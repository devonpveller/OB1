// deno test src/contracts/gaps_integration_test.ts - document gaps (rwr-doc-gaps-api) over a REAL workbench and database,
// as TWO users. SKIPPED unless GAPS_TEST_BASE and CONTRACT_TEST_DB_HOST are set; contract-test/run-gaps-tests.ps1 runs it
// in its disposable lab (the real initdb chain incl. 650-init-document-gaps.sql, fixtures.sql, the :wt workbench with
// WORKSPACE_IDENTITY_HEADER=X-Test-Sub, the stub research service that stores a job in research_jobs, the stub embedder
// that answers the same vector for every text). Never point it at a live stack.
//
// G1..G11 name the acceptance statements (test-plans/rwr-doc-gaps-api.md).
// Environment: GAPS_TEST_BASE, GAPS_TEST_KEY, GAPS_TEST_SUB_HEADER (default X-Test-Sub), CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD
// (superuser: plants and snapshots).
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("GAPS_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("GAPS_TEST_KEY") ?? "";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const SUB_HEADER = Deno.env.get("GAPS_TEST_SUB_HEADER") ?? "X-Test-Sub";
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 3, true)
  : null;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });

// deno-lint-ignore no-explicit-any
async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}
const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const A = `gap-a-${rnd()}`;
const B = `gap-b-${rnd()}`;
const GP = "/workbench/contract/gaps";
// a marker is looked for in ANY letter case: the stored de-dup key (text_norm) is lower case
const has = (body: string, marker: string) => body.toLowerCase().includes(marker.toLowerCase());
// all but the last n characters (code points: never a lone surrogate)
const head = (t: string, n: number) => Array.from(t).slice(0, -n).join("");
const ABSENT = "9a900000-0000-4000-8000-0000000000ee";

// deno-lint-ignore no-explicit-any
type J = Record<string, any>;
const seen: Record<string, string[]> = { [A]: [], [B]: [] }; // every response body each user received (G5, G7 scan them)

