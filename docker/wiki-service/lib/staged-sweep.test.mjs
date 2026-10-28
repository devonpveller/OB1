// node --test docker/wiki-service/lib/staged-sweep.test.mjs
// research-workbench P1c (rw-p1b-ready review R-1): a hard kill's staged
// leftovers are swept at start and ignored by the vault git.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaged, STAGED } from "./staged-sweep.mjs";
import { mergeGitignore } from "./vault-gitignore.mjs";

function vault() {
  const d = mkdtempSync(join(tmpdir(), "staged-"));
  mkdirSync(join(d, "content/person"), { recursive: true });
  mkdirSync(join(d, ".git/objects"), { recursive: true });
  writeFileSync(join(d, "content/person/ada.md"), "# Ada\n");
  writeFileSync(join(d, "content/person/.ada.md.wp-staged-4242"), "# Ada (staged)\n");
  writeFileSync(join(d, ".index.md.wp-staged-7"), "# home (staged)\n");
  writeFileSync(join(d, "content/person/.keep"), "");
  writeFileSync(join(d, "content/person/ada.md.wp-staged-1"), "not hidden: not ours\n");
  writeFileSync(join(d, ".git/objects/.x.wp-staged-1"), "inside .git: never touched\n");
  return d;
}

test("R-1: the sweep removes exactly the hidden .<name>.wp-staged-<pid> files, never .git/", async () => {
  const d = vault();
  try {
    const removed = (await sweepStaged(d)).sort();
    assert.deepEqual(removed, [".index.md.wp-staged-7", "content/person/.ada.md.wp-staged-4242"]);
    assert.ok(existsSync(join(d, "content/person/ada.md")));
    assert.ok(existsSync(join(d, "content/person/.keep")));
    assert.ok(existsSync(join(d, "content/person/ada.md.wp-staged-1")), "a non-dot name is not a staged file");
    assert.ok(existsSync(join(d, ".git/objects/.x.wp-staged-1")), ".git is never entered");
    assert.deepEqual(await sweepStaged(d), [], "idempotent");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("R-1: the pattern is the writer's stagedName shape", () => {
  assert.ok(STAGED.test(".person-ada.md.wp-staged-123"));
  assert.ok(!STAGED.test("person-ada.md"));
  assert.ok(!STAGED.test(".person-ada.md.wp-staged-"));
});

test("R-1: the merged vault .gitignore makes git add -A skip a staged file", () => {
  const d = mkdtempSync(join(tmpdir(), "staged-git-"));
  try {
    const git = (...a) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(d, ".gitignore"), mergeGitignore("").text);
    mkdirSync(join(d, "content"), { recursive: true });
    writeFileSync(join(d, "content/a.md"), "# a\n");
    writeFileSync(join(d, "content/.a.md.wp-staged-99"), "# a staged\n");
    git("add", "-A");
    const staged = git("diff", "--cached", "--name-only").trim().split("\n").sort();
    assert.deepEqual(staged, [".gitignore", "content/a.md"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
