// One-off backfill: render readable prose for EXISTING research_synthesis rows
// that predate the prose pass (they have only the tagged grounded claims in
// `content`). Uses the SAME PROSE_SYS prompt as harness.ts so backfilled prose
// matches forward output. Idempotent: skips rows that already have prose.
//
// Run inside openbrain-curator (has DB + LLM env + the `postgres` import cached):
//   docker cp backfill-prose.ts openbrain-curator:/app/backfill-prose.ts
//   docker exec -w /app openbrain-curator deno run -A backfill-prose.ts
//
// Notes for backfilled rows: research_query (the original question) is already
// stored and renders. Sub-questions / follow-up queries / [Source N] click-links
// were never persisted for old runs, so they stay absent (prose still readable,
// citations render as plain "[Source N]" text).
import { Pool } from "postgres";

const DB_HOST = Deno.env.get("DB_HOST") || "openbrain-db";
const DB_PORT = parseInt(Deno.env.get("DB_PORT") || "5432", 10);
const DB_NAME = Deno.env.get("DB_NAME") || "openbrain";
const DB_USER = Deno.env.get("DB_USER") || "postgres";
const DB_PASSWORD = Deno.env.get("DB_PASSWORD") || "";
const CHAT_BASE = (Deno.env.get("CHAT_API_BASE") || "http://llama-cpp:8080/v1").replace(/\/+$/, "");
const CHAT_KEY = Deno.env.get("CHAT_API_KEY") || "not-needed";
const CHAT_MODEL = Deno.env.get("CHAT_MODEL") || "qwen36-27b:nothink";

const PROSE_SYS =
  `You are Open Brain's research writer. You are given a QUESTION and a GROUNDED ANSWER — a list of verified assertions, each tagged [SOURCED]/[INFERRED]/[UNCERTAIN] and ending with its citation [Source N], plus [GAP] lines for points no source covered.

Rewrite it into a clear, readable Markdown synthesis that answers the QUESTION for a human reader.

RULES:
- Open with a direct answer, then supporting detail. Use ## section headers and short paragraphs or bullet lists where natural.
- PRESERVE every citation: keep each fact's [Source N] marker inline, using the SAME numbers (e.g. "The official repo is github.com/anthropics/skills [Source 1]."). Never renumber or drop a citation.
- Introduce NO fact, number, name, URL, or quote that is not in the grounded answer. If it is not supported there, do not write it.
- Drop the [SOURCED]/[INFERRED]/[UNCERTAIN] tags themselves — convey that nuance in prose ("directly reports…", "this suggests…") but keep the [Source N] citations.
- End with a short "## Gaps" section listing the [GAP] items as open questions (no citations). Omit the section entirely if there are no gaps.
- Be faithful and complete — cover every claim — but readable. Do not add a preamble like "Here is the synthesis"; start with the answer.`;

async function chat(system: string, user: string): Promise<string> {
  const r = await fetch(`${CHAT_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CHAT_KEY}` },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.3,
    }),
  });
  if (!r.ok) throw new Error(`chat ${r.status}`);
  const j = await r.json();
  return j?.choices?.[0]?.message?.content || "";
}

const pool = new Pool(
  { hostname: DB_HOST, port: DB_PORT, database: DB_NAME, user: DB_USER, password: DB_PASSWORD },
  2,
);
const LIMIT = parseInt(Deno.env.get("BACKFILL_LIMIT") || "0", 10); // 0 = all
const c = await pool.connect();
try {
  const { rows } = await c.queryObject<{ id: string; content: string; research_query: string | null }>(
    `SELECT id, content, research_query FROM sources
      WHERE content_type='research_synthesis'
        AND COALESCE(metadata->>'prose_synthesis','')=''
        AND COALESCE(content,'')<>''
      ORDER BY researched_on DESC NULLS LAST` + (LIMIT > 0 ? ` LIMIT ${LIMIT}` : ""),
  );
  console.log(`[backfill] ${rows.length} synthesis row(s) need prose`);
  let done = 0;
  for (const row of rows) {
    try {
      const q = (row.research_query || "(question not recorded)").trim();
      const prose = (await chat(PROSE_SYS, `QUESTION: ${q}\n\nGROUNDED ANSWER:\n${row.content}`)).trim();
      if (!prose) { console.log(`  - skip ${row.id} (empty prose)`); continue; }
      await c.queryObject(
        `UPDATE sources SET metadata = COALESCE(metadata,'{}'::jsonb) || $2::jsonb WHERE id=$1`,
        [row.id, JSON.stringify({ prose_synthesis: prose })],
      );
      done++;
      console.log(`  ✓ ${row.id} — "${q.slice(0, 60)}" (${prose.length} chars)`);
    } catch (e) {
      console.log(`  ✗ ${row.id}: ${(e as Error).message}`);
    }
  }
  console.log(`[backfill] done: ${done}/${rows.length} rows now have prose`);
} finally {
  c.release();
  await pool.end();
}
