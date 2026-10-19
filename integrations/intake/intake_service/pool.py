"""The warm pool of KILLABLE screening workers (I5; operator D38/D39).

WHY PROCESSES. The library's stages check a cooperative deadline, but a single library call - a
stdlib parser call, the tokenizer, one model forward pass - cannot be interrupted in-process
(D38), and every I2 round found another one. So every screen() runs in a worker PROCESS and the
parent holds a hard wall clock over it: an overrun is KILLED (SIGKILL) and the item is
`pending` with a transient error - never `clean`.

WHY A WARM POOL. Loading the classifier costs ~12-20 s and ~1.9 GB (hash check of 738 MB, then
the model build). Each worker loads it once at start (the parent waits for every worker to
report ready before the service listens) and then serves request after request. A killed or
crashed worker is replaced in the background; until its replacement is warm the pool has one
worker fewer, and a request that finds no free worker within queue_wait_s gets 503 (Busy).

THE PARENT DERIVES THE ITEM'S IDENTITY (operator D51(a), intake-i5d; this reverses the I5 rule
"the parent never parses the body"). Before it dispatches, the parent itself parses the request
(json.loads of at most INTAKE_MAX_REQUEST_BYTES, already capped by the HTTP layer) and builds the
announcement with the worker's own function (`prepare` -> `announce`: stage 1, then the key =
source/external_id/sha256(raw)). A body that is not a JSON object is `bad` and a key that is not
valid for the caller's connector is `skipped` - both WITHOUT a worker. So the connector binding
and the key are the parent's reading of the caller's bytes, never a worker's claim (the intake-i5c
tester's TC-2: a compromised worker could announce a self-consistent envelope of its own choosing).
The worker still parses and announces; its "started" must be EXACTLY the parent's announcement, or
it is dropped and nothing is stored.
The parent keeps only the announcement, never the parsed body, and parses at most as many bodies
at once as it has workers (the intake-i5d review's RV6-1: an 8 MiB body can parse to ~194 MiB, and
16 in flight would hold ~3 GiB).

THE JOB PROTOCOL (one duplex pipe per worker). Every message is one size-capped JSON frame over
send_bytes/recv_bytes - NEVER a pickle (intake-i5b R-2: unpickling runs code, and the worker is the
process that runs native parsers over untrusted bytes; wire.py has the frames and the caps):
  parent -> worker   ["job", id], then the body as one raw-bytes frame (the only parent send in a job)
  worker             parses the JSON body; stage 1 (envelope.validate) and the idempotency key
  worker -> parent   ["started", id, {key, envelope}] (the raw as base64) or ["started", id, null]
                     when the envelope is invalid: must equal the parent's own announcement
  worker             screen(envelope, classifier=<reporting wrapper>) - no answer is awaited (the
                     go/skip round trip is gone: the parent decided before it dispatched)
  worker -> parent   ["stage6", id] when stages 1-5 are done and the classifier starts
  worker -> parent   ["done", id, {kind: "result", result, detail}]
A worker that breaks the protocol - a frame that is not JSON (a pickle), one over its cap, a
message for another job, an unknown op, a "started" that is not the parent's announcement, an
invalid result - is DROPPED (SIGKILL, discarded, replaced: phase "died"), never re-pooled (R-4),
and the request gets killed_result(). THE ORDER is enforced (intake-i5b TF-3): one "started"; a
`done` only after it, of kind `result`; a result's key must be the announced key (none when the
announcement is null).
EVERY parent -> worker SEND is bounded and guarded (the review's RV5-1): it runs in a helper
thread under a clock, and a send that fails or times out drops and replaces the worker. And run()
drops its worker on ANY unexpected exception, so no failure leaves a worker `busy` forever.

THE WALL CLOCKS (the parent's, measured with time.monotonic):
  transfer    from BEFORE the job is sent to "started": wall_transfer_s (the body is up to
              16 MiB). The send itself runs in a helper thread and is bounded by this clock: a
              body bigger than the pipe buffer, handed to a frozen worker, blocks the send, and
              the worker is killed at the deadline (intake-i5 attempt 1 F-T2)
  stages      from "started" to "stage6" or "done": wall_stages_s (stages 1-5; the library's own
              deadline is 1.6 s, the D34 bound < 2 s)
  classifier  from "stage6" to "done": wall_classifier_s (the classifier's own budget plus slack;
              its budget is checked between chunks, so one forward pass can overshoot it)
EVERY READ of a worker frame - its length header AND its body - is bounded by the clock of the
phase it is read in (intake-i5b TF-1): poll() only says that SOME bytes arrived, and recv_bytes()
then blocks until the whole frame has, so a worker that writes a header and part of a body and
then stops (compromised, or frozen mid-write) would hold the parent past every clock. The read
runs in a helper thread (_read_frame) and the parent waits for it only until the deadline; then
the worker is killed, which ends the read (the pipe's far end closes; on a Unix socket pair the
parent also shuts its end down, in case anything else still holds the far one). The "ready"
frame is read the same way under the start clock (start and every replacement).
A busy worker whose job has outlived every wall clock (max_job_seconds) counts as STUCK, and
status()["serving"] (what /healthz reads) leaves it out.
EVERY WORKER RUNS IN ITS OWN SESSION (os.setsid; the intake-i5c tester's TC-1 / F-3), and the reap
kills the whole process group: a grandchild dies with its worker, so it cannot outlive it or hold the
worker's sentinel (which made the reap wait 5 s). The reap then closes the process object, and a
stored exception carries no traceback, so a dropped worker's fds are released at once, not at the
next cyclic GC (TC-3).
A deadline passing -> killpg -> join -> the worker is discarded and replaced -> the request
gets killed_result(): `pending`, error "worker: killed at the <phase> wall clock", error_kind
transient, with the idempotency key when "started" had arrived (so the item can be stored and
re-screened from bronze). A worker that dies (EOF on its pipe) is the same, phase "died".

The workers hold NO secret: the service removes the keys and the DB password from its own
environment before the pool starts (app.py), and child_env_drop removes any named variable from
the environment a worker is spawned with. A worker opens no socket and has no DB connection.
"""
from __future__ import annotations

