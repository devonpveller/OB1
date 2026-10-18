// deno test src/contracts/references_integration_test.ts - P2a's reference records over a REAL
// database.
//
// SKIPPED unless CONTRACT_TEST_DB_HOST is set. contract-test/run-references-tests.ps1 sets it to
// a DISPOSABLE Postgres on its own internal network (the pinned pgvector image, the compose
// initdb chain incl. 230 + 240, contract-test/fixtures.sql). Never point it at a live database:
// the tests insert sources, references and holders.
//
// Every test makes its own sources; the fixture rows are read, never changed.
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { Pool } from "postgres";
import { type Db, poolDb } from "./db.ts";
import { RegistryReader } from "./registry.ts";
import { createContractApp } from "./app.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import { chunkText } from "../util/chunk.ts";
import {
  bodyExportReferences, ensureLegacyNote, markHolderRemoved, MigrationRefused, moveHolder, noteExportReferences,
  noteRefsView, syncLegacyNote,
} from "./repo/references.ts";
import { renderCitations } from "./logic/citations.ts";
import * as S from "./schemas/sources.ts";
import * as R from "./schemas/references.ts";
import { Documents } from "./schemas/ideas.ts";
import { FX } from "./schemas/fixtures.ts";

const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !HOST;
const pool = HOST
  ? new Pool({
    hostname: HOST, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 4, true)
  : null;
const db = pool ? poolDb(pool) : null;

// The "network log" of the database side: every row every query returned while recording.
const wire: { sql: string; rows: unknown[] }[] = [];
let recording = false;
const recDb: Db | null = db
  ? (() => {
    const wrap = (inner: Db): Db => ({
      query: async <T>(text: string, args: unknown[] = []) => {
        const rows = await inner.query<T>(text, args);
        if (recording) wire.push({ sql: text, rows });
        return rows;
      },
      tx: (fn) => inner.tx((t) => fn(wrap(t))),
    });
    return wrap(db);
  })()
  : null;
const app = recDb
  ? createContractApp({
    db: recDb, registry: new RegistryReader(recDb, 0), scorer: unavailableScorer, chunk: chunkText,
    mountsRoot: "/tmp/contract-mounts", embed: () => Promise.resolve(Array.from({ length: 1024 }, () => 0)),
    streamPollMs: 20, log: () => {},
  })
  : null;

const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });
const sql = <T = Record<string, unknown>>(text: string, args: unknown[] = []) => db!.query<T>(text, args);
const B = "/workbench/contract";
async function call(method: string, path: string, body?: unknown) {
  const r = await app!.request(B + path, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  return { status: r.status, json, text };
}
const uuid = () => crypto.randomUUID();

// A source with `revisions` committed revisions (revision k's text = texts[k-1]); the head and its
// chunks are the last text, split on ". ".
async function newSource(texts: string[], over: { content_type?: string; title?: string } = {}) {
  const id = uuid();
  const head = texts[texts.length - 1];
  await sql(`INSERT INTO public.sources (id, url, title, content, content_type) VALUES ($1, $2, $3, $4, $5)`,
    [id, `https://example.org/p2a/${id}`, over.title ?? `P2a source ${id.slice(0, 8)}`, head, over.content_type ?? "web_article"]);
  if (texts.length > 1) {
    for (let k = 0; k < texts.length; k++) {
      await sql(`INSERT INTO public.source_revisions (source_id, revision, content, title, edited_by) VALUES ($1, $2, $3, $4, 'test')`,
        [id, k + 1, texts[k], over.title ?? `P2a source ${id.slice(0, 8)}`]);
    }
  }
  const parts = head.split(/(?<=\.) /);
  for (let i = 0; i < parts.length; i++) {
    await sql(`INSERT INTO public.source_chunks (source_id, idx, content) VALUES ($1, $2, $3)`, [id, i, parts[i]]);
  }
  return id;
}
const sel = (text: string, exact: string) => {
  const start = text.indexOf(exact);
  return {
    quote: { exact, prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(start + exact.length, start + exact.length + 32) },
    position: { start, end: start + exact.length },
  };
};
const revisionOf = async (id: string) =>
  (await sql<{ r: number }>(`SELECT COALESCE(max(revision), 1)::int AS r FROM public.source_revisions WHERE source_id = $1`, [id]))[0].r;

// ── acceptance 2: a reference stores quote + prefix/suffix, position, and page+quad for PDFs ──
t("the database refuses a reference without a quote, without position, or a PDF reference without page+quad", async () => {
  const s = await newSource(["Plain text for the selector rule."]);
  const pdf = await newSource(["PDF page text."], { content_type: "pdf" });
  const ins = (source: string, selectors: unknown, extra = "") =>
    sql(`INSERT INTO public.reference_records (source_id, selectors, provenance, pinned_revision${extra ? ", scope" : ""})
         VALUES ($1, $2::jsonb, 'user', 1${extra ? ", $3" : ""})`, extra ? [source, JSON.stringify(selectors), extra] : [source, JSON.stringify(selectors)]);
  const good = sel("Plain text for the selector rule.", "Plain text");
  await ins(s, good);
  const refused = async (source: string, selectors: unknown, why: string) => {
    const e = await assertRejects(() => ins(source, selectors)) as { fields?: { code?: string; message?: string } };
    assertEquals(e.fields?.code, "OBR01", why);
    return e.fields?.message ?? "";
  };
  assert((await refused(s, { position: good.position }, "no quote")).includes("quote selector is required"));
  await refused(s, { quote: { ...good.quote, exact: "" }, position: good.position }, "empty exact");
  await refused(s, { quote: { exact: "Plain text" }, position: good.position }, "no prefix/suffix");
  await refused(s, { quote: good.quote }, "no position");
  await refused(s, { ...good, position: { start: "0", end: 10 } }, "position.start not an integer");
  await refused(s, { ...good, video: { t: 1 } }, "an unregistered selector kind");
  assert((await refused(pdf, sel("PDF page text.", "PDF page"), "pdf without page+quad")).includes("for content type pdf"));
  await ins(pdf, { ...sel("PDF page text.", "PDF page"), pdf: { page: 1, quads: [[0.1, 0.1, 0.5, 0.1, 0.5, 0.2, 0.1, 0.2]] } });
  const e = await assertRejects(() => sql(
    `INSERT INTO public.reference_records (source_id, selectors, provenance, pinned_revision) VALUES ($1, $2::jsonb, 'robot', 1)`,
    [s, JSON.stringify(good)],
  )) as { fields?: { code?: string } };
  assertEquals(e.fields?.code, "OBR01", "an unregistered provenance");
});

t("POST /references pins the current revision, locates the quote's chunk, and refuses a reference without a quote", async () => {
  const texts = ["Alpha one. Beta two.", "Alpha one. Beta two. Gamma three."];
  const s = await newSource(texts);
  const ok = await call("POST", "/references", { source_id: s, provenance: "user", selectors: sel(texts[1], "Gamma three.") });
  assertEquals(ok.status, 201, ok.text);
  assert(R.ReferenceCreated.safeParse(ok.json).success);
  assertEquals([ok.json.record.pinned_revision, ok.json.record.chunk_idx, ok.json.record.scope], [2, 2, "span"]);
  const { quote: _q, ...noQuote } = sel(texts[1], "Gamma three.");
  assertEquals((await call("POST", "/references", { source_id: s, provenance: "user", selectors: noQuote })).status, 400);
  const wrongPos = { ...sel(texts[1], "Gamma three."), position: { start: 0, end: 5 } };
  const r422 = await call("POST", "/references", { source_id: s, provenance: "user", selectors: wrongPos });
  assertEquals(r422.status, 422, "a position that does not select the quote");
  const pdf = await newSource(["PDF page text."], { content_type: "pdf" });
  const noQuad = await call("POST", "/references", { source_id: pdf, provenance: "user", selectors: sel("PDF page text.", "PDF") });
  assertEquals(noQuad.status, 422, noQuad.text);
  assertEquals((await call("POST", "/references", { source_id: s, provenance: "nobody", selectors: sel(texts[1], "Alpha one.") })).status, 422);
  assertEquals((await call("POST", "/references", { source_id: uuid(), provenance: "user", selectors: sel(texts[1], "Alpha one.") })).status, 404);
});

t("a reference to a held source pins revision 1 (D17)", async () => {
  const r = await call("POST", "/references", {
    source_id: FX.heldLinked, provenance: "user",
    selectors: sel("Held text about contract retrieval in the refinery.", "Held text"),
    holder: { kind: "user_document", ref: FX.documentPath },
  });
  assertEquals(r.status, 201, r.text);
  assertEquals(r.json.record.pinned_revision, 1);
  assertEquals(r.json.held.origin, "added");
});

// ── acceptance 1: legacy notes migrate with provenance user and the current revision pinned ──
t("migration: every legacy-note reference becomes a row, provenance user, pinned at the current revision", async () => {
  const s1 = await newSource(["First revision text.", "Second revision text. More."]);
  const s2 = await newSource(["Only revision text of the second source."]);
  const s3 = await newSource(["Added through frontmatter. Two."]);
  const missing = uuid();
  const rel = `notes/p2a/m-${uuid().slice(0, 8)}.md`;
  const content = `---\ntitle: m\nsources: [${s3}]\n---\n# M\n\n[[content/source/${s1}|S1]] then [[source/${missing}|gone]] and [[source/${s2}]] and [[source/${s1}|S1]].\n`;
  const rep = await syncLegacyNote(db!, rel, content, { onlyIfUnmigrated: true });
  assert(rep.migrated);
  assertEquals(rep.before, { added: 1, cited: 2, total: 3 });
  assertEquals([rep.after.added, rep.after.cited, rep.after.total, rep.after.unresolved], [1, 2, 3, 1]);
  const rows = await sql<{ source_id: string; provenance: string; pinned_revision: number; scope: string; selectors: any; number: number | null; origin: string }>(
    `SELECT r.source_id::text AS source_id, r.provenance, r.pinned_revision, r.scope, r.selectors, h.number, h.origin
       FROM public.reference_holders h JOIN public.reference_records r ON r.id = h.reference_id
      WHERE h.holder_kind = 'legacy_note' AND h.holder_ref = $1 ORDER BY h.seq`, [rel]);
  assertEquals(rows.map((r) => r.source_id), [s3, s1, s2]);
  for (const r of rows) {
    assertEquals(r.provenance, "user");
    assertEquals(r.scope, "source");
    assertEquals(r.pinned_revision, await revisionOf(r.source_id), "pinned = the source's current revision at migration");
    assert(r.selectors.quote.exact.length > 0 && "prefix" in r.selectors.quote && "suffix" in r.selectors.quote);
    assert(Number.isInteger(r.selectors.position.start));
  }
  assertEquals(rows.find((r) => r.source_id === s1)!.pinned_revision, 2);
  // the export numbers: s1 [1], missing [2], s2 [3], s3 (added) [4]
  assertEquals(rows.map((r) => r.number), [4, 1, 3]);
  const unresolved = await sql<{ number: number; reference_id: string | null }>(
    `SELECT number, reference_id FROM public.reference_holders WHERE holder_ref = $1 AND cited_ref = $2`, [rel, missing]);
  assertEquals(unresolved, [{ number: 2, reference_id: null }]);
  // re-running skips; the view is what note-refs lists
  const again = await syncLegacyNote(db!, rel, content, { onlyIfUnmigrated: true });
  assert(again.skipped);
  const view = await noteRefsView(db!, rel);
  assertEquals([view.added.map((r) => r.id), view.cited.map((r) => r.id)], [[s3], [s1, s2]]);
});

t("migration: a note whose references would differ is refused and nothing is written", async () => {
  const s = await newSource(["Text."]);
  const rel = `notes/p2a/dup-${uuid().slice(0, 8)}.md`;
  // the legacy reader listed a duplicated frontmatter id twice; one record per source cannot
  const content = `---\nsources: [${s}, ${s}]\n---\nbody`;
  await assertRejects(() => syncLegacyNote(db!, rel, content), MigrationRefused, "differ before and after");
  assertEquals((await sql(`SELECT 1 FROM public.reference_holders WHERE holder_ref = $1`, [rel])).length, 0);
  assertEquals((await sql(`SELECT 1 FROM public.reference_holder_state WHERE holder_ref = $1`, [rel])).length, 0);
  const junk = `notes/p2a/junk-${uuid().slice(0, 8)}.md`;
  await assertRejects(() => syncLegacyNote(db!, junk, `x [[source/1111111111111111111111111111111111-1]]`), MigrationRefused, "not uuids");
});

t("dry run computes and checks, then leaves nothing", async () => {
  const s = await newSource(["Dry run text."]);
  const rel = `notes/p2a/dry-${uuid().slice(0, 8)}.md`;
  const rep = await syncLegacyNote(db!, rel, `[[source/${s}|d]]`, { dryRun: true });
  assertEquals(rep.after.total, 1);
  assertEquals((await sql(`SELECT 1 FROM public.reference_holders WHERE holder_ref = $1`, [rel])).length, 0);
  assertEquals((await sql(`SELECT 1 FROM public.reference_records WHERE source_id = $1`, [s])).length, 0);
});

t("pins never move: a new source revision leaves the pin; a new citation pins the new current revision", async () => {
  const s = await newSource(["Version one text."]);
  const rel = `notes/p2a/pin-${uuid().slice(0, 8)}.md`;
  await syncLegacyNote(db!, rel, `[[source/${s}|v]]`);
  const [{ id: refId, pinned_revision: pin }] = await sql<{ id: string; pinned_revision: number }>(
    `SELECT r.id::text AS id, r.pinned_revision FROM public.reference_holders h JOIN public.reference_records r ON r.id = h.reference_id WHERE h.holder_ref = $1`, [rel]);
  assertEquals(pin, 1);
  await sql(`INSERT INTO public.source_revisions (source_id, revision, content, title) VALUES ($1, 1, 'Version one text.', 't'), ($1, 2, 'Version two text.', 't')`, [s]);
  await syncLegacyNote(db!, rel, `edited [[source/${s}|v]] body`);
  const after = await sql<{ id: string; pinned_revision: number }>(
    `SELECT r.id::text AS id, r.pinned_revision FROM public.reference_holders h JOIN public.reference_records r ON r.id = h.reference_id WHERE h.holder_ref = $1`, [rel]);
  assertEquals(after, [{ id: refId, pinned_revision: 1 }], "the same record, the same pin");
  // a second note citing it now pins revision 2: pins are per holder (D17)
  const rel2 = `notes/p2a/pin2-${uuid().slice(0, 8)}.md`;
  await syncLegacyNote(db!, rel2, `[[source/${s}|v]]`);
  const other = await sql<{ pinned_revision: number }>(
    `SELECT r.pinned_revision FROM public.reference_holders h JOIN public.reference_records r ON r.id = h.reference_id WHERE h.holder_ref = $1`, [rel2]);
  assertEquals(other, [{ pinned_revision: 2 }]);
  // removing the citation drops the holder row and the record it alone held
  await syncLegacyNote(db!, rel, `no links any more`);
  assertEquals((await sql(`SELECT 1 FROM public.reference_records WHERE id = $1`, [refId])).length, 0);
});

t("added references live in the record after migration: add / remove keep pins; a move keeps them", async () => {
  const s = await newSource(["Added later text."]);
  const c = await newSource(["Cited text."]);
  const rel = `notes/p2a/add-${uuid().slice(0, 8)}.md`;
  const content = `[[source/${c}|c]]`;
  await ensureLegacyNote(db!, rel, content);
  await syncLegacyNote(db!, rel, content, { addAdded: s });
  let v = await noteRefsView(db!, rel);
  assertEquals([v.added.map((r) => r.id), v.cited.map((r) => r.id)], [[s], [c]]);
  // adding a cited one makes it added, with its pin kept
  const [{ id: cRef }] = await sql<{ id: string }>(`SELECT reference_id::text AS id FROM public.reference_holders WHERE holder_ref = $1 AND cited_ref = $2`, [rel, c]);
  await syncLegacyNote(db!, rel, content, { addAdded: c });
  await syncLegacyNote(db!, rel, content, { removeAdded: c });
  const [{ id: cRef2, origin }] = await sql<{ id: string; origin: string }>(`SELECT reference_id::text AS id, origin FROM public.reference_holders WHERE holder_ref = $1 AND cited_ref = $2`, [rel, c]);
  assertEquals([cRef2, origin], [cRef, "cited"]);
  // the frontmatter is not read after the migration
  await syncLegacyNote(db!, rel, `---\nsources: [${uuid()}]\n---\n${content}`);
  v = await noteRefsView(db!, rel);
  assertEquals(v.added.map((r) => r.id), [s]);
  const to = rel.replace("add-", "moved-");
  await moveHolder(db!, rel, to);
  assertEquals((await noteRefsView(db!, to)).added.map((r) => r.id), [s]);
  assertEquals((await sql(`SELECT 1 FROM public.reference_holders WHERE holder_ref = $1`, [rel])).length, 0);
});

// ── acceptance 3: the export's numbered References, read from the records, equal the legacy ones ──
// The legacy export (OB1 a28e9db routes/export.ts applyCitations), verbatim, over the same rows.
async function legacyExport(md: string): Promise<string> {
  const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
  const SOURCE_LINK_RE = /\[\[([^\]|]*?source\/([0-9a-fA-F-]{36}))(?:\|([^\]]+))?\]\]/g;
  const order: string[] = [];
  const numFor = new Map<string, number>();
  const enrol = (u: string) => {
    if (UUID_RE.test(u) && !numFor.has(u)) {
      order.push(u);
      numFor.set(u, order.length);
    }
  };
  let m: RegExpExecArray | null;
  SOURCE_LINK_RE.lastIndex = 0;
  while ((m = SOURCE_LINK_RE.exec(md))) enrol(m[2]);
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const sm = fmMatch[1].match(/^sources:\s*\[([^\]]*)\]\s*$/m);
    if (sm) sm[1].split(",").forEach((s) => enrol(s.trim().replace(/^["']|["']$/g, "")));
  }
  let out = md.replace(SOURCE_LINK_RE, (_full, _target, uuid, alias) => {
    const n = numFor.get(uuid);
    const label = (alias || "").trim();
    return label ? `${label} [${n}]` : `[${n}]`;
  });
  out = out.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, (_m, t) => String(t).split("/").pop() || String(t));
  if (order.length) {
    const rows = await db!.query<{ id: string; title: string; url: string }>(
      `SELECT id::text AS id, title, url FROM public.sources WHERE id = ANY($1::uuid[]) AND retraction_committed_at IS NULL`, [order],
    ).catch(() => []);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const lines = order.map((u) => {
      const r = byId.get(u);
      if (!r) return null;
      const title = (r.title || "Untitled source").replace(/\n/g, " ");
      return `[${numFor.get(u)}] ${title}${r.url ? `. <${r.url}>` : "."}`;
    }).filter(Boolean);
    if (lines.length) out += "\n\n## References\n\n" + lines.join("\n\n");
  }
  return out;
}

t("export: a migrated note renders the same numbered references (and the same text) as the legacy export", async () => {
  const a = await newSource(["A text."], { title: "Source A" });
  const b = await newSource(["B text."], { title: "Source\nB" });
  const sup = await newSource(["Suppressed text."], { title: "Suppressed S" });
  await sql(`UPDATE public.sources SET retracted_at = now(), retraction_committed_at = now(), suppression_reason = 'test' WHERE id = $1`, [sup]);
  const added = await newSource(["Added text."], { title: "Added" });
  const notes = [
    `---\ntitle: e\nsources: [${added}, ${a}]\n---\n# E\n\nSee [[content/source/${a}|S1]], [[source/${uuid()}|gone]], [[source/${sup}|s]] and [[source/${b}]].\n\n[[tool-x]] and [[x/y|Y]].`,
    `[[content/source/${a}#h|anchored]] [[see|source/${b}]] [[source/${a.toUpperCase()}|upper]]`,
    `no references at all`,
  ];
  for (const md of notes) {
    const rel = `notes/p2a/export-${uuid().slice(0, 8)}.md`;
    const before = await legacyExport(md); // the legacy export, before the migration
    await ensureLegacyNote(db!, rel, md); // the migration (first touch)
    const refs = await noteExportReferences(db!, rel);
    const after = renderCitations(md, refs.numberOf, refs.lines);
    const section = (s: string) => s.includes("\n## References\n") ? s.slice(s.indexOf("\n## References\n")) : "";
    assertEquals(section(after), section(before), "the References section differs");
    assertEquals(after, before, "the rendered export differs");
  }
  // a page that is not a note: body numbering, no frontmatter list
  const page = `[[content/source/${a}|S1]] [[source/${b}]]`;
  const r = await bodyExportReferences(db!, page);
  assertEquals(renderCitations(page, r.numberOf, r.lines), await legacyExport(page));
});

// ── acceptance 4: diffCheck over 200 references, under 200 ms, no chunk text fetched ──────
t("diffCheck over a note holding 200 references: < 200 ms, every pin out of date, re-anchored, and NO chunk text on the wire", async () => {
  const rel = `notes/p2a/two-hundred-${uuid().slice(0, 8)}.md`;
  const SENTINEL = "zq-chunk-text-sentinel";
  // 200 sources at revision 2; each reference was placed on revision 1. 190 quotes survive into
  // revision 2 (in chunk 1), 10 do not.
  const ids: string[] = [];
  const rows = await sql<{ id: string; n: number }>(
    `WITH g AS (SELECT n, gen_random_uuid() AS id FROM generate_series(1, 200) n),
          s AS (INSERT INTO public.sources (id, url, title, content)
                SELECT id, 'https://example.org/p2a-200/' || n, 'Two hundred ' || n,
                       'Opening ' || n || '. ' || CASE WHEN n <= 190 THEN 'Quoted span ' || n || ' ${SENTINEL}.' ELSE 'Rewritten ' || n || '.' END || ' Tail.'
                  FROM g RETURNING id),
          r AS (INSERT INTO public.source_revisions (source_id, revision, content, title, edited_by)
                SELECT g.id, v, 'rev', 't', 'test' FROM g CROSS JOIN generate_series(1, 2) v RETURNING 1),
          c AS (INSERT INTO public.source_chunks (source_id, idx, content)
                SELECT g.id, k, CASE k WHEN 0 THEN 'Opening ' || g.n || '.'
                                       WHEN 1 THEN CASE WHEN g.n <= 190 THEN 'Quoted span ' || g.n || ' ${SENTINEL}.' ELSE 'Rewritten ' || g.n || '.' END
                                       ELSE 'Tail.' END
                  FROM g CROSS JOIN generate_series(0, 2) k RETURNING 1)
     SELECT id::text AS id, n FROM g ORDER BY n`,
  );
  for (const r of rows) {
    const exact = `Quoted span ${r.n} ${SENTINEL}.`;
    const [rec] = await sql<{ id: string }>(
      `INSERT INTO public.reference_records (source_id, scope, selectors, provenance, pinned_revision, chunk_idx)
       VALUES ($1, 'span', $2::jsonb, 'user', 1, 1) RETURNING id::text AS id`,
      [r.id, JSON.stringify({ quote: { exact, prefix: `Opening ${r.n}. `, suffix: " Tail." }, position: { start: 10, end: 10 + exact.length } })],
    );
    ids.push(rec.id);
    await sql(`INSERT INTO public.reference_holders (holder_kind, holder_ref, reference_id, cited_ref, origin, seq, number)
               VALUES ('legacy_note', $1, $2, $3, 'cited', $4, $4 + 1)`, [rel, rec.id, r.id, r.n - 1]);
  }
  const body = { holder: { kind: "legacy_note", ref: rel } };
  await call("POST", "/diff-check", body); // warm the route and the plan cache
  const times: number[] = [];
  let last: Awaited<ReturnType<typeof call>> | null = null;
  for (let i = 0; i < 5; i++) {
    wire.length = 0;
    recording = true;
    const t0 = performance.now();
    last = await call("POST", "/diff-check", body);
    times.push(performance.now() - t0);
    recording = false;
  }
  console.log(`diffCheck(200) ms: ${times.map((x) => x.toFixed(1)).join(", ")}`);
  assertEquals(last!.status, 200, last!.text);
  assert(Math.max(...times) < 200, `diffCheck over 200 references took ${Math.max(...times).toFixed(1)} ms`);
  const res = last!.json.results as any[];
  assertEquals(res.length, 200);
  assert(S.DiffCheck.safeParse(last!.json).success);
  assert(res.every((x) => x.out_of_date === true && x.pinned_revision === 1 && x.current_revision === 2));
  assertEquals(res.filter((x) => x.anchor === "requoted").length, 190);
  assertEquals(res.filter((x) => x.anchor === "lost").length, 10);
  assert(res.filter((x) => x.anchor === "requoted").every((x) => x.equivalent_current_chunk_id === `${x.source_id}:1`));
  // the HTTP response carries no chunk text; nor does any row the database returned for it
  assert(!last!.text.includes(SENTINEL) && !last!.text.includes("Quoted span") && !last!.text.includes("Opening"),
    "chunk text crossed the wire");
  const dbWire = JSON.stringify(wire.map((w) => w.rows));
  assert(wire.length > 0 && wire.length <= 4, `diffCheck ran ${wire.length} queries`);
  assert(!dbWire.includes(SENTINEL) && !dbWire.includes("Quoted span"), "a query returned chunk text to the workbench");
  for (const w of wire) {
    for (const row of w.rows as Record<string, unknown>[]) {
      for (const k of Object.keys(row)) assert(!["content", "text", "excerpt", "selectors"].includes(k), `column ${k} fetched`);
    }
  }
});

t("diffCheck: a current pin answers its pinned chunk; a bare pin keeps P0's same-index rule; a filter fails closed", async () => {
  const r = await call("POST", "/diff-check", { references: [{ reference_id: FX.referenceCurrent }, { reference_id: FX.referenceSpan }, { source_id: FX.refSource, revision: 1, chunk_idx: 2 }] });
  assertEquals(r.status, 200, r.text);
  const [cur, span, bare] = r.json.results;
  assertEquals([cur.out_of_date, cur.anchor, cur.equivalent_current_chunk_id], [false, "pinned", `${FX.refSource}:2`]);
  assertEquals([span.out_of_date, span.anchor, span.equivalent_current_chunk_id], [true, "requoted", `${FX.refSource}:1`]);
  assertEquals([bare.reference_id, bare.anchor, bare.equivalent_current_chunk_id], [null, "same_idx", `${FX.refSource}:2`]);
  const f = encodeURIComponent(JSON.stringify({ share: "cloud" }));
  assertEquals((await call("POST", `/diff-check?metadata_filter=${f}`, { references: [{ reference_id: FX.referenceSpan }] })).status, 404);
  assertEquals((await call("POST", `/diff-check?metadata_filter=${f}`, { holder: { kind: "legacy_note", ref: FX.refNotePath } })).json.results, []);
  const omitted = await call("POST", `/diff-check?metadata_filter=${f}`, { references: [{ source_id: FX.refSource, revision: 1 }] });
  assertEquals(omitted.json.results[0].state, "omitted");
  assertEquals((await call("POST", "/diff-check", { references: [{ reference_id: uuid() }] })).status, 404);
});

// ── reference(id) over a record ────────────────────────────────────────────────────────────
t("reference(id) of a record: kind reference, read at the pin (state updated), record with selectors; fail closed under a filter", async () => {
  const r = await call("GET", `/references/${FX.referenceSpan}`);
  assertEquals(r.status, 200, r.text);
  assert(S.Reference.safeParse(r.json).success);
  assertEquals([r.json.kind, r.json.state, r.json.requested_version, r.json.version], ["reference", "updated", 1, 2]);
  assertEquals(r.json.record.selectors.quote.exact, "The quoted span about pinned anchors lives here.");
  assertEquals(r.json.source.excerpt, "Opening line of the reference fixture. The quoted span about pinned anchors lives here.",
    "the excerpt is the PINNED revision's text");
  const f = encodeURIComponent(JSON.stringify({ share: "cloud" }));
  assertEquals((await call("GET", `/references/${FX.referenceSpan}?metadata_filter=${f}`)).status, 404);
  // a source id still answers as P0 did, with record null
  const s = await call("GET", `/references/${FX.sourceActive}`);
  assertEquals([s.json.kind, s.json.record], ["source", null]);
  // evidence-only: a record whose source is suppressed is omitted, record and all
  const sup = await newSource(["Soon suppressed."]);
  const created = await call("POST", "/references", { source_id: sup, provenance: "user", selectors: sel("Soon suppressed.", "Soon") });
  await sql(`UPDATE public.sources SET retracted_at = now(), retraction_committed_at = now() WHERE id = $1`, [sup]);
  const ev = await call("GET", `/references/${created.json.record.id}?evidence_only=true`);
  assertEquals([ev.json.state, ev.json.record], ["omitted", null]);
});

t("holder listing is body-less: ids, pins and order, no selectors or text", async () => {
  const r = await call("GET", `/holders/legacy_note/references?ref=${encodeURIComponent(FX.refNotePath)}`);
  assertEquals(r.status, 200, r.text);
  assert(R.HolderReferences.safeParse(r.json).success);
  assertEquals(r.json.references[0].reference_id, FX.referenceSpan);
  assert(!/selectors|exact|"quote"/.test(r.text));
  assertEquals((await call("GET", `/holders/legacy_note/references?ref=notes/none.md`)).status, 404);
});

// ── D5 / D12: dependence counts the notes' references; a document link's pin is the record's ──
t("a source a legacy note holds has a blocking reference_record dependence, gone once the note is hard-removed", async () => {
  const s = await newSource(["Depended on."]);
  const rel = `notes/p2a/dep-${uuid().slice(0, 8)}.md`;
  await syncLegacyNote(db!, rel, `[[source/${s}|d]]`);
  let d = await call("GET", `/sources/${s}/dependence`);
  assertEquals(d.json.counts.reference_record, 1, JSON.stringify(d.json.counts));
  assert(d.json.connections.find((c: any) => c.kind === "reference_record").blocks_erase);
  await markHolderRemoved(db!, rel);
  d = await call("GET", `/sources/${s}/dependence`);
  assertEquals(d.json.counts.reference_record, undefined);
  // a user document holder is counted through its listing (document_link), not twice
  const u = await call("POST", "/references", { source_id: s, provenance: "user", selectors: sel("Depended on.", "Depended"), holder: { kind: "user_document", ref: FX.documentPath } });
  assertEquals(u.status, 201);
  d = await call("GET", `/sources/${s}/dependence`);
  assertEquals(d.json.counts.reference_record, undefined);
});

t("a user document link carrying a reference_id reads its pin from the record (D12), never a copy", async () => {
  const path = `documents/p2a-${uuid().slice(0, 8)}.md`;
  await sql(`INSERT INTO public.user_document_listings (path, title, outbound_links) VALUES ($1, 'P2a doc', $2::jsonb)`,
    [path, JSON.stringify([{ kind: "source", id: FX.refSource, pin: 99, reference_id: FX.referenceSpan }, { kind: "page", id: FX.pageEntity, pin: null }])]);
  const r = await call("GET", `/documents?limit=500`);
  assert(Documents.safeParse(r.json).success);
  const doc = r.json.documents.find((d: any) => d.path === path);
  assertEquals(doc.outbound_links[0], { kind: "source", id: FX.refSource, pin: 1, reference_id: FX.referenceSpan });
  assertEquals(doc.outbound_links[1].reference_id, null);
  assertNotEquals(doc.outbound_links[0].pin, 99);
});
