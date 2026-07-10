/**
 * Open Brain MCP Server - Kubernetes Self-Hosted Version
 *
 * This is a modified version of the OB1 server that connects directly to
 * PostgreSQL + pgvector instead of Supabase. All MCP tools and the Hono
 * HTTP layer are preserved; only the data access layer is changed.
 *
 * Environment variables:
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD - PostgreSQL connection
 *   EMBEDDING_API_BASE - Base URL for OpenAI-compatible embedding API
 *   EMBEDDING_API_KEY - API key for the embedding service
 *   EMBEDDING_MODEL - Model name for embeddings (default: text-embedding-3-small)
 *   CHAT_API_BASE - Base URL for OpenAI-compatible chat API (defaults to EMBEDDING_API_BASE)
 *   CHAT_API_KEY - API key for chat service (defaults to EMBEDDING_API_KEY)
 *   CHAT_MODEL - Model name for metadata extraction (default: gpt-4o-mini)
 *   MCP_ACCESS_KEY - Authentication key for MCP endpoint
 *   OPEN_BRAIN_CITATION_BASE_URL - Optional base URL for search/fetch citation links
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { Pool } from "postgres";

// --- Configuration ---

const DB_HOST = Deno.env.get("DB_HOST") || "127.0.0.1";
const DB_PORT = parseInt(Deno.env.get("DB_PORT") || "5432", 10);
const DB_NAME = Deno.env.get("DB_NAME") || "openbrain";
const DB_USER = Deno.env.get("DB_USER") || "postgres";
const DB_PASSWORD = Deno.env.get("DB_PASSWORD")!;

const EMBEDDING_API_BASE = Deno.env.get("EMBEDDING_API_BASE") || "https://openrouter.ai/api/v1";
const EMBEDDING_API_KEY = Deno.env.get("EMBEDDING_API_KEY") || Deno.env.get("OPENROUTER_API_KEY") || "";
const EMBEDDING_MODEL = Deno.env.get("EMBEDDING_MODEL") || "openai/text-embedding-3-small";

const CHAT_API_BASE = Deno.env.get("CHAT_API_BASE") || EMBEDDING_API_BASE;
const CHAT_API_KEY = Deno.env.get("CHAT_API_KEY") || EMBEDDING_API_KEY;
const CHAT_MODEL = Deno.env.get("CHAT_MODEL") || "openai/gpt-4o-mini";

const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

// BigInt JSON safety: the postgres driver returns int8 columns (e.g. thoughts.id)
// as BigInt, which JSON.stringify cannot serialize ("Do not know how to serialize
// a BigInt") — this previously broke the `search`/`fetch` tools. All numbers in
// this brain are far below 2^53, so render any BigInt that reaches JSON as a Number.
// Tools that need a stable string id (the ChatGPT search/fetch contract) still
// wrap their id in String(...) explicitly below.
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this as unknown as bigint);
};

// --- PostgreSQL Connection Pool (self-reconnecting) ---
//
// deno-postgres v0.19.3 does NOT recycle a pooled connection whose socket died
// (e.g. after openbrain-db restarts: recovery scripts, gpu-reset, Docker Desktop
// restart, watchtower). It hands the dead connection straight back, so every
// subsequent query throws `BrokenPipe (os error 32)` until the PROCESS is
// restarted — the failure that surfaces to Open WebUI tools as HTTP 500.
// See memory: openbrain-mcp-stale-db-connection.
//
// ResilientPool keeps the exact `pool.connect()` / `client.release()` contract
// (so no call site changes) but: (a) builds the underlying Pool LAZILY so a
// down DB never throws at construction; (b) liveness-probes each checkout with a
// cheap `SELECT 1` and, on a connection-class failure, (c) rebuilds the Pool
// once (single-flight) and retries — so a dropped DB self-heals without an
// operator `docker restart`.
const DB_CONFIG = {
  hostname: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
};
const POOL_SIZE = 20;
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

  // Swap in a fresh Pool synchronously (so concurrent connect()s immediately use
  // it) and drain the old one in the background. Single-flight: concurrent
  // failures share one rebuild instead of spawning a pool per caller.
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

type ThoughtMatch = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
  created_at: string;
};

type ThoughtRecord = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at?: string | null;
};

const CITATION_BASE_URL =
  Deno.env.get("OPEN_BRAIN_CITATION_BASE_URL") || "https://openbrain.local/thoughts";

function thoughtTitle(content: string, createdAt?: string): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt ? new Date(createdAt).toLocaleDateString() : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

function thoughtUrl(id: string): string {
  return `${CITATION_BASE_URL.replace(/\/$/, "")}/${id}`;
}

// --- Embedding & Metadata Extraction ---

// The embedding model has a fixed physical batch (512 tokens for the local
// bge-m3 on llama-cpp-embed); a single input above it is hard-rejected. We embed
// only a bounded prefix of the text. This loses NO retrievable information: the
// full document is stored in source.content, and the chunk-worker embeds every
// 1200-char chunk separately, so deep retrieval (match_source_chunks) covers the
// whole document — only this coarse source-level summary vector is prefix-bounded.
// The budget is halved and retried on a "too large" error so dense/CJK text that
// tokenizes past the limit at MAX_EMBED_CHARS still succeeds with a smaller prefix.
const MAX_EMBED_CHARS = Number(Deno.env.get("MAX_EMBED_CHARS") || "1500");

async function getEmbedding(text: string): Promise<number[]> {
  let budget = Math.min(text.length, MAX_EMBED_CHARS);
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${EMBEDDING_API_BASE}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${EMBEDDING_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text.slice(0, budget),
      }),
    });
    if (r.ok) {
      const d = await r.json();
      return d.data[0].embedding;
    }
    const msg = await r.text().catch(() => "");
    if (
      (r.status === 500 || r.status === 413) &&
      /too large|batch size|context|n_tokens|exceed/i.test(msg) &&
      budget > 200
    ) {
      budget = Math.floor(budget / 2); // shrink and retry under the batch limit
      continue;
    }
    throw new Error(`Embedding API failed: ${r.status} ${msg}`);
  }
  throw new Error(
    "Embedding API failed: input could not be reduced under the embedding batch limit",
  );
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${CHAT_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CHAT_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

// --- Tool result size caps (adjustable via env) -----------------------------
// Large tool payloads (research dumps from list_threads / search_claims /
// search_thoughts, etc.) accumulate across a multi-tool turn and can exceed the
// model's context lane — llama.cpp then rejects the follow-up with HTTP 400
// "exceeds context size" and the model stops mid-turn (tools respond, no answer).
// So EVERY tool response is capped to a character budget (~4 chars/token). On
// truncation the model is told to narrow its request and call again, so a topic
// is gathered across several focused calls instead of one giant dump.
//   OB_TOOL_RESULT_MAX_CHARS          global cap (default 12000 ~= 3k tokens)
//   OB_TOOL_RESULT_MAX_CHARS_<TOOL>   per-tool override, e.g. _LIST_THREADS, _FETCH
// A value of 0 disables the cap (globally or for that one tool).
const TOOL_RESULT_MAX_CHARS = parseInt(Deno.env.get("OB_TOOL_RESULT_MAX_CHARS") || "12000", 10);

function toolCap(tool: string): number {
  const v = Deno.env.get(`OB_TOOL_RESULT_MAX_CHARS_${tool.toUpperCase()}`);
  const n = v !== undefined && v !== "" ? parseInt(v, 10) : NaN;
  if (Number.isFinite(n)) return n; // includes 0 = disabled for this tool
  return Number.isFinite(TOOL_RESULT_MAX_CHARS) ? TOOL_RESULT_MAX_CHARS : 0;
}

function capNotice(tool: string, shown: number | null, total: number | null): string {
  const scope = total != null ? ` (showing ${shown} of ${total})` : "";
  return `[Open Brain: '${tool}' result truncated to fit the model context${scope}. ` +
    `To see more, call again with a NARROWER request — add a filter (metadata_filter / ` +
    `type / topic / person / thread_id / status), lower 'limit', or use a more specific ` +
    `query — and gather a topic across several focused calls rather than one broad dump. ` +
    `(cap = OB_TOOL_RESULT_MAX_CHARS.)]`;
}

// Cap one text payload. Keeps JSON valid (trims array items or the dominant
// string field); truncates plain text on a paragraph boundary. Adds a notice.
function capResultText(tool: string, text: string): string {
  const cap = toolCap(tool);
  if (!cap || cap <= 0 || text.length <= cap) return text;

  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    // (a) top-level array field (results/threads/sources/…): drop trailing items.
    const arrKey = Object.keys(obj).find((k) => Array.isArray(obj[k]));
    if (arrKey) {
      const arr = obj[arrKey] as unknown[];
      const total = arr.length;
      let kept = total;
      while (kept > 1) {
        kept = Math.max(1, Math.floor(kept * 0.7));
        const trial = JSON.stringify({ ...obj, [arrKey]: arr.slice(0, kept), _note: capNotice(tool, kept, total) });
        if (trial.length <= cap) return trial;
      }
      return JSON.stringify({ ...obj, [arrKey]: arr.slice(0, 1), _note: capNotice(tool, 1, total) });
    }
    // (b) object with a dominant string field (e.g. fetch.text): trim that field.
    let strKey = "";
    let strLen = 0;
    for (const k of Object.keys(obj)) {
      const val = obj[k];
      if (typeof val === "string" && val.length > strLen) { strKey = k; strLen = val.length; }
    }
    if (strKey) {
      const overhead = JSON.stringify({ ...obj, [strKey]: "", _note: capNotice(tool, null, null) }).length;
      const room = Math.max(200, cap - overhead);
      return JSON.stringify({ ...obj, [strKey]: (obj[strKey] as string).slice(0, room), _note: capNotice(tool, null, null) });
    }
  }

  // Plain text (search_thoughts / search_claims / list_thoughts): cut on a
  // paragraph boundary, then append the notice.
  const notice = "\n\n" + capNotice(tool, null, null);
  const room = Math.max(200, cap - notice.length);
  const head = text.slice(0, room);
  const nl = head.lastIndexOf("\n\n");
  const body = nl > room * 0.5 ? head.slice(0, nl) : head;
  return body + notice;
}

// Wrap every server.registerTool so its text content is size-capped. Placed
// before the first registerTool call, so every tool (and any added later)
// inherits the cap with no per-handler changes.
type ToolResponse = { content?: Array<Record<string, unknown>>; [k: string]: unknown };
const _origRegisterTool = server.registerTool.bind(server);
(server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool = ((...args: unknown[]) => {
  const [name, config, handler] = args as [string, unknown, (...a: unknown[]) => unknown];
  return _origRegisterTool(
    name as never,
    config as never,
    (async (...a: unknown[]): Promise<ToolResponse> => {
      const res = (await handler(...a)) as ToolResponse;
      if (res && Array.isArray(res.content)) {
        res.content = res.content.map((c) =>
          c && c.type === "text" && typeof c.text === "string"
            ? { ...c, text: capResultText(name, c.text as string) }
            : c
        );
      }
      return res;
    }) as never,
  );
}) as (...a: unknown[]) => unknown;

// Optional caller-supplied JSONB metadata predicate. Used by the cloud
// gateway (../../../../openbrain-gateway/app.py) to scope reads to
// share=cloud; default-unset = unconstrained (local-zone behaviour).
// Mirrors mnemory's `labels` mechanic — keep the arg optional so trusted
// local clients are unaffected.
// Zod 4 requires the two-arg form: z.record(keySchema, valueSchema).
// Single-arg z.record(z.unknown()) breaks at runtime ("Cannot read
// properties of undefined (reading '_zod')").
const metadataFilterArg = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "Optional JSONB metadata predicate (rows must contain it). Cloud gateway forces {share:'cloud'}.",
  );
const metadataExtraArg = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "Optional metadata merged into the stored row. Cloud gateway forces {origin:'cloud',share:'cloud'}.",
  );

function hasMd(m: Record<string, unknown> | undefined): m is Record<string, unknown> {
  return !!m && Object.keys(m).length > 0;
}

// ChatGPT compatibility: restricted connector surfaces, company knowledge, and deep
// research look for exact read-only `search` and `fetch` tool shapes.
server.registerTool(
  "search",
  {
    title: "Search Open Brain",
    description:
      "Search Open Brain memories by meaning. Use this read-only compatibility tool when ChatGPT needs search/fetch-style access to stored thoughts.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      query: z.string().describe("The search query to run against Open Brain thoughts"),
      metadata_filter: metadataFilterArg,
    },
  },
  async ({ query, metadata_filter }) => {
    try {
      const qEmb = await getEmbedding(query);
      const embStr = `[${qEmb.join(",")}]`;

      const client = await pool.connect();
      try {
        const mdOn = hasMd(metadata_filter);
        const params: unknown[] = [embStr, 0.5, 10];
        if (mdOn) params.push(JSON.stringify(metadata_filter));
        const result = await client.queryObject<ThoughtMatch>(
          `SELECT id, content, metadata, created_at,
                  1 - (embedding <=> $1::vector) AS similarity
           FROM thoughts
           WHERE 1 - (embedding <=> $1::vector) >= $2
             ${mdOn ? "AND metadata @> $4::jsonb" : ""}
           ORDER BY embedding <=> $1::vector
           LIMIT $3`,
          params,
        );

        const results = result.rows.map((t) => ({
          id: String(t.id), // ChatGPT search/fetch contract: id is a string
          title: thoughtTitle(t.content, t.created_at),
          url: thoughtUrl(t.id),
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ results }) }],
        };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "fetch",
  {
    title: "Fetch Open Brain Thought",
    description:
      "Fetch one Open Brain thought by ID after using search. Use this read-only compatibility tool to retrieve the full text and metadata for citation.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      id: z.string().describe("The Open Brain thought ID returned by the search tool"),
      metadata_filter: metadataFilterArg,
    },
  },
  async ({ id, metadata_filter }) => {
    try {
      const client = await pool.connect();
      try {
        const mdOn = hasMd(metadata_filter);
        const params: unknown[] = [id];
        if (mdOn) params.push(JSON.stringify(metadata_filter));
        const result = await client.queryObject<ThoughtRecord>(
          `SELECT id, content, metadata, created_at, updated_at
           FROM thoughts
           WHERE id = $1
             ${mdOn ? "AND metadata @> $2::jsonb" : ""}
           LIMIT 1`,
          params,
        );

        const thought = result.rows[0];
        if (!thought) {
          return {
            content: [{ type: "text" as const, text: `No thought found for ID ${id}.` }],
            isError: true,
          };
        }

        const document = {
          id: String(thought.id), // ChatGPT search/fetch contract: id is a string
          title: thoughtTitle(thought.content, thought.created_at),
          text: thought.content,
          url: thoughtUrl(thought.id),
          metadata: {
            ...thought.metadata,
            created_at: thought.created_at,
            updated_at: thought.updated_at,
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(document) }],
        };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 1: Semantic Search (replaces supabase.rpc with raw SQL)
server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured. Results are capped to fit the model context — prefer a specific query with a modest 'limit' and metadata_filter, and cover a broad topic across several focused searches rather than one large one.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
      metadata_filter: metadataFilterArg,
    },
  },
  async ({ query, limit, threshold, metadata_filter }) => {
    try {
      const qEmb = await getEmbedding(query);
      const embStr = `[${qEmb.join(",")}]`;

      const client = await pool.connect();
      try {
        const mdOn = hasMd(metadata_filter);
        const params: unknown[] = [embStr, threshold, limit];
        if (mdOn) params.push(JSON.stringify(metadata_filter));
        const result = await client.queryObject<ThoughtMatch>(
          `SELECT id, content, metadata, created_at,
                  1 - (embedding <=> $1::vector) AS similarity
           FROM thoughts
           WHERE 1 - (embedding <=> $1::vector) >= $2
             ${mdOn ? "AND metadata @> $4::jsonb" : ""}
           ORDER BY embedding <=> $1::vector
           LIMIT $3`,
          params,
        );

        if (!result.rows.length) {
          return {
            content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
          };
        }

        const results = result.rows.map((t, i) => {
          const m = t.metadata || {};
          const parts = [
            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length)
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          if (Array.isArray(m.people) && m.people.length)
            parts.push(`People: ${(m.people as string[]).join(", ")}`);
          if (Array.isArray(m.action_items) && m.action_items.length)
            parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${result.rows.length} thought(s):\n\n${results.join("\n\n")}`,
            },
          ],
        };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Search grounded CLAIMS (Research Engine). Distinct from `search`/
// `search_thoughts` (which return raw thoughts): this returns the GROUNDED
// CLAIMS the research engine produced — each anchored to the source(s) that
// make it, with a computed confidence. Use to recall what research has
// ESTABLISHED (trustworthy, sourced knowledge) rather than raw captures.
server.registerTool(
  "search_claims",
  {
    title: "Search Grounded Claims",
    description:
      "Search Open Brain's GROUNDED CLAIMS by meaning — assertions established by research, each anchored to the source(s) that ground it, with a computed confidence (0-1). Prefer this over `search` when you want trustworthy, sourced facts the research engine has already established. Every claim returned is grounded (terminates in a primary source); claims flagged contradicted have conflicting evidence and are shown with low confidence. Results are capped to fit the model context — keep 'limit' modest, scope with thread_id / min_confidence, and gather a topic across several focused searches rather than one broad dump.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5).describe("Min semantic similarity 0-1"),
      min_confidence: z.number().optional().default(0).describe("Min claim confidence 0-1 (0.5 = grounded+reusable floor)"),
      thread_id: z.string().optional().describe("Restrict to one research thread (uuid)"),
    },
  },
  async ({ query, limit, threshold, min_confidence, thread_id }) => {
    try {
      const qEmb = await getEmbedding(query);
      const embStr = `[${qEmb.join(",")}]`;
      const client = await pool.connect();
      try {
        const params: unknown[] = [embStr, threshold, limit, min_confidence];
        let threadClause = "";
        if (thread_id) { params.push(thread_id); threadClause = `AND c.thread_id = $5`; }
        const result = await client.queryObject<{
          id: string; text: string; confidence: number; contradicted: boolean;
          thread_id: string | null; similarity: number;
          sources: Array<{ title: string; url: string | null }>;
        }>(
          `SELECT c.id, c.text, c.confidence, c.contradicted, c.thread_id,
                  1 - (c.embedding <=> $1::vector) AS similarity,
                  COALESCE((
                    SELECT json_agg(json_build_object('title', s.title, 'url', s.url))
                    FROM public.claim_sources cs JOIN public.sources s ON s.id = cs.source_id
                    WHERE cs.claim_id = c.id AND cs.edge_type <> 'contradicts'
                  ), '[]'::json) AS sources
             FROM public.claims c
            WHERE c.status = 'active' AND c.embedding IS NOT NULL
              AND 1 - (c.embedding <=> $1::vector) >= $2
              AND c.confidence >= $4
              ${threadClause}
            ORDER BY c.embedding <=> $1::vector
            LIMIT $3`,
          params,
        );
        if (!result.rows.length) {
          return { content: [{ type: "text" as const, text: `No grounded claims found matching "${query}".` }] };
        }
        const results = result.rows.map((c, i) => {
          const srcs = (c.sources || []).map((s) => s.url ? `${s.title} (${s.url})` : s.title);
          const flag = c.contradicted ? " ⚠ CONTRADICTED (conflicting evidence)" : "";
          return [
            `--- Claim ${i + 1} (${(c.similarity * 100).toFixed(0)}% match · confidence ${c.confidence.toFixed(2)})${flag} ---`,
            c.text,
            srcs.length ? `Grounded in: ${srcs.join("; ")}` : "Grounded (sources omitted)",
          ].join("\n");
        });
        return {
          content: [{ type: "text" as const, text: `Found ${result.rows.length} grounded claim(s):\n\n${results.join("\n\n")}` }],
        };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: List Recent (replaces supabase query builder with raw SQL)
server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range. Results are capped to fit the model context — use the filters and a modest 'limit', and page through a topic with successive narrower calls rather than requesting everything at once.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe("Only thoughts from the last N days"),
      metadata_filter: metadataFilterArg,
    },
  },
  async ({ limit, type, topic, person, days, metadata_filter }) => {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (type) {
        conditions.push(`metadata->>'type' = $${paramIdx}`);
        params.push(type);
        paramIdx++;
      }
      if (topic) {
        conditions.push(`metadata->'topics' ? $${paramIdx}`);
        params.push(topic);
        paramIdx++;
      }
      if (person) {
        conditions.push(`metadata->'people' ? $${paramIdx}`);
        params.push(person);
        paramIdx++;
      }
      if (days) {
        conditions.push(`created_at >= NOW() - INTERVAL '${days} days'`);
      }
      if (hasMd(metadata_filter)) {
        conditions.push(`metadata @> $${paramIdx}::jsonb`);
        params.push(JSON.stringify(metadata_filter));
        paramIdx++;
      }

      const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

      const client = await pool.connect();
      try {
        const result = await client.queryObject<{
          content: string;
          metadata: Record<string, unknown>;
          created_at: string;
        }>(
          `SELECT content, metadata, created_at
           FROM thoughts
           ${whereClause}
           ORDER BY created_at DESC
           LIMIT $${paramIdx}`,
          [...params, limit]
        );

        if (!result.rows.length) {
          return { content: [{ type: "text" as const, text: "No thoughts found." }] };
        }

        const results = result.rows.map((t, i) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `${result.rows.length} recent thought(s):\n\n${results.join("\n\n")}`,
            },
          ],
        };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: Stats (replaces supabase queries with raw SQL)
server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {},
  },
  async () => {
    try {
      const client = await pool.connect();
      try {
        const countResult = await client.queryObject<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM thoughts"
        );

        const dataResult = await client.queryObject<{
          metadata: Record<string, unknown>;
          created_at: string;
        }>(
          "SELECT metadata, created_at FROM thoughts ORDER BY created_at DESC"
        );

        const count = countResult.rows[0]?.count || 0;
        const data = dataResult.rows;

        const types: Record<string, number> = {};
        const topics: Record<string, number> = {};
        const people: Record<string, number> = {};

        for (const r of data) {
          const m = r.metadata || {};
          if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
          if (Array.isArray(m.topics))
            for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
          if (Array.isArray(m.people))
            for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
        }

        const sort = (o: Record<string, number>): [string, number][] =>
          Object.entries(o)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const lines: string[] = [
          `Total thoughts: ${count}`,
          `Date range: ${
            data.length
              ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
                " -> " +
                new Date(data[0].created_at).toLocaleDateString()
              : "N/A"
          }`,
          "",
          "Types:",
          ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
        ];

        if (Object.keys(topics).length) {
          lines.push("", "Top topics:");
          for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
        }

        if (Object.keys(people).length) {
          lines.push("", "People mentioned:");
          for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: Capture Thought (replaces supabase insert with raw SQL)
server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically.",
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      content: z.string().describe("The thought to capture"),
      metadata_extra: metadataExtraArg,
    },
  },
  async ({ content, metadata_extra }) => {
    try {
      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);

      const embStr = `[${embedding.join(",")}]`;
      const meta: Record<string, unknown> = {
        ...metadata,
        source: "mcp",
        ...(metadata_extra ?? {}),
      };

      const client = await pool.connect();
      try {
        await client.queryObject(
          `INSERT INTO thoughts (content, embedding, metadata)
           VALUES ($1, $2::vector, $3::jsonb)`,
          [content, embStr, JSON.stringify(meta)]
        );
      } finally {
        client.release();
      }

      let confirmation = `Captured as ${meta.type || "thought"}`;
      if (Array.isArray(meta.topics) && meta.topics.length)
        confirmation += ` -- ${(meta.topics as string[]).join(", ")}`;
      if (Array.isArray(meta.people) && meta.people.length)
        confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
      if (Array.isArray(meta.action_items) && meta.action_items.length)
        confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;

      return {
        content: [{ type: "text" as const, text: confirmation }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// --- Source ingest (v2 three-layer: external documents -> `sources`) ---
//
// Local, dependency-free fetch + extraction. NOT smolcrawl (that is a
// separate whole-domain tool). End users feed URLs here for wiki use;
// deep_research writes its gathered sources through the same table.

function detectContentType(url: string, ctHeader: string): string {
  const u = url.toLowerCase();
  if (/youtube\.com\/watch|youtu\.be\//.test(u)) return "youtube_transcript";
  if (u.endsWith(".pdf") || ctHeader.includes("application/pdf")) return "pdf";
  if (/arxiv\.org\/(abs|pdf)\//.test(u)) return "paper";
  return "web_article";
}

function stripHtml(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return { title, text };
}

type IngestOutcome = {
  url: string;
  ok: boolean;
  id?: string;
  title?: string;
  content_type?: string;
  chars?: number;
  error?: string;
};

async function ingestOne(
  url: string,
  notebook: string | undefined,
  tags: string[],
  metadata_extra?: Record<string, unknown>,
): Promise<IngestOutcome> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "open-brain-ingest/1.0" },
      redirect: "follow",
    });
    if (!resp.ok) {
      return { url, ok: false, error: `fetch ${resp.status}` };
    }
    const ctHeader = (resp.headers.get("content-type") || "").toLowerCase();
    const contentType = detectContentType(url, ctHeader);

    let title = "";
    let body = "";
    if (contentType === "pdf") {
      // No PDF text extraction without a heavy dep; store a stub the
      // user/agent can replace. Modular: a future extractor can fill this.
      body = `[PDF source not text-extracted: ${url}]`;
    } else {
      const raw = await resp.text();
      if (/^\s*</.test(raw) || ctHeader.includes("html")) {
        const ex = stripHtml(raw);
        title = ex.title;
        body = ex.text;
      } else {
        body = raw.replace(/\s+/g, " ").trim();
      }
    }
    if (!body) return { url, ok: false, error: "no extractable content" };

    let domain = "";
    try {
      domain = new URL(url).hostname;
    } catch { /* ignore */ }
    if (!title) title = domain || url.slice(0, 120);

    // llama-cpp-embed (bge-m3) rejects inputs over its physical batch
    // (512 tokens). Cap the embed input well under that (~1600 chars);
    // the FULL body is still stored. Richer embeddings require raising
    // the embed server batch size (VRAM-costed — see tracker F7).
    const embInput = `${title}\n\n${body}`.slice(0, 1600);
    const embedding = await getEmbedding(embInput);
    const embStr = `[${embedding.join(",")}]`;

    const client = await pool.connect();
    try {
      const meta: Record<string, unknown> = {
        source: "ingest_url",
        ...(metadata_extra ?? {}),
      };
      const res = await client.queryObject<{ id: string }>(
        `INSERT INTO sources
           (url, title, content, content_type, tags, notebook, domain,
            fetched_at, embedding, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8::vector, $9::jsonb)
         RETURNING id`,
        [
          url, title, body, contentType, tags, notebook ?? null, domain,
          embStr, JSON.stringify(meta),
        ],
      );
      return {
        url, ok: true, id: res.rows[0]?.id, title,
        content_type: contentType, chars: body.length,
      };
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    return { url, ok: false, error: (err as Error).message };
  }
}

