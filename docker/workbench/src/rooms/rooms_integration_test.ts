// deno test src/rooms/rooms_integration_test.ts - the room store and its scoped chat against a REAL
// database and a stub gateway named llama-cpp (rw-p8a3-room). SKIPPED unless ROOMS_TEST_BASE is set:
// contract-test/run-room-tests.ps1 runs it in its disposable lab. Never point it at a live stack.
//
// Environment:
//   ROOMS_TEST_BASE      the workbench with chat ON (WORKBENCH_CHAT_KEY = ROOMS_TEST_CHAT_KEY, the stub alias)
//   ROOMS_TEST_OFF_BASE  the same image with WORKBENCH_CHAT_KEY blank (as shipped)
//   ROOMS_TEST_MIS_BASE  the same image with WORKBENCH_CHAT_URL = http://llama-cpp-upstream:8080/v1 (a bypass)
//   ROOMS_TEST_STUB      the stub gateway (its /_log: every call with the host it was addressed to)
//   ROOMS_TEST_MM        the Mattermost stand-in (its /_log must stay empty)
//   ROOMS_TEST_KEY, ROOMS_TEST_CHAT_KEY, ROOMS_TEST_MODEL, CONTRACT_TEST_DB_HOST/_USER/_PASSWORD
// Users are the identity header's subjects (WORKSPACE_IDENTITY_HEADER=X-Test-Sub in the lab).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("ROOMS_TEST_BASE") ?? "").replace(/\/+$/, "");
const OFF = (Deno.env.get("ROOMS_TEST_OFF_BASE") ?? "").replace(/\/+$/, "");
const MIS = (Deno.env.get("ROOMS_TEST_MIS_BASE") ?? "").replace(/\/+$/, "");
const STUB = (Deno.env.get("ROOMS_TEST_STUB") ?? "").replace(/\/+$/, "");
const MM = (Deno.env.get("ROOMS_TEST_MM") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("ROOMS_TEST_KEY") ?? "";
const CHAT_KEY = Deno.env.get("ROOMS_TEST_CHAT_KEY") ?? "";
const MODEL = Deno.env.get("ROOMS_TEST_MODEL") ?? "";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !BASE || !OFF || !MIS || !STUB || !MM || !HOST;
const CHAT_OFF = "chat is off: the workbench-chat key is not configured";

const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const A = `room-alice-${rnd()}`;
const B = `room-bob-${rnd()}`;
const VEC = `[${[1, ...Array(1023).fill(0)].join(",")}]`; // the stub embedder's vector: these chunks rank first

let pool: Pool | null = null;
async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  pool ??= new Pool({
    hostname: HOST!, port: 5432, database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 2, true);
  const c = await pool.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}

async function call(base: string, who: string, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method, headers: { "content-type": "application/json", "x-brain-key": KEY, "X-Test-Sub": who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const stubLog = async (u: string) => (await (await fetch(`${u}/_log`)).json()) as Record<string, any>[];
const reset = async (u: string) => void (await (await fetch(`${u}/_reset`, { method: "POST" })).body?.cancel());

// ── the fixture: A's idea (a refinery) with a hidden source, a shared source, a held source; A's session
// started from a Mattermost thread ───────────────────────────────────────────────────────────────────
const M = { hidden: `HiddenPassage${rnd()}`, shared: `SharedPassage${rnd()}`, held: `HeldPassage${rnd()}`, upper: `UpperHiddenPassage${rnd()}`, permalink: `https://chat.lab.invalid/team/pl/${rnd()}` };
let idea = "", hiddenSrc = "", sharedSrc = "", heldSrc = "", session = "";
async function fixture() {
  if (idea) return;
  idea = (await sql<{ id: string }>(`INSERT INTO public.ideas (title, summary, status, owner_sub) VALUES ($1, 'room idea', 'new', $2) RETURNING id::text`, [`Room idea ${rnd()}`, A]))[0].id;
  hiddenSrc = (await sql<{ id: string }>(`INSERT INTO public.sources (title, content) VALUES ('room hidden source', $1) RETURNING id::text`, [M.hidden]))[0].id;
  sharedSrc = (await sql<{ id: string }>(`INSERT INTO public.sources (title, content) VALUES ('room shared source', $1) RETURNING id::text`, [M.shared]))[0].id;
  for (const [s, t] of [[hiddenSrc, M.hidden], [sharedSrc, M.shared]]) {
    await sql(`INSERT INTO public.source_chunks (source_id, idx, content, embedding) VALUES ($1, 0, $2, $3::vector)`, [s, t, VEC]);
  }
  heldSrc = (await sql<{ id: string }>(`INSERT INTO public.held_sources (refinery_id, title, content) VALUES ($1, 'room held source', $2) RETURNING id::text`, [idea, M.held]))[0].id;
  await sql(`INSERT INTO public.held_source_chunks (held_source_id, idx, content, embedding) VALUES ($1, 0, $2, $3::vector)`, [heldSrc, M.held, VEC]);
  await sql(`INSERT INTO public.refinery_hidden (refinery_id, node_kind, node_ref) VALUES ($1, 'source', $2)`, [idea, hiddenSrc]);
  session = (await sql<{ id: string }>(
    `INSERT INTO public.research_jobs (status, origin, query, inlet_ref) VALUES ('done', 'mattermost', 'a question from a thread', jsonb_build_object('kind', 'mattermost_permalink', 'id', $1::text))
     RETURNING id::text`, [M.permalink]))[0].id;
  await sql(`INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, $2, $2, 'a question from a thread')`, [session, A]);
}
const open = async (base: string, who: string, kind: string, id: string) => await call(base, who, "POST", "/workbench/rooms", { subject_kind: kind, subject_id: id });

const T = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, ignore, sanitizeOps: false, sanitizeResources: false, fn: async () => { await fixture(); await fn(); } });

T("R1 chat messages are room entries in the one per-user room store", async () => {
  await reset(STUB);
  const o = await open(BASE, A, "idea", idea);
  assertEquals(o.status, 201, o.text);
  const again = await open(BASE, A, "idea", idea);
  assertEquals([again.status, again.json.room?.id], [200, o.json.room.id], "one room per idea");
  const room = o.json.room.id;
  const q = `R1 question ${rnd()}`;
  const ch = await call(BASE, A, "POST", `/workbench/rooms/${room}/chat`, { text: q });
  assertEquals(ch.status, 201, ch.text);
  assertEquals(ch.json.entries.map((e: any) => e.kind), ["user", "assistant"]);
  const rows = await sql<{ kind: string; body: string; owner_sub: string }>(
    `SELECT e.kind, e.body, r.owner_sub FROM public.workspace_room_entries e JOIN public.workspace_rooms r ON r.id = e.room_id WHERE e.room_id = $1 ORDER BY e.seq`, [room]);
  assertEquals(rows.map((r) => [r.kind, r.owner_sub]), [["user", A], ["assistant", A]]);
  assertEquals(rows[0].body, q);
  // the transcript the room reads is exactly the store's
  const g = await call(BASE, A, "GET", `/workbench/rooms/${room}`);
  assertEquals(g.status, 200, g.text);
  assertEquals(g.json.entries.map((e: any) => e.body), rows.map((r) => r.body));
  assertEquals(g.json.chat.state, "on");
  // no chat outside the room store: the question is in no other table
  const elsewhere = await sql<{ t: string }>(
    `SELECT c.table_name AS t FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.data_type IN ('text', 'jsonb') AND c.table_name NOT IN ('workspace_room_entries')
        AND c.table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE')
      GROUP BY c.table_name`);
  const hits: string[] = [];
  for (const { t } of elsewhere) {
    const n = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public."${t}" x WHERE x::text LIKE '%' || $1 || '%'`, [q]);
    if (n[0].n) hits.push(t);
  }
  assertEquals(hits, [], "the chat message is stored in the room store only");
  console.log(`R1: room ${room.slice(0, 8)} holds the exchange; ${elsewhere.length} other tables searched, 0 hold it`);
});

T("R5 inference only through the LiteLLM alias under the workbench-chat key", async () => {
  await reset(STUB);
  const room = (await open(BASE, A, "idea", idea)).json.room.id;
  await call(BASE, A, "POST", `/workbench/rooms/${room}/chat`, { text: "R5 question" });
  const log = await stubLog(STUB);
  assertEquals(log.length, 1, JSON.stringify(log.map((l) => l.host)));
  assert(/^llama-cpp(:8080)?$/.test(log[0].host), `host ${log[0].host}`);
  assertEquals([log[0].path, log[0].auth, log[0].model], ["/v1/chat/completions", `Bearer ${CHAT_KEY}`, MODEL]);
  console.log(`R5: 1 call -> host ${log[0].host}, the chat's own bearer, model ${MODEL}`);
});

T("R5 chat OFF (blank key, as shipped): the fixed refusal, nothing written, nothing called; the room still reads", async () => {
  await reset(STUB);
  const room = (await open(OFF, A, "idea", idea)).json.room.id;
  const before = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.workspace_room_entries WHERE room_id = $1`, [room]))[0].n;
  const ch = await call(OFF, A, "POST", `/workbench/rooms/${room}/chat`, { text: "asked while chat is off" });
  assertEquals([ch.status, ch.json.error, ch.json.code], [503, CHAT_OFF, "chat-off"]);
  const after = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.workspace_room_entries WHERE room_id = $1`, [room]))[0].n;
  assertEquals(after, before, "nothing written");
  assertEquals((await stubLog(STUB)).length, 0, "nothing called");
  const g = await call(OFF, A, "GET", `/workbench/rooms/${room}`);
  assertEquals([g.status, g.json.chat?.state], [200, "off"]);
  console.log(`R5: chat off -> 503 "${ch.json.error}"; entries ${before} -> ${after}; 0 gateway calls`);
});

