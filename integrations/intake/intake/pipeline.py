"""The deterministic intake stages as one pure function (DESIGN-intake.md section 3, stages
1-5 and 8). No service, no DB, no model, no network.

    screen(envelope, history=None) -> IntakeResult

  1 validate      envelope.validate            -> `rejected` on a bad envelope
  2 idempotency   revisions.decide (history)   -> a repeat returns the stored result
  3 cdr           cdr.extract                  -> `rejected` on a parser bomb / unparseable body
  4 invisible     invisible.strip + rules_copy -> `rejected` on a normalisation bomb
  5 rules         rules.evaluate + neutralise  -> STRONG (or two cues together): `injected`;
                                                  WEAK: `pending` for the second opinion;
                                                  none: `clean` (so far)
  8 fail closed   any exception in any stage, or the deadline passing INSIDE a stage
                  (deadline.py: the stages check it in their loops), gives `pending` with the
                  error, never `clean`.

screen() never raises: anything that escapes the stage loop (building the result, an
exception whose __str__ raises, a BaseException other than KeyboardInterrupt / SystemExit)
still returns a minimal `pending` result (attempt 1, F-8).

Each stage is looked up on this module at call time (STAGES), so a test can replace one with
a function that raises and check that the result is `pending`.
"""
from __future__ import annotations

import time
from typing import Callable

from . import cdr, envelope, invisible, limits, revisions, rules
from .deadline import Deadline
from .htmlscan import ParserBomb
from .result import IntakeResult, Reason, StageRecord

_MD_ESCAPE = {ord(c): "\\" + c for c in "\\`*_[]()!<>#|{}"}


def escape_markdown(text: str | None, cap: int = limits.TITLE_MAX_CHARS) -> str | None:
    """Markdown-inert text (audit B10): every character markdown or HTML gives meaning to is
    backslash-escaped, whitespace collapsed, capped. Used for the title, link texts, alt/title
    attributes and attachment names."""
    if text is None:
        return None
    t = " ".join(text.split())[:cap]
    return t.translate(_MD_ESCAPE) or None


escape_title = escape_markdown


def _describe(e: BaseException) -> str:
    """'Type: message', even when the exception's __str__ itself raises."""
    try:
        name = type(e).__name__
    except BaseException:  # noqa: BLE001
        name = "exception"
    try:
        msg = str(e)
    except BaseException:  # noqa: BLE001
        msg = "<message unavailable>"
    return f"{name}: {msg}"[:300]


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
        ex = cdr.extract(env.kind, env.raw, env.charset, st["dl"])
    except (ParserBomb, cdr.ContentInvalid) as e:
        st["stop"] = ("rejected", Reason("cdr", "stage", str(e)))
        return f"rejected: {e}"
    st["extract"] = ex
    st["counts"].update(ex.counts)
    if env.surrogates:  # replaced in stage 1 (they cannot be encoded); counted as stage 4's class
        st["counts"]["surrogates"] = env.surrogates
    links = [dict(x) for x in ex.links]
    for u in env.links:
        if len(links) >= limits.MAX_LINKS:
            st["counts"]["links_dropped"] = st["counts"].get("links_dropped", 0) + 1
            continue
        links.append({"kind": "envelope", "url": u, "text": ""})
    st["links"] = links
    return f"{env.kind}: {len(ex.text)} chars, {len(links)} links, {len(ex.attachments)} attachments"


def _add(counts: dict, more: dict) -> None:
    for k, v in more.items():
        counts[k] = counts.get(k, 0) + v


def stage_invisible(st: dict) -> str:
    dl = st["dl"]
    ex = st["extract"]
    text, counts, payloads = invisible.strip(ex.text, dl)
    # The side text: the title, every link's text (alt / title attribute) and URL, every
    # attachment name. Stripped the same way, screened by the rules, escaped in the result
    # (attempt 1, F-6: a clean result carried '<|im_start|>system' in a link text).
    side_parts: list[str] = []
    title = None
    if ex.title is not None:
        title, c, p = invisible.strip(ex.title, dl)
        _add(counts, c)
        payloads += p
        side_parts.append(title)
    for item in st["links"]:
        for k in ("url", "text"):
            if item.get(k):
                item[k], c, p = invisible.strip(item[k], dl)
                _add(counts, c)
                payloads += p
                side_parts.append(item[k])
    attachments = [dict(a) for a in ex.attachments]
    for att in attachments:
        if att.get("filename"):
            att["filename"], c, p = invisible.strip(att["filename"], dl)
            _add(counts, c)
            payloads += p
            side_parts.append(att["filename"])
    try:
        copy, trimmed = invisible.rules_copy(text, dl)
        side_copy = invisible.rules_copy("\n".join(side_parts), dl)[0] if side_parts else ""
    except invisible.NormalisationBomb as e:
        st["stop"] = ("rejected", Reason("invisible", "stage", str(e)))
        return f"rejected: {e}"
    counts["nonstarters_trimmed"] = trimmed
    _add(st["counts"], counts)
    st["text"], st["title"], st["copy"], st["side_copy"] = text, title, copy, side_copy
    st["attachments"] = attachments
    st["payloads"] = payloads
    return ", ".join(f"{k}={v}" for k, v in counts.items() if v) or "none"


