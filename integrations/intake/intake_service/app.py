"""Start-up of the intake service (I5). THE ORDER IS THE POINT: nothing listens, and no worker
loads, until everything that can be checked has been.

  1. configuration (settings.load): any invalid value -> exit 2 (EXIT_CONFIG), naming the
     variable, never a secret value (I4 R3-T3: the D40 policy point is validated here)
  2. the classifier files (weights.verify_model_dir): missing or not the pinned bytes -> exit 3
  3. the secrets leave the process environment: the second-opinion key goes into the Judge's
     closure (the library's), the DB password and caller keys stay in Settings' masked objects,
     and os.environ no longer carries any of them - the worker processes are spawned without
     them (and child_env_drop names them again, belt and braces)
  4. the warm pool: every worker loads and verifies the model; any failure -> exit 4
  5. the loops (second opinion, re-screen, purge), then the HTTP server
SIGTERM stops the server, the loops and the workers.
"""
from __future__ import annotations

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

    source = os.environ if env is None else env
    judge = Judge(http_gateway.send, cfg=s.second_opinion, env={KEY_ENV: source.get(KEY_ENV, "")})
    for name in settings.SECRET_ENV:
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
