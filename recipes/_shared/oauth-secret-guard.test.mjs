// Tests for oauth-secret-guard.mjs (cf-gmail-untrack). Run: `node --test`.
// Every "secret" below is a DUMMY string written into a throwaway repo. The
// token-shaped dummies are assembled at runtime so this tracked file does not
// itself carry a token shape.
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
const BOM = "﻿";
const FILL = "DummyValue_0123456789-abcdefghij";
const ACCESS = "ya" + "29." + FILL;
const REFRESH = "1/" + "/0" + FILL;
const CLIENT_SECRET = "GOC" + "SPX-" + FILL;

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
function hitsFor(files) {
  const dir = scratchRepo(files);
  try {
    return findOAuthSecrets(dir, { env: ENV }).map((h) => h.path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const ignored = (root, p) => spawnSync("git", ["-C", root, "check-ignore", "-q", "--no-index", "--", p], { env: ENV }).status === 0;

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
    "recipes/some-recipe/oauth_token.json",
  ]) {
    assert.ok(ignored(root, p), `${p} is not gitignored`);
  }
});

test("this repo: ordinary token-ish names stay trackable (not gitignored)", () => {
  const root = g(HERE, "rev-parse", "--show-toplevel");
  for (const p of ["recipes/some-recipe/tokenizer.json", "recipes/some-recipe/design-tokens.json"]) {
    assert.ok(!ignored(root, p), `${p} is gitignored`);
  }
});

test("refuses a staged file by NAME, even when it is empty", () => {
  assert.deepEqual(
    hitsFor({
      "recipes/daily-digest/gmail-read-token.json": "",
      "recipes/daily-digest/gmail-read-credentials.json": "",
      "recipes/x/client_secret_1-abc.apps.googleusercontent.com.json": "{}",
      "recipes/x/calendar-token.json": "{}",
      "recipes/x/oauth_token.json": "{}",
      "recipes/x/token.json": "{}",
      "tools/credentials.json": "{}",
    }),
    [
      "recipes/daily-digest/gmail-read-credentials.json",
      "recipes/daily-digest/gmail-read-token.json",
      "recipes/x/calendar-token.json",
      "recipes/x/client_secret_1-abc.apps.googleusercontent.com.json",
      "recipes/x/oauth_token.json",
      "recipes/x/token.json",
      "tools/credentials.json",
    ],
  );
});

test("refuses an innocently named JSON by SHAPE, at any depth", () => {
  assert.deepEqual(
    hitsFor({
      "recipes/a/config.json": JSON.stringify({ client_id: "x", refresh_token: "DUMMY" }),
      "recipes/b/oauth.json": JSON.stringify({ installed: { client_id: "x", client_secret: "DUMMY" } }),
      "recipes/c/app.json": JSON.stringify({ web: { client_secret: "DUMMY" } }),
      "recipes/d/flat.json": JSON.stringify({ client_id: "x", client_secret: "DUMMY" }),
      "recipes/e/lone.json": JSON.stringify({ client_secret: "DUMMY" }),
      "recipes/f/nested.json": JSON.stringify({ creds: { google: { refresh_token: "DUMMY" } } }),
      "recipes/g/list.json": JSON.stringify([{ refresh_token: "DUMMY" }]),
      "recipes/h/Upper.JSON": JSON.stringify({ refresh_token: "DUMMY" }),
    }),
    [
      "recipes/a/config.json",
      "recipes/b/oauth.json",
      "recipes/c/app.json",
      "recipes/d/flat.json",
      "recipes/e/lone.json",
      "recipes/f/nested.json",
      "recipes/g/list.json",
      "recipes/h/Upper.JSON",
    ],
  );
});

