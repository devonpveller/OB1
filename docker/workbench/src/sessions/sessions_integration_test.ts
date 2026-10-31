// deno test src/sessions/sessions_integration_test.ts - research-workbench P4b (rw-p4b-sessions) end to
// end: the running-session cards, the stream, steer / cancel / narrow / add-source and the research flow,
// over the REAL research service (its P4a steer door) and the REAL workbench, signed in the way
// Authentik forward-auth signs users in (a lab signer mints the outpost's token, as in run-identity).
// Cases (the anchor's acceptance, numbered):
//   S1 every running session's card: phase, current artifact, waiting-on, next steering point, the tree
//   S2 a steer from the card is a pending branch in the steer's answer AND in the very next stream event
//   S3 a due-process step is not a steering point: refused 409, never offered by the card
//   S4 the flow: every source with its stages, each carrying its trail
//   S5 one card per origin (workspace, OWUI, Mattermost, notebook, Idea Refinery, manual), one shape,
//      a badge each, a working link where a reference exists; the admin steers the Mattermost job, the
//      steer is in the session, and agent-org's own poll (its post-back path) still reads the job
//   S6 an idea's session names the idea and links to its refinery room
//   S7 multi-user: another user's card carries no prompt, no inlet, no branch text, no step id; every
//      steer records actor_sub (an admin impersonating a user is recorded as the admin)
//   S8 authority: a service's job is steered / cancelled by an admin only (a non-admin 404, nothing
//      recorded; no other key may assert an admin); a user's job stays its owner's; single-user mode's
//      default subject counts as admin
//   S9 the OWUI link exists only under WORKSPACE_OWUI_BASE_URL; Mattermost / notebook are badge-only
// The research service in the lab has no model: every claimed job waits in a model call at a stub
// gateway that never answers, so it stays `running`. The stage events a real run would write while
// planning (a STEERING stage) and admitting a source (a source event with its trail) are written into
// research_job_events with the P4a schema's own constraints - the event SHAPES are P4a's, tested there.
// SKIPPED unless SESSIONS_TEST_VIEWER is set: contract-test/run-sessions-tests.ps1 runs it in its
// disposable lab. It imports nothing from the tree, so the RED run mounts it into the base image.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const E = (k: string) => Deno.env.get(k) ?? "";
const VIEWER = E("SESSIONS_TEST_VIEWER").replace(/\/+$/, "");
const WB_PLAIN = E("SESSIONS_TEST_WB_PLAIN").replace(/\/+$/, "");
const RS = E("SESSIONS_TEST_RESEARCH").replace(/\/+$/, "");
const INTERNAL = E("SESSIONS_TEST_INTERNAL_KEY");
const OWUI_BASE = E("SESSIONS_TEST_OWUI_BASE").replace(/\/+$/, "");
const K = { owui: E("SESSIONS_TEST_OWUI_KEY"), ao: E("SESSIONS_TEST_AO_KEY"), nb: E("SESSIONS_TEST_NB_KEY"), ws: E("SESSIONS_TEST_WS_KEY"), shared: INTERNAL };
const USERS = (E("SESSIONS_TEST_USERS") ? JSON.parse(E("SESSIONS_TEST_USERS")) : []) as { login: string; sub: string; name: string; groups: string[] }[];
const sub = (login: string) => USERS.find((u) => u.login === login)?.sub ?? "";
const FA = { iss: E("SESSIONS_TEST_FA_ISSUER"), aud: E("SESSIONS_TEST_FA_CLIENT_ID"), secret: E("SESSIONS_TEST_FA_SECRET") };
const ignore = !VIEWER;
const opts = { ignore, sanitizeOps: false, sanitizeResources: false };
const C = "/workbench/contract";
const CARD_KEYS = ["badge", "caller", "can_act", "created_at", "current_artifact", "finished_at", "id", "link", "next_steering_point",
  "origin", "phase", "query", "started_at", "state", "status", "tree", "waiting_on"];

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const p = new Pool({ hostname: E("CONTRACT_TEST_DB_HOST"), port: 5432, user: "postgres", password: E("CONTRACT_TEST_DB_PASSWORD"), database: "openbrain" }, 1, true);
  const c = await p.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
    await p.end();
  }
}

