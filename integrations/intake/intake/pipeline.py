"""The intake stages as one function (DESIGN-intake.md section 3, stages 1-6 and 8). No
service, no DB, no network; stage 6 reads a local, hash-verified model (classifier.py).

    screen(envelope, history=None, *, classifier=None) -> IntakeResult

  1 validate      envelope.validate            -> `rejected` on a bad envelope
  2 idempotency   revisions.decide (history)   -> a repeat returns the stored result
  3 cdr           cdr.extract                  -> `rejected` on a parser bomb / unparseable body
  4 invisible     invisible.strip + rules_copy -> `rejected` on a normalisation bomb
  5 rules         rules.evaluate + neutralise  -> STRONG (or two cues together): `injected`;
                                                  WEAK: `pending` for the second opinion;
                                                  none: `clean` (so far)
  6 classifier    classifier.Classifier.score  -> skipped after a STRONG rule; a max chunk score
                                                  >= threshold: `pending` + needs_second_opinion
                                                  with the score and chunk offsets (D24: never
                                                  `injected` on the score alone); below it the
                                                  stage-5 verdict stands. Its own time budget
                                                  (config), not the stage 1-5 deadline.
  7 second opinion  NOT run here (I4: second_opinion.py, decided by d2.py). An item pending
                  for it carries judge_chunks / judge_complete: what the judge reads.
  8 fail closed   any exception in any stage, or the deadline passing INSIDE a stage
                  (deadline.py: the stages check it in their loops), gives `pending` with the
                  error, never `clean`. That includes every classifier failure: missing or
                  corrupt model files, a hash mismatch, a tokenizer or model exception, the
                  classifier's time or chunk budget. The result's error_kind says whether a retry can help:
  `permanent` for the classifier's budget (I3 F-2), `transient` for everything else.

Callers run screen() in a killable worker process with a hard wall-clock limit (operator D38,
I5): single library calls (stdlib parsers, the tokenizer, a model forward pass) cannot be
interrupted in-process.

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
from . import classifier as _classifier
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
        st["rescreen"] = _needs_rescreen(decision.stored, st["classifier"])
        return f"repeat of revision {decision.revision}" + (
            " (re-screen: another classifier version)" if st["rescreen"] else "")
    return f"{decision.kind}, revision {decision.revision}"


def _current_classifier_version(clf) -> str | None:
    try:
        clf = clf if clf is not None else _classifier.default()
        v = getattr(clf, "version", None)
        return v if isinstance(v, str) and v else None
    except Exception:  # noqa: BLE001 - a misconfigured default: the version is unknown
        return None


def _needs_rescreen(stored: IntakeResult, clf) -> bool:
    """I3 F-3: a stored `clean` or `pending` was decided with the classifier's evidence (or
    without it, before I3); when that classifier is not the current one the caller re-screens
    (DESIGN section 7, "classifier upgrade"). `injected` and `rejected` never depend on the
    classifier. An unknown current version flags too (the safe direction)."""
    if stored.verdict not in ("clean", "pending"):
        return False
    current = _current_classifier_version(clf)
    return current is None or stored.classifier_version != current


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


def stage_classifier(st: dict) -> str:
    if any(r.strength == "strong" for r in st["reasons"]):
        st["skipped"] = True
        return "skipped: a STRONG rule decided"
    clf = st["classifier"] if st["classifier"] is not None else _classifier.default()
    fields = [("body", st["copy"]), ("side", st["side_copy"])]
    if st["payloads"]:
        fields.append(("payload", "\n".join(st["payloads"])))
    scored = clf.score(fields)
    st["scored"] = scored
    return (f"max {scored.max_score:.4f} over {scored.chunks} chunks, {scored.flagged_count} >= "
            f"{scored.threshold} ({scored.precision}, {scored.threads} threads, {scored.ms:.0f} ms)")


STAGES: list[tuple[str, str]] = [
    ("validate", "stage_validate"),
    ("idempotency", "stage_idempotency"),
    ("cdr", "stage_cdr"),
    ("invisible", "stage_invisible"),
    ("rules", "stage_rules"),
    ("classifier", "stage_classifier"),
]
# Stages that keep their own time budget instead of the stage 1-5 deadline.
OWN_BUDGET = frozenset({"classifier"})


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
    scored = st.get("scored")
    if scored is not None:
        base["classifier_version"] = scored.version
        base["classifier"] = scored.to_dict()
    base.update(kw)
    return IntakeResult(verdict=verdict, **base)


def screen(env_input: object, history: revisions.History | None = None, *,
           deadline_s: float = limits.DEADLINE_SECONDS,
           clock: Callable[[], float] = time.perf_counter,
           classifier: _classifier.Classifier | None = None) -> IntakeResult:
    """Run stages 1-6 on one envelope. Never raises (but KeyboardInterrupt / SystemExit);
    never returns `clean` after an error. `classifier` defaults to the process-wide one
    configured from the environment (classifier.default())."""
    try:
        return _screen(env_input, history, deadline_s, clock, classifier)
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException as e:  # noqa: BLE001 - stage 8: nothing escapes as a crash
        return _minimal_pending("screen: " + _describe(e))


def _minimal_pending(error: str, kind: str = "transient") -> IntakeResult:
    return IntakeResult(verdict="pending", error=error[:300], error_kind=kind)


def _screen(env_input, history, deadline_s, clock, clf=None) -> IntakeResult:
    dl = Deadline(deadline_s, clock)
    st: dict = {"input": env_input, "history": history or revisions.NoHistory(),
                "counts": {}, "trace": [], "reasons": [], "dl": dl, "classifier": clf}
    for name, attr in STAGES:
        t0 = clock()
        try:
            detail = globals()[attr](st)
            if name not in OWN_BUDGET:
                dl.check()
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as e:  # noqa: BLE001 - stage 8: any error fails closed
            msg = _describe(e)  # a DeadlineExceeded reads "DeadlineExceeded: deadline: ..."
            st["trace"].append(StageRecord(name, "error", (clock() - t0) * 1000, msg))
            # I3 F-2: the classifier's time or chunk budget is passed again on every retry
            kind = "permanent" if isinstance(e, _classifier.ClassifierBudget) else "transient"
            return _fail_closed(st, f"{name}: {msg}", kind)
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
                                   "trace": tuple(st["trace"]),
                                   "rescreen": st.get("rescreen", False)})
        status = "skipped" if st.pop("skipped", False) else "ok"
        st["trace"].append(StageRecord(name, status, (elapsed - t0) * 1000, detail))
    return _decide(st)


def _fields(r: IntakeResult) -> dict:
    return {f: getattr(r, f) for f in r.__dataclass_fields__}


def _fail_closed(st: dict, error: str, kind: str = "transient") -> IntakeResult:
    try:
        return _result(st, "pending", error=error, error_kind=kind, needs_second_opinion=False,
                       title=None)
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException:  # noqa: BLE001 - even building the result failed: minimal pending
        return _minimal_pending(error, kind)


def _decide(st: dict) -> IntakeResult:
    reasons = st["reasons"]
    if any(r.strength == "strong" for r in reasons):
        return _result(st, "injected")
    scored = st.get("scored")
    if scored is None:  # cannot happen past stage 6; never resolve missing evidence to clean
        return _fail_closed(st, "classifier: no score")
    if reasons or scored.over_threshold:
        # D24: a confident score alone goes to the second opinion, never to a discard
        try:
            chunks, complete = _judge_chunks(st, scored, reasons)
        except Exception:  # noqa: BLE001 - no judge input: the judge cannot clear the item
            chunks, complete = (), False
        return _result(st, "pending", text=st["text"], links=_escaped_links(st["links"]),
                       needs_second_opinion=True, judge_chunks=chunks, judge_complete=complete)
    return _result(st, "clean", text=st["text"], links=_escaped_links(st["links"]))


def _judge_chunks(st: dict, scored, reasons) -> tuple[tuple[dict, ...], bool]:
    """Stage 7's input (I4): the flagged classifier chunks (highest score first) and the
    context of EVERY match of each WEAK rule in every field (attempt 2 D-2: a decoy first match
    must not hide the payload), cut from the texts the classifier and the rules read (the
    stage-4 NFKC copies), fields searched in rules.FIELD_ORDER. Match windows in one field that
    overlap are merged while the result fits one piece. Returns (chunks, complete); complete is
    False when anything was cut, left out, more matches existed than fit, or a rule hit could
    not be located - and D2 never ends `clean` on an incomplete input."""
    fields = {"body": st["copy"], "side": st["side_copy"], "payload": "\n".join(st["payloads"])}
    pieces: list[dict] = []
    complete = scored.flagged_count == len(scored.flagged)
    for c in scored.flagged:
        text = fields.get(c.field, "")[c.start:c.end]
        if not text.strip():
            complete = False
            continue
        pieces.append({"why": "classifier", "field": c.field, "start": c.start, "end": c.end,
                       "text": text})
    seen: set[str] = set()
    windows: dict[str, list[tuple[int, int, str]]] = {name: [] for name in rules.FIELD_ORDER}
    cap = limits.JUDGE_MAX_CHUNKS
    for r in reasons:
        if r.strength != "weak" or r.rule in seen:
            continue
        seen.add(r.rule)
        found = False
        for name in rules.FIELD_ORDER:
            hits = rules.spans(r.rule, fields[name], cap)
            if len(hits) > cap:  # more matches than could ever be shown
                complete = False
                hits = hits[:cap]
            for a, b in hits:
                found = True
                windows[name].append((max(0, a - limits.JUDGE_CONTEXT_CHARS),
                                      min(len(fields[name]), b + limits.JUDGE_CONTEXT_CHARS), r.rule))
        if not found:  # e.g. tag-chars: nothing in the text to show the judge
            complete = False
    for name in rules.FIELD_ORDER:
        merged: list[list] = []
        for a, b, rule in sorted(windows[name]):
            if merged and a <= merged[-1][1] and max(b, merged[-1][1]) - merged[-1][0] <= limits.JUDGE_CHUNK_MAX_CHARS:
                merged[-1][1] = max(b, merged[-1][1])
                if rule not in merged[-1][2]:
                    merged[-1][2].append(rule)
            else:
                merged.append([a, b, [rule]])
        for a, b, rule_ids in merged:
            pieces.append({"why": "rule:" + "+".join(rule_ids), "field": name, "start": a, "end": b,
                           "text": fields[name][a:b]})
    out: list[dict] = []
    total = 0
    for p in pieces:
        if len(out) >= limits.JUDGE_MAX_CHUNKS or total >= limits.JUDGE_TOTAL_MAX_CHARS:
            complete = False
            break
        room = min(limits.JUDGE_CHUNK_MAX_CHARS, limits.JUDGE_TOTAL_MAX_CHARS - total)
        if len(p["text"]) > room:
            p = {**p, "text": p["text"][:room], "end": p["start"] + room}
            complete = False
        out.append(p)
        total += len(p["text"])
    if not out:
        complete = False
    return tuple(out), complete
