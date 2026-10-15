#!/usr/bin/env python3
"""run_db_tests.py - prove sql/init-intake.sql and sql/revert-intake.sql on a THROWAWAY postgres.

NEVER the live openbrain-db. The runner refuses any container that is not labelled
`ai-stack.test=<label>` AND attached to network `none`, so a mistyped name cannot reach a real
database.

Usage (from integrations/intake/):
  # start a throwaway container from the SAME image as openbrain-db, load a schema-only dump
  python tests/db/run_db_tests.py --start --image pgvector/pgvector:pg16 \
      --roles live-roles.sql --schema live-schema.sql
  # or reuse one you started yourself (docker run --rm --network none --label ai-stack.test=intake-i1 ...)
  python tests/db/run_db_tests.py --container intake-i1-pg [--roles ... --schema ...]

The dumps are `pg_dumpall --roles-only --no-role-passwords` and `pg_dump --schema-only` of the
live database: DDL only, no data. Without them the runner builds the schema from the OB1
initdb chain instead is NOT supported - the point is the live shape.

What it proves (each line prints PASS/FAIL; exit 1 on any FAIL):
  A. apply, re-apply (catalogue identical), revert (catalogue identical to before), revert
     again, apply again (identical to the first apply);
  B. the backfill labels synthetic fixture rows per the documented origin rule, writes ONLY the
     label column (every other column byte-identical, updated_at included);
  C. roles: intake reads/writes bronze and sets clean/suspicious; every other non-superuser
     role (enumerated from pg_roles, cross-checked against the live grant list) cannot read
     or write intake.* and cannot set clean/suspicious - and where the role CAN write the
     table, it is the authority trigger that refuses, not an invisible row;
  D. the CHECK refuses other values; 'injected' never lands in sources/thoughts, not even
     from the intake role.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent  # integrations/intake
INIT = ROOT / "sql" / "init-intake.sql"
REVERT = ROOT / "sql" / "revert-intake.sql"
FIXTURES = HERE / "fixtures.sql"

# The live non-superuser roles on openbrain-db (pg_dumpall --roles-only, read-only, 2026-10-15).
# The runner ALSO enumerates pg_roles at run time, so a role added later is tested too; this
# list only makes a test DB that is missing them fail instead of passing vacuously.
LIVE_MODEL_FACING = ["anon", "authenticated", "ob_app_memory", "ob_pantry",
                     "ob_plane_personal", "service_role"]
# Of those, the ones the live grants let write sources/thoughts at all (service_role and its
# members): for them the refusal MUST come from the trigger, not from a missing privilege.
TABLE_WRITERS = {"service_role", "ob_app_memory", "ob_plane_personal"}

FAILS: list[str] = []


def ok(name):
    print(f"PASS  {name}")


def bad(name, detail=""):
    FAILS.append(name)
    print(f"FAIL  {name}" + (f"\n      {detail.strip()[:800]}" if detail else ""))


class DB:
    def __init__(self, container):
        self.c = container

    def run(self, sql, role=None, user_id=None, file=None, login="postgres"):
        pre = "\\set VERBOSITY verbose\n"
        if user_id:
            pre += f"SELECT set_config('ob.user_id', '{user_id}', false);\n"
        if role:
            pre += f"SET ROLE {role};\n"
        body = pre + (Path(file).read_text(encoding="utf-8") if file else sql)
        r = subprocess.run(["docker", "exec", "-i", self.c, "psql", "-U", login, "-d", "openbrain",
                            "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"],
                           input=body, capture_output=True, text=True, encoding="utf-8", errors="replace")
        return r.returncode, r.stdout, r.stderr

    def val(self, sql):
        rc, out, err = self.run(sql)
        if rc != 0:
            raise RuntimeError(err)
        lines = [line for line in out.splitlines() if line.strip()]
        return lines[-1] if lines else ""

    def snapshot(self):
        r = subprocess.run(["docker", "exec", self.c, "pg_dump", "-U", "postgres", "-d", "openbrain",
                            "--schema-only"], capture_output=True, text=True, encoding="utf-8")
        if r.returncode != 0:
            raise RuntimeError(r.stderr)
        dump = re.sub(r"^\\(un)?restrict .*$", "", r.stdout, flags=re.M)
        roles = self.val("SELECT string_agg(rolname || ':' || rolcanlogin || rolsuper || rolbypassrls, ',' "
                         "ORDER BY rolname) FROM pg_roles WHERE rolname !~ '^pg_'")
        return dump + "\n-- roles: " + roles


def expect_ok(db, name, sql, **kw):
    rc, out, err = db.run(sql, **kw)
    if rc == 0:
        ok(name)
    else:
        bad(name, err)
    return out


def expect_err(db, name, sql, codes, must_contain=None, **kw):
    """The statement must fail with one of `codes` (SQLSTATE); a success is a FAIL."""
    rc, out, err = db.run(sql, **kw)
    if rc == 0:
        bad(name, f"statement SUCCEEDED (expected {codes}); output: {out}")
        return
    m = re.search(r"ERROR:\s+([0-9A-Z]{5}):", err)
    code = m.group(1) if m else "?"
    if code not in codes:
        bad(name, f"failed with {code}, expected {codes}: {err}")
    elif must_contain and must_contain not in err:
        bad(name, f"failed with {code} but not from {must_contain!r}: {err}")
    else:
        ok(f"{name}  [{code}]")


def guard(container, label):
    r = subprocess.run(["docker", "inspect", container, "--format",
                        '{{index .Config.Labels "ai-stack.test"}}|{{.HostConfig.NetworkMode}}'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"REFUSED: cannot inspect {container}: {r.stderr.strip()}")
    lab, net = r.stdout.strip().split("|")
    if lab != label or net != "none":
        sys.exit(f"REFUSED: {container} is labelled ai-stack.test={lab!r} on network {net!r}; this runner "
                 f"only touches a throwaway container labelled ai-stack.test={label} on network none.")


def start(image, label):
    name = f"intake-dbtest-{uuid.uuid4().hex[:8]}"
    subprocess.run(["docker", "run", "-d", "--rm", "--network", "none", "--label", f"ai-stack.test={label}",
                    "--name", name, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=openbrain",
                    image], check=True, capture_output=True)
    import time
    for _ in range(180):
        logs = subprocess.run(["docker", "logs", name], capture_output=True, text=True)
        if "PostgreSQL init process complete" in (logs.stdout + logs.stderr):
            r = subprocess.run(["docker", "exec", name, "pg_isready", "-U", "postgres", "-d", "openbrain"],
                               capture_output=True)
            if r.returncode == 0:
                return name
        time.sleep(1)
    sys.exit(f"throwaway container {name} did not become ready")


def load(db, roles, schema):
    roles_sql = "\n".join(line for line in Path(roles).read_text(encoding="utf-8").splitlines()
                          if not re.match(r"^(CREATE|ALTER) ROLE postgres\b", line))
    rc, _, err = db.run(roles_sql)
    if rc != 0:
        sys.exit("loading roles failed: " + err)
    rc, _, err = db.run("", file=schema)
    if rc != 0:
        sys.exit("loading the schema-only dump failed: " + err)


# ------------------------------------------------------------------------------------------
def section_apply_revert(db):
    s0 = db.snapshot()
    rc, _, err = db.run("", file=INIT)
    if rc != 0:
        bad("A1 migration applies", err)
        return None
    ok("A1 migration applies")
    s1 = db.snapshot()
    rc, _, err = db.run("", file=INIT)
    if rc != 0:
        bad("A2 migration re-applies", err)
    else:
        ok("A2 migration re-applies")
        s2 = db.snapshot()
        (ok if s2 == s1 else lambda n: bad(n, _first_diff(s1, s2)))(
            "A3 re-apply leaves the catalogue identical (idempotent)")
    return s0, s1


def _first_diff(a, b):
    al, bl = a.splitlines(), b.splitlines()
    for i, (x, y) in enumerate(zip(al, bl)):
        if x != y:
            return f"line {i}: {x!r} != {y!r}"
    return f"length {len(al)} != {len(bl)}"


# Expected labels for fixtures.sql: fixture tag -> label. Kept here, beside the rule's prose in
# init-intake.sql section 2, so a change to the rule has to change both.
def expected_labels():
    exp = {}
    for line in FIXTURES.read_text(encoding="utf-8").splitlines():
        m = re.search(r"--\s*expect\s+(\S+)\s+(internal|unscreened)\b", line)
        if m:
            exp[m.group(1)] = m.group(2)
    return exp


def section_backfill(db, before):
    exp = expected_labels()
    if not exp:
        bad("B0 fixtures declare expectations")
        return
    rows = db.run("SELECT 'src:' || (metadata->>'fixture') || '=' || screen_verdict FROM public.sources "
                  "WHERE metadata ? 'fixture' UNION ALL "
                  "SELECT 'th:' || (metadata->>'fixture') || '=' || screen_verdict FROM public.thoughts "
                  "WHERE metadata ? 'fixture'")[1].split()
    got = {}
    for r in rows:
        k, _, v = r.partition("=")
        got[k.split(":", 1)[1]] = v
    wrong = {k: (exp[k], got.get(k)) for k in exp if got.get(k) != exp[k]}
    if wrong:
        bad("B1 backfill labels every fixture per the documented rule",
            "; ".join(f"{k}: expected {e} got {g}" for k, (e, g) in sorted(wrong.items())))
    else:
        ok(f"B1 backfill labels every fixture per the documented rule ({len(exp)} rows: "
           f"{sum(v == 'internal' for v in exp.values())} internal, "
           f"{sum(v == 'unscreened' for v in exp.values())} unscreened)")
    after = fixture_image(db)
    (ok if after == before else lambda n: bad(n, _first_diff(before, after)))(
        "B2 backfill rewrote no other column (updated_at, content, metadata byte-identical)")


def fixture_image(db):
    return db.run("SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM ("
                  "SELECT id::text, url, title, content, content_type, metadata::text, created_at, updated_at, "
                  "content_hash FROM public.sources WHERE metadata ? 'fixture') t; "
                  "SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM ("
                  "SELECT id, content, metadata::text, created_at, updated_at, content_fingerprint, exposure, "
                  "user_id FROM public.thoughts WHERE metadata ? 'fixture') t;")[1]


def section_roles(db):
    roles = db.val("SELECT string_agg(rolname, ' ' ORDER BY rolname) FROM pg_roles "
                   "WHERE NOT rolsuper AND rolname !~ '^pg_' AND rolname <> 'intake'").split()
    missing = [r for r in LIVE_MODEL_FACING if r not in roles]
    if missing:
        bad("C0 the live model-facing roles exist in the test DB", f"missing {missing}")
    else:
        ok(f"C0 model-facing roles under test (pg_roles, cross-checked with the live grant list): {roles}")

    sid = db.val("SELECT id FROM public.sources WHERE metadata->>'fixture' = 'ext-web' LIMIT 1")
    tid_ops = db.val("SELECT id FROM public.thoughts WHERE metadata->>'fixture' = 'th-capture-ops' LIMIT 1")
    tid_per = db.val("SELECT id FROM public.thoughts WHERE metadata->>'fixture' = 'th-personal' LIMIT 1")
    tid_plain = db.val("SELECT id FROM public.thoughts WHERE metadata->>'fixture' = 'th-agent-org' LIMIT 1")
    per_user = db.val(f"SELECT user_id FROM public.thoughts WHERE id = {tid_per}")

    # ---- intake can do its job --------------------------------------------------------------
    raw = ("INSERT INTO intake.raw_items (source, connector, external_id, raw_sha256, content_type, raw, envelope) "
           "VALUES ('web', 'web', 'https://example.test/a', repeat('a', 64), 'text/html', 'x'::bytea, '{}') "
           "RETURNING id;")
    out = expect_ok(db, "C1 intake writes bronze (raw_items INSERT)", raw, login="intake")
    raw_id = (out.strip().splitlines() or [""])[-1]
    expect_ok(db, "C2 intake reads bronze", "SELECT count(*) FROM intake.raw_items;", login="intake")
    expect_ok(db, "C3 intake updates/deletes bronze",
              f"UPDATE intake.raw_items SET envelope = '{{\"k\":1}}' WHERE id = '{raw_id}'; "
              "DELETE FROM intake.raw_items WHERE external_id = 'nothing';", login="intake")
    out = expect_ok(db, "C4 intake writes silver (items) and discards",
                    "INSERT INTO intake.items (raw_item_id, source, connector, external_id, raw_sha256, status, "
                    f"verdict, classifier_version) VALUES ('{raw_id}', 'web', 'web', 'https://example.test/a', "
                    "repeat('a', 64), 'done', 'clean', 'test') RETURNING id; "
                    "INSERT INTO intake.discards (source, connector, external_id, raw_sha256, reason) "
                    "VALUES ('web','web','x', repeat('b',64), 'test');", login="intake")
    item_id = [line for line in out.split() if re.fullmatch(r"[0-9a-f-]{36}", line)]
    item_id = item_id[-1] if item_id else str(uuid.uuid4())
    expect_ok(db, "C5 intake sets clean + intake_item_id on sources",
              f"UPDATE public.sources SET screen_verdict='clean', intake_item_id='{item_id}' "
              f"WHERE id='{sid}' RETURNING id;", login="intake")
    rc, out, _ = db.run(f"UPDATE public.thoughts SET screen_verdict='suspicious', intake_item_id='{item_id}' "
                        f"WHERE id={tid_ops} RETURNING id;", login="intake")
    (ok if rc == 0 and str(tid_ops) in out else lambda n: bad(n, out))(
        "C6 intake sets suspicious + intake_item_id on thoughts (RLS lets it reach the row)")
    expect_err(db, "C7 intake cannot read thought/source CONTENT (column-level grant)",
               "SELECT content FROM public.sources LIMIT 1;", {"42501"}, login="intake")

    # ---- every other role -----------------------------------------------------------------
    for r in roles:
        for t in ("raw_items", "items", "discards"):
            expect_err(db, f"C8 {r} cannot read intake.{t}", f"SELECT * FROM intake.{t} LIMIT 1;",
                       {"42501"}, role=r)
        expect_err(db, f"C9 {r} cannot write bronze",
                   "INSERT INTO intake.raw_items (source, connector, external_id, raw_sha256, content_type, raw) "
                   "VALUES ('w','w','x', repeat('c',64), 'text/plain', 'x'::bytea);", {"42501"}, role=r)
        trig = "intake authority" if r in TABLE_WRITERS else None
        uid = per_user if r == "ob_plane_personal" else None
        # a row intake has NOT labelled (C6 made tid_ops 'suspicious'; re-writing the same
        # value is not a change and is rightly allowed)
        tid = tid_per if r == "ob_plane_personal" else tid_plain
        for v in ("clean", "suspicious"):
            expect_err(db, f"C10 {r} cannot UPDATE sources to {v}",
                       f"UPDATE public.sources SET screen_verdict='{v}' WHERE metadata->>'fixture'='ext-gmail' "
                       "RETURNING id;", {"42501"}, must_contain=trig, role=r, user_id=uid)
            expect_err(db, f"C11 {r} cannot UPDATE thoughts to {v}",
                       f"UPDATE public.thoughts SET screen_verdict='{v}' WHERE id={tid} RETURNING id;",
                       {"42501"}, must_contain=trig, role=r, user_id=uid)
            expect_err(db, f"C12 {r} cannot INSERT a source as {v}",
                       "INSERT INTO public.sources (url, title, content, screen_verdict) "
                       f"VALUES ('https://example.test/{r}', 't', 'c', '{v}') RETURNING id;",
                       {"42501"}, must_contain=trig, role=r, user_id=uid)
        expect_err(db, f"C13 {r} cannot set intake_item_id",
                   f"UPDATE public.sources SET intake_item_id='{item_id}' WHERE metadata->>'fixture'='ext-gmail' "
                   "RETURNING id;", {"42501"}, must_contain=trig, role=r, user_id=uid)
        expect_err(db, f"C14 {r} cannot overwrite intake's verdict (clean -> unscreened/internal)",
                   f"UPDATE public.sources SET screen_verdict='internal' WHERE id='{sid}' RETURNING id;",
                   {"42501"}, must_contain=trig, role=r, user_id=uid)
        expect_err(db, f"C15 {r} cannot launder an external row (unscreened -> internal)",
                   "UPDATE public.sources SET screen_verdict='internal' WHERE metadata->>'fixture'='ext-gmail' "
                   "RETURNING id;", {"42501"}, must_contain=trig, role=r, user_id=uid)

    # Model-facing writers keep working: an insert that does not state the label gets the safe default.
    rc, out, err = db.run("INSERT INTO public.sources (url, title, content) VALUES "
                          "('https://example.test/new', 't', 'c') RETURNING screen_verdict;", role="service_role")
    (ok if rc == 0 and out.strip().endswith("unscreened") else lambda n: bad(n, out + err))(
        "C16 an unconverted writer still inserts; the row defaults to 'unscreened'")
    rc, out, err = db.run("INSERT INTO public.sources (url, title, content, screen_verdict) VALUES "
                          "(NULL, 'note', 'c', 'internal') RETURNING screen_verdict;", role="ob_app_memory")
    (ok if rc == 0 and out.strip().endswith("internal") else lambda n: bad(n, out + err))(
        "C17 a stack writer may state 'internal' on INSERT")
    rc, out, err = db.run(f"UPDATE public.sources SET title = title || '' WHERE id='{sid}' RETURNING id;",
                          role="service_role")
    (ok if rc == 0 else lambda n: bad(n, err))(
        "C18 an ordinary UPDATE of a screened row that leaves the label alone still works")

    # Superuser is not 'intake' either: the trigger keys on the role, not on privilege.
    expect_err(db, "C19 even postgres (superuser) cannot set clean on a plain write",
               "UPDATE public.sources SET screen_verdict='clean' WHERE metadata->>'fixture'='ext-gmail';",
               {"42501"}, must_contain="intake authority")
    # F5: intake is not assumable. Only a connection that LOGGED IN as intake decides; SET ROLE
    # (an operator, or PostgREST honouring a JWT with role=intake: it authenticates as postgres
    # and runs SET LOCAL ROLE) is refused.
    gid = db.val("SELECT id FROM public.sources WHERE metadata->>'fixture' = 'ext-gmail'")
    for t, where in (("sources", f"id='{gid}'"), ("thoughts", f"id={tid_plain}")):
        expect_err(db, f"C22 SET ROLE intake (not a login) cannot set clean on {t}",
                   f"UPDATE public.{t} SET screen_verdict='clean' WHERE {where};",
                   {"42501"}, must_contain="intake authority", role="intake")
        expect_err(db, f"C23 a PostgREST-style JWT role switch to intake cannot set suspicious on {t}",
                   "BEGIN; SET LOCAL ROLE intake; "
                   "SELECT set_config('request.jwt.claims', '{\"role\":\"intake\"}', true); "
                   f"UPDATE public.{t} SET screen_verdict='suspicious' WHERE {where}; COMMIT;",
                   {"42501"}, must_contain="intake authority")
    who = db.val("SELECT coalesce(string_agg(m.rolname, ','), '') FROM pg_auth_members a "
                 "JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member "
                 "WHERE g.rolname = 'intake' OR m.rolname = 'intake'")
    (ok if who == "" else lambda n: bad(n, who))(
        "C24 catalogue: intake has no members and is a member of nothing (no membership path to assume it)")

    # Catalogue-level: no non-superuser role but intake holds ANY privilege on intake.*
    leak = db.val("SELECT coalesce(string_agg(r.rolname || ' ' || c.relname || ' ' || p, ', '), '') "
                  "FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                  "CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p "
                  "WHERE n.nspname = 'intake' AND c.relkind IN ('r','p','v','m','S') AND NOT r.rolsuper "
                  "AND r.rolname <> 'intake' AND r.rolname NOT IN ('pg_write_all_data','pg_read_all_data') "
                  "AND has_table_privilege(r.oid, c.oid, p)")
    (ok if leak == "" else lambda n: bad(n, leak))(
        "C20 catalogue: no non-superuser role except intake holds any privilege on intake.*")
    members = db.val("SELECT coalesce(string_agg(m.rolname || ' in ' || g.rolname, ', '), '') FROM pg_auth_members a "
                     "JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member "
                     "WHERE g.rolname IN ('intake','pg_read_all_data','pg_write_all_data')")
    (ok if members == "" else lambda n: bad(n, members))(
        "C21 catalogue: nobody is a member of intake / pg_read_all_data / pg_write_all_data")


ATTACKERS = (("ob_app_memory", "login"), ("service_role", "role"))


def as_(who, how):
    return {"login": who} if how == "login" else {"role": who}


def section_attacks(db):
    """Round 2: the tester's T5.1 laundering trigger and the T5.2 list, as ob_app_memory (a real
    login: openbrain-mcp, -ext, -research, ...) and as service_role, on sources AND thoughts."""
    # rows still 'unscreened' at this point (ext-web was set clean by intake in C5)
    sid = db.val("SELECT id FROM public.sources WHERE metadata->>'fixture' = 'ext-gmail'")
    tid = db.val("SELECT id FROM public.thoughts WHERE metadata->>'fixture' = 'th-chatgpt'")
    launder = ("CREATE FUNCTION pg_temp.launder() RETURNS trigger LANGUAGE plpgsql AS "
               "$f$ BEGIN NEW.screen_verdict := 'clean'; RETURN NEW; END $f$; ")
    for who, how in ATTACKERS:
        kw = as_(who, how)
        for t in ("sources", "thoughts"):
            # E1 the exact T5.1 repro: attach a pg_temp BEFORE trigger that rewrites NEW.
            expect_err(db, f"E1 {who} cannot attach a laundering trigger to {t} (TRIGGER revoked)",
                       launder + f"CREATE TRIGGER zzzz_launder BEFORE INSERT OR UPDATE ON public.{t} "
                       "FOR EACH ROW EXECUTE FUNCTION pg_temp.launder();", {"42501"}, **kw)
        # E3 defence in depth: even if a rewriting BEFORE trigger exists (planted by the owner,
        # i.e. the TRIGGER revoke is assumed lost), the AFTER ROW check judges the stored row.
        for t, where in (("sources", f"id='{sid}'"), ("thoughts", f"id={tid}")):
            db.run(f"CREATE FUNCTION public.zz_test_launder() RETURNS trigger LANGUAGE plpgsql AS "
                   f"$f$ BEGIN NEW.screen_verdict := 'clean'; RETURN NEW; END $f$; "
                   f"GRANT EXECUTE ON FUNCTION public.zz_test_launder() TO PUBLIC; "
                   f"CREATE TRIGGER zzzz_planted BEFORE INSERT OR UPDATE ON public.{t} "
                   f"FOR EACH ROW EXECUTE FUNCTION public.zz_test_launder();")
            expect_err(db, f"E3 {who}: a later BEFORE trigger rewriting NEW to clean on {t} is caught AFTER",
                       f"UPDATE public.{t} SET content = content WHERE {where};",
                       {"42501"}, must_contain="intake authority", **kw)
            db.run(f"DROP TRIGGER zzzz_planted ON public.{t}; DROP FUNCTION public.zz_test_launder();")
        # E4 the T5.2 list (all must stay refused)
        cases = [
            ("read bronze with COPY", "COPY intake.raw_items TO STDOUT;"),
            ("read bronze via COPY (SELECT)", "COPY (SELECT raw FROM intake.raw_items) TO STDOUT;"),
            ("temp view over bronze", "CREATE TEMP VIEW v AS SELECT * FROM intake.raw_items;"),
            ("SET ROLE intake", "SET ROLE intake;"),
            ("SET SESSION AUTHORIZATION intake", "SET SESSION AUTHORIZATION intake;"),
            ("session_replication_role=replica", "SET session_replication_role = replica;"),
            ("DISABLE the authority trigger",
             "ALTER TABLE public.sources DISABLE TRIGGER zzz_intake_screen_verdict_authority;"),
            ("DISABLE TRIGGER USER", "ALTER TABLE public.thoughts DISABLE TRIGGER USER;"),
            ("DROP the authority trigger", "DROP TRIGGER zzz_intake_screen_verdict_authority ON public.sources;"),
            ("default the column to clean", "ALTER TABLE public.sources ALTER COLUMN screen_verdict SET DEFAULT 'clean';"),
            ("drop the CHECK", "ALTER TABLE public.thoughts DROP CONSTRAINT thoughts_screen_verdict_check;"),
            ("disable RLS", "ALTER TABLE public.thoughts DISABLE ROW LEVEL SECURITY;"),
            ("CREATE RULE", "CREATE RULE r AS ON UPDATE TO public.sources DO INSTEAD NOTHING;"),
            ("replace the trigger function",
             "CREATE OR REPLACE FUNCTION intake.enforce_screen_verdict_authority() RETURNS trigger "
             "LANGUAGE plpgsql AS $f$ BEGIN RETURN NULL; END $f$;"),
            ("COPY sources FROM STDIN with clean",
             "COPY public.sources (url, title, content, screen_verdict) FROM STDIN;\n"
             "https://example.test/copy\tt\tc\tclean\n\\.\n"),
            ("INSERT .. ON CONFLICT DO UPDATE SET clean (sources)",
             "INSERT INTO public.sources (url, title, content, content_type, research_key) "
             "VALUES (NULL, 't', 'c', 'research_synthesis', 'rk-1') "
             "ON CONFLICT (research_key) WHERE content_type = 'research_synthesis' "
             "DO UPDATE SET screen_verdict = 'clean';"),
            ("INSERT .. ON CONFLICT DO UPDATE SET suspicious (thoughts)",
             f"INSERT INTO public.thoughts (id, content, exposure, metadata) "
             f"VALUES ({tid}, 'x', 'ops', '{{\"exposure\":\"ops\"}}') "
             "ON CONFLICT (id) DO UPDATE SET screen_verdict = 'suspicious';"),
            ("ALTER the intake role", "ALTER ROLE intake NOLOGIN;"),
            ("GRANT intake membership to self", f"GRANT intake TO {who};"),
        ]
        for name, sql in cases:
            if how == "role" and name.startswith(("SET ROLE", "SET SESSION")):
                continue  # SET ROLE from a superuser session: the escalation case is the real login above
            expect_err(db, f"E4 {who}: {name}", sql, {"42501"}, **kw)
    # E5 the property, over every role: nobody but a superuser can attach code.
    leak = db.val("SELECT coalesce(string_agg(r.rolname || ' ' || c.oid::regclass::text || ' ' || p, ', '), '') "
                  "FROM pg_roles r CROSS JOIN pg_class c CROSS JOIN unnest(ARRAY['TRIGGER','REFERENCES']) p "
                  "WHERE (c.oid IN ('public.sources'::regclass,'public.thoughts'::regclass) "
                  "OR c.relnamespace = 'intake'::regnamespace) AND c.relkind IN ('r','p') "
                  "AND NOT r.rolsuper AND has_table_privilege(r.oid, c.oid, p)")
    (ok if leak == "" else lambda n: bad(n, leak))(
        "E5 catalogue: no non-superuser holds TRIGGER/REFERENCES on sources, thoughts or intake.* "
        "(REFERENCES is checked here only: a non-owner has no schema to create a referencing table in, "
        "and a temp table cannot reference a permanent one)")
    led = db.val("SELECT coalesce(string_agg((detail->>'grantee') || ' ' || (detail->>'privilege') || ' ' || "
                 "(detail->>'table'), ', ' ORDER BY 1), '') FROM intake.migration_ledger")
    (ok if "service_role TRIGGER" in led else lambda n: bad(n, led))(
        f"E6 the revoked live grants are recorded for the revert: {led}")


def _wait(db, sql, want, seconds=30):
    import time
    for _ in range(seconds * 4):
        if db.val(sql) == want:
            return True
        time.sleep(0.25)
    return False


def section_guard(db):
    """D31: foreign code attached BEFORE the apply must make the apply refuse."""
    trig_q = "SELECT count(*) FROM pg_trigger WHERE tgname = 'zzzz_preattached'"
    # Start from the pre-migration state, where the live grants still give service_role TRIGGER.
    rc, _, err = db.run("", file=REVERT)
    if rc != 0:
        bad("G0 revert to the pre-migration state", err)
        return
    has = db.val("SELECT has_table_privilege('ob_app_memory', 'public.sources', 'TRIGGER')")
    (ok if has == "t" else lambda n: bad(n, has))(
        "G0 pre-migration: ob_app_memory (via service_role) holds TRIGGER on sources (the live grant)")
    # G1: a model-facing session attaches a pg_temp trigger and STAYS OPEN across the apply.
    sess = subprocess.Popen(["docker", "exec", "-i", db.c, "psql", "-U", "ob_app_memory", "-d", "openbrain",
                             "-X", "-q", "-v", "ON_ERROR_STOP=1"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        sess.stdin.write("CREATE FUNCTION pg_temp.launder() RETURNS trigger LANGUAGE plpgsql AS "
                         "$f$ BEGIN NEW.screen_verdict := 'clean'; RETURN NEW; END $f$;\n"
                         "CREATE TRIGGER zzzz_preattached BEFORE INSERT OR UPDATE ON public.sources "
                         "FOR EACH ROW EXECUTE FUNCTION pg_temp.launder();\n")
        sess.stdin.flush()
        if not _wait(db, trig_q, "1"):
            bad("G1 an open ob_app_memory session attached a pg_temp trigger before the apply")
            return
        ok("G1 an open ob_app_memory session attached a pg_temp trigger before the apply")
        rc, _, err = db.run("", file=INIT)
        if rc == 0:
            bad("G2 the apply REFUSES while that foreign trigger is attached")
        elif "foreign code is attached" in err:
            ok("G2 the apply REFUSES while that foreign trigger is attached  "
               + (re.search(r"foreign code is attached[^.]*", err) or [""])[0][:150])
        else:
            bad("G2 the apply REFUSES while that foreign trigger is attached", err)
        still = db.val("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' "
                       "AND table_name='sources' AND column_name='screen_verdict'")
        (ok if still == "0" else lambda n: bad(n, still))("G3 the refused apply left nothing behind (atomic)")
    finally:
        try:
            sess.stdin.close()
            sess.wait(timeout=30)
        except Exception:
            sess.kill()
    gone = _wait(db, trig_q, "0")
    (ok if gone else bad)("G4 the trigger dies with its session (pg_temp function dropped)")
    rc, _, err = db.run("", file=INIT)
    (ok if rc == 0 else lambda n: bad(n, err))("G5 with the session gone the apply succeeds")
    # G6/G7: on an applied database a re-apply refuses foreign code that a session could not
    # have attached itself but that would still act: a trigger function owned by a non-superuser,
    # and a superuser-owned one that names the label.
    for name, setup, cleanup in (
        ("a trigger function owned by a non-superuser (ob_pantry)",
         "CREATE FUNCTION public.zz_g6() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$; "
         "ALTER FUNCTION public.zz_g6() OWNER TO ob_pantry; "
         "CREATE TRIGGER zzzz_g6 BEFORE UPDATE ON public.thoughts FOR EACH ROW EXECUTE FUNCTION public.zz_g6();",
         "DROP TRIGGER zzzz_g6 ON public.thoughts; DROP FUNCTION public.zz_g6();"),
        ("a superuser-owned trigger function that writes screen_verdict",
         "CREATE FUNCTION public.zz_g7() RETURNS trigger LANGUAGE plpgsql AS "
         "$f$ BEGIN NEW.screen_verdict := 'clean'; RETURN NEW; END $f$; "
         "CREATE TRIGGER zzzz_g7 BEFORE UPDATE ON public.sources FOR EACH ROW EXECUTE FUNCTION public.zz_g7();",
         "DROP TRIGGER zzzz_g7 ON public.sources; DROP FUNCTION public.zz_g7();")):
        rc, _, err = db.run(setup)
        if rc != 0:
            bad(f"G6 setup: {name}", err)
            continue
        rc, _, err = db.run("", file=INIT)
        (ok if rc != 0 and "foreign code is attached" in err else lambda n: bad(n, err or "apply succeeded"))(
            f"G6 a re-apply REFUSES with {name} attached")
        db.run(cleanup)
    rc, _, err = db.run("", file=INIT)
    (ok if rc == 0 else lambda n: bad(n, err))("G7 clean re-apply after the foreign triggers are removed")
    # G8: the ledger grantee is DATA - a role name needing quotes round-trips through apply + revert.
    odd = 'odd "role"; x'
    q = odd.replace('"', '""')
    rc, _, err = db.run("", file=REVERT)
    rc2, _, err2 = db.run(f'CREATE ROLE "{q}" NOLOGIN; GRANT TRIGGER ON public.sources TO "{q}";')
    rc3, _, err3 = db.run("", file=INIT)
    lit = odd.replace("'", "''")
    held = db.val(f"SELECT has_table_privilege((SELECT oid FROM pg_roles WHERE rolname = '{lit}'), "
                  "'public.sources', 'TRIGGER')")
    rc4, _, err4 = db.run("", file=REVERT)
    back = db.val(f"SELECT has_table_privilege((SELECT oid FROM pg_roles WHERE rolname = '{lit}'), "
                  "'public.sources', 'TRIGGER')")
    (ok if (rc, rc2, rc3, rc4, held, back) == (0, 0, 0, 0, "f", "t")
     else lambda n: bad(n, f"rc={rc,rc2,rc3,rc4} held={held} back={back} {err}{err2}{err3}{err4}"))(
        "G8 a role whose name needs quoting loses TRIGGER on apply and gets it back on revert (%I)")
    db.run(f'REVOKE ALL ON public.sources FROM "{q}"; DROP ROLE "{q}";')
    rc, _, err = db.run("", file=INIT)
    (ok if rc == 0 else lambda n: bad(n, err))("G9 final apply")


def section_check(db):
    # By id: intake has no SELECT on metadata (column grants), so a metadata WHERE is refused 42501.
    sid = db.val("SELECT id FROM public.sources WHERE metadata->>'fixture' = 'ext-gmail'")
    tid = db.val("SELECT id FROM public.thoughts WHERE metadata->>'fixture' = 'th-chatgpt'")
    for t, where in (("sources", f"id='{sid}'"), ("thoughts", f"id={tid}")):
        for v in ("injected", "bogus", "CLEAN", "", "clean "):
            expect_err(db, f"D1 CHECK refuses {t}.screen_verdict={v!r} (even as intake)",
                       f"UPDATE public.{t} SET screen_verdict='{v}' WHERE {where};", {"23514"}, login="intake")
        expect_err(db, f"D2 NOT NULL refuses {t}.screen_verdict=NULL",
                   f"UPDATE public.{t} SET screen_verdict=NULL WHERE {where};", {"23502"}, login="intake")
    expect_err(db, "D3 'injected' cannot be INSERTed into sources even by intake (no INSERT grant; CHECK as owner)",
               "INSERT INTO public.sources (url, title, content, screen_verdict) VALUES ('u','t','c','injected');",
               {"23514"})
    expect_err(db, "D4 'injected' cannot be INSERTed into thoughts",
               "INSERT INTO public.thoughts (content, exposure, metadata, screen_verdict) "
               "VALUES ('c','ops','{\"exposure\":\"ops\"}','injected');", {"23514"})
    for t in ("sources", "thoughts"):
        v = db.val(f"SELECT convalidated FROM pg_constraint WHERE conname = '{t}_screen_verdict_check'")
        (ok if v == "t" else lambda n: bad(n, f"convalidated={v!r}"))(f"D5 {t}_screen_verdict_check exists and is VALIDATED")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--container")
    ap.add_argument("--start", action="store_true")
    ap.add_argument("--image", default="pgvector/pgvector:pg16")
    ap.add_argument("--label", default="intake-i1")
    ap.add_argument("--roles")
    ap.add_argument("--schema")
    ap.add_argument("--keep", action="store_true", help="do not remove a container this runner started")
    a = ap.parse_args()
    if not (a.container or a.start):
        ap.error("--container NAME or --start")
    name = start(a.image, a.label) if a.start else a.container
    guard(name, a.label)
    db = DB(name)
    try:
        if a.roles and a.schema:
            load(db, a.roles, a.schema)
        if not INIT.exists() or not REVERT.exists():
            bad("A0 migration and revert files exist", f"{INIT} / {REVERT}")
            return 1
        rc, _, err = db.run("", file=FIXTURES)
        if rc != 0:
            bad("A0 synthetic fixtures load (pre-migration)", err)
            return 1
        before = fixture_image(db)
        r = section_apply_revert(db)
        if r is None:
            return 1
        s0, s1 = r
        section_backfill(db, before)
        section_check(db)
        section_roles(db)
        section_attacks(db)
        # F2: a row a model-facing writer adds AFTER the first apply, with forged synthesis markers.
        rc, _, err = db.run("INSERT INTO public.thoughts (content, exposure, metadata) VALUES ('forged', 'ops', "
                            "'{\"forged\":\"after-apply\",\"source\":\"user_note\",\"note_path\":\"notes/forged.md\","
                            "\"exposure\":\"ops\"}');", login="ob_app_memory")
        (ok if rc == 0 else lambda n: bad(n, err))("F2a a writer adds a row with forged internal markers after the apply")
        # The role tests left intake data behind (bronze, silver, clean/suspicious labels).
        # Revert must REFUSE to drop that silently...
        rc, _, err = db.run("", file=REVERT)
        if rc == 0:
            bad("A9 revert REFUSES while intake holds data (no silent bronze/label loss)")
        else:
            ok("A9 revert REFUSES while intake holds data (no silent bronze/label loss)  "
               + (re.search(r"ERROR:.*", err) or [""])[0][:160])
        # ...and proceed only when told to, explicitly (psql -v intake_revert_drop_data=1).
        rc, _, err = db.run("\\set intake_revert_drop_data 1\n" + REVERT.read_text(encoding="utf-8"))
        if rc != 0:
            bad("A4 revert applies (with -v intake_revert_drop_data=1)", err)
        else:
            ok("A4 revert applies (with -v intake_revert_drop_data=1)")
            s3 = db.snapshot()
            (ok if s3 == s0 else lambda n: bad(n, _first_diff(s0, s3)))(
                "A5 revert restores the pre-migration catalogue exactly (schema dump + roles)")
            rc, _, err = db.run("", file=REVERT)
            (ok if rc == 0 else lambda n: bad(n, err))("A6 revert re-applies (idempotent, no-op)")
            rc, _, err = db.run("", file=INIT)
            if rc != 0:
                bad("A7 migration applies again after revert", err)
            else:
                ok("A7 migration applies again after revert")
                lab = db.val("SELECT string_agg(v, ',' ORDER BY v) FROM (SELECT coalesce(metadata->>'fixture', "
                             "metadata->>'forged') || '=' || screen_verdict AS v FROM public.thoughts "
                             "WHERE metadata->>'forged' = 'after-apply' OR metadata->>'fixture' = 'th-user-note') q")
                (ok if lab == "after-apply=unscreened,th-user-note=unscreened" else lambda n: bad(n, lab))(
                    "F2b revert + re-apply does NOT re-run the marker backfill: the forged row (and every "
                    "row) stays unscreened")
                rec = db.val("SELECT count(*) FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase "
                             "AND d.datname = current_database() CROSS JOIN unnest(s.setconfig) c "
                             "WHERE c LIKE 'intake.backfill_done_at=%'")
                (ok if rec == "1" else lambda n: bad(n, rec))(
                    "F2c the one-shot record (database setting intake.backfill_done_at) survives the revert")
                s4 = db.snapshot()
                (ok if s4 == s1 else lambda n: bad(n, _first_diff(s1, s4)))(
                    "A8 apply after revert yields the same catalogue as the first apply")
                rc, _, err = db.run("", file=REVERT)
                (ok if rc == 0 else lambda n: bad(n, err))(
                    "A10 revert of an apply with no intake data needs no flag (backfilled labels are re-derivable)")
                rc, _, err = db.run("\\set intake_rerun_backfill 1\n" + INIT.read_text(encoding="utf-8"))
                (ok if rc == 0 else lambda n: bad(n, err))("A11 re-apply with -v intake_rerun_backfill=1")
                lab = db.val("SELECT screen_verdict FROM public.thoughts WHERE metadata->>'fixture' = 'th-user-note'")
                (ok if lab == "internal" else lambda n: bad(n, lab))(
                    "F2d the marker rule re-runs only when asked for explicitly")
                section_guard(db)
    finally:
        if a.start and not a.keep:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
    print(f"\n{'FAILED' if FAILS else 'ALL PASS'}: {len(FAILS)} failure(s)")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
