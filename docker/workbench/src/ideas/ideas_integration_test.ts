// deno test src/ideas/ideas_integration_test.ts - the ideas panel's and the refinery view's back end (research-workbench
// rw-p8a4-ideas, D17 items 5-6, the D17 archive, the ingestion model's user source list, 07-MULTI-USER) over a REAL
// workbench and database.
//
// SKIPPED unless DOCS_TEST_BASE is set. contract-test/run-workspace-tests.ps1 [5h] runs it on a DISPOSABLE internal
// network (the real initdb chain incl. slot 370, fixtures.sql, a stub embedder and research service). Two users act
// through the lab's identity header (WORKSPACE_IDENTITY_HEADER=X-Test-Sub). The app role's own view of the database
// (what openbrain-mcp and the idea refinery run as: ob_app_memory) is taken with SET LOCAL ROLE on the superuser
// connection. Never point it at a live stack.
// Environment: DOCS_TEST_BASE, DOCS_TEST_KEY, CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser).
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("DOCS_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("DOCS_TEST_KEY") ?? "";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const APP_ROLE = Deno.env.get("IDEAS_TEST_APP_ROLE") ?? "ob_app_memory";
const VAULT = Deno.env.get("DOCS_TEST_VAULT") ?? "";
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 3, true)
  : null;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });

const rnd = () => crypto.randomUUID().slice(0, 8);
const A = { "X-Test-Sub": `ideas-a-${rnd()}` };
const B = { "X-Test-Sub": `ideas-b-${rnd()}` };
const sub = (u: Record<string, string>) => u["X-Test-Sub"];
const FX = { active: "11111111-1111-4111-8111-111111111111", synthesis: "77777777-7777-4777-8777-777777777777" };

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}

// as the app role (openbrain-mcp, the idea refinery, the workbench): the production shape the write guard judges
async function asApp<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    await c.queryObject("BEGIN");
    await c.queryObject(`SET LOCAL ROLE ${APP_ROLE}`);
    const rows = (await c.queryObject<T>(text, args)).rows;
    await c.queryObject("COMMIT");
    return rows;
  } catch (e) {
    try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
    throw e;
  } finally {
    c.release();
  }
}
// several statements in ONE app-role transaction (the tester's G4b shape); "" = all accepted, else the refusal code
async function refusedAsAppTx(steps: [string, unknown[]][]): Promise<string> {
  const c = await pool!.connect();
  try {
    await c.queryObject("BEGIN");
    await c.queryObject(`SET LOCAL ROLE ${APP_ROLE}`);
    for (const [text, args] of steps) await c.queryObject(text, args);
    await c.queryObject("COMMIT");
    return "";
  } catch (e) {
    try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
    return String((e as { fields?: { code?: string } }).fields?.code ?? (e as Error).message);
  } finally {
    c.release();
  }
}
const refusedAsApp = async (text: string, args: unknown[] = []) => {
  try {
    await asApp(text, args);
    return "";
  } catch (e) {
    return String((e as { fields?: { code?: string } }).fields?.code ?? (e as Error).message);
  }
};

