/**
 * One-time backfill: embed every existing thread so the curator's Stage-1
 * shortlist works on day one (research-inlet plan, P0.2).
 *
 * Computes threads.embedding = embed(name + '\n' + description) — the same basis
 * the curator maintains on every ingest (PLAN §3.5), so backfilled and
 * live-maintained embeddings are consistent.
 *
 * Idempotent: skips threads that already have an embedding unless --force.
 * Dry-run by default; pass --apply to write. Operator-run (G10).
 *
 *   deno run --allow-net --allow-env backfill-thread-embeddings.ts            # dry-run
 *   deno run --allow-net --allow-env backfill-thread-embeddings.ts --apply
 *   deno run --allow-net --allow-env backfill-thread-embeddings.ts --apply --force
 *
 * Env: DB_HOST/PORT/NAME/USER/PASSWORD, EMBEDDING_API_BASE/KEY/MODEL.
 */
import { Pool } from "postgres";

const DB_HOST = Deno.env.get("DB_HOST") || "openbrain-db";
const DB_PORT = parseInt(Deno.env.get("DB_PORT") || "5432", 10);
const DB_NAME = Deno.env.get("DB_NAME") || "openbrain";
const DB_USER = Deno.env.get("DB_USER") || "postgres";
const DB_PASSWORD = Deno.env.get("DB_PASSWORD") || "";

const EMBEDDING_API_BASE = (Deno.env.get("EMBEDDING_API_BASE") || "http://llama-cpp-embed:8080/v1").replace(/\/+$/, "");
const EMBEDDING_API_KEY = Deno.env.get("EMBEDDING_API_KEY") || "not-needed";
const EMBEDDING_MODEL = Deno.env.get("EMBEDDING_MODEL") || "bge-m3";

const APPLY = Deno.args.includes("--apply");
const FORCE = Deno.args.includes("--force");

const pool = new Pool({ hostname: DB_HOST, port: DB_PORT, database: DB_NAME, user: DB_USER, password: DB_PASSWORD }, 4);

async function embed(text: string): Promise<number[]> {
  let input = String(text || "").slice(0, 4000);
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${EMBEDDING_API_BASE}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${EMBEDDING_API_KEY}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
    });
    if (r.ok) {
      const v = (await r.json())?.data?.[0]?.embedding;
      if (!Array.isArray(v)) throw new Error("no vector");
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

const client = await pool.connect();
let done = 0, skipped = 0, failed = 0;
try {
  const where = FORCE ? "" : "WHERE embedding IS NULL";
  const rows = await client.queryObject<{ id: string; name: string; description: string | null }>(
    `SELECT id, name, description FROM threads ${where} ORDER BY created_at`,
  );
  console.log(`[backfill] ${rows.rows.length} thread(s) to process (apply=${APPLY}, force=${FORCE})`);
  for (const t of rows.rows) {
    const text = `${t.name}\n${t.description || ""}`;
    try {
      if (!APPLY) {
        console.log(`  [dry-run] would embed thread ${t.id} "${t.name}"`);
        done++;
        continue;
      }
      const emb = `[${(await embed(text)).join(",")}]`;
      await client.queryObject(`UPDATE threads SET embedding = $2::vector WHERE id = $1`, [t.id, emb]);
      console.log(`  embedded ${t.id} "${t.name}"`);
      done++;
    } catch (e) {
      console.error(`  FAILED ${t.id} "${t.name}":`, (e as Error).message);
      failed++;
    }
  }
} finally {
  client.release();
  await pool.end();
}
console.log(`[backfill] done=${done} skipped=${skipped} failed=${failed}${APPLY ? "" : " (DRY-RUN — pass --apply to write)"}`);
