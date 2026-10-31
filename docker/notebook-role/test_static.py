#!/usr/bin/env python3
"""Static checks for intake-notebook-role (no database, no docker; stdlib only).

    python test_static.py                      # migration / revert / compose / inventory
    OPEN_NOTEBOOK_DIR=<fork> [OB1_REPOSITORY_FILE=<patched ob1_repository.py>] python test_static.py
                                               # + the inventory against the fork's code

1. init-notebook-role.sql grants EXACTLY inventory.json's grants and policies (an extra grant or
   a missing one fails), sets no password, revokes before it grants; the revert removes each.
2. compose: open_notebook connects as ob_notebook with OB1_DB_PASSWORD_FILE from a compose secret
   in the gitignored docker/notebook-secrets/, no OB1_DB_PASSWORD entry; openbrain-db mounts the
   migration at slot 310 (the next after the current head 300).
3. with the fork: every function of open_notebook/database/ob1_repository.py that runs SQL is
   classified reachable / unreachable correctly (callers measured with ast), every OB1 table and
   function a reachable function's SQL names has an inventory grant citing that function, and
   every 'direct' grant is named by one of its sites; the session_sources write stays
   unreachable (no caller passes session_id).
"""
from __future__ import annotations

import ast
import json
import os
import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCKER = HERE.parent
OB1 = DOCKER.parent
def _read(p: Path) -> str:  # a missing file reads empty, so the RED run fails per test, not at import
    return p.read_text(encoding="utf-8") if p.exists() else ""


INIT = _read(DOCKER / "init-notebook-role.sql")
REVERT = _read(DOCKER / "revert-notebook-role.sql")
COMPOSE = (DOCKER / "docker-compose.yml").read_text(encoding="utf-8")
INV = json.loads((HERE / "inventory.json").read_text(encoding="utf-8"))
FORK = os.environ.get("OPEN_NOTEBOOK_DIR", "")


def strip_sql_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


def split_top(s: str) -> list[str]:
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return [x.strip() for x in out if x.strip()]


def norm(kind: str, name: str) -> str:
    return kind + ":" + re.sub(r"\s+", "", name).replace("public.", "")


def sql_grants() -> set[tuple[str, str, str]]:
    sql = strip_sql_comments(INIT)
    out = set()
    for m in re.finditer(r"\bGRANT\s+(\w+)\s*(\(([^)]*)\))?\s+ON\s+(.*?)\s+TO\s+(\w+)\s*;", sql, re.S | re.I):
        priv, cols, target, who = m.group(1).upper(), m.group(3), m.group(4), m.group(5)
        assert who == "ob_notebook", f"a grant to {who}"
        t = re.sub(r"\s+", " ", target.strip())
        if t.upper().startswith("SCHEMA "):
            objs = [("schema", x) for x in split_top(t[7:])]
        elif t.upper().startswith("FUNCTION "):
            objs = [("function", x) for x in split_top(t[9:])]
        else:
            objs = [("table", x) for x in split_top(t.replace("TABLE ", ""))]
        for kind, name in objs:
            for c in ([x.strip() for x in cols.split(",")] if cols else [""]):
                out.add((priv, norm(kind, name), c))
    return out


def inv_grants() -> set[tuple[str, str, str]]:
    out = set()
    for g in INV["grants"]:
        kind, name = g["object"].split(":", 1)
        for c in (g.get("columns") or [""]):
            out.add((g["privilege"], norm(kind, name), c))
    return out


def sql_policies() -> set[str]:
    sql = strip_sql_comments(INIT)
    return {f"public.{t} {p} {c}" for t, p, c in
            re.findall(r"\(\s*'(\w+)'\s*,\s*'(\w+)'\s*,\s*'(SELECT|INSERT|UPDATE|DELETE|ALL)'\s*,", sql)}


