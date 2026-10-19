"""The service's DB access: the I1 tables (intake.raw_items, intake.items, intake.discards),
written as the `intake` role (I5).

The service logs in AS intake (session_user = intake: the only login whose writes the I1
authority trigger accepts for clean/suspicious; this item writes no public.* row - that is the
consumers' cut-over, I8). It reaches openbrain-db only through the relay
(openbrain-intake-dbrelay), its one route to the database.

ONE TRANSACTION PER ITEM (DESIGN section 7): Store.transaction() yields a Tx; the core takes a
per-item advisory lock (source, external_id), reads the item FOR UPDATE, and writes bronze,
silver and the discard record together or not at all. The purge and stats run through
execute() in autocommit (each purge batch its own short transaction, as purge.py expects).

A connection or server failure raises StoreUnavailable -> HTTP 503; nothing is half-written.
A pooled connection idle longer than MAX_IDLE_SECONDS (300) is closed and replaced when it is next
taken: the DB relay closes a connection idle for its INTAKE_RELAY_IDLE_SECONDS (900 in compose;
intake-i5b R-6), and a connection the relay has cut must never be the one a request gets.
The DSN and the password are never logged; errors carry the exception type only.
"""
from __future__ import annotations

import contextlib
import datetime as dt
import json
import logging
import queue
import threading
import time
from dataclasses import dataclass, field

log = logging.getLogger("intake_service.store")
MAX_IDLE_SECONDS = 300.0


class StoreUnavailable(Exception):
    """The database cannot be reached or refused the work: 503, retry later."""


@dataclass
class ItemRow:
    id: str
    raw_item_id: str | None
    source: str
    connector: str
    external_id: str
    raw_sha256: str
    status: str
    verdict: str | None
    reasons: list = field(default_factory=list)
    counts: dict = field(default_factory=dict)
    scores: dict = field(default_factory=dict)
    classifier_version: str | None = None
    created_at: dt.datetime | None = None
    decided_at: dt.datetime | None = None


_ITEM_COLS = ("id, raw_item_id, source, connector, external_id, raw_sha256, status, verdict, reasons, "
              "counts, scores, classifier_version, created_at, decided_at")


def _row(r) -> ItemRow:
    return ItemRow(id=str(r[0]), raw_item_id=None if r[1] is None else str(r[1]), source=r[2], connector=r[3],
                   external_id=r[4], raw_sha256=r[5], status=r[6], verdict=r[7], reasons=list(r[8] or []),
                   counts=dict(r[9] or {}), scores=dict(r[10] or {}), classifier_version=r[11],
                   created_at=r[12], decided_at=r[13])


def _fetched_at(value: str):
    """The envelope's fetched_at as a timestamptz when it carries a zone; else NULL (the original
    string is kept in the bronze envelope JSON either way)."""
    try:
        t = dt.datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return t if t.tzinfo is not None and t.utcoffset() is not None else None