T("R5 a bypass (WORKBENCH_CHAT_URL = an *-upstream name) is refused before any request", async () => {
  await reset(STUB);
  const room = (await open(MIS, A, "idea", idea)).json.room.id;
  const ch = await call(MIS, A, "POST", `/workbench/rooms/${room}/chat`, { text: "asked through a bypass" });
  assertEquals([ch.status, ch.json.code], [503, "chat-misrouted"]);
  assertEquals((await stubLog(STUB)).length, 0, "the upstream alias was never called");
});

T("R2 an enabled-but-EMPTY source filter gives no context; scope off reads the whole knowledge database", async () => {
  const room = (await open(BASE, A, "session", session)).json.room.id;
  const sc = await call(BASE, A, "PUT", `/workbench/rooms/${room}/scope`, { enabled: true, sources: [] });
  assertEquals([sc.status, sc.json.room?.scope], [200, { enabled: true, sources: [] }]);
  await reset(STUB);
  const ch = await call(BASE, A, "POST", `/workbench/rooms/${room}/chat`, { text: "what do the sources say?" });
  assertEquals(ch.status, 201, ch.text);
  assertEquals(ch.json.entries[1].context, [], "no passage");
  const sys = String((await stubLog(STUB))[0]?.system ?? "");
  assert(sys.includes("Context: (none"), sys.slice(-200));
  for (const m of [M.shared, M.hidden, "Alpha fixture text", "One chunk of text"]) assert(!sys.includes(m), `the model was given ${m}`);
  // a listed filter reads only the listed source
  await call(BASE, A, "PUT", `/workbench/rooms/${room}/scope`, { enabled: true, sources: [sharedSrc] });
  const listed = await call(BASE, A, "POST", `/workbench/rooms/${room}/chat`, { text: "listed" });
  assertEquals([...new Set(listed.json.entries[1].context.map((c: any) => c.source_id))], [sharedSrc]);
  // scope off: the whole knowledge database
  await call(BASE, A, "PUT", `/workbench/rooms/${room}/scope`, { enabled: false, sources: [] });
  const all = await call(BASE, A, "POST", `/workbench/rooms/${room}/chat`, { text: "all" });
  const ids = new Set(all.json.entries[1].context.map((c: any) => c.source_id));
  assert(ids.has(sharedSrc) && ids.size > 1, JSON.stringify([...ids]));
  console.log(`R2: empty filter -> 0 passages (the model's context: none); listed -> [shared]; off -> ${ids.size} sources`);
});

