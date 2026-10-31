// Podcasts (research-workbench P7a): reads and writes of the presenter model and render requests,
// every one filtered by the identity seam's subject (`sub`). A request's requester is the caller's
// subject_sub and nothing in a body can name another; another user's request, team or presenter
// is "not found", never "forbidden" (it does not exist for the caller).
import type { Db } from "../db.ts";
import { NotFound } from "./lifecycle.ts";

export async function presenters(db: Db, sub: string) {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT p.id, p.name, p.personality, p.backstory, p.language, p.origin,
            json_build_object('id', v.id, 'route', v.route, 'voice', v.voice, 'speed', v.speed) AS voice
       FROM public.podcast_presenters p JOIN public.podcast_voice_links v ON v.id = p.voice_link_id
      WHERE p.owner_sub = $1 AND v.owner_sub = $1
      ORDER BY p.name, p.id`, [sub],
  );
  return { presenters: rows };
}

export async function teams(db: Db, sub: string) {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT t.id, t.name, t.description, t.origin,
            COALESCE((SELECT json_agg(json_build_object('position', m.position, 'presenter_id', m.presenter_id, 'name', p.name) ORDER BY m.position)
                        FROM public.podcast_team_members m JOIN public.podcast_presenters p ON p.id = m.presenter_id AND p.owner_sub = $1
                       WHERE m.team_id = t.id), '[]'::json) AS presenters,
            COALESCE((SELECT json_agg(json_build_object('id', f.id, 'name', f.name, 'segments', f.segments, 'language', f.language, 'script_route', f.script_route) ORDER BY f.name)
                        FROM public.podcast_formats f WHERE f.team_id = t.id AND f.owner_sub = $1), '[]'::json) AS formats
       FROM public.podcast_teams t WHERE t.owner_sub = $1 ORDER BY t.name`, [sub],
  );
  return { teams: rows };
}

// The library's source (P7b lists it): the caller's own renders and renders shared with everyone.
// Rows exist only for renders of the new system (origin 'render'); Open Notebook's archived
// episodes are files in the archive folder and never rows, so they cannot appear here.
export async function podcasts(db: Db, sub: string, limit: number) {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT e.id, e.title, CASE WHEN e.owner_sub = $1 THEN e.team_id END AS team_id, e.audio_format, e.seconds, e.shared,
            (e.owner_sub = $1) AS mine, e.created_at
       FROM public.podcast_episodes e
      WHERE e.origin = 'render' AND (e.owner_sub = $1 OR e.shared)
      ORDER BY e.created_at DESC LIMIT $2`, [sub, limit],
  );
  return { podcasts: rows };
}

const REQUEST_COLS = `r.id, r.team_id, r.title, r.state, r.episode_id::text AS episode_id, r.error,
  jsonb_array_length(r.input->'transcript'->'turns') AS turns, r.created_at, r.updated_at`;

export async function requests(db: Db, sub: string, limit: number) {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${REQUEST_COLS} FROM public.podcast_render_requests r WHERE r.requester_sub = $1 ORDER BY r.created_at DESC LIMIT $2`,
    [sub, limit],
  );
  return { requests: rows };
}

export interface RequestIn {
  team_id: string;
  title: string;
  transcript: { title: string; turns: { presenterId: string; text: string }[] };
}

export async function createRequest(db: Db, who: { sub: string; actor: string }, b: RequestIn) {
  const team = await db.query<{ id: string }>(`SELECT id FROM public.podcast_teams WHERE id = $1 AND owner_sub = $2`, [b.team_id, who.sub]);
  if (!team.length) throw new NotFound("no such team");
  const members = new Set((await db.query<{ presenter_id: string }>(
    `SELECT presenter_id FROM public.podcast_team_members WHERE team_id = $1`, [b.team_id],
  )).map((m) => m.presenter_id));
  const stray = b.transcript.turns.find((t) => !members.has(t.presenterId));
  if (stray) throw new NotFound("a turn names a presenter who is not in the team");
  const rows = await db.query<Record<string, unknown>>(
    `INSERT INTO public.podcast_render_requests AS r (requester_sub, actor_sub, team_id, title, input)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING ${REQUEST_COLS}`,
    [who.sub, who.actor, b.team_id, b.title, JSON.stringify({ transcript: b.transcript })],
  );
  return rows[0];
}
