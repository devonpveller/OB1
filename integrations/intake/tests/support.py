"""Shared helpers for the intake tests. Importing this module turns the network OFF for the
whole test process: every socket connect or name lookup raises (acceptance: no network in
tests; I3: the classifier loads its model from local, verified files with sockets off). It also
installs ZeroClassifier as the process default, for the stage 1-5 tests."""
from __future__ import annotations

import socket

from intake import classifier as _classifier

_REFUSED = "network access is disabled in the intake tests"


class NetworkDisabled(RuntimeError):
    pass


def _refuse(*_a, **_k):
    raise NetworkDisabled(_REFUSED)


socket.socket.connect = _refuse  # type: ignore[method-assign]
socket.socket.connect_ex = _refuse  # type: ignore[method-assign]
socket.create_connection = _refuse  # type: ignore[assignment]
socket.getaddrinfo = _refuse  # type: ignore[assignment]


class ZeroClassifier:
    """Stands in for the model in the stage 1-5 tests: scores every text 0 (so the I2 verdicts
    are what they test) and records what it was asked to score. The classifier's own tests
    (test_classifier*.py) pass the real, hash-verified model explicitly."""

    version = "test-stub/zero"

    def __init__(self, record: bool = True):
        self.record = record
        self.calls: list[list[tuple[str, str]]] = []

    def score(self, fields):
        fields = list(fields)
        if self.record:
            self.calls.append(fields)
        return _classifier.Scored(version=self.version, precision="none", threads=0,
                                  threshold=0.5, max_score=0.0, chunks=len(fields),
                                  flagged_count=0)


ZERO = ZeroClassifier(record=False)  # the process default keeps nothing
_classifier.set_default(ZERO)


def envelope(raw: str, content_type: str = "text/plain", **extra) -> dict:
    env = {
        "source": "web",
        "connector": "test",
        "external_id": "item-1",
        "fetched_at": "2026-10-15T10:00:00+00:00",
        "content_type": content_type,
        "raw": raw,
    }
    env.update(extra)
    return env


def tag(s: str) -> str:
    """s encoded in Unicode TAG characters (ASCII smuggling)."""
    return "".join(chr(0xE0000 + ord(c)) for c in s)


def rule_ids(result) -> list[str]:
    return [r.rule for r in result.reasons]


def strong(result) -> list[str]:
    return [r.rule for r in result.reasons if r.strength == "strong"]
