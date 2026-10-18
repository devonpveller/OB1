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
                    JOIN public.sources s ON s.id = cs.source_id
                    WHERE cs.claim_id = c.id
                      AND cs.edge_type IN ('states','corroborates')
                      AND s.retraction_committed_at IS NULL) AS has_strong, -- D5 stage 1 (research-workbench P0)
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

export interface RelevantSource {
  id: string; url: string | null; title: string; content: string; domain: string | null;
  distance: number;
}

/**
 * Semantic recall of DURABLE SOURCES already in OB (REPO-SOURCES-WIRING §6) — e.g. repo docs
 * synced via /sources/repo-sync. Web search can never surface these (raw repo files aren't
 * usefully indexed), so the harness folds store recall into the staged pool ahead of any web
 * gathering. Excludes retracted + empty sources; distance-filtered like claim recall.
 */
export async function retrieveRelevantSources(
  client: QueryClient,
  queryEmb: number[],
  k: number,
  maxDistance = 0.8,
): Promise<RelevantSource[]> {
  const vec = toVector(queryEmb);
  const r = await client.queryObject<{
    id: string; url: string | null; title: string; content: string; domain: string | null;
    distance: string;
  }>(
    `SELECT s.id, s.url, s.title, s.content, s.domain,
            (s.embedding <=> $1::vector) AS distance
       FROM public.sources s
      WHERE s.embedding IS NOT NULL
        AND s.content IS NOT NULL AND length(s.content) > 0
        AND s.retraction_committed_at IS NULL
      ORDER BY s.embedding <=> $1::vector
      LIMIT $2`,
    [vec, k],
  );
  return r.rows
    .map((row) => ({
      id: row.id, url: row.url, title: row.title, content: row.content, domain: row.domain,
      distance: Number(row.distance),
    }))
    .filter((s) => s.distance <= maxDistance);
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
  // D5 stage 1 (research-workbench P0): dedup can land on a SUPPRESSED row. It is never
  // rewritten or pooled - a suppressed source feeds no generation. The caller's staging is
  // best-effort, so this refusal drops the one candidate.
  const supp = await client.queryObject<{ suppressed: boolean }>(
    `SELECT retraction_committed_at IS NOT NULL AS suppressed FROM public.sources WHERE id = $1`, [id],
  );
  if (supp.rows[0]?.suppressed) throw new Error(`source ${id} is suppressed; not staged`);
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
 * D5 item 4 / item 6 (research-workbench P0): a query hit whose URL resolves to an erased
 * source's tombstone is dropped, and the attempt recorded on the tombstone by
 * public.contract_record_query_hit (the deliberate path appends a reopen note; debunked and
 * credibility need the D15 pre-ingestion score, P3a, so they are refused until then). Pages
 * without a URL, or with no tombstone, pass through unchanged.
 */
export async function dropTombstoned<P extends { url?: string | null }>(
  client: QueryClient,
  pages: P[],
  sessionId: string | null,
): Promise<P[]> {
  const kept: P[] = [];
  for (const p of pages) {
    const url = (p.url || "").trim();
    const t = url
      ? await client.queryObject<{ id: string | null }>(
        `SELECT public.contract_record_query_hit($1, $2, 'returned as a research query hit') AS id`, [url, sessionId],
      )
      : { rows: [] as { id: string | null }[] };
    if (!t.rows[0]?.id) kept.push(p);
  }
  return kept;
}

export interface ReuseSourceRow { id: string; url: string | null; title: string; content: string; domain: string | null; }

/**
 * The grounding sources behind a set of reused claims — one PRIMARY source per
 * claim (prefer states > corroborates > inferred_from), deduped across claims.
 * The harness folds these into the synthesis's numbered SOURCES pool so reused
 * facts can be cited [Source N] (not left as uncited [SOURCED]), and so the
 * curator re-links the new synthesis to those grounded sources/claims
 * (provenance) — closing the reuse-only citation gap.
 */
export async function getReuseSources(
  client: QueryClient,
  claimIds: string[],
): Promise<{ sources: ReuseSourceRow[]; claimToSource: Record<string, string> }> {
  if (!claimIds.length) return { sources: [], claimToSource: {} };
  const r = await client.queryObject<{
    claim_id: string; id: string; url: string | null; title: string; content: string; domain: string | null;
  }>(
    `SELECT DISTINCT ON (cs.claim_id)
            cs.claim_id, s.id, s.url, s.title, s.content, s.domain
       FROM public.claim_sources cs
       JOIN public.sources s ON s.id = cs.source_id
      WHERE cs.claim_id = ANY($1::uuid[])
        AND cs.edge_type <> 'contradicts'
        AND s.retraction_committed_at IS NULL
      ORDER BY cs.claim_id,
               CASE cs.edge_type WHEN 'states' THEN 0 WHEN 'corroborates' THEN 1 ELSE 2 END,
               cs.created_at`,
    [claimIds],
  );
  const claimToSource: Record<string, string> = {};
  const seen = new Map<string, ReuseSourceRow>();
  for (const row of r.rows) {
    claimToSource[row.claim_id] = row.id;
    if (!seen.has(row.id)) {
      seen.set(row.id, { id: row.id, url: row.url, title: row.title, content: row.content, domain: row.domain });
    }
  }
  return { sources: [...seen.values()], claimToSource };
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

// ── D15 credibility records (research-workbench P3a) ────────────────────────
// The research service still never writes CLAIMS (the curator does). What it writes here is
// the credibility record of the sources it admitted: the family, the signals and the score on
// sources.metadata.credibility (+ the resolved scholarly record), the rolling-total history,
// the entailment-gated corroborations, found_via on a source reached through a lead, and the
// admission trail - where a below-floor lead lives, never as a sources row.

/** A scholarly record already cached on a stored source with this URL (D15 item 1: cached). */
export async function cachedScholarly(client: QueryClient, url: string): Promise<Record<string, unknown> | null> {
  const r = await client.queryObject<{ scholarly: Record<string, unknown> | null }>(
    `SELECT metadata -> 'scholarly' AS scholarly FROM public.sources
      WHERE url = $1 AND metadata ? 'scholarly' AND retraction_committed_at IS NULL
      ORDER BY updated_at DESC LIMIT 1`,
    [url],
  );
  return r.rows[0]?.scholarly ?? null;
}

export interface CredibilityStamp {
  family: string;
  claim_kind: string;
  signals: unknown;
  score: number;
  total: number;
  reasons: string[];
  model_version: string;
  admission: { path: string; floor: number | null; total: number | null; trail_id: string | null };
  found_via?: string | null;
  found_via_kind?: "lead" | "held" | null;
}

/** Stamp one source's credibility record and append its history row. */
export async function stampSourceCredibility(
  client: QueryClient,
  sourceId: string,
  stamp: CredibilityStamp,
  scholarly: Record<string, unknown> | null,
  jobId: string | null,
): Promise<void> {
  const patch: Record<string, unknown> = { credibility: stamp };
  if (scholarly) patch.scholarly = scholarly;
  if (stamp.found_via) { patch.found_via = stamp.found_via; patch.found_via_kind = stamp.found_via_kind ?? "lead"; }
  await client.queryObject(
    `UPDATE public.sources SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1::uuid`,
    [sourceId, JSON.stringify(patch)],
  );
  await client.queryObject(
    `INSERT INTO public.source_credibility_history
        (source_id, family, claim_kind, score, total, model_version, signals, reasons, job_id)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::uuid)`,
    [sourceId, stamp.family, stamp.claim_kind, stamp.score, stamp.total, stamp.model_version,
      JSON.stringify(stamp.signals), JSON.stringify(stamp.reasons), jobId],
  );
  if (stamp.found_via) {
    await client.queryObject(
      `INSERT INTO public.source_trail_events (source_id, kind, detail) VALUES ($1::uuid, 'found_via', $2::jsonb)`,
      [sourceId, JSON.stringify({ found_via: stamp.found_via, kind: stamp.found_via_kind ?? "lead", job_id: jobId })],
    );
  }
}

/** One entailment-gated corroboration (the DB refuses a non-transferring verdict, OBC02). */
export async function recordCorroboration(
  client: QueryClient,
  e: { from: string; to: string; strength: "strong" | "weak"; amount: number; claim: string; kind: string; verdict: string; model: string },
  jobId: string | null,
): Promise<void> {
  await client.queryObject(
    `INSERT INTO public.source_corroborations
        (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version, job_id)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::uuid)
     ON CONFLICT (from_source_id, to_source_id, claim_text, model_version) DO NOTHING`,
    [e.from, e.to, e.strength, e.amount, e.claim.slice(0, 2000), e.kind, e.verdict, e.model, jobId],
  );
}

export interface TrailRow {
  id: string; url: string; kind: string; claim_kind: string; family: string | null; score: number | null;
  total: number | null; floor: number | null; model_version: string; signals: unknown; reasons: string[];
  found_via: string | null; path: unknown[]; source_id: string | null;
}

/** Persist the run's admission trail (every judged hit, every lead, every path). */
export async function recordAdmissionTrail(
  client: QueryClient, rows: TrailRow[], jobId: string | null, sessionId: string | null,
): Promise<void> {
  for (const t of rows) {
    await client.queryObject(
      `INSERT INTO public.research_admission_trail
          (id, job_id, session_id, url, url_key, kind, claim_kind, family, score, total, floor, model_version,
           signals, reasons, found_via, path, source_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, public.contract_url_key($4), $5, $6, $7, $8, $9, $10, $11,
               $12::jsonb, $13::jsonb, $14::uuid, $15::jsonb, $16::uuid)
       ON CONFLICT (id) DO NOTHING`,
      [t.id, jobId, sessionId, t.url, t.kind, t.claim_kind, t.family, t.score, t.total, t.floor, t.model_version,
        JSON.stringify(t.signals ?? {}), JSON.stringify(t.reasons ?? []), t.found_via, JSON.stringify(t.path ?? []), t.source_id],
    );
  }
}

export interface HeldRow { id: string; url: string | null; title: string; content: string; content_type: string; metadata: Record<string, unknown> }

/** A refinery's held sources, minus the ones its hidden set narrows out of this session. */
export async function loadHeldSources(client: QueryClient, refineryId: string): Promise<HeldRow[]> {
  const r = await client.queryObject<HeldRow>(
    `SELECT h.id, h.url, h.title, h.content, h.content_type, h.metadata
       FROM public.held_sources h
      WHERE h.refinery_id = $1::uuid
        AND NOT EXISTS (SELECT 1 FROM public.refinery_hidden x
                         WHERE x.refinery_id = h.refinery_id AND x.node_kind = 'source' AND x.node_ref = h.id::text)
      ORDER BY h.created_at`,
    [refineryId],
  );
  return r.rows;
}

/** The refinery's unhidden ACTIVE context sources (its folded user sources), for the scoped pass. */
export async function loadRefineryContext(client: QueryClient, refineryId: string): Promise<Array<{ id: string; url: string | null; title: string }>> {
  const r = await client.queryObject<{ id: string; url: string | null; title: string }>(
    `SELECT s.id, s.url, s.title
       FROM public.refinery_user_sources u JOIN public.sources s ON s.id = u.source_id
      WHERE u.refinery_id = $1::uuid AND s.retraction_committed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.refinery_hidden x
                         WHERE x.refinery_id = u.refinery_id AND x.node_kind = 'source' AND x.node_ref = s.id::text)`,
    [refineryId],
  );
  return r.rows;
}

export class TombstonedError extends Error {
  constructor(readonly url: string, message: string) { super(message); this.name = "TombstonedError"; }
}

/**
 * The fold's move (public.fold_held_source). A tombstoned URL makes the sources gate raise
 * OBT01; that is surfaced as TombstonedError so the caller routes the D5 reopening path.
 */
export async function foldHeld(client: QueryClient, heldId: string, credibility: unknown, jobId: string | null): Promise<string> {
  try {
    const r = await client.queryObject<{ id: string }>(
      `SELECT public.fold_held_source($1::uuid, $2::jsonb, $3::uuid) AS id`,
      [heldId, JSON.stringify(credibility), jobId],
    );
    return r.rows[0].id;
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    if (/tombstoned url refused|OBT01/i.test(m) || (e as { fields?: { code?: string } })?.fields?.code === "OBT01") {
      throw new TombstonedError("", m);
    }
    throw e;
  }
}
