// deno test src/contracts/toplace_integration_test.ts - the document's "to place" queue (rwr-doc-toplace-api) over a REAL
// workbench and database (the real initdb chain, slot 630 included), as TWO users with planted data.
// SKIPPED unless TOPLACE_TEST_BASE and CONTRACT_TEST_DB_HOST are set; contract-test/run-toplace-tests.ps1 runs it in its
// disposable lab (the :wt workbench with WORKSPACE_IDENTITY_HEADER=X-Test-Sub, a vault it mounts here too).
// Never point it at a live stack: it trashes and deletes documents.
//
// Callers: A is the lab's default identity (no header); B is a request with X-Test-Sub.
// Environment: TOPLACE_TEST_BASE, TOPLACE_TEST_KEY, TOPLACE_TEST_VAULT, TOPLACE_TEST_SUB_HEADER (default X-Test-Sub),
// CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser: plants and snapshots).
// P1..P8 name the acceptance statements (test-plans/rwr-doc-toplace-api.md).
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("TOPLACE_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("TOPLACE_TEST_KEY") ?? "";
const VAULT = Deno.env.get("TOPLACE_TEST_VAULT") ?? "/vault";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const SUB_HEADER = Deno.env.get("TOPLACE_TEST_SUB_HEADER") ?? "X-Test-Sub";
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 3, true)
  : null;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}
const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const run = rnd();
const A: Record<string, string> = {};
const B_SUB = `toplace-b-${run}`;
const B: Record<string, string> = { [SUB_HEADER]: B_SUB };

// the shared fixture rows (contract-test/fixtures.sql): a source with text and chunks, a claim that states from 1111...
const SRC_TEXT = "f1000000-0000-4000-8000-000000000001"; // "Opening line of the reference fixture. The quoted span about pinned anchors lives here. ..."
const QUOTE = "The quoted span about pinned anchors lives here.";
const SRC_WHOLE = "11111111-1111-4111-8111-111111111111";
const CLAIM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"; // states from SRC_WHOLE
const NO_DOC = JSON.stringify({ error: "no such document" });
const NO_REF = JSON.stringify({ error: "no such pending reference" });
const PR = "/workbench/contract/documents/pending-refs";
const D = "/workbench/documents";

