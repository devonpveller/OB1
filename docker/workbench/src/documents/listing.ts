// The user document listing record and the references a document holds (research-workbench P2b,
// D12, P2a, D17 item 6).
//
// The listing record (user_document_listings, P0) keeps title, path, updated and the outbound
// links AS IDS - never the body. It is derived from the file and rebuildable from the documents
// tree (reconcile). Its links point at the reference records the document holds (pins live there,
// P2a): one whole-source record per (document, source) for a plain [[source:<id>]] link, placed the
// first time the link is saved and never moved; one record per chip or transclusion, named in the
// text. A refinery tethered to the document picks the links up (refinery_picked_links) unless it is
// archived; linking a source hidden in the refinery unhides it (the pick-up rule).
import type { Db } from "../contracts/db.ts";
import type { RegistryReader } from "../contracts/registry.ts";
import { placeReference, targetHead } from "../contracts/repo/references.ts";
import { type ParsedDocument, parseDocument, referenceIdsOf } from "./grammar.ts";
import { HOLDER_KIND } from "./paths.ts";

export interface OutboundLink {
  kind: string;
  id: string;
  pin: number | null;
  reference_id: string | null;
}

interface HolderRow {
  id: string;
  reference_id: string | null;
  origin: string;
  source_id: string | null;
  scope: string | null;
}

async function holderRows(db: Db, rel: string): Promise<HolderRow[]> {
  return await db.query<HolderRow>(
    `SELECT h.id::text AS id, h.reference_id::text AS reference_id, h.origin, r.source_id::text AS source_id, r.scope
       FROM public.reference_holders h LEFT JOIN public.reference_records r ON r.id = h.reference_id
      WHERE h.holder_kind = $1 AND h.holder_ref = $2 ORDER BY h.seq`,
    [HOLDER_KIND, rel],
  );
}

async function dropHolder(db: Db, h: HolderRow) {
  await db.query(`DELETE FROM public.reference_holders WHERE id = $1`, [h.id]);
  if (h.reference_id) {
    // held by nothing any more (pins are per holder): the record goes with its last holder
    await db.query(
      `DELETE FROM public.reference_records r WHERE r.id = $1
         AND NOT EXISTS (SELECT 1 FROM public.reference_holders x WHERE x.reference_id = r.id)
         AND NOT EXISTS (SELECT 1 FROM public.refinery_picked_links p WHERE p.reference_id = r.id)`,
      [h.reference_id],
    );
  }
}

// Bring the holder rows in line with the text. Returns the links the listing records.
export async function syncHolders(db: Db, reg: RegistryReader, rel: string, doc: ParsedDocument, by: string | null) {
  const textRefs = referenceIdsOf(doc);
  const linkSources = [...new Set(doc.links.filter((l) => l.kind === "source").map((l) => l.id))];
  const rows = await holderRows(db, rel);
  const linkRecord = new Map<string, string>(); // source id -> its whole-source record for this document
  for (const h of rows.filter((r) => r.origin === "cited")) {
    if (h.reference_id && textRefs.includes(h.reference_id)) continue;
    if (h.reference_id && h.scope === "source" && h.source_id && linkSources.includes(h.source_id) && !linkRecord.has(h.source_id)) {
      linkRecord.set(h.source_id, h.reference_id);
      continue;
    }
    await dropHolder(db, h);
  }
  const held = new Set(rows.map((r) => r.reference_id));
  for (const id of textRefs) {
    if (held.has(id)) continue;
    // a chip pasted from another document: the record exists - hold it here too
    const rec = (await db.query<{ source_id: string }>(`SELECT source_id::text FROM public.reference_records WHERE id = $1`, [id]))[0];
    if (!rec) continue;
    await db.query(
      `INSERT INTO public.reference_holders (holder_kind, holder_ref, reference_id, cited_ref, origin, seq, number)
       SELECT $1, $2, $3, $4, 'cited',
              COALESCE((SELECT max(seq) + 1 FROM public.reference_holders WHERE holder_kind = $1 AND holder_ref = $2), 0), NULL
       ON CONFLICT DO NOTHING`,
      [HOLDER_KIND, rel, id, rec.source_id],
    );
  }
  for (const sid of linkSources) {
    if (linkRecord.has(sid) || !(await targetHead(db, sid))) continue; // a link to nothing stays a live link
    const out = await placeReference(db, reg, {
      source_id: sid, holder: { kind: HOLDER_KIND, ref: rel, origin: "cited" }, by: by ?? "document",
    });
    linkRecord.set(sid, out.record.id);
  }
  return await outboundLinks(db, rel, doc, linkRecord);
}

