// deno test src/inlet/private_report_claims_integration_test.ts - slot 570 (research-workbench rw-private-report-claims;
// operator 2026-11-21 "any information generated from private data remains private since it could leak through a
// generated series"): a claim drawn from a private report is private to the report's owner on every shared read.
//
// SKIPPED unless PRC_PHASE, PRC_WB and CONTRACT_TEST_DB_HOST are set. contract-test/run-private-report-claims-lab.ps1
// runs it in phases on a DISPOSABLE internal network, around psql runs of init- / revert- / check-private-report-claims.sql:
//   plant     (after the lab REVERTED the chain's 570, so the 390 model is writable) two users' private idea reports and
//             the claims drawn from them in the shape 390 left them (shared rows + the link back), plus everything that
//             names them: their grounding edges, a contradicts edge onto a shared claim, a shared job's reuse list, a
//             wiki page carrying a claim's text, a corroboration line of B's run; the controls (a shared claim, a claim a
//             shared synthesis also filed); a claim linked to both users' reports and one to an ownerless report
//   red       before 570 runs: every [leak] / [db] case FAILS (A, the lane, a service, A signed in and a non-owner admin
//             read B's claims); every [control] / [owner] case passes
//   migrated  after 570: every case passes
// Identities: B is the victim (PRC_B); A (PRC_A) a second user; C (PRC_C) an admin signed in (forward-auth, the admin
// group) who owns nothing; the lane (no identity header: the default subject the MCP lanes act as); a service key.
// Round 2 (tester attempt 1): the plant uses a registered content type and every red / migrated case first asserts the
// plant LANDED (landed()) - a missing plant fails loudly ("plant did not land"), never a vacuous red; the gap work of a
// shared tree (P1), the wiki variants (P3), the services' REAL login (the owner read, the link guard, the gap guard),
// PostgREST's rpc refused, and a P2 shared synthesis restating one of B's claims (counted by the lab, not judged).
// Only counts, route names and pass/fail are printed, never a claim's text. Never point it at a live stack.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const PHASE = Deno.env.get("PRC_PHASE") ?? "";
const WB = (Deno.env.get("PRC_WB") ?? "").replace(/\/+$/, "");          // header-identity workbench
const WB_FA = (Deno.env.get("PRC_WB_FA") ?? "").replace(/\/+$/, "");    // forward-auth (signed-in) workbench
const KEY = Deno.env.get("PRC_KEY") ?? "";
const DOOR = Deno.env.get("PRC_DOOR") ?? "";
const SVC_KEY = Deno.env.get("PRC_SVC_KEY") ?? "";
const A = Deno.env.get("PRC_A") ?? "";
const B = Deno.env.get("PRC_B") ?? "";
const C = Deno.env.get("PRC_C") ?? "";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const off = !PHASE || !WB || !HOST || !A || !B;
const pool = !off
  ? new Pool({
    hostname: HOST!, port: 5432, database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 2, true)
  : null;
// the services' REAL login (ob_app_memory, non-superuser: session_user is it), as the workbench and the curator connect
const APP_PW = Deno.env.get("PRC_APP_PASSWORD") ?? "";
const appPool = !off && APP_PW
  ? new Pool({ hostname: HOST!, port: 5432, database: "openbrain", user: "ob_app_memory", password: APP_PW }, 2, true)
  : null;
// slot 480's workbench login (ob_workbench: LOGIN INHERIT, a member of ob_app_memory), as 480 creates it
const WB_PW = Deno.env.get("PRC_WB_PASSWORD") ?? "";
const wbPool = !off && WB_PW
  ? new Pool({ hostname: HOST!, port: 5432, database: "openbrain", user: "ob_workbench", password: WB_PW }, 1, true)
  : null;
// the REST door (slot 450: Caddy + PostgREST, no anonymous role) as /rest/v1, and every minted caller's own token (ROLE=jwt,...)
const PGRST = (Deno.env.get("PRC_PGRST") ?? "").replace(/\/+$/, "");
const REST_TOKENS = (Deno.env.get("PRC_REST_TOKENS") ?? "").split(",").filter(Boolean).map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)] as [string, string]);
const t = (phases: string[], name: string, fn: () => Promise<void>) =>
  Deno.test({ name: `[${phases.join("|")}] ${name}`, ignore: off || !phases.includes(PHASE), fn, sanitizeOps: false, sanitizeResources: false });
const BOTH = ["red", "migrated"];

// deno-lint-ignore no-explicit-any
async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try { return (await c.queryObject<T>(text, args)).rows; } finally { c.release(); }
}
// deno-lint-ignore no-explicit-any
async function asRole<T = Record<string, any>>(role: string, text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    await c.queryObject("BEGIN");
    await c.queryObject(`SET LOCAL ROLE ${role}`);
    const rows = (await c.queryObject<T>(text, args)).rows;
    await c.queryObject("COMMIT");
    return rows;
  } catch (e) {
    try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
    throw e;
  } finally { c.release(); }
}
// a probe that changes nothing: one transaction, always rolled back (the red phase must leave the planted state as it was)
// deno-lint-ignore no-explicit-any
async function probe<T = Record<string, any>>(role: string | null, text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    await c.queryObject("BEGIN");
    if (role) await c.queryObject(`SET LOCAL ROLE ${role}`);
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
    c.release();
  }
}
// as the services' real login, one transaction, always rolled back
// deno-lint-ignore no-explicit-any
async function asApp<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  if (!appPool) throw new Error("PRC_APP_PASSWORD is not set: the services' real login is required");
  const c = await appPool.connect();
  try {
    await c.queryObject("BEGIN");
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
    c.release();
  }
}
// as PostgREST runs a request: its anon role, request.method set (what slot 570's caller gate keys on)
// deno-lint-ignore no-explicit-any
async function asPostgrest<T = Record<string, any>>(role: string, text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    await c.queryObject("BEGIN");
    await c.queryObject(`SELECT set_config('request.method', 'POST', true) AS m, set_config('request.path', '/rpc/x', true) AS p`);
    await c.queryObject(`SET LOCAL ROLE ${role}`);
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
    c.release();
  }
}
async function errCode(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return ""; } catch (e) { return String((e as { fields?: { code?: string } }).fields?.code ?? (e as Error).message); }
}
const rnd = () => crypto.randomUUID().slice(0, 8);
const VEC = `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`; // the lab embedder's vector

// the lab signer: Authentik's outpost token (HS256 with the lab proxy provider's client secret)
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encJ = (o: unknown) => b64u(new TextEncoder().encode(JSON.stringify(o)));
async function token(sub: string, groups: string[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: Deno.env.get("PRC_FA_ISSUER"), aud: Deno.env.get("PRC_FA_CLIENT"), sub, iat: now, exp: now + 3600, name: sub, preferred_username: sub, groups };
  const data = `${encJ({ alg: "HS256", typ: "JWT" })}.${encJ(claims)}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(Deno.env.get("PRC_FA_SECRET") ?? ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${data}.${b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))))}`;
}
type Viewer = { name: string; base: string; headers: () => Promise<Record<string, string>> };
const VIEWERS_NOT_B: Viewer[] = [
  { name: "A", base: WB, headers: () => Promise.resolve({ "x-brain-key": KEY, "X-Test-Sub": A }) },
  { name: "lane", base: WB, headers: () => Promise.resolve({ "x-brain-key": KEY }) },
  { name: "service", base: WB, headers: () => Promise.resolve({ "x-brain-key": SVC_KEY }) },
  ...(WB_FA ? [
    { name: "A signed in", base: WB_FA, headers: async () => ({ "x-brain-key": DOOR, "x-authentik-jwt": await token(A, ["lab-users"]) }) },
    { name: "admin C signed in", base: WB_FA, headers: async () => ({ "x-brain-key": DOOR, "x-authentik-jwt": await token(C, ["lab-users", "lab-admins"]) }) },
  ] : []),
];
const B_VIEWERS: Viewer[] = [
  { name: "B", base: WB, headers: () => Promise.resolve({ "x-brain-key": KEY, "X-Test-Sub": B }) },
  ...(WB_FA ? [{ name: "B signed in", base: WB_FA, headers: async () => ({ "x-brain-key": DOOR, "x-authentik-jwt": await token(B, ["lab-users"]) }) }] : []),
];
async function get(v: Viewer, path: string) {
  const r = await fetch(v.base + path, { headers: await v.headers() });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, text, json };
}