import contextlib
import importlib
import itertools
import json
import logging
import multiprocessing as mp
import os
import signal
import threading
import time
from dataclasses import dataclass

from intake.result import IdempotencyKey, IntakeResult

from . import wire

log = logging.getLogger("intake_service.pool")
_CTX = mp.get_context("spawn")
DEFAULT_FACTORY = "intake.classifier:default"
_ENV_LOCK = threading.Lock()


class PoolError(Exception):
    """The pool cannot serve: a worker failed to load, or the pool is closed."""


class Busy(PoolError):
    """No worker became free within queue_wait_s."""


class NotReady(PoolError):
    """No worker is loaded (all are being replaced)."""


@dataclass
class Outcome:
    kind: str                 # result | killed | died | bad | skipped
    result: IntakeResult | None
    started: dict | None      # {"key": {...}, "envelope": {...}} or None
    phase: str = ""           # transfer | stages | classifier (killed / died)
    elapsed_s: float = 0.0
    detail: str = ""
    worker_pid: int = 0
    kill_s: float | None = None  # from the deadline to the reaped process


def _describe(e: BaseException) -> str:
    try:
        return f"{type(e).__name__}: {e}"[:300]
    except BaseException:  # noqa: BLE001
        return type(e).__name__


def killed_result(out: Outcome) -> IntakeResult:
    """The fail-closed result for a job that produced none (killed, died, unreadable)."""
    key = None
    if out.started and isinstance(out.started.get("key"), dict):
        k = out.started["key"]
        key = IdempotencyKey(k["source"], k["external_id"], k["sha256"])
    if out.kind == "killed":
        msg = f"worker: killed at the {out.phase} wall clock after {out.elapsed_s:.3f}s"
    else:
        msg = f"worker: died during {out.phase or 'the job'} ({out.detail or 'no result'})"
    return IntakeResult(verdict="pending", key=key, error=msg[:300], error_kind="transient")


# -- the job: the same function in a worker process and in the tests' inline pool ----------------
class _Reporting:
    """Wraps the classifier so the parent learns when stage 6 starts (its own wall clock)."""

    def __init__(self, clf, emit):
        self._clf = clf
        self._emit = emit
        self.version = getattr(clf, "version", None)

    def score(self, fields):
        self._emit("stage6")
        return self._clf.score(fields)


