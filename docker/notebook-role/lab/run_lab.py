#!/usr/bin/env python3
"""run_lab.py - the disposable lab for intake-notebook-role (ob_notebook, open_notebook's DB role).

    python run_lab.py --subnet 10.x.y.0/24 --schema live-schema-only.sql --roles live-roles.sql \
        --fork <open-notebook checkout with the patched ob1_repository.py> --evidence <empty dir> [--red]

NEVER the live stack. One pgvector database (the digest openbrain-db runs) and throwaway flow
containers on ONE `--internal` bridge network this script creates (exactly a /24, outside
192.168.0.0/16 and Docker's 172.16.0.0/12 pools), no published port, no ai-stack_* network, label
ai-stack.harness.owner=wt-intake-notebook-role. The database is a schema-only restore of the live
one (pg_dump --schema-only + pg_dumpall --roles-only --no-role-passwords: DDL, no rows) plus
synthetic fixtures (fixtures.sql). The flows run through the fork's REAL ob1_repository module in
an image built FROM the deployed open_notebook:iks (Dockerfile.lab). Everything it creates
(containers, the network, the two :wt- image tags, the staging dirs) is removed at the end and
the removal is checked.

GREEN (default) proves, each line PASS/FAIL, exit 1 on any FAIL:
  A  apply init-notebook-role.sql twice (catalogue identical), password set from a secret FILE by
     scram_verifier.py (the server receives a verifier only)
  B  every reachable flow passes as ob_notebook (current_user ob_notebook, not a superuser), with
     OB1_DB_PASSWORD_FILE and a decoy POSTGRES_PASSWORD in the environment
  C  the same flows as a role WITHOUT the grants: every one fails
  D  no superuser fallback: a missing password file with OB1_DB_USER=ob_notebook or =postgres
     (and the superuser's POSTGRES_PASSWORD present) connects as nobody
  E  negative tests: no DDL, no RLS bypass, no other role, no table outside the inventory, no
     sequence, no SECURITY DEFINER function that is not a trigger; catalogue sweeps
  F  revert twice (catalogue identical to before the apply), apply again (identical to the apply)
  G  grants == inventory, measured: with PUBLIC's EXECUTE revoked from the OB1 functions (lab
     only) the flows still pass; revoking any ONE inventory entry (each column of a column grant,
     each policy) makes a flow fail; the tables the flows touch (pg_stat) equal the inventory's
     tables plus the two owner-side ones
  H  with intake's init-intake.sql applied on top: the flows still pass; intake.* (bronze,
     silver, discards, the ledger) is unreadable; init-notebook-role.sql re-applies cleanly
  I  the password is in no log (database with log_statement=all, flow containers), and the secret
     check (check_notebook_secret.py) passes against the lab containers
--red: the base (bc6d3a6) shape - no init-notebook-role.sql, the deployed image's unpatched
  ob1_repository.py: the flows fail as a bare ob_notebook role, and the old code falls back to the
  superuser password. Every GREEN clause must FAIL there.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROLE_DIR = HERE.parent
DOCKER_DIR = ROLE_DIR.parent
OB1 = DOCKER_DIR.parent
INIT = DOCKER_DIR / "init-notebook-role.sql"
REVERT = DOCKER_DIR / "revert-notebook-role.sql"
INTAKE = OB1 / "integrations" / "intake" / "sql" / "init-intake.sql"
INVENTORY = json.loads((ROLE_DIR / "inventory.json").read_text(encoding="utf-8"))
ID = "wt-intake-notebook-role"
LABEL = f"ai-stack.harness.owner={ID}"
PG_IMAGE = "pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b"
RUN_ID = secrets.token_hex(3)               # one lab run: tags and a label of its own, so two runs never collide
RUN_LABEL = f"ai-stack.harness.run={RUN_ID}"
IMG_PATCHED = f"ob-notebook-lab:{ID}-{RUN_ID}"
IMG_BASE = f"ob-notebook-lab-base:{ID}-{RUN_ID}"
OWNER_SIDE_TABLES = {"public.content_types", "public.source_extraction_queue"}

RESULTS: list[tuple[str, bool, str]] = []
LOG: list[str] = []


def say(t: str = "") -> None:
    print(t, flush=True)
    LOG.append(t)


def check(name: str, cond: bool, detail: str = "") -> bool:
    RESULTS.append((name, bool(cond), detail))
    say(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"\n      {detail}" if detail and not cond else ""))
    return bool(cond)


def run(cmd: list[str], stdin: str | None = None, timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, input=stdin, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=timeout)


def subnet_ok(s: str) -> str:
    try:
        n = ipaddress.ip_network(s, strict=True)
    except ValueError as exc:
        return f"--subnet {s!r}: {exc}"
    if n.version != 4 or n.prefixlen != 24:
        return f"--subnet {s} must be an IPv4 /24"
    for bad in ("172.16.0.0/12", "192.168.0.0/16", "0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "224.0.0.0/3"):
        if n.overlaps(ipaddress.ip_network(bad)):
            return f"--subnet {s} overlaps {bad}"
    return ""


class Lab:
    def __init__(self, a):
        self.a = a
        self.rand = RUN_ID
        self.net = f"nbr-{self.rand}-net"
        self.db = f"nbr-{self.rand}-db"
        self.su_pw = secrets.token_hex(16)        # the lab superuser's (the "decoy" POSTGRES_PASSWORD)
        self.nogrants_pw = secrets.token_hex(16)
        self.tmp = Path(tempfile.mkdtemp(prefix=f"nbr-{self.rand}-"))
        self.secret_dir = self.tmp / "notebook-secrets"
        self.secret_dir.mkdir()
        self.secret = self.secret_dir / "ob_notebook_db_password"
        self.flow_outputs: list[str] = []
        self.images: list[str] = []

    # ---------------------------------------------------------------- docker / psql
    def psql(self, sql: str, user: str = "postgres", password: str | None = None,
             stop: bool = True, extra: list[str] | None = None):
        cmd = ["docker", "exec", "-i"]
        if user == "postgres":
            cmd += [self.db, "psql", "-U", "postgres", "-d", "openbrain"]
        else:
            cmd += ["-e", f"PGPASSWORD={password}", self.db, "psql", "-h", self.db, "-U", user, "-d", "openbrain"]
            # -h <its own network name>, NOT 127.0.0.1: the image's pg_hba TRUSTS loopback; this
            # address hits `host all all all scram-sha-256`, as open_notebook's connections do
        cmd += ["-X", "-q", "-At", "-v", "VERBOSITY=verbose"] + (["-v", "ON_ERROR_STOP=1"] if stop else []) + (extra or [])
        p = run(cmd, stdin="\\set VERBOSITY verbose\n" + sql)
        return p.returncode, p.stdout, p.stderr

    def psql_file(self, path: Path, extra: list[str] | None = None):
        name = f"/tmp/{path.name}"
        run(["docker", "cp", str(path), f"{self.db}:{name}"])
        p = run(["docker", "exec", self.db, "psql", "-U", "postgres", "-d", "openbrain", "-X", "-q",
                 "-v", "ON_ERROR_STOP=1", "-f", name] + (extra or []))
        return p.returncode, p.stdout, p.stderr

    def val(self, sql: str) -> str:
        rc, out, err = self.psql(sql)
        if rc != 0:
            raise RuntimeError(f"lab query failed: {err.strip()[:300]}")
        return out.strip()

    def as_role(self, sql: str, user: str = "ob_notebook"):
        pw = self.read_secret() if user == "ob_notebook" else self.nogrants_pw
        return self.psql(sql, user=user, password=pw, stop=True)

    def read_secret(self) -> str:
        return self.secret.read_text(encoding="utf-8").rstrip("\n")

    def flows(self, image: str, user: str, password_file: str | None = "/run/secrets/ob_notebook_db_password",
              mount: Path | None = None, only: list[str] | None = None) -> dict:
        cmd = ["docker", "run", "--rm", "--label", LABEL, "--label", RUN_LABEL, "--network", self.net,
               "-e", f"OB1_DB_HOST={self.db}", "-e", "OB1_DB_PORT=5432", "-e", "OB1_DB_NAME=openbrain",
               "-e", f"OB1_DB_USER={user}", "-e", f"POSTGRES_PASSWORD={self.su_pw}"]
        if password_file:
            cmd += ["-e", f"OB1_DB_PASSWORD_FILE={password_file}"]
        if mount is not None:
            cmd += ["-v", f"{mount}:/run/secrets/ob_notebook_db_password:ro"]
        cmd += [image, "/lab/flows.py"] + (only or [])
        p = run(cmd, timeout=300)
        self.flow_outputs.append(p.stdout + p.stderr)
        m = re.search(r"^FLOWS-JSON (.*)$", p.stdout, re.M)
        if not m:
            return {"identity": {"error": "no output"}, "flows": [], "raw": (p.stdout + p.stderr)[-2000:]}
        return json.loads(m.group(1))

    # ---------------------------------------------------------------- setup / teardown
    def build_images(self) -> None:
        for img, patched in ((IMG_PATCHED, True), (IMG_BASE, False)):
            ctx = self.tmp / f"ctx-{'p' if patched else 'b'}"
            (ctx / "stage").mkdir(parents=True)
            shutil.copy(HERE / "Dockerfile.lab", ctx / "Dockerfile")
            shutil.copy(HERE / "flows.py", ctx / "stage" / "flows.py")
            if patched:
                shutil.copy(Path(self.a.fork) / "open_notebook" / "database" / "ob1_repository.py", ctx / "stage")
                shutil.copy(Path(self.a.fork) / "tests" / "test_ob1_password_file.py", ctx / "stage")
            p = run(["docker", "build", "-q", "--label", LABEL, "--label", RUN_LABEL, "-t", img, str(ctx)], timeout=900)
            if p.returncode != 0:
                raise RuntimeError(f"build {img}: {p.stderr[-1500:]}")
            self.images.append(img)

    def start(self) -> None:
        p = run(["docker", "network", "create", "--driver", "bridge", "--internal", "--subnet", self.a.subnet,
                 "--label", LABEL, "--label", RUN_LABEL, self.net])
        if p.returncode != 0:
            raise RuntimeError(f"network create: {p.stderr.strip()}")
        p = run(["docker", "run", "-d", "--name", self.db, "--label", LABEL, "--label", RUN_LABEL, "--network", self.net,
                 "-e", f"POSTGRES_PASSWORD={self.su_pw}", "-e", "POSTGRES_DB=openbrain", PG_IMAGE,
                 "-c", "track_functions=all", "-c", "log_statement=all", "-c", "log_min_error_statement=error"])
        if p.returncode != 0:
            raise RuntimeError(f"db run: {p.stderr.strip()}")
        for _ in range(90):
            lg = run(["docker", "logs", self.db])
            logs = lg.stdout + lg.stderr
            if "PostgreSQL init process complete" in logs and \
               run(["docker", "exec", self.db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).returncode == 0:
                break
            time.sleep(2)
        else:
            raise RuntimeError("lab database did not come up")
        roles = Path(self.a.roles).read_text(encoding="utf-8")
        roles = "\n".join(line for line in roles.splitlines()
                          if not re.match(r"^(CREATE|ALTER) ROLE postgres\b", line))
        rc, _, err = self.psql(roles)
        if rc != 0:
            raise RuntimeError(f"roles restore: {err[-800:]}")
        rc, _, err = self.psql_file(Path(self.a.schema))
        if rc != 0:
            raise RuntimeError(f"schema restore: {err[-800:]}")

    def stop(self) -> None:
        run(["docker", "rm", "-f", "-v", self.db])
        for cid in run(["docker", "ps", "-aq", "--filter", f"label={RUN_LABEL}"]).stdout.split():
            run(["docker", "rm", "-f", "-v", cid])
        run(["docker", "network", "rm", self.net])
        for img in self.images:
            run(["docker", "image", "rm", "-f", img])
        for iid in run(["docker", "image", "ls", "-aq", "--filter", f"label={RUN_LABEL}"]).stdout.split():
            run(["docker", "image", "rm", "-f", iid])
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---------------------------------------------------------------- the catalogue
    SNAPSHOT = r"""
    SELECT string_agg(l, E'\n' ORDER BY l) FROM (
      SELECT 'role ' || rolname || ' ' || concat_ws(',', rolsuper, rolinherit, rolcreaterole, rolcreatedb,
             rolcanlogin, rolreplication, rolbypassrls) AS l FROM pg_roles WHERE rolname !~ '^pg_'
      UNION ALL SELECT 'member ' || g.rolname || ' > ' || m.rolname FROM pg_auth_members a
             JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
      UNION ALL SELECT 'rel ' || c.oid::regclass::text || ' ' || coalesce(nullif(a.grantee, 0)::regrole::text, 'PUBLIC')
             || ' ' || a.privilege_type || ' ' || a.is_grantable
        FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
       WHERE c.relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace, 'pg_toast'::regnamespace)
      UNION ALL SELECT 'col ' || at.attrelid::regclass::text || '.' || at.attname || ' '
             || coalesce(nullif(a.grantee, 0)::regrole::text, 'PUBLIC') || ' ' || a.privilege_type
        FROM pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a WHERE at.attacl IS NOT NULL
      UNION ALL SELECT 'fn ' || p.oid::regprocedure::text || ' ' || coalesce(nullif(a.grantee, 0)::regrole::text, 'PUBLIC')
             || ' ' || a.privilege_type
        FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
      UNION ALL SELECT 'nsp ' || n.nspname || ' ' || coalesce(nullif(a.grantee, 0)::regrole::text, 'PUBLIC') || ' ' || a.privilege_type
        FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
       WHERE n.nspname !~ '^pg_(toast_)?temp_'
      UNION ALL SELECT 'db ' || d.datname || ' ' || coalesce(nullif(a.grantee, 0)::regrole::text, 'PUBLIC') || ' ' || a.privilege_type
        FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
      UNION ALL SELECT 'policy ' || schemaname || '.' || tablename || ' ' || policyname || ' ' || permissive || ' '
             || cmd || ' ' || roles::text || ' ' || coalesce(qual, '-') || ' ' || coalesce(with_check, '-') FROM pg_policies
      UNION ALL SELECT 'rls ' || oid::regclass::text || ' ' || relrowsecurity || ' ' || relforcerowsecurity
        FROM pg_class WHERE relkind IN ('r', 'p') AND relnamespace = 'public'::regnamespace
    ) s"""

    def snapshot(self) -> str:
        return self.val(self.SNAPSHOT)


# ==================================================================================== the clauses
def _norm(kind: str, name: str) -> str:
    return kind + ":" + re.sub(r"\s+", "", name).replace("public.", "")


def expected_grants() -> set[tuple[str, str, str]]:
    """(privilege, kind:name, column-or-'') for every inventory grant, names without 'public.'."""
    out = set()
    for g in INVENTORY["grants"]:
        kind, name = g["object"].split(":", 1)
        for c in (g.get("columns") or [""]):
            out.add((g["privilege"], _norm(kind, name), c))
    return out


def measured_grants(lab: Lab) -> set[tuple[str, str, str]]:
    """The same, read from the catalogue: every ACL entry naming ob_notebook, in every schema."""
    rows = lab.val(r"""
      SELECT string_agg(l, E'\n') FROM (
        SELECT a.privilege_type || '|' || CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'table' END || '|'
               || c.oid::regclass::text || '|' AS l
          FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE a.grantee = 'ob_notebook'::regrole
        UNION ALL SELECT a.privilege_type || '|table|' || at.attrelid::regclass::text || '|' || at.attname
          FROM pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a WHERE a.grantee = 'ob_notebook'::regrole
        UNION ALL SELECT a.privilege_type || '|function|' || p.oid::regprocedure::text || '|'
          FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE a.grantee = 'ob_notebook'::regrole
        UNION ALL SELECT a.privilege_type || '|schema|' || n.nspname || '|'
          FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE a.grantee = 'ob_notebook'::regrole
        UNION ALL SELECT a.privilege_type || '|database|' || d.datname || '|'
          FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a WHERE a.grantee = 'ob_notebook'::regrole
      ) s""")
    out = set()
    for line in filter(None, (rows or "").splitlines()):
        priv, kind, name, col = line.split("|")
        out.add((priv, _norm(kind, name), col))
    return out


def flows_ok(res: dict) -> tuple[bool, list[dict]]:
    bad = [f for f in res.get("flows", []) if not f["ok"]]
    return (bool(res.get("flows")) and not bad), bad


def red(lab: Lab) -> None:
    """The base (bc6d3a6) shape: no migration, the unpatched module."""
    lab.secret.write_text(secrets.token_hex(32) + "\n", encoding="utf-8")
    # A role named ob_notebook WITHOUT the migration's grants (bc6d3a6 has no such role at all).
    lab.psql("CREATE ROLE ob_notebook LOGIN;")
    rc, _, err = lab.psql(run([sys.executable, str(ROLE_DIR / "scram_verifier.py"), str(lab.secret)]).stdout)
    check("R0 a bare ob_notebook role exists with the file's password", rc == 0, err[-300:])
    lab.psql_file(HERE / "fixtures.sql")
    res = lab.flows(IMG_PATCHED, "ob_notebook", mount=lab.secret)
    ok, bad = flows_ok(res)
    check("B (RED expects FAIL) every reachable flow passes as ob_notebook", ok,
          f"{len(bad)}/{len(res.get('flows', []))} flows fail; first: {bad[0]['error'] if bad else res.get('raw', '')[:300]}")
    res = lab.flows(IMG_BASE, "postgres", password_file="/run/secrets/missing")
    ident = res.get("identity", {})
    check("D (RED expects FAIL) no superuser fallback with OB1_DB_USER=postgres and no usable password file",
          "error" in ident, f"the deployed module connected as {ident} (fell back to POSTGRES_PASSWORD)")


def green(lab: Lab) -> None:
    # ---------------------------------------------------------------- A: apply, twice; password
    lab.psql(f"CREATE ROLE ob_nogrants LOGIN PASSWORD '{lab.nogrants_pw}';")
    s0 = lab.snapshot()
    rc, out, err = lab.psql_file(INIT)
    check("A1 init-notebook-role.sql applies", rc == 0, err[-600:])
    s1 = lab.snapshot()
    rc, out, err = lab.psql_file(INIT)
    check("A2 a second apply succeeds and leaves the catalogue identical", rc == 0 and lab.snapshot() == s1,
          err[-400:] or diff(s1, lab.snapshot()))
    attrs = lab.val("SELECT concat_ws(',', rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, "
                    "rolreplication, rolinherit) FROM pg_roles WHERE rolname = 'ob_notebook'")
    check("A3 ob_notebook is LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT",
          attrs == "t,f,f,f,f,f,f", attrs)
    check("A4 the role has no password after the apply (cannot log in yet)",
          lab.val("SELECT rolpassword IS NULL FROM pg_authid WHERE rolname = 'ob_notebook'") == "t")
    gen = run([sys.executable, str(ROLE_DIR / "scram_verifier.py"), "--generate", str(lab.secret)])
    stmt = gen.stdout
    pw = lab.read_secret()
    check("A5 scram_verifier.py --generate wrote the file and printed a verifier, never the password",
          gen.returncode == 0 and stmt.startswith("ALTER ROLE ob_notebook PASSWORD 'SCRAM-SHA-256$4096:")
          and pw not in stmt and pw not in gen.stderr and len(pw) == 64, gen.stderr[-300:])
    rc, _, err = lab.psql(stmt)
    stored = lab.val("SELECT rolpassword FROM pg_authid WHERE rolname = 'ob_notebook'")
    check("A6 the server stores the verifier as sent (the plaintext never reached it)",
          rc == 0 and stored.startswith("SCRAM-SHA-256$4096:") and stored in stmt, err[-300:])
    rc, out, err = lab.as_role("SELECT current_user;")
    check("A7 ob_notebook logs in over TCP (scram) with the file's password", rc == 0 and out.strip() == "ob_notebook", err[-300:])
    rc, out, err = lab.psql("SELECT 1;", user="ob_notebook", password="wrong-" + secrets.token_hex(4), stop=True)
    check("A8 a wrong password is refused", rc != 0 and "password authentication failed" in err, err[-200:])
    rc, _, err = lab.psql_file(HERE / "fixtures.sql")
    if rc != 0:
        raise RuntimeError(f"fixtures: {err[-600:]}")

    # ---------------------------------------------------------------- B: flows as ob_notebook
    res = lab.flows(IMG_PATCHED, "ob_notebook", mount=lab.secret)
    ok, bad = flows_ok(res)
    ident = res.get("identity", {})
    check(f"B1 all {len(res.get('flows', []))} reachable flows pass as ob_notebook (POSTGRES_PASSWORD decoy present)",
          ok and len(res["flows"]) == 17, json.dumps(bad)[:800])
    check("B2 the pool is ob_notebook, session and current, not a superuser, no BYPASSRLS",
          ident.get("cu") == "ob_notebook" and ident.get("su") == "ob_notebook"
          and ident.get("super") is False and ident.get("bypassrls") is False, json.dumps(ident))
    p = run(["docker", "run", "--rm", "--network", "none", "--label", LABEL, "--label", RUN_LABEL, IMG_PATCHED, "-m", "pytest", "-q",
             "-p", "no:cacheprovider", "--noconftest", "tests/test_ob1_password_file.py"], timeout=300)
    lab.flow_outputs.append(p.stdout + p.stderr)
    check("B3 the fork's unit test (OB1_DB_PASSWORD_FILE, no fallback, value never logged) passes in the image",
          p.returncode == 0, (p.stdout + p.stderr)[-800:])
    say("      " + (p.stdout.strip().splitlines() or ["?"])[-1])

    # ---------------------------------------------------------------- C: a role without the grants
    nog = lab.tmp / "nogrants_pw"
    nog.write_text(lab.nogrants_pw + "\n", encoding="utf-8")
    res = lab.flows(IMG_PATCHED, "ob_nogrants", mount=nog)
    fl = res.get("flows", [])
    check(f"C1 RED: as a role without the grants every one of the {len(fl)} flows fails",
          len(fl) == 17 and all(not f["ok"] for f in fl),
          json.dumps([f["name"] for f in fl if f["ok"]]))
    codes = sorted({f["sqlstate"] or "assert" for f in fl})
    say(f"      failure kinds: {codes}")

    # ---------------------------------------------------------------- D: no superuser fallback
    for user in ("ob_notebook", "postgres"):
        res = lab.flows(IMG_PATCHED, user, password_file="/run/secrets/missing")
        ident = res.get("identity", {})
        check(f"D no fallback: OB1_DB_USER={user}, password file missing, POSTGRES_PASSWORD=superuser's -> no connection",
              "error" in ident and not any(f["ok"] for f in res.get("flows", []) if f["name"] != "test_connection"),
              json.dumps(ident)[:300])
    res = lab.flows(IMG_BASE, "postgres", password_file="/run/secrets/missing")
    say(f"      (contrast, the DEPLOYED module in the same setup: identity {json.dumps(res.get('identity'))[:200]})")

    # ---------------------------------------------------------------- E: negative tests
    negatives(lab, s_label="E")

    # ---------------------------------------------------------------- F: revert / re-apply
    rc, _, err = lab.psql_file(REVERT)
    s_rev = lab.snapshot()
    check("F1 revert-notebook-role.sql applies; the catalogue equals the one before the apply", rc == 0 and s_rev == s0,
          err[-400:] or diff(s0, s_rev))
    rc, _, err = lab.psql_file(REVERT)
    check("F2 a second revert succeeds and changes nothing", rc == 0 and lab.snapshot() == s0, err[-400:])
    rc, _, err = lab.psql_file(INIT)
    check("F3 apply after the revert: the catalogue equals the first apply's", rc == 0 and lab.snapshot() == s1,
          err[-400:] or diff(s1, lab.snapshot()))
    lab.psql(run([sys.executable, str(ROLE_DIR / "scram_verifier.py"), str(lab.secret)]).stdout)

    # ---------------------------------------------------------------- G: grants == inventory
    meas, exp = measured_grants(lab), expected_grants()
    check("G1 the catalogue's explicit ob_notebook grants equal inventory.json",
          meas == exp, f"extra={sorted(meas - exp)} missing={sorted(exp - meas)}")
    pol = set(filter(None, lab.val("SELECT string_agg(schemaname || '.' || tablename || ' ' || policyname || ' ' || cmd, E'\\n') "
                                   "FROM pg_policies WHERE 'ob_notebook' = ANY(roles)").splitlines()))
    pexp = {f"{p['table']} {p['name']} {p['command']}" for p in INVENTORY["policies"]}
    check("G2 the policies naming ob_notebook equal inventory.json", pol == pexp, f"got={sorted(pol)} want={sorted(pexp)}")
    revoked = lab.val("""SELECT string_agg(p.oid::regprocedure::text, ';') FROM pg_proc p
                          WHERE p.pronamespace = 'public'::regnamespace
                            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
                                            AND d.objid = p.oid AND d.deptype = 'e')
                            AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')""").split(";")
    # only the functions PUBLIC can execute today (some, e.g. the idea_* SECURITY DEFINER ones, are already revoked)
    lab.val("DO $$ DECLARE f text; BEGIN FOREACH f IN ARRAY string_to_array(" + q(";".join(revoked)) + ", ';') LOOP "
            "EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f); END LOOP; END $$; SELECT 1")
    lab.val("SELECT pg_stat_reset()")
    res = lab.flows(IMG_PATCHED, "ob_notebook", mount=lab.secret)
    ok, bad = flows_ok(res)
    check(f"G3 sufficiency: with PUBLIC's EXECUTE revoked from all {len(revoked)} OB1 functions PUBLIC could run (lab only), every flow "
          "still passes on the inventory's grants alone", ok, json.dumps(bad)[:600])
    time.sleep(1)
    touched = set(filter(None, lab.val(
        "SELECT string_agg(schemaname || '.' || relname, E'\\n') FROM pg_stat_user_tables "
        "WHERE coalesce(seq_scan,0) + coalesce(idx_scan,0) + n_tup_ins + n_tup_upd + n_tup_del > 0").splitlines()))
    inv_tables = {g["object"].split(":", 1)[1] for g in INVENTORY["grants"] if g["object"].startswith("table:")}
    check("G4 the tables the flows touched (pg_stat_user_tables) == the inventory's tables + the owner-side two "
          "(content_types FK check, source_extraction_queue via the SECURITY DEFINER trigger)",
          touched == inv_tables | OWNER_SIDE_TABLES,
          f"touched-not-inventory={sorted(touched - inv_tables - OWNER_SIDE_TABLES)} inventory-not-touched={sorted(inv_tables - touched)}")
    called = set(filter(None, lab.val("SELECT string_agg(schemaname || '.' || funcname, E'\\n') FROM pg_stat_user_functions").splitlines()))
    say(f"      functions counted by track_functions (SQL functions inlined by the planner are not): {sorted(called)}")
    # necessity: each entry alone
    entries = []
    for g in INVENTORY["grants"]:
        obj = g["object"].split(":", 1)[1]
        kind = g["object"].split(":", 1)[0]
        if kind == "schema":
            entries.append((f"USAGE ON SCHEMA {obj}", f"REVOKE USAGE ON SCHEMA {obj} FROM ob_notebook; REVOKE USAGE ON SCHEMA {obj} FROM PUBLIC"))
        elif kind == "function":
            entries.append((f"EXECUTE {obj}", f"REVOKE EXECUTE ON FUNCTION {obj} FROM ob_notebook"))
        elif g.get("columns"):
            for c in g["columns"]:
                entries.append((f"{g['privilege']} ({c}) ON {obj}", f"REVOKE {g['privilege']} ({c}) ON {obj} FROM ob_notebook"))
        else:
            entries.append((f"{g['privilege']} ON {obj}", f"REVOKE {g['privilege']} ON {obj} FROM ob_notebook"))
    for p in INVENTORY["policies"]:
        entries.append((f"policy {p['name']} ({p['command']}) ON {p['table']}", f"DROP POLICY {p['name']} ON {p['table']}"))
    unneeded = []
    for name, sql in entries:
        rc, _, err = lab.psql(sql)
        if rc != 0:
            unneeded.append(f"{name}: could not remove ({err.strip()[:120]})")
            continue
        res = lab.flows(IMG_PATCHED, "ob_notebook", mount=lab.secret)
        failing = [f["name"] for f in res.get("flows", []) if not f["ok"]]
        if not failing:
            unneeded.append(name)
        say(f"      without {name}: {len(failing)} flow(s) fail {failing[:3]}")
        if "SCHEMA" in name:
            lab.psql("GRANT USAGE ON SCHEMA public TO PUBLIC")
        lab.psql_file(INIT)  # restore (idempotent)
        # an ablation that let the url gate miss the tombstone readmitted the erased url: remove that row
        lab.psql("DELETE FROM public.sources WHERE url = 'https://lab.example/erased-page';")
    check(f"G5 necessity: removing any ONE of the {len(entries)} inventory entries makes a flow fail (no unused grant)",
          not unneeded, f"no flow failed without: {unneeded}")
    lab.val("DO $$ DECLARE f text; BEGIN FOREACH f IN ARRAY string_to_array(" + q(";".join(revoked)) + ", ';') LOOP "
            "EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', f); END LOOP; END $$; SELECT 1")
    check("G6 PUBLIC's EXECUTE restored (catalogue equals the first apply's)", lab.snapshot() == s1, diff(s1, lab.snapshot()))

    # ---------------------------------------------------------------- H: with intake applied
    lab.psql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename <> 'postgres' AND pid <> pg_backend_pid();")
    rc, _, err = lab.psql_file(INTAKE)
    check("H1 intake's init-intake.sql applies on top (ob_notebook in place)", rc == 0, err[-800:])
    since = lab.val("SELECT now()")
    res = lab.flows(IMG_PATCHED, "ob_notebook", mount=lab.secret)
    ok, bad = flows_ok(res)
    check("H2 every flow still passes as ob_notebook with intake's labels and authority trigger in place", ok,
          json.dumps(bad)[:600])
    label = lab.val("SELECT string_agg(DISTINCT screen_verdict, ',') FROM public.sources WHERE metadata->>'source' = 'open_notebook' AND created_at >= " + q(since))
    check("H3 open_notebook's new rows come out 'unscreened' (it cannot label clean/suspicious)", label == "unscreened", label)
    for t in ("intake.raw_items", "intake.items", "intake.discards", "intake.migration_ledger"):
        rc, out, err = lab.as_role(f"SELECT count(*) FROM {t};")
        check(f"H4 ob_notebook cannot read {t}", rc != 0 and "42501" in err, (out + err)[-200:])
    rc, out, err = lab.as_role("UPDATE public.sources SET screen_verdict = 'clean' WHERE id = '22222222-2222-4222-8222-000000000001';")
    check("H5 ob_notebook cannot label a source clean (no column grant; intake's trigger behind it)", rc != 0 and "42501" in err, err[-200:])
    rc, _, err = lab.psql_file(INIT)
    check("H6 init-notebook-role.sql re-applies cleanly after intake", rc == 0, err[-400:])
    negatives(lab, s_label="H7")

    # ---------------------------------------------------------------- I: the password in no log
    pw = lab.read_secret()
    dblog = run(["docker", "logs", lab.db])
    check("I1 the database log (log_statement=all, log_min_error_statement=error) never holds the password",
          pw not in dblog.stdout + dblog.stderr and "SCRAM-SHA-256$4096:" in dblog.stdout + dblog.stderr,
          "plaintext found" if pw in dblog.stdout + dblog.stderr else "the verifier statement is not in the log (log_statement off?)")
    check("I2 no flow container's output holds the password", all(pw not in o for o in lab.flow_outputs))
    chk = run([sys.executable, str(ROLE_DIR / "check_notebook_secret.py"), "--secret-file", str(lab.secret),
               "--ob1", str(OB1), "--containers", lab.db, "--skip-env-file"])
    say("      " + "\n      ".join(chk.stdout.strip().splitlines()))
    check("I3 check_notebook_secret.py passes against the lab (repo, compose, logs, container env)",
          chk.returncode == 0 and pw not in chk.stdout + chk.stderr, chk.stderr[-300:])


