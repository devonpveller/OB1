// The export's database side (research-workbench P6a): the numbered references a document holds,
// with what each needs to become a CSL item, and the resolution cache on the reference record.
import type { Db } from "../contracts/db.ts";
import { exportOrder } from "../contracts/logic/citations.ts";
import { LEGACY_NOTE } from "../contracts/repo/references.ts";
import type { CslItem } from "./csl.ts";

export interface ExportRef {
  number: number;
  cited_ref: string; // the id as the document wrote it
  reference_id: string | null; // null for a page that is not a holder, or a citation of nothing
  pinned_revision: number | null;
  source_id: string | null; // null: the citation resolves to no source
  suppressed: boolean;
  title: string | null; // at the pinned revision
  url: string | null;
  metadata: Record<string, unknown> | null;
  accessed: string | null;
  cached: { identifier: string; csl: CslItem; via: string }[];
}

const SOURCE_COLS = `s.id::text AS source_id, (s.retraction_committed_at IS NOT NULL) AS suppressed, s.url, s.metadata,
  COALESCE(s.fetched_at, s.created_at)::date::text AS accessed`;

// A legacy note: its holder rows (P2a), numbered, with the source at the pinned revision and the
// cached resolutions of the reference.
export async function noteExportRefs(db: Db, rel: string): Promise<ExportRef[]> {
  return await db.query<ExportRef>(
    `SELECT h.number, h.cited_ref, r.id::text AS reference_id, r.pinned_revision, ${SOURCE_COLS},
            COALESCE(NULLIF(rv.title, ''), s.title) AS title,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('identifier', rr.identifier, 'csl', rr.csl, 'via', rr.via))
                        FROM public.reference_resolutions rr WHERE rr.reference_id = r.id), '[]'::jsonb) AS cached
       FROM public.reference_holders h
       LEFT JOIN public.reference_records r ON r.id = h.reference_id
       LEFT JOIN public.sources s ON s.id = r.source_id
       LEFT JOIN public.source_revisions rv ON rv.source_id = s.id AND rv.revision = r.pinned_revision
      WHERE h.holder_kind = $1 AND h.holder_ref = $2 AND h.number IS NOT NULL
      ORDER BY h.number`,
    [LEGACY_NOTE, rel],
  );
}

// Any other page (a compiled page holds no references, P2a): its body links numbered by first
// appearance, each read from the source as it stands. Nothing is cached for it - there is no
// reference record to cache on.
export async function pageExportRefs(db: Db, md: string): Promise<ExportRef[]> {
  const order = exportOrder(md, []);
  if (!order.length) return [];
  const rows = await db.query<Omit<ExportRef, "number" | "cited_ref" | "reference_id" | "pinned_revision" | "cached">>(
    `SELECT ${SOURCE_COLS}, s.title FROM public.sources s WHERE s.id::text = ANY($1::text[])`,
    [order],
  );
  const byId = new Map(rows.map((r) => [r.source_id!, r]));
  return order.map((u, i) => {
    const s = byId.get(u);
    return {
      number: i + 1, cited_ref: u, reference_id: null, pinned_revision: null, cached: [],
      source_id: s?.source_id ?? null, suppressed: s?.suppressed ?? false, title: s?.title ?? null,
      url: s?.url ?? null, metadata: s?.metadata ?? null, accessed: s?.accessed ?? null,
    };
  });
}

// Cache a resolution on its reference record, at the record's pinned revision (the trigger refuses
// any other revision). A concurrent export that cached it first wins; the metadata is the same.
export async function cacheResolution(db: Db, referenceId: string, identifier: string, csl: CslItem, via: string) {
  await db.query(
    `INSERT INTO public.reference_resolutions (reference_id, identifier, pinned_revision, csl, via)
     SELECT r.id, $2, r.pinned_revision, $3::jsonb, $4 FROM public.reference_records r WHERE r.id = $1
     ON CONFLICT (reference_id, identifier) DO NOTHING`,
    [referenceId, identifier, JSON.stringify(csl), via],
  );
}
