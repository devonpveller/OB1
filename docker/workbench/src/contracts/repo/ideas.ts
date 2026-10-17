// ideas() / idea(id) over the existing ideas / idea_revisions aggregate, extended into the
// idea refinery (D17 items 5-6), plus the refinery's held user sources and hidden set, and the
// user document listing (D12).
//
// WRITE PATHS: this module never writes `ideas` or `idea_revisions` - the MCP idea tools
// (capture_idea / update_idea / find_idea / research_idea) stay their only writers. The
// refinery's own tables (refinery_hidden, refinery_user_sources, held_sources) are written
// here; hiding a node touches refinery_hidden and nothing else.
import type { Db } from "../db.ts";
import { Conflict, NotFound } from "./lifecycle.ts";
import { tombstoneForUrl, tombstoneOut } from "./sources.ts";

const IDEA_COLS = `i.id, i.title, i.status, i.summary, i.current_revision, i.created_at, i.updated_at,
  i.thread_root, i.last_job_id, i.dossier_source_id`;

interface IdeaRow {
  id: string;
  title: string;
  status: string;
  summary: string;
  current_revision: number;
  created_at: string;
  updated_at: string;
  thread_root: string | null;
  last_job_id: string | null;
  dossier_source_id: string | null;
  document_path?: string | null;
}

export async function ideas(db: Db, limit: number) {
  const rows = await db.query<IdeaRow>(
    `SELECT ${IDEA_COLS}, d.path AS document_path
       FROM public.ideas i LEFT JOIN public.user_document_listings d ON d.refinery_id = i.id
      ORDER BY i.updated_at DESC LIMIT $1`,
    [limit],
  );
  return {
    ideas: rows.map((r) => ({
      id: r.id, title: r.title, state: "current", status: r.status, summary: r.summary,
      current_revision: r.current_revision, updated_at: r.updated_at, document_path: r.document_path ?? null,
    })),
  };
}

// The refinery's sessions: jobs stamped with the refinery (research_jobs.refinery_id, set by
// the idea_revisions inlet trigger) and the jobs the aggregate itself points at.
async function sessionsOf(db: Db, i: IdeaRow) {
  return await db.query<{ id: string; status: string; origin: string; query: string; refinery_id: string | null;
    created_at: string; finished_at: string | null; session_id: string | null }>(
    `SELECT j.id, j.status, j.origin, j.query, j.refinery_id, j.created_at, j.finished_at, j.session_id
       FROM public.research_jobs j
      WHERE j.refinery_id = $1
         OR j.id::text = $2
         OR j.id::text IN (SELECT research_job_id FROM public.idea_revisions WHERE idea_id = $1)
      ORDER BY j.created_at`,
    [i.id, i.last_job_id ?? ""],
  );
}

async function producedOf(db: Db, sessionIds: string[], dossierId: string | null) {
  const sources = await db.query<{ id: string; title: string; lifecycle: string }>(
    `SELECT DISTINCT s.id, s.title, public.source_lifecycle_state(s.retraction_committed_at, s.unlinked_at) AS lifecycle
       FROM public.sources s
      WHERE s.id IN (SELECT ss.source_id FROM public.session_sources ss WHERE ss.session_id = ANY($1::uuid[]))
         OR s.id = $2::uuid
      ORDER BY s.title`,
    [sessionIds, dossierId],
  );
  const claims = await db.query<{ id: string; text: string; confidence: number }>(
    `SELECT DISTINCT c.id, c.text, c.confidence
       FROM public.claims c
      WHERE c.synthesis_id IN (SELECT ss.source_id FROM public.session_sources ss
                                JOIN public.sources s ON s.id = ss.source_id AND s.content_type = 'research_synthesis'
                               WHERE ss.session_id = ANY($1::uuid[]))
         OR c.synthesis_id = $2::uuid
      ORDER BY c.text LIMIT 200`,
    [sessionIds, dossierId],
  );
  return { sources, claims: claims.map((c) => ({ ...c, confidence: Number(c.confidence) })) };
}

