// Tests for oauth-secret-guard.mjs (cf-gmail-untrack). Run: `node --test`.
// Every "secret" below is a DUMMY string written into a throwaway repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findOAuthSecrets, oauthShape } from "./oauth-secret-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, "oauth-secret-guard.mjs");

// A parent repo's hook exports GIT_DIR / GIT_INDEX_FILE, which override `-C`
// and would point every query below at the PARENT repo. Strip them.
const ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX|COMMON_DIR)$/.test(k)),
);
const g = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { env: ENV, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

function scratchRepo(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "oauth-guard-"));
  g(dir, "init", "-q");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  g(dir, "add", "-f", "--", ...Object.keys(files));
  return dir;
}
const paths = (hits) => hits.map((h) => h.path);

test("this repo: no OAuth token/client-secret file is tracked", () => {
  const root = g(HERE, "rev-parse", "--show-toplevel");
  const hits = findOAuthSecrets(root, { env: ENV });
  assert.deepEqual(hits, [], `tracked OAuth-shaped files: ${JSON.stringify(hits)}`);
});

test("this repo: the mount points Docker creates for the Gmail binds are gitignored", () => {
  const root = g(HERE, "rev-parse", "--show-toplevel");
  for (const p of [
    "recipes/daily-digest/gmail-read-token.json",
    "recipes/daily-digest/gmail-read-credentials.json",
    "recipes/daily-digest/token.json",
    "recipes/daily-digest/credentials.json",
    "recipes/daily-digest/calendar-token.json",
    "recipes/some-recipe/client_secret_123.apps.googleusercontent.com.json",
    "recipes/some-recipe/drive-token.json",
  ]) {
    const r = spawnSync("git", ["-C", root, "check-ignore", "-q", "--no-index", "--", p], { env: ENV });
    assert.equal(r.status, 0, `${p} is not gitignored`);
  }
});

test("refuses a staged file by NAME, even when it is empty", () => {
  const dir = scratchRepo({
    "recipes/daily-digest/gmail-read-token.json": "",
    "recipes/daily-digest/gmail-read-credentials.json": "",
    "recipes/x/client_secret_1-abc.apps.googleusercontent.com.json": "{}",
    "recipes/x/calendar-token.json": "{}",
    "tools/credentials.json": "{}",
  });
  try {
    assert.deepEqual(paths(findOAuthSecrets(dir, { env: ENV })), [
      "recipes/daily-digest/gmail-read-credentials.json",
      "recipes/daily-digest/gmail-read-token.json",
      "recipes/x/calendar-token.json",
      "recipes/x/client_secret_1-abc.apps.googleusercontent.com.json",
      "tools/credentials.json",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses an innocently named JSON by SHAPE", () => {
  const dir = scratchRepo({
    "recipes/a/config.json": JSON.stringify({ client_id: "x", refresh_token: "DUMMY-refresh" }),
    "recipes/b/oauth.json": JSON.stringify({ installed: { client_id: "x", client_secret: "DUMMY-secret" } }),
    "recipes/c/app.json": JSON.stringify({ web: { client_secret: "DUMMY-secret" } }),
    "recipes/d/flat.json": JSON.stringify({ client_id: "x", client_secret: "DUMMY-secret" }),
  });
  try {
    assert.deepEqual(paths(findOAuthSecrets(dir, { env: ENV })), [
      "recipes/a/config.json",
      "recipes/b/oauth.json",
      "recipes/c/app.json",
      "recipes/d/flat.json",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("passes ordinary files (no false positives on this repo's usual shapes)", () => {
  const dir = scratchRepo({
    "recipes/a/metadata.json": JSON.stringify({ name: "a", requires: { services: ["x"] } }),
    "recipes/a/package.json": JSON.stringify({ name: "a", version: "1.0.0" }),
    "recipes/a/empty-token-field.json": "", // name has "token" -> caught by name; excluded below
    "recipes/a/blank.json": JSON.stringify({ refresh_token: "", client_secret: "" }),
    "recipes/a/secret-only.json": JSON.stringify({ client_secret: "no client id alongside" }),
    "recipes/a/list.json": JSON.stringify([{ refresh_token: "arrays are not OAuth files" }]),
    "recipes/a/broken.json": "{ not json",
    "recipes/a/tokenizer.md": "tokens",
    "recipes/a/.env.example": "GMAIL_READ_TOKEN=/app/gmail-read-token.json",
  });
  try {
    assert.deepEqual(paths(findOAuthSecrets(dir, { env: ENV })), ["recipes/a/empty-token-field.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oauthShape: the three Google shapes, nothing else", () => {
  assert.ok(oauthShape({ refresh_token: "r" }));
  assert.ok(oauthShape({ installed: { client_secret: "s" } }));
  assert.ok(oauthShape({ client_id: "i", client_secret: "s" }));
  assert.equal(oauthShape({ access_token: "a" }), null);
  assert.equal(oauthShape(null), null);
  assert.equal(oauthShape("refresh_token"), null);
});

test("CLI: exit 1 naming the paths, and never printing a file's contents", () => {
  const dir = scratchRepo({
    "recipes/daily-digest/gmail-read-token.json": JSON.stringify({ refresh_token: "DUMMY-VALUE-MUST-NOT-PRINT" }),
    "recipes/a/config.json": JSON.stringify({ installed: { client_secret: "DUMMY-VALUE-MUST-NOT-PRINT" } }),
  });
  try {
    const r = spawnSync(process.execPath, [GUARD, dir], { env: ENV, encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /REFUSED/);
    assert.match(r.stderr, /recipes\/daily-digest\/gmail-read-token\.json/);
    assert.match(r.stderr, /recipes\/a\/config\.json/);
    assert.doesNotMatch(r.stdout + r.stderr, /DUMMY-VALUE-MUST-NOT-PRINT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: exit 0 on a clean index", () => {
  const dir = scratchRepo({ "recipes/a/metadata.json": "{}" });
  try {
    const r = spawnSync(process.execPath, [GUARD, dir], { env: ENV, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
