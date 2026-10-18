// Source lifecycle repository (P4). Update-with-history (never replace),
// reversible STAGED retract and restore. Multi-row writes go through withTransaction (G8).
// The purge is no longer here: DELETE /workbench/sources/:id calls the contract's D5 suppress
// (src/contracts/repo/lifecycle.ts; rw-p0b-purge-door).
import { query, withTransaction } from "../db/pool.ts";
import type { Source, SourceRevision } from "../types.ts";

const COLS =
  "id, url, title, content, content_type, notebook, retracted_at, retracted_by, " +
  "retraction_committed_at, last_edited_by, last_edited_at, created_at, updated_at, " +
  "COALESCE((metadata->>'purged')::boolean, false) AS purged";

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

// The D5 lifecycle these pre-contract doors must honour (research-workbench P0, rw-p0-contract
// attempt 2, tester finding F2): a committed retraction IS the suppressed state
// (source_lifecycle_state, 230-init-research-contract.sql), so neither door may flip one back
// to active silently.
export class LifecycleConflict extends Error {
  constructor(message: string, public lifecycle: string) {
    super(message);
  }
}

// Reversible STAGED retract (global). retraction_committed_at stays NULL =
// staged; the compile tick commits it. Restore clears all three.
// REFUSED on a suppressed / unlinked source: re-staging would null retraction_committed_at and
// return it to generation until the next compile - the source is already retracted, harder.
export async function retractStaged(id: string, by = "operator"): Promise<Source | null> {
  return await withTransaction(async (c) => {
    const cur = (await c.queryObject<{ lifecycle: string }>(
      `SELECT public.source_lifecycle_state(retraction_committed_at, unlinked_at) AS lifecycle
         FROM public.sources WHERE id = $1 FOR UPDATE`,
      [id],
    )).rows[0];
    if (!cur) return null;
    if (cur.lifecycle !== "active") {
      throw new LifecycleConflict(
        `source is ${cur.lifecycle}: a staged retract would return it to generation; it is already retracted (D5)`,
        cur.lifecycle,
      );
    }
    const rows = await c.queryObject<Source>(
      `UPDATE public.sources
          SET retracted_at = now(), retracted_by = $2, retraction_committed_at = NULL
        WHERE id = $1 RETURNING ${COLS}`,
      [id, by],
    );
    return rows.rows[0] ?? null;
  });
}

// Restore. On an ACTIVE source (a staged retract, or none) it clears the stage as before. On a
// suppressed / unlinked source it is the D5 un-suppress, made a RECORDED transition like the
// contract's own suppress / sever / erase: the suppression state (reason, context, unlinked_at)
// is cleared, a 'restored' trail event carries from -> to and the old reason, and the claims the
// source grounds are re-scored (claim_confidence counts it again).
export async function restore(
  id: string,
  by = "operator",
): Promise<{ source: Source; transition: { from: string; to: string } | null } | null> {
  // A source purged BEFORE rw-p0b-purge-door (metadata.purged, stamped by the removed direct
  // purge) stays a permanent suppression (OD-1) — restore refuses it. A purge made since is the
  // contract's D5 suppress, which stamps nothing, so restore takes it back like any suppression.
  return await withTransaction(async (c) => {
    const cur = (await c.queryObject<{ lifecycle: string; reason: string | null }>(
      `SELECT public.source_lifecycle_state(retraction_committed_at, unlinked_at) AS lifecycle,
              suppression_reason AS reason
         FROM public.sources
        WHERE id = $1 AND COALESCE((metadata->>'purged')::boolean, false) = false
        FOR UPDATE`,
      [id],
    )).rows[0];
    if (!cur) return null;
    const rows = await c.queryObject<Source>(
      `UPDATE public.sources
          SET retracted_at = NULL, retracted_by = NULL, retraction_committed_at = NULL,
              suppression_reason = NULL, suppression_context = NULL, unlinked_at = NULL
        WHERE id = $1
        RETURNING ${COLS}`,
      [id],
    );
    if (cur.lifecycle === "active") return { source: rows.rows[0], transition: null };
    const transition = { from: cur.lifecycle, to: "active" };
    await c.queryObject(
      `INSERT INTO public.source_trail_events (source_id, kind, detail, actor)
       VALUES ($1, 'restored', $2::jsonb, $3)`,
      [id, JSON.stringify({ ...transition, reason: cur.reason, door: "POST /workbench/sources/:id/restore" }), by],
    );
    await c.queryObject(`SELECT public.recompute_claims_for_source($1)`, [id]);
    return { source: rows.rows[0], transition };
  });
}

// Per-notebook unlink (soft status flip; source stays elsewhere + in generation).
export async function unlinkFromNotebook(threadId: string, sourceId: string): Promise<unknown> {
  const rows = await query(
    `SELECT * FROM public.set_thread_source_status($1, $2, 'hidden')`,
    [threadId, sourceId],
  );
  return rows[0];
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