class PgTx:
    def __init__(self, cur, jsonb):
        self.cur = cur
        self.J = jsonb

    def _one(self, sql, params):
        self.cur.execute(sql, params)
        return self.cur.fetchone()

    def lock_item(self, source: str, external_id: str) -> None:
        self.cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                         (source + "\x1f" + external_id,))

    def get_item(self, source, external_id, sha) -> ItemRow | None:
        r = self._one(f"SELECT {_ITEM_COLS} FROM intake.items WHERE source = %s AND external_id = %s "
                      "AND raw_sha256 = %s FOR UPDATE", (source, external_id, sha))
        return None if r is None else _row(r)

    def get_item_by_id(self, item_id) -> ItemRow | None:
        r = self._one(f"SELECT {_ITEM_COLS} FROM intake.items WHERE id = %s FOR UPDATE", (item_id,))
        return None if r is None else _row(r)

    def latest(self, source, external_id, exclude_sha):
        r = self._one("SELECT (scores->'service'->>'revision')::int, raw_sha256 FROM intake.items "
                      "WHERE source = %s AND external_id = %s AND raw_sha256 <> %s "
                      "AND scores->'service'->>'revision' ~ '^[0-9]{1,9}$' "
                      "ORDER BY (scores->'service'->>'revision')::int DESC, created_at DESC LIMIT 1",
                      (source, external_id, exclude_sha))
        return None if r is None else (int(r[0]), r[1])

    def upsert_raw(self, rec: dict) -> str:
        r = self._one(
            "INSERT INTO intake.raw_items (source, connector, external_id, raw_sha256, fetched_at, content_type, "
            "raw, envelope) VALUES (%s, %s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT ON CONSTRAINT raw_items_idempotency_key DO UPDATE SET source = EXCLUDED.source "
            "RETURNING id",
            (rec["source"], rec["connector"], rec["external_id"], rec["raw_sha256"], _fetched_at(rec["fetched_at"]),
             rec["content_type"], rec["raw"], self.J(rec["envelope"])))
        return str(r[0])

    def raw_by_id(self, raw_id) -> dict | None:
        r = self._one("SELECT source, connector, external_id, raw_sha256, content_type, raw, envelope "
                      "FROM intake.raw_items WHERE id = %s", (raw_id,))
        if r is None:
            return None
        return {"source": r[0], "connector": r[1], "external_id": r[2], "raw_sha256": r[3],
                "content_type": r[4], "raw": bytes(r[5]), "envelope": dict(r[6] or {})}

    def delete_raw(self, source, external_id, sha) -> int:
        self.cur.execute("DELETE FROM intake.raw_items WHERE source = %s AND external_id = %s AND raw_sha256 = %s",
                         (source, external_id, sha))
        return self.cur.rowcount

    def insert_item(self, row: dict) -> str:
        r = self._one(
            "INSERT INTO intake.items (raw_item_id, source, connector, external_id, raw_sha256, status, verdict, "
            "reasons, counts, scores, classifier_version, decided_at) VALUES "
            "(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, CASE WHEN %s = 'done' THEN now() END) RETURNING id",
            (row["raw_item_id"], row["source"], row["connector"], row["external_id"], row["raw_sha256"],
             row["status"], row["verdict"], list(row["reasons"]), self.J(row["counts"]), self.J(row["scores"]),
             row["classifier_version"], row["status"]))
        return str(r[0])

    def update_item(self, item_id, row: dict) -> None:
        sets, params = [], []
        for col in ("raw_item_id", "connector", "status", "verdict", "reasons", "counts", "scores",
                    "classifier_version"):
            if col in row:
                v = row[col]
                if col in ("counts", "scores"):
                    v = self.J(v)
                elif col == "reasons":
                    v = list(v)
                sets.append(f"{col} = %s")
                params.append(v)
        if row.get("status") == "done":
            sets.append("decided_at = now()")
        params.append(item_id)
        self.cur.execute(f"UPDATE intake.items SET {', '.join(sets)} WHERE id = %s", params)

    def insert_discard(self, rec: dict) -> None:
        self.cur.execute("INSERT INTO intake.discards (source, connector, external_id, raw_sha256, reason, scores) "
                         "VALUES (%s, %s, %s, %s, %s, %s)",
                         (rec["source"], rec["connector"], rec["external_id"], rec["raw_sha256"], rec["reason"],
                          self.J(rec["scores"])))

    def claim_due(self, kind: str, now: float, lease_until: float, limit: int) -> list[ItemRow]:
        """Pending items due for the second opinion (kind second_opinion) or for a re-screen
        (kind rescreen: errored, with bronze), oldest first, skipping rows another session holds;
        each claimed row gets a lease (scores.service.lease_until) so a slow step is not taken
        twice."""
        if kind == "second_opinion":
            due = ("scores->>'needs_second_opinion' = 'true' AND coalesce(jsonb_typeof(scores->'error'), 'null') = 'null' "
                   "AND coalesce((scores->'second_opinion'->>'next_attempt_at')::float8, 0) <= %(now)s")
        elif kind == "rescreen":
            due = ("coalesce(jsonb_typeof(scores->'error'), 'null') <> 'null' AND raw_item_id IS NOT NULL "
                   "AND coalesce((scores->'service'->'rescreen'->>'next_at')::float8, 0) <= %(now)s")
        else:
            raise ValueError(kind)
        self.cur.execute(
            "UPDATE intake.items SET scores = jsonb_set(scores, '{service,lease_until}', to_jsonb(%(lease)s::float8), true) "
            "WHERE id IN (SELECT id FROM intake.items WHERE status = 'pending' AND (" + due + ") "
            "AND coalesce((scores->'service'->>'lease_until')::float8, 0) <= %(now)s "
            "ORDER BY created_at, id LIMIT %(n)s FOR UPDATE SKIP LOCKED) "
            f"RETURNING {_ITEM_COLS}",
            {"now": now, "lease": lease_until, "n": limit})
        return [_row(r) for r in self.cur.fetchall()]


