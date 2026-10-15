"""FORK-OWNED guard (operator D23): an upstream diff that touches a fork-owned path, the
`intake` schema, or the screen_verdict / intake_item_id columns must FAIL; an unrelated diff
must PASS. Synthetic diffs here; the git-driven modes are exercised against a scratch repo."""
import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

from tools import check_fork_owned as cfo

HERE = Path(__file__).resolve().parent
MANIFEST = HERE.parent / "FORK-OWNED.md"


def diff(path, *lines, old=None):
    old = old or path
    body = "\n".join(lines)
    return textwrap.dedent(f"""\
        diff --git a/{old} b/{path}
        index 1111111..2222222 100644
        --- a/{old}
        +++ b/{path}
        @@ -1,3 +1,3 @@
        """) + body + "\n"


class Manifest(unittest.TestCase):
    def test_manifest_parses_and_lists_the_owned_surface(self):
        m = cfo.load_manifest(MANIFEST)
        self.assertIn("integrations/intake/", m.paths)
        for ident in ("screen_verdict", "intake_item_id"):
            self.assertIn(ident, m.identifiers)
        self.assertTrue(m.patterns, "the intake schema/role need regex rules")

    def test_empty_manifest_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "FORK-OWNED.md"
            p.write_text("# nothing here\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                cfo.load_manifest(p)


class DiffCheck(unittest.TestCase):
    def setUp(self):
        self.m = cfo.load_manifest(MANIFEST)

    def assertFails(self, text):
        v = cfo.check_diff(text, self.m)
        self.assertTrue(v, "expected a violation for:\n" + text)
        return v

    def assertPasses(self, text):
        self.assertEqual(cfo.check_diff(text, self.m), [])

    # --- must FAIL -------------------------------------------------------------------------
    def test_touching_an_owned_path_fails(self):
        self.assertFails(diff("integrations/intake/sql/init-intake.sql", "-old", "+new"))

    def test_adding_a_new_file_under_an_owned_path_fails(self):
        self.assertFails(diff("integrations/intake/upstream.py", "+print(1)", old="dev/null"))

    def test_deleting_the_manifest_fails(self):
        self.assertFails("diff --git a/integrations/intake/FORK-OWNED.md b/integrations/intake/FORK-OWNED.md\n"
                         "deleted file mode 100644\n--- a/integrations/intake/FORK-OWNED.md\n+++ /dev/null\n"
                         "@@ -1 +0,0 @@\n-x\n")

    def test_rename_into_an_owned_path_fails(self):
        self.assertFails("diff --git a/x/y.py b/integrations/intake/y.py\nsimilarity index 100%\n"
                         "rename from x/y.py\nrename to integrations/intake/y.py\n")

    def test_column_in_any_file_fails(self):
        self.assertFails(diff("docker/init-sources.sql",
                              "+ALTER TABLE sources ADD COLUMN screen_verdict text;"))
        self.assertFails(diff("server/index.ts", "-  intake_item_id: row.x,"))

    def test_intake_schema_reference_fails(self):
        self.assertFails(diff("docker/init-upstream.sql", "+CREATE SCHEMA IF NOT EXISTS intake;"))
        self.assertFails(diff("docker/init-upstream.sql", "+SELECT * FROM intake.raw_items;"))
        self.assertFails(diff("docker/init-upstream.sql", '+CREATE TABLE "intake"."x" (id int);'))

    def test_intake_role_reference_fails(self):
        self.assertFails(diff("docker/init-grants.sql", "+CREATE ROLE intake LOGIN;"))
        self.assertFails(diff("docker/init-grants.sql", "+GRANT SELECT ON sources TO intake;"))

    def test_unquoted_identifier_in_any_case_fails(self):
        # Round 2 (tester F3): unquoted SQL identifiers fold to lower case, so SCREEN_VERDICT IS
        # screen_verdict to postgres.
        self.assertFails(diff("docker/init-x.sql", "+ALTER TABLE thoughts ADD COLUMN SCREEN_VERDICT text;"))
        self.assertFails(diff("docker/init-x.sql", "+ALTER TABLE sources ADD COLUMN Intake_Item_Id uuid;"))

    def test_role_membership_and_grant_option_fail(self):
        # Round 2 (tester F4): membership in intake is the most dangerous upstream collision.
        self.assertFails(diff("docker/init-grants.sql", "+GRANT intake TO service_role;"))
        self.assertFails(diff("docker/init-grants.sql", '+GRANT "intake" TO authenticated, anon;'))
        self.assertFails(diff("docker/init-grants.sql", "+REVOKE intake FROM service_role;"))
        self.assertFails(diff("docker/init-grants.sql",
                              "+GRANT SELECT ON public.sources TO intake WITH GRANT OPTION;"))
        self.assertFails(diff("docker/init-grants.sql", "+ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO intake"))

    def test_initdb_slot_220_fails(self):
        # Round 2 (tester F4): an upstream file or mount in the 220 initdb slot collides with ours.
        self.assertFails(diff("docker/220-init-upstream.sql", "+SELECT 1;", old="dev/null"))
        self.assertFails(diff("docker/docker-compose.yml",
                              "+      - ./init-up.sql:/docker-entrypoint-initdb.d/220-init-up.sql:ro"))

    def test_other_initdb_slots_pass(self):
        self.assertPasses(diff("docker/docker-compose.yml",
                               "+      - ./init-up.sql:/docker-entrypoint-initdb.d/230-init-up.sql:ro"))
        self.assertPasses(diff("docker/2200-notes.md", "+x"))

    def test_migration_file_name_in_compose_fails(self):
        self.assertFails(diff("docker/docker-compose.yml",
                              "-      - ../integrations/intake/sql/init-intake.sql:/docker-entrypoint-initdb.d/220-init-intake.sql:ro"))

    # --- must PASS -------------------------------------------------------------------------
    def test_unrelated_diff_passes(self):
        self.assertPasses(diff("recipes/daily-digest/src/index.ts", "-const a = 1;", "+const a = 2;"))
        self.assertPasses(diff("docker/init-sources.sql", "+ALTER TABLE sources ADD COLUMN volatility text;"))

    def test_the_word_intake_in_prose_passes(self):
        # 'intake' is an ordinary English word; only the schema/role forms are owned.
        self.assertPasses(diff("docs/nutrition.md", "+Track your daily calorie intake and water intake."))
        self.assertPasses(diff("recipes/x/README.md", "+The intake form asks three questions."))

    def test_lookalike_paths_pass(self):
        self.assertPasses(diff("integrations/intake-other/x.py", "+1"))
        self.assertPasses(diff("recipes/integrations/intake/x.py", "+1"))

    def test_context_lines_do_not_count(self):
        # Only lines the diff ADDS or REMOVES are a change; unchanged context naming a column is not.
        text = diff("docker/init-sources.sql", " -- screen_verdict is fork-owned", "+-- unrelated")
        self.assertPasses(text)

    def test_empty_diff_passes(self):
        self.assertPasses("")


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True,
                          text=True, env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                                          "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
                                          "GIT_CONFIG_NOSYSTEM": "1", "HOME": str(repo)}).stdout.strip()


