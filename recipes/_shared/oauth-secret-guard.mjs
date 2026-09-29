// Refuse Google OAuth tokens and client secrets in the git INDEX.
//
// Why (2026-09-29, cf-gmail-untrack): this fork is public, and since 6594759
// (2026-06-10) it tracked recipes/daily-digest/gmail-read-token.json and
// gmail-read-credentials.json. Those two were the 0-byte mount points Docker
// creates when docker-compose.scheduled.yml binds the real files from
// ../secrets/google/open-brain-email/ over /app/gmail-read-*.json inside the
// ../recipes/daily-digest:/app bind - but the path names are exactly where a
// real refresh token or client secret lands if one is ever copied next to the
// recipe, and nothing refused it. They are untracked and gitignored now; this
// guard is what keeps a file of that NAME or that CONTENT out of the index.
//
// It reports PATHS and the rule that matched, never file contents.
//
// Use:
//   node recipes/_shared/oauth-secret-guard.mjs [repo]   # exit 1 if the index holds one
// The recipe test (oauth-secret-guard.test.mjs) runs it against this repo, and
// the ai-stack parent runs every recipe test on each OB1 gitlink bump.
//
// It refuses rather than emulates: a heuristic that says "looks like a secret"
// is enough to stop a commit; a false refusal is fixed with an ALLOW entry.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Matched against the file's BASENAME, case-insensitively. Deliberately narrow
// (attempt 2): an unanchored /token.*\.json/ refused tokenizer.json and
// design-tokens.json. What a name cannot tell, the CONTENT rules below decide.
export const NAME_RULES = [
  { re: /^gmail-.*\.json$/i, why: "gmail-*.json (Gmail OAuth file name)" },
  { re: /^client_secret.*\.json$/i, why: "client_secret*.json (Google OAuth client secret)" },
  { re: /^token\.json$/i, why: "token.json (OAuth token file)" },
  { re: /[-_]token\.json$/i, why: "*-token.json / *_token.json (OAuth token file)" },
  { re: /oauth.*token.*\.json$/i, why: "*oauth*token*.json (OAuth token file)" },
  { re: /^credentials\.json$/i, why: "credentials.json (Google OAuth client file)" },
];

// Google credential VALUE shapes, searched in the raw text of every tracked,
// non-binary blob up to 1 MiB, of ANY file type, and in every tracked PATH
// (attempt 3: a token pasted as a file name): an access token (ya29., including
// the dotted ya29.c. service-account form), a refresh token (1//0) and an OAuth
// client secret (GOCSPX-). The 20-character floor keeps prose, and these
// patterns as written here, from matching.
export const TOKEN_SHAPES = [
  { re: /ya29\.[0-9A-Za-z_.-]{20,}/, why: "Google access token shape (ya29.)" },
  { re: /1\/\/0[0-9A-Za-z_-]{20,}/, why: "Google refresh token shape (1//0)" },
  { re: /GOCSPX-[0-9A-Za-z_-]{20,}/, why: "Google OAuth client secret shape (GOCSPX-)" },
];

