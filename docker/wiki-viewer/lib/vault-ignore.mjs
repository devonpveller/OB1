// vault-ignore - what the vault's .gitignore keeps OUT of the viewer
// (research-workbench rw-p1c-retire2, review r-p1c).
//
// The retired builder ran Quartz over the vault with `gitignore: true`, so it
// never published a file the vault's .gitignore lists - the wiki-service's
// state files above all (planned.json: every entity id and name, incl. the
// unlinked ones with no page; the ledgers and their *.lock files). Since P1c
// the viewer reads attachments from the vault itself, so it must refuse the
// same set: isVaultIgnored(vault, rel) is true for every path a .gitignore in
// the vault (the root one and any nested one, as git and globby read them)
// excludes, OR that the wiki-service's REQUIRED_IGNORES exclude.
//
// FAIL CLOSED: REQUIRED_IGNORES apply whatever the file says - a missing or
// unreadable .gitignore, or an operator line that re-includes (!planned.json),
// never makes a state file public. The list is a COPY of
// OB1/docker/wiki-service/lib/vault-gitignore.mjs REQUIRED_IGNORES (the viewer
// image carries no wiki-service code); vault-ignore.test.mjs fails when the
// two differ.
//
// The matcher is git's rule set for one file: blank lines and # comments are
// skipped; "!" re-includes; "\" escapes a leading # or !; a trailing "/"
// matches directories only; a pattern with a "/" elsewhere is anchored to the
// .gitignore's directory, else it matches a name at any depth; "*", "?",
// "[...]" never cross "/", "**/" / "/**" / "/**/" span directories; the last
// matching line wins; a path under an excluded directory is excluded (git
// cannot re-include a file whose parent is excluded).
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const REQUIRED_IGNORES = [
  ".quartz-cache/",
  "public/",
  "node_modules/",
  ".wikistate.json",
  "assets/",
  ".failed-entity-ids.json",
  "planned.json",
  ".compile-notifications.jsonl",
  ".structural-failures.json",
  ".unsynced-rows.json",
  ".unsynced-rows.json.lock",
  "*.lock",
  ".structural-failures.json.tmp-*",
  ".unsynced-rows.json.tmp-*",
  ".*.wp-staged-*",
];

function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const before = i === 0 || glob[i - 1] === "/";
        const after = glob[i + 2] === "/" || i + 2 === glob.length;
        if (before && after) {
          if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
          continue;
        }
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end < 0) { re += "\\["; continue; }
      let body = glob.slice(i + 1, end);
      if (body[0] === "!") body = "^" + body.slice(1);
      re += "[" + body.replace(/\\/g, "\\\\") + "]";
      i = end;
    } else if (c === "\\" && i + 1 < glob.length) { re += "\\" + glob[++i]; }
    else re += /[.+^${}()|\]\\/]/.test(c) ? "\\" + c : c;
  }
  return re;
}

/** text of one .gitignore -> [{ re, negate, dirOnly }] (paths relative to its directory) */
export function parseGitignore(text) {
  const rules = [];
  for (let line of String(text || "").split(/\r?\n/)) {
    line = line.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) { negate = true; line = line.slice(1); }
    else if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith("/")) { dirOnly = true; line = line.replace(/\/+$/, ""); }
    if (!line) continue;
    const anchored = line.includes("/");
    const body = globToRegex(line.replace(/^\//, ""));
    rules.push({ re: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`), negate, dirOnly });
  }
  return rules;
}

/** the last matching rule decides; undefined = no rule matches */
function decide(rules, rel, isDir) {
  let v;
  for (const r of rules) if ((!r.dirOnly || isDir) && r.re.test(rel)) v = !r.negate;
  return v;
}

/**
 * rel (vault-relative, "/"-separated; a file unless leafIsDir) against rule sets in vault order:
 * [{ base: "" | "a/b", rules }]. Each ancestor directory is tested first: one
 * excluded ancestor excludes the file.
 */
export function ignoredBy(sets, rel, leafIsDir = false) {
  const parts = rel.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/");
    const isDir = i < parts.length || leafIsDir;
    let v;
    for (const { base, rules } of sets) {
      if (base && !(p === base || p.startsWith(base + "/"))) continue;
      if (base && p === base) continue; // a .gitignore never matches its own directory
      const d = decide(rules, base ? p.slice(base.length + 1) : p, isDir);
      if (d !== undefined) v = d; // a deeper .gitignore overrides a shallower one
    }
    if (v) return true;
  }
  return false;
}

const REQUIRED = [{ base: "", rules: parseGitignore(REQUIRED_IGNORES.join("\n")) }];
const TTL_MS = Math.max(1_000, Number(process.env.WIKI_GITIGNORE_TTL_MS || "5000"));
const _cache = new Map(); // abs dir -> { at, rules }

async function rulesOf(vault, base) {
  const dir = base ? join(vault, base) : vault;
  const hit = _cache.get(dir);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rules;
  let rules = [];
  try { rules = parseGitignore(await readFile(join(dir, ".gitignore"), "utf8")); } catch { /* absent or unreadable: REQUIRED still applies */ }
  _cache.set(dir, { at: Date.now(), rules });
  return rules;
}

/** true when the vault's .gitignore files, or REQUIRED_IGNORES, exclude rel (a directory when isDir) */
export async function isVaultIgnored(vault, rel, isDir = false) {
  if (ignoredBy(REQUIRED, rel, isDir)) return true;
  const parts = rel.split("/").filter(Boolean);
  const sets = [];
  for (let i = 0; i < parts.length; i++) {
    const base = parts.slice(0, i).join("/");
    const rules = await rulesOf(vault, base);
    if (rules.length) sets.push({ base, rules });
  }
  return ignoredBy(sets, rel, isDir);
}
