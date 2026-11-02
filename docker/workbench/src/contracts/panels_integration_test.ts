// deno test src/contracts/panels_integration_test.ts - research-workbench P8a-1 (rw-p8a1-core): the reads the
// timeline, trail and page graph panels stand on, over a REAL database through a running :wt workbench.
//
// SKIPPED unless PANELS_TEST_BASE (the lab workbench) and CONTRACT_TEST_DB_HOST (its DISPOSABLE database) are
// set - contract-test/run-panels-tests.ps1 sets both. Never point it at a live stack: it plants rows.
// Identity: the lab runs the workbench with WORKSPACE_IDENTITY_HEADER=X-Test-Sub, so a request names its user.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";
import * as K from "./schemas/knowledge.ts";
import * as S from "./schemas/sources.ts";

const BASE = (Deno.env.get("PANELS_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("DOCS_TEST_KEY") ?? "";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const SUB_HEADER = Deno.env.get("DOCS_TEST_SUB_HEADER") ?? "X-Test-Sub";
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 2, true)
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
async function call(method: string, path: string, sub: string, body?: unknown) {
  const r = await fetch(BASE + "/workbench/contract" + path, {
    method, headers: { "content-type": "application/json", "x-brain-key": KEY, [SUB_HEADER]: sub },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  return { status: r.status, json, text };
}
const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const uuid = () => crypto.randomUUID();

// ── one world for every case ──────────────────────────────────────────────────────────────────
const W = (() => {
  const r = rnd();
  return {
    r, subA: `panels-a-${r}`, subB: `panels-b-${r}`,
    active: uuid(), suppressed: uuid(), erased: uuid(), tomb: uuid(), held: uuid(),
    jobA: uuid(), jobB: uuid(), lead: uuid(), leadPath: uuid(), leadB: uuid(), eventB: `evB${r}`,
    urlActive: `https://example.org/p8a1/${r}/active`, urlSuppressed: `https://example.org/p8a1/${r}/suppressed`,
    urlErased: `https://example.org/p8a1/${r}/erased`, urlLead: `https://example.org/p8a1/${r}/lead`,
    urlB: `https://example.org/p8a1/${r}/LeadSecretB`, root: `content/tool/p8a1-${r}`, claim: uuid(),
  };
})();
let planted = false;
async function plant() {
  if (planted) return;
  planted = true;
  await sql(`INSERT INTO public.sources (id, url, title, content) VALUES ($1, $2, 'P8a1 active', 'x'), ($3, $4, 'P8a1 suppressed', 'y')`,
    [W.active, W.urlActive, W.suppressed, W.urlSuppressed]);
  await sql(`UPDATE public.sources SET retracted_at = now(), retraction_committed_at = now(), retracted_by = 'p8a1',
               suppression_reason = 'p8a1 suppressed on purpose' WHERE id = $1`, [W.suppressed]);
  await sql(`INSERT INTO public.source_tombstones (id, source_id, url, url_key, title, reason_type, note, eraser_kind, eraser_user)
             VALUES ($1, $2, $3, public.contract_url_key($3), 'P8a1 erased', 'deliberate', 'p8a1 tombstone note', 'user', $4)`,
    [W.tomb, W.erased, W.urlErased, W.subA]); // round 3: user A erased it (the lift rule)
  // the page graph: a root linking both leaf pages; a contradicted claim grounded in the active source
  await sql(`INSERT INTO public.wiki_pages (slug, page_class, entity_type, title, body, links) VALUES
               ($1, 'entity', 'tool', 'P8a1 root', 'root', $2::jsonb), ($3, 'source', NULL, 'P8a1 active leaf', 'leaf', '[]'),
               ($4, 'source', NULL, 'P8a1 suppressed leaf', 'leaf', '[]')`,
    [W.root, JSON.stringify([`content/source/${W.active}`, `content/source/${W.suppressed}`]), `content/source/${W.active}`, `content/source/${W.suppressed}`]);
  // contested by a contradicts edge (claims.contradicted itself is recomputed from the edges by claim_confidence)
  await sql(`INSERT INTO public.claims (id, text, epistemic_tag) VALUES ($1, 'P8a1 contested claim', 'sourced')`, [W.claim]);
  await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $2, 'contradicts')`, [W.claim, W.active]);
  // two users' research jobs (their original prompts record the owner)
  for (const [job, sub] of [[W.jobA, W.subA], [W.jobB, W.subB]]) {
    await sql(`INSERT INTO public.research_jobs (id, status, origin, query) VALUES ($1, 'done', 'workspace', 'p8a1 question')`, [job]);
    await sql(`INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, $2, $2, 'p8a1 question')`, [job, sub]);
  }
  // P3a: A's lead and the found_via path it opened to the active source; B's lead (a marker URL)
  const adm = `INSERT INTO public.research_admission_trail (id, job_id, url, url_key, kind, claim_kind, family, score, floor, model_version, reasons, found_via, path, source_id)
               VALUES ($1, $2, $3, public.contract_url_key($3), $4, 'general', 'general', $5, 0.4, 'd15', $6::jsonb, $7, $8::jsonb, $9)`;
  await sql(adm, [W.lead, W.jobA, W.urlLead, "lead", 0.2, JSON.stringify(["below floor"]), null, "[]", null]);
  await sql(adm, [W.leadPath, W.jobA, W.urlActive, "lead_path", 0.7, JSON.stringify(["reached through a lead"]), W.lead,
    JSON.stringify([{ kind: "lead", url: W.urlLead }, { kind: "lead_path", url: W.urlActive }]), W.active]);
  await sql(adm, [W.leadB, W.jobB, W.urlB, "lead", 0.1, JSON.stringify(["below floor"]), null, "[]", null]);
  // P4a: the per-source events (A's carries the lead_path entry's id; B's a marker URL)
  const ev = `INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, trail, payload) VALUES ($1, $1, 'source', 'due_process', $2::jsonb, $3::jsonb)`;
  await sql(ev, [W.jobA, JSON.stringify({ id: W.leadPath, url: W.urlActive, kind: "lead_path", score: 0.7, floor: 0.4, family: "general", reasons: ["reached through a lead"], found_via: W.lead, path: [] }), JSON.stringify({ url: W.urlActive, outcome: "lead_path" })]);
  await sql(ev, [W.jobB, JSON.stringify({ id: W.eventB, url: W.urlB, kind: "lead", score: 0.1, floor: 0.4, family: "general", reasons: [], found_via: null, path: [] }), JSON.stringify({ url: W.urlB, outcome: "lead" })]);
}

// ── T2: the trail carries P4a's per-source events and P3a's lead entries ─────────────────────────
t("T2 trail: P3a's lead entry and its found_via path (origin admission) and P4a's per-source event (origin session)", async () => {
  await plant();
  const r = await call("GET", `/trail?limit=500`, W.subA);
  assertEquals(r.status, 200, r.text);
  assert(K.Trail.safeParse(r.json).success, "the answer validates against Trail");
  const leads = r.json.leads as any[];
  const adm = leads.filter((l) => l.origin === "admission" && [W.lead, W.leadPath].includes(l.id));
  assertEquals(adm.length, 2, `A's lead and its lead_path entry (${JSON.stringify(leads).slice(0, 400)})`);
  const path = adm.find((l) => l.id === W.leadPath);
  assertEquals(path.found_via, W.lead);
  assertEquals(path.stage, "lead_path");
  assertEquals(path.path.length, 2, "the found_via path is carried");
  assertEquals(path.source_id, W.active);
  assertEquals(path.lifecycle, "active");
  const ses = leads.filter((l) => l.origin === "session" && l.job_id === W.jobA);
  assertEquals(ses.length, 1, "A's per-source session event");
  assertEquals(ses[0].id, W.leadPath);
  assertEquals(ses[0].source_id, W.active, "a session event names the source its admission entry became");
  assert(leads.every((l) => l.counts_as_evidence === false));
  // scoped to the active source: its own entries and the lead it was found via
  const s = await call("GET", `/trail?source_id=${W.active}&limit=500`, W.subA);
  const ids = new Set((s.json.leads as any[]).map((l) => `${l.origin}:${l.id}`));
  assert(ids.has(`admission:${W.leadPath}`) && ids.has(`admission:${W.lead}`) && ids.has(`session:${W.leadPath}`), [...ids].join(" "));
});

