// deno test src/documents/documents_integration_test.ts - the documents API (research-workbench P2b)
// over a REAL workbench and database.
//
// SKIPPED unless DOCS_TEST_BASE is set. contract-test/run-workspace-tests.ps1 sets it to the :wt
// workbench it runs on a DISPOSABLE internal network (the real initdb chain, contract-test/fixtures.sql,
// a temp vault, a stub embedder, a stub research service, a stub egress proxy). Never point it at a
// live stack: the tests write documents, suppress sources and install a fault trigger.
//
// Environment: DOCS_TEST_BASE, DOCS_TEST_KEY (the X-Brain-Key), DOCS_TEST_VAULT (the vault the
// workbench writes, mounted here too), CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser - the
// fault trigger needs it), DOCS_TEST_PROXY_HOST (the stub proxy's name, for a held link's URL).
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";
import { parseDocument } from "./grammar.ts";

const BASE = (Deno.env.get("DOCS_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("DOCS_TEST_KEY") ?? "";
const VAULT = Deno.env.get("DOCS_TEST_VAULT") ?? "/vault";
const PROXY_HOST = Deno.env.get("DOCS_TEST_PROXY_HOST") ?? "stub-proxy";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 3, true)
  : null;

const FX = {
  active: "11111111-1111-4111-8111-111111111111", suppressed: "22222222-2222-4222-8222-222222222222",
  unlinked: "33333333-3333-4333-8333-333333333333", synthesis: "77777777-7777-4777-8777-777777777777",
  claim: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", idea: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  job: "99999999-9999-4999-8999-999999999999", refSrc: "f1000000-0000-4000-8000-000000000001",
  page: "content/tool/tool-fixture",
};

const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}

// The lab workbench runs with WORKSPACE_IDENTITY_HEADER=X-Test-Sub (the seam's extension point), so a test
// can act as a second user; without the header every call is the seam's default identity ("operator").
const SUB_HEADER = Deno.env.get("DOCS_TEST_SUB_HEADER") ?? "X-Test-Sub";
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json", "x-brain-key": KEY, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  return { status: r.status, json, text };
}

const D = "/workbench/documents";
const uid = () => crypto.randomUUID().slice(0, 8);
const file = async (rel: string) => await Deno.readTextFile(`${VAULT}/${rel}`);
const exists = async (rel: string) => {
  try {
    await Deno.stat(`${VAULT}/${rel}`);
    return true;
  } catch {
    return false;
  }
};

async function newDoc(title: string, body = "", idea?: string) {
  const r = await call("POST", D, { title, body, ...(idea ? { idea } : {}) });
  assertEquals(r.status, 201, r.text);
  return r.json.path as string;
}

async function save(path: string, content: string) {
  const cur = await call("GET", `${D}/file?path=${encodeURIComponent(path)}`);
  return await call("PUT", `${D}/file?path=${encodeURIComponent(path)}`, { content, if_match: cur.json.hash });
}

async function listing(path: string) {
  return (await sql<{ title: string; outbound_links: any[]; refinery_id: string | null; updated_at: Date }>(
    `SELECT title, outbound_links, refinery_id::text AS refinery_id, updated_at FROM public.user_document_listings WHERE path = $1`, [path],
  ))[0] ?? null;
}

async function newSource(content: string, title = `src ${uid()}`) {
  const id = crypto.randomUUID();
  await sql(`INSERT INTO public.sources (id, url, title, content, content_type) VALUES ($1, $2, $3, $4, 'web_article')`,
    [id, `https://example.org/p2b/${id}`, title, content]);
  await sql(`INSERT INTO public.source_chunks (source_id, idx, content) VALUES ($1, 0, $2)`, [id, content]);
  return id;
}

async function newRevision(id: string, content: string) {
  await sql(
    `INSERT INTO public.source_revisions (source_id, revision, content, title, edited_by)
     SELECT $1, COALESCE(max(revision), 1) + 1, $2, 'revised', 'p2b-test' FROM public.source_revisions WHERE source_id = $1`,
    [id, content],
  );
  await sql(`UPDATE public.sources SET content = $2 WHERE id = $1`, [id, content]);
  await sql(`UPDATE public.source_chunks SET content = $2 WHERE source_id = $1 AND idx = 0`, [id, content]);
}

const noPageRow = async (path: string) =>
  (await sql(`SELECT 1 FROM public.wiki_pages WHERE slug = $1 OR slug = $2 OR slug LIKE 'documents/%'`, [path, path.replace(/\.md$/, "")])).length === 0;

// ── C8: a user document created through the documents API ─────────────────────────────────
t("C8: created through the API -> its file and listing within 2 s, and no wiki_pages row", async () => {
  const t0 = performance.now();
  const path = await newDoc(`Created ${uid()}`, "Body text.");
  const read = await call("GET", `${D}/file?path=${encodeURIComponent(path)}`);
  const list = await call("GET", `/workbench/contract/documents`);
  const ms = performance.now() - t0;
  assertEquals(read.status, 200);
  assert(read.json.content.includes("Body text."));
  assert(list.json.documents.some((d: any) => d.path === path), "listed through the contract's documents call");
  assert(ms < 2000, `create + open took ${ms.toFixed(0)} ms`);
  assert(path.startsWith("documents/"));
  assert(await noPageRow(path), "a user document is never a wiki page (D12)");
});

