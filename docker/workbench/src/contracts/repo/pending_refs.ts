// The document's "to place" queue (research-workbench redesign, rwr-doc-toplace-api): the reads and writes over
// public.document_pending_refs (init-document-toplace.sql, slot 630).
//
// Per user (07-MULTI-USER): a queue row is its owner's own context. owner_sub is the identity seam's subject_sub and
// actor_sub who acted; every read and every write filters by owner_sub = who.sub IN THE QUERY, and the document must be
// the caller's own LISTED document. Another user's document, a document that is not listed and a path nobody has all
// answer 404 "no such document"; another user's row, a missing row and an id that is no id all answer 404
// "no such pending reference": a refusal for another user's row is the same answer as a missing row, byte for byte, and
// no count or field of anyone else's rows is ever read into a response.
//
// The queue follows its document by the database (path is a foreign key to the listing record, ON UPDATE / DELETE
// CASCADE): this file never moves or removes a row for a document move, trash or delete.
// Placing calls the existing place-reference path (references.placeReference) and deletes the row in the SAME
// transaction: a placement that is refused (the quote is not in the source, the document already cites it) leaves the row
// where it was. This file never writes to sources, claims or reference_records itself.
import type { Db } from "../db.ts";
import type { RegistryReader } from "../registry.ts";
import { BadRequest } from "../logic/scope.ts";
import { Conflict, NotFound } from "./lifecycle.ts";
import { placeReference, SelectorRefused, targetHead } from "./references.ts";
import type { Identity } from "../../middleware/identity.ts";
import { docRel, HOLDER_KIND } from "../../documents/paths.ts";
import { chipText, transclusionText } from "../../documents/grammar.ts";
import { claimVisibleTo } from "./private_claims.ts";

export interface PendingRefRow {
  id: string;
  path: string;
  source_id: string | null;
  claim_id: string | null;
  section: string;
  quote: string;
  added_from: string;
  created_at: string;
}

const COLS = `id::text AS id, path, source_id::text AS source_id, claim_id::text AS claim_id, section, quote, added_from, created_at`;
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The ONE refusal words: another user's document, a missing one and an unlisted one are all this; another user's
// queue row, a missing one and a malformed id are all NO_REF.
export const NO_DOC = "no such document";
export const NO_REF = "no such pending reference";

// A queue holds at most this many cites per document (a bound, not a quota the UI is expected to reach).
export const MAX_PER_DOCUMENT = 200;

export const FORMS = ["chip", "transclusion"];

// The caller's own LISTED document at `path`, as its vault path. A path that is not a document path is the caller's
// error (400, whoever owns what), never an ownership answer.
async function ownListed(db: Db, who: Identity, path: string): Promise<string> {
  let rel: string;
  try {
    rel = docRel(path, who);
  } catch {
    throw new BadRequest("path must be a document path (a .md file under documents/)");
  }
  const r = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM public.user_document_listings WHERE path = $1 AND owner_sub = $2) AS ok`, [rel, who.sub],
  );
  if (!r[0]?.ok) throw new NotFound(NO_DOC);
  return rel;
}

export interface AddInput {
  path: string;
  source_id?: string;
  claim_id?: string;
  section?: string;
  quote?: string;
  added_from: string;
}

export async function addPendingRef(db: Db, who: Identity, b: AddInput): Promise<PendingRefRow> {
  if ((b.source_id === undefined) === (b.claim_id === undefined)) throw new BadRequest("give exactly one of source_id or claim_id");
  const rel = await ownListed(db, who, b.path);
  if (b.source_id !== undefined) {
    // a source or a held source the caller may read: another user's held source is a missing one (no oracle)
    if (!(await targetHead(db, b.source_id, who))) throw new NotFound("no such source");
  } else {
    const c = await db.query<{ ok: boolean }>(`SELECT EXISTS (SELECT 1 FROM public.claims c WHERE c.id = $1 AND ${claimVisibleTo("c", "$2")}) AS ok`, [b.claim_id, who.sub]);
    if (!c[0]?.ok) throw new NotFound("no such claim"); // a private-report claim that is not the caller's answers as a missing one (no oracle)
  }
  try {
    // The bound and the insert are ONE step (attempt 1, D2): an advisory lock on (owner, document) serialises the adds of one
    // queue for the length of the transaction, so the count a caller reads is still true when its row goes in.
    const r = await db.tx(async (t) => {
      await t.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || '|' || $2, 630))`, [who.sub, rel]);
      const n = (await t.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.document_pending_refs WHERE owner_sub = $1 AND path = $2`, [who.sub, rel],
      ))[0].n;
      if (n >= MAX_PER_DOCUMENT) throw new Conflict(`this document's to-place queue is full (${MAX_PER_DOCUMENT} cites): place or remove some first`);
      return await t.query<PendingRefRow>(
        `INSERT INTO public.document_pending_refs (owner_sub, actor_sub, path, source_id, claim_id, section, quote, added_from)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (owner_sub, path, (COALESCE(source_id::text, 'claim:' || claim_id::text)), md5(quote)) DO NOTHING
         RETURNING ${COLS}`,
        [who.sub, who.actor, rel, b.source_id ?? null, b.claim_id ?? null, b.section ?? "", b.quote ?? "", b.added_from],
      );
    });
    if (r[0]) return r[0];
  } catch (e) {
    // the document's listing went away between the check and the insert (a delete forever): it is a missing document
    if ((e as { fields?: { code?: string } })?.fields?.code === "23503") throw new NotFound(NO_DOC);
    throw e;
  }
  const dup = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM public.document_pending_refs
      WHERE owner_sub = $1 AND path = $2 AND COALESCE(source_id::text, 'claim:' || claim_id::text) = $3
        AND md5(quote) = md5($4::text) AND quote = $4::text`,
    [who.sub, rel, b.source_id ?? `claim:${b.claim_id}`, b.quote ?? ""],
  );
  throw new Conflict("this cite is already waiting in this document", { pending_ref_id: dup[0]?.id ?? null });
}

// The caller's own queue for one of their own documents, oldest first (the order they were gathered in).
export async function listPendingRefs(db: Db, who: Identity, path: string, limit: number) {
  const rel = await ownListed(db, who, path);
  const rows = await db.query<PendingRefRow>(
    `SELECT ${COLS} FROM public.document_pending_refs WHERE owner_sub = $1 AND path = $2 ORDER BY created_at, id LIMIT $3`,
    [who.sub, rel, limit],
  );
  const total = (await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.document_pending_refs WHERE owner_sub = $1 AND path = $2`, [who.sub, rel],
  ))[0].n;
  return { path: rel, pending_refs: rows, total };
}

