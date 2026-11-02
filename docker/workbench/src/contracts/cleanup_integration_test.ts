// deno test src/contracts/cleanup_integration_test.ts - the cleanup view's routes (rw-p8a2-cleanup; D5 items
// 4-7 and 07-MULTI-USER) over a REAL workbench and database, as TWO users.
//
// SKIPPED unless DOCS_TEST_BASE and CONTRACT_TEST_DB_HOST are set. contract-test/run-workspace-tests.ps1
// runs it in its disposable lab (the real initdb chain incl. 340-init-cleanup.sql, fixtures.sql, the :wt
// workbench with WORKSPACE_IDENTITY_HEADER=X-Test-Sub, the stub research service as the D15 scorer).
// Never point it at a live stack: it suppresses, severs and erases rows. Every source it acts on is its own.
//
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
const A = `clean-a-${rnd()}`;
const B = `clean-b-${rnd()}`;
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
const CL = `${C}/cleanup`;

// a source of this test's own: a chunk and a claim edge (two severable, blocking connections)
async function newSource(tag: string, opts: { chunk?: boolean; claim?: boolean; url?: string } = {}) {
  const id = crypto.randomUUID();
  await sql(`INSERT INTO public.sources (id, url, title, content) VALUES ($1, $2, $3, $4)`,
    [id, opts.url ?? `https://example.org/cleanup/${tag}/${id}`, `cleanup ${tag} ${id.slice(0, 8)}`, `content ${tag} ${id}`]);
  if (opts.chunk !== false) await sql(`INSERT INTO public.source_chunks (source_id, idx, content) VALUES ($1, 0, 'a chunk')`, [id]);
  if (opts.claim !== false) {
    const c = crypto.randomUUID();
    await sql(`INSERT INTO public.claims (id, text) VALUES ($1, $2)`, [c, `claim on ${tag} ${id}`]);
    await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $2, 'states')`, [c, id]);
  }
  return id;
}
const suppress = async (id: string) => assertEquals((await call(A, "POST", `${C}/sources/${id}/suppress`, { reason: "cleanup test" })).status, 200);
const listed = async (who = A) => (await call(who, "GET", `${CL}/sources?limit=500`)).json.sources as any[];

t("the listing shows every suppressed and unlinked source with its status and dependence counts", async () => {
  const s = await newSource("listing");
  await suppress(s);
  const r = await call(A, "GET", `${CL}/sources?limit=500`);
  assertEquals(r.status, 200, r.text);
  const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.sources WHERE retraction_committed_at IS NOT NULL`);
  assertEquals(r.json.total, n, "total = every suppressed or unlinked source");
  assertEquals(r.json.sources.length, n, "every one listed (limit 500)");
  for (const x of r.json.sources) {
    assert(["suppressed", "unlinked"].includes(x.lifecycle), `${x.id} listed without its status: ${x.lifecycle}`);
    assert(x.suppressed_at, `${x.id} has no suppressed_at`);
    assertEquals(x.erase_allowed, x.lifecycle === "unlinked" && x.blocking === 0, `${x.id}: erase offered only when unlinked with no dependence`);
  }
  const mine = r.json.sources.find((x: any) => x.id === s);
  assertEquals([mine.lifecycle, mine.reason, mine.counts.chunk, mine.counts.claim_edge, mine.blocking, mine.erase_allowed],
    ["suppressed", "cleanup test", 1, 1, 2, false]);
  // shared knowledge: user B reads the same listing
  assertEquals(JSON.stringify(await listed(B)), JSON.stringify(r.json.sources));
  // an active source is never listed
  const active = await newSource("active");
  assertEquals((await listed()).some((x) => x.id === active), false);
});