def service(name: str) -> str:
    m = re.search(rf"(?m)^  {re.escape(name)}:\s*$", COMPOSE)
    nxt = re.search(r"(?m)^  [A-Za-z0-9_.-]+:\s*$|^[A-Za-z]", COMPOSE[m.end():])
    return COMPOSE[m.end(): m.end() + (nxt.start() if nxt else len(COMPOSE))]


class Migration(unittest.TestCase):
    def test_grants_equal_the_inventory(self):
        got, want = sql_grants(), inv_grants()
        self.assertEqual(got, want, f"extra in SQL: {sorted(got - want)}; missing from SQL: {sorted(want - got)}")

    def test_policies_equal_the_inventory(self):
        want = {f"{p['table']} {p['name']} {p['command']}" for p in INV["policies"]}
        self.assertEqual(sql_policies(), want)

    def test_role_attributes(self):
        for attr in ("LOGIN", "NOSUPERUSER", "NOCREATEDB", "NOCREATEROLE", "NOBYPASSRLS"):
            self.assertEqual(len(re.findall(rf"\b{attr}\b", strip_sql_comments(INIT))), 2, attr)  # CREATE + ALTER

    def test_revokes_everything_before_granting(self):
        sql = strip_sql_comments(INIT)
        first_grant = sql.index("GRANT USAGE ON SCHEMA public")
        for r in ("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ob_notebook",
                  "REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ob_notebook",
                  "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ob_notebook",
                  "REVOKE ALL ON SCHEMA public FROM ob_notebook", "pg_auth_members"):
            self.assertIn(r, sql)
            self.assertLess(sql.index(r), first_grant, r)

    def test_no_password_and_no_role_membership_in_the_sql(self):
        sql = strip_sql_comments(INIT)
        self.assertNotRegex(sql, r"(?i)\bPASSWORD\b")
        self.assertNotRegex(sql, r"(?i)\bGRANT\s+\w+\s+TO\s+ob_notebook\s*;")  # GRANT <role> TO
        self.assertNotRegex(sql, r"(?i)\bWITH\s+GRANT\s+OPTION\b")

    def test_nothing_but_ob_notebook_is_granted_or_altered(self):
        sql = strip_sql_comments(INIT)
        self.assertNotRegex(sql, r"(?i)\b(CREATE|ALTER|DROP)\s+(TABLE|FUNCTION|VIEW|TRIGGER|INDEX|SCHEMA)\b")
        for m in re.finditer(r"(?i)\bREVOKE\b[^;]*?\bFROM\s+(\w+)", sql):
            self.assertEqual(m.group(1), "ob_notebook")

    def test_revert_removes_each_policy_and_the_role(self):
        for p in INV["policies"]:
            self.assertIn(f"DROP POLICY IF EXISTS {p['name']} ON {p['table']};", REVERT)
        self.assertIn("DROP OWNED BY ob_notebook", REVERT)
        self.assertIn("DROP ROLE ob_notebook", REVERT)