// deno-lint-ignore no-explicit-any
async function plant(): Promise<Record<string, any>> {
  const r = await sql<{ v: Record<string, unknown> }>(
    `SELECT v FROM public.lab_prc_plant WHERE k = 'plant'`).catch(() => [] as { v: Record<string, unknown> }[]);
  const p = r[0]?.v;
  if (!p || !p.R) throw new Error("plant did not land: no plant record");
  await landed(p);
  return p;
}
// the plant is where the phase expects it - before any absence check (round 2, tester F1: a missing plant made every red
// case fail vacuously). Each planted claim is in the shared table, an owner store or 570's archive; each planted page /
// gap row is in its table or the archive; the shared job and the gap branch exist.
// deno-lint-ignore no-explicit-any
async function landed(p: Record<string, any>): Promise<void> {
  const ids = [p.b1, p.b2, p.b3, p.a1, p.multi, p.orph, p.ctl, p.mix, p.bh, p.dupB3, p.supB2];
  // fix item (P2): each planted shared synthesis is in sources or 570's archive (moved / withheld); each P2 job exists
  const syns = [p.syn, p.p2syn, p.p2multi, p.synCtl, p.p2synB];
  const p2 = (await sql<{ s: number; j: number }>(
    `SELECT (SELECT count(DISTINCT x)::int FROM unnest($1::uuid[]) x
              WHERE EXISTS (SELECT 1 FROM public.sources s WHERE s.id = x)
                 OR (to_regclass('public.private_report_claims_archive') IS NOT NULL
                     AND EXISTS (SELECT 1 FROM public.private_report_claims_archive a WHERE a.action = 's' AND a.ref = x::text AND a.restored_at IS NULL))) AS s,
            (SELECT count(*)::int FROM public.research_jobs WHERE id = ANY($2::uuid[])) AS j`,
    [syns, [p.p2job, p.p2jobA, p.hjob, p.hchild]]))[0];
  if (p2.s !== syns.length || p2.j !== 4) throw new Error(`plant did not land: P2 syntheses ${p2.s}/${syns.length}, jobs ${p2.j}/4`);
  const n = (await sql<{ c: number; j: number; g: number; s: number; e: number; w: number; syn: number }>(
    `SELECT (SELECT count(DISTINCT x)::int FROM unnest($1::uuid[]) x
              WHERE EXISTS (SELECT 1 FROM public.claims c WHERE c.id = x)
                 OR EXISTS (SELECT 1 FROM public.inlet_private_claims c WHERE c.id = x)
                 OR (to_regclass('public.private_report_claims_archive') IS NOT NULL
                     AND EXISTS (SELECT 1 FROM public.private_report_claims_archive a WHERE a.action IN ('k', 'x') AND a.ref = x::text))) AS c,
            (SELECT count(*)::int FROM public.research_jobs WHERE id = $2::uuid) AS j,
            (SELECT count(*)::int FROM public.research_jobs WHERE id = $3::uuid AND gap_ref = 'claim:' || $4) AS g,
            (SELECT count(*)::int FROM public.research_steers WHERE child_job_id = $3::uuid) AS s,
            (SELECT count(*)::int FROM public.research_job_events WHERE job_id = $2::uuid AND type = 'gap' AND payload ->> 'claim_id' = $4) AS e,
            (SELECT count(*)::int FROM unnest($5::text[]) x
              WHERE EXISTS (SELECT 1 FROM public.wiki_pages w WHERE w.slug = x)
                 OR (to_regclass('public.private_report_claims_archive') IS NOT NULL
                     AND EXISTS (SELECT 1 FROM public.private_report_claims_archive a WHERE a.action = 'w' AND a.ref = x))) AS w,
            (SELECT count(*)::int FROM unnest(ARRAY[$6::uuid]) x
              WHERE EXISTS (SELECT 1 FROM public.sources s WHERE s.id = x)
                 OR (to_regclass('public.private_report_claims_archive') IS NOT NULL
                     AND EXISTS (SELECT 1 FROM public.private_report_claims_archive a WHERE a.action = 's' AND a.ref = x::text AND a.restored_at IS NULL))) AS syn`,
    [ids, p.job, p.child, p.b1, [p.page, p.pageCite, p.pageBold, p.pageWiki, p.pageMid, p.pageSup, p.clean, p.near], p.p2syn]))[0];
  const want = { c: ids.length, j: 1, g: 1, s: 1, e: 1, w: 8, syn: 1 };
  const got = { c: n.c, j: n.j, g: n.g, s: n.s, e: n.e, w: n.w, syn: n.syn };
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`plant did not land: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
}

// fix item (F2): the human steer's three rows as a person wrote them (the steer's text, its branch's question, its event)
async function humanImage(hjob: string, hchild: string): Promise<string> {
  return (await sql<{ h: string }>(
    `SELECT md5((SELECT text || '|' || topic_estimate || '|' || anchor FROM public.research_steers WHERE child_job_id = $2::uuid)
                || '|' || (SELECT query || '|' || anchor FROM public.research_jobs WHERE id = $2::uuid)
                || '|' || (SELECT string_agg(payload::text, '|' ORDER BY id) FROM public.research_job_events WHERE job_id = $1::uuid AND type = 'human_steer')) AS h`,
    [hjob, hchild]))[0].h;
}

// ── plant: the 390 shape ───────────────────────────────────────────────────────────────────────────────────────────
t(["plant"], "plant two users' private reports and their claims in the shape slot 390 left them", async () => {
  const R = rnd();
  const w = { b: `prcb${R}`, a: `prca${R}`, multi: `prcmulti${R}`, orph: `prcorph${R}`, ctl: `prcctl${R}`, mix: `prcmix${R}`, bnew: `prcbnew${R}`, b3: `prcbthree${R}`, bh: `prcbhuman${R}` };
  const one = async (q: string, args: unknown[] = []) => (await sql<{ id: string }>(q, args))[0].id;
  const thread = await one(`INSERT INTO public.threads (name, description, status) VALUES ($1, 'a shared thread', 'active') RETURNING id::text AS id`, [`Shared thread ${R}`]);
  const src = (title: string, ct = "web_article") => one(
    `INSERT INTO public.sources (title, content, content_type, url) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
    [title, `shared page text ${title} `.repeat(4), ct, `https://example.org/prc-${R}/${title.replace(/\W+/g, "-")}`]);
  const s1 = await src(`Shared source one ${R}`);
  const s2 = await src(`Shared source two ${R}`);
  const syn = await one(`INSERT INTO public.sources (title, content, content_type, research_key) VALUES ($1, 'a shared report', 'research_synthesis', $2) RETURNING id::text AS id`,
    [`Shared report ${R}`, `rk-prc-shared-${R}`]);
  await sql(`INSERT INTO public.source_chunks (source_id, idx, content) VALUES ($1, 0, 'chunk zero of the shared source')`, [s1]).catch(() => {});
  const idea = async (owner: string, title: string) => {
    const id = await one(`SELECT public.idea_capture($1, 'service:openbrain-mcp', $2, $3, NULL, $4)::text AS id`, [owner, title, `${title} statement`, VEC]);
    let job = (await sql<{ id: string }>(`SELECT id::text AS id FROM public.research_jobs WHERE refinery_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]))[0]?.id;
    if (!job) job = await one(`INSERT INTO public.research_jobs (status, origin, query, refinery_id, branch_kind) VALUES ('done', 'manual', 'idea research', $1, 'idea') RETURNING id::text AS id`, [id]);
    await sql(`UPDATE public.research_jobs SET status = 'done', finished_at = now() WHERE id = $1`, [job]);
    return { id, job };
  };
  const bIdea = await idea(B, `B idea ${R}`);
  const aIdea = await idea(A, `A idea ${R}`);
  const report = (key: string, owner: string | null, ideaId: string | null, job: string | null) => one(
    `INSERT INTO public.research_private_reports (research_key, owner_sub, idea_id, job_id, title, content) VALUES ($1, $2, $3, $4, 'a private report', 'the private report body') RETURNING id::text AS id`,
    [key, owner, ideaId, job]);
  const bReport = await report(`rk-prc-b-${R}`, B, bIdea.id, bIdea.job);
  const aReport = await report(`rk-prc-a-${R}`, A, aIdea.id, aIdea.job);
  const orphReport = await report(`rk-prc-o-${R}`, null, null, null);
  const claim = async (text: string, th: string | null, synthesis: string | null) => {
    const id = await one(`SELECT f.id::text AS id FROM public.find_or_create_claim($1, $2::uuid, $3::uuid, 'sourced', NULL, NULL, $4::vector, '{"claim_kind":"descriptive"}'::jsonb) f`,
      [text, th, synthesis, VEC]);
    await sql(`SELECT public.link_claim_to_source($1::uuid, $2::uuid, 'states', 1.0)`, [id, s1]);
    return id;
  };
  const link = (rep: string, c: string) => sql(`INSERT INTO public.research_private_report_claims (report_id, claim_id) VALUES ($1, $2)`, [rep, c]);
  const b1 = await claim(`The ${w.b} alpha result reproduced in 12 trials across two labs.`, thread, null);
  const b2 = await claim(`The ${w.b} beta result held for 40 participants over six months.`, thread, null);
  await link(bReport, b1); await link(bReport, b2);
  // P2 (operator decision, counted not judged): B's third claim, restated by a SHARED synthesis and a shared job's report
  const b3text = `The ${w.b3} theta result was restated in a shared report later on.`;
  const b3 = await claim(b3text, null, null);
  await link(bReport, b3);
  // (round 2, P2 #4: its title / research_query are A's typed question - B's copy must not carry them)
  const p2syn = await one(`INSERT INTO public.sources (title, content, content_type, research_key, research_query) VALUES ($1, $2, 'research_synthesis', $3, $4) RETURNING id::text AS id`,
    [`A typed question ${w.a}q ${R}`, `A shared run. ${b3text} Nothing else.`, `rk-prc-shared2-${R}`, `A typed question ${w.a}q ${R}`]);
  // round 2 (P2 #4): the synthesis B's OWN question filed (p2job's curator answer): B's copy keeps its title
  const p2synB = await one(`INSERT INTO public.sources (title, content, content_type, research_key, research_query) VALUES ($1, $2, 'research_synthesis', $3, 'another shared question') RETURNING id::text AS id`,
    [`B question title ${R}`, `B's run. ${b3text}`, `rk-prc-sharedB-${R}`]);
  // round 2 (P2 #1): a thread minted from the restating synthesis (its description is the report's headline) and linked to it
  // (round 3, tester attempt 2: NAMED from the report - its slug is slugifyBase(name) in full, the hub page's path)
  const p2name = `Thread: ${b3text}`;
  const p2slug = p2name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const p2thread = await one(`INSERT INTO public.threads (name, description, status, slug) VALUES ($1, $2, 'active', $3) RETURNING id::text AS id`,
    [p2name, `Research on: ${b3text}`, p2slug]);
  await sql(`INSERT INTO public.thread_sources (thread_id, source_id) VALUES ($1, $2)`, [p2thread, p2syn]);
  // round 3: a shared web source the curator filed into that thread carries its name as the notebook label
  const nbSrc = await one(`INSERT INTO public.sources (title, content, content_type, url, notebook) VALUES ($1, 'public page text', 'web_article', $2, $3) RETURNING id::text AS id`,
    [`Filed web page ${R}`, `https://example.org/prc-${R}/filed`, p2name]);
  await sql(`INSERT INTO public.thread_sources (thread_id, source_id) VALUES ($1, $2)`, [p2thread, nbSrc]);
  // round 3: the thread's hub page (its path is the slug; title and body neutral)
  const hubPage = `notebooks/${p2slug}/${p2slug}`;
  await sql(`INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'hub', 'Hub', 'A hub page.')`, [hubPage]).catch(async () =>
    await sql(`INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'entity', 'Hub', 'A hub page.')`, [hubPage]));
  // round 3 (sibling sweep): an entity the synthesis's extraction named
  const entity = (await sql<{ id: string; at: string }>(`INSERT INTO public.entities (entity_type, canonical_name, normalized_name) VALUES ('topic', $1, $2) RETURNING id::text AS id, updated_at::text AS at`,
    [`Theta topic ${R}`, `theta topic ${R}`.toLowerCase()]))[0];
  await sql(`INSERT INTO public.source_entities (source_id, entity_id, mention_role) VALUES ($1, $2::bigint, 'about')`, [p2syn, entity.id]);
  // round 2 (P2 #2): the curator filed the synthesis's sentence into ITS thread - a separate SHARED row with B's text
  const dupB3 = await claim(b3text, p2thread, p2syn);
  // fix item (P2): B's own shared question (B's prompt) whose report restated B's claim - moves private to B, copied
  const p2job = await one(`INSERT INTO public.research_jobs (status, origin, query, finished_at, result) VALUES ('done', 'manual', 'another shared question', now(), $1::jsonb) RETURNING id::text AS id`,
    [JSON.stringify({ outcome: "answered", synthesis: `Findings. ${b3text}`, prose: `In prose: ${b3text}`, claims: [], curator: { persist: { synthesis_id: p2synB } } })]);
  await sql(`INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, $2, $2, 'another shared question')`, [p2job, B]);
  // ... and A's shared question whose report restated B's claim: withheld (a copy would hand B A's prompt's words)
  const p2jobA = await one(`INSERT INTO public.research_jobs (status, origin, query, finished_at, result) VALUES ('done', 'manual', 'a question A asked', now(), $1::jsonb) RETURNING id::text AS id`,
    [JSON.stringify({ outcome: "answered", synthesis: `A's findings. ${b3text}`, claims: [] })]);
  await sql(`INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, $2, $2, 'a question A asked')`, [p2jobA, A]);
  const a1 = await claim(`The ${w.a} gamma result was confirmed by a second team in 2025.`, null, null);
  await link(aReport, a1);
  // fix item (P2): a shared synthesis restating claims of TWO owners (B's beta, A's gamma): withheld from everyone
  const p2multi = await one(`INSERT INTO public.sources (title, content, content_type, research_key) VALUES ($1, $2, 'research_synthesis', $3) RETURNING id::text AS id`,
    [`Shared report three ${R}`, `A shared run. The ${w.b} beta result held for 40 participants over six months. Also: The ${w.a} gamma result was confirmed by a second team in 2025.`, `rk-prc-shared3-${R}`]);
  // fix item (F2): a HUMAN steer on a shared tree that typed the text of one of B's claims (bh); never rewritten
  const bhText = `The ${w.bh} kappa result was typed into a steer by a person.`;
  const bh = await claim(bhText, null, null);
  await link(bReport, bh);
  const hjob = await one(`INSERT INTO public.research_jobs (status, origin, query, finished_at) VALUES ('done', 'manual', 'a human-steered shared question', now()) RETURNING id::text AS id`);
  const hchild = await one(`INSERT INTO public.research_jobs (status, origin, query, parent_job_id, root_job_id, rooted_step_id, branch_kind, anchor)
      VALUES ('queued', 'manual', $1, $2, $2, 'synth', 'steer', 'a human-steered shared question') RETURNING id::text AS id`, [`Check: ${bhText}`, hjob]);
  await sql(`INSERT INTO public.research_steers (root_job_id, parent_job_id, child_job_id, steer_kind, step_id, text, topic_estimate, anchor, actor_sub)
             VALUES ($1, $1, $2, 'human', 'synth', $3, 'a steered topic', 'a human-steered shared question', $4)`, [hjob, hchild, `Check: ${bhText}`, A]);
  await sql(`INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, payload) VALUES ($1, $1, 'human_steer', 'steering', $2::jsonb)`,
    [hjob, JSON.stringify({ child_job_id: hchild, step_id: "synth", text: `Check: ${bhText}`, topic_estimate: "a steered topic", anchor: "a human-steered shared question" })]);
  // a shared control synthesis (the control claim's own; it restates nothing private and stays shared)
  const synCtl = await one(`INSERT INTO public.sources (title, content, content_type, research_key) VALUES ($1, 'a shared control report', 'research_synthesis', $2) RETURNING id::text AS id`,
    [`Shared control report ${R}`, `rk-prc-sharedctl-${R}`]);
  // round 3 (tester attempt 2, P2 #2): a shared claim with B's beta sentence left behind by a synthesis superseded in
  // place - its filer (the control synthesis) no longer restates it - in another thread
  const thread3 = await one(`INSERT INTO public.threads (name, description, status) VALUES ($1, 'another shared thread', 'active') RETURNING id::text AS id`, [`Other thread ${R}`]);
  const supB2 = await claim(`The ${w.b} beta result held for 40 participants over six months.`, thread3, synCtl);
  // round 3 (sibling sweep): A's idea job's curator answer named the minted thread (thread_name, the shortlist)
  await sql(`UPDATE public.research_jobs SET result = coalesce(result, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [aIdea.job, JSON.stringify({ curator: { thread_id: p2thread, thread_name: p2name, shortlist: [{ thread_id: p2thread, name: p2name, distance: 0.1 }] } })]);
  const multi = await claim(`The ${w.multi} delta result appeared in both private reports alike.`, thread, null);
  await link(bReport, multi); await link(aReport, multi);
  const orph = await claim(`The ${w.orph} epsilon result came from a report whose idea is gone.`, thread, null);
  await link(orphReport, orph);
  // controls: a shared claim (its own shared synthesis); and a claim B's report shares with a shared synthesis ("mixed":
  // fix item P2 - it moves to B like every private-report claim, and the synthesis that filed it moves private to B)
  const ctl = await claim(`The ${w.ctl} control result is shared knowledge from a shared report.`, thread, synCtl);
  const mix = await claim(`The ${w.mix} mixed result came out of a shared report too.`, thread, syn);
  await link(bReport, mix);
  // the conflict detector's reciprocal contradicts edges between B's claim and the shared control
  await sql(`SELECT public.link_claim_to_claim($1::uuid, $2::uuid, 'contradicts', 1.0)`, [ctl, b1]);
  await sql(`SELECT public.link_claim_to_claim($1::uuid, $2::uuid, 'contradicts', 1.0)`, [b1, ctl]);
  // a SHARED job that reused B's claim (and the control) - its result names B's claim and its text
  const job = await one(`INSERT INTO public.research_jobs (status, origin, query, finished_at, result, metrics)
      VALUES ('done', 'manual', 'a shared question', now(), $1::jsonb, '{"claims_reused": 2, "gap_ratio": 0.5}'::jsonb) RETURNING id::text AS id`,
    [JSON.stringify({ outcome: "answered", reuse_claims: [{ id: b1, text: `The ${w.b} alpha result reproduced in 12 trials across two labs.` }, { id: ctl, text: `The ${w.ctl} control result is shared knowledge from a shared report.` }], claims: [] })]);
  // P1 (round 2): the shared job's gap work - B's claim recalled below its threshold: a gap event on the root, a gap
  // branch asking to verify it, its steer, and the root's tree report naming the branch by it (tree.ts / index.ts shapes)
  const b1text = `The ${w.b} alpha result reproduced in 12 trials across two labs.`;
  const gap = { claim_id: b1, text: b1text, score: 0.1, threshold: 0.5, claim_kind: "descriptive" };
  await sql(`INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, payload) VALUES ($1, $1, 'gap', 'steering', $2::jsonb)`, [job, JSON.stringify(gap)]);
  const child = await one(`INSERT INTO public.research_jobs (status, origin, query, parent_job_id, root_job_id, rooted_step_id, branch_kind, anchor, gap_ref)
      VALUES ('queued', 'manual', $1, $2, $2, 'reuse', 'gap', 'a shared question', $3) RETURNING id::text AS id`, [`Verify: ${b1text}`, job, `claim:${b1}`]);
  await sql(`INSERT INTO public.research_steers (root_job_id, parent_job_id, child_job_id, steer_kind, step_id, text, topic_estimate, anchor, gap, actor_sub)
             VALUES ($1, $1, $2, 'gap', 'reuse', $3, 'a shared topic', 'a shared question', $4::jsonb, 'system:research')`, [job, child, b1text, JSON.stringify(gap)]);
  await sql(`UPDATE public.research_jobs SET topic_estimate = 'a shared topic', tree_report = $2::jsonb WHERE id = $1`,
    [job, JSON.stringify({ heading: "a shared topic", origin: "a shared question", topic_estimate: "a shared topic",
      branches: [{ job_id: child, branch_kind: "gap", opened_by: b1text, steer_kind: "gap" }],
      markdown: `# a shared topic\n\n## Branch (gap gap): ${b1text}\n` })]);
  // a wiki page carrying B's claim's text, the P3 variants (a citation marker, emphasis inside the sentence), a clean page
  const page = `content/topic/prc-${R}`, clean = `content/topic/prc-clean-${R}`;
  const pageCite = `content/topic/prc-cite-${R}`, pageBold = `content/topic/prc-bold-${R}`;
  await sql(`INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'entity', $2, $3), ($4, 'entity', $5, 'nothing private here at all'),
             ($6, 'entity', $7, $8), ($9, 'entity', $10, $11)`,
    [page, `Topic ${R}`, `Some notes. The ${w.b} alpha result reproduced in 12 trials across two labs. More notes.`, clean, `Clean topic ${R}`,
     pageCite, `Cite ${R}`, `Notes. The ${w.b} alpha result reproduced in 12 trials across two labs [Source 2]. More.`,
     pageBold, `Bold ${R}`, `Notes. The ${w.b} **alpha** result   reproduced in 12 trials across two labs. More.`]);
  // final round (tester attempt 2, Q4): the forms the round-2 normaliser did not fold, planted before 570 - a wikilink on a
  // word (the vault's own link syntax), a mid-word footnote, a <sup> marker; and a NEAR MISS that must stay (false positive)
  const pageWiki = `content/topic/prc-wiki-${R}`, pageMid = `content/topic/prc-mid-${R}`, pageSup = `content/topic/prc-sup-${R}`;
  const near = `content/topic/prc-near-${R}`;
  await sql(`INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'entity', $2, $3), ($4, 'entity', $5, $6), ($7, 'entity', $8, $9), ($10, 'entity', $11, $12)`,
    [pageWiki, `Wiki ${R}`, `Notes. The ${w.b} [[alpha]] result reproduced in 12 trials across two labs.`,
     pageMid, `Mid ${R}`, `Notes. The ${w.b} alpha result repro[^1]duced in 12 trials across two labs.`,
     pageSup, `Sup ${R}`, `Notes. The ${w.b} alpha<sup>1</sup> result reproduced in 12 trials across two labs.`,
     near, `Near ${R}`, `Notes. The ${w.b.slice(0, 4)} alpha result reproduced in 13 trials across one lab.`]);
  // a corroboration line of B's run (the research service writes them during the run)
  await sql(`INSERT INTO public.source_corroborations (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version, job_id)
             VALUES ($1, $2, 'strong', 0.5, $3, 'descriptive', 'supports', 'lab', $4)`,
    [s2, s1, `The ${w.b} alpha result reproduced in 12 trials across two labs.`, bIdea.job]);
  await sql(`CREATE TABLE IF NOT EXISTS public.lab_prc_plant (k TEXT PRIMARY KEY, v JSONB NOT NULL)`);
  await sql(`INSERT INTO public.lab_prc_plant (k, v) VALUES ('plant', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [JSON.stringify({ R, w, thread, s1, s2, syn, bIdea, aIdea, bReport, aReport, orphReport, b1, b2, b3, a1, multi, orph, ctl, mix, job, child, page, pageCite, pageBold, pageWiki, pageMid, pageSup, near, clean, p2syn, p2job,
      p2jobA, p2multi, synCtl, bh, hjob, hchild, b3text, bhText, human: await humanImage(hjob, hchild), p2synB, p2thread, dupB3,
      p2slug, nbSrc, hubPage, entity, thread3, supB2 })]);
  await landed(await plant());
});

// ── migrated only: a new filing the way the curator files it (before the reads, so they see it too) ──────────────────
t(["migrated"], "the curator's write: a new claim of B's report lands in B's store, linked, and nowhere shared", async () => {
  const p = await plant();
  const text = `The ${p.w.bnew} zeta result was observed after the migration ran.`;
  const r = await asRole<{ id: string; was_duplicate: boolean }>("ob_app_memory",
    `SELECT f.id::text AS id, f.was_duplicate FROM public.private_report_claim_file($1, $2::uuid, $3, $4::uuid, 'sourced', NULL, NULL, $5::vector, '{"claim_kind":"descriptive"}'::jsonb) f`,
    [`rk-prc-b-${p.R}`, p.bIdea.job, text, p.thread, VEC]);
  await asRole("ob_app_memory", `SELECT public.private_report_claim_edge($1::uuid, $2::uuid, 'states', 1.0)`, [r[0].id, p.s1]);
  const again = await asRole<{ id: string; was_duplicate: boolean }>("ob_app_memory",
    `SELECT f.id::text AS id, f.was_duplicate FROM public.private_report_claim_file($1, $2::uuid, $3, $4::uuid, 'sourced', NULL, NULL, NULL, '{}'::jsonb) f`,
    [`rk-prc-b-${p.R}`, p.bIdea.job, text, p.thread]);
  assertEquals([again[0].id, again[0].was_duplicate], [r[0].id, true], "a re-file dedups within B's own store");
  const where = (await sql<{ shared: number; priv: number; owner: string; linked: number; edges: number }>(
    `SELECT (SELECT count(*)::int FROM public.claims WHERE id = $1) AS shared,
            (SELECT count(*)::int FROM public.inlet_private_claims WHERE id = $1) AS priv,
            (SELECT inlet_owner_sub FROM public.inlet_private_claims WHERE id = $1) AS owner,
            (SELECT count(*)::int FROM public.research_private_report_claims WHERE claim_id = $1 AND report_id = $2) AS linked,
            (SELECT count(*)::int FROM public.inlet_private_claim_sources WHERE claim_id = $1 AND owner_sub = $3) AS edges`,
    [r[0].id, p.bReport, B]))[0];
  assertEquals([where.shared, where.priv, where.owner === B, where.linked, where.edges], [0, 1, true, 1, 1]);
  // a report with no owner who may read it files nothing; nor does a key + job naming no report
  await sql(`UPDATE public.research_private_reports SET job_id = $2 WHERE id = $1`, [p.orphReport, p.job]);
  assertEquals(await errCode(() => asRole("ob_app_memory", `SELECT * FROM public.private_report_claim_file($1, $2::uuid, 'a claim text for an ownerless report', NULL)`, [`rk-prc-o-${p.R}`, p.job])), "42501",
    "an ownerless report files nothing");
  await sql(`UPDATE public.research_private_reports SET job_id = NULL WHERE id = $1`, [p.orphReport]);
  assertEquals(await errCode(() => asRole("ob_app_memory", `SELECT * FROM public.private_report_claim_file('rk-none', gen_random_uuid(), 'a claim text', NULL)`)), "23503");
  // PostgREST's anon role (service_role, as PostgREST runs a request) and authenticated may not file
  for (const role of ["service_role", "authenticated"]) {
    assertEquals(await errCode(() => asPostgrest(role, `SELECT * FROM public.private_report_claim_file($1, $2::uuid, 'a claim text', NULL)`, [`rk-prc-b-${p.R}`, p.bIdea.job])), "42501", role);
  }
  // the services' REAL login files (the curator's connection)
  const real = await asApp<{ id: string }>(`SELECT f.id::text AS id FROM public.private_report_claim_file($1, $2::uuid, $3, NULL) f`,
    [`rk-prc-b-${p.R}`, p.bIdea.job, `The ${p.w.bnew} eta result, filed by the services' own login.`]);
  assertEquals(real.length, 1, "the ob_app_memory login files");
  await sql(`UPDATE public.lab_prc_plant SET v = v || jsonb_build_object('bnewId', $1::text) WHERE k = 'plant'`, [r[0].id]);
});

// ── the reads: one case per shared read path, every non-owner viewer ─────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
const READS: Array<[string, (p: Record<string, any>) => string]> = [
  ["contract/claims?q (the claim's word)", (p) => `/workbench/contract/claims?q=${p.w.b}&limit=200`],
  ["contract/claims?q (the withheld claims' words)", (p) => `/workbench/contract/claims?q=prcmulti${p.R}&limit=200`],
  ["contract/claims?thread_id", (p) => `/workbench/contract/claims?thread_id=${p.thread}&limit=200`],
  ["contract/claims?source_id", (p) => `/workbench/contract/claims?source_id=${p.s1}&limit=200`],
  ["contract/claims (all)", () => `/workbench/contract/claims?limit=200`],
  ["contract/search (claims, pages, sources)", (p) => `/workbench/contract/search?q=${p.w.b}&kinds=claim,page,source`],
  ["contract/search (the claim's sentence)", () => `/workbench/contract/search?q=${encodeURIComponent("alpha result reproduced")}&kinds=claim,page,source`],
  ["contract/neighbours (the page)", (p) => `/workbench/contract/neighbours?id=${encodeURIComponent(p.page)}&depth=2`],
  ["contract/timeline", () => `/workbench/contract/timeline?limit=200`],
  ["contract/timeline?source_id", (p) => `/workbench/contract/timeline?source_id=${p.s1}&limit=200`],
  ["contract/sources/{id}/quality", (p) => `/workbench/contract/sources/${p.s1}/quality`],
  ["contract/sources/{id}/dependence", (p) => `/workbench/contract/sources/${p.s1}/dependence`],
  ["contract/chunks/{id}/context", (p) => `/workbench/contract/chunks/${p.s1}:0/context`],
  ["contract/trail?source_id", (p) => `/workbench/contract/trail?source_id=${p.s1}`],
  ["contract/jobs", () => `/workbench/contract/jobs?limit=200`],
  ["contract/sessions/{shared job}", (p) => `/workbench/contract/sessions/${p.job}`],
  // round 2 (tester P1): the shared job's gap work
  ["contract/jobs?kind=research", () => `/workbench/contract/jobs?kind=research&limit=200`],
  ["contract/sessions/{the gap branch}", (p) => `/workbench/contract/sessions/${p.child}`],
  ["contract/sessions/{shared job}/coverage", (p) => `/workbench/contract/sessions/${p.job}/coverage`],
  ["contract/search kinds=page (the claim's word)", (p) => `/workbench/contract/search?q=${p.w.b}&kinds=page`],
  // fix item (P2): the shared outputs that restated a private-report claim (B's theta claim; the mixed claim's synthesis)
  ["contract/search (the restated claim's word: sources, claims, pages)", (p) => `/workbench/contract/search?q=${p.w.b3}&kinds=claim,page,source`],
  ["contract/search (the mixed claim's word)", (p) => `/workbench/contract/search?q=${p.w.mix}&kinds=claim,page,source`],
  ["contract/sessions/{A's shared job that restated B's claim}", (p) => `/workbench/contract/sessions/${p.p2jobA}`],
  ["contract/sessions/{B's shared job that restated B's claim}", (p) => `/workbench/contract/sessions/${p.p2job}`],
  ["contract/claims?q (the mixed claim's word)", (p) => `/workbench/contract/claims?q=${p.w.mix}&limit=200`],
  // already owner-only before slot 570 (rw-report-isolation / rw-p8a4-ideas): controls, green in both phases
  ["contract/ideas/{B's idea}", (p) => `/workbench/contract/ideas/${p.bIdea.id}`],
  ["contract/ideas", () => `/workbench/contract/ideas?limit=200`],
  ["contract/sessions/{B's idea job}", (p) => `/workbench/contract/sessions/${p.bIdea.job}`],
];
// what of B's (and of nobody's) a non-owner must never read: the words, the ids
// deno-lint-ignore no-explicit-any
// fix item (P2): the mixed claim and B's restated theta claim are B's too (their words and ids)
const secretsOf = (p: Record<string, any>) => [p.w.b, p.w.multi, p.w.orph, p.w.bnew, p.w.b3, p.w.mix, p.b1, p.b2, p.b3, p.mix, p.multi, p.orph, p.bnewId].filter(Boolean) as string[];
for (const [name, path] of READS) {
  t(BOTH, `[leak] ${name}: no non-owner reads B's private-report claims (text, id, nested fields)`, async () => {
    const p = await plant();
    const secrets = secretsOf(p);
    const hits: string[] = [];
    for (const v of VIEWERS_NOT_B) {
      const r = await get(v, path(p));
      // a search echoes its own query: judge the results only
      const body = path(p).includes("/search?") ? JSON.stringify((r.json as { results?: unknown }).results ?? []) : r.text;
      for (const s of secrets) if (body.includes(s)) hits.push(`${v.name} -> ${r.status} carries a ${[p.b1, p.b2, p.b3, p.mix, p.multi, p.orph, p.bnewId].includes(s) ? "claim id" : "claim word"}`);
    }
    assertEquals(hits, [], `${name}`);
  });
}
t(BOTH, "[leak] contract/claims?thread_id: the count is the shared claims' only (the control; the mixed claim is B's since the fix item)", async () => {
  const p = await plant();
  for (const v of VIEWERS_NOT_B) {
    const r = await get(v, `/workbench/contract/claims?thread_id=${p.thread}&limit=200`);
    assertEquals(r.status, 200, `${v.name}: ${r.text.slice(0, 200)}`);
    const ids = ((r.json.claims ?? []) as { id: string }[]).map((c) => c.id).sort();
    assertEquals([r.json.count, ids], [1, [p.ctl]], `${v.name}: the thread's claims and count`);
  }
});

// ── controls and the owner ─────────────────────────────────────────────────────────────────────────────────────
t(BOTH, "[control] a shared claim (its own shared synthesis) still answers every viewer, B included; its synthesis stays shared", async () => {
  const p = await plant();
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.sources WHERE id = $1`, [p.synCtl]))[0].n, 1, "the control synthesis stays");
  for (const v of [...VIEWERS_NOT_B, ...B_VIEWERS]) {
    for (const [word, id] of [[p.w.ctl, p.ctl]]) {
      const r = await get(v, `/workbench/contract/claims?q=${word}`);
      assert(((r.json.claims ?? []) as { id: string }[]).some((c) => c.id === id), `${v.name}: the shared claim ctl is listed (${r.status})`);
      const s = await get(v, `/workbench/contract/search?q=${word}&kinds=claim`);
      assert(((s.json.results ?? []) as { id: string }[]).some((h) => h.id === id), `${v.name}: search finds the shared claim`);
    }
  }
  const page = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.wiki_pages WHERE slug = $1`, [p.clean]);
  assertEquals(page[0].n, 1, "the clean page is untouched");
});
t(BOTH, "[owner] B reads the claims drawn from B's report in B's idea dossier (header and signed in); A and the admin read none of B's idea", async () => {
  const p = await plant();
  for (const v of B_VIEWERS) {
    const r = await get(v, `/workbench/contract/ideas/${p.bIdea.id}`);
    assertEquals(r.status, 200, `${v.name}: ${r.text.slice(0, 200)}`);
    const ids = (((r.json.produced as { claims?: { id: string }[] })?.claims) ?? []).map((c) => c.id);
    for (const id of [p.b1, p.b2]) assert(ids.includes(id), `${v.name}: the dossier lists B's claim`);
    if (PHASE === "migrated") {
      assert(ids.includes(p.bnewId), `${v.name}: the dossier lists the claim filed after the migration`);
      assert(!ids.includes(p.multi) && !ids.includes(p.orph), `${v.name}: a withheld claim (two owners / no owner) is nobody's`);
      assert(!ids.includes(p.a1), `${v.name}: A's claim is not in B's dossier`);
    }
  }
});

// ── the database surfaces ──────────────────────────────────────────────────────────────────────────────────────
t(BOTH, "[db] no shared table row carries B's claims: claims, claim_sources, the semantic recall (the research service's shape)", async () => {
  const p = await plant();
  const ids = [p.b1, p.b2, p.b3, p.multi, p.orph];
  const n = (await sql<{ c: number; e: number; t: number }>(
    `SELECT (SELECT count(*)::int FROM public.claims WHERE id = ANY($1::uuid[])) AS c,
            (SELECT count(*)::int FROM public.claim_sources WHERE claim_id = ANY($1::uuid[]) OR parent_claim_id = ANY($1::uuid[])) AS e,
            (SELECT count(*)::int FROM public.claims WHERE text LIKE '%' || $2 || '%') AS t`, [ids, p.w.b]))[0];
  assertEquals([n.c, n.e, n.t], [0, 0, 0], "shared claims / edges / text");
  // integrations/research-service/kb.ts's semantic recall, as the services' role
  const near = await asRole<{ id: string }>("ob_app_memory",
    `SELECT c.id::text AS id FROM public.claims c WHERE c.status = 'active' AND c.embedding IS NOT NULL ORDER BY c.embedding <=> $1::vector LIMIT 100`, [VEC]);
  assertEquals(near.filter((r) => ids.includes(r.id)).length, 0, "the semantic recall serves none of them");
  assert(near.some((r) => r.id === p.ctl), "the semantic recall still serves the shared control");
});
t(BOTH, "[db] the shared job that reused B's claim no longer names it (result and count); the control stays", async () => {
  const p = await plant();
  const j = (await sql<{ result: { reuse_claims: { id: string }[] }; metrics: { claims_reused: number } }>(`SELECT result, metrics FROM public.research_jobs WHERE id = $1`, [p.job]))[0];
  assertEquals(j.result.reuse_claims.map((c) => c.id), [p.ctl]);
  assertEquals(j.metrics.claims_reused, 1);
});
t(BOTH, "[db] the shared claim that B's claim contradicted is no longer capped or flagged by it", async () => {
  const p = await plant();
  const c = (await sql<{ contradicted: boolean }>(`SELECT contradicted FROM public.claims WHERE id = $1`, [p.ctl]))[0];
  assertEquals(c.contradicted, false);
});
t(BOTH, "[db] the wiki page carrying B's claim's text is withheld, and stays out (a rewrite is withheld, a note refused); a clean page goes in", async () => {
  const p = await plant();
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.wiki_pages WHERE slug = $1`, [p.page]))[0].n, 0, "the page is gone");
  // round 2 (tester P3): the variants - a citation marker before the full stop, emphasis and a whitespace run inside
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.wiki_pages WHERE slug = ANY($1::text[])`, [[p.pageCite, p.pageBold]]))[0].n, 0,
    "the citation-marker and emphasis variants are gone");
  // final round (tester attempt 2): the skeleton match - the pre-570 wikilink / mid-word footnote / <sup> pages are gone,
  // the near miss (13 trials, one lab) stays
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.wiki_pages WHERE slug = ANY($1::text[])`, [[p.pageWiki, p.pageMid, p.pageSup]]))[0].n, 0,
    "the wikilink, mid-word footnote and <sup> pages are gone");
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.wiki_pages WHERE slug = $1`, [p.near]))[0].n, 1, "the near-miss page stays (no false positive)");
  const W = p.w.b;
  const forms: Array<[string, string]> = [
    ["midword-footnote", `The ${W} alpha result repro[^1]duced in 12 trials across two labs.`],
    ["wikilink", `The ${W} [[alpha]] result reproduced in 12 trials across two labs.`],
    ["sup", `The ${W} alpha<sup>1</sup> result reproduced in 12 trials across two labs.`],
    ["nbsp", `The ${W} alpha\u00a0result reproduced in 12 trials across two labs.`],
    ["nbsp-entity", `The ${W} alpha&nbsp;result reproduced in 12 trials across two labs.`],
    ["named-footnote", `The ${W} alpha result reproduced in 12[^note-a] trials across two labs.`],
    ["hyphen-wrap", `The ${W} alpha result repro-\nduced in 12 trials across two labs.`],
    ["wikilink-label", `The ${W} [[Alpha (topic)|alpha]] result reproduced in 12 trials across two labs.`],
    ["numeric-entity", `The ${W} alph&#97; result reproduced in 12 trials across two labs.`],
    ["ref-tag", `The ${W} <em>alpha</em> result<ref>Smith 2020</ref> reproduced in 12 trials across two labs.`],
    ["zero-width-curly", `The ${W} \u201calpha\u201d\u200b result reproduced in 12 trials across two labs.`],
    ["caps-accents", `THE ${W.toUpperCase()} \u00c1LPHA RESULT REPRODUCED IN 12 TRIALS ACROSS TWO LABS`],
    // attempt 3: a citation number mid-sentence, a full-width number (the skeleton is letters only)
    ["pandoc-sup", `The ${W} alpha result^1^ reproduced in 12 trials across two labs.`],
    ["paren-number", `The ${W} alpha result (1) reproduced in 12 trials across two labs.`],
    ["footnote-n", `The ${W} alpha result[^n] reproduced in 12 trials across two labs.`],
    ["full-width-digits", `The ${W} alpha result reproduced in １２ trials across two labs.`],
  ];
  const leaked: string[] = [];
  for (const [name, body] of forms) {
    const n = await probe<{ n: number }>(null,
      `WITH w AS (INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'entity', 'form', $2) RETURNING 1) SELECT count(*)::int AS n FROM w`,
      [`content/topic/prc-form-${name}-${p.R}`, `Later. ${body} Then more.`]);
    if (n[0].n !== 0) leaked.push(name);
  }
  assertEquals(leaked, [], "every formatting form of B's sentence is withheld on a new write");
  const nearW = await probe<{ n: number }>(null,
    `WITH w AS (INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'entity', 'near', $2) RETURNING 1) SELECT count(*)::int AS n FROM w`,
    [`content/topic/prc-near2-${p.R}`, `The ${W} alpha result reproduced in 12 trials across one lab.`]);
  assertEquals(nearW[0].n, 1, "a near miss is written (no false positive)");
  for (const [slug, variant] of [
    [`content/topic/prc-cite3-${p.R}`, `Later. The ${p.w.b} alpha result reproduced in 12 trials across two labs [3].`],
    [`content/topic/prc-em-${p.R}`, `Later. THE ${p.w.b} alpha result reproduced in 12 trials across _two labs_ [^1], it says.`],
    [`content/topic/prc-link-${p.R}`, `Later. The ${p.w.b} alpha result [reproduced](https://example.org/x) in 12 trials across two labs.`],
  ]) {
    const n = await probe<{ n: number }>(null,
      `WITH w AS (INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'entity', 'variant', $2) RETURNING 1) SELECT count(*)::int AS n FROM w`, [slug, variant]);
    assertEquals(n[0].n, 0, `a new write of a variant is withheld (${slug.split("/").pop()!.replace(/-.*/, "")})`);
  }
  const body = `Rewritten. The ${p.w.b} alpha result reproduced in 12 trials across two labs.`;
  // each probe in a rolled-back transaction (the viewer's reconcile / a compile writing the page back)
  const back = await probe<{ n: number }>(null,
    `WITH w AS (INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'entity', 'again', $2)
                ON CONFLICT (slug) DO UPDATE SET body = EXCLUDED.body RETURNING 1) SELECT count(*)::int AS n FROM w`, [p.page, body]);
  assertEquals(back[0].n, 0, "the rewrite is withheld");
  // fix item round 2 (A1): a NOTE is a person's text - with no author named it matches nothing (the [fix2] note case)
  const noteN = await probe<{ n: number }>(null,
    `WITH w AS (INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'note', 'n', $2) RETURNING 1) SELECT count(*)::int AS n FROM w`, [`notes/prc-${p.R}`, body]);
  assertEquals(noteN[0].n, 1, "a note with no author named is saved");
  const clean = await probe<{ n: number }>(null,
    `WITH w AS (INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'entity', 'clean', 'still nothing private') RETURNING 1) SELECT count(*)::int AS n FROM w`,
    [`content/topic/prc-clean2-${p.R}`]);
  assertEquals(clean[0].n, 1, "a clean page goes in");
});
t(BOTH, "[db] B's run's corroboration line no longer carries the claim's text; its amount and pair stay", async () => {
  const p = await plant();
  const r = await sql<{ t: string; amount: number }>(`SELECT claim_text AS t, amount FROM public.source_corroborations WHERE from_source_id = $1 AND to_source_id = $2`, [p.s2, p.s1]);
  assertEquals(r.length, 1);
  assert(r[0].t.startsWith("private-text:") && !r[0].t.includes(p.w.b), "the line is neutral");
  assertEquals(Number(r[0].amount), 0.5, "the amount (numeric arrives as a string)");
});
t(BOTH, "[db] the owner stores and the owner read: closed to every app role, owner-checked for the services' role", async () => {
  const p = await plant();
  for (const role of ["ob_app_memory", "service_role", "authenticated"]) {
    assertEquals(await errCode(() => asRole(role, `SELECT count(*) FROM public.inlet_private_claims`)), "42501", `${role} reads the store`);
    assertEquals(await errCode(() => asRole(role, `SELECT count(*) FROM public.private_report_claims_archive`)), "42501", `${role} reads the archive`);
  }
  // round 2 (tester F2): the services' REAL login (created after the chain ran), as the workbench connects
  const of = async (sub: string) => (await asApp<{ id: string }>(`SELECT id::text AS id FROM public.private_report_claims_of_idea($1::uuid, $2)`, [p.bIdea.id, sub])).map((r) => r.id).sort();
  const mine = await of(B);
  for (const id of [p.b1, p.b2, p.b3]) assert(mine.includes(id), "B's own, read by the ob_app_memory login");
  for (const s of [A, C, "", "service:openbrain-mcp", "anonymous:", "operator"]) assertEquals(await of(s), [], `subject ${s || "(blank)"}`);
  assertEquals(await errCode(() => asPostgrest("service_role", `SELECT * FROM public.private_report_claims_of_idea($1::uuid, $2)`, [p.bIdea.id, B])), "42501", "PostgREST's anon role");
  // the withheld ones are in no store
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.inlet_private_claims WHERE id = ANY($1::uuid[])`, [[p.multi, p.orph]]))[0].n, 0);
});
t(BOTH, "[db] no service can link a shared claim to a private report (the services' REAL login, and PostgREST's anon role)", async () => {
  const p = await plant();
  // round 2 (tester F5): the services' own login (session_user ob_app_memory, not a superuser session under SET ROLE);
  // it holds INSERT on the link (slot 390 grants service_role ALL), so only the guard stands in the way
  assertEquals(await errCode(() => asApp(`INSERT INTO public.research_private_report_claims (report_id, claim_id) VALUES ($1, $2)`, [p.bReport, p.ctl])), "23514", "ob_app_memory login");
  assertEquals(await errCode(() => asPostgrest("service_role", `INSERT INTO public.research_private_report_claims (report_id, claim_id) VALUES ($1, $2)`, [p.bReport, p.ctl])), "23514", "service_role (PostgREST)");
});

// ── round 2 (tester P1): the gap work of a shared tree ───────────────────────────────────────────────────────────
t(BOTH, "[db] the shared tree's gap work no longer carries B's claim's text (the branch's question, its steer, the gap event, the tree report)", async () => {
  const p = await plant();
  const r = (await sql<{ q: string; s: string; e: string; tr: string; ref: string }>(
    `SELECT (SELECT query FROM public.research_jobs WHERE id = $2) AS q,
            (SELECT text || ' ' || coalesce(gap::text, '') FROM public.research_steers WHERE child_job_id = $2) AS s,
            (SELECT string_agg(payload::text, ' ') FROM public.research_job_events WHERE job_id = $1 AND type = 'gap') AS e,
            (SELECT coalesce(tree_report::text, '') FROM public.research_jobs WHERE id = $1) AS tr,
            (SELECT gap_ref FROM public.research_jobs WHERE id = $2) AS ref`, [p.job, p.child]))[0];
  const carries = Object.entries({ branch: r.q, steer: r.s, event: r.e, tree_report: r.tr }).filter(([, v]) => (v ?? "").includes(p.w.b)).map(([k]) => k);
  assertEquals(carries, [], "rows still carrying the claim's word");
  assertEquals(r.ref, `claim:${p.b1}`, "the branch keeps its gap_ref (ids only), so the tree's per-gap dedup still holds");
});
t(BOTH, "[db] a NEW gap branch / steer / gap event for B's claim on a shared tree carries no text (the services' REAL login)", async () => {
  const p = await plant();
  const text = `The ${p.w.b} alpha result reproduced in 12 trials across two labs.`;
  const gap = JSON.stringify({ claim_id: p.b2, text, score: 0.1, threshold: 0.5, claim_kind: "descriptive" });
  const c = await appPool!.connect();
  try {
    await c.queryObject("BEGIN");
    const j = (await c.queryObject<{ id: string }>(`INSERT INTO public.research_jobs (status, origin, query, parent_job_id, root_job_id, rooted_step_id, branch_kind, anchor, gap_ref)
        VALUES ('queued', 'manual', $1, $2, $2, 'reuse', 'gap', 'a shared question', $3) RETURNING id::text AS id`, [`Verify: ${text}`, p.job, `claim:${p.b2}`])).rows;
    assertEquals(j.length, 0, "no gap branch is opened for a private claim on a shared tree");
    await c.queryObject(`INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, payload) VALUES ($1, $1, 'gap', 'steering', $2::jsonb)`, [p.job, gap]);
    const ev = (await c.queryObject<{ t: string }>(`SELECT payload::text AS t FROM public.research_job_events WHERE job_id = $1 AND type = 'gap' AND payload ->> 'claim_id' = $2`, [p.job, p.b2])).rows;
    assertEquals(ev.length, 1);
    assert(!ev[0].t.includes(p.w.b), "the gap event's text is neutral");
    // final round (tester attempt 2 F2): every steering kind, UPDATEs, a braced id, an inter-hub branch
    const hub = JSON.stringify({ a: { label: p.b2, members: [p.b2], sample: text }, b: { label: p.ctl, members: [p.ctl], sample: "a shared sample" }, density: 0.1, links: 1 });
    await c.queryObject(`INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, payload) VALUES ($1, $1, 'interhub_gap', 'steering', $2::jsonb)`, [p.job, hub]);
    const kinds = (await c.queryObject<{ t: string }>(`SELECT string_agg(payload::text, ' ') AS t FROM public.research_job_events WHERE job_id = $1 AND type = 'interhub_gap'`, [p.job])).rows;
    assert(!(kinds[0].t ?? "").includes(p.w.b), "an inter-hub event naming the claim carries no text");
    const ih = (await c.queryObject<{ id: string }>(`INSERT INTO public.research_jobs (status, origin, query, parent_job_id, root_job_id, rooted_step_id, branch_kind, anchor, gap_ref)
        VALUES ('queued', 'manual', $1, $2, $2, 'reuse', 'interhub', 'a shared question', $3) RETURNING id::text AS id`,
      [`How does "${text}" relate to "a shared sample"?`, p.job, `interhub:{${p.b2}}|x`])).rows;
    assertEquals(ih.length, 0, "no inter-hub branch is opened for a private claim on a shared tree (braced id)");
    await c.queryObject(`UPDATE public.research_jobs SET query = $2 WHERE id = $1`, [p.child, `Verify again: ${text}`]);
    await c.queryObject(`UPDATE public.research_steers SET text = $2 WHERE child_job_id = $1`, [p.child, `Steer: ${text}`]);
    const up = (await c.queryObject<{ t: string }>(
      `SELECT (SELECT query FROM public.research_jobs WHERE id = $1) || ' ' || (SELECT text FROM public.research_steers WHERE child_job_id = $1) AS t`, [p.child])).rows;
    assert(!up[0].t.includes(p.w.b), "an UPDATE of a machine gap branch's question or its steer carries no text");
    // (fix item F2: a root's tree report / topic estimate and a topic event name no claim id - a text there is a
    //  person's or a summary of one, and is never matched; see the [fix] F2 cases)
  } finally {
    try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
    c.release();
  }
});
// fix item (A1, operator 2026-11-22; the PD0b slot 580 integration before it): a DERIVED (shared) question carrying the
// REQUESTER's OWN private-report claim is refused (23514); another user's claim is never matched, so the requester's
// answer is the same whether or not that user holds a claim with the text. The requester is the hand-back's owner: the
// boundary writes the job, then the hand-back naming it (handback_open), in one transaction - as here (a superuser
// session: slot 420 grants handback_open to ob_app_memory only when the role exists at 420's run, which a lab's
// late-created role is not; the guard is a trigger and runs for every role), each start rolled back. Two identities (A
// and B) and a control text nobody holds; the HTTP door's two-identity case is start.e2e.test.ts S9.
t(BOTH, "[fix] A1 two identities: A's derived question with B's claim text gets the same answer as with a text nobody holds; A's own claim, and B's own, are refused", async () => {
  const p = await plant();
  const stamp = JSON.stringify({ version: "lab-1", lexicon: "a".repeat(64), verdict_id: "a".repeat(64) });
  const start = async (owner: string, q: string): Promise<{ out: string; ms: number }> => {
    const c = await pool!.connect();
    const t0 = performance.now();
    try {
      await c.queryObject("BEGIN");
      const j = (await c.queryObject<{ id: string }>(`INSERT INTO public.research_jobs (status, origin, caller, query, anchor, options, request_kind, boundary)
          VALUES ('queued', 'manual', 'boundary', $1, $1, '{}'::jsonb, 'derived', $2::jsonb) RETURNING id::text AS id`, [q, stamp])).rows[0].id;
      await c.queryObject(`SELECT public.handback_open($1, 'chat', $2, NULL, 'user-start', $3::uuid, 'queued', '{}'::jsonb, NULL, '{}'::jsonb)`,
        [owner, `start:prc-a1-${crypto.randomUUID()}`, j]);
      return { out: "started", ms: performance.now() - t0 };
    } catch (e) {
      return { out: (e as { fields?: { code?: string } }).fields?.code ?? `error ${(e as Error).name}`, ms: performance.now() - t0 };
    } finally {
      try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
      c.release();
    }
  };
  const bText = `What is known about how the ${p.w.b} beta result held for 40 participants over six months?`;    // B's claim b2
  const ctrl = `What is known about how the ${p.w.b}x beta result held for 40 participants over six weeks?`;  // nobody's
  const aText = `What is known about how the ${p.w.a} gamma result was confirmed by a second team in 2025?`;   // A's own a1
  const runs: Record<string, { out: string; ms: number }[]> = { bText: [], ctrl: [] };
  for (let i = 0; i < 3; i++) { runs.bText.push(await start(A, bText)); runs.ctrl.push(await start(A, ctrl)); }
  const outs = (k: string) => [...new Set(runs[k].map((r) => r.out))];
  assertEquals([outs("bText"), outs("ctrl")], [["started"], ["started"]], "A's start: B's claim text and the control get the same answer");
  // the timing class: both well under a second, the medians within 3x (+20 ms) of each other
  const med = (k: string) => runs[k].map((r) => r.ms).sort((x, y) => x - y)[1];
  console.log(`A1 timing (median ms): B's text ${med("bText").toFixed(1)}, control ${med("ctrl").toFixed(1)}`);
  assert(med("bText") < 1000 && med("ctrl") < 1000, "both under a second");
  assert(med("bText") < 3 * med("ctrl") + 20 && med("ctrl") < 3 * med("bText") + 20, "one timing class");
  assertEquals((await start(A, aText)).out, "23514", "A's own private claim in A's shared question is refused");
  assertEquals((await start(B, bText)).out, "23514", "B's own private claim in B's shared question is refused");
  // a derived job that no hand-back names has no requester: it matches nothing
  assertEquals((await asApp<{ id: string }>(`INSERT INTO public.research_jobs (status, origin, caller, query, anchor, options, request_kind, boundary)
      VALUES ('queued', 'manual', 'boundary', $1, $1, '{}'::jsonb, 'derived', $2::jsonb) RETURNING id::text AS id`, [ctrl, stamp])).length, 1,
    "a clean derived question is written");
});