def announce(obj: dict) -> dict | None:
    """Stage 1 + the idempotency key, for the parent (the connector binding check and the bronze
    row). None when the envelope is invalid: the screen will return `rejected`."""
    from intake import envelope, revisions
    try:
        env = envelope.validate(obj)
    except Exception:  # noqa: BLE001 - Rejected or anything else: the screen decides
        return None
    key = revisions.key_for(env.source, env.external_id, env.raw)
    return {"key": key.to_dict(),
            "envelope": {"source": env.source, "connector": env.connector, "external_id": env.external_id,
                         "fetched_at": env.fetched_at, "content_type": str(obj["content_type"]),
                         "raw": env.raw, "metadata": dict(env.metadata), "links": list(env.links)}}


def prepare(body: bytes, gate) -> tuple[Outcome | None, dict | None, dict | None]:
    """Parse, announce, ask the gate: (early outcome, announcement, parsed body). The early outcome
    is `bad` (not a JSON object) or `skipped` (the gate refused), else None. The PARENT runs this
    before it dispatches (D51(a)); a worker runs it too, with a gate that only announces."""
    try:
        obj = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return Outcome("bad", None, None, detail="the body is not UTF-8 JSON"), None, None
    if not isinstance(obj, dict):
        return Outcome("bad", None, None, detail="the body is not a JSON object"), None, None
    info = announce(obj)
    refusal = gate(info)
    if refusal:
        return Outcome("skipped", None, info, detail=str(refusal)), info, obj
    return None, info, obj


def screen_job(body: bytes, clf, gate, emit) -> Outcome:
    """Parse, announce, ask the gate, screen. Never raises for content (screen() does not)."""
    from intake import pipeline
    early, info, obj = prepare(body, gate)
    if early is not None:
        return early
    result = pipeline.screen(obj, classifier=_Reporting(clf, emit))
    return Outcome("result", result, info)


def _make(factory: str):
    mod, _, fn = factory.partition(":")
    return getattr(importlib.import_module(mod), fn)()


def _worker_entry(main, conn, *args) -> None:
    """Every worker process starts here: its own session first (TC-1 / F-3: the reap kills the
    whole group, grandchildren included), then the worker main (pool._worker_main; the tests pass
    their stand-ins)."""
    if hasattr(os, "setsid"):
        os.setsid()
    main(conn, *args)


def _worker_main(conn, factory: str, max_body: int = 16 * 1024 * 1024 + 1) -> None:
    """A worker process: load once, then serve jobs until told to stop or the pipe closes."""
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        clf = _make(factory)
        load = getattr(clf, "load", None)
        if callable(load):
            load()
        from intake import pipeline  # noqa: F401 - build the Unicode tables before "ready"
        version = getattr(clf, "version", None)
        wire.send_msg(conn, ["ready", {"version": None if version is None else str(version), "pid": os.getpid()}])
    except BaseException as e:  # noqa: BLE001
        with contextlib.suppress(Exception):
            wire.send_msg(conn, ["failed", _describe(e)])
        return
    while True:
        try:
            msg = wire.recv_msg(conn, wire.MAX_CONTROL_BYTES)
            op = msg[0]
            if op == "job":
                body = conn.recv_bytes(max_body)
        except (EOFError, OSError, wire.WireError):
            return
        if op == "stop":
            return
        if op == "env":
            wire.send_msg(conn, ["env", sorted(os.environ)])
            continue
        if op != "job":
            continue
        job_id = msg[1]

        def gate(info, job_id=job_id):  # announce only: the parent decided before it dispatched
            wire.send_msg(conn, ["started", job_id, wire.started_to_wire(info)])
            return None

        def emit(event, job_id=job_id):
            wire.send_msg(conn, [event, job_id])

        out = screen_job(body, clf, gate, emit)
        wire.send_msg(conn, ["done", job_id, {"kind": out.kind, "detail": out.detail,
                                              "result": None if out.result is None else out.result.to_dict()}])


# -- the parent side ------------------------------------------------------------------------------
class _Worker:
    def __init__(self, proc, conn):
        self.proc = proc
        self.conn = conn
        self.pid = proc.pid or 0
        self.os_pid = proc.pid or 0  # the process (group) id the reap kills; w.pid is what it reported
        self.version = None
        # reads/sends a clock gave up on (TF-1, RV5-1): the reap ends them before it closes the pipe
        self.abandoned: list[threading.Thread] = []
        self.exitcode: int | None = None  # recorded by the reap, before it closes the process object
        self.reaped = False


class _ReadTimeout(Exception):
    """The phase clock ran out before a whole frame arrived (TF-1)."""


