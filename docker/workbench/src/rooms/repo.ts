// The room store's SQL half (rw-p8a3-room; tables in init-rooms.sql, slot 340). Every read and write is
// decided for the request's subject (subject_sub) where it is read: a room is the caller's when its
// owner_sub is the caller's subject, and anything else - another user's room, a room id that does not
// exist - is the same 404 (never an existence oracle). The subject a room is ABOUT:
//   idea     the caller's own idea (refinery) only: another user's idea is 404, like the idea routes
//   session  any research session (sessions are shared knowledge); each user keeps their own room on it,
//            and the session's private fields (its inlet) are read through the session card, which
//            answers them to the session's owner only (sessions/repo.ts card())
import type { Db } from "../contracts/db.ts";
import type { Identity } from "../middleware/identity.ts";
import type { ContextPassage } from "./chat.ts";

export class RoomError extends Error {
  constructor(readonly status: 400 | 404 | 409, msg: string) { super(msg); }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_QUESTION = 4000;
export const MAX_SCOPE = 200;
export const HISTORY_TURNS = 8;

export interface RoomRow {
  id: string;
  subject_kind: "idea" | "session";
  subject_id: string;
  scope_enabled: boolean;
  scope_sources: string[];
  draft: string;
  draft_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntryRow {
  id: string;
  seq: number;
  kind: "user" | "assistant" | "dossier";
  body: string;
  context: { source_id: string; chunk: number; held: boolean }[];
  meta: Record<string, unknown>;
  created_at: string;
  mine: boolean;
}

const ROOM_COLS = `r.id::text AS id, r.subject_kind, r.subject_id::text AS subject_id, r.scope_enabled,
  ARRAY(SELECT x::text FROM unnest(r.scope_sources) x) AS scope_sources, r.draft, r.draft_updated_at, r.created_at, r.updated_at`;

export function parseSubject(b: Record<string, unknown>): { kind: "idea" | "session"; id: string } {
  const kind = b.subject_kind;
  const id = typeof b.subject_id === "string" ? b.subject_id.trim() : "";
  if (kind !== "idea" && kind !== "session") throw new RoomError(400, "subject_kind is idea or session");
  if (!UUID_RE.test(id)) throw new RoomError(400, "subject_id is a uuid");
  return { kind, id: id.toLowerCase() };
}

export function parseScope(b: Record<string, unknown>): { enabled: boolean; sources: string[] } {
  if (typeof b.enabled !== "boolean") throw new RoomError(400, "enabled is true (only the listed sources) or false (the whole knowledge database)");
  const raw = b.sources ?? [];
  if (!Array.isArray(raw)) throw new RoomError(400, "sources is a list of source ids");
  if (raw.length > MAX_SCOPE) throw new RoomError(400, `at most ${MAX_SCOPE} sources in a chat scope`);
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== "string" || !UUID_RE.test(s)) throw new RoomError(400, "every source in a chat scope is a source id");
    if (!out.includes(s.toLowerCase())) out.push(s.toLowerCase());
  }
  return { enabled: b.enabled, sources: out };
}

export function parseQuestion(b: Record<string, unknown>): string {
  const t = typeof b.text === "string" ? b.text.trim() : "";
  if (!t) throw new RoomError(400, "text is the question");
  if (t.length > MAX_QUESTION) throw new RoomError(400, `a question is at most ${MAX_QUESTION} characters`);
  return t;
}

// The caller's room on a subject, created on first ask. 201 when it was made now.
export async function openRoom(db: Db, subject: { kind: "idea" | "session"; id: string }, who: Identity): Promise<{ room: RoomRow; created: boolean }> {
  if (subject.kind === "idea") {
    const own = await db.query<{ id: string }>(`SELECT id::text FROM public.ideas WHERE id = $1::uuid AND owner_sub = $2`, [subject.id, who.sub]);
    if (!own.length) throw new RoomError(404, "no such idea");
  } else {
    const job = await db.query<{ id: string }>(`SELECT id::text FROM public.research_jobs WHERE id = $1::uuid`, [subject.id]);
    if (!job.length) throw new RoomError(404, "no such session");
  }
  const made = await db.query<{ id: string }>(
    `INSERT INTO public.workspace_rooms (owner_sub, actor_sub, subject_kind, subject_id) VALUES ($1, $2, $3, $4::uuid)
     ON CONFLICT DO NOTHING RETURNING id::text AS id`,
    [who.sub, who.actor, subject.kind, subject.id],
  );
  const rows = await db.query<RoomRow>(
    `SELECT ${ROOM_COLS} FROM public.workspace_rooms r WHERE r.owner_sub = $1 AND r.subject_kind = $2 AND r.subject_id = $3::uuid`,
    [who.sub, subject.kind, subject.id],
  );
  // an idea's room belongs to the idea's owner: it is this caller's (checked above)
  if (!rows.length) throw new RoomError(409, "the room could not be opened");
  return { room: rows[0], created: made.length > 0 };
}