async function call(who: string, method: string, path: string, body?: unknown, raw?: string) {
  const headers: Record<string, string> = { "x-brain-key": KEY, [SUB_HEADER]: who };
  if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(BASE + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text();
  let json: J = {};
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  seen[who]?.push(text);
  return { status: r.status, json, text };
}
const docOf = async (who: string) => {
  const r = await call(who, "POST", "/workbench/documents", { title: `gaps ${rnd()}`, body: "A document that still needs things." });
  assert(r.status === 201 || r.status === 207, `document create: ${r.status} ${r.text}`);
  return r.json.path as string;
};
const mk = (who: string, path: string, text: string, over: J = {}) => call(who, "POST", GP, { path, text, ...over });
const VEC = (i: number) => "[" + Array.from({ length: 1024 }, (_, k) => (k === i ? 1 : 0)).join(",") + "]";

// the stub research service stores each job it is asked for; these are the jobs of one test
async function jobsFor(marker: string) {
  return await sql<{ id: string; query: string; options: J }>(`SELECT id::text AS id, query, options FROM public.research_jobs WHERE query ILIKE $1`, [`%${marker}%`]);
}
async function finish(jobId: string, status: string, filed: string[]) {
  await sql(
    `UPDATE public.research_jobs SET status = $2, finished_at = now(),
            result = jsonb_build_object('curator', jsonb_build_object('claims', jsonb_build_object('filed', $3::jsonb))) WHERE id = $1`,
    [jobId, status, JSON.stringify(filed)],
  );
}
// a shared claim of the run, backed by sources on the given hosts (edge types per host); embedding axis i
async function plantClaim(text: string, axis: number, edges: { host: string; edge: string }[], over: { contradicted?: boolean; status?: string } = {}) {
  const cid = crypto.randomUUID();
  const c = await pool!.connect();
  try {
    await c.queryObject(`ALTER TABLE public.sources DISABLE TRIGGER USER`); // slot 470's stamp: the lab plants shared sources directly
    await c.queryObject(
      `INSERT INTO public.claims (id, text, embedding, status, contradicted) VALUES ($1, $2, $3::vector, $4, $5)`,
      [cid, text, VEC(axis), over.status ?? "active", over.contradicted ?? false],
    );
    for (const e of edges) {
      const sid = crypto.randomUUID();
      await c.queryObject(`INSERT INTO public.sources (id, title, content, url, domain) VALUES ($1, $2, 'planted', $3, $4)`, [sid, `s ${rnd()}`, `https://${e.host}/${rnd()}`, e.host]);
      await c.queryObject(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $2, $3)`, [cid, sid, e.edge]);
    }
  } finally {
    await c.queryObject(`ALTER TABLE public.sources ENABLE TRIGGER USER`).catch(() => {});
    c.release();
  }
  return cid;
}
/** a gap queued in its own run, the run then ended as given; the gap is read back (the read settles it) */
async function runAndEnd(who: string, path: string, text: string, status: string, filed: string[]) {
  const g = await mk(who, path, text);
  assertEquals(g.status, 201, g.text);
  const r = await call(who, "POST", `${GP}/research`, { ids: [g.json.id] });
  assertEquals(r.status, 202, r.text);
  if (status) await finish(r.json.job_id, status, filed);
  const back = await call(who, "GET", `${GP}/${g.json.id}`);
  return { id: g.json.id as string, job: r.json.job_id as string, gap: back.json };
}

t("G1: add, tick two, research: exactly one job; both gaps researching with that job id", async () => {
  const path = await docOf(A);
  const mark = `G1needs${rnd()}`;
  const g1 = await mk(A, path, `${mark} first question`);
  const g2 = await mk(A, path, `${mark} second question`);
  const g3 = await mk(A, path, `${mark} third, not ticked`);
  for (const g of [g1, g2, g3]) assertEquals(g.status, 201, g.text);
  assertEquals(g1.json.state, "open");
  assertEquals(g1.json.origin, "user");
  assertEquals(g1.json.job_id, null);
  const before = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_jobs`))[0].n;
  const r = await call(A, "POST", `${GP}/research`, { ids: [g1.json.id, g2.json.id] });
  assertEquals(r.status, 202, r.text);
  const after = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_jobs`))[0].n;
  assertEquals(after - before, 1, "exactly one job was created");
  const jobs = await jobsFor(mark);
  assertEquals(jobs.length, 1);
  assertEquals(jobs[0].options.gap_research, "preliminary", "queued as the gap kind, through the existing research path");
  assert(jobs[0].query.includes("first question") && jobs[0].query.includes("second question") && !jobs[0].query.includes("not ticked"));
  assertEquals(r.json.job_id, jobs[0].id);
  const rows = await sql<{ id: string; state: string; job_id: string | null }>(`SELECT id::text, state, job_id::text FROM public.document_gaps WHERE id = ANY($1::uuid[]) OR id = $2`, [[g1.json.id, g2.json.id], g3.json.id]);
  for (const id of [g1.json.id, g2.json.id]) {
    const row = rows.find((x) => x.id === id)!;
    assertEquals([row.state, row.job_id], ["researching", jobs[0].id]);
  }
  assertEquals(rows.find((x) => x.id === g3.json.id)!.state, "open");
  assertEquals(rows.find((x) => x.id === g3.json.id)!.job_id, null);
  // asking again for the same ticked gaps starts nothing
  const again = await call(A, "POST", `${GP}/research`, { ids: [g1.json.id, g2.json.id] });
  assertEquals(again.status, 409);
  assertEquals((await jobsFor(mark)).length, 1);
  // two requests at once for the third gap: one run
  const [x, y] = await Promise.all([call(A, "POST", `${GP}/research`, { ids: [g3.json.id] }), call(A, "POST", `${GP}/research`, { ids: [g3.json.id] })]);
  assertEquals([x.status, y.status].sort(), [202, 409]);
  assertEquals((await jobsFor(mark)).length, 2);
  // gaps of two documents cannot share one run; a gap that is not open cannot be researched
  const p2 = await docOf(A);
  const o1 = await mk(A, p2, `${mark} other doc`);
  const o2 = await mk(A, path, `${mark} fourth`);
  assertEquals((await call(A, "POST", `${GP}/research`, { ids: [o1.json.id, o2.json.id] })).status, 400);
  assertEquals((await jobsFor(mark)).length, 2);
});

t("G2: duplicate text is refused, names the existing gap, and nothing is added", async () => {
  const path = await docOf(A);
  const mark = `G2dup${rnd()}`;
  const first = await mk(A, path, `How does ${mark} hold pressure?`);
  assertEquals(first.status, 201);
  const n0 = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.document_gaps WHERE owner_sub = (SELECT owner_sub FROM public.document_gaps WHERE id = $1)`, [first.json.id]))[0].n;
  for (const variant of [`How does ${mark} hold pressure?`, `  how does ${mark.toUpperCase()} hold   pressure `, `"How does ${mark} hold pressure."`]) {
    const d = await mk(A, path, variant);
    assertEquals(d.status, 409, d.text);
    assertEquals(d.json.detail.existing.id, first.json.id, "the refusal names the existing gap");
    assertEquals(d.json.detail.existing.text, first.json.text);
  }
  const n1 = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.document_gaps WHERE owner_sub = (SELECT owner_sub FROM public.document_gaps WHERE id = $1)`, [first.json.id]))[0].n;
  assertEquals(n1, n0, "nothing was added");
  // a gap being researched still blocks its twin
  await call(A, "POST", `${GP}/research`, { ids: [first.json.id] });
  assertEquals((await mk(A, path, `how does ${mark} hold pressure`)).status, 409);
  // the same words on another document of the same person are not a duplicate
  assertEquals((await mk(A, await docOf(A), `How does ${mark} hold pressure?`)).status, 201);
  // rewording a gap into another's words is refused the same way; the database holds the line too
  const other = await mk(A, path, `${mark} another`);
  const re = await call(A, "PATCH", `${GP}/${other.json.id}`, { text: `HOW does ${mark} hold pressure` });
  assertEquals(re.status, 409);
  assertEquals(re.json.detail.existing.id, first.json.id);
  let refused = false;
  try {
    await sql(`INSERT INTO public.document_gaps (owner_sub, actor_sub, doc_path, text, text_norm) SELECT owner_sub, actor_sub, doc_path, 'x', text_norm FROM public.document_gaps WHERE id = $1`, [first.json.id]);
  } catch { refused = true; }
  assert(refused, "the partial unique index refuses an active twin");
});

t("G3: a dismissed gap never comes back from the same origin", async () => {
  const path = await docOf(A);
  const mark = `G3dis${rnd()}`;
  const g = await mk(A, path, `${mark} a topic nobody wants`, { origin: "scan" });
  assertEquals(g.status, 201);
  const d = await call(A, "PATCH", `${GP}/${g.json.id}`, { state: "dismissed" });
  assertEquals([d.status, d.json.state], [200, "dismissed"]);
  const same = await mk(A, path, `${mark} A topic nobody wants.`, { origin: "scan" });
  assertEquals(same.status, 409, same.text);
  assertEquals(same.json.detail.existing.id, g.json.id);
  const listed = (await call(A, "GET", `${GP}?path=${encodeURIComponent(path)}`)).json;
  assertEquals(listed.gaps.filter((x: J) => x.id === g.json.id).length, 0, "a dismissed gap is not in the default list");
  assertEquals(listed.counts.dismissed, 1);
  const only = (await call(A, "GET", `${GP}?path=${encodeURIComponent(path)}&state=dismissed`)).json;
  assertEquals(only.gaps.map((x: J) => x.id), [g.json.id]);
  // the person's own typing is another origin: it is a gap again, and the dismissed one stays dismissed
  const mine = await mk(A, path, `${mark} a topic nobody wants`, { origin: "user" });
  assertEquals(mine.status, 201, mine.text);
  assertEquals((await call(A, "GET", `${GP}/${g.json.id}`)).json.state, "dismissed");
  // a dismissed gap is kept (deleting it would let its origin bring it back)
  assertEquals((await call(A, "DELETE", `${GP}/${g.json.id}`)).status, 409);
  // reopening is the person's own act, refused while an active twin exists
  assertEquals((await call(A, "PATCH", `${GP}/${g.json.id}`, { state: "open" })).status, 409);
  assertEquals((await call(A, "DELETE", `${GP}/${mine.json.id}`)).status, 200);
  assertEquals((await call(A, "PATCH", `${GP}/${g.json.id}`, { state: "open" })).json.state, "open");
});

t("G4: rotate-out - a run that finished with a claim of two agreeing sources covers the gap; one without does not", async () => {
  const path = await docOf(A);
  const mark = `G4rot${rnd()}`;
  const q = (s: string) => `${mark} ${s}`;
  // the claim sits on embedding axis 0, the stub embedder answers axis 0 for every text: near. Axis 1 is orthogonal: far.
  const good = await plantClaim(q("good claim"), 0, [{ host: "alpha.example", edge: "states" }, { host: "beta.example", edge: "corroborates" }]);
  const one = await plantClaim(q("one source"), 0, [{ host: "alpha.example", edge: "states" }]);
  const sameHost = await plantClaim(q("same host"), 0, [{ host: "alpha.example", edge: "states" }, { host: "ALPHA.example", edge: "corroborates" }]);
  const against = await plantClaim(q("one agrees one contradicts"), 0, [{ host: "alpha.example", edge: "states" }, { host: "beta.example", edge: "contradicts" }]);
  const far = await plantClaim(q("far from the question"), 1, [{ host: "alpha.example", edge: "states" }, { host: "beta.example", edge: "states" }]);
  // a contradicts edge makes the claim contradicted (slot init-claims' trigger sets claims.contradicted from the edges)
  const disputed = await plantClaim(q("contradicted"), 0, [{ host: "alpha.example", edge: "states" }, { host: "beta.example", edge: "states" }, { host: "gamma.example", edge: "contradicts" }]);
  const retracted = await plantClaim(q("retracted"), 0, [{ host: "alpha.example", edge: "states" }, { host: "beta.example", edge: "states" }], { status: "retracted" });

  const ok = await runAndEnd(A, path, q("covered question"), "done", [good]);
  assertEquals(ok.gap.state, "covered", JSON.stringify(ok.gap));
  assert(ok.gap.covered_at, "covered_at is set");
  assertEquals(ok.gap.job_id, ok.job);
  // it rotates out: the counts move, and "open" no longer lists it
  const list = (await call(A, "GET", `${GP}?path=${encodeURIComponent(path)}&state=open`)).json;
  assert(!list.gaps.some((x: J) => x.id === ok.id));
  assert(list.counts.covered >= 1);

  // FAILS if it rotates on run-finished alone: each of these runs FINISHED (done) and none is covered
  const finishedAlone = await runAndEnd(A, path, q("finished with nothing"), "done", []);
  assertEquals(finishedAlone.gap.state, "open", "a finished run alone does not cover a gap");
  assertEquals(finishedAlone.gap.covered_at, null);
  assertEquals(finishedAlone.gap.job_id, finishedAlone.job, "the run it was in stays on the record");
  for (const [label, cid] of [["one source", one], ["two pages of one host", sameHost], ["one source against", against], ["not the question's claim", far], ["a contradicted claim", disputed], ["a retracted claim", retracted]] as const) {
    const r = await runAndEnd(A, path, q(`not covered: ${label}`), "done", [cid]);
    assertEquals(r.gap.state, "open", `${label}: a finished run whose claim is not backed by two agreeing sources covers nothing`);
  }
  // an errored or cancelled run covers nothing, whatever it filed
  assertEquals((await runAndEnd(A, path, q("errored"), "error", [good])).gap.state, "open");
  assertEquals((await runAndEnd(A, path, q("cancelled"), "cancelled", [good])).gap.state, "open");
  // a run still going leaves the gap researching
  const going = await runAndEnd(A, path, q("still running"), "", []);
  assertEquals(going.gap.state, "researching");
  // a claim another run filed does not count for this run
  const elsewhere = await runAndEnd(A, path, q("claims of another run"), "done", []);
  assertEquals(elsewhere.gap.state, "open");
  // the person's own mark covers a gap with no run at all
  const m = await mk(A, path, q("marked by hand"));
  const marked = await call(A, "PATCH", `${GP}/${m.json.id}`, { state: "covered" });
  assertEquals([marked.status, marked.json.state], [200, "covered"]);
  assert(marked.json.covered_at);
  // researching cannot be set by hand
  assertEquals((await call(A, "PATCH", `${GP}/${m.json.id}`, { state: "researching" })).status, 400);
});

t("G5: two identities - B never sees A's gaps, counts, totals or the query text; a refusal is the missing row's twin", async () => {
  const pathA = await docOf(A);
  const pathB = await docOf(B);
  const MARK = `G5secret${rnd()}`;
  const ga = await mk(A, pathA, `${MARK} private need one`);
  const gb = await mk(A, pathA, `${MARK} private need two`);
  const run = await call(A, "POST", `${GP}/research`, { ids: [ga.json.id, gb.json.id] });
  assertEquals(run.status, 202);
  const bBefore = (await call(B, "GET", GP)).json;
  // B's own gap, to prove B's numbers are B's
  const bOwn = await mk(B, pathB, "B has its own need");
  assertEquals(bOwn.status, 201);
  const bList = (await call(B, "GET", GP)).json;
  assertEquals(bList.gaps.map((g: J) => g.id), [bOwn.json.id]);
  assertEquals([bList.total, bList.counts.open], [bBefore.total + 1, bBefore.counts.open + 1]);
  // A's activity moves none of B's numbers
  for (let i = 0; i < 3; i++) await mk(A, pathA, `${MARK} more ${i}`);
  const bAfter = (await call(B, "GET", GP)).json;
  assertEquals([bAfter.total, bAfter.counts], [bList.total, bList.counts]);
  assertEquals((await call(B, "GET", `${GP}?state=researching`)).json.total, 0);
  assertEquals((await call(B, "GET", `${GP}?state=researching`)).json.counts.researching, 0);
  // by id: A's gap is exactly a missing one, for every verb
  for (const [m, p, body] of [
    ["GET", `${GP}/${ga.json.id}`, undefined], ["PATCH", `${GP}/${ga.json.id}`, { state: "dismissed" }], ["DELETE", `${GP}/${ga.json.id}`, undefined],
  ] as const) {
    const foreign = await call(B, m, p, body);
    const missing = await call(B, m, p.replace(ga.json.id, ABSENT), body);
    assertEquals([foreign.status, foreign.text], [missing.status, missing.text], `${m} of another user's gap is the missing gap's answer`);
    assertEquals(foreign.status, 404);
  }
  // "research these" with A's ids, with a missing id, and with a mix of B's own and A's: all the same refusal
  const fr = await call(B, "POST", `${GP}/research`, { ids: [ga.json.id] });
  const mr = await call(B, "POST", `${GP}/research`, { ids: [ABSENT] });
  const mix = await call(B, "POST", `${GP}/research`, { ids: [bOwn.json.id, ga.json.id] });
  assertEquals([fr.status, fr.text], [mr.status, mr.text]);
  assertEquals([mix.status, mix.text], [mr.status, mr.text]);
  assertEquals((await call(B, "GET", `${GP}/${bOwn.json.id}`)).json.state, "open", "the refusal left B's own gap alone");
  // another user's document: the same refusal as a document that is not there
  const onA = await mk(B, pathA, "x");
  const onNone = await mk(B, pathA.replace(/\/[^/]+$/, "/nothing-here.md"), "x");
  assertEquals(onA.status, 404);
  assertEquals([onA.status, onA.json.error], [onNone.status, onNone.json.error]);
  assertEquals((await call(B, "GET", `${GP}?path=${encodeURIComponent(pathA)}`)).json.total ?? 0, 0);
  // B writes A's exact words on B's own document: it is simply added (no cross-user duplicate oracle) and names nothing of A's
  const same = await mk(B, pathB, `${MARK} private need one`);
  assertEquals(same.status, 201);
  const dupB = await mk(B, pathB, `${MARK} private need one`);
  assertEquals(dupB.status, 409);
  assertEquals(dupB.json.detail.existing.id, same.json.id, "the refusal names B's own gap, never A's");
  // the job's prompt stays owner-scoped (as research_prompts does today): B's reads of the run show no query
  const jobA = run.json.job_id as string;
  assertEquals((await call(B, "GET", `/workbench/contract/sessions/${jobA}`)).json.query ?? "", "");
  const sess = (await call(B, "GET", "/workbench/contract/sessions?limit=500")).json;
  assert(!has(JSON.stringify(sess), MARK), "B's session list carries no query text");
  assertEquals((await call(A, "GET", `/workbench/contract/sessions/${jobA}`)).json.query.includes(MARK), true, "A reads their own run's query");
  const prompt = await sql<{ owner_sub: string }>(`SELECT owner_sub FROM public.research_prompts WHERE job_id = $1`, [jobA]);
  assertEquals(prompt.length, 1, "the prompt is recorded owner-scoped");
  // nothing B ever received carries A's marker or A's gap ids; no error text either
  const mine = seen[B].join("\n");
  for (const id of [ga.json.id, gb.json.id]) assert(!mine.includes(id), `B never received A's gap id ${id}`);
  const onlyOwn = seen[B].filter((x) => has(x, MARK));
  // the only bodies with the marker are the two B itself wrote (the add and its duplicate refusal naming B's own gap)
  assertEquals(onlyOwn.length, 2, "the marker came back only in B's own gap's bodies");
});