class PgStore:
    """psycopg 3, a small pool of connections, each logged in as the intake role."""

    def __init__(self, *, host: str, port: int, dbname: str, user: str, password, size: int = 4,
                 connect_timeout: int = 10, max_idle_s: float = MAX_IDLE_SECONDS):
        import psycopg
        from psycopg.types.json import Jsonb
        self._psycopg = psycopg
        self._J = Jsonb
        self._kw = dict(host=host, port=port, dbname=dbname, user=user, connect_timeout=connect_timeout,
                        application_name="intake-service")
        self._password = password
        self._pool: queue.LifoQueue = queue.LifoQueue(maxsize=size)  # (connection, idle since)
        self._lock = threading.Lock()
        self._max_idle = max_idle_s

    def _connect(self):
        try:
            conn = self._psycopg.connect(password=self._password.reveal(), **self._kw)
        except Exception as e:  # noqa: BLE001 - never echo the DSN
            raise StoreUnavailable(type(e).__name__) from None
        return conn

    def _get(self):
        while True:
            try:
                conn, since = self._pool.get_nowait()
            except queue.Empty:
                return self._connect()
            if conn.closed or conn.broken:
                continue
            if time.monotonic() - since > self._max_idle:
                with contextlib.suppress(Exception):
                    conn.close()
                continue
            return conn

    def _put(self, conn):
        try:
            self._pool.put_nowait((conn, time.monotonic()))
        except queue.Full:
            conn.close()

    @contextlib.contextmanager
    def transaction(self):
        conn = self._get()
        ok = False
        try:
            conn.autocommit = False
            with conn.cursor() as cur:
                yield PgTx(cur, self._J)
            conn.commit()
            ok = True
        except self._psycopg.OperationalError as e:
            raise StoreUnavailable(type(e).__name__) from None
        finally:
            if not ok:
                with contextlib.suppress(Exception):
                    conn.rollback()
            if conn.broken or conn.closed:
                with contextlib.suppress(Exception):
                    conn.close()
            else:
                self._put(conn)

    def execute(self, sql: str, params) -> list[tuple]:
        """Autocommit execute (purge.py / stats.py DB interface)."""
        conn = self._get()
        try:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute(sql, params)
                rows = cur.fetchall() if cur.description is not None else []
            return [tuple(r) for r in rows]
        except self._psycopg.OperationalError as e:
            raise StoreUnavailable(type(e).__name__) from None
        finally:
            if conn.broken or conn.closed:
                with contextlib.suppress(Exception):
                    conn.close()
            else:
                self._put(conn)

    def ping(self) -> bool:
        try:
            return self.execute("SELECT 1 FROM intake.items LIMIT 0", {}) == []
        except Exception:  # noqa: BLE001
            return False


def to_json(v):
    """JSON-safe copy (bytes never reach scores)."""
    return json.loads(json.dumps(v, default=str))
