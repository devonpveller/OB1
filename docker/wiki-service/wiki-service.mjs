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
 *   RECOMPILE_INTERVAL_HOURS (=24)  COMPILE_ON_BOOT (=true)
 *   WIKI_BATCH_MIN_LINKED (=1)  WIKI_MAX_SOURCES (=5)  PORT (=8000)
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
const INTERVAL_MS = Math.max(1, Number(ENV.RECOMPILE_INTERVAL_HOURS || "24")) * 3600_000;
const COMPILE_ON_BOOT = (ENV.COMPILE_ON_BOOT || "true") !== "false";
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
const GIT_FORCE = ENV.WIKI_GIT_FORCE || "true";
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

async function ensureRepo() {
  await mkdir(WIKI_OUT_DIR, { recursive: true });
  if (!existsSync(`${WIKI_GIT_DIR}/.git`)) {
    await git(["init", "-q"]);
    await git(["config", "user.email", "wiki@openbrain.local"]);
    await git(["config", "user.name", "openbrain-wiki"]);
    // Keep .git out of the rendered site; record provenance of the layout.
    await writeFile(
      `${WIKI_GIT_DIR}/.gitignore`,
      ".quartz-cache/\npublic/\nnode_modules/\n",
    );
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "wiki: initial repo"]).catch(() => {});
    console.log("[wiki-service] initialized git repo at", WIKI_GIT_DIR);
  }
  // Keep the `origin` remote in sync with config (idempotent).
  if (GIT_REMOTE) {
    try {
      await git(["remote", "set-url", "origin", GIT_REMOTE]);
    } catch {
      await git(["remote", "add", "origin", GIT_REMOTE]).catch(() => {});
    }
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

async function compile(reason) {
  if (running) return { skipped: true, reason: "compile already in progress" };
  running = true;
  lastStatus = { state: "running", at: new Date().toISOString(), ok: null, summary: null, error: null };
  console.log(`[wiki-service] compile start (${reason})`);
  try {
    await ensureRepo();
    // The wiki is fully regenerable — wipe prior output so renamed/moved
    // pages (e.g. flat → type subfolders) and deleted entities don't
    // leave stale duplicates. .git + .gitignore live at WIKI_GIT_DIR,
    // not under WIKI_OUT_DIR, so they're untouched; the commit captures
    // the deletions + fresh tree.
    await rm(WIKI_OUT_DIR, { recursive: true, force: true });
    await mkdir(WIKI_OUT_DIR, { recursive: true });
    // Fresh entity / source_entities links before the wiki is built.
    await drainWorkerQueues();
    const childEnv = {
      ...ENV,
      OPEN_BRAIN_URL: ENV.OPEN_BRAIN_URL || "http://openbrain-rest",
      OPEN_BRAIN_SERVICE_KEY: ENV.OPEN_BRAIN_SERVICE_KEY || "local-trust",
      OB_WIKI_OUT_DIR: WIKI_OUT_DIR,
    };
    const args = [
      RECIPE_PATH,
      "--batch",
      "--batch-min-linked", String(BATCH_MIN_LINKED),
      "--batch-limit", String(BATCH_LIMIT),
      "--include-sources",
      "--max-sources", String(MAX_SOURCES),
      "--out-dir", WIKI_OUT_DIR,
    ];
    if (ENV.WIKI_NOTEBOOK) args.push("--notebook", ENV.WIKI_NOTEBOOK);
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
    lastStatus = {
      state: "idle", at: new Date().toISOString(), ok: true,
      summary: tail, committed, push,
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
  console.log(`[wiki-service] listening on :${PORT} (interval ${INTERVAL_MS / 3600000}h)`);
});

if (COMPILE_ON_BOOT) compile("boot").catch(() => {});
setInterval(() => compile("scheduled").catch(() => {}), INTERVAL_MS);