// fix item (F2): a human steer on a shared tree is never rewritten - at the migration (the planted one, byte for byte)
// and on a new write (as typed, whether its text is B's claim or a text nobody holds); machine gap work still is
t(BOTH, "[fix] F2 the human steer planted before 570 (its text, its branch's question, its event) is byte-identical after it", async () => {
  const p = await plant();
  assertEquals(await humanImage(p.hjob, p.hchild), p.human, "the human steer's rows as the person wrote them");
});
t(BOTH, "[fix] F2 a NEW human steer / its branch / its event on a shared tree is stored as typed, with or without B's matching claim; machine gap work is still neutral", async () => {
  const p = await plant();
  const c = await appPool!.connect();
  const store = async (text: string) => {
    const ch = (await c.queryObject<{ id: string }>(`INSERT INTO public.research_jobs (status, origin, query, parent_job_id, root_job_id, rooted_step_id, branch_kind, anchor)
        VALUES ('queued', 'manual', $1, $2, $2, 'synth', 'steer', 'a human-steered shared question') RETURNING id::text AS id`, [text, p.hjob])).rows;
    assertEquals(ch.length, 1, "the human's branch is opened");
    await c.queryObject(`INSERT INTO public.research_steers (root_job_id, parent_job_id, child_job_id, steer_kind, step_id, text, topic_estimate, anchor, actor_sub)
        VALUES ($1, $1, $2, 'human', 'synth', $3, $3, 'a human-steered shared question', $4)`, [p.hjob, ch[0].id, text, A]);
    await c.queryObject(`INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, payload) VALUES ($1, $1, 'human_steer', 'steering', $2::jsonb)`,
      [p.hjob, JSON.stringify({ child_job_id: ch[0].id, step_id: "synth", text, topic_estimate: text, anchor: "a" })]);
    await c.queryObject(`INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, payload) VALUES ($1, $1, 'topic', 'steering', $2::jsonb)`,
      [p.hjob, JSON.stringify({ from: "a steered topic", to: text, at_branch: ch[0].id })]);
    await c.queryObject(`UPDATE public.research_jobs SET topic_estimate = $2, tree_report = $3::jsonb WHERE id = $1`, [p.hjob, text, JSON.stringify({ markdown: `# t\n${text}` })]);
    const r = (await c.queryObject<{ q: string; s: string; e: string; tp: string; te: string; tr: string }>(
      `SELECT (SELECT query FROM public.research_jobs WHERE id::text = $1) AS q,
              (SELECT text || '|' || topic_estimate FROM public.research_steers WHERE child_job_id::text = $1) AS s,
              (SELECT payload ->> 'text' FROM public.research_job_events WHERE type = 'human_steer' AND payload ->> 'child_job_id' = $1) AS e,
              (SELECT payload ->> 'to' FROM public.research_job_events WHERE type = 'topic' AND payload ->> 'at_branch' = $1) AS tp,
              (SELECT topic_estimate FROM public.research_jobs WHERE id = $2::uuid) AS te,
              (SELECT tree_report ->> 'markdown' FROM public.research_jobs WHERE id = $2::uuid) AS tr`, [ch[0].id, p.hjob])).rows[0];
    return [r.q === text, r.s === `${text}|${text}`, r.e === text, r.tp === text, r.te === text, r.tr === `# t\n${text}`];
  };
  try {
    await c.queryObject("BEGIN");
    const withB = await store(`Check again: ${p.bhText}`);                                     // B's private claim bh
    const ctrl = await store(`Check again: The ${p.w.bh}x kappa result was typed into a steer by a person.`); // nobody's
    assertEquals(withB, [true, true, true, true, true, true], "B's claim text typed by a person is stored as typed (branch, steer, event, topic, root)");
    assertEquals(withB, ctrl, "the same as a text nobody holds");
    // machine gap work naming B's claim (by its id) is still neutral and a new gap branch for it is still not opened
    const gap = JSON.stringify({ claim_id: p.bh, text: p.bhText, score: 0.1, threshold: 0.5, claim_kind: "descriptive" });
    await c.queryObject(`INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, payload) VALUES ($1, $1, 'gap', 'steering', $2::jsonb)`, [p.hjob, gap]);
    const ev = (await c.queryObject<{ t: string }>(`SELECT payload ->> 'text' AS t FROM public.research_job_events WHERE job_id = $1 AND type = 'gap' AND payload ->> 'claim_id' = $2`, [p.hjob, p.bh])).rows;
    assertEquals(ev.map((x) => x.t), ["(a private claim)"], "a machine gap event naming the claim is neutral");
    const g = (await c.queryObject<{ id: string }>(`INSERT INTO public.research_jobs (status, origin, query, parent_job_id, root_job_id, rooted_step_id, branch_kind, anchor, gap_ref)
        VALUES ('queued', 'manual', $1, $2, $2, 'reuse', 'gap', 'a', $3) RETURNING id::text AS id`, [`Verify: ${p.bhText}`, p.hjob, `claim:${p.bh}`])).rows;
    assertEquals(g.length, 0, "no machine gap branch is opened for it");
  } finally {
    try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
    c.release();
  }
});