// ── C9: a save whose listing update fails ───────────────────────────────────────────────────
t("C9: listing update made to fail -> reported once (207 + one notification), file on disk, reconcile repairs it", async () => {
  const path = await newDoc(`Fault ${uid()}`);
  await sql(`CREATE OR REPLACE FUNCTION public.p2b_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$
               BEGIN RAISE EXCEPTION 'p2b test fault: listing write refused'; END $$`);
  await sql(`CREATE TRIGGER p2b_test_fault BEFORE INSERT OR UPDATE ON public.user_document_listings
               FOR EACH ROW EXECUTE FUNCTION public.p2b_test_fault()`);
  let first, second;
  try {
    first = await save(path, `---\ntitle: "Renamed under fault"\n---\n\nlinks [[source:${FX.active}|a]]\n`);
    second = await save(path, `---\ntitle: "Renamed under fault"\n---\n\nlinks [[source:${FX.active}|a]] again\n`);
  } finally {
    await sql(`DROP TRIGGER IF EXISTS p2b_test_fault ON public.user_document_listings`);
    await sql(`DROP FUNCTION IF EXISTS public.p2b_test_fault()`);
  }
  for (const r of [first!, second!]) {
    assertEquals(r.status, 207, "never a silent 200");
    assertEquals(r.json.listing.ok, false);
  }
  const notes = await sql<{ count: number }>(
    `SELECT count FROM public.research_notifications WHERE entity = $1`, [`document:${path}`],
  );
  assertEquals(notes.length, 1, "one notification for the document, however many saves failed");
  assert((await file(path)).includes("again"), "the file is on disk");
  assertEquals((await listing(path))!.title !== "Renamed under fault", true, "the listing is stale until the reconcile");
  assert(await noPageRow(path));
  const rec = await call("POST", `${D}/reconcile`);
  assertEquals(rec.status, 200);
  assert(rec.json.repaired.includes(path), JSON.stringify(rec.json));
  const l = (await listing(path))!;
  assertEquals(l.title, "Renamed under fault");
  assert(l.outbound_links.some((x: any) => x.id === FX.active && x.reference_id), "links repaired, pinned");
});

// ── C10 + C11 + C13: the listing record ─────────────────────────────────────────────────────
t("C10/C11/C13: a save refreshes the listing's links; the record holds title, path, updated, links as ids - never the body", async () => {
  const sentinel = `zq-body-sentinel-${uid()}`;
  const path = await newDoc(`Listing ${uid()}`, sentinel);
  const r = await save(path, `# Listing\n\n${sentinel} [[source:${FX.active}|A]] [[${FX.page}|tool]] [[claim:${FX.claim}]]\n`);
  assertEquals(r.status, 200);
  const cols = (await sql<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_document_listings' ORDER BY 1`,
  )).map((c) => c.column_name);
  assertEquals(cols, ["actor_sub", "id", "outbound_links", "owner_sub", "path", "refinery_id", "title", "updated_at"]);
  const l = (await listing(path))!;
  assert(!JSON.stringify(l).includes(sentinel), "no body in the listing row");
  assertEquals(l.outbound_links.map((x: any) => [x.kind, x.id]).sort(), [["claim", FX.claim], ["page", FX.page], ["source", FX.active]].sort());
  for (const x of l.outbound_links) assertEquals(Object.keys(x).sort(), ["id", "kind", "pin", "reference_id"], "ids, never copies");
  const c = await call("GET", `/workbench/contract/documents`);
  const d = c.json.documents.find((x: any) => x.path === path);
  assertEquals(Object.keys(d).sort(), ["outbound_links", "path", "title", "updated"]);
  assert(!c.text.includes(sentinel));
  // the listing lives in its own table, never wiki_pages
  assert(await noPageRow(path));
});

t("C13: a suppressed source's dependence counts the user documents that link it (the listing's links)", async () => {
  const s = await newSource("A source a user document links, then suppressed.");
  const path = await newDoc(`Dependence ${uid()}`, `[[source:${s}|it]]`);
  const sup = await call("POST", `/workbench/contract/sources/${s}/suppress`, { reason: "p2b test" });
  assertEquals(sup.status, 200, sup.text);
  const dep = await call("GET", `/workbench/contract/sources/${s}/dependence`);
  assertEquals(dep.json.counts.document_link, 1, dep.text);
  assert(dep.json.connections.some((c: any) => c.kind === "document_link" && c.ref === path));
});