export async function userSources(db: Db, refineryId: string) {
  return await db.query<{ source_id: string; refinery_id: string; status: string; state: string;
    title: string; url: string | null; revision: number }>(
    `SELECT rus.source_id, rus.refinery_id, rus.status,
            COALESCE(CASE WHEN h.id IS NOT NULL THEN 'held' END,
                     public.source_lifecycle_state(s.retraction_committed_at, s.unlinked_at), 'erased') AS state,
            COALESCE(h.title, s.title, '') AS title, COALESCE(h.url, s.url) AS url,
            COALESCE(h.revision, (SELECT max(r.revision) FROM public.source_revisions r WHERE r.source_id = s.id), 1) AS revision
       FROM public.refinery_user_sources rus
       LEFT JOIN public.held_sources h ON h.id = rus.source_id
       LEFT JOIN public.sources s ON s.id = rus.source_id
      WHERE rus.refinery_id = $1
      ORDER BY rus.added_at`,
    [refineryId],
  );
}

interface Link { kind: string; id: string; pin: number | null }

// The context graph: a subgraph over the knowledge graph - the sources and claims of the
// refinery's sessions, its user sources, and every link picked up from its document. A link
// carries a pin only where the document pinned it; hidden is read from refinery_hidden only.
async function contextGraph(db: Db, refineryId: string, sessionIds: string[], docLinks: Link[]) {
  const hidden = new Set((await db.query<{ k: string }>(
    `SELECT node_kind || ':' || node_ref AS k FROM public.refinery_hidden WHERE refinery_id = $1`, [refineryId],
  )).map((r) => r.k));
  const docSourceIds = docLinks.filter((l) => l.kind === "source").map((l) => l.id);
  const src = await db.query<{ id: string; title: string; state: string }>(
    `SELECT id, title, state FROM (
       SELECT s.id::text AS id, s.title, public.source_lifecycle_state(s.retraction_committed_at, s.unlinked_at) AS state
         FROM public.sources s
        WHERE s.id IN (SELECT ss.source_id FROM public.session_sources ss WHERE ss.session_id = ANY($1::uuid[]))
           OR s.id::text = ANY($2::text[])
           OR s.id IN (SELECT rus.source_id FROM public.refinery_user_sources rus WHERE rus.refinery_id = $3)
       UNION
       SELECT h.id::text, h.title, 'held' FROM public.held_sources h WHERE h.refinery_id = $3
     ) x ORDER BY title`,
    [sessionIds, docSourceIds, refineryId],
  );
  const ids = src.map((s) => s.id);
  const grounds = await db.query<{ claim_id: string; text: string; source_id: string }>(
    `SELECT c.id::text AS claim_id, left(c.text, 200) AS text, cs.source_id::text AS source_id
       FROM public.claim_sources cs JOIN public.claims c ON c.id = cs.claim_id
      WHERE cs.source_id::text = ANY($1::text[]) LIMIT 500`,
    [ids],
  );
  const nodes = [
    ...src.map((s) => ({ kind: "source", id: s.id, title: s.title, state: s.state })),
    ...[...new Map(grounds.map((g) => [g.claim_id, g])).values()]
      .map((g) => ({ kind: "claim", id: g.claim_id, title: g.text, state: "current" })),
    ...docLinks.filter((l) => l.kind === "page").map((l) => ({ kind: "page", id: l.id, title: l.id, state: "current" })),
  ].map((n) => ({ ...n, hidden: hidden.has(`${n.kind}:${n.id}`) }));
  const links = [
    ...grounds.map((g) => ({ source: g.claim_id, target: g.source_id, kind: "grounds", pin: null })),
    ...docLinks.map((l) => ({ source: "document", target: l.id, kind: "document_link", pin: l.pin ?? null })),
  ];
  return { nodes, links };
}