// fix item (P2, operator 2026-11-22): the SHARED outputs that restated a private-report claim
t(BOTH, "[db] [fix] P2 a shared synthesis restating B's claim, and the one that filed B's mixed claim, are B's alone; one restating B's and A's is withheld; the control stays", async () => {
  const p = await plant();
  const inSources = async (id: string) => (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.sources WHERE id = $1`, [id]))[0].n;
  const copy = async (key: string) => await sql<{ owner_sub: string | null; content: string; idea_id: string | null }>(
    `SELECT owner_sub, content, idea_id::text AS idea_id FROM public.research_private_reports WHERE research_key = $1`, [key]);
  assertEquals([await inSources(p.p2syn), await inSources(p.syn), await inSources(p.p2multi), await inSources(p.synCtl)], [0, 0, 0, 1],
    "the restating, the mixed-filing and the two-owner syntheses left the shared table; the control stays");
  const own = await copy(`prc570-syn:${p.p2syn}`);
  assertEquals(own.map((r) => r.owner_sub === B), [true], "the restating synthesis is in B's private store");
  assert(own[0].content.includes(p.w.b3), "with its text (B reads it)");
  assertEquals((await copy(`prc570-syn:${p.syn}`)).map((r) => r.owner_sub === B), [true], "the synthesis that filed B's mixed claim is B's");
  assertEquals((await copy(`prc570-syn:${p.p2multi}`)).length, 0, "the two-owner synthesis is nobody's (archived only)");
  // the mixed claim follows the same rule: in B's store, not shared
  const mix = (await sql<{ shared: number; owner: string | null }>(
    `SELECT (SELECT count(*)::int FROM public.claims WHERE id = $1) AS shared, (SELECT inlet_owner_sub FROM public.inlet_private_claims WHERE id = $1) AS owner`, [p.mix]))[0];
  assertEquals([mix.shared, mix.owner === B], [0, true], "the mixed claim moved to B");
  // nothing shared still carries the restated sentences (the skeleton match, as 570's)
  const left = (await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.sources s WHERE s.content_type = 'research_synthesis' AND (s.content LIKE '%' || $1 || '%' OR s.content LIKE '%' || $2 || '%')`,
    [p.w.b3, p.w.a]))[0].n;
  assertEquals(left, 0, "no shared synthesis carries B's theta or A's gamma sentence");
});
t(BOTH, "[db] [fix] P2 shared job reports restating B's claim: B's own question's report is B's alone; A's question's and an ownerless one's are withheld; the jobs keep no report text", async () => {
  const p = await plant();
  const jobs = await sql<{ id: string; t: string }>(`SELECT id::text AS id, result::text AS t FROM public.research_jobs WHERE id = ANY($1::uuid[]) ORDER BY id`, [[p.p2job, p.p2jobA, p.job]]);
  assertEquals(jobs.length, 3);
  for (const j of jobs) {
    assert(!j.t.includes(p.w.b3) && !j.t.includes(p.w.b), `job ${j.id === p.p2job ? "p2job" : j.id === p.p2jobA ? "p2jobA" : "job"}: no private sentence in its result`);
    assertEquals(JSON.parse(j.t).synthesis, "", "its synthesis is empty");
  }
  const copies = await sql<{ research_key: string; owner_sub: string | null; content: string }>(
    `SELECT research_key, owner_sub, content FROM public.research_private_reports WHERE research_key = ANY($1::text[])`,
    [[`prc570-job:${p.p2job}`, `prc570-job:${p.p2jobA}`, `prc570-job:${p.job}`]]);
  assertEquals(copies.map((c) => [c.research_key === `prc570-job:${p.p2job}`, c.owner_sub === B]), [[true, true]],
    "only B's own question's report is copied, to B (A's prompt / an ownerless job's would leave with it)");
  assert(copies[0].content.includes(p.w.b3), "B reads its text");
});
// fix item round 2 (tester attempt 1, A1): a person's NOTE is refused only for its AUTHOR's own private-report claim -
// the workbench's note write names the author for its one statement (ob.page_author). Another user's claim never
// changes whether a note is saved (and so whether search finds it): no existence oracle through note + search.
t(BOTH, "[fix2] A1 a note by A carrying B's claim is saved exactly like one carrying a text nobody holds; A's own claim in A's note, and B's in B's, are refused", async () => {
  const p = await plant();
  const note = async (author: string, text: string) => {
    try {
      const r = await probe<{ n: number }>(null,
        `WITH who AS (SELECT set_config('ob.page_author', $3, true) AS a),
              w AS (INSERT INTO public.wiki_pages (slug, page_class, title, body) SELECT $1, 'note', 'my note', $2 FROM who RETURNING 1)
         SELECT count(*)::int AS n FROM w`, [`notes/prc-a1-${crypto.randomUUID()}.md`, `Some notes. ${text} More notes.`, author]);
      return r[0].n === 1 ? "saved" : "dropped";
    } catch (e) {
      return (e as { fields?: { code?: string } }).fields?.code ?? "error";
    }
  };
  const bText = `The ${p.w.b} beta result held for 40 participants over six months.`;
  const ctrl = `The ${p.w.b}x beta result held for 40 participants over six weeks.`;
  const out = {
    aWithB: await note(A, bText), aWithBUpper: await note(A, bText.toUpperCase()), aCtrl: await note(A, ctrl),
    aOwn: await note(A, `The ${p.w.a} gamma result was confirmed by a second team in 2025.`), bOwn: await note(B, bText),
  };
  assertEquals(out, { aWithB: "saved", aWithBUpper: "saved", aCtrl: "saved", aOwn: "42501", bOwn: "42501" });
  // a machine-written page (a compile) carrying B's claim is still withheld: no person chose that text
  const page = await probe<{ n: number }>(null,
    `WITH w AS (INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'entity', 'compiled', $2) RETURNING 1) SELECT count(*)::int AS n FROM w`,
    [`content/topic/prc-a1-${p.R}`, `Compiled. ${bText}`]);
  assertEquals(page[0].n, 0, "a compiled page carrying B's claim is withheld");
});