t("G6: nothing is added by the item to a cloud or shared path: no cloud stamp is needed, no shared row carries a gap", async () => {
  // the item adds no model call; research is the existing path with the workspace key. A gap is not a source, claim or page.
  const path = await docOf(A);
  const MARK = `G6local${rnd()}`;
  const g = await mk(A, path, `${MARK} what is the local-only need`);
  assertEquals(g.status, 201);
  assertEquals((await call(A, "POST", `${GP}/research`, { ids: [g.json.id] })).status, 202);
  const jobs = await jobsFor(MARK);
  assertEquals(jobs.length, 1);
  const row = (await sql<J>(`SELECT caller, origin, origin_claimed FROM public.research_jobs WHERE id = $1`, [jobs[0].id]))[0];
  assertEquals(row.origin, "workspace", "the existing workspace caller path (the local research service)");
  // no key of a cloud stamp is written by this item, on the gap or anywhere it touches
  const cols = (await sql<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'document_gaps'`)).map((c) => c.column_name);
  assert(!cols.some((c) => /share|cloud|model/.test(c)), `document_gaps has no cloud/share/model column: ${cols}`);
});

t("G7: nothing private from this item appears on a shared surface (planted marker)", async () => {
  const path = await docOf(A);
  const MARK = `G7marker${rnd()}`;
  const g1 = await mk(A, path, `${MARK} the first private gap`);
  const g2 = await mk(A, path, `${MARK} the second private gap`);
  const run = await call(A, "POST", `${GP}/research`, { ids: [g1.json.id, g2.json.id] });
  assertEquals(run.status, 202);
  await finish(run.json.job_id, "done", []);
  await call(A, "GET", GP); // settle
  await call(A, "PATCH", `${GP}/${g1.json.id}`, { state: "dismissed" });
  // 1. the shared search, as B, and as A (a gap is not indexed anywhere)
  for (const who of [A, B]) {
    const s = await call(who, "GET", `/workbench/contract/search?q=${MARK}&limit=50`);
    // the search echoes the asked query; what it FOUND is what must carry nothing
    assertEquals(s.json.count, 0, `${who}: the shared search finds nothing for a gap's words`);
    assert(!has(JSON.stringify(s.json.results), MARK), `${who}: the shared search carries no gap text`);
  }
  // 2. shared rows: no shared table holds the marker. The only rows are the gap (its own table), the run's own query and
  //    its owner-scoped prompt, both of which the existing research path writes and which B cannot read (G5).
  const shared = ["sources", "source_chunks", "claims", "claim_sources", "wiki_pages", "thoughts", "entities", "reference_records",
    "source_revisions", "source_trail_events", "user_document_listings", "ideas", "idea_revisions"];
  for (const tb of shared) {
    const ex = (await sql<{ r: string | null }>(`SELECT to_regclass('public.${tb}')::text AS r`))[0].r;
    if (!ex) continue;
    const n = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.${tb} x WHERE x::text ILIKE $1`, [`%${MARK}%`]))[0].n;
    assertEquals(n, 0, `public.${tb} holds no gap text`);
  }
  const holders = (await sql<{ t: string }>(
    `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`)).map((r) => r.t);
  const hits: string[] = [];
  for (const tb of holders) {
    const n = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public."${tb}" x WHERE x::text ILIKE $1`, [`%${MARK}%`]))[0].n;
    if (n) hits.push(`${tb}:${n}`);
  }
  assertEquals(hits.sort(), ["document_gaps:2", "research_jobs:1", "research_prompts:1"], "the marker is in the gap table and in the run the existing research path owns - nowhere else");
  // 3. the run's prompt is owner-scoped: B's reads of it are empty, A's is whole
  const job = run.json.job_id as string;
  assertEquals((await call(B, "GET", `/workbench/contract/sessions/${job}`)).json.query ?? "", "");
  assertEquals((await call(B, "GET", `/workbench/contract/jobs?limit=500`)).text.toLowerCase().includes(MARK.toLowerCase()), false);
  // 4. the ops corpus: the wiki pages and the shared search read nothing of this table
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.wiki_pages WHERE content::text ILIKE $1 OR title ILIKE $1`, [`%${MARK}%`]).catch(() => [{ n: 0 }]))[0].n, 0);
  // 5. every body B received in the whole run carries no marker of A's (G5 checked the ids)
  // (B's own search for the words echoes them back as `query`; that is B's own text, not a finding)
  assert(!seen[B].some((x) => has(x, MARK) && !x.toLowerCase().startsWith(`{"query":"${MARK}`.toLowerCase())), "B received a body carrying A's marker");
});