server.registerTool(
  "ingest_url",
  {
    title: "Ingest URL",
    description:
      "Fetch a single URL, extract its text, embed it, and store it as an external source document for wiki/research use. Use when the user wants to add a web page, article, or paper to Open Brain.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      url: z.string().describe("The URL to ingest"),
      notebook: z.string().optional().describe("Optional notebook/project to group this source under"),
      tags: z.array(z.string()).optional().describe("Optional tags"),
      metadata_extra: metadataExtraArg,
    },
  },
  async ({ url, notebook, tags, metadata_extra }) => {
    const r = await ingestOne(url, notebook, tags ?? [], metadata_extra);
    const text = r.ok
      ? `Ingested source ${r.id} — "${r.title}" (${r.content_type}, ${r.chars} chars)`
      : `Failed to ingest ${url}: ${r.error}`;
    return { content: [{ type: "text" as const, text }], isError: !r.ok };
  },
);

server.registerTool(
  "ingest_urls",
  {
    title: "Ingest URLs (batch)",
    description:
      "Fetch a list of URLs in parallel, extract and embed each, and store them as external source documents. Use for batch-adding sources for wiki/research use.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      urls: z.array(z.string()).describe("The URLs to ingest"),
      notebook: z.string().optional().describe("Optional notebook/project for all of them"),
      tags: z.array(z.string()).optional().describe("Optional tags applied to all"),
      metadata_extra: metadataExtraArg,
    },
  },
  async ({ urls, notebook, tags, metadata_extra }) => {
    const results = await Promise.all(
      urls.map((u) => ingestOne(u, notebook, tags ?? [], metadata_extra)),
    );
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    const lines = [
      `Ingested ${ok.length}/${results.length} source(s).`,
      ...ok.map((r) => `  ✓ ${r.id} — "${r.title}" (${r.content_type})`),
      ...failed.map((r) => `  ✗ ${r.url}: ${r.error}`),
    ];
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      isError: ok.length === 0,
    };
  },
);