async function call(method: string, path: string, body?: unknown, who: Record<string, string> = A) {
  const r = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json", "x-brain-key": KEY, ...who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

// a captured idea (what capture_idea writes: the row + revision 1, under its owner); the capture trigger queues research
async function captured(owner: string, title: string, summary = `${title} statement`) {
  // exactly what capture_idea now does: idea_capture() as the app role - the idea and its PRIVATE revision 1, no thought
  const rows = await asApp<{ id: string }>(
    `SELECT public.idea_capture($1, 'service:openbrain-mcp', $2, $3, NULL, $4)::text AS id`,
    [owner, title, summary, `[${Array(1024).fill(0.01).join(",")}]`],
  );
  return rows[0].id;
}

// a user document carrying an idea, its refinery started (P2b)
async function docRefinery(who: Record<string, string>, idea: string) {
  const made = await call("POST", "/workbench/documents", { title: `doc ${rnd()}`, idea }, who);
  assertEquals(made.status, 201, made.text);
  const st = await call("POST", "/workbench/documents/refinery/start", { path: made.json.path }, who);
  assertEquals(st.status, 200, st.text);
  return { path: made.json.path as string, id: st.json.refinery_id as string };
}

const idea = async (id: string, who = A) => await call("GET", `/workbench/contract/ideas/${id}`, undefined, who);
const ideaRow = async (id: string) =>
  (await sql<{ title: string; summary: string; status: string; current_revision: number; metadata: any; updated_at: Date }>(
    `SELECT title, summary, status, current_revision, metadata, updated_at FROM public.ideas WHERE id = $1`, [id]))[0];

// ── acceptance 1 (D17 item 5): the ideas panel and the idea view ─────────────────────────────────────────────
t("I1: ideas() lists by state incl. dormant and resurfaced, with last session and dossier date", async () => {
  const live = await captured(sub(A), `live ${rnd()}`);
  const parked = await captured(sub(A), `parked ${rnd()}`);
  await sql(`UPDATE public.ideas SET status = 'dormant', dormant_at = now() - interval '1 day' WHERE id = $1`, [parked]);
  // the refinery's cross-link (IR section 8) stamps the same owner's parked idea
  const near = await asApp<{ id: string }>(`SELECT id::text AS id FROM public.idea_resurface($1::uuid, 0.5, 2)`, [live]);
  assert(near.some((n) => n.id === parked), "the parked idea resurfaced");
  await asApp(`SELECT public.idea_deliver_dossier($1::uuid, $2, 'a dossier', '{}'::jsonb)`, [live, crypto.randomUUID()]);
  const l = await call("GET", "/workbench/contract/ideas?limit=200");
  assertEquals(l.status, 200, l.text);
  const byId = new Map(l.json.ideas.map((i: any) => [i.id, i]));
  const L: any = byId.get(live), P: any = byId.get(parked);
  assert(L && P, "both of A's ideas are listed");
  // rw-boundary-ideas (slot 580): the capture queues a private hand-back (no job until the research service forms a
  // de-personalised question from it) - its revision is marked, and the dossier dates the idea
  assertEquals((await sql<{ q: boolean }>(`SELECT coalesce(metadata ? 'research_handback', false) AS q FROM public.idea_revisions WHERE idea_id = $1 AND revision = 1`, [live]))[0].q, true,
    "the capture queued the idea's research (a pending hand-back)");
  assertNotEquals(L.dossier_at, null, "the dossier delivered into its room dates it");
  assertEquals([P.status, P.resurfaced_at !== null], ["dormant", true]);
  assertEquals(L.resurfaced_at, null);
});

t("I2: idea(id) shows its revisions, dossier, draft, every session and its ONE room; dossiers of every session land in that room", async () => {
  const id = await captured(sub(A), `room ${rnd()}`);
  const j1 = crypto.randomUUID(), j2 = crypto.randomUUID();
  const d1 = await asApp<{ o: any }>(`SELECT public.idea_deliver_dossier($1::uuid, $2, 'first dossier', '{}'::jsonb) AS o`, [id, j1]);
  const d2 = await asApp<{ o: any }>(`SELECT public.idea_deliver_dossier($1::uuid, $2, 'second dossier', '{}'::jsonb) AS o`, [id, j2]);
  assertEquals([d1[0].o.outcome, d2[0].o.outcome], ["delivered", "delivered"], "I2 line 126");
  assertEquals(d1[0].o.room_id, d2[0].o.room_id, "an idea whose sessions span more than one room FAILS");
  const again = await asApp<{ o: any }>(`SELECT public.idea_deliver_dossier($1::uuid, $2, 'first dossier', '{}'::jsonb) AS o`, [id, j1]);
  assertEquals(again[0].o.outcome, "already", "a retried delivery adds nothing");
  assertEquals((await sql(`SELECT 1 FROM public.workspace_rooms WHERE subject_kind = 'idea' AND subject_id = $1`, [id])).length, 1, "I2 line 130");
  const dr = await call("PUT", `/workbench/ideas/${id}/draft`, { text: "the accreting draft" });
  assertEquals(dr.status, 200, dr.text);
  const ed = await call("POST", `/workbench/ideas/${id}/edit`, { summary: "a sharper statement" });
  assertEquals(ed.status, 200, ed.text);
  const r = await idea(id);
  assertEquals(r.status, 200, r.text);
  assertEquals(r.json.revisions.map((x: any) => x.revision), [1, 2], "I2 line 137");
  assertEquals([r.json.room.state, r.json.room.room_id, r.json.room.dossiers], ["current", d1[0].o.room_id, 2], "I2 line 138");
  assertEquals(r.json.refinery.members.room, d1[0].o.room_id, "I2 line 139");
  assertEquals([r.json.draft.state, r.json.draft.text], ["current", "the accreting draft"], "I2 line 140");
  // rw-boundary-ideas round 2 (tester T5): with slot 580 a capture or an edit makes NO job - it queues one private
  // hand-back (the edit folds onto it) and the research service's drain forms the de-personalised question later. So
  // before the drain the idea has no session, and exactly one pending hand-back on the latest revision ...
  assertEquals(r.json.sessions.length, 0, "no session before the drain (580: the capture queues a hand-back, not a job)");
  assert(r.json.revisions.every((v: any) => !v.research_job_id), "no revision names a job before the drain");
  // (read through the owner's review function, as the app role: 420's static check keeps the table's name to its list)
  const pend = await asApp<{ id: string; revision: number; state: string }>(
    `SELECT handback_id::text AS id, revision, state FROM public.idea_handback_review($1, $2::uuid)`, [sub(A), id]);
  assertEquals(pend.map((h) => [h.state, h.revision]), [["pending", 2]], "one pending hand-back, on the edited revision");
  // ... then the drain's outcome, as the research service settles it (a queued DERIVED job, stamped on the idea)
  const STAMP = JSON.stringify({ version: "pd0b-2", lexicon: "a".repeat(64), verdict_id: "b".repeat(64), evidence: [] });
  const job = (await sql<{ id: string }>(`INSERT INTO public.research_jobs (status, origin, caller, query, anchor, options, request_kind, boundary)
     VALUES ('queued', 'manual', 'boundary', 'What is known about room designs?', 'What is known about room designs?', '{"public_links":[],"queue_origin":"manual"}'::jsonb, 'derived', $1::jsonb) RETURNING id::text AS id`, [STAMP]))[0].id;
  const settled = await asApp<{ ok: boolean }>(`SELECT public.idea_handback_settle($1::uuid, 2, $2::uuid, 'queued', '{}'::jsonb, NULL) AS ok`, [pend[0].id, job]);
  assertEquals(settled[0].ok, true, "the drain settles the pending hand-back");
  // every session it spun off: after the drain the stamped derived job is listed, once, and the revision names it
  const after = await idea(id);
  assertEquals(after.status, 200, after.text);
  assertEquals(after.json.sessions.map((x: any) => x.id), [job], "the drained job is the idea's one session");
  assertEquals(after.json.revisions.map((v: any) => v.research_job_id ?? null), [null, job], "revision 2 (the one the question was formed from) names it");
  const sess = new Set(after.json.sessions.map((x: any) => x.id));
  assert(after.json.revisions.every((v: any) => !v.research_job_id || sess.has(v.research_job_id)), "every session it spun off");
  const rm = await call("GET", `/workbench/rooms/${d1[0].o.room_id}`);
  assertEquals(rm.json.entries.filter((e: any) => e.kind === "dossier").map((e: any) => e.body), ["first dossier", "second dossier"], "I2 line 143");
});

t("I3: edit goes through idea_edit(); identical text is unchanged; an edit that bypasses the function FAILS (the app role is refused)", async () => {
  const id = await captured(sub(A), `edit ${rnd()}`, "the first text");
  const same = await call("POST", `/workbench/ideas/${id}/edit`, { summary: "the first text" });
  assertEquals([same.status, same.json.outcome], [200, "unchanged"]);
  const ch = await call("POST", `/workbench/ideas/${id}/edit`, { summary: "the second text", title: "renamed" });
  assertEquals([ch.status, ch.json.outcome, ch.json.revision], [200, "changed", 2]);
  const row = await ideaRow(id);
  assertEquals([row.summary, row.title, row.current_revision, row.status], ["the second text", "renamed", 2, "dirty"]);
  const rev = (await sql<{ handback: string | null; thought_id: string | null }>(
    `SELECT metadata ->> 'research_handback' AS handback, thought_id::text AS thought_id FROM public.idea_revisions WHERE idea_id = $1 AND revision = 2`, [id]))[0];
  // rw-boundary-ideas (slot 580): queued as a private hand-back; the job id is stamped when the boundary forms it
  assertNotEquals(rev.handback, null, "the revision is queued for research by the database");
  // operator 2026-11-02 (ideas are completely user isolated): no corpus thought; the revision is its owner's private one
  assertEquals(rev.thought_id, null, "no thought in the shared corpus");
  assertEquals((await sql<{ p: string }>(`SELECT private_owner AS p FROM public.idea_revisions WHERE idea_id = $1 AND revision = 2`, [id]))[0].p, sub(A));
  // the bypasses, as the app role every service runs as
  assertEquals(await refusedAsApp(`UPDATE public.ideas SET summary = 'bypass' WHERE id = $1`, [id]), "42501");
  assertEquals(await refusedAsApp(`UPDATE public.ideas SET title = 'bypass' WHERE id = $1`, [id]), "42501");
  assertEquals(await refusedAsApp(`INSERT INTO public.idea_revisions (idea_id, revision, summary) VALUES ($1, 3, 'bypass')`, [id]), "42501");
  assertEquals((await ideaRow(id)).summary, "the second text");
  // what the guard leaves open: the refinery's own lifecycle writes (status, delivery) still work
  assertEquals(await refusedAsApp(`UPDATE public.ideas SET status = 'researched', thread_root = 'r1' WHERE id = $1`, [id]), "");
});

t("I4: a promotion the refinery performs on its own FAILS; an MCP idea tool's function call for another owner's idea writes nothing", async () => {
  const id = await captured(sub(A), `mcp ${rnd()}`, "owned by A");
  assertEquals(await refusedAsApp(`UPDATE public.ideas SET status = 'promoted' WHERE id = $1`, [id]), "42501");
  // the SQL functions the MCP tools call, with ANOTHER owner (B) - as the app role, the tools' own role
  const e = await asApp<{ o: any }>(`SELECT public.idea_edit($1::uuid, $2, 'service:mcp', 'B rewrites it', NULL, NULL, NULL) AS o`, [id, sub(B)]);
  const r = await asApp<{ o: any }>(`SELECT public.idea_research($1::uuid, $2, 'service:mcp') AS o`, [id, sub(B)]);
  const p = await asApp<{ o: any }>(`SELECT public.idea_promote($1::uuid, $2, 'service:mcp', 'documents/x.md') AS o`, [id, sub(B)]);
  assertEquals([e[0].o.outcome, r[0].o.outcome, p[0].o.outcome], ["not_found", "not_found", "not_found"]);
  // a blank owner is nobody's
  const blank = await asApp<{ o: any }>(`SELECT public.idea_edit($1::uuid, '', 'x', 'y', NULL, NULL, NULL) AS o`, [id]);
  assertEquals(blank[0].o.outcome, "not_found");
  const row = await ideaRow(id);
  assertEquals([row.summary, row.current_revision, row.status], ["owned by A", 1, "new"]);
  // the owner itself, through the same function the tool calls: it changes (the tools' path is the workspace's)
  const own = await asApp<{ o: any }>(`SELECT public.idea_edit($1::uuid, $2, 'service:mcp', 'A refines it', NULL, NULL, NULL) AS o`, [id, sub(A)]);
  assertEquals(own[0].o.outcome, "changed");
  // promote needs the idea's own tethered document: none here
  const nd = await asApp<{ o: any }>(`SELECT public.idea_promote($1::uuid, $2, 'service:mcp', 'documents/none.md') AS o`, [id, sub(A)]);
  assertEquals(nd[0].o.outcome, "no_document");
});

t("I5: research now is idea_research() for the owner (202 + a queued request); another user's idea 404", async () => {
  const id = await captured(sub(A), `now ${rnd()}`);
  const r = await call("POST", `/workbench/ideas/${id}/research-now`, {});
  assertEquals([r.status, r.json.outcome], [202, "queued"]);
  // rw-boundary-ideas (slot 580): a private hand-back, never a job carrying the idea (its id or its text)
  const st = await sql<{ handback_id: string; state: string }>(`SELECT handback_id::text, state FROM public.idea_handback_review($1, $2::uuid)`, [sub(A), id]);
  assertEquals([st[0]?.handback_id, st[0]?.state], [r.json.request_id, "pending"]);
  assertEquals((await sql(`SELECT 1 FROM public.research_jobs WHERE refinery_id = $1`, [id])).length, 0, "no job names the idea");
  // the older idea-schedule door is the same function
  const s = await call("POST", `/workbench/idea-schedule/research-now/${id}`, {});
  assertEquals(s.status, 200, s.text);
  // reviewer R4-2: it answers the queued request's id (no job_id: slot 580 makes no job here)
  assertEquals([s.json.queued, /^[0-9a-f-]{36}$/.test(String(s.json.request_id)), "job_id" in s.json], [true, true, false], s.text);
  assertEquals((await call("POST", `/workbench/ideas/${id}/research-now`, {}, B)).status, 404);
  assertEquals((await call("POST", `/workbench/idea-schedule/research-now/${id}`, {}, B)).status, 404);
});

t("I6: create document = the P2b seed: once, the idea promoted with the pointer; thereafter go to document", async () => {
  const id = await captured(sub(A), `seed ${rnd()}`, "seed me");
  await call("PUT", `/workbench/ideas/${id}/draft`, { text: "DraftLine for the seed" });
  assertEquals((await call("POST", "/workbench/documents/seed", { idea_id: id }, B)).status, 404, "another user's idea seeds nothing");
  const s = await call("POST", "/workbench/documents/seed", { idea_id: id });
  assertEquals(s.status, 201, s.text);
  const row = await ideaRow(id);
  assertEquals([row.status, row.metadata?.promoted?.document_path], ["promoted", s.json.path]);
  const r = await idea(id);
  assertEquals(r.json.refinery.members.document.path, s.json.path);
  const file = await call("GET", `/workbench/documents/file?path=${encodeURIComponent(s.json.path)}`);
  assert(String(file.json.content).includes("DraftLine for the seed"), "the accreting draft seeds the document");
  const again = await call("POST", "/workbench/documents/seed", { idea_id: id });
  assertEquals([again.status, again.json.path], [409, s.json.path], "a second document for the same refinery FAILS: go to document");
  assertEquals((await sql(`SELECT 1 FROM public.user_document_listings WHERE refinery_id = $1`, [id])).length, 1);
});

// ── acceptance 2 (D17 item 6): the refinery view ──────────────────────────────────────────────────────────
t("I7: the refinery's members - every session, podcast and chat engaged from inside it plus its one document", async () => {
  const { path, id } = await docRefinery(A, `members ${rnd()}`);
  const now = await call("POST", `/workbench/ideas/${id}/research-now`, {});
  assertEquals(now.status, 202, now.text);
  const q = await call("POST", "/workbench/documents/research", { path, query: "a question from the document", kind: "research" });
  assertEquals(q.status, 202, q.text);
  const room = await call("POST", "/workbench/rooms", { subject_kind: "idea", subject_id: id });
  const team = `team-${rnd()}`;
  await sql(`INSERT INTO public.podcast_voice_links (id, owner_sub, route, voice) VALUES ($1, $2, 'local-tts', 'af_bella')`, [`${team}-v`, sub(A)]);
  await sql(`INSERT INTO public.podcast_presenters (id, owner_sub, name, voice_link_id) VALUES ($1, $2, 'P', $3)`, [`${team}-p`, sub(A), `${team}-v`]);
  await sql(`INSERT INTO public.podcast_teams (id, owner_sub, name) VALUES ($1, $2, 'T')`, [team, sub(A)]);
  await sql(`INSERT INTO public.podcast_team_members (team_id, position, presenter_id) VALUES ($1, 0, $2)`, [team, `${team}-p`]);
  const pod = await call("POST", "/workbench/contract/podcasts/requests",
    { team_id: team, title: "from the refinery", refinery_id: id, transcript: { title: "t", turns: [{ presenterId: `${team}-p`, text: "hi" }] } });
  assertEquals(pod.status, 202, pod.text);
  const m = (await idea(id)).json.refinery.members;
  // rw-boundary-ideas (slot 580): research now queues a private request (its derived job is stamped when formed)
  assert(now.json.request_id && m.sessions.includes(q.json.job_id), "a member missing after engagement FAILS (sessions)");
  assert(m.podcasts.includes(pod.json.id), "a member missing after engagement FAILS (podcast)");
  assert(m.chats.includes(room.json.room.id), "a member missing after engagement FAILS (chat)");
  assertEquals(m.document.path, path);
  // refinery sessions are ordinary sessions: they appear in the plain research home
  const home = await call("GET", "/workbench/contract/jobs?limit=200");
  assert(JSON.stringify(home.json).includes(q.json.job_id), "a session hidden from the research home FAILS");
  // B cannot engage A's refinery
  const podB = await call("POST", "/workbench/contract/podcasts/requests",
    { team_id: team, title: "x", refinery_id: id, transcript: { title: "t", turns: [{ presenterId: `${team}-p`, text: "hi" }] } }, B);
  assertEquals(podB.status, 404);
});

t("I8: hide/unhide narrows the refinery's own context only; search re-sorts a hidden source last with a tag, never excludes it", async () => {
  const one = await docRefinery(A, `hide ${rnd()}`);
  const two = await docRefinery(A, `other ${rnd()}`);
  const held = await call("POST", "/workbench/documents/user-sources", { path: one.path, title: `HideMe ${rnd()}`, content: "contract retrieval words to find" });
  assertEquals(held.status, 201, held.text);
  const hid = held.json.source.source_id;
  const before2 = await sql(`SELECT node_kind, node_ref FROM public.refinery_hidden WHERE refinery_id = $1`, [two.id]);
  const h = await call("POST", `/workbench/contract/ideas/${one.id}/hidden`, { node_kind: "source", node_ref: hid, hidden: true });
  assertEquals([h.status, h.json.hidden], [200, true]);
  const g = (await idea(one.id)).json.refinery.context_graph.nodes.find((n: any) => n.id === hid);
  assertEquals(g?.hidden, true);
  // nothing outside the refinery changes: the other refinery's hidden set and the source itself are untouched
  assertEquals(await sql(`SELECT node_kind, node_ref FROM public.refinery_hidden WHERE refinery_id = $1`, [two.id]), before2);
  assertEquals((await sql(`SELECT 1 FROM public.held_sources WHERE id = $1`, [hid])).length, 1);
  // search keeps a hidden (shared) source, last, tagged - in THIS refinery's document only
  await call("POST", `/workbench/contract/ideas/${one.id}/hidden`, { node_kind: "source", node_ref: FX.active, hidden: true });
  const c = await call("GET", `/workbench/documents/candidates?q=fixture&path=${encodeURIComponent(one.path)}`);
  assertEquals(c.status, 200, c.text);
  const list = c.json.candidates as any[];
  const at = list.findIndex((x) => x.id === FX.active);
  assert(at >= 0, "a hidden source excluded from search FAILS");
  assert(list.slice(at).every((x) => (x.tags ?? []).includes("hidden in this session")), "hidden sources are re-sorted to the end with the tag");
  const c2 = await call("GET", `/workbench/documents/candidates?q=fixture&path=${encodeURIComponent(two.path)}`);
  const other = (c2.json.candidates as any[]).find((x) => x.id === FX.active);
  assert(other && !other.tags.includes("hidden in this session"), "a hide that changes anything outside the refinery FAILS");
  const u = await call("POST", `/workbench/contract/ideas/${one.id}/hidden`, { node_kind: "source", node_ref: hid, hidden: false });
  assertEquals(u.json.hidden, false);
  assertEquals((await idea(one.id)).json.refinery.context_graph.nodes.find((n: any) => n.id === hid)?.hidden, false);
  // another user cannot hide in A's refinery
  assertEquals((await call("POST", `/workbench/contract/ideas/${one.id}/hidden`, { node_kind: "source", node_ref: hid, hidden: true }, B)).status, 404);
});

// ── acceptance 3: archive deletes nothing ────────────────────────────────────────────────────────────────
t("I9: archive deletes nothing; engagement skips it and no notification lands; opening it from its document reopens the same one", async () => {
  const { path, id } = await docRefinery(A, `archive ${rnd()}`);
  const q = await call("POST", "/workbench/documents/research", { path, query: "archived refinery question", kind: "research" });
  const roomId = (await call("POST", "/workbench/rooms", { subject_kind: "idea", subject_id: id })).json.room.id;
  const before = (await idea(id)).json.refinery.members;
  const ar = await call("POST", "/workbench/documents/refinery/archive", { path });
  assertEquals([ar.status, ar.json.archived], [200, true], ar.text);
  const r = await idea(id);
  assertEquals([r.json.status, r.json.refinery.archived], ["archived", true]);
  assertEquals(r.json.refinery.members.sessions, before.sessions, "a deleted member FAILS");
  assertEquals(r.json.refinery.members.document.path, path);
  assert((await sql(`SELECT 1 FROM public.research_jobs WHERE id::text = $1`, [q.json.job_id])).length === 1);
  // engagement skips it
  assertEquals((await call("POST", `/workbench/ideas/${id}/edit`, { summary: "while resting" })).status, 409);
  assertEquals((await call("POST", `/workbench/ideas/${id}/research-now`, {})).status, 409);
  assertEquals((await call("POST", `/workbench/rooms/${roomId}/chat`, { text: "hello?" })).status, 409);
  // round 2 (tester A6): the draft is a write too
  const dr = await call("PUT", `/workbench/ideas/${id}/draft`, { text: "while resting" });
  assertEquals([dr.status, dr.json.code], [409, "refinery-archived"], "the draft of an archived refinery is refused");
  const notesBefore = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_notifications WHERE entity LIKE $1`, [`idea:${id}%`]))[0].n;
  const d = await asApp<{ o: any }>(`SELECT public.idea_deliver_dossier($1::uuid, $2, 'late dossier', '{}'::jsonb) AS o`, [id, crypto.randomUUID()]);
  assertEquals(d[0].o.outcome, "archived", "an engagement run on an archived refinery FAILS");
  await sql(`UPDATE public.ideas SET dossier_source_id = $2 WHERE id = $1`, [id, FX.synthesis]); // what a late research write could do
  const notesAfter = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_notifications WHERE entity LIKE $1`, [`idea:${id}%`]))[0].n;
  assertEquals(notesAfter, notesBefore, "no notification lands while archived");
  assertEquals((await sql(`SELECT 1 FROM public.workspace_room_entries WHERE room_id = $1::uuid AND kind = 'dossier'`, [roomId])).length, 0);
  // the archived list: the ideas() read still lists it, as archived
  const listed = (await call("GET", "/workbench/contract/ideas?limit=200")).json.ideas.find((i: any) => i.id === id);
  assertEquals(listed?.status, "archived");
  // opening the refinery from its document reopens THIS one; starting again never makes a second
  const again = await call("POST", "/workbench/documents/refinery/start", { path });
  assertEquals([again.status, again.json.refinery_id, again.json.started], [200, id, false]);
  assertEquals((await ideaRow(id)).status !== "archived", true);
  assertEquals((await sql(`SELECT 1 FROM public.user_document_listings WHERE path = $1 AND refinery_id = $2`, [path, id])).length, 1,
    "a second refinery created for a document whose refinery is archived FAILS");
});

