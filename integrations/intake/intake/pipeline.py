"""The deterministic intake stages as one pure function (DESIGN-intake.md section 3, stages
1-5 and 8). No service, no DB, no model, no network.

    screen(envelope, history=None) -> IntakeResult

  1 validate      envelope.validate            -> `rejected` on a bad envelope
  2 idempotency   revisions.decide (history)   -> a repeat returns the stored result
  3 cdr           cdr.extract                  -> `rejected` on a parser bomb / unparseable body
  4 invisible     invisible.strip + rules_copy -> `rejected` on a normalisation bomb
  5 rules         rules.evaluate + neutralise  -> STRONG: `injected`; WEAK: `pending` for the
                                                  second opinion; none: `clean` (so far)
  8 fail closed   any other exception in any stage, or a stage that ends past the deadline,
                  gives `pending` with the error, never `clean`.

Each stage is looked up on this module at call time (STAGES), so a test can replace one with
a function that raises and check that the result is `pending` (tests/test_fail_closed.py).
"""
from __future__ import annotations

import time
from typing import Callable

from . import cdr, envelope, invisible, limits, revisions, rules
from .htmlscan import ParserBomb
from .result import IntakeResult, Reason, StageRecord

_TITLE_ESCAPE = {ord(c): "\\" + c for c in "\\`*_[]()!<>#|{}"}


def escape_title(title: str | None) -> str | None:
    """Markdown-inert title (audit B10): every character markdown or HTML gives meaning to is
    backslash-escaped, whitespace collapsed, capped at TITLE_MAX_CHARS."""
    if title is None:
        return None
    t = " ".join(title.split())[: limits.TITLE_MAX_CHARS]
    return t.translate(_TITLE_ESCAPE) or None


class _Stop(Exception):
    """A stage decided the outcome (rejected / repeat); carries the result."""

    def __init__(self, result: IntakeResult):
        super().__init__(result.verdict)
        self.result = result


# -- the stages (each takes and returns the working state dict) ------------------------------
def stage_validate(st: dict) -> str:
    try:
        st["env"] = envelope.validate(st["input"])
    except envelope.Rejected as e:
        st["stop"] = ("rejected", Reason("validate", "stage", str(e)))
        return f"rejected: {e}"
    env = st["env"]
    return f"{env.content_type}, {len(env.raw)} bytes"


def stage_idempotency(st: dict) -> str:
    env = st["env"]
    key = revisions.key_for(env.source, env.external_id, env.raw)
    decision = revisions.decide(key, st["history"])
    st["key"], st["decision"] = key, decision
    if decision.kind == "repeat":
        st["repeat"] = decision.stored
        return f"repeat of revision {decision.revision}"
    return f"{decision.kind}, revision {decision.revision}"


def stage_cdr(st: dict) -> str:
    env = st["env"]
    try:
        ex = cdr.extract(env.kind, env.raw, env.charset)
    except (ParserBomb, cdr.ContentInvalid) as e:
        st["stop"] = ("rejected", Reason("cdr", "stage", str(e)))
        return f"rejected: {e}"
    st["extract"] = ex
    st["counts"].update(ex.counts)
    if env.surrogates:  # replaced in stage 1 (they cannot be encoded); counted as stage 4's class
        st["counts"]["surrogates"] = env.surrogates
    links = list(ex.links)
    for u in env.links:
        if len(links) >= limits.MAX_LINKS:
            st["counts"]["links_dropped"] = st["counts"].get("links_dropped", 0) + 1
            continue
        links.append({"kind": "envelope", "url": u, "text": ""})
    st["links"] = links
    return f"{env.kind}: {len(ex.text)} chars, {len(links)} links, {len(ex.attachments)} attachments"


def stage_invisible(st: dict) -> str:
    ex = st["extract"]
    text, counts, payloads = invisible.strip(ex.text)
    title = None
    if ex.title is not None:
        title, tcounts, tpayloads = invisible.strip(ex.title)
        for k, v in tcounts.items():
            counts[k] = counts.get(k, 0) + v
        payloads = payloads + tpayloads
    # links, link texts and attachment names get the same treatment (a bidi override in a
    # file name or URL is a spoof; TAG text in a link text is a payload)
    side: list[str] = []
    for item, keys in ((x, ("url", "text")) for x in st["links"]):
        for k in keys:
            if item.get(k):
                item[k], c, p = invisible.strip(item[k])
                side.extend(p)
                for kk, v in c.items():
                    counts[kk] = counts.get(kk, 0) + v
    for att in ex.attachments:
        if att.get("filename"):
            att["filename"], c, p = invisible.strip(att["filename"])
            side.extend(p)
            for kk, v in c.items():
                counts[kk] = counts.get(kk, 0) + v
    if side:
        payloads = payloads + ["".join(side)]
    try:
        copy, trimmed = invisible.rules_copy(text)
        title_copy = invisible.rules_copy(title)[0] if title else ""
    except invisible.NormalisationBomb as e:
        st["stop"] = ("rejected", Reason("invisible", "stage", str(e)))
        return f"rejected: {e}"
    counts["nonstarters_trimmed"] = trimmed
    for k, v in counts.items():
        st["counts"][k] = st["counts"].get(k, 0) + v
    st["text"], st["title"], st["copy"], st["title_copy"] = text, title, copy, title_copy
    st["payloads"] = payloads
    return ", ".join(f"{k}={v}" for k, v in counts.items() if v) or "none"