test("a UTF-8 BOM or unparseable JSON does not hide the keys (attempt-1 bypass)", () => {
  assert.deepEqual(
    hitsFor({
      // PowerShell 5.1 Out-File / `>` write a BOM; JSON.parse throws on it.
      "recipes/x/e.json": BOM + JSON.stringify({ refresh_token: "DUMMY" }),
      "recipes/x/f.json": BOM + JSON.stringify({ nested: [{ client_secret: "DUMMY" }] }),
      "recipes/x/trailing-comma.json": '{"refresh_token": "DUMMY",}',
      "recipes/x/json5.json": "{client_secret: 'DUMMY'}",
      "recipes/x/truncated.json": '{"installed": {"client_secret": "DUMMY"',
    }),
    [
      "recipes/x/e.json",
      "recipes/x/f.json",
      "recipes/x/json5.json",
      "recipes/x/trailing-comma.json",
      "recipes/x/truncated.json",
    ],
  );
});

test("Google token VALUE shapes are refused in any file type", () => {
  assert.deepEqual(
    hitsFor({
      "notes/g.txt": `access ${ACCESS}\n`,
      "recipes/x/client.ts": `const s = "${CLIENT_SECRET}";\n`,
      "docs/setup.md": `refresh: ${REFRESH}\n`,
      "recipes/x/access.json": JSON.stringify({ token: ACCESS }),
      "recipes/x/bom.json": BOM + JSON.stringify({ t: REFRESH }),
    }),
    ["docs/setup.md", "notes/g.txt", "recipes/x/access.json", "recipes/x/bom.json", "recipes/x/client.ts"],
  );
});

test("passes ordinary files (no false positives on this repo's usual shapes)", () => {
  assert.deepEqual(
    hitsFor({
      "recipes/a/metadata.json": JSON.stringify({ name: "a", requires: { services: ["x"] } }),
      "recipes/a/package.json": JSON.stringify({ name: "a", version: "1.0.0" }),
      "recipes/a/tokenizer.json": JSON.stringify({ vocab: { a: 1 } }),
      "recipes/a/design-tokens.json": JSON.stringify({ color: { primary: "#000" } }),
      "recipes/a/blank.json": BOM + JSON.stringify({ refresh_token: "", client_secret: "" }),
      "recipes/a/broken.json": "{ not json",
      "recipes/a/tokenizer.md": "tokens; ya29. and GOCSPX- mentioned as prefixes only",
      "recipes/a/client.ts": "body: { refresh_token: token.refresh_token, client_secret: creds.client_secret }",
      "recipes/a/.env.example": "GMAIL_READ_TOKEN=/app/gmail-read-token.json",
    }),
    [],
  );
});

test("oauthShape: secret keys at any depth, nothing else", () => {
  assert.ok(oauthShape({ refresh_token: "r" }));
  assert.ok(oauthShape({ installed: { client_secret: "s" } }));
  assert.ok(oauthShape({ client_secret: "s" }));
  assert.ok(oauthShape([[{ a: { refresh_token: "r" } }]]));
  assert.equal(oauthShape({ access_token: "a", client_id: "i" }), null);
  assert.equal(oauthShape({ refresh_token: "" }), null);
  assert.equal(oauthShape(null), null);
  assert.equal(oauthShape("refresh_token"), null);
});

test("CLI: exit 1 naming the paths, and never printing a file's contents", () => {
  const dir = scratchRepo({
    "recipes/daily-digest/gmail-read-token.json": JSON.stringify({ refresh_token: "DUMMY-VALUE-MUST-NOT-PRINT" }),
    "recipes/a/config.json": BOM + JSON.stringify({ installed: { client_secret: "DUMMY-VALUE-MUST-NOT-PRINT" } }),
    "recipes/a/x.ts": `const s = "${CLIENT_SECRET}";`,
  });
  try {
    const r = spawnSync(process.execPath, [GUARD, dir], { env: ENV, encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /REFUSED/);
    assert.match(r.stderr, /recipes\/daily-digest\/gmail-read-token\.json/);
    assert.match(r.stderr, /recipes\/a\/config\.json/);
    assert.match(r.stderr, /recipes\/a\/x\.ts/);
    assert.doesNotMatch(r.stdout + r.stderr, /DUMMY-VALUE-MUST-NOT-PRINT/);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(FILL));
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