t("I9b: archiving a PROMOTED refinery and reopening it restores the promotion (the guard allows only that way back)", async () => {
  const id = await captured(sub(A), `promoted-archive ${rnd()}`);
  const s = await call("POST", "/workbench/documents/seed", { idea_id: id });
  assertEquals(s.status, 201, s.text);
  assertEquals((await call("POST", "/workbench/documents/refinery/archive", { path: s.json.path })).status, 200);
  assertEquals((await ideaRow(id)).status, "archived");
  const o = await call("POST", "/workbench/documents/refinery/open", { path: s.json.path });
  assertEquals(o.status, 200, o.text);
  assertEquals((await ideaRow(id)).status, "promoted");
});

// ── acceptance 4: the user source list ───────────────────────────────────────────────────────────────────
t("I10: every user-added source is listed with its fold status, scoped corroboration and found_via trail; a held one goes with no tombstone", async () => {
  const { path, id } = await docRefinery(A, `sources ${rnd()}`);
  const add = await call("POST", "/workbench/documents/user-sources", { path, title: `Held ${rnd()}`, content: "held text" });
  assertEquals(add.status, 201, add.text);
  const hid = add.json.source.source_id;
  // a folded user source (admitted: status active), corroborated by one of the refinery's own session sources
  const folded = crypto.randomUUID(), giver = crypto.randomUUID(), session = crypto.randomUUID();
  await sql(`INSERT INTO public.sources (id, url, title, content) VALUES ($1, $2, 'folded', 'f'), ($3, $4, 'giver', 'g')`,
    [folded, `https://example.org/folded/${folded}`, giver, `https://example.org/giver/${giver}`]);
  await sql(`INSERT INTO public.refinery_user_sources (refinery_id, source_id, status) VALUES ($1, $2, 'active')`, [id, folded]);
  await sql(`INSERT INTO public.sessions (id, origin_tool, query_text) VALUES ($1, 'manual', 'q')`, [session]);
  await sql(`INSERT INTO public.research_jobs (status, origin, query, refinery_id, session_id) VALUES ('done', 'workspace', 'q', $1, $2)`, [id, session]);
  await sql(`INSERT INTO public.session_sources (session_id, source_id) VALUES ($1, $2)`, [session, giver]);
  await sql(`INSERT INTO public.source_corroborations (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version)
             VALUES ($1, $2, 'strong', 0.5, 'c', 'general', 'supports', 'd15')`, [giver, folded]);
  // something admitted found_via the held source
  await sql(`INSERT INTO public.research_admission_trail (url, url_key, kind, found_via) VALUES ('https://example.org/via', 'k', 'admitted', $1)`, [hid]);
  const us = (await idea(id)).json.refinery.user_sources as any[];
  const H = us.find((u) => u.source_id === hid), F = us.find((u) => u.source_id === folded);
  assert(H && F, "a user-added source missing from the list FAILS");
  assertEquals([H.status, H.corroboration.state, H.found_via.length], ["held", "not_run", 1]);
  assertEquals([F.status, F.corroboration.state, F.corroboration.givers], ["active", "scoped", 1]);
  // remove a held one: no tombstone
  const tombs = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.source_tombstones`))[0].n;
  assertEquals((await call("DELETE", `/workbench/documents/user-sources/${hid}?refinery_id=${id}`, undefined, B)).status, 404, "another user's user source by id is 404");
  const rm = await call("DELETE", `/workbench/documents/user-sources/${hid}?refinery_id=${id}`);
  assertEquals([rm.status, rm.json.tombstoned], [200, false], rm.text);
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.source_tombstones`))[0].n, tombs, "removed while held with a tombstone left behind FAILS");
  assert(!(await idea(id)).json.refinery.user_sources.some((u: any) => u.source_id === hid));
});

// ── acceptance 5: multi-user ─────────────────────────────────────────────────────────────────────────────
t("I11: another user's idea, refinery, room and draft by id are 404 on every new route; B's rows are unchanged", async () => {
  const { id } = await docRefinery(B, `bee ${rnd()}`);
  await call("PUT", `/workbench/ideas/${id}/draft`, { text: "BeeDraft" }, B);
  const before = await ideaRow(id);
  const roomB = (await call("POST", "/workbench/rooms", { subject_kind: "idea", subject_id: id }, B)).json.room.id;
  for (const [m, p, b] of [
    ["GET", `/workbench/contract/ideas/${id}`, undefined],
    ["POST", `/workbench/ideas/${id}/edit`, { summary: "A was here" }],
    ["POST", `/workbench/ideas/${id}/research-now`, {}],
    ["PUT", `/workbench/ideas/${id}/draft`, { text: "A was here" }],
    ["POST", "/workbench/documents/seed", { idea_id: id }],
    ["GET", `/workbench/rooms/${roomB}`, undefined],
  ] as const) {
    const r = await call(m, p, b);
    assertEquals(r.status, 404, `${m} ${p}: ${r.text}`);
    assert(!r.text.includes("BeeDraft"));
  }
  const after = await ideaRow(id);
  assertEquals([after.summary, after.current_revision, after.status], [before.summary, before.current_revision, before.status]);
  assertEquals((await idea(id, B)).json.draft.text, "BeeDraft");
});