// ── C14: see all citations of this source ───────────────────────────────────────────────────
t("C14: citations of a source = the D5 lookup over the listing links; each dropped-in reference is a pinned P2a row", async () => {
  const s = await newSource("Citations fixture text: the quoted bit is here.");
  const a = await newDoc(`Cites A ${uid()}`, `[[source:${s}|s]]`);
  const b = await newDoc(`Cites B ${uid()}`);
  const placed = await call("POST", `${D}/references`, { path: b, source_id: s, exact: "the quoted bit", form: "chip" });
  assertEquals(placed.status, 201, placed.text);
  assertEquals(placed.json.record.pinned_revision, 1);
  assertEquals((await save(b, `chip ${placed.json.insert}\n`)).status, 200);
  const cites = await call("GET", `${D}/citations?source_id=${s}`);
  const dep = await call("GET", `/workbench/contract/sources/${s}/dependence`);
  const viaDep = dep.json.connections.filter((c: any) => c.kind === "document_link").map((c: any) => c.ref).sort();
  assertEquals(cites.json.documents.map((d: any) => d.path).sort(), [a, b].sort());
  assertEquals(cites.json.documents.map((d: any) => d.path).sort(), viaDep, "the same lookup as D5's dependence count");
  const held = await sql(
    `SELECT r.pinned_revision FROM public.reference_holders h JOIN public.reference_records r ON r.id = h.reference_id
      WHERE h.holder_kind = 'user_document' AND h.holder_ref = $1 AND r.source_id = $2`, [b, s],
  );
  assertEquals(held.map((x: any) => x.pinned_revision), [1]);
  // no source stores a back-link to a document
  const back = await sql(`SELECT 1 FROM public.sources WHERE id = $1 AND (metadata::text LIKE '%documents/%' OR content LIKE '%documents/%')`, [s]);
  assertEquals(back.length, 0);
});

// ── C1 / C2 / C3: pins, re-pins, the diff-id check ─────────────────────────────────────────
t("C1/C2: a transclusion pins the revision; a re-pin makes a NEW record and the broken-out chip keeps its own", async () => {
  const s = await newSource("Transclusion source text: pinned words live here.");
  const path = await newDoc(`Transclude ${uid()}`);
  const tr = await call("POST", `${D}/references`, { path, source_id: s, exact: "pinned words live here", form: "transclusion", chunk_idx: 0 });
  assertEquals(tr.status, 201, tr.text);
  assertEquals(tr.json.record.pinned_revision, 1);
  assertEquals(tr.json.record.chunk_idx, 0);
  assertEquals(tr.json.insert, `{{ref:${tr.json.record.id}}}pinned words live here{{/ref}}`);
  // the break leaves the chip on the SAME record; then the source moves on and the user re-pins a new transclusion
  await save(path, `pinned words live here [@ref:${tr.json.record.id}]\n`);
  await newRevision(s, "Transclusion source text, revised: pinned words live here.");
  const re = await call("POST", `${D}/references/${tr.json.record.id}/repin?path=${encodeURIComponent(path)}`);
  assertEquals(re.status, 201, re.text);
  assertNotEquals(re.json.record.id, tr.json.record.id);
  assertEquals(re.json.record.pinned_revision, 2);
  const old = await sql(`SELECT pinned_revision FROM public.reference_records WHERE id = $1`, [tr.json.record.id]);
  assertEquals(old[0].pinned_revision, 1, "the chip's record never moves");
});

t("C3: opening flags only references whose source has a newer revision - ids and revisions, no text", async () => {
  const s1 = await newSource("Stays the same: alpha words.");
  const s2 = await newSource("Will change: beta words.");
  const path = await newDoc(`Stale ${uid()}`);
  const a = await call("POST", `${D}/references`, { path, source_id: s1, exact: "alpha words", form: "chip" });
  const b = await call("POST", `${D}/references`, { path, source_id: s2, exact: "beta words", form: "chip" });
  await save(path, `${a.json.insert} and ${b.json.insert}\n`);
  await newRevision(s2, "Has changed: beta words.");
  const r = await call("POST", `/workbench/contract/diff-check`, { holder: { kind: "user_document", ref: path } });
  assertEquals(r.status, 200, r.text);
  const by = new Map(r.json.results.map((x: any) => [x.reference_id, x]));
  assertEquals((by.get(a.json.record.id) as any).out_of_date, false);
  assertEquals((by.get(b.json.record.id) as any).out_of_date, true);
  assert(!r.text.includes("words"), "no chunk text in the diff-id check");
});

