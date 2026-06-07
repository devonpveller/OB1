/**
 * One-time retroactive thread consolidation (research-inlet plan, P5).
 *
 * The live brain fragmented into ~one thread per deep-research run (38 threads ↔
 * 38 research_synthesis sources, 1:1). This script applies the SAME resolver
 * philosophy as the curator, but over HISTORY: it greedily folds splinter
 * threads into earlier canonical threads of the same line of inquiry.
 *
 * Algorithm (greedy, single pass, deterministic by created_at):
 *   - Process threads oldest-first. The first thread of any subject becomes a
 *     CANONICAL anchor.
 *   - For each later thread, shortlist the canonicals by embedding distance,
 *     then ask the LLM whether it should MERGE into one of them.
 *   - If merge (confidence >= --min-confidence): re-link the splinter's confirmed
 *     sources onto the canonical (link_source_to_thread, additive) and ARCHIVE
 *     the splinter (status='archived' — NEVER deleted). Otherwise it becomes a
 *     new canonical.
 *
 * SAFETY:
 *   - Dry-run by DEFAULT. Pass --apply to write. Operator-run only (G10).
 *   - Additive + reversible: links are upserted (never removed); archive is a
 *     status flip (un-archive to undo). No source or thread row is deleted.
 *   - Idempotent: already-archived threads are skipped; re-linking is a no-op.
 *   - Requires threads.embedding (run backfill-thread-embeddings.ts first).
 *
 * WIKI RECONCILIATION (P5.3): archived threads still own a
 * content/notebooks/<slug>/ hub in the Quartz-4 vault. This script does NOT
 * touch the vault — after applying, the wiki compiler must retire/redirect the
 * archived hubs (coordinate with the compiler; see PLAN §7). The script prints
 * the archived thread ids/names so the operator can verify the recompile.
 *
 *   deno run --allow-net --allow-env consolidate-threads.ts                       # dry-run report
 *   deno run --allow-net --allow-env consolidate-threads.ts --min-confidence 0.7  # tune
 *   deno run --allow-net --allow-env consolidate-threads.ts --apply               # WRITE
 *
 * Env: DB_HOST/PORT/NAME/USER/PASSWORD, EMBEDDING_API_BASE/KEY/MODEL,
 *      CHAT_API_BASE/KEY/MODEL.
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

const CHAT_API_BASE = (Deno.env.get("CHAT_API_BASE") || "http://llama-cpp:8080/v1").replace(/\/+$/, "");
const CHAT_API_KEY = Deno.env.get("CHAT_API_KEY") || "not-needed";
const CHAT_MODEL = Deno.env.get("CHAT_MODEL") || "qwen36-27b:nothink";

const APPLY = Deno.args.includes("--apply");
const SHORTLIST_K = 6;
const minConfArg = Deno.args.indexOf("--min-confidence");
const MIN_CONFIDENCE = minConfArg >= 0 ? parseFloat(Deno.args[minConfArg + 1]) : 0.70;

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

async function chatJson(system: string, user: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${CHAT_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CHAT_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CHAT_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`chat ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return JSON.parse(d?.choices?.[0]?.message?.content ?? "{}");
}

const MERGE_SYS = `You are consolidating a fragmented research knowledge base. Decide whether a thread (line of inquiry) is really the SAME subject as one of a set of existing canonical threads and should be MERGED into it.

Merge ONLY when they are clearly the same subject / line of inquiry (e.g. two queries about the same topic). Do NOT merge merely adjacent or loosely related topics — when in doubt, do NOT merge.

Return ONLY JSON:
{ "merge": true|false, "target_thread_id": "<uuid when merge=true>", "confidence": 0.0-1.0, "reason": "<one sentence>" }`;

interface ThreadRow {
  id: string;
  name: string;
  description: string | null;
  synthesis: string | null;
  embedding: string | null; // pgvector text form
}

const client = await pool.connect();
const archivedReport: Array<{ id: string; name: string; into: string; intoName: string; confidence: number; reason: string }> = [];
let canonicals: ThreadRow[] = [];
let processed = 0, merged = 0, kept = 0, skipped = 0;

try {
  // Active threads oldest-first, each with its most-recent synthesis text.
  const rows = await client.queryObject<ThreadRow>(
    `SELECT t.id, t.name, t.description,
            t.embedding::text AS embedding,
            (SELECT s.content
               FROM thread_sources ts JOIN sources s ON s.id = ts.source_id
              WHERE ts.thread_id = t.id AND ts.status = 'confirmed'
                AND s.content_type = 'research_synthesis'
              ORDER BY s.updated_at DESC LIMIT 1) AS synthesis
       FROM threads t
      WHERE t.status = 'active'
      ORDER BY t.created_at ASC`,
  );
  console.log(`[consolidate] ${rows.rows.length} active thread(s); min_confidence=${MIN_CONFIDENCE} apply=${APPLY}`);

  for (const t of rows.rows) {
    processed++;
    if (!t.embedding) {
      console.warn(`  SKIP "${t.name}" (${t.id}) — no embedding; run backfill-thread-embeddings.ts first`);
      skipped++;
      continue;
    }
    if (canonicals.length === 0) {
      canonicals.push(t);
      kept++;
      continue;
    }

    // Shortlist canonicals by embedding distance to this thread.
    const shortlist = await client.queryObject<{ id: string; name: string; description: string | null; distance: number }>(
      `SELECT id, name, description, (embedding <=> $1::vector) AS distance
         FROM threads
        WHERE id = ANY($2) AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $3`,
      [t.embedding, canonicals.map((c) => c.id), SHORTLIST_K],
    );

    const candBlock = shortlist.rows
      .map((c, i) => `${i + 1}. thread_id=${c.id} | distance=${Number(c.distance).toFixed(3)} | name="${c.name}"\n   description: ${c.description || "(none)"}`)
      .join("\n");
    const user = [
      `THREAD UNDER REVIEW`,
      `name: ${t.name}`,
      `description: ${t.description || "(none)"}`,
      `synthesis: ${(t.synthesis || "").slice(0, 1800)}`,
      ``,
      `CANDIDATE CANONICAL THREADS:`,
      candBlock || "(none)",
    ].join("\n");

    let decision: Record<string, unknown> = {};
    try {
      decision = await chatJson(MERGE_SYS, user);
    } catch (e) {
      console.warn(`  "${t.name}" — decision LLM failed (${(e as Error).message}); keeping as canonical`);
    }
    const wantMerge = decision.merge === true;
    const conf = typeof decision.confidence === "number" ? decision.confidence : 0;
    const target = canonicals.find((c) => c.id === decision.target_thread_id);

    if (wantMerge && target && conf >= MIN_CONFIDENCE) {
      const reason = typeof decision.reason === "string" ? decision.reason : "";
      console.log(`  MERGE "${t.name}" (${t.id})\n        -> "${target.name}" (${target.id})  conf=${conf.toFixed(2)}  ${reason}`);
      archivedReport.push({ id: t.id, name: t.name, into: target.id, intoName: target.name, confidence: conf, reason });
      if (APPLY) {
        await client.queryArray("BEGIN");
        try {
          // Re-link the splinter's confirmed sources onto the canonical (additive).
          await client.queryObject(
            `SELECT link_source_to_thread($1, ts.source_id, 'automatic',
                      'consolidated from thread ' || $2, 'confirmed')
               FROM thread_sources ts
              WHERE ts.thread_id = $3 AND ts.status = 'confirmed'`,
            [target.id, t.id, t.id],
          );
          // Archive the splinter (reversible; never deleted).
          await client.queryObject(`UPDATE threads SET status = 'archived', updated_at = now() WHERE id = $1`, [t.id]);
          await client.queryArray("COMMIT");
        } catch (e) {
          await client.queryArray("ROLLBACK").catch(() => {});
          console.error(`  FAILED to merge "${t.name}": ${(e as Error).message}`);
        }
      }
      merged++;
    } else {
      canonicals.push(t);
      kept++;
    }
  }
} finally {
  client.release();
  await pool.end();
}

console.log(`\n[consolidate] processed=${processed} merged=${merged} kept(canonical)=${kept} skipped=${skipped}${APPLY ? "" : "  (DRY-RUN — pass --apply to write)"}`);
if (archivedReport.length) {
  console.log(`\n[consolidate] ${APPLY ? "ARCHIVED" : "WOULD ARCHIVE"} ${archivedReport.length} splinter thread(s):`);
  for (const a of archivedReport) {
    console.log(`  - "${a.name}" (${a.id}) -> "${a.intoName}" (${a.into})  conf=${a.confidence.toFixed(2)}`);
  }
  console.log(`\n  P5.3 WIKI: recompile the wiki and retire/redirect these threads'`);
  console.log(`  content/notebooks/<slug>/ hubs (the compiler must handle archived threads).`);
}
