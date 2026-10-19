"""Hostile worker processes for the intake-i5d tests (the intake-i5c tester's TC-1/TC-2/TC-3 and the
review's RV5-1).

Each `*_main` stands in for intake_service.pool._worker_main (the tests patch that module global). As
in tests/i5c_workers.py the FIRST job in a test meets the hostile move (a flag file named by
INTAKE_TEST_ONCE) and every later job, and every replacement, is served honestly - except the
`always_*` mains, which are hostile on every job.

The stand-ins speak both protocols, so the same test is RED on the pre-i5d pool for the real reason:
after "started" they take the parent's go/skip if one arrives within 0.5 s (the pre-i5d pool sends it
at once) and go on without it otherwise (i5d removed the round trip: the parent decides before it
dispatches).

  mismatch_main         announces a self-consistent envelope that is NOT the request (another
                        source, external_id or raw, per INTAKE_TEST_MISMATCH) and screens THAT (TC-2)
  exit_after_started_main  an honest "started", then closes the pipe and exits (RV5-1)
  shutrd_main           shuts its read side down (Linux), announces honestly, then holds (RV5-1, the
                        deterministic variant: a parent write to it fails at once)
  grandchild_main       forks a grandchild that keeps every inherited fd (the sentinel among them)
                        and writes its pid to INTAKE_TEST_GC_FILE, then stalls (TC-1/F-3)
  always_partial_main   a partial frame then a stall, on EVERY job (TC-3, the fd count)
"""
from __future__ import annotations

import json
import os
import socket
import time

from intake_service import pool, wire

from tests import i5c_workers as _c


def _maybe_reply(conn):
    """The pre-i5d parent answers "started" with go/skip; i5d sends nothing."""
    if conn.poll(0.5):
        reply = wire.recv_msg(conn, wire.MAX_CONTROL_BYTES)
        if reply[0] != "go":
            return str(reply[1]) if len(reply) > 1 else "refused"
    return None


def honest(conn, clf, jid, body):
    def gate(info):
        wire.send_msg(conn, ["started", jid, wire.started_to_wire(info)])
        return _maybe_reply(conn)

    out = pool.screen_job(body, clf, gate, lambda ev: wire.send_msg(conn, [ev, jid]))
    wire.send_msg(conn, ["done", jid, {"kind": out.kind, "detail": out.detail,
                                       "result": None if out.result is None else out.result.to_dict()}])


def _serve(conn, factory, hostile, always=False):
    clf = pool._make(factory)
    from intake import pipeline  # noqa: F401 - as _worker_main: the Unicode tables before "ready"
    _c._ready(conn)
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
        if always or _c._first():
            hostile(conn, clf, msg[1], body)
        else:
            honest(conn, clf, msg[1], body)


# -- TC-2 -------------------------------------------------------------------------------------------------
def mismatch_main(conn, factory="tests.service_support:zero", *_a):
    how = os.environ.get("INTAKE_TEST_MISMATCH", "raw")

    def hostile(c, clf, jid, body):
        obj = json.loads(body.decode("utf-8"))
        if how == "source":
            obj["source"] = "planted"
        elif how == "external_id":
            obj["external_id"] = "another-item"
        else:
            obj["raw"] = "PLANTED content the caller never sent."
        info = pool.announce(obj)  # self-consistent: the key is sha256 of the planted raw
        wire.send_msg(c, ["started", jid, wire.started_to_wire(info)])
        _maybe_reply(c)
        from intake import pipeline
        res = pipeline.screen(obj, classifier=clf)
        wire.send_msg(c, ["done", jid, {"kind": "result", "detail": "", "result": res.to_dict()}])
    _serve(conn, factory, hostile)


# -- RV5-1 ------------------------------------------------------------------------------------------------
def exit_after_started_main(conn, factory="tests.service_support:zero", *_a):
    def hostile(c, clf, jid, body):
        info = pool.announce(json.loads(body.decode("utf-8")))
        wire.send_msg(c, ["started", jid, wire.started_to_wire(info)])
        c.close()
        os._exit(0)
    _serve(conn, factory, hostile)


def shutrd_main(conn, factory="tests.service_support:zero", *_a):
    def hostile(c, clf, jid, body):
        s = socket.socket(fileno=os.dup(c.fileno()))
        s.shutdown(socket.SHUT_RD)
        s.close()
        info = pool.announce(json.loads(body.decode("utf-8")))
        wire.send_msg(c, ["started", jid, wire.started_to_wire(info)])
        _c._hold()
    _serve(conn, factory, hostile)


# -- TC-1 / F-3 ---------------------------------------------------------------------------------------
def grandchild_main(conn, factory="tests.service_support:zero", *_a):
    def hostile(c, clf, jid, body):
        pid = os.fork()
        if pid == 0:  # the grandchild: keeps every inherited fd open, the sentinel's write end too
            time.sleep(120)
            os._exit(0)
        with open(os.environ["INTAKE_TEST_GC_FILE"], "w") as fh:
            fh.write(str(pid))
        _c._hold()
    _serve(conn, factory, hostile)


# -- TC-3 -------------------------------------------------------------------------------------------------
def always_partial_main(conn, factory="tests.service_support:zero", *_a):
    def hostile(c, clf, jid, body):
        _c._partial(c)
        _c._hold()
    _serve(conn, factory, hostile, always=True)