// --- Research threads + suggestions (Integrated Knowledge System) ------
//
// Thread / session / suggestion tools over the Phase-1 schema (threads,
// thread_sources, sessions, session_sources + find_or_create_source /
// link_source_to_thread / set_thread_source_status).
//
// PRIVACY (guardrail 5 / Task 2.2): these are personal/local tools. They
// are deliberately NOT added to the openbrain-gateway cloud allow-list
// (../../../../openbrain-gateway/app.py ALLOWED_TOOLS), mirroring the
// extensions server. Cloud clients cannot see or call them. Do not expose
// them there without explicit operator sign-off; if you do, give the read
// tools a metadata_filter the way search/fetch get one.

type ThreadRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

// create_thread
server.registerTool(
  "create_thread",
  {
    title: "Create Research Thread",
    description:
      "Create a new research thread (a durable, named line of inquiry that accumulates sources across tools and sessions).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      name: z.string().describe("Short thread name"),
      description: z.string().optional().describe("Optional guiding question / description"),
    },
  },
  async ({ name, description }) => {
    try {
      const client = await pool.connect();
      try {
        const r = await client.queryObject<ThreadRow>(
          `INSERT INTO threads (name, description)
           VALUES ($1, $2)
           RETURNING id, name, description, status, created_at, updated_at`,
          [name, description ?? null],
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(r.rows[0]) }] };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// list_threads
server.registerTool(
  "list_threads",
  {
    title: "List Research Threads",
    description:
      "List research threads (id, name, description, status, source_count), most-recently-updated first. Defaults to active threads; pass status='archived' or status='all'. Output is capped to fit the model context, so it may not include every thread at once — narrow with status, and pull a thread's detail on demand via get_thread_sources or search_claims(thread_id=...) instead of expecting the full description of every thread here.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      status: z
        .enum(["active", "archived", "all"])
        .optional()
        .default("active")
        .describe("Filter by status (default active)"),
    },
  },
  async ({ status }) => {
    try {
      const filter = !status || status === "all" ? null : status;
      const client = await pool.connect();
      try {
        const r = await client.queryObject<ThreadRow & { source_count: number }>(
          `SELECT t.id, t.name, t.description, t.status, t.created_at, t.updated_at,
                  (SELECT COUNT(*)::int FROM thread_sources ts
                    WHERE ts.thread_id = t.id AND ts.status = 'confirmed') AS source_count
           FROM threads t
           WHERE ($1::text IS NULL OR t.status = $1)
           ORDER BY t.updated_at DESC`,
          [filter],
        );
        return { content: [{ type: "text" as const, text: JSON.stringify({ threads: r.rows }) }] };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

type ThreadSourceView = {
  source_id: string;
  url: string | null;
  title: string;
  content_type: string;
  link_type: string;
  status: string;
  suggestion_reason: string | null;
  created_at: string;
  confirmed_at: string | null;
};

// get_thread_sources — only CONFIRMED links (the thread "view").
server.registerTool(
  "get_thread_sources",
  {
    title: "Get Thread Sources",
    description:
      "Return all confirmed sources linked to a thread (regardless of which tool ingested them). This is the thread/notebook view.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      thread_id: z.string().describe("Thread UUID"),
    },
  },
  async ({ thread_id }) => {
    try {
      const client = await pool.connect();
      try {
        const r = await client.queryObject<ThreadSourceView>(
          `SELECT ts.source_id, s.url, s.title, s.content_type,
                  ts.link_type, ts.status, ts.suggestion_reason,
                  ts.created_at, ts.confirmed_at
           FROM thread_sources ts
           JOIN sources s ON s.id = ts.source_id
           WHERE ts.thread_id = $1 AND ts.status = 'confirmed'
           ORDER BY ts.confirmed_at DESC NULLS LAST, ts.created_at DESC`,
          [thread_id],
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ thread_id, sources: r.rows }) }],
        };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// add_to_thread — deliberate link of an existing source.
server.registerTool(
  "add_to_thread",
  {
    title: "Add Source to Thread",
    description:
      "Deliberately link an existing source to a thread (link_type=deliberate, confirmed). Additive — never removes it from any other thread.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      thread_id: z.string().describe("Thread UUID"),
      source_id: z.string().describe("Source UUID"),
    },
  },
  async ({ thread_id, source_id }) => {
    try {
      const client = await pool.connect();
      try {
        await client.queryObject(
          `SELECT link_source_to_thread($1, $2, 'deliberate', NULL, 'confirmed')`,
          [thread_id, source_id],
        );
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ thread_id, source_id, link_type: "deliberate", status: "confirmed" }),
          }],
        };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// Helper: register the soft status-flip tools (remove/accept/hide/restore).
// All call set_thread_source_status — pure flag flips, never deletes.
function registerStatusTool(
  name: string,
  title: string,
  description: string,
  targetStatus: string,
) {
  server.registerTool(
    name,
    {
      title,
      description,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        thread_id: z.string().describe("Thread UUID"),
        source_id: z.string().describe("Source UUID"),
      },
    },
    async ({ thread_id, source_id }) => {
      try {
        const client = await pool.connect();
        try {
          const r = await client.queryObject<{ status: string; link_type: string }>(
            `SELECT (set_thread_source_status($1, $2, $3)).status AS status`,
            [thread_id, source_id, targetStatus],
          );
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ thread_id, source_id, status: r.rows[0]?.status ?? targetStatus }),
            }],
          };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

