/**
 * openbrain-wiki — compiler + scheduler + on-demand trigger.
 *
 * Runs recipes/entity-wiki/generate-wiki.mjs (--batch) into the shared
 * wiki volume, then git-commits the result (D16: local commits only, no
 * remote, no secrets). Compiles on boot (opt-out), on an interval, and
 * on POST /recompile. The wiki is fully regenerable: delete the volume
 * and the next compile rebuilds it from OpenBrain.
 *
 * No npm deps — Node builtins only. Env:
 *   OPEN_BRAIN_URL EMBEDDING_BASE_URL EMBEDDING_API_KEY EMBEDDING_MODEL
 *   EMBEDDING_DIMENSION LLM_BASE_URL LLM_API_KEY LLM_MODEL
 *   OPEN_BRAIN_SERVICE_KEY MCP_ACCESS_KEY
 *   WIKI_OUT_DIR (=/wiki/content)  WIKI_GIT_DIR (=/wiki)
 *   RECIPE_PATH (=/recipes/entity-wiki/generate-wiki.mjs)
 *   WIKI_RECOMPILE_HOUR (=1, local-time daily) COMPILE_ON_BOOT (=true)
 *   WIKI_WATCH_ENABLED (=true) WIKI_WATCH_INTERVAL_MIN (=3)
 *   WIKI_BATCH_MIN_LINKED (=1)  WIKI_MAX_SOURCES (=5)  PORT (=8000)
 *   TZ (set on the service so the daily hour = your local time)
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, copyFile, chmod, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
// Canonical slug algorithm — shared single source of truth (G5, plan §14.1).
// Imported from the bind-mounted recipes dir (../recipes:/recipes:ro), the
// same mount this service already reads the recipe from (RECIPE_PATH). The
// hand-synced slugifyEntity/slugifyNotebook copies are gone — no more drift.
import { slugifyEntity, slugifyNotebook } from "file:///recipes/_shared/slug.mjs";
// Idempotent writes (churn fix): an unchanged file keeps its mtime so the
// viewer's polling watcher does not see a phantom change every compile.
import { writeIfChanged } from "file:///recipes/_shared/write-if-changed.mjs";

const pexec = promisify(execFile);

const ENV = process.env;
const PORT = parseInt(ENV.PORT || "8000", 10);
const MCP_ACCESS_KEY = ENV.MCP_ACCESS_KEY || "";
const WIKI_OUT_DIR = ENV.WIKI_OUT_DIR || "/wiki/content";
const WIKI_GIT_DIR = ENV.WIKI_GIT_DIR || "/wiki";
const RECIPE_PATH = ENV.RECIPE_PATH || "/recipes/entity-wiki/generate-wiki.mjs";
const SYNTH_PATH = ENV.SYNTH_PATH || "/recipes/wiki-synthesis/scripts/synthesize-notebooks.mjs";
// Deterministic daily compile at a fixed local-time hour (default 01:00),
// NOT a 24h-from-boot interval (that drifts and can hit during work).
// Set the container TZ so this hour means your local time.
const RECOMPILE_HOUR = Math.min(23, Math.max(0, Number(ENV.WIKI_RECOMPILE_HOUR || "1")));
const COMPILE_ON_BOOT = (ENV.COMPILE_ON_BOOT || "true") !== "false";
// Change-driven recompile: poll OpenBrain for new/edited sources or
// thoughts since the last compile; when activity settles (no new arrivals
// for one watch interval = debounce/coalesce a research burst), compile.
const WATCH_ENABLED = (ENV.WIKI_WATCH_ENABLED || "true") !== "false";
const WATCH_INTERVAL_MIN = Math.max(1, Number(ENV.WIKI_WATCH_INTERVAL_MIN || "3"));
const BATCH_MIN_LINKED = ENV.WIKI_BATCH_MIN_LINKED || "1";
const BATCH_LIMIT = ENV.WIKI_BATCH_LIMIT || "1000";
const MAX_SOURCES = ENV.WIKI_MAX_SOURCES || "5";
// Bounded queue drain: each incremental compile ALSO generates this many
// pages from the planned manifest (most-recently-active first), so the
// registered-but-never-built backlog shrinks steadily instead of sitting
// "queued" forever. 0 disables.
const BACKFILL_PER_COMPILE = Math.max(0, Number(ENV.WIKI_BACKFILL_PER_COMPILE || "25"));
// Self-continuing drain (operator 2026-08-23: "all compilations should be
// working towards a completed state"): backfill only rides compiles, and
// compiles only fire on research activity + the daily — on a quiet day the
// queue stalled. When a compile backfilled pages AND the queue is still
// non-empty, another compile is scheduled after this delay, so the drain
// converges continuously in bounded slices. 0 disables (queue then drains
// only on organic compiles).
const BACKFILL_CONTINUE_MIN = Math.max(0, Number(ENV.WIKI_BACKFILL_CONTINUE_MIN || "10"));
// Interaction-aware drain (operator 2026-08-24): while a human is actively
// using the wiki, the bulk backfill DEFERS — it resumes only once the viewer
// has been idle this long (measured from the viewer's last real request via
// its /__last-access probe endpoint). Organic compile work (fresh research,
// notes ingest) still runs; only the backlog slice waits. 0 disables gating.
const BACKFILL_IDLE_MIN = Math.max(0, Number(ENV.WIKI_BACKFILL_IDLE_MIN || "15"));
const VIEWER_URL = (ENV.VIEWER_URL || "http://openbrain-wiki-viewer:8080").replace(/\/+$/, "");

// ms since the viewer last served a real user request. Unreachable/down
// viewer → Infinity (nobody can be browsing a dead viewer; never stall the
// drain on an outage).
async function viewerIdleMs() {
  try {
    const r = await fetch(`${VIEWER_URL}/__last-access`, { signal: AbortSignal.timeout(3000) });
    const ts = Number((await r.json())?.ts || 0);
    return ts > 0 ? Math.max(0, Date.now() - ts) : Infinity;
  } catch {
    return Infinity;
  }
}

// Pre-compile entity extraction. The worker drains the thought + source
// queues so entity/source_entities links are fresh before the wiki is
// built (this is what makes sources attach to the RIGHT entity). Each
// worker call processes a bounded batch; we loop until both queues are
// empty or WORKER_DRAIN_MAX_MIN is hit. Non-fatal: a compile still runs
// on whatever has been extracted so far.
const WORKER_URL = ENV.WORKER_URL || "http://openbrain-entity-worker:8000";
const DRAIN_BEFORE_COMPILE = (ENV.DRAIN_BEFORE_COMPILE || "true") !== "false";
const WORKER_DRAIN_MAX_MIN = Math.max(1, Number(ENV.WORKER_DRAIN_MAX_MIN || "30"));

// Recipe-execution timeouts. A FULL compile of the whole graph + topic
// synthesis can outrun the prior 55/30-min defaults once the thought
// corpus grows (post-import floods of new entities). Killing pexec
// mid-write leaves an unstaged dirty tree that blocks the next
// pull --rebase (Catch-22). Defaults raised; tunable per environment.
const COMPILE_TIMEOUT_MS = Math.max(1, Number(ENV.WIKI_COMPILE_TIMEOUT_MIN || "120")) * 60_000;
const SYNTH_TIMEOUT_MS = Math.max(1, Number(ENV.WIKI_SYNTH_TIMEOUT_MIN || "60")) * 60_000;

// Optional private-remote push (opt-in; unset = D16 local-commits-only,
// unchanged). WIKI_GIT_REMOTE is an SSH URL; WIKI_GIT_SSH_KEY is the
// mounted (gitignored) deploy private key; pushes go to WIKI_GIT_BRANCH.
const GIT_REMOTE = ENV.WIKI_GIT_REMOTE || "";
const GIT_SSH_KEY = ENV.WIKI_GIT_SSH_KEY || "/secrets/deploy_key";
const GIT_BRANCH = ENV.WIKI_GIT_BRANCH || "main";
// This service is the SOLE generator of the wiki repo's content and the
// content is fully regenerable, so on any non-fast-forward rejection it
// reconciles with an unconditional `git push --force` (always overwrite
// — user-directed). Set "false" to require manual reconciliation.
// Evolving-vault model: pull --rebase before compile keeps pushes
// fast-forward, so force is OFF by default (manual escape only).
const GIT_FORCE = ENV.WIKI_GIT_FORCE || "false";
const OB_URL = (ENV.OPEN_BRAIN_URL || "http://openbrain-rest").replace(/\/+$/, "");
// IdentitiesOnly so it can't fall back to other keys; accept-new trusts
// github.com's host key on first contact (written to a tmp known_hosts).
const GIT_SSH_COMMAND =
  `ssh -i ${GIT_SSH_KEY} -o IdentitiesOnly=yes ` +
  `-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/known_hosts`;

let running = false;
let lastStatus = { state: "idle", at: null, ok: null, summary: null, error: null };
let backfillContinueTimer = null; // single continuation timer (see compile())

async function git(args) {
  return pexec("git", ["-C", WIKI_GIT_DIR, ...args], { maxBuffer: 8 * 1024 * 1024 });
}

const NOTES_DIR = `${WIKI_GIT_DIR}/notes`;
const STATE_FILE = `${WIKI_GIT_DIR}/.wikistate.json`;

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
async function writeState(s) {
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}

async function ensureRepo() {
  await mkdir(WIKI_OUT_DIR, { recursive: true });
  // notes/ is the human-owned layer — created once, then never touched
  // by the compiler (it only writes under content/).
  await mkdir(NOTES_DIR, { recursive: true });
  const freshRepo = !existsSync(`${WIKI_GIT_DIR}/.git`);
  if (freshRepo) {
    await git(["init", "-q"]);
    await git(["config", "user.email", "wiki@openbrain.local"]);
    await git(["config", "user.name", "openbrain-wiki"]);
  }
  // Idempotent every run (existing repos created before these existed
  // must still get them): pull.rebase, .gitignore (so .wikistate.json is
  // never committed/pulled), notes/ README.
  await git(["config", "pull.rebase", "true"]).catch(() => {});
  // assets/ is the wiki-assets volume (binaries, D-I) — keep it OUT of vault
  // git so the workbench's note commits never stage images.
  const wantIgnore =
    ".quartz-cache/\npublic/\nnode_modules/\n.wikistate.json\nassets/\n" +
    ".failed-entity-ids.json\nplanned.json\n";
  let curIgnore = "";
  try { curIgnore = await readFile(`${WIKI_GIT_DIR}/.gitignore`, "utf8"); } catch { /* */ }
  if (
    !curIgnore.includes(".wikistate.json") || !curIgnore.includes("assets/") ||
    !curIgnore.includes(".failed-entity-ids.json") || !curIgnore.includes("planned.json")
  ) {
    await writeFile(`${WIKI_GIT_DIR}/.gitignore`, wantIgnore);
  }
  // If a prior (pre-fix) run already tracked the state file, untrack it.
  await git(["rm", "--cached", "-q", "--ignore-unmatch", ".wikistate.json"]).catch(() => {});
  if (!existsSync(`${NOTES_DIR}/README.md`)) {
    await writeFile(
      `${NOTES_DIR}/README.md`,
      "# Notes\n\nHand-written notes live here. The wiki compiler NEVER " +
        "edits this folder. Each note is tethered to one OpenBrain record " +
        "(by path) and ingested back so it joins the research effort. " +
        "Link freely into `content/` with [[wikilinks]].\n",
    );
  }
  if (freshRepo) {
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "wiki: initial repo"]).catch(() => {});
    console.log("[wiki-service] initialized git repo at", WIKI_GIT_DIR);
  }
  if (GIT_REMOTE) {
    try {
      await git(["remote", "set-url", "origin", GIT_REMOTE]);
    } catch {
      await git(["remote", "add", "origin", GIT_REMOTE]).catch(() => {});
    }
  }
}

