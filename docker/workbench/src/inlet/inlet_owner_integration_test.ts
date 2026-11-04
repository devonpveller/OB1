// deno test src/inlet/inlet_owner_integration_test.ts - slot 410 (research-workbench rw-inlet-owner, plan 08 PD1;
// operator 2026-11-04 "all private"): every existing personal row becomes its owner's and private, over a REAL
// workbench, viewer, PostgREST and database.
//
// SKIPPED unless DOCS_TEST_BASE and INLET_PHASE are set. contract-test/run-workspace-tests.ps1 [5r] runs it in phases
// around psql runs of contract-test/inlet-owner-plant.sql, init-inlet-owner.sql and revert-inlet-owner.sql, on a
// DISPOSABLE internal network:
//   snapshot  the md5 of the 14 tables slot 410 touches, kept in the lab's plant table (before the first init)
//   migrated  as user B (a second, seeded subject): no planted marker and no Gmail id or URL in any read B has (the
//             workbench's contract and legacy routes, nested fields included; the viewer's pages, nav and graph; the
//             compile's PostgREST reads; match_thoughts as B / shared); the mixed claim is B's with only the shared
//             source, the private and chained claims are not; as the owner A: every thought through match_thoughts,
//             the moved source through the owner read; the guard; the stores readable by no app role
//   rerun     after the late plant + init again: exactly the rows that arrived unowned are stamped and isolated
//   reverted  after the revert: the 14 tables byte-identical to the snapshot
// Only counts, route names and pass/fail are printed, never a row's content. Never point it at a live stack.
// Environment: INLET_PHASE, INLET_OWNER (A), INLET_SECOND (B), INLET_VIEWER, OPEN_BRAIN_URL, DOCS_TEST_BASE,
// DOCS_TEST_KEY, CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("DOCS_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("DOCS_TEST_KEY") ?? "";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const PHASE = Deno.env.get("INLET_PHASE") ?? "";
const A = Deno.env.get("INLET_OWNER") ?? "";
const B = Deno.env.get("INLET_SECOND") ?? "";
const VIEWER = (Deno.env.get("INLET_VIEWER") ?? "").replace(/\/+$/, "");
const REST = (Deno.env.get("OPEN_BRAIN_URL") ?? "http://openbrain-rest").replace(/\/+$/, "");
const APP_ROLE = "ob_app_memory";
const off = !BASE || !HOST || !PHASE || !A || !B;
const pool = !off
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 2, true)
  : null;
const t = (phase: string, name: string, fn: () => Promise<void>) =>
  Deno.test({ name: `[${phase}] ${name}`, ignore: off || PHASE !== phase, fn, sanitizeOps: false, sanitizeResources: false });

// deno-lint-ignore no-explicit-any
async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}
// as the app role every service uses, optionally with ob.user_id set for the transaction
// deno-lint-ignore no-explicit-any
async function asApp<T = Record<string, any>>(text: string, args: unknown[] = [], guc = ""): Promise<T[]> {
  const c = await pool!.connect();
  try {
    await c.queryObject("BEGIN");
    await c.queryObject(`SET LOCAL ROLE ${APP_ROLE}`);
    if (guc) await c.queryObject(`SELECT set_config('ob.user_id', $1, true)`, [guc]);
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
async function errCode(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return ""; } catch (e) { return String((e as { fields?: { code?: string } }).fields?.code ?? (e as Error).message); }
}
async function get(base: string, path: string, sub: string) {
  const r = await fetch(base + path, { headers: { "x-brain-key": KEY, "X-Test-Sub": sub } });
  return { status: r.status, text: await r.text() };
}
// deno-lint-ignore no-explicit-any
async function plant(k = "plant"): Promise<Record<string, any>> {
  const r = await sql<{ v: Record<string, unknown> }>(`SELECT v FROM public.lab_inlet_owner_plant WHERE k = $1`, [k]);
  return r[0]?.v ?? {};
}
// a personal marker: the plant's token NOT preceded by 'ctl' (the shared controls carry 'ctl' + the token); a Gmail URL
// (a route's echo of B's own query - "query"/"q" - is B's text, not a leak, and is cut before the test)
const leaks = (text: string, m: string) => {
  const body = text.replace(/"(query|q)"\s*:\s*"[^"]*"/g, '""');
  return new RegExp(`(?<!ctl)${m}`).test(body) || /mail\.google\.com/i.test(body);
};

const TABLES = ["thoughts", "sources", "source_chunks", "claims", "claim_sources", "research_jobs", "wiki_pages", "entities",
  "thought_entities", "source_entities", "thread_sources", "source_extraction_queue", "session_sources", "research_private_report_claims"];
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const tb of TABLES) {
    out[tb] = (await sql<{ h: string }>(
      `SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text), ',' ORDER BY md5(to_jsonb(x)::text)), '')) AS h FROM public.${tb} x`))[0].h;
  }
  return out;
}

