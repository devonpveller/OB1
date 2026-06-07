/**
 * Research-package ingestion inlet — Open Brain curator (research-inlet plan).
 *
 * The single front door for deep-research output. deep_research finishes, builds
 * a "package" (synthesis + sources + topic hint) and POSTs it here instead of
 * straight to /research/persist. This service owns the HOUSEKEEPING DECISION —
 * which thread the research belongs to — so the research model never has to, and
 * so OB1 stops fragmenting into one thread per run.
 *
 * Flow (see PLAN-research-inlet-service.md §3):
 *   POST /ingest/research-package
 *     1. embed the synthesis claim (bge-m3, 1024)
 *     2. Stage 1 — shortlist top-K threads by pgvector cosine (threads.embedding)
 *     3. Stage 2 — LLM decides: attach to an existing thread, or create a new one
 *        (conservative-merge bias; explicit thread_id bypasses the resolver)
 *     4. ensure the thread exists (create when decision=new)
 *     5. delegate the WRITE to the existing /research/persist with the resolved
 *        thread_id injected (reuses find_or_create_source / sessions / supersede)
 *     6. refresh the thread's description + embedding so matching improves (§3.5)
 *
 * Persistence is NOT reimplemented here — the curator adds intelligence and
 * delegates the proven write (§3.3). Resolution never hard-fails an ingest: a
 * down LLM falls back to the Stage-1 top candidate or a cold-start new thread.
 *
 * Talks to Postgres DIRECTLY via deno-postgres (like the MCP server and the
 * suggestion worker) so the pgvector distance operator stays server-side.
 *
 * Routes:
 *   GET  /health                  -> {ok, db}                (unauthenticated)
 *   POST /ingest/research-package -> resolve + persist + refresh  (x-brain-key)
 *
 * Env: DB_HOST/PORT/NAME/USER/PASSWORD, EMBEDDING_API_BASE/KEY/MODEL,
 *      CHAT_API_BASE/KEY/MODEL, MCP_ACCESS_KEY (== WORKBENCH/brain key),
 *      PERSIST_URL (default http://openbrain-mcp:8000), SHORTLIST_K (5),
 *      NEW_THREAD_MIN_CONFIDENCE (0.60), MERGE_FLOOR_DISTANCE (0.45), PORT (8000).
 */
import { Pool } from "postgres";

// --- Config -----------------------------------------------------------------
const DB_HOST = Deno.env.get("DB_HOST") || "openbrain-db";
const DB_PORT = parseInt(Deno.env.get("DB_PORT") || "5432", 10);
const DB_NAME = Deno.env.get("DB_NAME") || "openbrain";
const DB_USER = Deno.env.get("DB_USER") || "postgres";
const DB_PASSWORD = Deno.env.get("DB_PASSWORD") || "";

const EMBEDDING_API_BASE = (Deno.env.get("EMBEDDING_API_BASE") || "http://llama-cpp-embed:8080/v1").replace(/\/+$/, "");
const EMBEDDING_API_KEY = Deno.env.get("EMBEDDING_API_KEY") || "not-needed";
const EMBEDDING_MODEL = Deno.env.get("EMBEDDING_MODEL") || "bge-m3";
const EMBEDDING_MAX_CHARS = parseInt(Deno.env.get("EMBEDDING_MAX_CHARS") || "4000", 10);

const CHAT_API_BASE = (Deno.env.get("CHAT_API_BASE") || "http://llama-cpp:8080/v1").replace(/\/+$/, "");
const CHAT_API_KEY = Deno.env.get("CHAT_API_KEY") || "not-needed";
const CHAT_MODEL = Deno.env.get("CHAT_MODEL") || "qwen36-27b:nothink";

const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") || "";
const PERSIST_URL = (Deno.env.get("PERSIST_URL") || "http://openbrain-mcp:8000").replace(/\/+$/, "");

const SHORTLIST_K = parseInt(Deno.env.get("SHORTLIST_K") || "5", 10);
// Below this confidence the resolver will NOT mint a new thread when a candidate
// exists — it attaches to the top candidate instead (conservative-merge bias).
const NEW_THREAD_MIN_CONFIDENCE = parseFloat(Deno.env.get("NEW_THREAD_MIN_CONFIDENCE") || "0.60");
// Cosine-distance floor used only on the LLM-down fallback: if the top candidate
// is at least this close, attach to it; otherwise cold-start a new thread.
const MERGE_FLOOR_DISTANCE = parseFloat(Deno.env.get("MERGE_FLOOR_DISTANCE") || "0.45");
const PORT = parseInt(Deno.env.get("PORT") || "8000", 10);

