// The export's database side (research-workbench P6a): the numbered references a document holds,
// with what each needs to become a CSL item, and the resolution cache on the reference record.
import type { Db } from "../contracts/db.ts";
import { EXPORT_LINK_RE, exportOrder } from "../contracts/logic/citations.ts";
import { type MdNode, parseMarkdown } from "./markdown.ts";
import { LEGACY_NOTE } from "../contracts/repo/references.ts";
import type { CslItem } from "./csl.ts";

// The order citeproc NUMBERS the cited sources in (rw-p6b-gate round 3, tester t-p6b-gate2 D12): the
// READING order of the parsed document - a citation inside a footnote counts where the footnote's marker
// is, a footnote definition is not read where it is written, and a link inside code (a code span or block)
// is not a citation. Sources the text links only from code are listed after the cited ones (pandoc lists
// them as nocite, after every cited item), then the deliberately added ones. exportOrder (the raw text
// position) stays the P2a holder rule; the export and the reference panel number by this.
export function readingOrder(content: string, added: string[]): string[] {
  const n = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const ids: string[] = [];
  const src = content.replace(new RegExp(EXPORT_LINK_RE.source, "g"), (_m, _t, uuid) => `zwr${n}q${ids.push(String(uuid).toLowerCase()) - 1}z`);
  const tree = parseMarkdown(src);
  const defs = new Map<string, MdNode>();
  const collect = (node: MdNode) => {
    if (node.type === "footnoteDefinition" && typeof node.identifier === "string") defs.set(node.identifier, node);
    for (const c of node.children ?? []) collect(c);
  };
  collect(tree);
  const order: string[] = [];
  const seen = new Set<string>();
  const marker = new RegExp(`zwr${n}q(\\d+)z`, "g");
  const visiting = new Set<string>();
  const walk = (node: MdNode) => {
    if (node.type === "code" || node.type === "inlineCode" || node.type === "footnoteDefinition") return;
    if (node.type === "footnoteReference" && typeof node.identifier === "string") {
      const d = defs.get(node.identifier);
      if (d && !visiting.has(node.identifier)) {
        visiting.add(node.identifier);
        for (const c of d.children ?? []) walk(c);
        visiting.delete(node.identifier);
      }
      return;
    }
    for (const v of [node.value, node.url, node.title, node.alt]) {
      if (typeof v !== "string") continue;
      for (const m of v.matchAll(marker)) {
        const id = ids[Number(m[1])];
        if (id && !seen.has(id)) { seen.add(id); order.push(id); }
      }
    }
    for (const c of node.children ?? []) walk(c);
  };
  walk(tree);
  for (const raw of exportOrder(content, added)) {
    const id = raw.toLowerCase();
    if (!seen.has(id)) { seen.add(id); order.push(id); }
  }
  return order;
}

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
  const order = readingOrder(md, []);
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

// A user document (research-workbench P2b): its citations - chips, transclusions and source links,
// rewritten to source wikilinks by documentExportMarkdown - numbered by first appearance, then the
// references it ADDED (both fold into one References list, D12 parity item 8); each read at the
// pin THIS document holds (its P2a record), with that record's cached resolutions.
export async function documentExportRefs(db: Db, rel: string, md: string): Promise<ExportRef[]> {
  const added = (await db.query<{ source_id: string }>(
    `SELECT r.source_id::text AS source_id FROM public.reference_holders h JOIN public.reference_records r ON r.id = h.reference_id
      WHERE h.holder_kind = 'user_document' AND h.holder_ref = $1 AND h.origin = 'added' ORDER BY h.seq`,
    [rel],
  )).map((r) => r.source_id);
  const order = readingOrder(md, added);
  if (!order.length) return [];
  const rows = await db.query<Omit<ExportRef, "number">>(
    `SELECT DISTINCT ON (r.source_id) r.source_id::text AS cited_ref, r.id::text AS reference_id, r.pinned_revision, ${SOURCE_COLS},
            COALESCE(NULLIF(rv.title, ''), s.title) AS title,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('identifier', rr.identifier, 'csl', rr.csl, 'via', rr.via))
                        FROM public.reference_resolutions rr WHERE rr.reference_id = r.id), '[]'::jsonb) AS cached
       FROM public.reference_holders h
       JOIN public.reference_records r ON r.id = h.reference_id
       LEFT JOIN public.sources s ON s.id = r.source_id
       LEFT JOIN public.source_revisions rv ON rv.source_id = s.id AND rv.revision = r.pinned_revision
      WHERE h.holder_kind = 'user_document' AND h.holder_ref = $1 AND r.source_id::text = ANY($2::text[])
      ORDER BY r.source_id, h.seq`,
    [rel, order],
  );
  const bySource = new Map(rows.map((r) => [r.cited_ref, r]));
  return order.map((u, i) => {
    const r = bySource.get(u);
    return r ? { ...r, number: i + 1 } : {
      number: i + 1, cited_ref: u, reference_id: null, pinned_revision: null, cached: [], source_id: null,
      suppressed: false, title: null, url: null, metadata: null, accessed: null,
    };
  });
}

// The user document grammar, rewritten for the export: a chip or a transclusion becomes its quoted
// text (a transclusion) and the source wikilink the export numbers; a typed link becomes a source
// wikilink (sources, reports) or its plain text (claims, other documents). Page links stay.
export async function documentExportMarkdown(db: Db, md: string): Promise<string> {
  const ids = [...new Set([...md.matchAll(/\[@ref:([0-9a-fA-F-]{36})\]|\{\{ref:([0-9a-fA-F-]{36})\}\}/g)].map((m) => (m[1] ?? m[2]).toLowerCase()))];
  const src = new Map((await db.query<{ id: string; source_id: string }>(
    `SELECT id::text AS id, source_id::text AS source_id FROM public.reference_records WHERE id::text = ANY($1::text[])`, [ids],
  )).map((r) => [r.id, r.source_id]));
  const leaf = (refId: string) => src.has(refId.toLowerCase()) ? `[[content/source/${src.get(refId.toLowerCase())}]]` : "";
  return md
    .replace(/\{\{ref:([0-9a-fA-F-]{36})\}\}([\s\S]*?)\{\{\/ref\}\}/g, (_m, id, text) => `${text} ${leaf(id)}`.trimEnd())
    .replace(/\[@ref:([0-9a-fA-F-]{36})\]/g, (_m, id) => leaf(id))
    .replace(/\[\[(source|report):([0-9a-fA-F-]{36})(\|[^\]\n]+)?\]\]/g, (_m, _k, id, alias) => `[[content/source/${id.toLowerCase()}${alias ?? ""}]]`)
    .replace(/\[\[(claim|doc):([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_m, _k, id, alias) => (alias ?? id).trim());
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
