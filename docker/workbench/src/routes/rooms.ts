// /workbench/rooms - the research room and its scoped chat (research-workbench rw-p8a3-room, D2 / D17
// item 3; operator 2026-11-01: chat IS the room). One per-user room store (init-rooms.sql, slot 340):
//
//   GET    /workbench/rooms                the caller's rooms, newest first
//   POST   /workbench/rooms                {subject_kind: idea|session, subject_id} - the caller's room on it,
//                                         created on first ask (201) or the one already there (200)
//   GET    /workbench/rooms/:id            the room: its subject (a session's card - origin badge and the
//                                         link back to its inlet, e.g. the Mattermost thread), its chat
//                                         scope, its draft, whether chat is on, and the transcript
//   PUT    /workbench/rooms/:id/scope      {enabled, sources[]} - the chat scope (enabled + empty = nothing)
//   POST   /workbench/rooms/:id/chat       {text} - a scoped chat message: the question and the model's
//                                         answer become two room entries, written together. Chat OFF
//                                         (blank 'workbench-chat' key, as shipped): 503 with ONE fixed
//                                         message and nothing written.
//
// Every route acts for the identity seam's subject (identityOf); another user's room is 404. The room is
// the record: nothing here reads from or posts to Mattermost (a thread that started a session is the
// session's inlet, shown as the card's link back).
import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../contracts/db.ts";
import { identityOf, type Identity } from "../middleware/identity.ts";
import { card } from "../sessions/repo.ts";
import { owuiBase } from "../sessions/cards.ts";
import { CHAT_OFF, CHAT_REFUSED, type ChatConfig, chatCall, chatConfigFromEnv, ChatRefused, type Fetch } from "../rooms/chat.ts";
import { contextFor, refineryOf } from "../rooms/context.ts";
import * as rooms from "../rooms/repo.ts";

export interface RoomsDeps {
  db: Db;
  embed: (t: string) => Promise<number[]>;
  chat?: () => ChatConfig; // read per request (tests); production: the environment
  fetch?: Fetch;
}

const CONTEXT_UNAVAILABLE = "the room's context could not be read";

async function body(c: Context): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : {};
}

function fail(c: Context, e: unknown) {
  if (e instanceof rooms.RoomError) return c.json({ error: e.message }, e.status);
  if (e instanceof ChatRefused) return c.json({ error: e.message, code: e.code }, e.status);
  console.error("[rooms] error:", String((e as Error)?.message ?? e));
  return c.json({ error: "internal" }, 500);
}

const wrap = (fn: (c: Context, who: Identity) => Promise<Response>) => async (c: Context) => {
  try {
    return await fn(c, await identityOf(c));
  } catch (e) {
    return fail(c, e);
  }
};

function shapeRoom(r: rooms.RoomRow) {
  return {
    id: r.id, subject: { kind: r.subject_kind, id: r.subject_id },
    scope: { enabled: r.scope_enabled, sources: r.scope_sources },
    draft: r.draft, draft_updated_at: r.draft_updated_at, created_at: r.created_at, updated_at: r.updated_at,
  };
}

// What the room is about, as the caller may see it: an idea's title and state (the caller's own idea); a
// session's card (sessions are shared; its inlet and link back are answered to its owner only).
async function subjectOf(db: Db, r: rooms.RoomRow, who: Identity) {
  if (r.subject_kind === "idea") {
    const i = (await db.query<{ title: string; status: string }>(
      `SELECT title, status FROM public.ideas WHERE id = $1::uuid AND owner_sub = $2`, [r.subject_id, who.sub],
    ))[0];
    return i ? { kind: "idea", id: r.subject_id, title: i.title, status: i.status } : { kind: "idea", id: r.subject_id, title: "", status: "gone" };
  }
  const l = await card(db, r.subject_id, who, owuiBase());
  if (!l) return { kind: "session", id: r.subject_id, card: null };
  const { id, status, origin, badge, link, query } = l.card as unknown as Record<string, unknown>;
  return { kind: "session", id: r.subject_id, card: { id, status, origin, badge, link, query } };
}

export function roomsRouter(deps: RoomsDeps) {
  const { db } = deps;
  const chatCfg = deps.chat ?? (() => chatConfigFromEnv());
  const r = new Hono();

  r.get("/", wrap(async (c, who) => c.json({ rooms: (await rooms.listRooms(db, who)).map(shapeRoom) })));

  r.post("/", wrap(async (c, who) => {
    const out = await rooms.openRoom(db, rooms.parseSubject(await body(c)), who);
    return c.json({ room: shapeRoom(out.room), created: out.created }, out.created ? 201 : 200);
  }));

  r.get("/:id", wrap(async (c, who) => {
    const room = await rooms.roomOf(db, c.req.param("id") ?? "", who);
    const cfg = chatCfg();
    return c.json({
      room: shapeRoom(room),
      subject: await subjectOf(db, room, who),
      chat: { state: cfg.state },
      entries: await rooms.entries(db, room.id, who),
    });
  }));

  r.put("/:id/scope", wrap(async (c, who) => {
    const scope = rooms.parseScope(await body(c));
    return c.json({ room: shapeRoom(await rooms.setScope(db, c.req.param("id") ?? "", scope, who)) });
  }));

  r.post("/:id/chat", wrap(async (c, who) => {
    const room = await rooms.roomOf(db, c.req.param("id") ?? "", who);
    const question = rooms.parseQuestion(await body(c));
    const cfg = chatCfg();
    // chat off (as shipped) or misconfigured: the fixed refusal, before anything is read or written
    if (cfg.state === "off") return c.json({ error: CHAT_OFF, code: "chat-off" }, 503);
    if (cfg.state === "refused") return c.json({ error: CHAT_REFUSED, code: cfg.code }, 503);
    const scope = { enabled: room.scope_enabled, sources: room.scope_sources };
    let ctx;
    try {
      ctx = await contextFor(db, deps.embed, question, scope, refineryOf(room));
    } catch (e) {
      console.error("[rooms] context:", String((e as Error)?.message ?? e).slice(0, 200));
      return c.json({ error: CONTEXT_UNAVAILABLE, code: "chat-context-unavailable" }, 502);
    }
    const answer = await chatCall(cfg, await rooms.history(db, room.id, who), question, ctx, deps.fetch);
    const written = await rooms.appendExchange(db, room.id, who, question, answer, ctx, {
      scope: scope.enabled ? "listed" : "all", refinery: refineryOf(room) !== null, passages: ctx.length,
    });
    return c.json({ entries: written }, 201);
  }));

  return r;
}
