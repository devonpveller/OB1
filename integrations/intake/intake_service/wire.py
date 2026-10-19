"""What crosses the pipe between the service and a worker process (I5; intake-i5b R-2 / R-4).

NEVER PICKLE (intake-int review R-2). A worker is the process that parses untrusted bytes with
native code (selectolax, re2, tokenizers, torch); a code-execution bug there must not become code
execution in the parent, which holds the DB password, the caller keys and the LiteLLM key.
`multiprocessing.Connection.send()/recv()` pickle, and unpickling runs code. So every message is
ONE frame of UTF-8 JSON (a list whose first item is the op name), sent with send_bytes() and read
with recv_bytes(maxlength): a frame over the reader's cap is refused from its length header
before its body is read (the connection is then closed: the pool drops that worker). NaN and
Infinity are refused both ways. The one non-JSON frame is a job's body, raw bytes sent right
after the parent's ["job", id] header; only the worker reads it.

The caps (the frame length, bytes):
  MAX_CONTROL_BYTES        64 KiB  every parent -> worker header, and the worker's "ready"
  MAX_WORKER_MESSAGE_BYTES 64 MiB  any other worker -> parent message. The largest legitimate
                           ones: "started" carries the envelope's raw (<= 5 MiB, as base64)
                           and "done" the result's text (<= the raw, JSON-escaped)
  the job body             the service's INTAKE_MAX_REQUEST_BYTES (<= 16 MiB) - the worker's cap

What the parent acts on is rebuilt and re-checked here: an IntakeResult through its constructor
(no `clean` with an error or reasons, no text on `injected`/`rejected`, ...) and the "started"
announcement field by field. Anything else is a WireError, and the pool drops the worker that
sent it (R-4: a worker that sent something invalid is never re-pooled).
"""
from __future__ import annotations

import base64
import binascii
import json
import re

from intake.result import IdempotencyKey, IntakeResult, Reason, StageRecord

MAX_CONTROL_BYTES = 64 * 1024
MAX_WORKER_MESSAGE_BYTES = 64 * 1024 * 1024
_SHA = re.compile(r"[0-9a-f]{64}")


class WireError(ValueError):
    """A frame that is not a valid message: the sender is dropped."""


def _no_constant(name):
    raise WireError(f"{name} is not JSON")


def send_msg(conn, msg: list) -> None:
    """One JSON frame. Raises ValueError for a value JSON cannot carry (NaN, bytes, ...)."""
    try:
        data = json.dumps(msg, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except TypeError as e:
        raise ValueError(str(e)) from None
    conn.send_bytes(data)


def recv_msg(conn, max_bytes: int) -> list:
    """One JSON frame of at most max_bytes. OSError (the connection's own, "bad message length")
    when the frame is longer - it is refused before it is read - EOFError when the pipe closed,
    WireError when it is not a JSON list starting with an op name."""
    data = conn.recv_bytes(max_bytes)
    try:
        msg = json.loads(data.decode("utf-8"), parse_constant=_no_constant)
    except (UnicodeDecodeError, ValueError, RecursionError) as e:
        raise WireError(f"not a JSON frame ({type(e).__name__})") from None
    if not isinstance(msg, list) or not msg or not isinstance(msg[0], str):
        raise WireError("a frame is a JSON list starting with an op name")
    return msg


# -- the "started" announcement ---------------------------------------------------------------------
def started_to_wire(info: dict | None):
    if info is None:
        return None
    env = dict(info["envelope"])
    env["raw"] = base64.b64encode(env["raw"]).decode("ascii")
    return {"key": info["key"], "envelope": env}


def _str(d: dict, k: str, limit: int = 4096) -> str:
    v = d.get(k)
    if not isinstance(v, str) or len(v) > limit:
        raise WireError(f"started: {k} is not a string")
    return v


def started_from_wire(obj):
    """The worker's stage-1 announcement, checked: None (an invalid envelope) or
    {"key": {source, external_id, sha256}, "envelope": {..., "raw": bytes}}."""
    if obj is None:
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("key"), dict) or not isinstance(obj.get("envelope"), dict):
        raise WireError("started: not {key, envelope}")
    k, e = obj["key"], obj["envelope"]
    key = {"source": _str(k, "source"), "external_id": _str(k, "external_id"), "sha256": _str(k, "sha256")}
    if not _SHA.fullmatch(key["sha256"]):
        raise WireError("started: sha256 is not 64 hex characters")
    try:
        raw = base64.b64decode(_str(e, "raw", MAX_WORKER_MESSAGE_BYTES), validate=True)
    except (binascii.Error, ValueError):
        raise WireError("started: raw is not base64") from None
    if not isinstance(e.get("metadata"), dict) or not isinstance(e.get("links"), list):
        raise WireError("started: metadata/links have the wrong type")
    env = {"source": _str(e, "source"), "connector": _str(e, "connector"), "external_id": _str(e, "external_id"),
           "fetched_at": _str(e, "fetched_at"), "content_type": _str(e, "content_type"), "raw": raw,
           "metadata": e["metadata"], "links": e["links"]}
    if env["source"] != key["source"] or env["external_id"] != key["external_id"]:
        raise WireError("started: the key does not match the envelope")
    return {"key": key, "envelope": env}


# -- the "done" payload ------------------------------------------------------------------------------
DONE_KINDS = ("result", "bad", "skipped")


def done_from_wire(obj) -> tuple[str, IntakeResult | None, str]:
    """-> (kind, result, detail), checked: a `result` carries a valid IntakeResult, `bad` and
    `skipped` carry none."""
    if not isinstance(obj, dict):
        raise WireError("done: not an object")
    kind, detail, raw = obj.get("kind"), obj.get("detail", ""), obj.get("result")
    if kind not in DONE_KINDS or not isinstance(detail, str) or len(detail) > 4096:
        raise WireError("done: bad kind or detail")
    if (kind == "result") != (raw is not None):
        raise WireError(f"done: kind {kind} with{'out' if raw is None else ''} a result")
    try:
        result = None if raw is None else result_from_dict(raw)
    except WireError:
        raise
    except Exception as e:  # noqa: BLE001 - every invariant the constructor checks
        raise WireError(f"an invalid result: {type(e).__name__}: {str(e)[:200]}") from None
    return kind, result, detail


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
