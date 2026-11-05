// deno test src/inlet/inlet_owner_integration_test.ts - slot 410 (research-workbench rw-inlet-owner, plan 08 PD1;
// operator 2026-11-04 "all private"): every existing personal row becomes its owner's and private, over a REAL
// workbench, viewer, PostgREST and database.
//
// Round 2 (tester attempt 1): a service-owned digest job, the function grants, the link and text variants, the manifest.
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
    // round 2 (tester 1): the SERVICE-owned digest job and its branch - every session and contract read
    ["contract sessions (recent)", `${W}/sessions?state=recent`],
    ["contract sessions (all)", `${W}/sessions`],
    ["contract session (service-owned digest job)", `${W}/sessions/${j.svc}`],
    ["contract session flow (service-owned)", `${W}/sessions/${j.svc}/flow`],
    ["contract session coverage (service-owned)", `${W}/sessions/${j.svc}/coverage`],
    ["contract session (its branch)", `${W}/sessions/${j.svcbranch}`],
    ["contract session flow (its branch)", `${W}/sessions/${j.svcbranch}/flow`],
    ["contract report credibility (service-owned)", `${W}/reports/${j.svc}/credibility`],
    ["contract jobs (every kind)", `${W}/jobs?kinds=research,import`],
    ["contract timeline (service-owned)", `${W}/timeline?session_id=${j.svc}`],
    // round 3 (tester attempt 2, P1b): the marker only in the seed BODY and in the text derived from it
    ["contract session (body-seeded digest job)", `${W}/sessions/${j.body}`],
    ["contract session flow (body-seeded)", `${W}/sessions/${j.body}/flow`],
    ["contract session coverage (body-seeded)", `${W}/sessions/${j.body}/coverage`],
    ["contract session (its branch)", `${W}/sessions/${j.bodybranch}`],
    ["contract session flow (its branch)", `${W}/sessions/${j.bodybranch}/flow`],
    ["contract report credibility (body-seeded)", `${W}/reports/${j.body}/credibility`],
    ["contract session (transcript-seeded)", `${W}/sessions/${j.pod}`],
    ["contract session flow (transcript-seeded)", `${W}/sessions/${j.pod}/flow`],
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
  for (const tb of ["inlet_owner_archive", "inlet_private_sources", "inlet_private_source_chunks", "inlet_private_claims", "inlet_private_claim_links", "inlet_owner",
                    "inlet_owner_withheld_pages", "inlet_owner_withheld_chunks"]) {
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

t("migrated", "round 2 (tester 2, 5): no slot-440 function executes for service_role (PostgREST's anon role), anon, authenticated or PUBLIC; ob_app_memory holds only the owner read; round 1's owner function is gone", async () => {
  const fns = ["public.inlet_private_source(uuid,text)", "public.inlet_owner_page_private(text,text,text,jsonb)",
    "public.inlet_owner_page_links_private(text,text,text,jsonb)", "public.inlet_owner_text_withheld(text)",
    "public.inlet_owner_linked_source_ids(text,text,text,jsonb)", "public.inlet_owner_norm(text)", "public.trg_inlet_owner_wiki_guard()"];
  const present = (await sql<{ f: string }>(`SELECT f FROM unnest($1::text[]) f WHERE to_regprocedure(f) IS NOT NULL`, [fns])).map((x) => x.f);
  assertEquals(present.length, fns.length, "every slot-440 function exists");
  const roles = (await sql<{ r: string }>(
    `SELECT r FROM unnest(ARRAY['service_role','anon','authenticated','public','ob_app_memory']) r
      WHERE r = 'public' OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)`)).map((x) => x.r);
  const grants = await sql<{ r: string; f: string }>(
    `SELECT r, f FROM unnest($1::text[]) r, unnest($2::text[]) f WHERE has_function_privilege(r, f, 'EXECUTE') ORDER BY 1, 2`, [roles, fns]);
  assertEquals(grants.map((g) => `${g.r}:${g.f}`), ["ob_app_memory:public.inlet_private_source(uuid,text)"]);
  const gone = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'inlet_owner_default'`))[0].n;
  assertEquals(gone, 0, "inlet_owner_default no longer exists");
  // a role reachable without credentials asking the store for the owner's moved source, with the right subject: refused
  const p = await plant();
  for (const role of ["service_role", "authenticated"]) {
    const code = await errCode(async () => {
      const c = await pool!.connect();
      try {
        await c.queryObject("BEGIN");
        await c.queryObject(`SET LOCAL ROLE ${role}`);
        await c.queryObject(`SELECT * FROM public.inlet_private_source($1::uuid, $2)`, [p.sources.mail, A]);
        await c.queryObject("COMMIT");
      } catch (e) {
        try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
        throw e;
      } finally {
        c.release();
      }
    });
    assertEquals(code, "42501", `${role} may not execute the owner read`);
  }
  // the prune's view: the owner's gmail thoughts, no owner column
  const cols = await sql<{ c: string }>(`SELECT attname::text AS c FROM pg_attribute WHERE attrelid = 'public.inlet_owner_mail'::regclass AND attnum > 0 ORDER BY attnum`);
  assertEquals(cols.map((x) => x.c), ["id", "content", "metadata", "created_at"]);
});

t("migrated", "round 2 (tester 4, 6): every link form is withheld (any case, %2F); a note with [[Thought/<id>]] is refused with 430's one message; withheld text that comes back nearly whole is withheld at ANY slug, a quarter of it is not (the stated limit); every withheld row is marked", async () => {
  const p = await plant();
  const pg = p.pages;
  const priv = p.thoughts[2];
  const srcUpper = String(p.sources.mail).toUpperCase();
  const arch = Object.fromEntries((await sql<{ ref: string; body: string }>(
    `SELECT ref, row_data ->> 'body' AS body FROM public.inlet_owner_archive WHERE action = 'w' AND restored_at IS NULL AND ref = ANY($1)`,
    [[pg.linking, pg.evidence]])).map((x) => [x.ref, x.body]));
  const longBody = arch[pg.linking];
  const smallBody = arch[pg.evidence];
  assert(longBody && smallBody, "the long and the small withheld page are archived");
  const longWords = longBody.split(" ").filter((w) => w !== "");
  const tail = longWords.slice(12).join(" ");    // past the thought link: the text rule, not the link rule, must hold it
  const variants: [string, string, boolean][] = [   // [name, body, withheld?]
    ["[[Content/Thought/<id>]]", `see [[Content/Thought/${priv}]]`, true],
    ["content/thought%2F<id>", `see content/thought%2F${priv}`, true],
    ["(THOUGHT%2f<id>)", `see (THOUGHT%2f${priv})`, true],
    ["[[content/SOURCE/<UUID>]]", `see [[content/SOURCE/${srcUpper}]]`, true],
    ["source%2F<uuid>", `see source%2F${p.sources.mail}`, true],
    ["long page, one byte changed, another slug", tail.replace("para50 ", "pare50 "), true],
    ["small page, one word changed, another slug", smallBody.replace("topic", "topix"), true],
    ["small page exact, another slug", smallBody, true],
    ["a quarter of the long page (the stated limit)", longWords.slice(-24).join(" "), false],
    ["new shared text", "Rebuilt from the shared article only: it has three parts.", false],
    ["control: afterthought/<id>", `about afterthought/${priv}`, false],
  ];
  const bad: string[] = [];
  let i = 0;
  for (const [name, body, held] of variants) {
    const sl = `content/topic/variant-${i++}-${String(p.mark).slice(-4)}`;
    await asApp(`INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'entity', 'v', $2)`, [sl, body]);
    const n = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.wiki_pages WHERE slug = $1`, [sl]))[0].n;
    if ((n === 0) !== held) bad.push(`${name}: ${n === 0 ? "withheld" : "written"}`);
    await sql(`DELETE FROM public.wiki_pages WHERE slug = $1`, [sl]);
  }
  console.log(`inlet privacy: guard variants judged wrongly: ${bad.length}${bad.length ? " - " + bad.join("; ") : ""}`);
  assertEquals(bad, []);
  // a NOTE with the upper-case link: refused, with 430's message (it names neither the guard nor the reason)
  let msg = "";
  try {
    await asApp(`INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ($1, 'note', 'n', $2)`,
      [`notes/variant-${String(p.mark).slice(-4)}`, `see [[Thought/${priv}]]`]);
  } catch (e) {
    msg = `${(e as { fields?: { code?: string } }).fields?.code}: ${(e as Error).message}`;
  }
  assert(msg.startsWith("42501") && msg.includes("wiki_pages: this page cannot be saved"), "the note is refused with the uniform message");
  // the marker: a raw PostgREST upsert of two withheld rows says 2, and returns neither
  const r = await fetch(`${REST}/rest/v1/wiki_pages?on_conflict=slug&select=slug`, {
    method: "POST",
    headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{ slug: "content/topic/marker-a", page_class: "entity", title: "m", body: `[[thought/${priv}]]` },
      { slug: "content/topic/marker-b", page_class: "entity", title: "m", body: tail }]),
  });
  const back = await r.json();
  assertEquals([r.status < 300, r.headers.get("x-wiki-withheld"), Array.isArray(back) ? back.length : -1], [true, "2", 0]);
});