// ── round 2 (tester attempt 1): F2 - the write guard, whatever the order of steps; F1 - create document under concurrency ──
t("I12: the guard: no app-role sequence promotes or forges the pointer (G4, G4b), no idea is born promoted (G5); owner_sub and the pointer are not rewritten", async () => {
  const forged = '{"promoted":{"document_path":"documents/forged.md"}}';
  // G4: archive with a forged pointer, then "reopen" into promoted - two transactions
  const g4 = await captured(sub(A), `twostep ${rnd()}`);
  assertEquals(await refusedAsApp(`UPDATE public.ideas SET status = 'archived', metadata = metadata || $2::jsonb WHERE id = $1`, [g4, forged]), "42501", "G4 step 1: the forged pointer");
  assertEquals(await refusedAsApp(`UPDATE public.ideas SET status = 'promoted' WHERE id = $1`, [g4]), "42501", "G4 step 2");
  assertEquals((await ideaRow(g4)).status, "new");
  // G4b: the same two steps in ONE transaction (also with an empty pointer object)
  const g4b = await captured(sub(A), `twostep1tx ${rnd()}`);
  for (const m of [forged, '{"promoted":{}}']) {
    assertEquals(await refusedAsAppTx([
      [`UPDATE public.ideas SET status = 'archived', metadata = metadata || $2::jsonb WHERE id = $1`, [g4b, m]],
      [`UPDATE public.ideas SET status = 'promoted' WHERE id = $1`, [g4b]],
    ]), "42501", `G4b ${m}`);
  }
  const r4b = await ideaRow(g4b);
  assertEquals([r4b.status, r4b.metadata?.promoted ?? null], ["new", null], "G4b: nothing was written");
  // archive alone (no pointer), then promoted: refused too
  assertEquals(await refusedAsAppTx([[`UPDATE public.ideas SET status = 'archived' WHERE id = $1`, [g4b]], [`UPDATE public.ideas SET status = 'promoted' WHERE id = $1`, [g4b]]]), "42501", "archive then promoted");
  // G5: an idea INSERTED promoted, or carrying a pointer
  assertEquals(await refusedAsApp(`INSERT INTO public.ideas (id, title, summary, owner_sub, status) VALUES ($1, 'born promoted', 'x', $2, 'promoted')`, [crypto.randomUUID(), sub(A)]), "42501", "G5 status promoted");
  assertEquals(await refusedAsApp(`INSERT INTO public.ideas (id, title, summary, owner_sub, metadata) VALUES ($1, 'born with a pointer', 'x', $2, $3::jsonb)`, [crypto.randomUUID(), sub(A), forged]), "42501", "G5 pointer");
  assertEquals(await refusedAsApp(`INSERT INTO public.ideas (id, title, summary, owner_sub) VALUES ($1, 'an ordinary capture', 'x', $2)`, [crypto.randomUUID(), sub(A)]), "", "an ordinary insert still works");
  // G6: owner_sub is not rewritten by the app role (moving an idea between users)
  const g6 = await captured(sub(B), `owned by B ${rnd()}`);
  assertEquals(await refusedAsApp(`UPDATE public.ideas SET owner_sub = $2 WHERE id = $1`, [g6, sub(A)]), "42501", "G6 owner_sub");
  assertEquals((await sql<{ o: string }>(`SELECT owner_sub AS o FROM public.ideas WHERE id = $1`, [g6]))[0].o, sub(B));
  // G7: a real promotion's pointer is neither rewritten nor dropped by the app role
  const s7 = await call("POST", "/workbench/documents/seed", { idea_id: await captured(sub(A), `ptr ${rnd()}`) });
  assertEquals(s7.status, 201, s7.text);
  const g7 = s7.json.refinery_id as string;
  assertEquals(await refusedAsApp(`UPDATE public.ideas SET metadata = jsonb_set(metadata, '{promoted,document_path}', '"documents/evil.md"') WHERE id = $1`, [g7]), "42501", "G7 rewrite");
  assertEquals(await refusedAsApp(`UPDATE public.ideas SET metadata = metadata - 'promoted' WHERE id = $1`, [g7]), "42501", "G7 drop");
  assertEquals((await ideaRow(g7)).metadata?.promoted?.document_path, s7.json.path);
  // review RV2: a revision is history. On a corpus-shaped (legacy) revision - one the app role can see by its thought -
  // its summary / content_hash / thought_id are not rewritten in place; its research stamp (research_job_id) is.
  const legacy = await captured(sub(A), `legacy ${rnd()}`, "legacy statement");
  const th = (await sql<{ id: string }>(`INSERT INTO public.thoughts (content, metadata, exposure) VALUES ('legacy idea', '{"type":"idea","exposure":"ops"}'::jsonb, 'ops') RETURNING id::text AS id`))[0].id;
  await sql(`UPDATE public.idea_revisions SET thought_id = $2::bigint, private_owner = NULL WHERE idea_id = $1 AND revision = 1`, [legacy, th]);
  // the lab chain grants the app role no UPDATE on idea_revisions; LIVE it holds one (the review's has_table_privilege
  // check) - reproduce the live grant for these probes so the GUARD is what answers, then take it back
  await sql(`GRANT UPDATE ON public.idea_revisions TO ${APP_ROLE}`);
  const rv2 = async (label: string, stmt: string, want: string) => {
    const got = await refusedAsApp(stmt, [legacy]);
    assertEquals(got, want, `${label}: got ${JSON.stringify(got)}`);
  };
  await rv2("RV2 summary", `UPDATE public.idea_revisions SET summary = 'rewritten history' WHERE idea_id = $1 AND revision = 1`, "42501");
  await rv2("RV2 content_hash", `UPDATE public.idea_revisions SET content_hash = 'x' WHERE idea_id = $1 AND revision = 1`, "42501");
  await rv2("RV2 the research stamp", `UPDATE public.idea_revisions SET research_job_id = 'rv2-stamp' WHERE idea_id = $1 AND revision = 1`, "");
  assertEquals((await sql<{ j: string; s: string }>(`SELECT research_job_id AS j, summary AS s FROM public.idea_revisions WHERE idea_id = $1 AND revision = 1`, [legacy]))[0],
    { j: "rv2-stamp", s: "legacy statement" }, "the stamp landed; the history did not change");
  // a PRIVATE revision is not even visible to an app role's UPDATE (no write policy names its plane): nothing changes
  await refusedAsApp(`UPDATE public.idea_revisions SET summary = 'rewritten history' WHERE idea_id = $1 AND revision = 1`, [g4]);
  assertEquals((await sql<{ s: string }>(`SELECT summary AS s FROM public.idea_revisions WHERE idea_id = $1 AND revision = 1`, [g4]))[0].s.includes("rewritten"), false);
  await sql(`REVOKE UPDATE ON public.idea_revisions FROM ${APP_ROLE}`);
  // the refinery's own lifecycle writes still work (status, the research flag)
  assertEquals(await refusedAsApp(`UPDATE public.ideas SET metadata = metadata || '{"research_now": true}'::jsonb, status = 'researched' WHERE id = $1`, [g4]), "");
});

async function seededFiles(id: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory && e.name !== ".git") await walk(p);
      else if (e.isFile && e.name.endsWith(".md") && (await Deno.readTextFile(p)).includes(`seeded_from: "${id}"`)) out.push(p.slice(VAULT.length + 1));
    }
  }
  await walk(`${VAULT}/documents`).catch(() => {});
  return out;
}

t("I13: create document under concurrent requests (tester S): exactly one document; every other request 409 go to document; no orphan", async () => {
  for (const n of [2, 6]) {
    const id = await captured(sub(A), `seedrace${n} ${rnd()}`);
    const before = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.user_document_listings WHERE owner_sub = $1`, [sub(A)]))[0].n;
    const res = await Promise.all(Array.from({ length: n }, () => call("POST", "/workbench/documents/seed", { idea_id: id })));
    const won = res.filter((r) => r.status === 201);
    assertEquals(won.length, 1, `S${n}: one 201 (codes ${res.map((r) => r.status).join(",")})`);
    for (const r of res.filter((x) => x.status !== 201)) {
      assertEquals([r.status, r.json.path], [409, won[0].json.path], `S${n}: a losing request is 409 go to document: ${r.text.slice(0, 160)}`);
    }
    const after = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.user_document_listings WHERE owner_sub = $1`, [sub(A)]))[0].n;
    assertEquals(after - before, 1, `S${n}: one new listing`);
    assertEquals((await sql(`SELECT 1 FROM public.user_document_listings WHERE refinery_id = $1`, [id])).length, 1, `S${n}: one tethered`);
    assert(VAULT, "the lab mounts the vault (DOCS_TEST_VAULT)");
    assertEquals(await seededFiles(id), [won[0].json.path], `S${n}: one vault file seeded from the idea`);
  }
});

t("I14 (review RV1): found_via lists only the viewer's own admissions - another user's research admitting through a shared source in A's refinery is withheld", async () => {
  const a = await docRefinery(A, `via ${rnd()}`);
  const b = await docRefinery(B, `via-b ${rnd()}`);
  const S = crypto.randomUUID();
  await sql(`INSERT INTO public.sources (id, url, title, content) VALUES ($1, $2, 'shared S', 's')`, [S, `https://example.org/shared/${S}`]);
  await sql(`INSERT INTO public.refinery_user_sources (refinery_id, source_id, status) VALUES ($1, $2, 'active')`, [a.id, S]);
  const jobOf = async (who: Record<string, string>, path: string) => {
    const r = await call("POST", "/workbench/documents/research", { path, query: `via q ${rnd()}`, kind: "research" }, who);
    assertEquals(r.status, 202, r.text);
    return r.json.job_id as string;
  };
  const jobA = await jobOf(A, a.path), jobB = await jobOf(B, b.path);
  const trail = async (job: string, url: string, kind: string, extra: { found_via?: string; source_id?: string }) =>
    (await sql<{ id: string }>(
      `INSERT INTO public.research_admission_trail (job_id, url, url_key, kind, found_via, source_id) VALUES ($1, $2, public.contract_url_key($2), $3, $4, $5) RETURNING id::text AS id`,
      [job, url, kind, extra.found_via ?? null, extra.source_id ?? null]))[0].id;
  // B's tree: a lead on S, X admitted through it, and Y admitted found_via S directly
  const leadB = await trail(jobB, `https://example.org/shared/${S}`, "lead", { source_id: S });
  await trail(jobB, "https://example.org/b-admits-x", "admitted", { found_via: leadB });
  await trail(jobB, "https://example.org/b-admits-y", "admitted", { found_via: S });
  // A's own admission through S (the positive control) and an admission whose job row is gone (fail closed)
  await trail(jobA, "https://example.org/a-admits-z", "admitted", { found_via: S });
  await trail(crypto.randomUUID(), "https://example.org/orphan-job", "admitted", { found_via: S });
  const r = await idea(a.id);
  assertEquals(r.status, 200, r.text);
  const us = (r.json.refinery.user_sources as any[]).find((u) => u.source_id === S);
  assertEquals(us.found_via.map((v: any) => v.url), ["https://example.org/a-admits-z"], "A sees only A's own admission");
  assert(!r.text.includes("b-admits") && !r.text.includes("orphan-job"), "nothing of B's tree (or of a vanished job) in A's refinery view");
});

