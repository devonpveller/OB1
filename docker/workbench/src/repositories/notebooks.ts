// Notebook (threads) repository (P2). "Notebook" is the user-facing noun; the
// table stays `threads`/`thread_sources`. Slug is generated ONCE at create via
// the shared canonical module, de-collided on the UNIQUE violation, and NEVER
// recomputed (rename touches name only) — the G6 pinned-slug contract.
import { query } from "../db/pool.ts";
import { isUniqueViolation } from "../db/errors.ts";
// @ts-ignore — plain .mjs from the /recipes bind-mount (no .d.ts); JS-typed.
import { slugifyNotebook } from "@shared/slug";
import type { Notebook } from "../types.ts";

const NB_COLS =
  "id, name, description, status, slug, created_at, updated_at";

export async function listNotebooks(): Promise<Notebook[]> {
  return await query<Notebook>(
    `SELECT ${NB_COLS} FROM public.threads WHERE status = 'active' ORDER BY name`,
  );
}

export async function getNotebook(id: string): Promise<Notebook | null> {
  const rows = await query<Notebook>(
    `SELECT ${NB_COLS} FROM public.threads WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// Create a notebook, pinning a unique slug. The slug is the canonical
// slugifyNotebook(name); on a UNIQUE(slug) collision we append -1, -2, …
// (mirrors resolveOutputPath). Each attempt is its own statement so a unique
// violation never poisons a surrounding transaction.
export async function createNotebook(
  name: string,
  description: string | null,
): Promise<Notebook> {
  const base: string = slugifyNotebook(name);
  for (let i = 0; i < 1000; i++) {
    const slug = i === 0 ? base : `${base}-${i}`;
    try {
      const rows = await query<Notebook>(
        `INSERT INTO public.threads (name, description, slug, status)
         VALUES ($1, $2, $3, 'active')
         RETURNING ${NB_COLS}`,
        [name, description, slug],
      );
      return rows[0];
    } catch (e) {
      if (isUniqueViolation(e)) continue; // slug taken — try the next suffix
      throw e;
    }
  }
  throw new Error(`could not allocate a unique slug for notebook "${name}"`);
}

// Rename / re-describe. The slug is IMMUTABLE (G6) — only name/description
// change; the hub page emits `aliases: [name]` so old links keep resolving.
export async function updateNotebook(
  id: string,
  name: string | null,
  description: string | null,
): Promise<Notebook | null> {
  const rows = await query<Notebook>(
    `UPDATE public.threads
        SET name = COALESCE($2, name),
            description = COALESCE($3, description)
      WHERE id = $1
      RETURNING ${NB_COLS}`,
    [id, name, description],
  );
  return rows[0] ?? null;
}

// Link a source into a notebook (additive upsert via the lifecycle RPC).
export async function linkSource(
  threadId: string,
  sourceId: string,
  linkType = "deliberate",
  reason: string | null = null,
): Promise<unknown> {
  const rows = await query(
    `SELECT * FROM public.link_source_to_thread($1, $2, $3, $4, 'confirmed')`,
    [threadId, sourceId, linkType, reason],
  );
  return rows[0];
}

// Soft status flip (unlink = hidden, triage accept = confirmed, hide = hidden).
// A hidden/inactive row also SUPPRESSES re-suggestion: the suggestion worker's
// upsert is `ON CONFLICT (thread_id, source_id) DO NOTHING`, so any existing
// row (in any status) blocks a re-propose — no extra guard needed (2.5).
export async function setStatus(
  threadId: string,
  sourceId: string,
  status: "confirmed" | "pending" | "hidden" | "inactive",
): Promise<unknown> {
  const rows = await query(
    `SELECT * FROM public.set_thread_source_status($1, $2, $3)`,
    [threadId, sourceId, status],
  );
  return rows[0];
}

// Confirmed sources on a notebook (committed-retracted excluded — P4 4.5).
export async function listNotebookSources(threadId: string): Promise<unknown[]> {
  return await query(
    `SELECT s.id, s.title, s.url, s.content_type, ts.link_type, ts.status
       FROM public.thread_sources ts
       JOIN public.sources s ON s.id = ts.source_id
      WHERE ts.thread_id = $1
        AND ts.status = 'confirmed'
        AND s.retraction_committed_at IS NULL
      ORDER BY s.title`,
    [threadId],
  );
}

// Pending cross-notebook suggestions for the triage strip.
export async function listSuggestions(threadId: string): Promise<unknown[]> {
  return await query(
    `SELECT s.id, s.title, s.url, ts.suggestion_reason
       FROM public.thread_sources ts
       JOIN public.sources s ON s.id = ts.source_id
      WHERE ts.thread_id = $1
        AND ts.status = 'pending'
        AND s.retraction_committed_at IS NULL
      ORDER BY ts.created_at DESC`,
    [threadId],
  );
}
