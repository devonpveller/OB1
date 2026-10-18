"""Shared helpers for the I5 service tests (intake_service/).

Importing tests.support first turns the network OFF in this process (every socket connect and
name lookup raises). The worker-pool tests start real worker PROCESSES (spawn); those children
re-import nothing from here, so they get no such guard - the stub classifier factories below
open no socket either way.

Stub classifier factories (the pool's `factory` argument, "module:function"):
  zero      scores every text 0                         (stage 1-5 verdicts stand)
  high      scores every text 0.9                       (classifier over -> second opinion)
  hang      sleeps 3600 s inside score() (a hung forward pass: the wall-clock kill is the bound)
  die       os._exit(9) inside score() (a crashed worker)
  budget    raises ClassifierBudget (I3 F-2: permanent -> D2 suspicious)
  zero_chunks scores nothing (chunks == 0; I3 review R-4 counts these cleans)
  slow_load sleeps INTAKE_TEST_LOAD_SECONDS before it is ready (the warm-up cost)
  broken    raises at load (a worker that never becomes ready)
"""
from __future__ import annotations

import io
import json
import logging
import os
import time

from tests import support

from intake import classifier as _classifier

CALLER_KEYS = {"research": "rk-" + "a1" * 16, "mcp": "mk-" + "b2" * 16}
DB_PASSWORD = "db-pass-" + "c3" * 12
SO_KEY = "sk-so-" + "d4" * 14
SECRETS = (*CALLER_KEYS.values(), DB_PASSWORD, SO_KEY)


def base_env(**over) -> dict:
    env = {
        "INTAKE_CALLER_KEYS": ",".join(f"{c}={k}" for c, k in CALLER_KEYS.items()),
        "INTAKE_DB_HOST": "intake-db",
        "INTAKE_DB_PASSWORD": DB_PASSWORD,
        "INTAKE_SECOND_OPINION_KEY": SO_KEY,
    }
    env.update({k: v for k, v in over.items() if v is not None})
    for k in [k for k, v in over.items() if v is None]:
        env.pop(k, None)
    return env


class _Stub:
    def __init__(self, score: float, version: str = "test-stub/fixed"):
        self.version = version
        self._score = score

    def load(self):
        return None

    def score(self, fields):
        fields = [(n, t) for n, t in fields if t and t.strip()]
        flagged = ()
        if self._score >= 0.5 and fields:
            name, text = fields[0]
            flagged = (_classifier.ChunkScore(name, 0, min(len(text), 400), self._score),)
        return _classifier.Scored(version=self.version, precision="none", threads=0,
                                  threshold=0.5, max_score=self._score, chunks=len(fields),
                                  flagged_count=len(flagged), flagged=flagged)


def zero():
    return _Stub(0.0, "test-stub/zero")


def high():
    return _Stub(0.9, "test-stub/high")


class _Hang(_Stub):
    def score(self, fields):
        time.sleep(3600)


def hang():
    return _Hang(0.0, "test-stub/hang")


class _Die(_Stub):
    def score(self, fields):
        os._exit(9)


def die():
    return _Die(0.0, "test-stub/die")


class _Budget(_Stub):
    def score(self, fields):
        raise _classifier.ClassifierBudget("classifier: passed 180.0s")


def budget():
    return _Budget(0.0, "test-stub/budget")


class _ZeroChunks(_Stub):
    def score(self, fields):
        return _classifier.Scored(version=self.version, precision="none", threads=0, threshold=0.5,
                                  max_score=0.0, chunks=0, flagged_count=0)


def zero_chunks():
    return _ZeroChunks(0.0, "test-stub/zero-chunks")


def slow_load():
    time.sleep(float(os.environ.get("INTAKE_TEST_LOAD_SECONDS", "2")))
    return _Stub(0.0, "test-stub/slow-load")


def broken():
    raise _classifier.ClassifierUnavailable("model.safetensors: sha256 0000... is not the pinned 6521...")


def envelope_bytes(raw: str = "A plain paragraph about gardening.", content_type: str = "text/plain",
                   **extra) -> bytes:
    return json.dumps(support.envelope(raw, content_type, connector=extra.pop("connector", "research"),
                                       **extra)).encode("utf-8")


class LogCapture:
    """Every log record of the process, as text, for the 'no secret in logs' checks."""

    def __init__(self):
        self.stream = io.StringIO()
        self.handler = logging.StreamHandler(self.stream)
        self.handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))

    def __enter__(self):
        root = logging.getLogger()
        self._level = root.level
        root.addHandler(self.handler)
        root.setLevel(logging.DEBUG)
        return self

    def __exit__(self, *exc):
        root = logging.getLogger()
        root.removeHandler(self.handler)
        root.setLevel(self._level)

    @property
    def text(self) -> str:
        return self.stream.getvalue()


assert support
