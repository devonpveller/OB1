/**
 * Grounding Backfiller (S2 / P2) — brain-health worker.
 *
 * Drains `public.ungrounded_claims` (active claims with `claim_min_depth IS NULL`
 * — no grounding chain terminating in a source). For each: extract the claim's
 * central encyclopedic ENTITY (one local `:nothink` LLM call), fetch the
 * Wikipedia page for it, persist it as a source (`find_or_create_source`, dedup),
 * and link it to the claim as a **`corroborates`** edge. The `claim_sources`
 * trigger recomputes confidence automatically → the claim leaves the view.
 *
 * Wikipedia is a TERTIARY grounding-corpus backend behind a swappable seam — its
 * authority lands at 0.85 automatically (non `.gov/.edu/.mil` domain), which is
 * the correct "supplementary, not primary" weight. It is general brain-health:
 * every claim it grounds raises the brain's reusable-claim ratio for ALL inlets,
 * not just the podcast.
 *
 * Routes (obnet loopback):
 *   GET  /health   -> { ok, running, egress }
 *   POST /backfill?limit=N  body: { "thread_ids"?: [uuid,...] }
 *        scoped run (today's digest threads, pre-script) passes thread_ids;
 *        the global off-peak sweep omits them.
 *
 * No-entity / no-Wikipedia-match → stamp `metadata.backfill_skip=true` + log, so
 * an un-groundable claim is never re-attempted every sweep (no retry storm; clear
 * the flag to retry). External fetches Tor-routed (D10, socks5h, fail-soft).
 *
 * Env: DB_HOST/PORT/NAME/USER/PASSWORD; CHAT_API_BASE/CHAT_MODEL/CHAT_NOTHINK_SUFFIX;
 *      FETCH_PROXY_URL (socks5h://tor:9050; "" = direct); WIKI_BASE;
 *      BACKFILL_BATCH (20), BACKFILL_CONCURRENCY (2), BACKFILL_INTERVAL_MS (0=off),
 *      BACKFILL_EDGE_WEIGHT (0.7), BACKFILL_FETCH_TIMEOUT_MS (15000), PORT (8000).
 */
import { Pool } from "postgres";

const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const DB = {
  hostname: env("DB_HOST", "openbrain-db"),
  port: parseInt(env("DB_PORT", "5432"), 10),
  database: env("DB_NAME", "openbrain"),
  user: env("DB_USER", "postgres"),
  password: env("DB_PASSWORD", ""),
};
const PORT = parseInt(env("PORT", "8000"), 10);
const BATCH = parseInt(env("BACKFILL_BATCH", "20"), 10);
const CONCURRENCY = parseInt(env("BACKFILL_CONCURRENCY", "2"), 10);
const INTERVAL_MS = parseInt(env("BACKFILL_INTERVAL_MS", "0"), 10);
const CHAT_API_BASE = env("CHAT_API_BASE", "http://llama-cpp:8080/v1");
const CHAT_MODEL = env("CHAT_MODEL", "qwen36-27b");
const NOTHINK = env("CHAT_NOTHINK_SUFFIX", ":nothink");
const WIKI_BASE = env("WIKI_BASE", "https://en.wikipedia.org");
const EDGE_WEIGHT = parseFloat(env("BACKFILL_EDGE_WEIGHT", "0.7"));
const FETCH_TIMEOUT_MS = parseInt(env("BACKFILL_FETCH_TIMEOUT_MS", "15000"), 10);

const pool = new Pool(DB, 6);

// ── Tor egress (privacy-by-default; D10) — socks5h = DNS through Tor ──────────
const DEFAULT_PROXY = "socks5h://tor:9050";
let httpClient: Deno.HttpClient | null | undefined; // undefined=uninit, null=direct
function getClient(): Deno.HttpClient | null {
  if (httpClient !== undefined) return httpClient;
  const url = (Deno.env.get("FETCH_PROXY_URL") ?? DEFAULT_PROXY).trim();
  try {
    httpClient = url ? Deno.createHttpClient({ proxy: { url } }) : null;
  } catch (e) {
    console.warn(`[backfill] Tor client init failed (${e}); using direct fetch`);
    httpClient = null;
  }
  return httpClient;
}
function egressMode(): string {
  return getClient() ? (Deno.env.get("FETCH_PROXY_URL") ?? DEFAULT_PROXY) : "direct";
}
function torFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const c = getClient();
  // Wikipedia API etiquette requires a descriptive User-Agent.
  const headers = { "user-agent": "open-brain-grounding-backfiller/1.0 (private brain-health)", ...(init.headers ?? {}) };
  return c ? fetch(url, { ...init, headers, client: c }) : fetch(url, { ...init, headers });
}