// Take one of the caller's own cites out of the queue (another user's, a missing one and a malformed id: NO_REF).
export async function removePendingRef(db: Db, who: Identity, id: string): Promise<{ removed: string }> {
  if (!UUIDISH.test(id)) throw new NotFound(NO_REF);
  const r = await db.query<{ id: string }>(
    `DELETE FROM public.document_pending_refs WHERE id = $1 AND owner_sub = $2 RETURNING id::text AS id`, [id, who.sub],
  );
  if (!r[0]) throw new NotFound(NO_REF);
  return { removed: r[0].id };
}

// The source a claim's cite is placed on: the source the claim directly states from (strongest edge, then oldest).
async function sourceOfClaim(db: Db, claimId: string): Promise<string | null> {
  const r = await db.query<{ source_id: string }>(
    `SELECT cs.source_id::text AS source_id FROM public.claim_sources cs
      WHERE cs.claim_id = $1 AND cs.source_id IS NOT NULL
      ORDER BY (cs.edge_type = 'states') DESC, cs.weight DESC, cs.created_at, cs.id LIMIT 1`,
    [claimId],
  );
  return r[0]?.source_id ?? null;
}

// Place one of the caller's own queued cites at the cursor: the existing place-reference path pins a reference record
// for the document, and the row leaves the queue in the same transaction (a refusal rolls the removal back).
export async function placePendingRef(db: Db, reg: RegistryReader, who: Identity, id: string, form: string | undefined) {
  const f = form ?? "chip";
  if (!FORMS.includes(f)) throw new BadRequest("form is chip or transclusion");
  if (!UUIDISH.test(id)) throw new NotFound(NO_REF);
  return await db.tx(async (t) => {
    // the claim on the row first: two callers placing one row get one placement and one NO_REF
    const row = (await t.query<PendingRefRow>(
      `DELETE FROM public.document_pending_refs WHERE id = $1 AND owner_sub = $2 RETURNING ${COLS}`, [id, who.sub],
    ))[0];
    if (!row) throw new NotFound(NO_REF);
    if (f === "transclusion" && !row.quote.trim()) throw new BadRequest("a transclusion needs a quote: this cite has none");
    const sourceId = row.source_id ?? (await sourceOfClaim(t, row.claim_id!));
    if (!sourceId) throw new SelectorRefused("the claim states from no source to place a reference on");
    const placed = await placeReference(t, reg, {
      source_id: sourceId, exact: row.quote.trim() ? row.quote : null,
      holder: { kind: HOLDER_KIND, ref: row.path, origin: "cited" }, by: who.name, who,
    });
    const rec = placed.record;
    const quote = (rec.selectors as { quote?: { exact?: string } }).quote?.exact ?? "";
    return { pending_ref_id: row.id, form: f, record: rec, insert: f === "transclusion" ? transclusionText(rec.id, quote) : chipText(rec.id) };
  });
}
