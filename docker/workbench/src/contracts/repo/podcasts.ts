// Podcasts (research-workbench P7a): reads and writes of the presenter model and render requests,
// every one filtered by the identity seam's subject (`sub`). A request's requester is the caller's
// subject_sub and nothing in a body can name another; another user's request, team or presenter
// is "not found", never "forbidden" (it does not exist for the caller).
import type { Db } from "../db.ts";
import { Conflict, NotFound } from "./lifecycle.ts";

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
  // rw-p8a4-ideas (D17 item 6): a podcast engaged from inside an idea refinery is recorded as its member
  refinery_id?: string;
}

export async function createRequest(db: Db, who: { sub: string; actor: string }, b: RequestIn) {
  const team = await db.query<{ id: string }>(`SELECT id FROM public.podcast_teams WHERE id = $1 AND owner_sub = $2`, [b.team_id, who.sub]);
  if (!team.length) throw new NotFound("no such team");
  const members = new Set((await db.query<{ presenter_id: string }>(
    `SELECT presenter_id FROM public.podcast_team_members WHERE team_id = $1`, [b.team_id],
  )).map((m) => m.presenter_id));
  const stray = b.transcript.turns.find((t) => !members.has(t.presenterId));
  if (stray) throw new NotFound("a turn names a presenter who is not in the team");
  return await db.tx(async (t) => {
    const rows = await t.query<Record<string, unknown>>(
      `INSERT INTO public.podcast_render_requests AS r (requester_sub, actor_sub, team_id, title, input)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING ${REQUEST_COLS}`,
      [who.sub, who.actor, b.team_id, b.title, JSON.stringify({ transcript: b.transcript })],
    );
    if (b.refinery_id) {
      // the owner-checked engagement (slot 370): another user's refinery is none; a resting one records nothing
      const o = (await t.query<{ o: { outcome: string } }>(
        `SELECT public.refinery_engage($1::uuid, $2, 'podcast_request', $3) AS o`, [b.refinery_id, who.sub, String(rows[0].id)],
      ))[0].o;
      if (o.outcome === "not_found") throw new NotFound("no such refinery");
      if (o.outcome !== "engaged") throw new Conflict("this refinery is archived: reopen it from its document first");
    }
    return rows[0];
  });
}

// rwr-podcast-audio-api: the row an episode's audio is served from. Visible to the caller exactly
// as podcasts() lists it - the caller's own render, or one shared with everyone (when the caller
// may hear shared ones) - and nothing else: another user's unshared episode and an id that is no
// row both come back null, so the route answers them the same way. The id is the only input; the
// archive directory comes from the row, never from the request.
export async function episodeAudio(db: Db, sub: string, id: string, shared: boolean) {
  const rows = await db.query<{ id: string; archive_dir: string; audio_format: string; shared: boolean }>(
    `SELECT e.id::text AS id, e.archive_dir, e.audio_format, e.shared
       FROM public.podcast_episodes e
      WHERE e.id = $1::uuid AND e.origin = 'render' AND (e.owner_sub = $2 OR ($3::boolean AND e.shared))`,
    [id, sub, shared],
  );
  return rows[0] ?? null;
}

// rwr-podcast-audio-api: retry a failed render request - the requester's own only. ONE conditional
// UPDATE moves failed -> queued, so two retries racing move it once and the second is refused (the
// row is then queued, not failed). Another user's request and an id that is no row are the same
// NotFound; the requester's own request in another state is a Conflict naming its state (the
// requester can see that state in their own list anyway).
export const NO_SUCH_REQUEST = "no such request";

export async function retryRequest(db: Db, sub: string, id: string) {
  const moved = await db.query<Record<string, unknown>>(
    `UPDATE public.podcast_render_requests AS r SET state = 'queued', error = NULL, updated_at = now()
      WHERE r.id = $1::uuid AND r.requester_sub = $2 AND r.state = 'failed'
      RETURNING ${REQUEST_COLS}`,
    [id, sub],
  );
  if (moved.length) return moved[0];
  const mine = await db.query<{ state: string }>(
    `SELECT r.state FROM public.podcast_render_requests r WHERE r.id = $1::uuid AND r.requester_sub = $2`, [id, sub],
  );
  if (!mine.length) throw new NotFound(NO_SUCH_REQUEST);
  throw new Conflict(`only a failed request can be retried: this one is ${mine[0].state}`, { state: mine[0].state });
}
