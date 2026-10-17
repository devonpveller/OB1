// Knowledge reads: neighbours (page graph), claims, search, timeline, trail.
//
// Pages carry no metadata, so under a metadata filter they are never returned (fail closed).
// Held sources are not rows of `sources`, so no query here can surface one; search reaches
// held_sources only when the caller scopes it to their refinery.
import type { Db } from "../db.ts";
import type { MetadataFilter } from "../logic/scope.ts";

const STATEMENT_TIMEOUT_MS = 3000;

async function bounded<T>(db: Db, fn: (t: Db) => Promise<T>): Promise<T> {
  return await db.tx(async (t) => {
    await t.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    return await fn(t);
  });
}

// A page is pending-compile while a compile mark is newer than its row (D13).
const PAGE_STATE = `CASE WHEN EXISTS (SELECT 1 FROM public.page_compile_marks m
                            WHERE m.page_ref = w.slug AND m.marked_at >= w.updated_at)
                         THEN 'pending_compile' ELSE 'current' END`;

export async function neighbours(db: Db, slug: string, depth: number, limit: number, classes: string[], f: MetadataFilter) {
  if (f) return { root: slug, depth, truncated: false, nodes: [], links: [] };
  const rows = await bounded(db, (t) =>
    t.query<{ slug: string; title: string; page_class: string; links: unknown; d: number; state: string }>(
      `WITH RECURSIVE nbr(slug, d) AS (
         SELECT $1::text, 0
         UNION
         SELECT e.slug, n.d + 1
           FROM nbr n
           CROSS JOIN LATERAL (
             SELECT t.target AS slug FROM public.wiki_pages w
               CROSS JOIN LATERAL jsonb_array_elements_text(w.links) AS t(target) WHERE w.slug = n.slug
             UNION
             SELECT b.slug FROM public.wiki_pages b WHERE b.links @> to_jsonb(n.slug) LIMIT 200
           ) e
          WHERE n.d < $2)
       SELECT w.slug, w.title, w.page_class, w.links, k.d, ${PAGE_STATE} AS state
         FROM public.wiki_pages w
         JOIN (SELECT slug, min(d) AS d FROM nbr GROUP BY slug) k ON k.slug = w.slug
        WHERE (cardinality($4::text[]) = 0 OR w.page_class = ANY($4::text[]) OR w.slug = $1)
        ORDER BY k.d ASC, w.slug ASC
        LIMIT $3`,
      [slug, depth, limit, classes],
    )
  );
  const present = new Set(rows.map((r) => r.slug));
  const seen = new Set<string>();
  const links: { source: string; target: string }[] = [];
  for (const r of rows) {
    for (const target of Array.isArray(r.links) ? r.links as unknown[] : []) {
      if (typeof target !== "string" || !present.has(target) || seen.has(`${r.slug} ${target}`)) continue;
      seen.add(`${r.slug} ${target}`);
      links.push({ source: r.slug, target });
    }
  }
  return {
    root: slug, depth, truncated: rows.length >= limit, links,
    nodes: rows.map((r) => ({
      kind: "page", id: r.slug, title: r.title || r.slug.split("/").pop() || r.slug,
      page_class: r.page_class, state: r.state, distance: Number(r.d),
    })),
  };
}

export interface ClaimsQuery {
  thread_id: string | null;
  source_id: string | null;
  synthesis_id: string | null;
  status: string | null;
  q: string | null;
  limit: number;
  evidenceOnly: boolean;
  filter: MetadataFilter;
}

interface ClaimRow {
  id: string;
  text: string;
  epistemic_tag: string;
  status: string;
  confidence: number;
  contradicted: boolean;
  grounded: boolean;
  thread_id: string | null;
  synthesis_id: string | null;
  edges: { edge_id: number; source_id: string; edge_type: string; lifecycle: string; title: string; url: string | null }[];
}

// claims(scope, filter). An evidence-only caller sees only edges whose source is active; a claim
// left with no active edge is not evidence and is dropped. Others see every edge, typed.
export async function claims(db: Db, q: ClaimsQuery) {
  const rows = await db.query<ClaimRow>(
    `SELECT c.id, c.text, c.epistemic_tag, c.status, c.confidence, c.contradicted,
            public.claim_is_grounded(c.id) AS grounded, c.thread_id, c.synthesis_id,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('edge_id', cs.id, 'source_id', s.id, 'edge_type', cs.edge_type,
                        'lifecycle', public.source_lifecycle_state(s.retraction_committed_at, s.unlinked_at),
                        'title', s.title, 'url', s.url) ORDER BY cs.id)
                        FROM public.claim_sources cs JOIN public.sources s ON s.id = cs.source_id
                       WHERE cs.claim_id = c.id), '[]'::jsonb) AS edges
       FROM public.claims c
      WHERE ($1::uuid IS NULL OR c.thread_id = $1)
        AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM public.claim_sources x WHERE x.claim_id = c.id AND x.source_id = $2))
        AND ($3::uuid IS NULL OR c.synthesis_id = $3)
        AND ($4::text IS NULL OR c.status = $4)
        AND ($5::text IS NULL OR c.text ILIKE '%' || $5 || '%')
        AND ($6::jsonb IS NULL OR c.metadata @> $6::jsonb)
      ORDER BY c.confidence DESC, c.created_at DESC
      LIMIT $7`,
    [q.thread_id, q.source_id, q.synthesis_id, q.status, q.q, q.filter ? JSON.stringify(q.filter) : null, q.limit],
  );
  const out = rows.map((r) => shapeClaim(r, q.evidenceOnly)).filter((c) => c !== null);
  return { count: out.length, claims: out };
}

