// Source reads for the contract: reference, chunk context, quality. (diffCheck moved to
// references.ts in P2a, where the pinned revision lives.)
// Lifecycle WRITES (suppress / sever / erase / admission) live in lifecycle.ts.
import type { Db } from "../db.ts";
import type { MetadataFilter } from "../logic/scope.ts";
import { sourceRecordState } from "../logic/state.ts";
import { refineryScopedScore, termDef } from "../logic/credibility.ts";
import type { RegistryReader } from "../registry.ts";

export interface SourceRow {
  id: string;
  url: string | null;
  title: string;
  content_type: string;
  domain: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  excerpt: string;
  lifecycle: string;
  staged_retract: boolean;
  suppression_reason: string | null;
  suppression_context: Record<string, unknown> | null;
  retracted_by: string | null;
  retraction_committed_at: string | null;
  max_revision: number | null;
}

const SOURCE_COLS = `
  s.id, s.url, s.title, s.content_type, s.domain, s.metadata, s.created_at, s.updated_at,
  left(s.content, 500) AS excerpt,
  public.source_lifecycle_state(s.retraction_committed_at, s.unlinked_at) AS lifecycle,
  (s.retracted_at IS NOT NULL AND s.retraction_committed_at IS NULL) AS staged_retract,
  s.suppression_reason, s.suppression_context, s.retracted_by, s.retraction_committed_at,
  (SELECT max(r.revision) FROM public.source_revisions r WHERE r.source_id = s.id) AS max_revision`;

// `$2` is the metadata filter (NULL = unconstrained).
export async function getSource(db: Db, id: string, f: MetadataFilter): Promise<SourceRow | null> {
  const rows = await db.query<SourceRow>(
    `SELECT ${SOURCE_COLS} FROM public.sources s
      WHERE s.id = $1 AND ($2::jsonb IS NULL OR s.metadata @> $2::jsonb)`,
    [id, f ? JSON.stringify(f) : null],
  );
  return rows[0] ?? null;
}

export interface HeldRow {
  id: string;
  refinery_id: string;
  url: string | null;
  title: string;
  content_type: string;
  revision: number;
  excerpt: string;
  status: string;
  metadata: Record<string, unknown>;
}

export async function getHeld(db: Db, id: string, f: MetadataFilter): Promise<HeldRow | null> {
  const rows = await db.query<HeldRow>(
    `SELECT h.id, h.refinery_id, h.url, h.title, h.content_type, h.revision,
            left(h.content, 500) AS excerpt, rus.status, h.metadata
       FROM public.held_sources h
       JOIN public.refinery_user_sources rus ON rus.source_id = h.id
      WHERE h.id = $1 AND ($2::jsonb IS NULL OR h.metadata @> $2::jsonb)`,
    [id, f ? JSON.stringify(f) : null],
  );
  return rows[0] ?? null;
}

export interface TombstoneRow {
  id: string;
  source_id: string;
  url: string;
  title: string;
  reason_type: string;
  note: string | null;
  batch_run_id: string | null;
  eraser_kind: string;
  eraser_run_id: string | null;
  eraser_user: string | null;
  confidence: number | null;
  score_version: string | null;
  fingerprint: string | null;
  erased_at: string;
  lifted_at: string | null;
  lifted_by: string | null;
  readmitted_source_id: string | null;
  attempts: unknown[];
}

const TOMBSTONE_SELECT = `
  SELECT t.id, t.source_id, t.url, t.title, t.reason_type, t.note, t.batch_run_id, t.eraser_kind,
         t.eraser_run_id, t.eraser_user, t.confidence, t.score_version, t.fingerprint, t.erased_at,
         t.lifted_at, t.lifted_by, t.readmitted_source_id,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('path', a.path, 'outcome', a.outcome,
                     'session_id', a.session_id, 'note', a.note, 'attempted_at', a.attempted_at)
                     ORDER BY a.attempted_at, a.id)
                     FROM public.source_tombstone_attempts a WHERE a.tombstone_id = t.id), '[]'::jsonb) AS attempts
    FROM public.source_tombstones t`;

export async function tombstoneBySource(db: Db, sourceId: string): Promise<TombstoneRow | null> {
  return (await db.query<TombstoneRow>(`${TOMBSTONE_SELECT} WHERE t.source_id = $1`, [sourceId]))[0] ?? null;
}

export async function tombstoneById(db: Db, id: string): Promise<TombstoneRow | null> {
  return (await db.query<TombstoneRow>(`${TOMBSTONE_SELECT} WHERE t.id = $1`, [id]))[0] ?? null;
}

