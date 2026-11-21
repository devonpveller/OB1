// rwr-source-reader-api: the reader's read of one source - its chunks in order, the section each sits in and the
// claims drawn from it, placed in the chunk their words are found in (logic/source_reader.ts).
//
// Two stores, one answer shape:
//   shared    public.sources / source_chunks / claim_sources / claims, read the way the other source reads are
//             (getSource: the metadata filter, the lifecycle state, evidence-only);
//   private   a moved email-body / podcast-transcript source (slot 440): ONLY its owner, through the owner-only
//             functions (inlet_private_source, slot 440; inlet_private_reader_chunks / _claims, slot 520). Anyone
//             else - another user, a non-owner admin, a service, a filtered (cloud door) caller - and a source that
//             does not exist get the same answer: null, which the route turns into one 404 body.
// Nothing here calls a model. Held (refinery) sources are not served: they are an idea's, not the library's.
import type { Db } from "../db.ts";
import type { MetadataFilter } from "../logic/scope.ts";
import { sourceRecordState } from "../logic/state.ts";
import { placeClaim, type Placement, sectionsFor } from "../logic/source_reader.ts";
import { getSource, sourceStateDetail } from "./sources.ts";
import type { Viewer } from "../../documents/ownership.ts";

interface ClaimRow {
  claim_id: string;
  text: string;
  epistemic_tag: string;
  status: string;
  edge_type: string;
}
interface ChunkRow {
  idx: number;
  content: string;
}

const isOwnerSub = (sub: string) => !!sub && sub.trim() !== "" && !sub.startsWith("service:");

// 42883 (function missing: slot 440 / 520 not applied) and 42501 (this role may not call it) read as absent:
// fail closed, the same answer as no such source
async function privateQuery<T>(db: Db, sql: string, args: unknown[]): Promise<T[] | null> {
  try {
    return await db.query<T>(sql, args);
  } catch (e) {
    const code = (e as { fields?: { code?: string } }).fields?.code;
    if (code === "42883" || code === "42501") return null;
    throw e;
  }
}

function shape(
  base: {
    source_id: string; state: string; state_detail: Record<string, unknown>; lifecycle: string | null; revision: number | null;
    private: boolean; title: string; url: string | null;
  },
  content: string,
  chunks: ChunkRow[],
  claims: ClaimRow[],
) {
  const { sections, chunkSection } = sectionsFor(content, chunks);
  const placed = chunks.map(() => [] as unknown[]);
  const unplaced: unknown[] = [];
  const byIdx = new Map(chunks.map((c, i) => [c.idx, i]));
  for (const cl of claims) {
    const row = { claim_id: cl.claim_id, text: cl.text, edge_type: cl.edge_type, epistemic_tag: cl.epistemic_tag, status: cl.status };
    const p: Placement | null = placeClaim(cl.text, chunks);
    if (p) placed[byIdx.get(p.idx)!].push({ ...row, span: p.span, overlap: p.overlap });
    else unplaced.push({ ...row, span: null, overlap: null });
  }
  return {
    ...base,
    sections,
    chunks: chunks.map((c, i) => ({
      idx: c.idx, chunk_id: `${base.source_id}:${c.idx}`, section: chunkSection[i], content: c.content, claims: placed[i],
    })),
    unplaced_claims: unplaced,
  };
}

export async function sourceReader(
  db: Db,
  id: string,
  opts: { evidenceOnly: boolean; visible: Set<string>; filter: MetadataFilter; who: Viewer },
) {
  const s = await getSource(db, id, opts.filter);
  if (s) {
    const state = sourceRecordState({ lifecycle: s.lifecycle, staged_retract: s.staged_retract });
    const base = {
      source_id: s.id, state, state_detail: sourceStateDetail(s, opts.filter), lifecycle: s.lifecycle,
      revision: s.max_revision ?? 1, private: false, title: s.title, url: s.url,
    };
    if (opts.evidenceOnly && !opts.visible.has(s.lifecycle)) {
      return { ...base, state: "omitted", lifecycle: null, state_detail: { reason: "evidence_only" }, title: "", url: null, sections: [], chunks: [], unplaced_claims: [] };
    }
    const mf = opts.filter ? JSON.stringify(opts.filter) : null;
    const content = (await db.query<{ content: string }>(`SELECT content FROM public.sources WHERE id = $1`, [s.id]))[0]?.content ?? "";
    const chunks = await db.query<ChunkRow>(`SELECT idx, content FROM public.source_chunks WHERE source_id = $1 ORDER BY idx`, [s.id]);
    const claims = await db.query<ClaimRow>(
      `SELECT c.id::text AS claim_id, c.text, c.epistemic_tag, c.status, cs.edge_type
         FROM public.claim_sources cs JOIN public.claims c ON c.id = cs.claim_id
        WHERE cs.source_id = $1 AND ($2::jsonb IS NULL OR c.metadata @> $2::jsonb)
        ORDER BY c.created_at, c.id, cs.edge_type`,
      [s.id, mf],
    );
    return shape(base, content, chunks, claims);
  }
  // not a shared source: a private one is its owner's, and never reaches a filtered (cloud door) caller
  if (opts.filter || !isOwnerSub(opts.who.sub)) return null;
  const src = await privateQuery<{ id: string; title: string; url: string | null; content: string }>(
    db, `SELECT id, title, url, content FROM public.inlet_private_source($1::uuid, $2)`, [id, opts.who.sub],
  );
  if (!src || !src[0]) return null;
  const chunks = await privateQuery<ChunkRow>(db, `SELECT idx, content FROM public.inlet_private_reader_chunks($1::uuid, $2)`, [id, opts.who.sub]);
  const claims = await privateQuery<ClaimRow>(
    db, `SELECT claim_id::text AS claim_id, text, epistemic_tag, status, edge_type FROM public.inlet_private_reader_claims($1::uuid, $2)`, [id, opts.who.sub],
  );
  // the source resolved for this owner, so the chunk and claim reads must too; if one does not (slot 520 is not
  // applied) the whole answer is not found rather than a source with no text
  if (!chunks || !claims) return null;
  return shape(
    { source_id: src[0].id, state: "current", state_detail: {}, lifecycle: null, revision: null, private: true, title: src[0].title ?? "", url: src[0].url ?? null },
    src[0].content ?? "", chunks, claims,
  );
}