t("G8: bodies are strict, errors say nothing of other users, and the id and filter parameters are checked", async () => {
  const path = await docOf(A);
  assertEquals((await call(A, "POST", GP, { path, text: "x", owner_sub: "someone-else" })).status, 400);
  assertEquals((await call(A, "POST", GP, { path, text: "x", origin: "madeup" })).status, 422);
  assertEquals((await call(A, "POST", GP, { path, text: "   " })).status, 400);
  assertEquals((await call(A, "POST", GP, { path, text: "x\u0000y" })).status, 400);
  assertEquals((await call(A, "POST", GP, { path: "notes/outside.md", text: "x" })).status, 400);
  assertEquals((await call(A, "POST", GP, undefined, "{not json")).status, 400);
  assertEquals((await call(A, "GET", `${GP}?state=nonsense`)).status, 422);
  assertEquals((await call(A, "GET", `${GP}/not-a-uuid`)).status, 404);
  assertEquals((await call(A, "POST", `${GP}/research`, { ids: [] })).status, 400);
  assertEquals((await call(A, "POST", `${GP}/research`, { ids: ["not-a-uuid"] })).status, 400);
  assertEquals((await call(A, "PATCH", `${GP}/${ABSENT}`, {})).status, 400);
  const g = await mk(A, path, `strict ${rnd()}`);
  assertEquals((await call(A, "PATCH", `${GP}/${g.json.id}`, { text: "reworded " + rnd() })).status, 200);
  const e = await call(A, "POST", GP, { path, text: "x", owner_sub: "other" });
  assert(!/postgres|select |insert |stack|at file:/i.test(e.text), "an error body carries no database or runtime text");
});

