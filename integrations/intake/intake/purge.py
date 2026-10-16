"""The retention purge jobs (operator D2, D27; DESIGN-intake.md sections 4 and 5; I4).

Pure functions over a DB interface - anything with

    execute(sql: str, params: Mapping[str, object]) -> list[tuple]

using psycopg-style %(name)s parameters (I5 passes a psycopg connection in autocommit mode, so
each batch is its own short transaction). They run as the `intake` role, which holds DELETE on
intake.raw_items / intake.discards and nothing on any other table's rows.

What each rule deletes - and NOTHING else (the policy names exactly these rows):

  clean-bronze       intake.raw_items rows older than BRONZE_RETENTION_DAYS (30) whose linked
                     items are ALL status 'done' with verdict 'clean' (at least one)
  suspicious-bronze  intake.raw_items rows older than SUSPICIOUS_RETENTION_DAYS (30) whose
                     linked items are ALL status 'done' with verdict 'suspicious' (D2: held
                     items are purged after 30 days)
  discards           intake.discards rows older than DISCARD_RETENTION_DAYS (365)

"Linked" means intake.items.raw_item_id = the raw row's id OR the same idempotency key
(source, external_id, raw_sha256). A raw row with no linked item, a pending, injected,
unscreened or rejected item, or a mix of verdicts, is not named and stays. Age is the raw row's
created_at; the cutoff is strict (exactly 30 days old stays).

THE CUTOFF IS ABSOLUTE TIME (intake-i4 attempt 1, D-1). It is the DATABASE's now() minus
N x 24 HOURS - make_interval(hours => ...), never "N days", because both Python's aware-datetime
subtraction and postgres's timestamptz - 'N days' count calendar days in a zone, and across a
DST change that is N days +- 1 hour (a row 29 d 23 h old was deleted in the tester's repro).
Production passes no `now`. A test may pass a timezone-aware `now`; it is converted to UTC
before the subtraction, so the same instant gives the same cutoff in every zone.

POLICY POINT D41 = (a) (operator 2026-10-16, DESIGN section 11): "held items are purged after
30 days" means intake's RAW COPY (suspicious-bronze). The `suspicious` CONTENT rows in
public.sources / public.thoughts are NOT purged and no content-row rule exists: the intake role
cannot delete them, and deleting a source would cascade into gold (claim_sources, source_chunks,
...). Instead, from now on `suspicious` content must not feed research or any generated outcome
(research recall/reuse, synthesis, wiki, digest, podcast, agent knowledge): a READ-policy point
for I6, not a purge. Should a content-row purge ever be wanted, the change stays local: a
postgres-owned SECURITY DEFINER function in the migration, EXECUTE to intake, and one more entry
in RULES below.

The ONE side effect on silver is the schema's own: intake.items.raw_item_id is
`ON DELETE SET NULL` (init-intake.sql: "bronze is purged, silver stays"), so the items linked
to a purged raw row keep everything but that pointer. intake.items rows are never deleted (they
are the verdict record; sources/thoughts.intake_item_id references them). public.sources and
public.thoughts rows labelled `suspicious` are NOT purged here: the intake role holds no DELETE
on them and deleting a source cascades into claims and chunks (gold). That is an operator
decision for a later item (intake-i4 findings).

Bounded: each statement deletes at most batch_size rows (LIMIT inside the DELETE's subquery,
FOR UPDATE SKIP LOCKED so a concurrent writer is never blocked), and one run makes at most
max_batches statements. Idempotent: a second run deletes nothing.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Mapping, Protocol

from .config import Retention, retention as _retention

BATCH_SIZE = 500
MAX_BATCHES = 20
_MAX_BATCH_SIZE = 10_000
_MAX_MAX_BATCHES = 1000


class DB(Protocol):
    def execute(self, sql: str, params: Mapping[str, object]) -> list[tuple]:
        ...


def _bronze_sql(verdict: str) -> str:
    assert verdict in ("clean", "suspicious")
    return f"""DELETE FROM intake.raw_items AS r
 WHERE r.id IN (
   SELECT b.id FROM intake.raw_items AS b
    WHERE b.created_at < COALESCE(CAST(%(cutoff)s AS timestamptz), now() - make_interval(hours => %(hours)s))
      AND EXISTS (SELECT 1 FROM intake.items AS i
                   WHERE (i.raw_item_id = b.id
                          OR (i.source, i.external_id, i.raw_sha256) = (b.source, b.external_id, b.raw_sha256))
                     AND i.status = 'done' AND i.verdict = '{verdict}')
      AND NOT EXISTS (SELECT 1 FROM intake.items AS i
                       WHERE (i.raw_item_id = b.id
                              OR (i.source, i.external_id, i.raw_sha256) = (b.source, b.external_id, b.raw_sha256))
                         AND (i.status <> 'done' OR i.verdict IS DISTINCT FROM '{verdict}'))
    ORDER BY b.created_at, b.id
    LIMIT %(batch)s
    FOR UPDATE OF b SKIP LOCKED)