t("I15 (operator 2026-11-02, ideas are completely user isolated): A's capture, edit and dossier reach no shared corpus search - yet A still reads every revision", async () => {
  const mk = { cap: `CaptureSecret${rnd()}`, edit: `EditSecret${rnd()}`, dossier: `DossierSecret${rnd()}`, title: `IdeaTitle${rnd()}` };
  const id = await captured(sub(A), mk.title, `the idea ${mk.cap}`);
  assertEquals((await call("POST", `/workbench/ideas/${id}/edit`, { summary: `the idea, sharper ${mk.edit}` })).status, 200);
  // the MCP tool's own door (update_idea): idea_edit() with no thought, as the app role
  const mcp = await asApp<{ o: any }>(`SELECT public.idea_edit($1::uuid, $2, 'service:openbrain-mcp', $3, NULL, NULL, NULL) AS o`, [id, sub(A), `the idea, via mcp ${mk.edit}`]);
  assertEquals(mcp[0].o.outcome, "changed");
  assertEquals((await asApp<{ o: any }>(`SELECT public.idea_deliver_dossier($1::uuid, $2, $3, '{}'::jsonb) AS o`, [id, crypto.randomUUID(), `dossier ${mk.dossier}`]))[0].o.outcome, "delivered");
  for (const m of Object.values(mk)) {
    // the shared thought corpus (search_thoughts / search / fetch read it): not even as the superuser - the text is not there
    assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.thoughts WHERE content LIKE '%' || $1 || '%' OR metadata::text LIKE '%' || $1 || '%'`, [m]))[0].n, 0, `thoughts carry ${m}`);
    // the generic MCP lane's database role sees no thought of it either
    assertEquals((await asApp<{ n: number }>(`SELECT count(*)::int AS n FROM public.thoughts WHERE content LIKE '%' || $1 || '%'`, [m]))[0].n, 0, `app-role thoughts carry ${m}`);
    // nor any shared knowledge table a search reads (sources, their chunks)
    assertEquals((await sql<{ n: number }>(`SELECT ((SELECT count(*) FROM public.sources WHERE content LIKE '%' || $1 || '%' OR title LIKE '%' || $1 || '%')
                                              + (SELECT count(*) FROM public.source_chunks WHERE content LIKE '%' || $1 || '%'))::int AS n`, [m]))[0].n, 0, `sources carry ${m}`);
  }
  // user B's search of the shared knowledge (the contract search) finds nothing of A's idea
  for (const m of [mk.cap, mk.edit, mk.title]) {
    const r = await call("GET", `/workbench/contract/search?q=${encodeURIComponent(m)}&kinds=page,claim,source`, undefined, B);
    assertEquals(r.status, 200, r.text);
    assert(!JSON.stringify(r.json.results ?? []).includes(m), `B's search results carry ${m}`); // the response echoes the query itself
  }
  // A, through the workbench (the app role), still reads all three revisions - the private plane, not a thought
  const r = await idea(id);
  assertEquals(r.json.revisions.map((v: any) => v.revision), [1, 2, 3]);
  assert(r.text.includes(mk.cap) && r.text.includes(mk.edit));
  // an app role cannot write a private-plane revision itself (only the functions name the plane)
  assertEquals(await refusedAsApp(`INSERT INTO public.idea_revisions (idea_id, revision, summary, private_owner) VALUES ($1, 1, 'forged', $2)`, [crypto.randomUUID(), sub(A)]), "42501");
});

// ── rw-report-isolation (operator 2026-11-02): an idea's research report is private to its owner; the claims drawn
// from it stay shared; every other report stays shared ──────────────────────────────────────────────────────────
// The report as the code under test files it: research_private_reports (slot 390) where it exists, else the way the
// base filed it (a shared research_synthesis source, the claims' synthesis_id, the idea's dossier pointer) - so the
// same assertions are RED on the base and GREEN here. The job row holds the report text as the research service
// stores it (result.synthesis). The job is tied to the idea ONLY by a revision stamp (the live shape: no refinery_id).
async function plantIdeaReport(owner: string, ideaId: string, mk: { report: string; title: string; prose: string; key: string; word: string }) {
  const job = (await sql<{ id: string }>(`INSERT INTO public.research_jobs (status, origin, query, finished_at) VALUES ('done', 'manual', 'research for an idea', now()) RETURNING id::text AS id`))[0].id;
  await sql(`UPDATE public.idea_revisions SET research_job_id = $2 WHERE idea_id = $1 AND revision = 1`, [ideaId, job]);
  await sql(`UPDATE public.research_jobs SET refinery_id = NULL, inlet_ref = NULL WHERE id = $1`, [job]);
  const priv = (await sql<{ ok: boolean }>(`SELECT to_regclass('public.research_private_reports') IS NOT NULL AS ok`))[0].ok;
  // rw-private-report-claims (slot 570): a private report's claim is filed into its owner's store, as the curator files it
  const has570 = (await sql<{ ok: boolean }>(`SELECT to_regprocedure('public.private_report_claim_file(text,uuid,text,uuid,text,text,integer,vector,jsonb)') IS NOT NULL AS ok`))[0].ok;
  let claim = "";
  if (!(priv && has570)) {
    claim = (await sql<{ id: string }>(`SELECT f.id::text AS id FROM public.find_or_create_claim($1, NULL, NULL, 'sourced', NULL, NULL, NULL, '{"claim_kind":"descriptive"}'::jsonb) f`,
      [`The ${mk.word} result held in 12 trials.`]))[0].id;
    await sql(`SELECT public.link_claim_to_source($1::uuid, $2::uuid, 'states', 1.0)`, [claim, FX.active]);
  }
  let ref: string;
  if (priv) {
    ref = (await sql<{ id: string }>(
      `INSERT INTO public.research_private_reports (research_key, owner_sub, idea_id, job_id, title, content, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, jsonb_build_object('prose_synthesis', $7::text)) RETURNING id::text AS id`,
      [mk.key, owner, ideaId, job, mk.title, `${mk.report} the report body`, mk.prose]))[0].id;
    if (has570) {
      claim = (await sql<{ id: string }>(
        `SELECT f.id::text AS id FROM public.private_report_claim_file($1, $2::uuid, $3, NULL, 'sourced', NULL, NULL, NULL, '{"claim_kind":"descriptive"}'::jsonb) f`,
        [mk.key, job, `The ${mk.word} result held in 12 trials.`]))[0].id;
      await sql(`SELECT public.private_report_claim_edge($1::uuid, $2::uuid, 'states', 1.0)`, [claim, FX.active]);
    } else {
      await sql(`INSERT INTO public.research_private_report_claims (report_id, claim_id) VALUES ($1, $2)`, [ref, claim]);
    }
  } else {
    ref = (await sql<{ id: string }>(
      `INSERT INTO public.sources (title, content, content_type, research_key, metadata)
       VALUES ($1, $2, 'research_synthesis', $3, jsonb_build_object('prose_synthesis', $4::text)) RETURNING id::text AS id`,
      [mk.title, `${mk.report} the report body`, mk.key, mk.prose]))[0].id;
    await sql(`UPDATE public.claims SET synthesis_id = $2 WHERE id = $1`, [claim, ref]);
    await sql(`UPDATE public.ideas SET dossier_source_id = $2 WHERE id = $1`, [ideaId, ref]);
  }
  await sql(`UPDATE public.research_jobs SET result = jsonb_build_object('synthesis', $2::text, 'prose', $3::text, 'claims', '[]'::jsonb, 'cited_sources', '[]'::jsonb,
                                                         'curator', jsonb_build_object('persist', jsonb_build_object('synthesis_id', $4::text)))
              WHERE id = $1`, [job, `${mk.report} the report body`, mk.prose, priv ? null : ref]);
  return { job, claim, ref };
}

t("I16 (rw-report-isolation + rw-private-report-claims): an idea's research report AND the claims drawn from it are private - B and the lane get no text, title, key or id of either anywhere (the claims read, its nested fields, search, the session, the report and source routes); the owner reads the report and its claim", async () => {
  const tag = rnd();
  const mk = { report: `PrivReport${tag}`, title: `PrivTitle${tag}`, prose: `PrivProse${tag}`, key: `rk-priv-${tag}`, word: `privclaimword${tag}` };
  const ideaId = await captured(sub(A), `report idea ${tag}`);
  const { job, claim, ref } = await plantIdeaReport(sub(A), ideaId, mk);
  // slot 570 (operator 2026-11-21): the claim's text and id are A's too
  const secrets = [mk.report, mk.title, mk.prose, mk.key, ref, mk.word, claim];
  const leaks = (label: string, text: string) => secrets.filter((s) => text.includes(s)).map((s) => `${label} carries ${s}`);
  const LANE: Record<string, string> = {}; // no identity header: the default subject - what the MCP lanes act as
  const found: string[] = [];
  for (const [who, h] of [["B", B], ["lane", LANE]] as const) {
    const reads = [
      `/workbench/contract/ideas/${ideaId}`, `/workbench/contract/ideas?limit=200`,
      `/workbench/contract/claims?q=${encodeURIComponent(mk.word)}`, `/workbench/contract/claims?synthesis_id=${ref}`,
      `/workbench/contract/search?q=${encodeURIComponent(mk.report)}&kinds=page,claim,source`,
      `/workbench/contract/search?q=${encodeURIComponent(mk.word)}&kinds=page,claim,source`,
      `/workbench/contract/sessions/${job}`, `/workbench/contract/jobs?limit=200`, `/workbench/contract/timeline?limit=100`,
      `/workbench/contract/reports/${ref}/credibility`, `/workbench/contract/sources/${ref}/quality`, `/workbench/contract/sources/${ref}/dependence`,
      `/workbench/contract/trail?source_id=${ref}`, `/workbench/contract/notifications`,
    ];
    for (const path of reads) {
      const r = await call("GET", path, undefined, h);
      // the search echoes its own query, and a route may echo the id it was handed: judge the results, minus that echo
      const raw = path.includes("/search?") ? JSON.stringify(r.json.results ?? []) : r.text;
      const body = path.includes(ref) ? raw.replaceAll(ref, "") : raw;
      found.push(...leaks(`${who} ${path} -> ${r.status}`, body));
    }
    // the claim drawn from the report: absent for every other user (slot 570), its count included
    const c = await call("GET", `/workbench/contract/claims?q=${encodeURIComponent(mk.word)}`, undefined, h);
    assertEquals(c.status, 200, c.text);
    assertEquals((c.json.claims as any[]).filter((x) => x.id === claim).length, 0, `${who}: the claim from A's idea report is A's alone`);
    assertEquals((c.json.claims as any[]).length, 0, `${who}: the claims read finds nothing for the claim's word`);
    const bySyn = await call("GET", `/workbench/contract/claims?synthesis_id=${ref}`, undefined, h);
    assertEquals((bySyn.json.claims ?? []).length, 0, `${who}: following the report id finds nothing`);
  }
  assertEquals(found, [], "nothing of A's idea report reaches B or the lane");
  // nor any shared knowledge table (as the superuser and as the app role: the generic MCP lane's database role)
  for (const m of [mk.report, mk.title, mk.prose]) {
    const shared = `SELECT ((SELECT count(*) FROM public.sources WHERE content LIKE '%' || $1 || '%' OR title LIKE '%' || $1 || '%' OR metadata::text LIKE '%' || $1 || '%')
                          + (SELECT count(*) FROM public.source_chunks WHERE content LIKE '%' || $1 || '%')
                          + (SELECT count(*) FROM public.wiki_pages WHERE body LIKE '%' || $1 || '%' OR title LIKE '%' || $1 || '%'))::int AS n`;
    assertEquals((await sql<{ n: number }>(shared, [m]))[0].n, 0, `a shared table carries ${m}`);
    assertEquals((await asApp<{ n: number }>(shared, [m]))[0].n, 0, `a shared table (app role) carries ${m}`);
  }
  // A, the owner, reads the report in the idea's dossier, and the claims it gave
  const a = await idea(ideaId);
  assertEquals(a.status, 200, a.text);
  assert(String(a.json.report?.content ?? "").includes(mk.report), `A reads the report: ${JSON.stringify(a.json.report ?? null).slice(0, 200)}`);
  assertEquals([a.json.report?.title, a.json.report?.prose, a.json.report?.claims, a.json.report?.job_id], [mk.title, mk.prose, 1, job]);
  assert((a.json.produced.claims as any[]).some((x) => x.id === claim), "the idea's produced claims list the claim");
});

