// The shared-library reads behind Home's two library cards (rwr-home round 4). Shared knowledge only: public.claims
// and public.sources hold no per-user rows (a user's own report is filed in research_private_reports, a held source
// in held_sources, and neither is read here). No caller identity is used or needed.
import type { Db } from "../db.ts";
import { claimNotPrivate } from "./private_claims.ts";

// An active claim that is not contradicted and has exactly ONE distinct active source behind it (an edge that
// states or corroborates, from a source that is not retracted) - the same rule the claims read's `corroborations`
// and `sources[]` express, counted by the server over EVERY claim instead of a page.
export async function waitingClaims(db: Db, limit: number) {
  const rows = await db.query<{ id: string; text: string; created_at: string; total: number | bigint }>(
    `SELECT c.id, c.text, c.created_at, count(*) OVER () AS total
       FROM public.claims c
      WHERE c.status = 'active' AND NOT c.contradicted
        AND ${claimNotPrivate("c")} -- a claim drawn from a user's PRIVATE idea report (private-only: no shared synthesis filed it too; private_claims.ts) stays in public.claims (slot 390) but is not library material
        AND (SELECT count(DISTINCT s.id)
               FROM public.claim_sources cs JOIN public.sources s ON s.id = cs.source_id
              WHERE cs.claim_id = c.id AND cs.edge_type IN ('states', 'corroborates')
                AND public.source_lifecycle_state(s.retraction_committed_at, s.unlinked_at) = 'active') = 1
        AND NOT EXISTS (SELECT 1 FROM public.claim_sources x
                          LEFT JOIN public.claims n ON n.id = x.parent_claim_id
                          LEFT JOIN public.sources xs ON xs.id = x.source_id
                         WHERE x.claim_id = c.id AND x.edge_type = 'contradicts'
                           AND ((n.id IS NOT NULL AND n.status = 'active' AND n.created_at > c.created_at)
                             OR (xs.id IS NOT NULL AND xs.retraction_committed_at IS NULL AND xs.created_at > c.created_at)))
      ORDER BY c.created_at DESC, c.id
      LIMIT $1`,
    [limit],
  );
  // limit >= 1 here, so a page with no rows means the total is zero
  return { total: rows.length ? Number(rows[0].total) : 0, claims: rows.map((r) => ({ id: r.id, text: r.text, created_at: r.created_at })) };
}

export async function recentSources(db: Db, days: number, limit: number) {
  const [src, cl] = await Promise.all([
    db.query<{ id: string; title: string | null; url: string | null; content_type: string; created_at: string; total: number | bigint }>(
      `SELECT s.id, s.title, s.url, s.content_type, s.created_at, count(*) OVER () AS total
         FROM public.sources s
        WHERE s.created_at >= now() - make_interval(days => $1::int)
          AND public.source_lifecycle_state(s.retraction_committed_at, s.unlinked_at) = 'active'
        ORDER BY s.created_at DESC, s.id
        LIMIT $2`,
      [days, limit],
    ),
    db.query<{ n: number | bigint }>(
      `SELECT count(*) AS n FROM public.claims c WHERE c.status = 'active' AND c.created_at >= now() - make_interval(days => $1::int)
          AND ${claimNotPrivate("c")}`,
      [days],
    ),
  ]);
  return {
    days,
    sources_total: src.length ? Number(src[0].total) : 0,
    claims_total: Number(cl[0]?.n ?? 0),
    sources: src.map((r) => ({ id: r.id, title: r.title ?? "", url: r.url, content_type: r.content_type, created_at: r.created_at })),
  };
}