RETURNING r.id"""


SQL_CLEAN_BRONZE = _bronze_sql("clean")
SQL_SUSPICIOUS_BRONZE = _bronze_sql("suspicious")
SQL_DISCARDS = """DELETE FROM intake.discards AS d
 WHERE d.id IN (
   SELECT x.id FROM intake.discards AS x
    WHERE x.created_at < COALESCE(CAST(%(cutoff)s AS timestamptz), now() - make_interval(hours => %(hours)s))
    ORDER BY x.created_at, x.id
    LIMIT %(batch)s
    FOR UPDATE OF x SKIP LOCKED)
RETURNING d.id"""


@dataclass(frozen=True)
class PurgeReport:
    rule: str
    cutoff: str        # ISO 8601 in UTC, or "database now() - N hours" when no now was given
    deleted: int
    batches: int
    more: bool         # max_batches was reached with full batches: run again

    def to_dict(self) -> dict:
        return {"rule": self.rule, "cutoff": self.cutoff, "deleted": self.deleted,
                "batches": self.batches, "more": self.more}


def _whole(name: str, v, hi: int) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= hi:
        raise ValueError(f"{name} must be a whole number in [1, {hi}]")
    return v


def _run(db: DB, rule: str, sql: str, now: dt.datetime | None, days: int, batch_size: int,
         max_batches: int) -> PurgeReport:
    if now is not None and (not isinstance(now, dt.datetime) or now.tzinfo is None
                            or now.utcoffset() is None):
        raise ValueError("now must be a timezone-aware datetime (or None: the database's now())")
    batch_size = _whole("batch_size", batch_size, _MAX_BATCH_SIZE)
    max_batches = _whole("max_batches", max_batches, _MAX_MAX_BATCHES)
    hours = _whole("retention days", days, 10**6) * 24
    # D-1: absolute hours from a UTC instant, never calendar days in the caller's zone
    cutoff = None if now is None else now.astimezone(dt.timezone.utc) - dt.timedelta(hours=hours)
    deleted = batches = 0
    more = False
    while batches < max_batches:
        rows = db.execute(sql, {"cutoff": cutoff, "hours": hours, "batch": batch_size})
        batches += 1
        n = len(rows)
        if n > batch_size:
            raise RuntimeError(f"{rule}: a batch deleted {n} rows, more than {batch_size}")
        deleted += n
        if n < batch_size:
            break
    else:
        more = True
    shown = cutoff.isoformat() if cutoff is not None else f"database now() - {hours} hours"
    return PurgeReport(rule, shown, deleted, batches, more)


def purge_clean_bronze(db: DB, now: dt.datetime | None = None, *, retention: Retention | None = None,
                       batch_size: int = BATCH_SIZE, max_batches: int = MAX_BATCHES) -> PurgeReport:
    r = retention or _retention()
    return _run(db, "clean-bronze", SQL_CLEAN_BRONZE, now, r.bronze_days, batch_size, max_batches)


def purge_suspicious_bronze(db: DB, now: dt.datetime | None = None, *, retention: Retention | None = None,
                            batch_size: int = BATCH_SIZE, max_batches: int = MAX_BATCHES) -> PurgeReport:
    r = retention or _retention()
    return _run(db, "suspicious-bronze", SQL_SUSPICIOUS_BRONZE, now, r.suspicious_days, batch_size,
                max_batches)


def purge_discards(db: DB, now: dt.datetime | None = None, *, retention: Retention | None = None,
                   batch_size: int = BATCH_SIZE, max_batches: int = MAX_BATCHES) -> PurgeReport:
    r = retention or _retention()
    return _run(db, "discards", SQL_DISCARDS, now, r.discard_days, batch_size, max_batches)


def run_all(db: DB, now: dt.datetime | None = None, *, retention: Retention | None = None,
            batch_size: int = BATCH_SIZE, max_batches: int = MAX_BATCHES) -> tuple[PurgeReport, ...]:
    r = retention or _retention()
    kw = dict(retention=r, batch_size=batch_size, max_batches=max_batches)
    return tuple(fn(db, now, **kw) for fn in RULES)


# The rules run_all runs, in order. D41 (above) would add one entry here.
RULES = (purge_clean_bronze, purge_suspicious_bronze, purge_discards)