function shapeClaim(r: ClaimRow, evidenceOnly: boolean) {
  const edges = evidenceOnly ? r.edges.filter((e) => e.lifecycle === "active") : r.edges;
  if (evidenceOnly && edges.length === 0) return null;
  const byType: Record<string, number> = {};
  for (const e of edges) byType[e.edge_type] = (byType[e.edge_type] ?? 0) + 1;
  const suppressedEdges = r.edges.filter((e) => e.lifecycle !== "active").length;
  return {
    id: r.id, text: r.text, epistemic_tag: r.epistemic_tag, status: r.status, confidence: Number(r.confidence),
    contradicted: r.contradicted, grounded: r.grounded, thread_id: r.thread_id, synthesis_id: r.synthesis_id,
    state: "current",
    state_detail: suppressedEdges ? { suppressed_edges: suppressedEdges, note: "suppressed sources lend no credit (D5 stage 1)" } : {},
    edges_by_type: byType,
    sources: edges.map((e) => ({ ...e, edge_id: Number(e.edge_id) })),
  };
}

export interface SearchQuery {
  q: string;
  kinds: string[];
  refinery_id: string | null;
  limit: number;
  evidenceOnly: boolean;
  filter: MetadataFilter;
}

type Hit = { kind: string; id: string; title: string; snippet: string; state: string; lifecycle: string | null; page_class: string | null };

// search(query, kinds[], scope). Pages: the weighted tsvector (wiki_pages). Claims and sources:
// ILIKE on text / title. User documents are never searched - their bodies are not in the
// database (D12). Held sources: only inside the caller's refinery scope.
export async function search(db: Db, s: SearchQuery) {
  const want = (k: string) => s.kinds.length === 0 || s.kinds.includes(k);
  const hits: Hit[] = [];
  const mf = s.filter ? JSON.stringify(s.filter) : null;
  if (want("page") && !s.filter) hits.push(...await searchPages(db, s.q, s.limit));
  if (want("claim")) {
    hits.push(...await db.query<Hit>(
      `SELECT 'claim' AS kind, c.id::text AS id, left(c.text, 120) AS title, left(c.text, 300) AS snippet,
              'current' AS state, NULL::text AS lifecycle, NULL::text AS page_class
         FROM public.claims c WHERE c.text ILIKE '%' || $1 || '%' AND ($3::jsonb IS NULL OR c.metadata @> $3::jsonb)
        ORDER BY c.confidence DESC LIMIT $2`,
      [s.q, s.limit, mf],
    ));
  }
  if (want("source")) {
    const rows = await db.query<Hit>(
      `SELECT 'source' AS kind, x.id::text AS id, x.title, left(x.content, 300) AS snippet,
              public.source_lifecycle_state(x.retraction_committed_at, x.unlinked_at) AS state,
              public.source_lifecycle_state(x.retraction_committed_at, x.unlinked_at) AS lifecycle, NULL::text AS page_class
         FROM public.sources x
        WHERE (x.title ILIKE '%' || $1 || '%' OR x.content ILIKE '%' || $1 || '%')
          AND ($3::jsonb IS NULL OR x.metadata @> $3::jsonb)
        ORDER BY x.updated_at DESC LIMIT $2`,
      [s.q, s.limit, mf],
    );
    hits.push(...(s.evidenceOnly ? rows.filter((r) => r.lifecycle === "active") : rows));
    if (s.refinery_id && !s.evidenceOnly) hits.push(...await searchHeld(db, s.q, s.refinery_id, s.limit, mf));
  }
  return { query: s.q, kinds: s.kinds, scope: { refinery_id: s.refinery_id }, count: hits.length, results: hits };
}

async function searchPages(db: Db, q: string, limit: number): Promise<Hit[]> {
  return await bounded(db, (t) =>
    t.query<Hit>(
      `SELECT 'page' AS kind, w.slug AS id, w.title,
              ts_headline('english', w.body, websearch_to_tsquery('english', $1),
                          'StartSel=<<HL>>, StopSel=<</HL>>, MaxWords=30, MinWords=12, ShortWord=3, MaxFragments=1') AS snippet,
              ${PAGE_STATE} AS state, NULL::text AS lifecycle, w.page_class
         FROM public.wiki_pages w
        WHERE w.search_tsv @@ websearch_to_tsquery('english', $1)
        ORDER BY ts_rank(w.search_tsv, websearch_to_tsquery('english', $1)) DESC, w.updated_at DESC
        LIMIT $2`,
      [q, limit],
    )
  );
}

