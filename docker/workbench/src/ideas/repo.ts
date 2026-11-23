// The idea writes of the workspace (research-workbench rw-p8a4-ideas, D17 items 5-6). Every one is a call of an
// owner-checked SQL function (init-idea-functions.sql, slot 370) - the SAME functions openbrain-mcp's
// update_idea / research_idea / promote_idea call - with the identity seam's subject as the owner, never a
// caller-supplied user. Nothing here writes `ideas` or `idea_revisions` itself: the database refuses an app
// role that tries (trg_ideas_write_guard).
//   edit          idea_edit(idea, subject, actor, summary, title, embedding, NULL) - a PRIVATE revision, no corpus thought
//                 (operator 2026-11-02: ideas are completely user isolated)
//   research now  idea_research(idea, subject, actor)
//   promote       idea_promote(idea, subject, actor, path) - documents/seed.ts calls it after the seed
//   draft         the accreting draft, a field on the idea's ONE room (workspace_rooms.draft, slot 340)
//   engage        refinery_engage(refinery, subject, kind, ref) - a member engaged from inside the refinery
//   capture       idea_capture(subject, actor, title, summary, NULL, embedding) - the SAME write capture_idea makes (rwr-idea-
//                 capture-api): the idea and its PRIVATE revision 1, no corpus thought; the revision trigger (slot 300)
//                 queues research at once, or marks it deferred for an owner on a daily / weekly schedule
import type { Db } from "../contracts/db.ts";
import type { Identity } from "../middleware/identity.ts";

export class IdeaError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502, msg: string, readonly detail: Record<string, unknown> = {}) { super(msg); }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_SUMMARY = 20000;
export const MAX_TITLE = 120;
export const MAX_DRAFT = 100000;
export const NOT_FOUND = "no idea with this id";
export const ARCHIVED = "this idea's refinery is archived: reopen it from its document first";

export interface Outcome {
  outcome: "changed" | "unchanged" | "queued" | "promoted" | "engaged" | "not_found" | "archived" | "no_document" | "already" | "delivered";
  [k: string]: unknown;
}

export function ideaId(raw: string | undefined): string {
  const id = (raw ?? "").trim();
  if (!UUID_RE.test(id)) throw new IdeaError(404, NOT_FOUND); // an id that cannot exist reads like one that does not
  return id.toLowerCase();
}

export function parseEdit(b: Record<string, unknown>): { summary: string; title: string | null } {
  const summary = typeof b.summary === "string" ? b.summary.trim() : "";
  if (!summary) throw new IdeaError(400, "summary is the idea's new text");
  if (summary.length > MAX_SUMMARY) throw new IdeaError(400, `an idea is at most ${MAX_SUMMARY} characters`);
  if (b.title !== undefined && b.title !== null && typeof b.title !== "string") throw new IdeaError(400, "title is text");
  const title = typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, MAX_TITLE) : null;
  return { summary, title };
}

// rwr-idea-capture-api: the capture's body - the idea's text and an optional title, the same limits as an edit. The
// contract route refuses any other field (an owner, a user, a domain) before this runs.
export function parseCapture(b: Record<string, unknown>): { summary: string; title: string | null } {
  if (b.summary !== undefined && typeof b.summary !== "string") throw new IdeaError(400, "summary is the idea's text");
  return parseEdit(b);
}

export function parseDraft(b: Record<string, unknown>): string {
  if (typeof b.text !== "string") throw new IdeaError(400, "text is the draft");
  if (b.text.length > MAX_DRAFT) throw new IdeaError(400, `a draft is at most ${MAX_DRAFT} characters`);
  return b.text;
}

// the refusal every write answers the same way (another user's idea = no idea; an archived refinery rests)
export function refuse(o: Outcome): Outcome {
  if (o.outcome === "not_found") throw new IdeaError(404, NOT_FOUND);
  if (o.outcome === "archived") throw new IdeaError(409, ARCHIVED, { code: "refinery-archived" });
  return o;
}

async function fn(db: Db, sql: string, args: unknown[]): Promise<Outcome> {
  return (await db.query<{ o: Outcome }>(sql, args))[0].o;
}