const pool = new Pool({
  hostname: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
}, 8);

// --- Types ------------------------------------------------------------------
interface Pkg {
  research_key?: string;
  query?: string;
  claim?: string; // short standalone summary (required) — used for the resolver embedding
  synthesis?: string; // the FULL detailed research result — stored as source content
  kind?: string;
  volatility?: string;
  revalidate_days?: number;
  topic_hint?: string; // was `notebook`; now a hint to the resolver only
  notebook?: string; // back-compat alias for topic_hint
  thread_id?: string; // explicit override -> bypass the resolver
  model?: string;
  sources?: Array<{ url?: string; title?: string; content?: string; summary?: string; domain?: string }>;
}

interface Candidate {
  thread_id: string;
  name: string;
  description: string | null;
  distance: number;
}

interface Decision {
  decision: "existing" | "new";
  thread_id?: string;
  confidence: number;
  new_thread_name?: string;
  new_thread_description?: string;
  reason?: string;
}

// --- LLM / embedding helpers ------------------------------------------------

/** Embed text; halves the input on a physical-batch overflow and retries. */
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
  throw new Error("embedding failed: input still too large after shrinking");
}

const toVector = (v: number[]): string => `[${v.join(",")}]`;

/** Chat completion that must return a JSON object; returns the parsed object. */
async function chatJson(system: string, user: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${CHAT_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CHAT_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CHAT_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`chat ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  const text = d?.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(text);
}

// --- Stage 1: embedding shortlist -------------------------------------------
async function shortlistThreads(claimEmb: number[], k: number): Promise<Candidate[]> {
  const client = await pool.connect();
  try {
    const r = await client.queryObject<{ thread_id: string; name: string; description: string | null; distance: number }>(
      `SELECT id AS thread_id, name, description,
              (embedding <=> $1::vector) AS distance
         FROM threads
        WHERE status = 'active' AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2`,
      [toVector(claimEmb), k],
    );
    // pgvector's <=> distance decodes as a string over the wire — coerce so
    // numeric comparisons (.toFixed, thresholds) behave.
    return r.rows.map((row) => ({ ...row, distance: Number(row.distance) }));
  } finally {
    client.release();
  }
}

// --- Stage 2: LLM decision --------------------------------------------------
const RESOLVE_SYS = `You are Open Brain's research curator. You decide which research THREAD a new piece of research belongs to.

A thread is a durable, named line of inquiry that accumulates related sources over time. Your job is to fight fragmentation: prefer attaching new research to an EXISTING thread whenever it plausibly belongs there. Only create a NEW thread when the research is a genuinely distinct line of inquiry that no candidate covers.

You are given the new research and a shortlist of candidate threads (already pre-filtered by semantic similarity; lower distance = more similar). Decide.

Return ONLY a JSON object:
{
  "decision": "existing" | "new",
  "thread_id": "<uuid of the chosen candidate, when decision=existing>",
  "confidence": <0.0-1.0>,
  "new_thread_name": "<short broad name, 2-5 words, when decision=new>",
  "new_thread_description": "<1-3 sentence scope statement, when decision=new>",
  "reason": "<one sentence>"
}

Rules:
- Bias toward "existing". A near-duplicate or same-subject query MUST attach to the existing thread, not spawn a sibling.
- Choose "new" only if you can name the distinct line of inquiry that no candidate represents.
- A new thread name must be BROAD (the topic area), never the specific query, so future related research lands here too.
- confidence reflects how sure you are of the decision.`;

async function decideThread(pkg: Pkg, shortlist: Candidate[]): Promise<Decision> {
  const titles = (pkg.sources || []).map((s) => s.title || s.domain || s.url).filter(Boolean).slice(0, 8);
  const candidatesBlock = shortlist.length
    ? shortlist
      .map((c, i) =>
        `${i + 1}. thread_id=${c.thread_id} | distance=${c.distance.toFixed(3)} | name="${c.name}"\n   description: ${c.description || "(none)"}`
      )
      .join("\n")
    : "(no candidate threads)";
  const user = [
    `NEW RESEARCH`,
    `topic hint: ${pkg.topic_hint || pkg.notebook || "(none)"}`,
    `question: ${(pkg.query || "").slice(0, 400)}`,
    `synthesis: ${(pkg.claim || "").slice(0, 2000)}`,
    titles.length ? `source titles: ${titles.join("; ")}` : "",
    ``,
    `CANDIDATE THREADS (lower distance = more similar):`,
    candidatesBlock,
  ].filter(Boolean).join("\n");

  const out = await chatJson(RESOLVE_SYS, user);
  return {
    decision: out.decision === "new" ? "new" : "existing",
    thread_id: typeof out.thread_id === "string" ? out.thread_id : undefined,
    confidence: typeof out.confidence === "number" ? out.confidence : 0.5,
    new_thread_name: typeof out.new_thread_name === "string" ? out.new_thread_name : undefined,
    new_thread_description: typeof out.new_thread_description === "string" ? out.new_thread_description : undefined,
    reason: typeof out.reason === "string" ? out.reason : undefined,
  };
}

// --- Thread creation / maintenance ------------------------------------------

/** Create a thread. slug is left NULL — the wiki compiler pins the canonical
 *  slug (G5: never slugify outside the shared module). */
async function createThread(name: string, description: string): Promise<string> {
  const emb = toVector(await embed(`${name}\n${description}`));
  const client = await pool.connect();
  try {
    const r = await client.queryObject<{ id: string }>(
      `INSERT INTO threads (name, description, embedding, status)
       VALUES ($1, $2, $3::vector, 'active')
       RETURNING id`,
      [name.slice(0, 200), description.slice(0, 2000), emb],
    );
    return r.rows[0].id;
  } finally {
    client.release();
  }
}

const REFRESH_SYS = `You maintain the scope DESCRIPTION of an Open Brain research thread. Given the thread's current name + description and a newly added piece of research, return an updated description that still captures the thread's overall scope (not just the new research). Keep it 1-3 sentences, broad enough to attract future related research. Return ONLY JSON: {"description": "..."}`;

/** Extend the thread's description with the new research, then recompute its
 *  embedding from name+description. Best-effort: callers ignore failures. */
async function refreshThread(threadId: string, pkg: Pkg): Promise<void> {
  const client = await pool.connect();
  try {
    const cur = await client.queryObject<{ name: string; description: string | null }>(
      `SELECT name, description FROM threads WHERE id = $1`,
      [threadId],
    );
    if (cur.rows.length === 0) return;
    const { name, description } = cur.rows[0];
    let newDesc = description || "";
    try {
      const out = await chatJson(
        REFRESH_SYS,
        `THREAD name: ${name}\ncurrent description: ${description || "(none)"}\n\nNEW RESEARCH\nquestion: ${(pkg.query || "").slice(0, 300)}\nsynthesis: ${(pkg.claim || "").slice(0, 1500)}`,
      );
      if (typeof out.description === "string" && out.description.trim()) {
        newDesc = out.description.trim().slice(0, 2000);
      }
    } catch (e) {
      console.error(`refresh: description LLM failed for ${threadId}:`, (e as Error).message);
    }
    const emb = toVector(await embed(`${name}\n${newDesc}`));
    await client.queryObject(
      `UPDATE threads SET description = $2, embedding = $3::vector, updated_at = now() WHERE id = $1`,
      [threadId, newDesc, emb],
    );
  } finally {
    client.release();
  }
}

// --- Resolution policy ------------------------------------------------------
async function resolve(pkg: Pkg, claimEmb: number[]): Promise<{
  thread_id: string;
  decision: "explicit" | "existing" | "new";
  confidence: number;
  name: string;
  shortlist: Candidate[];
}> {
  // Explicit-thread bypass: a deliberately-set thread_id is honored as-is.
  const explicit = (pkg.thread_id || "").trim();
  if (explicit) {
    const client = await pool.connect();
    try {
      const r = await client.queryObject<{ name: string }>(`SELECT name FROM threads WHERE id = $1`, [explicit]);
      if (r.rows.length) {
        return { thread_id: explicit, decision: "explicit", confidence: 1, name: r.rows[0].name, shortlist: [] };
      }
      // Falls through to resolver if the id is stale/unknown.
    } finally {
      client.release();
    }
  }

  const shortlist = await shortlistThreads(claimEmb, SHORTLIST_K);
  const hint = (pkg.topic_hint || pkg.notebook || "research").trim() || "research";

  let decision: Decision;
  try {
    decision = await decideThread(pkg, shortlist);
  } catch (e) {
    // LLM down -> attach to the Stage-1 top candidate if close enough, else cold-start.
    console.error("resolve: decision LLM failed, using distance fallback:", (e as Error).message);
    const top = shortlist[0];
    if (top && top.distance <= MERGE_FLOOR_DISTANCE) {
      return { thread_id: top.thread_id, decision: "existing", confidence: 1 - top.distance, name: top.name, shortlist };
    }
    const id = await createThread(hint, (pkg.claim || "").slice(0, 400));
    return { thread_id: id, decision: "new", confidence: 0.5, name: hint, shortlist };
  }

  const top = shortlist[0];

  // Attach to an existing candidate.
  if (decision.decision === "existing") {
    const chosen = shortlist.find((c) => c.thread_id === decision.thread_id) || top;
    if (chosen) {
      return { thread_id: chosen.thread_id, decision: "existing", confidence: decision.confidence, name: chosen.name, shortlist };
    }
    // LLM said existing but named nothing valid and shortlist empty -> cold-start.
  }

  // decision = new. Conservative-merge gate: if a candidate exists but the LLM
  // isn't confident enough, attach to the top candidate instead of fragmenting.
  if (top && decision.confidence < NEW_THREAD_MIN_CONFIDENCE) {
    return { thread_id: top.thread_id, decision: "existing", confidence: decision.confidence, name: top.name, shortlist };
  }

  const name = (decision.new_thread_name || hint).slice(0, 200);
  const desc = (decision.new_thread_description || (pkg.claim || "").slice(0, 400)).slice(0, 2000);
  const id = await createThread(name, desc);
  return { thread_id: id, decision: "new", confidence: decision.confidence, name, shortlist };
}

// --- Delegate the write to the existing /research/persist -------------------
async function delegatePersist(pkg: Pkg, threadId: string): Promise<Record<string, unknown>> {
  const body = {
    research_key: pkg.research_key,
    query: pkg.query,
    claim: pkg.claim,
    synthesis: pkg.synthesis, // full detailed result -> stored as source content
    kind: pkg.kind,
    volatility: pkg.volatility,
    revalidate_days: pkg.revalidate_days,
    notebook: pkg.topic_hint || pkg.notebook, // persist still stamps a notebook label
    thread_id: threadId,
    model: pkg.model,
    sources: pkg.sources || [],
  };
  const r = await fetch(`${PERSIST_URL}/research/persist`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-brain-key": MCP_ACCESS_KEY },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`persist ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// --- HTTP server ------------------------------------------------------------
function authed(req: Request, url: URL): boolean {
  const provided = req.headers.get("x-brain-key") || req.headers.get("X-Brain-Key") || url.searchParams.get("key");
  return !!provided && !!MCP_ACCESS_KEY && provided === MCP_ACCESS_KEY;
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/ingest/health")) {
    let db = false;
    try {
      const c = await pool.connect();
      try { await c.queryArray("SELECT 1"); db = true; } finally { c.release(); }
    } catch { /* db down */ }
    return Response.json({ ok: db, db }, { status: db ? 200 : 503 });
  }

  if (req.method === "POST" && url.pathname === "/ingest/research-package") {
    if (!authed(req, url)) return Response.json({ error: "unauthorized" }, { status: 401 });
    let pkg: Pkg;
    try { pkg = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
    const claim = (pkg.claim || "").trim();
    if (!claim) return Response.json({ error: "claim required" }, { status: 400 });

    try {
      const claimEmb = await embed(claim.slice(0, 1600));
      const res = await resolve(pkg, claimEmb);

      let persist: Record<string, unknown>;
      try {
        persist = await delegatePersist(pkg, res.thread_id);
      } catch (e) {
        // Persist failed AFTER we resolved a thread. Surface it so the caller
        // can fall back to its own unthreaded persist (best-effort, never block).
        console.error("ingest: persist delegation failed:", (e as Error).message);
        return Response.json(
          { error: "persist_failed", detail: (e as Error).message, thread_id: res.thread_id, thread_decision: res.decision },
          { status: 502 },
        );
      }

      // Maintain the thread so future matching improves — best-effort.
      refreshThread(res.thread_id, pkg).catch((e) =>
        console.error("ingest: thread refresh failed:", (e as Error).message)
      );

      console.log(
        `ingest: decision=${res.decision} conf=${res.confidence.toFixed(2)} thread="${res.name}" (${res.thread_id}) sources=${persist.sources_written ?? "?"}`,
      );
      return Response.json({
        thread_id: res.thread_id,
        thread_decision: res.decision,
        thread_confidence: res.confidence,
        thread_name: res.name,
        shortlist: res.shortlist.map((c) => ({ thread_id: c.thread_id, name: c.name, distance: c.distance })),
        persist,
      });
    } catch (e) {
      console.error("ingest failed:", (e as Error).message);
      return Response.json({ error: "ingest_failed", detail: (e as Error).message }, { status: 500 });
    }
  }

  return new Response("not found", { status: 404 });
});

console.log(`research-curator listening on :${PORT} (persist=${PERSIST_URL}, k=${SHORTLIST_K}, min_conf=${NEW_THREAD_MIN_CONFIDENCE})`);