// Pull the user's note commits before regenerating, so their notes/
// edits and our content/ regen interleave as a normal evolving repo
// (rebase: our generated commits replay on top of theirs). On conflict
// (only if a human edited content/, which they shouldn't) we abort and
// skip this cycle rather than clobber — never force in normal flow.
async function gitPullRebase() {
  if (!GIT_REMOTE || !existsSync(GIT_SSH_KEY)) return { ok: true, skipped: true };
  const key = await preparedKeyPath();
  const sshCmd =
    `ssh -i ${key} -o IdentitiesOnly=yes ` +
    `-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/known_hosts`;
  const gitEnv = { env: { ...ENV, GIT_SSH_COMMAND: sshCmd }, maxBuffer: 8 * 1024 * 1024 };
  try {
    await pexec("git", ["-C", WIKI_GIT_DIR, "fetch", "origin", GIT_BRANCH], gitEnv);
    // No-op if origin/<branch> doesn't exist yet (fresh remote).
    const { stdout: refs } = await pexec(
      "git", ["-C", WIKI_GIT_DIR, "ls-remote", "--heads", "origin", GIT_BRANCH], gitEnv,
    );
    if (!refs.trim()) return { ok: true, fresh: true };
    await pexec(
      "git", ["-C", WIKI_GIT_DIR, "rebase", `origin/${GIT_BRANCH}`], gitEnv,
    );
    return { ok: true };
  } catch (e) {
    const msg = (e?.stderr || e?.message || String(e)).toString().slice(0, 400);
    console.error("[wiki-service] pull --rebase failed; aborting rebase:", msg);
    await pexec("git", ["-C", WIKI_GIT_DIR, "rebase", "--abort"], gitEnv).catch(() => {});
    return { ok: false, error: msg };
  }
}

