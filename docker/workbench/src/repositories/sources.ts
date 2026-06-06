// Source lifecycle repository (P4). Update-with-history (never replace),
// reversible STAGED retract, restore, and the rare irreversible purge. Multi-row
// writes go through withTransaction (G8).
import { query, withTransaction } from "../db/pool.ts";
import type { Source, SourceRevision } from "../types.ts";

const COLS =
  "id, url, title, content, content_type, notebook, retracted_at, retracted_by, " +
  "retraction_committed_at, last_edited_by, last_edited_at, created_at, updated_at";

export async function getSource(id: string): Promise<Source | null> {
  const rows = await query<Source>(`SELECT ${COLS} FROM public.sources WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// Search existing (non-retracted) sources by title/content — backs the modal's
// "link an existing source" mode (#3, the deliberate-link path).
export async function searchSources(q: string, limit = 20): Promise<Partial<Source>[]> {
  const like = `%${q}%`;
  return await query<Partial<Source>>(
    `SELECT id, title, url, content_type FROM public.sources
      WHERE retraction_committed_at IS NULL
        AND ($1 = '' OR title ILIKE $2 OR content ILIKE $2)
      ORDER BY updated_at DESC LIMIT $3`,
    [q, like, limit],
  );
}

// Link an EXISTING source to an entity (grounding via the existing link system).
// user_linked wins on PK collision (P6.3).
export async function linkEntity(sourceId: string, entityId: number): Promise<unknown> {
  const rows = await query(
    `INSERT INTO public.source_entities (source_id, entity_id, mention_role, confidence, evidence)
     VALUES ($1,$2,'user_linked',1.0,$3)
     ON CONFLICT (source_id, entity_id)
     DO UPDATE SET mention_role='user_linked', confidence=1.0, evidence=EXCLUDED.evidence
     RETURNING source_id, entity_id`,
    [sourceId, entityId, `manual:operator@${new Date().toISOString()}`],
  );
  return rows[0];
}

// Link an EXISTING source into a notebook (deliberate membership).
export async function linkNotebook(threadId: string, sourceId: string): Promise<unknown> {
  const rows = await query(
    `SELECT * FROM public.link_source_to_thread($1,$2,'deliberate',NULL,'confirmed')`,
    [threadId, sourceId],
  );
  return rows[0];
}

// The notebooks this source is currently a confirmed member of (SourceLinker).
export async function listSourceNotebooks(sourceId: string): Promise<unknown[]> {
  return await query(
    `SELECT t.id, t.name, t.slug
       FROM public.thread_sources ts
       JOIN public.threads t ON t.id = ts.thread_id
      WHERE ts.source_id = $1 AND ts.status = 'confirmed'
      ORDER BY t.name`,
    [sourceId],
  );
}

// "Gravity" for the retract confirm dialog: N notebooks linked, M pages citing.
export async function gravity(id: string): Promise<{ notebooks: number; pages: number }> {
  const nb = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.thread_sources WHERE source_id = $1 AND status = 'confirmed'`,
    [id],
  );
  const pg = await query<{ n: number }>(
    `SELECT count(DISTINCT entity_id)::int AS n FROM public.source_entities WHERE source_id = $1`,
    [id],
  );
  return { notebooks: nb[0]?.n ?? 0, pages: pg[0]?.n ?? 0 };
}

export async function listRevisions(id: string): Promise<Partial<SourceRevision>[]> {
  return await query<Partial<SourceRevision>>(
    // content INCLUDED so the UI can compute per-revision line diffs.
    `SELECT revision, title, content, edited_at, edited_by, length(content) AS content_len
       FROM public.source_revisions WHERE source_id = $1 ORDER BY revision DESC`,
    [id],
  );
}

// Update the WORKING HEAD in place (P4.7 redesign). Edits do NOT each create a
// revision — they update sources.content/title and stamp last_edited_by/at. A
// revision is committed once per compile (commitPending). To keep a baseline for
// the first diff, the ORIGINAL head is snapshotted as revision 1 on the very
// first edit (only if no revisions exist yet). `source_id` is stable, so
// thread_sources / source_entities / search stay valid. ONE transaction (G8).
export async function updateSource(
  id: string,
  content: string | null,
  title: string | null,
  editedBy = "operator",
): Promise<{ source: Source } | null> {
  return await withTransaction(async (c) => {
    const exists = await c.queryObject<{ id: string }>(
      `SELECT id FROM public.sources WHERE id = $1`,
      [id],
    );
    if (exists.rows.length === 0) return null;
    const revCount = (await c.queryObject<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.source_revisions WHERE source_id = $1`,
      [id],
    )).rows[0].n;
    if (revCount === 0) {
      // Baseline = the original (pre-edit) head, so a diff has a "before".
      await c.queryObject(
        `INSERT INTO public.source_revisions (source_id, revision, content, title, edited_by)
         SELECT id, 1, content, title, 'original' FROM public.sources WHERE id = $1`,
        [id],
      );
    }
    const upd = await c.queryObject<Source>(
      `UPDATE public.sources
          SET content = COALESCE($2, content), title = COALESCE($3, title),
              last_edited_by = $4, last_edited_at = now()
        WHERE id = $1
        RETURNING ${COLS}`,
      [id, content, title, editedBy],
    );
    return { source: upd.rows[0] };
  });
}

// Commit working heads to source_revisions — ONE revision per dirty source per
// compile (the wiki-service calls this at compile start). "Dirty" = the head
// content/title differs from the source's latest committed revision. The new
// revision is stamped with last_edited_by (the working-head author).
export async function commitPending(): Promise<{ committed: number }> {
  return await withTransaction(async (c) => {
    const dirty = await c.queryObject<
      { id: string; content: string; title: string; last_edited_by: string }
    >(
      `SELECT s.id, s.content, s.title, COALESCE(s.last_edited_by, 'operator') AS last_edited_by
         FROM public.sources s
         LEFT JOIN LATERAL (
           SELECT content, title FROM public.source_revisions r
            WHERE r.source_id = s.id ORDER BY revision DESC LIMIT 1
         ) lr ON true
        WHERE s.last_edited_at IS NOT NULL
          AND (lr.content IS DISTINCT FROM s.content OR lr.title IS DISTINCT FROM s.title)`,
    );
    let committed = 0;
    for (const s of dirty.rows) {
      const next = (await c.queryObject<{ n: number }>(
        `SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM public.source_revisions WHERE source_id = $1`,
        [s.id],
      )).rows[0].n;
      await c.queryObject(
        `INSERT INTO public.source_revisions (source_id, revision, content, title, edited_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [s.id, next, s.content, s.title, s.last_edited_by],
      );
      committed++;
    }
    return { committed };
  });
}

