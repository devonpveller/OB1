/**
 * KB access for the research harness (DB-backed; integration-tested).
 *
 *  - retrieveRelevantClaims: semantic recall of existing claims for the reuse
 *    loop (PLAN §6). Returns the fields the OD-5 `decideReuse` classifier needs.
 *  - staging (PLAN §5 / P3): a `sessions` row is the candidate pool; sources are
 *    deduped against OB (find_or_create_source) and linked to the session.
 *  - existingFreshSource: P3.3 — a URL already fresh in OB is reused, not refetched.
 *
 * The research service NEVER writes claims itself — it delegates persistence to
 * the curator (OD-2), which writes grounded claims (P2). This module only READS
 * claims and STAGES candidate sources.
 */

interface QueryClient {
  queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>;
}

const toVector = (v: number[]): string => `[${v.join(",")}]`;

export interface RelevantClaim {
  id: string;
  text: string;
  confidence: number;
  contradicted: boolean;
  grounded: boolean;
  hasStrongEdge: boolean;
  researchedOn: string | null;
  volatility: string | null;
  revalidateDays: number | null;
  distance: number;
}

/**
 * Semantic recall of active claims relevant to the query embedding, optionally
 * scoped to a thread. Returns everything `decideReuse` needs to classify each
 * as reuse / revalidate / research.
 */
export async function retrieveRelevantClaims(
  client: QueryClient,
  queryEmb: number[],
  threadId: string | null,
  k: number,
  maxDistance = 1,
): Promise<RelevantClaim[]> {
  const vec = toVector(queryEmb);
  const where = threadId ? "AND c.thread_id = $3" : "";
  const args: unknown[] = threadId ? [vec, k, threadId] : [vec, k];
  const r = await client.queryObject<{
    id: string; text: string; confidence: number; contradicted: boolean;
    grounded: boolean; has_strong: boolean; researched_on: string | null;
    volatility: string | null; revalidate_days: number | null; distance: string;
  }>(
    `SELECT c.id, c.text, c.confidence, c.contradicted,
            public.claim_is_grounded(c.id) AS grounded,
            EXISTS(SELECT 1 FROM public.claim_sources cs
                    WHERE cs.claim_id = c.id
                      AND cs.edge_type IN ('states','corroborates')) AS has_strong,
            c.researched_on::text AS researched_on, c.volatility, c.revalidate_days,
            (c.embedding <=> $1::vector) AS distance
       FROM public.claims c
      WHERE c.status = 'active' AND c.embedding IS NOT NULL ${where}
      ORDER BY c.embedding <=> $1::vector
      LIMIT $2`,
    args,
  );
  return r.rows
    .map((row) => ({
      id: row.id, text: row.text, confidence: row.confidence, contradicted: row.contradicted,
      grounded: row.grounded, hasStrongEdge: row.has_strong, researchedOn: row.researched_on,
      volatility: row.volatility, revalidateDays: row.revalidate_days,
      distance: Number(row.distance), // pgvector distance decodes as string over the wire
    }))
    // Drop semantically-far claims so an unscoped query doesn't drag in
    // irrelevant grounded claims as "reuse" (#5). Cosine distance: 0 = identical.
    .filter((c) => c.distance <= maxDistance);
}

// ── Staging ─────────────────────────────────────────────────────────────────
export async function createStagingSession(
  client: QueryClient,
  query: string,
  threadId: string | null,
  origin: string,
): Promise<string> {
  const ot = ["owui", "open_notebook", "manual"].includes(origin) ? origin : "manual";
  const r = await client.queryObject<{ id: string }>(
    `INSERT INTO public.sessions (origin_tool, query_text, thread_id, metadata)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [ot, query, threadId, JSON.stringify({ source: "research-service" })],
  );
  return r.rows[0].id;
}

export interface StagedSource { id: string; url: string | null; wasDuplicate: boolean; }

/**
 * Dedup a candidate source into OB (stable id via find_or_create_source), stamp
 * its content/embedding, and link it to the staging session (candidate pool).
 * NOT linked to any thread here — promotion (cited + grounded only) happens when
 * the curator ingests the synthesis (P2). Returns the stable source id.
 */
export async function stageSource(
  client: QueryClient,
  sessionId: string,
  src: { url?: string | null; title?: string; content: string; domain?: string | null },
  emb: number[],
): Promise<StagedSource> {
  const url = (src.url || "").trim() || null;
  const title = (src.title || src.domain || url || "source").slice(0, 300);
  const vec = toVector(emb);
  const meta = JSON.stringify({ source: "research-stage", session_id: sessionId });
  const fc = await client.queryObject<{ id: string; was_duplicate: boolean }>(
    `SELECT * FROM public.find_or_create_source($1, $2, NULL, $3, 'web_article', NULL, $4, $5::vector, $6::jsonb)`,
    [url, src.content, title, src.domain ?? null, vec, meta],
  );
  const id = fc.rows[0].id;
  await client.queryObject(
    `UPDATE public.sources SET
        content = $2, title = COALESCE(NULLIF($3,''), title), domain = COALESCE($4, domain),
        fetched_at = now(), embedding = $5::vector, content_hash = COALESCE(content_hash, md5($2))
      WHERE id = $1`,
    [id, src.content, title, src.domain ?? null, vec],
  );
  await client.queryObject(
    `INSERT INTO public.session_sources (session_id, source_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [sessionId, id],
  );
  return { id, url, wasDuplicate: fc.rows[0].was_duplicate };
}

/**
 * P3.3 — is this URL already a FRESH source in OB? If so the caller reuses it
 * instead of re-fetching. Returns the source row (with content) or null.
 */
export async function existingFreshSource(
  client: QueryClient,
  url: string,
): Promise<{ id: string; title: string; content: string; domain: string | null } | null> {
  const r = await client.queryObject<{
    id: string; title: string; content: string; domain: string | null; stale: boolean;
  }>(
    `SELECT id, title, content, domain,
            (researched_on IS NOT NULL AND revalidate_days IS NOT NULL
             AND researched_on + revalidate_days < CURRENT_DATE) AS stale
       FROM public.sources
      WHERE url = $1 AND retraction_committed_at IS NULL
      ORDER BY created_at ASC LIMIT 1`,
    [url],
  );
  const row = r.rows[0];
  if (!row || row.stale) return null;
  return { id: row.id, title: row.title, content: row.content, domain: row.domain };
}