def q(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def diff(a: str, b: str) -> str:
    sa, sb = set(a.splitlines()), set(b.splitlines())
    return f"only-before={sorted(sa - sb)[:8]} only-after={sorted(sb - sa)[:8]}"


NEG_DDL = [
    ("create a table", "CREATE TABLE public.nb_x (i int);"),
    ("create a schema", "CREATE SCHEMA nb_s;"),
    ("create a function", "CREATE FUNCTION public.nb_f() RETURNS int LANGUAGE sql AS 'select 1';"),
    ("create a view", "CREATE VIEW public.nb_v AS SELECT 1;"),
    ("replace an inventory function", "CREATE OR REPLACE FUNCTION public.set_thread_source_status(uuid, uuid, text) "
     "RETURNS public.thread_sources LANGUAGE sql AS 'select null::public.thread_sources';"),
    ("alter a table", "ALTER TABLE public.sources ADD COLUMN nb int;"),
    ("alter a function", "ALTER FUNCTION public.find_or_create_source(text, text, text, text, text, text, text, public.vector, jsonb) SECURITY DEFINER;"),
    ("drop a table", "DROP TABLE public.threads;"),
    ("drop a policy", "DROP POLICY ob_notebook_select ON public.threads;"),
    ("create a policy", "CREATE POLICY nb_p ON public.thoughts FOR SELECT TO ob_notebook USING (true);"),
    ("create an index", "CREATE INDEX nb_i ON public.sources (url);"),
    ("attach a trigger", "CREATE TRIGGER nb_t BEFORE UPDATE ON public.sources FOR EACH ROW EXECUTE FUNCTION public.sources_touch_updated_at();"),
    ("disable RLS", "ALTER TABLE public.threads DISABLE ROW LEVEL SECURITY;"),
    ("truncate", "TRUNCATE public.sources;"),
    ("delete a source", "DELETE FROM public.sources;"),
    ("delete a thread", "DELETE FROM public.threads;"),
    ("delete a link", "DELETE FROM public.thread_sources;"),
    ("update an ungranted sources column (url)", "UPDATE public.sources SET url = url;"),
    ("update an ungranted thread_sources column (thread_id)", "UPDATE public.thread_sources SET thread_id = thread_id;"),
    ("update threads", "UPDATE public.threads SET name = name;"),
    ("insert an ungranted sources column (research_key)", "INSERT INTO public.sources (title, research_key) VALUES ('x', 'y');"),
    ("insert session_sources", "INSERT INTO public.session_sources (session_id, source_id) VALUES (gen_random_uuid(), gen_random_uuid());"),
    ("write the tombstones", "UPDATE public.source_tombstones SET lifted_at = now();"),
    ("make itself superuser", "ALTER ROLE ob_notebook SUPERUSER;"),
    ("give itself BYPASSRLS", "ALTER ROLE ob_notebook BYPASSRLS;"),
    ("give itself CREATEDB", "ALTER ROLE ob_notebook CREATEDB;"),
    ("create a role", "CREATE ROLE nb_r;"),
    ("create a database", "CREATE DATABASE nb_d;"),
    ("create an extension", "CREATE EXTENSION IF NOT EXISTS hstore;"),
    ("SET ROLE postgres", "SET ROLE postgres;"),
    ("SET ROLE service_role", "SET ROLE service_role;"),
    ("SET ROLE ob_app_memory", "SET ROLE ob_app_memory;"),
    ("SET SESSION AUTHORIZATION postgres", "SET SESSION AUTHORIZATION postgres;"),
    ("grant itself thoughts", "GRANT SELECT ON public.thoughts TO ob_notebook;"),
    ("grant itself service_role", "GRANT service_role TO ob_notebook;"),
    ("read a server file", "SELECT pg_read_file('/etc/hostname');"),
    ("COPY to a server file", "COPY public.sources TO '/tmp/nb_sources';"),
    ("COPY from a program", "COPY public.sources (title) FROM PROGRAM 'id';"),
    ("server-side lo_import", "SELECT lo_import('/etc/hostname');"),
    ("RLS off reads threads", "SET row_security = off; SELECT count(*) FROM public.threads;"),
    ("read thoughts", "SELECT count(*) FROM public.thoughts;"),
    ("read sessions", "SELECT count(*) FROM public.sessions;"),
]


def negatives(lab: Lab, s_label: str) -> None:
    fails = []
    for name, sql in NEG_DDL:
        if sql is None:
            continue
        rc, out, err = lab.as_role(sql)
        if not (rc != 0 and re.search(r"ERROR:\s+42501", err)):
            fails.append(f"{name}: rc={rc} {(out + err).strip()[-160:]}")
    check(f"{s_label}1 ob_notebook is refused (42501) all {len([n for n in NEG_DDL if n[1]])} forbidden actions "
          "(DDL, RLS, roles, ungranted columns/tables, server files)", not fails, "; ".join(fails)[:1500])
    # catalogue sweeps
    inv_rel = {}
    for g in INVENTORY["grants"]:
        if g["object"].startswith("table:"):
            inv_rel.setdefault(g["object"][6:], set()).add(g["privilege"])
    leaks = lab.val(r"""
      SELECT string_agg(c.oid::regclass::text || ' ' || p, ', ' ORDER BY 1) FROM pg_class c
       CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
       WHERE c.relkind IN ('r','p','v','m','f','S')
         AND c.relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace, 'pg_toast'::regnamespace)
         AND (CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('ob_notebook', c.oid, CASE p WHEN 'SELECT' THEN 'SELECT' WHEN 'UPDATE' THEN 'UPDATE' ELSE 'USAGE' END)
                   WHEN p IN ('SELECT','INSERT','UPDATE','REFERENCES') THEN has_any_column_privilege('ob_notebook', c.oid, p)
                   ELSE has_table_privilege('ob_notebook', c.oid, p) END)""")
    got = {}
    for item in filter(None, (leaks or "").split(", ")):
        rel, p = item.rsplit(" ", 1)
        rel = rel if "." in rel else "public." + rel
        got.setdefault(rel, set()).add(p)
    check(f"{s_label}2 catalogue: every relation and sequence ob_notebook holds any privilege on is in the inventory, "
          "with exactly the inventory's privileges", got == inv_rel, f"got={got} want={inv_rel}")
    n = lab.val("SELECT count(*) FROM pg_class c WHERE c.relkind IN ('r','p','v','m') AND c.relnamespace NOT IN "
                "('pg_catalog'::regnamespace,'information_schema'::regnamespace,'pg_toast'::regnamespace)")
    rc, out, err = lab.as_role(r"""
      DO $$ DECLARE r record; ok int := 0; leak text := ''; BEGIN
        FOR r IN SELECT c.oid::regclass AS t FROM pg_class c WHERE c.relkind IN ('r','p','v','m')
                  AND c.relnamespace NOT IN ('pg_catalog'::regnamespace,'information_schema'::regnamespace,'pg_toast'::regnamespace)
                  AND c.oid NOT IN ('public.sources'::regclass,'public.threads'::regclass,'public.thread_sources'::regclass,
                                    'public.source_chunks'::regclass,'public.source_tombstones'::regclass) LOOP
          BEGIN EXECUTE format('SELECT 1 FROM %s LIMIT 1', r.t); leak := leak || r.t::text || ' ';
          EXCEPTION WHEN insufficient_privilege THEN ok := ok + 1; END;
        END LOOP;
        RAISE NOTICE 'refused=% leaked=[%]', ok, leak;
      END $$;""")
    m = re.search(r"refused=(\d+) leaked=\[(.*)\]", err)
    check(f"{s_label}3 a real SELECT on every one of the {int(n) - 5} other tables/views (all schemas) is refused",
          bool(m) and m.group(2).strip() == "" and int(m.group(1)) == int(n) - 5, (err or out)[-300:])
    secdef = lab.val("""SELECT coalesce(string_agg(p.oid::regprocedure::text, ', '), '') FROM pg_proc p
                         WHERE p.prosecdef AND p.prorettype <> 'trigger'::regtype
                           AND p.pronamespace NOT IN ('pg_catalog'::regnamespace,'information_schema'::regnamespace)
                           AND has_function_privilege('ob_notebook', p.oid, 'EXECUTE')""")
    check(f"{s_label}4 no SECURITY DEFINER function (other than trigger functions, which cannot be called) is executable "
          "by ob_notebook", secdef == "", secdef)
    rows = lab.val("""SELECT concat_ws('|', (SELECT count(*) FROM pg_auth_members WHERE member = 'ob_notebook'::regrole),
                        coalesce((SELECT string_agg(nspname, ',' ORDER BY nspname) FROM pg_namespace WHERE has_schema_privilege('ob_notebook', oid, 'CREATE')
                                  AND nspname !~ '^pg_(toast_)?temp_'), ''),
                        has_database_privilege('ob_notebook', 'openbrain', 'CREATE'),
                        (SELECT string_agg(nspname, ',' ORDER BY nspname) FROM pg_namespace WHERE has_schema_privilege('ob_notebook', oid, 'USAGE')
                           AND nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg_temp%' AND nspname NOT LIKE 'pg_toast%'))""")
    parts = rows.split("|")
    check(f"{s_label}5 no role membership, CREATE on no schema and not on the database; USAGE on schema public only",
          parts[0] == "0" and parts[1] == "" and parts[2] == "f" and parts[3] == "public", rows)
    rc, out, err = lab.as_role("CREATE TEMP TABLE nb_tmp (i int); SELECT 'temp-created';")
    say(f"      DECLARED GAP (not a PASS): TEMP on the database is PUBLIC's - ob_notebook "
        f"{'CAN' if rc == 0 else 'cannot'} create session-local temp objects (rc={rc}); see the findings.")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--subnet", required=True)
    ap.add_argument("--schema", required=True)
    ap.add_argument("--roles", required=True)
    ap.add_argument("--fork", required=False, default=os.environ.get("OPEN_NOTEBOOK_DIR", ""))
    ap.add_argument("--evidence", default="")
    ap.add_argument("--red", action="store_true")
    a = ap.parse_args()
    w = subnet_ok(a.subnet)
    if w:
        print(f"REFUSED: {w}")
        return 2
    if not a.red and not (Path(a.fork) / "open_notebook" / "database" / "ob1_repository.py").exists():
        print("REFUSED: --fork must point at an open-notebook checkout with open_notebook/database/ob1_repository.py")
        return 2
    if a.red:
        a.fork = a.fork or str(HERE)
    ev = Path(a.evidence) if a.evidence else None
    if ev and ev.exists() and any(ev.iterdir()):
        print(f"REFUSED: --evidence {ev} is not empty")
        return 2
    lab = Lab(a)
    say(f"lab {lab.rand}: network {lab.net} {a.subnet} (--internal), db {lab.db}, mode {'RED' if a.red else 'GREEN'}")
    t0 = time.time()
    try:
        if a.red:
            lab.images.append(IMG_PATCHED)  # removed at the end even if the build half-ran
            build_red(lab)
        else:
            lab.build_images()
        lab.start()
        (red if a.red else green)(lab)
    except Exception as exc:
        check(f"lab ran to the end ({type(exc).__name__}: {str(exc)[:300]})", False)
    finally:
        lab.stop()
        left = (run(["docker", "ps", "-aq", "--filter", f"label={RUN_LABEL}"]).stdout.split()
                + run(["docker", "network", "ls", "-q", "--filter", f"label={RUN_LABEL}"]).stdout.split()
                + run(["docker", "volume", "ls", "-q", "--filter", f"label={RUN_LABEL}"]).stdout.split()
                + run(["docker", "image", "ls", "-aq", "--filter", f"label={RUN_LABEL}"]).stdout.split()
                + ([str(lab.tmp)] if lab.tmp.exists() else []))
        check("Z leftovers: no container, network, volume, image (tagged or not) or temp dir of this run remains",
              not left, str(left))
    n_fail = sum(1 for _, ok, _ in RESULTS if not ok)
    say(f"\n{len(RESULTS) - n_fail} PASS, {n_fail} FAIL ({time.time() - t0:.0f} s)")
    if ev:
        ev.mkdir(parents=True, exist_ok=True)
        (ev / "run.log").write_text("\n".join(LOG) + "\n", encoding="utf-8")
    return 1 if n_fail else 0


def build_red(lab: Lab) -> None:
    """RED images: the patched-variant tag holds the DEPLOYED module too (bc6d3a6 has no fork change)."""
    lab.images = []
    for img in (IMG_PATCHED, IMG_BASE):
        ctx = lab.tmp / f"ctx-{img.split(':')[0]}"
        (ctx / "stage").mkdir(parents=True)
        shutil.copy(HERE / "Dockerfile.lab", ctx / "Dockerfile")
        shutil.copy(HERE / "flows.py", ctx / "stage" / "flows.py")
        p = run(["docker", "build", "-q", "--label", LABEL, "--label", RUN_LABEL, "-t", img, str(ctx)], timeout=900)
        if p.returncode != 0:
            raise RuntimeError(f"build {img}: {p.stderr[-1500:]}")
        lab.images.append(img)


if __name__ == "__main__":
    sys.exit(main())
