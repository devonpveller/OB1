/**
 * P2.5 integration test — exercises the REAL writeClaims path against the REAL
 * init-claims.sql schema. Proves grounded ingestion writes claims+edges and
 * that the poisoning case (an ungrounded fabricated claim) is never stored.
 *
 * Run (DB on docker network `obtest`):
 *   deno run --allow-net --allow-env claims.integration.ts
 * Exits non-zero on any assertion failure.
 */
import { Pool } from "postgres";
import { writeClaims } from "./claims.ts";

const pool = new Pool({
  hostname: Deno.env.get("DB_HOST") || "ob-claims-test",
  port: 5432,
  database: "openbrain",
  user: "postgres",
  password: Deno.env.get("DB_PASSWORD") || "test",
}, 4);

function assert(cond: unknown, msg: string) {
  if (!cond) { console.error("FAIL:", msg); Deno.exit(1); }
  console.log("ok:", msg);
}

const client = await pool.connect();
try {
  // ── Fixtures: a thread, a synthesis row, and two real sources (one .gov). ──
  const t = await client.queryObject<{ id: string }>(
    `INSERT INTO threads (name, description, status) VALUES ('Recycling','x','active') RETURNING id`);
  const threadId = t.rows[0].id;
  const syn = await client.queryObject<{ id: string }>(
    `INSERT INTO sources (title, content, content_type)
     VALUES ('syn','full synthesis text','research_synthesis') RETURNING id`);
  const synthesisId = syn.rows[0].id;
  const s1 = await client.queryObject<{ id: string }>(
    `INSERT INTO sources (url,title,content,content_type,domain)
     VALUES ('https://oakridgetn.gov/recycle','gov','c','web_article','oakridgetn.gov') RETURNING id`);
  const s2 = await client.queryObject<{ id: string }>(
    `INSERT INTO sources (url,title,content,content_type,domain)
     VALUES ('https://blog.example.com/x','blog','c','web_article','example.com') RETURNING id`);
  // Index-aligned source_ids exactly as /research/persist returns them.
  const sourceIds = [s1.rows[0].id, s2.rows[0].id];

  // ── A realistic tagged synthesis, including the poisoning line. ──
  const synthesis = [
    "## Curbside recycling",
    "- [SOURCED] Curbside recycling uses a brown cart. [Source 1]",
    "- [INFERRED] Glass is taken to the Convenience Center, not curbside. [Source 1, 2]",
    "- [SOURCED] The recycling hotline is 865-482-3656. [Source 1]",
    "- [SOURCED] Call 1-800-438-8657 for pickup.",   // ← fabricated, NO citation (parser-gate drop)
    "- [SOURCED] Pickup is on Mondays. [Source 9]",   // ← cites a non-existent source (writer-gate drop)
    "- [GAP] The holiday collection schedule is unknown.",
  ].join("\n");

  const res = await writeClaims(client, synthesis, {
    threadId, synthesisId, sourceIds, volatility: "slow", revalidateDays: 1095,
  });
  console.log("writeClaims result:", JSON.stringify(res));

  // 3 grounded claims; the 1-800 line is dropped by the PARSER (zero citations,
  // never reaches the writer); the [Source 9] line is dropped by the WRITER
  // (citation resolves to no real source) — two layers of the rule-#1 gate.
  assert(res.claimsWritten === 3, `3 grounded claims written (got ${res.claimsWritten})`);
  assert(res.ungroundedSkipped === 1, `1 writer-gate skip (the [Source 9] line) (got ${res.ungroundedSkipped})`);
  assert(res.edgesSkipped === 1, `1 unresolvable citation skipped (got ${res.edgesSkipped})`);
  assert(res.gaps.length === 1, `1 gap recorded (got ${res.gaps.length})`);
  assert(res.edgesWritten === 4, `4 edges written: states+inferredx2+states (got ${res.edgesWritten})`);

  // Neither ungrounded line may exist as a claim anywhere.
  const poison = await client.queryObject<{ n: bigint }>(
    `SELECT count(*) AS n FROM claims WHERE thread_id=$1 AND (text ILIKE '%1-800-438-8657%' OR text ILIKE '%Pickup is on Mondays%')`,
    [threadId]);
  assert(Number(poison.rows[0].n) === 0, "neither the fabricated 1-800 nor the phantom-source claim is stored");

  // The sourced number IS stored, grounded, and reusable.
  const good = await client.queryObject<{ n: bigint }>(
    `SELECT count(*) AS n FROM reusable_claims WHERE thread_id=$1 AND text ILIKE '%865-482-3656%'`, [threadId]);
  assert(Number(good.rows[0].n) === 1, "sourced 865 number IS a reusable grounded claim");

  // The .gov-stated claim outranks the blog-inferred one.
  const conf = await client.queryObject<{ text: string; confidence: number }>(
    `SELECT text, confidence FROM claims WHERE thread_id=$1 ORDER BY confidence DESC`, [threadId]);
  console.log("confidences:", conf.rows.map((r) => `${r.confidence.toFixed(2)} ${r.text.slice(0, 30)}`));
  assert(conf.rows[0].text.includes("brown cart"), "top claim is the .gov-stated fact");
  assert(conf.rows[0].confidence >= 0.85, "fact confidence >= 0.85");

  // ungrounded_claims view stays empty — the gate kept everything grounded.
  const ung = await client.queryObject<{ n: bigint }>(`SELECT count(*) AS n FROM ungrounded_claims WHERE thread_id=$1`, [threadId]);
  assert(Number(ung.rows[0].n) === 0, "ungrounded_claims view is empty (nothing ungrounded stored)");

  // Idempotency: re-running folds into the same claims (no duplicates).
  const res2 = await writeClaims(client, synthesis, {
    threadId, synthesisId, sourceIds, volatility: "slow", revalidateDays: 1095,
  });
  assert(res2.claimsWritten === 0 && res2.claimsDeduped === 3, "re-run dedupes (0 new, 3 deduped)");
  const total = await client.queryObject<{ n: bigint }>(`SELECT count(*) AS n FROM claims WHERE thread_id=$1`, [threadId]);
  assert(Number(total.rows[0].n) === 3, "still only 3 claims after re-run (idempotent)");

  console.log("\nALL P2.5 ASSERTIONS PASSED");
} finally {
  client.release();
  await pool.end();
}
