// The scoped chat's CONTEXT (rw-p8a3-room, anchor acceptance 2 and 4): which passages of the knowledge
// database a question in a room is answered over.
//
//   scope off          the whole knowledge database (active sources: a suppressed source lends nothing, D5)
//   scope on, a list   only the listed sources
//   scope on, EMPTY    NOTHING: no passage, and not even the question's embedding is asked for. Falling
//                      back to the whole vault would be the failure the anchor names.
//   an idea's room     is the refinery chat: the refinery's own held sources join the knowledge database,
//                      and the refinery's HIDDEN sources are left out (refinery_hidden, node_kind 'source' -
//                      the rule the research service applies to a refinery session's context, kb.ts
//                      loadHeldSources / loadRefineryContext). A hide narrows that refinery's chat only:
//                      a session's room reads the knowledge database whatever any refinery hides.
// Only ids, chunk indexes and the passage text (cut to MAX_PASSAGE) leave this module; the room stores the
// ids and indexes, never the text.
import type { Db } from "../contracts/db.ts";
import { toVector } from "../util/embed.ts";
import type { ContextPassage } from "./chat.ts";

export const MAX_PASSAGES = 8;
export const MAX_PASSAGE = 1200;

export interface Scope {
  enabled: boolean;
  sources: string[];
}

// The refinery whose hidden set and held sources apply: an idea's room only.
export function refineryOf(room: { subject_kind: string; subject_id: string }): string | null {
  return room.subject_kind === "idea" ? room.subject_id : null;
}

export const NOTHING_IN_SCOPE = (s: Scope) => s.enabled && s.sources.length === 0;

const HIDDEN = (ref: string, refinery: string) =>
  `(${refinery}::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM public.refinery_hidden x
       WHERE x.refinery_id = ${refinery}::uuid AND x.node_kind = 'source' AND x.node_ref = (${ref})::text))`;

export const CONTEXT_SQL = `
  SELECT * FROM (
    (SELECT c.source_id::text AS source_id, c.idx AS chunk, false AS held, s.title,
            left(c.content, ${MAX_PASSAGE}) AS text, (c.embedding <=> $1::vector) AS d
       FROM public.source_chunks c JOIN public.sources s ON s.id = c.source_id
      WHERE s.retraction_committed_at IS NULL
        AND (NOT $2::boolean OR c.source_id = ANY($3::uuid[]))
        AND NOT ${HIDDEN("c.source_id", "$4")}
      ORDER BY c.embedding <=> $1::vector NULLS LAST, c.source_id, c.idx
      LIMIT $5)
    UNION ALL
    (SELECT h.id::text, hc.idx, true, h.title, left(hc.content, ${MAX_PASSAGE}), (hc.embedding <=> $1::vector)
       FROM public.held_source_chunks hc JOIN public.held_sources h ON h.id = hc.held_source_id
      WHERE $4::uuid IS NOT NULL AND h.refinery_id = $4::uuid
        AND (NOT $2::boolean OR h.id = ANY($3::uuid[]))
        AND NOT ${HIDDEN("h.id", "$4")}
      ORDER BY hc.embedding <=> $1::vector NULLS LAST, h.id, hc.idx
      LIMIT $5)
  ) p
  ORDER BY p.d NULLS LAST, p.source_id, p.chunk
  LIMIT $5`;

export async function contextFor(
  db: Db, embed: (t: string) => Promise<number[]>, question: string, scope: Scope, refinery: string | null,
): Promise<ContextPassage[]> {
  if (NOTHING_IN_SCOPE(scope)) return [];
  const v = await embed(question);
  const rows = await db.query<ContextPassage & { d: number | null }>(CONTEXT_SQL, [toVector(v), scope.enabled, scope.sources, refinery, MAX_PASSAGES]);
  return rows.map(({ source_id, chunk, held, title, text }) => ({ source_id, chunk: Number(chunk), held: !!held, title: title ?? "", text: text ?? "" }));
}
