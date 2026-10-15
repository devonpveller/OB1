"""Shared helpers for the I2 tests. Importing this module turns the network OFF for the whole
test process: every socket connect or name lookup raises (acceptance: no network in tests)."""
from __future__ import annotations

import socket

_REFUSED = "network access is disabled in the intake tests"


class NetworkDisabled(RuntimeError):
    pass


def _refuse(*_a, **_k):
    raise NetworkDisabled(_REFUSED)


socket.socket.connect = _refuse  # type: ignore[method-assign]
socket.socket.connect_ex = _refuse  # type: ignore[method-assign]
socket.create_connection = _refuse  # type: ignore[assignment]
socket.getaddrinfo = _refuse  # type: ignore[assignment]


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