// ── the lab signer (Authentik's outpost token shape, HS256 with the lab client secret) ──────────
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function mint(login: string) {
  const u = USERS.find((x) => x.login === login);
  assert(u, `lab user ${login}`);
  const t = Math.floor(Date.now() / 1000);
  const data = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ iss: FA.iss, aud: FA.aud, sub: u.sub, exp: t + 3600, iat: t, name: u.name, preferred_username: login, groups: u.groups })}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(FA.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${data}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))))}`;
}

// A browser behind the edge: the outpost's token on every request, the viewer's Origin on every write.
class Browser {
  token = "";
  constructor(readonly base = VIEWER, readonly key = "") {}
  async signIn(login: string) {
    this.token = await mint(login);
    return this;
  }
  async req(method: string, path: string, body?: unknown) {
    const h: Record<string, string> = this.token ? { "x-authentik-jwt": this.token } : {};
    if (this.key) h["x-brain-key"] = this.key;
    if (!["GET", "HEAD"].includes(method)) {
      h.origin = this.base;
      h["content-type"] = "application/json";
    }
    const r = await fetch(this.base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await r.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  }
  // the session stream, as the panel reads it: every SSE event with its arrival time
  stream(path: string) {
    const ctl = new AbortController();
    const got: { event: string; data: any; at: number }[] = [];
    const h: Record<string, string> = this.token ? { "x-authentik-jwt": this.token } : {};
    if (this.key) h["x-brain-key"] = this.key;
    const done = (async () => {
      const r = await fetch(this.base + path, { headers: h, signal: ctl.signal });
      const rd = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await rd.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
            const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
            let j: any = data;
            try { j = JSON.parse(data); } catch { /* raw */ }
            got.push({ event: ev, data: j, at: Date.now() });
          }
        }
      } catch { /* aborted */ }
    })();
    return { got, stop: async () => { ctl.abort(); await done.catch(() => {}); } };
  }
}

async function submit(key: string, body: Record<string, unknown>) {
  const r = await fetch(`${RS}/research`, { method: "POST", headers: { "content-type": "application/json", "x-brain-key": key }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  assertEquals(r.status, 202, JSON.stringify(j));
  return String(j.job_id);
}
async function rs(method: string, path: string, key: string, headers: Record<string, string> = {}, body?: unknown) {
  const r = await fetch(`${RS}${path}`, { method, headers: { "content-type": "application/json", "x-brain-key": key, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = () => crypto.randomUUID().slice(0, 8);

// The planning stage (steering) and an admitted source (due process, with its trail), written as the
// harness writes them (P4a appendEvent: root, kind, step id; the schema refuses a source without a trail).
async function plantEvents(job: string, n = 1) {
  const root = (await sql<{ r: string }>(`SELECT coalesce(root_job_id, id)::text AS r FROM public.research_jobs WHERE id = $1`, [job]))[0].r;
  await sql(`INSERT INTO public.research_job_events (job_id, root_job_id, step_id, type, kind, payload)
             VALUES ($1, $2, 'p1', 'stage', 'due_process', '{"phase":"reuse","message":"recall"}'),
                    ($1, $2, 'p2', 'stage', 'steering', '{"phase":"plan","message":"planning"}')`, [job, root]);
  for (let i = 0; i < n; i++) {
    const url = `https://example.org/flow-${job.slice(0, 8)}-${i}`;
    const trail = { id: `t-${rnd()}`, url, kind: "admitted", claim_kind: "general", family: "general", score: 0.71, total: 0.71, floor: 0.4, model_version: "d15", signals: {}, reasons: ["lab"], found_via: null, path: [], source_url: null };
    await sql(`INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, trail, payload)
               VALUES ($1, $2, 'source', 'due_process', $3::jsonb, $4::jsonb)`, [job, root, JSON.stringify(trail), JSON.stringify({ url, outcome: "admitted" })]);
    await sql(`INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, trail, payload)
               VALUES ($1, $2, 'source', 'due_process', $3::jsonb, $4::jsonb)`, [job, root, JSON.stringify({ ...trail, kind: "lead_path" }), JSON.stringify({ url, outcome: "lead_path" })]);
  }
  await sql(`INSERT INTO public.research_job_events (job_id, root_job_id, step_id, type, kind, payload)
             VALUES ($1, $2, 'p3', 'stage', 'due_process', '{"phase":"gather","message":"fetching"}')`, [job, root]);
}