export async function editIdea(
  db: Db, id: string, input: { summary: string; title: string | null }, who: Identity, embed: (t: string) => Promise<number[]>,
): Promise<Outcome> {
  const own = await db.query<{ title: string }>(`SELECT title FROM public.ideas WHERE id = $1::uuid AND owner_sub = $2`, [id, who.sub]);
  if (!own.length) throw new IdeaError(404, NOT_FOUND);
  // the embedding keeps dedup and resurfacing true to the new text; an embedder that is down keeps the old one
  let vec: string | null = null;
  try {
    vec = `[${(await embed(`${input.title ?? own[0].title}\n\n${input.summary}`)).join(",")}]`;
  } catch (e) {
    console.error("[ideas] embedding unavailable; the idea keeps its previous embedding:", String((e as Error)?.message ?? e).slice(0, 200));
  }
  // Operator decision 2026-11-02: ideas are completely user isolated - the revision carries NO corpus thought (the
  // shared thought corpus is searchable by other users' tools). idea_edit() writes it as a PRIVATE revision of its owner
  // (idea_revisions.private_owner), read through its own owner-established policy (slot 370), not through a thought.
  return refuse(await fn(db, `SELECT public.idea_edit($1::uuid, $2, $3, $4, $5, $6, NULL) AS o`,
    [id, who.sub, who.actor, input.summary, input.title, vec]));
}

export interface Captured {
  idea_id: string;
  title: string;
  status: string;
  research: { mode: string; queued: boolean; job_id: string | null; next_start: string | null };
}

// rwr-idea-capture-api: capture a new idea for the identity seam's subject (owner) and actor. Whether research starts now
// is the database's (the revision trigger reads the owner's idea_schedule row: none = immediate); this only reports what
// it did, read back for the same owner.
export async function captureIdea(
  db: Db, input: { summary: string; title: string | null }, who: Identity, embed: (t: string) => Promise<number[]>,
): Promise<Captured> {
  let vec: string | null = null;
  try {
    vec = `[${(await embed(`${input.title ?? ""}\n\n${input.summary}`.trim())).join(",")}]`;
  } catch (e) {
    console.error("[ideas] embedding unavailable; the idea is captured without one:", String((e as Error)?.message ?? e).slice(0, 200));
  }
  const id = (await db.query<{ id: string }>(
    `SELECT public.idea_capture($1, $2, $3, $4, $5, $6)::text AS id`, [who.sub, who.actor, input.title, input.summary, null, vec],
  ))[0].id;
  const row = (await db.query<{ title: string; status: string; job_id: string | null; deferred: boolean; handback: boolean }>(
    `SELECT i.title, i.status, r.research_job_id AS job_id, coalesce(r.metadata->>'deferred' = 'true', false) AS deferred,
            coalesce(r.metadata ? 'research_handback', false) AS handback
       FROM public.ideas i
       JOIN public.idea_revisions r ON r.idea_id = i.id AND r.revision = i.current_revision
      WHERE i.id = $1::uuid AND i.owner_sub = $2`, [id, who.sub],
  ))[0];
  if (!row) throw new Error("the captured idea did not read back for its owner");
  const sched = (await db.query<{ mode: string; next_start: string | null }>(
    `SELECT mode, to_json(public.idea_schedule_next(owner_sub, now())) #>> '{}' AS next_start
       FROM public.idea_schedule WHERE owner_sub = $1`,
    [who.sub],
  ))[0];
  const mode = sched?.mode ?? "immediate";
  // slot 580 (PD0b): queued = a private hand-back is pending for the request boundary (the job id is stamped later, by the drain)
  const queued = (row.job_id !== null || row.handback) && !row.deferred;
  return {
    idea_id: id, title: row.title, status: row.status,
    research: { mode, queued, job_id: queued ? row.job_id : null, next_start: queued ? null : (sched?.next_start ?? null) },
  };
}

export async function researchIdea(db: Db, id: string, who: Identity): Promise<Outcome> {
  return refuse(await fn(db, `SELECT public.idea_research($1::uuid, $2, $3) AS o`, [id, who.sub, who.actor]));
}

export async function promoteIdea(db: Db, id: string, path: string, who: Identity): Promise<Outcome> {
  return refuse(await fn(db, `SELECT public.idea_promote($1::uuid, $2, $3, $4) AS o`, [id, who.sub, who.actor, path]));
}

export async function engageRefinery(db: Db, id: string, kind: string, ref: string, who: Identity): Promise<Outcome> {
  return refuse(await fn(db, `SELECT public.refinery_engage($1::uuid, $2, $3, $4) AS o`, [id, who.sub, kind, ref]));
}