t("migrated", "round 2 (tester 3): the wiki-service manifest and the compile count only shared thoughts - the private-only entity has no link", async () => {
  const p = await plant();
  // the manifest's query (docker/wiki-service/wiki-service.mjs fetchEntityLinkData) and the compile's eligibility count
  for (const q of [`thought_entities?select=entity_id,thoughts!inner(id)&thoughts.user_id=is.null&entity_id=eq.${p.entities.priv}`,
                   `thought_entities?select=thought_id,thoughts!inner(id)&entity_id=eq.${p.entities.priv}&thoughts.user_id=is.null`]) {
    const r = await fetch(`${REST}/rest/v1/${q}`);
    assertEquals(((await r.json()) as unknown[]).length, 0, "no shared link for the private-only entity");
  }
  const edges = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.edges WHERE from_entity_id = $1`, [p.entities.priv]))[0].n;
  assertEquals(edges, 1, "the entity keeps its typed edge (the runner's compile step proves no page is built from it)");
});

t("migrated", "round 3 (tester attempt 2, P1b): a tree seeded with an email body or a podcast transcript - the marker only in the seed body and the text derived from it - carries no personal text in ANY shared row any reader reads (jobs, branches, events, prompts: what the workbench and the research service read); its owner reads the original through the session read", async () => {
  const p = await plant();
  const m = p.mark as string;
  const ids = [p.jobs.body, p.jobs.bodybranch, p.jobs.pod];
  // every column of the shared rows (the research service's /research/jobs/{id}, /tree, /events and the workbench read these)
  const rows = await sql<{ t: string }>(
    `SELECT to_jsonb(j)::text AS t FROM public.research_jobs j WHERE j.id = ANY($1::uuid[])
     UNION ALL SELECT to_jsonb(e)::text FROM public.research_job_events e WHERE e.job_id = ANY($1::uuid[]) OR e.root_job_id = ANY($1::uuid[])
     UNION ALL SELECT to_jsonb(r)::text FROM public.research_prompts r WHERE r.job_id = ANY($1::uuid[])`, [ids]);
  const hit = rows.filter((r) => leaks(r.t, m)).length;
  console.log(`inlet privacy: seeded-tree shared rows carrying the seed body's text: ${hit} of ${rows.length}`);
  assertEquals(hit, 0);
  assert(rows.length >= 6, "the planted jobs, branch, events and prompts are all there");
  // B reads the neutral text; A, the owner, reads the original through the session read
  const b = await get(BASE, `/workbench/contract/sessions/${p.jobs.body}`, B);
  const a = await get(BASE, `/workbench/contract/sessions/${p.jobs.body}`, A);
  assertEquals([b.status, a.status], [200, 200]);
  assert(!leaks(b.text, m), "B's session read carries no seed-body text");
  assert(a.text.includes(`${m}b`), "A (the owner) reads the job's own text as before");
  // the owner-only store: the originals, readable by no app role directly
  const kept = (await sql<{ n: number }>(`SELECT count(DISTINCT job_id)::int AS n FROM public.inlet_private_jobs WHERE job_id = ANY($1::uuid[])`, [ids]))[0].n;
  assertEquals(kept, 3, "the three jobs' own text is kept for their owner");
  for (const tb of ["inlet_private_jobs", "inlet_private_job_events"]) {
    assertEquals(await errCode(() => asApp(`SELECT count(*) FROM public.${tb}`)), "42501", `${tb} is refused to the app role`);
  }
  // the owner read: EXECUTE for ob_app_memory only (never PostgREST's anon role), and no row for another subject
  const g = await sql<{ r: string }>(
    `SELECT r FROM unnest(ARRAY['service_role','anon','authenticated','public','ob_app_memory']) r
      WHERE (r = 'public' OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)) AND has_function_privilege(r, 'public.inlet_private_job(uuid,text)', 'EXECUTE')`);
  assertEquals(g.map((x) => x.r), ["ob_app_memory"]);
  const other = await asApp(`SELECT count(*)::int AS n FROM public.inlet_private_job($1::uuid, $2)`, [p.jobs.body, B]);
  assertEquals((other[0] as { n: number }).n, 0, "the owner read answers no row for another subject");
});