t("I17 (rw-report-isolation): a non-idea research report is still a shared source, exactly as before - every user follows its claims to it", async () => {
  const tag = rnd();
  const job = (await sql<{ id: string }>(`INSERT INTO public.research_jobs (status, origin, query, finished_at) VALUES ('done', 'manual', 'shared research', now()) RETURNING id::text AS id`))[0].id;
  const src = (await sql<{ id: string }>(
    `INSERT INTO public.sources (title, content, content_type, research_key) VALUES ($1, $2, 'research_synthesis', $3) RETURNING id::text AS id`,
    [`SharedTitle${tag}`, `SharedReport${tag} body`, `rk-shared-${tag}`]))[0].id;
  const claim = (await sql<{ id: string }>(`SELECT f.id::text AS id FROM public.find_or_create_claim($1, NULL, $2::uuid, 'sourced', NULL, NULL, NULL, '{"claim_kind":"descriptive"}'::jsonb) f`,
    [`The sharedclaimword${tag} result held.`, src]))[0].id;
  await sql(`SELECT public.link_claim_to_source($1::uuid, $2::uuid, 'states', 1.0)`, [claim, FX.active]);
  await sql(`UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('persist', jsonb_build_object('synthesis_id', $2::text))) WHERE id = $1`, [job, src]);
  for (const h of [A, B, {}]) {
    const c = await call("GET", `/workbench/contract/claims?synthesis_id=${src}`, undefined, h);
    assertEquals(c.status, 200, c.text);
    assertEquals((c.json.claims as any[]).map((x) => [x.id, x.synthesis_id]), [[claim, src]], "the claim points at its shared report");
  }
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.sources WHERE id = $1 AND content_type = 'research_synthesis'`, [src]))[0].n, 1);
});

t("I18 (rw-boundary-ideas round 2): a 'dossier delivered' event (entity idea:<id>:dossier:<source>) reaches its owner only - B never sees it", async () => {
  const id = await captured(sub(A), `dossier note ${rnd()}`);
  const since = (await sql<{ t: string }>(`SELECT (now() - interval '1 second')::text AS t`))[0].t;
  // what the research service's delivery does: the idea's dossier source is set, trg_ideas_notify posts the event
  await sql(`UPDATE public.ideas SET dossier_source_id = $2 WHERE id = $1`, [id, FX.synthesis]);
  const entity = `idea:${id}:dossier:${FX.synthesis}`;
  assertEquals((await sql(`SELECT 1 FROM public.research_notifications WHERE entity = $1`, [entity])).length, 1,
    "the dossier-shaped event exists (non-vacuous: the filter's :dossier: branch is exercised)");
  const read = async (who: Record<string, string>) => {
    const r = await call("GET", `/workbench/contract/notifications?limit=500&since=${encodeURIComponent(since)}`, undefined, who);
    assertEquals(r.status, 200, r.text);
    return r;
  };
  const a = await read(A);
  assert((a.json.notifications as any[]).some((n) => n.entity === entity), "the owner reads the dossier event");
  const b = await read(B);
  assertEquals((b.json.notifications as any[]).filter((n) => String(n.entity ?? "").includes(id)), [], "B reads no event naming A's idea");
  assertEquals([b.text.includes(id), b.text.includes(entity)], [false, false], "A's idea id appears nowhere in B's answer");
  // and the lane (no identity header): the shared default subject reads none of it either
  const lane = await read({});
  assertEquals(lane.text.includes(id), false, "the lane reads no event naming A's idea");
});

// ── rwr-idea-capture-api: POST /workbench/ideas - an idea written down in the workbench ───────────────────────────────
// Each case maps to an acceptance line of the anchor (C1 privacy, C2/C3 the schedule, C4 the owner, C5 the research
// path, C6 the two-identity sweep incl. counts and error bodies). Red before this item: the route does not exist (404).
const capture = (b: unknown, who: Record<string, string> = A) => call("POST", "/workbench/ideas", b, who);
const markerCount = async (m: string) => (await sql<{ n: number }>(
  `SELECT ((SELECT count(*) FROM public.thoughts WHERE content LIKE '%' || $1 || '%' OR metadata::text LIKE '%' || $1 || '%')
         + (SELECT count(*) FROM public.thought_entities WHERE evidence::text LIKE '%' || $1 || '%')
         + (SELECT count(*) FROM public.sources WHERE content LIKE '%' || $1 || '%' OR title LIKE '%' || $1 || '%')
         + (SELECT count(*) FROM public.source_chunks WHERE content LIKE '%' || $1 || '%'))::int AS n`, [m]))[0].n;

t("C1 (acceptance 1): a captured idea is invisible to B, to shared search and to the ops corpus - planted marker", async () => {
  const mk = { title: `CapTitle${rnd()}`, body: `CapBody${rnd()}` };
  const r = await capture({ title: mk.title, summary: `my idea ${mk.body}` });
  assertEquals(r.status, 201, r.text);
  const id = r.json.idea_id as string;
  assertEquals((await sql<{ owner_sub: string }>(`SELECT owner_sub FROM public.ideas WHERE id = $1`, [id]))[0].owner_sub, sub(A));
  // the ops corpus (the shared thought corpus, its entity evidence) and the shared knowledge tables: no marker at all
  for (const m of Object.values(mk)) assertEquals(await markerCount(m), 0, `a shared table carries ${m}`);
  // the app role (the generic MCP lane) finds no thought of it either
  for (const m of Object.values(mk)) {
    assertEquals((await asApp<{ n: number }>(`SELECT count(*)::int AS n FROM public.thoughts WHERE content LIKE '%' || $1 || '%'`, [m]))[0].n, 0);
  }
  // shared search, as B and as A (the search reads shared knowledge only)
  for (const who of [A, B]) {
    for (const m of Object.values(mk)) {
      const s = await call("GET", `/workbench/contract/search?q=${encodeURIComponent(m)}&kinds=page,claim,source`, undefined, who);
      assertEquals(s.status, 200, s.text);
      assert(!JSON.stringify(s.json.results ?? []).includes(m), `search results carry ${m}`);
    }
  }
  // B: not in the ideas list, the idea by id, the bell, the sessions or jobs reads, the rooms
  const reads = ["/workbench/contract/ideas?limit=200", `/workbench/contract/ideas/${id}`, "/workbench/contract/notifications",
    "/workbench/contract/sessions", "/workbench/contract/jobs", "/workbench/jobs", "/workbench/rooms"];
  for (const p of reads) {
    const b = await call("GET", p, undefined, B);
    for (const m of [id, ...Object.values(mk)]) assert(!b.text.includes(m), `B's ${p} carries ${m === id ? "the idea id" : m}`);
  }
  // A reads it back
  const own = await idea(id);
  assertEquals(own.status, 200, own.text);
  assert(own.text.includes(mk.body) && own.text.includes(mk.title));
});

const handbacks = async (id: string) => await sql<{ state: string; purpose: string; owner_sub: string; inlet_revision: number }>(
  `SELECT state, purpose, owner_sub, inlet_revision FROM public.research_handbacks WHERE inlet_kind = 'idea' AND inlet_id = $1`, [id]);

t("C2 (acceptance 2): with no schedule (immediate, the default) research is queued at capture as a private hand-back on revision 1 (slot 580)", async () => {
  const r = await capture({ summary: `immediate ${rnd()}` });
  assertEquals(r.status, 201, r.text);
  assertEquals([r.json.research.mode, r.json.research.queued, r.json.research.next_start], ["immediate", true, null]);
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_jobs WHERE refinery_id = $1`, [r.json.idea_id]))[0].n, 0, "no job before the boundary forms the question");
  const hb = await handbacks(r.json.idea_id);
  assertEquals(hb.map((h) => [h.state, h.purpose, h.owner_sub, h.inlet_revision]), [["pending", "idea-research", sub(A), 1]]);
  assertEquals((await sql<{ h: string }>(`SELECT metadata->>'research_handback' AS h FROM public.idea_revisions WHERE idea_id = $1 AND revision = 1`, [r.json.idea_id]))[0].h !== null, true);
});

t("C3 (acceptance 2): a daily schedule holds research until the scheduled time, then the drain queues its hand-back once", async () => {
  const C = { "X-Test-Sub": `ideas-c-${rnd()}` };
  const at = new Date(Date.now() + 3 * 3600_000); // three hours from now, UTC
  const hhmm = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
  const s = await call("PUT", "/workbench/idea-schedule", { mode: "daily", at_time: hhmm, tz: "UTC" }, C);
  assertEquals(s.status, 200, s.text);
  const r = await capture({ summary: `scheduled ${rnd()}` }, C);
  assertEquals(r.status, 201, r.text);
  assertEquals([r.json.research.mode, r.json.research.queued, r.json.research.job_id], ["daily", false, null]);
  assertNotEquals(r.json.research.next_start, null);
  const id = r.json.idea_id as string;
  assertEquals((await handbacks(id)).length, 0, "nothing queued before the scheduled time");
  await sql(`SELECT public.idea_schedule_drain(now())`);
  assertEquals((await handbacks(id)).length, 0, "a drain before the time queues nothing");
  await sql(`SELECT public.idea_schedule_drain($1::timestamptz + interval '1 minute')`, [r.json.research.next_start]);
  assertEquals((await handbacks(id)).length, 1, "the drain after the time queues it");
  await sql(`SELECT public.idea_schedule_drain($1::timestamptz + interval '2 minutes')`, [r.json.research.next_start]);
  assertEquals((await handbacks(id)).length, 1, "once");
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_jobs WHERE refinery_id = $1`, [id]))[0].n, 0, "still no job: the boundary forms it");
});

