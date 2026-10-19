"""Hostile and probing worker processes for the intake-i5b tests (review R-2 / R-4, tester R2-F1).

Each `*_main` stands in for intake_service.pool._worker_main (the tests patch that module global,
which WorkerPool._spawn reads at every spawn, so the replacement worker is the same stand-in). A
stand-in is what a COMPROMISED worker could do: the worker is the process that parses untrusted
bytes, so the parent must survive anything it sends.

The stand-ins speak whichever pipe protocol the pool under test speaks - the JSON frames of
intake_service.wire (send_msg / recv_msg) when it has them, else the pickled tuples of the
pre-i5b pool - so the same test is RED on the old pool for the real reason (a pickle executed in
the parent, an oversize message accepted, an invalid worker re-pooled) and GREEN on the new one.

probe_factory: a classifier factory ("module:function") whose `version` reports whether THIS
worker process could read a file named by INTAKE_TEST_PROBE_FILE (a sealed secret, R2-F1).
"""
from __future__ import annotations

import os

from intake_service import wire

NEW = hasattr(wire, "send_msg")
OVERSIZE_BYTES = 70 * 1024 * 1024  # over wire.MAX_WORKER_MESSAGE_BYTES (64 MiB)


class _Exec:
    """Unpickling this creates the marker file: code run in whatever process unpickles it."""

    def __init__(self, path: str):
        self.path = path

    def __reduce__(self):
        return (open, (self.path, "w"))


def _send(conn, msg):
    if NEW:
        wire.send_msg(conn, list(msg))
    else:
        conn.send(tuple(msg))


def _recv_job(conn):
    """-> ("job", id) after reading the job (and its body frame), or the other op."""
    if NEW:
        msg = wire.recv_msg(conn, 1 << 16)
        if msg[0] == "job":
            conn.recv_bytes()
        return msg
    return conn.recv()


def _ready(conn):
    _send(conn, ("ready", {"version": "hostile-test/1", "pid": os.getpid()}))


def _serve(conn, on_job):
    _ready(conn)
    while True:
        try:
            msg = _recv_job(conn)
        except (EOFError, OSError):
            return
        if msg[0] == "stop":
            return
        if msg[0] == "job":
            on_job(conn, msg[1])


def pickle_main(conn, *_args):
    """Answers a job with a pickle whose unpickling creates INTAKE_TEST_MARKER."""
    def job(c, jid):
        c.send(_Exec(os.environ["INTAKE_TEST_MARKER"]))
    _serve(conn, job)


def oversize_main(conn, *_args):
    """Answers a job with a 70 MiB `done` message (valid JSON / a valid pickle)."""
    def job(c, jid):
        _send(c, ("done", jid, {"kind": "bad", "detail": "x" * OVERSIZE_BYTES, "result": None}))
    _serve(conn, job)


def invalid_result_main(conn, *_args):
    """Answers a job with a `done` whose result breaks the IntakeResult invariants (clean WITH
    an error)."""
    def job(c, jid):
        _send(c, ("done", jid, {"kind": "result", "detail": "",
                                "result": {"verdict": "clean", "error": "boom", "error_kind": "transient"}}))
    _serve(conn, job)


def wrong_id_main(conn, *_args):
    """Answers a job with a message for another job id, then an unknown op."""
    def job(c, jid):
        _send(c, ("stage6", jid + 1000))
        _send(c, ("lol", jid))
    _serve(conn, job)


def _probe_read() -> str:
    path = os.environ.get("INTAKE_TEST_PROBE_FILE", "")
    try:
        with open(path, "rb") as fh:
            fh.read(1)
        return "probe/READ"
    except Exception as e:  # noqa: BLE001
        return "probe/" + type(e).__name__


def probe_factory():
    from tests import service_support
    return service_support._Stub(0.0, version=_probe_read())
