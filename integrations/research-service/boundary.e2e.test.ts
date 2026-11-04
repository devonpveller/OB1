/**
 * boundary.e2e.test.ts - rw-boundary-core (plan 09 PD0a) against a LAB database carrying the full initdb chain
 * (slot 420 included), as the production app role (ob_app_memory: non-superuser, member of service_role).
 *
 *   A. the database guard (acceptance 2): a derived job carrying inlet_ref / refinery_id / seed_sources / callback /
 *      on_behalf_of / a research_prompts row is refused; so is any change of request_kind into or out of 'derived';
 *      branches take their parent's kind (a steer on a derived job is 'direct').
 *   B. the report-owner rule: a derived job idea_revisions points at has no report owner; an unclassified idea job
 *      keeps its private report (slot 390 unchanged).
 *   C. the hand-back: forced RLS, no grant to any app role; the purpose-scoped functions; the owner's rows only.
 *   D. THE DOOR, over HTTP: the REAL research service (index.ts, spawned as the container runs it) with a stub gateway
 *      on the LiteLLM alias whose proposer is HOSTILE (it returns every personal field verbatim), a stub search gate,
 *      stub public pages (on the lab's own names: news.example.org / blog.example.org -> 127.0.0.1) and a stub curator.
 *      Every personal field of every inlet kind carries its own marker. The derived jobs then RUN (the dispatcher,
 *      the harness, the curator hand-off) so the sweep sees what research does with them.
 *   E. the readers (acceptance 3): as a seeded second user, a derived job's question is visible; a service:shared-key
 *      prompt on an unclassified job is not; the request kinds POST /research records.
 *   F. THE SWEEP: zero markers in every text / json column of every shared table (generated from information_schema),
 *      in the search egress, the page fetches, the curator packages and the second user's reads - and the markers ARE
 *      in the private hand-back (the zero is not vacuous). Counts only.
 *
 * IGNORED unless BND_E2E_DB_HOST is set (run-boundary-e2e.ps1 sets it inside a disposable internal network). Never
 * point it at a live database.
 */
import { assert, assertEquals, assertFalse, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Pool } from "postgres";
import { MK, OWNER } from "./fixtures/boundary-markers.ts";
import { describe, sweepTables, sweepText } from "./fixtures/boundary-sweep.ts";

const DB_HOST = Deno.env.get("BND_E2E_DB_HOST") ?? "";
const DB_PASSWORD = Deno.env.get("BND_E2E_DB_PASSWORD") ?? "";
const APP_PASSWORD = Deno.env.get("BND_E2E_APP_PASSWORD") ?? "";
const SERVICE_DIR: string | URL = Deno.env.get("BND_E2E_SERVICE_DIR") ?? new URL(".", import.meta.url);
const ignore = !DB_HOST;
const opts = { ignore, sanitizeOps: false, sanitizeResources: false };
const SHARED = "e2e-shared-key-000000";
const OWUI = "e2e-owui-key-0000000000", AGENT = "e2e-agent-key-000000000", WORKSPACE = "e2e-workspace-key-00000";
const BEE = "user-bee-second";
const PERSONAL: Record<string, string> = Object.fromEntries(Object.entries(MK).filter(([k]) => k !== "PUB"));