// Push to the private remote over SSH with the mounted deploy key.
// Pushes whatever HEAD is to <branch>; never blocks the compile result.
// SSH refuses a key file with group/other-readable perms. Bind mounts
// from a Windows host expose the key as 0644, so copy it to a private
// 0600 path inside the container and point ssh at that.
async function preparedKeyPath() {
  const dst = "/tmp/wiki_deploy_key";
  await copyFile(GIT_SSH_KEY, dst);
  await chmod(dst, 0o600);
  return dst;
}

async function gitPush() {
  if (!GIT_REMOTE) return { pushed: false, reason: "no remote configured" };
  if (!existsSync(GIT_SSH_KEY)) {
    return { pushed: false, error: `deploy key missing at ${GIT_SSH_KEY}` };
  }
  try {
    const key = await preparedKeyPath();
    const sshCmd =
      `ssh -i ${key} -o IdentitiesOnly=yes ` +
      `-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/known_hosts`;
    const gitEnv = { env: { ...ENV, GIT_SSH_COMMAND: sshCmd }, maxBuffer: 8 * 1024 * 1024 };
    try {
      await pexec(
        "git",
        ["-C", WIKI_GIT_DIR, "push", "origin", `HEAD:refs/heads/${GIT_BRANCH}`],
        gitEnv,
      );
      console.log(`[wiki-service] pushed to ${GIT_REMOTE} (${GIT_BRANCH})`);
      return { pushed: true };
    } catch (e) {
      const msg = (e?.stderr || e?.message || "").toString();
      const nonFF = /\[rejected\]|fetch first|non-fast-forward/i.test(msg);
      // Sole generator + regenerable content: a non-FF rejection only
      // ever means an earlier auto-snapshot is on the remote, superseded
      // by this compile. Unconditionally overwrite it (user-directed).
      if (!nonFF || GIT_FORCE !== "true") throw e;
      console.warn("[wiki-service] non-FF; reconciling with --force (sole generator)");
      await pexec(
        "git",
        ["-C", WIKI_GIT_DIR, "push", "--force", "origin", `HEAD:refs/heads/${GIT_BRANCH}`],
        gitEnv,
      );
      console.log(`[wiki-service] force-pushed to ${GIT_REMOTE} (${GIT_BRANCH})`);
      return { pushed: true, reconciled: true };
    }
  } catch (e) {
    const msg = (e?.stderr || e?.message || String(e)).toString().slice(0, 500);
    console.error("[wiki-service] git push failed:", msg);
    return { pushed: false, error: msg };
  }
}

