#!/usr/bin/env python3
"""run_i4_db_tests.py - prove intake/purge.py and intake/stats.py on a THROWAWAY postgres.

NEVER the live openbrain-db: the same guard as run_db_tests.py (the container must be labelled
ai-stack.test=<label> AND on network `none`).

Usage (from integrations/intake/):
  python tests/db/run_i4_db_tests.py --start --image pgvector/pgvector:pg16 --label intake-i4 \
      --roles live-roles.sql --schema live-schema.sql

The dumps are the schema-only / roles-only dumps the I1 tests use (no data). The runner loads
them, applies sql/init-intake.sql, loads the I1 fixtures (sources/thoughts rows) and the I4
fixtures below, and then, running the library functions as the `intake` role:

  P1 each retention rule deletes exactly the rows it names (by id), nothing else;
  P2 each rule is batch-bounded (batch_size 2, max_batches 1 deletes 2 and says `more`);
  P3 each rule is idempotent (a second run deletes 0);
  P4 every other table is unchanged (row count + md5 of every row, all tables in public and
     intake); intake.items changes ONLY raw_item_id -> NULL on the rows linked to a purged raw
     row (the schema's ON DELETE SET NULL), every other column byte-identical;
  P5 a `suspicious` source row linked to a purged item is untouched;
  S1 stats.collect returns the documented shape and the counts the fixtures imply.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))

import run_db_tests as base  # noqa: E402  (start, guard, DB, load, INIT, FIXTURES)

from intake import config, purge, stats  # noqa: E402

NOW = dt.datetime(2026, 10, 16, 12, 0, tzinfo=dt.timezone.utc)
FAILS: list[str] = []


def ok(name):
    print(f"PASS  {name}")


def bad(name, detail=""):
    FAILS.append(name)
    print(f"FAIL  {name}" + (f"\n      {str(detail)[:800]}" if detail else ""))


def check(cond, name, detail=""):
    (ok(name) if cond else bad(name, detail))


def lit(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, dt.datetime):
        return "'" + v.isoformat() + "'::timestamptz"
    if isinstance(v, str):
        return "'" + v.replace("'", "''") + "'"
    raise TypeError(type(v))


class PsqlAdapter:
    """purge.DB / stats DB over `docker exec psql`, as a given role. Parameters are rendered as
    SQL literals (ints, aware datetimes, strings, NULL only)."""

    def __init__(self, db: base.DB, role: str = "intake", pre: str = ""):
        self.db = db
        self.role = role
        self.pre = pre
        self.calls = 0

    def execute(self, sql, params):
        for k, v in params.items():
            sql = sql.replace(f"%({k})s", lit(v))
        if "%(" in sql:
            raise ValueError("unbound parameter in " + sql[:80])
        self.calls += 1
        rc, out, err = self.db.run("\\pset null '<NULL>'\n" + self.pre + sql + ";", role=self.role)
        if rc != 0:
            raise RuntimeError(err)
        rows = []
        for line in out.splitlines():
            if not line.strip() or line.startswith("Null display"):
                continue
            rows.append(tuple(None if c == "<NULL>" else c for c in line.split("|")))
        return rows


# -- fixtures --------------------------------------------------------------------------------
# name, connector, age_days, items: [(item name, status, verdict, link: "id"|"key", scores)]
def sha(name: str) -> str:
    return hashlib.sha256(name.encode()).hexdigest()


RAW = [
    ("rc_old", "web", 31, [("i_rc_old", "done", "clean", "id", {})]),
    ("rc_new", "web", 29, [("i_rc_new", "done", "clean", "id", {})]),
    ("rc_edge", "web", 30, [("i_rc_edge", "done", "clean", "id", {})]),
    ("rc_key", "gmail", 40, [("i_rc_key", "done", "clean", "key", {})]),
    ("rs_old", "web", 31, [("i_rs_old", "done", "suspicious", "id", {})]),
    ("rs_new", "web", 10, [("i_rs_new", "done", "suspicious", "id", {})]),
    ("rp_old", "web", 60, [("i_rp_old", "pending", None, "id",
                            {"needs_second_opinion": True})]),
    ("rp_err", "gmail", 2, [("i_rp_err", "pending", None, "id",
                             {"error": "classifier: x", "error_kind": "transient"})]),
    ("ri_old", "web", 60, [("i_ri_old", "done", "injected", "id", {})]),
    ("ru_old", "web", 60, [("i_ru_old", "done", "unscreened", "id", {})]),
    ("rorph", "web", 90, []),
    ("rmix", "web", 60, [("i_rmix_a", "done", "clean", "id", {}),
                         ("i_rmix_b", "done", "suspicious", "id-other-key", {})]),
    ("rrej", "web", 60, [("i_rrej", "rejected", None, "id", {})]),
    ("rperm", "web", 3, [("i_rperm", "done", "suspicious", "id",
                          {"error": "classifier: passed 180.0s", "error_kind": "permanent"})]),
] + [(f"rb{i}", "web", 45, [(f"i_rb{i}", "done", "clean", "id", {})]) for i in range(1, 6)]

EXPECT_CLEAN = {"rc_old", "rc_key", "rb1", "rb2", "rb3", "rb4", "rb5"}
EXPECT_SUSPICIOUS = {"rs_old"}

DISCARDS = [("d_old", "web", 366), ("d_old2", "gmail", 400), ("d_new", "web", 364), ("d_edge", "web", 365),
            ("d_b1", "web", 500), ("d_b2", "web", 500), ("d_b3", "web", 500)]
EXPECT_DISCARDS = {"d_old", "d_old2", "d_b1", "d_b2", "d_b3"}


def fixture_sql() -> str:
    out = []
    for name, conn, age, items in RAW:
        t = NOW - dt.timedelta(days=age)
        out.append(
            "INSERT INTO intake.raw_items (source, connector, external_id, raw_sha256, content_type, raw, created_at) "
            f"VALUES ('web', {lit(conn)}, {lit(name)}, {lit(sha(name))}, 'text/plain', 'x'::bytea, {lit(t)});")
        for iname, status, verdict, link, scores in items:
            ext = name if link in ("id", "key") else iname  # another key for the mixed case
            rid = (f"(SELECT id FROM intake.raw_items WHERE external_id = {lit(name)})"
                   if link in ("id", "id-other-key") else "NULL")
            out.append(
                "INSERT INTO intake.items (raw_item_id, source, connector, external_id, raw_sha256, status, verdict, "
                f"scores, created_at, decided_at) VALUES ({rid}, 'web', {lit(conn)}, {lit(ext)}, "
                f"{lit(sha(ext))}, {lit(status)}, {lit(verdict)}, {lit(json.dumps(scores))}::jsonb, {lit(t)}, "
                f"{lit(t if status == 'done' else None)});")
    for name, conn, age in DISCARDS:
        out.append("INSERT INTO intake.discards (source, connector, external_id, raw_sha256, reason, created_at) "
                   f"VALUES ('web', {lit(conn)}, {lit(name)}, {lit(sha(name))}, 'strong-rule', "
                   f"{lit(NOW - dt.timedelta(days=age))});")
    return "\n".join(out)


def tables(db) -> list[str]:
    out = db.val("SELECT string_agg(format('%I.%I', table_schema, table_name), ',' ORDER BY 1) "
                 "FROM information_schema.tables WHERE table_schema IN ('public','intake') "
                 "AND table_type = 'BASE TABLE'")
    return out.split(",")


def image(db, names) -> dict:
    """Row count + md5 over every row of every table, in one query (as postgres: RLS bypassed)."""
    parts = [f"SELECT {base_lit(t)}, count(*) || ':' || md5(coalesce(string_agg(x.t, E'\\n' ORDER BY x.t), '')) "
             f"FROM (SELECT r::text AS t FROM {t} r) x" for t in names]
    parts.append("SELECT 'intake.items/without raw_item_id', count(*) || ':' || "
                 "md5(coalesce(string_agg(x.t, E'\\n' ORDER BY x.t), '')) "
                 "FROM (SELECT (to_jsonb(r) - 'raw_item_id')::text AS t FROM intake.items r) x")
    rc, out, err = db.run("\nUNION ALL\n".join(parts) + ";")
    if rc != 0:
        raise RuntimeError(err)
    snap = dict(line.split("|", 1) for line in out.splitlines() if "|" in line)
    if len(snap) != len(names) + 1:
        raise RuntimeError(f"snapshot covered {len(snap)} of {len(names) + 1} tables")
    return snap


def base_lit(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def names(db, table) -> set:
    v = db.val(f"SELECT coalesce(string_agg(external_id, ',' ORDER BY external_id), '') FROM {table}")
    return set(v.split(",")) - {""}


def null_links(db) -> set:
    v = db.val("SELECT coalesce(string_agg(external_id, ',' ORDER BY external_id), '') FROM intake.items "
               "WHERE raw_item_id IS NULL")
    return set(v.split(",")) - {""}


def expected_stats() -> dict:
    verdicts: dict = {}
    pending, so = [], []
    errors = {"transient": 0, "permanent": 0}
    for _name, conn, age, items in RAW:
        for _i, status, verdict, _link, scores in items:
            row = verdicts.setdefault(conn, dict.fromkeys(stats.VERDICT_KEYS, 0))
            row[verdict if status == "done" else status] += 1
            if status == "pending":
                pending.append(age)
                if scores.get("needs_second_opinion"):
                    so.append(age)
            if scores.get("error"):
                errors[scores.get("error_kind", "transient")] += 1
    discards: dict = {}
    for _n, conn, _a in DISCARDS:
        discards[conn] = discards.get(conn, 0) + 1
    return {
        "schema": stats.SCHEMA, "generated_at": NOW.isoformat(), "since": None,
        "verdicts": dict(sorted(verdicts.items())),
        "queue": {"pending": len(pending), "oldest_pending_age_s": max(pending) * 86400.0,
                  "second_opinion_depth": len(so), "second_opinion_oldest_age_s": max(so) * 86400.0},
        "errors": {**errors, "total": sum(errors.values())},
        "discards": dict(sorted(discards.items())),
    }


class Eastern(dt.tzinfo):
    """US Eastern, 2007+ DST rules (the Windows host has no tzdata)."""

    @staticmethod
    def _window(y):
        m, n = dt.datetime(y, 3, 8), dt.datetime(y, 11, 1)
        return ((m + dt.timedelta(days=(6 - m.weekday()) % 7)).replace(hour=2),
                (n + dt.timedelta(days=(6 - n.weekday()) % 7)).replace(hour=2))

    def dst(self, d):
        a, b = self._window(d.year)
        return dt.timedelta(hours=1) if a <= d.replace(tzinfo=None) < b else dt.timedelta(0)

    def utcoffset(self, d):
        return dt.timedelta(hours=-5) + self.dst(d)


def _time_fixture(db, tag: str, created: dict) -> None:
    """Empty bronze and the discard records (as postgres), then add one clean raw row, one
    suspicious raw row and one discard per entry of `created` (name -> SQL timestamptz expr)."""
    rc, _, err = db.run("DELETE FROM intake.raw_items; DELETE FROM intake.discards;")
    if rc != 0:
        raise RuntimeError(err)
    out = []
    for name, when in created.items():
        for kind, verdict in (("c", "clean"), ("s", "suspicious")):
            ext = f"{tag}-{kind}-{name}"
            out.append("INSERT INTO intake.raw_items (source, connector, external_id, raw_sha256, content_type, raw, "
                       f"created_at) VALUES ('web', 'web', {lit(ext)}, {lit(sha(ext))}, 'text/plain', 'x', {when});")
            out.append("INSERT INTO intake.items (raw_item_id, source, connector, external_id, raw_sha256, status, "
                       f"verdict, created_at) VALUES ((SELECT id FROM intake.raw_items WHERE external_id = {lit(ext)}), "
                       f"'web', 'web', {lit(ext)}, {lit(sha(ext))}, 'done', {lit(verdict)}, {when});")
        ext = f"{tag}-d-{name}"
        out.append("INSERT INTO intake.discards (source, connector, external_id, raw_sha256, reason, created_at) "
                   f"VALUES ('web', 'web', {lit(ext)}, {lit(sha(ext))}, 'strong-rule', {when});")
    rc, _, err = db.run("\n".join(out))
    if rc != 0:
        raise RuntimeError(err)


def time_sections(db, r) -> None:
    """D-1 (attempt 1): the cutoff is absolute time. TZ: a DST-zone `now` (spring and autumn);
    N: no `now` at all - the database's now() - with the session in a DST zone."""
    for label, now in (("spring", dt.datetime(2027, 4, 5, 12, 0, tzinfo=Eastern())),
                       ("autumn", dt.datetime(2027, 11, 20, 12, 0, tzinfo=Eastern())),
                       # EST now, EDT one year earlier: the 365-day window crosses a change too
                       ("yearly", dt.datetime(2027, 3, 10, 12, 0, tzinfo=Eastern()))):
        u = now.astimezone(dt.timezone.utc)
        ages = {}
        for days, prefix in ((30, "b"), (365, "x")):
            ages[f"{prefix}young"] = u - dt.timedelta(days=days) + dt.timedelta(minutes=30)
            ages[f"{prefix}old"] = u - dt.timedelta(days=days) - dt.timedelta(minutes=30)
        _time_fixture(db, label, {k: lit(v) for k, v in ages.items()})
        purge.run_all(PsqlAdapter(db), now, retention=r)
        raw = names(db, "intake.raw_items")
        disc = names(db, "intake.discards")
        check(raw == {f"{label}-c-byoung", f"{label}-s-byoung"},
              f"TZ {label} DST now ({now.isoformat()}): bronze 29 d 23 h 30 min old stays, 30 d 0 h 30 min old "
              "goes (clean and suspicious)", sorted(raw))
        check(disc == {f"{label}-d-xyoung", f"{label}-d-byoung", f"{label}-d-bold"},
              f"TZ {label} DST now: discards 364 d 23 h 30 min old stay, 365 d 0 h 30 min old go", sorted(disc))
    # N: the database's now(), the session in a DST zone
    ages = {"byoung": "now() - make_interval(hours => 30 * 24 - 1)",
            "bold": "now() - make_interval(hours => 30 * 24 + 1)",
            "xyoung": "now() - make_interval(hours => 365 * 24 - 1)",
            "xold": "now() - make_interval(hours => 365 * 24 + 1)"}
    _time_fixture(db, "dbnow", ages)
    ad = PsqlAdapter(db, pre="SET TimeZone = 'America/New_York';\n")
    reps = purge.run_all(ad, retention=r)
    raw = names(db, "intake.raw_items")
    disc = names(db, "intake.discards")
    check(raw == {"dbnow-c-byoung", "dbnow-s-byoung"}
          and disc == {"dbnow-d-xyoung", "dbnow-d-byoung", "dbnow-d-bold"},
          "N no `now` given: the database's now() minus N x 24 h decides, session TimeZone America/New_York",
          f"{sorted(raw)} {sorted(disc)} {[x.to_dict() for x in reps]}")
    check(all(x.cutoff.startswith("database now() - ") for x in reps), "N the report names the database clock",
          [x.cutoff for x in reps])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--container")
    ap.add_argument("--start", action="store_true")
    ap.add_argument("--image", default="pgvector/pgvector:pg16")
    ap.add_argument("--label", default="intake-i4")
    ap.add_argument("--roles")
    ap.add_argument("--schema")
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    if not (a.container or a.start):
        ap.error("--container NAME or --start")
    name = base.start(a.image, a.label) if a.start else a.container
    base.guard(name, a.label)
    db = base.DB(name)
    try:
        if a.roles and a.schema:
            base.load(db, a.roles, a.schema)
        for label, kw in (("I1 fixtures", dict(file=base.FIXTURES)), ("init-intake.sql", dict(file=base.INIT)),
                          ("I4 fixtures", dict())):
            rc, _, err = db.run(fixture_sql() if not kw else "", **kw)
            if rc != 0:
                bad(f"setup: {label}", err)
                return 1
        ok("setup: schema, init-intake.sql, I1 + I4 fixtures")
        # P5 setup: a source row labelled suspicious by the intake role, linked to the item purged below
        rc, _, err = db.run("UPDATE public.sources SET screen_verdict = 'suspicious', intake_item_id = "
                            "(SELECT id FROM intake.items WHERE external_id = 'rs_old') "
                            "WHERE id = (SELECT id FROM public.sources ORDER BY id LIMIT 1);", login="intake")
        check(rc == 0, "setup: the intake role labels one source `suspicious`, linked to item rs_old", err)
        src_before = db.val("SELECT row_to_json(s)::text FROM public.sources s WHERE intake_item_id IS NOT NULL")

        # S1 stats on the fixture data (before any purge)
        got = stats.collect(PsqlAdapter(db), NOW).to_dict()
        want = expected_stats()
        check(got == want, "S1 stats.collect: documented shape and fixture counts",
              json.dumps({"got": got, "want": want}, indent=1))
        since = NOW - dt.timedelta(days=20)
        got = stats.collect(PsqlAdapter(db), NOW, since=since).to_dict()
        check(got["since"] == since.isoformat() and got["verdicts"]["web"]["suspicious"] == 2
              and got["verdicts"]["gmail"]["pending"] == 1 and got["discards"] == {}
              and got["queue"]["pending"] == 2, "S2 stats.collect with since: only rows created since",
              json.dumps(got))

        all_tables = tables(db)
        r = config.retention({})
        rules = (("clean-bronze", purge.purge_clean_bronze, "intake.raw_items", EXPECT_CLEAN),
                 ("suspicious-bronze", purge.purge_suspicious_bronze, "intake.raw_items", EXPECT_SUSPICIOUS),
                 ("discards", purge.purge_discards, "intake.discards", EXPECT_DISCARDS))
        for rule, fn, table, expect in rules:
            before = image(db, all_tables)
            ids_before = names(db, table)
            links_before = null_links(db)
            ad = PsqlAdapter(db)
            # P2 batch bound
            rep = fn(ad, NOW, retention=r, batch_size=2, max_batches=1)
            want_first = min(2, len(expect))
            check(rep.deleted == want_first and rep.batches == 1 and rep.more == (len(expect) >= 2),
                  f"P2 {rule}: batch_size 2 x 1 batch deletes {want_first} and reports more={len(expect) >= 2}",
                  rep.to_dict())
            rep2 = fn(ad, NOW, retention=r, batch_size=2, max_batches=100)
            check(rep.deleted + rep2.deleted == len(expect) and not rep2.more,
                  f"P1 {rule}: the rest in bounded batches ({rep2.batches} more), {len(expect)} in all",
                  rep2.to_dict())
            gone = ids_before - names(db, table)
            check(gone == expect, f"P1 {rule}: deleted exactly {sorted(expect)}",
                  f"deleted {sorted(gone)}")
            rep3 = fn(ad, NOW, retention=r, batch_size=2, max_batches=100)
            check(rep3.deleted == 0, f"P3 {rule}: idempotent, a second run deletes 0", rep3.to_dict())
            after = image(db, all_tables)
            changed = sorted(t for t in after if after[t] != before[t])
            allowed = {table}
            if table == "intake.raw_items":
                allowed.add("intake.items")  # raw_item_id SET NULL only (checked next)
            check(set(changed) <= allowed, f"P4 {rule}: no other table changed (of {len(all_tables)})",
                  f"changed: {changed}")
            if table == "intake.raw_items":
                new_null = null_links(db) - links_before
                # an item's external_id is its raw row's, except the mixed case's other key
                linked = {(n if link == "id" else i) for n, _c, _a, items in RAW if n in expect
                          for i, _s, _v, link, _sc in items if link in ("id", "id-other-key")}
                check(after["intake.items/without raw_item_id"] == before["intake.items/without raw_item_id"],
                      f"P4 {rule}: intake.items unchanged but for raw_item_id")
                check(new_null == linked, f"P4 {rule}: raw_item_id became NULL exactly on {sorted(linked)}",
                      f"became NULL: {sorted(new_null)}")
        src_after = db.val("SELECT row_to_json(s)::text FROM public.sources s WHERE intake_item_id IS NOT NULL")
        check(src_before == src_after and '"screen_verdict":"suspicious"' in src_after,
              "P5 the suspicious source row (silver) is untouched by every purge", src_after[:300])
        left = names(db, "intake.raw_items")
        check(left == {n for n, *_x in RAW} - EXPECT_CLEAN - EXPECT_SUSPICIOUS,
              "P1 what remains in bronze is exactly what no rule names", sorted(left))
        time_sections(db, r)
        # refused as a role without privileges: a model-facing role cannot purge
        try:
            purge.purge_discards(PsqlAdapter(db, role="service_role"), NOW, retention=r)
            bad("P6 a model-facing role (service_role) cannot run the purge")
        except RuntimeError as e:
            check("permission denied" in str(e), "P6 a model-facing role (service_role) cannot run the purge",
                  str(e)[:200])
    finally:
        if a.start and not a.keep:
            import subprocess
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
    print(f"\n{'FAILED' if FAILS else 'ALL PASS'}: {len(FAILS)} failure(s)")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