// The accreting draft: the idea's ONE room carries it (the room is created under the idea's owner, idea_room()).
export async function setDraft(db: Db, id: string, text: string, who: Identity) {
  const own = await db.query<{ status: string }>(`SELECT status FROM public.ideas WHERE id = $1::uuid AND owner_sub = $2`, [id, who.sub]);
  if (!own.length) throw new IdeaError(404, NOT_FOUND);
  // round 2 (tester A6): a resting refinery takes no write - its draft too (D17 archive)
  if (own[0].status === "archived") throw new IdeaError(409, ARCHIVED, { code: "refinery-archived" });
  const room = (await db.query<{ r: string | null }>(`SELECT public.idea_room($1::uuid)::text AS r`, [id]))[0]?.r;
  if (!room) throw new IdeaError(404, NOT_FOUND);
  const rows = await db.query<{ id: string; draft_updated_at: string }>(
    `UPDATE public.workspace_rooms SET draft = $3, draft_updated_at = now(), actor_sub = $4, updated_at = now()
      WHERE id = $1::uuid AND owner_sub = $2 RETURNING id::text AS id, draft_updated_at`,
    [room, who.sub, text, who.actor],
  );
  if (!rows.length) throw new IdeaError(404, NOT_FOUND);
  return { idea_id: id, room_id: rows[0].id, draft: { text, updated_at: rows[0].draft_updated_at } };
}

// Is this idea's refinery archived (and the caller's)? null = not the caller's idea.
export async function archivedState(db: Db, id: string, owner: string): Promise<boolean | null> {
  const r = await db.query<{ status: string }>(`SELECT status FROM public.ideas WHERE id = $1::uuid AND owner_sub = $2`, [id, owner]);
  return r.length ? r[0].status === "archived" : null;
}

// rwr-idea-archive-api: archive and reopen an idea by its own id (a captured idea has no document, so the document-path
// routes of documents/refinery.ts cannot reach it). The SAME writes as archiveRefinery / reopenRefinery - the
// refinery_state archived_at / archived_from stamp and ideas.status - keyed on ideas.id and the seam's subject. An idea
// that is not the caller's answers exactly like one that does not exist (404, the one NOT_FOUND body). The idea row is
// locked, so two requests cannot both archive it (archived_from would then record "archived").
export const ALREADY_ARCHIVED = "this idea is already archived";
export const NOT_ARCHIVED = "this idea is not archived";
export const CANNOT_REOPEN = "this idea cannot be reopened: the document it was promoted to is no longer its own";

export interface ArchiveState { idea_id: string; status: string; archived: boolean }

export async function archiveIdea(db: Db, id: string, who: Identity): Promise<ArchiveState> {
  return await db.tx(async (t) => {
    const own = await t.query<{ status: string }>(
      `SELECT status FROM public.ideas WHERE id = $1::uuid AND owner_sub = $2 FOR UPDATE`, [id, who.sub]);
    if (!own.length) throw new IdeaError(404, NOT_FOUND);
    if (own[0].status === "archived") throw new IdeaError(409, ALREADY_ARCHIVED, { code: "already-archived" });
    await t.query(
      `INSERT INTO public.refinery_state (refinery_id, archived_at, archived_from) VALUES ($1::uuid, now(), $2)
       ON CONFLICT (refinery_id) DO UPDATE SET archived_at = now(), archived_from = EXCLUDED.archived_from`,
      [id, own[0].status]);
    await t.query(`UPDATE public.ideas SET status = 'archived', updated_at = now() WHERE id = $1::uuid`, [id]);
    return { idea_id: id, status: "archived", archived: true };
  });
}

export async function reopenIdea(db: Db, id: string, who: Identity): Promise<ArchiveState> {
  try {
    return await db.tx(async (t) => {
      const own = await t.query<{ status: string; archived_from: string | null }>(
        `SELECT i.status, s.archived_from FROM public.ideas i
           LEFT JOIN public.refinery_state s ON s.refinery_id = i.id
          WHERE i.id = $1::uuid AND i.owner_sub = $2 FOR UPDATE OF i`, [id, who.sub]);
      if (!own.length) throw new IdeaError(404, NOT_FOUND);
      if (own[0].status !== "archived") throw new IdeaError(409, NOT_ARCHIVED, { code: "not-archived" });
      // the state the idea was archived from; "engaged" (as reopenRefinery) for an archive that left no stamp
      const was = own[0].archived_from && own[0].archived_from !== "archived" ? own[0].archived_from : "engaged";
      await t.query(`UPDATE public.refinery_state SET archived_at = NULL, archived_from = NULL WHERE refinery_id = $1::uuid`, [id]);
      await t.query(`UPDATE public.ideas SET status = $2, updated_at = now() WHERE id = $1::uuid`, [id, was]);
      return { idea_id: id, status: was, archived: false };
    });
  } catch (e) {
    // the write guard lets a promoted idea come back only while its document is still the refinery's
    if ((e as { fields?: { code?: string } })?.fields?.code === "42501") throw new IdeaError(409, CANNOT_REOPEN, { code: "cannot-reopen" });
    throw e;
  }
}