class Compose(unittest.TestCase):
    def test_open_notebook_connects_as_ob_notebook_with_a_password_file(self):
        blk = service("open_notebook")
        self.assertRegex(blk, r"(?m)^\s*- OB1_DB_USER=ob_notebook\s*$")
        self.assertRegex(blk, r"(?m)^\s*- OB1_DB_PASSWORD_FILE=/run/secrets/ob_notebook_db_password\s*$")
        self.assertNotRegex(blk, r"(?m)^\s*-?\s*OB1_DB_PASSWORD\s*[=:]")
        self.assertNotRegex(blk, r"(?m)^\s*- OB1_DB_USER=postgres")
        self.assertRegex(blk, r"(?m)^\s*- source: ob_notebook_db_password\n\s*target: ob_notebook_db_password\s*$")

    def test_the_secret_is_a_gitignored_file(self):
        top = COMPOSE[re.search(r"(?m)^secrets:\s*$", COMPOSE).end():]
        self.assertRegex(top, r"(?m)^  ob_notebook_db_password:\n    file: \./notebook-secrets/ob_notebook_db_password\s*$")
        ign = (OB1 / ".gitignore").read_text(encoding="utf-8").splitlines()
        self.assertIn("docker/notebook-secrets/", [x.strip() for x in ign])

    def test_no_password_variable_for_it_in_env_example(self):
        ex = (DOCKER / ".env.example").read_text(encoding="utf-8")
        names = [ln.split("=", 1)[0].strip() for ln in ex.splitlines() if "=" in ln and not ln.lstrip().startswith("#")]
        self.assertFalse([n for n in names if re.search(r"NOTEBOOK.*PASSWORD|OB1_DB_PASSWORD", n)], names)

    def test_openbrain_db_mounts_slot_310_after_the_head(self):
        slots = re.findall(r"/docker-entrypoint-initdb\.d/(\d{3})-", service("openbrain-db"))
        self.assertIn("310", slots)
        self.assertEqual(max(slots), "310")
        self.assertEqual(slots.count("310"), 1)
        self.assertIn("./init-notebook-role.sql:/docker-entrypoint-initdb.d/310-init-notebook-role.sql:ro", COMPOSE)


SKIP_FUNCS = {"embed", "get_pool", "close_current_pool", "close_pool", "apply_settings"}


@unittest.skipUnless(FORK and (Path(FORK) / "open_notebook/database/ob1_repository.py").exists(),
                     "OPEN_NOTEBOOK_DIR is not set to the fork")
