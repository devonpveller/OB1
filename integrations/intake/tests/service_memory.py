"""In-memory stand-ins for the I5 service tests: a Store with the same transaction interface as
intake_service.store.PgStore (whose SQL is proved against a throwaway postgres by the e2e run,
tests/e2e/run_service_e2e.py), and an in-process pool that runs the same job function the
worker processes run (intake_service.pool.screen_job) without spawning anything."""
from __future__ import annotations

import contextlib
import copy
import datetime as dt
import threading
import time
import uuid

from intake_service import pool as poolmod
from intake_service.store import ItemRow


class MemoryTx:
    def __init__(self, store):
        self.s = store

    def lock_item(self, source, external_id):
        return None

    def get_item(self, source, external_id, sha):
        for row in self.s.items.values():
            if (row.source, row.external_id, row.raw_sha256) == (source, external_id, sha):
                return copy.deepcopy(row)
        return None

    def get_item_by_id(self, item_id):
        row = self.s.items.get(item_id)
        return copy.deepcopy(row) if row else None

    def latest(self, source, external_id, exclude_sha):
        best = None
        for row in self.s.items.values():
            if (row.source, row.external_id) != (source, external_id) or row.raw_sha256 == exclude_sha:
                continue
            rev = (row.scores.get("service") or {}).get("revision")
            if isinstance(rev, int) and (best is None or rev > best[0]):
                best = (rev, row.raw_sha256)
        return best

    def upsert_raw(self, rec):
        for rid, r in self.s.raw.items():
            if (r["source"], r["external_id"], r["raw_sha256"]) == (rec["source"], rec["external_id"], rec["raw_sha256"]):
                return rid
        rid = str(uuid.uuid4())
        self.s.raw[rid] = {**rec, "created_at": self.s.now()}
        return rid

    def raw_by_id(self, raw_id):
        r = self.s.raw.get(raw_id)
        return copy.deepcopy(r) if r else None

    def delete_raw(self, source, external_id, sha):
        gone = [rid for rid, r in self.s.raw.items()
                if (r["source"], r["external_id"], r["raw_sha256"]) == (source, external_id, sha)]
        for rid in gone:
            del self.s.raw[rid]
            for row in self.s.items.values():
                if row.raw_item_id == rid:
                    row.raw_item_id = None
        return len(gone)

    def insert_item(self, row):
        iid = str(uuid.uuid4())
        self.s.items[iid] = ItemRow(id=iid, created_at=self.s.now(),
                                    decided_at=self.s.now() if row["status"] == "done" else None, **row)
        return iid

    def update_item(self, item_id, row):
        old = self.s.items[item_id]
        for k, v in row.items():
            setattr(old, k, copy.deepcopy(v))
        old.decided_at = self.s.now() if row.get("status") == "done" else old.decided_at

    def insert_discard(self, rec):
        self.s.discards.append({**rec, "created_at": self.s.now()})

    def claim_due(self, kind, now, lease_until, limit):
        out = []
        for row in sorted(self.s.items.values(), key=lambda r: r.created_at):
            if row.status != "pending":
                continue
            sc = row.scores
            svc = sc.setdefault("service", {})
            errored = sc.get("error") is not None
            if kind == "second_opinion":
                if errored or not sc.get("needs_second_opinion"):
                    continue
                if float((sc.get("second_opinion") or {}).get("next_attempt_at", 0)) > now:
                    continue
            else:
                if not errored or row.raw_item_id is None:
                    continue
                if float((svc.get("rescreen") or {}).get("next_at", 0)) > now:
                    continue
            if float(svc.get("lease_until", 0)) > now:
                continue
            svc["lease_until"] = lease_until
            out.append(copy.deepcopy(row))
            if len(out) >= limit:
                break
        return out


class MemoryStore:
    def __init__(self):
        self.items: dict[str, ItemRow] = {}
        self.raw: dict[str, dict] = {}
        self.discards: list[dict] = []
        self.executed: list[tuple[str, dict]] = []
        self.lock = threading.Lock()
        self.down = False

    def now(self):
        return dt.datetime.now(dt.timezone.utc)

    @contextlib.contextmanager
    def transaction(self):
        if self.down:
            from intake_service.store import StoreUnavailable
            raise StoreUnavailable("OperationalError")
        with self.lock:
            snap = copy.deepcopy((self.items, self.raw, self.discards))
            try:
                yield MemoryTx(self)
            except BaseException:
                self.items, self.raw, self.discards = snap
                raise

    def execute(self, sql, params):
        self.executed.append((sql, dict(params)))
        if "/*stats:queue*/" in sql:
            return [(0, None, 0, None)]
        return []

    def ping(self):
        return not self.down

    # helpers for the tests
    def one(self):
        assert len(self.items) == 1, self.items
        return next(iter(self.items.values()))


class InlinePool:
    """The worker job run in THIS process (no spawn): same parse/validate/announce/gate/screen
    sequence as a worker process, so the core tests exercise the real job protocol."""

    def __init__(self, classifier, *, outcome=None):
        self.clf = classifier
        self.forced = outcome   # "killed" | "died" to simulate the kill path
        self.calls = 0

    def run(self, body, gate):
        self.calls += 1
        t0 = time.monotonic()
        events = []
        out = poolmod.screen_job(body, self.clf, gate, emit=events.append)
        if self.forced and out.kind == "result":
            out = poolmod.Outcome(kind=self.forced, result=None, started=out.started,
                                  phase="stages", elapsed_s=time.monotonic() - t0,
                                  detail="simulated", worker_pid=0)
        return out

    def status(self):
        return {"ready": 1, "total": 1, "busy": 0, "kills": 0, "deaths": 0}
