// deno test src/contracts/episode_from_integration_test.ts - rwr-episode-from over a REAL workbench and database, as TWO
// users (A owns the planted material, B is the other account). SKIPPED unless EPF_TEST_BASE and CONTRACT_TEST_DB_HOST are
// set; contract-test/run-episode-from-tests.ps1 runs it in its disposable lab (the real initdb chain, fixtures.sql, the :wt
// workbench logged in as ob_workbench with WORKSPACE_IDENTITY_HEADER=X-Test-Sub). Never point it at a live stack.
//
// E1..E12 name the acceptance statements (test-plans/rwr-episode-from.md). A and B are fresh lab subjects per run.
// Environment: EPF_TEST_BASE, EPF_TEST_KEY, EPF_TEST_SUB_HEADER (default X-Test-Sub), EPF_TEST_MARKER_OUT (a file the run
// writes its planted markers to, so the runner can search the workbench's and the database's logs for them),
// EPF_WORLD_OUT (a file the run writes the planted world to, for the render step), CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser).
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("EPF_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("EPF_TEST_KEY") ?? "";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const SUB_HEADER = Deno.env.get("EPF_TEST_SUB_HEADER") ?? "X-Test-Sub";
const MARKER_OUT = Deno.env.get("EPF_TEST_MARKER_OUT") ?? "";
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

const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const RUN = rnd();
const A = `lab-epf-a-${RUN}`;
const B = `lab-epf-b-${RUN}`;
// planted markers: A's private material, one per kind. None may reach B, a shared table, a log, or search.
const M = {
  idea: `EpfIdeaSecret${rnd()}`, run: `EpfRunSecret${rnd()}`, report: `EpfReportSecret${rnd()}`, doc: `EpfDocSecret${rnd()}`,
  claim: `EpfClaimSecret${rnd()}`, note: `EpfNoteSecret${rnd()}`, title: `EpfTitleSecret${rnd()}`,
};
const TOPIC_TEXT = `EpfTopicShared${rnd()}`; // a topic is shared knowledge: it may be seen by anyone

interface Res { status: number; json: any; text: string }
async function call(method: string, path: string, body: unknown, sub: string | null, prefix = "/workbench/contract"): Promise<Res> {
  const headers: Record<string, string> = { "x-brain-key": KEY };
  if (sub) headers[SUB_HEADER] = sub;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${BASE}${prefix}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  return { status: r.status, json, text };
}
const asA = (m: string, p: string, b?: unknown) => call(m, p, b, A);
const asB = (m: string, p: string, b?: unknown) => call(m, p, b, B);
const noMarkers = (label: string, text: string, which: (keyof typeof M)[] = Object.keys(M) as (keyof typeof M)[]) => {
  for (const k of which) assert(!text.includes(M[k]), `${label}: carries A's ${k} marker`);
};

const W: Record<string, string> = {};
async function setup() {
  if (W.ready) return;
  if (MARKER_OUT) await Deno.writeTextFile(MARKER_OUT, Object.values(M).join("\n") + "\n");
  for (const [who, sub] of [["a", A], ["b", B]] as const) {
    await sql(`INSERT INTO public.podcast_voice_links (id, owner_sub, route, voice) VALUES ($1, $2, 'local-tts', 'bm_george')`, [`epf-v-${who}-${RUN}`, sub]);
    await sql(`INSERT INTO public.podcast_presenters (id, owner_sub, name, voice_link_id) VALUES ($1, $2, $3, $4), ($5, $2, $6, $4)`,
      [`epf-p1-${who}-${RUN}`, sub, `Alex ${who}`, `epf-v-${who}-${RUN}`, `epf-p2-${who}-${RUN}`, `Blair ${who}`]);
    await sql(`INSERT INTO public.podcast_teams (id, owner_sub, name) VALUES ($1, $2, $3)`, [`epf-t-${who}-${RUN}`, sub, `team ${who} ${RUN}`]);
    await sql(`INSERT INTO public.podcast_team_members (team_id, position, presenter_id) VALUES ($1, 0, $2), ($1, 1, $3)`,
      [`epf-t-${who}-${RUN}`, `epf-p1-${who}-${RUN}`, `epf-p2-${who}-${RUN}`]);
    W[`team${who}`] = `epf-t-${who}-${RUN}`;
  }
  // A's idea (the text is the marker), A's finished run (A's prompt on it), A's private report, A's document, a topic page, A's note
  W.idea = crypto.randomUUID();
  await sql(`INSERT INTO public.ideas (id, title, summary, owner_sub) VALUES ($1, $2, $3, $4)`, [W.idea, `Idea ${M.title}`, `The idea text ${M.idea}`, A]);
  W.run = crypto.randomUUID();
  await sql(`INSERT INTO public.research_jobs (id, status, origin, query, result, caller, started_at, finished_at) VALUES ($1, 'done', 'workbench', $2, $3::jsonb, 'workbench', now(), now())`,
    [W.run, `question ${M.run}`, JSON.stringify({ claims: [{ text: `claim ${M.claim}` }], cited_sources: [], gaps: [] })]);
  await sql(`INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, $2, $2, $3)`, [W.run, A, `question ${M.run}`]);
  W.report = crypto.randomUUID();
  await sql(`INSERT INTO public.research_private_reports (id, research_key, owner_sub, idea_id, title, content) VALUES ($1, $2, $3, $4, $5, $6)`,
    [W.report, `epf-${RUN}`, A, W.idea, `Report ${M.title}`, `The report text ${M.report}`]);
  const d = await call("POST", "", { title: `Doc ${RUN}`, body: `The document text ${M.doc}` }, A, "/workbench/documents");
  assertEquals(d.status, 201, d.text);
  W.doc = d.json.path;
  W.topic = `content/tool/epf-topic-${RUN}`;
  await sql(`INSERT INTO public.wiki_pages (slug, page_class, entity_type, title, body) VALUES ($1, 'entity', 'tool', $2, $3)`, [W.topic, `Topic ${RUN}`, `A topic about ${TOPIC_TEXT}`]);
  W.note = `notes/epf-note-${RUN}`;
  await sql(`INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'note', 'A note', $2)`, [W.note, `A's own note ${M.note}`]);
  W.ready = "1";
}

const FROMS = () => ({
  idea: { kind: "idea", id: W.idea }, run: { kind: "run", id: W.run }, report: { kind: "report", id: W.report },
  document: { kind: "document", id: W.doc }, topic: { kind: "topic", id: W.topic },
});
const missingId = (kind: string) => kind === "document" ? "documents/nobody/none.md" : kind === "topic" ? "content/tool/none-none" : crypto.randomUUID();

// the tables that carry a marker (every text / json column of every table in public, as text)
async function tablesWith(marker: string): Promise<string[]> {
  const tables = await sql<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`);
  const out: string[] = [];
  for (const { t: tbl } of tables) {
    const r = await sql<{ n: string }>(`SELECT (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I x where x::text like %L', $1::text, $2::text), false, true, '')))[1]::text AS n`, [tbl, `%${marker}%`]);
    if (Number(r[0]?.n ?? 0) > 0) out.push(tbl);
  }
  return out;
}

t("E1: A makes a request from each of run, report, document, idea and topic; the answer carries none of the text", async () => {
  await setup();
  for (const [kind, from] of Object.entries(FROMS())) {
    const r = await asA("POST", "/podcasts/requests", { team_id: W.teama, title: `Episode ${kind} ${RUN}`, from });
    assertEquals(r.status, 202, `${kind}: ${r.text}`);
    assertEquals(r.json.state, "queued");
    assertEquals(r.json.turns, 0, `${kind}: the request holds no transcript turns`);
    noMarkers(`${kind} answer`, r.text);
    assert(!r.text.includes(TOPIC_TEXT));
    W[`req-${kind}`] = r.json.id;
  }
  const list = await asA("GET", "/podcasts/requests?limit=50");
  assertEquals(list.status, 200);
  for (const kind of Object.keys(FROMS())) assert(list.json.requests.some((x: any) => x.id === W[`req-${kind}`]), `${kind} request is in A's list`);
  noMarkers("A's request list", list.text);
  // the planted world, for the render lab step (the podcast image renders these queued requests)
  const out = Deno.env.get("EPF_WORLD_OUT");
  if (out) {
    await Deno.writeTextFile(out, JSON.stringify({
      A, B, teamA: W.teama, teamB: W.teamb, topicText: TOPIC_TEXT, markers: M,
      requests: { idea: W["req-idea"], run: W["req-run"], report: W["req-report"], document: W["req-document"], topic: W["req-topic"] },
    }));
  }
});

t("E2: the material is recorded on the request row (A's own, private) and in no other table beyond its source; never on a shared row", async () => {
  await setup();
  // where each marker may legitimately live: the source it came from, and the requester-only request row
  const allowed: Record<string, string[]> = {
    idea: ["ideas", "idea_revisions", "podcast_render_requests"], run: ["research_jobs", "research_prompts", "podcast_render_requests"],
    report: ["research_private_reports", "podcast_render_requests"], claim: ["research_jobs", "podcast_render_requests"],
    doc: ["podcast_render_requests", "user_document_listings", "wiki_pages", "documents_text"], note: ["wiki_pages"],
  };
  for (const [k, ok] of Object.entries(allowed)) {
    const hit = await tablesWith(M[k as keyof typeof M]);
    for (const tbl of hit) assert(ok.includes(tbl) || (k === "doc" && /^(user_document|document|workspace_)/.test(tbl)), `marker ${k} found in ${tbl} (allowed: ${ok.join(", ")})`);
  }
  // the idea text is in the request row, and that row belongs to A alone
  const rows = await sql<{ requester_sub: string }>(`SELECT requester_sub FROM public.podcast_render_requests WHERE input::text LIKE $1`, [`%${M.idea}%`]);
  assert(rows.length >= 1 && rows.every((r) => r.requester_sub === A), "the idea text sits only on A's own request row");
  // no episode row, shared or not, was made by a request (rendering is the service's step, and it did not run)
  const eps = await sql(`SELECT 1 FROM public.podcast_episodes WHERE title LIKE $1 OR transcript LIKE $2`, [`%${M.title}%`, `%${M.idea}%`]);
  assertEquals(eps.length, 0);
});

t("E3: B cannot make an episode from A's run, report, document or idea; the refusal is the same as for a thing that does not exist", async () => {
  await setup();
  const before = (await sql<{ n: string }>(`SELECT count(*)::text AS n FROM public.podcast_render_requests WHERE requester_sub = $1`, [B]))[0].n;
  for (const kind of ["idea", "run", "report", "document", "topic"]) {
    const foreign = kind === "topic" ? { kind, id: W.note } : (FROMS() as Record<string, { kind: string; id: string }>)[kind]; // a note is A's page, not a topic
    const f = await asB("POST", "/podcasts/requests", { team_id: W.teamb, title: "mine", from: foreign });
    const m = await asB("POST", "/podcasts/requests", { team_id: W.teamb, title: "mine", from: { kind, id: missingId(kind) } });
    assertEquals(f.status, 404, `${kind}: ${f.text}`);
    assertEquals(f.status, m.status, `${kind}: same status`);
    assertEquals(f.text, m.text, `${kind}: the same body, byte for byte`);
    noMarkers(`${kind} refusal`, f.text);
  }
  // A's own text appears in none of B's reads, counts, totals
  const after = (await sql<{ n: string }>(`SELECT count(*)::text AS n FROM public.podcast_render_requests WHERE requester_sub = $1`, [B]))[0].n;
  assertEquals(after, before, "a refused request writes nothing");
  const bl = await asB("GET", "/podcasts/requests?limit=200");
  assertEquals(bl.json.requests.length, 0, "B's list has none of A's requests");
  noMarkers("B's request list", bl.text);
  // another user's team for A's thing: still the team refusal, not a hint about the input
  const t2 = await asB("POST", "/podcasts/requests", { team_id: W.teama, title: "x", from: { kind: "idea", id: W.idea } });
  assertEquals(t2.status, 404);
  assertEquals(t2.json.error, "no such team");
});

t("E4: an id that cannot exist, a path outside the caller's tree and a made-up kind are refused without a hint", async () => {
  await setup();
  const cases: [string, unknown][] = [
    ["not a uuid", { kind: "idea", id: "not-a-uuid" }], ["a path of another tree", { kind: "document", id: `documents/${B}/../x.md` }],
    ["a traversal", { kind: "document", id: "../../etc/passwd" }], ["an unregistered kind", { kind: "habit", id: "x" }],
    ["__proto__", { kind: "__proto__", id: "x" }], ["no id", { kind: "idea" }], ["a number", { kind: "idea", id: 7 }],
  ];
  for (const [name, from] of cases) {
    const r = await asB("POST", "/podcasts/requests", { team_id: W.teamb, title: "x", from });
    assert([400, 404].includes(r.status), `${name}: ${r.status} ${r.text}`);
    noMarkers(name, r.text);
  }
  // a transcript AND a from, and neither
  assertEquals((await asA("POST", "/podcasts/requests", { team_id: W.teama, title: "x", from: { kind: "idea", id: W.idea }, transcript: { title: "t", turns: [{ presenterId: `epf-p1-a-${RUN}`, text: "hi" }] } })).status, 400);
  assertEquals((await asA("POST", "/podcasts/requests", { team_id: W.teama, title: "x" })).status, 400);
});

t("E5: discussion is registered and not usable: one answer whatever the id, nothing written", async () => {
  await setup();
  const before = (await sql<{ n: string }>(`SELECT count(*)::text AS n FROM public.podcast_render_requests`))[0].n;
  const seen = new Set<string>();
  for (const id of [crypto.randomUUID(), "x", W.idea]) {
    const r = await asA("POST", "/podcasts/requests", { team_id: W.teama, title: "x", from: { kind: "discussion", id } });
    assertEquals(r.status, 409, r.text);
    seen.add(r.text);
  }
  assertEquals(seen.size, 1, "the same body for every id");
  assertEquals((await sql<{ n: string }>(`SELECT count(*)::text AS n FROM public.podcast_render_requests`))[0].n, before);
});

t("E6: a topic is shared knowledge: B may make an episode from it; a person's note is not a topic for anyone but is not leaked either", async () => {
  await setup();
  const r = await asB("POST", "/podcasts/requests", { team_id: W.teamb, title: "Topic ep", from: { kind: "topic", id: W.topic } });
  assertEquals(r.status, 202, r.text);
  const row = (await sql<{ input: any }>(`SELECT input FROM public.podcast_render_requests WHERE id = $1`, [r.json.id]))[0];
  assertEquals(row.input.source.items, [], "a topic holds nothing private to list");
  assert(row.input.source.text.includes(TOPIC_TEXT));
  const note = await asA("POST", "/podcasts/requests", { team_id: W.teama, title: "n", from: { kind: "topic", id: W.note } });
  assertEquals(note.status, 404, "a note is not a topic, not even A's own");
});

// planted episodes for the share step: one per kind, linked to the real request rows
async function planEpisode(kind: string, owner = A): Promise<string> {
  const id = crypto.randomUUID();
  await sql(`INSERT INTO public.podcast_episodes (id, owner_sub, shared, title, team_id, audio_format, archive_dir, request_id)
             VALUES ($1, $2, false, $3, $4, 'mp3', $5, $6)`, [id, owner, `Episode ${kind} ${RUN}`, W.teama, `/mounts/podcast-archive/epf-${id}`, W[`req-${kind}`]]);
  return id;
}

t("E7: an episode made from private material starts shared = false, is in no one else's library, and the share preview lists what would be shared", async () => {
  await setup();
  for (const kind of ["idea", "run", "report", "document"]) {
    const ep = await planEpisode(kind);
    W[`ep-${kind}`] = ep;
    assertEquals((await sql<{ shared: boolean }>(`SELECT shared FROM public.podcast_episodes WHERE id = $1`, [ep]))[0].shared, false);
    const bl = await asB("GET", "/podcasts?limit=200");
    assert(!bl.json.podcasts.some((p: any) => p.id === ep), `${kind}: not in B's library`);
    noMarkers("B's library", bl.text);
    const pv = await asA("GET", `/podcasts/${ep}/share-preview`);
    assertEquals(pv.status, 200, pv.text);
    assertEquals(pv.json.already_shared, false);
    assert(pv.json.text.startsWith("By sharing this podcast, you'll be sharing the following private information to the users who have access to this server: ["), pv.json.text);
    const types = pv.json.would_share.map((i: any) => i.type);
    assert(types.includes("episode") && types.includes(kind), `${kind}: the list names the episode and the ${kind}: ${types}`);
    assert(pv.json.would_share.every((i: any) => i.marker === "private" || i.marker === "cloud"));
    // everything recorded from the material is listed (nothing omitted)
    const recorded = (await sql<{ items: any[] }>(`SELECT input->'source'->'items' AS items FROM public.podcast_render_requests WHERE id = $1`, [W[`req-${kind}`]]))[0].items;
    for (const it of recorded) assert(pv.json.would_share.some((x: any) => x.type === it.type && x.id === it.id), `${kind}: recorded ${it.type} ${it.id} is in the list`);
    assert(/^[0-9a-f]{64}$/.test(pv.json.share_digest));
  }
});

t("E8: sharing needs the owner's confirmation of the list they were shown: no digest, a wrong digest and a stale one are refused", async () => {
  await setup();
  const ep = W["ep-idea"];
  const pv = await asA("GET", `/podcasts/${ep}/share-preview`);
  for (const body of [{ shared: true }, { shared: true, share_digest: "0".repeat(64) }, { shared: true, share_digest: "" }]) {
    const r = await asA("PATCH", `/podcasts/${ep}`, body);
    assert([400, 409].includes(r.status), `${JSON.stringify(body)}: ${r.status}`);
    assertEquals((await sql<{ shared: boolean }>(`SELECT shared FROM public.podcast_episodes WHERE id = $1`, [ep]))[0].shared, false);
  }
  // the list changes after the preview (another item was recorded): the digest the owner holds no longer matches
  const items = (await sql<{ items: any[] }>(`SELECT input->'source'->'items' AS items FROM public.podcast_render_requests WHERE id = $1`, [W["req-idea"]]))[0].items;
  await sql(`UPDATE public.podcast_render_requests SET input = jsonb_set(input, '{source,items}', input->'source'->'items' || $2::jsonb) WHERE id = $1`,
    [W["req-idea"], JSON.stringify([{ type: "source", id: "s-extra", label: "an extra source", marker: "private" }])]);
  const stale = await asA("PATCH", `/podcasts/${ep}`, { shared: true, share_digest: pv.json.share_digest });
  assertEquals(stale.status, 409, "the list grew since the owner saw it: refused");
  assertEquals(stale.json.detail?.needs, "share-preview");
  assertEquals((await sql<{ shared: boolean }>(`SELECT shared FROM public.podcast_episodes WHERE id = $1`, [ep]))[0].shared, false);
  await sql(`UPDATE public.podcast_render_requests SET input = jsonb_set(input, '{source,items}', $2::jsonb) WHERE id = $1`, [W["req-idea"], JSON.stringify(items)]);
  // extra fields are refused (the share is its own step)
  assertEquals((await asA("PATCH", `/podcasts/${ep}`, { shared: true, share_digest: pv.json.share_digest, title: "x" })).status, 400);
});

t("E9: a non-owner can neither read the preview nor share nor unshare, even with the owner's digest; every answer is the missing episode's", async () => {
  await setup();
  const ep = W["ep-run"];
  const pv = await asA("GET", `/podcasts/${ep}/share-preview`);
  const ghost = crypto.randomUUID();
  const gp = await asB("GET", `/podcasts/${ghost}/share-preview`);
  for (const [m, p, b] of [
    ["GET", `/podcasts/${ep}/share-preview`, undefined], ["PATCH", `/podcasts/${ep}`, { shared: true, share_digest: pv.json.share_digest }],
    ["PATCH", `/podcasts/${ep}`, { shared: false }],
  ] as [string, string, unknown][]) {
    const r = await asB(m, p, b);
    assertEquals(r.status, 404, `${m} ${p}: ${r.text}`);
    const g = await asB(m, p.replace(ep, ghost), b);
    assertEquals(r.text, g.text, `${m}: a refusal for A's episode equals one for a missing episode`);
    noMarkers("refusal", r.text);
  }
  assertEquals(gp.status, 404);
  assertEquals((await asB("GET", `/podcasts/not-a-uuid/share-preview`)).status, 404);
  assertEquals((await sql<{ shared: boolean }>(`SELECT shared FROM public.podcast_episodes WHERE id = $1`, [ep]))[0].shared, false);
});

t("E10: the owner shares after the preview; only then does another user see the episode, and unsharing takes it away; no list is shown to B", async () => {
  await setup();
  const ep = W["ep-report"];
  const pv = await asA("GET", `/podcasts/${ep}/share-preview`);
  const ok = await asA("PATCH", `/podcasts/${ep}`, { shared: true, share_digest: pv.json.share_digest });
  assertEquals(ok.status, 200, ok.text);
  assertEquals(ok.json.shared, true);
  assertEquals(ok.json.disclosed, pv.json.would_share.length);
  const bl = await asB("GET", "/podcasts?limit=200");
  const seen = bl.json.podcasts.find((p: any) => p.id === ep);
  assert(seen && seen.mine === false && seen.team_id === null, "B sees the shared episode, not as theirs, without A's team");
  const un = await asA("PATCH", `/podcasts/${ep}`, { shared: false });
  assertEquals(un.status, 200);
  assert(!(await asB("GET", "/podcasts?limit=200")).json.podcasts.some((p: any) => p.id === ep), "unshared: gone from B's library");
});

t("E11: an episode without a request (a daily or archived one) still discloses itself; a legacy room transcript request discloses its transcript", async () => {
  await setup();
  const lone = crypto.randomUUID();
  await sql(`INSERT INTO public.podcast_episodes (id, owner_sub, shared, title, team_id, audio_format, archive_dir) VALUES ($1, $2, false, 'Daily', $3, 'mp3', '/mounts/podcast-archive/epf-lone')`, [lone, A, W.teama]);
  const pv = await asA("GET", `/podcasts/${lone}/share-preview`);
  assertEquals(pv.status, 200);
  assertEquals(pv.json.would_share.map((i: any) => i.type), ["episode"]);
  const tr = await asA("POST", "/podcasts/requests", { team_id: W.teama, title: "Room", transcript: { title: "Room", turns: [{ presenterId: `epf-p1-a-${RUN}`, text: "hello" }] } });
  assertEquals(tr.status, 202, tr.text);
  const e2 = crypto.randomUUID();
  await sql(`INSERT INTO public.podcast_episodes (id, owner_sub, shared, title, team_id, audio_format, archive_dir, request_id) VALUES ($1, $2, false, 'Room', $3, 'mp3', '/mounts/podcast-archive/epf-room', $4)`, [e2, A, W.teama, tr.json.id]);
  const p2 = await asA("GET", `/podcasts/${e2}/share-preview`);
  assertEquals(p2.json.would_share.map((i: any) => i.type), ["episode", "transcript"]);
});

t("E12: nothing of A's private material is on a shared surface: search, the shared library, the workbench's answers to B", async () => {
  await setup();
  for (const [k, v] of Object.entries(M)) {
    for (const path of [`/search?q=${v}&limit=50`, `/podcasts?limit=200`, `/podcasts/requests?limit=200`]) {
      const r = await asB("GET", path);
      assert(r.status < 500, `${path}: ${r.status}`);
      assert(!r.text.includes(v), `B's ${path} carries A's ${k} marker`);
    }
  }
  // the whole database, as shared tables: the markers' homes were checked in E2; here, the shared claim / source / thought / wiki stores
  for (const k of ["idea", "run", "report", "claim"] as const) {
    const hit = await tablesWith(M[k]);
    for (const shared of ["sources", "source_chunks", "claims", "thoughts", "wiki_pages", "threads", "podcast_episodes"]) assert(!hit.includes(shared), `${k} marker is in shared table ${shared}`);
  }
  assertNotEquals(await tablesWith(M.idea), [], "(control: the idea marker is found where it should be)");
});
