/**
 * start.e2e.test.ts - rwr-research-start-api against a LAB database carrying the full initdb chain (slots 420, 460 and
 * 540 included), as the production app role (ob_app_memory), with the REAL research service (index.ts) over HTTP and a
 * HOSTILE proposer (it returns every personal field verbatim).
 *
 *   1. slot 540's allow-list in the database: a derived job may carry contract.budget (numbers, one key) on a root and
 *      on a branch; a source list, a red line, a string number, an extra key or a stray `depth` is refused.
 *   2. THE PREVIEW writes nothing: no research_jobs row, no research_handbacks row (counts before and after), and it
 *      answers the boundary's question with no personal marker.
 *   3. THE START: 202, a derived job whose query is the previewed question, no research_prompts row, no inlet_ref /
 *      refinery_id, options public_links + queue_origin + contract.budget; the budget of quick | standard | deep is
 *      min(preset, the admin ceilings the service was started with) - deep under LOWER ceilings is the ceilings.
 *   4. approved_question that the boundary would not send is a 409 and starts nothing.
 *   5. attach to nothing (kind chat): a derived job with no document / idea link; its private hand-back is purpose
 *      user-start, owner-only.
 *   6. THE SWEEP: no planted marker (question, document text, idea title / summary, passages) in any text / json column
 *      of any shared table, in the search egress or the page fetches - and the markers ARE in what the hostile proposer
 *      was given (the zero is not vacuous).
 *   7. two identities: another subject's hand-back list holds none of this owner's rows.
 *   8. round 2 - an IDEA is not a start (slot 580 PD0b; the coordinator's decision): the preview and the start doors both
 *      answer the same 400 for an idea item (the owner's real idea, another subject naming it, purpose idea-research),
 *      nothing is formed or written (no job, no hand-back, no personal job on the idea), and slot 580's trigger still
 *      refuses a user-start hand-back on an idea (23514) - its rules are untouched.
 *
 * IGNORED unless BND_E2E_DB_HOST is set (run-boundary-e2e.ps1 sets it inside a disposable internal network).
 */
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Pool } from "postgres";
import { MK, OWNER } from "./fixtures/boundary-markers.ts";
import { describe, sweepTables } from "./fixtures/boundary-sweep.ts";

const DB_HOST = Deno.env.get("BND_E2E_DB_HOST") ?? "";
const DB_PASSWORD = Deno.env.get("BND_E2E_DB_PASSWORD") ?? "";
const APP_PASSWORD = Deno.env.get("BND_E2E_APP_PASSWORD") ?? "";
const SERVICE_DIR: string | URL = Deno.env.get("BND_E2E_SERVICE_DIR") ?? new URL(".", import.meta.url);
const ignore = !DB_HOST;
const opts = { ignore, sanitizeOps: false, sanitizeResources: false };
const SHARED = "e2e-shared-key-000000";
const WORKSPACE = "e2e-workspace-key-00000";
const BEE = "user-bee-second";
const PAGES_PORT = Deno.env.get("BND_E2E_PAGES_PORT") ?? "8080";
const PERSONAL: Record<string, string> = Object.fromEntries(Object.entries(MK).filter(([k]) => k !== "PUB"));
// the admin ceilings this lab's research service runs with: LOWER than the shipped ones, so "deep" must come out as these
const CEIL = { rounds: 2, max_fetch: 30, wall_ms: 600_000 };

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
const STAMP = JSON.stringify({ version: "pd0a-2", lexicon: "a".repeat(64), verdict_id: "b".repeat(64) });
function derivedInsert(options: string): string {
  return `INSERT INTO public.research_jobs (status, origin, caller, query, anchor, request_kind, boundary, options)
          VALUES ('done', 'manual', 'boundary', 'What is known about solar roofs?', 'What is known about solar roofs?', 'derived', '${STAMP}'::jsonb, '${options}'::jsonb)
          RETURNING id::text AS id`;
}

