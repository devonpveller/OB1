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
// round 2: the lab vault (rw), the viewer and PostgREST behind the OB1 rest Caddy (the compile's / reconcile's write path)
const VAULT = (Deno.env.get("PRIVACY_VAULT") ?? "").replace(/\/+$/, "");
const VIEWER = (Deno.env.get("PRIVACY_VIEWER") ?? "").replace(/\/+$/, "");
const REST = (Deno.env.get("OPEN_BRAIN_URL") ?? "http://openbrain-rest").replace(/\/+$/, "");
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
  const mk = { short2: `PrivShortA${rnd}`, short5: `PrivShortB${rnd}`, cap: `PrivCapture${rnd}`, upd: `PrivUpdate${rnd}`, gmail: `PrivGmail${rnd}`, other: `PrivOther${rnd}`, dup: `PrivDup${rnd}`,
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
  // round 3: idea texts of a real idea's length (a run of 8 words is the fragment rule; a short text matches whole)
  const capText = `an idea ${mk.cap} about routing the gateway through one queue per tenant`;
  const updText = `the idea, sharper ${mk.upd}: every tenant gets its own admission queue and its own budget`;
  const i1 = await idea(`Idea ${mk.cap}`, updText, 2);
  const t1 = await th(capText, { type: "idea", source: "mcp", kind: "idea", idea_id: i1, exposure: "ops" });
  const t2 = await th(updText, { type: "idea", source: "mcp", kind: "idea", idea_id: i1, exposure: "ops" });
  await rev(i1, 1, capText, t1);
  await rev(i1, 2, updText, t2);
  // 3: migrate-ideas-backfill.py from a gmail capture (type idea, no idea_id: linked only through the revision)
  const gText = `a mailed idea ${mk.gmail} about a weekly digest of saved research for the whole team`;
  const i2 = await idea(`Mail ${mk.gmail}`, gText, 1);
  const t3 = await th(gText, { type: "idea", source: "gmail" });
  await rev(i2, 1, gText, t3);
  // 4: a backfill run with --type other: linked, but the metadata says nothing of ideas
  const oText = `an observed idea ${mk.other} about tagging every source with the date it was retrieved`;
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
  // round 4 (the operator's Option A for review R2): two SHORT ideas, 2 and 5 words, each with its pre-370 thought. A
  // short idea never withholds a page by its text - only its leaf and the pages that link it
  const s2Text = `${mk.short2} radar`, s5Text = `pocket ${mk.short5} for tiny notes`;
  const i4 = await idea(`Short ${mk.short2}`, s2Text, 1);
  const t7 = await th(s2Text, { type: "idea", source: "mcp", kind: "idea", idea_id: i4 });
  await rev(i4, 1, s2Text, t7);
  const i5 = await idea(`Short ${mk.short5}`, s5Text, 1);
  const t8 = await th(s5Text, { type: "idea", source: "mcp", kind: "idea", idea_id: i5 });
  await rev(i5, 1, s5Text, t8);
  const snap = await sql(SNAPSHOT);
  const ctl = (await sql<{ h: string }>(`SELECT md5(to_jsonb(t)::text) AS h FROM public.thoughts t WHERE id = $1::bigint`, [t6]))[0].h;
  // round 2 (tester F1): the wiki's copies, as the entity wiki compiles them - each page's vault FILE first, then its
  // row (newer than the file, so the viewer presents it): the idea thought's leaf, an entity page quoting idea 1's
  // revision 2 and citing the leaf, a source page quoting the mailed idea, a person's note quoting the observed idea,
  // and a control page that shows no idea
  const pages: Record<string, { page_class: string; entity_type: string | null; title: string; body: string; links: string[] }> = {
    [`content/thought/${t1}`]: { page_class: "thought", entity_type: null, title: `Thought ${t1}`, body: capText, links: [] },
    [`content/topic/privacy-topic-${rnd}`]: { page_class: "entity", entity_type: "topic", title: `Privacy topic ${rnd}`,
      body: `A topic page. It cites: ${updText} [[content/thought/${t1}]]`, links: [`content/thought/${t1}`] },
    [`content/source/${crypto.randomUUID()}`]: { page_class: "source", entity_type: null, title: `Mail ${rnd}`, body: `Excerpt: ${gText}.`, links: [] },
    [`notes/privacy-note-${rnd}`]: { page_class: "note", entity_type: null, title: `Note ${rnd}`, body: `My note says ${oText} too.`, links: [] },
  };
  const r2Withheld = [`content/thought/${t1}`, `content/topic/privacy-topic-${rnd}`];
  const controlSlug = `content/topic/privacy-control-${rnd}`;
  pages[controlSlug] = { page_class: "entity", entity_type: "topic", title: `Control ${rnd}`, body: `A shared page ${mk.ctl}, no idea in it.`, links: [] };
  if (VAULT) {
    for (const [slug, pg] of Object.entries(pages)) {
      const f = `${VAULT}/${slug}.md`;
      await Deno.mkdir(f.slice(0, f.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(f, `---\ntitle: ${pg.title}\n---\n${pg.body}\n`);
    }
    await new Promise((r) => setTimeout(r, 1100)); // the row is newer than its file
  }
  // round 4 (the operator's bar, 2026-11-03): the wiki rule is the idea's PRESENTATION - its leaf, and pages that LINK
  // it - never shared wording. "shapes" must be withheld; "keep" must stay, and the text-only shapes of rounds 2-3 are
  // in "keep" now (general knowledge that shares wording with an idea). The 8-word fragment comes first: on the round-3
  // base it is withheld, and the RED names it
  const page = (page_class: string, title: string, body: string, links: string[] = []) =>
    ({ page_class, entity_type: page_class === "entity" ? "topic" : null, title, body, links });
  const capWords = capText.split(" ");
  const shapes: Record<string, ReturnType<typeof page>> = {
    [`content/topic/r3-barelink-${rnd}`]: page("entity", "R3 bare link", `As noted, ${mk.cap} [[thought/${t1}]].`),
    [`content/topic/r3-plainlink-${rnd}`]: page("entity", "R3 plain link", `see thought/${t1} for it`),
    [`content/topic/r4-title-link-${rnd}`]: page("entity", `About thought/${t2}`, "A page whose title links the idea."),
    [`content/thought/${t7}`]: page("thought", `Thought ${t7}`, s2Text),
    [`content/topic/r4-short-link-${rnd}`]: page("entity", "R4 short idea link", `see [[thought/${t8}]] for that one`),
  };
  const keep: Record<string, ReturnType<typeof page>> = {
    [`content/topic/r3-fragment-${rnd}`]: page("entity", "R3 fragment", `It recalls: ${updText.split(" ").slice(2).join(" ")}`),
    [`content/source/r3-upper-${rnd}`]: page("source", "R3 upper", `Excerpt: ${capText.toUpperCase()}.`),
    [`content/source/r3-split-${rnd}`]: page("source", "R3 split", `Excerpt: ${capWords.slice(0, 5).join(" ")}\n${capWords.slice(5).join(" ")}`),
    [`content/source/r3-dblspace-${rnd}`]: page("source", "R3 double space", `Excerpt: ${capWords.join("  ")}.`),
    [`content/source/r3-markdown-${rnd}`]: page("source", "R3 markdown", `an idea **${mk.cap}** about _routing the gateway_ through one queue per tenant`),
    [`content/source/r3-quote-${rnd}`]: page("source", "R3 blockquote", `> ${capWords.slice(0, 5).join(" ")}\n> ${capWords.slice(5).join(" ")}`),
    [`notes/r3-title-only-${rnd}`]: page("note", capText, "A clean body."),
    [`content/topic/r3-eight-${rnd}`]: page("entity", "R3 eight words", "about a weekly digest of saved research for"),
    [`content/topic/r3-seven-${rnd}`]: page("entity", "R3 seven words", "about a weekly digest of saved research"),
    [`content/topic/r3-prefix-${rnd}`]: page("entity", "R3 prefix ids", `cites [[thought/${t1}0]] and content/thought/${t1}1`, [`content/thought/${t1}2`]),
    [`content/topic/r3-afterthought-${rnd}`]: page("entity", "R3 afterthought", `an afterthought/${t1} is not a link`),
    [`content/topic/r3-ctl-thought-${rnd}`]: page("entity", "R3 control thought", `cites [[content/thought/${t6}]]`, [`content/thought/${t6}`]),
    [`content/topic/r3-guard-${rnd}`]: page("entity", "R3 guard target", "A clean guard target."),
    [`content/topic/r4-short-words-${rnd}`]: page("entity", "R4 short idea words", `notes: ${s2Text} and also ${s5Text} appear here`),
  };
  // the pages a compile wrote BEFORE slot 380: the chain's guard is already on in this lab (it knows every revision as
  // it is written), so they are planted with triggers off, as the superuser - the state a live database is in today
  const c = await pool!.connect();
  try {
    await c.queryObject("BEGIN");
    await c.queryObject("SET LOCAL session_replication_role = replica");
    for (const [slug, pg] of [...Object.entries(pages), ...Object.entries(shapes), ...Object.entries(keep)]) {
      await c.queryObject(`INSERT INTO public.wiki_pages (slug, page_class, entity_type, title, body, links) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [slug, pg.page_class, pg.entity_type, pg.title, pg.body, JSON.stringify(pg.links)]);
    }
    await c.queryObject("COMMIT");
  } catch (e) {
    try { await c.queryObject("ROLLBACK"); } catch { /* */ }
    throw e;
  } finally {
    c.release();
  }
  const wikiAll = Object.fromEntries((await sql<{ slug: string; h: string }>(`SELECT slug, md5(to_jsonb(w)::text) AS h FROM public.wiki_pages w`)).map((r) => [r.slug, r.h]));
  await sql(`CREATE TABLE IF NOT EXISTS public.lab_idea_privacy_plant (k TEXT PRIMARY KEY, v JSONB NOT NULL)`);
  await sql(`INSERT INTO public.lab_idea_privacy_plant (k, v) VALUES ('plant', $1::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [JSON.stringify({ A, B, mk, ideas: [i1, i2, i3], thoughts: [t1, t2, t3, t4, t5], control: t6, control_hash: ctl, snapshot: snap,
      capText, updText, gText,
      // round 4: of the round-2 pages, the leaf and the entity page that links it are withheld; the source page and the
      // note that only quote an idea, and the control, are general knowledge and stay
      wiki: { pages, withheld: [...r2Withheld, ...Object.keys(shapes)], control: controlSlug, all: wikiAll, files: !!VAULT,
              shapes: Object.keys(shapes), keep: [...Object.keys(keep), ...Object.keys(pages).filter((x) => !r2Withheld.includes(x))], keepPages: keep,
              guard: `content/topic/r3-guard-${rnd}` } })]);
  console.log(`privacy plant: ${snap.length} idea-shaped thoughts in the shared corpus (5 planted + the fixtures'), 1 control; ` +
    `${Object.keys(pages).length - 1} wiki pages showing idea text + 1 control page${VAULT ? ", each with its vault file" : ""}`);
  assert(snap.length >= 5);
  // positive control: before slot 380, B's page search DOES find the leaf's text (the probe can see a leak)
  const r = await call("GET", `/workbench/contract/search?q=${encodeURIComponent(mk.cap)}&kinds=page`, B);
  assert(JSON.stringify(r.json.results ?? []).includes(mk.cap), "positive control: B's page search should find the planted leaf before 380");
});

t("migrated", "the wiki: the idea's presentation (its leaf, pages linking it) is withheld and no page surface serves it or a link to it; general pages that share wording stay; archive = withheld; the guard refuses the leaf and the link on the compile / reconcile write path, never the text; a rebuilt page without the link is let back", async () => {
  const p = await plant();
  const w = p.wiki;
  const ideaIds = (await sql<{ id: string }>(`SELECT id::text AS id FROM public.idea_thought_archive`)).map((r) => r.id);
  const linksAnIdea = (txt: string) => ideaIds.some((id) => new RegExp(`(^|[^A-Za-z0-9])thought/${id}(?![0-9])`).test(txt));
  // the withheld pages are gone; the general ones that only share wording are still there, unchanged
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.wiki_pages WHERE slug = ANY($1::text[])`, [w.withheld]))[0].n, 0, "a withheld page is back (the reconcile repair ran with its file present)");
  for (const s of w.keep) {
    const h = (await sql<{ h: string }>(`SELECT md5(to_jsonb(x)::text) AS h FROM public.wiki_pages x WHERE slug = $1`, [s]))[0]?.h;
    assertEquals(h, w.all[s], `a general page was withheld or changed: ${s.replace(/-[0-9a-f]{8}$/, "")}`);
  }
  // no page anywhere links an archived idea thought
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.wiki_pages x WHERE public.idea_privacy_page_links_idea(x.slug, x.title, x.body, x.links)`))[0].n, 0, "a page still links an idea");
  // B's (and A's) page search and every-kind search: no withheld page, no link to an idea
  for (const who of [p.B, p.A]) {
    for (const m of [p.mk.cap, p.mk.upd, p.mk.gmail, p.mk.other]) {
      for (const k of ["&kinds=page", ""]) {
        const r = await call("GET", `/workbench/contract/search?q=${encodeURIComponent(m)}${k}`, who);
        assertEquals(r.status, 200);
        const res = JSON.stringify(r.json.results ?? []);
        assert(!w.withheld.some((s: string) => res.includes(s)), `${who === p.B ? "B" : "A"}'s search ${k || "(every kind)"} returns a withheld page`);
        assert(!linksAnIdea(res), `${who === p.B ? "B" : "A"}'s search ${k || "(every kind)"} returns a link to an idea`);
      }
    }
  }
  // the archive is exactly the pages removed, each byte-identical to what it was
  const now = new Set((await sql<{ slug: string }>(`SELECT slug FROM public.wiki_pages`)).map((r) => r.slug));
  const removed = Object.keys(w.all).filter((s) => !now.has(s)).sort();
  const arch = await sql<{ slug: string; h: string }>(`SELECT slug, md5((SELECT jsonb_object_agg(k, v) FROM jsonb_each(to_jsonb(a)) j(k, v) WHERE k NOT LIKE 'archive\\_%')::text) AS h FROM public.idea_wiki_archive a ORDER BY slug`);
  console.log(`privacy wiki archive: ${arch.length} archived, ${removed.length} removed from wiki_pages`);
  assertEquals(arch.map((a) => a.slug).sort(), removed, "the wiki archive is not exactly the pages removed");
  for (const a of arch) assertEquals(a.h, w.all[a.slug], "an archived page differs from the page it copies");
  for (const s of w.withheld) assert(arch.some((a) => a.slug === s), "a planted leaf / linking page was not withheld");
  for (const role of [APP_ROLE, "service_role", "authenticated", "anon"]) {
    const c = await pool!.connect();
    try {
      await c.queryObject("BEGIN");
      await c.queryObject(`SET LOCAL ROLE ${role}`);
      let code = "";
      try { await c.queryObject(`SELECT count(*) FROM public.idea_wiki_archive`); } catch (e) { code = String((e as { fields?: { code?: string } }).fields?.code ?? ""); }
      assertEquals(code, "42501", `${role} can read the wiki archive`);
    } finally {
      try { await c.queryObject("ROLLBACK"); } catch { /* */ }
      c.release();
    }
  }
  // the viewer: a withheld page is not served (its row is gone and its file was moved out - the deploy step)
  if (VIEWER) {
    for (const s of w.withheld) {
      const v = await fetch(`${VIEWER}/${s}`);
      const body = await v.text();
      assert(!body.includes(String(p.mk.cap)) && !linksAnIdea(body), `the viewer serves a withheld page (${w.withheld.indexOf(s)}, status ${v.status})`);
    }
  }
  // the guard, on the write path the compile and the viewer's reconcile repair use (PostgREST upsert on slug)
  const rest = async (method: string, path: string, body: unknown, prefer: string) =>
    await fetch(`${REST}/rest/v1/${path}`, { method, headers: { "content-type": "application/json", apikey: "local-trust", prefer }, body: JSON.stringify(body) });
  const r2 = (w.withheld as string[]).filter((s) => w.pages[s]);   // the round-2 leaf and linking entity page
  const up = await rest("POST", "wiki_pages?on_conflict=slug", r2.map((s) => ({ slug: s, ...w.pages[s], tags: [], frontmatter: {}, updated_at: new Date().toISOString() })),
    "resolution=merge-duplicates,return=minimal");
  await up.body?.cancel();
  assert(up.ok, `the compile's batch upsert failed outright (${up.status}): one withheld row must not fail the batch`);
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.wiki_pages WHERE slug = ANY($1::text[])`, [r2]))[0].n, 0, "the guard let the leaf or the linking page back in");
  const note = await rest("POST", "wiki_pages?on_conflict=slug", [{ slug: `notes/r4-note-link-${String(p.A).slice(-8)}`, page_class: "note", entity_type: null, title: "A note",
    body: `my note links [[content/thought/${ideaIds[0]}]]`, links: [], tags: [], frontmatter: {}, updated_at: new Date().toISOString() }], "resolution=merge-duplicates,return=minimal");
  await note.body?.cancel();
  assert(!note.ok, "a note linking an idea is refused out loud");
  const ctlBefore = (await sql<{ h: string }>(`SELECT md5(to_jsonb(x)::text) AS h FROM public.wiki_pages x WHERE slug = $1`, [w.control]))[0].h;
  const patch = await rest("PATCH", `wiki_pages?slug=eq.${encodeURIComponent(w.control)}`, { body: `now citing [[content/thought/${ideaIds[0]}]]` }, "return=minimal");
  await patch.body?.cancel();
  assertEquals((await sql<{ h: string }>(`SELECT md5(to_jsonb(x)::text) AS h FROM public.wiki_pages x WHERE slug = $1`, [w.control]))[0].h, ctlBefore, "an update adding a link to an idea went through");
  // a page the compiler REBUILDS without the idea, under the withheld entity slug, is let back (then removed, so the
  // revert's check stays exact) - even when it shares wording with the idea: wording is general knowledge
  const entitySlug = r2.find((s) => w.pages[s].page_class === "entity")!;
  const rebuilt = await rest("POST", "wiki_pages?on_conflict=slug", [{ slug: entitySlug, ...w.pages[entitySlug],
    body: `A topic page, rebuilt from shared sources only. It mentions ${p.updText}.`, links: [], tags: [], frontmatter: {}, updated_at: new Date().toISOString() }],
    "resolution=merge-duplicates,return=minimal");
  await rebuilt.body?.cancel();
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.wiki_pages WHERE slug = $1`, [entitySlug]))[0].n, 1, "a rebuilt page without the link was refused");
  await sql(`DELETE FROM public.wiki_pages WHERE slug = $1`, [entitySlug]);
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
      // round 4: pages follow the presentation rule (the wiki test); claims and sources must carry no idea text
      const r = await call("GET", `/workbench/contract/search?q=${encodeURIComponent(m)}&kinds=claim,source`, who);
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