def _read_frame(w: _Worker, max_bytes: int, deadline: float) -> list:
    """One frame from the worker, bounded by `deadline` (time.monotonic) - header and body (TF-1).
    -> the message; raises _ReadTimeout when the clock runs out first (the caller then kills the
    worker, which ends the read), else what wire.recv_msg raises (EOFError, OSError, WireError)."""
    left = deadline - time.monotonic()
    if left <= 0 or not w.conn.poll(left):
        raise _ReadTimeout()
    box: list = []
    done = threading.Event()

    def read():
        try:
            box.append((True, wire.recv_msg(w.conn, max_bytes)))
        except BaseException as e:  # noqa: BLE001 - handed to the waiting thread
            box.append((False, e.with_traceback(None)))  # TC-3: no frame cycle holds the fds
        finally:
            done.set()

    th = threading.Thread(target=read, name="intake-job-recv", daemon=True)
    th.start()
    if not done.wait(max(0.0, deadline - time.monotonic())):
        w.abandoned.append(th)
        raise _ReadTimeout()
    ok, value = box[0]
    if not ok:
        raise value
    return value


def _send_bounded(w: _Worker, frames, deadline: float) -> str:
    """Send `frames` (each: a list -> one JSON frame, bytes -> one raw frame) to the worker in a
    helper thread bounded by `deadline` (RV5-1, F-T2). -> "" when sent, "timeout" when the clock ran
    out first (the caller drops the worker, which ends the send), else what went wrong."""
    failed: list = []
    done = threading.Event()

    def send():
        try:
            for f in frames:
                if isinstance(f, (bytes, bytearray, memoryview)):
                    w.conn.send_bytes(f)
                else:
                    wire.send_msg(w.conn, f)
        except BaseException as e:  # noqa: BLE001 - handed to the waiting thread
            failed.append(_describe(e))
        finally:
            done.set()

    th = threading.Thread(target=send, name="intake-job-send", daemon=True)
    th.start()
    if not done.wait(max(0.0, deadline - time.monotonic())):
        w.abandoned.append(th)
        return "timeout"
    return failed[0] if failed else ""


def _order_violation(announced: bool, kind: str, result: IntakeResult | None, started) -> str:
    """TF-3: what is wrong with a `done` of this kind (`announced`: the worker's "started" has
    arrived and matched), or "" when nothing is. The parent already answered `bad` and `skipped`
    itself, so a worker's `done` is only ever a result."""
    if not announced:
        return f"a done of kind {kind} before any started"
    if kind != "result":
        return f"a done of kind {kind} (only result is valid: the parent decides bad and skipped)"
    if result is not None and result.key is not None:
        k = (started or {}).get("key")
        if k is None or (result.key.source, result.key.external_id, result.key.sha256) != \
                (k["source"], k["external_id"], k["sha256"]):
            return "a result whose key is not the announced key"
    return ""


def _shutdown(conn) -> None:
    """Wake a reader blocked on a Unix socket-pair connection (Windows pipes need no help: the
    killed worker's handle closing ends the read)."""
    if os.name != "posix":
        return
    import socket
    with contextlib.suppress(Exception):
        s = socket.socket(fileno=os.dup(conn.fileno()))
        try:
            s.shutdown(socket.SHUT_RDWR)
        finally:
            s.close()


@contextlib.contextmanager
def _scrubbed_env(names):
    with _ENV_LOCK:
        saved = {n: os.environ.pop(n) for n in names if n in os.environ}
        try:
            yield
        finally:
            os.environ.update(saved)


