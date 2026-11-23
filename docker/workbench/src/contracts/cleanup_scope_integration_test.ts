// deno test src/contracts/cleanup_scope_integration_test.ts - rwr-cleanup-counts-scoped: GET
// /workbench/contract/cleanup/sources answers the CALLER's own dependence on a shared source and nothing of
// another user's. Over a REAL workbench and database, as TWO users.
//
//   S1  user B plants private work that depends on a shared suppressed source - a document linking it
//       (document_link), a reference held by a document of B's (reference_record), a research session of B's
//       (report_session) and a report of B's session that cites it (report_citation). A's whole listing is
//       BYTE-IDENTICAL with and without those rows (counts, blocking, severable, total, erase_allowed).
//   S2  the planted rows are real: the database's own source_dependence() counts them (so S1 is not vacuous)
//   S3  A's own dependence is still reported (her document's link is counted), and B reads his own, not hers
//
// SKIPPED unless DOCS_TEST_BASE and CONTRACT_TEST_DB_HOST are set. contract-test/run-cleanup-scope-tests.ps1 runs
// it in a disposable lab. Never point it at a live stack: it writes rows.
// Environment: DOCS_TEST_BASE, DOCS_TEST_KEY, DOCS_TEST_SUB_HEADER (default X-Test-Sub),
// CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser: plants rows the doors would write).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("DOCS_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("DOCS_TEST_KEY") ?? "";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const SUB_HEADER = Deno.env.get("DOCS_TEST_SUB_HEADER") ?? "X-Test-Sub";
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 3, true)
  : null;

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}
const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const A = `scope-a-${rnd()}`;
const B = `scope-b-${rnd()}`;
async function call(who: string, method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json", "x-brain-key": KEY, [SUB_HEADER]: who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  return { status: r.status, json, text };
}
const C = "/workbench/contract";
const LIST = `${C}/cleanup/sources?limit=500`;

Deno.test({ name: "S1-S3: another user's private dependence on a shared source changes nothing in the caller's cleanup listing", ignore, sanitizeOps: false, sanitizeResources: false, fn: async () => {
  // a shared source of this test's own: a chunk and a claim edge, then suppressed
  const S = crypto.randomUUID();
  await sql(`INSERT INTO public.sources (id, url, title, content) VALUES ($1, $2, $3, 'scope text')`,
    [S, `https://example.org/cleanup-scope/${S}`, `scope source ${S.slice(0, 8)}`]);
  await sql(`INSERT INTO public.source_chunks (source_id, idx, content) VALUES ($1, 0, 'a chunk')`, [S]);
  const claim = crypto.randomUUID();
  await sql(`INSERT INTO public.claims (id, text) VALUES ($1, $2)`, [claim, `claim on ${S}`]);
  await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $2, 'states')`, [claim, S]);
  assertEquals((await call(A, "POST", `${C}/sources/${S}/suppress`, { reason: "scope test" })).status, 200);

  // A's own private work: a document that links S
  const docA = await call(A, "POST", "/workbench/documents", { title: `scope A ${rnd()}`, body: `See [[source:${S}|it]].` });
  assertEquals(docA.status, 201, docA.text);

  const before = await call(A, "GET", LIST);
  assertEquals(before.status, 200, before.text);
  const rowBefore = before.json.sources.find((x: any) => x.id === S);
  // S3: A's own link is counted
  assertEquals([rowBefore.counts.document_link, rowBefore.counts.chunk, rowBefore.counts.claim_edge], [1, 1, 1], "A's own document link is reported");
  assertEquals(rowBefore.blocking, 3);

  // B's private work, all depending on the same shared source
  const docB = await call(B, "POST", "/workbench/documents", { title: `scope B ${rnd()}`, body: `Mine, [[source:${S}|it]].` });
  assertEquals(docB.status, 201, docB.text);
  const bPath: string = docB.json.path ?? docB.json.document?.path;
  assert(bPath?.startsWith("documents/"), `B's document path: ${docB.text}`);
  // a reference held by B's document (a legacy_note holder counts as dependence; the path is B's)
  const ref = crypto.randomUUID();
  await sql(`INSERT INTO public.reference_records (id, source_id, selectors, provenance, pinned_revision)
             VALUES ($1, $2, $3::jsonb, 'user', 1)`,
    [ref, S, JSON.stringify({ quote: { exact: "scope", prefix: "", suffix: " text" }, position: { start: 0, end: 5 } })]);
  await sql(`INSERT INTO public.reference_holders (holder_kind, holder_ref, reference_id, cited_ref, origin, seq, number)
             VALUES ('legacy_note', $1, $2, $3, 'cited', 0, 1)`, [bPath, ref, S]);
  // a research session of B's (a job B owns) that holds S, and B's report (a synthesis of that session) citing S
  const sess = crypto.randomUUID(), job = crypto.randomUUID(), syn = crypto.randomUUID();
  await sql(`INSERT INTO public.sessions (id, origin_tool, query_text) VALUES ($1, 'manual', $2)`, [sess, `B private question ${rnd()}`]);
  await sql(`INSERT INTO public.research_jobs (id, status, origin, query, caller, session_id, created_at)
             VALUES ($1, 'done', 'workspace', 'B private question', 'workspace', $2, now())`, [job, sess]);
  await sql(`INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, $2, $2, 'B private question')`, [job, B]);
  await sql(`INSERT INTO public.session_sources (session_id, source_id) VALUES ($1, $2)`, [sess, S]);
  await sql(`INSERT INTO public.sources (id, title, content, content_type, metadata)
             VALUES ($1, 'B private report', 'report text', 'research_synthesis', $2::jsonb)`, [syn, JSON.stringify({ source_ids: [S] })]);
  await sql(`INSERT INTO public.session_sources (session_id, source_id) VALUES ($1, $2)`, [sess, syn]);

  // S2: the database really counts them
  const raw = Object.fromEntries((await sql<{ kind: string; n: number }>(
    `SELECT kind, count(*)::int AS n FROM public.source_dependence($1) GROUP BY kind`, [S])).map((r) => [r.kind, r.n]));
  assertEquals([raw.document_link, raw.reference_record, raw.report_session, raw.report_citation], [2, 1, 1, 1],
    `the planted rows are real dependence: ${JSON.stringify(raw)}`);

  // S1: A's answer is byte-identical
  const after = await call(A, "GET", LIST);
  assertEquals(after.status, 200, after.text);
  assertEquals(after.text, before.text, "B's private document link / reference / report change nothing in A's listing");

  // S3: B reads his own work (and not A's document)
  const rowB = (await call(B, "GET", LIST)).json.sources.find((x: any) => x.id === S);
  assertEquals([rowB.counts.document_link, rowB.counts.reference_record, rowB.counts.report_session, rowB.counts.report_citation], [1, 1, 1, 1],
    "B's own dependence is reported to B, and A's document link is not");
} });

Deno.test({ name: "close the pool", ignore, fn: async () => { await pool!.end(); }, sanitizeOps: false, sanitizeResources: false });