export async function tombstoneForUrl(db: Db, url: string): Promise<TombstoneRow | null> {
  return (await db.query<TombstoneRow>(
    `${TOMBSTONE_SELECT} WHERE t.id = (SELECT id FROM public.contract_tombstone_for($1))`,
    [url],
  ))[0] ?? null;
}

export function sourceFamily(contentType: string, metadata: Record<string, unknown>): string {
  const scholarly = contentType === "paper" ||
    ["doi", "arxiv", "pmid", "pmcid"].some((k) => metadata?.[k] || (metadata?.scholarly as Record<string, unknown>)?.[k]);
  return scholarly ? "scholarly" : "general";
}

export function tombstoneOut(t: TombstoneRow) {
  return {
    ...t,
    confidence: t.confidence === null ? null : Number(t.confidence),
    attempts: Array.isArray(t.attempts) ? t.attempts : [],
  };
}

// reference(id, version?): sources -> held -> tombstone. null = unknown id.
export async function reference(
  db: Db,
  id: string,
  opts: { version: number | null; evidenceOnly: boolean; visible: Set<string>; filter: MetadataFilter },
) {
  const base = { id, kind: "source", requested_version: opts.version, source: null, tombstone: null, held: null, record: null };
  const s = await getSource(db, id, opts.filter);
  if (s) {
    if (opts.evidenceOnly && !opts.visible.has(s.lifecycle)) return omitted(base);
    return await sourceReference(db, s, opts.version, base);
  }
  const h = await getHeld(db, id, opts.filter);
  if (h) {
    if (opts.evidenceOnly && !opts.visible.has("held")) return omitted(base);
    return {
      ...base, state: "held", lifecycle: "held", version: h.revision,
      state_detail: { refinery_id: h.refinery_id, scope: "refinery only until folded" },
      held: { refinery_id: h.refinery_id, title: h.title, url: h.url, excerpt: h.excerpt, user_source_status: h.status },
    };
  }
  if (opts.filter) return null; // tombstones carry no metadata: fail closed under a filter
  const t = await tombstoneBySource(db, id);
  if (!t) return null;
  if (opts.evidenceOnly) return omitted(base);
  return {
    ...base, state: "erased", lifecycle: "erased", version: null,
    state_detail: { reason_type: t.reason_type, note: t.note, url: t.url },
    tombstone: tombstoneOut(t),
  };
}

export function omitted(base: Record<string, unknown>) {
  return { ...base, state: "omitted", lifecycle: null, version: null, state_detail: { reason: "evidence_only" } };
}

export async function sourceReference(db: Db, s: SourceRow, version: number | null, base: Record<string, unknown>) {
  const current = s.max_revision ?? 1;
  let excerpt = s.excerpt;
  let versionState = "current";
  if (version !== null && version !== current) {
    const rev = await db.query<{ excerpt: string }>(
      `SELECT left(content, 500) AS excerpt FROM public.source_revisions WHERE source_id = $1 AND revision = $2`,
      [s.id, version],
    );
    if (rev[0]) excerpt = rev[0].excerpt;
    versionState = version < current ? "updated" : "current";
  }
  const recordState = sourceRecordState({ lifecycle: s.lifecycle, staged_retract: s.staged_retract });
  const state = recordState === "active" ? (versionState === "updated" ? "updated" : "active") : recordState;
  return {
    ...base,
    state,
    lifecycle: s.lifecycle,
    version: current,
    state_detail: sourceStateDetail(s),
    source: {
      title: s.title, url: s.url, content_type: s.content_type, domain: s.domain,
      family: sourceFamily(s.content_type, s.metadata), excerpt,
      created_at: s.created_at, updated_at: s.updated_at,
    },
  };
}

export function sourceStateDetail(s: SourceRow): Record<string, unknown> {
  if (s.lifecycle === "suppressed" || s.lifecycle === "unlinked") {
    return {
      reason: s.suppression_reason ?? (s.metadata?.purged ? "purged (legacy, no reason recorded)" : "retracted (legacy, no reason recorded)"),
      context: s.suppression_context ?? { retracted_by: s.retracted_by, committed_at: s.retraction_committed_at },
    };
  }
  if (s.staged_retract) return { reason: "retraction staged; commits at the next compile", retracted_by: s.retracted_by };
  return {};
}