// ── 1. slot 540's allow-list ─────────────────────────────────────────────────────────────────
Deno.test({ name: "S1. slot 540: contract.budget (numbers, nothing else) is allowed on a derived root and branch; anything wider is refused", ...opts, fn: async () => {
  const ok = await q<{ id: string }>(su, derivedInsert(`{"public_links":[],"contract":{"budget":{"rounds":2,"max_fetch":30,"wall_ms":600000}}}`));
  const root = ok[0].id;
  for (const bad of [
    `{"contract":{"sources":{"allow":["example.org"]}}}`, `{"contract":{"redlines":["no_exploit_fetch"]}}`,
    `{"contract":{"budget":{"rounds":"3"}}}`, `{"contract":{"budget":{"rounds":0}}}`, `{"contract":{"budget":{"rounds":1,"note":2}}}`,
    `{"contract":{"budget":{"rounds":1},"sources":{}}}`, `{"contract":{}}`, `{"contract":"x"}`, `{"depth":"deep"}`,
    `{"contract":{"budget":{"rounds":1234567890}}}`,
  ]) assert((await refused(su, derivedInsert(bad))).includes("request boundary"), bad);
  // a gap branch of a derived root inherits the narrowed, budget-only contract (tree.ts inheritOptions)
  const branch = (opt: string) => `INSERT INTO public.research_jobs (status, origin, query, anchor, rooted_step_id, parent_job_id, root_job_id, branch_kind, options)
     VALUES ('done', 'manual', 'Verify: a claim', 'a', 's1', '${root}', '${root}', 'gap', '${opt}'::jsonb) RETURNING id::text AS id`;
  await q(su, branch(`{"lane":"research-branch","contract":{"budget":{"rounds":2,"max_fetch":30}}}`));
  assert((await refused(su, branch(`{"contract":{"sources":{"deny":["x.example.org"]}}}`))).includes("request boundary"), "a branch's source list");
  // the same through the application role
  assert((await refused(app, derivedInsert(`{"contract":{"sources":{"allow":["example.org"]}}}`))).length > 0);
  // the hand-back purpose CHECK
  const h = await q<{ id: string }>(su, `SELECT public.handback_open($1, 'chat', 'start:s540', NULL, 'user-start', NULL, 'refused', NULL, NULL, NULL)::text AS id`, [OWNER.sub]);
  assert(h[0].id);
  await q(su, `DELETE FROM public.research_handbacks WHERE id = $1::uuid`, [h[0].id]); // the check row is not part of S2-S7's counts
  assert((await refused(su, `SELECT public.handback_open($1, 'chat', 'start:s540b', NULL, 'made-up', NULL, 'refused', NULL, NULL, NULL)`, [OWNER.sub])).length > 0, "an unknown purpose");
  console.log("slot 540: contract.budget allowed on a root and a branch; sources / redlines / string and zero numbers / extra keys / depth / empty refused; user-start is a purpose");
}});

