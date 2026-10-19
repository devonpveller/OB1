"""Start-up of the intake service (I5). THE ORDER IS THE POINT: nothing listens, and no worker
loads, until everything that can be checked has been.

  1. configuration (settings.load): any invalid value -> exit 2 (EXIT_CONFIG), naming the
     variable, never a secret value (I4 R3-T3: the D40 policy point is validated here). The three
     secrets are read from their FILES here (intake-i5b R2-F1: never the environment, which every
     `docker exec` process inherits; a secret name in the environment is refused)
  2. the classifier files (weights.verify_model_dir): missing or not the pinned bytes -> exit 3
  3. the process makes itself NON-DUMPABLE (prctl PR_SET_DUMPABLE 0; exit 5 if that fails): a
     worker runs with the same uid - non-dumpable is what stops a worker (no capability) reading
     /proc/1/environ or /proc/1/mem (intake-i5 attempt 1 F-T1). The second-opinion key goes into
     the Judge's closure (the library's); the DB password and caller keys stay in Settings'
     masked objects; os.environ never held them (and child_env_drop names them, belt and braces)
  3b. the secrets directory is SEALED (seal_secrets, Landlock; exit 5 if that fails): this
     process and every process it starts from now on - every worker, every replacement - can no
     longer read a file under it. The bind is world-readable on this host (a Windows source
     mounts 0777; 0400 cannot be enforced), and a worker has the service's uid, so without the
     seal a compromised worker would simply read the files. A Landlock domain also keeps its
     members from ptrace-ing a process outside it, such as a `docker exec` probe
  4. the warm pool: every worker loads and verifies the model; any failure -> exit 4
  5. the loops (second opinion, re-screen, purge), then the HTTP server
SIGTERM stops the server, the loops and the workers.
"""
from __future__ import annotations

import errno
import logging
import os
import signal
import sys
import threading

from . import relay, settings
from .weights import WeightsRefused, verify_model_dir

EXIT_CONFIG = 2
EXIT_WEIGHTS = 3
EXIT_WORKERS = 4
EXIT_HARDEN = 5
EXIT_USAGE = 64
log = logging.getLogger("intake_service")


def _logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    if not any(getattr(h, "_intake", False) for h in root.handlers):
        h = logging.StreamHandler(sys.stderr)
        h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        h._intake = True  # type: ignore[attr-defined]
        root.addHandler(h)
    root.setLevel(level)


def harden_process() -> None:
    """PR_SET_DUMPABLE 0 for this process (Linux). Children started by exec become dumpable
    again (their own environ holds no secret); this process's environ and memory are then
    readable only with CAP_SYS_PTRACE, which no process in the container has. Raises OSError
    when the kernel refuses; a no-op (logged) where there is no prctl - the service runs only in
    its Linux container."""
    if not sys.platform.startswith("linux"):
        log.warning("not Linux: the process is NOT made non-dumpable")
        return
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    PR_SET_DUMPABLE, PR_GET_DUMPABLE = 4, 3
    if libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 or libc.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_DUMPABLE, 0) refused")


# Landlock (linux/landlock.h; the syscall numbers are the same on every architecture)
_SYS_CREATE_RULESET, _SYS_ADD_RULE, _SYS_RESTRICT_SELF = 444, 445, 446
_LANDLOCK_CREATE_RULESET_VERSION = 1
_LANDLOCK_RULE_PATH_BENEATH = 1
_LANDLOCK_ACCESS_FS_READ_FILE = 1 << 2
_PR_SET_NO_NEW_PRIVS = 38


def _outside(path: str) -> list[str]:
    """Every entry beside the path from / down to it: granting each of them leaves exactly the
    path's own subtree without a rule."""
    parts = [x for x in path.split("/") if x]
    out, cur = [], "/"
    for part in parts:
        out += [os.path.join(cur, name) for name in sorted(os.listdir(cur)) if name != part]
        cur = os.path.join(cur, part)
    return out