T("R4 the refinery chat leaves out the refinery's hidden sources and keeps the rest; a hide narrows nothing outside it", async () => {
  const ir = (await open(BASE, A, "idea", idea)).json.room.id;
  await call(BASE, A, "PUT", `/workbench/rooms/${ir}/scope`, { enabled: false, sources: [] });
  await reset(STUB);
  const ch = await call(BASE, A, "POST", `/workbench/rooms/${ir}/chat`, { text: "refinery chat" });
  assertEquals(ch.status, 201, ch.text);
  const ids = new Set(ch.json.entries[1].context.map((c: any) => c.source_id));
  assert(!ids.has(hiddenSrc), "the hidden source is in the refinery chat's context");
  assert(ids.has(sharedSrc), "the rest of the knowledge database is kept");
  assert(ids.has(heldSrc), "the refinery's own held source is in its context");
  const sys = String((await stubLog(STUB))[0]?.system ?? "");
  assert(!sys.includes(M.hidden) && sys.includes(M.shared) && sys.includes(M.held), "the model saw what the context says");
  // a hidden source listed explicitly in the refinery chat's filter is still hidden
  await call(BASE, A, "PUT", `/workbench/rooms/${ir}/scope`, { enabled: true, sources: [hiddenSrc, sharedSrc] });
  const f = await call(BASE, A, "POST", `/workbench/rooms/${ir}/chat`, { text: "filtered refinery chat" });
  assertEquals([...new Set(f.json.entries[1].context.map((c: any) => c.source_id))], [sharedSrc]);
  await call(BASE, A, "PUT", `/workbench/rooms/${ir}/scope`, { enabled: false, sources: [] });
  // round 2 (tester N3): a hide typed in UPPER CASE through the contract's hide route still leaves the
  // source out of the refinery chat (setHidden normalises the id; the context rule compares case-blind)
  const upper = (await sql<{ id: string }>(`INSERT INTO public.sources (title, content) VALUES ('room upper-hidden source', $1) RETURNING id::text`, [M.upper]))[0].id;
  await sql(`INSERT INTO public.source_chunks (source_id, idx, content, embedding) VALUES ($1, 0, $2, $3::vector)`, [upper, M.upper, VEC]);
  const hid = await call(BASE, A, "POST", `/workbench/contract/ideas/${idea}/hidden`, { node_kind: "source", node_ref: upper.toUpperCase(), hidden: true });
  assertEquals(hid.status, 200, hid.text);
  const stored = await sql<{ r: string }>(`SELECT node_ref AS r FROM public.refinery_hidden WHERE refinery_id = $1 AND lower(node_ref) = $2`, [idea, upper]);
  assertEquals(stored.map((x) => x.r), [upper], "the hide is stored as the canonical (lower-case) id");
  // and a row written in upper case by anything else (an older writer) is matched too
  await sql(`INSERT INTO public.refinery_hidden (refinery_id, node_kind, node_ref) VALUES ($1, 'source', $2) ON CONFLICT DO NOTHING`, [idea, sharedSrc.toUpperCase()]);
  await reset(STUB);
  const up = await call(BASE, A, "POST", `/workbench/rooms/${ir}/chat`, { text: "refinery chat after an upper-case hide" });
  const uids = new Set(up.json.entries[1].context.map((c: any) => c.source_id));
  assert(!uids.has(upper), "an upper-case hide through the route left the source in the refinery chat");
  assert(!uids.has(sharedSrc), "an upper-case refinery_hidden row left the source in the refinery chat");
  assert(uids.has(heldSrc), "the rest is kept");
  const usys = String((await stubLog(STUB))[0]?.system ?? "");
  assert(!usys.includes(M.upper) && !usys.includes(M.shared), "the model saw an upper-case-hidden passage");
  await sql(`DELETE FROM public.refinery_hidden WHERE refinery_id = $1 AND node_ref = $2`, [idea, sharedSrc.toUpperCase()]);
  console.log(`R4 round 2: upper-case hides (route + raw row) leave both sources out of the refinery chat (${uids.size} sources)`);
  // outside the refinery (A's room on a session), the same hide narrows nothing
  const sr = (await open(BASE, A, "session", session)).json.room.id;
  await call(BASE, A, "PUT", `/workbench/rooms/${sr}/scope`, { enabled: false, sources: [] });
  const out = await call(BASE, A, "POST", `/workbench/rooms/${sr}/chat`, { text: "session chat" });
  const oids = new Set(out.json.entries[1].context.map((c: any) => c.source_id));
  assert(oids.has(hiddenSrc), "a refinery's hide narrowed a chat outside the refinery");
  assert(!oids.has(heldSrc), "a refinery's held source leaked into a chat outside it");
  console.log(`R4: refinery chat ${ids.size} sources (hidden out, shared + held in); session chat ${oids.size} sources (hidden in)`);
});