async function searchHeld(db: Db, q: string, refineryId: string, limit: number, mf: string | null): Promise<Hit[]> {
  return await db.query<Hit>(
    `SELECT 'source' AS kind, h.id::text AS id, h.title, left(h.content, 300) AS snippet,
            'held' AS state, 'held' AS lifecycle, NULL::text AS page_class
       FROM public.held_sources h
      WHERE h.refinery_id = $2 AND (h.title ILIKE '%' || $1 || '%' OR h.content ILIKE '%' || $1 || '%')
        AND ($4::jsonb IS NULL OR h.metadata @> $4::jsonb)
      ORDER BY h.created_at DESC LIMIT $3`,
    [q, refineryId, limit, mf],
  );
}

// timeline(scope, range): revisions, sessions, claims and trail events in one ordered list.
export async function timeline(db: Db, from: string | null, to: string | null, sourceId: string | null, limit: number, f: MetadataFilter) {
  if (f) return { from, to, events: [] };
  const events = await db.query<{ at: string; kind: string; ref: string; summary: string }>(
    `SELECT * FROM (
       SELECT r.edited_at AS at, 'source_revision' AS kind, r.source_id::text || '@' || r.revision AS ref,
              'revision ' || r.revision || ' by ' || r.edited_by AS summary, r.source_id AS sid
         FROM public.source_revisions r
       UNION ALL
       SELECT j.created_at, 'session_started', j.id::text, left(j.query, 120), NULL FROM public.research_jobs j
       UNION ALL
       SELECT j.finished_at, 'session_finished', j.id::text, j.status || ': ' || left(j.query, 100), NULL
         FROM public.research_jobs j WHERE j.finished_at IS NOT NULL
       UNION ALL
       SELECT c.created_at, 'claim_created', c.id::text, left(c.text, 120), NULL FROM public.claims c
       UNION ALL
       SELECT te.created_at, 'trail', te.source_id::text, te.kind, te.source_id FROM public.source_trail_events te
     ) e
     WHERE ($1::timestamptz IS NULL OR e.at >= $1) AND ($2::timestamptz IS NULL OR e.at <= $2)
       AND ($3::uuid IS NULL OR e.sid = $3)
     ORDER BY e.at DESC LIMIT $4`,
    [from, to, sourceId, limit],
  );
  return { from, to, events: events.map(({ ...e }) => ({ at: e.at, kind: e.kind, ref: e.ref, summary: e.summary })) };
}

// trail(scope): what was removed or excluded, and why. Nothing on it counts as evidence.
export async function trail(db: Db, sourceId: string | null, limit: number, f: MetadataFilter) {
  if (f) return { entries: [] };
  const rows = await db.query<{ kind: string; source_id: string; tombstone_id: string | null; state: string;
    reason: string | null; context: Record<string, unknown>; at: string }>(
    `SELECT * FROM (
       SELECT 'suppressed' AS kind, s.id AS source_id, NULL::uuid AS tombstone_id,
              public.source_lifecycle_state(s.retraction_committed_at, s.unlinked_at) AS state,
              COALESCE(s.suppression_reason, 'retracted (legacy, no reason recorded)') AS reason,
              COALESCE(s.suppression_context, jsonb_build_object('title', s.title, 'url', s.url)) AS context,
              s.retraction_committed_at AS at
         FROM public.sources s WHERE s.retraction_committed_at IS NOT NULL
       UNION ALL
       SELECT 'suppressed', s.id, NULL, 'redaction', 'retraction staged; commits at the next compile',
              jsonb_build_object('title', s.title, 'url', s.url, 'retracted_by', s.retracted_by), s.retracted_at
         FROM public.sources s WHERE s.retracted_at IS NOT NULL AND s.retraction_committed_at IS NULL
       UNION ALL
       SELECT 'erased', t.source_id, t.id, 'erased', t.reason_type,
              jsonb_build_object('url', t.url, 'title', t.title, 'note', t.note, 'batch_run_id', t.batch_run_id,
                                 'eraser_kind', t.eraser_kind), t.erased_at
         FROM public.source_tombstones t
       UNION ALL
       SELECT te.kind, te.source_id, te.tombstone_id, 'current', NULL, te.detail, te.created_at
         FROM public.source_trail_events te WHERE te.kind NOT IN ('suppressed', 'erased')
     ) x
     WHERE ($1::uuid IS NULL OR x.source_id = $1)
     ORDER BY x.at DESC LIMIT $2`,
    [sourceId, limit],
  );
  return { entries: rows.map((r) => ({ ...r, counts_as_evidence: false })) };
}