t("a manual erase is refused while dependence remains, needs a reason type, and takes an optional note", async () => {
  const s = await newSource("manual");
  await suppress(s);
  const refused = await call(A, "POST", `${CL}/sources/${s}/erase`, { reason_type: "deliberate" });
  assertEquals(refused.status, 409, refused.text);
  assertEquals((await sql(`SELECT 1 FROM public.source_tombstones WHERE source_id = $1`, [s])).length, 0);
  assertEquals((await call(A, "POST", `${CL}/sources/${s}/erase`, { note: "no reason" })).status, 400, "an erase without a reason type FAILS");
  assertEquals((await call(A, "POST", `${CL}/sources/${s}/erase`, { reason_type: "not-a-reason" })).status, 422);
  // round 2 (tester N2): a JSON content type with no body, or a body that does not parse, is a 400 (was 500)
  for (const raw of [undefined, "", "{"]) {
    const r = await fetch(`${BASE}${CL}/sources/${s}/erase`, { method: "POST", headers: { "content-type": "application/json", "x-brain-key": KEY, [SUB_HEADER]: A }, body: raw });
    assertEquals(r.status, 400, `body ${JSON.stringify(raw)}: ${await r.text()}`);
  }
  assertEquals((await call(A, "POST", `${CL}/sources/${s}/erase`, { reason_type: "deliberate", eraser: { kind: "user", user: B } })).status, 400,
    "a caller-supplied eraser is refused");
  // sever one connection, then the rest
  const one = await call(A, "POST", `${CL}/sources/${s}/sever`, { kind: "chunk", ref: "0" });
  assertEquals([one.status, one.json.lifecycle, one.json.blocking, one.json.action.kind], [200, "suppressed", 1, "sever"], one.text);
  const all = await call(A, "POST", `${CL}/sources/${s}/sever`, { all: true });
  assertEquals([all.status, all.json.lifecycle, all.json.blocking], [200, "unlinked", 0], all.text);
  const row = (await listed()).find((x) => x.id === s);
  assertEquals([row.lifecycle, row.erase_allowed], ["unlinked", true]);
  const e = await call(A, "POST", `${CL}/sources/${s}/erase`, { reason_type: "credibility", note: "a manual note" });
  assertEquals(e.status, 200, e.text);
  const [tb] = await sql<{ reason_type: string; note: string; eraser_kind: string; eraser_user: string; batch_run_id: string | null }>(
    `SELECT reason_type, note, eraser_kind, eraser_user, batch_run_id FROM public.source_tombstones WHERE source_id = $1`, [s]);
  assertEquals([tb.reason_type, tb.note, tb.eraser_kind, tb.eraser_user, tb.batch_run_id],
    ["credibility", "a manual note", "user", `cleanup-action:${e.json.action.id}`, null]);
  // the shared rows name the action, never the user
  const trailActors = await sql<{ actor: string }>(`SELECT DISTINCT actor FROM public.source_trail_events WHERE source_id = $1 AND kind IN ('severed', 'erased')`, [s]);
  for (const r of trailActors) assert(r.actor?.startsWith("cleanup-action:"), `trail actor ${r.actor}`);
});

