"""The stats query for I5's GET /v1/stats (DESIGN-intake.md sections 2 and 7; I4).

    collect(db, now, since=None) -> Stats        Stats.to_dict() is the JSON body

Read-only, over the I1 schema (intake.items, intake.discards), with the same DB interface as
purge.py (execute(sql, params) -> rows; psycopg-style %(name)s parameters). The digest shows
these counts only (operator D2).

Shape (SCHEMA = "intake-stats/1"):

  {"schema": "intake-stats/1",
   "generated_at": "<now, ISO 8601>", "since": "<ISO 8601>" | null,
   "verdicts": {"<connector>": {"clean": n, "suspicious": n, "injected": n, "unscreened": n,
                                "pending": n, "rejected": n}, ...},
   "queue":    {"pending": n, "oldest_pending_age_s": s | null,
                "second_opinion_depth": n, "second_opinion_oldest_age_s": s | null},
   "errors":   {"transient": n, "permanent": n, "total": n},
   "discards": {"<connector>": n, ...}}

`verdicts`, `errors` and `discards` count rows created at or after `since` (all rows when it is
null); `queue` is the current pending set. An item counts as waiting for the second opinion,
and as an error, by the `scores` JSON that I5 stores with it - its shape is item_scores()
below, so the writer and this reader share one definition. A row this module cannot classify
(an unknown status or verdict) raises ValueError instead of being counted somewhere wrong.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Mapping

from .purge import DB
from .result import IntakeResult

SCHEMA = "intake-stats/1"
VERDICT_KEYS = ("clean", "suspicious", "injected", "unscreened", "pending", "rejected")

_SINCE = "(CAST(%(since)s AS timestamptz) IS NULL OR {col} >= CAST(%(since)s AS timestamptz))"

SQL: dict[str, str] = {
    "verdicts": ("/*stats:verdicts*/ SELECT connector, status, coalesce(verdict, ''), count(*) "
                 "FROM intake.items WHERE " + _SINCE.format(col="created_at")
                 + " GROUP BY 1, 2, 3 ORDER BY 1, 2, 3"),
    "queue": ("/*stats:queue*/ SELECT count(*), "
              "EXTRACT(EPOCH FROM (CAST(%(now)s AS timestamptz) - min(created_at)))::float8, "
              "count(*) FILTER (WHERE scores->>'needs_second_opinion' = 'true'), "
              "EXTRACT(EPOCH FROM (CAST(%(now)s AS timestamptz) - "
              "min(created_at) FILTER (WHERE scores->>'needs_second_opinion' = 'true')))::float8 "
              "FROM intake.items WHERE status = 'pending'"),
    "errors": ("/*stats:errors*/ SELECT coalesce(scores->>'error_kind', 'transient'), count(*) "
               "FROM intake.items WHERE scores->>'error' IS NOT NULL AND "
               + _SINCE.format(col="created_at") + " GROUP BY 1 ORDER BY 1"),
    "discards": ("/*stats:discards*/ SELECT connector, count(*) FROM intake.discards WHERE "
                 + _SINCE.format(col="created_at") + " GROUP BY 1 ORDER BY 1"),
}


@dataclass(frozen=True)
class Queue:
    pending: int
    oldest_pending_age_s: float | None
    second_opinion_depth: int
    second_opinion_oldest_age_s: float | None


@dataclass(frozen=True)
class Errors:
    transient: int
    permanent: int

    @property
    def total(self) -> int:
        return self.transient + self.permanent


@dataclass(frozen=True)
class Stats:
    generated_at: str
    since: str | None
    verdicts: Mapping[str, Mapping[str, int]]
    queue: Queue
    errors: Errors
    discards: Mapping[str, int]

    def to_dict(self) -> dict:
        return {
            "schema": SCHEMA,
            "generated_at": self.generated_at,
            "since": self.since,
            "verdicts": {c: dict(v) for c, v in sorted(self.verdicts.items())},
            "queue": {"pending": self.queue.pending,
                      "oldest_pending_age_s": self.queue.oldest_pending_age_s,
                      "second_opinion_depth": self.queue.second_opinion_depth,
                      "second_opinion_oldest_age_s": self.queue.second_opinion_oldest_age_s},
            "errors": {"transient": self.errors.transient, "permanent": self.errors.permanent,
                       "total": self.errors.total},
            "discards": dict(sorted(self.discards.items())),
        }


def _aware(name: str, t: dt.datetime) -> dt.datetime:
    if not isinstance(t, dt.datetime) or t.tzinfo is None or t.utcoffset() is None:
        raise ValueError(f"{name} must be a timezone-aware datetime")
    return t


def _int(v) -> int:
    if isinstance(v, bool):
        raise ValueError("not a count")
    n = int(v)
    if n < 0:
        raise ValueError("a negative count")
    return n


def _age(v) -> float | None:
    if v is None or v == "":
        return None
    return round(float(v), 3)


def collect(db: DB, now: dt.datetime, since: dt.datetime | None = None) -> Stats:
    now = _aware("now", now)
    if since is not None:
        since = _aware("since", since)
    params = {"now": now, "since": since}
    verdicts: dict[str, dict[str, int]] = {}
    for connector, status, verdict, n in db.execute(SQL["verdicts"], params):
        if status == "done":
            key = verdict
        elif status in ("pending", "rejected"):
            key = status
        else:
            key = None
        if key not in VERDICT_KEYS:
            raise ValueError(f"stats: unexpected status/verdict {status!r}/{verdict!r}")
        row = verdicts.setdefault(str(connector), dict.fromkeys(VERDICT_KEYS, 0))
        row[key] += _int(n)
    q = db.execute(SQL["queue"], params)
    if len(q) != 1 or len(q[0]) != 4:
        raise ValueError("stats: the queue query returned an unexpected shape")
    pend, oldest, so_depth, so_oldest = q[0]
    queue = Queue(_int(pend), _age(oldest), _int(so_depth), _age(so_oldest))
    kinds = {"transient": 0, "permanent": 0}
    for kind, n in db.execute(SQL["errors"], params):
        if kind not in kinds:
            raise ValueError(f"stats: unknown error kind {kind!r}")
        kinds[kind] += _int(n)
    discards = {str(c): _int(n) for c, n in db.execute(SQL["discards"], params)}
    return Stats(now.isoformat(), since.isoformat() if since else None, verdicts, queue,
                 Errors(**kinds), discards)


def item_scores(result: IntakeResult, wait_state=None) -> dict:
    """The `scores` JSON I5 stores in intake.items for an item; what collect() reads."""
    return {
        "classifier": None if result.classifier is None else result.to_dict()["classifier"],
        "classifier_version": result.classifier_version,
        "needs_second_opinion": bool(result.needs_second_opinion),
        "judge_complete": bool(result.judge_complete),
        "error": result.error,
        "error_kind": result.error_kind,
        "second_opinion": None if wait_state is None else wait_state.to_dict(),
    }