// ── C12: document management (parity baseline) ─────────────────────────────────────────────
t("C12: create, folder create/delete, move, trash/restore, history + recover, properties, cited vs added references", async () => {
  const folder = `p2b-${uid()}`;
  assertEquals((await call("POST", `${D}/folders`, { path: folder })).status, 201);
  assert((await call("GET", `${D}/folders`)).json.folders.includes(folder));
  const path = await newDoc(`Managed ${uid()}`, "v1 text");
  await save(path, "# Managed\n\nv2 text\n");
  await call("PUT", `${D}/file?path=${encodeURIComponent(path)}&commit=1`, { content: "# Managed\n\nv3 text\n" });
  const mv = await call("POST", `${D}/move`, { from: path, to_folder: folder });
  assertEquals(mv.status, 200, mv.text);
  const moved = mv.json.to as string;
  assert(await exists(moved) && !(await exists(path)));
  assert(await listing(moved), "the listing moved with the file");
  const tr = await call("POST", `${D}/trash`, { path: moved });
  assertEquals(tr.status, 200);
  assert(tr.json.trashed.startsWith("documents/operator/.trash/"), tr.text);
  const rs = await call("POST", `${D}/restore`, { path: tr.json.trashed });
  assertEquals(rs.json.restored, moved);
  const h = await call("GET", `${D}/history?path=${encodeURIComponent(moved)}`);
  assert(h.json.commits.length >= 2, h.text);
  const create = h.json.commits[h.json.commits.length - 1];
  const rec = await call("POST", `${D}/recover`, { path: moved, from: create.hash });
  assertEquals(rec.status, 200, rec.text);
  const prop = await call("POST", `${D}/property`, { path: moved, key: "status", value: "draft" });
  assertEquals(prop.status, 200, prop.text);
  assert((await file(moved)).includes('status: "draft"'));
  // references: added (attached deliberately) vs cited (in the text)
  const added = await call("POST", `${D}/references`, { path: moved, source_id: FX.active, form: "added" });
  assertEquals(added.status, 201, added.text);
  await save(moved, `${await file(moved)}\n[[source:${FX.refSrc}|cited]]\n`);
  const refs = await call("GET", `${D}/references?path=${encodeURIComponent(moved)}`);
  const origins = refs.json.references.map((r: any) => [r.origin, r.source_id]).sort();
  assertEquals(origins, [["added", FX.active], ["cited", FX.refSrc]].sort());
  assertEquals((await call("DELETE", `${D}/references/${added.json.record.id}?path=${encodeURIComponent(moved)}`)).status, 200);
  // delete the folder: its documents go to the trash
  const del = await call("DELETE", `${D}/folders`, { path: folder });
  assertEquals(del.status, 200, del.text);
  assert(await exists(moved.replace(/^documents\/operator\//, "documents/operator/.trash/")));
});

t("C12: export of a user document - MD, TXT, DOCX and PDF through the export route", async () => {
  const path = await newDoc(`Export ${uid()}`, `Exported text citing [[source:${FX.active}|the active source]].`);
  for (const format of ["md", "txt", "docx", "pdf"]) {
    const r = await fetch(`${BASE}/workbench/export?path=${encodeURIComponent(path)}&format=${format}`, { headers: { "x-brain-key": KEY } });
    const bytes = new Uint8Array(await r.arrayBuffer());
    assertEquals(r.status, 200, `${format}: ${new TextDecoder().decode(bytes.slice(0, 300))}`);
    assert(bytes.length > 20, format);
    if (format === "md" || format === "txt") assert(new TextDecoder().decode(bytes).includes("Exported text citing"), format);
  }
});

// ── C15 / C16: the hub context, computed ───────────────────────────────────────────────────
t("C15/C16: the hub context is computed from the graph on read; no hub/topic table; no hub id on a document", async () => {
  const path = await newDoc(`Hubs ${uid()}`, `[[source:${FX.active}|a]] [[source:${FX.suppressed}|b]]`);
  const r = await call("GET", `${D}/hub-context?path=${encodeURIComponent(path)}`);
  assertEquals(r.status, 200, r.text);
  assertEquals(r.json.stored, false);
  const hub = r.json.hubs.find((h: any) => h.centre.slug === FX.page);
  assert(hub, `the shared neighbour is the computed centre: ${r.text}`);
  assertEquals(hub.seeds.length, 2);
  assertEquals(hub.thin, true, "two source pages around the centre is thin");
  assert(r.json.hubs.every((h: any) => h.centre.slug !== path), "the document is never a hub");
  // contested is computed: add a contradicting edge and read again
  const before = hub.contested;
  await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $2, 'contradicts') ON CONFLICT DO NOTHING`,
    [FX.claim, FX.active]);
  const again = (await call("GET", `${D}/hub-context?path=${encodeURIComponent(path)}`)).json.hubs.find((h: any) => h.centre.slug === FX.page);
  assertEquals([before, again.contested], [false, true]);
  await sql(`DELETE FROM public.claim_sources WHERE claim_id = $1 AND source_id = $2 AND edge_type = 'contradicts'`, [FX.claim, FX.active]);
  const tables = await sql(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name ~* 'hub' OR table_name ~* 'topic')`,
  );
  assertEquals(tables, [], "no hub or topic table");
  const cols = await sql(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name ~* 'hub'`,
  );
  assertEquals(cols, [], "no hub id column anywhere");
});

t("C15: the writing-surface tools: queue research and open a gap session, both ordinary sessions", async () => {
  const path = await newDoc(`Tools ${uid()}`);
  for (const kind of ["research", "gap"]) {
    const r = await call("POST", `${D}/research`, { path, query: `p2b ${kind} question`, kind });
    assertEquals(r.status, 202, r.text);
    const job = await call("GET", `/workbench/contract/sessions/${r.json.job_id}`);
    assertEquals(job.status, 200, job.text);
    assertEquals(job.json.origin, "workspace", "the workspace key decides the origin");
    const home = await call("GET", `/workbench/contract/jobs?kinds=research&limit=200`);
    assert(home.json.jobs.some((j: any) => j.id === r.json.job_id), "listed in the research home");
  }
});

// ── C17: seed a document from an idea (PROMOTE) ─────────────────────────────────────────────
t("C17: seeding from an idea: every source, claim and page drawn on is a pinned reference row; an ordinary user document", async () => {
  const ideaId = crypto.randomUUID();
  await sql(`INSERT INTO public.ideas (id, title, summary, status, dossier_source_id, last_job_id) VALUES ($1, $2, 'Seed me into a document.', 'researched', $3, $4)`,
    [ideaId, `Seed idea ${uid()}`, FX.synthesis, FX.job]);
  const r = await call("POST", `${D}/seed`, { idea_id: ideaId });
  assertEquals(r.status, 201, r.text);
  const path = r.json.path as string;
  assert(path.startsWith("documents/") && await exists(path));
  const idea = await call("GET", `/workbench/contract/ideas/${ideaId}`);
  assertEquals(idea.json.status, "promoted");
  assertEquals(idea.json.refinery.members.document.path, path);
  const held = await sql<{ source_id: string; pinned_revision: number }>(
    `SELECT r.source_id::text AS source_id, r.pinned_revision FROM public.reference_holders h JOIN public.reference_records r ON r.id = h.reference_id
      WHERE h.holder_kind = 'user_document' AND h.holder_ref = $1`, [path],
  );
  const pinned = new Set(held.map((h) => h.source_id));
  for (const s of idea.json.produced.sources) assert(pinned.has(s.id), `a reference row for source ${s.id}`);
  for (const c of idea.json.produced.claims) {
    const syn = await sql<{ synthesis_id: string }>(`SELECT synthesis_id::text AS synthesis_id FROM public.claims WHERE id = $1`, [c.id]);
    assert(pinned.has(syn[0].synthesis_id), `a reference row for claim ${c.id}'s report`);
    assert((await file(path)).includes(`[[claim:${c.id}`), "the claim is linked");
  }
  assert(pinned.has(FX.synthesis), "the dossier");
  for (const h of held) assert(h.pinned_revision >= 1);
  assert(await noPageRow(path));
  assertEquals((await call("POST", `${D}/seed`, { idea_id: ideaId })).status, 409, "one document per refinery: go to document");
  // and it is an ordinary user document thereafter: it saves like any other
  assertEquals((await save(path, `${await file(path)}\nmy own words\n`)).status, 200);
});

// ── C18 / C19: the refinery from the document ──────────────────────────────────────────────
t("C18/C19: start refinery needs an idea; one ideas row, one tethered document; pick-up, unhide, archive and reopen", async () => {
  const path = await newDoc(`Refinery ${uid()}`, "no idea yet");
  const ideasBefore = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.ideas`))[0].n;
  const refused = await call("POST", `${D}/refinery/start`, { path });
  assertEquals(refused.status, 422, refused.text);
  assertEquals((await call("GET", `${D}/state?path=${encodeURIComponent(path)}`)).json.carries_idea, false);
  await call("POST", `${D}/property`, { path, key: "idea", value: "a refinery started from a document" });
  const st = await call("POST", `${D}/refinery/start`, { path });
  assertEquals(st.status, 200, st.text);
  const rid = st.json.refinery_id as string;
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.ideas`))[0].n, ideasBefore + 1);
  assertEquals((await listing(path))!.refinery_id, rid, "the listing shows its refinery");
  assertEquals((await sql(`SELECT origin_kind FROM public.refinery_state WHERE refinery_id = $1`, [rid]))[0].origin_kind, "document");
  // a second document cannot be tethered to the same refinery
  const other = await newDoc(`Second ${uid()}`);
  let unique = false;
  try {
    await sql(`UPDATE public.user_document_listings SET refinery_id = $1 WHERE path = $2`, [rid, other]);
  } catch {
    unique = true;
  }
  assert(unique, "one document per refinery");
  // starting again reopens, never a second refinery
  assertEquals((await call("POST", `${D}/refinery/start`, { path })).json.refinery_id, rid);
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.ideas`))[0].n, ideasBefore + 1);
  // pick-up + unhide + the pin the document defines
  await call("POST", `/workbench/contract/ideas/${rid}/hidden`, { node_kind: "source", node_ref: FX.refSrc, hidden: true });
  await save(path, `${await file(path)}\n[[source:${FX.refSrc}|picked]]\n`);
  const picked = await sql<{ reference_id: string | null }>(
    `SELECT reference_id::text AS reference_id FROM public.refinery_picked_links WHERE refinery_id = $1 AND node_ref = $2`, [rid, FX.refSrc],
  );
  assertEquals(picked.length, 1, "picked up into the refinery's context graph");
  assert(picked[0].reference_id, "with the document's pin");
  assertEquals((await sql(`SELECT 1 FROM public.refinery_hidden WHERE refinery_id = $1 AND node_ref = $2`, [rid, FX.refSrc])).length, 0, "linking unhides");
  const holderOfPin = await sql(`SELECT holder_kind, holder_ref FROM public.reference_holders WHERE reference_id = $1`, [picked[0].reference_id]);
  assertEquals(holderOfPin.map((h: any) => [h.holder_kind, h.holder_ref]), [["user_document", path]], "the pin is the document's, nowhere else");
  const graph = await call("GET", `/workbench/contract/ideas/${rid}`);
  const link = graph.json.refinery.context_graph.links.find((l: any) => l.kind === "document_link" && l.target === FX.refSrc);
  assertEquals(link.pin, 2, "the refinery mirrors the document's pin");
  // gaps and sessions from the writing surface join the refinery
  const gap = await call("POST", `${D}/research`, { path, query: "a gap", kind: "gap" });
  assertEquals(gap.json.refinery_id, rid);
  assertEquals((await call("GET", `/workbench/contract/sessions/${gap.json.job_id}`)).json.refinery_id, rid);
  // search never excludes: a source hidden in the refinery is sorted last with the tag
  await call("POST", `/workbench/contract/ideas/${rid}/hidden`, { node_kind: "source", node_ref: FX.active, hidden: true });
  const cand = await call("GET", `${D}/candidates?q=fixture&path=${encodeURIComponent(path)}`);
  const ids = cand.json.candidates.map((c: any) => c.id);
  const i = ids.indexOf(FX.active);
  assert(i >= 0, "a hidden source is never excluded");
  assert(cand.json.candidates[i].tags.includes("hidden in this session"));
  assert(cand.json.candidates.slice(i).every((c: any) => c.tags.includes("hidden in this session")), "sorted last");
  // archive: tag, stays editable, no pick-up while archived, reopen picks up
  assertEquals((await call("POST", `${D}/refinery/archive`, { path })).json.archived, true);
  const state = await call("GET", `${D}/state?path=${encodeURIComponent(path)}`);
  assertEquals(state.json.tags, ["refinery archived"]);
  assert(!state.json.tags.some((x: string) => /finished|closed/.test(x)));
  const s3 = await newSource("Linked while the refinery rests.");
  assertEquals((await save(path, `${await file(path)}\n[[source:${s3}|while archived]]\n`)).status, 200, "the document stays editable");
  assertEquals((await sql(`SELECT 1 FROM public.refinery_picked_links WHERE refinery_id = $1 AND node_ref = $2`, [rid, s3])).length, 0);
  const open = await call("POST", `${D}/refinery/open`, { path });
  assertEquals([open.json.refinery_id, open.json.reopened], [rid, true]);
  assertEquals((await sql(`SELECT 1 FROM public.refinery_picked_links WHERE refinery_id = $1 AND node_ref = $2`, [rid, s3])).length, 1);
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.ideas`))[0].n, ideasBefore + 1, "reopened, not recreated");
  // archiving the document archives its refinery
  const ar = await call("POST", `${D}/archive`, { path });
  assertEquals(ar.status, 200, ar.text);
  assertEquals(ar.json.refinery.archived, true);
  assertEquals((await sql(`SELECT status FROM public.ideas WHERE id = $1`, [rid]))[0].status, "archived");
});

