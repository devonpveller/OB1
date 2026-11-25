// Podcasts (research-workbench P7a): reads and writes of the presenter model and render requests,
// every one filtered by the identity seam's subject (`sub`). A request's requester is the caller's
// subject_sub and nothing in a body can name another; another user's request, team or presenter
// is "not found", never "forbidden" (it does not exist for the caller).
import type { Db } from "../db.ts";
import { Conflict, NotFound } from "./lifecycle.ts";
import type { Identity } from "../../middleware/identity.ts";
import { BadRequest } from "../logic/scope.ts";
import {
  type DisclosureItem, disclosureHash, disclosureText, type FromRef, item, itemsOf, kindEntry, parseFrom,
} from "../logic/episode_inputs.ts";
import { type ResolveDeps, resolveFrom } from "./episode_inputs.ts";

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
  COALESCE(jsonb_array_length(r.input->'transcript'->'turns'), 0) AS turns, r.created_at, r.updated_at`;

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
  // exactly one of these two: a room transcript (the original input), or the thing to make the episode from
  transcript?: { title: string; turns: { presenterId: string; text: string }[] };
  from?: FromRef;
  // rw-p8a4-ideas (D17 item 6): a podcast engaged from inside an idea refinery is recorded as its member
  refinery_id?: string;
}

export const NO_INPUT = "no such input";

export async function createRequest(db: Db, who: { sub: string; actor: string }, b: RequestIn, deps?: Omit<ResolveDeps, "db">) {
  if ((b.transcript === undefined) === (b.from === undefined)) throw new BadRequest("send either a transcript or from, not both and not neither");
  const team = await db.query<{ id: string }>(`SELECT id FROM public.podcast_teams WHERE id = $1 AND owner_sub = $2`, [b.team_id, who.sub]);
  if (!team.length) throw new NotFound("no such team");
  let input: Record<string, unknown>;
  if (b.from !== undefined) {
    const from = parseFrom(b.from);
    // registered, not usable yet: the same answer whatever the id (it looks nothing up)
    if (!kindEntry(from.kind)!.available) throw new Conflict("episodes from this kind are not available yet", { code: "kind-unavailable" });
    const m = await resolveFrom({ db, ...deps }, who as Identity, from);
    if (!m) throw new NotFound(NO_INPUT); // another user's, a missing one and an id that cannot exist: one answer
    input = { source: { kind: from.kind, id: from.id, title: b.title, text: m.text, items: m.items } };
  } else {
    const transcript = b.transcript!;
    const members = new Set((await db.query<{ presenter_id: string }>(
      `SELECT presenter_id FROM public.podcast_team_members WHERE team_id = $1`, [b.team_id],
    )).map((m) => m.presenter_id));
    const stray = transcript.turns.find((t) => !members.has(t.presenterId));
    if (stray) throw new NotFound("a turn names a presenter who is not in the team");
    input = { transcript };
  }
  return await db.tx(async (t) => {
    const rows = await t.query<Record<string, unknown>>(
      `INSERT INTO public.podcast_render_requests AS r (requester_sub, actor_sub, team_id, title, input)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING ${REQUEST_COLS}`,
      [who.sub, who.actor, b.team_id, b.title, JSON.stringify(input)],
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

// -- the share step (operator decision 2026-11-22) -----------------------------------------------------------------
// An episode starts private to its owner (shared = false: nothing in the renderer or here sets it otherwise). It is
// shared by ONE path: the owner is shown what would become visible (shareDisclosure), then confirms it (shareEpisode,
// sending back the fingerprint of the list they were shown). No background, bulk or automatic path calls this.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NO_EPISODE = "no such episode";

interface EpisodeRow { id: string; title: string; shared: boolean; request_id: string | null }

// The owner's own render, or NotFound: another user's, a missing one and an id that cannot exist are one answer.
async function ownEpisode(db: Db, sub: string, id: string): Promise<EpisodeRow> {
  if (!UUID.test(id)) throw new NotFound(NO_EPISODE);
  const row = (await db.query<EpisodeRow>(
    `SELECT id::text AS id, title, shared, request_id::text AS request_id FROM public.podcast_episodes
      WHERE id = $1::uuid AND owner_sub = $2 AND origin = 'render'`, [id, sub],
  ))[0];
  if (!row) throw new NotFound(NO_EPISODE);
  return row;
}

/** Every private or cloud-derived item that becomes visible to another user if this episode is shared. */
export async function disclosureItems(db: Db, sub: string, e: EpisodeRow): Promise<DisclosureItem[]> {
  const req = e.request_id
    ? (await db.query<{ input: unknown }>(`SELECT input FROM public.podcast_render_requests WHERE id = $1::uuid AND requester_sub = $2`, [e.request_id, sub]))[0]
    : undefined;
  const source = (req?.input as { source?: { kind?: string } } | undefined)?.source;
  const personal = source ? (kindEntry(String(source.kind))?.personal ?? true) : true; // a transcript or an unknown origin: the owner's own
  const out: DisclosureItem[] = [];
  // the episode itself: its audio and script are derived from what follows
  if (personal) out.push(item("episode", e.id, e.title));
  if (source) out.push(...itemsOf(req!.input));
  else if (req) out.push(item("transcript", e.request_id!, e.title)); // a room transcript: the owner's own prompting
  return out;
}

export async function sharePreview(db: Db, sub: string, id: string) {
  const e = await ownEpisode(db, sub, id);
  const items = await disclosureItems(db, sub, e);
  return { episode_id: e.id, already_shared: e.shared, text: disclosureText("podcast", items), would_share: items, share_digest: await disclosureHash(items) };
}

// shared: true needs the digest of the list the owner was shown, and nothing less: a missing or stale digest is a 409 that
// says to read the preview again. shared: false needs none (it only takes visibility away).
export async function setShared(db: Db, sub: string, id: string, shared: boolean, digest: string | undefined) {
  return await db.tx(async (t) => {
    const e = await ownEpisode(t, sub, id);
    if (!shared) {
      if (e.shared) await t.query(`UPDATE public.podcast_episodes SET shared = false WHERE id = $1::uuid AND owner_sub = $2`, [e.id, sub]);
      return { episode_id: e.id, shared: false, disclosed: 0 };
    }
    const items = await disclosureItems(t, sub, e);
    if (digest !== await disclosureHash(items)) {
      throw new Conflict("review what would be shared first: GET .../share-preview, then send its share_digest (this one is missing or out of date)", { needs: "share-preview" });
    }
    if (!e.shared) await t.query(`UPDATE public.podcast_episodes SET shared = true WHERE id = $1::uuid AND owner_sub = $2`, [e.id, sub]);
    return { episode_id: e.id, shared: true, disclosed: items.length };
  });
}
