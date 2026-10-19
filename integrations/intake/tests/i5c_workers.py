"""Hostile worker processes for the intake-i5c tests (the intake-i5b tester's TF-1/2/3/7).

Each `*_main` stands in for intake_service.pool._worker_main (the tests patch that module global,
which WorkerPool._spawn reads at every spawn). The FIRST job a stand-in sees in a test is answered
with the hostile move; every later job, and every replacement worker (the same stand-in), is
served honestly, so a test can show the pool serving again after it dropped the hostile worker.
"First" is a flag file named by INTAKE_TEST_ONCE (shared by the replacement process).

What a stand-in may do is what a COMPROMISED worker could do: the worker parses untrusted bytes
with native code, so the parent must survive anything it sends.

  partial_*      a length header and part of a frame, then a stall (TF-1); Unix pipes only (a
                 Windows pipe is message-mode: there is no partial frame to stall in)
  frame_main     answers the job with the raw frame in INTAKE_TEST_FRAME ("JID" -> the job id)
                 (TF-2: 1e99999, -1e99999, NaN, Infinity)
  order_main     breaks the message order per INTAKE_TEST_ORDER (TF-3)
  started_main   announces a "started" mutated per INTAKE_TEST_STARTED_FILE (envelope/key field
                 overrides; TF-7)
"""
from __future__ import annotations

import json
import os
import struct
import time

from intake_service import pool, wire


def _hold():
    time.sleep(float(os.environ.get("INTAKE_TEST_HOLD", "30")))
    os._exit(0)


def _first() -> bool:
    flag = os.environ.get("INTAKE_TEST_ONCE", "")
    if not flag or os.path.exists(flag):
        return False
    open(flag, "w").close()
    return True


def _partial(conn, claimed: int = 1000, head: bytes = b'["done",'):
    """A length header claiming `claimed` bytes, then only `head` of them (Unix Connection)."""
    conn._send(struct.pack("!i", claimed) + head)


def _ready(conn):
    wire.send_msg(conn, ["ready", {"version": "hostile-i5c/1", "pid": os.getpid()}])


def _good_result(**over):
    r = {"verdict": "clean", "reasons": [], "counts": {}, "links": [], "attachments": [], "text": "x",
         "title": None, "trace": [], "key": {"source": "web", "external_id": "item-1", "sha256": "0" * 64}}
    r.update(over)
    return r


def _honest(conn, clf, jid, body, *, mutate_started=None, mutate_done=None):
    """pool._worker_main's job loop for one job, with optional hooks on what is sent."""
    def gate(info):
        payload = wire.started_to_wire(info)
        if mutate_started is not None:
            payload = mutate_started(payload)
        wire.send_msg(conn, ["started", jid, payload])
        return None  # intake-i5d: no go/skip round trip (the parent decided before it dispatched)

    out = pool.screen_job(body, clf, gate, lambda ev: wire.send_msg(conn, [ev, jid]))
    payload = {"kind": out.kind, "detail": out.detail, "result": None if out.result is None else out.result.to_dict()}
    if mutate_done is not None:
        payload = mutate_done(payload)
    wire.send_msg(conn, ["done", jid, payload])


def _serve(conn, factory, hostile):
    clf = pool._make(factory)
    from intake import pipeline  # noqa: F401 - as _worker_main: the Unicode tables before "ready"
    _ready(conn)
    while True:
        try:
            msg = wire.recv_msg(conn, wire.MAX_CONTROL_BYTES)
            body = conn.recv_bytes() if msg[0] == "job" else None
        except (EOFError, OSError, wire.WireError):
            return
        if msg[0] == "stop":
            return
        if msg[0] != "job":
            continue
        if _first():
            hostile(conn, clf, msg[1], body)
        else:
            _honest(conn, clf, msg[1], body)


# -- TF-1: a partial frame, then a stall --------------------------------------------------------------
def partial_transfer_main(conn, factory="tests.service_support:zero", *_a):
    """In the transfer phase (before "started")."""
    def hostile(c, clf, jid, body):
        _partial(c)
        _hold()
    _serve(conn, factory, hostile)


def partial_stages_main(conn, factory="tests.service_support:zero", *_a):
    """In the stages phase: a valid "started", then a partial frame."""
    def hostile(c, clf, jid, body):
        info = pool.announce(json.loads(body.decode("utf-8")))
        wire.send_msg(c, ["started", jid, wire.started_to_wire(info)])
        _partial(c, 5000, b'["done",' + str(jid).encode() + b',{"kind":"result"')
        _hold()
    _serve(conn, factory, hostile)