// Deliberate commit-now: snapshot THIS source's head as a revision if it differs
// from the latest committed one (used by "Commit now" + the revert flow).
export async function commitOne(
  id: string,
  author = "operator",
): Promise<{ committed: boolean; revision?: number }> {
  return await withTransaction(async (c) => {
    const head = (await c.queryObject<{ content: string; title: string }>(
      `SELECT content, title FROM public.sources WHERE id = $1`,
      [id],
    )).rows[0];
    if (!head) return { committed: false };
    const latest = (await c.queryObject<{ content: string; title: string }>(
      `SELECT content, title FROM public.source_revisions WHERE source_id = $1 ORDER BY revision DESC LIMIT 1`,
      [id],
    )).rows[0];
    if (latest && latest.content === head.content && latest.title === head.title) return { committed: false };
    const next = (await c.queryObject<{ n: number }>(
      `SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM public.source_revisions WHERE source_id = $1`,
      [id],
    )).rows[0].n;
    await c.queryObject(
      `INSERT INTO public.source_revisions (source_id, revision, content, title, edited_by) VALUES ($1, $2, $3, $4, $5)`,
      [id, next, head.content, head.title, author],
    );
    return { committed: true, revision: next };
  });
}

async function revisionContent(id: string, rev: number): Promise<{ content: string; title: string } | null> {
  const rows = await query<{ content: string; title: string }>(
    `SELECT content, title FROM public.source_revisions WHERE source_id = $1 AND revision = $2`,
    [id, rev],
  );
  return rows[0] ?? null;
}

// Revert: preserve current edits as a revision, then set the head to revision
// `rev`'s content (a new working draft that re-commits as the revert).
export async function revertToRevision(id: string, rev: number, author = "operator"): Promise<{ source: Source } | null> {
  const target = await revisionContent(id, rev);
  if (!target) return null;
  await commitOne(id, author);
  return await updateSource(id, target.content, target.title, author);
}

// Discard: drop uncommitted edits — reset the head to the latest committed
// revision (no new revision). No-op if there are no revisions yet.
export async function discardToLatest(id: string, author = "operator"): Promise<{ source: Source } | null> {
  const latest = (await query<{ content: string; title: string }>(
    `SELECT content, title FROM public.source_revisions WHERE source_id = $1 ORDER BY revision DESC LIMIT 1`,
    [id],
  ))[0];
  if (!latest) return null;
  return await updateSource(id, latest.content, latest.title, author);
}

// Reversible STAGED retract (global). retraction_committed_at stays NULL =
// staged; the compile tick commits it. Restore clears all three.
export async function retractStaged(id: string, by = "operator"): Promise<Source | null> {
  const rows = await query<Source>(
    `UPDATE public.sources
        SET retracted_at = now(), retracted_by = $2, retraction_committed_at = NULL
      WHERE id = $1 RETURNING ${COLS}`,
    [id, by],
  );
  return rows[0] ?? null;
}

export async function restore(id: string): Promise<Source | null> {
  const rows = await query<Source>(
    `UPDATE public.sources
        SET retracted_at = NULL, retracted_by = NULL, retraction_committed_at = NULL
      WHERE id = $1 RETURNING ${COLS}`,
    [id],
  );
  return rows[0] ?? null;
}

// Per-notebook unlink (soft status flip; source stays elsewhere + in generation).
export async function unlinkFromNotebook(threadId: string, sourceId: string): Promise<unknown> {
  const rows = await query(
    `SELECT * FROM public.set_thread_source_status($1, $2, 'hidden')`,
    [threadId, sourceId],
  );
  return rows[0];
}

// Irreversible purge (cascades source_entities/thread_sources/session_sources/
// source_revisions/source_chunks). Qualified DELETE — operator-confirmed only.
export async function purge(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM public.sources WHERE id = $1 RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

// URL re-fetch → NEW revision (never head overwrite, never a duplicate). A
// real deployment would route the fetched HTML through openbrain-extract; this
// stores the fetched text and appends it as a revision via updateSource.
export async function refetch(id: string): Promise<{ source: Source } | null> {
  const src = await getSource(id);
  if (!src) return null;
  if (!src.url) throw new Error("source has no URL to re-fetch");
  const r = await fetch(src.url, { redirect: "follow" });
  if (!r.ok) throw new Error(`re-fetch HTTP ${r.status}`);
  const text = await r.text();
  // Re-fetch updates the working head; the new revision commits at the next compile.
  return await updateSource(id, text, null, "refetch");
}