t("snapshot", "the 14 tables slot 410 touches, hashed before the first run", async () => {
  const snap = await snapshot();
  await sql(`INSERT INTO public.lab_inlet_owner_plant VALUES ('snapshot', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [JSON.stringify(snap)]);
  assertEquals(Object.keys(snap).length, 14);
});

// every read user B has, by route name (the body is searched for the marker; only the names are reported)
async function secondUserReads(p: Record<string, any>): Promise<string[]> {
  const m = p.mark as string;
  const s = p.sources, c = p.claims, pg = p.pages, j = p.jobs;
  const W = "/workbench/contract";
  const routes: [string, string][] = [
    ["contract search (every kind)", `${W}/search?q=${m}`],
    ["contract search (pages)", `${W}/search?q=${m}&kinds=page`],
    ["contract search (plan)", `${W}/search?q=plan`],
    ["contract claims", `${W}/claims?q=plan&limit=200`],
    ["contract claims (marker)", `${W}/claims?q=${m}&limit=200`],
    ["contract chunk context (email body)", `${W}/chunks/${s.mail}:0/context`],
    ["contract chunk context (podcast)", `${W}/chunks/${s.pod}:0/context`],
    ["contract chunk context (article)", `${W}/chunks/${s.art}:0/context`],
    ["contract source quality (email body)", `${W}/sources/${s.mail}/quality`],
    ["contract source quality (article)", `${W}/sources/${s.art}/quality`],
    ["contract source dependence (email body)", `${W}/sources/${s.mail}/dependence`],
    ["contract neighbours (entity page)", `${W}/neighbours?id=${encodeURIComponent(pg.evidence)}`],
    ["contract neighbours (clean page)", `${W}/neighbours?id=${encodeURIComponent(pg.clean)}`],
    ["contract timeline", `${W}/timeline`],
    ["contract trail", `${W}/trail`],
    ["contract session (the seeded job)", `${W}/sessions/${j.seed}`],
    ["contract jobs", `${W}/jobs?kinds=research`],
    ["sources search", `/workbench/sources?q=${m}`],
    ["source read (email body)", `/workbench/sources/${s.mail}`],
    ["source read (podcast)", `/workbench/sources/${s.pod}`],
    ["source read (article)", `/workbench/sources/${s.art}`],
    ["source revisions (email body)", `/workbench/sources/${s.mail}/revisions`],
    ["source notebooks (email body)", `/workbench/sources/${s.mail}/notebooks`],
    ["wiki search", `/workbench/search?q=${m}`],
    ["graph", `/workbench/graph`],
    ["notebook (the shared thread)", `/workbench/notebooks/${p.thread}`],
    ["grounding (the mixed entity)", `/workbench/grounding/${p.entities.mixed}`],
  ];
  const hits: string[] = [];
  for (const [name, path] of routes) {
    const r = await get(BASE, path, B);
    if (leaks(r.text, m)) hits.push(`${name} (${r.status})`);
  }
  // the viewer: every planted page, the nav and the graph index (not per-user: what anyone at the door reads)
  if (VIEWER) {
    for (const [name, slug] of Object.entries(pg as Record<string, string>)) {
      if (name === "clean") continue;
      const r = await get(VIEWER, `/${slug.split("/").map(encodeURIComponent).join("/")}`, B);
      if (leaks(r.text, m)) hits.push(`viewer page ${name} (${r.status})`);
    }
    for (const path of ["/__nav", "/static/graphIndex.json"]) {
      const r = await get(VIEWER, path, B);
      if (leaks(r.text, m)) hits.push(`viewer ${path} (${r.status})`);
    }
  }
  // what the wiki compile reads through PostgREST (service_role, the same queries generate-wiki.mjs issues)
  const ents = [p.entities.priv, p.entities.mixed].join(",");
  for (const [name, q] of [
    ["compile evidence", `thought_entities?select=thought_id,thoughts!inner(id,content,metadata)&entity_id=in.(${ents})&thoughts.user_id=is.null`],
    ["compile leaves", `thoughts?select=id,content,metadata&id=in.(${(p.thoughts as number[]).join(",")})&user_id=is.null`],
    ["compile source evidence", `source_entities?select=source_id,sources!inner(id,title,content,url)&entity_id=in.(${ents})`],
  ] as [string, string][]) {
    const r = await fetch(`${REST}/rest/v1/${q}`);
    const text = await r.text();
    if (leaks(text, m)) hits.push(`${name} (${r.status})`);
  }
  // match_thoughts: the compile's scope (shared) and a session that says it is B
  const dim = (await sql<{ d: number }>(`SELECT atttypmod AS d FROM pg_attribute WHERE attrelid = 'public.thoughts'::regclass AND attname = 'embedding'`))[0].d;
  const vec = `[${Array(dim).fill(0.02).join(",")}]`;
  const shared = await asApp(`SELECT content FROM public.match_thoughts($1::vector, 0.1, 50, '{"owner_scope":"shared"}'::jsonb)`, [vec]);
  if (shared.some((r) => leaks(String(r.content), m))) hits.push("match_thoughts (shared scope)");
  const asB = await asApp(`SELECT content FROM public.match_thoughts($1::vector, 0.1, 50, '{}'::jsonb)`, [vec], B);
  if (asB.some((r) => leaks(String(r.content), m))) hits.push("match_thoughts (ob.user_id = B)");
  const named = await asApp(`SELECT content FROM public.match_thoughts($1::vector, 0.1, 50, $2::jsonb)`, [vec, JSON.stringify({ owner_scope: B })]);
  if (named.some((r) => leaks(String(r.content), m))) hits.push("match_thoughts (owner_scope = B)");
  // openbrain-mcp's thought reads, with the lane subject B (thought-owner.ts's clause, as index.ts issues it)
  const mcp = await asApp(`SELECT content, metadata FROM thoughts WHERE (user_id IS NULL OR user_id = $1)`, [B]);
  if (mcp.some((r) => leaks(String(r.content) + JSON.stringify(r.metadata), m))) hits.push("the MCP thought read (lane subject B)");
  return hits;
}

t("migrated", "user B reads no marker, Gmail id or Gmail URL anywhere (routes, nested fields, viewer, compile, match_thoughts, MCP)", async () => {
  const p = await plant();
  const hits = await secondUserReads(p);
  console.log(`inlet privacy: B's reads with a personal marker: ${hits.length}${hits.length ? " - " + hits.join("; ") : ""}`);
  assertEquals(hits, []);
});

t("migrated", "the mixed claim stays B's with only the shared source; the private and the chained claims are not B's", async () => {
  const p = await plant();
  const r = await get(BASE, `/workbench/contract/claims?q=plan&limit=200`, B);
  // deno-lint-ignore no-explicit-any
  const items: any[] = (JSON.parse(r.text).claims ?? JSON.parse(r.text).items ?? JSON.parse(r.text).results ?? []);
  const byId = new Map(items.map((x) => [String(x.id ?? x.claim_id), x]));
  const mixed = byId.get(p.claims.mixed);
  assert(mixed, "the mixed claim is visible to B");
  const srcIds = (mixed.sources ?? []).map((x: Record<string, unknown>) => String(x.source_id ?? x.id));
  assertEquals(srcIds, [p.sources.art], "the mixed claim carries only the shared source");
  assert(!byId.has(p.claims.priv), "the private claim is not B's");
  assert(!byId.has(p.claims.chain), "the claim grounded on the private claim is not B's");
  const cnt = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.claims WHERE id = ANY($1::uuid[])`, [[p.claims.priv, p.claims.chain]]))[0].n;
  assertEquals(cnt, 0, "no shared claims row for the private claims");
});

t("migrated", "the owner A reads what they read before: every thought, and the moved source through the owner read", async () => {
  const p = await plant();
  const m = p.mark as string;
  const dim = (await sql<{ d: number }>(`SELECT atttypmod AS d FROM pg_attribute WHERE attrelid = 'public.thoughts'::regclass AND attname = 'embedding'`))[0].d;
  const vec = `[${Array(dim).fill(0.02).join(",")}]`;
  // as the services acting for A read today: no scope set (every ops-plane row), and A's own scope
  const plain = await asApp(`SELECT id FROM public.match_thoughts($1::vector, 0.1, 50, '{}'::jsonb)`, [vec]);
  const mine = await asApp(`SELECT id FROM public.match_thoughts($1::vector, 0.1, 50, $2::jsonb)`, [vec, JSON.stringify({ owner_scope: A })]);
  const ops = (p.thoughts as number[]).slice(0, 4).map(String);   // the fifth is exposure 'personal': no app read had it before either
  for (const id of ops) {
    assert(plain.some((r) => String(r.id) === id), "a service acting for A still reads A's thought");
    assert(mine.some((r) => String(r.id) === id), "A's own scope reads A's thought");
  }
  const mcp = await asApp(`SELECT id FROM thoughts WHERE (user_id IS NULL OR user_id = $1) AND id = ANY($2::bigint[])`, [A, p.thoughts]);
  assertEquals(mcp.length, 4, "the MCP lane with A's subject reads A's four ops-plane thoughts");
  const own = await get(BASE, `/workbench/sources/${p.sources.mail}`, A);
  assertEquals(own.status, 200);
  assert(new RegExp(m).test(own.text), "A reads the moved email body");
  const other = await get(BASE, `/workbench/sources/${p.sources.mail}`, B);
  assertEquals(other.status, 404);
  const owner = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.thoughts WHERE id = ANY($1::bigint[]) AND user_id = $2`, [p.thoughts, A]))[0].n;
  assertEquals(owner, 5, "every planted thought is A's");
});

