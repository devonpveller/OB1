// node --test docker/wiki-service/lib/vault-gitignore.test.mjs
// rw-p1a-deploy-prep (reviewer RV-5): the vault .gitignore keeps every
// operator line and gains the ledger and lock entries; a real git repo
// confirms `git add -A` stages none of the ledgers.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { mergeGitignore, REQUIRED_IGNORES } from "./vault-gitignore.mjs";

const OPERATOR = "# operator: my own lines\n*.bak\ndrafts/\n!drafts/keep.md\nnotplanned.json\n.wikistate.json\nassets/\n";

test("RV-5: every pre-existing line is kept, in order, byte for byte; only missing entries are appended", () => {
  const r = mergeGitignore(OPERATOR);
  assert.equal(r.changed, true);
  assert.ok(r.text.startsWith(OPERATOR), "the operator's text is a prefix of the result");
  for (const e of [".structural-failures.json", ".unsynced-rows.json", "*.lock", "planned.json", ".compile-notifications.jsonl"]) {
    assert.ok(r.added.includes(e), `appended ${e}`);
  }
  assert.ok(!r.added.includes(".wikistate.json") && !r.added.includes("assets/"), "an entry already there is not repeated");
  assert.ok(r.added.includes("planned.json"), "notplanned.json does not stand in for planned.json");
});

test("RV-5: a file that already has every entry is returned unchanged (no write)", () => {
  const full = mergeGitignore(OPERATOR).text;
  const again = mergeGitignore(full);
  assert.equal(again.changed, false);
  assert.equal(again.text, full);
});

test("RV-5: no file -> exactly the required entries; CRLF and a missing final newline are respected", () => {
  const r = mergeGitignore("");
  for (const e of REQUIRED_IGNORES) assert.ok(r.text.split("\n").includes(e), e);
  const crlf = mergeGitignore("a\r\nb");
  assert.ok(crlf.text.startsWith("a\r\nb\r\n"), "the last operator line is terminated, not joined to ours");
  assert.ok(crlf.text.includes("\r\n.structural-failures.json\r\n"));
});

test("RV-5: in a git repo, `git add -A` stages none of the ledgers, their locks or temp files; operator lines still apply", (t) => {
  let git;
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); git = true; } catch { git = false; }
  if (!git) { t.skip("no git on this host"); return; }
  const v = mkdtempSync(join(tmpdir(), "rv5-vault-"));
  t.after(() => rmSync(v, { recursive: true, force: true }));
  // A scratch repo of its own: git never walks up out of it (a temp dir can sit
  // inside another repository, e.g. a home directory under git).
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(v), GIT_CONFIG_NOSYSTEM: "1" };
  const run = (...a) => execFileSync("git", ["-C", v, ...a], { encoding: "utf8", env });
  run("init", "-q");
  assert.equal(run("rev-parse", "--show-toplevel").trim().replace(/\\/g, "/").toLowerCase(), v.replace(/\\/g, "/").toLowerCase());
  writeFileSync(join(v, ".gitignore"), mergeGitignore(OPERATOR).text);
  mkdirSync(join(v, "content", "person"), { recursive: true });
  mkdirSync(join(v, "drafts"), { recursive: true });
  for (const f of ["content/.structural-failures.json", "content/.structural-failures.json.lock", "content/.unsynced-rows.json",
    "content/.unsynced-rows.json.lock", "content/.unsynced-rows.json.tmp-host-1-ab12cd34", "content/.structural-failures.json.tmp-host-2-ff",
    "content/.compile-notifications.jsonl", "planned.json", "x.bak", "drafts/d.md", "drafts/keep.md", "content/person/p.md"]) {
    writeFileSync(join(v, f), "x\n");
  }
  run("add", "-A");
  const staged = run("diff", "--cached", "--name-only").trim().split("\n").sort();
  assert.deepEqual(staged, [".gitignore", "content/person/p.md"]);
});