// ── C20: user sources, held, the "+"s, clean-up, replace ───────────────────────────────────
t("C20: the universal + adds to an existing refinery only and creates none; the contextual + holds in the document's", async () => {
  const before = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.ideas`))[0].n;
  const none = await call("POST", `${D}/user-sources`, { title: "x", content: "y" });
  assertEquals(none.status, 400);
  assert(/existing refinery/.test(none.json.error));
  assertEquals((await call("POST", `${D}/user-sources`, { title: "x", content: "y", refinery_id: crypto.randomUUID() })).status, 404);
  const ok = await call("POST", `${D}/user-sources`, { title: `Universal ${uid()}`, content: "universal content", refinery_id: FX.idea });
  assertEquals(ok.status, 201, ok.text);
  assertEquals(ok.json.source.state, "held");
  const lonely = await newDoc(`No refinery ${uid()}`);
  assertEquals((await call("POST", `${D}/user-sources`, { path: lonely, title: "x", content: "y" })).status, 409, "no refinery: no add");
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.ideas`))[0].n, before, "no + created a refinery");
});

t("C20: a held source is citable from day one; removing it is blocked and flagged while linked; nothing edits the document", async () => {
  const path = await newDoc(`Held ${uid()}`, "", "an idea for held sources");
  const rid = (await call("POST", `${D}/refinery/start`, { path })).json.refinery_id;
  const add = await call("POST", `${D}/user-sources`, { path, title: `Held paste ${uid()}`, content: "Pasted held text to cite." });
  assertEquals(add.status, 201, add.text);
  const hid = add.json.source.source_id as string;
  const cite = await save(path, `${await file(path)}\nCiting held [[source:${hid}|held]].\n`);
  assertEquals(cite.status, 200, "a document is never refused a held citation");
  const l = (await listing(path))!;
  const link = l.outbound_links.find((x: any) => x.id === hid);
  assertEquals(link.pin, 1, "a held source is always revision 1");
  const dep = await call("GET", `/workbench/contract/sources/${hid}/dependence`);
  assertEquals(dep.json.counts.document_link, 1, "the listing counts it as a dependence");
  const before = await file(path);
  const rm = await call("DELETE", `${D}/user-sources/${hid}?refinery_id=${rid}`);
  assertEquals(rm.status, 409, rm.text);
  const flags = rm.json.documents.find((d: any) => d.path === path).flags;
  assert(flags.some((f: any) => f.form === "link" && f.line > 0), JSON.stringify(flags));
  assertEquals(await file(path), before, "the clean-up trigger edits nothing");
  assertEquals((await sql(`SELECT 1 FROM public.held_sources WHERE id = $1`, [hid])).length, 1, "not erased while linked");
  await save(path, before.replace(`[[source:${hid}|held]]`, "held"));
  const rm2 = await call("DELETE", `${D}/user-sources/${hid}?refinery_id=${rid}`);
  assertEquals(rm2.status, 200, rm2.text);
  assertEquals(rm2.json.tombstoned, false);
});

