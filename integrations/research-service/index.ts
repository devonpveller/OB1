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
import { runResearch, type Deps, type SearchHit, type Page, type Progress } from "./harness.ts";

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

const pool = new Pool({ hostname: DB_HOST, port: DB_PORT, database: DB_NAME, user: DB_USER, password: DB_PASSWORD }, 8);

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

async function fetchPage(url: string): Promise<Page | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const client = fetchClient();
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { "user-agent": FETCH_UA },
      ...(client ? { client } : {}),
    });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (ct && !/text\/html|text\/plain|application\/xhtml/i.test(ct)) return null;
    const html = await r.text();
    const content = extractTextFromHtml(html).slice(0, FETCH_MAX_CHARS);
    if (!content) return null;
    return { url, title: extractTitle(html) || domainOf(url), content, domain: domainOf(url) };
  } catch {
    return null;
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
async function runJob(jobId: string): Promise<void> {
  const client = await pool.connect();
  const progress: Progress = async (phase, message, counters = {}) => {
    await client.queryObject(
      `UPDATE research_jobs SET status='running', progress=$2::jsonb WHERE id=$1`,
      [jobId, JSON.stringify({ phase, message, counters })],
    ).catch(() => {});
  };
  try {
    const j = await client.queryObject<{ query: string; thread_id: string | null; origin: string; options: Record<string, unknown> }>(
      `UPDATE research_jobs SET status='running', started_at=now() WHERE id=$1
       RETURNING query, thread_id, origin, options`, [jobId],
    );
    if (!j.rows.length) return;
    const { query, thread_id, origin, options } = j.rows[0];
    const seedSources = Array.isArray(options?.seed_sources)
      ? (options.seed_sources as Array<{ url: string; title: string; content: string }>)
      : undefined;
    const res = await runResearch(realDeps, client, query, {
      threadId: thread_id, origin,
      confidenceFloor: typeof options?.confidence_floor === "number" ? options.confidence_floor : undefined,
      seedSources,
      disableWebSearch: options?.disable_web_search === true,
      mode: options?.mode === "article" ? "article" : undefined,
      gapResearch: options?.gap_research === "preliminary" ? "preliminary" : undefined,
      dryRun: options?.dry_run === true,
    }, progress);
    await client.queryObject(
      `UPDATE research_jobs SET status='done', finished_at=now(),
         result=$2::jsonb, metrics=$3::jsonb, progress=$4::jsonb WHERE id=$1`,
      [jobId, JSON.stringify({
        synthesis: res.synthesis, needs: res.needs, gaps: res.gaps,
        cited_sources: res.citedSources, reuse_claims: res.reuseClaims,
        thread_id: (res.curator?.thread_id as string) ?? thread_id, reuse_ratio: 1 - res.metrics.gap_ratio,
        curator: res.curator, backstop: res.backstop,
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
      disable_web_search?: boolean; mode?: string; dry_run?: boolean; gap_research?: string;
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
    runJob(jobId).catch((e) => console.error("runJob failed:", (e as Error).message));
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
        const r = await c.queryObject(`SELECT id, status, progress, result, metrics, error FROM research_jobs WHERE id=$1`, [id]);
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

console.log(`openbrain-research listening on :${PORT} (curator=${CURATOR_URL}, search=${SEARCH_API_BASE})`);