def stage_rules(st: dict) -> str:
    dl = st["dl"]
    reasons = rules.evaluate(st["copy"], st["payloads"], st["counts"], st["side_copy"], dl)
    st["reasons"] = reasons
    if any(r.strength == "strong" for r in reasons):
        return "STRONG: " + ", ".join(r.rule for r in reasons if r.strength == "strong")
    try:
        text, lines, refs = rules.neutralise(st["text"], st["copy"], dl)
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


def _escaped_links(links) -> tuple[dict, ...]:
    out = []
    for x in links:
        y = dict(x)
        y["text"] = escape_markdown(y.get("text"), limits.MAX_LINK_TEXT_CHARS) or ""
        out.append(y)
    return tuple(out)


def _result(st: dict, verdict: str, **kw) -> IntakeResult:
    decision = st.get("decision")
    attachments = st.get("attachments")
    if attachments is None:
        attachments = st["extract"].attachments if "extract" in st else ()
    base = dict(
        reasons=tuple(st.get("reasons", ())),
        counts=st["counts"],
        trace=tuple(st["trace"]),
        key=st.get("key"),
        revision=decision.revision if decision else None,
        supersedes=decision.supersedes if decision else None,
        attachments=tuple({**a, "filename": escape_markdown(a.get("filename"), 255) or ""}
                          for a in attachments),
        title=escape_markdown(st.get("title")) if verdict in ("clean", "pending") else None,
    )
    base.update(kw)
    return IntakeResult(verdict=verdict, **base)


def screen(env_input: object, history: revisions.History | None = None, *,
           deadline_s: float = limits.DEADLINE_SECONDS,
           clock: Callable[[], float] = time.perf_counter) -> IntakeResult:
    """Run stages 1-5 on one envelope. Never raises (but KeyboardInterrupt / SystemExit);
    never returns `clean` after an error."""
    try:
        return _screen(env_input, history, deadline_s, clock)
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException as e:  # noqa: BLE001 - stage 8: nothing escapes as a crash
        return _minimal_pending("screen: " + _describe(e))


def _minimal_pending(error: str) -> IntakeResult:
    return IntakeResult(verdict="pending", error=error[:300])


def _screen(env_input, history, deadline_s, clock) -> IntakeResult:
    dl = Deadline(deadline_s, clock)
    st: dict = {"input": env_input, "history": history or revisions.NoHistory(),
                "counts": {}, "trace": [], "reasons": [], "dl": dl}
    for name, attr in STAGES:
        t0 = clock()
        try:
            detail = globals()[attr](st)
            dl.check()
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as e:  # noqa: BLE001 - stage 8: any error fails closed
            msg = _describe(e)  # a DeadlineExceeded reads "DeadlineExceeded: deadline: ..."
            st["trace"].append(StageRecord(name, "error", (clock() - t0) * 1000, msg))
            return _fail_closed(st, f"{name}: {msg}")
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
    return _decide(st)


def _fields(r: IntakeResult) -> dict:
    return {f: getattr(r, f) for f in r.__dataclass_fields__}


def _fail_closed(st: dict, error: str) -> IntakeResult:
    try:
        return _result(st, "pending", error=error, needs_second_opinion=False, title=None)
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException:  # noqa: BLE001 - even building the result failed: minimal pending
        return _minimal_pending(error)


def _decide(st: dict) -> IntakeResult:
    reasons = st["reasons"]
    if any(r.strength == "strong" for r in reasons):
        return _result(st, "injected")
    if reasons:
        return _result(st, "pending", text=st["text"], links=_escaped_links(st["links"]),
                       needs_second_opinion=True)
    return _result(st, "clean", text=st["text"], links=_escaped_links(st["links"]))
