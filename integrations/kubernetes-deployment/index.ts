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

// --- PostgreSQL Connection Pool ---

const pool = new Pool({
  hostname: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
}, 20);

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

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${EMBEDDING_API_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${EMBEDDING_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`Embedding API failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
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
          id: t.id,
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
          id: thought.id,
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
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
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

// Tool 2: List Recent (replaces supabase query builder with raw SQL)
server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range.",
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
      "List research threads. Defaults to active threads; pass status='archived' or status='all'.",
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
    return c.json({
      found: true, id: row.id, claim: row.content,
      researched_on: row.researched_on, volatility: row.volatility,
      revalidate_days: row.revalidate_days, run_kind: row.run_kind,
      is_stale: isStale, age_days: ageDays, due_date: dueDate,
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
    for (const s of (body.sources || [])) {
      const url = (s.url || "").trim();
      const content = (s.content || s.summary || "").trim();
      if (!url && !content) continue;
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
      written++;
    }
    await client.queryArray("COMMIT");
    return c.json({
      synthesis_id: synth.rows[0]?.id,
      sources_written: written,
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
