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
// guard is what keeps a file of that NAME or that SHAPE out of the index.
//
// It reports PATHS and the rule that matched, never file contents.
//
// Use:
//   node recipes/_shared/oauth-secret-guard.mjs        # exit 1 if the index holds one
// The recipe test (oauth-secret-guard.test.mjs) runs it against this repo, and
// the ai-stack parent runs every recipe test on each OB1 gitlink bump.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Matched against the file's BASENAME, case-insensitively.
export const NAME_RULES = [
  { re: /^gmail-read-.*\.json$/i, why: "gmail-read-*.json (daily-digest Gmail OAuth file)" },
  { re: /^client_secret.*\.json$/i, why: "client_secret*.json (Google OAuth client secret)" },
  { re: /token.*\.json$/i, why: "*token*.json (OAuth token file)" },
  { re: /^credentials\.json$/i, why: "credentials.json (Google OAuth client file)" },
];

// Tracked paths that match a NAME rule but are known not to be secrets. Empty on
// purpose: add a path here, with a reason, rather than weakening a rule.
export const ALLOW = new Set([]);

const CONTENT_MAX_BYTES = 1024 * 1024;

const nonEmptyString = (v) => typeof v === "string" && v.length > 0;

// The JSON shapes Google OAuth files take: an authorized-user token
// (refresh_token), a downloaded client ("installed"/"web" with client_secret),
// or a flat client_id + client_secret pair.
export function oauthShape(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (nonEmptyString(obj.refresh_token)) return "JSON carries a refresh_token";
  for (const k of ["installed", "web"]) {
    if (obj[k] && typeof obj[k] === "object" && nonEmptyString(obj[k].client_secret)) {
      return `JSON carries ${k}.client_secret`;
    }
  }
  if (nonEmptyString(obj.client_secret) && nonEmptyString(obj.client_id)) {
    return "JSON carries client_id + client_secret";
  }
  return null;
}

function git(repoDir, args, opts = {}) {
  return execFileSync("git", ["-C", repoDir, ...args], {
    env: opts.env ?? process.env,
    input: opts.input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// Read many blobs with one `git cat-file --batch`. Returns Map<sha, Buffer>.
function readBlobs(repoDir, shas, env) {
  const out = new Map();
  if (shas.length === 0) return out;
  const buf = git(repoDir, ["cat-file", "--batch"], { env, input: shas.join("\n") + "\n" });
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

// Every index entry that looks like a Google OAuth token or client secret.
// Returns [{ path, why }]. Never returns or logs contents.
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
    .filter((e) => e.mode !== "160000"); // gitlinks are not files

  const hits = [];
  const jsonToRead = [];
  for (const e of entries) {
    if (ALLOW.has(e.path)) continue;
    const base = path.posix.basename(e.path);
    const rule = NAME_RULES.find((r) => r.re.test(base));
    if (rule) {
      hits.push({ path: e.path, why: rule.why });
    } else if (/\.json$/i.test(base)) {
      jsonToRead.push(e);
    }
  }

  const blobs = readBlobs(repoDir, [...new Set(jsonToRead.map((e) => e.sha))], env);
  for (const e of jsonToRead) {
    const b = blobs.get(e.sha);
    if (!b || b.length === 0 || b.length > CONTENT_MAX_BYTES) continue;
    let obj;
    try {
      obj = JSON.parse(b.toString("utf8"));
    } catch {
      continue;
    }
    const why = oauthShape(obj);
    if (why) hits.push({ path: e.path, why });
  }
  return hits.sort((a, b) => a.path.localeCompare(b.path));
}

function main() {
  const repoDir = process.argv[2] ?? process.cwd();
  const hits = findOAuthSecrets(repoDir);
  if (hits.length === 0) {
    console.log("oauth-secret-guard: no Google OAuth token/client-secret file in the index.");
    return 0;
  }
  console.error(`oauth-secret-guard: REFUSED - ${hits.length} OAuth-shaped file(s) in the index:`);
  for (const h of hits) console.error(`  ${h.path}  [${h.why}]`);
  console.error("Unstage them (git rm --cached <path>); real OAuth files live in the gitignored secrets/ tree.");
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