// ── multi-user: another user's research tree withholds its lead entries ──────────────────────────
t("T7 trail: user A never sees user B's lead entries or per-source events; B sees their own", async () => {
  await plant();
  const a = await call("GET", `/trail?limit=500`, W.subA);
  assert(!a.text.includes("LeadSecretB") && !a.text.includes(W.eventB) && !a.text.includes(W.jobB), "A sees nothing of B's tree");
  const b = await call("GET", `/trail?limit=500`, W.subB);
  assert(b.text.includes("LeadSecretB") && b.text.includes(W.eventB), "B sees their own lead and event");
  assert(!b.text.includes(W.urlLead) && !b.text.includes(W.jobA), "B does not see A's lead entries");
});

// ── T3: a tombstone opens from the trail with link, reason and note, and lifts ───────────────────
t("T3 trail: an erased entry names its tombstone; the tombstone has link, reason and note; lift works", async () => {
  await plant();
  const r = await call("GET", `/trail?source_id=${W.erased}`, W.subA);
  const e = (r.json.entries as any[]).find((x) => x.kind === "erased");
  assert(e, r.text);
  assertEquals(e.tombstone_id, W.tomb);
  assertEquals(e.reason, "deliberate");
  assertEquals(e.lifecycle, "erased");
  const tb = await call("GET", `/tombstones/${e.tombstone_id}`, W.subA);
  assertEquals(tb.status, 200, tb.text);
  assert(S.Tombstone.safeParse(tb.json).success);
  assertEquals([tb.json.url, tb.json.reason_type, tb.json.note], [W.urlErased, "deliberate", "p8a1 tombstone note"]);
  const lift = await call("POST", `/tombstones/${W.tomb}/lift`, W.subA, { by: "p8a1-tester", note: "lifted in the lab" });
  assertEquals(lift.status, 200, lift.text);
  assert(lift.json.lifted_at, "lifted");
});