// ── Entity extraction (one local nothink call) ───────────────────────────────
const ENTITY_SYS =
  `You ground a factual CLAIM by naming the single best Wikipedia topic to corroborate it. ` +
  `Output ONLY the most specific real-world ENTITY the claim is about that has an encyclopedia page ` +
  `— a person, organization, product, technology, place, law, or established concept. ` +
  `2-4 words, no quotes, no punctuation. ` +
  `If the claim has no such encyclopedic entity (a pure opinion, a transient statistic, or a private/unnameable subject), ` +
  `output exactly: NONE`;

async function extractEntity(claimText: string): Promise<string | null> {
  try {
    const res = await fetch(`${CHAT_API_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer not-needed", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${CHAT_MODEL}${NOTHINK}`,
        temperature: 0,
        max_tokens: 24,
        messages: [
          { role: "system", content: ENTITY_SYS },
          { role: "user", content: `CLAIM: ${claimText.slice(0, 600)}` },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    const d = await res.json();
    const t = ((d.choices?.[0]?.message?.content as string | undefined) ?? "").trim();
    if (!t || /^none\b/i.test(t)) return null;
    return t.replace(/^["'\s]+|["'\s.]+$/g, "").slice(0, 120) || null;
  } catch (e) {
    console.warn(`[backfill] entity extract failed: ${e}`);
    return null;
  }
}

// ── Wikipedia (grounding-corpus backend; swappable) ──────────────────────────
interface WikiPage {
  url: string;
  title: string;
  extract: string;
}
async function wikiLookup(entity: string): Promise<WikiPage | null> {
  // 1. resolve the best-matching page title
  const sUrl = `${WIKI_BASE}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(entity)}&srlimit=1&format=json`;
  let title: string | null = null;
  try {
    const r = await torFetch(sUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) {
      r.body?.cancel().catch(() => {});
      return null;
    }
    const j = await r.json();
    title = j?.query?.search?.[0]?.title ?? null;
  } catch (e) {
    console.warn(`[backfill] wiki search failed (${entity}): ${e}`);
    return null;
  }
  if (!title) return null;
  // 2. fetch the intro extract via the REST summary endpoint
  const key = encodeURIComponent(title.replace(/ /g, "_"));
  try {
    const r = await torFetch(`${WIKI_BASE}/api/rest_v1/page/summary/${key}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) {
      r.body?.cancel().catch(() => {});
      return null;
    }
    const j = await r.json();
    const extract = ((j?.extract as string | undefined) ?? "").trim();
    if (!extract || (j?.type as string) === "disambiguation") return null;
    const canonical = (j?.content_urls?.desktop?.page as string | undefined) ?? `${WIKI_BASE}/wiki/${key}`;
    return { url: canonical, title: (j?.title as string) ?? title, extract };
  } catch (e) {
    console.warn(`[backfill] wiki summary failed (${title}): ${e}`);
    return null;
  }
}

// ── Drain ────────────────────────────────────────────────────────────────────
interface Claim {
  id: string;
  text: string;
  thread_id: string | null;
}
type Outcome = "grounded" | "no-entity" | "no-page" | "error";

// deno-lint-ignore no-explicit-any
async function fetchUngrounded(client: any, limit: number, threadIds: string[] | null): Promise<Claim[]> {
  const scoped = threadIds && threadIds.length > 0;
  const args: unknown[] = [limit];
  if (scoped) args.push(threadIds);
  const q = `
    SELECT uc.id, uc.text, uc.thread_id
    FROM ungrounded_claims uc
    JOIN public.claims c ON c.id = uc.id
    WHERE COALESCE((c.metadata->>'backfill_skip')::boolean, false) = false
      ${scoped ? "AND uc.thread_id = ANY($2::uuid[])" : ""}
    ORDER BY uc.created_at DESC
    LIMIT $1`;
  const r = await client.queryObject(q, args);
  return r.rows as Claim[];
}

// deno-lint-ignore no-explicit-any
async function markSkip(client: any, claimId: string, reason: string): Promise<void> {
  await client.queryObject(
    `UPDATE public.claims SET metadata = metadata || $2::jsonb, updated_at = now() WHERE id = $1`,
    [claimId, JSON.stringify({ backfill_skip: true, backfill_reason: reason, backfill_attempted_at: new Date().toISOString() })],
  );
}

// deno-lint-ignore no-explicit-any
async function groundClaim(client: any, claim: Claim): Promise<Outcome> {
  const entity = await extractEntity(claim.text);
  if (!entity) {
    await markSkip(client, claim.id, "no-entity");
    return "no-entity";
  }
  const page = await wikiLookup(entity);
  if (!page) {
    await markSkip(client, claim.id, `no-page:${entity}`);
    return "no-page";
  }
  try {
    const src = await client.queryObject(
      `SELECT id FROM find_or_create_source(
         p_url := $1, p_content := $2, p_title := $3,
         p_domain := 'en.wikipedia.org', p_metadata := $4::jsonb)`,
      [page.url, page.extract, page.title, JSON.stringify({ source: "grounding_backfiller", wikipedia_title: page.title, grounded_entity: entity })],
    );
    const sourceId = (src.rows[0] as { id: string } | undefined)?.id;
    if (!sourceId) return "error";
    await client.queryObject(
      `SELECT link_claim_to_source($1, $2, 'corroborates', $3)`,
      [claim.id, sourceId, EDGE_WEIGHT],
    );
    console.log(`[backfill] grounded ${claim.id} → "${page.title}" (entity: ${entity})`);
    return "grounded";
  } catch (e) {
    console.warn(`[backfill] write failed for ${claim.id}: ${e}`);
    return "error";
  }
}

interface RunResult {
  scanned: number;
  grounded: number;
  noEntity: number;
  noPage: number;
  errors: number;
}

let running = false;
async function runBackfill(limit: number, threadIds: string[] | null): Promise<RunResult> {
  const res: RunResult = { scanned: 0, grounded: 0, noEntity: 0, noPage: 0, errors: 0 };
  const scan = await pool.connect();
  let claims: Claim[];
  try {
    claims = await fetchUngrounded(scan, limit, threadIds);
  } finally {
    scan.release();
  }
  res.scanned = claims.length;
  if (claims.length === 0) return res;

  let i = 0;
  const worker = async () => {
    while (i < claims.length) {
      const claim = claims[i++];
      const client = await pool.connect();
      try {
        const o = await groundClaim(client, claim);
        if (o === "grounded") res.grounded++;
        else if (o === "no-entity") res.noEntity++;
        else if (o === "no-page") res.noPage++;
        else res.errors++;
      } catch (e) {
        console.warn(`[backfill] claim ${claim.id} errored: ${e}`);
        res.errors++;
      } finally {
        client.release();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, claims.length) }, worker));
  return res;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const J = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") {
    return J({ ok: true, service: "openbrain-grounding-backfiller", running, egress: egressMode() });
  }
  if (req.method === "POST" && url.pathname === "/backfill") {
    if (running) return J({ ok: false, error: "already running" }, 409);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? String(BATCH), 10) || BATCH, 200);
    let threadIds: string[] | null = null;
    try {
      const body = await req.json();
      if (Array.isArray(body?.thread_ids)) {
        threadIds = body.thread_ids.filter((x: unknown) => typeof x === "string");
      }
    } catch { /* no body → global sweep */ }
    running = true;
    const t0 = Date.now();
    try {
      const r = await runBackfill(limit, threadIds);
      console.log(
        `[backfill] done scanned=${r.scanned} grounded=${r.grounded} no-entity=${r.noEntity} ` +
          `no-page=${r.noPage} err=${r.errors} (${threadIds ? threadIds.length + " thread(s)" : "global"})`,
      );
      return J({ ok: true, ...r, ms: Date.now() - t0 });
    } catch (e) {
      console.error(`[backfill] run failed: ${e}`);
      return J({ ok: false, error: String(e) }, 500);
    } finally {
      running = false;
    }
  }
  return new Response("not found", { status: 404 });
});

console.log(`[backfill] listening on :${PORT} (egress=${egressMode()}, batch=${BATCH}, model=${CHAT_MODEL}${NOTHINK})`);

// Optional bounded periodic global sweep (off by default; cron is preferred).
if (INTERVAL_MS > 0) {
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await runBackfill(BATCH, null);
      if (r.scanned > 0) console.log(`[backfill] sweep scanned=${r.scanned} grounded=${r.grounded}`);
    } catch (e) {
      console.error(`[backfill] sweep error: ${e}`);
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
}
