/**
 * openbrain-research — HTTP + job layer (Research Engine P3/P4).
 *
 * Wires the real seams (llama-cpp chat/embeddings, the SearXNG private gateway,
 * direct page fetch+extract, the curator) around the testable `runResearch`
 * harness (harness.ts), and exposes the async job+poll API (OD-3):
 *   POST /research                -> {job_id}            (x-brain-key)
 *   GET  /research/jobs/:id        -> job status+result   (x-brain-key)
 *   GET  /research/jobs/:id/stream -> SSE progress        (x-brain-key)
 *   POST /research/jobs/:id/cancel -> cancel a queued/running job (x-brain-key)
 *   GET  /health                   -> {ok, db}            (unauthenticated)
 *
 * See harness.ts / GROUNDING-MODEL.md for the grounding guarantees.
 *
 * A job outlives the request that submitted it. Callers may either poll
 * `/research/jobs/:id`, or pass `callback: {chat_id, message_id}` to have the
 * finished report POSTed straight into that Open WebUI chat message when the job
 * terminates (see notifyChat) — required for runs longer than a chat turn.
 *
 * Env: DB_*, EMBEDDING_API_*, CHAT_API_*, MCP_ACCESS_KEY, CURATOR_URL,
 *      SEARCH_API_BASE, FETCH_TIMEOUT_MS, FETCH_MAX_CHARS, PORT,
 *      OWUI_BASE_URL + OWUI_API_KEY (async chat callback; unset = disabled)
 *      (+ harness.ts tunables).
 */
import { Pool } from "postgres";
import { curatorFileAttemptsFromEnv, curatorSettleMsFromEnv, type FiledRecord } from "./curator-filed.ts";
import { classifyCuratorOutcome, curatorRetriesFromEnv, curatorTimeoutMsFromEnv, delegateCuratorWithRetry, domainOf, engineBlock, ENGINE_BLOCK_START, extractLinks, extractTextFromHtml, extractTitle, HANDOFF_WAIT_LINE, proxyPolicy, renderResult, rewriteChatBody, selectRepoFiles } from "./lib.ts";
import { runResearch, type Deps, type SearchHit, type Page, type Progress, type FetchResult } from "./harness.ts";
import { createStagingSession, stageSource } from "./kb.ts";
import { screenSources } from "./injection.ts";
import { resolveContract } from "./contract.ts";
import { createChat, isModelDownError, ModelDownError, ModelHealth, type ChatOpts } from "./llm.ts";
import { cancelQueued, DeadlineError, Dispatcher, JobCancelled, jobStatus, markCancelled, parseDeadline, pauseForModelDown, SlotGate, type ClaimedJob } from "./jobs.ts";
import { type Caller, callerFor, inletRef, MismatchLog, onBehalfOf, parseCallers, promptOwner, resolveOrigin } from "./origin.ts";
import { actorOf, FOREIGN_PROMPTS_SQL, LISTED_FOR, MAY_ACT_SQL, omitPrompts, readViewer, sharedEvents, sharedJobView, sharedTree } from "./viewer.ts";
import { classifyClaimKind, CredibilityGateError, loadCredibilityModel } from "./credibility.ts";
import { assess } from "./admission.ts";
import { createScholarlyResolver, proxiedFetch, type ScholarlyResolver } from "./scholarly.ts";
import {
  appendEvent, buildTreeReport, closeBranch, createSteer, interHubEvent, interHubGaps, interHubRef, LANE_DEFAULT, LANE_KINDS,
  learningRecords, loadClaimGraph, loadTree, openGapBranches, readLaneConcurrency, stageEvent, SteerError, treeEstimate,
} from "./tree.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const DB_HOST = env("DB_HOST", "openbrain-db");
const DB_PORT = parseInt(env("DB_PORT", "5432"), 10);
const DB_NAME = env("DB_NAME", "openbrain");
const DB_USER = env("DB_USER", "postgres");
const DB_PASSWORD = env("DB_PASSWORD");

const EMBEDDING_API_BASE = env("EMBEDDING_API_BASE", "http://llama-cpp-embed:8080/v1").replace(/\/+$/, "");
const EMBEDDING_API_KEY = env("EMBEDDING_API_KEY", "not-needed");
const EMBEDDING_MODEL = env("EMBEDDING_MODEL", "local-embed");
const EMBEDDING_MAX_CHARS = parseInt(env("EMBEDDING_MAX_CHARS", "4000"), 10);

const CHAT_API_BASE = env("CHAT_API_BASE", "http://llama-cpp:8080/v1").replace(/\/+$/, "");
const CHAT_API_KEY = env("CHAT_API_KEY", "not-needed");
const CHAT_MODEL = env("CHAT_MODEL", "local-large");
const NOTHINK_SUFFIX = env("NOTHINK_SUFFIX", ":nothink");
// llm-queue admission attribution. The B2 admission controller reads the OpenAI
// `user` body field (LiteLLM forwards it — see config/litellm.config.yaml §B2)
// as the caller key and maps it to a priority CLASS with its own acceptable-wait
// budget (llm-queue policy.py). Only the ASYNC overnight digest/podcast lane
// (origin "notebook") attributes to the generous `ob-research` batch budget — it
// is happy to wait a long time for a deep dive. INTERACTIVE OWUI deep_research
// (origin "owui") and agent/manual jobs are left UNattributed so they keep their
// existing default-lane queue treatment — do not regress OWUI's separately-tuned
// concurrent-research behaviour. Set per-origin via RESEARCH_QUEUE_USER.
const RESEARCH_QUEUE_USER = env("RESEARCH_QUEUE_USER", "ob-research");
const QUEUE_USER_BY_ORIGIN: Record<string, string> = { notebook: RESEARCH_QUEUE_USER };
// A 429 from the llm-queue is BACKPRESSURE ("projected wait exceeds budget"), not
// a failure — the queue expects the caller to come back. LiteLLM only retries 3×
// before surfacing it, which a sustained morning saturation blows past, killing
// the whole research job. The research fan-out is allowed to take hours, so ride
// out saturation with capped exponential backoff for up to this budget per call.
const CHAT_RETRY_BUDGET_MS = parseInt(env("CHAT_RETRY_BUDGET_MS", "1500000"), 10); // 25 min
// ...but an upstream that is DOWN (a 502 naming name resolution / connection
// refused / upstream_error, or the gateway unreachable) is not backpressure:
// 2026-10-13 spent 25 min per call x 3 calls per job x every job on it. A down
// upstream gets this short budget, then the process-wide latch (llm.ts) fails
// every later call at once and PAUSES jobs until a probe sees the model back.
const CHAT_DOWN_BUDGET_MS = parseInt(env("CHAT_DOWN_BUDGET_MS", "180000"), 10); // 3 min
// Per-attempt bound on a chat request (a stalled connection must not hang a job
// forever). Above LiteLLM's worst case (request_timeout 600 s x 4 tries) so it
// never cuts a request the gateway is still honouring.
const CHAT_FETCH_TIMEOUT_MS = parseInt(env("CHAT_FETCH_TIMEOUT_MS", "2700000"), 10); // 45 min
// While the model is down: one probe at most this often, each bounded (a cold
// model load after a restart can take minutes).
const MODEL_PROBE_INTERVAL_MS = parseInt(env("RESEARCH_MODEL_PROBE_MS", "60000"), 10);
const MODEL_PROBE_TIMEOUT_MS = parseInt(env("RESEARCH_MODEL_PROBE_TIMEOUT_MS", "600000"), 10);
// A job paused for model_down more than this many times ends `error`.
const MAX_MODEL_DOWN_REQUEUES = parseInt(env("RESEARCH_MAX_MODEL_DOWN_REQUEUES", "6"), 10);