// ── T4: the lifecycle state rides with every read a panel lists sources from ─────────────────────
t("T4 states: trail, timeline, neighbours and source-states carry the lifecycle state", async () => {
  await plant();
  const tr = await call("GET", `/trail?source_id=${W.suppressed}`, W.subA);
  const sup = (tr.json.entries as any[]).find((x) => x.kind === "suppressed");
  assertEquals(sup?.lifecycle, "suppressed", `trail: ${tr.text.slice(0, 600)}`);
  await sql(`INSERT INTO public.source_revisions (source_id, revision, content, title, edited_by) VALUES ($1, 1, 'y', 'P8a1 suppressed', 'p8a1')
             ON CONFLICT DO NOTHING`, [W.suppressed]);
  const tl = await call("GET", `/timeline?source_id=${W.suppressed}&limit=50`, W.subA);
  assertEquals(tl.status, 200, tl.text);
  assert(K.Timeline.safeParse(tl.json).success);
  const ev = (tl.json.events as any[]).find((x) => x.kind === "source_revision");
  assertEquals([ev?.source_id, ev?.lifecycle], [W.suppressed, "suppressed"], `timeline: ${tl.text.slice(0, 600)}`);
  const nb = await call("GET", `/neighbours?id=${encodeURIComponent(W.root)}&depth=1`, W.subA);
  assertEquals(nb.status, 200, nb.text);
  assert(K.Neighbours.safeParse(nb.json).success);
  const node = (id: string) => (nb.json.nodes as any[]).find((n) => n.id === `content/source/${id}`);
  assertEquals([node(W.active)?.lifecycle, node(W.active)?.contested], ["active", true], `neighbours: ${nb.text.slice(0, 800)}`);
  assertEquals([node(W.suppressed)?.lifecycle, node(W.suppressed)?.contested], ["suppressed", false], `neighbours: ${nb.text.slice(0, 800)}`);
  assertEquals((nb.json.nodes as any[]).find((n) => n.id === W.root)?.lifecycle, null, "a page that is no source has none");
  const st = await call("POST", `/source-states`, W.subA, { ids: [W.active, W.suppressed, W.erased, uuid()], urls: [W.urlSuppressed, W.urlErased, "https://example.org/never"] });
  assertEquals(st.status, 200, st.text);
  assert(K.SourceStates.safeParse(st.json).success);
  assertEquals(st.json.by_id[W.suppressed].lifecycle, "suppressed");
  assertEquals(st.json.by_id[W.active].lifecycle, "active");
  assertEquals(st.json.by_id[W.erased].lifecycle, "erased");
  assertEquals(st.json.by_id[W.erased].tombstone_id, W.tomb);
  assertEquals(Object.keys(st.json.by_id).length, 3, "an unknown id is absent");
  assertEquals(st.json.by_url[W.urlSuppressed].id, W.suppressed);
  assertEquals(st.json.by_url[W.urlErased].lifecycle, "erased");
  assertEquals(st.json.by_url["https://example.org/never"], undefined);
  // under a metadata filter the batch answers nothing (fail closed)
  const f = await call("POST", `/source-states?metadata_filter=${encodeURIComponent('{"share":"cloud"}')}`, W.subA, { ids: [W.active] });
  assertEquals(f.json, { by_id: {}, by_url: {} });
});

t("T4 states: a held source is never answered by source-states (per refinery; never a hint)", async () => {
  await plant();
  // round 2 (tester t-p8a1-core): the case plants its own held source - in its own refinery (an idea of user B) -
  // instead of depending on the fixtures
  const idea = uuid();
  await sql(`INSERT INTO public.ideas (id, title, owner_sub) VALUES ($1, 'P8a1 held probe', $2)`, [idea, W.subB]);
  await sql(`INSERT INTO public.held_sources (id, refinery_id, url, title, content, content_type) VALUES ($1, $2, $3, 'P8a1 held', 'held text', 'manual')`,
    [W.held, idea, `https://example.org/p8a1/${W.r}/held`]);
  for (const sub of [W.subA, W.subB]) {
    const st = await call("POST", `/source-states`, sub, { ids: [W.held, W.held.toUpperCase()], urls: [`https://example.org/p8a1/${W.r}/held`] });
    assertEquals(st.status, 200, st.text);
    assertEquals([st.json.by_id, st.json.by_url], [{}, {}], `held answered for ${sub}: ${st.text}`);
  }
});