registerStatusTool(
  "remove_from_thread",
  "Remove Source from Thread (soft)",
  "Soft-remove a source from a thread: marks the link inactive (recoverable). Never deletes the source or the join row.",
  "inactive",
);
registerStatusTool(
  "accept_suggestion",
  "Accept Suggestion",
  "Confirm a pending cross-thread suggestion: the source now appears in the thread view, indistinguishable from auto/deliberate links.",
  "confirmed",
);
registerStatusTool(
  "hide_suggestion",
  "Hide Suggestion",
  "Hide a pending suggestion: removes it from the triage queue but keeps it in the recoverable hidden pool.",
  "hidden",
);
registerStatusTool(
  "restore_suggestion",
  "Restore Suggestion",
  "Restore a hidden suggestion back to pending so it re-appears in the triage queue.",
  "pending",
);

// Helper: list thread_sources rows in a given status (suggestions / hidden).
type SuggestionView = {
  thread_id: string;
  source_id: string;
  url: string | null;
  title: string;
  link_type: string;
  suggestion_reason: string | null;
  created_at: string;
};

function registerSuggestionList(
  name: string,
  title: string,
  description: string,
  whereStatus: string,
) {
  server.registerTool(
    name,
    {
      title,
      description,
      annotations: { readOnlyHint: true },
      inputSchema: {
        thread_id: z.string().optional().describe("Optional thread UUID to scope to; omit for global"),
      },
    },
    async ({ thread_id }) => {
      try {
        const client = await pool.connect();
        try {
          const r = await client.queryObject<SuggestionView>(
            `SELECT ts.thread_id, ts.source_id, s.url, s.title,
                    ts.link_type, ts.suggestion_reason, ts.created_at
             FROM thread_sources ts
             JOIN sources s ON s.id = ts.source_id
             WHERE ts.status = $1
               AND ($2::uuid IS NULL OR ts.thread_id = $2)
             ORDER BY ts.created_at DESC`,
            [whereStatus, thread_id ?? null],
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ status: whereStatus, items: r.rows }) }],
          };
        } finally {
          client.release();
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

registerSuggestionList(
  "get_suggestions",
  "Get Pending Suggestions",
  "Return pending cross-thread suggestions (the triage queue), optionally scoped to one thread.",
  "pending",
);
registerSuggestionList(
  "get_hidden_suggestions",
  "Get Hidden Suggestions",
  "Return hidden/rejected suggestions (the recoverable pool), optionally scoped to one thread.",
  "hidden",
);

// fetchExtract — minimal fetch + text extraction for capture_with_thread
// when only a URL is supplied. Mirrors ingestOne's extraction (kept
// separate so the live ingest path is untouched).
async function fetchExtract(
  url: string,
): Promise<{ title: string; body: string; contentType: string; domain: string }> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "open-brain-ingest/1.0" },
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`fetch ${resp.status}`);
  const ctHeader = (resp.headers.get("content-type") || "").toLowerCase();
  const contentType = detectContentType(url, ctHeader);
  let title = "";
  let body = "";
  if (contentType === "pdf") {
    body = `[PDF source not text-extracted: ${url}]`;
  } else {
    const raw = await resp.text();
    if (/^\s*</.test(raw) || ctHeader.includes("html")) {
      const ex = stripHtml(raw);
      title = ex.title;
      body = ex.text;
    } else {
      body = raw.replace(/\s+/g, " ").trim();
    }
  }
  let domain = "";
  try {
    domain = new URL(url).hostname;
  } catch { /* ignore */ }
  if (!title) title = domain || url.slice(0, 120);
  return { title, body, contentType, domain };
}