// ── the lab's sessions, one per origin, made once ─────────────────────────────────────────────
interface Lab { jobs: Record<string, string>; prompts: Record<string, string>; idea: string; alicePath: string }
let labP: Promise<Lab> | null = null;
function lab(): Promise<Lab> {
  return labP ??= (async () => {
    const prompts = { owui: `OwuiSessionsSecret${rnd()}`, ws: `WsSessionsSecret${rnd()}`, ao: `AgentQuestion${rnd()} about soil`,
      nb: `DigestQuestion${rnd()}`, manual: `ManualQuestion${rnd()}`, owuiProf: `ProfOwui${rnd()}` };
    const jobs: Record<string, string> = {};
    jobs.owui = await submit(K.owui, { query: prompts.owui, origin: "owui", on_behalf_of: sub("alice"), callback: { chat_id: "chat-alice-p4b", message_id: "m-1" } });
    jobs.owuiProf = await submit(K.owui, { query: prompts.owuiProf, origin: "owui", on_behalf_of: sub("prof"), callback: { chat_id: "chat-prof-p4b", message_id: "m-2" } });
    jobs.ao = await submit(K.ao, { query: prompts.ao, origin: "agent-org-advisory" });
    jobs.nb = await submit(K.nb, { query: prompts.nb, origin: "notebook" });
    jobs.manual = await submit(K.shared, { query: prompts.manual });
    // the workspace: alice's own document, research queued from it (the workbench writes her prompt row)
    const a = await new Browser().signIn("alice");
    const made = await a.req("POST", "/workbench/documents", { title: `Sessions doc ${rnd()}` });
    assertEquals(made.status, 201, made.text);
    const alicePath = String(made.json.path);
    const q = await a.req("POST", "/workbench/documents/research", { path: alicePath, query: prompts.ws, kind: "research" });
    assertEquals(q.status, 202, q.text);
    jobs.ws = String(q.json.job_id);
    // the Idea Refinery: alice's idea captured; its revision engages research at once (P4a trigger)
    const idea = (await sql<{ id: string }>(`INSERT INTO public.ideas (title, summary, status, owner_sub, thread_root)
                   VALUES ($1, 'an idea to research', 'new', $2, 'mm-room-p4b') RETURNING id::text`, [`Idea ${rnd()}`, sub("alice")]))[0].id;
    await sql(`INSERT INTO public.idea_revisions (idea_id, revision, summary) VALUES ($1, 1, 'an idea to research')`, [idea]);
    jobs.idea = (await sql<{ id: string }>(`SELECT id::text FROM public.research_jobs WHERE refinery_id = $1 ORDER BY created_at DESC LIMIT 1`, [idea]))[0]?.id;
    assert(jobs.idea, "the idea's revision queued its research");
    // every job claimed (it then waits in the stub gateway) - or still queued; both are running sessions
    for (let i = 0; i < 60; i++) {
      const st = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_jobs WHERE id = ANY($1::uuid[]) AND status IN ('queued','running')`, [Object.values(jobs)]);
      if (st[0].n === Object.keys(jobs).length) break;
      await sleep(500);
    }
    for (const j of Object.values(jobs)) await plantEvents(j, j === jobs.ao ? 2 : 1);
    return { jobs, prompts, idea, alicePath };
  })();
}

const cardsOf = async (b: Browser) => {
  const r = await b.req("GET", `${C}/sessions?limit=200`);
  assertEquals(r.status, 200, r.text);
  return new Map<string, any>((r.json.sessions as any[]).map((s) => [s.id, s]));
};

Deno.test({ name: "S1 every running session's card shows phase, current artifact, waiting-on, next steering point and its tree", ...opts, fn: async () => {
  const L = await lab();
  const cards = await cardsOf(await new Browser().signIn("admin"));
  for (const [name, id] of Object.entries(L.jobs)) {
    const c = cards.get(id);
    assert(c, `${name}: no card`);
    assert(c.phase && c.current_artifact?.label && c.waiting_on?.kind, `${name}: ${JSON.stringify(c)}`);
    assert(Array.isArray(c.tree) && c.tree.length >= 1, `${name}: a card without its tree`);
    for (const b of c.tree) assert(typeof b.open === "boolean", `${name}: a branch neither open nor closed`);
    assertEquals(c.next_steering_point?.phase, "plan", `${name}: the next steering point is the planning stage`);
  }
} });

Deno.test({ name: "S2 a steer from the card is a pending branch in its answer and within one stream event", ...opts, fn: async () => {
  const L = await lab();
  const ad = await new Browser().signIn("admin");
  const s = ad.stream(`${C}/sessions/${L.jobs.ao}/stream`);
  try {
    for (let i = 0; i < 40 && !s.got.some((e) => e.event === "card"); i++) await sleep(250);
    assert(s.got.some((e) => e.event === "card"), `the stream sends the card while the session runs: ${JSON.stringify(s.got.map((e) => e.event))}`);
    const before = s.got.length;
    const r = await ad.req("POST", `${C}/sessions/${L.jobs.ao}/steer`, { step_id: "p2", text: `narrow to raised beds ${rnd()}` });
    assertEquals(r.status, 201, r.text);
    const child = r.json.steer.child_job_id;
    const inAnswer = (r.json.card.tree as any[]).find((b) => b.id === child);
    assert(inAnswer?.pending && inAnswer.open, `the steer's answer shows the branch pending: ${JSON.stringify(r.json.card.tree)}`);
    for (let i = 0; i < 40 && !s.got.slice(before).some((e) => e.event === "card"); i++) await sleep(250);
    const next = s.got.slice(before).find((e) => e.event === "card");
    assert(next, "a card event followed the steer");
    assert((next.data.card.tree as any[]).some((b: any) => b.id === child), `the very next card event carries the new branch: ${JSON.stringify(next.data.card.tree)}`);
  } finally {
    await s.stop();
  }
} });