t("process-all: one reason type, no note; severs and erases what it can, reports what it cannot; each tombstone records the run", async () => {
  const sev = await newSource("bulk-severable");
  const unl = await newSource("bulk-unlinked", { chunk: false, claim: false });
  const linked = await newSource("bulk-doclinked");
  const active = await newSource("bulk-active");
  for (const s of [sev, unl, linked]) await suppress(s);
  // a user document links `linked` (a connection only its owner resolves, in the document: not severable)
  const doc = await call(A, "POST", "/workbench/documents", { title: `bulk ${rnd()}`, body: `See [[source:${linked}|it]].` });
  assertEquals(doc.status, 201, doc.text);
  const noted = await call(A, "POST", `${CL}/process-all`, { reason_type: "deliberate", source_ids: [sev], note: "a note" });
  assertEquals(noted.status, 400, "a bulk run that takes a note FAILS");
  assertEquals((await call(A, "POST", `${CL}/process-all`, { source_ids: [sev] })).status, 400, "no reason type");
  assertEquals((await sql(`SELECT 1 FROM public.source_tombstones WHERE source_id = $1`, [sev])).length, 0, "a refused run changed nothing");
  const r = await call(A, "POST", `${CL}/process-all`, { reason_type: "debunked", source_ids: [sev, unl, linked, active] });
  assertEquals(r.status, 200, r.text);
  const by = Object.fromEntries(r.json.items.map((i: any) => [i.source_id, i]));
  assertEquals([by[sev].outcome, by[unl].outcome, by[linked].outcome, by[active].outcome], ["erased", "erased", "blocked", "skipped"], r.text);
  assertEquals(by[sev].severed, 2);
  assertEquals(r.json.erased, 2);
  const run = `cleanup-action:${r.json.action.id}`;
  const tombs = await sql<{ source_id: string; reason_type: string; note: string | null; batch_run_id: string; eraser_user: string }>(
    `SELECT source_id, reason_type, note, batch_run_id, eraser_user FROM public.source_tombstones WHERE source_id = ANY($1::uuid[])`, [[sev, unl, linked]]);
  assertEquals(tombs.length, 2);
  for (const tb of tombs) assertEquals([tb.reason_type, tb.note, tb.batch_run_id, tb.eraser_user], ["debunked", null, run, run]);
  assertEquals((await listed()).find((x) => x.id === linked)?.lifecycle, "suppressed", "the blocked source stays listed with its status");
  const act = await call(A, "GET", `${CL}/actions/${r.json.action.id}`);
  assertEquals([act.status, act.json.kind, act.json.reason_type, act.json.detail.erased, act.json.detail.blocked], [200, "process_all", "debunked", 2, 1]);
});

