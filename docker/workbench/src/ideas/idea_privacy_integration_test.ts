// deno test src/ideas/idea_privacy_integration_test.ts - slot 380 (research-workbench rw-idea-privacy, operator 2026-11-02:
// "Ideas are completely user isolated. The shared knowledge are the sources and claims.") over a REAL workbench and
// database: the shared-corpus thoughts every idea door wrote before slot 370 leave the shared corpus.
//
// SKIPPED unless DOCS_TEST_BASE and PRIVACY_PHASE are set. contract-test/run-workspace-tests.ps1 [5j] runs it in phases
// around psql runs of init-idea-privacy.sql / revert-idea-privacy.sql on a DISPOSABLE internal network:
//   plant     user A's ideas with the OLD shapes (capture_idea's thought, update_idea's revision thought, a backfilled
//             gmail thought, a linked thought of another type, an unlinked duplicate naming its idea), an entity link,
//             an edge and the extraction queue; a control thought that is not an idea; a snapshot (hashes only)
//   migrated  after init: no shared-corpus search finds any idea text (superuser, the app role = the generic MCP lane,
//             the list_thoughts type filter, B's and A's contract search); 0 idea-type thoughts; the archive holds
//             exactly the rows removed and no app role reads it; A reads every revision; the control is untouched
//   reverted  after revert: every thought, link, edge, queue row and revision is back byte-identical; no archive
// Only counts and pass/fail are printed, never a row's content. Never point it at a live stack.
// Environment: PRIVACY_PHASE, DOCS_TEST_BASE, DOCS_TEST_KEY, CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("DOCS_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("DOCS_TEST_KEY") ?? "";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const PHASE = Deno.env.get("PRIVACY_PHASE") ?? "";
const APP_ROLE = Deno.env.get("IDEAS_TEST_APP_ROLE") ?? "ob_app_memory";
const off = !BASE || !HOST || !PHASE;
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
// deno-lint-ignore no-explicit-any
async function asApp<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    await c.queryObject("BEGIN");
    await c.queryObject(`SET LOCAL ROLE ${APP_ROLE}`);
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
async function refusedAsApp(text: string): Promise<string> {
  try { await asApp(text); return ""; } catch (e) { return String((e as { fields?: { code?: string } }).fields?.code ?? (e as Error).message); }
}
async function call(method: string, path: string, sub: string) {
  const r = await fetch(BASE + path, { method, headers: { "x-brain-key": KEY, "X-Test-Sub": sub } });
  const text = await r.text();
  // deno-lint-ignore no-explicit-any
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

// the lab's own record of what was planted (ids, markers, hashes - this lab database only)
async function plant(): Promise<Record<string, any>> {
  return (await sql<{ v: Record<string, any> }>(`SELECT v FROM public.lab_idea_privacy_plant WHERE k = 'plant'`))[0].v;
}
// what slot 380 must move: the same predicate the migration states (a linked thought, or idea-shaped metadata)
const IDEA_SHAPED = `(EXISTS (SELECT 1 FROM public.idea_revisions r WHERE r.thought_id = t.id)
   OR lower(btrim(coalesce(t.metadata ->> 'type', ''))) = 'idea' OR lower(btrim(coalesce(t.metadata ->> 'kind', ''))) = 'idea'
   OR t.metadata ? 'idea_id')`;
// a row's hash, its children's hashes and the revisions' links, for byte-identity
const SNAPSHOT = `SELECT t.id::text AS id, md5(to_jsonb(t)::text) AS row,
       md5(coalesce((SELECT jsonb_agg(to_jsonb(te) ORDER BY te.entity_id, te.mention_role) FROM public.thought_entities te WHERE te.thought_id = t.id), '[]')::text) AS ent,
       md5(coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.thought_edges e WHERE e.from_thought_id = t.id OR e.to_thought_id = t.id), '[]')::text) AS edg,
       md5(coalesce((SELECT jsonb_agg(to_jsonb(q)) FROM public.entity_extraction_queue q WHERE q.thought_id = t.id), '[]')::text) AS que,
       md5(coalesce((SELECT jsonb_agg(jsonb_build_object('i', r.idea_id, 'r', r.revision, 'p', r.private_owner) ORDER BY r.idea_id, r.revision)
                       FROM public.idea_revisions r WHERE r.thought_id = t.id), '[]')::text) AS rev
  FROM public.thoughts t WHERE ${IDEA_SHAPED} ORDER BY t.id`;

t("plant", "user A's ideas in every pre-370 shape, an entity link, an edge, a control thought; the snapshot", async () => {
  const rnd = crypto.randomUUID().slice(0, 8);
  const A = `privacy-a-${rnd}`, B = `privacy-b-${rnd}`;
  const mk = { cap: `PrivCapture${rnd}`, upd: `PrivUpdate${rnd}`, gmail: `PrivGmail${rnd}`, other: `PrivOther${rnd}`, dup: `PrivDup${rnd}`,
    ent: `PrivEvidence${rnd}`, ctl: `PrivControl${rnd}` };
  const emb = `[${Array(1536).fill(0.02).join(",")}]`;
  const dim = (await sql<{ d: number }>(`SELECT atttypmod AS d FROM pg_attribute WHERE attrelid = 'public.thoughts'::regclass AND attname = 'embedding'`))[0].d;
  const vec = dim > 0 ? `[${Array(dim).fill(0.02).join(",")}]` : emb;
  const th = async (content: string, meta: Record<string, unknown>) =>
    (await sql<{ id: string }>(`INSERT INTO public.thoughts (content, embedding, metadata, exposure) VALUES ($1, $2::vector, $3::jsonb, 'ops') RETURNING id::text AS id`,
      [content, vec, JSON.stringify(meta)]))[0].id;
  const idea = async (title: string, summary: string, rev: number) =>
    (await sql<{ id: string }>(`INSERT INTO public.ideas (title, summary, status, current_revision, owner_sub, actor_sub) VALUES ($1, $2, 'dormant', $3, $4, 'system:lab') RETURNING id::text AS id`,
      [title, summary, rev, A]))[0].id;
  const rev = (id: string, n: number, summary: string, thought: string | null) =>
    sql(`INSERT INTO public.idea_revisions (idea_id, revision, summary, thought_id, research_job_id, content_hash) VALUES ($1::uuid, $2, $3, $4::bigint, 'backfill-parked', md5(lower(btrim($3))))`,
      [id, n, summary, thought]);
  // 1-2: capture_idea + update_idea (openbrain-mcp before slot 370): an ops thought per revision, naming the idea
  const capText = `an idea ${mk.cap}`, updText = `the idea, sharper ${mk.upd}`;
  const i1 = await idea(`Idea ${mk.cap}`, updText, 2);
  const t1 = await th(capText, { type: "idea", source: "mcp", kind: "idea", idea_id: i1, exposure: "ops" });
  const t2 = await th(updText, { type: "idea", source: "mcp", kind: "idea", idea_id: i1, exposure: "ops" });
  await rev(i1, 1, capText, t1);
  await rev(i1, 2, updText, t2);
  // 3: migrate-ideas-backfill.py from a gmail capture (type idea, no idea_id: linked only through the revision)
  const gText = `a mailed idea ${mk.gmail}`;
  const i2 = await idea(`Mail ${mk.gmail}`, gText, 1);
  const t3 = await th(gText, { type: "idea", source: "gmail" });
  await rev(i2, 1, gText, t3);
  // 4: a backfill run with --type other: linked, but the metadata says nothing of ideas
  const oText = `an observed idea ${mk.other}`;
  const i3 = await idea(`Other ${mk.other}`, oText, 1);
  const t4 = await th(oText, { type: "observation", source: "mcp" });
  await rev(i3, 1, oText, t4);
  // 5: an unlinked duplicate naming idea 1, its text the same as revision 1 (Kind spelled with a capital)
  const t5 = await th(capText, { kind: "Idea", idea_id: i1, note: mk.dup });
  // the cascade: an entity link with evidence quoting the idea, an edge between two idea thoughts (the queue rows the
  // insert trigger made stay as they are)
  const e = (await sql<{ id: string }>(`INSERT INTO public.entities (entity_type, canonical_name, normalized_name) VALUES ('topic', $1, lower($1)) RETURNING id::text AS id`, [`Topic ${mk.ent}`]))[0].id;
  await sql(`INSERT INTO public.thought_entities (thought_id, entity_id, mention_role, confidence, source, evidence) VALUES ($1::bigint, $2::bigint, 'mentioned', 0.87, 'entity_worker', $3::jsonb)`,
    [t1, e, JSON.stringify({ quote: `quoting ${mk.cap}` })]);
  await sql(`INSERT INTO public.thought_edges (from_thought_id, to_thought_id, relation, confidence) VALUES ($1::bigint, $2::bigint, 'evolved_into', 0.66)`, [t1, t2]);
  // the control: a thought that is no idea stays exactly where it is
  const t6 = await th(`an ordinary note ${mk.ctl}`, { type: "observation", source: "mcp" });
  const snap = await sql(SNAPSHOT);
  const ctl = (await sql<{ h: string }>(`SELECT md5(to_jsonb(t)::text) AS h FROM public.thoughts t WHERE id = $1::bigint`, [t6]))[0].h;
  await sql(`CREATE TABLE IF NOT EXISTS public.lab_idea_privacy_plant (k TEXT PRIMARY KEY, v JSONB NOT NULL)`);
  await sql(`INSERT INTO public.lab_idea_privacy_plant (k, v) VALUES ('plant', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [JSON.stringify({ A, B, mk, ideas: [i1, i2, i3], thoughts: [t1, t2, t3, t4, t5], control: t6, control_hash: ctl, snapshot: snap })]);
  console.log(`privacy plant: ${snap.length} idea-shaped thoughts in the shared corpus (5 planted + the fixtures'), 1 control`);
  assert(snap.length >= 5);
});

t("migrated", "no shared-corpus search finds any idea text - as the superuser, as the app role (the generic MCP lane), as B and as A", async () => {
  const p = await plant();
  const ideaMarkers = [p.mk.cap, p.mk.upd, p.mk.gmail, p.mk.other, p.mk.dup, p.mk.ent];
  for (const m of ideaMarkers) {
    assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.thoughts WHERE content LIKE '%' || $1 || '%' OR metadata::text LIKE '%' || $1 || '%'`, [m]))[0].n, 0, `thoughts still carry an idea marker (${ideaMarkers.indexOf(m)})`);
    // search / fetch / search_thoughts read thoughts as the app role
    assertEquals((await asApp<{ n: number }>(`SELECT count(*)::int AS n FROM public.thoughts WHERE content ILIKE '%' || $1 || '%'`, [m]))[0].n, 0, `the app role finds an idea marker (${ideaMarkers.indexOf(m)})`);
    // the cascade's evidence quoting the idea is gone from the shared graph too
    assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.thought_entities WHERE evidence::text LIKE '%' || $1 || '%'`, [m]))[0].n, 0, `thought_entities evidence carries an idea marker`);
  }
  // list_thoughts' type filter (type = idea) and every idea shape: none left in the shared corpus
  assertEquals((await asApp<{ n: number }>(`SELECT count(*)::int AS n FROM public.thoughts WHERE metadata ->> 'type' = 'idea'`))[0].n, 0, "idea-type thoughts left (app role)");
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.thoughts t WHERE ${IDEA_SHAPED}`))[0].n, 0, "idea-shaped thoughts left");
  // the contract search routes, as another user and as the owner: the shared knowledge holds no idea text
  for (const who of [p.B, p.A]) {
    for (const m of [p.mk.cap, p.mk.upd, p.mk.gmail, p.mk.other]) {
      const r = await call("GET", `/workbench/contract/search?q=${encodeURIComponent(m)}&kinds=page,claim,source`, who);
      assertEquals(r.status, 200);
      assert(!JSON.stringify(r.json.results ?? []).includes(m), `${who === p.B ? "B" : "A"}'s contract search returns an idea marker`);
    }
  }
  // the control thought is untouched
  assertEquals((await sql<{ h: string }>(`SELECT md5(to_jsonb(t)::text) AS h FROM public.thoughts t WHERE id = $1::bigint`, [p.control]))[0]?.h, p.control_hash, "the control thought changed");
});

