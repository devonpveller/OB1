// Source lifecycle repository (P4). Update-with-history (never replace),
// reversible STAGED retract, restore, and the rare irreversible purge. Multi-row
// writes go through withTransaction (G8).
import { query, withTransaction } from "../db/pool.ts";
import type { Source, SourceRevision } from "../types.ts";

const COLS =
  "id, url, title, content, content_type, notebook, retracted_at, retracted_by, " +
  "retraction_committed_at, created_at, updated_at";

export async function getSource(id: string): Promise<Source | null> {
  const rows = await query<Source>(`SELECT ${COLS} FROM public.sources WHERE id = $1`, [id]);
  return rows[0] ?? null;
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
    `SELECT revision, title, edited_at, edited_by, length(content) AS content_len
       FROM public.source_revisions WHERE source_id = $1 ORDER BY revision DESC`,
    [id],
  );
}

// Update IN PLACE, never replace (D-D): snapshot the prior head into
// source_revisions, then update sources.content/title. `source_id` is stable, so
// thread_sources / source_entities / search stay valid. Re-embed is automatic
// via the fingerprint-gated queue trigger; a metadata/title-only edit (content
// unchanged) leaves the content fingerprint untouched. ONE transaction (G8).
export async function updateSource(
  id: string,
  content: string | null,
  title: string | null,
  editedBy = "operator",
): Promise<{ source: Source; revision: number } | null> {
  return await withTransaction(async (c) => {
    const exists = await c.queryObject<{ id: string }>(
      `SELECT id FROM public.sources WHERE id = $1`,
      [id],
    );
    if (exists.rows.length === 0) return null;
    const next = (await c.queryObject<{ n: number }>(
      `SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM public.source_revisions WHERE source_id = $1`,
      [id],
    )).rows[0].n;
    // Snapshot the CURRENT head as the prior revision.
    await c.queryObject(
      `INSERT INTO public.source_revisions (source_id, revision, content, title, edited_by)
       SELECT id, $2, content, title, $3 FROM public.sources WHERE id = $1`,
      [id, next, editedBy],
    );
    const upd = await c.queryObject<Source>(
      `UPDATE public.sources
          SET content = COALESCE($2, content), title = COALESCE($3, title)
        WHERE id = $1
        RETURNING ${COLS}`,
      [id, content, title],
    );
    return { source: upd.rows[0], revision: next };
  });
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
export async function refetch(id: string): Promise<{ source: Source; revision: number } | null> {
  const src = await getSource(id);
  if (!src) return null;
  if (!src.url) throw new Error("source has no URL to re-fetch");
  const r = await fetch(src.url, { redirect: "follow" });
  if (!r.ok) throw new Error(`re-fetch HTTP ${r.status}`);
  const text = await r.text();
  return await updateSource(id, text, null, "refetch");
}
