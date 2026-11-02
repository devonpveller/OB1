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
  const id = crypto.randomUUID();
  await sql(`INSERT INTO public.ideas (id, title, summary, owner_sub, embedding)
             VALUES ($1, $2, $3, $4, array_fill(0.01::real, ARRAY[1024])::vector)`, [id, title, summary, owner]);
  // revision 1 carries its corpus thought, as capture_idea writes it (the memory plane shows the app role a revision by it)
  const th = (await sql<{ id: string }>(`INSERT INTO public.thoughts (content, metadata, exposure) VALUES ($1, jsonb_build_object('type', 'idea', 'exposure', 'ops'), 'ops') RETURNING id::text AS id`, [summary]))[0].id;
  await sql(`INSERT INTO public.idea_revisions (idea_id, revision, summary, content_hash, thought_id) VALUES ($1, 1, $2, md5(lower(btrim($2))), $3::bigint)`, [id, summary, th]);
  return id;
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
  assertNotEquals(L.last_session_at, null, "the capture queued a session: its date is listed");
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
  // every session it spun off: each revision's job is listed (a queued run coalesces an edit onto it, P4a)
  const sess = new Set(r.json.sessions.map((x: any) => x.id));
  assert(r.json.sessions.length >= 1 && r.json.revisions.every((v: any) => !v.research_job_id || sess.has(v.research_job_id)), "every session it spun off");
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
  const rev = (await sql<{ research_job_id: string | null; thought_id: string | null }>(
    `SELECT research_job_id, thought_id::text AS thought_id FROM public.idea_revisions WHERE idea_id = $1 AND revision = 2`, [id]))[0];
  assertNotEquals(rev.research_job_id, null, "the revision is queued for research by the database");
  assertNotEquals(rev.thought_id, null, "the revision carries the door's corpus thought (the memory plane reads it by that)");
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

t("I5: research now is idea_research() for the owner (202 + a job); another user's idea 404", async () => {
  const id = await captured(sub(A), `now ${rnd()}`);
  const r = await call("POST", `/workbench/ideas/${id}/research-now`, {});
  assertEquals([r.status, r.json.outcome], [202, "queued"]);
  assert((await sql(`SELECT 1 FROM public.research_jobs WHERE id::text = $1 AND refinery_id = $2`, [r.json.job_id, id])).length === 1);
  // the older idea-schedule door is the same function
  const s = await call("POST", `/workbench/idea-schedule/research-now/${id}`, {});
  assertEquals(s.status, 200, s.text);
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
  assert(m.sessions.includes(now.json.job_id) && m.sessions.includes(q.json.job_id), "a member missing after engagement FAILS (sessions)");
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