// Drain one worker queue (suffix "" = thoughts, "/sources" = sources)
// until empty or the shared time budget is exhausted.
async function drainQueue(suffix, label, deadlineMs) {
  let totalProcessed = 0;
  let calls = 0;
  let connErrs = 0;
  while (Date.now() < deadlineMs) {
    let j;
    try {
      const r = await fetch(`${WORKER_URL}${suffix}?limit=50`, {
        method: "POST",
        headers: { "x-brain-key": MCP_ACCESS_KEY, "content-type": "application/json" },
      });
      if (!r.ok) {
        console.error(`[wiki-service] worker ${label} drain HTTP ${r.status}`);
        break;
      }
      j = await r.json();
      connErrs = 0;
    } catch (e) {
      // Worker may not be listening yet on a cold boot — retry a few
      // times before giving up rather than skipping extraction.
      connErrs++;
      if (connErrs > 6) {
        console.error(`[wiki-service] worker ${label} unreachable, giving up:`, e?.message || e);
        break;
      }
      console.warn(`[wiki-service] worker ${label} not ready (try ${connErrs}); retrying in 10s`);
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    calls++;
    const processed = Number(j?.processed ?? 0);
    totalProcessed += processed;
    if (processed === 0) break; // queue empty
  }
  console.log(`[wiki-service] drained ${label}: ${totalProcessed} processed in ${calls} call(s)`);
  return totalProcessed;
}

async function drainWorkerQueues() {
  if (!DRAIN_BEFORE_COMPILE) return;
  const deadline = Date.now() + WORKER_DRAIN_MAX_MIN * 60_000;
  try {
    await drainQueue("", "thoughts", deadline);
    await drainQueue("/sources", "sources", deadline);
  } catch (e) {
    console.error("[wiki-service] pre-compile drain failed (non-fatal):", e?.message || e);
  }
}

// ── OpenBrain (PostgREST via Caddy) client + tethered note ingest ───────────

// Offset-paginated fetch-ALL (pathq MUST carry a stable order=). The flat
// `limit=` caps this file used silently clipped once tables outgrew them —
// found 2026-08-23 with 68,712 entities vs the sweep's unordered limit=20000:
// the kept-set was an ARBITRARY 20k-entity window and every other entity's
// page was deleted as an "orphan" (the operator's "anthropic organization is
// a 404, I'm sure there are many others"), and the planned manifest missed
// the same rows. The hard ceiling is a runaway guard, far above real scale.
async function obFetchAll(pathq, pageSize = 5000, hardCeiling = 500000) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const rows = await obFetch("GET", `${pathq}&limit=${pageSize}&offset=${offset}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    if (out.length > hardCeiling) throw new Error(`fetch exceeded ${hardCeiling} rows: ${pathq}`);
    if (rows.length < pageSize) break;
  }
  return out;
}

async function obFetch(method, pathq, body) {
  const r = await fetch(`${OB_URL}/rest/v1/${pathq}`, {
    method,
    headers: {
      "content-type": "application/json",
      // Caddy strips auth; PostgREST uses anon=service_role. Non-empty
      // just to satisfy any client that expects it.
      apikey: "local-trust",
      prefer: method === "POST" ? "return=representation" : "return=minimal",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`OB ${method} ${pathq}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// One note file ↔ one OpenBrain thought, tethered by metadata.note_path.
// Edit a note → PATCH the SAME row (no duplicate); the content-change
// trigger re-enqueues entity extraction. Delete a note → delete its row.
// Author-owned content trees (operator layout #4/#5):
//   notes/notebooks/<nb>/…    user notes  (user_note)
//   content/notebooks/<nb>/…  AI-generated from external inlets  (ai_note)
// The Changes log (notes/Changes/…) is excluded — it's a log, not a note.
const NOTE_TREES = ["notes/notebooks/", "content/notebooks/"];
function isExcludedNote(file) {
  return !file.endsWith(".md") || /(^|\/)README\.md$/i.test(file) || file.startsWith("notes/Changes/");
}
async function ingestNotes(prevCommit) {
  let changed = [];
  let deleted = [];
  try {
    if (prevCommit) {
      const { stdout } = await git([
        "diff", "--name-status", `${prevCommit}..HEAD`, "--", ...NOTE_TREES,
      ]);
      for (const line of stdout.split("\n")) {
        const m = line.match(/^([ACMRD])\S*\t(.+?)(?:\t(.+))?$/);
        if (!m) continue;
        const status = m[1];
        const file = (m[3] || m[2]).trim();
        if (isExcludedNote(file)) continue;
        if (status === "D") deleted.push(file);
        else changed.push(file);
      }
    } else {
      const { stdout } = await git(["ls-files", ...NOTE_TREES]);
      changed = stdout.split("\n").filter((f) => f && !isExcludedNote(f));
    }
  } catch (e) {
    console.error("[wiki-service] note diff failed (non-fatal):", e?.message || e);
    return { ingested: 0, deleted: 0 };
  }

  let ingested = 0;
  for (const rel of changed) {
    try {
      const abs = `${WIKI_GIT_DIR}/${rel}`;
      if (!existsSync(abs)) continue;
      const content = await readFile(abs, "utf8");
      // notebook = the segment right after "notebooks/"; title = filename.
      const parts = rel.split("/"); // <tree>/notebooks/<nb-slug>/file.md
      const nbIdx = parts.indexOf("notebooks");
      const notebook = nbIdx >= 0 && parts[nbIdx + 1] ? parts[nbIdx + 1] : "notes";
      const title = parts[parts.length - 1].replace(/\.md$/, "");
      // Authorship: content/notebooks/ defaults to ai_note, notes/ to user_note;
      // frontmatter `source:` overrides either way (P3.4 / #5).
      const isAiTree = rel.startsWith("content/notebooks/");
      const fmBlock = content.match(/^---\n([\s\S]*?)\n---/);
      const fmSource = fmBlock?.[1].match(/^source:\s*(\S+)/m)?.[1];
      const fmAgent = fmBlock?.[1].match(/^agent:\s*"?([^"\n]+)"?/m)?.[1];
      const source = fmSource === "ai_note" || (isAiTree && fmSource !== "user_note")
        ? "ai_note"
        : "user_note";
      const meta = { source, note_path: rel, notebook, title };
      if (source === "ai_note" && fmAgent) meta.agent = fmAgent;
      const enc = encodeURIComponent(rel);
      const existing = await obFetch(
        "GET",
        `thoughts?select=id&metadata->>note_path=eq.${enc}&limit=1`,
      );
      if (Array.isArray(existing) && existing[0]) {
        await obFetch("PATCH", `thoughts?id=eq.${existing[0].id}`, { content, metadata: meta });
      } else {
        await obFetch("POST", "thoughts", { content, metadata: meta });
      }
      ingested++;
    } catch (e) {
      console.error(`[wiki-service] note ingest failed for ${rel}:`, e?.message || e);
    }
  }
  let delc = 0;
  for (const rel of deleted) {
    try {
      const enc = encodeURIComponent(rel);
      await obFetch("DELETE", `thoughts?metadata->>note_path=eq.${enc}`);
      delc++;
    } catch (e) {
      console.error(`[wiki-service] note delete failed for ${rel}:`, e?.message || e);
    }
  }
  console.log(`[wiki-service] notes ingested: ${ingested} upserted, ${delc} deleted`);
  return { ingested, deleted: delc };
}

// Entities whose links/metadata changed since the last compile (the set
// that needs regeneration). upsertEntity bumps entities.updated_at on
// every extraction, so this captures note- and source-driven changes.
// Entities that FAILED last compile (ledger written by generate-wiki) are
// unioned in — before this, a failure exited 0, the watermark advanced, and
// the page froze stale forever.
async function dirtyEntityIds(prevIso) {
  if (!prevIso) return null; // null → full rebuild
  try {
    const rows = await obFetchAll(
      `entities?select=id&updated_at=gte.${encodeURIComponent(prevIso)}&order=id.asc`,
    );
    const ids = new Set(rows.map((r) => r.id));
    try {
      const failed = JSON.parse(
        await readFile(`${WIKI_OUT_DIR}/.failed-entity-ids.json`, "utf8"),
      );
      if (Array.isArray(failed) && failed.length) {
        for (const id of failed) ids.add(id);
        console.log(`[wiki-service] retrying ${failed.length} failed entity id(s) from last compile`);
      }
    } catch { /* no ledger — nothing failed last run */ }
    return [...ids];
  } catch (e) {
    console.error("[wiki-service] dirty-entity query failed; full rebuild:", e?.message || e);
    return null;
  }
}

// ── Orphan sweep ────────────────────────────────────────────────────────────
// slugifyEntity / slugifyNotebook are imported from the shared canonical
// module (top of file). Only used when an entity has no pinned wiki_slug yet.

// Walks one level under outDir/<subdir>/ and returns absolute paths of
// .md files, skipping README.md.
async function listEntityFiles(outDir) {
  const out = [];
  let typeDirs;
  try {
    typeDirs = await readdir(outDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of typeDirs) {
    if (!d.isDirectory()) continue;
    // Non-entity page classes, each with its OWN kept-set, skipped here so the
    // entity sweep never deletes them against the wrong set: `notebook/` (P2
    // hubs → sweepOrphanNotebookPages), `topic/` (retired, swept wholesale),
    // `thought/`+`source/` (P1 leaves → sweepOrphanLeafPages).
    // `notebooks/` (plural) holds AI-authored notes (content/notebooks/<nb>/) —
    // author-owned-in-content, never swept. `notebook/` (singular) = the hubs.
    if (
      d.name === "notebook" || d.name === "notebooks" || d.name === "topic" ||
      d.name === "thought" || d.name === "source"
    ) continue;
    const dirPath = `${outDir}/${d.name}`;
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".md")) continue;
      if (/^README\.md$/i.test(e.name)) continue;
      out.push(`${dirPath}/${e.name}`);
    }
  }
  return out;
}