t("G9: the identity is the seam's: a gap's owner is the caller, whatever the body says", async () => {
  const path = await docOf(A);
  const g = await mk(A, path, `owner check ${rnd()}`);
  const row = (await sql<{ owner_sub: string; actor_sub: string }>(`SELECT owner_sub, actor_sub FROM public.document_gaps WHERE id = $1`, [g.json.id]))[0];
  assertEquals(row.owner_sub, A);
  assertEquals(row.actor_sub, A);
  assertNotEquals(row.owner_sub, B);
  assert(!("owner_sub" in g.json) && !("actor_sub" in g.json), "the response names no owner");
});

t("G10: a person can remove a gap that is not being researched, and a researching one is held", async () => {
  const path = await docOf(A);
  const g = await mk(A, path, `remove me ${rnd()}`);
  assertEquals((await call(A, "DELETE", `${GP}/${g.json.id}`)).status, 200);
  assertEquals((await call(A, "GET", `${GP}/${g.json.id}`)).status, 404);
  const h = await mk(A, path, `held ${rnd()}`);
  await call(A, "POST", `${GP}/research`, { ids: [h.json.id] });
  assertEquals((await call(A, "DELETE", `${GP}/${h.json.id}`)).status, 409);
  assertEquals((await call(A, "PATCH", `${GP}/${h.json.id}`, { text: "changed" })).status, 409);
});

