// deno test src/contracts/research_runs_integration_test.ts - rwr-research-runs over a REAL workbench and database: the runs
// list / detail / archive / unarchive / report-as-document (slot 640) as THREE users and a service key, with planted markers.
// SKIPPED unless RUNS_TEST_BASE and CONTRACT_TEST_DB_HOST are set; contract-test/run-research-runs-tests.ps1 runs it in its
// disposable lab (the real initdb chain incl. 420, 480 and 640; the workbench logs in as ob_workbench, as compose does).
// Never point it at a live stack: it plants jobs, prompts, hand-backs and claims.
// Environment: RUNS_TEST_BASE, RUNS_TEST_KEY (the door key), RUNS_TEST_SERVICE_KEY, RUNS_TEST_SUB_HEADER (default X-Test-Sub),
// RUNS_TEST_VAULT (the workbench's vault dir, readable here), CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser).
// R1.. name the acceptance statements (test-plans/rwr-research-runs.md).
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("RUNS_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("RUNS_TEST_KEY") ?? "";
const SVC = Deno.env.get("RUNS_TEST_SERVICE_KEY") ?? "";
const SUB_HEADER = Deno.env.get("RUNS_TEST_SUB_HEADER") ?? "X-Test-Sub";
const VAULT = Deno.env.get("RUNS_TEST_VAULT") ?? "";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 3, true)
  : null;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}
const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const hex64 = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
const A = `run-ann-${rnd()}`;
const B = `run-bob-${rnd()}`;
const C = `run-cy-${rnd()}`; // owns nothing
const M_PROMPT = `ALPHA-PROMPT-${rnd()}`; // A's private prompt (research_prompts); also the root job's query
const M_REPORT = `ALPHA-REPORT-${rnd()}`; // text of A's report
const M_PRIV_CLAIM = `ALPHA-PRIVATE-CLAIM-${rnd()}`; // a claim drawn from A's private report (owner store only)
const M_STEER = `ALPHA-STEER-${rnd()}`;
const M_B = `BRAVO-PROMPT-${rnd()}`;
const M_DOC = `ALPHA-DOCPATH-${rnd()}`;
const JA1 = crypto.randomUUID(); // A: prompt-owned root, done, with a steer branch
const JA1S = crypto.randomUUID();
const JA2 = crypto.randomUUID(); // A: a derived (started) run through the request boundary, from a document, running
const JB1 = crypto.randomUUID(); // B: prompt-owned root, done
const SHARED_CLAIM = crypto.randomUUID();
const PRIV_CLAIM = crypto.randomUUID();
const P = "/workbench/contract/research/runs";