// fix item round 2 (tester attempt 1, P2): what a moved synthesis left on other shared surfaces
t(BOTH, "[db] [fix2] P2 the thread minted from the restating synthesis no longer carries B's sentence; the shared claim it filed into that thread moved to B", async () => {
  const p = await plant();
  const th = (await sql<{ name: string; description: string | null; emb: boolean }>(
    `SELECT name, description, embedding IS NOT NULL AS emb FROM public.threads WHERE id = $1`, [p.p2thread]))[0];
  assert(!`${th.name} ${th.description ?? ""}`.includes(p.w.b3), "the thread's name / description carry no private word");
  assertEquals(th.emb, false, "no embedding made from the old description");
  const left = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.threads WHERE coalesce(description, '') || ' ' || name LIKE '%' || $1 || '%'`, [p.w.b3]))[0].n;
  assertEquals(left, 0, "no thread carries B's theta sentence");
  const dup = (await sql<{ shared: number; owner: string | null; linked: number }>(
    `SELECT (SELECT count(*)::int FROM public.claims WHERE id = $1) AS shared,
            (SELECT inlet_owner_sub FROM public.inlet_private_claims WHERE id = $1) AS owner,
            (SELECT count(*)::int FROM public.research_private_report_claims WHERE claim_id = $1 AND report_id = $2) AS linked`, [p.dupB3, p.bReport]))[0];
  assertEquals([dup.shared, dup.owner === B, dup.linked], [0, true, 1], "the duplicate is B's (in B's store, linked to B's report), not shared");
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.claims WHERE text LIKE '%' || $1 || '%'`, [p.w.b3]))[0].n, 0,
    "no shared claim carries B's theta sentence");
});
t(BOTH, "[db] [fix2] P2 a synthesis copy keeps its title / question only when the question was B's own; A's typed question never reaches B", async () => {
  const p = await plant();
  const copy = async (id: string) => (await sql<{ title: string; research_query: string | null; m: string }>(
    `SELECT title, research_query, metadata::text AS m FROM public.research_private_reports WHERE research_key = $1 AND owner_sub = $2`, [`prc570-syn:${id}`, B]))[0];
  const a = await copy(p.p2syn);
  assert(a, "the restating synthesis is copied to B");
  assert(!a.title.includes(`${p.w.a}q`) && !(a.research_query ?? "").includes(`${p.w.a}q`) && !a.m.includes(`${p.w.a}q`), "A's typed question is not in B's copy");
  const b = await copy(p.p2synB);
  assert(b, "the synthesis of B's own question is copied to B");
  assertEquals([b.title, b.research_query], [`B question title ${p.R}`, "another shared question"], "B's own question stays on B's copy");
});
// fix item round 3 (tester attempt 2): the thread's slug and notebook labels; the curator answers naming it; its hub
// page; the entities the synthesis named (sibling sweep); a claim left by a superseded synthesis
t(BOTH, "[db] [fix3] P2 the minted thread's slug and hub page, the shared sources' notebook labels and a curator answer naming it carry no private sentence; the synthesis's entity is bumped", async () => {
  const p = await plant();
  const th = (await sql<{ name: string; slug: string | null }>(`SELECT name, slug FROM public.threads WHERE id = $1`, [p.p2thread]))[0];
  assert(!`${th.name} ${th.slug ?? ""}`.includes(p.w.b3), "the thread's name and slug carry no private word");
  assertEquals(th.slug, `research-thread-${p.p2thread.slice(0, 8)}`, "re-slugged");
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.threads WHERE coalesce(slug, '') LIKE '%' || $1 || '%'`, [p.w.b3]))[0].n, 0, "no slug carries it");
  const nb = (await sql<{ notebook: string | null }>(`SELECT notebook FROM public.sources WHERE id = $1`, [p.nbSrc]))[0];
  assertEquals(nb.notebook, th.name, "the filed source's notebook label is the thread's new name");
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.sources WHERE coalesce(notebook, '') LIKE '%' || $1 || '%'`, [p.w.b3]))[0].n, 0, "no notebook label carries it");
  const cur = (await sql<{ t: string }>(`SELECT (result -> 'curator')::text AS t FROM public.research_jobs WHERE id = $1`, [p.aIdea.job]))[0];
  assert(!cur.t.includes(p.w.b3) && cur.t.includes(th.name), "A's job's curator answer names the thread by its new name");
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.wiki_pages WHERE slug = $1`, [p.hubPage]))[0].n, 0, "the hub page at the old slug is withheld");
  const ent = (await sql<{ at: string }>(`SELECT updated_at::text AS at FROM public.entities WHERE id = $1::bigint`, [p.entity.id]))[0];
  assert(ent.at !== p.entity.at, "the entity the moved synthesis named is bumped (its page recompiles from shared material)");
});
t(BOTH, "[db] [fix3] P2 a shared claim left by a superseded synthesis (its filer no longer restates it) moves to B with the claim it restates", async () => {
  const p = await plant();
  const r = (await sql<{ shared: number; owner: string | null; linked: number }>(
    `SELECT (SELECT count(*)::int FROM public.claims WHERE id = $1) AS shared,
            (SELECT inlet_owner_sub FROM public.inlet_private_claims WHERE id = $1) AS owner,
            (SELECT count(*)::int FROM public.research_private_report_claims WHERE claim_id = $1 AND report_id = $2) AS linked`, [p.supB2, p.bReport]))[0];
  assertEquals([r.shared, r.owner === B, r.linked], [0, true, 1], "the left-behind claim is B's, not shared");
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.sources WHERE id = $1`, [p.synCtl]))[0].n, 1, "its filer (which restates nothing) stays shared");
});
// final round (tester attempt 2 F3): slot 480's workbench login reads the owner's claims, owner-scoped; it files nothing
t([...BOTH, "p480"], "[db] slot 480's ob_workbench login reads only the verified subject's private-report claims, and files none", async () => {
  if (!wbPool) throw new Error("PRC_WB_PASSWORD is not set: slot 480's ob_workbench login is required");
  const p = await plant();
  const c = await wbPool.connect();
  try {
    const of = async (sub: string) => (await c.queryObject<{ id: string }>(`SELECT id::text AS id FROM public.private_report_claims_of_idea($1::uuid, $2)`, [p.bIdea.id, sub])).rows.map((r) => r.id);
    const mine = await of(B);
    for (const id of [p.b1, p.b2, p.b3]) assert(mine.includes(id), "B's own, read by the ob_workbench login");
    for (const s of [A, C, "", "service:openbrain-mcp", "operator"]) assertEquals(await of(s), [], `subject ${s || "(blank)"}`);
    const code = await errCode(() => c.queryObject(`SELECT * FROM public.private_report_claim_file($1, $2::uuid, 'a claim text', NULL)`, [`rk-prc-b-${p.R}`, p.bIdea.job]));
    assertEquals(code, "42501", "ob_workbench files nothing");
  } finally { c.release(); }
});
// the REST door over HTTP (slot 450): no token is refused at the door (401); EVERY door caller's own token (wiki, viewer, entity,
// digest, ...) is refused the slot's functions BY PRIVILEGE (exactly 403 - a mis-addressed route or an unresolved function is a
// 404 and fails the case) - no row, no claim text. Self-proving controls on the same /rest/v1 prefix: an unknown rpc answers
// 404 for every token (the request reached PostgREST's function lookup), and a table the wiki / viewer token is granted
// answers 200 (the prefix is right). In the red phase the revert dropped the functions: they must be 404 then (absent), not 403.
// Fails closed: no minted token, no granted-table control token, or PRC_PGRST unset = the lab is wrong.
t(BOTH, "[guard] the REST door's rpc never reads or files a private-report claim, with no token or any caller's token", async () => {
  if (!PGRST) throw new Error("PRC_PGRST is not set");
  if (REST_TOKENS.length < 1) throw new Error("PRC_REST_TOKENS is not set (the lab mints one per caller)");
  const p = await plant();
  const present = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM unnest(ARRAY[
      to_regprocedure('public.private_report_claims_of_idea(uuid,text)'),
      to_regprocedure('public.private_report_claim_file(text,uuid,text,uuid,text,text,integer,vector,jsonb)')]) f WHERE f IS NOT NULL`))[0].n;
  assertEquals(present, PHASE === "red" ? 0 : 2, `the slot's functions in the catalog (${PHASE})`);
  const refused = PHASE === "red" ? 404 : 403; // red: absent; after 570: present and refused by privilege
  const req = async (method: string, path: string, body: unknown, token: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(`${PGRST}/${path}`, { method, headers, body: body === null ? undefined : JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  };
  const call = (fn: string, body: unknown, token: string) => req("POST", `rpc/${fn}`, body, token);
  const callers: [string, string][] = [["(no token)", ""], ...REST_TOKENS];
  for (const [who, token] of callers) {
    const want = token ? refused : 401;
    const read = await call("private_report_claims_of_idea", { p_idea_id: p.bIdea.id, p_sub: B }, token);
    assertEquals(read.status, want, `${who}: the owner read over rpc (${read.text.slice(0, 120)})`);
    for (const s of secretsOf(p)) assert(!read.text.includes(s), `${who}: no claim text or id in the refusal`);
    const file = await call("private_report_claim_file", { p_research_key: `rk-prc-b-${p.R}`, p_job_id: p.bIdea.job, p_text: "a claim text over rpc" }, token);
    assertEquals(file.status, want, `${who}: filing over rpc (${file.text.slice(0, 120)})`);
    for (const s of secretsOf(p)) assert(!file.text.includes(s), `${who}: no claim text or id in the filing refusal`);
    // control: an unknown function on the same prefix - the door lets the token through and PostgREST answers "not found"
    const none = await call("no_such_function_prcprobe", {}, token);
    assertEquals(none.status, token ? 404 : 401, `${who}: an unknown rpc on the same prefix`);
  }
  // control: a granted read on the same prefix succeeds (slot 450's door map: wiki and viewer read wiki_pages)
  const granted = REST_TOKENS.filter(([who]) => /^(WIKI|VIEWER)$/i.test(who));
  if (granted.length < 1) throw new Error("no wiki / viewer token minted: the granted-route control cannot run");
  for (const [who, token] of granted) {
    const ok = await req("GET", "wiki_pages?select=slug&limit=1", null, token);
    assertEquals(ok.status, 200, `${who}: a granted table on the same /rest/v1 prefix answers`);
  }
});
