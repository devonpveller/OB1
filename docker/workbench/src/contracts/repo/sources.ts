// Source reads for the contract: reference, chunk context, quality. (diffCheck moved to
// references.ts in P2a, where the pinned revision lives.)
// Lifecycle WRITES (suppress / sever / erase / admission) live in lifecycle.ts.
import type { Db } from "../db.ts";
import type { MetadataFilter } from "../logic/scope.ts";
import { sourceRecordState } from "../logic/state.ts";
import { refineryScopedScore, termDef } from "../logic/credibility.ts";
import { safeReasonText, safeSignals } from "../logic/scholarly_reason.ts";
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

// A held source belongs to exactly one refinery, and a refinery (an idea) carries no metadata, so
// under a filter a held source is out of scope whatever its own metadata says: answering it would
// name the refinery (rw-p0-contract2 attempt 2). Unfiltered callers read it as before.
export async function getHeld(db: Db, id: string, f: MetadataFilter): Promise<HeldRow | null> {
  if (f) return null;
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

// `f` scopes by the erased source's metadata, snapshotted onto the tombstone at erase time
// (rw-p0-contract2): under the cloud door's filter only a tombstone of a share=cloud source
// resolves; a tombstone with no snapshot ('{}', e.g. one written before the column) does not.
// What an in-scope tombstone carries that names ANOTHER row is redacted to in-scope ids
// (attempt 2, tester finding N4): attempts[].session_id and .note (a session carries no metadata;
// the note is the door's free text about it), batch_run_id and eraser_run_id (runs are jobs,
// which carry no metadata), readmitted_source_id unless that source is itself in scope, and
// confidence (the score_at_removal snapshot: a mean over every claim the source grounded, in and
// out of scope - the same value the scoped suppression context drops).
export async function tombstoneById(db: Db, id: string, f: MetadataFilter = null): Promise<TombstoneRow | null> {
  const mf = f ? JSON.stringify(f) : null;
  const t = (await db.query<TombstoneRow & { readmitted_in_scope: boolean }>(
    `SELECT x.*, EXISTS (SELECT 1 FROM public.sources r WHERE r.id = x.readmitted_source_id AND r.metadata @> $2::jsonb)
                 AS readmitted_in_scope
       FROM (${TOMBSTONE_SELECT} WHERE t.id = $1 AND ($2::jsonb IS NULL OR t.metadata @> $2::jsonb)) x`,
    [id, mf],
  ))[0];
  if (!t) return null;
  const { readmitted_in_scope, ...row } = t;
  if (!mf) return row;
  return {
    ...row,
    batch_run_id: null,
    eraser_run_id: null,
    confidence: null,
    readmitted_source_id: readmitted_in_scope ? row.readmitted_source_id : null,
    attempts: (Array.isArray(row.attempts) ? row.attempts : []).map((a) => ({
      ...(a as Record<string, unknown>), session_id: null, note: null,
    })),
  };
}

export async function tombstoneForUrl(db: Db, url: string): Promise<TombstoneRow | null> {
  return (await db.query<TombstoneRow>(
    `${TOMBSTONE_SELECT} WHERE t.id = (SELECT id FROM public.contract_tombstone_for($1))`,
    [url],
  ))[0] ?? null;
}

// D15 item 10 (P3a): scholarly when a scholarly identifier RESOLVED, general otherwise - an
// identifier that did not resolve, or a content_type of "paper" alone, is not the scholarly family
// (it has no cited_by / works_count to be scored from). The admission record's family wins.
export function sourceFamily(_contentType: string, metadata: Record<string, unknown>): string {
  const recorded = (metadata?.credibility as Record<string, unknown> | undefined)?.family;
  if (typeof recorded === "string") return recorded;
  return (metadata?.scholarly as Record<string, unknown> | undefined)?.state === "resolved" ? "scholarly" : "general";
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
    return await sourceReference(db, s, opts.version, base, opts.filter);
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

export async function sourceReference(db: Db, s: SourceRow, version: number | null, base: Record<string, unknown>, f: MetadataFilter) {
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
    state_detail: sourceStateDetail(s, f),
    source: {
      title: s.title, url: s.url, content_type: s.content_type, domain: s.domain,
      family: sourceFamily(s.content_type, s.metadata), excerpt,
      created_at: s.created_at, updated_at: s.updated_at,
    },
  };
}

// The suppression context is a snapshot taken at suppress time (lifecycle.ts suppress()). Beside
// the source's own title / url / who / when it counts notebooks and citing pages (records with no
// metadata) and averages the claims the source grounded (in and out of scope). Under a filter only
// the source's own fields are kept - an ALLOW-LIST, so a key a later snapshot gains is dropped
// (rw-p0-contract2 attempt 2, tester finding N4).
const SCOPED_CONTEXT_KEYS = ["title", "url", "suppressed_by", "suppressed_at", "retracted_by", "committed_at"];

export function sourceStateDetail(s: SourceRow, f: MetadataFilter = null): Record<string, unknown> {
  if (s.lifecycle === "suppressed" || s.lifecycle === "unlinked") {
    const context: Record<string, unknown> = s.suppression_context ?? { retracted_by: s.retracted_by, committed_at: s.retraction_committed_at };
    return {
      reason: s.suppression_reason ?? (s.metadata?.purged ? "purged (legacy, no reason recorded)" : "retracted (legacy, no reason recorded)"),
      context: f ? Object.fromEntries(Object.entries(context).filter(([k]) => SCOPED_CONTEXT_KEYS.includes(k))) : context,
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
    state_detail: s ? sourceStateDetail(s, opts.filter) : { refinery_id: h!.refinery_id },
    chunks: rows.map((r) => ({ idx: r.idx, content: r.content, is_target: r.idx === idx })),
  };
}

// diffCheck(referenceIds[]) lives in repo/references.ts since research-workbench P2a (it reads
// the reference_records pin); P3a's quality() below is unchanged by it.

// quality(id) - why this source is rated as it is (research-workbench P3a, D15). Never a bare
// number: the D15 rolling total for the claim kind it was admitted under, the family and the
// signals it was computed from, every source whose corroboration is in it, every source that
// contradicts a claim it grounds, and the history. The numbers come from the SQL twin of the
// model (init-research-credibility.sql: source_credibility / source_rolling_total), which reads
// the research service's admission record (metadata.credibility) or, for a source stored before
// P3a, derives the general family's domain-class score and says so.
// Under a filter (the cloud door) every aggregate and every named row is scoped the way P0 scoped
// the pre-D15 score (rw-p0-contract2 attempt 2, tester finding N2/N4): a source is named in
// corroborated_by / contradicted_by only when it is itself in scope AND the claim that links it is
// in scope; the rolling total counts only corroborations received from in-scope givers
// (source_rolling_total's scoped form); a history row's stored total (a snapshot over every giver,
// in and out of scope) is null - its family score is the source's own and stays.
// Attempt 2 (tester t-rw-p3a finding 1): a giver row's `claim` is the corroboration LINE - the
// synthesis line, i.e. the text of the claim filed from it - and a line has no metadata of its own.
// Under a filter the line's text is served only when an ACTIVE IN-SCOPE claim has exactly that
// text; otherwise it is null (fail closed: an in-scope giver on an out-of-scope claim's line, or a
// line no in-scope claim was filed as). The giver itself (in scope) and its amount stay: the number
// is the accepted residual class, the text is not. The rule for a cloud answer: every text, id,
// title or URL it carries belongs to an in-scope row. signals.scholarly.reason is served only as an
// allow-listed reason code and every reason line is scrubbed of credential-shaped text, on both
// doors (logic/scholarly_reason.ts).
interface CredRow { family: string | null; score: number | null; is_primary: boolean | null; basis: string | null; kind: string | null; total: number | null; model: string }
interface QSourceRow { source_id: string; title: string; url: string | null; family: string | null; relation: string; amount: number | null; claim: string | null }

export async function quality(db: Db, reg: RegistryReader, id: string, f: MetadataFilter) {
  const s = await getSource(db, id, f);
  const userTerm = termDef((await reg.entry("credibility_terms", "user_provided"))?.definition);
  if (!s) {
    const h = await getHeld(db, id, f);
    if (!h) return null;
    return heldQuality(h, userTerm);
  }
  const cred = (s.metadata?.credibility ?? null) as Record<string, unknown> | null;
  const mf = f ? JSON.stringify(f) : null;
  const [c] = await db.query<CredRow>(
    `WITH k AS (SELECT COALESCE($2::text, public.credibility_fallback_kind()) AS kind)
     SELECT sc.family, sc.score, sc.is_primary, sc.basis, k.kind,
            public.source_rolling_total($1::uuid, k.kind, $3::jsonb) AS total, public.credibility_model_version() AS model
       FROM k LEFT JOIN LATERAL public.source_credibility($1::uuid) sc ON TRUE`,
    [id, typeof cred?.claim_kind === "string" ? cred.claim_kind : null, mf],
  );
  const corroborated = await db.query<QSourceRow>(
    `SELECT g.id AS source_id, g.title, g.url, gc.family,
            CASE sc.strength WHEN 'strong' THEN 'strong corroboration (entailment ' || sc.verdict || ')'
                             ELSE 'weak corroboration (entailment ' || sc.verdict || ')' END AS relation,
            sc.amount::float AS amount,
            CASE WHEN $2::jsonb IS NULL THEN sc.claim_text
                 WHEN EXISTS (SELECT 1 FROM public.claims lc
                               WHERE btrim(lc.text) = btrim(sc.claim_text) AND lc.status = 'active'
                                 AND lc.metadata @> $2::jsonb) THEN sc.claim_text
                 ELSE NULL END AS claim
       FROM public.source_corroborations sc
       JOIN public.sources g ON g.id = sc.from_source_id AND g.retraction_committed_at IS NULL
            AND ($2::jsonb IS NULL OR g.metadata @> $2::jsonb)
       LEFT JOIN LATERAL public.source_credibility(g.id) gc ON TRUE
      WHERE sc.to_source_id = $1::uuid
     UNION ALL
     SELECT DISTINCT ON (o.id) o.id, o.title, o.url, oc.family, 'co-grounds a claim' AS relation, NULL::float, cl.text
       FROM public.claim_sources mine
       JOIN public.claim_sources other ON other.claim_id = mine.claim_id AND other.source_id <> mine.source_id
            AND other.edge_type IN ('states', 'corroborates')
       JOIN public.sources o ON o.id = other.source_id AND o.retraction_committed_at IS NULL
            AND ($2::jsonb IS NULL OR o.metadata @> $2::jsonb)
       JOIN public.claims cl ON cl.id = mine.claim_id AND cl.status = 'active'
            AND ($2::jsonb IS NULL OR cl.metadata @> $2::jsonb)
       LEFT JOIN LATERAL public.source_credibility(o.id) oc ON TRUE
      WHERE mine.source_id = $1::uuid AND mine.edge_type IN ('states', 'corroborates')`,
    [id, mf],
  );
  const contradicted = await db.query<QSourceRow>(
    `SELECT DISTINCT ON (o.id) o.id AS source_id, o.title, o.url, oc.family,
            'contradicts a claim this source grounds' AS relation, NULL::float AS amount, cl.text AS claim
       FROM public.claim_sources mine
       JOIN public.claims cl ON cl.id = mine.claim_id AND cl.status = 'active'
            AND ($2::jsonb IS NULL OR cl.metadata @> $2::jsonb)
       JOIN public.claim_sources against ON against.claim_id = mine.claim_id AND against.edge_type = 'contradicts'
            AND against.source_id IS NOT NULL AND against.source_id <> mine.source_id
       JOIN public.sources o ON o.id = against.source_id AND o.retraction_committed_at IS NULL
            AND ($2::jsonb IS NULL OR o.metadata @> $2::jsonb)
       LEFT JOIN LATERAL public.source_credibility(o.id) oc ON TRUE
      WHERE mine.source_id = $1::uuid AND mine.edge_type <> 'contradicts'
     UNION
     SELECT DISTINCT ON (o.id) o.id, o.title, o.url, oc.family,
            'grounds a claim that contradicts one this source grounds', NULL::float, other.text
       FROM public.claim_sources mine
       JOIN public.claims mc ON mc.id = mine.claim_id AND ($2::jsonb IS NULL OR mc.metadata @> $2::jsonb)
       JOIN public.claim_sources cc ON cc.claim_id = mine.claim_id AND cc.edge_type = 'contradicts' AND cc.parent_claim_id IS NOT NULL
       JOIN public.claims other ON other.id = cc.parent_claim_id AND other.status = 'active'
            AND ($2::jsonb IS NULL OR other.metadata @> $2::jsonb)
       JOIN public.claim_sources theirs ON theirs.claim_id = other.id AND theirs.edge_type <> 'contradicts' AND theirs.source_id IS NOT NULL
       JOIN public.sources o ON o.id = theirs.source_id AND o.retraction_committed_at IS NULL AND o.id <> $1::uuid
            AND ($2::jsonb IS NULL OR o.metadata @> $2::jsonb)
       LEFT JOIN LATERAL public.source_credibility(o.id) oc ON TRUE
      WHERE mine.source_id = $1::uuid AND mine.edge_type <> 'contradicts'`,
    [id, mf],
  );
  // attempt 4 (tester near-miss: a history row's labels were served verbatim, so a writer could put any
  // text there): claim_kind is served only when it is a claim_kinds registry key, model_version only
  // when it is a D15 model label ("d15 weights v<N> paper <key>") naming a paper_score_versions row;
  // anything else is null. Retired rows count (the history is historical).
  const history = await db.query<{ score: number; total: number | null; claim_kind: string | null; model_version: string | null; computed_at: string }>(
    `SELECT h.score::float AS score, h.total::float AS total,
            CASE WHEN EXISTS (SELECT 1 FROM public.contract_registry_entries e
                               WHERE e.registry = 'claim_kinds' AND e.key = h.claim_kind) THEN h.claim_kind END AS claim_kind,
            CASE WHEN h.model_version ~ '^d15 weights v[0-9]{1,9} paper [a-z0-9][a-z0-9._-]*$'
                  AND EXISTS (SELECT 1 FROM public.contract_registry_entries e WHERE e.registry = 'paper_score_versions'
                                 AND e.key = substring(h.model_version from ' paper ([a-z0-9][a-z0-9._-]*)$'))
                 THEN h.model_version END AS model_version,
            h.computed_at
       FROM public.source_credibility_history h WHERE h.source_id = $1::uuid ORDER BY h.computed_at DESC, h.id DESC LIMIT 50`,
    [id],
  );
  const family = c?.family ?? sourceFamily(s.content_type, s.metadata);
  const reasons = Array.isArray(cred?.reasons) ? (cred!.reasons as unknown[]).map(safeReasonText) : [];
  const received = corroborated.filter((r) => r.amount !== null);
  const total = c?.total === null || c?.total === undefined ? null : r4(c.total);
  return {
    source_id: id, lifecycle: s.lifecycle,
    state: sourceRecordState({ lifecycle: s.lifecycle, staged_retract: s.staged_retract }),
    state_detail: sourceStateDetail(s, f),
    family,
    score: {
      value: total, refinery_scoped: null,
      version: typeof cred?.model_version === "string" ? cred.model_version : (c?.model ?? "d15"),
      computed_from: `D15 rolling total for claim kind ${c?.kind ?? "?"}: family score (${c?.basis ?? "no record"}) x the weight row` +
        `${received.length ? `, plus ${received.length} entailment-gated corroboration(s) received` : ""}`,
    },
    claim_kind: c?.kind ?? null,
    signals: safeSignals(cred?.signals ?? (s.metadata?.scholarly ? { scholarly: s.metadata.scholarly } : {})),
    corroborated_by: corroborated.map(qSource),
    contradicted_by: contradicted.map(qSource),
    history: history.map((h) => ({ score: r4(h.score), total: h.total === null || mf ? null : r4(h.total), claim_kind: h.claim_kind, model_version: h.model_version, computed_at: new Date(h.computed_at).toISOString() })),
    factors: [
      { name: `${family}_family_score`, value: r4(c?.score ?? 0), reason: c?.basis ?? "no credibility record and no derivable signal" },
      ...reasons.map((r) => ({ name: "reason", value: 0, reason: r })),
      ...received.map((r) => ({ name: "corroboration_received", value: r4(r.amount), reason: `${r.relation} from ${r.title || r.source_id}` })),
      { name: "contradicting_sources", value: contradicted.length, reason: "sources contradicting a claim this source grounds (listed in contradicted_by)" },
    ],
  };
}

// REAL columns read back as 0.40000000596; the contract carries 4 decimals.
const r4 = (x: unknown) => Math.round(Number(x) * 10_000) / 10_000;

function qSource(r: QSourceRow) {
  return { source_id: r.source_id, title: r.title ?? "", url: r.url, family: r.family, relation: r.relation,
    amount: r.amount === null || r.amount === undefined ? null : r4(r.amount), claim: r.claim };
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
    claim_kind: null,
    signals: {},
    corroborated_by: [],
    contradicted_by: [],
    history: [],
    factors: [
      { name: "user_provided", value: t.refinery_weight, reason: `refinery-scoped only (credibility_terms user_provided v${t.term_version}); admission weight 0` },
    ],
  };
}