// chunkContext(chunkId, window)
export async function chunkContext(
  db: Db,
  sourceId: string,
  idx: number,
  window: number,
  opts: { evidenceOnly: boolean; visible: Set<string>; filter: MetadataFilter },
) {
  const s = await getSource(db, sourceId, opts.filter);
  const h = s ? null : await getHeld(db, sourceId, opts.filter);
  if (!s && !h) return null;
  const lifecycle = s ? s.lifecycle : "held";
  const base = { chunk_id: `${sourceId}:${idx}`, source_id: sourceId, idx, window };
  if (opts.evidenceOnly && !opts.visible.has(lifecycle)) {
    return { ...base, state: "omitted", lifecycle: null, state_detail: { reason: "evidence_only" }, chunks: [] };
  }
  const table = s ? "public.source_chunks" : "public.held_source_chunks";
  const key = s ? "source_id" : "held_source_id";
  const rows = await db.query<{ idx: number; content: string }>(
    `SELECT idx, content FROM ${table} WHERE ${key} = $1 AND idx BETWEEN $2 AND $3 ORDER BY idx`,
    [sourceId, idx - window, idx + window],
  );
  if (!rows.some((r) => r.idx === idx)) return null;
  const state = s ? sourceRecordState({ lifecycle, staged_retract: s.staged_retract }) : "held";
  return {
    ...base, state, lifecycle,
    state_detail: s ? sourceStateDetail(s) : { refinery_id: h!.refinery_id },
    chunks: rows.map((r) => ({ idx: r.idx, content: r.content, is_target: r.idx === idx })),
  };
}

// quality(id): the factors that exist before the D15 model (P3a) - authority, the claims the
// source grounds and their confidence. Version-stamped so P3a's model replaces it visibly.
export async function quality(db: Db, reg: RegistryReader, id: string, f: MetadataFilter) {
  const s = await getSource(db, id, f);
  const userTerm = termDef((await reg.entry("credibility_terms", "user_provided"))?.definition);
  if (!s) {
    const h = await getHeld(db, id, f);
    if (!h) return null;
    return heldQuality(h, userTerm);
  }
  const rows = await db.query<{ claims: number; mean: number | null; corroborating: number; contradicting: number; authority: number }>(
    `SELECT count(DISTINCT cs.claim_id) FILTER (WHERE cs.edge_type <> 'contradicts')::int AS claims,
            avg(c.confidence) FILTER (WHERE cs.edge_type <> 'contradicts') AS mean,
            count(*) FILTER (WHERE cs.edge_type = 'corroborates')::int AS corroborating,
            count(*) FILTER (WHERE cs.edge_type = 'contradicts')::int AS contradicting,
            (CASE WHEN $2::text ~* '\\.(gov|edu|mil)(:|/|$)' OR $3::text ~* '://[^/]*\\.(gov|edu|mil)(:|/|$)'
                   OR $4::text = 'primary' THEN 1.0 ELSE 0.85 END)::float AS authority
       FROM public.claim_sources cs JOIN public.claims c ON c.id = cs.claim_id
      WHERE cs.source_id = $1`,
    [id, s.domain ?? "", s.url ?? "", String(s.metadata?.authority ?? "")],
  );
  const q = rows[0];
  const mean = q?.mean === null || q?.mean === undefined ? null : Number(q.mean);
  return {
    source_id: id, lifecycle: s.lifecycle,
    state: sourceRecordState({ lifecycle: s.lifecycle, staged_retract: s.staged_retract }),
    state_detail: sourceStateDetail(s),
    family: sourceFamily(s.content_type, s.metadata),
    score: {
      value: mean, refinery_scoped: null, version: "claim-confidence-mean-v1",
      computed_from: "mean confidence of the claims this source grounds (init-claims.sql claim_confidence); the D15 model replaces it in P3a",
    },
    factors: [
      { name: "authority", value: Number(q?.authority ?? 0.85), reason: "1.0 for .gov/.edu/.mil or metadata.authority=primary, else 0.85" },
      { name: "grounded_claims", value: q?.claims ?? 0, reason: "claims this source states, corroborates or is inferred from" },
      { name: "corroborating_edges", value: q?.corroborating ?? 0, reason: "corroborates edges" },
      { name: "contradicting_edges", value: q?.contradicting ?? 0, reason: "contradicts edges" },
    ],
  };
}

function heldQuality(h: HeldRow, t: ReturnType<typeof termDef>) {
  return {
    source_id: h.id, lifecycle: "held", state: "held",
    state_detail: { refinery_id: h.refinery_id },
    family: sourceFamily(h.content_type, h.metadata),
    score: {
      value: 0, refinery_scoped: refineryScopedScore(0, true, t), version: `user_provided-v${t.term_version}`,
      computed_from: "a held source is not scored for the database; user_provided counts in its refinery only and is zero for admission",
    },
    factors: [
      { name: "user_provided", value: t.refinery_weight, reason: `refinery-scoped only (credibility_terms user_provided v${t.term_version}); admission weight 0` },
    ],
  };
}