async function call(who: string | null, method: string, path: string, body?: unknown, key = KEY) {
  const headers: Record<string, string> = { "x-brain-key": key };
  if (who) headers[SUB_HEADER] = who;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

async function plant() {
  await sql(`INSERT INTO public.claims (id, text) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [SHARED_CLAIM, "A shared claim the run reused."]);
  // a claim drawn from A's private report lives in A's owner store only (slot 570 moved such claims: copy to inlet_private_claims,
  // delete from claims); it has no row in claims. The row is planted the way slot 570 moved them, so its shape is the real one.
  await sql(`INSERT INTO public.claims (id, text) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [PRIV_CLAIM, M_PRIV_CLAIM]);
  const haveStore = (await sql(`SELECT to_regclass('public.inlet_private_claims') IS NOT NULL AS ok`))[0].ok;
  if (haveStore) {
    await sql(`INSERT INTO public.inlet_private_claims SELECT * FROM public.claims WHERE id = $1 ON CONFLICT DO NOTHING`, [PRIV_CLAIM]);
    await sql(`DELETE FROM public.claims WHERE id = $1`, [PRIV_CLAIM]);
  } else {
    await sql(`DELETE FROM public.claims WHERE id = $1`, [PRIV_CLAIM]); // a chain without slot 570: the claim exists nowhere shared either
  }
  const result = {
    prose: `# Report\n${M_REPORT}`, synthesis: "short", cited_sources: [{ title: "A cited page", url: "https://example.org/a-cited-page" }],
    reuse_claims: [{ id: SHARED_CLAIM, text: "stale text" }, { id: PRIV_CLAIM, text: M_PRIV_CLAIM }],
  };
  await sql(`INSERT INTO public.research_jobs (id, status, origin, query, progress, result, caller, started_at, finished_at)
             VALUES ($1, 'done', 'owui', $2, '{"phase":"done"}', $3, 'owui-tool', now() - interval '2 hours', now() - interval '1 hour')`, [JA1, M_PROMPT, JSON.stringify(result)]);
  await sql(`INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, $2, $2, $3)`, [JA1, A, M_PROMPT]);
  await sql(`INSERT INTO public.research_jobs (id, status, origin, query, progress, result, caller, parent_job_id, root_job_id, branch_kind, started_at, finished_at)
             VALUES ($1, 'done', 'owui', $2, '{"phase":"done"}', $3, 'owui-tool', $4, $4, 'steer', now() - interval '50 minutes', now() - interval '40 minutes')`,
    [JA1S, M_STEER, JSON.stringify({ synthesis: "branch text", cited_sources: [{ title: "Branch page", url: "https://example.org/branch" }], reuse_claims: [] }), JA1]);
  await sql(`INSERT INTO public.research_jobs (id, status, origin, query, progress, result, caller, started_at, finished_at)
             VALUES ($1, 'done', 'owui', $2, '{"phase":"done"}', '{"synthesis":"bravo report"}', 'owui-tool', now(), now())`, [JB1, M_B]);
  await sql(`INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, $2, $2, $3)`, [JB1, B, M_B]);
  // a started (derived) run: no prompt row; the hand-back is the record of whose it is
  const q = "A public question formed by the boundary?";
  await sql(`INSERT INTO public.research_jobs (id, status, origin, query, anchor, caller, request_kind, boundary, progress, started_at)
             VALUES ($1, 'running', 'owui', $2, $2, 'boundary', 'derived', $3, '{"phase":"searching"}', now() - interval '5 minutes')`,
    [JA2, q, JSON.stringify({ version: "b1", lexicon: hex64(), verdict_id: hex64(), topic: "sensors" })]);
  await sql(`INSERT INTO public.research_handbacks (owner_sub, inlet_kind, inlet_id, purpose, job_id, state)
             VALUES ($1, 'document', $2, 'user-start', $3, 'queued')`, [A, `documents/${A}/${M_DOC}.md#s1`, JA2]);
}

const flat = (r: { text: string }) => r.text;
const leaks = (r: { text: string }, ...markers: string[]) => markers.filter((m) => r.text.includes(m));

t("R0 plant", async () => { await plant(); });

t("R1 list: each person lists only their own runs; counts and totals are theirs; no marker of another person anywhere", async () => {
  const a = await call(A, "GET", `${P}?view=all`);
  assertEquals(a.status, 200);
  assertEquals(a.json.runs.map((r: any) => r.id).sort(), [JA1, JA2].sort());
  assertEquals(a.json.counts, { running: 1, queued: 0, done: 1, stopped: 0, archived: 0, total: 2 });
  const a1 = a.json.runs.find((r: any) => r.id === JA1);
  assertEquals([a1.question, a1.group, a1.branches], [M_PROMPT, "done", 1]);
  const a2 = a.json.runs.find((r: any) => r.id === JA2);
  assertEquals([a2.group, a2.topic, a2.document], ["running", "sensors", `documents/${A}/${M_DOC}.md`], "a started run: topic and the caller's own document");
  const b = await call(B, "GET", `${P}?view=all`);
  assertEquals(b.json.runs.map((r: any) => r.id), [JB1]);
  assertEquals(b.json.counts, { running: 0, queued: 0, done: 1, stopped: 0, archived: 0, total: 1 });
  assertEquals(leaks(b, M_PROMPT, M_REPORT, M_STEER, M_PRIV_CLAIM, M_DOC, JA1, JA2, "sensors", A), [], "nothing of A's, in any field, count or total");
  const c = await call(C, "GET", `${P}?view=all`);
  assertEquals(c.json, { runs: [], counts: { running: 0, queued: 0, done: 0, stopped: 0, archived: 0, total: 0 } });
  assertEquals(leaks(a, M_B, JB1, B), []);
});

t("R2 detail: the owner reads the tree and the node details; another person (or a missing id) gets one identical 404", async () => {
  const d = await call(A, "GET", `${P}/${JA1}`);
  assertEquals(d.status, 200);
  assertEquals(d.json.nodes.map((n: any) => n.id).sort(), [JA1, JA1S].sort());
  const root = d.json.nodes.find((n: any) => n.id === JA1);
  assertEquals(root.sources.map((s: any) => s.url), ["https://example.org/a-cited-page"]);
  assertEquals(root.claims, [{ id: SHARED_CLAIM, text: "A shared claim the run reused." }], "the claim's text is the shared table's, not the job's copy");
  assert(root.has_report);
  assertEquals(leaks(d, M_PRIV_CLAIM, "stale text"), [], "a claim drawn from a private report is never shown, counted or offered");
  const missing = await call(B, "GET", `${P}/${crypto.randomUUID()}`);
  const foreign = await call(B, "GET", `${P}/${JA1}`);
  assertEquals([foreign.status, foreign.text], [404, missing.text]);
  assertEquals(missing.status, 404);
  assertEquals(leaks(foreign, M_PROMPT, M_REPORT, M_STEER, M_PRIV_CLAIM), []);
  assertEquals((await call(C, "GET", `${P}/${JA2}`)).status, 404);
});

t("R3 the claim count never includes a private-report claim, for the owner or anyone", async () => {
  const d = await call(A, "GET", `${P}/${JA1}`);
  const all = d.json.nodes.flatMap((n: any) => n.claims);
  assertEquals(all.length, 1);
  const other = await call(B, "GET", `${P}/${JA1}`);
  assertEquals(other.status, 404);
});

t("R4 archive hides the run from the caller's list only; sources, claims and jobs are untouched; B cannot archive A's run", async () => {
  const snap = async () => JSON.stringify([
    await sql(`SELECT id::text, text FROM public.claims ORDER BY id`), await sql(`SELECT count(*)::int AS n FROM public.sources`),
    await sql(`SELECT id::text, status, query, result FROM public.research_jobs ORDER BY id`), await sql(`SELECT * FROM public.research_prompts ORDER BY job_id`),
  ]);
  const before = await snap();
  const bBefore = (await call(B, "GET", `${P}?view=all`)).text;
  const denied = await call(B, "POST", `${P}/${JA1}/archive`);
  assertEquals(denied.status, 404);
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.research_run_views`))[0].n, 0, "B's attempt wrote nothing");
  assertEquals((await sql(`SELECT public.run_view_archive($1, $2::uuid) AS ok`, [B, JA1]))[0].ok, false, "the function refuses a run whose prompt is another person's");
  const ok = await call(A, "POST", `${P}/${JA1}/archive`);
  assertEquals([ok.status, ok.json.archived], [200, true]);
  assertEquals((await call(A, "POST", `${P}/${JA1}/archive`)).status, 409, "a second archive says so");
  const active = await call(A, "GET", `${P}`);
  assertEquals(active.json.runs.map((r: any) => r.id), [JA2]);
  assertEquals(active.json.counts, { running: 1, queued: 0, done: 0, stopped: 0, archived: 1, total: 1 });
  const arch = await call(A, "GET", `${P}?view=archived`);
  assertEquals(arch.json.runs.map((r: any) => r.id), [JA1]);
  assertEquals(await snap(), before, "no source, claim, job or prompt row changed");
  assertEquals((await call(B, "GET", `${P}?view=all`)).text, bBefore, "B's view did not change");
  const rows = await sql(`SELECT owner_sub FROM public.research_run_views`);
  assertEquals(rows.map((r) => r.owner_sub), [A], "one row, keyed by the archiver");
  // the run is still readable by its owner
  assertEquals((await call(A, "GET", `${P}/${JA1}`)).status, 200);
  const back = await call(A, "POST", `${P}/${JA1}/unarchive`);
  assertEquals([back.status, back.json.archived], [200, false]);
  assertEquals((await call(A, "POST", `${P}/${JA1}/unarchive`)).status, 409);
  assertEquals((await call(A, "GET", `${P}`)).json.counts.total, 2);
  assertEquals((await call(B, "POST", `${P}/${JA1}/unarchive`)).status, 404);
});

t("R5 the stream of another person's run carries no prompt, steer text, report or private claim", async () => {
  const s = await call(B, "GET", `/workbench/contract/sessions/${JA1}/stream`);
  assertEquals(leaks(s, M_PROMPT, M_STEER, M_REPORT, M_PRIV_CLAIM), []);
  const list = await call(B, "GET", `/workbench/contract/sessions?state=recent&limit=200`);
  assertEquals(leaks(list, M_PROMPT, M_STEER, M_REPORT, M_PRIV_CLAIM), []);
});

t("R6 the report as a document: a document of the caller's own, private; another person gets 404 and no document; nothing reaches a shared row", async () => {
  const denied = await call(B, "POST", `${P}/${JA1}/document`);
  assertEquals(denied.status, 404);
  const r = await call(A, "POST", `${P}/${JA1}/document`);
  assertEquals(r.status, 201);
  assert(r.json.path.startsWith("documents/"), r.text);
  assertEquals(r.json.title, M_PROMPT);
  if (VAULT) {
    const file = await Deno.readTextFile(`${VAULT}/${r.json.path}`);
    assert(file.includes(M_REPORT) && file.includes(`research_run: "${JA1}"`));
  }
  // nothing private reaches a shared row
  const shared = await sql(`SELECT (SELECT count(*)::int FROM public.sources WHERE content ILIKE $1 OR title ILIKE $1) AS sources,
                                   (SELECT count(*)::int FROM public.claims WHERE text ILIKE $1) AS claims,
                                   (SELECT count(*)::int FROM public.thoughts WHERE content ILIKE $1) AS thoughts,
                                   (SELECT count(*)::int FROM public.wiki_pages WHERE slug ILIKE $1 OR title ILIKE $1) AS wiki`, [`%${M_REPORT}%`]);
  assertEquals(shared[0], { sources: 0, claims: 0, thoughts: 0, wiki: 0 });
  // B's document listing does not show it
  const listB = await call(B, "GET", "/workbench/contract/documents?limit=200");
  assertEquals(leaks(listB, M_PROMPT, M_REPORT, r.json.path), []);
  const noReport = await call(A, "POST", `${P}/${JA2}/document`);
  assertEquals(noReport.status, 409, "a run with no report yet");
});

t("R7 a service key has no runs (403) and no door key is 401/403", async () => {
  if (SVC) assertEquals((await call(null, "GET", P, undefined, SVC)).status, 403);
  assertNotEquals((await call(A, "GET", P, undefined, "wrong-key")).status, 200);
});

t("R8 the catalog: ob_workbench alone may run the four functions; nobody holds a right on the table", async () => {
  const fns = ["run_view_archive(text,uuid)", "run_view_unarchive(text,uuid)", "run_views_of(text)", "run_handbacks_of(text)"];
  for (const f of fns) {
    const rows = await sql<{ rolname: string }>(`SELECT r.rolname FROM pg_roles r WHERE has_function_privilege(r.oid, $1::regprocedure, 'EXECUTE') AND NOT r.rolsuper AND r.rolname !~ '^pg_' ORDER BY 1`, [`public.${f}`]);
    assertEquals(rows.map((x) => x.rolname), ["ob_workbench"], f);
  }
  const t1 = await sql<{ rolname: string }>(`SELECT r.rolname FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname !~ '^pg_'
      AND (has_table_privilege(r.oid, 'public.research_run_views', 'SELECT') OR has_table_privilege(r.oid, 'public.research_run_views', 'INSERT')
        OR has_table_privilege(r.oid, 'public.research_run_views', 'UPDATE') OR has_table_privilege(r.oid, 'public.research_run_views', 'DELETE'))`);
  assertEquals(t1.map((x) => x.rolname), [], "no non-superuser role holds a right on the table (it is the table's owner at most)");
});