function pool(user: "postgres" | "ob_app_memory") {
  return new Pool({ hostname: DB_HOST, port: 5432, database: "openbrain", user, password: user === "postgres" ? DB_PASSWORD : APP_PASSWORD }, 2, true);
}
const su = ignore ? null : pool("postgres");
const app = ignore ? null : pool("ob_app_memory");
async function q<T = Record<string, unknown>>(p: Pool | null, text: string, args: unknown[] = []): Promise<T[]> {
  const c = await p!.connect();
  try { return (await c.queryObject<T>(text, args)).rows; } finally { c.release(); }
}
/** one statement that must FAIL; returns the error text (for its fixed message only - never content) */
async function refused(p: Pool | null, text: string, args: unknown[] = []): Promise<string> {
  try { await q(p, text, args); } catch (e) { return String((e as Error).message); }
  throw new Error(`not refused: ${text.slice(0, 120)}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STAMP = JSON.stringify({ version: "pd0a-1", lexicon: "x", verdict_id: "y" });

function derivedInsert(extra: Record<string, string> = {}): string {
  const cols: Record<string, string> = { status: "'done'", origin: "'manual'", caller: "'boundary'", query: "'What is known about solar roofs?'",
    anchor: "'What is known about solar roofs?'", request_kind: "'derived'", boundary: `'${STAMP}'::jsonb`, options: `'{"public_links":[]}'::jsonb`, ...extra };
  return `INSERT INTO public.research_jobs (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")}) RETURNING id::text AS id`;
}
async function derivedRow(extra: Record<string, string> = {}): Promise<string> {
  return (await q<{ id: string }>(su, derivedInsert(extra)))[0].id;
}

// ── A. the guard ────────────────────────────────────────────────────────────────────────────
Deno.test({ name: "A. the guard refuses a derived job that carries anything personal, and any kind change into or out of derived", ...opts, fn: async () => {
  const ok = await derivedRow();
  assert(ok, "a well-formed derived job is accepted");
  const idea = (await q<{ id: string }>(su, `INSERT INTO public.ideas (title, owner_sub) VALUES ('guard idea', $1) RETURNING id::text AS id`, [OWNER.sub]))[0].id;
  const cases: Array<[string, Record<string, string>]> = [
    ["inlet_ref", { inlet_ref: `'{"kind":"chat_id","id":"x"}'::jsonb` }],
    ["refinery_id", { refinery_id: `'${idea}'::uuid` }],
    ["seed_sources", { options: `'{"seed_sources":[{"url":"https://example.org","content":"BODY"}]}'::jsonb` }],
    ["callback", { options: `'{"callback":{"chat_id":"c","message_id":"m"}}'::jsonb` }],
    ["on_behalf_of", { options: `'{"on_behalf_of":"user-1"}'::jsonb` }],
    ["no stamp", { boundary: "NULL" }],
    ["anchor <> query", { anchor: "'something else'" }],
    ["caller not boundary", { caller: "'shared-key'" }],
  ];
  for (const [name, extra] of cases) {
    const msg = await refused(su, derivedInsert({ status: "'queued'", ...extra }));
    assert(msg.includes("request boundary"), `${name}: ${msg}`);
    console.log(`guard: insert with ${name} refused`);
  }
  // as the app role too (the guard is the database's, not a superuser habit)
  assert((await refused(app, `INSERT INTO public.research_jobs (status, origin, caller, query, anchor, request_kind, boundary, options)
     VALUES ('queued', 'manual', 'boundary', 'q q q', 'q q q', 'derived', $1::jsonb, '{"seed_sources":[]}'::jsonb)`, [STAMP])).includes("request boundary"));
  // updates: personal fields onto a derived row; kind into / out of derived
  for (const [name, set] of [["inlet_ref", `inlet_ref = '{"kind":"x","id":"y"}'::jsonb`], ["refinery_id", `refinery_id = '${idea}'::uuid`],
    ["seed_sources", `options = options || '{"seed_sources":[]}'::jsonb`], ["callback", `options = options || '{"callback":{}}'::jsonb`],
    ["on_behalf_of", `options = options || '{"on_behalf_of":"u"}'::jsonb`], ["out of derived", "request_kind = 'direct'"]]) {
    assert((await refused(su, `UPDATE public.research_jobs SET ${set} WHERE id = $1::uuid`, [ok])).includes("request boundary"), `update ${name}`);
    console.log(`guard: update ${name} on a derived job refused`);
  }
  const plain = (await q<{ id: string }>(su, `INSERT INTO public.research_jobs (status, origin, query) VALUES ('done', 'manual', 'a typed question') RETURNING id::text AS id`))[0].id;
  assertEquals((await q<{ k: string }>(su, `SELECT request_kind AS k FROM public.research_jobs WHERE id = $1::uuid`, [plain]))[0].k, "unclassified");
  for (const p of [su, app]) {
    assert((await refused(p, `UPDATE public.research_jobs SET request_kind = 'derived', boundary = $2::jsonb, caller = 'boundary', anchor = query WHERE id = $1::uuid`, [plain, STAMP])).includes("request boundary"));
  }
  console.log("guard: update of a non-derived job into derived refused (superuser and app role)");
  // a research_prompts row for a derived job, both ways round
  assert((await refused(app, `INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1::uuid, 'u', 'u', 'p')`, [ok])).includes("request boundary"));
  await q(su, `INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1::uuid, 'u', 'u', 'p')`, [plain]);
  assert((await refused(su, `UPDATE public.research_jobs SET request_kind = 'derived' WHERE id = $1::uuid`, [plain])).includes("request boundary"));
  console.log("guard: a research_prompts row for a derived job refused");
  // the other kinds move freely (PD0e may reclassify), never through derived
  await q(su, `UPDATE public.research_jobs SET request_kind = 'direct' WHERE id = $1::uuid`, [plain]);
  assert((await refused(su, `UPDATE public.research_jobs SET request_kind = 'bogus' WHERE id = $1::uuid`, [plain])).includes("request_kind_check"));
}});

Deno.test({ name: "A2. branches take their parent's kind; a steer on a derived job is its actor's (direct)", ...opts, fn: async () => {
  const root = await derivedRow({ status: "'running'" });
  const branch = async (parent: string, kind: string, wanted = "'unclassified'") => (await q<{ k: string }>(su,
    `INSERT INTO public.research_jobs (status, origin, query, parent_job_id, root_job_id, rooted_step_id, branch_kind, anchor, request_kind)
     SELECT 'queued', 'manual', 'Verify: a claim', $1::uuid, coalesce(p.root_job_id, p.id), 's1', $2, p.query, ${wanted} FROM public.research_jobs p WHERE p.id = $1::uuid
     RETURNING request_kind AS k`, [parent, kind]))[0].k;
  assertEquals(await branch(root, "gap"), "derived");
  assertEquals(await branch(root, "interhub", "'direct'"), "derived", "a caller's own value is overruled by the parent's");
  assertEquals(await branch(root, "steer"), "direct");
  const plain = (await q<{ id: string }>(su, `INSERT INTO public.research_jobs (status, origin, query, request_kind) VALUES ('running', 'manual', 'typed', 'direct') RETURNING id::text AS id`))[0].id;
  assertEquals(await branch(plain, "gap", "'derived'"), "direct", "a branch of a non-derived job never becomes derived");
  // a derived gap branch carrying seed content is refused like a root
  assert((await refused(su, `INSERT INTO public.research_jobs (status, origin, query, parent_job_id, root_job_id, rooted_step_id, branch_kind, anchor, options)
     VALUES ('queued', 'manual', 'Verify: x', $1::uuid, $1::uuid, 's1', 'gap', 'a', '{"seed_sources":[]}'::jsonb)`, [root])).includes("request boundary"));
}});

// ── B. the report owner ─────────────────────────────────────────────────────────────────────
Deno.test({ name: "B. a derived job idea_revisions points at has no report owner; an unclassified idea job keeps its private report", ...opts, fn: async () => {
  const idea = (await q<{ id: string }>(su, `INSERT INTO public.ideas (title, owner_sub) VALUES ('owner rule idea', $1) RETURNING id::text AS id`, [OWNER.sub]))[0].id;
  const derived = await derivedRow();
  await q(su, `INSERT INTO public.idea_revisions (idea_id, revision, summary, research_job_id) VALUES ($1::uuid, 900, 'rev', $2)`, [idea, derived]);
  const owner = (job: string) => q<{ idea_id: string; owner_sub: string }>(app, `SELECT idea_id::text, owner_sub FROM public.research_job_report_owner($1::uuid)`, [job]);
  assertEquals((await owner(derived)).length, 0, "derived + revision stamp: no report owner (its report is shared)");
  // the stamp copied nothing of the idea onto the shared row (slot 230's inlet trigger skips a derived job)
  assertEquals((await q<{ i: unknown; r: unknown }>(su, `SELECT inlet_ref AS i, refinery_id AS r FROM public.research_jobs WHERE id = $1::uuid`, [derived]))[0], { i: null, r: null });
  // a derived job's gap branch: shared too
  const gap = (await q<{ id: string }>(su, `INSERT INTO public.research_jobs (status, origin, query, parent_job_id, root_job_id, rooted_step_id, branch_kind, anchor)
     VALUES ('done', 'manual', 'Verify: x', $1::uuid, $1::uuid, 's1', 'gap', 'a') RETURNING id::text AS id`, [derived]))[0].id;
  assertEquals((await owner(gap)).length, 0);
  // slot 390 unchanged for every other kind: the revision stamp, the refinery, the idea branch
  const stamped = (await q<{ id: string }>(su, `INSERT INTO public.research_jobs (status, origin, query) VALUES ('done', 'manual', 'idea text') RETURNING id::text AS id`))[0].id;
  await q(su, `INSERT INTO public.idea_revisions (idea_id, revision, summary, research_job_id) VALUES ($1::uuid, 901, 'rev', $2)`, [idea, stamped]);
  const refinery = (await q<{ id: string }>(su, `INSERT INTO public.research_jobs (status, origin, query, refinery_id) VALUES ('done', 'manual', 'idea text', $1::uuid) RETURNING id::text AS id`, [idea]))[0].id;
  for (const [name, job] of [["revision-stamped unclassified", stamped], ["refinery_id unclassified", refinery]]) {
    const r = await owner(job);
    assertEquals(r.length, 1, name);
    assertEquals(r[0].owner_sub, OWNER.sub, name);
    assertEquals(r[0].idea_id, idea, name);
  }
  console.log("report owner: derived -> none (2 shapes); unclassified idea jobs -> the idea's owner (2 shapes)");
}});

// ── C. the hand-back ────────────────────────────────────────────────────────────────────────
Deno.test({ name: "C. research_handbacks: forced RLS, no app grant, the purpose-scoped functions, the owner's rows only", ...opts, fn: async () => {
  const rel = (await q<{ rls: boolean; force: boolean; grants: number }>(su,
    `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
            (SELECT count(*)::int FROM aclexplode(coalesce(c.relacl, '{}')) a LEFT JOIN pg_roles r ON r.oid = a.grantee
              WHERE a.grantee = 0 OR NOT coalesce(r.rolsuper, false)) AS grants
       FROM pg_class c WHERE c.oid = 'public.research_handbacks'::regclass`))[0];
  assert(rel.rls && rel.force, "RLS enabled and forced");
  assertEquals(rel.grants, 0, "no grant to PUBLIC or any non-superuser role");
  for (const stmt of ["SELECT count(*) FROM public.research_handbacks", "INSERT INTO public.research_handbacks (owner_sub, inlet_kind, inlet_id, purpose, state) VALUES ('u','idea','i','idea-research','pending')",
    "UPDATE public.research_handbacks SET state = 'failed'", "DELETE FROM public.research_handbacks"]) {
    assert((await refused(app, stmt)).includes("permission denied"), `the app role: ${stmt}`);
    const c = await su!.connect();
    try {
      await c.queryObject("BEGIN");
      await c.queryObject("SET LOCAL ROLE service_role");
      await assertRejects(() => c.queryObject(stmt), Error, "permission denied");
    } finally { await c.queryObject("ROLLBACK").catch(() => {}); c.release(); }
  }
  console.log("hand-back: SELECT / INSERT / UPDATE / DELETE refused to ob_app_memory and service_role (PostgREST's role)");
  const job = await derivedRow({ status: "'done'" });
  const open = (owner: string, kind: string, id: string, purpose: string, job: string | null, state: string) => q<{ id: string }>(app,
    `SELECT public.handback_open($1, $2, $3, NULL, $4, $5::uuid, $6, '{"verdict_id":"v"}'::jsonb, NULL, '{"segment":1}'::jsonb)::text AS id`,
    [owner, kind, id, purpose, job, state]);
  const a = (await open(OWNER.sub, "gmail", "hb-c-1", "digest-article", job, "queued"))[0].id;
  const again = (await open(OWNER.sub, "gmail", "hb-c-1", "digest-article", job, "queued"))[0].id;
  assertEquals(again, a, "an open row of the same inlet and purpose is brought up to date, not duplicated");
  await open(BEE, "idea", "hb-c-2", "idea-research", null, "refused");
  assert((await refused(app, `SELECT public.handback_open('service:shared-key', 'gmail', 'x', NULL, 'digest-article', NULL, 'refused', NULL, NULL, NULL)`)).length > 0, "a service owner is refused");
  const plain = (await q<{ id: string }>(su, `INSERT INTO public.research_jobs (status, origin, query) VALUES ('done', 'manual', 'typed') RETURNING id::text AS id`))[0].id;
  assert((await refused(app, `SELECT public.handback_open($1, 'gmail', 'x2', NULL, 'digest-article', $2::uuid, 'queued', NULL, NULL, NULL)`, [OWNER.sub, plain])).includes("derived job only"));
  const deliv = await q<Record<string, unknown>>(app, `SELECT * FROM public.handback_deliverables('digest-article')`);
  assert(deliv.some((d) => d.id === a), "the finished derived job is deliverable");
  assertEquals(Object.keys(deliv[0]).sort(), ["deliver", "id", "job_id", "job_status"], "deliverables carry no owner, inlet or verdict");
  assertEquals((await q(app, `SELECT * FROM public.handback_deliverables('idea-research')`)).length, 0, "scoped by purpose");
  assertEquals((await q<{ ok: boolean }>(app, `SELECT public.handback_delivered($1::uuid) AS ok`, [a]))[0].ok, true);
  const mine = await q<{ inlet_id: string }>(app, `SELECT inlet_id FROM public.handback_owned($1)`, [OWNER.sub]);
  const bees = await q<{ inlet_id: string }>(app, `SELECT inlet_id FROM public.handback_owned($1)`, [BEE]);
  assert(mine.some((r) => r.inlet_id === "hb-c-1") && !mine.some((r) => r.inlet_id === "hb-c-2"), "the owner's rows only");
  assert(bees.every((r) => r.inlet_id !== "hb-c-1"), "another user never reads them");
  assertEquals((await q(app, `SELECT * FROM public.handback_owned('')`)).length, 0, "no subject, no rows");
  // the drain's pair (PD0b uses them)
  const p = (await open(OWNER.sub, "idea", "hb-c-3", "idea-research", null, "pending"))[0].id;
  const pend = await q<{ id: string }>(app, `SELECT id::text FROM public.handback_pending('idea-research')`);
  assert(pend.some((r) => r.id === p));
  const j2 = await derivedRow({ status: "'queued'" });
  assertEquals((await q<{ ok: boolean }>(app, `SELECT public.handback_claim($1::uuid, $2::uuid, 'queued', NULL, NULL) AS ok`, [p, j2]))[0].ok, true);
  console.log("hand-back: open / coalesce / pending / claim / deliverables / delivered / owned - each scoped");
}});

// ── D/E/F. the door, the readers, the sweep ─────────────────────────────────────────────────
const VEC = (() => { const v = new Array(1024).fill(0); v[0] = 1; return v; })();
function stubs() {
  const log = { proposer: [] as string[], chat: 0, search: [] as string[], pages: [] as string[], curator: [] as string[] };
  const ac = new AbortController();
  let port = 0;
  const page = (title: string, body: string) => new Response(`<html><head><title>${title}</title></head><body><article><p>${body}</p></article></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
  const server = Deno.serve({ port: 0, hostname: "0.0.0.0", signal: ac.signal, onListen: () => {} }, async (req) => {
    const u = new URL(req.url);
    const host = (req.headers.get("host") ?? "").split(":")[0];
    if (u.pathname.endsWith("/observe/queue/estimate")) return Response.json({ max_concurrency: 2, capacity_declared: true });
    if (u.pathname === "/search") {
      log.search.push(u.searchParams.get("q") ?? "");
      return Response.json({ results: [{ url: `http://news.example.org:${port}/solar-roofs`, title: "Community solar roofs cut winter bills", content: "solar roofs survey" }] });
    }
    if (host === "news.example.org" || host === "blog.example.org") {
      log.pages.push(`${host}${u.pathname}${u.search}`);
      if (u.pathname === "/solar-roofs" && !u.search) {
        return page("Community solar roofs cut winter bills", `Community solar roofs cut winter bills by 18 percent in 2024, a survey found. The ${MK.PUB} method is described. `.repeat(8));
      }
      if (u.pathname === "/hello") return page("Hello Dana Quillfeather", "Hello Dana Quillfeather, here is your weekly letter about heat pumps. ".repeat(8));
      return new Response("not found", { status: 404 });
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
      // THE HOSTILE PROPOSER: every personal field verbatim, one candidate per field, then all of them joined
      log.proposer.push(raw);
      const note = user.slice(user.indexOf("PRIVATE NOTE:") + 13, user.indexOf("PUBLIC PAGES:")).trim().split("\n").map((l) => l.replace(/^[^:]+:\s*/, ""));
      content = JSON.stringify({ questions: [...note, note.join(" "), `What is known about ${note.join(" and ")}?`] });
    } else {
      log.chat++;
      if (sys.includes("INJECTION or CLEAN") || sys.includes("You screen fetched web content")) content = "CLEAN";
      else if (sys.includes("RELEVANT or IRRELEVANT") || sys.includes("You screen a fetched web page")) content = "RELEVANT";
      else if (sys.includes("ENTAILMENT JUDGE")) content = JSON.stringify({ verdict: "supports" });
      else if (sys.includes("research planner")) content = JSON.stringify({ needs: ["How much do community solar roofs cut winter bills?"] });
      else if (sys.includes("web-search queries")) content = JSON.stringify({ entity: "community solar roofs", queries: ["community solar roofs winter bills"] });
      else if (sys.includes("grounded synthesizer")) content = "[SOURCED] Community solar roofs cut winter bills by 18 percent in 2024. [Source 1]";
      else if (sys.includes("CURRENT TOPIC")) content = JSON.stringify({ topic: "community solar roofs" });
      else if (!body?.response_format) content = "A short report.";
    }
    return Response.json({ choices: [{ message: { content } }] });
  });
  port = server.addr.port;
  return { port, base: `http://127.0.0.1:${port}`, log, async close() { ac.abort(); await server.finished; } };
}
function freePort(): number { const l = Deno.listen({ port: 0, hostname: "127.0.0.1" }); const p = (l.addr as Deno.NetAddr).port; l.close(); return p; }