// ── the real service over HTTP ───────────────────────────────────────────────────────────────
const VEC = (() => { const v = new Array(1024).fill(0); v[0] = 1; return v; })();
function stubs() {
  const log = { proposer: [] as string[], search: [] as string[] };
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, hostname: "0.0.0.0", signal: ac.signal, onListen: () => {} }, async (req) => {
    const u = new URL(req.url);
    if (u.pathname.endsWith("/observe/queue/estimate")) return Response.json({ max_concurrency: 2, capacity_declared: true });
    if (u.pathname === "/search") {
      log.search.push(u.searchParams.get("q") ?? "");
      return Response.json({ results: [{ url: `http://news.example.org:${PAGES_PORT}/solar-roofs`, title: "Community solar roofs cut winter bills", content: "solar roofs survey" }] });
    }
    const raw = await req.text();
    if (u.pathname.endsWith("/ingest/research-package")) return Response.json({ thread_id: null, persist: { sources_written: 1, source_ids: [] }, claims: { claimsWritten: 0, filed: [] } });
    if (u.pathname.startsWith("/research/filed")) return Response.json({ filed: null });
    // deno-lint-ignore no-explicit-any
    const body: any = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
    if (u.pathname.endsWith("/embeddings")) return Response.json({ data: [{ embedding: VEC }] });
    const sys = String(body?.messages?.[0]?.content ?? "");
    const user = String(body?.messages?.[1]?.content ?? "");
    if (body?.max_tokens === 1) return Response.json({ choices: [{ message: { content: "ok" } }] });
    let content = "{}";
    if (sys.includes("You write research questions for a public research library")) {
      log.proposer.push(raw);
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
  const port = server.addr.port;
  return { base: `http://127.0.0.1:${port}`, log, async close() { ac.abort(); await server.finished; } };
}
function freePort(): number { const l = Deno.listen({ port: 0, hostname: "127.0.0.1" }); const p = (l.addr as Deno.NetAddr).port; l.close(); return p; }
async function startService(stubBase: string) {
  const port = freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--unstable-net", "--allow-net", "--allow-env", "index.ts"], cwd: SERVICE_DIR,
    env: {
      PORT: String(port), DB_HOST, DB_PORT: "5432", DB_NAME: "openbrain", DB_USER: "ob_app_memory", DB_PASSWORD: APP_PASSWORD,
      MCP_ACCESS_KEY: SHARED, RESEARCH_CALLERS: `workspace=workspace:${WORKSPACE}`,
      CHAT_API_BASE: `${stubBase}/v1`, EMBEDDING_API_BASE: `${stubBase}/v1`, CURATOR_URL: stubBase, SEARCH_API_BASE: stubBase,
      CHAT_API_KEY: "lab-stub-key", RESEARCH_BRANCH_LLM_KEY: "lab-stub-branch-key", RESEARCH_LANE_REFRESH_MS: "1000",
      FETCH_PROXY_URL: "", OWUI_BASE_URL: "", CALLBACK_MIN_AGE_MS: "0", CURATOR_FILE_ATTEMPTS: "1",
      CHAT_DOWN_BUDGET_MS: "4000", RESEARCH_MODEL_PROBE_MS: "1000", RESEARCH_MODEL_PROBE_TIMEOUT_MS: "3000", NO_COLOR: "1",
      WORKSPACE_DEFAULT_SUB: "",
      // the admin ceilings (what a deep preset is clamped by)
      MAX_ROUNDS: String(CEIL.rounds), MAX_FETCH: String(CEIL.max_fetch), MAX_WALL_MS: String(CEIL.wall_ms),
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
const post = (base: string, path: string, body: unknown, key = WORKSPACE) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "x-brain-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
const counts = async () => (await q<{ j: number; h: number }>(su,
  `SELECT (SELECT count(*)::int FROM public.research_jobs) AS j, (SELECT count(*)::int FROM public.research_handbacks) AS h`))[0];

Deno.test({ name: "S2-S7. preview writes nothing; start forms the same request inside the ceilings; markers stay out; attach-to-nothing; two identities", ...opts, fn: async () => {
  await q(su, `INSERT INTO public.workspace_users (sub, name, email) VALUES ($1, $2, $3) ON CONFLICT (sub) DO NOTHING`, [OWNER.sub, OWNER.name, OWNER.email]);
  const st = stubs();
  const svc = await startService(st.base);
  const out: string[] = [];
  try {
    const page = `http://news.example.org:${PAGES_PORT}/solar-roofs`;
    const item = (kind: string, id: string, extra: Record<string, string> = {}) => ({
      kind, id, owner_sub: OWNER.sub, links: [page],
      fields: { question: `${MK.SUM} should I fit solar roofs on my cabin`, document_title: `${MK.TIT} cabin notes`, document: `${MK.BODY} long personal notes about my cabin`, passage_1: `${MK.REPLY} a passage`, ...extra },
    });
    const body = (it: unknown, depth: string, more: Record<string, unknown> = {}) => ({ purpose: "user-start", item: it, run: { depth }, deliver: { attach: "document" }, ...more });

    // ── S2: the preview writes nothing, and shows the boundary's question
    const before = await counts();
    const pv = await post(svc.base, "/research/derived/preview", body(item("document", "documents/lab/notes.md#p1"), "deep"));
    assertEquals(pv.status, 200);
    const pvText = await pv.text();
    const pj = JSON.parse(pvText);
    assert(pj.ok === true && typeof pj.question === "string", pvText.slice(0, 400));
    for (const [k, m] of Object.entries(PERSONAL)) assertFalse(pvText.includes(m), `a marker (${k}) is in the preview`);
    assertEquals(Object.keys(pj).sort(), ["depth", "links", "ok", "question", "topic"]);
    assertEquals(await counts(), before, "the preview created no job and no hand-back");
    assert(st.log.proposer.length >= 1 && st.log.proposer.some((r) => r.includes(MK.SUM)), "the hostile proposer WAS given the personal text (the zero below is not vacuous)");
    assertEquals(pj.depth.budget, { rounds: CEIL.rounds, max_fetch: CEIL.max_fetch, wall_ms: CEIL.wall_ms }, "deep under lower ceilings previews as the ceilings");
    out.push(`preview: 200, the boundary's question, depth deep -> ${JSON.stringify(pj.depth.budget)}; jobs ${before.j} -> ${(await counts()).j}, hand-backs ${before.h} -> ${(await counts()).h}`);
    assertEquals((await post(svc.base, "/research/derived/preview", body(item("document", "x"), "deep"), "wrong")).status, 401);

    // ── S3: the start - the same function, the previewed question, inside the ceilings
    const budgets: Record<string, unknown> = {};
    const jobs: string[] = [];
    for (const depth of ["quick", "standard", "deep"]) {
      const r = await post(svc.base, "/research/derived", body(item("document", `documents/lab/notes.md#s-${depth}`), depth, { approved_question: pj.question }));
      const j = await r.json();
      assertEquals(r.status, 202, JSON.stringify(j));
      assertEquals(j.question, pj.question, "the start's question is the previewed one");
      jobs.push(j.job_id);
      const row = (await q<{ request_kind: string; caller: string; query: string; anchor: string; inlet_ref: unknown; refinery_id: unknown; options: Record<string, unknown>; prompts: number }>(su,
        `SELECT j.request_kind, j.caller, j.query, j.anchor, j.inlet_ref, j.refinery_id, j.options,
                (SELECT count(*)::int FROM public.research_prompts p WHERE p.job_id = j.id) AS prompts FROM public.research_jobs j WHERE j.id = $1::uuid`, [j.job_id]))[0];
      assertEquals([row.request_kind, row.caller, row.query === pj.question, row.query === row.anchor, row.inlet_ref, row.refinery_id, row.prompts], ["derived", "boundary", true, true, null, null, 0]);
      assertEquals(Object.keys(row.options).sort(), ["contract", "public_links", "queue_origin"]);
      budgets[depth] = (row.options.contract as { budget: unknown }).budget;
    }
    assertEquals(budgets.quick, { rounds: 1, max_fetch: 12, wall_ms: 300_000 });
    assertEquals(budgets.standard, { rounds: 2, max_fetch: 30, wall_ms: 600_000 }, "standard (40) is clamped by the 30 ceiling");
    assertEquals(budgets.deep, { rounds: CEIL.rounds, max_fetch: CEIL.max_fetch, wall_ms: CEIL.wall_ms }, "deep never exceeds the admin ceilings");
    out.push(`start: 3 derived jobs, query = the previewed question, no prompt row / inlet_ref / refinery_id; budgets ${JSON.stringify(budgets)}`);

    // ── S4: a question the boundary would not send is a 409 and starts nothing
    const n0 = await counts();
    const ch = await post(svc.base, "/research/derived", body(item("document", "documents/lab/notes.md#chg"), "standard", { approved_question: `What is known about ${MK.SUM}?` }));
    const chj = await ch.json();
    assert(ch.status === 409 && chj.changed === true, `${ch.status} ${JSON.stringify(chj).slice(0, 300)}`);
    assertFalse(JSON.stringify(chj).includes(MK.SUM), "the 409 shows no marker");
    assertEquals(await counts(), n0, "a changed question created no job and no hand-back");
    out.push("approved_question that the boundary would not send: 409, nothing created");

    // ── S5: attach to nothing - a chat item; no document / idea link anywhere
    const none = await post(svc.base, "/research/derived", body(item("chat", "start:lab-none-1", { document: "", document_title: "", passage_1: "" }), "quick", { deliver: { attach: "none" } }));
    const nj = await none.json();
    assertEquals(none.status, 202, JSON.stringify(nj));
    jobs.push(nj.job_id);
    const nrow = (await q<{ inlet_ref: unknown; refinery_id: unknown; options: Record<string, unknown> }>(su, `SELECT inlet_ref, refinery_id, options FROM public.research_jobs WHERE id = $1::uuid`, [nj.job_id]))[0];
    assertEquals([nrow.inlet_ref, nrow.refinery_id], [null, null]);
    assertFalse(JSON.stringify(nrow.options).includes("documents/"), "no document in the job's options");
    const hbs = await q<{ inlet_kind: string; purpose: string; state: string }>(su, `SELECT inlet_kind, purpose, state FROM public.research_handbacks WHERE owner_sub = $1 AND purpose = 'user-start' ORDER BY created_at`, [OWNER.sub]);
    assertEquals(hbs.length, 4);
    assert(hbs.every((h) => h.state === "queued") && hbs.some((h) => h.inlet_kind === "chat") && hbs.filter((h) => h.inlet_kind === "document").length === 3, JSON.stringify(hbs));
    out.push(`attach to nothing: a derived job with no inlet_ref / refinery_id / document; ${hbs.length} private user-start hand-backs (3 document, 1 chat), one per start`);

    // ── run the jobs so the sweep sees what research does with them
    for (let i = 0; i < 300; i++) {
      const left = (await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM public.research_jobs WHERE id = ANY($1::uuid[]) AND status IN ('queued','running')`, [jobs]))[0].n;
      if (!left) break;
      await sleep(500);
    }
    const ran = await q<{ status: string; n: number }>(su, `SELECT status, count(*)::int AS n FROM public.research_jobs WHERE id = ANY($1::uuid[]) GROUP BY status`, [jobs]);
    assert(ran.every((x) => x.status === "done"), `${JSON.stringify(ran)}\n${svc.log.slice(-2500)}`);
    out.push(`the jobs ran: ${ran.map((x) => `${x.status}=${x.n}`).join(" ")}`);

    // ── S6: the sweep - no marker in any shared column, the search egress, the research_jobs rows
    const c = await su!.connect();
    let sw;
    try { sw = await sweepTables(c, PERSONAL); } finally { c.release(); }
    out.push(`sweep: ${describe(sw)}`);
    assertEquals(sw.hits, [], `a planted marker reached a shared table: ${JSON.stringify(sw.hits)}`);
    for (const [k, m] of Object.entries(PERSONAL)) {
      assertFalse(st.log.search.join("\n").includes(m), `a marker (${k}) reached the search gateway's request`);
      const jt = (await q<{ t: string }>(su, `SELECT string_agg(j::text, E'\\n') AS t FROM public.research_jobs j WHERE j.id = ANY($1::uuid[])`, [jobs]))[0].t;
      assertFalse(jt.includes(m), `a marker (${k}) is in a created research_jobs row`);
    }
    out.push(`search egress: ${st.log.search.length} request(s), no marker`);

    // ── S7: two identities - the other subject sees none of this owner's hand-backs
    // (BEE may hold rows from the boundary's own e2e in this database: none of them is a user-start, none is one of these jobs)
    const bee = await q<{ n: number }>(app, `SELECT count(*)::int AS n FROM public.handback_owned($1, 500) WHERE purpose = 'user-start' OR job_id = ANY($2::uuid[])`, [BEE, jobs]);
    assertEquals(bee[0].n, 0, "another subject's hand-back list holds none of this owner's start rows");
    const own = await q<{ n: number }>(app, `SELECT count(*)::int AS n FROM public.handback_owned($1, 500) WHERE purpose = 'user-start'`, [OWNER.sub]);
    assertEquals(own[0].n, 4);
    assertEquals((await q(app, `SELECT * FROM public.handback_owned($1, 500) WHERE position($2 in verdict::text || deliver::text) > 0`, [OWNER.sub, MK.SUM])).length, 0, "the hand-back holds hashes and codes, not the question's text");
    out.push("two identities: another subject's list holds none of the owner's user-start rows or jobs; the owner's is 4; the hand-back holds no personal text");
  } finally {
    await svc.stop();
    await st.close();
    console.log(out.join("\n"));
  }
}});

Deno.test({ name: "S8. an idea is not a start: preview and start refuse it alike (owner or not), nothing written; slot 580's trigger still refuses", ...opts, fn: async () => {
  await q(su, `INSERT INTO public.workspace_users (sub, name, email) VALUES ($1, $2, $3) ON CONFLICT (sub) DO NOTHING`, [OWNER.sub, OWNER.name, OWNER.email]);
  const idea = (await q<{ id: string }>(su, `INSERT INTO public.ideas (title, owner_sub) VALUES ('start lab idea', $1) RETURNING id::text AS id`, [OWNER.sub]))[0].id;
  const st = stubs();
  const svc = await startService(st.base);
  const out: string[] = [];
  try {
    const before = await counts();
    const proposed = st.log.proposer.length;
    const item = (owner: string) => ({
      kind: "idea", id: `${idea}#s8`, revision: 1, owner_sub: owner, links: [],
      fields: { question: `${MK.SUM} should I build it`, title: `${MK.TIT} my idea`, summary: `${MK.BODY} the plan`, passage_1: `${MK.REPLY} a passage` },
    });
    const answers: Array<{ path: string; status: number; text: string }> = [];
    for (const path of ["/research/derived/preview", "/research/derived"]) {
      for (const [owner, purpose] of [[OWNER.sub, "user-start"], [BEE, "user-start"], [OWNER.sub, "idea-research"]]) {
        const r = await post(svc.base, path, { purpose, item: item(owner), run: { depth: "quick" }, deliver: { attach: "idea" } });
        answers.push({ path, status: r.status, text: await r.text() });
      }
    }
    assertEquals(answers.map((a) => a.status), [400, 400, 400, 400, 400, 400], JSON.stringify(answers));
    assertEquals(new Set(answers.map((a) => a.text)).size, 1, "the preview and the start answer an idea alike, whoever names it");
    for (const [k, m] of Object.entries(PERSONAL)) assertFalse(answers[0].text.includes(m), `a marker (${k}) is in the refusal`);
    assertFalse(answers[0].text.includes(idea), "the refusal names no idea");
    assertEquals(st.log.proposer.length, proposed, "nothing was formed: the proposer was never asked");
    assertEquals(await counts(), before, "no job and no hand-back");
    const onIdea = await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM public.research_jobs WHERE refinery_id::text = $1 OR inlet_ref->>'id' = $1`, [idea]);
    assertEquals(onIdea[0].n, 0, "no job of any kind (personal or derived) is tied to the idea");
    const hb = await q<{ n: number }>(su, `SELECT count(*)::int AS n FROM public.research_handbacks WHERE lower(inlet_id) LIKE $1::text || '%'`, [idea]);
    assertEquals(hb[0].n, 0, "no hand-back names the idea");
    out.push(`idea: preview + start x (owner, another subject, purpose idea-research) = 6 x 400, one answer, no marker; jobs ${before.j} -> ${(await counts()).j}, hand-backs ${before.h} -> ${(await counts()).h}`);
    // slot 580 untouched: a user-start hand-back on an idea is still refused by its trigger, for the owner too
    const e = await refused(su, `INSERT INTO public.research_handbacks (owner_sub, inlet_kind, inlet_id, purpose, state, deliver)
                                 VALUES ($1, 'idea', $2, 'user-start', 'refused', '{}'::jsonb)`, [OWNER.sub, idea]);
    assert(/an idea hand-back is inlet idea with purpose idea-research/.test(e), e);
    out.push("slot 580's trigger: a user-start hand-back on the owner's idea is refused (23514)");
  } finally {
    await svc.stop();
    await st.close();
    await q(su, `DELETE FROM public.ideas WHERE id = $1::uuid`, [idea]).catch(() => {});
    console.log(out.join("\n"));
  }
}});

Deno.test({ name: "teardown", ...opts, fn: async () => { await su?.end(); await app?.end(); } });