// Brain → wiki delete-propagation. After each compile, query the
// authoritative kept-set from OpenBrain (entities meeting the
// BATCH_MIN_LINKED threshold) and remove any content/<type>/<slug>.md
// not in that set. This is what makes a thought-delete in the brain
// erase the corresponding wiki page on the next compile.
async function sweepOrphanEntityPages() {
  const minLinked = Math.max(1, Number(BATCH_MIN_LINKED) || 1);
  // Two queries: (1) every entity with id/type/canonical_name/wiki_slug,
  // (2) link counts per entity_id. Joining client-side keeps the query
  // shape simple (PostgREST doesn't easily compose HAVING).
  let entities = [];
  let counts = new Map();
  try {
    // Paginated fetch-ALL — a partial kept-set here deletes real pages, so any
    // failure (including the runaway ceiling) skips the whole sweep.
    entities = await obFetchAll(
      "entities?select=id,canonical_name,entity_type,metadata&order=id.asc",
    );
    const rows = await obFetchAll(
      "thought_entities?select=entity_id&order=entity_id.asc,thought_id.asc",
    );
    for (const r of rows) {
      const k = r.entity_id;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    // SOURCE links count too (tombstone-filtered), mirroring the candidate
    // selection in generate-wiki listBatchCandidates. Counting only thought
    // links here meant a source-only entity (exactly what research output
    // creates) was WRITTEN by the compile and DELETED by this sweep in the
    // same cycle — research-derived entity pages systematically vanished.
    const sRows = await obFetchAll(
      "source_entities?select=entity_id,sources!inner(id)&sources.retraction_committed_at=is.null&order=entity_id.asc,source_id.asc",
    );
    for (const r of sRows) {
      const k = r.entity_id;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  } catch (e) {
    console.error("[wiki-service] orphan-sweep query failed (skipping sweep):",
      e?.message || e);
    return { kept: 0, deleted: 0, error: true };
  }
  const kept = new Set();
  for (const e of entities) {
    if ((counts.get(e.id) || 0) < minLinked) continue;
    const slug =
      (e.metadata && typeof e.metadata.wiki_slug === "string" && e.metadata.wiki_slug.trim())
      || slugifyEntity(e.canonical_name, e.entity_type);
    kept.add(`${e.entity_type}/${slug}.md`);
  }
  const files = await listEntityFiles(WIKI_OUT_DIR);
  let deleted = 0;
  for (const abs of files) {
    const rel = abs.slice(WIKI_OUT_DIR.length + 1).replace(/\\/g, "/");
    if (kept.has(rel)) continue;
    try {
      await rm(abs, { force: true });
      deleted++;
    } catch (e) {
      console.error(`[wiki-service] orphan-sweep delete failed for ${rel}:`, e?.message || e);
    }
  }
  if (deleted > 0) {
    console.log(`[wiki-service] orphan-sweep: deleted ${deleted} stale entity page(s)`);
  }
  return { kept: kept.size, deleted };
}

// P2.3 — notebook hubs replace topic pages. Keep only `content/notebook/<slug>.md`
// for an ACTIVE thread (the slug kept-set comes from threads.slug), and RETIRE
// the old `topic/` layer wholesale (synthesis now lands in notebook/). The
// `notebook/` dir has its own kept-set here, exactly as `topic/` used to —
// don't let the entity sweep eat hubs (same bug-class as the leaf sweep).
async function sweepOrphanNotebookPages() {
  // 1. Retire the old layers (one-time, idempotent): `topic/` (research
  //    synthesis, superseded) and the SINGULAR `notebook/` (hubs moved into
  //    content/notebooks/<slug>/<slug>.md).
  let retired = 0;
  for (const d of ["topic", "notebook"]) {
    const dir = `${WIKI_OUT_DIR}/${d}`;
    if (existsSync(dir)) {
      try { await rm(dir, { recursive: true, force: true }); retired++; }
      catch (e) { console.error(`[wiki-service] ${d}/ retire failed:`, e?.message || e); }
    }
  }
  await rm(`${WIKI_OUT_DIR}/topic.md`, { force: true }).catch(() => {});
  await rm(`${WIKI_OUT_DIR}/notebook.md`, { force: true }).catch(() => {});

  // 2. Sweep notebook HUB pages (content/notebooks/<slug>/<slug>.md) whose
  //    thread is gone/archived. The folder also holds author-owned AI notes —
  //    only the hub file (named after its folder) is swept; AI notes are left.
  const nbDir = `${WIKI_OUT_DIR}/notebooks`;
  if (!existsSync(nbDir)) return { kept: 0, deleted: retired };
  let active = new Set();
  try {
    const rows = (await obFetch(
      "GET",
      "threads?select=slug,status&status=eq.active&slug=not.is.null&limit=20000",
    )) || [];
    for (const r of rows) if (r.slug) active.add(r.slug);
  } catch (e) {
    console.error("[wiki-service] notebook-sweep query failed (skipping):", e?.message || e);
    return { kept: 0, deleted: retired, error: true };
  }
  let entries;
  try { entries = await readdir(nbDir, { withFileTypes: true }); } catch { return { kept: active.size, deleted: retired }; }
  let deleted = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const slug = e.name;
    if (active.has(slug)) continue;
    const hub = `${nbDir}/${slug}/${slug}.md`;
    if (existsSync(hub)) {
      try { await rm(hub, { force: true }); deleted++; }
      catch (err) { console.error(`[wiki-service] notebook hub delete failed for ${slug}:`, err?.message || err); }
    }
  }
  if (deleted > 0 || retired > 0) {
    console.log(`[wiki-service] orphan-sweep: deleted ${deleted} stale notebook hub(s)${retired ? " + retired topic/+notebook/ layers" : ""}`);
  }
  return { kept: active.size, deleted: deleted + retired };
}

// Recursively collect absolute paths of .md files under `dir`, skipping any
// directory whose absolute path is in `skip` (plus the usual build/git dirs).
async function collectMarkdown(dir, skip, acc = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const abs = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (skip.has(abs)) continue;
      if (/^(\.git|\.quartz-cache|public|node_modules)$/.test(e.name)) continue;
      await collectMarkdown(abs, skip, acc);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      acc.push(abs);
    }
  }
  return acc;
}