const MCP_ACCESS_KEY = env("MCP_ACCESS_KEY");
// Origin is bound to the caller's key (research-workbench P0, D17 item 1; origin.ts).
// RESEARCH_CALLERS declares one key per caller (name=origin:key;...). MCP_ACCESS_KEY keeps
// authenticating every existing caller and records RESEARCH_SHARED_KEY_ORIGIN. A malformed
// RESEARCH_CALLERS is reported loudly and ignored (only the shared key then authenticates),
// never half-applied.
const SHARED_KEY_ORIGIN = env("RESEARCH_SHARED_KEY_ORIGIN", "manual");
let CALLERS: Caller[];
try {
  CALLERS = parseCallers(env("RESEARCH_CALLERS"), MCP_ACCESS_KEY, SHARED_KEY_ORIGIN);
} catch (e) {
  console.error(`[research] RESEARCH_CALLERS ignored: ${(e as Error).message}`);
  CALLERS = parseCallers("", MCP_ACCESS_KEY, SHARED_KEY_ORIGIN);
}
const originMismatch = new MismatchLog();
// Open WebUI async completion callback. A research job outlives the tool call
// that submitted it, so the finished report is POSTed back into the originating
// chat message instead of the caller blocking on a poll loop.
//
// The base URL and key live HERE, not in the caller-supplied options: the client
// only names which chat/message to write to. If the callback target were part of
// the request body, anyone who could enqueue a job could aim this service's
// authenticated POST at an arbitrary host (SSRF) and leak the key with it.
// Unset OWUI_BASE_URL/OWUI_API_KEY disables the callback entirely; callers then
// fall back to polling, which still works.
const OWUI_BASE_URL = env("OWUI_BASE_URL", "").replace(/\/+$/, "");
const OWUI_API_KEY = env("OWUI_API_KEY");
// Floor on how soon after starting a job it may announce itself.
//
// Open WebUI runs with ENABLE_REALTIME_CHAT_SAVE off, so the BROWSER persists the
// finished turn a moment after the model stops streaming, writing the message
// content as the browser knows it. An announce that lands before that write gets
// overwritten by it. Minutes-long research is nowhere near this window, but a
// near-instant job (fully-reused claims) could be, and the failure is silent —
// the report is on the job row, just missing from the chat. Cheaper to wait.
const CALLBACK_MIN_AGE_MS = parseInt(env("CALLBACK_MIN_AGE_MS", "15000"), 10);
// Prefix for an appended report. The event APPENDS to whatever the model wrote
// when it handed off, which ends mid-sentence with no separator of its own, so
// without this the report runs straight onto the end of that line. The two
// halves were written minutes apart by different authors; the seam should show.
const SEPARATOR = `

---

`;
const CURATOR_URL = env("CURATOR_URL", "http://openbrain-curator:8000").replace(/\/+$/, "");
const SEARCH_API_BASE = env("SEARCH_API_BASE", "http://gateway:8080").replace(/\/+$/, "");
const SEARCH_K_DEFAULT = parseInt(env("SEARCH_K", "8"), 10);
const FETCH_TIMEOUT_MS = parseInt(env("FETCH_TIMEOUT_MS", "15000"), 10);
// Curator call policy (researchretry 2026-09-06; policy + tests in lib.ts). The
// curator delegation was the one fetch here with no timeout and no retry.
// CURATOR_TIMEOUT_MS bounds EACH attempt - connect, headers AND body - and is
// deliberately generous (default 180 s, NOT FETCH_TIMEOUT_MS): an ingest
// awaits an embedding, an LLM thread decision, a persist and a claims pass,
// and the goal is "cannot hang forever", not "fail fast". A timeout is NEVER
// retried - the curator may still be working, a resend would double-ingest -
// it fails once naming the elapsed time. CURATOR_RETRIES is the TOTAL number
// of attempts on CONNECT-PHASE failures only (refused, unreachable, reset
// during connect: Deno's "client error (Connect)") - never after the request
// was sent, never on a timeout, never on an HTTP answer. A 2xx without a JSON
// object body is NOT filed. Worst cases with defaults: refused = 3
// connect-fails (ms each) + 2 s + 4 s ~ 6 s; timeout = exactly one 180 s.
// Then the harness records the loss in research_jobs.error instead of
// hanging the slot. <= 0 / non-numeric values fall back to the defaults.
const CURATOR_TIMEOUT_MS = curatorTimeoutMsFromEnv(Deno.env.get("CURATOR_TIMEOUT_MS"));
const CURATOR_RETRIES = curatorRetriesFromEnv(Deno.env.get("CURATOR_RETRIES"));
// rw-curator-filed (2026-10-29: 4 of 80 runs in 30 h completed but were never filed - a 180 s timeout
// was final). After a timeout / dropped connection / curator 5xx the harness now WAITS up to
// CURATOR_SETTLE_MS for the curator's typed 'filed' event (research_job_events) and, if none appears,
// resends the package (persist is idempotent on research_key), CURATOR_FILE_ATTEMPTS hand-offs in all,
// 2 s / 4 s backoff between. Worst case with the defaults ~ 3 x (180 s + 30 s) + 6 s backoff + 3 x 6 s inner connect backoff ~ 10.9 min before
// the job ends error "(not filed)". CURATOR_FILE_ATTEMPTS=1 restores the single hand-off.
const CURATOR_FILE_ATTEMPTS = curatorFileAttemptsFromEnv(Deno.env.get("CURATOR_FILE_ATTEMPTS"));
const CURATOR_SETTLE_MS = curatorSettleMsFromEnv(Deno.env.get("CURATOR_SETTLE_MS"));
// Raised 8000 -> 16000 (research-trust 2026-09-11): the synthesizer saw 2 000
// chars of each source, so "thin evidence" was partly a slicing decision. The
// harness slice (SOURCE_SLICE_CHARS) moved with it.
const FETCH_MAX_CHARS = parseInt(env("FETCH_MAX_CHARS", "16000"), 10);
const PORT = parseInt(env("PORT", "8000"), 10);
// How many research jobs may run at once across the whole stack.
//
// research-workbench P4a (D16): there is no hand-set cap any more. The dispatcher's concurrency IS
// llm-queue's research-branch lane - ALL of LLM_QUEUE_SLOTS, no cap or floor here (D16 as amended
// 2026-10-26: how much research runs is the queue's decision) - read back through the
// gateway's GET-only /observe/queue/estimate pass-through at boot and every RESEARCH_LANE_REFRESH_MS,
// so a reloaded queue moves it with no other change. Unreadable = the queue's default (3) with a warning.
if (Deno.env.get("RESEARCH_MAX_CONCURRENCY") !== undefined) {
  console.warn("[lane] WARNING RESEARCH_MAX_CONCURRENCY is set and IGNORED: research concurrency is derived from llm-queue's research-branch lane (all of LLM_QUEUE_SLOTS)");
}
const LANE_URL = env("RESEARCH_LANE_URL", `${CHAT_API_BASE.replace(/\/v1$/, "")}/observe/queue/estimate`);
const LANE_REFRESH_MS = parseInt(env("RESEARCH_LANE_REFRESH_MS", "60000"), 10);
let laneConcurrency = LANE_DEFAULT;
/** Gap branches (D15 per-claim + D1 inter-hub) a tree may open from inside its runs. */
const MAX_GAP_BRANCHES = Math.max(0, parseInt(env("RESEARCH_TREE_MAX_GAP_BRANCHES", "3"), 10) || 0);

// Privacy: page fetches egress through the configured proxy (compose points
// this at the Mullvad VPN, http://vpn:8888; DNS follows the proxy scheme).
// Needs `--unstable-net` for Deno.createHttpClient.
//
// FAIL-CLOSED (2026-09-05, srcadm): a non-empty FETCH_PROXY_URL whose client
// cannot be built is a deploy-config bug (the flag missing from the run
// command), and the old behavior — one warning line, then DIRECT egress for
// every page fetch — silently un-proxied research traffic. The policy decision
// is proxyPolicy() in lib.ts (pure, tested); on "refuse" the process EXITS at
// startup so the failure is a crash loop at deploy time, never a leak at
// research time. Set FETCH_PROXY_URL="" to deliberately force direct.
const FETCH_PROXY_URL = env("FETCH_PROXY_URL", "socks5h://tor:9050");
const FETCH_UA = env(
  "FETCH_UA",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
);
let _httpClient: Deno.HttpClient | null | undefined; // undefined=uninit, null=direct
function fetchClient(): Deno.HttpClient | null {
  if (_httpClient !== undefined) return _httpClient;
  const url = FETCH_PROXY_URL.trim();
  let built: Deno.HttpClient | null = null;
  let buildError = "";
  if (url) {
    try {
      built = Deno.createHttpClient({ proxy: { url } });
    } catch (e) {
      buildError = (e as Error).message;
    }
  }
  switch (proxyPolicy(url, built !== null)) {
    case "direct":
      _httpClient = null; // operator's explicit choice (FETCH_PROXY_URL="")
      console.log("fetchPage egress DIRECT (FETCH_PROXY_URL is empty by configuration)");
      break;
    case "proxy":
      _httpClient = built;
      console.log(`fetchPage egress via ${url}`);
      break;
    case "refuse":
      console.error(
        `FETCH_PROXY_URL=${url} is configured but the proxy client cannot be built ` +
          `(${buildError}; is --unstable-net on the run command?). Refusing to start: ` +
          `falling back to direct egress would silently un-proxy every page fetch. ` +
          `Fix the deploy, or set FETCH_PROXY_URL="" to explicitly choose direct.`,
      );
      Deno.exit(78); // EX_CONFIG
  }
  return _httpClient;
}
// Probe at startup, not first fetch: a bad proxy config must be a visible
// crash loop the moment the container starts, not a landmine that detonates
// mid-research an hour later.
fetchClient();

// research-workbench P3a (D15 item 1): the keyed OpenAlex client with Crossref's polite pool as
// fallback, built ONLY on the fetch above's egress (proxiedFetch refuses a missing proxy client
// unless FETCH_PROXY_URL was deliberately emptied). No key or no mailto = no resolver: every
// identifier is then recorded `unresolved` with that reason, never a silent zero.
const OPENALEX_API_KEY = env("OPENALEX_API_KEY", "");
const SCHOLARLY_MAILTO = env("SCHOLARLY_MAILTO", "");
let scholarlyResolver: ScholarlyResolver | null = null;
if (SCHOLARLY_MAILTO) {
  const client = fetchClient();
  scholarlyResolver = createScholarlyResolver({
    fetch: proxiedFetch((u, i) => fetch(u, i as RequestInit), client, { direct: client === null && FETCH_PROXY_URL.trim() === "" }),
    openalexKey: OPENALEX_API_KEY, mailto: SCHOLARLY_MAILTO,
    timeoutMs: parseInt(env("SCHOLARLY_TIMEOUT_MS", "10000"), 10),
  });
  console.log(`scholarly resolver: OpenAlex ${OPENALEX_API_KEY ? "keyed" : "NOT configured (Crossref only)"}, egress ${scholarlyResolver.egress}`);
} else {
  console.log("scholarly resolver OFF: SCHOLARLY_MAILTO is unset (identifiers are recorded unresolved)");
}
// The D5 admission gate lives in the workbench; the fold calls it for a tombstoned held source.
const WORKBENCH_URL = env("WORKBENCH_URL", "").replace(/\/+$/, "");
const WORKBENCH_KEY = env("WORKBENCH_KEY", "");

// Self-reconnecting pool. deno-postgres v0.19.3 keeps handing back a pooled
// connection whose socket died after an openbrain-db restart, so every query
// throws `BrokenPipe (os error 32)` until the process restarts — surfacing to
// the OWUI deep_research tool as a research 500 (while web search is fine).
// ResilientPool preserves the `pool.connect()` / `client.release()` contract:
// it builds the Pool lazily, liveness-probes each checkout with `SELECT 1`, and
// rebuilds the Pool (single-flight) on a connection-class error, so a dropped DB
// self-heals without an operator restart. See memory: openbrain-mcp-stale-db-connection.
const DB_CONFIG = { hostname: DB_HOST, port: DB_PORT, database: DB_NAME, user: DB_USER, password: DB_PASSWORD };
const POOL_SIZE = 8;
type PgClient = Awaited<ReturnType<Pool["connect"]>>;

function isConnError(e: unknown): boolean {
  const m = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).toLowerCase();
  // deno-postgres raises every connection-level failure as `ConnectionError`
  // (name match = future-proof); the message list is a backstop for raw
  // Deno/OS socket errors that surface before the driver wraps them.
  return /connectionerror|broken pipe|os error 32|connection reset|connection refused|connection closed|connection terminated|session was terminated|terminated unexpectedly|econnreset|bad resource id|unexpected eof|not connected/.test(m);
}

class ResilientPool {
  #pool = new Pool(DB_CONFIG, POOL_SIZE, true); // lazy: connect on first use
  #rebuilding: Promise<void> | null = null;

