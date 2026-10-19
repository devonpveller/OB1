"""What crosses the pipe between the service and a worker process (I5).

An IntakeResult travels as its to_dict() and is rebuilt here; the constructor re-checks every
invariant (no `clean` with an error or reasons, no text on `injected`/`rejected`, ...), so a
result the parent acts on is a valid IntakeResult whatever the worker sent.
"""
from __future__ import annotations

from intake.result import IdempotencyKey, IntakeResult, Reason, StageRecord


def result_from_dict(d: dict) -> IntakeResult:
    if not isinstance(d, dict):
        raise ValueError("a result is a dict")
    key = d.get("key")
    clf = d.get("classifier")
    return IntakeResult(
        verdict=d["verdict"],
        reasons=tuple(Reason(r["rule"], r["strength"], r.get("detail", "")) for r in d.get("reasons", ())),
        counts=dict(d.get("counts") or {}),
        links=tuple(dict(x) for x in d.get("links", ())),
        attachments=tuple(dict(x) for x in d.get("attachments", ())),
        text=d.get("text"),
        title=d.get("title"),
        trace=tuple(StageRecord(t["stage"], t["status"], float(t["ms"]), t.get("detail", ""))
                    for t in d.get("trace", ())),
        key=IdempotencyKey(key["source"], key["external_id"], key["sha256"]) if key else None,
        revision=d.get("revision"),
        supersedes=d.get("supersedes"),
        repeat=bool(d.get("repeat", False)),
        needs_second_opinion=bool(d.get("needs_second_opinion", False)),
        error=d.get("error"),
        classifier_version=d.get("classifier_version"),
        classifier=None if clf is None else {**clf, "flagged": tuple(dict(x) for x in clf.get("flagged", ()))},
        error_kind=d.get("error_kind"),
        rescreen=bool(d.get("rescreen", False)),
        judge_chunks=tuple(dict(x) for x in d.get("judge_chunks", ())),
        judge_complete=bool(d.get("judge_complete", False)),
    )
