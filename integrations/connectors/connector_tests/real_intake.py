"""The REAL I5 intake service code, in this process, on a loopback socket: intake_service.web.Server
+ Router + core.Intake with intake's own in-memory stand-ins (tests/service_memory.py: the store,
and the inline pool that runs the same job function a worker process runs) and a stub classifier.
Everything between the socket and the store is the shipped code: the HTTP checks, stage 1, the
connector binding, the screen (stages 1-5), D2, the response bodies.

Needs intake's runtime dep google-re2 (intake's requirements.txt / requirements-dev.txt). HAVE_RUNTIME says whether they import.
NOTE: intake's tests/service_support.py is NOT imported - importing it switches sockets off for the
whole process (tests/support.py); the few helpers needed are re-made here.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import threading

import connector_tests  # noqa: F401 - sys.path

try:
    import re2  # noqa: F401 - intake's one native runtime dep for stages 1-5 (requirements.txt)
    HAVE_RUNTIME = True
    WHY = ""
except Exception as e:  # noqa: BLE001
    HAVE_RUNTIME = False
    WHY = f"intake's runtime deps are missing ({type(e).__name__}: {e}); run in the intake venv"

OVER_MARKER = None  # set by the parity tests: text that the stub classifier scores 0.9


class StubClassifier:
    """Scores 0.9 for a text holding OVER_MARKER, else 0 (intake's stage 6 interface)."""

    version = "test-stub/connector-kit"

    def load(self):
        return None

    def score(self, fields):
        from intake import classifier as _c
        fields = [(n, t) for n, t in fields if t and t.strip()]
        hit = OVER_MARKER is not None and any(OVER_MARKER in t for _n, t in fields)
        score = 0.9 if hit else 0.0
        flagged = ()
        if hit:
            name, text = next((n, t) for n, t in fields if OVER_MARKER in t)
            flagged = (_c.ChunkScore(name, 0, min(len(text), 400), score),)
        return _c.Scored(version=self.version, precision="none", threads=0, threshold=0.5, max_score=score,
                         chunks=len(fields), flagged_count=len(flagged), flagged=flagged)


class RealIntake:
    """with RealIntake({"reference-file": key}) as svc: svc.url, svc.store, svc.pool"""

    def __init__(self, keys: dict, *, body_read_s: float = 1.0, max_inflight: int = 16,
                 max_request_bytes: int = 8 * 1024 * 1024):
        self.keys = keys
        self.env_over = {"INTAKE_BODY_READ_SECONDS": str(body_read_s), "INTAKE_MAX_INFLIGHT": str(max_inflight),
                         "INTAKE_MAX_REQUEST_BYTES": str(max_request_bytes)}

    def __enter__(self):
        from intake import second_opinion
        from intake_service import core, settings, web
        from intake_service.metrics import Metrics
        from tests.service_memory import InlinePool, MemoryStore
        self.dir = tempfile.mkdtemp(prefix="connector-kit-real-intake-")
        files = {"intake_caller_keys": ",".join(f"{c}={k}" for c, k in self.keys.items()),
                 "intake_db_password": "db-" + "a" * 30, "intake_second_opinion_key": "so-" + "b" * 30}
        for name, value in files.items():
            with open(os.path.join(self.dir, name), "w", encoding="utf-8", newline="") as fh:
                fh.write(value)
        env = {"INTAKE_DB_HOST": "intake-db", "INTAKE_SECRETS_DIR": self.dir, **self.env_over}
        self.settings = settings.load(env)
        self.store = MemoryStore()
        self.pool = InlinePool(StubClassifier())
        judge = second_opinion.Judge(lambda r: None, cfg=self.settings.second_opinion, env={})
        self.svc = core.Intake(self.settings, self.pool, self.store, Metrics(), judge=judge)
        self.server = web.Server(web.Router(self.svc, self.settings), "127.0.0.1", 0)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05},
                                       name="real-intake", daemon=True)
        self.thread.start()
        return self

    @property
    def address(self):
        return self.server.server_address[:2]

    @property
    def url(self):
        h, p = self.address
        return f"http://{h}:{p}/v1/intake"

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.dir, ignore_errors=True)
        return False
