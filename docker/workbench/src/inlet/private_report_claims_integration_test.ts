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
  const r = await sql<{ v: Record<string, unknown> }>(`SELECT v FROM public.lab_prc_plant WHERE k = 'plant'`);
  return r[0]?.v ?? {};
}

// ── plant: the 390 shape ───────────────────────────────────────────────────────────────────────────────────────────
t(["plant"], "plant two users' private reports and their claims in the shape slot 390 left them", async () => {
  const R = rnd();
  const w = { b: `prcb${R}`, a: `prca${R}`, multi: `prcmulti${R}`, orph: `prcorph${R}`, ctl: `prcctl${R}`, mix: `prcmix${R}`, bnew: `prcbnew${R}` };
  const one = async (q: string, args: unknown[] = []) => (await sql<{ id: string }>(q, args))[0].id;
  const thread = await one(`INSERT INTO public.threads (name, description, status) VALUES ($1, 'a shared thread', 'active') RETURNING id::text AS id`, [`Shared thread ${R}`]);
  const src = (title: string, ct = "web") => one(
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
  const a1 = await claim(`The ${w.a} gamma result was confirmed by a second team in 2025.`, null, null);
  await link(aReport, a1);
  const multi = await claim(`The ${w.multi} delta result appeared in both private reports alike.`, thread, null);
  await link(bReport, multi); await link(aReport, multi);
  const orph = await claim(`The ${w.orph} epsilon result came from a report whose idea is gone.`, thread, null);
  await link(orphReport, orph);
  // controls: a shared claim (shared synthesis), and a claim B's report shares with a shared synthesis (mixed: stays shared)
  const ctl = await claim(`The ${w.ctl} control result is shared knowledge from a shared report.`, thread, syn);
  const mix = await claim(`The ${w.mix} mixed result came out of a shared report too.`, thread, syn);
  await link(bReport, mix);
  // the conflict detector's reciprocal contradicts edges between B's claim and the shared control
  await sql(`SELECT public.link_claim_to_claim($1::uuid, $2::uuid, 'contradicts', 1.0)`, [ctl, b1]);
  await sql(`SELECT public.link_claim_to_claim($1::uuid, $2::uuid, 'contradicts', 1.0)`, [b1, ctl]);
  // a SHARED job that reused B's claim (and the control) - its result names B's claim and its text
  const job = await one(`INSERT INTO public.research_jobs (status, origin, query, finished_at, result, metrics)
      VALUES ('done', 'manual', 'a shared question', now(), $1::jsonb, '{"claims_reused": 2, "gap_ratio": 0.5}'::jsonb) RETURNING id::text AS id`,
    [JSON.stringify({ outcome: "answered", reuse_claims: [{ id: b1, text: `The ${w.b} alpha result reproduced in 12 trials across two labs.` }, { id: ctl, text: `The ${w.ctl} control result is shared knowledge from a shared report.` }], claims: [] })]);
  // a wiki page carrying B's claim's text, and a clean page
  const page = `content/topic/prc-${R}`, clean = `content/topic/prc-clean-${R}`;
  await sql(`INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'entity', $2, $3), ($4, 'entity', $5, 'nothing private here at all')`,
    [page, `Topic ${R}`, `Some notes. The ${w.b} alpha result reproduced in 12 trials across two labs. More notes.`, clean, `Clean topic ${R}`]);
  // a corroboration line of B's run (the research service writes them during the run)
  await sql(`INSERT INTO public.source_corroborations (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version, job_id)
             VALUES ($1, $2, 'strong', 0.5, $3, 'descriptive', 'supports', 'lab', $4)`,
    [s2, s1, `The ${w.b} alpha result reproduced in 12 trials across two labs.`, bIdea.job]);
  await sql(`CREATE TABLE IF NOT EXISTS public.lab_prc_plant (k TEXT PRIMARY KEY, v JSONB NOT NULL)`);
  await sql(`INSERT INTO public.lab_prc_plant (k, v) VALUES ('plant', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [JSON.stringify({ R, w, thread, s1, s2, syn, bIdea, aIdea, bReport, aReport, orphReport, b1, b2, a1, multi, orph, ctl, mix, job, page, clean })]);
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
  // PostgREST's anon role (service_role) and authenticated may not file
  for (const role of ["service_role", "authenticated"]) {
    assertEquals(await errCode(() => asRole(role, `SELECT * FROM public.private_report_claim_file($1, $2::uuid, 'a claim text', NULL)`, [`rk-prc-b-${p.R}`, p.bIdea.job])), "42501", role);
  }
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
  // already owner-only before slot 570 (rw-report-isolation / rw-p8a4-ideas): controls, green in both phases
  ["contract/ideas/{B's idea}", (p) => `/workbench/contract/ideas/${p.bIdea.id}`],
  ["contract/ideas", () => `/workbench/contract/ideas?limit=200`],
  ["contract/sessions/{B's idea job}", (p) => `/workbench/contract/sessions/${p.bIdea.job}`],
];
// what of B's (and of nobody's) a non-owner must never read: the words, the ids
// deno-lint-ignore no-explicit-any
const secretsOf = (p: Record<string, any>) => [p.w.b, p.w.multi, p.w.orph, p.w.bnew, p.b1, p.b2, p.multi, p.orph, p.bnewId].filter(Boolean) as string[];
for (const [name, path] of READS) {
  t(BOTH, `[leak] ${name}: no non-owner reads B's private-report claims (text, id, nested fields)`, async () => {
    const p = await plant();
    const secrets = secretsOf(p);
    const hits: string[] = [];
    for (const v of VIEWERS_NOT_B) {
      const r = await get(v, path(p));
      // a search echoes its own query: judge the results only
      const body = path(p).includes("/search?") ? JSON.stringify((r.json as { results?: unknown }).results ?? []) : r.text;
      for (const s of secrets) if (body.includes(s)) hits.push(`${v.name} -> ${r.status} carries a ${s === p.b1 || s === p.b2 || s === p.multi || s === p.orph || s === p.bnewId ? "claim id" : "claim word"}`);
    }
    assertEquals(hits, [], `${name}`);
  });
}
t(BOTH, "[leak] contract/claims?thread_id: the count is the shared claims' only (the control and the mixed claim)", async () => {
  const p = await plant();
  for (const v of VIEWERS_NOT_B) {
    const r = await get(v, `/workbench/contract/claims?thread_id=${p.thread}&limit=200`);
    assertEquals(r.status, 200, `${v.name}: ${r.text.slice(0, 200)}`);
    const ids = ((r.json.claims ?? []) as { id: string }[]).map((c) => c.id).sort();
    assertEquals([r.json.count, ids], [2, [p.ctl, p.mix].sort()], `${v.name}: the thread's claims and count`);
  }
});

// ── controls and the owner ─────────────────────────────────────────────────────────────────────────────────────
t(BOTH, "[control] a shared claim and a claim a shared synthesis also filed still answer every viewer, B included", async () => {
  const p = await plant();
  for (const v of [...VIEWERS_NOT_B, ...B_VIEWERS]) {
    for (const [word, id] of [[p.w.ctl, p.ctl], [p.w.mix, p.mix]]) {
      const r = await get(v, `/workbench/contract/claims?q=${word}`);
      assert(((r.json.claims ?? []) as { id: string }[]).some((c) => c.id === id), `${v.name}: the shared claim ${word === p.w.ctl ? "ctl" : "mix"} is listed (${r.status})`);
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
  const ids = [p.b1, p.b2, p.multi, p.orph];
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
  const body = `Rewritten. The ${p.w.b} alpha result reproduced in 12 trials across two labs.`;
  // each probe in a rolled-back transaction (the viewer's reconcile / a compile writing the page back)
  const back = await probe<{ n: number }>(null,
    `WITH w AS (INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'entity', 'again', $2)
                ON CONFLICT (slug) DO UPDATE SET body = EXCLUDED.body RETURNING 1) SELECT count(*)::int AS n FROM w`, [p.page, body]);
  assertEquals(back[0].n, 0, "the rewrite is withheld");
  assertEquals(await errCode(() => probe(null, `INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'note', 'n', $2)`, [`notes/prc-${p.R}`, body])), "42501", "a note is refused");
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
  assertEquals(r[0].amount, 0.5);
});
t(BOTH, "[db] the owner stores and the owner read: closed to every app role, owner-checked for the services' role", async () => {
  const p = await plant();
  for (const role of ["ob_app_memory", "service_role", "authenticated"]) {
    assertEquals(await errCode(() => asRole(role, `SELECT count(*) FROM public.inlet_private_claims`)), "42501", `${role} reads the store`);
    assertEquals(await errCode(() => asRole(role, `SELECT count(*) FROM public.private_report_claims_archive`)), "42501", `${role} reads the archive`);
  }
  const of = async (sub: string) => (await asRole<{ id: string }>("ob_app_memory", `SELECT id::text AS id FROM public.private_report_claims_of_idea($1::uuid, $2)`, [p.bIdea.id, sub])).map((r) => r.id).sort();
  assertEquals(await of(B), [p.b1, p.b2, p.bnewId].filter(Boolean).sort(), "B's own");
  for (const s of [A, C, "", "service:openbrain-mcp", "anonymous:", "operator"]) assertEquals(await of(s), [], `subject ${s || "(blank)"}`);
  assertEquals(await errCode(() => asRole("service_role", `SELECT * FROM public.private_report_claims_of_idea($1::uuid, $2)`, [p.bIdea.id, B])), "42501", "PostgREST's anon role");
  // the withheld ones are in no store
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.inlet_private_claims WHERE id = ANY($1::uuid[])`, [[p.multi, p.orph]]))[0].n, 0);
});
t(BOTH, "[db] no service can link a shared claim to a private report (the services' role and PostgREST's)", async () => {
  const p = await plant();
  for (const role of ["ob_app_memory", "service_role"]) {
    assertEquals(await errCode(() => probe(role, `INSERT INTO public.research_private_report_claims (report_id, claim_id) VALUES ($1, $2)`, [p.bReport, p.ctl])), "23514", role);
  }
});