export async function roomOf(db: Db, id: string, who: Identity): Promise<RoomRow> {
  if (!UUID_RE.test(id)) throw new RoomError(404, "no such room");
  const rows = await db.query<RoomRow>(`SELECT ${ROOM_COLS} FROM public.workspace_rooms r WHERE r.id = $1::uuid AND r.owner_sub = $2`, [id, who.sub]);
  if (!rows.length) throw new RoomError(404, "no such room");
  return rows[0];
}

export async function listRooms(db: Db, who: Identity, limit = 100): Promise<RoomRow[]> {
  return await db.query<RoomRow>(
    `SELECT ${ROOM_COLS} FROM public.workspace_rooms r WHERE r.owner_sub = $1 ORDER BY r.updated_at DESC LIMIT $2`,
    [who.sub, Math.max(1, Math.min(limit, 500))],
  );
}

export async function entries(db: Db, roomId: string, who: Identity, limit = 500): Promise<EntryRow[]> {
  const rows = await db.query<EntryRow>(
    `SELECT e.id::text AS id, e.seq, e.kind, e.body, e.context, e.meta, e.created_at, (e.actor_sub = $3) AS mine
       FROM public.workspace_room_entries e JOIN public.workspace_rooms r ON r.id = e.room_id
      WHERE e.room_id = $1::uuid AND r.owner_sub = $2
      ORDER BY e.seq DESC LIMIT $4`,
    [roomId, who.sub, who.actor, Math.max(1, Math.min(limit, 2000))],
  );
  return rows.reverse().map((r) => ({ ...r, seq: Number(r.seq) }));
}

// The last turns of the chat, oldest first (dossiers are not chat turns).
export async function history(db: Db, roomId: string, who: Identity): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const rows = await db.query<{ kind: "user" | "assistant"; body: string }>(
    `SELECT e.kind, e.body FROM public.workspace_room_entries e JOIN public.workspace_rooms r ON r.id = e.room_id
      WHERE e.room_id = $1::uuid AND r.owner_sub = $2 AND e.kind IN ('user', 'assistant')
      ORDER BY e.seq DESC LIMIT $3`,
    [roomId, who.sub, HISTORY_TURNS],
  );
  return rows.reverse().map((r) => ({ role: r.kind, content: r.body.slice(0, 4000) }));
}

export async function setScope(db: Db, roomId: string, scope: { enabled: boolean; sources: string[] }, who: Identity): Promise<RoomRow> {
  const n = await db.query<{ id: string }>(
    `UPDATE public.workspace_rooms SET scope_enabled = $3, scope_sources = $4::uuid[], actor_sub = $5, updated_at = now()
      WHERE id = $1::uuid AND owner_sub = $2 RETURNING id::text AS id`,
    [roomId, who.sub, scope.enabled, scope.sources, who.actor],
  );
  if (!n.length) throw new RoomError(404, "no such room");
  return await roomOf(db, roomId, who);
}

// The question and its answer, written together (one transaction) - or nothing.
export async function appendExchange(
  db: Db, roomId: string, who: Identity, question: string, answer: string, ctx: ContextPassage[], meta: Record<string, unknown>,
): Promise<EntryRow[]> {
  const context = ctx.map((c) => ({ source_id: c.source_id, chunk: c.chunk, held: c.held }));
  await db.tx(async (t) => {
    const own = await t.query<{ id: string }>(`SELECT id::text FROM public.workspace_rooms WHERE id = $1::uuid AND owner_sub = $2 FOR UPDATE`, [roomId, who.sub]);
    if (!own.length) throw new RoomError(404, "no such room");
    await t.query(`INSERT INTO public.workspace_room_entries (room_id, actor_sub, kind, body) VALUES ($1::uuid, $2, 'user', $3)`, [roomId, who.actor, question]);
    await t.query(
      `INSERT INTO public.workspace_room_entries (room_id, actor_sub, kind, body, context, meta) VALUES ($1::uuid, $2, 'assistant', $3, $4::jsonb, $5::jsonb)`,
      [roomId, who.actor, answer, JSON.stringify(context), JSON.stringify(meta)],
    );
    await t.query(`UPDATE public.workspace_rooms SET updated_at = now() WHERE id = $1::uuid`, [roomId]);
  });
  return (await entries(db, roomId, who, 2));
}