t("C20: replace is type-conditional; pins are per document (doc 1 keeps v1 when doc 2 adds v2)", async () => {
  // a LINK: refetch through the egress proxy into a new revision; this document's pin moves
  const p1 = await newDoc(`Replace link ${uid()}`, "", "replace idea");
  await call("POST", `${D}/refinery/start`, { path: p1 });
  const url = `http://${PROXY_HOST}/held/${uid()}`;
  const add = await call("POST", `${D}/user-sources`, { path: p1, title: "Linked held", content: "version one", url });
  const hid = add.json.source.source_id as string;
  await save(p1, `[[source:${hid}|linked]]\n`);
  const p2 = await newDoc(`Also links ${uid()}`, `[[source:${hid}|same]]`);
  const rep = await call("POST", `${D}/user-sources/${hid}/replace`, { path: p1 });
  assertEquals(rep.status, 200, rep.text);
  assertEquals([rep.json.kind, rep.json.changed, rep.json.revision], ["link", true, 2]);
  const pinOf = async (p: string) => (await listing(p))!.outbound_links.find((x: any) => x.id === hid)?.pin;
  assertEquals(await pinOf(p1), 2, "the replacing document's pin moves");
  assertEquals(await pinOf(p2), 1, "another document keeps its pin");
  // an uploaded FILE: replaced by the user by hand -> a new held source (a new pin id)
  const f = await call("POST", `${D}/user-sources`, { path: p1, title: `Upload ${uid()}.pdf`, content: "file v1" });
  const rf = await call("POST", `${D}/user-sources/${f.json.source.source_id}/replace`, { path: p1, content: "file v2 by hand" });
  assertEquals(rf.status, 200, rf.text);
  assertEquals(rf.json.kind, "file");
  assertNotEquals(rf.json.source_id, f.json.source.source_id, "a new pin id");
  // the SAME file added again (another document, other contents): deduped; doc 1 keeps v1, doc 2 gets v2
  const title = `Same file ${uid()}.pdf`;
  const d1 = await newDoc(`Doc one ${uid()}`, "", "doc one idea");
  await call("POST", `${D}/refinery/start`, { path: d1 });
  const v1 = await call("POST", `${D}/user-sources`, { path: d1, title, content: "same file v1" });
  const sid = v1.json.source.source_id;
  await save(d1, `[[source:${sid}|v1]]\n`);
  const d2 = await newDoc(`Doc two ${uid()}`, `[[source:${sid}|v2]]`, "doc two idea");
  await call("POST", `${D}/refinery/start`, { path: d2 });
  // doc two linked it at v1 too; now it adds the same file with new contents
  const v2 = await call("POST", `${D}/user-sources`, { path: d2, title, content: "same file v2" });
  assertEquals(v2.status, 201, v2.text);
  assertEquals([v2.json.source.source_id, v2.json.deduped, v2.json.revised], [sid, true, true]);
  const pin1 = (await listing(d1))!.outbound_links.find((x: any) => x.id === sid).pin;
  const pin2 = (await listing(d2))!.outbound_links.find((x: any) => x.id === sid).pin;
  assertEquals([pin1, pin2], [1, 2], "pins are per document");
  const same = await call("POST", `${D}/user-sources`, { path: d2, title, content: "same file v2" });
  assertEquals([same.json.deduped, same.json.revised], [true, false], "identical contents: deduped, no new revision");
});