// OAuth secret KEYS. In parsed JSON they count at any depth, arrays included.
const SECRET_KEYS = ["refresh_token", "client_secret"];
// For a .json that does not parse (a trailing comma, JSON5, a truncated file):
// the same keys with a non-empty string value, read from the raw text.
const RAW_SECRET_KEY = /["']?(refresh_token|client_secret)["']?\s*:\s*["'][^"'\s]/;

// Tracked paths that are known not to be secrets although a rule matches. Empty
// on purpose: add a path here, with a reason, rather than weakening a rule.
export const ALLOW = new Set([]);

const CONTENT_MAX_BYTES = 1024 * 1024;

const nonEmptyString = (v) => typeof v === "string" && v.length > 0;

// A refresh_token or client_secret with a non-empty string value, at ANY depth
// (objects and arrays). A lone client_secret counts; no client_id is required.
export function oauthShape(value, depth = 0) {
  if (depth > 64 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = oauthShape(v, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const k of SECRET_KEYS) {
    if (nonEmptyString(value[k])) return `JSON carries a ${k}`;
  }
  for (const v of Object.values(value)) {
    const r = oauthShape(v, depth + 1);
    if (r) return r;
  }
  return null;
}

// Why a blob looks like a Google OAuth secret, or null. Never returns content.
export function contentReason(buf, isJson) {
  if (!buf || buf.length === 0 || buf.length > CONTENT_MAX_BYTES) return null;
  if (buf.subarray(0, 8000).includes(0)) return null; // binary
  // Strip a UTF-8 BOM: PowerShell 5.1's Out-File and `>` write one by default,
  // and JSON.parse throws on it (attempt 1's bypass).
  const text = buf.toString("utf8").replace(/^﻿/, "");
  // JSON-escaped slashes ("1\/\/0...", PHP json_encode's default) hide the
  // refresh-token shape from a raw search: also search a copy with \/ read as /.
  const unescaped = text.replace(/\\\//g, "/");
  for (const t of TOKEN_SHAPES) if (t.re.test(text) || t.re.test(unescaped)) return t.why;
  if (!isJson) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    // Unparseable is suspicious, not skipped: fall back to the raw text.
    return RAW_SECRET_KEY.test(text) ? "unparseable JSON with a refresh_token/client_secret key" : null;
  }
  return oauthShape(obj);
}

function git(repoDir, args, opts = {}) {
  return execFileSync("git", ["-C", repoDir, ...args], {
    env: opts.env ?? process.env,
    input: opts.input,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// Read blobs with `git cat-file --batch`, skipping any over the size cap (sizes
// come from --batch-check first). Returns Map<sha, Buffer>.
function readBlobs(repoDir, shas, env) {
  const out = new Map();
  if (shas.length === 0) return out;
  const small = git(repoDir, ["cat-file", "--batch-check"], { env, input: shas.join("\n") + "\n" })
    .toString("utf8")
    .split("\n")
    .map((l) => l.split(" "))
    .filter((f) => f[1] === "blob" && Number(f[2]) > 0 && Number(f[2]) <= CONTENT_MAX_BYTES)
    .map((f) => f[0]);
  if (small.length === 0) return out;
  const buf = git(repoDir, ["cat-file", "--batch"], { env, input: small.join("\n") + "\n" });
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString("utf8").split(" ");
    pos = nl + 1;
    if (header[1] === "missing") continue;
    const size = Number(header[2]);
    out.set(header[0], buf.subarray(pos, pos + size));
    pos += size + 1; // content + trailing LF
  }
  return out;
}

// Every index entry that looks like a Google OAuth token or client secret, by
// NAME or by CONTENT. Returns [{ path, why }]. Never returns or logs contents.
export function findOAuthSecrets(repoDir, { env } = {}) {
  const raw = git(repoDir, ["ls-files", "-z", "--stage"], { env }).toString("utf8");
  const entries = raw
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, sha] = line.slice(0, tab).split(" ");
      return { mode, sha, path: line.slice(tab + 1) };
    })
    .filter((e) => e.mode !== "160000" && !ALLOW.has(e.path)); // gitlinks are not files

  const hits = [];
  const toRead = [];
  for (const e of entries) {
    const rule = NAME_RULES.find((r) => r.re.test(path.posix.basename(e.path)));
    const shape = TOKEN_SHAPES.find((t) => t.re.test(e.path));
    if (rule) hits.push({ path: e.path, why: rule.why });
    else if (shape) hits.push({ path: e.path, why: `${shape.why} in the file NAME` });
    else toRead.push(e);
  }

  const blobs = readBlobs(repoDir, [...new Set(toRead.map((e) => e.sha))], env);
  for (const e of toRead) {
    const why = contentReason(blobs.get(e.sha), /\.json$/i.test(e.path));
    if (why) hits.push({ path: e.path, why });
  }
  return hits.sort((a, b) => a.path.localeCompare(b.path));
}

// A path can itself carry a token (a file NAMED after one). Printing it would
// put the value in the hook's output, so the token-shaped part is masked.
export function redactPath(p) {
  let out = p;
  for (const t of TOKEN_SHAPES) out = out.replace(new RegExp(t.re.source, "g"), "<token-shaped>");
  return out;
}

// Throw a plain Error naming the MASKED paths when the index holds a secret.
// For tests: node's assert.deepEqual(hits, [], msg) appends an actual/expected
// diff and the TAP reporter an `actual:` block, both with the RAW paths
// (attempt-3 finding) - a plain Error carries only this message.
export function assertNoOAuthSecrets(repoDir, opts = {}) {
  const hits = findOAuthSecrets(repoDir, opts);
  if (hits.length === 0) return;
  const lines = hits.map((h) => `  ${redactPath(h.path)}  [${h.why}]`);
  throw new Error(`${hits.length} OAuth-shaped file(s) in the index:\n${lines.join("\n")}`);
}

function main() {
  const repoDir = process.argv[2] ?? process.cwd();
  const hits = findOAuthSecrets(repoDir);
  if (hits.length === 0) {
    console.log("oauth-secret-guard: no Google OAuth token/client-secret file in the index.");
    return 0;
  }
  console.error(`oauth-secret-guard: REFUSED - ${hits.length} OAuth-shaped file(s) in the index:`);
  for (const h of hits) console.error(`  ${redactPath(h.path)}  [${h.why}]`);
  console.error("Unstage them (git rm --cached <path>); real OAuth files live in the gitignored secrets/ tree.");
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