export async function idea(db: Db, id: string) {
  const row = (await db.query<IdeaRow>(`SELECT ${IDEA_COLS} FROM public.ideas i WHERE i.id = $1`, [id]))[0];
  if (!row) return null;
  const revisions = await db.query<{ revision: number; summary: string; research_job_id: string | null; created_at: string }>(
    `SELECT revision, summary, research_job_id, created_at FROM public.idea_revisions WHERE idea_id = $1 ORDER BY revision`,
    [id],
  );
  const sessions = await sessionsOf(db, row);
  const sessionPoolIds = sessions.map((s) => s.session_id).filter((x): x is string => !!x);
  const doc = (await db.query<{ path: string; title: string; outbound_links: Link[] }>(
    `SELECT path, title, outbound_links FROM public.user_document_listings WHERE refinery_id = $1`, [id],
  ))[0] ?? null;
  const state = (await db.query<{ origin_kind: string; origin_document_id: string | null; path: string | null }>(
    `SELECT rs.origin_kind, rs.origin_document_id, d.path FROM public.refinery_state rs
       LEFT JOIN public.user_document_listings d ON d.id = rs.origin_document_id WHERE rs.refinery_id = $1`, [id],
  ))[0];
  const members = await db.query<{ member_kind: string; member_ref: string }>(
    `SELECT member_kind, member_ref FROM public.refinery_members WHERE refinery_id = $1 ORDER BY added_at`, [id],
  );
  const dossier = row.dossier_source_id
    ? (await db.query<{ source_id: string; title: string; lifecycle: string }>(
      `SELECT id AS source_id, title, public.source_lifecycle_state(retraction_committed_at, unlinked_at) AS lifecycle
         FROM public.sources WHERE id = $1`, [row.dossier_source_id],
    ))[0] ?? null
    : null;
  const external = (what: string) => ({
    state: "external",
    location: row.thread_root ? `mattermost:thread:${row.thread_root}` : null,
    note: `the ${what} lives in the idea's Mattermost thread today; it moves into the workspace room in P8a (D17)`,
  });
  return {
    id: row.id, title: row.title, state: "current", state_detail: {}, status: row.status, summary: row.summary,
    current_revision: row.current_revision, created_at: row.created_at, updated_at: row.updated_at,
    revisions,
    sessions: sessions.map(({ session_id: _s, ...rest }) => rest),
    dossier,
    draft: external("accreting draft"),
    room: external("room transcript"),
    produced: await producedOf(db, sessionPoolIds, row.dossier_source_id),
    refinery: {
      origin: { kind: state?.origin_kind ?? "captured_idea", document_path: state?.path ?? null },
      members: {
        sessions: sessions.map((s) => s.id),
        document: doc ? { path: doc.path, title: doc.title } : null,
        podcasts: members.filter((m) => m.member_kind === "podcast").map((m) => m.member_ref),
        exports: members.filter((m) => m.member_kind === "export").map((m) => m.member_ref),
        room: members.find((m) => m.member_kind === "room")?.member_ref ?? row.thread_root ?? null,
      },
      context_graph: await contextGraph(db, id, sessionPoolIds, doc?.outbound_links ?? []),
      hidden: await db.query<{ node_kind: string; node_ref: string; hidden_at: string }>(
        `SELECT node_kind, node_ref, hidden_at FROM public.refinery_hidden WHERE refinery_id = $1 ORDER BY hidden_at`, [id],
      ),
      user_sources: await userSources(db, id),
    },
  };
}

async function requireIdea(db: Db, id: string) {
  const r = await db.query<{ id: string }>(`SELECT id FROM public.ideas WHERE id = $1`, [id]);
  if (!r[0]) throw new NotFound("refinery not found (a user source needs a pre-existing refinery)");
}

