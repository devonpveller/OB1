/**
 * structural-ledger - the compile's OPEN structural failures (research-
 * workbench D13 item 6: "no retry, loud on the first occurrence ... the ledger
 * does NOT re-queue it (it would fail identically every cycle); the
 * reconciliation check keeps listing it until it is fixed").
 *
 * A structural failure is recorded per page (key "entity:<id>" or
 * "notebook:<thread id>") with its slug, the error, the hash of the reply
 * that failed (when there was one) and the hash of the page's INPUTS. A later
 * run SKIPS the page while its inputs are unchanged - no LLM call, no second
 * notification - and retries it once its inputs change:
 *   entity    the entity row's updated_at (bumped by every extraction, i.e. a
 *             new source revision), the model, and the compile code
 *   notebook  the hub's synthesis input hash (sources + model), and the code
 * "The code" is a hash of the recipe files, so a patch that lands retries
 * every open failure once ("never presented until a patch lands"). A manual
 * clear: `generate-wiki.mjs --clear-structural <id,...|all>`, or delete the
 * file. A page that compiles cleanly leaves the ledger.
 *
 * One notification per DISTINCT failure: a recorded failure that recurs with
 * the same slug, error and reply hash (inputs changed, same outcome) is
 * logged, not notified again.
 *
 * The file lives beside the failed-ids ledger: <out-dir>/.structural-failures.json
 * (WIKI_STRUCTURAL_FILE overrides). PURE apart from the read/write helpers.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const STRUCTURAL_FILE = ".structural-failures.json";

export const sha256 = (s) => crypto.createHash("sha256").update(String(s ?? "")).digest("hex");

export function ledgerPath(outDir) {
  return process.env.WIKI_STRUCTURAL_FILE ||
    path.join(outDir || process.env.OB_WIKI_OUT_DIR || "./wikis", STRUCTURAL_FILE);
}

// Read the ledger. A missing file is an empty ledger; an unreadable one is
// reported and read as empty (every open failure is retried ONCE - loud, not
// silent, and never a crash of the compile).
export function readLedger(outDir, file = ledgerPath(outDir)) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { failures: {} };
  }
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object" && j.failures && typeof j.failures === "object") return { failures: { ...j.failures } };
  } catch { /* fall through */ }
  console.error(`[structural] ledger ${file} is unreadable; reading it as empty (open failures are retried once)`);
  return { failures: {} };
}

// Stable on disk: sorted keys, written only when the content changed, via a
// temp file + rename (a reader never sees half a ledger).
export function writeLedger(outDir, ledger, file = ledgerPath(outDir)) {
  const sorted = Object.fromEntries(Object.entries(ledger.failures).sort(([a], [b]) => a.localeCompare(b)));
  const text = JSON.stringify({ failures: sorted }, null, 2) + "\n";
  let prev = null;
  try { prev = fs.readFileSync(file, "utf8"); } catch { /* none */ }
  if (prev === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return true;
}

// The compile code's fingerprint: every .mjs in recipes/_shared plus the
// caller's own recipe file(s). Memoised per process.
const _codeMemo = new Map();
export function codeFingerprint(extraFiles = []) {
  const key = extraFiles.join("\u001f");
  if (_codeMemo.has(key)) return _codeMemo.get(key);
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = [
    ...fs.readdirSync(dir).filter((n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs")).sort().map((n) => path.join(dir, n)),
    ...extraFiles,
  ];
  const h = crypto.createHash("sha256");
  for (const f of files) {
    h.update(path.basename(f));
    try { h.update(fs.readFileSync(f)); } catch { h.update("(unreadable)"); }
  }
  const out = h.digest("hex");
  _codeMemo.set(key, out);
  return out;
}

export const inputsKey = (parts) => sha256(JSON.stringify(parts));
export const failureKey = ({ slug, error, replySha256 }) => sha256([slug, error, replySha256 ?? ""].join("\u001f"));

/** The open failure for `key` whose inputs are unchanged, or null. */
export function openFailure(ledger, key, inputs) {
  const e = ledger.failures[key];
  return e && e.inputs === inputs ? e : null;
}

/**
 * Record a structural failure. Returns { entry, distinct }: distinct is false
 * when the same page already failed the same way (same slug, error and reply
 * hash) - the caller then does not notify again.
 */
export function recordFailure(ledger, { key, slug, entity = null, error, replySha256 = null, inputs }, now = new Date().toISOString()) {
  const fk = failureKey({ slug, error, replySha256 });
  const prev = ledger.failures[key];
  const distinct = !prev || prev.failure_key !== fk;
  const entry = {
    key, slug, entity: entity == null ? null : String(entity),
    error: String(error).slice(0, 1000), reply_sha256: replySha256, inputs, failure_key: fk,
    first_seen: distinct ? now : prev.first_seen, last_seen: now,
    occurrences: distinct ? 1 : (prev.occurrences || 1) + 1,
  };
  ledger.failures[key] = entry;
  return { entry, distinct };
}

export function clearFailure(ledger, key) {
  if (!(key in ledger.failures)) return false;
  delete ledger.failures[key];
  return true;
}

/** Every open failure (for the reconciliation report and /status). */
export function listOpen(outDir, file = ledgerPath(outDir)) {
  return Object.values(readLedger(outDir, file).failures).sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
}