T("R3 a session started from a Mattermost thread shows the thread as its inlet with a link back; the room is the transcript; Mattermost is never called", async () => {
  await reset(MM);
  const o = await open(BASE, A, "session", session);
  const g = await call(BASE, A, "GET", `/workbench/rooms/${o.json.room.id}`);
  assertEquals(g.status, 200, g.text);
  assertEquals(g.json.subject.card.badge, { key: "mattermost", label: "Mattermost" });
  assertEquals([g.json.subject.card.link?.kind, g.json.subject.card.link?.href], ["external", M.permalink]);
  // the session's transcript is the room's entries, from the store
  const n = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.workspace_room_entries WHERE room_id = $1`, [o.json.room.id]))[0].n;
  assertEquals(g.json.entries.length, n);
  // another user's room on the same shared session: B's own room, no inlet (owner-only)
  const b = await open(BASE, B, "session", session);
  assertEquals(b.status, 201, b.text);
  assert(b.json.room.id !== o.json.room.id);
  const bg = await call(BASE, B, "GET", `/workbench/rooms/${b.json.room.id}`);
  assertEquals([bg.json.subject.card.link ?? null, bg.json.entries], [null, []]);
  assert(!bg.text.includes(M.permalink));
  assertEquals((await stubLog(MM)).length, 0, "the room read from or posted to Mattermost");
  console.log(`R3: A's session room links back to the thread; B's own room on it has no link and no transcript of A's; Mattermost calls: 0`);
});