  async connect(): Promise<PgClient> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      let client: PgClient | undefined;
      try {
        client = await this.#pool.connect();
        await client.queryArray("SELECT 1"); // probe: rejects a dead socket here
        return client;
      } catch (e) {
        lastErr = e;
        try { client?.release(); } catch { /* already broken */ }
        if (!isConnError(e)) throw e; // a real query/SQL error — surface it
        await this.#rebuild(); // dead socket(s) in the pool — get fresh ones
        // Brief backoff: Postgres refuses connections for a sub-second window
        // right after a restart (even once pg_isready reports ready), so a tight
        // retry would burn all attempts in that gap. Riding it out lets the
        // in-flight request recover instead of returning one transient 500.
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  // Swap in a fresh Pool synchronously, drain the old one in the background.
  // Single-flight so concurrent failures share one rebuild.
  #rebuild(): Promise<void> {
    if (!this.#rebuilding) {
      const old = this.#pool;
      this.#pool = new Pool(DB_CONFIG, POOL_SIZE, true);
      this.#rebuilding = (async () => { try { await old.end(); } catch { /* dead */ } })()
        .finally(() => { this.#rebuilding = null; });
    }
    return this.#rebuilding;
  }

  end(): Promise<void> { return this.#pool.end(); }
}

const pool = new ResilientPool();

// ── Real seams ───────────────────────────────────────────────────────────────
async function embed(text: string): Promise<number[]> {
  let input = String(text || "").slice(0, EMBEDDING_MAX_CHARS);
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${EMBEDDING_API_BASE}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${EMBEDDING_API_KEY}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
    });
    if (r.ok) {
      const v = (await r.json())?.data?.[0]?.embedding;
      if (!Array.isArray(v)) throw new Error("embedding endpoint returned no vector");
      return v;
    }
    const body = (await r.text()).slice(0, 300);
    if (r.status === 500 && /too large|batch size|n_tokens|exceed/i.test(body) && input.length > 200) {
      input = input.slice(0, Math.floor(input.length / 2));
      continue;
    }
    throw new Error(`embedding ${r.status}: ${body}`);
  }
  throw new Error("embedding failed after shrinking");
}

// The chat seam + model-down latch live in llm.ts (tested there against a stub
// gateway). One ModelHealth per process: it is what pauses the queue.
const modelHealth = new ModelHealth();
const llm = createChat({
  base: CHAT_API_BASE, apiKey: CHAT_API_KEY, model: CHAT_MODEL, nothinkSuffix: NOTHINK_SUFFIX,
  retryBudgetMs: CHAT_RETRY_BUDGET_MS, downBudgetMs: CHAT_DOWN_BUDGET_MS,
  fetchTimeoutMs: CHAT_FETCH_TIMEOUT_MS, probeTimeoutMs: MODEL_PROBE_TIMEOUT_MS,
  health: modelHealth,
});
function chat(system: string, user: string, opts: ChatOpts = {}, queueUser = ""): Promise<string> {
  return llm.chat(system, user, opts, queueUser);
}
// P4a (D16): tree branches (steers, gap work, idea research) call the model under their OWN LiteLLM
// virtual key, whose metadata.lane=research-branch attributes them to llm-queue's research-branch
// lane. Operator-provisioned (OB_RESEARCH_BRANCH_LLM_KEY); unset = the research key, with a warning
// (the calls then carry `user: research-branch`, which the queue reads as a fallback).
const BRANCH_CHAT_API_KEY = env("RESEARCH_BRANCH_LLM_KEY", "");
if (!BRANCH_CHAT_API_KEY) console.warn("[lane] WARNING RESEARCH_BRANCH_LLM_KEY is not set: branch jobs use the research key (provision a LiteLLM virtual key with metadata.lane=research-branch)");
const BRANCH_QUEUE_USER = "research-branch";
const branchLlm = createChat({
  base: CHAT_API_BASE, apiKey: BRANCH_CHAT_API_KEY || CHAT_API_KEY, model: CHAT_MODEL, nothinkSuffix: NOTHINK_SUFFIX,
  retryBudgetMs: CHAT_RETRY_BUDGET_MS, downBudgetMs: CHAT_DOWN_BUDGET_MS,
  fetchTimeoutMs: CHAT_FETCH_TIMEOUT_MS, probeTimeoutMs: MODEL_PROBE_TIMEOUT_MS,
  health: modelHealth,
});
function branchChat(system: string, user: string, opts: ChatOpts = {}): Promise<string> {
  return branchLlm.chat(system, user, opts, BRANCH_QUEUE_USER);
}
async function refreshLane(): Promise<void> {
  const n = await readLaneConcurrency(LANE_URL, BRANCH_CHAT_API_KEY || CHAT_API_KEY, (l) => console.warn(l));
  if (n !== laneConcurrency) {
    console.log(`[lane] research-branch lane concurrency ${laneConcurrency} -> ${n}`);
    laneConcurrency = n;
    dispatcher.wake();
  }
}

async function searchWeb(query: string, k: number): Promise<SearchHit[]> {
  const u = `${SEARCH_API_BASE}/search?q=${encodeURIComponent(query)}&format=json`;
  const r = await fetch(u, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`search ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json().catch(() => ({}));
  const results = Array.isArray(d?.results) ? d.results : [];
  return results.slice(0, k).map((x: Record<string, unknown>) => ({
    url: String(x.url || ""), title: String(x.title || ""),
    snippet: String(x.content || x.snippet || ""),
  })).filter((h: SearchHit) => h.url);
}

// Returns a DISCRIMINATED result so the harness can tell a real source from a
// TIMEOUT (flaky Tor circuit) from another fetch error — three different signals
// that used to collapse into a single `null`. `outcome`:
//   "ok"      — a usable page was retrieved (page is non-null)
//   "timeout" — the FETCH_TIMEOUT_MS abort fired (the page never responded)
//   "error"   — non-OK HTTP, non-HTML content, empty body, or a network error
async function fetchPage(url: string): Promise<FetchResult> {
  const ac = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; ac.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const client = fetchClient();
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "user-agent": FETCH_UA },
      ...(client ? { client } : {}),
    });
    // Phase 1.5 (research-trust) - the three ways a fetch can fail without the
    // network failing were one bucket, so "we could not READ it" and "it is not
    // THERE" were indistinguishable in every run record.
    if (!r.ok) return { page: null, outcome: "http" };
    const ct = r.headers.get("content-type") || "";
    if (ct && !/text\/html|text\/plain|application\/xhtml/i.test(ct)) return { page: null, outcome: "non_html" };
    const html = await r.text();
    const content = extractTextFromHtml(html).slice(0, FETCH_MAX_CHARS);
    if (!content) return { page: null, outcome: "empty_extract" };
    // finalUrl (kp-contract): where the page was really served from after
    // redirects; a job's contract judges that url (harness.ts withContract).
    // links (P3a): a lead is followed through these (D15 item 8).
    return {
      page: { url, title: extractTitle(html) || domainOf(url), content, domain: domainOf(url), links: extractLinks(html, r.url || url) },
      outcome: "ok", finalUrl: r.url || url,
    };
  } catch (e) {
    // AbortError fired by our timeout vs any other network failure.
    const isTimeout = timedOut || (e as Error)?.name === "AbortError";
    return { page: null, outcome: isTimeout ? "timeout" : "network" };
  } finally {
    clearTimeout(t);
  }
}

// Each attempt carries AbortSignal.timeout(CURATOR_TIMEOUT_MS) (added inside
// the wrapper so the unit tests can see it) over connect, headers and body; a
// timeout throws once and is not retried; a non-2xx answer still throws
// `curator <status>: <body>` exactly as before and is never retried.
async function delegateToCurator(pkg: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await delegateCuratorWithRetry(fetch, `${CURATOR_URL}/ingest/research-package`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-brain-key": MCP_ACCESS_KEY },
    body: JSON.stringify(pkg),
  }, {
    retries: CURATOR_RETRIES,
    timeoutMs: CURATOR_TIMEOUT_MS,
    log: (line) => console.warn(line),
  });
}

// ── Repo source sync (REPO-SOURCES-WIRING RS.1) ─────────────────────────────
// Onboarded repos' docs + structural manifests become PRIMARY sources: fetched at a PINNED
// commit sha (provenance + idempotency), injection-screened like any web page, staged +
// promoted via find_or_create_source. Public repos need no token; a read-scoped token can be
// provided via REPO_SYNC_GITHUB_TOKEN for private ones (never the bridge's App key).
const REPO_FILE_MAX_BYTES = parseInt(env("REPO_FILE_MAX_BYTES", "131072"), 10);   // 128 KB/file
const REPO_SYNC_MAX_FILES = parseInt(env("REPO_SYNC_MAX_FILES", "40"), 10);
const REPO_SYNC_TOKEN = env("REPO_SYNC_GITHUB_TOKEN", "");

function ghHeaders(): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": FETCH_UA,
    ...(REPO_SYNC_TOKEN ? { authorization: `Bearer ${REPO_SYNC_TOKEN}` } : {}),
  };
}

function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
  const m = String(repoUrl || "").trim().replace(/\.git$/, "")
    .match(/github\.com[/:]([^/]+)\/([^/?#]+)/i)
    || String(repoUrl || "").trim().match(/^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function ghJson(url: string): Promise<Record<string, unknown>> {
  const client = fetchClient();
  const r = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: ghHeaders(),
    ...(client ? { client } : {}),
  });
  if (!r.ok) throw new Error(`github ${r.status} for ${url.split("?")[0]}`);
  return await r.json();
}

/** Resolve a ref (branch/tag/sha; default = the repo's default branch) to a full commit sha. */
async function resolveRepoSha(owner: string, repo: string, ref: string): Promise<string> {
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
  const j = await ghJson(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref || "HEAD")}`);
  const sha = String(j.sha || "");
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("could not resolve a commit sha");
  return sha.toLowerCase();
}