@unittest.skipUnless(shutil.which("git"), "git not on PATH")
class GitModes(unittest.TestCase):
    """A scratch repo standing in for fork + upstream; never the real OB1 checkout."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fork-owned-")
        self.repo = Path(self.tmp)
        git(self.repo, "init", "-q", "-b", "main")
        (self.repo / "README.md").write_text("base\n")
        git(self.repo, "add", "-A"); git(self.repo, "commit", "-qm", "base")
        self.base = git(self.repo, "rev-parse", "HEAD")
        # fork side: adds the owned path
        (self.repo / "integrations/intake").mkdir(parents=True)
        (self.repo / "integrations/intake/x.sql").write_text("ALTER TABLE sources ADD COLUMN screen_verdict text;\n")
        git(self.repo, "add", "-A"); git(self.repo, "commit", "-qm", "fork adds intake")
        self.fork = git(self.repo, "rev-parse", "HEAD")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def upstream_commit(self, rel, content):
        git(self.repo, "checkout", "-q", "-b", "up-" + rel.replace("/", "_"), self.base)
        p = self.repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        git(self.repo, "add", "-A"); git(self.repo, "commit", "-qm", "upstream change")
        ref = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "checkout", "-q", self.fork)
        return ref

    def test_upstream_mode_ignores_the_forks_own_changes(self):
        up = self.upstream_commit("recipes/a.txt", "unrelated\n")
        m = cfo.load_manifest(MANIFEST)
        self.assertEqual(cfo.check_upstream(self.repo, up, m, head=self.fork), [])

    def test_upstream_mode_fails_on_owned_path(self):
        up = self.upstream_commit("integrations/intake/x.sql", "upstream rewrite\n")
        m = cfo.load_manifest(MANIFEST)
        self.assertTrue(cfo.check_upstream(self.repo, up, m, head=self.fork))

    def test_range_mode_checks_what_a_merge_brought_in(self):
        up = self.upstream_commit("docker/init-x.sql", "ALTER TABLE thoughts ADD COLUMN intake_item_id uuid;\n")
        git(self.repo, "merge", "-q", "--no-ff", "--no-edit", up)
        merged = git(self.repo, "rev-parse", "HEAD")
        m = cfo.load_manifest(MANIFEST)
        self.assertTrue(cfo.check_range(self.repo, f"{self.fork}..{merged}", m))

    def test_range_mode_passes_an_unrelated_merge_and_fork_only_commits(self):
        up = self.upstream_commit("recipes/b.txt", "fine\n")
        git(self.repo, "merge", "-q", "--no-ff", "--no-edit", up)
        (self.repo / "integrations/intake/y.sql").write_text("-- fork edits its own path\n")
        git(self.repo, "add", "-A"); git(self.repo, "commit", "-qm", "fork edit")
        head = git(self.repo, "rev-parse", "HEAD")
        m = cfo.load_manifest(MANIFEST)
        self.assertEqual(cfo.check_range(self.repo, f"{self.fork}..{head}", m), [])

    def test_cli_exit_codes(self):
        bad = Path(self.tmp) / "bad.diff"
        bad.write_text(diff("integrations/intake/a.py", "+1"))
        good = Path(self.tmp) / "good.diff"
        good.write_text(diff("recipes/a.py", "+1"))
        self.assertEqual(cfo.main(["--manifest", str(MANIFEST), "--diff", str(bad)]), 1)
        self.assertEqual(cfo.main(["--manifest", str(MANIFEST), "--diff", str(good)]), 0)


if __name__ == "__main__":
    unittest.main()
