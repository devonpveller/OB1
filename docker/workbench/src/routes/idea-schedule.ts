// research-workbench rw-idea-schedule: the per-user "when does research on my ideas start" setting and
// "research now". Thin over the database functions of init-idea-schedule.sql. Every read and write is
// for the caller's subject (the identity seam); one user's setting is never readable through here by
// another, and research-now refuses an idea that is not the caller's.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../contracts/db.ts";
import { identityOf } from "../middleware/identity.ts";

export interface ScheduleInput {
  mode: "immediate" | "daily" | "weekly";
  at_time: string | null; // HH:MM
  weekday: number | null; // ISO 1..7
  tz: string;
}

// Pure validation of the PUT body; returns the normalised input or a message.
export function parseSchedule(b: unknown): ScheduleInput | string {
  const o = (b ?? {}) as Record<string, unknown>;
  const mode = o.mode;
  if (mode !== "immediate" && mode !== "daily" && mode !== "weekly") return "mode must be immediate, daily or weekly";
  const tz = typeof o.tz === "string" && o.tz.trim() ? o.tz.trim() : "UTC";
  if (mode === "immediate") return { mode, at_time: null, weekday: null, tz };
  const t = typeof o.at_time === "string" ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(o.at_time.trim()) : null;
  if (!t) return "at_time must be HH:MM (24-hour)";
  let weekday: number | null = null;
  if (mode === "weekly") {
    weekday = Number(o.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return "weekday must be 1 (Monday) to 7 (Sunday)";
  }
  return { mode, at_time: `${t[1]}:${t[2]}`, weekday, tz };
}

async function read(db: Db, sub: string) {
  const rows = await db.query<{ mode: string; at_time: string | null; weekday: number | null; tz: string; next_start: string | null }>(
    `SELECT mode, to_char(at_time, 'HH24:MI') AS at_time, weekday, tz,
            public.idea_schedule_next(owner_sub, now())::text AS next_start
       FROM public.idea_schedule WHERE owner_sub = $1`,
    [sub],
  );
  return rows[0] ?? { mode: "immediate", at_time: null, weekday: null, tz: "UTC", next_start: null };
}

export function ideaScheduleRouter(db: Db) {
  const r = new Hono();
  r.get("/", async (c: Context) => c.json(await read(db, (await identityOf(c)).sub)));
  r.put("/", async (c: Context) => {
    const who = await identityOf(c);
    const p = parseSchedule(await c.req.json().catch(() => null));
    if (typeof p === "string") return c.json({ error: p }, 400);
    try {
      await db.query(`SELECT public.idea_schedule_set($1, $2, $3, $4::time, $5, $6)`, [who.sub, who.actor, p.mode, p.at_time, p.weekday, p.tz]);
    } catch (e) {
      if (/unknown time zone/.test((e as Error).message)) return c.json({ error: `unknown time zone ${p.tz}` }, 400);
      throw e;
    }
    return c.json(await read(db, who.sub));
  });
  // research now: queues at once in every mode; only the caller's own idea
  r.post("/research-now/:id", async (c: Context) => {
    const who = await identityOf(c);
    const id = c.req.param("id") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: "not an idea id" }, 400);
    const own = await db.query<{ id: string }>(`SELECT id::text FROM public.ideas WHERE id = $1 AND owner_sub = $2`, [id, who.sub]);
    if (!own.length) return c.json({ error: "no idea with this id" }, 404);
    const job = await db.query<{ job: string | null }>(`SELECT public.idea_research_now($1)::text AS job`, [id]);
    if (!job[0]?.job) return c.json({ error: "the idea is archived" }, 409);
    return c.json({ queued: true, job_id: job[0].job });
  });
  return r;
}
