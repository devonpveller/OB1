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
 * Every CHANGE is a locked read-modify-write transaction (updateLedger) -
 * see "the ledger LOCK" below.
 */
import fs from "node:fs";
import os from "node:os";
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
const _warnedUnreadable = new Set(); // once per file per process (it is read per check)
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
  if (!_warnedUnreadable.has(file)) {
    _warnedUnreadable.add(file);
    console.error(`[structural] ledger ${file} is unreadable; reading it as empty (open failures are retried once)`);
  }
  return { failures: {} };
}

// Stable on disk: sorted keys, written only when the content changed, via a
// temp file + rename (a reader never sees half a ledger). The temp name
// carries host + pid + a random part: every one-off container runs node as
// pid 1, so a pid alone is not unique on a shared volume (tester AT2-4).
// Callers that MODIFY the ledger go through updateLedger() (locked).
export function writeLedger(outDir, ledger, file = ledgerPath(outDir)) {
  const sorted = Object.fromEntries(Object.entries(ledger.failures).sort(([a], [b]) => a.localeCompare(b)));
  const text = JSON.stringify({ failures: sorted }, null, 2) + "\n";
  let prev = null;
  try { prev = fs.readFileSync(file, "utf8"); } catch { /* none */ }
  if (prev === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return true;
}

// ── the ledger LOCK (rw-p1a-render attempt 3, tester AT2-4) ─────────────────
// The ledger used to be read at run start and rewritten whole at run end, so
// two compiles racing lost one's entries (an extra LLM call and a third
// notification for two failures), and a --clear-structural during a compile
// was written back by it. Now every change is one locked transaction:
// lock -> RE-READ the file -> apply this change -> write -> unlock. A run
// writes only its own changes (deltas), never its start-of-run copy, so a
// clear made while it ran is never resurrected and another run's entries are
// never lost; and "distinct" (notify or not) is decided against the file as
// it is at that moment, so two racing failures of one page notify once.
// The lock is a lockfile <ledger>.lock created O_EXCL holding
// { owner, host, pid, acquired, expires }. A lock is STALE (a crashed holder)
// once past its expiry - or when its expiry lies beyond a sane ceiling
// (more than 2 x the stale time from now: a clock jump or a hand-made lock is
// never trusted; tester NA3-2) - or, unreadable, when its mtime is older than
// the stale time; a stale lock is taken over. Waiting is bounded and
// ALWAYS sleeps between attempts: a takeover that fails (a read-only
// directory, a lock path that is a directory - tester NA3-1: the old loop
// `continue`d past the deadline and the sleep and spun at 100 % CPU) is
// retried until the deadline and then throws naming the holder and the
// error. The wait (WIKI_LEDGER_LOCK_WAIT_MS, default 45 s) must exceed the
// stale time (WIKI_LEDGER_LOCK_STALE_MS, default 30 s), so a run starting
// right after a holder crashed takes over instead of failing (NA3-2: it was
// 20 s < 30 s); lockTimes() refuses a configuration that breaks it. Hold
// times are milliseconds (no LLM call is ever made under the lock).
export function lockTimes(env = process.env) {
  const staleMs = Math.max(1000, Number(env.WIKI_LEDGER_LOCK_STALE_MS || "30000"));
  const waitMs = Math.max(0, Number(env.WIKI_LEDGER_LOCK_WAIT_MS || "45000"));
  if (!(waitMs > staleMs)) {
    throw new Error(`structural ledger lock: WIKI_LEDGER_LOCK_WAIT_MS (${waitMs}) must exceed WIKI_LEDGER_LOCK_STALE_MS (${staleMs}) ` +
      "- a run starting right after a crashed holder must outwait its lock and take it over, not fail");
  }
  return { staleMs, waitMs };
}
const LOCK_SLEEP_MS = 25;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Why a held lock (parsed content `held`, mtime `mtimeMs`) is stale, or null
// while it is live.
function staleReason(held, mtimeMs, staleMs, now = Date.now()) {
  const exp = held && typeof held === "object" ? Date.parse(held.expires) : NaN;
  if (Number.isFinite(exp)) {
    if (exp < now) return `expired ${held.expires}`;
    if (exp > now + 2 * staleMs) return `expires ${held.expires} is beyond the ceiling of 2 x ${staleMs} ms from now`;
    return null;
  }
  return mtimeMs + staleMs < now ? `unreadable, last written ${new Date(mtimeMs).toISOString()}` : null;
}

// `unlink` is a test seam (a read-only directory: EROFS).
export function withLedgerLock(file, fn, { log = console.error, unlink = fs.unlinkSync } = {}) {
  const { staleMs, waitMs } = lockTimes();
  const lock = `${file}.lock`;
  const owner = `${os.hostname()}:${process.pid}:${crypto.randomBytes(6).toString("hex")}`;
  const deadline = Date.now() + waitMs;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let lastHeld = null;
  let takeoverError = null;
  for (;;) {
    let fd = null;
    try {
      fd = fs.openSync(lock, "wx");
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
    }
    if (fd != null) {
      const now = Date.now();
      try {
        fs.writeSync(fd, JSON.stringify({
          owner, host: os.hostname(), pid: process.pid,
          acquired: new Date(now).toISOString(), expires: new Date(now + staleMs).toISOString(),
        }));
      } finally {
        fs.closeSync(fd);
      }
      break;
    }
    // Held. Stale (a crashed holder): take it over - unlinked only while its
    // content is still what was read. A takeover that removed the lock retries
    // the open at once (progress: ours, or a live holder's); anything else
    // checks the deadline and SLEEPS before the next attempt - never a spin.
    let raw = null;
    let held = null;
    let mtimeMs = null;
    try { raw = fs.readFileSync(lock, "utf8"); held = JSON.parse(raw); } catch { /* being written, a directory, or gone */ }
    try { mtimeMs = fs.statSync(lock).mtimeMs; } catch { /* released meanwhile */ }
    if (held) lastHeld = held;
    if (mtimeMs != null) {
      const why = staleReason(held, mtimeMs, staleMs);
      if (why) {
        let removed = false;
        try {
          let same = true;
          try { same = fs.readFileSync(lock, "utf8") === raw; } catch (e) { if (e?.code === "ENOENT") same = false; }
          if (same) { unlink(lock); removed = true; }
        } catch (e) {
          if (e?.code !== "ENOENT") takeoverError = e;
        }
        if (removed) {
          takeoverError = null;
          log(`[structural] ledger lock ${lock} was stale (holder ${held?.owner || "unknown"}, ${why}); taken over`);
          continue;
        }
      }
    }
    if (Date.now() > deadline) {
      const h = held || lastHeld;
      const te = takeoverError ? ` - the stale lock could not be taken over (${takeoverError.code ? `${takeoverError.code}: ` : ""}${takeoverError.message || takeoverError})` : "";
      throw new Error(`structural ledger lock ${lock} is held by ${h?.owner || "an unknown holder"} since ${h?.acquired || "?"} ` +
        `(waited ${waitMs} ms; a lock past ${h?.expires || "its expiry"} is taken over)${te}`);
    }
    sleepSync(LOCK_SLEEP_MS);
  }
  try {
    return fn();
  } finally {
    try {
      const cur = JSON.parse(fs.readFileSync(lock, "utf8"));
      if (cur.owner === owner) fs.unlinkSync(lock);
    } catch { /* already gone */ }
  }
}

/**
 * One locked transaction on the ledger file: fn(ledger) sees the CURRENT
 * file, may change it in place, and returns a value; the ledger is written
 * (if it changed) before the lock is released. Returns fn's value.
 */
export function updateLedger(outDir, fn, file = ledgerPath(outDir)) {
  return withLedgerLock(file, () => {
    const ledger = readLedger(outDir, file);
    const out = fn(ledger);
    writeLedger(outDir, ledger, file);
    return out;
  });
}

/**
 * The manual clear (--clear-structural): `want` is "all" or a comma list of
 * keys / entity ids ("905" = "entity:905"). One locked transaction. Returns
 * { cleared, unknown, open }: `unknown` lists the requested keys that were
 * not open (a typo is not silently a no-op - the CLI exits non-zero naming
 * them; tester N2-2).
 */
export function clearStructuralKeys(outDir, want, file = ledgerPath(outDir)) {
  const w = String(want ?? "").trim();
  return updateLedger(outDir, (ledger) => {
    const keys = w === "all" ? Object.keys(ledger.failures)
      : w.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (s.includes(":") ? s : `entity:${s}`));
    const cleared = [];
    const unknown = [];
    for (const k of keys) (clearFailure(ledger, k) ? cleared : unknown).push(k);
    return { cleared, unknown, open: Object.keys(ledger.failures).length };
  }, file);
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