class WorkerPool:
    def __init__(self, size: int, *, factory: str = DEFAULT_FACTORY, wall_stages_s: float,
                 wall_transfer_s: float, wall_classifier_s: float, start_timeout_s: float,
                 queue_wait_s: float, child_env_drop=(), respawn_backoff_s: float = 30.0,
                 max_body_bytes: int = 16 * 1024 * 1024, max_message_bytes: int = wire.MAX_WORKER_MESSAGE_BYTES):
        if size < 1:
            raise ValueError("a pool has at least one worker")
        self.size = size
        self._factory = factory
        self.wall_stages_s = wall_stages_s
        self.wall_transfer_s = wall_transfer_s
        self.wall_classifier_s = wall_classifier_s
        self.start_timeout_s = start_timeout_s
        self.queue_wait_s = queue_wait_s
        self._drop = tuple(child_env_drop)
        self._backoff = respawn_backoff_s
        self.max_body_bytes = max_body_bytes
        self.max_message_bytes = max_message_bytes
        self._cv = threading.Condition()
        self._parse_slots = threading.BoundedSemaphore(size)  # RV6-1: parses in the parent at once
        self._idle: list[_Worker] = []
        self._busy: set[_Worker] = set()
        self._replacing = 0
        self._closed = False
        self._ids = itertools.count(1)
        self.kills = 0
        self.deaths = 0
        self.version: str | None = None
        self._job_started: dict = {}
        self.max_job_seconds = wall_transfer_s + wall_stages_s + wall_classifier_s + 5.0

    # -- lifecycle ------------------------------------------------------------------------------
    def _spawn(self) -> _Worker:
        parent, child = _CTX.Pipe(duplex=True)
        with _scrubbed_env(self._drop):
            proc = _CTX.Process(target=_worker_entry,
                                args=(_worker_main, child, self._factory, self.max_body_bytes + 1),
                                daemon=True, name="intake-worker")
            proc.start()
        child.close()
        return _Worker(proc, parent)

    def _await_ready(self, w: _Worker, timeout: float) -> None:
        try:
            try:
                msg = _read_frame(w, wire.MAX_CONTROL_BYTES, time.monotonic() + timeout)
            except _ReadTimeout:
                raise PoolError(f"a worker did not finish loading in {timeout:.0f}s") from None
        except (EOFError, OSError):
            self._reap(w)
            raise PoolError(f"a worker exited while loading (exit code {w.exitcode})") from None
        except wire.WireError as e:
            self._reap(w)
            raise PoolError(f"a worker sent an invalid ready message ({e})") from None
        except PoolError:
            self._reap(w)
            raise
        info = msg[1] if len(msg) > 1 else None
        if msg[0] != "ready" or not isinstance(info, dict):
            self._reap(w)
            detail = info if isinstance(info, str) else msg[0]
            raise PoolError(f"a worker failed to load: {str(detail)[:300]}")
        version, pid = info.get("version"), info.get("pid")
        w.version = version if isinstance(version, str) else None
        w.pid = pid if isinstance(pid, int) and pid > 0 else w.pid
        self.version = w.version

    def start(self) -> None:
        """Spawn every worker and wait until each has loaded; any failure refuses the start."""
        workers = [self._spawn() for _ in range(self.size)]
        try:
            for w in workers:
                self._await_ready(w, self.start_timeout_s)
        except PoolError:
            for w in workers:
                self._reap(w)
            raise
        with self._cv:
            self._idle.extend(workers)
            self._cv.notify_all()
        log.info("worker pool ready: %d worker(s), classifier %s", self.size, self.version)

    def _reap(self, w: _Worker) -> None:
        if w.reaped:  # start() may reap a worker _await_ready already reaped
            return
        w.reaped = True
        # TC-1 / F-3: the worker leads its own process group (setsid); killing the GROUP ends any
        # grandchild too, so nothing outlives the worker or holds its sentinel open (the join below
        # then returns at once instead of waiting out its 5 s)
        if hasattr(os, "killpg") and w.os_pid:
            with contextlib.suppress(OSError):
                os.killpg(w.os_pid, signal.SIGKILL)
        with contextlib.suppress(Exception):
            if w.proc.is_alive():
                w.proc.kill()
            w.proc.join(5)
        if w.abandoned:  # a read/send the clock gave up on: end it before the close (TF-1, RV5-1)
            _shutdown(w.conn)
            for th in w.abandoned:
                th.join(2)
            w.abandoned.clear()
        with contextlib.suppress(Exception):
            w.exitcode = w.proc.exitcode
            w.proc.close()  # TC-3: the sentinel fd now, not at the next cyclic GC
        with contextlib.suppress(Exception):
            w.conn.close()

    def _replace(self) -> None:
        with self._cv:
            if self._closed:
                return
            self._replacing += 1

        def run():
            try:
                while True:
                    with self._cv:
                        if self._closed:
                            return
                    w = self._spawn()
                    try:
                        self._await_ready(w, self.start_timeout_s)
                    except PoolError as e:
                        log.error("worker replacement failed (%s); retrying in %.0fs", e, self._backoff)
                        time.sleep(self._backoff)
                        continue
                    with self._cv:
                        if self._closed:
                            self._reap(w)
                            return
                        self._idle.append(w)
                        self._cv.notify_all()
                    log.info("worker replaced (pid %s)", w.pid)
                    return
            finally:
                with self._cv:
                    self._replacing -= 1

        threading.Thread(target=run, name="intake-worker-replace", daemon=True).start()

    def close(self) -> None:
        with self._cv:
            self._closed = True
            workers = list(self._idle) + list(self._busy)
            self._idle.clear()
            self._cv.notify_all()
        for w in workers:
            if not _send_bounded(w, [["stop"]], time.monotonic() + 2.0):
                with contextlib.suppress(Exception):
                    w.proc.join(2)
            self._reap(w)

    def status(self) -> dict:
        now = time.monotonic()
        with self._cv:
            stuck = sum(1 for w in self._busy if now - self._job_started.get(w, now) > self.max_job_seconds)
            ready = len(self._idle) + len(self._busy)
            return {"ready": ready, "serving": ready - stuck, "stuck": stuck, "total": self.size,
                    "busy": len(self._busy), "replacing": self._replacing, "kills": self.kills,
                    "deaths": self.deaths}

    def status_pids(self) -> list[int]:
        with self._cv:
            return [w.pid for w in list(self._idle) + list(self._busy)]

    # -- one job --------------------------------------------------------------------------------
    def _acquire(self, wait: float) -> _Worker:
        end = time.monotonic() + wait
        with self._cv:
            while not self._idle:
                if self._closed:
                    raise NotReady("the pool is closed")
                left = end - time.monotonic()
                if left <= 0:
                    if not self._busy:
                        raise NotReady("no worker is loaded (replacement in progress)")
                    raise Busy(f"no worker free within {wait:.1f}s")
                self._cv.wait(left)
            w = self._idle.pop()
            self._busy.add(w)
            self._job_started[w] = time.monotonic()
            return w

    def _release(self, w: _Worker) -> None:
        with self._cv:
            self._busy.discard(w)
            self._job_started.pop(w, None)
            if not self._closed:
                self._idle.append(w)
                self._cv.notify_all()

    def _drop_worker(self, w: _Worker, killed: bool) -> float:
        t = time.monotonic()
        self._reap(w)
        with self._cv:
            self._busy.discard(w)
            self._job_started.pop(w, None)
            if killed:
                self.kills += 1
            else:
                self.deaths += 1
        self._replace()
        return time.monotonic() - t

    def worker_environment(self) -> list[str]:
        """The variable NAMES a worker process sees (tests; never values)."""
        w = self._acquire(self.queue_wait_s)
        deadline = time.monotonic() + self.wall_transfer_s
        try:
            if _send_bounded(w, [["env"]], deadline):
                raise OSError("the env request was not sent")
            msg = _read_frame(w, wire.MAX_CONTROL_BYTES, deadline)
        except (_ReadTimeout, EOFError, OSError, wire.WireError):
            self._drop_worker(w, killed=False)
            return []
        self._release(w)
        return [str(n) for n in msg[1]] if msg[0] == "env" and len(msg) > 1 and isinstance(msg[1], list) else []

    def run(self, body: bytes, gate) -> Outcome:
        """Screen one request body in a worker. gate(announcement) -> None (go) or a refusal.
        The PARENT parses the body and runs the gate before any worker is involved (D51(a))."""
        t0 = time.monotonic()

        def checked_gate(info):
            try:
                return gate(info)
            except Exception as e:  # noqa: BLE001 - a broken gate refuses
                return "gate: " + type(e).__name__

        # RV6-1 (the intake-i5d review): the parsed body is NOT kept - a near-cap body parses to ~24x
        # its size, and a request then waits in _acquire and runs a whole job - and at most as many
        # bodies are parsed at once as there are workers (more could not be screened at once anyway)
        with self._parse_slots:
            early, info = prepare(body, checked_gate)[:2]
        if early is not None:
            early.elapsed_s = time.monotonic() - t0
            return early
        expected = wire.started_to_wire(info)
        w = self._acquire(self.queue_wait_s)
        try:
            return self._job(w, body, info, expected)
        except BaseException as e:
            # RV5-1: whatever went wrong, the worker is never left `busy` - drop and replace it
            with self._cv:
                busy = w in self._busy
            if busy:
                self._drop_worker(w, killed=False)
            if not isinstance(e, Exception):
                raise
            log.error("the job on worker %s failed in the parent (%s): worker dropped", w.pid, _describe(e))
            return Outcome("died", None, None, "", time.monotonic() - t0,
                           f"the parent failed during the job ({_describe(e)})"[:300], w.pid)

    def _job(self, w: _Worker, body: bytes, info, expected) -> Outcome:
        jid = next(self._ids)
        t0 = time.monotonic()
        phase = "transfer"
        deadline = t0 + self.wall_transfer_s
        started = None
        # F-T2 / RV5-1: the send is bounded by the transfer clock and guarded (a frozen worker never
        # drains the pipe; a gone one breaks it)
        why = _send_bounded(w, [["job", jid], body], deadline)
        if why == "timeout":
            elapsed = time.monotonic() - t0
            kill_s = self._drop_worker(w, killed=True)
            log.warning("worker %s killed at the transfer wall clock after %.3fs (the send did not finish)",
                        w.pid, elapsed)
            return Outcome("killed", None, None, phase, elapsed, "wall clock (the send)", w.pid, kill_s)
        if why:
            self._drop_worker(w, killed=False)
            return Outcome("died", None, None, phase, time.monotonic() - t0,
                           f"the pipe to the worker broke ({why})"[:300], w.pid)
        announced = False
        while True:
            try:
                msg = _read_frame(w, self.max_message_bytes, deadline)
            except _ReadTimeout:
                msg = None
            except EOFError:
                elapsed = time.monotonic() - t0
                self._drop_worker(w, killed=False)
                code = w.exitcode
                log.warning("worker %s died during %s (exit code %s)", w.pid, phase, code)
                return Outcome("died", None, started, phase, elapsed, f"exit code {code}", w.pid)
            except (OSError, wire.WireError) as e:
                # an oversize frame (refused from its length header) or one that is not a JSON
                # message - a pickle among them: the worker is dropped, never re-pooled (R-2, R-4)
                oversize = isinstance(e, OSError) and "message length" in str(e)
                return self._violation(w, t0, started, phase,
                                       "an oversize message" if oversize else f"an invalid message ({_describe(e)})")
            if msg is None:
                elapsed = time.monotonic() - t0
                kill_s = self._drop_worker(w, killed=True)
                log.warning("worker %s killed at the %s wall clock after %.3fs", w.pid, phase, elapsed)
                return Outcome("killed", None, started, phase, elapsed, "wall clock", w.pid, kill_s)
            kind = msg[0]
            if len(msg) < 2 or isinstance(msg[1], bool) or msg[1] != jid:
                return self._violation(w, t0, started, phase, f"a {kind[:20]!r} message for another job")
            if kind == "started" and not announced and len(msg) == 3:
                # TC-2: the worker's announcement must be EXACTLY the parent's own; anything else is a
                # worker naming an item the caller did not send - dropped, and no key to store under
                try:
                    same = msg[2] == expected
                except RecursionError:
                    same = False
                if not same:
                    return self._violation(w, t0, None, phase, "a started that is not the parent's announcement")
                announced = True
                started = info
                phase = "stages"
                deadline = time.monotonic() + self.wall_stages_s
            elif kind == "stage6" and phase == "stages" and len(msg) == 2:
                phase = "classifier"
                deadline = time.monotonic() + self.wall_classifier_s
            elif kind == "done" and len(msg) == 3:
                elapsed = time.monotonic() - t0
                try:
                    out_kind, result, detail = wire.done_from_wire(msg[2])
                except wire.WireError as e:
                    # R-4: checked BEFORE the worker goes back to idle; an invalid result drops it
                    return self._violation(w, t0, started, phase, str(e))
                why = _order_violation(announced, out_kind, result, started)
                if why:
                    return self._violation(w, t0, started, phase, why)
                self._release(w)
                return Outcome(out_kind, result, started, phase, elapsed, detail, w.pid)
            else:
                return self._violation(w, t0, started, phase, f"an unexpected {kind[:20]!r} message in {phase}")

    def _violation(self, w: _Worker, t0: float, started, phase: str, why: str) -> Outcome:
        """A worker broke the protocol: drop it (SIGKILL, discard, replace) - never re-pool it."""
        elapsed = time.monotonic() - t0
        self._drop_worker(w, killed=False)
        log.warning("worker %s dropped during %s: it sent %s", w.pid, phase, why[:200])
        return Outcome("died", None, started, phase, elapsed, why[:300], w.pid)
