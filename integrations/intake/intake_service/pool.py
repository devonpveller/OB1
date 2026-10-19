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

THE JOB PROTOCOL (one duplex pipe per worker; the parent never parses untrusted content).
Every message is one size-capped JSON frame over send_bytes/recv_bytes - NEVER a pickle
(intake-i5b R-2: unpickling runs code, and the worker is the process exposed to untrusted bytes;
wire.py has the frames and the caps):
  parent -> worker   ["job", id], then the body as one raw-bytes frame
  worker             parses the JSON body; stage 1 (envelope.validate) and the idempotency key
  worker -> parent   ["started", id, {key, envelope}] (the raw as base64) or ["started", id, null]
                     when the envelope is invalid (the screen then returns its `rejected` result)
  parent -> worker   ["go"] or ["skip", reason]: the parent checks the key's connector binding
  worker             screen(envelope, classifier=<reporting wrapper>)
  worker -> parent   ["stage6", id] when stages 1-5 are done and the classifier starts
  worker -> parent   ["done", id, {kind, result, detail}]
A worker that breaks the protocol - a frame that is not JSON (a pickle), one over its cap, a
message for another job, an unknown op, an invalid "started" or result - is DROPPED (SIGKILL,
discarded, replaced: phase "died"), never re-pooled (R-4), and the request gets killed_result().

THE WALL CLOCKS (the parent's, measured with time.monotonic):
  transfer    from BEFORE the job is sent to "started": wall_transfer_s (the body is up to
              16 MiB). The send itself runs in a helper thread and is bounded by this clock: a
              body bigger than the pipe buffer, handed to a frozen worker, blocks the send, and
              the worker is killed at the deadline (intake-i5 attempt 1 F-T2)
  stages      from "go" to "stage6" or "done": wall_stages_s (stages 1-5; the library's own
              deadline is 1.6 s, the D34 bound < 2 s)
  classifier  from "stage6" to "done": wall_classifier_s (the classifier's own budget plus slack;
              its budget is checked between chunks, so one forward pass can overshoot it)
A busy worker whose job has outlived every wall clock (max_job_seconds) counts as STUCK, and
status()["serving"] (what /healthz reads) leaves it out.
A deadline passing -> proc.kill() -> join -> the worker is discarded and replaced -> the request
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


def screen_job(body: bytes, clf, gate, emit) -> Outcome:
    """Parse, announce, ask the gate, screen. Never raises for content (screen() does not)."""
    from intake import pipeline
    try:
        obj = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return Outcome("bad", None, None, detail="the body is not UTF-8 JSON")
    if not isinstance(obj, dict):
        return Outcome("bad", None, None, detail="the body is not a JSON object")
    info = announce(obj)
    refusal = gate(info)
    if refusal:
        return Outcome("skipped", None, info, detail=str(refusal))
    result = pipeline.screen(obj, classifier=_Reporting(clf, emit))
    return Outcome("result", result, info)


def _make(factory: str):
    mod, _, fn = factory.partition(":")
    return getattr(importlib.import_module(mod), fn)()


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

        def gate(info, job_id=job_id):
            wire.send_msg(conn, ["started", job_id, wire.started_to_wire(info)])
            reply = wire.recv_msg(conn, wire.MAX_CONTROL_BYTES)
            return None if reply[0] == "go" else (str(reply[1]) if len(reply) > 1 else "refused")

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
        self.version = None


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
            proc = _CTX.Process(target=_worker_main, args=(child, self._factory, self.max_body_bytes + 1),
                                daemon=True, name="intake-worker")
            proc.start()
        child.close()
        return _Worker(proc, parent)

    def _await_ready(self, w: _Worker, timeout: float) -> None:
        try:
            if not w.conn.poll(timeout):
                raise PoolError(f"a worker did not finish loading in {timeout:.0f}s")
            msg = wire.recv_msg(w.conn, wire.MAX_CONTROL_BYTES)
        except (EOFError, OSError):
            w.proc.join(5)
            self._reap(w)
            raise PoolError(f"a worker exited while loading (exit code {w.proc.exitcode})") from None
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
        with contextlib.suppress(Exception):
            if w.proc.is_alive():
                w.proc.kill()
            w.proc.join(5)
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
            with contextlib.suppress(Exception):
                wire.send_msg(w.conn, ["stop"])
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
        try:
            wire.send_msg(w.conn, ["env"])
            msg = wire.recv_msg(w.conn, wire.MAX_CONTROL_BYTES)
            return [str(n) for n in msg[1]] if msg[0] == "env" and isinstance(msg[1], list) else []
        finally:
            self._release(w)

    def run(self, body: bytes, gate) -> Outcome:
        """Screen one request body in a worker. gate(started_info) -> None (go) or a refusal."""
        w = self._acquire(self.queue_wait_s)
        jid = next(self._ids)
        t0 = time.monotonic()
        phase = "transfer"
        deadline = t0 + self.wall_transfer_s
        started = None
        # F-T2: the send is bounded by the transfer clock (a frozen worker never drains the pipe)
        sent = threading.Event()
        failed: list = []

        def _send():
            try:
                wire.send_msg(w.conn, ["job", jid])
                w.conn.send_bytes(body)
            except Exception as e:  # noqa: BLE001
                failed.append(e)
            finally:
                sent.set()

        threading.Thread(target=_send, name="intake-job-send", daemon=True).start()
        if not sent.wait(max(0.0, deadline - time.monotonic())):
            elapsed = time.monotonic() - t0
            kill_s = self._drop_worker(w, killed=True)
            log.warning("worker %s killed at the transfer wall clock after %.3fs (the send did not finish)",
                        w.pid, elapsed)
            return Outcome("killed", None, None, phase, elapsed, "wall clock (the send)", w.pid, kill_s)
        if failed:
            self._drop_worker(w, killed=False)
            return Outcome("died", None, None, phase, time.monotonic() - t0, "the pipe to the worker broke", w.pid)
        while True:
            left = deadline - time.monotonic()
            try:
                ready = left > 0 and w.conn.poll(left)
                msg = wire.recv_msg(w.conn, self.max_message_bytes) if ready else None
            except EOFError:
                elapsed = time.monotonic() - t0
                code = None
                with contextlib.suppress(Exception):
                    w.proc.join(1)
                    code = w.proc.exitcode
                self._drop_worker(w, killed=False)
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
            if kind == "started" and phase == "transfer" and len(msg) == 3:
                try:
                    started = wire.started_from_wire(msg[2])
                except wire.WireError as e:
                    return self._violation(w, t0, None, phase, f"an invalid started message ({e})")
                try:
                    refusal = gate(started)
                except Exception as e:  # noqa: BLE001 - a broken gate refuses
                    refusal = "gate: " + type(e).__name__
                if refusal:
                    wire.send_msg(w.conn, ["skip", str(refusal)])
                else:
                    wire.send_msg(w.conn, ["go"])
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