// capture_with_thread — one-transaction capture: find-or-create the source
// (dedup) + automatic/confirmed thread link + optional session link.
server.registerTool(
  "capture_with_thread",
  {
    title: "Capture Source into Thread",
    description:
      "Write a source and link it to a thread in one operation. Dedups on url/content_hash (find_or_create_source); links automatic/confirmed. Pass `content`, or a `url` to fetch. Optionally attach to a session.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      thread_id: z.string().describe("Thread UUID to link the source to"),
      content: z.string().optional().describe("Source body. If omitted and url is given, the url is fetched."),
      url: z.string().optional().describe("Source URL (used for dedup + optional fetch)"),
      title: z.string().optional().describe("Optional title"),
      content_type: z
        .enum(["web_article", "pdf", "youtube_transcript", "podcast_transcript", "paper", "manual"])
        .optional()
        .describe("Optional content type (default web_article / inferred)"),
      notebook: z.string().optional().describe("Optional notebook/project scope"),
      session_id: z.string().optional().describe("Optional session UUID to also record provenance"),
      metadata_extra: metadataExtraArg,
    },
  },
  async ({ thread_id, content, url, title, content_type, notebook, session_id, metadata_extra }) => {
    try {
      let body = (content ?? "").trim();
      let ttl = (title ?? "").trim();
      let ctype: string | undefined = content_type;
      let domain: string | undefined;

      if (!body && url) {
        const ex = await fetchExtract(url);
        body = ex.body;
        if (!ttl) ttl = ex.title;
        if (!ctype) ctype = ex.contentType;
        domain = ex.domain;
      }
      if (!body) {
        return {
          content: [{ type: "text" as const, text: "capture_with_thread needs `content` or a fetchable `url`." }],
          isError: true,
        };
      }
      if (!ctype) ctype = "web_article";
      if (!ttl) ttl = url ? url.slice(0, 120) : body.slice(0, 80);
      if (!domain && url) {
        try { domain = new URL(url).hostname; } catch { /* ignore */ }
      }

      const embInput = `${ttl}\n\n${body}`.slice(0, 1600);
      const embedding = await getEmbedding(embInput);
      const embStr = `[${embedding.join(",")}]`;
      const meta = { source: "capture_with_thread", ...(metadata_extra ?? {}) };

      const client = await pool.connect();
      try {
        await client.queryArray("BEGIN");
        const src = await client.queryObject<{ id: string; was_duplicate: boolean }>(
          `SELECT * FROM find_or_create_source($1, $2, NULL, $3, $4, $5, $6, $7::vector, $8::jsonb)`,
          [url ?? null, body, ttl, ctype, notebook ?? null, domain ?? null, embStr, JSON.stringify(meta)],
        );
        const sourceId = src.rows[0].id;
        const wasDup = src.rows[0].was_duplicate;
        await client.queryObject(
          `SELECT link_source_to_thread($1, $2, 'automatic', NULL, 'confirmed')`,
          [thread_id, sourceId],
        );
        if (session_id) {
          await client.queryObject(
            `INSERT INTO session_sources (session_id, source_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [session_id, sourceId],
          );
        }
        await client.queryArray("COMMIT");
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              source_id: sourceId,
              was_duplicate: wasDup,
              thread_id,
              link: "automatic/confirmed",
              session_id: session_id ?? null,
              note: wasDup ? "source already existed — linked to this thread" : "source created and linked",
            }),
          }],
        };
      } catch (e) {
        await client.queryArray("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// --- Research persistence REST API (deep_research -> open-brain) ---
//
// deep_research_tool.py (running in Open WebUI) calls these instead of
// misusing mnemory. open-brain returns full structured rows, so the old
// ⟦EV:research⟧ header / label / artifact workarounds are gone — volatility
// and staleness are real columns on `sources`.

const app = new Hono();

function researchAuthed(c: { req: { header: (k: string) => string | undefined; url: string } }): boolean {
  const provided = c.req.header("x-brain-key") ||
    new URL(c.req.url).searchParams.get("key");
  return !!provided && provided === MCP_ACCESS_KEY;
}

// GET /research/lookup?key=<research_key> — current synthesis row + staleness.
app.get("/research/lookup", async (c) => {
  if (!researchAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  const key = c.req.query("key");
  if (!key) return c.json({ found: false });
  const client = await pool.connect();
  try {
    const r = await client.queryObject<{
      id: string; content: string; researched_on: string | null;
      volatility: string | null; revalidate_days: number | null;
      run_kind: string | null;
    }>(
      `SELECT id, content, researched_on, volatility, revalidate_days, run_kind
         FROM sources
        WHERE content_type='research_synthesis' AND research_key=$1
        LIMIT 1`,
      [key],
    );
    if (r.rows.length === 0) return c.json({ found: false });
    const row = r.rows[0];
    let isStale = false, ageDays: number | null = null, dueDate: string | null = null;
    if (row.researched_on && row.revalidate_days != null) {
      const ro = new Date(row.researched_on);
      const due = new Date(ro.getTime() + row.revalidate_days * 86400000);
      const today = new Date();
      ageDays = Math.floor((today.getTime() - ro.getTime()) / 86400000);
      dueDate = due.toISOString().slice(0, 10);
      isStale = today > due;
    }
    // Grounding signal (Research Engine P2.3). The reuse path must NOT re-serve
    // a synthesis with no grounded claims (that is how a fabricated answer got
    // re-cached as fact). `grounded` = this synthesis has >=1 reusable claim
    // (grounded ∧ fresh ∧ >= confidence floor). Guarded: the claims layer is
    // additive (P1.5) and may not be applied yet — degrade to null, never 500.
    let groundedClaims: number | null = null, totalClaims: number | null = null;
    try {
      const g = await client.queryObject<{ grounded: bigint; total: bigint }>(
        `SELECT
           (SELECT count(*) FROM reusable_claims WHERE synthesis_id = $1) AS grounded,
           (SELECT count(*) FROM claims WHERE synthesis_id = $1 AND status='active') AS total`,
        [row.id],
      );
      groundedClaims = Number(g.rows[0]?.grounded ?? 0);
      totalClaims = Number(g.rows[0]?.total ?? 0);
    } catch { /* claims layer not applied yet — leave null (unknown) */ }
    return c.json({
      found: true, id: row.id, claim: row.content,
      researched_on: row.researched_on, volatility: row.volatility,
      revalidate_days: row.revalidate_days, run_kind: row.run_kind,
      is_stale: isStale, age_days: ageDays, due_date: dueDate,
      grounded_claims: groundedClaims, total_claims: totalClaims,
      // null = unknown (pre-migration); true/false once the claims layer exists.
      grounded: groundedClaims == null ? null : groundedClaims > 0,
    });
  } catch (err) {
    return c.json({ found: false, error: (err as Error).message }, 500);
  } finally {
    client.release();
  }
});

// POST /research/persist — supersede-in-place synthesis + provenance.
//
// Phase 3 (Integrated Knowledge System):
//   * C1 fix: per-source rows are dedup-and-relinked via
//     find_or_create_source (stable ids) instead of the old destructive
//     DELETE+INSERT, so thread_sources/session_sources FKs survive a
//     re-run. Sources accumulate (additive); nothing source-shaped is
//     deleted. The synthesis row still upserts in place.
//   * Every persist creates one `sessions` row (origin_tool='owui') and
//     links each gathered source via session_sources (provenance).
//   * If `thread_id` is supplied, each source is auto-linked to that
//     thread (link_type='automatic', confirmed). No thread_id => the
//     sources land in the unthreaded inbox (session only).
app.post("/research/persist", async (c) => {
  if (!researchAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  let body: {
    research_key?: string; query?: string; claim?: string; synthesis?: string; kind?: string;
    volatility?: string; revalidate_days?: number; notebook?: string;
    thread_id?: string;   // active thread; absent => unthreaded inbox
    model?: string;       // originating model (provenance metadata)
    sources?: Array<{ url?: string; title?: string; content?: string; summary?: string; domain?: string }>;
  };
  try { body = await c.req.json(); } catch { return c.json({ error: "bad json" }, 400); }
  const key = body.research_key;
  const claim = (body.claim || "").trim();
  if (!key || !claim) return c.json({ error: "research_key and claim required" }, 400);
  // The synthesis row's CONTENT is the FULL detailed research result when the
  // caller provides it; `claim` is the short standalone summary, kept for the
  // topical embedding + cache display. Older callers that only send `claim`
  // still work (content falls back to claim).
  const content = (body.synthesis || "").trim() || claim;
  const threadId = (body.thread_id || "").trim() || null;

  const client = await pool.connect();
  try {
    await client.queryArray("BEGIN");
    // Embed the short claim (focused, topical) — chunk-level retrieval over the
    // full content is handled separately by the chunk-embedding worker.
    const claimEmb = `[${(await getEmbedding(claim.slice(0, 1600))).join(",")}]`;
    // Supersede the synthesis row in place (unique partial index on research_key).
    const synth = await client.queryObject<{ id: string }>(
      `INSERT INTO sources
         (url, title, content, content_type, notebook, research_key,
          research_query, run_kind, volatility, revalidate_days,
          researched_on, fetched_at, embedding, metadata)
       VALUES (NULL, $1, $2, 'research_synthesis', $3, $4, $5, $6, $7, $8,
               CURRENT_DATE, now(), $9::vector, $10::jsonb)
       ON CONFLICT (research_key) WHERE content_type='research_synthesis'
       DO UPDATE SET content=EXCLUDED.content, notebook=EXCLUDED.notebook,
         research_query=EXCLUDED.research_query, run_kind=EXCLUDED.run_kind,
         volatility=EXCLUDED.volatility, revalidate_days=EXCLUDED.revalidate_days,
         researched_on=CURRENT_DATE, fetched_at=now(),
         embedding=EXCLUDED.embedding, updated_at=now()
       RETURNING id`,
      [
        (body.query || "research").slice(0, 200), content, body.notebook ?? null,
        key, body.query ?? null, body.kind ?? null,
        body.volatility ?? null, body.revalidate_days ?? null,
        claimEmb, JSON.stringify({ source: "deep-research", claim }),
      ],
    );

    // One session per persist run (provenance: where did these come from?).
    const sess = await client.queryObject<{ id: string }>(
      `INSERT INTO sessions (origin_tool, query_text, thread_id, metadata)
       VALUES ('owui', $1, $2, $3::jsonb)
       RETURNING id`,
      [
        body.query ?? null, threadId,
        JSON.stringify({ research_key: key, kind: body.kind ?? null, model: body.model ?? null }),
      ],
    );
    const sessionId = sess.rows[0].id;

    // Make the synthesis row a first-class MEMBER of its session + thread. Without
    // this the research_synthesis source is an orphan (findable only by
    // research_key), so it never surfaces in the notebook — the wiki compiler's
    // "## Deep Research" section is driven by thread membership. Linking it here
    // makes the originating AI synthesis appear (and be referenceable) under the
    // curator-resolved thread.
    const synthesisId = synth.rows[0]?.id;
    if (synthesisId) {
      await client.queryObject(
        `INSERT INTO session_sources (session_id, source_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [sessionId, synthesisId],
      );
      if (threadId) {
        await client.queryObject(
          `SELECT link_source_to_thread($1, $2, 'automatic', NULL, 'confirmed')`,
          [threadId, synthesisId],
        );
      }
    }

    let written = 0;
    // Index-aligned with body.sources so [Source N] in the synthesis maps to
    // source_ids[N-1] (null = a source that was skipped/empty). The curator
    // uses this to resolve the synthesis's citations into claim→source
    // grounding edges (Research Engine P1.6/P2.1).
    const sourceIds: Array<string | null> = [];
    for (const s of (body.sources || [])) {
      const url = (s.url || "").trim();
      const content = (s.content || s.summary || "").trim();
      if (!url && !content) { sourceIds.push(null); continue; }
      const title = (s.title || s.domain || url || "source").slice(0, 300);
      const emb = `[${(await getEmbedding(`${title}\n\n${content}`.slice(0, 1600))).join(",")}]`;
      const provMeta = {
        source: "deep-research-source",
        research_key: key,
        originating_query: body.query ?? null,
        model: body.model ?? null,
        session_id: sessionId,
      };
      // C1: dedup-and-relink (stable id), never delete.
      const fc = await client.queryObject<{ id: string; was_duplicate: boolean }>(
        `SELECT * FROM find_or_create_source($1, $2, NULL, $3, 'web_article', $4, $5, $6::vector, $7::jsonb)`,
        [url || null, content, title, body.notebook ?? null, s.domain ?? null, emb, JSON.stringify(provMeta)],
      );
      const sid = fc.rows[0].id;
      // Update content in place + (re)stamp research linkage & provenance.
      // (Nothing reads per-source rows by research_key except this writer,
      // so re-stamping a deduped row is safe — see /research/lookup.)
      await client.queryObject(
        `UPDATE sources SET
           content       = $2,
           title         = COALESCE(NULLIF($3,''), title),
           domain        = COALESCE($4, domain),
           research_key  = $5,
           research_query= $6,
           fetched_at    = now(),
           embedding     = $7::vector,
           content_hash  = COALESCE(content_hash, md5($2)),
           metadata      = COALESCE(metadata,'{}'::jsonb) || $8::jsonb
         WHERE id = $1`,
        [sid, content, title, s.domain ?? null, key, body.query ?? null, emb, JSON.stringify(provMeta)],
      );
      // Provenance link (session) — always.
      await client.queryObject(
        `INSERT INTO session_sources (session_id, source_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [sessionId, sid],
      );
      // Thread auto-link — only when a thread is active.
      if (threadId) {
        await client.queryObject(
          `SELECT link_source_to_thread($1, $2, 'automatic', NULL, 'confirmed')`,
          [threadId, sid],
        );
      }
      sourceIds.push(sid);
      written++;
    }
    await client.queryArray("COMMIT");
    return c.json({
      synthesis_id: synth.rows[0]?.id,
      sources_written: written,
      source_ids: sourceIds,   // index-aligned with body.sources ([Source N] => [N-1])
      session_id: sessionId,
      thread_id: threadId,
      threaded: !!threadId,
    });
  } catch (err) {
    await client.queryArray("ROLLBACK").catch(() => {});
    return c.json({ error: (err as Error).message }, 500);
  } finally {
    client.release();
  }
});

// --- MCP catch-all with Auth Check ---

app.all("*", async (c) => {
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve({ port: parseInt(Deno.env.get("PORT") || "8000", 10) }, app.fetch);