// every response text B's calls received, kept for the planted-marker search
const seen: string[] = [];
async function call(who: Record<string, string>, method: string, path: string, body?: unknown, raw?: string, ct = "application/json") {
  const headers: Record<string, string> = { "x-brain-key": KEY, ...who };
  if (body !== undefined || raw !== undefined) headers["content-type"] = ct;
  const r = await fetch(BASE + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  if (SUB_HEADER in who) seen.push(text);
  return { status: r.status, json, text };
}
async function newDoc(who: Record<string, string>, title: string, folder = "") {
  const r = await call(who, "POST", D, { title, body: `body of ${title}`, folder });
  assertEquals(r.status, 201, r.text);
  return r.json.path as string;
}
const add = (who: Record<string, string>, path: string, over: Record<string, unknown> = {}) =>
  call(who, "POST", PR, { path, source_id: SRC_TEXT, added_from: "source", ...over });
const list = (who: Record<string, string>, path: string) => call(who, "GET", `${PR}?path=${encodeURIComponent(path)}`);
const rows = (path: string) => sql<{ id: string; owner_sub: string; path: string }>(`SELECT id::text AS id, owner_sub, path FROM public.document_pending_refs WHERE path = $1 ORDER BY created_at, id`, [path]);
const orphans = async () => (await sql<{ n: number }>(
  `SELECT count(*)::int AS n FROM public.document_pending_refs p WHERE NOT EXISTS (SELECT 1 FROM public.user_document_listings l WHERE l.path = p.path)`))[0].n;

t("P1: add a pending ref and list it for that document (a source with a quote, a claim); the refusals are exact", async () => {
  const p = await newDoc(A, `toplace-p1-${run}`);
  const r1 = await add(A, p, { quote: QUOTE, section: "Opening", added_from: "search" });
  assertEquals(r1.status, 201, r1.text);
  assertEquals(
    [r1.json.path, r1.json.source_id, r1.json.claim_id, r1.json.quote, r1.json.section, r1.json.added_from],
    [p, SRC_TEXT, null, QUOTE, "Opening", "search"],
  );
  assert(!/owner|actor|sub/.test(Object.keys(r1.json).join(",")), "no owner or actor field on the wire");
  const r2 = await call(A, "POST", PR, { path: p, claim_id: CLAIM, added_from: "claim" });
  assertEquals(r2.status, 201, r2.text);
  assertEquals([r2.json.claim_id, r2.json.source_id], [CLAIM, null]);
  const l = await list(A, p);
  assertEquals(l.status, 200, l.text);
  assertEquals(l.json.total, 2);
  assertEquals((l.json.pending_refs as any[]).map((x) => x.id), [r1.json.id, r2.json.id], "oldest first");
  assertEquals(l.json.path, p);
  // the table holds the owner and actor the seam resolved, never anything the body said
  const db = await sql(`SELECT owner_sub, actor_sub FROM public.document_pending_refs WHERE id = $1::uuid`, [r1.json.id]);
  assertNotEquals(db[0].owner_sub, B_SUB);
  assertEquals(db[0].owner_sub, db[0].actor_sub);
  // a body with a user field is refused, not honoured
  assertEquals((await add(A, p, { owner_sub: B_SUB, quote: "x" })).status, 400);
  assertEquals((await rows(p)).length, 2);
  // the same cite and quote twice: 409 naming the row already waiting
  const dup = await add(A, p, { quote: QUOTE });
  assertEquals(dup.status, 409, dup.text);
  assertEquals(dup.json.detail.pending_ref_id, r1.json.id);
  // exactly one of source_id / claim_id; bad label; unknown cites; a body that is not JSON; the wrong media type
  assertEquals((await call(A, "POST", PR, { path: p, added_from: "x" })).status, 400);
  assertEquals((await call(A, "POST", PR, { path: p, source_id: SRC_TEXT, claim_id: CLAIM, added_from: "x" })).status, 400);
  assertEquals((await add(A, p, { added_from: "Not A Label" })).status, 400);
  const ghost = "99999999-9999-4999-8999-999999999991";
  assertEquals((await add(A, p, { source_id: ghost })).json.error, "no such source");
  assertEquals((await call(A, "POST", PR, { path: p, claim_id: ghost, added_from: "x" })).json.error, "no such claim");
  assertEquals((await call(A, "POST", PR, undefined, "{not json")).status, 400);
  assertEquals((await call(A, "POST", PR, undefined, "path=x", "text/plain")).status, 415);
  assertEquals((await call(A, "GET", PR)).status, 400, "path is required");
  assertEquals((await add(A, "notes/x.txt")).status, 400, "not a document path");
  assertEquals((await rows(p)).length, 2, "none of the refusals left a row");
  // a quote that names a document path is text: it is stored, and listed back, for its owner
  const q = await add(A, p, { quote: "see documents/some-other/x.md for the original", source_id: SRC_WHOLE });
  assertEquals(q.status, 201, q.text);
});

t("P2: placing at the cursor creates a pinned reference record and removes the row from the queue (chip, transclusion, claim)", async () => {
  const p = await newDoc(A, `toplace-p2-${run}`);
  const a = (await add(A, p, { quote: QUOTE })).json.id as string;
  const claim = (await call(A, "POST", PR, { path: p, claim_id: CLAIM, added_from: "claim" })).json.id as string;
  const pl = await call(A, "POST", `${PR}/${a}/place`, { form: "chip" });
  assertEquals(pl.status, 201, pl.text);
  assertEquals(pl.json.pending_ref_id, a);
  const rec = pl.json.record;
  assertEquals([rec.source_id, rec.state, rec.scope, rec.provenance], [SRC_TEXT, "pinned", "span", "user"]);
  assertEquals(rec.selectors.quote.exact, QUOTE);
  assertEquals(pl.json.insert, `[@ref:${rec.id}]`);
  assertEquals((await list(A, p)).json.total, 1, "it left the queue");
  assertEquals((await rows(p)).map((r) => r.id), [claim]);
  // the document now holds the record as cited, exactly as the existing place-reference path makes it
  const held = await sql<{ origin: string; holder_kind: string }>(
    `SELECT origin, holder_kind FROM public.reference_holders WHERE holder_ref = $1 AND reference_id = $2::uuid`, [p, rec.id]);
  assertEquals(held.map((h) => [h.holder_kind, h.origin]), [["user_document", "cited"]]);
  const refs = await call(A, "GET", `${D}/references?path=${encodeURIComponent(p)}`);
  assert((refs.json.references as any[]).some((r) => r.reference_id === rec.id && r.pinned_revision === rec.pinned_revision));
  // it is gone for good: placing it again, or removing it, is a missing row
  const again = await call(A, "POST", `${PR}/${a}/place`, {});
  assertEquals([again.status, again.text], [404, NO_REF]);
  assertEquals((await call(A, "DELETE", `${PR}/${a}`)).text, NO_REF);
  // a claim places on the source it states from (a whole-source reference), default form chip
  const pc = await call(A, "POST", `${PR}/${claim}/place`, {});
  assertEquals(pc.status, 201, pc.text);
  assertEquals([pc.json.record.source_id, pc.json.record.scope, pc.json.form], [SRC_WHOLE, "source", "chip"]);
  assertEquals((await list(A, p)).json.total, 0);
  // a transclusion carries its quote as protected text; the same source in another document
  const p2 = await newDoc(A, `toplace-p2b-${run}`);
  const tr = (await add(A, p2, { quote: QUOTE })).json.id;
  const ptr = await call(A, "POST", `${PR}/${tr}/place`, { form: "transclusion" });
  assertEquals(ptr.status, 201, ptr.text);
  assert((ptr.json.insert as string).startsWith(`{{ref:${ptr.json.record.id}}}${QUOTE}`), ptr.json.insert);
  // refusals leave the row where it was (the removal is rolled back with the placement)
  const p3 = await newDoc(A, `toplace-p3-${run}`);
  const noQuote = (await add(A, p3, { source_id: SRC_WHOLE })).json.id;
  const badQuote = (await add(A, p3, { quote: "this sentence is not in the source at all" })).json.id;
  assertEquals((await call(A, "POST", `${PR}/${noQuote}/place`, { form: "transclusion" })).status, 400);
  assertEquals((await call(A, "POST", `${PR}/${badQuote}/place`, {})).status, 422);
  assertEquals((await call(A, "POST", `${PR}/${noQuote}/place`, { form: "added" })).status, 400);
  assertEquals((await call(A, "POST", `${PR}/${noQuote}/place`, { user: "b" })).status, 400);
  assertEquals((await rows(p3)).length, 2, "both rows still wait");
  // a document may cite one source more than once (the place path allows it): the second placement succeeds and leaves the queue too
  const first = await call(A, "POST", `${PR}/${noQuote}/place`, {});
  assertEquals(first.status, 201, first.text);
  const second = (await add(A, p3, { source_id: SRC_WHOLE, quote: "", section: "again" })).json;
  assertEquals((await call(A, "POST", `${PR}/${second.id}/place`, {})).status, 201);
  assertEquals((await rows(p3)).map((r) => r.id), [badQuote], "only the refused row still waits");
  // taking one out (the delete route) removes only it
  assertEquals((await call(A, "DELETE", `${PR}/${badQuote}`)).json.removed, badQuote);
  assertEquals((await rows(p3)).length, 0);
});

t("P3: trash then restore keeps the queue; a move, an archive and a folder trash carry it; delete forever removes it (no orphan)", async () => {
  assertEquals((await call(A, "POST", `${D}/folders`, { path: `tpg-${run}` })).status, 201);
  const p = await newDoc(A, `toplace-p3-${run}`, `tpf-${run}`);
  const ids = [(await add(A, p, { quote: QUOTE })).json.id, (await call(A, "POST", PR, { path: p, claim_id: CLAIM, added_from: "claim" })).json.id];
  const idsOf = async (path: string) => (await list(A, path)).json.pending_refs.map((x: any) => x.id);
  // trash: the queue is under the trashed path, the same rows
  const tr = (await call(A, "POST", `${D}/trash`, { path: p })).json.trashed as string;
  assertEquals(await idsOf(tr), ids);
  assertEquals((await list(A, p)).status, 404, "the old path is no document any more");
  assertEquals((await rows(tr)).length, 2);
  // restore: back, still the same rows (same ids, same order)
  const back = (await call(A, "POST", `${D}/restore`, { path: tr })).json.restored as string;
  assertEquals(back, p);
  assertEquals(await idsOf(p), ids);
  // move to another folder carries it
  const mv = (await call(A, "POST", `${D}/move`, { from: p, to_folder: `tpg-${run}` })).json.to as string;
  assertNotEquals(mv, p);
  assertEquals(await idsOf(mv), ids);
  assertEquals((await rows(p)).length, 0);
  // archive and unarchive carry it
  const arch = (await call(A, "POST", `${D}/archive`, { path: mv })).json.archived as string;
  assertEquals(await idsOf(arch), ids);
  const un = (await call(A, "POST", `${D}/unarchive`, { path: arch })).json.unarchived as string;
  assertEquals(await idsOf(un), ids);
  // a folder deleted trashes its documents: the queue goes to the trashed path
  const folder = mv.split("/").slice(0, -1).join("/");
  const df = await call(A, "DELETE", `${D}/folders?path=${encodeURIComponent(folder)}`);
  assertEquals(df.status, 200, df.text);
  const inTrash = (await sql<{ path: string }>(`SELECT DISTINCT path FROM public.document_pending_refs WHERE id = ANY($1::uuid[])`, [ids])).map((r) => r.path);
  assertEquals(inTrash.length, 1);
  assert(inTrash[0].includes("/.trash/"), inTrash[0]);
  assertEquals(await idsOf(inTrash[0]), ids);
  // delete forever removes the queue with the document - no orphan row remains
  const gone = await call(A, "POST", `${D}/delete-forever`, { path: inTrash[0], confirm: true });
  assertEquals(gone.status, 200, gone.text);
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.document_pending_refs WHERE id = ANY($1::uuid[])`, [ids]))[0].n, 0);
  assertEquals(await orphans(), 0);
  // empty trash removes the queues of the documents it empties, and only those
  const e1 = await newDoc(A, `toplace-e1-${run}`);
  const e2 = await newDoc(A, `toplace-e2-${run}`);
  await add(A, e1);
  const keep = (await add(A, e2)).json.id;
  const t1 = (await call(A, "POST", `${D}/trash`, { path: e1 })).json.trashed;
  const et = await call(A, "POST", `${D}/empty-trash`, { confirm: true });
  assertEquals(et.status, 200, et.text);
  assertEquals((await rows(t1)).length, 0);
  assertEquals((await rows(e1)).length, 0);
  assertEquals((await rows(e2)).map((r) => r.id), [keep], "the live document's queue is untouched");
  // the reconcile pass removes a listing whose file is gone: its queue goes too
  await Deno.remove(`${VAULT}/${e2}`);
  const rc = await call(A, "POST", `${D}/reconcile`, {});
  assertEquals(rc.status, 200, rc.text);
  assertEquals((await rows(e2)).length, 0);
  assertEquals(await orphans(), 0);
});

t("P4: two identities, planted data: B never sees A's pending refs (list, add, place, delete, counts, nested fields, messages)", async () => {
  const markA = `MARKA-${rnd()}`;
  const markB = `MARKB-${rnd()}`;
  const pa = await newDoc(A, `toplace-p4a-${run}`);
  const pb = await newDoc(B, `toplace-p4b-${run}`);
  const aRows = [
    (await add(A, pa, { quote: QUOTE, section: markA })).json.id,
    (await call(A, "POST", PR, { path: pa, claim_id: CLAIM, section: markA, added_from: "claim" })).json.id,
    (await add(A, pa, { source_id: SRC_WHOLE, section: markA })).json.id,
  ] as string[];
  const bRow = (await add(B, pb, { quote: QUOTE, section: markB })).json.id as string;
  const snapA = async () => JSON.stringify(await sql(`SELECT * FROM public.document_pending_refs WHERE owner_sub <> $1 ORDER BY id`, [B_SUB]));
  const before = await snapA();
  // the same cite on B's own document is no conflict with A's (and tells B nothing about A's)
  assertEquals((await add(B, pb, { quote: QUOTE, section: markB })).status, 409, "B's own duplicate");
  assertEquals((await add(B, pb, { source_id: SRC_WHOLE })).status, 201);
  // list: B names A's document (full path, and the same file relative) - exactly the answer of a path nobody has
  const missingOwn = await list(B, `documents/${B_SUB}/nobody-${run}.md`);
  const missingElse = await list(B, `documents/nobody-key-${run}/x.md`);
  const foreign = await list(B, pa);
  const foreignRel = await call(B, "GET", `${PR}?path=${encodeURIComponent("../" + pa.split("/")[1] + "/" + pa.split("/").slice(2).join("/"))}`);
  for (const r of [missingOwn, missingElse, foreign]) assertEquals([r.status, r.text], [404, NO_DOC]);
  assert(foreignRel.status === 404 || foreignRel.status === 400, `${foreignRel.status} ${foreignRel.text}`);
  assert(!foreignRel.text.includes(markA));
  // B's own list: B's rows only; the total is B's own (never A's three)
  const bl = await list(B, pb);
  assertEquals(bl.json.total, 2);
  assert(!bl.text.includes(markA) && !bl.text.includes(aRows[0]), "nothing of A's in B's list");
  // add on A's document: the same refusal as a missing document, nothing written
  const addForeign = await add(B, pa, { source_id: SRC_WHOLE });
  const addMissing = await add(B, `documents/${B_SUB}/nobody-${run}.md`, { source_id: SRC_WHOLE });
  assertEquals([addForeign.status, addForeign.text], [404, NO_DOC]);
  assertEquals([addMissing.status, addMissing.text], [404, NO_DOC]);
  // delete / place A's row by id: byte-identical to a missing id and a malformed one; A's row is unchanged
  const ghost = "99999999-9999-4999-8999-999999999992";
  for (const id of aRows) {
    for (const [method, suffix, body] of [["DELETE", "", undefined], ["POST", "/place", {}], ["POST", "/place", { form: "chip" }]] as const) {
      const real = await call(B, method, `${PR}/${id}${suffix}`, body);
      const miss = await call(B, method, `${PR}/${ghost}${suffix}`, body);
      const bad = await call(B, method, `${PR}/not-an-id${suffix}`, body);
      assertEquals([real.status, real.text], [404, NO_REF]);
      assertEquals(real.text, miss.text, "another user's row is byte-identical to a missing one");
      assertEquals(real.text, bad.text);
      assert(!real.text.includes(id), "the id B sent is not echoed");
    }
  }
  assertEquals(await snapA(), before, "A's rows are unchanged, byte for byte, after every attempt of B's");
  // B's own delete and place of B's own row still work, and touch nothing of A's
  assertEquals((await call(B, "DELETE", `${PR}/${bRow}`)).status, 200);
  assertEquals(await snapA(), before);
  // A still reads all three, with the marker, and B's rows never appear for A
  const al = await list(A, pa);
  assertEquals(al.json.total, 3);
  assert(al.text.includes(markA) && !al.text.includes(markB));
  // B cannot reach A's document through the documents API either (the queue is not a way round the owner scope)
  assertEquals((await call(B, "POST", `${D}/trash`, { path: pa })).text, NO_DOC);
  // nothing B received, in any call of this whole file, carries A's marker or A's row ids
  assert(seen.length > 10, "B's responses were kept");
  for (const s of seen) {
    if (s.includes(markA)) assert(false, "A's marker reached a response of B's");
    for (const id of aRows) if (s.includes(id)) assert(false, "A's row id reached a response of B's");
  }
});

t("P5: nothing private from this item appears on a shared surface (a planted marker: tables, shared search, shared reads, the vault)", async () => {
  const mark = `PLANT-${rnd()}-QUOTE`;
  const markS = `PLANT-${rnd()}-SECTION`;
  const p = await newDoc(A, `toplace-p5-${run}`);
  assertEquals((await add(A, p, { source_id: SRC_WHOLE, quote: "", section: markS, added_from: "chat" })).status, 201);
  // a quote that is in the source (placeable) carrying the marker is not possible, so plant it in the quote of a claim cite
  const pq = await call(A, "POST", PR, { path: p, claim_id: CLAIM, quote: mark, added_from: "claim" });
  assertEquals(pq.status, 201, pq.text);
  // 1. every other table of the database: not one row text holds either marker
  const tables = (await sql<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'document_pending_refs'`)).map((r) => r.t);
  const hits: string[] = [];
  let read = 0;
  for (const tb of tables) {
    try {
      const n = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public."${tb}" x WHERE x::text LIKE $1 OR x::text LIKE $2`, [`%${mark}%`, `%${markS}%`]))[0].n;
      read++;
      if (n) hits.push(`${tb}:${n}`);
    } catch { /* an unreadable table is counted below */ }
  }
  assert(read >= tables.length * 0.9, `most tables were scanned (${read} / ${tables.length})`);
  assertEquals(hits, [], "no other table holds the marker");
  // 2. the shared reads and searches, as A and as B (a search echoes its own query, so it asks by the marker's first 16 characters: the full marker must not come back)
  for (const who of [A, B]) {
    for (const path of [`/workbench/search?q=${mark.slice(0, 16)}`, `/workbench/search?q=${markS.slice(0, 16)}`, `/workbench/contract/search?q=${mark.slice(0, 16)}`,
      `/workbench/contract/documents`, `/workbench/contract/sources`, `/workbench/documents/references?path=${encodeURIComponent(p)}`, `/workbench/contract/timeline`]) {
      const r = await call(who, "GET", path);
      assert(!r.text.includes(mark) && !r.text.includes(markS), `${path} (${who === A ? "A" : "B"}) carries a planted marker`);
    }
  }
  // 3. the vault (the shared files): the document is untouched, no file anywhere holds a marker
  let files = 0;
  async function walk(dir: string) {
    for await (const e of Deno.readDir(dir)) {
      if (e.name === ".git") continue;
      const f = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(f);
      else if (e.isFile) {
        files++;
        const txt = await Deno.readTextFile(f).catch(() => "");
        assert(!txt.includes(mark) && !txt.includes(markS), `${f} holds a planted marker`);
      }
    }
  }
  await walk(VAULT);
  assert(files > 0, "the vault was scanned");
  // the markers are there for their owner (the test would pass vacuously otherwise)
  const own = await list(A, p);
  assert(own.text.includes(mark) && own.text.includes(markS));
  // the workbench log is searched by the runner (it holds the same markers' prefix: PLANT-)
});

t("P6: the schema is what the migration says: the queue is bound to the listing by FK, rights are exact, the check script's rules hold", async () => {
  // a row for a path no listing has cannot exist, whoever inserts it
  let refused = "";
  try {
    await sql(`INSERT INTO public.document_pending_refs (owner_sub, actor_sub, path, source_id, added_from) VALUES ('x', 'x', $1, $2::uuid, 'source')`, [`documents/none/${run}.md`, SRC_WHOLE]);
  } catch (e) {
    refused = String((e as { fields?: { code?: string } })?.fields?.code ?? e);
  }
  assertEquals(refused, "23503", "no orphan can be inserted");
  // one target exactly
  for (const [s, c] of [[null, null], [SRC_WHOLE, CLAIM]] as const) {
    const p = await newDoc(A, `toplace-p6-${rnd()}`);
    let code = "";
    try {
      await sql(`INSERT INTO public.document_pending_refs (owner_sub, actor_sub, path, source_id, claim_id, added_from) VALUES ('x', 'x', $1, $2::uuid, $3::uuid, 'source')`, [p, s, c]);
    } catch (e) {
      code = String((e as { fields?: { code?: string } })?.fields?.code ?? e);
    }
    assertEquals(code, "23514");
  }
  assertEquals(await orphans(), 0);
  const acl = (await sql<{ g: string }>(
    `SELECT string_agg(coalesce(ro.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY coalesce(ro.rolname, 'PUBLIC'), a.privilege_type) AS g
       FROM pg_class cl, aclexplode(cl.relacl) a LEFT JOIN pg_roles ro ON ro.oid = a.grantee
      WHERE cl.oid = 'public.document_pending_refs'::regclass AND (ro.oid IS NULL OR ro.oid <> cl.relowner)`))[0].g;
  assertEquals(acl, "service_role:DELETE,service_role:INSERT,service_role:SELECT");
});

t("P7: the queue is bounded (200 per document) and a placed or removed row frees its place; counts are the caller's own", async () => {
  const p = await newDoc(A, `toplace-p7-${run}`);
  // fill the document's queue by SQL (a source-less loop through the API would take minutes); the 201st add is refused
  const owner = (await sql<{ owner_sub: string }>(`SELECT owner_sub FROM public.user_document_listings WHERE path = $1`, [p]))[0].owner_sub;
  await sql(
    `INSERT INTO public.document_pending_refs (owner_sub, actor_sub, path, claim_id, quote, added_from)
     SELECT $1, $1, $2, $3::uuid, 'bulk-' || g, 'bulk' FROM generate_series(1, 200) g`, [owner, p, CLAIM]);
  const full = await add(A, p, { source_id: SRC_WHOLE });
  assertEquals(full.status, 409, full.text);
  assert(full.json.error.includes("queue is full"));
  const l = await call(A, "GET", `${PR}?path=${encodeURIComponent(p)}&limit=5`);
  assertEquals([l.json.pending_refs.length, l.json.total], [5, 200], "total is the whole queue, not the page");
  const one = (await rows(p))[0].id;
  assertEquals((await call(A, "DELETE", `${PR}/${one}`)).status, 200);
  assertEquals((await add(A, p, { source_id: SRC_WHOLE })).status, 201, "a removed row frees its place");
  // B's total for a document of B's own is not moved by A's two hundred
  const pb = await newDoc(B, `toplace-p7b-${run}`);
  assertEquals((await list(B, pb)).json.total, 0);
});

t("P8: the placement and the removal are one step: two callers placing one row get one placement and one refusal", async () => {
  const p = await newDoc(A, `toplace-p8-${run}`);
  const id = (await add(A, p, { quote: QUOTE })).json.id as string;
  const rs = await Promise.all([1, 2, 3, 4].map(() => call(A, "POST", `${PR}/${id}/place`, {})));
  const codes = rs.map((r) => r.status).sort();
  assertEquals(codes, [201, 404, 404, 404], JSON.stringify(rs.map((r) => r.text)));
  const held = await sql(`SELECT 1 FROM public.reference_holders WHERE holder_ref = $1`, [p]);
  assertEquals(held.length, 1, "one reference was placed");
  assertEquals((await rows(p)).length, 0);
});

Deno.test({ name: "pool close", ignore, fn: async () => { await pool!.end(); }, sanitizeOps: false, sanitizeResources: false });
