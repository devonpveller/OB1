// The idea writes of the workspace (research-workbench rw-p8a4-ideas, D17 items 5-6). Every one is a call of an
// owner-checked SQL function (init-idea-functions.sql, slot 370) - the SAME functions openbrain-mcp's
// update_idea / research_idea / promote_idea call - with the identity seam's subject as the owner, never a
// caller-supplied user. Nothing here writes `ideas` or `idea_revisions` itself: the database refuses an app
// role that tries (trg_ideas_write_guard).
//   edit          idea_edit(idea, subject, actor, summary, title, embedding, thought) - the revision's corpus thought is this
//                 door's (as update_idea's), in the same transaction; the memory plane reads a revision by its thought
//   research now  idea_research(idea, subject, actor)
//   promote       idea_promote(idea, subject, actor, path) - documents/seed.ts calls it after the seed
//   draft         the accreting draft, a field on the idea's ONE room (workspace_rooms.draft, slot 340)
//   engage        refinery_engage(refinery, subject, kind, ref) - a member engaged from inside the refinery
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
  // The revision's corpus thought, written by THIS door in the same transaction (kept only when the edit changed
  // something) - exactly as openbrain-mcp's update_idea writes one. Without it the revision cannot be read back: the
  // memory-plane policy (slot 200) shows an app role only revisions whose thought it can see (thought_id IS NOT NULL).
  return refuse(await db.tx(async (t) => {
    const th = (await t.query<{ id: string }>(
      `INSERT INTO public.thoughts (content, embedding, metadata, exposure)
       VALUES ($1, $2::vector, $3::jsonb, $4::text) RETURNING id::text AS id`,
      [input.summary, vec, JSON.stringify({ type: "idea", source: "workspace", kind: "idea", idea_id: id, exposure: CORPUS_EXPOSURE }), CORPUS_EXPOSURE],
    ))[0].id;
    const o = await fn(t, `SELECT public.idea_edit($1::uuid, $2, $3, $4, $5, $6, $7::bigint) AS o`,
      [id, who.sub, who.actor, input.summary, input.title, vec, th]);
    if (o.outcome !== "changed") throw new Unchanged(o); // the thought goes with an edit that did not happen
    return o;
  }).catch((e) => {
    if (e instanceof Unchanged) return e.o;
    throw e;
  }));
}

// the corpus plane an idea's thought lands on: the door constant openbrain-mcp uses for the same rows (CORPUS_EXPOSURE)
export const CORPUS_EXPOSURE = "ops";
class Unchanged extends Error {
  constructor(readonly o: Outcome) { super("unchanged"); }
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