T("R6 two users: another user's room, idea or scope by id is 404; the knowledge database stays shared", async () => {
  const a = (await open(BASE, A, "idea", idea)).json.room.id;
  for (const [m, p, b] of [["GET", `/workbench/rooms/${a}`, undefined], ["PUT", `/workbench/rooms/${a}/scope`, { enabled: true, sources: [] }],
    ["POST", `/workbench/rooms/${a}/chat`, { text: "B asks in A's room" }]] as const) {
    const r = await call(BASE, B, m, p, b);
    assertEquals(r.status, 404, `${m} ${p}: ${r.text}`);
  }
  const bi = await open(BASE, B, "idea", idea);
  assertEquals(bi.status, 404, "B opens a room on A's idea");
  const list = await call(BASE, B, "GET", "/workbench/rooms");
  assert(!list.text.includes(a) && !list.text.includes(idea), "B's list names A's room or idea");
  // A's scope was not changed by B's PUT
  const ga = await call(BASE, A, "GET", `/workbench/rooms/${a}`);
  assertEquals(ga.json.room.scope.enabled, false);
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.workspace_room_entries WHERE body = 'B asks in A''s room'`))[0].n, 0);
  // the shared knowledge database answers both alike
  const sa = await call(BASE, A, "GET", `/workbench/contract/sources/${sharedSrc}`);
  const sb = await call(BASE, B, "GET", `/workbench/contract/sources/${sharedSrc}`);
  assertEquals([sa.status, sa.text], [sb.status, sb.text]);
  console.log("R6: B -> A's room GET/PUT scope/POST chat = 404, A's idea = 404, B's list names neither; shared source reads alike");
});

Deno.test({ name: "close", ignore, sanitizeOps: false, sanitizeResources: false, fn: async () => { await pool?.end(); } });