t("migrated", "the guard: the leaf, a link and a withheld page's own text are not written back; a rebuilt page is; a note is refused", async () => {
  const p = await plant();
  const pg = p.pages;
  const arch = await sql<{ ref: string; row_data: Record<string, unknown> }>(
    `SELECT ref, row_data FROM public.inlet_owner_archive WHERE action = 'w' AND restored_at IS NULL AND ref = ANY($1)`,
    [[pg.leaf, pg.linking, pg.srcleaf, pg.evidence]]);
  assertEquals(arch.length, 4, "the four planted pages are archived");
  // the compile / reconcile path: PostgREST upsert (on_conflict=slug), as recipes/_shared/wiki-pages.mjs writes
  const rows = arch.map((a) => ({ slug: a.ref, page_class: a.row_data.page_class, title: a.row_data.title, body: a.row_data.body,
    links: a.row_data.links, frontmatter: a.row_data.frontmatter }));
  const rebuilt = { slug: pg.evidence, page_class: "entity", title: "Mixed rebuilt", body: "rebuilt from the shared article only", links: [], frontmatter: {} };
  const w = await fetch(`${REST}/rest/v1/wiki_pages?on_conflict=slug`, {
    method: "POST", headers: { "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([...rows, rebuilt]),
  });
  const landed = (await w.json()) as { slug: string; body: string }[];
  assertEquals(w.status < 300, true, "the batch is not failed by a withheld row");
  assertEquals(landed.map((x) => x.body).sort(), ["rebuilt from the shared article only"], "only the rebuilt page landed");
  // a note linking a private thought is refused out loud, for the app role too
  const code = await errCode(() => asApp(`INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'note', 'n', $2)`,
    [`notes/again-${p.mark}`, `see thought/${p.thoughts[2]}`]));
  assertEquals(code, "42501");
  await sql(`DELETE FROM public.wiki_pages WHERE slug = $1`, [pg.evidence]);
});

t("migrated", "the archive and the private stores are readable by no app role; the stores hold the moved rows", async () => {
  for (const tb of ["inlet_owner_archive", "inlet_private_sources", "inlet_private_source_chunks", "inlet_private_claims", "inlet_private_claim_links", "inlet_owner"]) {
    assertEquals(await errCode(() => asApp(`SELECT count(*) FROM public.${tb}`)), "42501", `${tb} is refused to the app role`);
  }
  const p = await plant();
  const n = (await sql<{ s: number; c: number; k: number; l: number }>(
    `SELECT (SELECT count(*)::int FROM public.inlet_private_sources WHERE id = ANY($1::uuid[])) AS s,
            (SELECT count(*)::int FROM public.inlet_private_source_chunks WHERE source_id = ANY($1::uuid[])) AS c,
            (SELECT count(*)::int FROM public.inlet_private_claims WHERE id = ANY($2::uuid[])) AS k,
            (SELECT count(*)::int FROM public.inlet_private_claim_links WHERE claim_id = $3::uuid) AS l`,
    [[p.sources.mail, p.sources.pod], [p.claims.priv, p.claims.chain], p.claims.mixed]))[0];
  assertEquals([n.s, n.c, n.k, n.l], [2, 2, 2, 1]);
});

t("rerun", "a second run stamps and isolates exactly the rows that arrived unowned since the first", async () => {
  const late = await plant("late");
  const before = await plant("late-unowned");     // every unowned thought id at the moment of the late plant (the runner records it)
  const batches = await sql<{ batch: string }>(`SELECT batch::text FROM public.inlet_owner_archive WHERE restored_at IS NULL GROUP BY batch ORDER BY min(id) DESC LIMIT 1`);
  const b2 = batches[0].batch;
  const stamped = (await sql<{ id: string }>(`SELECT row_data ->> 'id' AS id FROM public.inlet_owner_archive WHERE batch = $1::uuid AND action = 'o'`, [b2])).map((r) => r.id).sort();
  assertEquals(stamped, ((before.ids ?? []) as (string | number)[]).map(String).sort(), "the second batch stamped exactly the unowned thoughts");
  const moved = (await sql<{ ref: string }>(`SELECT ref FROM public.inlet_owner_archive WHERE batch = $1::uuid AND action = 's'`, [b2])).map((r) => r.ref);
  assertEquals(moved, [late.source], "the second batch moved exactly the new email body");
  const seeds = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.research_jobs WHERE id = $1::uuid AND (options -> 'seed_sources')::text ~* 'mail\\.google'`, [late.job]))[0].n;
  assertEquals(seeds, 0, "the new email-body seed is stripped");
  const owner = (await sql<{ u: string | null }>(`SELECT user_id AS u FROM public.thoughts WHERE id = $1`, [late.thought]))[0].u;
  assertEquals(owner, A, "the late thought is A's");
  const hits = await secondUserReads(await plant());
  assertEquals(hits, [], "B still reads nothing personal");
});

t("reverted", "the 14 tables are byte-identical to the snapshot taken before the first run", async () => {
  const want = await plant("snapshot") as Record<string, string>;
  const got = await snapshot();
  const differ = TABLES.filter((tb) => want[tb] !== got[tb]);
  console.log(`inlet privacy: tables differing from the snapshot: ${differ.length}${differ.length ? " - " + differ.join(", ") : ""}`);
  assertEquals(differ, []);
});
