"""Stage 2: idempotency and revisions (DESIGN-intake.md section 3, stage 2; plan P1).

The key is (source, external_id, sha256(raw)).
  * the key was seen before            -> "repeat": the stored result is returned as it is;
  * same (source, external_id), new hash -> "new-revision": revision = latest + 1, and the
    decision names the hash it supersedes. The earlier record is never rewritten in place;
    the caller (I5) inserts a new row;
  * never seen                          -> "new-item", revision 1.

decide() is a pure function over a caller-supplied, read-only History (no DB here). Answers
that cannot be true (a key whose stored result belongs to another key, a revision below 1, a
latest hash equal to this one with no stored result) raise InconsistentHistory, which the
pipeline turns into `pending` (fail closed), never a guess.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Optional, Protocol

from .result import IdempotencyKey, IntakeResult


class InconsistentHistory(Exception):
    pass


class History(Protocol):
    def get(self, key: IdempotencyKey) -> Optional[IntakeResult]:
        """The stored result for exactly this key, or None."""

    def latest(self, source: str, external_id: str) -> Optional[tuple[int, str]]:
        """(revision, sha256) of the newest stored revision of this item, or None."""


class NoHistory:
    """A History with nothing stored (every item is new)."""

    def get(self, key: IdempotencyKey) -> Optional[IntakeResult]:
        return None

    def latest(self, source: str, external_id: str) -> Optional[tuple[int, str]]:
        return None


@dataclass(frozen=True)
class RevisionDecision:
    kind: str  # "repeat" | "new-item" | "new-revision"
    key: IdempotencyKey
    revision: int
    supersedes: Optional[str] = None
    stored: Optional[IntakeResult] = None


def key_for(source: str, external_id: str, raw: bytes) -> IdempotencyKey:
    return IdempotencyKey(source, external_id, hashlib.sha256(raw).hexdigest())


def decide(key: IdempotencyKey, history: History) -> RevisionDecision:
    stored = history.get(key)
    if stored is not None:
        if not isinstance(stored, IntakeResult) or stored.key != key:
            raise InconsistentHistory("history returned a result for a different key")
        if not isinstance(stored.revision, int) or stored.revision < 1:
            raise InconsistentHistory("the stored result has no valid revision")
        return RevisionDecision("repeat", key, stored.revision, stored.supersedes, stored)
    latest = history.latest(key.source, key.external_id)
    if latest is None:
        return RevisionDecision("new-item", key, 1)
    rev, sha = latest
    if not isinstance(rev, int) or isinstance(rev, bool) or rev < 1 or not isinstance(sha, str):
        raise InconsistentHistory("history returned an invalid latest revision")
    if sha == key.sha256:
        raise InconsistentHistory("the latest revision has this hash but no stored result")
    return RevisionDecision("new-revision", key, rev + 1, supersedes=sha)