// P1.5 — sweep provenance leaf pages (content/thought/<id>.md,
// content/source/<uuid>.md) no longer cited by ANY vault page. A leaf exists
// only to back a citation; once nothing links to it, remove it. CRITICAL: the
// kept-set is read from ON-DISK citations ([[thought/<id>…]] /
// [[source/<uuid>…]]) across every content/ + notes/ page — NOT from "ids
// cited this compile" — so an incremental compile (which regenerates only
// dirty pages) never deletes a leaf still cited by an unchanged page. This is
// a DEDICATED sweep, never the entity sweep (which keys on entity slugs and
// would delete every leaf — the P1.5 data-loss bug).
async function sweepOrphanLeafPages() {
  const thoughtDir = `${WIKI_OUT_DIR}/thought`;
  const sourceDir = `${WIKI_OUT_DIR}/source`;
  if (!existsSync(thoughtDir) && !existsSync(sourceDir)) return { kept: 0, deleted: 0 };
  // Scan content/ (minus the leaf dirs themselves) + the author-owned notes/
  // layer, since a hand-written note may also [[source/…]] a leaf.
  const skip = new Set([thoughtDir, sourceDir]);
  const pages = [
    ...(await collectMarkdown(WIKI_OUT_DIR, skip)),
    ...(await collectMarkdown(NOTES_DIR, skip)),
  ];
  const keptThoughts = new Set();
  const keptSources = new Set();
  // Match BOTH the bare (`[[source/<uuid>]]`) and content-prefixed
  // (`[[content/source/<uuid>]]`) link forms. The compiler emits the prefixed
  // form (viewer's Quartz root is the whole vault, so leaf slugs are
  // `content/source/<uuid>`); the bare form is kept for backward-compat. If this
  // regex misses the emitted form, the keep-set is empty and EVERY leaf is
  // wrongly swept as an orphan.
  const reThought = /\[\[(?:content\/)?thought\/(\d+)/g;
  const reSource = /\[\[(?:content\/)?source\/([0-9a-fA-F-]{36})/g;
  for (const p of pages) {
    let text;
    try { text = await readFile(p, "utf8"); } catch { continue; }
    let m;
    while ((m = reThought.exec(text)) !== null) keptThoughts.add(m[1]);
    while ((m = reSource.exec(text)) !== null) keptSources.add(m[1].toLowerCase());
  }
  let deleted = 0;
  for (const [dir, kept, isSource] of [
    [thoughtDir, keptThoughts, false],
    [sourceDir, keptSources, true],
  ]) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const id = e.name.replace(/\.md$/, "");
      const key = isSource ? id.toLowerCase() : id;
      if (kept.has(key)) continue;
      try {
        await rm(`${dir}/${e.name}`, { force: true });
        deleted++;
      } catch (err) {
        console.error(`[wiki-service] leaf orphan delete failed for ${e.name}:`, err?.message || err);
      }
    }
  }
  if (deleted > 0) {
    console.log(`[wiki-service] orphan-sweep: deleted ${deleted} stale leaf page(s)`);
  }
  return { kept: keptThoughts.size + keptSources.size, deleted };
}

// The truthful "wiki filler" queue (2026-08-23). Entities the brain knows
// about whose page does NOT exist on disk yet — because they haven't met the
// link threshold, were beyond a batch cap, or simply haven't been compiled
// yet. serve.mjs reads this from the shared volume and turns what used to be
// a bare 404 into an honest "queued for synthesis" page. Derived data:
// gitignored, quartz-ignored, rewritten (write-if-changed) each compile.
async function writePlannedManifest() {
  try {
    const entities = await obFetchAll(
      "entities?select=id,canonical_name,entity_type,metadata,updated_at&order=id.asc",
    );
    const planned = {};
    // The queue must be TRUE: types the compiler no longer emits (topic layer
    // retired P2.3 — swept wholesale) would sit "queued" forever.
    const RETIRED_TYPES = new Set(["topic"]);
    for (const e of entities) {
      if (!e.canonical_name || !e.entity_type) continue;
      if (RETIRED_TYPES.has(e.entity_type)) continue;
      const slug =
        (e.metadata && typeof e.metadata.wiki_slug === "string" && e.metadata.wiki_slug.trim())
        || slugifyEntity(e.canonical_name, e.entity_type);
      if (existsSync(`${WIKI_OUT_DIR}/${e.entity_type}/${slug}.md`)) continue;
      // id + updated_at: the bounded per-compile backfill reads LAST compile's
      // manifest and generates the most-recently-active queued entities first.
      planned[`content/${e.entity_type}/${slug}`] = {
        id: e.id,
        name: e.canonical_name,
        type: e.entity_type,
        updated_at: e.updated_at,
      };
    }
    writeIfChanged(
      `${WIKI_GIT_DIR}/planned.json`,
      JSON.stringify({ generated_at: new Date().toISOString(), planned }) + "\n",
    );
    const n = Object.keys(planned).length;
    console.log(`[wiki-service] planned manifest: ${n} queued page(s)`);
    return n;
  } catch (e) {
    console.error("[wiki-service] planned-manifest write failed (non-fatal):", e?.message || e);
    return 0;
  }
}

// P4.7 — commit working source-content edits as revisions, ONE per compile.
// The workbench tracks edits as a working head; this snapshots every dirty head
// into source_revisions (stamped with its author). Best-effort: a failure must
// never abort the compile.
const WORKBENCH_URL = ENV.WORKBENCH_URL || "http://openbrain-workbench:8000";
async function commitSourceEdits() {
  try {
    const r = await fetch(`${WORKBENCH_URL}/workbench/source-commit`, {
      method: "POST",
      headers: { "X-Brain-Key": ENV.WORKBENCH_KEY || "" },
    });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      if (j.committed) console.log(`[wiki-service] committed ${j.committed} source revision(s)`);
    } else {
      console.error(`[wiki-service] source-commit HTTP ${r.status} (non-fatal)`);
    }
  } catch (e) {
    console.error(`[wiki-service] source-commit failed (non-fatal): ${e.message}`);
  }
}

// P4.7 — commit any still-uncommitted NOTE edits (working-draft model) as git
// revisions before the compile reads/commits the tree. Authored "commit now"
// happens in the workbench; this is the catch-all. Best-effort.
async function commitNoteEdits() {
  try {
    const r = await fetch(`${WORKBENCH_URL}/workbench/note-commit`, {
      method: "POST",
      headers: { "X-Brain-Key": ENV.WORKBENCH_KEY || "" },
    });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      if (j.committed) console.log(`[wiki-service] committed pending note edits`);
    }
  } catch (e) {
    console.error(`[wiki-service] note-commit failed (non-fatal): ${e.message}`);
  }
}

