/**
 * Orchestrator integration test — runs the REAL runResearch() against the REAL
 * schema (throwaway DB on network `obtest`) with MOCKED LLM/search/fetch seams.
 * Proves the reuse loop, gap analysis, gap-only staging, cited-only sourcing,
 * grounding-honest synthesis, and curator delegation — without a live stack.
 *
 * Run: deno run --allow-net --allow-env orchestrator.test.ts
 */
import { Pool } from "postgres";
import { runResearch, type Deps, type SearchHit, type Page } from "./harness.ts";

const pool = new Pool({
  hostname: Deno.env.get("DB_HOST") || "ob-claims-test", port: 5432,
  database: "openbrain", user: "postgres", password: Deno.env.get("DB_PASSWORD") || "test",
}, 4);

function assert(c: unknown, m: string) { if (!c) { console.error("FAIL:", m); Deno.exit(1); } console.log("ok:", m); }

// Deterministic 1024-dim embedding (content only needs to be non-null + orderable).
function fakeEmbed(text: string): number[] {
  const v = new Array(1024).fill(0);
  let h = 0; for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 1024;
  v[h] = 1; v[(h + 7) % 1024] = 0.5;
  return v;
}

let curatorPkg: Record<string, unknown> | null = null;
const deps: Deps = {
  embed: (t) => Promise.resolve(fakeEmbed(t)),
  chat: (sys) => {
    if (sys.includes("research planner")) return Promise.resolve(JSON.stringify({ needs: ["Are cats mammals?", "Do cats purr?"] }));
    if (sys.includes("already covered by KNOWN CLAIMS")) return Promise.resolve(JSON.stringify({ covered: [0], gaps: [1] }));
    if (sys.includes("GATHERED SOURCES")) return Promise.resolve(JSON.stringify({ covered: [0], open: [] })); // gap covered → stop deepening
    if (sys.includes("research strategist")) return Promise.resolve(JSON.stringify({ queries: [] }));
    if (sys.includes("grounded synthesizer")) {
      return Promise.resolve("## Cats\n[SOURCED] Cats purr when content. [Source 1]\n[INFERRED] Purring may self-soothe. [Source 1]\nReused fact: cats are mammals.");
    }
    return Promise.resolve("{}");
  },
  searchWeb: (_q: string, _k: number): Promise<SearchHit[]> =>
    Promise.resolve([
      { url: "https://vet.example.org/purr", title: "Why cats purr", snippet: "purring" },
      { url: "https://blog.example.com/cats", title: "Cat blog", snippet: "cats" },
    ]),
  fetchPage: (url: string): Promise<Page | null> =>
    Promise.resolve({ url, title: "Why cats purr", content: "Cats purr at ~25Hz when content and to self-soothe.", domain: "vet.example.org" }),
  delegateToCurator: (pkg) => { curatorPkg = pkg; return Promise.resolve({ thread_id: pkg.thread_id, persist: { sources_written: (pkg.sources as unknown[]).length }, claims: { claimsWritten: 2 } }); },
};

const client = await pool.connect();
try {
  // ── Seed: a thread + a grounded, fresh, reusable claim "cats are mammals". ──
  const t = await client.queryObject<{ id: string }>(`INSERT INTO threads (name,description,status) VALUES ('Cats','x','active') RETURNING id`);
  const threadId = t.rows[0].id;
  const syn = await client.queryObject<{ id: string }>(`INSERT INTO sources (title,content,content_type) VALUES ('syn','s','research_synthesis') RETURNING id`);
  const s1 = await client.queryObject<{ id: string }>(`INSERT INTO sources (url,title,content,content_type,domain) VALUES ('https://animals.gov/cats','gov','c','web_article','animals.gov') RETURNING id`);
  const emb = `[${fakeEmbed("cats are mammals").join(",")}]`;
  const c1 = await client.queryObject<{ id: string }>(
    `SELECT id FROM find_or_create_claim('Cats are mammals.', $1, $2, 'sourced','slow',1095, $3::vector, '{}'::jsonb)`,
    [threadId, syn.rows[0].id, emb]);
  await client.queryObject(`SELECT link_claim_to_source($1,$2,'states',1.0)`, [c1.rows[0].id, s1.rows[0].id]);

  // ── Run the harness. ──
  const res = await runResearch(deps, client, "Tell me about cats", { threadId, origin: "owui" });
  console.log("metrics:", JSON.stringify(res.metrics), "backstop:", res.backstop);

  assert(res.needs.length === 2, "decomposed into 2 needs");
  assert(res.reuseClaims.some((c) => c.text.includes("mammals")), "reused the grounded 'cats are mammals' claim");
  assert(res.citedSources.length === 1, `cited exactly the 1 source the synthesis used (got ${res.citedSources.length})`);
  assert(res.citedSources[0].url === "https://vet.example.org/purr", "cited source is the purr page ([Source 1])");
  assert(res.metrics.claims_reused === 1, "metric: 1 claim reused");
  assert(res.metrics.claims_freshly_gathered === 1, "metric: 1 freshly gathered (cited)");

  // ── Curator got the VERBATIM synthesis + cited-only sources. ──
  assert(curatorPkg !== null, "curator was called");
  assert((curatorPkg!.synthesis as string).includes("[Source 1]"), "curator package carries the verbatim synthesis");
  assert((curatorPkg!.sources as unknown[]).length === 1, "curator package sources are cited-only (1, not 2 found)");
  assert((curatorPkg!.thread_id as string) === threadId, "curator package carries the thread scope");

  // ── Staging really happened (P3): the gap page is in the session pool. ──
  const staged = await client.queryObject<{ n: bigint }>(
    `SELECT count(*) AS n FROM sources WHERE url='https://vet.example.org/purr'`);
  assert(Number(staged.rows[0].n) === 1, "gap source was staged into OB (deduped find_or_create_source)");

  console.log("\nALL ORCHESTRATOR ASSERTIONS PASSED");
} finally {
  client.release();
  await pool.end();
}