// ── C7: the bell's acknowledgement ─────────────────────────────────────────────────────────
t("C7: an acknowledgement is stored (survives a reload); a repeat after it is unread again", async () => {
  const subject = `p2b ack ${uid()}`;
  const n = (await sql<{ id: string }>(`SELECT id::text AS id FROM public.post_research_notification('structural', $1, NULL, 'p2b:test')`, [subject]))[0];
  const ack = await call("POST", `/workbench/workspace/notifications/${n.id}/ack`);
  assertEquals(ack.status, 200, ack.text);
  const read = await call("GET", `/workbench/workspace/notifications`);
  assert(read.json.acknowledged.some((a: any) => a.id === n.id), "read back from the database");
  await sql(`SELECT public.post_research_notification('structural', $1, NULL, 'p2b:test')`, [subject]);
  const again = await call("GET", `/workbench/workspace/notifications`);
  assert(!again.json.acknowledged.some((a: any) => a.id === n.id), "a repeat is unread again");
});

t("C20: the bell's progress indicators are registered and read through jobs(state)", async () => {
  const reg = await call("GET", `/workbench/contract/registries/progress_indicators`);
  assertEquals(reg.status, 200, reg.text);
  assertEquals(reg.json.entries.map((e: any) => e.key).sort(), ["compiling", "held", "ingesting"]);
  for (const e of reg.json.entries) {
    const q = `/workbench/contract/jobs?kinds=${e.definition.job_kind}&limit=5`;
    assertEquals((await call("GET", q)).status, 200, q);
  }
  const held = await call("GET", `/workbench/contract/jobs?kinds=held&state=held`);
  assert(held.json.jobs.length >= 1, "held user sources counted");
  const dflt = await call("GET", `/workbench/contract/jobs?limit=200`);
  assert(dflt.json.jobs.every((j: any) => ["import", "research"].includes(j.kind)), "unchanged default kinds");
});