async function compile(reason) {
  if (running) return { skipped: true, reason: "compile already in progress" };
  running = true;
  lastStatus = { state: "running", at: new Date().toISOString(), ok: null, summary: null, error: null };
  console.log(`[wiki-service] compile start (${reason})`);
  try {
    await ensureRepo();
    // P4.7 — commit dirty source working-heads + pending note edits as revisions
    // (one per compile) BEFORE the compile reads/commits the tree.
    await commitSourceEdits();
    await commitNoteEdits();
    // Pull the user's note commits first (evolving repo; no wipe/force).
    const pull = await gitPullRebase();
    const state = await readState();
    const prevIso = state.last_compile_iso || null;
    const prevCommit = state.last_commit || null;

    // Tethered note ingest → enqueues extraction for changed notes.
    await ingestNotes(prevCommit);
    // Extract from the freshly-ingested notes + any pending sources.
    await drainWorkerQueues();

    const childEnv = {
      ...ENV,
      OPEN_BRAIN_URL: OB_URL,
      OPEN_BRAIN_SERVICE_KEY: ENV.OPEN_BRAIN_SERVICE_KEY || "local-trust",
      OB_WIKI_OUT_DIR: WIKI_OUT_DIR,
    };
    // Incremental: regenerate only entities touched since last compile.
    // First run (no state) or huge delta → full batch. graph.json +
    // index.md are whole-graph aggregates the recipe always rewrites.
    const dirty = await dirtyEntityIds(prevIso);
    const fullRebuild = dirty === null || dirty.length > Number(BATCH_LIMIT);
    // Bounded backfill: drain the planned queue (LAST compile's manifest —
    // freshly diffed against disk below after this run's pages land) a slice
    // per compile, most-recently-active entities first.
    let backfillAdded = 0;
    let backfillDeferredMs = 0;
    if (!fullRebuild && BACKFILL_PER_COMPILE > 0) {
      const idleMs = BACKFILL_IDLE_MIN > 0 ? await viewerIdleMs() : Infinity;
      const needMs = BACKFILL_IDLE_MIN * 60_000;
      if (idleMs < needMs) {
        // Human at the wheel — skip the bulk slice this compile and come back
        // 15min after their LAST interaction (re-checked then, so continued
        // browsing keeps pushing the drain out).
        backfillDeferredMs = needMs - idleMs + 30_000;
        console.log(
          `[wiki-service] backfill deferred: viewer active ${(idleMs / 60000).toFixed(1)}min ago — ` +
            `retry ${(backfillDeferredMs / 60000).toFixed(1)}min after their last interaction`,
        );
      } else {
        try {
          const manifest = JSON.parse(await readFile(`${WIKI_GIT_DIR}/planned.json`, "utf8"));
          const queued = Object.values(manifest.planned || {})
            .filter((p) => Number.isInteger(p.id))
            .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
            .slice(0, BACKFILL_PER_COMPILE)
            .map((p) => p.id);
          if (queued.length) {
            const before = dirty.length;
            for (const id of queued) if (!dirty.includes(id)) dirty.push(id);
            backfillAdded = dirty.length - before;
            console.log(`[wiki-service] backfill: +${backfillAdded} queued page(s) this compile`);
          }
        } catch { /* no manifest yet — nothing to drain */ }
      }
    }
    const args = fullRebuild
      ? [
          RECIPE_PATH, "--batch",
          "--batch-min-linked", String(BATCH_MIN_LINKED),
          "--batch-limit", String(BATCH_LIMIT),
          "--include-sources", "--max-sources", String(MAX_SOURCES),
          "--out-dir", WIKI_OUT_DIR,
        ]
      : [
          RECIPE_PATH, "--ids", dirty.join(","),
          "--include-sources", "--max-sources", String(MAX_SOURCES),
          "--out-dir", WIKI_OUT_DIR,
        ];
    if (ENV.WIKI_NOTEBOOK) args.push("--notebook", ENV.WIKI_NOTEBOOK);
    console.log(
      `[wiki-service] ${fullRebuild ? "FULL" : "incremental"} compile` +
        `${fullRebuild ? "" : ` (${dirty.length} dirty entities)`}`,
    );
    const { stdout } = await pexec("node", args, {
      env: childEnv,
      maxBuffer: 32 * 1024 * 1024,
      timeout: COMPILE_TIMEOUT_MS,
    });
    let tail = stdout.trim().split("\n").slice(-3).join(" | ");

    // Notebook → topic synthesis (research lives here, not on entity
    // pages). Non-fatal: entity pages already written above.
    try {
      const { stdout: so } = await pexec("node", [SYNTH_PATH], {
        env: childEnv,
        maxBuffer: 32 * 1024 * 1024,
        timeout: SYNTH_TIMEOUT_MS,
      });
      tail += " | " + so.trim().split("\n").slice(-1)[0];
    } catch (e) {
      console.error("[wiki-service] notebook synthesis failed (non-fatal):",
        (e?.stderr || e?.message || String(e)).toString().slice(0, 300));
    }

    // Vault-root home (Quartz `/`). Compiler-owned, distinct basename
    // from content/entities.md and notes/. Links across both layers.
    writeIfChanged(
      `${WIKI_GIT_DIR}/index.md`,
      [
        "---",
        'title: "Knowledge Vault"',
        "tags: [wiki, home]",
        "---",
        "",
        "# Knowledge Vault",
        "",
        "Generated from OpenBrain; your notes evolve alongside it.",
        "",
        "- [[entities|Entities]] — people, tools, projects, orgs (auto-generated)",
        "- [[notebooks|Notebooks]] — research groups: synthesis + sources + notes per notebook (auto-generated)",
        "- `notes/` — your own notes (hand-written; tethered back into OpenBrain)",
        "",
        "Generated pages regenerate from OpenBrain; never hand-edit them — " +
          "edit the source/thought (or your note) and the next compile reflects it.",
        "",
      ].join("\n"),
    );

    // Brain → wiki delete-propagation. Run AFTER the recipe writes
    // dirty entity pages and BEFORE we git-commit, so deletions land in
    // the same commit as regenerations (the git log then shows the wiki
    // shrinking in lockstep with the brain). Non-fatal: a failed sweep
    // just leaves stale pages until next compile.
    let sweepEntities = { kept: 0, deleted: 0 };
    let sweepNotebooks = { kept: 0, deleted: 0 };
    let sweepLeaves = { kept: 0, deleted: 0 };
    try {
      sweepEntities = await sweepOrphanEntityPages();
      sweepNotebooks = await sweepOrphanNotebookPages();
      // P1.5 — run AFTER entity/notebook sweeps so the leaf kept-set reflects
      // the final on-disk page set (deleted entity pages no longer count as
      // citing their leaves).
      sweepLeaves = await sweepOrphanLeafPages();
      if (sweepEntities.deleted || sweepNotebooks.deleted || sweepLeaves.deleted) {
        tail += ` | swept ${sweepEntities.deleted}+${sweepNotebooks.deleted}+${sweepLeaves.deleted} orphan(s)`;
      }
    } catch (e) {
      console.error("[wiki-service] orphan-sweep failed (non-fatal):",
        e?.message || e);
    }

    // AFTER pages + sweeps, so the on-disk diff is accurate.
    const plannedRemaining = await writePlannedManifest();
    // Keep the drain converging: this compile consumed a slice (or deferred
    // one for user activity) and more remains → schedule the next attempt
    // (single timer; any compile that runs in the meantime re-schedules
    // through this same path). A deferral retries 15min after the user's
    // last interaction; a consumed slice continues at the normal cadence.
    const continueMs = backfillDeferredMs > 0
      ? backfillDeferredMs
      : backfillAdded > 0 && plannedRemaining > 0 && BACKFILL_CONTINUE_MIN > 0
        ? BACKFILL_CONTINUE_MIN * 60_000
        : 0;
    if (continueMs > 0 && BACKFILL_PER_COMPILE > 0) {
      clearTimeout(backfillContinueTimer);
      backfillContinueTimer = setTimeout(
        () => { compile("backfill-continue").catch(() => {}); },
        continueMs,
      );
      console.log(
        `[wiki-service] backfill ${backfillDeferredMs ? "deferred" : "continues"}: ` +
          `${plannedRemaining} still queued — next attempt in ${(continueMs / 60000).toFixed(1)}min`,
      );
    }

    // Commit only if the compile changed something.
    await git(["add", "-A"]);
    const { stdout: status } = await git(["status", "--porcelain"]);
    let committed = false;
    if (status.trim()) {
      const ts = new Date().toISOString();
      await git(["commit", "-q", "-m", `wiki compile ${ts} (${reason}) — ${tail}`]);
      committed = true;
    }
    // Push when there's a new commit (or always, if a remote is set, to
    // recover from a prior failed push). Push failure never fails the
    // compile — the local commit (D16) is still the source of truth.
    let push = { pushed: false, reason: "skipped" };
    if (GIT_REMOTE && committed) push = await gitPush();

    // Persist compile watermark for the next incremental run. Use the
    // post-commit HEAD so the next note-diff starts after our own commit.
    let head = "";
    try { head = (await git(["rev-parse", "HEAD"])).stdout.trim(); } catch { /* */ }
    await writeState({
      last_compile_iso: new Date().toISOString(),
      last_commit: head || prevCommit || null,
      mode: fullRebuild ? "full" : "incremental",
    }).catch(() => {});

    lastStatus = {
      state: "idle", at: new Date().toISOString(), ok: true,
      summary: tail, committed, push,
      mode: fullRebuild ? "full" : "incremental",
      pull_ok: pull.ok !== false,
    };
    console.log(
      `[wiki-service] compile ok (committed=${committed}, ` +
        `pushed=${push.pushed}): ${tail}`,
    );
    return { ok: true, committed, summary: tail };
  } catch (e) {
    const msg = (e?.stderr || e?.message || String(e)).toString().slice(0, 1000);
    // Recovery commit: snapshot any files the recipe wrote before throwing,
    // so the next cycle's pull --rebase doesn't fail on a dirty tree
    // (otherwise: throw → unstaged files → rebase blocked → loop forever).
    let recoveryCommitted = false;
    try {
      await git(["add", "-A"]);
      const { stdout: status } = await git(["status", "--porcelain"]);
      if (status.trim()) {
        const ts = new Date().toISOString();
        await git(["commit", "-q", "-m",
          `wiki compile RECOVERY ${ts} — partial work after error: ${msg.slice(0, 200)}`,
        ]);
        recoveryCommitted = true;
        if (GIT_REMOTE) await gitPush().catch(() => {});
      }
    } catch (_) { /* recovery is best-effort; never mask the original error */ }
    lastStatus = {
      state: "idle", at: new Date().toISOString(), ok: false,
      error: msg, recovery_committed: recoveryCommitted,
    };
    console.error(
      `[wiki-service] compile FAILED (recovery_committed=${recoveryCommitted}):`,
      msg,
    );
    return { ok: false, error: msg, recovery_committed: recoveryCommitted };
  } finally {
    running = false;
  }
}

