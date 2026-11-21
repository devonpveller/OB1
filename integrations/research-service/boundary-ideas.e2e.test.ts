/**
 * boundary-ideas.e2e.test.ts - rw-boundary-ideas (plan 09 PD0b) against a LAB database carrying the full initdb chain
 * (slots 420 and 580 included), as the production app role (ob_app_memory). run-boundary-ideas-lab.ps1 runs it.
 *
 * Every personal field of an idea carries its own marker (title TIT, summary SUM, revision text REV, domain DOM, a link's
 * query string QRY, the idea room's draft and entry ROOM). The ideas are written the way every door writes them - the
 * SQL functions openbrain-mcp's capture_idea / update_idea / research_idea, the workbench and the refinery call
 * (idea_capture, idea_edit, idea_research, idea_research_now, idea_schedule_set / idea_schedule_drain) - as ob_app_memory.
 *
 *   R1-db  (acceptance 1, the RED case on the pre-580 code): captured, updated, scheduled and research-now'd, the ideas'
 *          markers are in ideas / idea_revisions / research_handbacks (and the owner's room) ONLY - no shared row, no job.
 *   C      (acceptance 3) coalescing: edits while a hand-back is pending fold into it; an edit while its derived job is
 *          still queued withdraws that job and the hand-back pends again on the new revision - one queued job per idea.
 *   B      (420 reviewer R-F4) an idea hand-back is bound to the idea's owner; the door refuses an idea; a second user
 *          reaches nothing of another user's idea through any slot-580 function.
 *   D      the REAL research service (index.ts) drains the hand-backs through the boundary with a HOSTILE proposer (it
 *          returns every field verbatim): the link idea -> a derived job (the template), the link-less idea ->
 *          awaiting_owner with the owner's review; the owner's approval (identity refused, a clean edit -> derived) over
 *          HTTP as the workspace's key; "run privately" -> a 'personal' job whose report is the owner's; the refinery's
 *          deliverables; then THE SWEEP over every shared table, the egress (search, page fetches, curator packages) and
 *          the second user's reads (acceptance 1, 2, 4).
 * IGNORED unless BND_E2E_DB_HOST is set. Never point it at a live database. Counts only, never content.
 * BND_IDEAS_RED=1 runs R1-db only and EXPECTS hits (the pre-580 chain: the RED run).
 */
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Pool } from "postgres";
import { MK, OWNER } from "./fixtures/boundary-markers.ts";
import { describe, sweepTables, sweepText } from "./fixtures/boundary-sweep.ts";

const DB_HOST = Deno.env.get("BND_E2E_DB_HOST") ?? "";
const DB_PASSWORD = Deno.env.get("BND_E2E_DB_PASSWORD") ?? "";
const APP_PASSWORD = Deno.env.get("BND_E2E_APP_PASSWORD") ?? "";
const SERVICE_DIR: string | URL = Deno.env.get("BND_E2E_SERVICE_DIR") ?? new URL(".", import.meta.url);
const PAGES_PORT = Deno.env.get("BND_E2E_PAGES_PORT") ?? "8080";
const RED = Deno.env.get("BND_IDEAS_RED") === "1";
const ignore = !DB_HOST;
const opts = { ignore, sanitizeOps: false, sanitizeResources: false };
const greenOnly = { ...opts, ignore: ignore || RED };
const SHARED = "e2e-shared-key-000000";
const OWUI = "e2e-owui-key-0000000000", WORKSPACE = "e2e-workspace-key-00000";
const BEE = "user-bee-second";
const ROOM = "zqROMm2c4e6a8b";   // the idea room's draft and entry (private to the owner)
const PRV = "zqPRVm5e7a9c1d";    // the owner's own words for a private run (D7: by their choice, private report)
const IDEA_MK: Record<string, string> = { TIT: MK.TIT, SUM: MK.SUM, REV: MK.REV, DOM: MK.DOMAIN, QRY: MK.QRY, ROOM };
const PRIVATE_TABLES = (t: string) =>
  t === "research_handbacks" || t.endsWith("_archive") || ["ideas", "idea_revisions", "workspace_rooms", "workspace_room_entries"].includes(t);