t("C4 (acceptance 3): the idea is created only for the calling identity; a body naming another owner is refused and writes nothing", async () => {
  const mk = `OwnerProbe${rnd()}`;
  const before = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.ideas`))[0].n;
  for (const f of ["owner_sub", "owner", "sub", "user", "actor_sub", "subject_sub"]) {
    const r = await capture({ summary: `${mk} ${f}`, [f]: sub(B) });
    assertEquals(r.status, 400, `${f}: ${r.text}`);
  }
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.ideas`))[0].n, before, "no idea was written");
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.ideas WHERE summary LIKE '%' || $1 || '%'`, [mk]))[0].n, 0);
  // the identity comes from the seam (the lab's header), never the body: A's call is A's idea, B's call is B's
  const ra = await capture({ summary: `${mk} A` }), rb = await capture({ summary: `${mk} B` }, B);
  const owners = await sql<{ id: string; owner_sub: string; actor_sub: string }>(
    `SELECT id::text AS id, owner_sub, actor_sub FROM public.ideas WHERE id = ANY($1::uuid[])`, [[ra.json.idea_id, rb.json.idea_id]]);
  assertEquals(new Map(owners.map((o) => [o.id, [o.owner_sub, o.actor_sub]])), new Map([[ra.json.idea_id, [sub(A), sub(A)]], [rb.json.idea_id, [sub(B), sub(B)]]]));
});

t("C5 (acceptance 4): its research goes through the one idea hand-back path (PD0b), exactly as capture_idea's - no job, no corpus thought", async () => {
  const text = `queue path ${rnd()}`;
  const viaRoute = await capture({ title: "Same", summary: text });
  assertEquals(viaRoute.status, 201, viaRoute.text);
  const viaMcp = await captured(sub(A), "Same", text);
  const shape = async (id: string) => ({
    hb: (await handbacks(id)).map((h) => [h.state, h.purpose, h.owner_sub, h.inlet_revision]),
    jobs: (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_jobs WHERE refinery_id = $1`, [id]))[0].n,
  });
  const a = await shape(viaRoute.json.idea_id), b = await shape(viaMcp);
  assertEquals(a, b, "the same hand-back, the same (zero) jobs");
  assertEquals(a.hb.length, 1);
  assertEquals(await markerCount(text), 0);
});

t("C6 (acceptance 5, two identities): B never learns of A's captured idea - lists, counts, nested fields, and a refusal identical to a missing row", async () => {
  const listB = async () => await call("GET", "/workbench/contract/ideas?limit=200", undefined, B);
  const before = await listB();
  assertEquals(before.status, 200, before.text);
  const mk = `TwoId${rnd()}`;
  const r = await capture({ title: `T ${mk}`, summary: `S ${mk}` });
  assertEquals(r.status, 201, r.text);
  const id = r.json.idea_id as string;
  const after = await listB();
  assertEquals(after.json.ideas.length, before.json.ideas.length, "B's count does not move");
  assertEquals(after.text, before.text, "B's list is byte-identical");
  const missing = crypto.randomUUID();
  for (const [m, p, b] of [
    ["GET", "/workbench/contract/ideas/{}", undefined],
    ["POST", "/workbench/ideas/{}/edit", { summary: "B was here" }],
    ["POST", "/workbench/ideas/{}/research-now", {}],
    ["PUT", "/workbench/ideas/{}/draft", { text: "B was here" }],
    ["POST", "/workbench/idea-schedule/research-now/{}", {}],
  ] as const) {
    const real = await call(m, p.replace("{}", id), b, B), none = await call(m, p.replace("{}", missing), b, B);
    assertEquals([real.status, real.text], [none.status, none.text.replaceAll(missing, id)], `${m} ${p}: A's idea reads like a missing one`);
    assert(!real.text.includes(mk));
  }
  // B's own capture answer carries nothing of A's
  const rb = await capture({ summary: `B's own ${rnd()}` }, B);
  assertEquals(rb.status, 201, rb.text);
  assert(!rb.text.includes(id) && !rb.text.includes(mk));
  assertEquals((await ideaRow(id)).current_revision, 1, "B's attempts changed nothing");
});

// ── rw-held-owner-scope (operator 2026-11-23): a held source is PRIVATE to its owner until admitted ────────
// Two real identities (the lab's X-Test-Sub seam), a real database. A holds a source whose title, url and text
// carry unique tokens; B, signed in as another user, gets exactly the answer a missing id gets on every route that
// takes a held id (same status, same body, same error text), and nothing B receives anywhere carries A's tokens.
// The owner's own reads still work, and B adding A's URL never touches A's row.
const D = "/workbench/documents";
const uid = rnd;
t("rw-held-owner-scope: another user's held source answers exactly like a missing one on every route; the owner's reads still work", async () => {
  const tok = () => uid().replace(/-/g, "");
  const urlTok = `UrlTok${tok()}`;
  const T = { title: `HeldTitleTok${tok()}`, url: `https://example.org/heldurl/${urlTok}`, body: `HeldBodyTok${tok()}` };
  const content = `${T.body} first sentence of A's private held text. Second sentence stays private too.`;
  const A = { "X-Test-Sub": `held-a-${uid()}` };
  const Bh = { "X-Test-Sub": `held-b-${uid()}` };
  const mk = async (h: Record<string, string>, title: string) => {
    const made = await call("POST", D, { title, body: "", idea: `held scope idea ${uid()}` }, h);
    assertEquals(made.status, 201, made.text);
    const st = await call("POST", `${D}/refinery/start`, { path: made.json.path }, h);
    assertEquals(st.status, 200, st.text);
    return { path: made.json.path as string, rid: st.json.refinery_id as string };
  };
  const a = await mk(A, `Held A ${uid()}`);
  const b = await mk(Bh, `Held B ${uid()}`);
  const addA = await call("POST", `${D}/user-sources`, { path: a.path, title: T.title, url: T.url, content }, A);
  assertEquals(addA.status, 201, addA.text);
  const hid = addA.json.source.source_id as string;
  const addB = await call("POST", `${D}/user-sources`, { path: b.path, title: `B own held ${uid()}`, content: "B's own held text to cite." }, Bh);
  assertEquals(addB.status, 201, addB.text);
  const bOwn = addB.json.source.source_id as string;
  const heldRow = async () => (await sql(
    `SELECT id::text AS id, refinery_id::text AS refinery_id, url, title, content, content_hash, revision, updated_at::text AS updated_at,
            (SELECT count(*)::int FROM public.held_source_chunks c WHERE c.held_source_id = h.id) AS chunks
       FROM public.held_sources h WHERE h.id = $1`, [hid],
  ))[0];
  const aBefore = JSON.stringify(await heldRow());

  const seen: string[] = []; // every response B gets, searched for A's tokens
  const hasTok = (s: string) => [T.title, urlTok, T.body].some((x) => s.includes(x));
  const miss = crypto.randomUUID();
  const norm = (s: string, id: string) => s.split(id).join("<ID>");
  // B asks about `id` and about a missing id: the status and the body must be the same, character for character
  // (the id the caller sent is the only thing allowed to differ)
  const asMissing = async (label: string, run: (id: string) => Promise<{ status: number; text: string }>) => {
    const real = await run(hid), none = await run(miss);
    seen.push(real.text);
    assertEquals(real.status, none.status, `${label}: status of a foreign held id vs a missing one: ${real.text}`);
    assertEquals(norm(real.text, hid), norm(none.text, miss), `${label}: body of a foreign held id vs a missing one`);
    assert(!hasTok(real.text), `${label}: carries A's text: ${real.text}`);
  };
  const C = "/workbench/contract";
  const sel = { quote: { exact: T.body, prefix: "", suffix: " first sentence" }, position: { start: 0, end: T.body.length } };
  await asMissing("GET /references/{id}", (id) => call("GET", `${C}/references/${id}`, undefined, Bh));
  await asMissing("GET /chunks/{id}:0/context", (id) => call("GET", `${C}/chunks/${id}:0/context?window=3`, undefined, Bh));
  await asMissing("GET /sources/{id}/quality", (id) => call("GET", `${C}/sources/${id}/quality`, undefined, Bh));
  await asMissing("GET /sources/{id}/dependence", (id) => call("GET", `${C}/sources/${id}/dependence`, undefined, Bh));
  await asMissing("POST /diff-check (bare pin)", (id) => call("POST", `${C}/diff-check`, { references: [{ source_id: id, revision: 1, chunk_idx: 0 }] }, Bh));
  await asMissing("POST /contract/references (a reference to the held id)", (id) =>
    call("POST", `${C}/references`, { source_id: id, provenance: "user", selectors: sel, holder: { kind: "user_document", ref: b.path } }, Bh));
  await asMissing("POST /documents/references (whole source: the quote would come from A's text)", (id) =>
    call("POST", `${D}/references`, { path: b.path, source_id: id, exact: "", form: "chip" }, Bh));
  await asMissing("POST /documents/references (a quote: the substring oracle)", (id) =>
    call("POST", `${D}/references`, { path: b.path, source_id: id, exact: T.body, form: "added" }, Bh));
  await asMissing("GET /documents/user-sources/{id}/locate", (id) => call("GET", `${D}/user-sources/${id}/locate`, undefined, Bh));
  await asMissing("POST /documents/user-sources/{id}/replace (a foreign id is never refetched or rewritten)", (id) =>
    call("POST", `${D}/user-sources/${id}/replace`, { path: b.path, content: "B overwrites A" }, Bh));
  await asMissing("DELETE /documents/user-sources/{id}", (id) =>
    call("DELETE", `${D}/user-sources/${id}?refinery_id=${b.rid}`, undefined, Bh));
  // the jobs list: A's held source is not in B's list (id, title and tokens absent); B's own is
  const jobs = await call("GET", `${C}/jobs?kinds=held&limit=500`, undefined, Bh);
  seen.push(jobs.text);
  assertEquals(jobs.status, 200, jobs.text);
  assert(!jobs.json.jobs.some((j: any) => j.id === hid), "B's held list names A's held source");
  assert(jobs.json.jobs.some((j: any) => j.id === bOwn), "B's held list still names B's own");
  assert(!hasTok(jobs.text) && !jobs.text.includes(hid), "B's held list carries A's id or text");
  // a document of B's that LINKS A's held id places no reference record (a link to nothing stays a live link)
  const cur = await call("GET", `${D}/file?path=${encodeURIComponent(b.path)}`, undefined, Bh);
  const linked = await call("PUT", `${D}/file?path=${encodeURIComponent(b.path)}`,
    { content: `${cur.json.content}\nLinks to [[source:${hid}|a private source]].\n`, if_match: cur.json.hash }, Bh);
  assertEquals(linked.status, 200, linked.text);
  assertEquals((await sql(`SELECT 1 FROM public.reference_records WHERE source_id = $1`, [hid])).length, 0, "a reference record points at A's held source");
  // a record that predates this fix (planted: B's document holds a record pointing at A's held id) shows nothing of A's
  const rec = (await sql<{ id: string }>(
    `INSERT INTO public.reference_records (source_id, scope, selectors, provenance, pinned_revision, chunk_idx, created_by)
     VALUES ($1, 'source', '{"quote":{"exact":"x","prefix":"","suffix":""},"position":{"start":0,"end":1}}'::jsonb, 'user', 1, 0, 'planted') RETURNING id::text AS id`, [hid],
  ))[0].id;
  await sql(`INSERT INTO public.reference_holders (holder_kind, holder_ref, reference_id, cited_ref, origin, seq, number)
             VALUES ('user_document', $1, $2, $3, 'added', 0, 1)`, [b.path, rec, hid]);
  try {
    const viaRec = await call("GET", `${C}/references/${rec}`, undefined, Bh);
    seen.push(viaRec.text);
    assert(!hasTok(viaRec.text), `a record pointing at A's held id shows A's text: ${viaRec.text}`);
    assertEquals(viaRec.json.held ?? null, null, `a record pointing at A's held id carries a held block: ${viaRec.text}`);
    const diffRec = await call("POST", `${C}/diff-check`, { references: [{ reference_id: rec }] }, Bh);
    seen.push(diffRec.text);
    assertEquals(diffRec.json.results?.[0]?.lifecycle ?? null, null, `diff-check of that record names A's source state: ${diffRec.text}`);
    const panel = await call("GET", `${D}/references?path=${encodeURIComponent(b.path)}`, undefined, Bh);
    seen.push(panel.text);
    assertEquals(panel.status, 200, panel.text);
    assert(!hasTok(panel.text), `the references list titles B's reference with A's title: ${panel.text}`);
  } finally {
    await sql(`DELETE FROM public.reference_holders WHERE reference_id = $1`, [rec]);
    await sql(`DELETE FROM public.reference_records WHERE id = $1`, [rec]);
  }

  // dedupe: B adds A's URL: B gets a held row of B's own and A's row is untouched, byte for byte
  // (B sent A's URL itself, so B's own row naturally carries it: this response is not searched for A's tokens)
  const dup = await call("POST", `${D}/user-sources`, { path: b.path, title: `B's own take ${uid()}`, url: T.url, content: "B's different content for the same link" }, Bh);
  assertEquals(dup.status, 201, dup.text);
  assertNotEquals(dup.json.source.source_id, hid, "B was handed A's held id");
  assert(!dup.json.deduped, "B's add was deduped onto A's row");
  assertEquals(JSON.stringify(await heldRow()), aBefore, "A's held row changed after B added A's URL with other content");
  assertEquals((await sql<{ r: string }>(`SELECT refinery_id::text AS r FROM public.held_sources WHERE id = $1`, [dup.json.source.source_id]))[0].r, b.rid, "the new row belongs to B's refinery");
  // B adds the very same content under the same URL: still a row of B's own, A's untouched
  const same = await call("POST", `${D}/user-sources`, { path: b.path, title: T.title, url: T.url, content }, Bh);
  assertEquals(same.status, 201, same.text);
  assertNotEquals(same.json.source.source_id, hid, "B was handed A's held id for identical content");
  assertEquals(JSON.stringify(await heldRow()), aBefore, "A's held row changed after B added identical content");

  // nothing B received on the routes above carries A's title, url or text
  for (const s of seen) assert(!hasTok(s), `a response to B carries A's tokens: ${s.slice(0, 300)}`);

  // the owner: A's own reads, citations and re-add still work
  const ownRef = await call("GET", `${C}/references/${hid}`, undefined, A);
  assertEquals(ownRef.status, 200, ownRef.text);
  assertEquals(ownRef.json.held.title, T.title);
  assertEquals(ownRef.json.held.url, T.url);
  assert(ownRef.json.held.excerpt.includes(T.body), "the owner reads the excerpt");
  assertEquals(ownRef.json.held.refinery_id, a.rid, "the owner reads which idea holds it");
  const ownChunk = await call("GET", `${C}/chunks/${hid}:0/context`, undefined, A);
  assertEquals(ownChunk.status, 200, ownChunk.text);
  assert(ownChunk.json.chunks.some((c: any) => c.content.includes(T.body)), "the owner reads the chunk text");
  assertEquals((await call("GET", `${C}/sources/${hid}/quality`, undefined, A)).status, 200);
  const ownDep = await call("GET", `${C}/sources/${hid}/dependence`, undefined, A);
  assertEquals([ownDep.status, ownDep.json.lifecycle], [200, "held"]);
  const ownDiff = await call("POST", `${C}/diff-check`, { references: [{ source_id: hid, revision: 1, chunk_idx: 0 }] }, A);
  assertEquals(ownDiff.json.results[0].lifecycle, "held", ownDiff.text);
  const ownJobs = await call("GET", `${C}/jobs?kinds=held&limit=500`, undefined, A);
  assert(ownJobs.json.jobs.some((j: any) => j.id === hid && j.detail.title === T.title), "the owner's held list names the source and its title");
  const cite = await call("POST", `${D}/references`, { path: a.path, source_id: hid, exact: "", form: "chip" }, A);
  assertEquals(cite.status, 201, cite.text);
  const ownPanel = await call("GET", `${D}/references?path=${encodeURIComponent(a.path)}`, undefined, A);
  assert(ownPanel.json.references.some((r: any) => r.source_id === hid && r.title === T.title), "the owner's panel titles it");
  const again = await call("POST", `${D}/user-sources`, { path: a.path, title: T.title, url: T.url, content }, A);
  assertEquals(again.status, 201, again.text);
  assertEquals(again.json.source.source_id, hid, "the owner adding the same link again reuses the owner's own row");
  assert(again.json.deduped, "an own re-add is still deduped");
});

