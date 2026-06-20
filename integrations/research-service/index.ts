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
 * Env: DB_*, EMBEDDING_API_*, CHAT_API_*, MCP_ACCESS_KEY, CURATOR_URL,
 *      SEARCH_API_BASE, FETCH_TIMEOUT_MS, FETCH_MAX_CHARS, PORT (+ harness.ts tunables).
 */
import { Pool } from "postgres";
import { extractTextFromHtml, extractTitle, domainOf } from "./lib.ts";
import { runResearch, type Deps, type SearchHit, type Page, type Progress, type FetchResult } from "./harness.ts";

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

const MCP_ACCESS_KEY = env("MCP_ACCESS_KEY");
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

async function chat(system: string, user: string, opts: { json?: boolean; nothink?: boolean } = {}): Promise<string> {
  const model = opts.nothink ? `${CHAT_MODEL}${NOTHINK_SUFFIX}` : CHAT_MODEL;
  const r = await fetch(`${CHAT_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CHAT_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, temperature: 0.2,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`chat ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  return d?.choices?.[0]?.message?.content ?? "";
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

const realDeps: Deps = { embed, chat, searchWeb, fetchPage, delegateToCurator };
void SEARCH_K_DEFAULT; // tunable also read inside harness.ts; surfaced here for ops visibility

// ── Job runner (OD-3 async job+poll) ─────────────────────────────────────────
// A job claimed by the drain loop: it has already been flipped to status='running'
// (started_at set) by the atomic claim, so executeJob only runs the harness and
// persists the terminal state — it never re-claims.
type ClaimedJob = { jobId: string; query: string; thread_id: string | null; origin: string; options: Record<string, unknown> };

async function executeJob(job: ClaimedJob): Promise<void> {
  const { jobId, query, thread_id, origin, options } = job;
  const client = await pool.connect();
  const progress: Progress = async (phase, message, counters = {}) => {
    await client.queryObject(
      `UPDATE research_jobs SET status='running', progress=$2::jsonb WHERE id=$1`,
      [jobId, JSON.stringify({ phase, message, counters })],
    ).catch(() => {});
  };
  try {
    const seedSources = Array.isArray(options?.seed_sources)
      ? (options.seed_sources as Array<{ url: string; title: string; content: string }>)
      : undefined;
    const res = await runResearch(realDeps, client, query, {
      threadId: thread_id, origin,
      confidenceFloor: typeof options?.confidence_floor === "number" ? options.confidence_floor : undefined,
      seedSources,
      disableWebSearch: options?.disable_web_search === true,
      sourcesOnly: options?.sources_only === true,
      mode: options?.mode === "article" ? "article" : undefined,
      gapResearch: options?.gap_research === "preliminary" ? "preliminary" : undefined,
      dryRun: options?.dry_run === true,
    }, progress);
    await client.queryObject(
      `UPDATE research_jobs SET status='done', finished_at=now(),
         result=$2::jsonb, metrics=$3::jsonb, progress=$4::jsonb WHERE id=$1`,
      [jobId, JSON.stringify({
        synthesis: res.synthesis, prose: res.prose, needs: res.needs,
        followup_queries: res.followupQueries, gaps: res.gaps,
        cited_sources: res.citedSources, reuse_claims: res.reuseClaims,
        thread_id: (res.curator?.thread_id as string) ?? thread_id, reuse_ratio: 1 - res.metrics.gap_ratio,
        curator: res.curator, backstop: res.backstop, fetch_stats: res.fetchStats,
      }), JSON.stringify(res.metrics), JSON.stringify({ phase: "done", message: `backstop=${res.backstop}` })],
    );
  } catch (e) {
    await client.queryObject(
      `UPDATE research_jobs SET status='error', finished_at=now(), error=$2 WHERE id=$1`,
      [jobId, String((e as Error).message)],
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

  if (req.method === "POST" && url.pathname === "/research") {
    if (!authed(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
    let body: {
      query?: string; thread_id?: string; origin?: string; options?: Record<string, unknown>;
      seed_sources?: Array<{ url?: string; title?: string; content?: string }>;
      disable_web_search?: boolean; sources_only?: boolean; mode?: string; dry_run?: boolean; gap_research?: string;
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
    const options = {
      ...(body.options || {}),
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
    return Response.json({ job_id: jobId, status: "queued" }, { status: 202 });
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
        // queue_depth (total queued) let an inlet show "Queued — position N of M"
        // while a job waits behind others. Both are null/0 once it starts running.
        const r = await c.queryObject(
          `SELECT j.id, j.status, j.progress, j.result, j.metrics, j.error,
             CASE WHEN j.status='queued' THEN
               (SELECT count(*)+1 FROM research_jobs q
                WHERE q.status='queued' AND q.created_at < j.created_at)::int
             END AS queue_position,
             (SELECT count(*) FROM research_jobs r WHERE r.status='queued')::int AS queue_depth
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