/** All blob paths (+sizes) in the repo tree at `sha`. */
async function listRepoTree(owner: string, repo: string, sha: string):
    Promise<Array<{ path: string; size: number }>> {
  const j = await ghJson(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
  const tree = Array.isArray(j.tree) ? j.tree : [];
  return tree
    .filter((e: Record<string, unknown>) => e.type === "blob" && typeof e.path === "string")
    .map((e: Record<string, unknown>) => ({ path: String(e.path), size: Number(e.size ?? 0) }));
}

/** Fetch one raw repo file at a pinned sha — PLAIN TEXT (no HTML extraction), repo-file cap. */
async function fetchRawFile(owner: string, repo: string, sha: string, path: string):
    Promise<{ content: string; outcome: "ok" | "timeout" | "error" }> {
  const ac = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; ac.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const client = fetchClient();
    const r = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`,
      { signal: ac.signal, headers: { "user-agent": FETCH_UA }, ...(client ? { client } : {}) },
    );
    if (!r.ok) return { content: "", outcome: "error" };
    const text = (await r.text()).slice(0, REPO_FILE_MAX_BYTES);
    if (!text.trim()) return { content: "", outcome: "error" };
    return { content: text, outcome: "ok" };
  } catch (e) {
    const isTimeout = timedOut || (e as Error)?.name === "AbortError";
    return { content: "", outcome: isTimeout ? "timeout" : "error" };
  } finally {
    clearTimeout(t);
  }
}

// The fold's D5 reopening path (a tombstoned held source) - the workbench's admission gate.
async function admissionGate(req: Parameters<NonNullable<Deps["admission"]>>[0]) {
  const r = await fetch(`${WORKBENCH_URL}/workbench/contract/admission`, {
    method: "POST", headers: { "content-type": "application/json", "x-brain-key": WORKBENCH_KEY },
    body: JSON.stringify(req), signal: AbortSignal.timeout(30_000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`admission gate ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  return { outcome: String(d.outcome), admits: d.admits === true, reason: String(d.reason ?? ""), source_id: d.source_id ?? null };
}
// rw-curator-filed - did the curator file this job? The typed 'filed' event it wrote in the filing transaction.
async function findFiled(jobId: string): Promise<FiledRecord | null> {
  const c = await pool.connect();
  try {
    const r = await c.queryObject(
      `SELECT payload FROM public.research_job_events WHERE job_id = $1 AND type = 'filed' LIMIT 1`, [jobId]);
    return ((r.rows[0] as { payload?: FiledRecord } | undefined)?.payload) ?? null;
  } finally { c.release(); }
}
const realDeps: Deps = {
  embed, chat, searchWeb, fetchPage, delegateToCurator, findFiled,
  curatorFiling: { attempts: CURATOR_FILE_ATTEMPTS, settleMs: CURATOR_SETTLE_MS, log: (l) => console.warn(l) },
  scholarly: scholarlyResolver,
  admission: WORKBENCH_URL && WORKBENCH_KEY ? admissionGate : null,
};
void SEARCH_K_DEFAULT; // tunable also read inside harness.ts; surfaced here for ops visibility

// ── Job runner (OD-3 async job+poll) ─────────────────────────────────────────
/** Hold a too-fast job back until the chat turn that launched it has settled. */
function settleBeforeAnnounce(claimedAt: number): Promise<void> {
  const wait = CALLBACK_MIN_AGE_MS - (Date.now() - claimedAt);
  return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}

// Announce a terminal job into the Open WebUI chat that submitted it.
//
// WHY THIS IS NOT THE EVENT API. Open WebUI documents
// `POST /api/v1/chats/:chat/messages/:msg/event` with type "message" for exactly
// this, and it does persist — but only to the message's legacy `content` string.
// An Open WebUI 0.11 assistant message also carries `output`: an array of
// structured blocks (reasoning / message / function_call), and THAT is what the
// interface renders. Nothing in the event API, and nothing in
// `POST /chats/:id/messages/:msgId` either, can write `output`. So the first
// real run delivered a report that was in the database, in chat_message, and
// returned by the chat API — and still showed a blank chat, before and after a
// reload. Synthetic test messages have no `output`, which is why smoke tests
// passed while the real thing did not.
//
// So write the chat object directly. `merge_history` merges per message id, so
// sending one message leaves every other message alone; it does replace that
// message wholesale, hence read-modify-write of the complete object.
async function deliverReport(
  chatId: string,
  messageId: string,
  markdown: string,
): Promise<boolean> {
  const H = { "content-type": "application/json", authorization: `Bearer ${OWUI_API_KEY}` };
  const chatUrl = `${OWUI_BASE_URL}/api/v1/chats/${encodeURIComponent(chatId)}`;

  const r = await fetch(chatUrl, { headers: H });
  if (!r.ok) throw new Error(`read chat ${r.status}`);
  const payload = await r.json();
  const history = payload?.chat?.history;
  const message = history?.messages?.[messageId];
  if (!message) throw new Error("message not found in chat history");

  // REWRITE, not append (research-trust-report). Two reasons, one mechanism:
  // the final body must start with the report rather than with the model's
  // "research is running" line, and the gap-closing pass writes an INTERIM
  // status that the final write then replaces. `rewriteChatBody` strips the
  // engine's previous block and the one waiting line the tool asked the model
  // for, and leaves anything else the model said alone.
  const addition = rewriteChatBody(String(message.content ?? ""), markdown, SEPARATOR);
  message.content = addition;

  // Append a rendered block only when the message already speaks that dialect.
  // A message with no `output` renders from `content`, and inventing an array
  // for it would hide everything the model actually said.
  if (Array.isArray(message.output) && message.output.length > 0) {
    // Drop what the engine wrote last time (and the waiting line) the same way,
    // or a second write would stack a second block beside the first.
    message.output = message.output.filter((b: unknown) => {
      const text = JSON.stringify(b ?? "");
      return !text.includes(ENGINE_BLOCK_START) && !text.includes(HANDOFF_WAIT_LINE.slice(1, 40));
    });
    message.output.push({
      type: "message",
      id: `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: engineBlock(markdown) }],
    });
  }

  // currentId is deliberately omitted: merge_history keeps the existing one when
  // the incoming history does not name a message it can resolve.
  const w = await fetch(chatUrl, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ chat: { history: { messages: { [messageId]: message } } } }),
  });
  if (!w.ok) throw new Error(`write chat ${w.status}: ${(await w.text()).slice(0, 200)}`);

  // Trust the read, not the 200. This is the only step that can silently no-op.
  const v = await fetch(chatUrl, { headers: H });
  const stored = (await v.json())?.chat?.history?.messages?.[messageId];
  const inContent = typeof stored?.content === "string" && stored.content.trimEnd().endsWith(addition.trimEnd());
  const needsBlock = Array.isArray(message.output) && message.output.length > 0;
  const inOutput = !needsBlock || JSON.stringify(stored?.output ?? []).includes("output_text");
  return inContent && inOutput;
}

async function notifyChat(
  callback: unknown,
  markdown: string,
  jobId: string,
  final = true,
): Promise<void> {
  if (!OWUI_BASE_URL || !OWUI_API_KEY) return;
  const cb = callback as { chat_id?: string; message_id?: string } | undefined;
  const chatId = cb?.chat_id;
  const messageId = cb?.message_id;
  if (!chatId || !messageId) return;

  const eventUrl =
    `${OWUI_BASE_URL}/api/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/event`;
  const send = async (body: unknown): Promise<void> => {
    await fetch(eventUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${OWUI_API_KEY}` },
      body: JSON.stringify(body),
    });
  };

  let delivered = false;
  for (let attempt = 1; attempt <= 3 && !delivered; attempt++) {
    try {
      delivered = await deliverReport(chatId, messageId, markdown);
      if (!delivered) {
        console.warn(`[callback] job ${jobId} attempt ${attempt}/3: write reported OK but the report is not in the chat`);
      }
    } catch (e) {
      console.warn(`[callback] job ${jobId} attempt ${attempt}/3: ${(e as Error).message}`);
    }
    if (!delivered && attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  if (!delivered) {
    console.error(`[callback] job ${jobId}: gave up delivering to ${chatId}/${messageId}; the result is still on the job row`);
    return;
  }

  // Cosmetic tail, all best-effort. `chat:message:delta` renders into a tab that
  // is already open (the frontend handles that name; it does not handle
  // "message"), and it does not persist, so it cannot double up with the write
  // above. `notification` is socket-only by design — a live ping, not a record.
  // An INTERIM write is not the end of the run, so it sends no "complete"
  // anything: the delta would render the status line a second time under a body
  // that already carries it, and "Research complete." while a gap-closing pass
  // is still searching would be a lie told by the cosmetics.
  if (!final) {
    await send({ type: "status", data: { description: "Closing gaps…", done: false } }).catch(() => {});
    return;
  }
  await send({ type: "chat:message:delta", data: { content: SEPARATOR + markdown } }).catch(() => {});
  await send({ type: "status", data: { description: "Research complete.", done: true } }).catch(() => {});
  await send({ type: "notification", data: { type: "info", content: "Deep research finished." } }).catch(() => {});
}

// The report is real; only its FILING failed. Both readers get the same words:
// the OWUI tool renders this banner from the job row (owui/tools/deep_research.py)
// and notifyChat prepends it on the async path. Turning a silent loss into a loud
// loss that ALSO throws away the user's report would be worse than the defect.
function notSavedBanner(jobId: string, reason: string): string {
  return [
    "> **Not saved to Open Brain.** This research completed and the findings below are real, " +
    "but filing them failed, so they are NOT searchable and will not appear in the wiki.",
    ">",
    "> Reason: " + reason,
    ">",
    "> The full result is retained on job `" + jobId + "` and can be replayed.",
    "",
    "",
  ].join("\n");
}

// Per-job seams: every call honours the job's abort signal (cancel / caller
// deadline), and a call that hit the model-down latch is remembered so the job is
// PAUSED instead of finishing on fail-open / skipped-step output. Filing to the
// curator is refused once either happened: nothing degraded is ever stored.
//
// FILING IS THE POINT OF NO RETURN (round 2). The curator call carries no abort
// and its effect is real, so once it has STARTED a cancel or deadline no longer
// changes the outcome: the job finishes with what really happened (done, or the
// curator's error) instead of reading "cancelled, nothing stored" over a filing
// that exists. `filingJobs` lets the cancel endpoint say so to the caller.
type SeamState = { modelDown: ModelDownError | null; filing: boolean };
const filingJobs = new Set<string>();
function jobSeams(base: Deps, signal: AbortSignal, state: SeamState, jobId: string): Deps {
  const guard = () => {
    if (signal.aborted) throw signal.reason ?? new JobCancelled("aborted", "cancel_requested");
    if (state.modelDown) throw state.modelDown;
  };
  return {
    embed: (t) => { guard(); return base.embed(t); },
    chat: async (s, u, o) => {
      if (signal.aborted) throw signal.reason ?? new JobCancelled("aborted", "cancel_requested");
      try {
        return await (base.chat as (s: string, u: string, o?: ChatOpts) => Promise<string>)(s, u, { ...(o ?? {}), signal });
      } catch (e) {
        // Only a LATCHED outage (the short budget spent, or the flag already set) is
        // recorded; chat() itself rides out a blip, so this never fires on one.
        if (isModelDownError(e) && (e as ModelDownError).latched) state.modelDown ??= e as ModelDownError;
        throw e;
      }
    },
    searchWeb: (q, k) => { guard(); return base.searchWeb(q, k); },
    fetchPage: (u) => { guard(); return base.fetchPage(u); },
    findFiled: base.findFiled,
    curatorFiling: base.curatorFiling,
    delegateToCurator: (pkg) => {
      // synchronous with the flag below: a cancel lands wholly before or after. Only the FIRST hand-off is
      // guarded: a resend (rw-curator-filed) is part of the same filing, past the point of no return.
      if (!state.filing) guard();
      state.filing = true;
      filingJobs.add(jobId);
      return base.delegateToCurator(pkg);
    },
  };
}

// A job claimed by the dispatcher: it has already been flipped to status='running'
// (started_at set) by the atomic claim, so executeJob only runs the harness and
// persists the terminal (or paused) state — it never re-claims.
async function executeJob(job: ClaimedJob, signal: AbortSignal, gate: SlotGate = new SlotGate()): Promise<void> {
  const { jobId, query, thread_id, origin, options, refinery_id } = job;
  // P4a: the job's place in its tree. A root (or an idea's research) is its own tree's root.
  const rootId = job.root_job_id ?? jobId;
  const branchKind = job.branch_kind ?? "root";
  const inLane = LANE_KINDS.has(branchKind) || options?.lane === "research-branch";
  const stepOf = new Map<string, string>();
  const seamState: SeamState = { modelDown: null, filing: false };
  // Conservative: measured from CLAIM, not submit, so a job that queued first
  // only ever waits longer than it needs to. See CALLBACK_MIN_AGE_MS.
  const claimedAt = Date.now();
  const client = await pool.connect();
  const progress: Progress = async (phase, message, counters = {}) => {
    await client.queryObject(
      `UPDATE research_jobs SET status='running', progress=$2::jsonb WHERE id=$1`,
      [jobId, JSON.stringify({ phase, message, counters })],
    ).catch(() => {});
    // P4a: every stage is an event with its steering|due_process marker and a step id a steer names.
    const ev = await appendEvent(client, jobId, rootId, stageEvent(phase, message, counters))
      .catch((e) => { console.error(`[job ${jobId}] stage event not recorded: ${(e as Error).message}`); return null; });
    if (ev?.step_id) stepOf.set(phase, ev.step_id);
    // The ONE progress event that reaches the person rather than the job row.
    // The gap-closing pass can add minutes to a run that already looked finished
    // from the chat's side, so the run says what it is doing and what it has so
    // far. Nothing canonical is written here: no result, no curator, no job
    // state - `notifyChat` only rewrites the chat message, and the final write
    // replaces this body.
    if (phase === "gap_pass" && counters.interim) {
      await notifyChat(options?.callback, `_${message}_`, jobId, false).catch(() => {});
    }
  };
  try {
    // Phase 1 — resolve the per-job contract FIRST (fail-closed: a malformed
    // contract throws ContractError → the catch below writes status='error', so
    // the job never runs wide-open).
    const contract = resolveContract(options);
    const seedSources = Array.isArray(options?.seed_sources)
      ? (options.seed_sources as Array<{ url: string; title: string; content: string }>)
      : undefined;
    // Per-origin queue attribution: only the overnight digest/podcast lane gets the
    // generous `ob-research` budget; OWUI/agent/manual keep the default lane (their
    // own tuning). All origins still get chat()'s 429 backpressure retry.
    // queue_origin is engine-owned (set at submit from the caller's key; origin.ts).
    const queueUser = QUEUE_USER_BY_ORIGIN[String(options?.queue_origin ?? origin)] ?? "";
    // P4a (D16): a tree branch runs in the research-branch lane, under the branch key.
    const laneDeps: Deps = inLane
      ? { ...realDeps, chat: (s, u, o) => branchChat(s, u, o) }
      : queueUser
      ? { ...realDeps, chat: (s, u, o) => chat(s, u, o, queueUser) }
      : realDeps;
    // P4a round 2: every model call goes through the job's lane-slot gate. A steer's child running in
    // its parent's slot (lane full) interleaves with the parent there, so the calls in flight never
    // exceed the slots held.
    const baseDeps: Deps = jobSeams({ ...laneDeps, chat: (s, u, o) => gate.run(() => laneDeps.chat(s, u, o)) },
      signal, seamState, jobId);
    // P4a: a branch researches its steer IN the tree - it sees the anchor (its parent's query) and
    // the tree's current topic estimate.
    let runQuery = query;
    if (job.parent_job_id) {
      const { estimate } = await treeEstimate(client, rootId).catch(() => ({ estimate: "", origin: "" }));
      const ctx = [job.anchor ? `origin question: ${job.anchor}` : "", estimate && estimate !== job.anchor ? `current topic: ${estimate}` : ""]
        .filter(Boolean).join("; ");
      if (ctx) runQuery = `${query} (${ctx})`;
    }
    // Contract enforcement (search hits, fetches, final urls, seeds, KB recall,
    // reused claims) lives in runResearch (harness.ts withContract) - one point.
    const res = await runResearch(baseDeps, client, runQuery, {
      threadId: thread_id, origin,
      confidenceFloor: typeof options?.confidence_floor === "number" ? options.confidence_floor : undefined,
      seedSources,
      disableWebSearch: options?.disable_web_search === true,
      sourcesOnly: options?.sources_only === true,
      mode: options?.mode === "article" ? "article" : undefined,
      gapResearch: options?.gap_research === "preliminary" ? "preliminary" : undefined,
      dryRun: options?.dry_run === true,
      contract: contract ?? undefined,
      jobId, refineryId: refinery_id ?? null,
      onEvent: async (ev) => {
        await appendEvent(client, jobId, rootId, ev)
          .catch((e) => console.error(`[job ${jobId}] ${ev.type} event not recorded: ${(e as Error).message}`));
      },
    }, progress);
    // The harness swallows some step failures (fail-open classifiers,
    // prose render). If the job was cancelled or the model went down under it,
    // what came back is degraded: pause / cancel it instead of recording it done.
    // Once filing started, the real outcome is recorded whatever came after.
    if (!seamState.filing) {
      if (signal.aborted) throw signal.reason ?? new JobCancelled("aborted", "cancel_requested");
      if (seamState.modelDown) throw seamState.modelDown;
    } else if (signal.aborted) {
      console.log(`[job ${jobId}] cancel/deadline arrived after filing started - recording the real outcome`);
    }
    // Render the chat-facing markdown ONCE, here, and persist it on the job. Both
    // readers (the async callback below, and the tool's synchronous path) return
    // this same string — see lib.ts renderResult for why it moved server-side.
    const rendered = renderResult({
      synthesis: res.synthesis,
      prose: res.prose,
      report_type: res.reportType,
      cited_sources: res.citedSources,
      gaps: res.gaps,
      backstop: res.backstop,
      reuse_ratio: 1 - res.metrics.gap_ratio,
      // research-trust: the footer now states how much of the QUESTION was
      // answered. reuse_ratio is still passed and still ignored by the renderer.
      needs_status: res.needsStatus,
      search_record: res.searchRecord,
      gap_pass: res.gapPass,
      render_fidelity: res.renderFidelity,
    });
    // ── Curator honesty gate (incident 2026-08-31) ──────────────────────────
    // runResearch NEVER throws when the curator dies — it records the failure as
    // res.curator = { error } and returns normally (harness.ts, delegateToCurator
    // call site). This row was then written status='done', error=NULL, progress
    // "backstop=complete", which is indistinguishable from a run that landed. It
    // is why 244 runs lost their entire output between 2026-06-19 and 2026-08-31
    // with nothing in the data the operator actually reads. A run whose output
    // was not FILED is not done.
    // classifyCuratorOutcome is pure and unit-tested (lib.test.ts) — the rule
    // "a run that lost output never reads status='done', error=NULL" lives there
    // rather than in this un-testable DB path. progress.message now carries the
    // curator outcome too: the old "backstop=complete" was the INITIAL value of
    // the backstop variable and meant 'no backstop tripped', never 'it landed'.
    const outcome = classifyCuratorOutcome(res.curator as Record<string, unknown> | null);
    const resultJson = JSON.stringify({
      synthesis: res.synthesis, prose: res.prose, report_type: res.reportType, needs: res.needs,
      followup_queries: res.followupQueries, gaps: res.gaps,
      cited_sources: res.citedSources, reuse_claims: res.reuseClaims,
      thread_id: (res.curator?.thread_id as string) ?? thread_id, reuse_ratio: 1 - res.metrics.gap_ratio,
      curator: res.curator, backstop: res.backstop, fetch_stats: res.fetchStats,
      // research-trust: what the run IS, per-need verdicts, and the search
      // funnel. `outcome` is the field that says a search failed rather than a
      // topic being absent; without it research_jobs cannot tell them apart.
      outcome: res.outcome,
      needs_status: res.needsStatus,
      search_record: res.searchRecord,
      // research-trust-report: what the gap-closing pass added and closed. The
      // python fallback renderer reads this key for its footer line.
      gap_pass: res.gapPass,
      ungrounded_numbers: res.ungroundedNumbers,
      // …and what the RENDERED report says that the grounded answer does not.
      prose_ungrounded: res.proseUngrounded,
      // …and what the per-sentence fidelity check corrected in it.
      render_fidelity: res.renderFidelity,
      contract: contract ?? null, // Phase 1 — records what the job was ALLOWED to do
      // kp-contract — what it dropped, per stage (key absent on a job without a contract)
      ...(contract ? { contract_drops: res.contractDrops ?? null } : {}),
      // research-workbench P3a: one verdict per cited line + the audit list (D10), the admission
      // trail and per-line credibility (D15), the fold on a refinery session.
      entailment: res.entailment, verdicts: res.verdicts, admission_trail: res.admissionTrail,
      line_credibility: res.lineCredibility, fold: res.fold,
      rendered, // chat-facing markdown; absent on jobs cached before this field
    });
    const progressJson = JSON.stringify({
      phase: outcome.status === "error" ? "error" : "done",
      message: `outcome=${res.outcome} backstop=${res.backstop} curator=${outcome.state}`,
    });
    if (outcome.error) console.error(`[job ${jobId}] ${outcome.error}`);
    // P4a: gap work opens branches from inside the run (D15 per claim, D1 between hubs), queued
    // BELOW any pending human steer. Never from a gap branch; capped and deduplicated per tree.
    if (MAX_GAP_BRANCHES > 0 && !signal.aborted) {
      await openTreeGaps(client, jobId, rootId, res, stepOf).catch((e) =>
        console.error(`[job ${jobId}] gap branches not opened: ${(e as Error).message}`));
    }

    // `result` is written in FULL on both paths, including the failure one: the
    // report is real, only its filing failed, and the OWUI tool renders it from
    // this column behind the "Not saved to Open Brain" banner. Dropping it would
    // turn a silent loss into a loud loss that also destroys the user's answer.
    await client.queryObject(
      `UPDATE research_jobs SET status=$6, finished_at=now(), error=$5,
         result=$2::jsonb, metrics=$3::jsonb, progress=$4::jsonb WHERE id=$1`,
      [jobId, resultJson, JSON.stringify(res.metrics), progressJson, outcome.error, outcome.status],
    );
    // Persist first, announce second. If the announce fails the result is still
    // retrievable by poll; the reverse order could show a chat a report the job
    // then failed to record.
    await settleBeforeAnnounce(claimedAt);
    // Same banner as the blocking path, so the async reader is told the findings
    // were not filed instead of being handed an ordinary-looking report.
    await notifyChat(
      options?.callback,
      outcome.status === "error" ? notSavedBanner(jobId, outcome.reason ?? "unknown error") + rendered : rendered,
      jobId,
    );
  } catch (e0) {
    let e = e0;
    // Cancelled (caller request or deadline): a terminal status the caller reads.
    if ((signal.aborted && !seamState.filing) || e instanceof JobCancelled) {
      const c = signal.reason instanceof JobCancelled ? signal.reason : e instanceof JobCancelled ? e : null;
      const reason = c?.reason ?? "aborted";
      await markCancelled(client, jobId, reason, c?.code ?? "cancel_requested").catch(() => {});
      console.log(`[job ${jobId}] cancelled: ${reason}`);
      await notifyChat(options?.callback, `\n\n> Deep research job \`${jobId}\` was CANCELLED: ${reason}. Nothing was stored.`, jobId).catch(() => {});
      return;
    }
    // Model down: PAUSE (requeue) — the dispatcher re-checks the model and
    // re-runs it from the top; nothing was filed (jobSeams refuses filing).
    if (!seamState.filing && (isModelDownError(e) || seamState.modelDown)) {
      const md = seamState.modelDown ?? (e as ModelDownError);
      if (!modelHealth.isDown) modelHealth.markDown(md.reason, Date.now(), md.downCode);
      const since = modelHealth.downSince === null ? null : new Date(modelHealth.downSince).toISOString();
      const outcome = await pauseForModelDown(client, job, md.reason, since, MAX_MODEL_DOWN_REQUEUES, Date.now())
        .catch((pe) => { console.error(`[job ${jobId}] pause failed: ${(pe as Error).message}`); return "failed" as const; });
      console.log(`[job ${jobId}] model down -> ${outcome}`);
      if (outcome === "paused") return;
      if (outcome !== "failed") {
        await notifyChat(options?.callback, `\n\n> \u26a0 Deep research job \`${jobId}\` stopped: the model is unreachable (${md.reason}). Nothing was stored.`, jobId).catch(() => {});
        return;
      }
      e = new Error(`model_down: ${md.reason}`);
    }
    const failure = String((e as Error).message);
    await client.queryObject(
      `UPDATE research_jobs SET status='error', finished_at=now(), error=$2 WHERE id=$1`,
      [jobId, failure],
    ).catch(() => {});
    // A caller that no longer polls would otherwise wait forever on a dead job.
    // Announce the failure with the same anti-fabrication directive the grounded
    // path carries — a failed research run is the moment a model is most tempted
    // to answer from its own weights.
    await settleBeforeAnnounce(claimedAt);
    await notifyChat(
      options?.callback,
      [
        "",
        "",
        "> \u26a0 Deep research job `" + jobId + "` FAILED: " + failure,
        ">",
        "> Nothing was grounded and nothing was stored. Do NOT answer the question from " +
          "your own knowledge or other web/fetch tools \u2014 say the research failed and " +
          "offer to re-run it.",
      ].join("\n"),
      jobId,
    ).catch(() => {});
  } finally {
    filingJobs.delete(jobId);
    // P4a: a closed branch (or a root with branches) re-estimates the tree's topic and rebuilds the
    // cumulative report. A requeued (paused) job is not closed.
    await finishTree(client, jobId, rootId, branchKind, gate).catch((e) =>
      console.error(`[job ${jobId}] tree close failed: ${(e as Error).message}`));
    client.release();
  }
}

/** Gap branches for one finished run: per-claim gaps (the harness's gap work) and inter-hub gaps. */
async function openTreeGaps(
  c: Awaited<ReturnType<typeof pool.connect>>, jobId: string, rootId: string,
  res: Awaited<ReturnType<typeof runResearch>>, stepOf: Map<string, string>,
): Promise<void> {
  const gaps: Parameters<typeof openGapBranches>[3] = [];
  const reuseStep = stepOf.get("reuse") ?? [...stepOf.values()].pop();
  if (!reuseStep) return;
  for (const g of res.gapWork ?? []) {
    gaps.push({ kind: "gap", text: g.text, query: `Verify: ${g.text}`, ref: `claim:${g.claim_id}`, gap: { ...g } });
  }
  const graph = await loadClaimGraph(c, res.reuseClaims.map((r) => r.id), res.citedSources.map((s) => s.url ?? "").filter(Boolean));
  const lastStep = [...stepOf.values()].pop() ?? reuseStep;
  for (const h of interHubGaps(graph.nodes, graph.edges)) {
    await appendEvent(c, jobId, rootId, interHubEvent(h));
    gaps.push({
      kind: "interhub", text: `${h.a.sample} <-> ${h.b.sample}`,
      query: `How does "${h.a.sample}" relate to "${h.b.sample}"?`, ref: interHubRef(h),
      gap: { a: h.a, b: h.b, density: h.density, links: h.links },
    });
  }
  if (!gaps.length) return;
  const opened = [];
  for (const g of gaps) {
    opened.push(...await openGapBranches(c, jobId, g.kind === "gap" ? reuseStep : lastStep, [g], MAX_GAP_BRANCHES, resolveContract));
  }
  if (opened.length) { console.log(`[job ${jobId}] opened ${opened.length} gap branch(es)`); wake(); }
}

async function finishTree(c: Awaited<ReturnType<typeof pool.connect>>, jobId: string, rootId: string, branchKind: string, gate: SlotGate): Promise<void> {
  const r = await c.queryObject<{ status: string; branches: number }>(
    `SELECT status, (SELECT count(*)::int FROM research_jobs WHERE root_job_id = $2::uuid) AS branches
       FROM research_jobs WHERE id = $1::uuid`, [jobId, rootId]);
  const row = r.rows[0];
  if (!row || !["done", "error", "cancelled"].includes(row.status)) return;
  if (branchKind === "root" || branchKind === "idea") { if (!row.branches) return; }
  await closeBranch(c, jobId, (s, u) => gate.run(() => branchChat(s, u, { json: true, nothink: true })));
}

// ── Dispatcher: queued jobs, bounded by the research-branch lane (P4a, D16) ──
// POST /research only enqueues (status='queued'); the Dispatcher (jobs.ts) is the
// sole dispatcher. Each tick it cancels queued jobs past their caller deadline,
// claims nothing while the model is down (one bounded probe per interval
// instead), and otherwise claims a queued job with FOR UPDATE SKIP LOCKED - a
// human steer's branch first, then main lines, then gap work, FIFO within each
// (D3). The cap is laneConcurrency, re-read every tick. wake() nudges it the
// instant a job arrives or finishes; a 2s safety poll backstops.
const dispatcher = new Dispatcher({
  connect: () => pool.connect(),
  execute: executeJob,
  health: modelHealth,
  probe: () => llm.probe(RESEARCH_QUEUE_USER),
  maxConcurrency: () => laneConcurrency,
  steersShareParentSlot: true, // P4a round 2: a steer never waits for its parent behind a full lane
  probeIntervalMs: MODEL_PROBE_INTERVAL_MS,
  onExpired: (rows) => {
    for (const r of rows) {
      void notifyChat(r.options?.callback,
        `\n\n> Deep research job \`${r.id}\` was CANCELLED: its deadline passed before it ran. Nothing was stored.`,
        r.id).catch(() => {});
    }
  },
});
function wake(): void { dispatcher.wake(); }

// On boot, any row still 'running' was orphaned by a restart/crash (its in-process
// task is gone) and would hang 'running' forever — fixing a latent bug in the old
// fire-and-forget dispatch. Requeue so the drain loop re-runs it from the top.
async function recoverOrphanedJobs(): Promise<void> {
  try {
    const c = await pool.connect();
    try {
      const r = await c.queryObject(`UPDATE research_jobs SET status='queued', started_at=NULL WHERE status='running'`);
      if (r.rowCount) console.log(`requeued ${r.rowCount} orphaned running job(s) at boot`);
    } finally { c.release(); }
  } catch (e) { console.error("orphan recovery failed:", (e as Error).message); }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function callerOf(req: Request, url: URL): Caller | null {
  return callerFor(req.headers.get("x-brain-key") || url.searchParams.get("key"), CALLERS);
}
function authed(req: Request, url: URL): boolean {
  return callerOf(req, url) !== null;
}
// rw-identity round 2: who a READ is for (viewer.ts) - a Response when the caller may not name that user
function viewerOf(req: Request, url: URL): { sub: string } | Response {
  const caller = callerOf(req, url);
  if (!caller) return Response.json({ error: "unauthorized" }, { status: 401 });
  const v = readViewer(caller, req.headers.get("x-on-behalf-of"));
  return "error" in v ? Response.json({ error: v.error }, { status: v.status }) : v;
}
// rw-identity round 3: who owns a job that predates rw-identity (no research_prompts row) - the one
// operator (07-MULTI-USER); blank = nobody (its prompt is read by no caller)
const DEFAULT_SUB = (Deno.env.get("WORKSPACE_DEFAULT_SUB") ?? "").trim();
// round 5 (tester attempt 2): only the job's owner may act on it (steer, cancel) - viewer.ts MAY_ACT_SQL;
// rw-p4b-sessions: and an admin (asserted by the workspace's key only, actorOf) on a service's job
async function mayAct(c: { queryObject: <T>(q: string, a: unknown[]) => Promise<{ rows: T[] }> }, id: string, viewer: string, admin = false): Promise<boolean> {
  return !!(await c.queryObject<{ ok: boolean }>(MAY_ACT_SQL, [id, viewer, DEFAULT_SUB, admin])).rows[0]?.ok;
}
// rw-p4b-sessions: who acts on a write (viewer.ts actorOf) - a Response when the caller may not say so
function actingOf(req: Request, url: URL, viewer: { sub: string }): { actor: string; admin: boolean } | Response {
  const caller = callerOf(req, url);
  if (!caller) return Response.json({ error: "unauthorized" }, { status: 401 });
  const a = actorOf(caller, (k) => req.headers.get(k), viewer.sub);
  return "error" in a ? Response.json({ error: a.error }, { status: a.status }) : a;
}
// whether job `id`'s tree belongs to another user than the viewer, and its texts (round 4: a foreign
// viewer reads the allow-list of viewer.ts, the texts omitted from what is left)
async function scopeOf(c: { queryObject: <T>(q: string, a: unknown[]) => Promise<{ rows: T[] }> }, id: string, viewer: string): Promise<{ foreign: boolean; prompts: string[] }> {
  const row = (await c.queryObject<{ foreign_: boolean; prompts: string[] }>(FOREIGN_PROMPTS_SQL, [id, viewer, DEFAULT_SUB])).rows[0];
  return { foreign: !!row?.foreign_, prompts: row?.prompts ?? [] };
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  // research-workbench P3a: the D15 score of one URL, for the workbench's D5 admission gate
  // (debunked / credibility reopen paths). The SAME model and pre-ingestion stage a research run
  // uses - one implementation. A claim kind with no weight row answers 422 naming it.
  if (req.method === "POST" && url.pathname === "/research/credibility/score") {
    if (!authed(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
    let body: { url?: string; title?: string; content?: string; content_type?: string; claim_kind?: string };
    try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
    if (!body.url) return Response.json({ error: "url required" }, { status: 400 });
    const c = await pool.connect();
    try {
      const model = await loadCredibilityModel(c);
      const kind = body.claim_kind
        ? { kind: body.claim_kind, basis: "given by the caller" }
        : classifyClaimKind(model, `${body.title ?? ""}\n${(body.content ?? "").slice(0, 2000)}`);
      const a = await assess({ model, kind: kind.kind, resolver: scholarlyResolver, subjectTokens: [], now: new Date() },
        { url: body.url, title: body.title, content: body.content });
      return Response.json({
        available: true, value: a.total, floor: a.floor, version: model.modelVersion,
        reason: `${kind.kind} (${kind.basis}); ${a.reasons.join("; ")}`,
        family: a.score.family, signals: a.score.signals, scholarly: a.scholarly,
      });
    } catch (e) {
      if (e instanceof CredibilityGateError) return Response.json({ error: "credibility_gate", detail: e.message }, { status: 422 });
      return Response.json({ error: "score_failed", detail: (e as Error).message }, { status: 500 });
    } finally { c.release(); }
  }

  if (req.method === "GET" && url.pathname === "/health") {
    let db = false;
    try { const c = await pool.connect(); try { await c.queryArray("SELECT 1"); db = true; } finally { c.release(); } } catch { /* */ }
    // `model` is informational (the model-down latch); `ok` stays DB-only so a
    // model outage does not make the container look unhealthy and get restarted.
    return Response.json({ ok: db, db, service: "openbrain-research", model: modelHealth.snapshot() }, { status: db ? 200 : 503 });
  }

  // REPO-SOURCES-WIRING RS.1: ingest an onboarded repo's docs + structural manifests as
  // PRIMARY sources (pinned to a commit sha). Enumeration is engine-side + deterministic
  // (selectRepoFiles); every file is injection-screened; skips are REPORTED, never silent.
  if (req.method === "POST" && url.pathname === "/sources/repo-sync") {
    if (!authed(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
    let body: { repo_url?: string; ref?: string; files?: string[]; thread_id?: string };
    try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
    const parsed = parseOwnerRepo(body.repo_url || "");
    if (!parsed) return Response.json({ error: "repo_url required (github.com/<owner>/<repo>)" }, { status: 400 });
    const { owner, repo } = parsed;
    // Every synced file is injection-screened by the model. With the model down
    // the screen would fail OPEN on every file (and now does so at once), so
    // refuse instead of staging third-party text unscreened.
    if (modelHealth.isDown) {
      return Response.json({ ok: false, error: `model_down: ${modelHealth.code ?? "model_unreachable"}`, model: modelHealth.snapshot() },
                           { status: 503 });
    }
    try {
      const sha = await resolveRepoSha(owner, repo, (body.ref || "").trim());
      const explicit = Array.isArray(body.files) ? body.files.map(String).filter(Boolean) : [];
      const skipped: Array<{ path: string; reason: string }> = [];
      let paths: string[];
      if (explicit.length) {
        paths = explicit.slice(0, REPO_SYNC_MAX_FILES);
      } else {
        const tree = await listRepoTree(owner, repo, sha);
        const oversize = new Set(
          tree.filter((e) => e.size > REPO_FILE_MAX_BYTES).map((e) => e.path));
        const sel = selectRepoFiles(tree.map((e) => e.path).filter((p) => !oversize.has(p)),
                                    REPO_SYNC_MAX_FILES);
        paths = sel.selected;
        for (const p of sel.skipped) skipped.push({ path: p, reason: "over file cap" });
        for (const e of tree) {
          if (oversize.has(e.path)) skipped.push({ path: e.path, reason: `>${REPO_FILE_MAX_BYTES}B` });
        }
      }
      // Fetch each file at the PINNED sha (plain text; no HTML extraction).
      const pages: Page[] = [];
      for (const p of paths) {
        const fr = await fetchRawFile(owner, repo, sha, p);
        if (fr.outcome !== "ok") { skipped.push({ path: p, reason: `fetch ${fr.outcome}` }); continue; }
        pages.push({
          url: `https://github.com/${owner}/${repo}/blob/${sha}/${p}`,   // canonical provenance
          title: `${owner}/${repo}/${p} @ ${sha.slice(0, 10)}`,
          content: fr.content,
          domain: "github.com",
        });
      }
      // Same injection quarantine as web sources — repo docs are third-party text.
      const { clean, quarantined } = await screenSources(realDeps, pages);
      // Stage + promote (find_or_create_source dedups by url/hash — unchanged blobs no-op).
      const c = await pool.connect();
      let sessionId = "";
      const synced: string[] = [];
      try {
        sessionId = await createStagingSession(
          c, `repo-sync: ${owner}/${repo} @ ${sha.slice(0, 10)}`, body.thread_id || null, "manual");
        for (const p of clean) {
          try {
            const emb = await embed(`${p.title}\n\n${p.content}`);
            await stageSource(c, sessionId, p, emb);
            synced.push(p.url);
          } catch (e) {
            skipped.push({ path: p.url, reason: `stage failed: ${String((e as Error).message).slice(0, 80)}` });
          }
        }
      } finally { c.release(); }
      return Response.json({
        ok: true, repo: `${owner}/${repo}`, sha, session_id: sessionId,
        synced: synced.length, synced_urls: synced,
        quarantined: quarantined.map((q) => ({ url: q.url, reason: q.reason })),
        skipped,
      }, { status: 200 });
    } catch (e) {
      return Response.json({ ok: false, error: String((e as Error).message).slice(0, 200) },
                           { status: 502 });
    }
  }

  if (req.method === "POST" && url.pathname === "/research") {
    if (!authed(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
    let body: {
      query?: string; thread_id?: string; origin?: string; options?: Record<string, unknown>;
      seed_sources?: Array<{ url?: string; title?: string; content?: string }>;
      disable_web_search?: boolean; sources_only?: boolean; mode?: string; dry_run?: boolean; gap_research?: string;
      callback?: { chat_id?: string; message_id?: string };
      deadline_at?: string | number;
      inlet_ref?: { kind?: string; id?: string };
    };
    try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
    const query = (body.query || "").trim();
    if (!query) return Response.json({ error: "query required" }, { status: 400 });
    // Caller deadline (top-level or options.deadline_at; ISO or epoch ms). A
    // queued job past it is never started and ends `cancelled`; a running one is
    // aborted. Normalised to one ISO shape; garbage is refused, never stored.
    let deadlineAt: string | undefined;
    try {
      deadlineAt = parseDeadline(body.deadline_at ?? (body.options as Record<string, unknown> | undefined)?.deadline_at);
    } catch (e) {
      if (e instanceof DeadlineError) return Response.json({ error: e.message }, { status: 400 });
      throw e;
    }
    // Seed sources + flags ride in the options jsonb (no schema change). Normalize
    // seeds to {url,title,content}; drop empties.
    const seeds = Array.isArray(body.seed_sources)
      ? body.seed_sources
        .map((s) => ({ url: String(s?.url || ""), title: String(s?.title || ""), content: String(s?.content || "") }))
        .filter((s) => s.content.trim().length > 0)
      : [];
    // Async completion target. Only the IDs are taken from the caller — the host
    // and key are service-side env (see OWUI_BASE_URL above), so this cannot be
    // pointed anywhere. Absent/incomplete => the caller polls, as before.
    const cbChat = String(body.callback?.chat_id || "").trim();
    const cbMessage = String(body.callback?.message_id || "").trim();
    const callback = cbChat && cbMessage ? { chat_id: cbChat, message_id: cbMessage } : null;
    // deadline_at is re-added normalised; model_down_requeues and queue_origin are engine-owned.
    const { deadline_at: _dl, model_down_requeues: _mdr, queue_origin: _qo, ...callerOptions } = (body.options || {}) as Record<string, unknown>;
    void _dl; void _mdr; void _qo;
    // D17 item 1: the key decides the origin; a disagreeing body value is kept and logged once.
    const caller = callerOf(req, url)!;
    const resolved = resolveOrigin(caller, body.origin, QUEUE_USER_BY_ORIGIN);
    originMismatch.note(caller, resolved.claimed, resolved.origin);
    const inlet = inletRef(body as Record<string, unknown>);
    // rw-identity: a user named by the caller - accepted from Open WebUI's key only (origin.ts)
    const onBehalf = onBehalfOf(caller, body as Record<string, unknown>);
    if ("error" in onBehalf) return Response.json({ error: onBehalf.error }, { status: onBehalf.status });
    const owner = promptOwner(caller, onBehalf.sub);
    const options = {
      ...callerOptions,
      ...(deadlineAt ? { deadline_at: deadlineAt } : {}),
      ...(callback ? { callback } : {}),
      ...(seeds.length ? { seed_sources: seeds } : {}),
      ...(body.disable_web_search === true ? { disable_web_search: true } : {}),
      ...(body.sources_only === true ? { sources_only: true } : {}),
      ...(body.mode === "article" ? { mode: "article" } : {}),
      ...(body.dry_run === true ? { dry_run: true } : {}),
      ...(body.gap_research === "preliminary" ? { gap_research: "preliminary" } : {}),
      queue_origin: resolved.queueOrigin,
    };
    const c = await pool.connect();
    let jobId: string;
    try {
      await c.queryObject("BEGIN");
      const r = await c.queryObject<{ id: string }>(
        `INSERT INTO research_jobs (status, origin, query, thread_id, options, caller, origin_claimed, inlet_ref)
         VALUES ('queued', $1, $2, $3, $4::jsonb, $5, $6, $7::jsonb) RETURNING id`,
        [resolved.origin, query, body.thread_id || null, JSON.stringify(options), caller.name, resolved.claimed,
         inlet ? JSON.stringify(inlet) : null],
      );
      jobId = r.rows[0].id;
      // rw-identity: whose original prompt this is (research_prompts, init-documents.sql), in the
      // job's own transaction - a user's job is never stored without its owner (it would read as shared)
      if (owner) {
        await c.queryObject(
          `INSERT INTO research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, $2, $3, $4) ON CONFLICT (job_id) DO NOTHING`,
          [jobId, owner.owner_sub, owner.actor_sub, query],
        );
      }
      await c.queryObject("COMMIT");
    } catch (e) {
      await c.queryObject("ROLLBACK").catch(() => {});
      throw e;
    } finally { c.release(); }
    // Enqueue only — the background drain loop is the sole dispatcher (serializes
    // research fan-out so it can't flood LiteLLM). wake() lets it pick this up now.
    wake();
    // `callback_armed` is the client's contract: false means nothing will be
    // announced (no callback given, or the service has no OWUI credentials), so
    // the client must poll. Never let a caller wait on a callback that is off.
    return Response.json({
      job_id: jobId,
      status: "queued",
      ...(deadlineAt ? { deadline_at: deadlineAt } : {}),
      callback_armed: Boolean(callback && OWUI_BASE_URL && OWUI_API_KEY),
    }, { status: 202 });
  }

  // List recent jobs (pull model): a thin client calls this to show "your recent
  // research" and retrieve completed runs without holding the chat open. Optional
  // ?status= exact filter, ?limit= (1-50, default 10). Newest first.
  if (req.method === "GET" && url.pathname === "/research/jobs") {
    const viewer = viewerOf(req, url);
    if (viewer instanceof Response) return viewer;
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "10", 10) || 10));
    const statusFilter = url.searchParams.get("status");
    const c = await pool.connect();
    try {
      const r = await c.queryObject(
        `SELECT j.id, j.status, left(j.query, 120) AS query, j.created_at, j.finished_at,
           CASE WHEN j.status='queued' THEN
             (SELECT count(*)+1 FROM research_jobs q
              WHERE q.status='queued' AND q.created_at < j.created_at)::int
           END AS queue_position
         FROM research_jobs j
         WHERE ($2::text IS NULL OR j.status = $2) AND ${LISTED_FOR("j", "$3", "$4")}
         ORDER BY j.created_at DESC LIMIT $1`,
        [limit, statusFilter, viewer.sub, DEFAULT_SUB],
      );
      return Response.json({ jobs: r.rows });
    } finally { c.release(); }
  }

  // Cancel: a queued job ends `cancelled` at once; a running one is aborted (its
  // in-flight LLM request too) and ends `cancelled` within moments. A terminal
  // job is left as it is. The caller reads the outcome from GET /research/jobs/:id.
  const cancelMatch = url.pathname.match(/^\/research\/jobs\/([0-9a-f-]{36})\/cancel$/i);
  if (req.method === "POST" && cancelMatch) {
    const viewer = viewerOf(req, url);
    if (viewer instanceof Response) return viewer;
    const id = cancelMatch[1];
    const acting = actingOf(req, url, viewer);
    if (acting instanceof Response) return acting;
    {
      const c0 = await pool.connect();
      try {
        // another user's job is answered as a missing one (the owner, or its service, alone may cancel;
        // rw-p4b-sessions: and an admin, a service's job)
        if (!(await mayAct(c0, id, viewer.sub, acting.admin))) return Response.json({ error: "not found" }, { status: 404 });
      } finally { c0.release(); }
    }
    let reason = "cancel requested by the caller";
    try {
      const b = await req.json() as { reason?: unknown };
      if (typeof b?.reason === "string" && b.reason.trim()) reason = b.reason.trim().slice(0, 200);
    } catch { /* no body is fine */ }
    const c = await pool.connect();
    try {
      if (await cancelQueued(c, id, reason)) {
        console.log(`[job ${id}] cancelled while queued: ${reason}`);
        return Response.json({ job_id: id, status: "cancelled" });
      }
      const st = await jobStatus(c, id);
      if (st === null) return Response.json({ error: "not found" }, { status: 404 });
      if (st === "running" && filingJobs.has(id)) {
        // Past the point of no return: the curator is filing this run. The job will
        // end with its real outcome; say so instead of promising a cancel.
        return Response.json({
          job_id: id, status: "running", filing: true,
          note: "filing to the curator has started; the job will finish with its real outcome",
        }, { status: 409 });
      }
      if (st === "running") {
        dispatcher.cancelRunning(id, reason);
        return Response.json({ job_id: id, status: "cancelling" }, { status: 202 });
      }
      return Response.json({ job_id: id, status: st, note: "already terminal" });
    } finally { c.release(); }
  }

  // P4a: steer a job - a child branch rooted at the named step, while the job keeps running.
  const steerMatch = url.pathname.match(/^\/research\/jobs\/([0-9a-f-]{36})\/steer$/i);
  if (req.method === "POST" && steerMatch) {
    const caller = callerOf(req, url);
    if (!caller) return Response.json({ error: "unauthorized" }, { status: 401 });
    const viewer = viewerOf(req, url);
    if (viewer instanceof Response) return viewer;
    const acting = actingOf(req, url, viewer);
    if (acting instanceof Response) return acting;
    {
      const c0 = await pool.connect();
      try {
        // round 5: only the owner steers (a steer's answer carries the job's anchor and topic);
        // rw-p4b-sessions: an admin steers a service's job (the operator, 2026-10-30)
        if (!(await mayAct(c0, steerMatch[1], viewer.sub, acting.admin))) return Response.json({ error: "not found" }, { status: 404 });
      } finally { c0.release(); }
    }
    let b: { step_id?: unknown; text?: unknown; contract?: unknown; context_snapshot?: unknown; seed_sources?: unknown };
    try { b = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
    const c = await pool.connect();
    try {
      const opened = await createSteer(c, {
        parentId: steerMatch[1], stepId: String(b.step_id ?? ""), text: String(b.text ?? ""), contract: b.contract,
        caller: caller.name, contextSnapshot: b.context_snapshot, actorSub: acting.actor, seedSources: b.seed_sources,
      }, resolveContract);
      console.log(`[job ${steerMatch[1]}] steered at ${opened.step_id} -> branch ${opened.child_job_id}${acting.admin ? " (an admin)" : ""}`);
      wake();
      return Response.json(opened, { status: 201 });
    } catch (e) {
      if (e instanceof SteerError) return Response.json({ error: e.code, detail: e.message }, { status: e.status });
      return Response.json({ error: "steer_failed", detail: (e as Error).message }, { status: 500 });
    } finally { c.release(); }
  }

  // P4a: the session record as a tree - branches, steers (where the operator steered, with what
  // they were made against), the cumulative report and one exploratory learning record per branch.
  const treeMatch = url.pathname.match(/^\/research\/jobs\/([0-9a-f-]{36})\/(tree|events)$/i);
  if (req.method === "GET" && treeMatch) {
    const viewer = viewerOf(req, url);
    if (viewer instanceof Response) return viewer;
    const c = await pool.connect();
    try {
      const scope = await scopeOf(c, treeMatch[1], viewer.sub);
      const foreign = scope.prompts;
      if (treeMatch[2] === "events") {
        const after = parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
        const r = await c.queryObject(
          `SELECT id::text, job_id::text, root_job_id::text, step_id, type, kind, trail, payload, created_at
             FROM research_job_events
            WHERE root_job_id = (SELECT coalesce(root_job_id, id) FROM research_jobs WHERE id = $1::uuid) AND id > $2
            ORDER BY id LIMIT 1000`, [treeMatch[1], after]);
        const rows = r.rows as Record<string, unknown>[];
        return Response.json(scope.foreign ? omitPrompts({ events: sharedEvents(rows) }, foreign) : { events: rows });
      }
      const t = await loadTree(c, treeMatch[1]);
      if (!t) return Response.json({ error: "not found" }, { status: 404 });
      const tree: Record<string, unknown> = {
        root_job_id: t.root.id, topic_estimate: t.estimate, origin: t.root.query,
        branches: t.nodes.map((n) => ({ id: n.id, parent_job_id: n.parent_job_id, branch_kind: n.branch_kind, rooted_step_id: n.rooted_step_id, anchor: n.anchor, query: n.query, status: n.status })),
        steers: t.steers, report: buildTreeReport(t), learning_records: learningRecords(t),
      };
      return Response.json(scope.foreign ? omitPrompts(sharedTree(tree), foreign) : tree);
    } finally { c.release(); }
  }

  const jobMatch = url.pathname.match(/^\/research\/jobs\/([0-9a-f-]{36})(\/stream)?$/i);
  if (req.method === "GET" && jobMatch) {
    const viewer = viewerOf(req, url);
    if (viewer instanceof Response) return viewer;
    const id = jobMatch[1];
    let scope = { foreign: false, prompts: [] as string[] };
    {
      const c = await pool.connect();
      try { scope = await scopeOf(c, id, viewer.sub); } finally { c.release(); }
    }
    const stream = !!jobMatch[2];
    const getJob = async () => {
      const c = await pool.connect();
      try {
        // queue_position (1-based rank among queued jobs ahead of this one) +
        // queue_depth (total queued) let an inlet show "Queued — position N of M".
        // eta_seconds is a self-calibrating estimate off the average run duration
        // over the last 7 days (fallback 1800s): for a QUEUED job it's position ×
        // avg (time until it even starts); for the RUNNING job it's the remaining
        // run time (avg − elapsed, floored at 0) so the active job reads "~Xm left"
        // instead of an ambiguous position-less state. Null for terminal jobs.
        const r = await c.queryObject(
          `WITH avg_run AS (
             SELECT coalesce((SELECT extract(epoch FROM avg(finished_at - started_at))
                              FROM research_jobs
                              WHERE status='done' AND started_at IS NOT NULL
                                AND finished_at > now() - interval '7 days'), 1800) AS secs)
           SELECT j.id, j.status, j.progress, j.result, j.metrics, j.error,
             CASE WHEN j.status='queued' THEN
               (SELECT count(*)+1 FROM research_jobs q
                WHERE q.status='queued' AND q.created_at < j.created_at)::int
             END AS queue_position,
             (SELECT count(*) FROM research_jobs r WHERE r.status='queued')::int AS queue_depth,
             CASE
               WHEN j.status='queued' THEN
                 round((SELECT count(*)+1 FROM research_jobs q
                        WHERE q.status='queued' AND q.created_at < j.created_at)
                       * (SELECT secs FROM avg_run))::int
               WHEN j.status='running' AND j.started_at IS NOT NULL THEN
                 greatest(0, round((SELECT secs FROM avg_run)
                                   - extract(epoch FROM (now() - j.started_at))))::int
             END AS eta_seconds
           FROM research_jobs j WHERE j.id=$1`, [id]);
        const row = r.rows[0] as Record<string, unknown> | undefined;
        if (!row) return null;
        return scope.foreign ? omitPrompts(sharedJobView(row), scope.prompts) : row;
      } finally { c.release(); }
    };
    if (!stream) {
      const job = await getJob();
      // `model` = the process-wide model-down latch, so a caller can tell "queued
      // behind other work" from "paused because the model is unreachable".
      return job ? Response.json({ ...job, model: modelHealth.snapshot() }) : Response.json({ error: "not found" }, { status: 404 });
    }
    const body = new ReadableStream({
      async start(ctrl) {
        const enc = new TextEncoder();
        for (let i = 0; i < 600; i++) {
          const job = await getJob() as { status?: string } | null;
          if (!job) { ctrl.enqueue(enc.encode(`event: error\ndata: {"error":"not found"}\n\n`)); break; }
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify(job)}\n\n`));
          if (job.status === "done" || job.status === "error" || job.status === "cancelled") break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        ctrl.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }

  return new Response("not found", { status: 404 });
});

console.log(`openbrain-research listening on :${PORT} (curator=${CURATOR_URL}, search=${SEARCH_API_BASE}, lane=${LANE_URL})`);

// Requeue any jobs orphaned by a restart, then start the single background
// dispatcher. This is the ONLY thing that runs queued jobs.
void refreshLane().finally(() => {
  setInterval(() => { void refreshLane(); }, Math.max(1000, LANE_REFRESH_MS));
  void recoverOrphanedJobs().then(() => { void dispatcher.run(); });
});