// ── rw-held-owner-scope round 2 (tester F1/F2): a reference RECORD that targets another user's held source ──
// The record carries the source id and a quote of the held text, so it is part of the held source: for any
// other user it is a MISSING record on every path (read, diff-check, re-pin), whether the owner placed it through
// the routes (a) or it predates the fix and was written straight into the table (b). The owner reads it as before (c).
t("rw-held-owner-scope round 2: a reference record on another user's held source answers exactly like a missing record", async () => {
  const tok = () => uid().replace(/-/g, "");
  const body = `RecHeldTok${tok()}`;
  const content = `${body} is the first private sentence of A's held text. A second private sentence.`;
  const A = { "X-Test-Sub": `rec-a-${uid()}` };
  const Bh = { "X-Test-Sub": `rec-b-${uid()}` };
  const mk = async (h: Record<string, string>, title: string) => {
    const made = await call("POST", D, { title, body: "", idea: `rec scope idea ${uid()}` }, h);
    assertEquals(made.status, 201, made.text);
    const st = await call("POST", `${D}/refinery/start`, { path: made.json.path }, h);
    assertEquals(st.status, 200, st.text);
    return { path: made.json.path as string, rid: st.json.refinery_id as string };
  };
  const a = await mk(A, `Rec A ${uid()}`);
  const b = await mk(Bh, `Rec B ${uid()}`);
  const add = await call("POST", `${D}/user-sources`, { path: a.path, title: `RecHeldTitle${tok()}`, content }, A);
  assertEquals(add.status, 201, add.text);
  const hid = add.json.source.source_id as string;
  const C = "/workbench/contract";
  const reads = (id: string) => [
    ["GET /references/{id}", () => call("GET", `${C}/references/${id}`, undefined, Bh)],
    ["POST /diff-check {reference_id}", () => call("POST", `${C}/diff-check`, { references: [{ reference_id: id }] }, Bh)],
    ["POST /documents/references/{id}/repin", () => call("POST", `${D}/references/${id}/repin?path=${encodeURIComponent(b.path)}`, undefined, Bh)],
  ] as [string, () => Promise<{ status: number; text: string }>][];
  const norm = (s: string, id: string) => s.split(id).join("<ID>");
  const sameAsMissing = async (what: string, id: string) => {
    const miss = crypto.randomUUID();
    const real = reads(id), none = reads(miss);
    for (let i = 0; i < real.length; i++) {
      const [label, run] = real[i];
      const x = await run(), y = await none[i][1]();
      assertEquals(x.status, y.status, `${what} ${label}: status ${x.status} vs a missing record's ${y.status}: ${x.text}`);
      assertEquals(norm(x.text, id), norm(y.text, miss), `${what} ${label}: body differs from a missing record's`);
      assert(!x.text.includes(body) && !x.text.includes(hid), `${what} ${label}: carries A's text or held id: ${x.text}`);
    }
  };
  // (a) A cites A's own held source: a real record R
  const cite = await call("POST", `${D}/references`, { path: a.path, source_id: hid, exact: body, form: "chip" }, A);
  assertEquals(cite.status, 201, cite.text);
  const R = cite.json.record.id as string;
  assertEquals((await sql<{ e: string }>(`SELECT selectors #>> '{quote,exact}' AS e FROM public.reference_records WHERE id = $1`, [R]))[0].e, body, "the record carries A's quote");
  await sameAsMissing("(a) A's real record,", R);
  // (b) a record that predates the fix: B's own document, A's held id, A's text in the selectors
  const legacy = (await sql<{ id: string }>(
    `INSERT INTO public.reference_records (source_id, scope, selectors, provenance, pinned_revision, chunk_idx, created_by)
     VALUES ($1, 'span', $2::jsonb, 'user', 1, 0, 'legacy') RETURNING id::text AS id`,
    [hid, JSON.stringify({ quote: { exact: body, prefix: "", suffix: " is the first" }, position: { start: 0, end: body.length } })],
  ))[0].id;
  await sql(`INSERT INTO public.reference_holders (holder_kind, holder_ref, reference_id, cited_ref, origin, seq, number)
             VALUES ('user_document', $1, $2, $3, 'added', 0, 1)`, [b.path, legacy, hid]);
  try {
    await sameAsMissing("(b) a legacy record in B's document,", legacy);
    const panel = await call("GET", `${D}/references?path=${encodeURIComponent(b.path)}`, undefined, Bh);
    assertEquals(panel.status, 200, panel.text);
    assert(!panel.text.includes(body), `B's panel carries A's text: ${panel.text}`);
  } finally {
    await sql(`DELETE FROM public.reference_holders WHERE reference_id = $1`, [legacy]);
    await sql(`DELETE FROM public.reference_records WHERE id = $1`, [legacy]);
  }
  // a chip of A's record pasted into B's document is not held there (the record is missing for B)
  const cur = await call("GET", `${D}/file?path=${encodeURIComponent(b.path)}`, undefined, Bh);
  const pasted = await call("PUT", `${D}/file?path=${encodeURIComponent(b.path)}`,
    { content: `${cur.json.content}\n[@ref:${R}]\n`, if_match: cur.json.hash }, Bh);
  assert(pasted.status === 200 || pasted.status === 400 || pasted.status === 409, pasted.text);
  assertEquals((await sql(`SELECT 1 FROM public.reference_holders WHERE reference_id = $1 AND holder_ref = $2`, [R, b.path])).length, 0, "B's document came to hold A's record");
  // (c) the owner reads R as before
  const own = await call("GET", `${C}/references/${R}`, undefined, A);
  assertEquals(own.status, 200, own.text);
  assertEquals(own.json.record.source_id, hid);
  assertEquals(own.json.record.selectors.quote.exact, body);
  assertEquals(own.json.held.refinery_id, a.rid);
  const ownDiff = await call("POST", `${C}/diff-check`, { references: [{ reference_id: R }] }, A);
  assertEquals([ownDiff.status, ownDiff.json.results[0].lifecycle], [200, "held"], ownDiff.text);
});