t("migrated", "round 4 (tester attempt 3, 4a - the tester's plant): a seeded tree's rows are rebuilt - no marker survives in a kept-shape value (urls with text, *_id hex / digits, code-shaped tokens, *_at strings that only start with a date), in a JSON key at any depth, in nested arrays or in an event's payload or trail; only an exact shared source url is kept, with the shared row's own title; the unseeded control stays", async () => {
  const p = await plant();
  const a = await plant("adv3");
  const m = p.mark as string;
  const ids = [a.j1, a.r, a.b1, a.b2];
  const rows = await sql<{ t: string }>(
    `SELECT to_jsonb(j)::text AS t FROM public.research_jobs j WHERE j.id = ANY($1::uuid[]) OR j.root_job_id = ANY($1::uuid[])
     UNION ALL SELECT to_jsonb(e)::text FROM public.research_job_events e WHERE e.job_id = ANY($1::uuid[]) OR e.root_job_id = ANY($1::uuid[])
     UNION ALL SELECT to_jsonb(r)::text FROM public.research_prompts r WHERE r.job_id = ANY($1::uuid[])`, [ids]);
  const hits = rows.filter((r) => leaks(r.t, m) || r.t.includes(String(a.hx)) || r.t.includes("1234567890123456")).length;
  console.log(`inlet privacy: the 4a tree's shared rows carrying a marker, the hex id or the digit id: ${hits} of ${rows.length}`);
  assertEquals(hits, 0);
  assert(rows.length >= 9, "the planted jobs, events and prompts are all there");
  // the kept url: exactly the shared source's, with its own title; nothing else under cited_sources
  const res = (await sql<{ r: Record<string, unknown> }>(`SELECT result AS r FROM public.research_jobs WHERE id = $1::uuid`, [a.j1]))[0].r;
  const cited = (res.cited_sources ?? []) as { url: string; title: string }[];
  assertEquals(cited.map((c) => c.url), [`https://news.example/b/ctl${m}`]);
  assertEquals(Object.keys(res).sort(), ["cited_sources", "outcome", "synthesis"], "only known keys survive (report_type was not an enumerated value)");
  // the unseeded control tree is untouched shared research output
  const ctl = (await sql<{ q: string }>(`SELECT query AS q FROM public.research_jobs WHERE id = $1::uuid`, [a.ctl]))[0].q;
  assertEquals(ctl, `ctl3 question ctl${m}q`);
  // the owner reads the original through the owner-only store
  const own = await asApp(`SELECT result FROM public.inlet_private_job($1::uuid, $2)`, [a.j1, A]);
  assert(JSON.stringify(own[0]).includes(`${m}rt`), "the owner's copy keeps the original result");
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