def seal_secrets(path: str) -> None:
    """Deny READING FILES under `path` to this process and every process it starts afterwards
    (Landlock, ABI >= 1; irreversible). Only file reads are handled, so execution, writes and
    directory listing are unchanged; every other part of the file system stays readable (a
    read rule on each entry beside the path, from / down). The calling thread must be the only
    one: a Landlock domain covers the thread that enforces it and its future children only.
    Verified before it returns: a file under `path` must no longer open. Raises OSError (the
    service exits 5). Not Linux: a logged no-op - the service runs only in its Linux container."""
    if not sys.platform.startswith("linux"):
        log.warning("not Linux: the secrets directory is NOT sealed")
        return
    import ctypes
    real = os.path.realpath(path)
    if real == "/" or not os.path.isdir(real):
        raise OSError(errno.EINVAL, f"cannot seal {path!r}: not a directory below /")
    tasks = os.listdir("/proc/self/task")
    if len(tasks) != 1:
        raise OSError(errno.EBUSY, f"cannot seal with {len(tasks)} threads running (the seal covers one)")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    L = ctypes.c_long
    abi = libc.syscall(L(_SYS_CREATE_RULESET), None, L(0), L(_LANDLOCK_CREATE_RULESET_VERSION))
    if abi < 1:
        raise OSError(ctypes.get_errno(), "Landlock is not available in this kernel")

    class _Ruleset(ctypes.Structure):
        _fields_ = [("handled_access_fs", ctypes.c_uint64)]

    class _PathBeneath(ctypes.Structure):
        _pack_ = 1
        _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

    attr = _Ruleset(_LANDLOCK_ACCESS_FS_READ_FILE)
    rfd = libc.syscall(L(_SYS_CREATE_RULESET), ctypes.byref(attr), L(ctypes.sizeof(attr)), L(0))
    if rfd < 0:
        raise OSError(ctypes.get_errno(), "landlock_create_ruleset failed")
    skipped = 0
    try:
        for entry in _outside(real):
            try:
                fd = os.open(entry, os.O_PATH | os.O_CLOEXEC)
            except OSError:
                skipped += 1  # a dangling link: nothing to read there
                continue
            try:
                rule = _PathBeneath(_LANDLOCK_ACCESS_FS_READ_FILE, fd)
                if libc.syscall(L(_SYS_ADD_RULE), L(rfd), L(_LANDLOCK_RULE_PATH_BENEATH), ctypes.byref(rule), L(0)) != 0:
                    skipped += 1  # unreadable from now on: costs availability, never secrecy
                    log.warning("seal: no read rule for %s (errno %d)", entry, ctypes.get_errno())
            finally:
                os.close(fd)
        if libc.prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "prctl(PR_SET_NO_NEW_PRIVS) refused")
        if libc.syscall(L(_SYS_RESTRICT_SELF), L(rfd), L(0)) != 0:
            raise OSError(ctypes.get_errno(), "landlock_restrict_self failed")
    finally:
        os.close(rfd)
    for name in sorted(os.listdir(real)):
        f = os.path.join(real, name)
        if os.path.isfile(f):
            try:
                with open(f, "rb"):
                    pass
            except PermissionError:
                continue
            raise OSError(errno.EPERM, f"the seal did not take: {name} is still readable")
    log.info("secrets directory sealed (Landlock ABI %d; %d entr%s without a rule)", abi, skipped,
             "y" if skipped == 1 else "ies")


def main(argv=None, env=None, *, start: bool = True, files=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    cmd = argv[0] if argv else "serve"
    _logging()
    if cmd == "relay":
        return relay.main(env)
    if cmd not in ("serve", "verify"):
        log.error("usage: python -m intake_service [serve|relay|verify]")
        return EXIT_USAGE
    try:
        s = settings.load(env)
    except settings.ConfigError as e:
        log.error("config refused, not starting: %s", e)
        return EXIT_CONFIG
    _logging(s.log_level)
    try:
        sums = verify_model_dir(s.classifier.model_dir, files)
    except WeightsRefused as e:
        log.error("classifier files refused, not starting: %s", e)
        return EXIT_WEIGHTS
    log.info("classifier files verified: %s", ", ".join(f"{n} {h[:12]}" for n, h in sums.items()))
    if cmd == "verify" or not start:
        return 0
    return _serve(s, env)


def _serve(s, env) -> int:
    from intake.second_opinion import KEY_ENV, Judge
    from transport import http_gateway

    from .core import Intake, Scheduler
    from .web import Router, Server
    from .metrics import Metrics
    from .pool import PoolError, WorkerPool
    from .store import PgStore

    try:
        harden_process()
    except OSError as e:
        log.error("could not make the process non-dumpable, not starting: %s", e)
        return EXIT_HARDEN
    try:
        seal_secrets(s.secrets_dir)
    except OSError as e:
        log.error("could not seal the secrets directory, not starting: %s", e)
        return EXIT_HARDEN
    judge = Judge(http_gateway.send, cfg=s.second_opinion, env={KEY_ENV: s.second_opinion_key.reveal()})
    for name in settings.SECRET_ENV:  # never set (settings refuses them); belt and braces
        os.environ.pop(name, None)
    if not s.second_opinion_key_set:
        log.warning("INTAKE_SECOND_OPINION_KEY is not set: every judge ask is no_key, and items that need "
                    "the second opinion expire suspicious (never clean)")
    pool = WorkerPool(s.workers, wall_stages_s=s.wall_stages_s, wall_transfer_s=s.wall_transfer_s,
                      wall_classifier_s=s.wall_classifier_s, start_timeout_s=s.worker_start_s,
                      queue_wait_s=s.queue_wait_s, child_env_drop=settings.SECRET_ENV)
    try:
        pool.start()
    except PoolError as e:
        log.error("worker pool refused, not starting: %s", e)
        pool.close()
        return EXIT_WORKERS
    store = PgStore(host=s.db_host, port=s.db_port, dbname=s.db_name, user=s.db_user, password=s.db_password,
                    size=max(4, s.so_concurrency + 2))
    svc = Intake(s, pool, store, Metrics(), judge=judge)
    if not store.ping():
        log.warning("the database is not reachable yet: /healthz reports db=false and POSTs get 503 until it is")
    sched = Scheduler(svc)
    server = Server(Router(svc, s), s.listen_host, s.listen_port)

    def stop(*_a):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    sched.start()
    log.info("intake service listening on %s:%d (%d worker(s), policy weak_rule_judge_clean=%s)",
             s.listen_host, s.listen_port, s.workers, s.policy.weak_rule_judge_clean)
    try:
        server.serve_forever()
    finally:
        sched.stop()
        pool.close()
        server.server_close()
        log.info("intake service stopped")
    return 0
