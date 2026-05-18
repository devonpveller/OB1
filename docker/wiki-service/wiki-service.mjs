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
import { mkdir, writeFile, readFile, copyFile, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

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

// Pre-compile entity extraction. The worker drains the thought + source
// queues so entity/source_entities links are fresh before the wiki is
// built (this is what makes sources attach to the RIGHT entity). Each
// worker call processes a bounded batch; we loop until both queues are
// empty or WORKER_DRAIN_MAX_MIN is hit. Non-fatal: a compile still runs
// on whatever has been extracted so far.
const WORKER_URL = ENV.WORKER_URL || "http://openbrain-entity-worker:8000";
const DRAIN_BEFORE_COMPILE = (ENV.DRAIN_BEFORE_COMPILE || "true") !== "false";
const WORKER_DRAIN_MAX_MIN = Math.max(1, Number(ENV.WORKER_DRAIN_MAX_MIN || "30"));

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
  const wantIgnore = ".quartz-cache/\npublic/\nnode_modules/\n.wikistate.json\n";
  let curIgnore = "";
  try { curIgnore = await readFile(`${WIKI_GIT_DIR}/.gitignore`, "utf8"); } catch { /* */ }
  if (!curIgnore.includes(".wikistate.json")) {
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
async function ingestNotes(prevCommit) {
  if (!existsSync(NOTES_DIR)) return { ingested: 0, deleted: 0 };
  let changed = [];
  let deleted = [];
  try {
    if (prevCommit) {
      const { stdout } = await git([
        "diff", "--name-status", `${prevCommit}..HEAD`, "--", "notes/",
      ]);
      for (const line of stdout.split("\n")) {
        const m = line.match(/^([ACMRD])\S*\t(.+?)(?:\t(.+))?$/);
        if (!m) continue;
        const status = m[1];
        const file = (m[3] || m[2]).trim();
        if (!file.endsWith(".md") || /(^|\/)README\.md$/i.test(file)) continue;
        if (status === "D") deleted.push(file);
        else changed.push(file);
      }
    } else {
      const { stdout } = await git(["ls-files", "notes/"]);
      changed = stdout.split("\n").filter((f) => f.endsWith(".md") && !/README\.md$/i.test(f));
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
      // notebook = first folder under notes/, else "notes".
      const parts = rel.split("/"); // notes/<maybe-nb>/file.md
      const notebook = parts.length > 2 ? parts[1] : "notes";
      const title = parts[parts.length - 1].replace(/\.md$/, "");
      const meta = { source: "user_note", note_path: rel, notebook, title };
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
async function dirtyEntityIds(prevIso) {
  if (!prevIso) return null; // null → full rebuild
  try {
    const rows = await obFetch(
      "GET",
      `entities?select=id&updated_at=gte.${encodeURIComponent(prevIso)}&limit=5000`,
    );
    return Array.isArray(rows) ? rows.map((r) => r.id) : [];
  } catch (e) {
    console.error("[wiki-service] dirty-entity query failed; full rebuild:", e?.message || e);
    return null;
  }
}

async function compile(reason) {
  if (running) return { skipped: true, reason: "compile already in progress" };
  running = true;
  lastStatus = { state: "running", at: new Date().toISOString(), ok: null, summary: null, error: null };
  console.log(`[wiki-service] compile start (${reason})`);
  try {
    await ensureRepo();
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
      timeout: 55 * 60_000,
    });
    let tail = stdout.trim().split("\n").slice(-3).join(" | ");

    // Notebook → topic synthesis (research lives here, not on entity
    // pages). Non-fatal: entity pages already written above.
    try {
      const { stdout: so } = await pexec("node", [SYNTH_PATH], {
        env: childEnv,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30 * 60_000,
      });
      tail += " | " + so.trim().split("\n").slice(-1)[0];
    } catch (e) {
      console.error("[wiki-service] notebook synthesis failed (non-fatal):",
        (e?.stderr || e?.message || String(e)).toString().slice(0, 300));
    }

    // Vault-root home (Quartz `/`). Compiler-owned, distinct basename
    // from content/entities.md and notes/. Links across both layers.
    await writeFile(
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
        "- [[topic|Topics]] — cross-source research syntheses (auto-generated)",
        "- `notes/` — your own notes (hand-written; tethered back into OpenBrain)",
        "",
        "Generated pages regenerate from OpenBrain; never hand-edit them — " +
          "edit the source/thought (or your note) and the next compile reflects it.",
        "",
      ].join("\n"),
    );

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
    lastStatus = { state: "idle", at: new Date().toISOString(), ok: false, error: msg };
    console.error("[wiki-service] compile FAILED:", msg);
    return { ok: false, error: msg };
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
