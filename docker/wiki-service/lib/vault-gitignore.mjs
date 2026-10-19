/**
 * vault-gitignore - the wiki-service's entries in the VAULT's .gitignore
 * (rw-p1a-deploy-prep, reviewer RV-5).
 *
 * The service commits the vault with `git add -A`, so every state file it (or
 * a recipe it runs) writes into the vault must be ignored, or it is committed
 * and pushed with the wiki. Before this the service REWROTE the file wholesale
 * whenever one entry was missing: an operator's own lines were lost on the
 * first boot of an image that added an entry, and the P1a ledgers
 * (.structural-failures.json, .unsynced-rows.json, their *.lock files) were
 * not ignored at all.
 *
 * mergeGitignore() is PURE: it keeps EVERY existing line, byte for byte and in
 * order, and appends only the required entries no line already names exactly
 * (a trimmed, whole-line comparison - "notplanned.json" does not stand in for
 * "planned.json"). Nothing missing -> the text is returned unchanged and the
 * file is not written.
 */

// Every entry the service needs ignored, in the order a fresh file lists them.
export const REQUIRED_IGNORES = [
  ".quartz-cache/",
  "public/",
  "node_modules/",
  ".wikistate.json",
  "assets/",
  ".failed-entity-ids.json",
  "planned.json",
  ".compile-notifications.jsonl",
  // rw-p1a-render's ledgers (content/ = the compile's out-dir) and their locks
  ".structural-failures.json",
  ".unsynced-rows.json",
  ".unsynced-rows.json.lock",
  "*.lock",
  // their write-then-rename temp files, left only by a crash mid-write
  ".structural-failures.json.tmp-*",
  ".unsynced-rows.json.tmp-*",
];

const HEADER = "# openbrain-wiki: state files the wiki-service and its recipes write (never committed)";

/** -> { text, added: [entries appended], changed: boolean } */
export function mergeGitignore(current, required = REQUIRED_IGNORES) {
  const cur = typeof current === "string" ? current : "";
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const missing = required.filter((e) => !have.has(e));
  if (!missing.length) return { text: cur, added: [], changed: false };
  const eol = cur.includes("\r\n") ? "\r\n" : "\n";
  let text = cur;
  if (text && !text.endsWith("\n")) text += eol;
  if (!have.has(HEADER)) text += HEADER + eol;
  text += missing.join(eol) + eol;
  return { text, added: missing, changed: true };
}