def stage_rules(st: dict) -> str:
    reasons = rules.evaluate(st["copy"], st["payloads"], st["counts"])
    if st["title_copy"]:
        have = {r.rule for r in reasons}
        for r in rules.evaluate(st["title_copy"], [], {}):
            if r.rule not in have:
                reasons.append(Reason(r.rule, r.strength, "in title: " + r.detail))
    st["reasons"] = reasons
    if any(r.strength == "strong" for r in reasons):
        return "STRONG: " + ", ".join(r.rule for r in reasons if r.strength == "strong")
    try:
        text, lines, refs = rules.neutralise(st["text"], st["copy"])
    except rules.NeutraliseBomb as e:
        st["stop"] = ("rejected", Reason("rules", "stage", str(e)))
        return f"rejected: {e}"
    st["text"] = text
    st["counts"]["neutralised_lines"] = lines
    st["counts"]["neutralised_refs"] = refs
    return ("WEAK: " + ", ".join(r.rule for r in reasons)) if reasons else "no rule hit"


STAGES: list[tuple[str, str]] = [
    ("validate", "stage_validate"),
    ("idempotency", "stage_idempotency"),
    ("cdr", "stage_cdr"),
    ("invisible", "stage_invisible"),
    ("rules", "stage_rules"),
]


def _result(st: dict, verdict: str, **kw) -> IntakeResult:
    decision = st.get("decision")
    base = dict(
        reasons=tuple(st.get("reasons", ())),
        counts=st["counts"],
        trace=tuple(st["trace"]),
        key=st.get("key"),
        revision=decision.revision if decision else None,
        supersedes=decision.supersedes if decision else None,
        attachments=tuple(st["extract"].attachments) if "extract" in st else (),
        title=escape_title(st.get("title")) if verdict in ("clean", "pending") else None,
    )
    base.update(kw)
    return IntakeResult(verdict=verdict, **base)


def screen(env_input: object, history: revisions.History | None = None, *,
           deadline_s: float = limits.DEADLINE_SECONDS,
           clock: Callable[[], float] = time.perf_counter) -> IntakeResult:
    """Run stages 1-5 on one envelope. Never raises; never returns `clean` after an error."""
    st: dict = {"input": env_input, "history": history or revisions.NoHistory(),
                "counts": {}, "trace": [], "reasons": []}
    t_start = clock()
    for name, attr in STAGES:
        t0 = clock()
        try:
            detail = globals()[attr](st)
        except Exception as e:  # noqa: BLE001 - stage 8: any error fails closed
            st["trace"].append(StageRecord(name, "error", (clock() - t0) * 1000,
                                           f"{type(e).__name__}: {e}"[:300]))
            return _fail_closed(st, f"{name}: {type(e).__name__}: {e}"[:300])
        elapsed = clock()
        if "stop" in st:
            verdict, reason = st["stop"]
            st["reasons"] = [*st["reasons"], reason]
            st["trace"].append(StageRecord(name, "stop", (elapsed - t0) * 1000, detail))
            return _result(st, verdict)
        if "repeat" in st:
            st["trace"].append(StageRecord(name, "stop", (elapsed - t0) * 1000, detail))
            stored: IntakeResult = st["repeat"]
            return IntakeResult(**{**_fields(stored), "repeat": True,
                                   "trace": tuple(st["trace"])})
        st["trace"].append(StageRecord(name, "ok", (elapsed - t0) * 1000, detail))
        if elapsed - t_start > deadline_s:
            return _fail_closed(st, f"deadline: {name} ended after {elapsed - t_start:.3f}s")
    return _decide(st)


def _fields(r: IntakeResult) -> dict:
    return {f: getattr(r, f) for f in r.__dataclass_fields__}


def _fail_closed(st: dict, error: str) -> IntakeResult:
    try:
        return _result(st, "pending", error=error, needs_second_opinion=False, title=None)
    except Exception:  # noqa: BLE001 - even building the result failed: minimal pending
        return IntakeResult(verdict="pending", error=error)


def _decide(st: dict) -> IntakeResult:
    reasons = st["reasons"]
    if any(r.strength == "strong" for r in reasons):
        return _result(st, "injected")
    if reasons:
        return _result(st, "pending", text=st["text"], links=tuple(st["links"]),
                       needs_second_opinion=True)
    return _result(st, "clean", text=st["text"], links=tuple(st["links"]))