t("migrated", "round 4: the idea's leaf and every link form are withheld (bare / plain thought links, a link in the title, a short idea's leaf and link); a general page that shares wording - 8 words or more, a fragment, any case or markup, the title, a short idea's words - is KEPT, and so are other ids and other thoughts; the guard refuses a link or the leaf as an app-role UPDATE and a PostgREST PATCH, and lets text through", async () => {
  const p = await plant();
  const w = p.wiki;
  const present = async (slug: string) => (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.wiki_pages WHERE slug = $1`, [slug]))[0].n === 1;
  const archived = new Set((await sql<{ slug: string }>(`SELECT slug FROM public.idea_wiki_archive`)).map((r) => r.slug));
  for (const s of w.shapes) {
    assert(!(await present(s)), `a leaf / linking page is still a page: ${s.replace(/-[0-9a-f]{8}$/, "")}`);
    assert(archived.has(s), `a leaf / linking page was not archived: ${s.replace(/-[0-9a-f]{8}$/, "")}`);
  }
  for (const s of Object.keys(w.keepPages)) {
    assert(await present(s), `a general page was withheld: ${s.replace(/-[0-9a-f]{8}$/, "")}`);
    assertEquals((await sql<{ h: string }>(`SELECT md5(to_jsonb(x)::text) AS h FROM public.wiki_pages x WHERE slug = $1`, [s]))[0].h, w.all[s], "a general page changed");
  }
  console.log(`privacy round 4: ${w.shapes.length} leaf / link pages withheld, ${Object.keys(w.keepPages).length} general pages kept`);
  // the guard, on the clean guard target, as the app role (UPDATE of body, title, links, slug) and through PostgREST
  const g = w.guard;
  const t1 = String(p.thoughts[0]);
  const row = async () => (await sql<{ h: string }>(`SELECT coalesce((SELECT md5(slug || '|' || title || '|' || body || '|' || links::text) FROM public.wiki_pages WHERE slug = $1), 'gone') AS h`, [g]))[0].h;
  const asAppTx = async (text: string, args: unknown[]) => {
    const c = await pool!.connect();
    try {
      await c.queryObject("BEGIN");
      await c.queryObject(`SET LOCAL ROLE ${APP_ROLE}`);
      const r = await c.queryObject(text, args);
      await c.queryObject("COMMIT");
      return r.rowCount ?? 0;
    } catch (e) {
      try { await c.queryObject("ROLLBACK"); } catch { /* */ }
      throw e;
    } finally {
      c.release();
    }
  };
  const gp = w.keepPages[g];
  const restore = async () => {
    const c = await pool!.connect();
    try {
      await c.queryObject("BEGIN");
      await c.queryObject("SET LOCAL session_replication_role = replica");
      await c.queryObject(`UPDATE public.wiki_pages SET slug = $1, title = $2, body = $3, links = $4::jsonb
                            WHERE slug = $1 OR (slug = $5 AND title IS DISTINCT FROM 'Thought ' || $6)`,
        [g, gp.title, gp.body, JSON.stringify(gp.links), `content/thought/${t1}`, t1]);
      await c.queryObject("COMMIT");
    } catch (e) {
      try { await c.queryObject("ROLLBACK"); } catch { /* */ }
      throw e;
    } finally {
      c.release();
    }
  };
  try {
    // text goes THROUGH (general knowledge): the whole idea text upper-cased, an 8-word fragment, the whole text as the title
    const through: [string, string, unknown[]][] = [
      ["body := the text upper-cased", `UPDATE public.wiki_pages SET body = $2 WHERE slug = $1`, [g, String(p.capText).toUpperCase()]],
      ["body := an 8-word fragment", `UPDATE public.wiki_pages SET body = $2 WHERE slug = $1`, [g, `now: ${String(p.updText).split(" ").slice(2).join(" ")}`]],
      ["title := the whole text", `UPDATE public.wiki_pages SET title = $2 WHERE slug = $1`, [g, p.capText]],
    ];
    for (const [name, text, args] of through) {
      const before = await row();
      assertEquals(await asAppTx(text, args), 1, `the app role cannot update a page at all (${name})`);
      assert((await row()) !== before, `the guard refused text, which is general knowledge: ${name}`);
    }
    await restore();
    const clean = await row();
    // a link or the leaf is REFUSED
    const refused: [string, string, unknown[]][] = [
      ["body := a bare [[thought/<id>]]", `UPDATE public.wiki_pages SET body = $2 WHERE slug = $1`, [g, `see [[thought/${t1}]]`]],
      ["body := a plain thought/<id>", `UPDATE public.wiki_pages SET body = $2 WHERE slug = $1`, [g, `see thought/${t1} there`]],
      ["title := a link", `UPDATE public.wiki_pages SET title = $2 WHERE slug = $1`, [g, `About content/thought/${t1}`]],
      ["links := [thought/<id>]", `UPDATE public.wiki_pages SET links = $2::jsonb WHERE slug = $1`, [g, JSON.stringify([`thought/${t1}`])]],
      ["slug := the idea leaf's slug", `UPDATE public.wiki_pages SET slug = $2 WHERE slug = $1`, [g, `content/thought/${t1}`]],
    ];
    for (const [name, text, args] of refused) {
      await asAppTx(text, args);
      assertEquals(await row(), clean, `the guard let an app-role UPDATE through: ${name}`);
    }
    const patch = await fetch(`${REST}/rest/v1/wiki_pages?slug=eq.${encodeURIComponent(g)}`, {
      method: "PATCH", headers: { "content-type": "application/json", apikey: "local-trust", prefer: "return=minimal" }, body: JSON.stringify({ title: `See thought/${t1}` }),
    });
    await patch.body?.cancel();
    assertEquals(await row(), clean, "the guard let a PostgREST PATCH adding a link through");
  } finally {
    await restore();
  }
  assertEquals((await sql<{ h: string }>(`SELECT md5(to_jsonb(x)::text) AS h FROM public.wiki_pages x WHERE slug = $1`, [g]))[0].h, w.all[g], "the guard target did not return to its planted state");
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
  // round 2: every wiki page as it was (the withheld ones byte-identical), no wiki archive, no guard left
  const wiki = Object.fromEntries((await sql<{ slug: string; h: string }>(`SELECT slug, md5(to_jsonb(w)::text) AS h FROM public.wiki_pages w`)).map((r) => [r.slug, r.h]));
  for (const s of p.wiki.withheld) assertEquals(wiki[s], p.wiki.all[s], "a withheld page did not come back byte-identical");
  for (const s of p.wiki.keep ?? []) assertEquals(wiki[s], p.wiki.all[s], "a round-3 control page changed");
  assertEquals(wiki[p.wiki.control], p.wiki.all[p.wiki.control], "the control page changed");
  assertEquals((await sql<{ r: string | null }>(`SELECT to_regclass('public.idea_wiki_archive')::text AS r`))[0].r, null, "the wiki archive is left");
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_idea_privacy_wiki_guard'`))[0].n, 0, "the guard is left");
});