async function outboundLinks(db: Db, rel: string, doc: ParsedDocument, linkRecord: Map<string, string>): Promise<OutboundLink[]> {
  const out: OutboundLink[] = [];
  const seen = new Set<string>();
  const push = (l: OutboundLink) => {
    const k = `${l.kind}:${l.id}:${l.reference_id ?? ""}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(l);
    }
  };
  for (const l of doc.links) {
    push({ kind: l.kind, id: l.id, pin: null, reference_id: l.kind === "source" ? linkRecord.get(l.id) ?? null : null });
  }
  const recs = await db.query<{ id: string; source_id: string; pinned_revision: number; origin: string }>(
    `SELECT r.id::text AS id, r.source_id::text AS source_id, r.pinned_revision, h.origin
       FROM public.reference_holders h JOIN public.reference_records r ON r.id = h.reference_id
      WHERE h.holder_kind = $1 AND h.holder_ref = $2 ORDER BY h.seq`,
    [HOLDER_KIND, rel],
  );
  const textRefs = new Set(referenceIdsOf(doc));
  for (const r of recs) {
    if (textRefs.has(r.id) || r.origin === "added") push({ kind: "source", id: r.source_id, pin: r.pinned_revision, reference_id: r.id });
  }
  // pins are read from the records (the listing points at them); a link without a record has none
  const pins = new Map(recs.map((r) => [r.id, r.pinned_revision]));
  return out.map((l) => ({ ...l, pin: l.reference_id ? pins.get(l.reference_id) ?? null : null }));
}

// Upsert the listing row for one document from its file. Throws on any database failure - the
// caller decides how that is reported (a save reports it once; the reconcile retries). `owner` is the
// identity seam's subject: written when the row is created, never changed by a later sync.
export async function syncListing(
  db: Db, reg: RegistryReader, rel: string, md: string, who: { sub: string; actor: string }, by: string | null = null,
) {
  const doc = parseDocument(md, rel);
  return await db.tx(async (t) => {
    await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`user-document:${rel}`]);
    const links = await syncHolders(t, reg, rel, doc, by);
    const row = (await t.query<{ id: string; refinery_id: string | null }>(
      `INSERT INTO public.user_document_listings (path, title, outbound_links, updated_at, owner_sub, actor_sub)
       VALUES ($1, $2, $3::jsonb, now(), $4, $5)
       ON CONFLICT (path) DO UPDATE SET title = EXCLUDED.title, outbound_links = EXCLUDED.outbound_links, updated_at = now(),
                                        actor_sub = EXCLUDED.actor_sub
       RETURNING id::text AS id, refinery_id::text AS refinery_id, owner_sub`,
      [rel, doc.title, JSON.stringify(links), who.sub, who.actor],
    ))[0] as { id: string; refinery_id: string | null; owner_sub: string };
    if (row.refinery_id) await pickUp(t, row.refinery_id, links, { sub: row.owner_sub, actor: who.actor });
    return { id: row.id, title: doc.title, links, refinery_id: row.refinery_id };
  });
}

// The pick-up rule (D17 item 6): a tethered, not archived refinery takes the document's links into
// its context graph (with the document's pin), and linking a source hidden there unhides it. An
// archived refinery picks up nothing; reopening it runs this again.
export async function pickUp(db: Db, refineryId: string, links: OutboundLink[], who: { sub: string; actor: string }) {
  const st = (await db.query<{ archived_at: string | null }>(
    `SELECT archived_at FROM public.refinery_state WHERE refinery_id = $1`, [refineryId],
  ))[0];
  if (st?.archived_at) return { picked: 0, archived: true };
  for (const l of links) {
    await db.query(
      `INSERT INTO public.refinery_picked_links (refinery_id, node_kind, node_ref, reference_id, pin, owner_sub, actor_sub)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (refinery_id, node_kind, node_ref) DO UPDATE
         SET reference_id = COALESCE(EXCLUDED.reference_id, refinery_picked_links.reference_id),
             pin = COALESCE(EXCLUDED.pin, refinery_picked_links.pin), actor_sub = EXCLUDED.actor_sub`,
      [refineryId, l.kind, l.id, l.reference_id, l.pin, who.sub, who.actor],
    );
    await db.query(`DELETE FROM public.refinery_hidden WHERE refinery_id = $1 AND node_kind = $2 AND node_ref = $3`, [refineryId, l.kind, l.id]);
  }
  return { picked: links.length, archived: false };
}

export async function deleteListing(db: Db, rel: string) {
  await db.tx(async (t) => {
    for (const h of await holderRows(t, rel)) await dropHolder(t, h);
    await t.query(`DELETE FROM public.user_document_listings WHERE path = $1`, [rel]);
  });
}

// A move keeps the listing row (its id, its refinery) and the document's references with it.
export async function moveListing(db: Db, from: string, to: string) {
  await db.tx(async (t) => {
    await t.query(`UPDATE public.reference_holders SET holder_ref = $2 WHERE holder_kind = $3 AND holder_ref = $1`, [from, to, HOLDER_KIND]);
    await t.query(`UPDATE public.user_document_listings SET path = $2, updated_at = now() WHERE path = $1`, [from, to]);
  });
}

export interface ListingRow {
  id: string;
  path: string;
  title: string;
  updated_at: string;
  refinery_id: string | null;
  owner_sub: string;
}

export async function listingRow(db: Db, rel: string): Promise<ListingRow | null> {
  return (await db.query<ListingRow>(
    `SELECT id::text AS id, path, title, updated_at, refinery_id::text AS refinery_id, owner_sub
       FROM public.user_document_listings WHERE path = $1`, [rel],
  ))[0] ?? null;
}