Deno.test({ name: "S3 a due-process step carries no steer: the card never offers one, the route refuses it 409", ...opts, fn: async () => {
  const L = await lab();
  const ad = await new Browser().signIn("admin");
  const c = (await cardsOf(ad)).get(L.jobs.nb);
  assertEquals(c.next_steering_point.step_id, "p2");
  const steps = await sql<{ step_id: string; kind: string }>(`SELECT step_id, kind FROM public.research_job_events WHERE job_id = $1 AND type = 'stage'`, [L.jobs.nb]);
  assertEquals(steps.find((x) => x.step_id === c.next_steering_point.step_id)?.kind, "steering");
  for (const step of ["p1", "p3"]) {
    const r = await ad.req("POST", `${C}/sessions/${L.jobs.nb}/steer`, { step_id: step, text: "steer at a fetch" });
    assertEquals(r.status, 409, `${step}: ${r.text}`);
  }
  const n = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_steers WHERE parent_job_id = $1`, [L.jobs.nb]);
  assertEquals(n[0].n, 0, "nothing was recorded");
} });

Deno.test({ name: "S4 the research flow: every source with its stages, each stage carrying its trail", ...opts, fn: async () => {
  const L = await lab();
  const ad = await new Browser().signIn("admin");
  const f = await ad.req("GET", `${C}/sessions/${L.jobs.ao}/flow`);
  assertEquals(f.status, 200, f.text);
  assertEquals(f.json.withheld, false);
  assertEquals(f.json.sources.length, 2);
  for (const s of f.json.sources) {
    assertEquals(s.stages.map((x: any) => x.kind), ["admitted", "lead_path"], s.url);
    for (const st of s.stages) assert(st.trail && st.trail.url === s.url && typeof st.trail.score === "number", `a stage without its trail: ${JSON.stringify(st)}`);
  }
  // the schema itself refuses a source event without its trail (P4a)
  let refused = false;
  try {
    await sql(`INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, payload) VALUES ($1, $1, 'source', 'due_process', '{}')`, [L.jobs.ao]);
  } catch { refused = true; }
  assert(refused, "a source event without a trail is refused by the database");
} });

Deno.test({ name: "S5 one card per origin, one shape, a badge each, working links; the admin's steer of the Mattermost job is in the session and agent-org's poll still reads the job", ...opts, fn: async () => {
  const L = await lab();
  const a = await new Browser().signIn("alice");
  const cards = await cardsOf(a);
  const want: Record<string, string> = { ws: "workspace", owui: "owui", ao: "mattermost", nb: "notebook", idea: "idea_refinery", manual: "manual" };
  const shapes = new Set<string>();
  for (const [name, badge] of Object.entries(want)) {
    const c = cards.get(L.jobs[name]);
    assert(c, `${name}: no card for alice`);
    assertEquals(Object.keys(c).sort(), CARD_KEYS, `${name}: the card's shape`);
    shapes.add(JSON.stringify(Object.keys(c).sort()));
    assertEquals(c.badge.key, badge, `${name}: badge`);
    assert(c.badge.label, `${name}: a badge label`);
  }
  assertEquals(shapes.size, 1, "one shape for every origin");
  // the links back, and that they work (each target answers alice)
  const ws = cards.get(L.jobs.ws).link;
  assertEquals([ws.kind, ws.panel, ws.params.path], ["panel", "document", L.alicePath]);
  assertEquals((await a.req("GET", `/workbench/documents/file?path=${encodeURIComponent(ws.params.path)}`)).status, 200);
  const ow = cards.get(L.jobs.owui).link;
  assertEquals(ow, { kind: "external", href: `${OWUI_BASE}/c/chat-alice-p4b`, panel: null, params: {} });
  const id = cards.get(L.jobs.idea).link;
  assertEquals([id.panel, id.params.idea_id, id.params.focus], ["refinery", L.idea, "room"]);
  const idea = await a.req("GET", `${C}/ideas/${id.params.idea_id}`);
  assertEquals(idea.status, 200, idea.text);
  const man = cards.get(L.jobs.manual).link;
  assertEquals([man.panel, man.params.session], ["sessions", L.jobs.manual]);
  assertEquals((await a.req("GET", `${C}/sessions/${man.params.session}`)).status, 200);
  assertEquals(cards.get(L.jobs.ao).link, null, "Mattermost: badge only (no permalink is sent)");
  assertEquals(cards.get(L.jobs.nb).link, null, "notebook: badge only (no run id is sent)");
  // the admin steers the Mattermost-started job from its card
  const ad = await new Browser().signIn("admin");
  const before = (await rs("GET", `/research/jobs/${L.jobs.ao}`, K.ao)).json;
  const r = await ad.req("POST", `${C}/sessions/${L.jobs.ao}/steer`, { step_id: "p2", text: `focus on clay soils ${rnd()}` });
  assertEquals(r.status, 201, r.text);
  const st = await sql<{ actor_sub: string; caller: string; steer_kind: string }>(`SELECT actor_sub, caller, steer_kind FROM public.research_steers WHERE id = $1`, [r.json.steer.steer_id]);
  assertEquals(st[0], { actor_sub: sub("admin"), caller: "workspace", steer_kind: "human" }, "the steer is recorded with its actor");
  const ev = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_job_events WHERE job_id = $1 AND type = 'human_steer' AND payload ->> 'steer_id' = $2`, [L.jobs.ao, r.json.steer.steer_id]);
  assertEquals(ev[0].n, 1, "the session records where it was steered");
  // the thread's post-back: agent-org polls its job with its own key - unchanged by the steer, and the
  // finished run is what it reads (the parent's status was never written by the steer)
  const after = (await rs("GET", `/research/jobs/${L.jobs.ao}`, K.ao)).json;
  assertEquals([after.id, after.status], [before.id, before.status]);
  await sql(`UPDATE public.research_jobs SET status = 'done', finished_at = now(), result = jsonb_build_object('synthesis', 'Clay soils hold water.', 'outcome', 'answered') WHERE id = $1`, [L.jobs.ao]);
  const done = await rs("GET", `/research/jobs/${L.jobs.ao}`, K.ao);
  assertEquals([done.status, done.json.status, done.json.result?.synthesis], [200, "done", "Clay soils hold water."], done.text);
} });

Deno.test({ name: "S6 an idea's session names the idea and links to its refinery room", ...opts, fn: async () => {
  const L = await lab();
  const a = await new Browser().signIn("alice");
  const c = (await cardsOf(a)).get(L.jobs.idea);
  assertEquals(c.badge, { key: "idea_refinery", label: "Idea Refinery" });
  assertEquals(c.link.params.idea_id, L.idea, "the idea is the inlet reference");
  // the link's target: the idea's refinery, whose room the refinery panel shows (focus: room)
  const idea = (await a.req("GET", `${C}/ideas/${L.idea}`)).json;
  assertEquals(idea.id, L.idea);
  assertEquals([idea.room?.location, idea.refinery?.members?.room], ["mattermost:thread:mm-room-p4b", "mm-room-p4b"]);
  assertEquals(idea.refinery.members.sessions.includes(L.jobs.idea), true, "the idea lists the session it triggered");
} });

Deno.test({ name: "S7 another user's card carries no prompt, inlet, branch text or step id; every steer records actor_sub", ...opts, fn: async () => {
  const L = await lab();
  const bo = await new Browser().signIn("bob");
  const all = await bo.req("GET", `${C}/sessions?limit=200`);
  for (const p of [L.prompts.owui, L.prompts.ws]) assert(!all.text.includes(p), "bob's list carries alice's prompt");
  for (const leak of ["chat-alice-p4b", L.alicePath, L.idea]) assert(!all.text.includes(leak), `bob's list carries ${leak}`);
  const cards = new Map<string, any>((all.json.sessions as any[]).map((s) => [s.id, s]));
  for (const name of ["owui", "ws", "idea"]) {
    const c = cards.get(L.jobs[name]);
    assert(c, `${name}: shared research is listed for bob`);
    assertEquals([c.query, c.link, c.can_act, c.next_steering_point?.step_id ?? null], ["", null, false, null], `${name}: ${JSON.stringify(c)}`);
    assert(c.tree.every((b: any) => b.query === "" && b.rooted_step_id === null), `${name}: branch text or step`);
    for (const p of [`${C}/sessions/${L.jobs[name]}/flow`, `${C}/sessions/${L.jobs[name]}`]) {
      const r = await bo.req("GET", p);
      for (const x of [L.prompts.owui, L.prompts.ws, "chat-alice-p4b", L.alicePath]) assert(!r.text.includes(x), `${p} carries ${x}`);
    }
    const s = bo.stream(`${C}/sessions/${L.jobs[name]}/stream`);
    await sleep(2500);
    await s.stop();
    const text = JSON.stringify(s.got);
    assert(s.got.some((e) => e.event === "card"), `${name}: bob's stream carries the shared card`);
    for (const x of [L.prompts.owui, L.prompts.ws, "chat-alice-p4b", L.alicePath, "\"p2\""]) assert(!text.includes(x), `${name}: bob's stream carries ${x}`);
    const fl = await bo.req("GET", `${C}/sessions/${L.jobs[name]}/flow`);
    assertEquals([fl.json.withheld, fl.json.sources.length], [true, 0]);
  }
  // alice steers her own job: the actor is alice
  const a = await new Browser().signIn("alice");
  const own = await a.req("POST", `${C}/sessions/${L.jobs.owui}/steer`, { step_id: "p2", text: `only peer-reviewed ${rnd()}` });
  assertEquals(own.status, 201, own.text);
  assertEquals((await sql(`SELECT actor_sub FROM public.research_steers WHERE id = $1`, [own.json.steer.steer_id]))[0].actor_sub, sub("alice"));
  // the admin, impersonating alice (a reason first), steers alice's job as alice - recorded as the admin
  const ad = await new Browser().signIn("admin");
  const go = await ad.req("POST", "/workbench/auth/impersonate", { sub: sub("alice"), reason: `checking alice's session card ${rnd()}` });
  assertEquals(go.status, 200, go.text);
  try {
    const imp = await ad.req("POST", `${C}/sessions/${L.jobs.ws}/steer`, { step_id: "p2", text: `steered while impersonating ${rnd()}` });
    assertEquals(imp.status, 201, imp.text);
    assertEquals((await sql(`SELECT actor_sub FROM public.research_steers WHERE id = $1`, [imp.json.steer.steer_id]))[0].actor_sub, sub("admin"));
  } finally {
    await ad.req("POST", "/workbench/auth/impersonate/end", {});
  }
  const unrecorded = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_steers WHERE actor_sub IS NULL OR btrim(actor_sub) = ''`);
  assertEquals(unrecorded[0].n, 0);
} });

Deno.test({ name: "S8 a service's job is steered and cancelled by an admin only; a user's job stays its owner's; no other key asserts an admin", ...opts, fn: async () => {
  const L = await lab();
  const ca = await new Browser().signIn("carol");
  const c = (await cardsOf(ca)).get(L.jobs.nb);
  assertEquals([c.can_act, c.next_steering_point.step_id], [false, null], "a non-admin's card offers no steer or cancel");
  const n0 = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_steers`))[0].n;
  assertEquals((await ca.req("POST", `${C}/sessions/${L.jobs.nb}/steer`, { step_id: "p2", text: "carol narrows" })).status, 404);
  assertEquals((await ca.req("POST", `${C}/sessions/${L.jobs.nb}/cancel`, {})).status, 404);
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_steers`))[0].n, n0, "nothing recorded");
  // straight to the research service: only the workspace key may assert an admin
  for (const [who, key] of [["owui", K.owui], ["agent-org", K.ao], ["notebook", K.nb], ["shared", K.shared]] as const) {
    const r = await rs("POST", `/research/jobs/${L.jobs.nb}/steer`, key, { "x-on-behalf-of": sub("carol"), "x-actor-admin": "1" }, { step_id: "p2", text: "forged admin" });
    assert(r.status === 403, `${who} asserting an admin: ${r.status} ${r.text}`);
  }
  const wsNonAdmin = await rs("POST", `/research/jobs/${L.jobs.nb}/steer`, K.ws, { "x-on-behalf-of": sub("carol") }, { step_id: "p2", text: "carol direct" });
  assertEquals(wsNonAdmin.status, 404, "the workspace key on behalf of a non-admin: refused as today");
  // the admin: the service's job yes (steer and cancel), alice's job no
  const ad = await new Browser().signIn("admin");
  const cd = (await cardsOf(ad)).get(L.jobs.nb);
  assertEquals(cd.can_act, true);
  const stA = await ad.req("POST", `${C}/sessions/${L.jobs.nb}/steer`, { step_id: "p2", text: `narrow ${rnd()}`, contract: { budget: { max_fetch: 3 }, sources: { deny: ["example.com"] } } });
  assertEquals(stA.status, 201, stA.text);
  const childOpts = (await sql<{ o: any }>(`SELECT options AS o FROM public.research_jobs WHERE id = $1`, [stA.json.steer.child_job_id]))[0].o;
  assertEquals([childOpts.contract?.budget?.max_fetch, childOpts.contract?.sources?.deny], [3, ["example.com"]], "narrow: the branch's contract");
  const addS = await ad.req("POST", `${C}/sessions/${L.jobs.nb}/steer`, { step_id: "p2", text: "use this source", add_source: { url: "https://example.org/added", title: "Added", content: "the added text" } });
  assertEquals(addS.status, 201, addS.text);
  const seeded = (await sql<{ o: any }>(`SELECT options AS o FROM public.research_jobs WHERE id = $1`, [addS.json.steer.child_job_id]))[0].o;
  assertEquals(seeded.seed_sources?.[0]?.url, "https://example.org/added", "add-source: the branch is seeded");
  assertEquals((await ad.req("POST", `${C}/sessions/${L.jobs.owui}/steer`, { step_id: "p2", text: "admin on a user's job" })).status, 404);
  assertEquals((await ad.req("POST", `${C}/sessions/${L.jobs.owui}/cancel`, {})).status, 404);
  const can = await ad.req("POST", `${C}/sessions/${L.jobs.manual}/cancel`, { reason: "admin cancels a service job" });
  assertEquals(can.status, 200, can.text);
  assert(["cancelled", "cancelling"].includes(can.json.status), can.text);
  // single-user mode (no sign-in configured): the default subject counts as admin
  if (WB_PLAIN) {
    const plain = new Browser(WB_PLAIN, INTERNAL);
    const pc = (await plain.req("GET", `${C}/sessions?limit=200`)).json.sessions.find((x: any) => x.id === L.jobs.nb);
    assertEquals(pc?.can_act, true, "single-user: the default subject may act on a service job");
    const ps = await plain.req("POST", `${C}/sessions/${L.jobs.nb}/steer`, { step_id: "p2", text: `single-user steer ${rnd()}` });
    assertEquals(ps.status, 201, ps.text);
    assertEquals((await sql(`SELECT actor_sub FROM public.research_steers WHERE id = $1`, [ps.json.steer.steer_id]))[0].actor_sub, sub("prof"));
  }
} });

Deno.test({ name: "S9 the OWUI link only under WORKSPACE_OWUI_BASE_URL; Mattermost and notebook badge-only; nothing invented", ...opts, ignore: ignore || !WB_PLAIN, fn: async () => {
  const L = await lab();
  // the single-user workbench ships the setting blank: prof's own OWUI job has no link, keeps its badge
  const plain = new Browser(WB_PLAIN, INTERNAL);
  const cards = new Map<string, any>(((await plain.req("GET", `${C}/sessions?limit=200`)).json.sessions as any[]).map((s) => [s.id, s]));
  const c = cards.get(L.jobs.owuiProf);
  assertEquals([c.badge.key, c.link], ["owui", null]);
  // the signed-in workbench has it set: the same job links to its chat
  const pr = await new Browser().signIn("prof");
  const d = (await cardsOf(pr)).get(L.jobs.owuiProf);
  assertEquals(d.link?.href, `${OWUI_BASE}/c/chat-prof-p4b`);
  for (const k of ["ao", "nb"]) assertEquals((await cardsOf(pr)).get(L.jobs[k])?.link ?? null, null, `${k}: no link invented`);
} });