t("migrated", "the archive holds exactly the rows removed (counts), and no app role can read it", async () => {
  const p = await plant();
  const removed = (p.snapshot as { id: string }[]).map((s) => s.id);
  const arch = await sql<{ id: string; owner: string }>(`SELECT id::text AS id, archive_owner_sub AS owner FROM public.idea_thought_archive ORDER BY id`);
  console.log(`privacy archive: ${arch.length} archived, ${removed.length} removed from the shared corpus`);
  assertEquals(arch.map((a) => a.id).sort(), [...removed].sort(), "the archive is not exactly the rows removed");
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.thoughts WHERE id = ANY($1::bigint[])`, [removed]))[0].n, 0);
  // the planted ones belong to A
  for (const id of p.thoughts as string[]) assertEquals(arch.find((a) => a.id === id)?.owner, p.A);
  // byte-identical copies: each archived row's thought columns hash as the snapshot did
  for (const s of p.snapshot as { id: string; row: string }[]) {
    const h = (await sql<{ h: string }>(`SELECT md5((SELECT jsonb_object_agg(k, v) FROM jsonb_each(to_jsonb(a)) j(k, v) WHERE k NOT LIKE 'archive\\_%')::text) AS h
                                           FROM public.idea_thought_archive a WHERE id = $1::bigint`, [s.id]))[0]?.h;
    assertEquals(h, s.row, "an archived row differs from the thought it copies");
  }
  for (const role of [APP_ROLE, "service_role", "authenticated", "anon"]) {
    const c = await pool!.connect();
    try {
      await c.queryObject("BEGIN");
      await c.queryObject(`SET LOCAL ROLE ${role}`);
      let code = "";
      try { await c.queryObject(`SELECT count(*) FROM public.idea_thought_archive`); } catch (e) { code = String((e as { fields?: { code?: string } }).fields?.code ?? ""); }
      assertEquals(code, "42501", `${role} can read the archive`);
    } finally {
      try { await c.queryObject("ROLLBACK"); } catch { /* */ }
      c.release();
    }
  }
});

t("migrated", "A still reads every revision of every idea through the workbench; B reads none", async () => {
  const p = await plant();
  const want: Record<string, [number[], string[]]> = {
    [p.ideas[0]]: [[1, 2], [p.mk.cap, p.mk.upd]], [p.ideas[1]]: [[1], [p.mk.gmail]], [p.ideas[2]]: [[1], [p.mk.other]],
  };
  for (const [id, [revs, marks]] of Object.entries(want)) {
    const r = await call("GET", `/workbench/contract/ideas/${id}`, p.A);
    assertEquals(r.status, 200);
    // deno-lint-ignore no-explicit-any
    assertEquals(r.json.revisions.map((v: any) => v.revision), revs, "A's revisions");
    for (const m of marks) assert(r.text.includes(m), "A's revision text");
    assert((await call("GET", `/workbench/contract/ideas/${id}`, p.B)).status === 404, "B reads A's idea");
  }
  // the private plane: the revisions name their owner and no thought
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.idea_revisions WHERE idea_id = ANY($1::uuid[]) AND (thought_id IS NOT NULL OR private_owner IS DISTINCT FROM $2)`, [p.ideas, p.A]))[0].n, 0);
  assertEquals(await refusedAsApp(`UPDATE public.idea_revisions SET private_owner = 'someone-else' WHERE private_owner IS NOT NULL`), "42501");
});

t("reverted", "the revert restores every thought byte-identical, with its entity links, edges, queue row and revision links; no archive is left", async () => {
  const p = await plant();
  const now = await sql<Record<string, string>>(SNAPSHOT);
  assertEquals(now.length, p.snapshot.length, "the number of idea-shaped thoughts");
  for (const s of p.snapshot as Record<string, string>[]) {
    const n = now.find((x) => x.id === s.id);
    assert(n, "a thought did not come back");
    for (const k of ["row", "ent", "edg", "que", "rev"]) assertEquals(n[k], s[k], `${k} differs after the revert`);
  }
  assertEquals((await sql<{ r: string | null }>(`SELECT to_regclass('public.idea_thought_archive')::text AS r`))[0].r, null, "the archive is left");
  assertEquals((await sql<{ h: string }>(`SELECT md5(to_jsonb(t)::text) AS h FROM public.thoughts t WHERE id = $1::bigint`, [p.control]))[0]?.h, p.control_hash, "the control thought changed");
});
