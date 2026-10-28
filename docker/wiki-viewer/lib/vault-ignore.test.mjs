// rw-p1c-retire2 (review r-p1c): the viewer refuses what the vault .gitignore lists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseGitignore, ignoredBy, isVaultIgnored, REQUIRED_IGNORES } from "./vault-ignore.mjs";

const one = (text, rel, isDir) => ignoredBy([{ base: "", rules: parseGitignore(text) }], rel, isDir);

test("git's rules: anchoring, dir-only, globs, negation, parent exclusion", () => {
  assert.equal(one("planned.json", "planned.json"), true);
  assert.equal(one("planned.json", "notes/planned.json"), true, "no slash = any depth");
  assert.equal(one("/planned.json", "notes/planned.json"), false, "leading slash anchors");
  assert.equal(one("planned.json", "notplanned.json"), false);
  assert.equal(one("*.lock", "content/x.lock"), true);
  assert.equal(one("assets/", "assets/src1/x.png"), true, "dir-only excludes what is under it");
  assert.equal(one("assets/", "assets", false), false, "dir-only never matches a file");
  assert.equal(one("notes/sub", "notes/sub/a.png"), true);
  assert.equal(one("notes/*.png", "notes/sub/a.png"), false, "* never crosses /");
  assert.equal(one("notes/**/a.png", "notes/sub/deep/a.png"), true);
  assert.equal(one("**/x.png", "x.png"), true);
  assert.equal(one("notes/**", "notes/sub/a.png"), true);
  assert.equal(one("*.png\n!keep.png", "keep.png"), false, "the last matching line wins");
  assert.equal(one("secret/\n!secret/keep.png", "secret/keep.png"), true, "no re-include under an excluded dir");
  assert.equal(one("# planned.json\n\n", "planned.json"), false, "comments and blanks");
  assert.equal(one("\\#x.png", "#x.png"), true);
  assert.equal(one("x[0-9].png", "x7.png"), true);
  assert.equal(one("x?.png", "xy.png"), true);
  assert.equal(one("a.b", "aXb"), false, "a dot is literal");
});

test("isVaultIgnored: the file, nested files, and REQUIRED_IGNORES fail closed", async () => {
  const v = mkdtempSync(join(tmpdir(), "vi-"));
  try {
    assert.equal(await isVaultIgnored(v, "planned.json"), true, "no .gitignore: REQUIRED still applies");
    assert.equal(await isVaultIgnored(v, "content/x.lock"), true);
    assert.equal(await isVaultIgnored(v, "assets", true), true);
    assert.equal(await isVaultIgnored(v, "root.svg"), false);
    mkdirSync(join(v, "notes"), { recursive: true });
    writeFileSync(join(v, ".gitignore"), "secret/\n!planned.json\n");
    writeFileSync(join(v, "notes", ".gitignore"), "*.bak\n");
    // a fresh cache entry per directory: the module caches by directory; new dirs read fresh
    assert.equal(await isVaultIgnored(v, "notes/x.bak"), true, "nested .gitignore");
    assert.equal(await isVaultIgnored(v, "other/x.bak"), false, "nested rules stay in their dir");
    assert.equal(await isVaultIgnored(v, "notes/x.png"), false);
  } finally { rmSync(v, { recursive: true, force: true }); }
  const v2 = mkdtempSync(join(tmpdir(), "vi-"));
  try {
    writeFileSync(join(v2, ".gitignore"), "secret/\n!planned.json\n");
    assert.equal(await isVaultIgnored(v2, "secret/a b.png"), true, "the file's own line");
    assert.equal(await isVaultIgnored(v2, "planned.json"), true, "an operator re-include never publishes a state file");
  } finally { rmSync(v2, { recursive: true, force: true }); }
});

// The list is a copy (the image has no wiki-service code); in a checkout, it must equal the source.
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "wiki-service", "lib", "vault-gitignore.mjs");
test("REQUIRED_IGNORES = the wiki-service's list", { skip: !existsSync(SRC) && "no wiki-service in this tree (the image)" }, async () => {
  const ws = await import(pathToFileURL(SRC).href);
  assert.deepEqual(REQUIRED_IGNORES, ws.REQUIRED_IGNORES);
});