export async function setHidden(db: Db, refineryId: string, kind: string, ref: string, hidden: boolean) {
  await requireIdea(db, refineryId);
  if (hidden) {
    await db.query(
      `INSERT INTO public.refinery_hidden (refinery_id, node_kind, node_ref) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [refineryId, kind, ref],
    );
  } else {
    await db.query(`DELETE FROM public.refinery_hidden WHERE refinery_id = $1 AND node_kind = $2 AND node_ref = $3`, [refineryId, kind, ref]);
  }
  return { refinery_id: refineryId, node_kind: kind, node_ref: ref, hidden };
}

export interface HeldInput {
  title: string;
  content: string;
  url?: string;
  content_type?: string;
  by?: string;
}

// Add a user-provided source: stored, chunked and embedded, state held, revision 1, owned by
// exactly one pre-existing refinery. A tombstoned URL is refused here too (held does not
// bypass the reopen path). Embeddings are computed BEFORE the transaction.
export async function addHeld(
  db: Db,
  refineryId: string,
  req: HeldInput,
  chunk: (t: string) => string[],
  embed: (t: string) => Promise<number[]>,
) {
  await requireIdea(db, refineryId);
  if (req.url) {
    const tb = await tombstoneForUrl(db, req.url);
    if (tb) throw new Conflict("this URL is tombstoned; it reopens through the admission call", { tombstone: tombstoneOut(tb) });
  }
  const chunks = chunk(req.content);
  const vec = (v: number[]) => `[${v.join(",")}]`;
  const docVec = vec(await embed(`${req.title}\n\n${req.content}`));
  const chunkVecs: string[] = [];
  for (const ch of chunks) chunkVecs.push(vec(await embed(ch)));
  return await db.tx(async (t) => {
    const id = (await t.query<{ id: string }>(
      `INSERT INTO public.held_sources (refinery_id, url, title, content, content_type, content_hash, embedding, metadata, added_by)
       VALUES ($1, $2, $3, $4, $5, md5($4), $6::vector, $7::jsonb, $8) RETURNING id`,
      [refineryId, req.url ?? null, req.title, req.content, req.content_type ?? "manual", docVec,
        JSON.stringify({ user_provided: true }), req.by ?? null],
    ))[0].id;
    for (let i = 0; i < chunks.length; i++) {
      await t.query(
        `INSERT INTO public.held_source_chunks (held_source_id, idx, content, embedding) VALUES ($1, $2, $3, $4::vector)`,
        [id, i, chunks[i], chunkVecs[i]],
      );
    }
    await t.query(
      `INSERT INTO public.refinery_user_sources (refinery_id, source_id, status, added_by) VALUES ($1, $2, 'held', $3)`,
      [refineryId, id, req.by ?? null],
    );
    const src = (await userSources(t, refineryId)).find((u) => u.source_id === id)!;
    return { source: src, chunks: chunks.length, embedded: true };
  });
}

// Remove a held source: outright, no tombstone (D5's erasure begins at active). Refused while a
// user document links it - the user resolves that in the document, by hand.
export async function removeHeld(db: Db, refineryId: string, sourceId: string) {
  return await db.tx(async (t) => {
    const h = await t.query<{ id: string }>(
      `SELECT id FROM public.held_sources WHERE id = $1 AND refinery_id = $2 FOR UPDATE`, [sourceId, refineryId],
    );
    if (!h[0]) {
      const listed = await t.query<{ source_id: string }>(
        `SELECT source_id FROM public.refinery_user_sources WHERE source_id = $1 AND refinery_id = $2`, [sourceId, refineryId],
      );
      if (listed[0]) throw new Conflict("this source was folded in; D5's suppression and erasure apply");
      throw new NotFound("no held source with this id in this refinery");
    }
    const docs = await t.query<{ path: string }>(
      `SELECT path FROM public.user_document_listings
        WHERE outbound_links @> jsonb_build_array(jsonb_build_object('id', $1::text)) ORDER BY path`,
      [sourceId],
    );
    if (docs.length) {
      throw new Conflict("a user document links this held source; remove the link in the document first", {
        documents: docs.map((d) => d.path),
      });
    }
    await t.query(`DELETE FROM public.refinery_user_sources WHERE source_id = $1 AND refinery_id = $2`, [sourceId, refineryId]);
    await t.query(`DELETE FROM public.held_sources WHERE id = $1`, [sourceId]);
    return { source_id: sourceId, removed: true, tombstoned: false };
  });
}

// D12: title, path, updated, outbound links. Nothing else is selected, so nothing else can leak.
export async function documents(db: Db, limit: number) {
  const rows = await db.query<{ title: string; path: string; updated: string; outbound_links: Link[] }>(
    `SELECT title, path, updated_at AS updated, outbound_links
       FROM public.user_document_listings ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  );
  return {
    documents: rows.map((r) => ({
      title: r.title, path: r.path, updated: r.updated,
      outbound_links: (r.outbound_links ?? []).map((l) => ({ kind: l.kind, id: l.id, pin: l.pin ?? null })),
    })),
  };
}