// ── the identity seam: per-user front-end context, shared knowledge (operator 2026-10-28) ─────
t("identity: two users see only their own documents, ideas, read state and prompts - and the same knowledge", async () => {
  const B = { [SUB_HEADER]: `p2b-user-b-${uid()}` };
  const a = await newDoc(`Owner A ${uid()}`, `[[source:${FX.active}|shared]]`);
  assert(a.startsWith("documents/operator/"), a);
  const bDoc = await call("POST", D, { title: `Owner B ${uid()}` }, B);
  assertEquals(bDoc.status, 201, bDoc.text);
  assert(bDoc.json.path.startsWith(`documents/${B[SUB_HEADER]}/`), bDoc.json.path);
  // documents: listed for their owner only; another user's answers like a document that does not exist
  const listA = await call("GET", `/workbench/contract/documents`);
  const listB = await call("GET", `/workbench/contract/documents`, undefined, B);
  assert(listA.json.documents.some((d: any) => d.path === a) && !listA.json.documents.some((d: any) => d.path === bDoc.json.path));
  assert(listB.json.documents.some((d: any) => d.path === bDoc.json.path) && !listB.json.documents.some((d: any) => d.path === a));
  assertEquals((await call("GET", `${D}/file?path=${encodeURIComponent(a)}`, undefined, B)).status, 404);
  assertEquals((await call("PUT", `${D}/file?path=${encodeURIComponent(a)}`, { content: "overwrite" }, B)).status, 404);
  assertEquals((await call("POST", `${D}/trash`, { path: a }, B)).status, 404);
  assert(!(await file(a)).includes("overwrite"), "another user cannot write it");
  const row = (await sql<{ owner_sub: string; actor_sub: string }>(`SELECT owner_sub, actor_sub FROM public.user_document_listings WHERE path = $1`, [bDoc.json.path]))[0];
  assertEquals([row.owner_sub, row.actor_sub], [B[SUB_HEADER], B[SUB_HEADER]], "subject and actor recorded");
  // ideas (refineries): the user's own
  const ideasB = await call("GET", `/workbench/contract/ideas`, undefined, B);
  assert(!ideasB.json.ideas.some((i: any) => i.id === FX.idea), "user B does not see the operator's idea");
  assertEquals((await call("GET", `/workbench/contract/ideas/${FX.idea}`, undefined, B)).status, 404);
  assertEquals((await call("POST", `${D}/user-sources`, { refinery_id: FX.idea, title: "x", content: "y" }, B)).status, 404, "no + into another user's refinery");
  // the bell: the same events, each user's own read state
  const n = (await sql<{ id: string }>(`SELECT id::text AS id FROM public.post_research_notification('informational', $1, NULL, 'p2b:owners')`, [`owners ${uid()}`]))[0];
  await call("POST", `/workbench/workspace/notifications/${n.id}/ack`);
  const readA = (await call("GET", `/workbench/workspace/notifications`)).json.acknowledged.map((x: any) => x.id);
  const readB = (await call("GET", `/workbench/workspace/notifications`, undefined, B)).json.acknowledged.map((x: any) => x.id);
  assert(readA.includes(n.id) && !readB.includes(n.id), "read state is per user");
  const notesB = await call("GET", `/workbench/contract/notifications?limit=500`, undefined, B);
  assert(notesB.json.notifications.some((x: any) => x.id === n.id), "the events themselves are the same for everyone");
  // the original prompt: its owner reads it; the job and what it produces stay shared
  const q = await call("POST", `${D}/research`, { path: a, query: `private prompt ${uid()}`, kind: "research" });
  assertEquals(q.status, 202, q.text);
  assertEquals((await call("GET", `/workbench/contract/sessions/${q.json.job_id}`)).json.query.startsWith("private prompt"), true);
  const sB = await call("GET", `/workbench/contract/sessions/${q.json.job_id}`, undefined, B);
  assertEquals(sB.status, 200, "the session itself is shared");
  assertEquals(sB.json.query, "", "another user does not read the prompt");
  const jB = await call("GET", `/workbench/contract/jobs?kinds=research&limit=200`, undefined, B);
  assertEquals(jB.json.jobs.find((j: any) => j.id === q.json.job_id)?.detail.query, "");
  // knowledge is shared: the same source, the same search, for both
  const srcA = await call("GET", `/workbench/contract/references/${FX.active}`);
  const srcB = await call("GET", `/workbench/contract/references/${FX.active}`, undefined, B);
  assertEquals(srcA.json.source.title, srcB.json.source.title);
  const sa = (await call("GET", `/workbench/contract/search?q=fixture&kinds=source`)).json.results.map((x: any) => x.id).sort();
  const sb = (await call("GET", `/workbench/contract/search?q=fixture&kinds=source`, undefined, B)).json.results.map((x: any) => x.id).sort();
  assertEquals(sa, sb);
  const who = await call("GET", `/workbench/workspace/whoami`, undefined, B);
  assertEquals([who.json.subject_sub, who.json.actor_sub], [B[SUB_HEADER], B[SUB_HEADER]]);
});

t("D12 overall: no user document has a wiki_pages row", async () => {
  assertEquals(await sql(`SELECT slug FROM public.wiki_pages WHERE slug LIKE 'documents/%' OR slug LIKE '%/documents/%'`), []);
  const docs = await sql<{ path: string }>(`SELECT path FROM public.user_document_listings`);
  for (const d of docs) assertEquals(parseDocument("").links.length, 0, d.path);
});