function authed(req) {
  const url = new URL(req.url, "http://x");
  const key = req.headers["x-brain-key"] || url.searchParams.get("key") || "";
  return MCP_ACCESS_KEY && key === MCP_ACCESS_KEY;
}

const send = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

const httpServer = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/healthz") {
    return send(res, 200, { ok: true, running });
  }
  if (req.method === "GET" && url.pathname === "/status") {
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    return send(res, 200, { running, last: lastStatus });
  }
  if (req.method === "POST" && url.pathname === "/recompile") {
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });
    if (running) return send(res, 409, { started: false, reason: "compile already in progress" });
    // Fire and forget; the caller polls /status or just trusts the schedule.
    compile("on-demand").catch(() => {});
    return send(res, 202, { started: true, message: "recompile started" });
  }
  return send(res, 404, { error: "not found" });
});

httpServer.listen(PORT, () => {
  console.log(
    `[wiki-service] listening on :${PORT} ` +
      `(daily compile ~${String(RECOMPILE_HOUR).padStart(2, "0")}:00 local; ` +
      `change-watch ${WATCH_ENABLED ? `every ${WATCH_INTERVAL_MIN}m` : "off"})`,
  );
});

// ── Deterministic daily compile at RECOMPILE_HOUR local time ────────────────
function msUntilNextDaily() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(RECOMPILE_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}
function scheduleDaily() {
  const ms = msUntilNextDaily();
  console.log(
    `[wiki-service] next daily compile in ${(ms / 3600000).toFixed(1)}h ` +
      `(~${String(RECOMPILE_HOUR).padStart(2, "0")}:00 local)`,
  );
  setTimeout(async () => {
    await compile("daily").catch(() => {});
    scheduleDaily();
  }, ms);
}

// ── Change-driven recompile (debounced) ─────────────────────────────────────
// Poll OpenBrain for sources/thoughts newer than the last compile. Only
// compile once activity SETTLES: a tick must see no growth vs the prior
// tick (so a research burst coalesces into one compile a few minutes
// after it stops landing) — no GPU churn while nothing changed.
let _watchPrevCount = -1;
async function changeWatchTick() {
  try {
    // Stand down entirely while ANY compile (boot/daily/on-demand/change)
    // is in progress. Firing compile() now would just skip (running
    // guard) without advancing last_compile_iso → the watcher would
    // re-detect the same rows forever (infinite-loop bug). Let the
    // running compile finish and advance the watermark first.
    if (running) return;
    const st = await readState();
    const since = st.last_compile_iso;
    if (!since) return; // no baseline yet (pre-first-compile)
    const enc = encodeURIComponent(since);
    const orF = `or=(created_at.gt.${enc},updated_at.gt.${enc})`;
    let n = 0;
    for (const tbl of ["sources", "thoughts"]) {
      const rows = await obFetch("GET", `${tbl}?select=id&${orF}&limit=200`);
      n += Array.isArray(rows) ? rows.length : 0;
    }
    // User notes are FILES first (working-draft model): a new/edited note is
    // uncommitted vault dirt, not a DB row, so the DB polls above never saw
    // it — a lone note waited for the 01:00 daily compile ("overnight" bug).
    // Count dirty note-tree files so a note triggers the same settled-compile.
    try {
      const { stdout } = await git(["status", "--porcelain", "--", ...NOTE_TREES]);
      n += stdout.split("\n").filter(Boolean).length;
    } catch { /* status failure — DB signal still applies */ }
    if (n === 0) { _watchPrevCount = -1; return; }
    if (_watchPrevCount === n) {
      // Settled (no new arrivals since the previous tick) → compile.
      // compile() advances last_compile_iso on success, so the next
      // tick's query returns ~0 and the watcher goes quiet.
      console.log(`[wiki-service] change-watch: ${n} new since last compile, settled → compiling`);
      _watchPrevCount = -1;
      const r = await compile("change").catch(() => ({ skipped: true }));
      // If it skipped (a compile slipped in), keep the count so the
      // next idle tick retries rather than dropping the signal.
      if (r && r.skipped) _watchPrevCount = n;
    } else {
      console.log(`[wiki-service] change-watch: ${n} new (was ${_watchPrevCount}); waiting for quiet`);
      _watchPrevCount = n;
    }
  } catch (e) {
    console.error("[wiki-service] change-watch error (non-fatal):", e?.message || e);
  }
}

if (COMPILE_ON_BOOT) compile("boot").catch(() => {});
scheduleDaily();
if (WATCH_ENABLED) setInterval(() => changeWatchTick(), WATCH_INTERVAL_MIN * 60_000);