// round 2 (tester t-p8a1-core D1): a source's leaf page is a page hit of search, with its source's state
t("T4 states: search answers a source's leaf page with its source's lifecycle (pages that are no source: null)", async () => {
  await plant();
  const r = await call("GET", `/search?q=${encodeURIComponent("P8a1 suppressed leaf")}&kinds=page&limit=50`, W.subA);
  assertEquals(r.status, 200, r.text);
  const hit = (r.json.results as any[]).find((h) => h.id === `content/source/${W.suppressed}`);
  assertEquals(hit?.lifecycle, "suppressed", r.text.slice(0, 600));
  const root = await call("GET", `/search?q=${encodeURIComponent("P8a1 root")}&kinds=page&limit=50`, W.subA);
  assertEquals((root.json.results as any[]).find((h) => h.id === W.root)?.lifecycle, null, root.text.slice(0, 600));
});

// ── T8 (round 3, operator decision 2026-11-02): only the user who erased a tombstone, or an admin, lifts it ──
t("T8 lift: the eraser lifts (the actor is the identity seam's, never the body's `by`); another user gets 403; an automation's needs an admin", async () => {
  await plant();
  const mine = uuid(), auto = uuid();
  const ins = `INSERT INTO public.source_tombstones (id, source_id, url, url_key, title, reason_type, eraser_kind, eraser_user)
               VALUES ($1, $2, $3, public.contract_url_key($3), 'P8a1 lift probe', 'deliberate', $4, $5)`;
  await sql(ins, [mine, uuid(), `https://example.org/p8a1/${W.r}/lift-mine`, "user", W.subA]);
  await sql(ins, [auto, uuid(), `https://example.org/p8a1/${W.r}/lift-auto`, "automation", null]);
  // the read says who may lift
  assertEquals((await call("GET", `/tombstones/${mine}`, W.subA)).json.may_lift, true);
  assertEquals((await call("GET", `/tombstones/${mine}`, W.subB)).json.may_lift, false);
  // another user: 403, nothing lifted - even naming the eraser in `by`
  const b = await call("POST", `/tombstones/${mine}/lift`, W.subB, { by: W.subA, note: "not mine" });
  assertEquals(b.status, 403, b.text);
  assertEquals((await sql<{ l: string | null }>(`SELECT lifted_at::text AS l FROM public.source_tombstones WHERE id = $1`, [mine]))[0].l, null);
  // the eraser: lifted, and lifted_by is the seam's actor, not the body's
  const a = await call("POST", `/tombstones/${mine}/lift`, W.subA, { by: "ForgedLifter", note: "mine" });
  assertEquals(a.status, 200, a.text);
  assertEquals(a.json.lifted_by, W.subA);
  assert(!a.text.includes("ForgedLifter"));
  const ev = await sql<{ actor: string }>(`SELECT actor FROM public.source_trail_events WHERE kind = 'lifted' AND detail ->> 'tombstone_id' = $1`, [mine]);
  assertEquals(ev.map((e) => e.actor), [W.subA]);
  // without `by` at all: still fine (it is ignored); an automation's tombstone is an admin's to lift
  const au = await call("POST", `/tombstones/${auto}/lift`, W.subA, {});
  assertEquals(au.status, 403, au.text);
});

t("T8 erase: a user's erasure records the identity seam's subject as its eraser, never the body's user", async () => {
  await plant();
  const id = uuid();
  await sql(`INSERT INTO public.sources (id, url, title, content, retracted_at, retraction_committed_at, unlinked_at, retracted_by)
             VALUES ($1, $2, 'P8a1 erase probe', 'e', now(), now(), now(), 'p8a1')`, [id, `https://example.org/p8a1/${W.r}/erase-probe`]);
  const r = await call("POST", `/sources/${id}/erase`, W.subA, { reason_type: "deliberate", eraser: { kind: "user", user: "SomeoneElse" } });
  assertEquals(r.status, 200, r.text);
  assertEquals(r.json.tombstone.eraser_user, W.subA);
  // so the eraser may lift it, and user B may not
  assertEquals((await call("POST", `/tombstones/${r.json.tombstone.id}/lift`, W.subB, {})).status, 403);
  assertEquals((await call("POST", `/tombstones/${r.json.tombstone.id}/lift`, W.subA, {})).status, 200);
});
