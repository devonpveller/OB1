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
    },
  },
  async ({ query }) => {
    try {
      const qEmb = await getEmbedding(query);
      const embStr = `[${qEmb.join(",")}]`;

      const client = await pool.connect();
      try {
        const result = await client.queryObject<ThoughtMatch>(
          `SELECT id, content, metadata, created_at,
                  1 - (embedding <=> $1::vector) AS similarity
           FROM thoughts
           WHERE 1 - (embedding <=> $1::vector) >= $2
           ORDER BY embedding <=> $1::vector
           LIMIT $3`,
          [embStr, 0.5, 10]
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
    },
  },
  async ({ id }) => {
    try {
      const client = await pool.connect();
      try {
        const result = await client.queryObject<ThoughtRecord>(
          `SELECT id, content, metadata, created_at, updated_at
           FROM thoughts
           WHERE id = $1
           LIMIT 1`,
          [id]
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
    },
  },
  async ({ query, limit, threshold }) => {
    try {
      const qEmb = await getEmbedding(query);
      const embStr = `[${qEmb.join(",")}]`;

      const client = await pool.connect();
      try {
        const result = await client.queryObject<ThoughtMatch>(
          `SELECT id, content, metadata, created_at,
                  1 - (embedding <=> $1::vector) AS similarity
           FROM thoughts
           WHERE 1 - (embedding <=> $1::vector) >= $2
           ORDER BY embedding <=> $1::vector
           LIMIT $3`,
          [embStr, threshold, limit]
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
    },
  },
  async ({ limit, type, topic, person, days }) => {
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
    },
  },
  async ({ content }) => {
    try {
      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);

      const embStr = `[${embedding.join(",")}]`;
      const meta: Record<string, unknown> = { ...metadata, source: "mcp" };

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
      const res = await client.queryObject<{ id: string }>(
        `INSERT INTO sources
           (url, title, content, content_type, tags, notebook, domain,
            fetched_at, embedding, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8::vector, $9::jsonb)
         RETURNING id`,
        [
          url, title, body, contentType, tags, notebook ?? null, domain,
          embStr, JSON.stringify({ source: "ingest_url" }),
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
    },
  },
  async ({ url, notebook, tags }) => {
    const r = await ingestOne(url, notebook, tags ?? []);
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
    },
  },
  async ({ urls, notebook, tags }) => {
    const results = await Promise.all(
      urls.map((u) => ingestOne(u, notebook, tags ?? [])),
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

// --- Hono App with Auth Check ---

const app = new Hono();

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