async function startService(stubBase: string) {
  const port = freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--unstable-net", "--allow-net", "--allow-env", "index.ts"], cwd: SERVICE_DIR,
    env: {
      PORT: String(port), DB_HOST, DB_PORT: "5432", DB_NAME: "openbrain", DB_USER: "ob_app_memory", DB_PASSWORD: APP_PASSWORD,
      MCP_ACCESS_KEY: SHARED, RESEARCH_CALLERS: `owui-tool=owui:${OWUI};agent-org=mattermost:${AGENT};workspace=workspace:${WORKSPACE}`,
      RESEARCH_SERVICE_CALLERS: "agent-org",
      CHAT_API_BASE: `${stubBase}/v1`, EMBEDDING_API_BASE: `${stubBase}/v1`, CURATOR_URL: stubBase, SEARCH_API_BASE: stubBase,
      CHAT_API_KEY: "lab-stub-key", RESEARCH_BRANCH_LLM_KEY: "lab-stub-branch-key", RESEARCH_LANE_REFRESH_MS: "1000",
      FETCH_PROXY_URL: "", OWUI_BASE_URL: "", CALLBACK_MIN_AGE_MS: "0", CURATOR_FILE_ATTEMPTS: "1",
      CHAT_DOWN_BUDGET_MS: "4000", RESEARCH_MODEL_PROBE_MS: "1000", RESEARCH_MODEL_PROBE_TIMEOUT_MS: "3000", NO_COLOR: "1",
      WORKSPACE_DEFAULT_SUB: "",
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

const post = (base: string, path: string, body: unknown, key = SHARED, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "x-brain-key": key, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

Deno.test({ name: "D/E/F. the door, the second user's reads and the sweep (hostile proposer, every inlet kind, markers in every field)", ...opts, fn: async () => {
  // the owner's identity, as the workbench's identity seam records it
  await q(su, `INSERT INTO public.workspace_users (sub, name, email) VALUES ($1, $2, $3) ON CONFLICT (sub) DO NOTHING`, [OWNER.sub, OWNER.name, OWNER.email]);
  const st = stubs();
  const svc = await startService(st.base);
  const out: string[] = [];
  try {
    const page = (p: string) => `http://news.example.org:${st.port}${p}`;
    const blog = `http://blog.example.org:${st.port}/hello`;
    // ── D1: the door's refusals of its body
    assertEquals((await post(svc.base, "/research/derived", {}, "wrong-key")).status, 401);
    const base = { item: { kind: "gmail", id: "door-1", owner_sub: OWNER.sub, fields: { subject: "s" }, links: [page("/solar-roofs")] }, purpose: "digest-article" };
    for (const k of ["seed_sources", "callback", "inlet_ref", "on_behalf_of", "query", "options"]) {
      const r = await post(svc.base, "/research/derived", { ...base, [k]: [{ url: page("/solar-roofs"), content: MK.BODY }] });
      assertEquals(r.status, 400, k);
      const t = await r.text();
      assertFalse(t.includes(MK.BODY), `${k}: the refusal echoes no content`);
    }
    out.push("door: 401 without a key; 400 for seed_sources / callback / inlet_ref / on_behalf_of / query / options (no content echoed)");

    // ── D2: every inlet kind, markers in every personal field, the HOSTILE proposer
    const items = [
      { purpose: "idea-research", deliver: { idea_id: "8b0c4f5e-1d2a-4b3c-9e8f-7a6b5c4d3e2f" }, item: { kind: "idea", id: "8b0c4f5e-1d2a-4b3c-9e8f-7a6b5c4d3e2f", revision: 3, owner_sub: OWNER.sub, links: [],
          fields: { title: `${MK.TIT} winter plan`, summary: `${MK.SUM} the cheap solar roof plan for my winter cabin`, revision: `${MK.REV} new notes`, domain: MK.DOMAIN } } },
      { purpose: "idea-research", deliver: {}, item: { kind: "idea", id: "9c1d5a6f-2e3b-4c4d-8f9a-8b7c6d5e4f3a", owner_sub: OWNER.sub, links: [page("/solar-roofs")],
          fields: { title: `${MK.TIT} solar`, summary: `${MK.SUM} community solar roofs for my street` } } },
      { purpose: "digest-article", deliver: { digest_run: "r1", segment: 2, gmail_id: MK.GID, gmail_thread_id: MK.THR, labels: [MK.LABEL] },
        item: { kind: "gmail", id: MK.GID, owner_sub: OWNER.sub,
          links: [`${page("/solar-roofs")}?u=${MK.QRY}`, `https://mail.google.com/mail/u/0/#inbox/${MK.THR}`, blog, `https://tracker.example.com/${MK.GID}/unsubscribe`],
          fields: { subject: `${MK.SUBJ} your weekly roundup`, from: `${MK.FROM} <${MK.FROM.toLowerCase()}@letters.example.com>`, body: `${MK.BODY} long newsletter text`, label: MK.LABEL, gmail_id: MK.GID, gmail_thread_id: MK.THR } } },
      { purpose: "digest-gap", deliver: { gmail_id: MK.GID }, item: { kind: "gmail", id: `${MK.GID}-gap`, owner_sub: OWNER.sub, links: [`${page("/solar-roofs")}?u=${MK.QRY}`],
          fields: { candidate: `${MK.BODY} what about solar in winter`, subject: MK.SUBJ, label: MK.LABEL } } },
      { purpose: "brainstorm-gap", deliver: { mm_channel: "ch1", mm_root: "root1" }, item: { kind: "brainstorm", id: "mm-post-1", owner_sub: OWNER.sub, links: [page("/solar-roofs")], identity: [MK.MMUSER],
          fields: { reply: `${MK.REPLY} maybe my cabin needs this`, dossier: `${MK.DOSSIER} thread text` } } },
      { purpose: "digest-article", deliver: {}, item: { kind: "gmail", id: "body-only", owner_sub: OWNER.sub, links: [`https://mail.google.com/mail/u/0/#inbox/${MK.THR}`],
          fields: { subject: MK.SUBJ, body: MK.BODY } } },
    ];
    const jobs: string[] = [];
    const answers: string[] = [];
    for (const it of items) {
      const r = await post(svc.base, "/research/derived", it);
      const b = await r.json();
      answers.push(JSON.stringify(b));
      if (b.job_id) { assertEquals(r.status, 202); jobs.push(b.job_id); } else { assertEquals(r.status, 200); assert(b.refused && b.handback_id, JSON.stringify(b)); }
      out.push(`door: ${it.item.kind}/${it.purpose} -> ${b.job_id ? "derived job" : `refused (${b.refused})`}`);
    }
    assert(st.log.proposer.length >= 3, `the hostile proposer was asked (${st.log.proposer.length})`);
    assertEquals(jobs.length, 4, `4 derived jobs (the two link-less refusals: the idea -> awaiting_owner, the body-only email -> refused): ${answers.join(" ")}`);
    const rows = await q<{ request_kind: string; caller: string; inlet_ref: unknown; refinery_id: unknown; options: Record<string, unknown>; query: string; anchor: string; boundary: Record<string, unknown>; prompts: number }>(su,
      `SELECT j.request_kind, j.caller, j.inlet_ref, j.refinery_id, j.options, j.query, j.anchor, j.boundary,
              (SELECT count(*)::int FROM public.research_prompts p WHERE p.job_id = j.id) AS prompts
         FROM public.research_jobs j WHERE j.id = ANY($1::uuid[])`, [jobs]);
    for (const r of rows) {
      assertEquals([r.request_kind, r.caller, r.inlet_ref, r.refinery_id, r.prompts, r.query === r.anchor], ["derived", "boundary", null, null, 0, true]);
      assertEquals(Object.keys(r.options).sort(), ["public_links", "queue_origin"]);
      for (const l of r.options.public_links as string[]) assertFalse(l.includes("?") || l.includes("mail.google"), l);
      assert(["version", "lexicon", "verdict_id", "topic"].every((k) => k in r.boundary));
    }
    out.push(`door: ${rows.length} derived rows - caller boundary, no inlet_ref / refinery_id / research_prompts, options only public_links + queue_origin, the stamp`);
    const hb = await q<{ state: string; n: number }>(su, `SELECT state, count(*)::int AS n FROM public.research_handbacks WHERE owner_sub = $1 AND inlet_id <> ALL($2) GROUP BY state ORDER BY state`, [OWNER.sub, ["hb-c-1", "hb-c-3"]]);
    out.push(`hand-backs: ${hb.map((x) => `${x.state}=${x.n}`).join(" ")}`);
    // never fetched: the query-string form, the mail.google.com thread, the tracker's unsubscribe path
    assertFalse(st.log.pages.some((p) => p.includes("?")), `a query string was fetched: ${st.log.pages.filter((p) => p.includes("?")).length}`);

    // ── the derived jobs RUN (dispatcher -> harness -> curator hand-off) before the sweep
    for (let i = 0; i < 300; i++) {
      const left = (await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM public.research_jobs WHERE id = ANY($1::uuid[]) AND status IN ('queued','running')`, [jobs]))[0].n;
      if (!left) break;
      await sleep(500);
    }
    const ran = await q<{ status: string; n: number }>(su, `SELECT status, count(*)::int AS n FROM public.research_jobs WHERE id = ANY($1::uuid[]) GROUP BY status`, [jobs]);
    out.push(`the derived jobs ran: ${ran.map((x) => `${x.status}=${x.n}`).join(" ")}; curator packages: ${st.log.curator.length}; searches: ${st.log.search.length}; page fetches: ${st.log.pages.length}`);
    assert(ran.every((x) => x.status === "done"), `${JSON.stringify(ran)}\n${svc.log.slice(-2500)}`);
    assert(st.log.curator.length >= 1, "a derived job's report was handed to the curator (filed shared, as before)");
    const pkg = JSON.parse(st.log.curator[0]);
    assert(String(pkg.synthesis ?? "").includes("Community solar roofs"), "a derived job's synthesis is handed over as written");

    // ── E: the readers, as a seeded second user (BEE, through Open WebUI's key on BEE's behalf)
    const read = async (job: string) => {
      const r = await fetch(`${svc.base}/research/jobs/${job}`, { headers: { "x-brain-key": OWUI, "x-on-behalf-of": BEE } });
      return { status: r.status, text: await r.text() };
    };
    // the job's question is in its tree read (the root branch's query); the detail read carries the shared result
    const tree = async (job: string) => {
      const r = await fetch(`${svc.base}/research/jobs/${job}/tree`, { headers: { "x-brain-key": OWUI, "x-on-behalf-of": BEE } });
      return { status: r.status, text: await r.text() };
    };
    const dq = (await q<{ query: string }>(su, `SELECT query FROM public.research_jobs WHERE id = $1::uuid`, [jobs[0]]))[0].query;
    const derivedRead = await read(jobs[0]);
    const derivedTree = await tree(jobs[0]);
    assert(derivedRead.status === 200 && derivedTree.status === 200, `${derivedRead.status} ${derivedTree.status}`);
    const dt = JSON.parse(derivedTree.text) as { origin?: string; branches?: Array<{ query?: string }> };
    assert(dt.origin === dq || (dt.branches ?? []).some((b) => b.query === dq), `the second user reads a derived job's question in its tree: ${derivedTree.text.slice(0, 300)}`);
    assert(JSON.parse(derivedRead.text).result?.synthesis !== undefined, "and its shared result");
    // a service:shared-key prompt on an unclassified job (the 88 live ones' shape): hidden from the second user
    const SKP = "zqSKPm3e5d7c9b";
    const PAST = { deadline_at: "2000-01-01T00:00:00Z", dry_run: true, disable_web_search: true }; // queued, never run: the deadline cancels it
    const sk = await (await post(svc.base, "/research", { query: `What does the shared key ask about ${SKP} today?`, ...PAST })).json();
    const skRow = (await q<{ request_kind: string; owner_sub: string }>(su, `SELECT j.request_kind, p.owner_sub FROM public.research_jobs j JOIN public.research_prompts p ON p.job_id = j.id WHERE j.id = $1::uuid`, [sk.job_id]))[0];
    assertEquals([skRow.request_kind, skRow.owner_sub], ["unclassified", "service:shared-key"]);
    const skRead = await read(sk.job_id);
    const skTree = await tree(sk.job_id);
    assertFalse(skRead.text.includes(SKP) || skTree.text.includes(SKP), `a service:shared-key prompt on an unclassified job is not shown to another user (${skRead.status} ${skTree.status})`);
    assert(skTree.status === 200 && !skTree.text.includes("query"), "the second user reads its tree as the shared shape only");
    // the same job as a service the operator declared (RESEARCH_SERVICE_CALLERS): its prompt stays shared
    const ag = await (await post(svc.base, "/research", { query: "What is known about solar roofs for the agent org?", ...PAST }, AGENT)).json();
    assertEquals((await q<{ k: string }>(su, `SELECT request_kind AS k FROM public.research_jobs WHERE id = $1::uuid`, [ag.job_id]))[0].k, "service");
    assert((await tree(ag.job_id)).text.includes("agent org"), "a 'service' job's prompt is shared");
    const ow = await (await post(svc.base, "/research", { query: "A typed question from Open WebUI", on_behalf_of: OWNER.sub, ...PAST }, OWUI)).json();
    assertEquals((await q<{ k: string }>(su, `SELECT request_kind AS k FROM public.research_jobs WHERE id = $1::uuid`, [ow.job_id]))[0].k, "direct");
    out.push(`readers: the second user reads a derived job's question ("${dq.slice(0, 60)}"); a service:shared-key prompt on an unclassified job is hidden; a declared service's is shared; kinds unclassified / service / direct recorded`);

    // ── F: THE SWEEP
    for (let i = 0; i < 120; i++) {
      const left = (await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM public.research_jobs WHERE status IN ('queued','running')`))[0].n;
      if (!left) break;
      await sleep(500);
    }
    const sc = await su!.connect();
    let res: Awaited<ReturnType<typeof sweepTables>>;
    try { res = await sweepTables(sc, PERSONAL); } finally { sc.release(); }
    out.push(describe(res));
    const egress = { search: sweepText(st.log.search.join("\n"), PERSONAL), pages: sweepText(st.log.pages.join("\n"), PERSONAL), curator: sweepText(st.log.curator.join("\n"), PERSONAL) };
    const reads: Record<string, number> = {};
    for (const j of [...jobs, sk.job_id]) for (const [k, n] of Object.entries(sweepText((await read(j)).text, PERSONAL))) reads[k] = (reads[k] ?? 0) + n;
    for (const j of jobs) {
      for (const suffix of ["/tree", "/events"]) {
        const r = await fetch(`${svc.base}/research/jobs/${j}${suffix}`, { headers: { "x-brain-key": OWUI, "x-on-behalf-of": BEE } });
        for (const [k, n] of Object.entries(sweepText(await r.text(), PERSONAL))) reads[k] = (reads[k] ?? 0) + n;
      }
    }
    const list = await fetch(`${svc.base}/research/jobs?limit=50`, { headers: { "x-brain-key": OWUI, "x-on-behalf-of": BEE } });
    for (const [k, n] of Object.entries(sweepText(await list.text(), PERSONAL))) reads[k] = (reads[k] ?? 0) + n;
    out.push(`egress: search ${JSON.stringify(egress.search)} page-fetches ${JSON.stringify(egress.pages)} curator ${JSON.stringify(egress.curator)}; second-user reads ${JSON.stringify(reads)}; local-model proposer calls ${st.log.proposer.length} (inference input, allowed)`);
    assertEquals(res.hits, [], "no marker in any shared table");
    assertEquals([egress.search, egress.pages, egress.curator, reads], [{}, {}, {}, {}], "no marker leaves the box or reaches the second user");
    assert(res.private.some((h) => h.table === "research_handbacks"), "the markers ARE in the private hand-back (the zero is not vacuous)");
    assert(res.columns > 100 && res.tables > 40, `the sweep read the whole schema (${res.columns} columns, ${res.tables} tables)`);
  } finally {
    for (const l of out) console.log(l);
    await svc.stop();
    await st.close();
  }
}});

Deno.test({ name: "teardown", ...opts, fn: async () => { await su?.end(); await app?.end(); } });