t("G11: long texts - 2000 CJK characters and 2000 four-byte emoji are added (201) and a repeat is a duplicate (409); a duplicate of a long text names the first", async () => {
  const path = await docOf(A);
  const cjk = Array.from({ length: 2000 }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 7) % 2000))).join(""); // 2000 chars, 6000 bytes
  const emoji = Array.from({ length: 2000 }, (_, i) => String.fromCodePoint(0x1f300 + (i % 400))).join(""); // 2000 chars, 8000 bytes
  for (const [label, text] of [["CJK", cjk], ["emoji", emoji]] as const) {
    const first = await mk(A, path, text);
    assertEquals(first.status, 201, `${label}: ${first.text.slice(0, 200)}`);
    assertEquals(Array.from(first.json.text as string).length, 2000, `${label}: the whole text is kept`);
    const again = await mk(A, path, text);
    assertEquals(again.status, 409, `${label} repeat: ${again.text.slice(0, 200)}`);
    assertEquals(again.json.detail.existing.id, first.json.id, `${label}: the refusal names the first gap`);
    // a duplicate of a long text in other spacing / punctuation is the same gap
    const variant = await mk(A, path, `  ${text}.  `);
    assertEquals(variant.status, 409, `${label} variant`);
    assertEquals(variant.json.detail.existing.id, first.json.id);
    // two long texts that differ only at the very end are two gaps (the key is the whole text, not a prefix)
    const near = await mk(A, path, head(text, 1) + "Z");
    assertEquals(near.status, 201, `${label}: a long text that differs at its last character is not a duplicate`);
    // a long gap is dismissed and kept; its origin cannot bring it back
    const sc = await mk(A, path, head(text, 2) + "QQ", { origin: "scan" });
    assertEquals(sc.status, 201);
    assertEquals((await call(A, "PATCH", `${GP}/${sc.json.id}`, { state: "dismissed" })).status, 200);
    assertEquals((await mk(A, path, head(text, 2) + "qq", { origin: "scan" })).status, 409, `${label}: dismissed long text`);
    // and it is researched like any other
    const r = await call(A, "POST", `${GP}/research`, { ids: [first.json.id] });
    assertEquals(r.status, 202, r.text.slice(0, 200));
  }
  // 2001 characters is refused (400), as before
  assertEquals((await mk(A, path, "x".repeat(2001))).status, 400);
  assertEquals((await mk(A, path, "\u{1F600}".repeat(2001))).status, 400);
  // a rewording to a long text is checked the same way
  const g = await mk(A, path, `short ${rnd()}`);
  assertEquals((await call(A, "PATCH", `${GP}/${g.json.id}`, { text: cjk })).status, 409, "reworded into the long text of another gap");
  // an invisible character does not make a second gap (the key ignores zero-width characters; the text is kept as typed)
  const zw = await mk(A, path, `zero\u200bwidth ${rnd().slice(0, 4)} need`);
  assertEquals(zw.status, 201);
  const zwDup = await mk(A, path, zw.json.text.replace("\u200b", ""));
  assertEquals(zwDup.status, 409, "a zero-width character inside the text is not a new gap");
  assertEquals(zwDup.json.detail.existing.id, zw.json.id);
  // a document path over 1024 bytes is refused 400 (the database index cannot hold it), never a 500
  const long = path.replace(/\/[^/]+$/, "/" + "\u6587".repeat(400) + ".md");
  const lp = await mk(A, long, "x");
  assert([400, 404].includes(lp.status), `a very long path is refused, not a 500 (${lp.status})`);
});

Deno.test({ name: "G-close: close the pool", ignore, fn: async () => { await pool?.end(); }, sanitizeOps: false, sanitizeResources: false });