def partial_header_main(conn, factory="tests.service_support:zero", *_a):
    """Only 2 of the 4 header bytes, then a stall."""
    def hostile(c, clf, jid, body):
        c._send(b"\x00\x00")
        _hold()
    _serve(conn, factory, hostile)


def partial_ready_main(conn, *_a):
    """A partial "ready" frame at start, then a stall (the start / replacement clock)."""
    _partial(conn, 200, b'["ready",')
    _hold()


# -- TF-2: non-finite numbers ---------------------------------------------------------------------------
def frame_main(conn, factory="tests.service_support:zero", *_a):
    def hostile(c, clf, jid, body):
        c.send_bytes(os.environ["INTAKE_TEST_FRAME"].replace("JID", str(jid)).encode("utf-8"))
        _hold()
    _serve(conn, factory, hostile)


def done_frame(result_json_tail: str) -> str:
    """A `done` frame template with a valid result whose trace's ms is the given JSON text."""
    s = json.dumps(["done", 0, {"kind": "result", "detail": "",
                                "result": _good_result(trace=[{"stage": "a", "status": "ok", "ms": 1}])}])
    return s.replace('["done", 0', '["done", JID').replace('"ms": 1', '"ms": ' + result_json_tail)


# -- TF-3: the message order and the key ----------------------------------------------------------------
def order_main(conn, factory="tests.service_support:zero", *_a):
    """INTAKE_TEST_ORDER:
      done_result_first   a `done` with a result before any "started" (the connector gate never ran)
      done_skipped_first  a `done` of kind skipped before any "started"
      skipped_after_started  a valid "started", then a `done` of kind skipped (intake-i5d: only the
                          parent decides skipped, before it dispatches; this replaced
                          result_after_skip, which needed the go/skip round trip i5d removed)
      second_started      two "started" in a row
      key_mismatch        the honest flow, but the result's key has another sha256
      key_without_started "started" null (an invalid envelope), then a result WITH a key (since
                          intake-i5d refused at "started": the parent's announcement is not null)
    """
    how = os.environ.get("INTAKE_TEST_ORDER", "")

    def hostile(c, clf, jid, body):
        info = pool.announce(json.loads(body.decode("utf-8")))
        honest_result = None
        if how in ("done_result_first", "key_without_started"):
            obj = json.loads(body.decode("utf-8"))
            from intake import pipeline
            honest_result = pipeline.screen(obj, classifier=clf).to_dict()
        if how == "done_result_first":
            wire.send_msg(c, ["done", jid, {"kind": "result", "detail": "", "result": honest_result}])
        elif how == "done_skipped_first":
            wire.send_msg(c, ["done", jid, {"kind": "skipped", "detail": "x", "result": None}])
        elif how == "skipped_after_started":
            wire.send_msg(c, ["started", jid, wire.started_to_wire(info)])
            wire.send_msg(c, ["done", jid, {"kind": "skipped", "detail": "x", "result": None}])
        elif how == "second_started":
            wire.send_msg(c, ["started", jid, wire.started_to_wire(info)])
            wire.send_msg(c, ["started", jid, wire.started_to_wire(info)])
        elif how == "key_mismatch":
            def other_key(p):
                if p.get("result") and p["result"].get("key"):
                    p["result"]["key"]["sha256"] = "f" * 64
                return p
            _honest(c, clf, jid, body, mutate_done=other_key)
            return
        elif how == "key_without_started":
            wire.send_msg(c, ["started", jid, None])
            wire.send_msg(c, ["done", jid, {"kind": "result", "detail": "", "result": honest_result}])
        else:
            raise SystemExit("unknown INTAKE_TEST_ORDER")
        _hold()
    _serve(conn, factory, hostile)


# -- TF-7: the announced envelope ------------------------------------------------------------------------
def started_main(conn, factory="tests.service_support:zero", *_a):
    """INTAKE_TEST_STARTED_FILE names a JSON file {"envelope": {...overrides...}, "key": {...},
    "drop": [...], "extra": {...}} (a file: the overrides can be over the Windows env limit)."""
    path = os.environ.get("INTAKE_TEST_STARTED_FILE", "")
    spec = {}
    if path and os.path.exists(path):  # a late replacement after the test may find it gone
        with open(path, encoding="utf-8") as fh:
            spec = json.load(fh)

    def mutate(p):
        if p is None:
            return p
        p["envelope"].update(spec.get("envelope", {}))
        p["key"].update(spec.get("key", {}))
        for k in spec.get("drop", ()):
            p["envelope"].pop(k, None)
        p["envelope"].update(spec.get("extra", {}))
        return p

    def hostile(c, clf, jid, body):
        _honest(c, clf, jid, body, mutate_started=mutate)
    _serve(conn, factory, hostile)