t("reopen candidates: user-erased returns that cleared their bar and deliberate notes, each with evidence and a lift; automation readmissions are trail events", async () => {
  // user-erased, debunked: its return scores 0.9 >= floor 0.5 -> a proposed contesting source, dispute previewed
  const debUrl = `https://example.org/cleanup/reopen/${rnd()}?score=high`;
  const deb = await newSource("reopen-debunked", { chunk: false, claim: false, url: debUrl });
  await suppress(deb);
  const de = await call(A, "POST", `${CL}/sources/${deb}/erase`, { reason_type: "debunked" });
  assertEquals(de.status, 200, de.text);
  const back = await call(A, "POST", `${C}/admission`, { url: debUrl, path: "intake", candidate: { content: "it came back" } });
  assertEquals([back.json.outcome, back.json.admits], ["candidate", false], back.text);
  // user-erased, credibility, revised content over the bar -> a credibility candidate
  const credUrl = `https://example.org/cleanup/reopen/${rnd()}?score=high`;
  const cred = await newSource("reopen-cred", { chunk: false, claim: false, url: credUrl });
  await suppress(cred);
  await sql(`UPDATE public.sources SET suppression_context = suppression_context || '{"score_at_removal":{"value":0.3,"version":"v1"}}'::jsonb WHERE id = $1`, [cred]);
  const ce = await call(A, "POST", `${CL}/sources/${cred}/erase`, { reason_type: "credibility" });
  assertEquals(ce.status, 200, ce.text);
  const cb = await call(A, "POST", `${C}/admission`, { url: credUrl, path: "watch", candidate: { content: "revised content" } });
  assertEquals(cb.json.outcome, "candidate", cb.text);
  // a return below the floor is no candidate
  const lowUrl = `https://example.org/cleanup/reopen/${rnd()}`;
  const low = await newSource("reopen-low", { chunk: false, claim: false, url: lowUrl });
  await suppress(low);
  const le = await call(A, "POST", `${CL}/sources/${low}/erase`, { reason_type: "debunked" });
  await call(A, "POST", `${C}/admission`, { url: lowUrl, path: "intake", candidate: { content: "back, still weak" } });
  // deliberate: a reopen note from user B's research session
  const delUrl = `https://example.org/cleanup/reopen/${rnd()}`;
  const del = await newSource("reopen-deliberate", { chunk: false, claim: false, url: delUrl });
  await suppress(del);
  const dle = await call(B, "POST", `${CL}/sources/${del}/erase`, { reason_type: "deliberate" });
  assertEquals(dle.status, 200, dle.text);
  const [job] = await sql<{ id: string }>(`INSERT INTO public.research_jobs (status, origin, query) VALUES ('done', 'workspace', 'b question') RETURNING id::text AS id`);
  await sql(`INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, $2, $2, 'b question')`, [job.id, B]);
  const noteText = `BReopenNote${rnd()}`;
  const dn = await call(B, "POST", `${C}/admission`, { url: delUrl, path: "query", session_id: job.id, note: noteText });
  assertEquals(dn.json.outcome, "note_appended", dn.text);
  // automation-erased, debunked, cleared its floor: readmitted by the gate itself
  const autoUrl = `https://example.org/cleanup/reopen/${rnd()}?score=high`;
  const auto = await newSource("reopen-auto", { chunk: false, claim: false, url: autoUrl });
  await suppress(auto);
  const ae = await call(A, "POST", `${C}/sources/${auto}/erase`, { reason_type: "debunked", eraser: { kind: "automation", run_id: "run-cleanup-test" } });
  assertEquals(ae.status, 200, ae.text);
  const ab = await call(A, "POST", `${C}/admission`, { url: autoUrl, path: "query", candidate: { content: "auto back" } });
  assertEquals([ab.json.outcome, ab.json.admits], ["admitted_contesting", true], ab.text);

  const ra = await call(A, "GET", `${CL}/reopen-candidates?limit=500`);
  assertEquals(ra.status, 200, ra.text);
  const byT = Object.fromEntries(ra.json.candidates.map((c: any) => [c.tombstone.source_id, c]));
  for (const c of ra.json.candidates) assert(c.evidence.length >= 1, `${c.tombstone.id} listed without evidence`);
  assertEquals(byT[deb]?.kind, "proposed_contesting");
  assertEquals(byT[deb].dispute_preview.criticism.tombstone_id, de.json.tombstone_id);
  assertEquals([byT[deb].dispute_preview.score.value, byT[deb].dispute_preview.score.floor], [0.9, 0.5]);
  assertEquals([byT[deb].evidence[0].outcome, byT[deb].evidence[0].path, byT[deb].tombstone.erased_by_you], ["candidate", "intake", true]);
  assertEquals(byT[cred]?.kind, "credibility_cleared");
  assertEquals(byT[low], undefined, "a return below its floor is no candidate");
  assertEquals(byT[auto], undefined, "an automation readmission is never parked as a candidate");
  const trail = await call(A, "GET", `${C}/trail?source_id=${auto}&limit=50`);
  assert(trail.json.entries.some((e: any) => e.kind === "readmitted"), "the automation readmission is a trail event");
  // the reopen note is its evidence (session, door, note: shared knowledge, as on the trail); WHO erased it is
  // the eraser's own - A sees "not erased by you", B "erased by you", and A's answer names no subject
  assertEquals(byT[del]?.kind, "reopen_note");
  assertEquals([byT[del].evidence[0].session_id, byT[del].evidence[0].note, byT[del].evidence[0].path, byT[del].tombstone.erased_by_you],
    [job.id, noteText, "query", false]);
  assertEquals(ra.text.includes(B) || ra.text.includes("b question"), false, "nothing of B's own in A's candidates");
  const rb = await call(B, "GET", `${CL}/reopen-candidates?limit=500`);
  const bDel = rb.json.candidates.find((c: any) => c.tombstone.source_id === del);
  assertEquals([bDel.evidence[0].note, bDel.tombstone.erased_by_you], [noteText, true]);
  assertEquals(rb.json.candidates.find((c: any) => c.tombstone.source_id === deb).tombstone.erased_by_you, false);
  // the lift action: A lifts the debunked candidate; it leaves the list and the URL may be intaken again
  const lifted = await call(A, "POST", `${CL}/tombstones/${de.json.tombstone_id}/lift`, { note: "reconsidered" });
  assertEquals([lifted.status, lifted.json.action.kind, !!lifted.json.lifted_at], [200, "lift", true], lifted.text);
  const [lt] = await sql<{ lifted_by: string }>(`SELECT lifted_by FROM public.source_tombstones WHERE id = $1`, [de.json.tombstone_id]);
  assertEquals(lt.lifted_by, `cleanup-action:${lifted.json.action.id}`);
  // round 2 (tester N3): a second lift is a 409 and records no second action; lifted_by keeps the first
  const liftActions = async () => (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.cleanup_actions WHERE kind = 'lift' AND tombstone_id = $1`, [de.json.tombstone_id]))[0].n;
  assertEquals(await liftActions(), 1);
  const twice = await call(A, "POST", `${CL}/tombstones/${de.json.tombstone_id}/lift`, {});
  assertEquals(twice.status, 409, twice.text);
  assertEquals((await call(B, "POST", `${CL}/tombstones/${de.json.tombstone_id}/lift`, {})).status, 409);
  assertEquals(await liftActions(), 1, "no second lift action");
  const after = await call(A, "GET", `${CL}/reopen-candidates?limit=500`);
  assertEquals(after.json.candidates.some((c: any) => c.tombstone.source_id === deb), false);
  const again = await call(A, "POST", `${C}/admission`, { url: debUrl, path: "intake" });
  assertEquals([again.json.outcome, again.json.admits], ["lifted", true]);
  assertEquals((await call(A, "POST", `${CL}/tombstones/${le.json.tombstone_id}/lift`, { by: B })).status, 400, "a caller-supplied lifter is refused");
});

t("07-MULTI-USER: cleanup actions are their owner's - another user's by id is 404, never listed, never named in a shared row", async () => {
  const s = await newSource("owner");
  await suppress(s);
  const bs = await call(B, "POST", `${CL}/sources/${s}/sever`, { all: true });
  assertEquals(bs.status, 200, bs.text);
  const be = await call(B, "POST", `${CL}/sources/${s}/erase`, { reason_type: "deliberate" });
  assertEquals(be.status, 200, be.text);
  const bRun = await call(B, "POST", `${CL}/process-all`, { reason_type: "deliberate", source_ids: [crypto.randomUUID()] });
  assertEquals(bRun.status, 200, bRun.text);
  const bIds = [bs.json.action.id, be.json.action.id, bRun.json.action.id];
  for (const id of bIds) {
    const asA = await call(A, "GET", `${CL}/actions/${id}`);
    assertEquals(asA.status, 404, `A reads B's action ${id}: ${asA.text}`);
    assertEquals(asA.text.includes(B), false);
    assertEquals((await call(B, "GET", `${CL}/actions/${id}`)).status, 200, "B reads its own");
  }
  const aList = await call(A, "GET", `${CL}/actions?limit=200`);
  assertEquals(bIds.some((id) => aList.text.includes(id)) || aList.text.includes(B), false, "A's action list holds nothing of B's");
  const bList = await call(B, "GET", `${CL}/actions?limit=200`);
  assert(bIds.every((id) => bList.text.includes(id)), "B lists its own actions");
  // the stored owner is the seam's subject; no shared row names B
  const [own] = await sql<{ owner_sub: string; actor_sub: string }>(`SELECT owner_sub, actor_sub FROM public.cleanup_actions WHERE id = $1`, [be.json.action.id]);
  assertEquals([own.owner_sub, own.actor_sub], [B, B]);
  const shared = await sql<{ n: number }>(
    `SELECT (SELECT count(*) FROM public.source_trail_events WHERE actor = $1 OR detail::text LIKE '%' || $1 || '%')
          + (SELECT count(*) FROM public.source_tombstones WHERE $1 IN (coalesce(eraser_user, ''), coalesce(lifted_by, ''), coalesce(batch_run_id, ''))
                                                              OR original_context::text LIKE '%' || $1 || '%') AS n`, [B]);
  assertEquals(Number(shared[0].n), 0, "no shared D5 row carries B's subject");
  // a non-uuid action id is a plain 404, not a database error
  assertEquals((await call(A, "GET", `${CL}/actions/not-an-id`)).status, 404);
});

Deno.test({ name: "close the pool", ignore, fn: async () => { await pool!.end(); }, sanitizeOps: false, sanitizeResources: false });
