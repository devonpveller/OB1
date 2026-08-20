/**
 * openbrain-research — HTTP + job layer (Research Engine P3/P4).
 *
 * Wires the real seams (llama-cpp chat/embeddings, the SearXNG private gateway,
 * direct page fetch+extract, the curator) around the testable `runResearch`
 * harness (harness.ts), and exposes the async job+poll API (OD-3):
 *   POST /research                -> {job_id}            (x-brain-key)
 *   GET  /research/jobs/:id        -> job status+result   (x-brain-key)
 *   GET  /research/jobs/:id/stream -> SSE progress        (x-brain-key)
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
import { extractTextFromHtml, extractTitle, domainOf, selectRepoFiles, renderResult } from "./lib.ts";
import { runResearch, type Deps, type SearchHit, type Page, type Progress, type FetchResult } from "./harness.ts";
import { createStagingSession, stageSource } from "./kb.ts";
import { screenSources } from "./injection.ts";
import { resolveContract, permitsUrl, permitsQuery, type ResolvedContract } from "./contract.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const DB_HOST = env("DB_HOST", "openbrain-db");
const DB_PORT = parseInt(env("DB_PORT", "5432"), 10);
const DB_NAME = env("DB_NAME", "openbrain");
const DB_USER = env("DB_USER", "postgres");
const DB_PASSWORD = env("DB_PASSWORD");

const EMBEDDING_API_BASE = env("EMBEDDING_API_BASE", "http://llama-cpp-embed:8080/v1").replace(/\/+$/, "");
const EMBEDDING_API_KEY = env("EMBEDDING_API_KEY", "not-needed");
const EMBEDDING_MODEL = env("EMBEDDING_MODEL", "bge-m3");
const EMBEDDING_MAX_CHARS = parseInt(env("EMBEDDING_MAX_CHARS", "4000"), 10);

const CHAT_API_BASE = env("CHAT_API_BASE", "http://llama-cpp:8080/v1").replace(/\/+$/, "");
const CHAT_API_KEY = env("CHAT_API_KEY", "not-needed");
const CHAT_MODEL = env("CHAT_MODEL", "qwen36-27b");
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

const MCP_ACCESS_KEY = env("MCP_ACCESS_KEY");
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
const FETCH_MAX_CHARS = parseInt(env("FETCH_MAX_CHARS", "8000"), 10);
const PORT = parseInt(env("PORT", "8000"), 10);
// How many research jobs may run at once across the whole stack. Default 1 =
// strict global serialization: at most one job's ~12-15 LLM calls are ever in
// flight, so a burst of research requests can't flood LiteLLM / the llm-queue
// admission controller and delay all chat traffic. Raise only if the inference
// plane can absorb concurrent research fan-out. Jobs queue (FIFO by created_at)
// and a background drain loop dispatches them; see drainLoop() below.
const MAX_CONCURRENCY = Math.max(1, parseInt(env("RESEARCH_MAX_CONCURRENCY", "1"), 10) || 1);

// Privacy: page fetches egress through Tor (socks5h = DNS resolved through Tor,
// matching SearXNG's settings.yml). Reaches `tor:9050` via ai-stack_default.
// Needs `--unstable-net`; if unavailable we warn and fall back to direct rather
// than break research for all callers. Set FETCH_PROXY_URL="" to force direct.
const FETCH_PROXY_URL = env("FETCH_PROXY_URL", "socks5h://tor:9050");
const FETCH_UA = env(
  "FETCH_UA",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
);
let _httpClient: Deno.HttpClient | null | undefined; // undefined=uninit, null=direct
function fetchClient(): Deno.HttpClient | null {
  if (_httpClient !== undefined) return _httpClient;
  const url = FETCH_PROXY_URL.trim();
  if (!url) { _httpClient = null; return _httpClient; }
  try {
    _httpClient = Deno.createHttpClient({ proxy: { url } });
    console.log(`fetchPage egress via ${url}`);
  } catch (e) {
    console.warn(`FETCH_PROXY_URL=${url} unavailable (${(e as Error).message}); needs --unstable-net. Falling back to DIRECT.`);
    _httpClient = null;
  }
  return _httpClient;
}

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

async function chat(
  system: string,
  user: string,
  opts: { json?: boolean; nothink?: boolean } = {},
  queueUser = "",
): Promise<string> {
  const model = opts.nothink ? `${CHAT_MODEL}${NOTHINK_SUFFIX}` : CHAT_MODEL;
  const body = JSON.stringify({
    model, temperature: 0.2,
    ...(queueUser ? { user: queueUser } : {}),
    ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  const deadline = Date.now() + CHAT_RETRY_BUDGET_MS;
  for (let attempt = 0; ; attempt++) {
    let r: Response;
    try {
      r = await fetch(`${CHAT_API_BASE}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${CHAT_API_KEY}`, "Content-Type": "application/json" },
        body,
      });
    } catch (e) {
      // Connection reset / network blip — transient. Ride it out within budget.
      if (Date.now() >= deadline) throw e;
      await sleep(backoffMs(attempt));
      continue;
    }
    if (r.ok) {
      const d = await r.json();
      return d?.choices?.[0]?.message?.content ?? "";
    }
    const text = (await r.text()).slice(0, 300);
    // 429 = llm-queue backpressure; 502/503/504 = upstream swap/restart blips.
    // All are "come back later", not genuine errors — retry within budget. A
    // real 4xx (400/401/422) or 500 surfaces immediately.
    const retryable = r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504;
    if (retryable && Date.now() < deadline) {
      console.log(`chat ${r.status} (backpressure); retry in ${Math.round(backoffMs(attempt) / 1000)}s [attempt ${attempt + 1}]`);
      await sleep(backoffMs(attempt));
      continue;
    }
    throw new Error(`chat ${r.status}: ${text}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
// Capped exponential backoff with jitter: ~10s, 15s, 22s … cap 90s.
function backoffMs(attempt: number): number {
  const base = Math.min(90_000, 10_000 * Math.pow(1.5, attempt));
  return Math.floor(base * (0.75 + Math.random() * 0.5));
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
    if (!r.ok) return { page: null, outcome: "error" };
    const ct = r.headers.get("content-type") || "";
    if (ct && !/text\/html|text\/plain|application\/xhtml/i.test(ct)) return { page: null, outcome: "error" };
    const html = await r.text();
    const content = extractTextFromHtml(html).slice(0, FETCH_MAX_CHARS);
    if (!content) return { page: null, outcome: "error" };
    return { page: { url, title: extractTitle(html) || domainOf(url), content, domain: domainOf(url) }, outcome: "ok" };
  } catch (e) {
    // AbortError fired by our timeout vs any other network failure.
    const isTimeout = timedOut || (e as Error)?.name === "AbortError";
    return { page: null, outcome: isTimeout ? "timeout" : "error" };
  } finally {
    clearTimeout(t);
  }
}

async function delegateToCurator(pkg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${CURATOR_URL}/ingest/research-package`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-brain-key": MCP_ACCESS_KEY },
    body: JSON.stringify(pkg),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`curator ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
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

const realDeps: Deps = { embed, chat, searchWeb, fetchPage, delegateToCurator };
void SEARCH_K_DEFAULT; // tunable also read inside harness.ts; surfaced here for ops visibility

// Phase 1 — enforce a resolved contract at the deps boundary (the gather loop is
// untouched): drop red-line queries + non-permitted search hits, and hard-block a
// fetch of a non-permitted URL. Budget/seed enforcement lives in the harness.
function withContract(deps: Deps, rc: ResolvedContract): Deps {
  return {
    ...deps,
    searchWeb: async (q: string, k: number): Promise<SearchHit[]> => {
      if (!permitsQuery(rc, q)) return [];
      const hits = await deps.searchWeb(q, k);
      return hits.filter((h) => permitsUrl(rc, h.url));
    },
    fetchPage: (url: string): Promise<FetchResult> =>
      permitsUrl(rc, url) ? deps.fetchPage(url) : Promise.resolve({ page: null, outcome: "error" }),
  };
}

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

  const addition = SEPARATOR + markdown;
  message.content = (message.content ?? "") + addition;

  // Append a rendered block only when the message already speaks that dialect.
  // A message with no `output` renders from `content`, and inventing an array
  // for it would hide everything the model actually said.
  if (Array.isArray(message.output) && message.output.length > 0) {
    message.output.push({
      type: "message",
      id: `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: addition }],
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
  const inContent = typeof stored?.content === "string" && stored.content.endsWith(addition);
  const needsBlock = Array.isArray(message.output) && message.output.length > 0;
  const inOutput = !needsBlock || JSON.stringify(stored?.output ?? []).includes("output_text");
  return inContent && inOutput;
}

async function notifyChat(
  callback: unknown,
  markdown: string,
  jobId: string,
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
  await send({ type: "chat:message:delta", data: { content: SEPARATOR + markdown } }).catch(() => {});
  await send({ type: "status", data: { description: "Research complete.", done: true } }).catch(() => {});
  await send({ type: "notification", data: { type: "info", content: "Deep research finished." } }).catch(() => {});
}

// A job claimed by the drain loop: it has already been flipped to status='running'
// (started_at set) by the atomic claim, so executeJob only runs the harness and
// persists the terminal state — it never re-claims.
type ClaimedJob = { jobId: string; query: string; thread_id: string | null; origin: string; options: Record<string, unknown> };

async function executeJob(job: ClaimedJob): Promise<void> {
  const { jobId, query, thread_id, origin, options } = job;
  // Conservative: measured from CLAIM, not submit, so a job that queued first
  // only ever waits longer than it needs to. See CALLBACK_MIN_AGE_MS.
  const claimedAt = Date.now();
  const client = await pool.connect();
  const progress: Progress = async (phase, message, counters = {}) => {
    await client.queryObject(
      `UPDATE research_jobs SET status='running', progress=$2::jsonb WHERE id=$1`,
      [jobId, JSON.stringify({ phase, message, counters })],
    ).catch(() => {});
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
    const queueUser = QUEUE_USER_BY_ORIGIN[origin] ?? "";
    const baseDeps: Deps = queueUser
      ? { ...realDeps, chat: (s, u, o) => chat(s, u, o, queueUser) }
      : realDeps;
    // Contract enforcement wraps searchWeb/fetchPage (no gather-loop change).
    const jobDeps: Deps = contract ? withContract(baseDeps, contract) : baseDeps;
    const res = await runResearch(jobDeps, client, query, {
      threadId: thread_id, origin,
      confidenceFloor: typeof options?.confidence_floor === "number" ? options.confidence_floor : undefined,
      seedSources,
      disableWebSearch: options?.disable_web_search === true,
      sourcesOnly: options?.sources_only === true,
      mode: options?.mode === "article" ? "article" : undefined,
      gapResearch: options?.gap_research === "preliminary" ? "preliminary" : undefined,
      dryRun: options?.dry_run === true,
      contract: contract ?? undefined,
    }, progress);
    // Render the chat-facing markdown ONCE, here, and persist it on the job. Both
    // readers (the async callback below, and the tool's synchronous path) return
    // this same string — see lib.ts renderResult for why it moved server-side.
    const rendered = renderResult({
      synthesis: res.synthesis,
      cited_sources: res.citedSources,
      gaps: res.gaps,
      backstop: res.backstop,
      reuse_ratio: 1 - res.metrics.gap_ratio,
    });
    await client.queryObject(
      `UPDATE research_jobs SET status='done', finished_at=now(),
         result=$2::jsonb, metrics=$3::jsonb, progress=$4::jsonb WHERE id=$1`,
      [jobId, JSON.stringify({
        synthesis: res.synthesis, prose: res.prose, needs: res.needs,
        followup_queries: res.followupQueries, gaps: res.gaps,
        cited_sources: res.citedSources, reuse_claims: res.reuseClaims,
        thread_id: (res.curator?.thread_id as string) ?? thread_id, reuse_ratio: 1 - res.metrics.gap_ratio,
        curator: res.curator, backstop: res.backstop, fetch_stats: res.fetchStats,
        contract: contract ?? null, // Phase 1 — records what the job was ALLOWED to do
        skeptic: res.skeptic ?? null, // Phase 2 — per-run audit (challenges/downgrades/refuted/dropped)
        rendered, // chat-facing markdown; absent on jobs cached before this field
      }), JSON.stringify(res.metrics), JSON.stringify({ phase: "done", message: `backstop=${res.backstop}` })],
    );
    // Persist first, announce second. If the announce fails the result is still
    // retrievable by poll; the reverse order could show a chat a report the job
    // then failed to record.
    await settleBeforeAnnounce(claimedAt);
    await notifyChat(options?.callback, rendered, jobId);
  } catch (e) {
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
    client.release();
  }
}

// ── Drain loop: serialize queued jobs, bounded by MAX_CONCURRENCY ────────────
// POST /research only enqueues (status='queued'); this single background loop is
// the sole dispatcher. It claims the oldest queued job FIFO with FOR UPDATE SKIP
// LOCKED (atomic even if MAX_CONCURRENCY>1 claims overlap), runs it, and on
// completion frees the slot. With the default MAX_CONCURRENCY=1 this is strict
// global serialization — exactly one research fan-out hits the inference plane at
// a time. wake() nudges the loop the instant a job arrives or finishes; a 2s
// safety poll backstops any missed wake.
let _wake: (() => void) | null = null;
function wake(): void { _wake?.(); }
function waitForWake(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; _wake = null; clearTimeout(t); resolve(); };
    const t = setTimeout(finish, timeoutMs);
    _wake = finish;
  });
}

async function claimNext(): Promise<ClaimedJob | null> {
  const c = await pool.connect();
  try {
    const r = await c.queryObject<{ id: string; query: string; thread_id: string | null; origin: string; options: Record<string, unknown> }>(
      `UPDATE research_jobs SET status='running', started_at=now()
       WHERE id = (SELECT id FROM research_jobs WHERE status='queued'
                   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id, query, thread_id, origin, options`,
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return { jobId: row.id, query: row.query, thread_id: row.thread_id, origin: row.origin, options: row.options };
  } finally { c.release(); }
}

async function drainLoop(): Promise<void> {
  let inFlight = 0;
  while (true) {
    // Fill every free slot with the next queued job.
    while (inFlight < MAX_CONCURRENCY) {
      let job: ClaimedJob | null = null;
      try { job = await claimNext(); }
      catch (e) { console.error("claimNext failed:", (e as Error).message); break; }
      if (!job) break; // queue empty
      inFlight++;
      executeJob(job)
        .catch((e) => console.error("executeJob failed:", (e as Error).message))
        .finally(() => { inFlight--; wake(); });
    }
    // Slots full or queue drained — sleep until a job arrives/finishes (or poll).
    await waitForWake(2000);
  }
}

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
function authed(req: Request, url: URL): boolean {
  const k = req.headers.get("x-brain-key") || url.searchParams.get("key");
  return !!k && !!MCP_ACCESS_KEY && k === MCP_ACCESS_KEY;
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    let db = false;
    try { const c = await pool.connect(); try { await c.queryArray("SELECT 1"); db = true; } finally { c.release(); } } catch { /* */ }
    return Response.json({ ok: db, db, service: "openbrain-research" }, { status: db ? 200 : 503 });
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
    };
    try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
    const query = (body.query || "").trim();
    if (!query) return Response.json({ error: "query required" }, { status: 400 });
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
    const options = {
      ...(body.options || {}),
      ...(callback ? { callback } : {}),
      ...(seeds.length ? { seed_sources: seeds } : {}),
      ...(body.disable_web_search === true ? { disable_web_search: true } : {}),
      ...(body.sources_only === true ? { sources_only: true } : {}),
      ...(body.mode === "article" ? { mode: "article" } : {}),
      ...(body.dry_run === true ? { dry_run: true } : {}),
      ...(body.gap_research === "preliminary" ? { gap_research: "preliminary" } : {}),
    };
    const c = await pool.connect();
    let jobId: string;
    try {
      const r = await c.queryObject<{ id: string }>(
        `INSERT INTO research_jobs (status, origin, query, thread_id, options)
         VALUES ('queued', $1, $2, $3, $4::jsonb) RETURNING id`,
        [["owui", "agent", "notebook", "manual"].includes(body.origin || "") ? body.origin : "owui",
         query, body.thread_id || null, JSON.stringify(options)],
      );
      jobId = r.rows[0].id;
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
      callback_armed: Boolean(callback && OWUI_BASE_URL && OWUI_API_KEY),
    }, { status: 202 });
  }

  // List recent jobs (pull model): a thin client calls this to show "your recent
  // research" and retrieve completed runs without holding the chat open. Optional
  // ?status= exact filter, ?limit= (1-50, default 10). Newest first.
  if (req.method === "GET" && url.pathname === "/research/jobs") {
    if (!authed(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
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
         WHERE ($2::text IS NULL OR j.status = $2)
         ORDER BY j.created_at DESC LIMIT $1`,
        [limit, statusFilter],
      );
      return Response.json({ jobs: r.rows });
    } finally { c.release(); }
  }

  const jobMatch = url.pathname.match(/^\/research\/jobs\/([0-9a-f-]{36})(\/stream)?$/i);
  if (req.method === "GET" && jobMatch) {
    if (!authed(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const id = jobMatch[1];
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
        return r.rows[0] ?? null;
      } finally { c.release(); }
    };
    if (!stream) {
      const job = await getJob();
      return job ? Response.json(job) : Response.json({ error: "not found" }, { status: 404 });
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

console.log(`openbrain-research listening on :${PORT} (curator=${CURATOR_URL}, search=${SEARCH_API_BASE}, max_concurrency=${MAX_CONCURRENCY})`);

// Requeue any jobs orphaned by a restart, then start the single background
// dispatcher. This is the ONLY thing that runs queued jobs.
void recoverOrphanedJobs().then(() => { void drainLoop(); });