class ForkInventory(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(FORK)
        # OB1_REPOSITORY_FILE: the patched module, when the callers come from a checkout whose
        # copy is the deployed one (the fork's IKS tree is uncommitted; see the findings)
        cls.mod_path = Path(os.environ.get("OB1_REPOSITORY_FILE") or
                            cls.root / "open_notebook" / "database" / "ob1_repository.py")
        cls.own_copy = cls.root / "open_notebook" / "database" / "ob1_repository.py"
        cls.tree = ast.parse(cls.mod_path.read_text(encoding="utf-8"))
        cls.funcs = {n.name: n for n in cls.tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
        cls.sql = {}
        for name, fn in cls.funcs.items():
            # every string constant in the function (f-string pieces are Constants too), minus the
            # docstring; to_regclass('...') names a relation without touching it (test_connection)
            doc = ast.get_docstring(fn, clean=False) or ""
            text = " ".join(c.value for c in ast.walk(fn) if isinstance(c, ast.Constant)
                            and isinstance(c.value, str) and c.value != doc)
            cls.sql[name] = re.sub(r"to_regclass\('[^']*'\)", "", text)
        # who calls what from outside the module (ob1.<name>( / _ob1.<name>( ), measured with ast
        cls.external_calls: dict[str, list[ast.Call]] = {}
        for py in cls.root.rglob("*.py"):
            if py in (cls.mod_path, cls.own_copy) or any(p in py.parts for p in (".venv", "node_modules", "tests")):
                continue
            try:
                t = ast.parse(py.read_text(encoding="utf-8"))
            except (SyntaxError, UnicodeDecodeError):
                continue
            for n in ast.walk(t):
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and \
                        isinstance(n.func.value, ast.Name) and n.func.value.id in ("ob1", "_ob1"):
                    cls.external_calls.setdefault(n.func.attr, []).append(n)
        # universe of OB1 object names (tables, views, functions) from OB1's SQL
        cls.universe = set()
        for f in list(DOCKER.glob("init*.sql")) + list((OB1 / "integrations" / "intake" / "sql").glob("*.sql")):
            s = f.read_text(encoding="utf-8", errors="replace")
            for m in re.finditer(r"(?i)CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION)\s+"
                                 r"(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)", s):
                cls.universe.add(m.group(1).lower())

    def runs_sql(self, name: str) -> bool:
        fn = self.funcs[name]
        return any(isinstance(n, ast.Attribute) and n.attr in ("fetch", "fetchrow", "fetchval", "execute", "connect")
                   for n in ast.walk(fn))

    def closure(self) -> set[str]:
        seen, todo = set(), [n for n in self.external_calls if n in self.funcs]
        while todo:
            n = todo.pop()
            if n in seen:
                continue
            seen.add(n)
            for c in ast.walk(self.funcs[n]):
                if isinstance(c, ast.Call) and isinstance(c.func, ast.Name) and c.func.id in self.funcs:
                    todo.append(c.func.id)
        return seen

    def test_every_sql_function_is_classified_and_reachability_is_measured(self):
        sql_funcs = {n for n in self.funcs if n not in SKIP_FUNCS and (self.runs_sql(n) or n in INV["reachable"])}
        reach = self.closure()
        classified = set(INV["reachable"]) | set(INV["unreachable"])
        self.assertEqual(sql_funcs - classified, set(), "a function that runs SQL is in neither list")
        self.assertEqual({n for n in INV["reachable"] if n not in reach}, set(), "listed reachable, no caller")
        self.assertEqual({n for n in INV["unreachable"] if n in reach}, set(), "listed unreachable, has a caller")
        self.assertEqual({n for n in sql_funcs if n in reach} - set(INV["reachable"]), set())

    def test_every_object_a_reachable_function_names_is_granted_for_it(self):
        granted: dict[str, set[str]] = {}
        for g in INV["grants"]:
            if g["object"].startswith(("table:", "function:")):
                obj = re.sub(r"\(.*", "", g["object"].split(":", 1)[1]).replace("public.", "")
                for s in g["sites"]:
                    granted.setdefault(s, set()).add(obj)
        # the one named-but-not-granted object: the session_sources branch, which no caller reaches
        # (test_the_session_sources_branch_stays_unreachable proves it)
        branch_only = {("capture_source_into_thread", "session_sources")}
        missing = []
        for name in INV["reachable"]:
            words = set(re.findall(r"\b([a-z_][a-z0-9_]*)\b", self.sql.get(name, "").lower()))
            for obj in sorted(words & self.universe):
                if obj not in granted.get(name, set()) and (name, obj) not in branch_only:
                    missing.append(f"{name} -> {obj}")
        self.assertEqual(missing, [], "an ungranted call site")

    def test_every_direct_grant_is_named_by_a_site(self):
        unused = []
        for g in INV["grants"]:
            if not g["object"].startswith(("table:", "function:")) or not g.get("via", "").startswith("direct"):
                continue
            obj = re.sub(r"\(.*", "", g["object"].split(":", 1)[1]).replace("public.", "")
            if not any(re.search(rf"\b{obj}\b", self.sql.get(s, "")) for s in g["sites"]):
                unused.append(g["object"])
        self.assertEqual(unused, [])

    def test_no_reachable_function_names_match_sources_or_session_sources_unless_listed(self):
        names = " ".join(self.sql[n] for n in INV["reachable"] if n in self.sql)
        self.assertNotRegex(names, r"\bmatch_sources\b")
        self.assertRegex(self.sql["capture_source_into_thread"], r"\bsession_sources\b")  # still the branch

    def test_the_session_sources_branch_stays_unreachable(self):
        calls = self.external_calls.get("capture_source_into_thread", [])
        self.assertTrue(calls, "capture_source_into_thread has no caller (the inventory is stale)")
        for c in calls:
            self.assertNotIn("session_id", [k.arg for k in c.keywords], "a caller passes session_id: grant session_sources")
            self.assertFalse(any(k.arg is None for k in c.keywords), "a **kwargs caller: cannot prove no session_id")

    def test_the_password_file_code_path_is_present(self):
        src = self.mod_path.read_text(encoding="utf-8")
        self.assertIn("OB1_DB_PASSWORD_FILE", src)
        self.assertIn("def _password_from_file", src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