function pool(user: "postgres" | "ob_app_memory") {
  return new Pool({ hostname: DB_HOST, port: 5432, database: "openbrain", user, password: user === "postgres" ? DB_PASSWORD : APP_PASSWORD }, 2, true);
}
const su = ignore ? null : pool("postgres");
const app = ignore ? null : pool("ob_app_memory");
async function q<T = Record<string, unknown>>(p: Pool | null, text: string, args: unknown[] = []): Promise<T[]> {
  const c = await p!.connect();
  try { return (await c.queryObject<T>(text, args)).rows; } finally { c.release(); }
}
async function refused(p: Pool | null, text: string, args: unknown[] = []): Promise<string> {
  try { await q(p, text, args); } catch (e) { return String((e as Error).message); }
  throw new Error(`not refused: ${text.slice(0, 120)}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const page = (p: string) => `http://news.example.org:${PAGES_PORT}${p}`;
const ACTOR = "service:openbrain-mcp";

// the ideas of the run (filled by R1-db, read by the later steps)
const ids: Record<string, string> = {};
const capture = async (owner: string, title: string, summary: string) =>
  (await q<{ id: string }>(app, `SELECT public.idea_capture($1, $2, $3, $4, $5, NULL)::text AS id`, [owner, ACTOR, title, summary, MK.DOMAIN]))[0].id;
const edit = async (id: string, owner: string, summary: string) =>
  (await q<{ o: { outcome: string } }>(app, `SELECT public.idea_edit($1::uuid, $2, $3, $4, NULL, NULL, NULL) AS o`, [id, owner, ACTOR, summary]))[0].o;

Deno.test({ name: "R1-db. captured, updated, scheduled, research-now'd: the markers are in the private tables only (no job carries the idea)", ...opts, fn: async () => {
  await q(su, `INSERT INTO public.workspace_users (sub, name, email) VALUES ($1, $2, $3), ($4, 'Bee Second', 'bee@example.net') ON CONFLICT (sub) DO NOTHING`,
    [OWNER.sub, OWNER.name, OWNER.email, BEE]);
  // A: no link (the boundary cannot phrase it -> the owner's review); L: a public link (the template phrases it)
  ids.A = await capture(OWNER.sub, `${MK.TIT} winter plan`, `${MK.SUM} the cheap solar roof plan for my winter cabin`);
  ids.L = await capture(OWNER.sub, `${MK.TIT} solar`, `${MK.SUM} community roofs, see ${page("/solar-roofs")}?u=${MK.QRY} for my street`);
  // updated (a new revision) and research-now'd (idea_research, the workbench / MCP door)
  assertEquals((await edit(ids.L, OWNER.sub, `${MK.REV} ${MK.SUM} community roofs, see ${page("/solar-roofs")}?u=${MK.QRY} again`)).outcome, "changed");
  const now = (await q<{ o: Record<string, string> }>(app, `SELECT public.idea_research($1::uuid, $2, $3) AS o`, [ids.L, OWNER.sub, ACTOR]))[0].o;
  assertEquals(now.outcome, "queued");
  // P: no link, for "run privately"
  ids.P = await capture(OWNER.sub, `${MK.TIT} private`, `${MK.SUM} something only I care about`);
  // S: the owner's schedule (daily): captured deferred, then the scheduler pass (idea_schedule_drain, the refinery's poll)
  await q(app, `SELECT public.idea_schedule_set($1, $1, 'daily', '03:00', NULL, 'UTC')`, [OWNER.sub]);
  ids.S = await capture(OWNER.sub, `${MK.TIT} scheduled`, `${MK.SUM} a scheduled idea`);
  await q(app, `SELECT public.idea_schedule_drain(now() + interval '2 days')`);
  await q(app, `SELECT public.idea_schedule_set($1, $1, 'immediate', NULL, NULL, 'UTC')`, [OWNER.sub]);
  // the owner's room: its draft and a note carry their own marker
  const room = (await q<{ r: string }>(app, `SELECT public.idea_room($1::uuid)::text AS r`, [ids.A]))[0].r;
  await q(su, `UPDATE public.workspace_rooms SET draft = $2 WHERE id = $1::uuid`, [room, `${ROOM} my draft`]);
  await q(su, `INSERT INTO public.workspace_room_entries (room_id, actor_sub, kind, body) VALUES ($1::uuid, $2, 'note', $3)`, [room, OWNER.sub, `${ROOM} a note`]).catch(() => {});
  const sc = await su!.connect();
  let res: Awaited<ReturnType<typeof sweepTables>>;
  try { res = await sweepTables(sc, IDEA_MK, PRIVATE_TABLES); } finally { sc.release(); }
  console.log(`R1-db ${describe(res)}`);
  const jobs = (await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM public.research_jobs WHERE refinery_id = ANY($1::uuid[]) OR inlet_ref ->> 'id' = ANY($2)`,
    [Object.values(ids), Object.values(ids)]))[0].n;
  console.log(`R1-db jobs naming an idea: ${jobs}`);
  if (RED) {
    assert(res.hits.length > 0 || jobs > 0, "RED: the pre-580 queue writes the idea onto a shared job row");
    return;
  }
  assertEquals(res.hits, [], "no marker in any shared table (the queue writes a private hand-back, never a job)");
  assertEquals(jobs, 0, "no job names an idea");
  for (const t of ["ideas", "idea_revisions"]) assert(res.private.some((h) => h.table === t), `the markers ARE in ${t} (not vacuous)`);
  const hb = await q<{ inlet_id: string; state: string; inlet_revision: number }>(su,
    `SELECT inlet_id, state, inlet_revision FROM public.research_handbacks WHERE purpose = 'idea-research' ORDER BY created_at`);
  for (const k of ["A", "L", "P", "S"]) assertEquals(hb.filter((h) => h.inlet_id === ids[k] && h.state === "pending").length, 1, `one pending hand-back for ${k}`);
  assertEquals(hb.find((h) => h.inlet_id === ids.L)!.inlet_revision, 2, "the update and research now folded into ONE pending row on the latest revision");
}});

Deno.test({ name: "C. coalescing: a change while pending folds; a change while the derived job is QUEUED withdraws it - one queued job per idea", ...greenOnly, fn: async () => {
  const id = await capture(OWNER.sub, "coalescing idea", "first text about roofs");
  for (let i = 2; i <= 4; i++) assertEquals((await edit(id, OWNER.sub, `text number ${i} about roofs`)).outcome, "changed");
  const open = () => q<{ id: string; state: string; inlet_revision: number; job_id: string | null }>(su,
    `SELECT id::text, state, inlet_revision, job_id::text FROM public.research_handbacks WHERE inlet_id = $1 AND state IN ('pending','queued') ORDER BY created_at`, [id]);
  let o = await open();
  assertEquals(o.map((h) => [h.state, h.inlet_revision]), [["pending", 4]], "four revisions, one pending hand-back on the latest");
  // the drain's outcome on it (a derived job, queued; as the research service settles it)
  const STAMP = JSON.stringify({ version: "pd0b-1", lexicon: "a".repeat(64), verdict_id: "b".repeat(64), evidence: [] });
  const job = (await q<{ id: string }>(app, `INSERT INTO public.research_jobs (status, origin, caller, query, anchor, options, request_kind, boundary)
     VALUES ('queued', 'manual', 'boundary', 'What is known about roof designs?', 'What is known about roof designs?', '{"public_links":[],"queue_origin":"manual"}'::jsonb, 'derived', $1::jsonb) RETURNING id::text AS id`, [STAMP]))[0].id;
  assertFalse((await q<{ ok: boolean }>(app, `SELECT public.idea_handback_settle($1::uuid, 3, $2::uuid, 'queued', '{}'::jsonb, NULL) AS ok`, [o[0].id, job]))[0].ok,
    "a settle against an older revision is refused (an edit came first)");
  assert((await q<{ ok: boolean }>(app, `SELECT public.idea_handback_settle($1::uuid, 4, $2::uuid, 'queued', '{}'::jsonb, NULL) AS ok`, [o[0].id, job]))[0].ok);
  const stamped = (await q<{ last: string; rev: string }>(su, `SELECT i.last_job_id AS last, r.research_job_id AS rev FROM public.ideas i JOIN public.idea_revisions r ON r.idea_id = i.id AND r.revision = 4 WHERE i.id = $1::uuid`, [id]))[0];
  assertEquals([stamped.last, stamped.rev], [job, job], "the drain stamps ideas.last_job_id and idea_revisions.research_job_id");
  assertEquals((await q<{ r: unknown; i: unknown }>(su, `SELECT refinery_id AS r, inlet_ref AS i FROM public.research_jobs WHERE id = $1::uuid`, [job]))[0], { r: null, i: null },
    "the stamp copied nothing of the idea onto the shared job");
  // a change while that job is still queued: the job is withdrawn and the SAME hand-back pends on revision 5
  await edit(id, OWNER.sub, "text number 5 about roofs");
  o = await open();
  assertEquals(o.map((h) => [h.state, h.inlet_revision, h.job_id]), [["pending", 5, null]]);
  assertEquals((await q<{ s: string }>(su, `SELECT status AS s FROM public.research_jobs WHERE id = $1::uuid`, [job]))[0].s, "cancelled");
  // a change while a job RUNS: the one follow-up (queued + pending side by side; still one QUEUED job)
  const job2 = (await q<{ id: string }>(app, `INSERT INTO public.research_jobs (status, origin, caller, query, anchor, options, request_kind, boundary)
     VALUES ('queued', 'manual', 'boundary', 'What is known about roof designs?', 'What is known about roof designs?', '{"public_links":[],"queue_origin":"manual"}'::jsonb, 'derived', $1::jsonb) RETURNING id::text AS id`, [STAMP]))[0].id;
  assert((await q<{ ok: boolean }>(app, `SELECT public.idea_handback_settle($1::uuid, 5, $2::uuid, 'queued', '{}'::jsonb, NULL) AS ok`, [o[0].id, job2]))[0].ok);
  await q(su, `UPDATE public.research_jobs SET status = 'running', started_at = now() WHERE id = $1::uuid`, [job2]);
  await edit(id, OWNER.sub, "text number 6 about roofs");
  o = await open();
  assertEquals(o.map((h) => [h.state, h.inlet_revision]), [["queued", 5], ["pending", 6]], "the running job keeps going; one follow-up pends");
  await edit(id, OWNER.sub, "text number 7 about roofs");
  assertEquals((await open()).filter((h) => h.state === "pending").map((h) => h.inlet_revision), [7], "and further changes fold into that one");
  const queuedJobs = (await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM public.research_jobs j JOIN public.research_handbacks h ON h.job_id = j.id WHERE h.inlet_id = $1 AND j.status = 'queued'`, [id]))[0].n;
  assertEquals(queuedJobs, 0, "never two queued jobs for one idea");
  await q(su, `UPDATE public.research_jobs SET status = 'done', finished_at = now() WHERE id = $1::uuid`, [job2]);
  ids.C = id;
  console.log("coalescing: 4 revisions -> 1 pending; stale settle refused; queued job withdrawn on change; running job + 1 follow-up");
}});

Deno.test({ name: "B. R-F4: an idea hand-back is bound to the idea's owner; the door refuses ideas; the second user reaches nothing", ...greenOnly, fn: async () => {
  // through 420's own function, as any key holder could: another owner for the owner's idea, a non-idea purpose, no idea
  for (const [owner, kind, inlet, purpose] of [[BEE, "idea", ids.A, "idea-research"], [OWNER.sub, "idea", ids.A, "digest-gap"],
    [OWNER.sub, "gmail", ids.A, "idea-research"], [OWNER.sub, "idea", "8b0c4f5e-1d2a-4b3c-9e8f-000000000000", "idea-research"]]) {
    const m = await refused(app, `SELECT public.handback_open($1, $2, $3, NULL, $4, NULL, 'awaiting_owner', NULL, '{"candidate":"x"}'::jsonb, NULL)`, [owner, kind, inlet, purpose]);
    assert(m.includes("research_handbacks: an idea hand-back"), `${owner}/${kind}/${purpose}: ${m.slice(0, 120)}`);
  }
  assert((await refused(su, `UPDATE public.research_handbacks SET owner_sub = $2 WHERE inlet_id = $1`, [ids.A, BEE])).includes("belongs to its idea's owner"), "re-owning refused (even as the superuser)");
  // the second user, through every slot-580 function and the idea functions
  assertEquals((await q(app, `SELECT * FROM public.idea_handback_review($1, $2::uuid)`, [BEE, ids.A])).length, 0);
  const hbA = (await q<{ id: string }>(su, `SELECT id::text FROM public.research_handbacks WHERE inlet_id = $1`, [ids.A]))[0].id;
  assertEquals((await q(app, `SELECT * FROM public.idea_handback_item($1::uuid, $2)`, [hbA, BEE])).length, 0);
  assertEquals((await q<{ j: string | null }>(app, `SELECT public.idea_handback_run_private($1, $1, $2::uuid, 'Which roofs suit me?')::text AS j`, [BEE, hbA]))[0].j, null);
  assertFalse((await q<{ ok: boolean }>(app, `SELECT public.idea_handback_decide($1, $2::uuid, gen_random_uuid(), NULL) AS ok`, [BEE, hbA]))[0].ok);
  assertEquals((await q<{ o: { outcome: string } }>(app, `SELECT public.idea_research($1::uuid, $2, 'x') AS o`, [ids.A, BEE]))[0].o.outcome, "not_found");
  // grants: the new functions are ob_app_memory's alone (not PostgREST's service_role / anon, not PUBLIC)
  const acl = await q<{ f: string; who: string }>(su, `SELECT p.proname AS f, coalesce(r.rolname, 'PUBLIC') AS who FROM pg_proc p, aclexplode(p.proacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE p.proname LIKE 'idea_handback_%' AND a.privilege_type = 'EXECUTE' AND NOT coalesce(r.rolsuper, false) AND a.grantee <> p.proowner`);
  assert(acl.length >= 6 && acl.every((x) => x.who === "ob_app_memory"), JSON.stringify(acl));
  console.log(`R-F4: 4 forged idea hand-backs refused, re-owning refused; the second user: review / item / private run / decide / research all nothing; grants ${acl.length} x ob_app_memory`);
}});

// ── D. the service ───────────────────────────────────────────────────────────────────────────────────────────
const VEC = (() => { const v = new Array(1024).fill(0); v[0] = 1; return v; })();
function stubs() {
  const log = { proposer: 0, search: [] as string[], curator: [] as string[] };
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, hostname: "0.0.0.0", signal: ac.signal, onListen: () => {} }, async (req) => {
    const u = new URL(req.url);
    if (u.pathname.endsWith("/observe/queue/estimate")) return Response.json({ max_concurrency: 2, capacity_declared: true });
    if (u.pathname === "/search") {
      log.search.push(u.searchParams.get("q") ?? "");
      return Response.json({ results: [{ url: page("/solar-roofs"), title: "Community solar roofs cut winter bills", content: "solar roofs survey" }] });
    }
    const raw = await req.text();
    if (u.pathname.endsWith("/ingest/research-package")) {
      log.curator.push(raw);
      return Response.json({ thread_id: null, persist: { sources_written: 1, source_ids: [] }, claims: { claimsWritten: 0, filed: [] } });
    }
    if (u.pathname.startsWith("/research/filed")) return Response.json({ filed: null });
    // deno-lint-ignore no-explicit-any
    const body: any = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
    if (u.pathname.endsWith("/embeddings")) return Response.json({ data: [{ embedding: VEC }] });
    const sys = String(body?.messages?.[0]?.content ?? "");
    const user = String(body?.messages?.[1]?.content ?? "");
    if (body?.max_tokens === 1) return Response.json({ choices: [{ message: { content: "ok" } }] });
    let content = "{}";
    if (sys.includes("You write research questions for a public research library")) {
      // THE HOSTILE PROPOSER: every personal field verbatim, then all of them joined
      log.proposer++;
      const note = user.slice(user.indexOf("PRIVATE NOTE:") + 13, user.indexOf("PUBLIC PAGES:")).trim().split("\n").map((l) => l.replace(/^[^:]+:\s*/, ""));
      content = JSON.stringify({ questions: [...note, note.join(" "), `What is known about ${note.join(" and ")}?`] });
    } else if (sys.includes("INJECTION or CLEAN") || sys.includes("You screen fetched web content")) content = "CLEAN";
    else if (sys.includes("RELEVANT or IRRELEVANT") || sys.includes("You screen a fetched web page")) content = "RELEVANT";
    else if (sys.includes("ENTAILMENT JUDGE")) content = JSON.stringify({ verdict: "supports" });
    else if (sys.includes("research planner")) content = JSON.stringify({ needs: ["How much do community solar roofs cut winter bills?"] });
    else if (sys.includes("web-search queries")) content = JSON.stringify({ entity: "community solar roofs", queries: ["community solar roofs winter bills"] });
    else if (sys.includes("grounded synthesizer")) content = "[SOURCED] Community solar roofs cut winter bills by 18 percent in 2024. [Source 1]";
    else if (sys.includes("CURRENT TOPIC")) content = JSON.stringify({ topic: "community solar roofs" });
    else if (!body?.response_format) content = "A short report.";
    return Response.json({ choices: [{ message: { content } }] });
  });
  return { base: `http://127.0.0.1:${server.addr.port}`, log, async close() { ac.abort(); await server.finished; } };
}
function freePort(): number { const l = Deno.listen({ port: 0, hostname: "127.0.0.1" }); const p = (l.addr as Deno.NetAddr).port; l.close(); return p; }
async function startService(stubBase: string) {
  const port = freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--unstable-net", "--allow-net", "--allow-env", "index.ts"], cwd: SERVICE_DIR,
    env: {
      PORT: String(port), DB_HOST, DB_PORT: "5432", DB_NAME: "openbrain", DB_USER: "ob_app_memory", DB_PASSWORD: APP_PASSWORD,
      MCP_ACCESS_KEY: SHARED, RESEARCH_CALLERS: `owui-tool=owui:${OWUI};workspace=workspace:${WORKSPACE}`, RESEARCH_SERVICE_CALLERS: "",
      CHAT_API_BASE: `${stubBase}/v1`, EMBEDDING_API_BASE: `${stubBase}/v1`, CURATOR_URL: stubBase, SEARCH_API_BASE: stubBase,
      CHAT_API_KEY: "lab-stub-key", RESEARCH_BRANCH_LLM_KEY: "lab-stub-branch-key", RESEARCH_LANE_REFRESH_MS: "1000",
      FETCH_PROXY_URL: "", OWUI_BASE_URL: "", CALLBACK_MIN_AGE_MS: "0", CURATOR_FILE_ATTEMPTS: "1", BOUNDARY_IDEA_DRAIN_MS: "500",
      CHAT_DOWN_BUDGET_MS: "4000", RESEARCH_MODEL_PROBE_MS: "1000", RESEARCH_MODEL_PROBE_TIMEOUT_MS: "3000", NO_COLOR: "1", WORKSPACE_DEFAULT_SUB: "",
    },
    stdout: "piped", stderr: "piped",
  }).spawn();
  let log = "";
  const pump = async (s: ReadableStream<Uint8Array>) => { for await (const ch of s.pipeThrough(new TextDecoderStream())) log += ch; };
  const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`${base}/health`); await r.body?.cancel(); if (r.ok) break; } catch { /* booting */ }
    await sleep(200);
  }
  return { base, get log() { return log; }, async stop() { try { child.kill(); } catch { /* gone */ } await child.status; await pumps.catch(() => {}); } };
}
const post = (base: string, path: string, body: unknown, key: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "x-brain-key": key, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
async function until(what: string, f: () => Promise<boolean>, ms = 60000): Promise<void> {
  for (let t = 0; t < ms; t += 500) { if (await f()) return; await sleep(500); }
  throw new Error(`timed out: ${what}`);
}
const stateOf = async (idea: string) => (await q<{ state: string }>(su, `SELECT state FROM public.research_handbacks WHERE inlet_id = $1 ORDER BY updated_at DESC LIMIT 1`, [idea]))[0]?.state;

Deno.test({ name: "D. the drain, the owner's review, run privately, the delivery - and THE SWEEP (hostile proposer, markers in every field)", ...greenOnly, fn: async () => {
  const st = stubs();
  const svc = await startService(st.base);
  const out: string[] = [];
  try {
    // the door refuses an idea (it is the database's to queue, with its own owner)
    const door = await post(svc.base, "/research/derived", { purpose: "idea-research", item: { kind: "idea", id: ids.A, owner_sub: OWNER.sub, fields: { title: MK.TIT } } }, SHARED);
    assertEquals(door.status, 400);
    assertFalse((await door.text()).includes(MK.TIT));
    // ── the drain
    await until("every pending idea hand-back settled", async () =>
      (await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM public.research_handbacks WHERE purpose = 'idea-research' AND state = 'pending'`))[0].n === 0);
    const states = Object.fromEntries(await Promise.all(["A", "L", "P", "S", "C"].map(async (k) => [k, await stateOf(ids[k])])));
    out.push(`drain: ${JSON.stringify(states)}; proposer calls ${st.log.proposer}`);
    assertEquals([states.A, states.L, states.P, states.S], ["awaiting_owner", "queued", "awaiting_owner", "awaiting_owner"], JSON.stringify(states));
    assert(st.log.proposer >= 3, "the hostile proposer was asked");
    // L: one derived job, stamped on the idea, nothing of the idea on it
    const L = (await q<{ last: string; rev: string; kind: string; query: string; refinery_id: unknown; inlet_ref: unknown; prompts: number }>(su,
      `SELECT i.last_job_id AS last, r.research_job_id AS rev, j.request_kind AS kind, j.query, j.refinery_id, j.inlet_ref,
              (SELECT count(*)::int FROM public.research_prompts p WHERE p.job_id = j.id) AS prompts
         FROM public.ideas i JOIN public.idea_revisions r ON r.idea_id = i.id AND r.revision = i.current_revision
         JOIN public.research_jobs j ON j.id::text = i.last_job_id WHERE i.id = $1::uuid`, [ids.L]))[0];
    assertEquals([L.kind, L.last === L.rev, L.refinery_id, L.inlet_ref, L.prompts], ["derived", true, null, null, 0]);
    assertFalse(/quill|feather/i.test(L.query), "the owner's name never");
    out.push(`L: derived "${L.query.slice(0, 80)}", stamped on ideas.last_job_id and the revision`);
    // ── the owner's review (A): its review data, then the approval over HTTP as the workspace's key on the owner's behalf
    const rv = (await q<{ handback_id: string; candidate: string; failing: string[]; state: string }>(app, `SELECT handback_id::text, candidate, failing, state FROM public.idea_handback_review($1, $2::uuid)`, [OWNER.sub, ids.A]))[0];
    assert(rv.state === "awaiting_owner" && Array.isArray(rv.failing), "the owner sees the candidate and the failing tokens");
    const approve = (question: string, sub = OWNER.sub, key = WORKSPACE) => post(svc.base, "/research/derived/approve", { handback_id: rv.handback_id, question }, key, { "x-on-behalf-of": sub });
    assertEquals((await approve("Which roofs suit a cabin?", OWNER.sub, SHARED)).status, 403, "only the workspace's key");
    assertEquals((await approve("Which roofs suit a cabin?", BEE)).status, 404, "another user: like no review at all");
    const withName = await (await approve(`What roof would ${OWNER.name} like for a cabin?`)).json();
    assertEquals(withName.refused, "identity_token", "the identity deny list still holds on an owner's approval");
    // round 2 (tester T1): the owner's name MERGED into one token (camel, zero-width-joined) is refused over HTTP too
    for (const merged of ["DanaQuillfeather", "Dana\u200BQuillfeather", "DQuillfeather"]) {
      const r = await approve(`What heating suits ${merged} barns?`);
      assertEquals([r.status, (await r.json()).refused], [200, "identity_token"], `the merged name refused: ${JSON.stringify(merged)}`);
    }
    const withMarker = await (await approve(`What is ${MK.TIT} about?`)).json();
    assert(withMarker.refused, "an id-shaped token too");
    const ok = await approve("Which cheap roof designs suit a small cold cabin?");
    assertEquals(ok.status, 202);
    const okJob = (await ok.json()).job_id as string;
    assertEquals(await stateOf(ids.A), "queued");
    assertEquals((await q<{ k: string }>(su, `SELECT request_kind AS k FROM public.research_jobs WHERE id = $1::uuid`, [okJob]))[0].k, "derived");
    out.push("A: awaiting_owner -> the owner's name refused, a marker refused, a clean edit -> derived (shared key 403, the second user 404)");
    // ── run privately (P): a 'personal' job tied to the idea; its report is the owner's; its prompt the owner's
    const hbP = (await q<{ handback_id: string }>(app, `SELECT handback_id::text FROM public.idea_handback_review($1, $2::uuid)`, [OWNER.sub, ids.P]))[0].handback_id;
    const pj = (await q<{ j: string }>(app, `SELECT public.idea_handback_run_private($1, $1, $2::uuid, $3)::text AS j`, [OWNER.sub, hbP, `my own words ${PRV} about my garden`]))[0].j;
    const P = (await q<{ kind: string; owner: string; rep: string }>(su, `SELECT j.request_kind AS kind, p.owner_sub AS owner,
        (SELECT ro.owner_sub FROM public.research_job_report_owner(j.id) ro) AS rep
       FROM public.research_jobs j JOIN public.research_prompts p ON p.job_id = j.id WHERE j.id = $1::uuid`, [pj]))[0];
    assertEquals([P.kind, P.owner, P.rep], ["personal", OWNER.sub, OWNER.sub], "personal: its prompt and its report are the owner's");
    out.push("P: run privately -> request_kind personal, prompt + report owner = the owner");
    // ── everything runs
    await until("all jobs ran", async () => (await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM public.research_jobs WHERE status IN ('queued','running')`))[0].n === 0, 180000);
    // ── the refinery's delivery (its SQL, as deliver.ts runs it): the deliverables, the room, the close
    const dl = await q<{ id: string; idea_id: string; job_id: string; job_status: string }>(app, `SELECT id::text, idea_id::text, job_id::text, job_status FROM public.idea_handback_deliverables(50)`);
    for (const d of dl) {
      const idea = (await q<{ title: string; summary: string }>(su, `SELECT title, summary FROM public.ideas WHERE id = $1::uuid`, [d.idea_id]))[0];
      await q(app, `SELECT public.idea_deliver_dossier($1::uuid, $2, $3, '{}'::jsonb)`, [d.idea_id, d.job_id, `${idea.title}\n\n${idea.summary}\n\nthe report`]);
      await q(app, `SELECT public.handback_delivered($1::uuid, $2)`, [d.id, d.job_status === "done"]);
    }
    assert(dl.some((d) => d.idea_id === ids.L) && dl.some((d) => d.idea_id === ids.A) && dl.some((d) => d.job_id === pj), `deliverables: ${dl.length}`);
    assertEquals((await q(app, `SELECT * FROM public.idea_handback_deliverables(50)`)).length, 0, "each closed once");
    // ── acceptance 2: the derived report is SHARED (no report owner) and readable by the second user; nothing ties it to the idea
    const read = async (path: string) => {
      const r = await fetch(`${svc.base}${path}`, { headers: { "x-brain-key": OWUI, "x-on-behalf-of": BEE } });
      return { status: r.status, text: await r.text() };
    };
    for (const j of [L.last, okJob]) {
      assertEquals((await q(app, `SELECT * FROM public.research_job_report_owner($1::uuid)`, [j])).length, 0, "a derived job's report has no owner: it is shared");
      const r = await read(`/research/jobs/${j}`);
      assertEquals(r.status, 200);
      const stored = (await q<{ s: string | null }>(su, `SELECT result ->> 'synthesis' AS s FROM public.research_jobs WHERE id = $1::uuid`, [j]))[0].s ?? "";
      assert(stored.length > 0 && JSON.parse(r.text).result?.synthesis === stored, "the second user reads the shared report, whole");
    }
    const curated = st.log.curator.filter((x) => x.includes(L.last) || x.includes(okJob));
    out.push(`derived reports: shared (no report owner), the second user reads both; curator packages for them: ${curated.length}`);
    const personalRead = await read(`/research/jobs/${pj}`);
    assertFalse(personalRead.text.includes(PRV), "the second user never reads the private run's question");
    assertFalse(String(JSON.parse(personalRead.text).result?.synthesis ?? "").includes("Community"), "nor its report");
    // ── THE SWEEP
    const sc = await su!.connect();
    let res: Awaited<ReturnType<typeof sweepTables>>;
    let idRes: Awaited<ReturnType<typeof sweepTables>>;
    const IDS = Object.fromEntries(Object.entries(ids).map(([k, v]) => [`ID_${k}`, v]));
    try {
      res = await sweepTables(sc, IDEA_MK, PRIVATE_TABLES);
      // the idea ids: in the private tables and the owner-filtered notification stream only (the workbench reads it per owner)
      idRes = await sweepTables(sc, IDS, (t) => PRIVATE_TABLES(t) || t === "research_notifications" || t === "notification_acks");
    } finally { sc.release(); }
    out.push(describe(res));
    out.push(`idea ids: ${describe(idRes)}`);
    const pageLog = ((await (await fetch(`http://news.example.org:${PAGES_PORT}/_log`)).json()).log ?? []) as string[];
    const egress = { search: sweepText(st.log.search.join("\n"), IDEA_MK), pages: sweepText(pageLog.join("\n"), IDEA_MK), curator: sweepText(st.log.curator.join("\n"), IDEA_MK) };
    const reads: Record<string, number> = {};
    const allJobs = (await q<{ id: string }>(su, `SELECT id::text FROM public.research_jobs`)).map((x) => x.id);
    for (const j of allJobs) for (const s of ["", "/tree", "/events"]) {
      for (const [k, n] of Object.entries(sweepText((await read(`/research/jobs/${j}${s}`)).text, { ...IDEA_MK, ...IDS }))) reads[k] = (reads[k] ?? 0) + n;
    }
    for (const [k, n] of Object.entries(sweepText((await read(`/research/jobs?limit=50`)).text, { ...IDEA_MK, ...IDS, PRV }))) reads[k] = (reads[k] ?? 0) + n;
    out.push(`egress: search ${JSON.stringify(egress.search)} pages ${JSON.stringify(egress.pages)} curator ${JSON.stringify(egress.curator)}; second user's reads ${JSON.stringify(reads)}`);
    assertEquals(res.hits, [], "no idea marker in any shared table (branch anchors included)");
    // the one expected shared row naming an idea: the PRIVATE run the owner chose (D7) - the legacy idea-job shape (its
    // inlet_ref), whose report and prompt are the owner's; no derived job and no other shared row names any idea
    const unexpected = idRes.hits.filter((h) => !(h.marker === "ID_P" && h.table === "research_jobs" && h.column === "inlet_ref" && h.rows === 1));
    assertEquals(unexpected, [], "no idea id on any shared row (the private run excepted)");
    assertEquals([egress.search, egress.pages, egress.curator, reads], [{}, {}, {}, {}], "nothing of an idea leaves the box or reaches the second user");
    for (const t of ["ideas", "idea_revisions", "research_handbacks"]) assert(res.private.some((h) => h.table === t), `the markers ARE in ${t} (not vacuous)`);
    assert(res.columns > 100 && res.tables > 40, `the sweep read the whole schema (${res.columns} columns, ${res.tables} tables)`);
  } finally {
    for (const l of out) console.log(l);
    await svc.stop();
    await st.close();
  }
}});

Deno.test({ name: "teardown", ...opts, fn: async () => { await su?.end(); await app?.end(); } });
