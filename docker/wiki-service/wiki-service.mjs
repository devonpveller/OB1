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
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const pexec = promisify(execFile);

const ENV = process.env;
const PORT = parseInt(ENV.PORT || "8000", 10);
const MCP_ACCESS_KEY = ENV.MCP_ACCESS_KEY || "";
const WIKI_OUT_DIR = ENV.WIKI_OUT_DIR || "/wiki/content";
const WIKI_GIT_DIR = ENV.WIKI_GIT_DIR || "/wiki";
const RECIPE_PATH = ENV.RECIPE_PATH || "/recipes/entity-wiki/generate-wiki.mjs";
const INTERVAL_MS = Math.max(1, Number(ENV.RECOMPILE_INTERVAL_HOURS || "24")) * 3600_000;
const COMPILE_ON_BOOT = (ENV.COMPILE_ON_BOOT || "true") !== "false";
const BATCH_MIN_LINKED = ENV.WIKI_BATCH_MIN_LINKED || "1";
const MAX_SOURCES = ENV.WIKI_MAX_SOURCES || "5";

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
}

async function compile(reason) {
  if (running) return { skipped: true, reason: "compile already in progress" };
  running = true;
  lastStatus = { state: "running", at: new Date().toISOString(), ok: null, summary: null, error: null };
  console.log(`[wiki-service] compile start (${reason})`);
  try {
    await ensureRepo();
    const childEnv = {
      ...ENV,
      OPEN_BRAIN_URL: ENV.OPEN_BRAIN_URL || "http://openbrain-rest",
      OPEN_BRAIN_SERVICE_KEY: ENV.OPEN_BRAIN_SERVICE_KEY || "local-trust",
    };
    const args = [
      RECIPE_PATH,
      "--batch",
      "--batch-min-linked", String(BATCH_MIN_LINKED),
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
    const tail = stdout.trim().split("\n").slice(-3).join(" | ");

    // Commit only if the compile changed something.
    await git(["add", "-A"]);
    const { stdout: status } = await git(["status", "--porcelain"]);
    let committed = false;
    if (status.trim()) {
      const ts = new Date().toISOString();
      await git(["commit", "-q", "-m", `wiki compile ${ts} (${reason}) — ${tail}`]);
      committed = true;
    }
    lastStatus = {
      state: "idle", at: new Date().toISOString(), ok: true,
      summary: tail, committed,
    };
    console.log(`[wiki-service] compile ok (committed=${committed}): ${tail}`);
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
