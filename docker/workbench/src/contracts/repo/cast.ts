// Cast editing (research-workbench redesign, rwr-cast-edit-api; slot 560): reads and writes of presenters, voice links,
// teams and formats, every one acting as the identity seam's subject (`sub`), never a user named by the caller.
//
// The rules, in one place:
//   * Visible = the caller's own row, or a row in the one shared pool (Q12: shared = every account sees it). Anything
//     else does not exist for the caller: "no such presenter" (team, format, voice), the same body a missing id gets.
//   * Writable = the caller's own row only. A shared row of someone else's is readable and refused for a write (403,
//     "read-only: copy it"); copying it makes the caller's own copy (copied_from names the original).
//   * What only the owner sees: a presenter's notes, its grounded-in links to private sources, which of the owner's
//     teams a presenter sits in, which formats a team has, a format's default flag. A refusal names a team, format or
//     presenter only to that row's owner (every refusal here is to the owner: another user's row is not found first).
//   * Sharing never exposes an unshared row: a presenter that links a private source cannot be shared (Q12), a team
//     only with every member shared, a format only with its team shared; and the reverse (unsharing a presenter of a
//     shared team, adding an unshared presenter to one) is refused while it would.
//   * A team is at most 26 seats in order: up to 25 presenters (HOST A ...) plus the user's seat.
//   * A presenter in a team cannot be deleted until it is taken out; a team with formats, episodes or render
//     requests cannot be deleted (existing episodes keep their team); a voice link voicing a presenter neither.
// Nothing here logs a row's text, and a database refusal is mapped to a fixed message (castError) before the
// contract's generic error path could log it.
import type { Db } from "../db.ts";
import type { RegistryReader } from "../registry.ts";
import { REGISTRY, requireRegistered } from "../registry.ts";
import { BadRequest } from "../logic/scope.ts";
import { Conflict, Forbidden, NotFound } from "./lifecycle.ts";
import { MAX_SEATS } from "../schemas/cast.ts";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export const NO_SUCH = {
  voice: "no such voice",
  presenter: "no such presenter",
  team: "no such team",
  format: "no such format",
  source: "no such source",
};
const READ_ONLY = (what: string) => `a shared ${what} is read-only: copy it to make your own`;

// A database refusal as a fixed message: the row's text never reaches a log or another user.
export function castError(e: unknown): unknown {
  const code = (e as { fields?: { code?: string } })?.fields?.code;
  if (code === "23505") return new Conflict("that name is already taken by one of yours");
  if (code === "23503") return new Conflict("it is still in use");
  if (code === "23514") return new BadRequest("a value is out of range");
  return e;
}

// ── voice links ───────────────────────────────────────────────────────────────────────────────
const VOICE_COLS = `v.id, v.route, v.voice, v.speed::float8 AS speed, v.created_at, v.updated_at,
  COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.name, p.id)
              FROM public.podcast_presenters p WHERE p.voice_link_id = v.id AND p.owner_sub = v.owner_sub), '[]'::json) AS used_by`;

// deno-postgres hands float8 back as a string: the wire carries a number (as repo/private.ts)
const voiceRow = (r: Row | undefined) => (r ? { ...r, speed: Number(r.speed) } : null);

export async function listVoices(db: Db, sub: string, limit: number) {
  const voices = (await db.query<Row>(
    `SELECT ${VOICE_COLS} FROM public.podcast_voice_links v WHERE v.owner_sub = $1 ORDER BY v.voice, v.id LIMIT $2`, [sub, limit],
  )).map(voiceRow);
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.podcast_voice_links WHERE owner_sub = $1`, [sub]))[0].n;
  return { voices, total };
}

export async function getVoice(db: Db, sub: string, id: string) {
  return voiceRow((await db.query<Row>(`SELECT ${VOICE_COLS} FROM public.podcast_voice_links v WHERE v.id = $1 AND v.owner_sub = $2`, [id, sub]))[0]);
}

export async function createVoice(db: Db, sub: string, b: { route: string; voice: string; speed?: number }) {
  const id = newId("voice");
  await db.query(`INSERT INTO public.podcast_voice_links (id, owner_sub, route, voice, speed) VALUES ($1, $2, $3, $4, $5)`,
    [id, sub, b.route, b.voice, b.speed ?? 1.0]);
  return await getVoice(db, sub, id);
}

export async function updateVoice(db: Db, sub: string, id: string, b: { route?: string; voice?: string; speed?: number }) {
  const r = await db.query<{ id: string }>(
    `UPDATE public.podcast_voice_links SET route = COALESCE($3, route), voice = COALESCE($4, voice), speed = COALESCE($5, speed), updated_at = now()
      WHERE id = $1 AND owner_sub = $2 RETURNING id`, [id, sub, b.route ?? null, b.voice ?? null, b.speed ?? null],
  );
  if (!r.length) throw new NotFound(NO_SUCH.voice);
  return await getVoice(db, sub, id);
}

export async function deleteVoice(db: Db, sub: string, id: string) {
  return await db.tx(async (t) => {
    const v = await t.query<{ id: string }>(`SELECT id FROM public.podcast_voice_links WHERE id = $1 AND owner_sub = $2 FOR UPDATE`, [id, sub]);
    if (!v.length) throw new NotFound(NO_SUCH.voice);
    const users = await t.query<{ id: string; name: string }>(
      `SELECT id, name FROM public.podcast_presenters WHERE voice_link_id = $1 AND owner_sub = $2 ORDER BY name, id`, [id, sub],
    );
    if (users.length) {
      throw new Conflict(`this voice voices ${users.map((u) => `"${u.name}"`).join(", ")}: give them another voice first`, { presenters: users });
    }
    await t.query(`DELETE FROM public.podcast_voice_links WHERE id = $1 AND owner_sub = $2`, [id, sub]);
    return { id, deleted: true };
  });
}

// ── presenters ────────────────────────────────────────────────────────────────────────────────
// $1 is always the caller. A grounding link is listed to the owner always, to anyone else only when it is a topic or
// a SHARED source (a link to anything else - a private source - is the owner's alone).
const PRESENTER_COLS = `p.id, p.name, p.personality, p.backstory, p.language, p.role, p.focus, p.stance, p.tone, p.speaking_style,
  p.system_prompt, p.system_prompt_mode, CASE WHEN p.owner_sub = $1 THEN p.notes END AS notes,
  json_build_object('id', v.id, 'route', v.route, 'voice', v.voice, 'speed', v.speed) AS voice,
  COALESCE((SELECT json_agg(json_build_object('kind', g.kind, 'ref', g.ref, 'title', s.title, 'is_shared', s.id IS NOT NULL) ORDER BY g.position)
              FROM public.podcast_presenter_grounding g
              LEFT JOIN public.sources s ON g.kind = 'source' AND s.id::text = g.ref
             WHERE g.presenter_id = p.id AND g.owner_sub = p.owner_sub
               AND (p.owner_sub = $1 OR g.kind <> 'source' OR s.id IS NOT NULL)), '[]'::json) AS grounding,
  CASE WHEN p.owner_sub = $1 THEN COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.name, t.id)
              FROM public.podcast_teams t WHERE t.owner_sub = $1 AND EXISTS (
                SELECT 1 FROM public.podcast_team_members m WHERE m.team_id = t.id AND m.presenter_id = p.id)), '[]'::json)
       ELSE '[]'::json END AS teams,
  p.shared, (p.owner_sub = $1) AS mine,
  CASE WHEN EXISTS (SELECT 1 FROM public.podcast_presenters o WHERE o.id = p.copied_from AND (o.owner_sub = $1 OR o.shared))
       THEN p.copied_from END AS copied_from,
  p.origin, p.created_at, p.updated_at`;
const PRESENTER_FROM = `public.podcast_presenters p JOIN public.podcast_voice_links v ON v.id = p.voice_link_id AND v.owner_sub = p.owner_sub`;

// A private source's title, for its owner, through the owner-scoped read (slot 440/480). A missing function or a role
// that may not run it reads as no source: fail closed.
async function privateSourceTitle(db: Db, sub: string, ref: string): Promise<string | null> {
  if (!UUID.test(ref)) return null;
  try {
    const r = await db.query<{ title: string }>(`SELECT title FROM public.inlet_private_source($1::uuid, $2)`, [ref, sub]);
    return r.length ? String(r[0].title ?? "") : null;
  } catch (e) {
    const code = (e as { fields?: { code?: string } }).fields?.code;
    if (code === "42883" || code === "42501" || code === "42P01") return null;
    throw e;
  }
}

async function shapePresenter(db: Db, sub: string, row: Row) {
  const { grounding, ...rest } = row as Row & { grounding: { kind: string; ref: string; title: string | null; is_shared: boolean }[] };
  const grounded_in = [];
  for (const g of grounding ?? []) {
    if (g.kind !== "source") grounded_in.push({ kind: g.kind, ref: g.ref, label: g.ref, private: false });
    else if (g.is_shared) grounded_in.push({ kind: g.kind, ref: g.ref, label: g.title ?? "", private: false });
    else if (rest.mine) {
      // the owner's own private link (the SQL lists it to the owner only)
      grounded_in.push({ kind: g.kind, ref: g.ref, label: (await privateSourceTitle(db, sub, g.ref)) ?? "(a private source)", private: true });
    }
  }
  return { ...rest, grounded_in };
}

export async function listPresenters(db: Db, sub: string, o: { shared: boolean; limit: number }) {
  const where = o.shared ? `p.shared` : `p.owner_sub = $1`;
  const rows = await db.query<Row>(`SELECT ${PRESENTER_COLS} FROM ${PRESENTER_FROM} WHERE ${where} ORDER BY p.name, p.id LIMIT $2`, [sub, o.limit]);
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${PRESENTER_FROM} WHERE ${where} AND $1::text IS NOT NULL`, [sub]))[0].n;
  const presenters = [];
  for (const r of rows) presenters.push(await shapePresenter(db, sub, r));
  return { presenters, total };
}

export async function getPresenter(db: Db, sub: string, id: string) {
  const r = (await db.query<Row>(`SELECT ${PRESENTER_COLS} FROM ${PRESENTER_FROM} WHERE p.id = $2 AND (p.owner_sub = $1 OR p.shared)`, [sub, id]))[0];
  return r ? await shapePresenter(db, sub, r) : null;
}

// The row the caller may write: its own. Another's shared row is read-only (403); anything else is not found.
async function writable(db: Db, sub: string, table: string, id: string, what: keyof typeof NO_SUCH): Promise<Row> {
  const r = (await db.query<Row>(`SELECT * FROM public.${table} WHERE id = $1 AND (owner_sub = $2 OR shared) FOR UPDATE`, [id, sub]))[0];
  if (!r) throw new NotFound(NO_SUCH[what]);
  if (r.owner_sub !== sub) throw new Forbidden(READ_ONLY(what));
  return r;
}

interface GroundingIn { kind: string; ref: string }

// Every link the caller writes: a registered kind; a source the caller may see (a shared source, or the caller's own
// private one - anything else is "no such source", exactly as a missing id); a topic's words. Returns which are private.
async function checkGrounding(db: Db, reg: RegistryReader, sub: string, links: GroundingIn[]) {
  const priv: GroundingIn[] = [];
  const seen = new Set<string>();
  for (const g of links) {
    await requireRegistered(reg, REGISTRY.podcastGroundingKinds, g.kind);
    const k = `${g.kind}\u0000${g.ref}`;
    if (seen.has(k)) throw new BadRequest("a grounded-in link is listed twice");
    seen.add(k);
    if (g.kind !== "source") continue;
    if (!UUID.test(g.ref)) throw new NotFound(NO_SUCH.source);
    const shared = await db.query(`SELECT 1 FROM public.sources WHERE id = $1::uuid`, [g.ref]);
    if (shared.length) continue;
    if ((await privateSourceTitle(db, sub, g.ref)) === null) throw new NotFound(NO_SUCH.source);
    priv.push(g);
  }
  return priv;
}

// The links of a presenter that are not shared sources (what blocks sharing it), with labels for the owner.
async function privateLinksOf(db: Db, sub: string, presenterId: string) {
  const rows = await db.query<{ ref: string }>(
    `SELECT g.ref FROM public.podcast_presenter_grounding g
      WHERE g.presenter_id = $1 AND g.owner_sub = $2 AND g.kind = 'source'
        AND NOT EXISTS (SELECT 1 FROM public.sources s WHERE s.id::text = g.ref) ORDER BY g.position`, [presenterId, sub],
  );
  const out = [];
  for (const r of rows) out.push({ ref: r.ref, label: (await privateSourceTitle(db, sub, r.ref)) ?? "(a private source)" });
  return out;
}

function refusePrivateShare(links: { ref: string; label: string }[]) {
  throw new Conflict(
    `this presenter links ${links.length === 1 ? "a private source" : `${links.length} private sources`} (${links.map((l) => `"${l.label}"`).join(", ")}): ` +
      "remove those links before sharing it",
    { private_links: links },
  );
}

async function ownVoice(db: Db, sub: string, id: string) {
  if (!(await db.query(`SELECT 1 FROM public.podcast_voice_links WHERE id = $1 AND owner_sub = $2`, [id, sub])).length) throw new NotFound(NO_SUCH.voice);
}

async function writeGrounding(db: Db, sub: string, presenterId: string, links: GroundingIn[]) {
  await db.query(`DELETE FROM public.podcast_presenter_grounding WHERE presenter_id = $1 AND owner_sub = $2`, [presenterId, sub]);
  for (const [i, g] of links.entries()) {
    await db.query(`INSERT INTO public.podcast_presenter_grounding (presenter_id, owner_sub, position, kind, ref) VALUES ($1, $2, $3, $4, $5)`,
      [presenterId, sub, i, g.kind, g.ref]);
  }
}

// The owner's shared teams a presenter sits in (unsharing the presenter would expose... nothing: it is refused instead).
async function sharedTeamsOf(db: Db, sub: string, presenterId: string) {
  return await db.query<{ id: string; name: string }>(
    `SELECT t.id, t.name FROM public.podcast_teams t WHERE t.owner_sub = $1 AND t.shared
        AND EXISTS (SELECT 1 FROM public.podcast_team_members m WHERE m.team_id = t.id AND m.presenter_id = $2) ORDER BY t.name, t.id`, [sub, presenterId],
  );
}

export interface PresenterIn {
  name?: string;
  voice_id?: string;
  personality?: string;
  backstory?: string;
  language?: string;
  role?: string;
  focus?: string;
  stance?: string;
  tone?: string;
  speaking_style?: string;
  system_prompt?: string;
  system_prompt_mode?: string;
  notes?: string;
  grounded_in?: GroundingIn[];
  shared?: boolean;
  share_digest?: string;
}
const PRESENTER_TEXT = ["name", "personality", "backstory", "language", "role", "focus", "stance", "tone", "speaking_style", "system_prompt",
  "system_prompt_mode", "notes"] as const;

export async function createPresenter(db: Db, reg: RegistryReader, sub: string, b: PresenterIn & { name: string; voice_id: string }) {
  if (b.system_prompt_mode !== undefined) await requireRegistered(reg, REGISTRY.podcastPromptModes, b.system_prompt_mode);
  return await db.tx(async (t) => {
    await ownVoice(t, sub, b.voice_id);
    const links = b.grounded_in ?? [];
    await checkGrounding(t, reg, sub, links);
    const id = newId("presenter"); // made private: sharing is its own step (share-preview, then shared + share_digest)
    await t.query(
      `INSERT INTO public.podcast_presenters (id, owner_sub, name, personality, backstory, language, voice_link_id, role, focus, stance, tone,
                                              speaking_style, system_prompt, system_prompt_mode, notes, shared)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [id, sub, b.name, b.personality ?? "", b.backstory ?? "", b.language ?? "en-US", b.voice_id, b.role ?? "", b.focus ?? "", b.stance ?? "",
        b.tone ?? "", b.speaking_style ?? "", b.system_prompt ?? "", b.system_prompt_mode ?? "built", b.notes ?? "", false],
    );
    await writeGrounding(t, sub, id, links);
    return await getPresenter(t, sub, id);
  });
}

export async function updatePresenter(db: Db, reg: RegistryReader, sub: string, id: string, b: PresenterIn) {
  if (b.system_prompt_mode !== undefined) await requireRegistered(reg, REGISTRY.podcastPromptModes, b.system_prompt_mode);
  return await db.tx(async (t) => {
    const cur = await writable(t, sub, "podcast_presenters", id, "presenter");
    if (b.shared === true && !cur.shared) await shareStep(t, sub, "presenter", cur, b as Record<string, unknown>);
    if (b.voice_id !== undefined) await ownVoice(t, sub, b.voice_id);
    const willShare = b.shared ?? (cur.shared as boolean);
    if (b.grounded_in !== undefined) {
      const priv = await checkGrounding(t, reg, sub, b.grounded_in);
      if (willShare && priv.length) {
        const labels = [];
        for (const g of priv) labels.push({ ref: g.ref, label: (await privateSourceTitle(t, sub, g.ref)) ?? "(a private source)" });
        refusePrivateShare(labels);
      }
      await writeGrounding(t, sub, id, b.grounded_in);
    } else if (willShare && !cur.shared) {
      const priv = await privateLinksOf(t, sub, id);
      if (priv.length) refusePrivateShare(priv);
    }
    if (b.shared === false && cur.shared) {
      const teams = await sharedTeamsOf(t, sub, id);
      if (teams.length) {
        throw new Conflict(`this presenter sits in your shared team${teams.length > 1 ? "s" : ""} ${teams.map((x) => `"${x.name}"`).join(", ")}: ` +
          "unshare the team first", { teams });
      }
    }
    const sets: string[] = [];
    const args: unknown[] = [id, sub];
    for (const k of PRESENTER_TEXT) {
      if (b[k] === undefined) continue;
      args.push(b[k]);
      sets.push(`${k} = $${args.length}`);
    }
    if (b.voice_id !== undefined) {
      args.push(b.voice_id);
      sets.push(`voice_link_id = $${args.length}`);
    }
    if (b.shared !== undefined) {
      args.push(b.shared);
      sets.push(`shared = $${args.length}`);
    }
    await t.query(`UPDATE public.podcast_presenters SET ${[...sets, "updated_at = now()"].join(", ")} WHERE id = $1 AND owner_sub = $2`, args);
    return await getPresenter(t, sub, id);
  });
}

export async function deletePresenter(db: Db, sub: string, id: string) {
  return await db.tx(async (t) => {
    await writable(t, sub, "podcast_presenters", id, "presenter");
    const teams = await t.query<{ id: string; name: string }>(
      `SELECT DISTINCT t.id, t.name FROM public.podcast_team_members m JOIN public.podcast_teams t ON t.id = m.team_id
        WHERE m.presenter_id = $1 ORDER BY t.name, t.id`, [id],
    );
    // the caller owns the presenter, and a team holds only its owner's presenters: these are the caller's own teams
    if (teams.length) {
      throw new Conflict(`this presenter is in ${teams.map((x) => `"${x.name}"`).join(", ")}: take it out of ${teams.length > 1 ? "those teams" : "the team"} first`,
        { teams });
    }
    await t.query(`DELETE FROM public.podcast_presenters WHERE id = $1 AND owner_sub = $2`, [id, sub]);
    return { id, deleted: true };
  });
}

// A copy of a presenter the caller can see: its voice link copied too (the copy is fully the caller's), the shared
// grounded-in links (an own copy of one's own presenter keeps the private ones too), never the original's notes.
async function copyPresenterRow(t: Db, sub: string, src: Row): Promise<string> {
  const own = src.owner_sub === sub;
  const voice = (await t.query<Row>(`SELECT route, voice, speed FROM public.podcast_voice_links WHERE id = $1 AND owner_sub = $2`,
    [src.voice_link_id, src.owner_sub]))[0];
  if (!voice) throw new NotFound(NO_SUCH.presenter);
  const vid = newId("voice");
  await t.query(`INSERT INTO public.podcast_voice_links (id, owner_sub, route, voice, speed) VALUES ($1, $2, $3, $4, $5)`,
    [vid, sub, voice.route, voice.voice, voice.speed]);
  const id = newId("presenter");
  await t.query(
    `INSERT INTO public.podcast_presenters (id, owner_sub, name, personality, backstory, language, voice_link_id, role, focus, stance, tone,
                                            speaking_style, system_prompt, system_prompt_mode, notes, shared, copied_from)
     SELECT $1, $2, name, personality, backstory, language, $3, role, focus, stance, tone, speaking_style, system_prompt, system_prompt_mode,
            CASE WHEN owner_sub = $2 THEN notes ELSE '' END, false, id
       FROM public.podcast_presenters WHERE id = $4`, [id, sub, vid, src.id],
  );
  await t.query(
    `INSERT INTO public.podcast_presenter_grounding (presenter_id, owner_sub, position, kind, ref)
     SELECT $1, $2, (row_number() OVER (ORDER BY g.position)) - 1, g.kind, g.ref
       FROM public.podcast_presenter_grounding g
      WHERE g.presenter_id = $3 AND g.owner_sub = $4
        AND ($5 OR g.kind <> 'source' OR EXISTS (SELECT 1 FROM public.sources s WHERE s.id::text = g.ref))`,
    [id, sub, src.id, src.owner_sub, own],
  );
  return id;
}

async function visibleRow(t: Db, sub: string, table: string, id: string, what: keyof typeof NO_SUCH): Promise<Row> {
  const r = (await t.query<Row>(`SELECT * FROM public.${table} WHERE id = $1 AND (owner_sub = $2 OR shared)`, [id, sub]))[0];
  if (!r) throw new NotFound(NO_SUCH[what]);
  return r;
}

export async function copyPresenter(db: Db, sub: string, id: string) {
  return await db.tx(async (t) => {
    const src = await visibleRow(t, sub, "podcast_presenters", id, "presenter");
    return await getPresenter(t, sub, await copyPresenterRow(t, sub, src));
  });
}

// ── teams ─────────────────────────────────────────────────────────────────────────────────────
const TEAM_COLS = `t.id, t.name, t.description,
  COALESCE((SELECT json_agg(json_build_object('position', m.position, 'presenter_id', m.presenter_id, 'name', p.name) ORDER BY m.position)
              FROM public.podcast_team_members m JOIN public.podcast_presenters p ON p.id = m.presenter_id AND p.owner_sub = t.owner_sub
             WHERE m.team_id = t.id), '[]'::json) AS members,
  COALESCE(t.user_seat, (SELECT count(*) FROM public.podcast_team_members m WHERE m.team_id = t.id))::int AS user_seat,
  ((SELECT count(*) FROM public.podcast_team_members m WHERE m.team_id = t.id) + 1)::int AS seats,
  CASE WHEN t.owner_sub = $1 THEN COALESCE((SELECT json_agg(json_build_object('id', f.id, 'name', f.name) ORDER BY f.name, f.id)
              FROM public.podcast_formats f WHERE f.team_id = t.id AND f.owner_sub = $1), '[]'::json) ELSE '[]'::json END AS formats,
  t.shared, (t.owner_sub = $1) AS mine,
  CASE WHEN EXISTS (SELECT 1 FROM public.podcast_teams o WHERE o.id = t.copied_from AND (o.owner_sub = $1 OR o.shared))
       THEN t.copied_from END AS copied_from,
  t.origin, t.created_at, t.updated_at`;

export async function listTeams(db: Db, sub: string, o: { shared: boolean; limit: number }) {
  const where = o.shared ? `t.shared` : `t.owner_sub = $1`;
  const teams = await db.query<Row>(`SELECT ${TEAM_COLS} FROM public.podcast_teams t WHERE ${where} ORDER BY t.name, t.id LIMIT $2`, [sub, o.limit]);
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.podcast_teams t WHERE ${where} AND $1::text IS NOT NULL`, [sub]))[0].n;
  return { teams, total };
}

export async function getTeam(db: Db, sub: string, id: string) {
  return (await db.query<Row>(`SELECT ${TEAM_COLS} FROM public.podcast_teams t WHERE t.id = $2 AND (t.owner_sub = $1 OR t.shared)`, [sub, id]))[0] ?? null;
}

export interface TeamIn {
  name?: string;
  description?: string;
  members?: string[];
  user_seat?: number;
  shared?: boolean;
  share_digest?: string;
}

// The members: the caller's own presenters (anything else is "no such presenter"), each once, at most 25 plus the
// user's seat, the seat within 0 .. members.
async function checkMembers(db: Db, sub: string, members: string[], seat: number | undefined) {
  if (new Set(members).size !== members.length) throw new BadRequest("a presenter sits in a team once");
  if (members.length + 1 > MAX_SEATS) throw new BadRequest(`a team has at most ${MAX_SEATS} seats: ${MAX_SEATS - 1} presenters and yours`);
  if (seat !== undefined && (seat < 0 || seat > members.length)) throw new BadRequest(`user_seat is 0 .. ${members.length} (the number of presenters)`);
  const own = await db.query<{ id: string; shared: boolean; name: string }>(
    `SELECT id, shared, name FROM public.podcast_presenters WHERE id = ANY($1::text[]) AND owner_sub = $2`, [members, sub],
  );
  if (own.length !== members.length) throw new NotFound(NO_SUCH.presenter);
  return own;
}

function refuseUnsharedMembers(unshared: { id: string; name: string }[]) {
  throw new Conflict(`a shared team shares its presenters: share ${unshared.map((p) => `"${p.name}"`).join(", ")} first`,
    { presenters: unshared.map((p) => ({ id: p.id, name: p.name })) });
}

async function writeMembers(db: Db, teamId: string, members: string[]) {
  await db.query(`DELETE FROM public.podcast_team_members WHERE team_id = $1`, [teamId]);
  for (const [i, pid] of members.entries()) {
    await db.query(`INSERT INTO public.podcast_team_members (team_id, position, presenter_id) VALUES ($1, $2, $3)`, [teamId, i, pid]);
  }
}

export async function createTeam(db: Db, sub: string, b: TeamIn & { name: string; members: string[] }) {
  return await db.tx(async (t) => {
    await checkMembers(t, sub, b.members, b.user_seat);
    const id = newId("team"); // made private: sharing is its own step
    await t.query(`INSERT INTO public.podcast_teams (id, owner_sub, name, description, user_seat, shared) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, sub, b.name, b.description ?? "", b.user_seat ?? b.members.length, false]);
    await writeMembers(t, id, b.members);
    return await getTeam(t, sub, id);
  });
}

export async function updateTeam(db: Db, sub: string, id: string, b: TeamIn) {
  return await db.tx(async (t) => {
    const cur = await writable(t, sub, "podcast_teams", id, "team");
    if (b.shared === true && !cur.shared) await shareStep(t, sub, "team", cur, b as Record<string, unknown>);
    const members = b.members ??
      (await t.query<{ presenter_id: string }>(`SELECT presenter_id FROM public.podcast_team_members WHERE team_id = $1 ORDER BY position`, [id]))
        .map((m) => m.presenter_id);
    // a new member list without a seat keeps the seat where it was, or after the last when it no longer fits
    const curSeat = cur.user_seat === null || cur.user_seat === undefined ? null : Number(cur.user_seat);
    const seat = b.user_seat ?? (curSeat === null || curSeat > members.length ? members.length : curSeat);
    const own = await checkMembers(t, sub, members, seat);
    const willShare = b.shared ?? (cur.shared as boolean);
    if (willShare) {
      const unshared = own.filter((p) => !p.shared);
      if (unshared.length) refuseUnsharedMembers(unshared);
    }
    if (b.shared === false && cur.shared) {
      const formats = await t.query<{ id: string; name: string }>(
        `SELECT id, name FROM public.podcast_formats WHERE team_id = $1 AND owner_sub = $2 AND shared ORDER BY name, id`, [id, sub],
      );
      if (formats.length) {
        throw new Conflict(`this team is the team of your shared format${formats.length > 1 ? "s" : ""} ${formats.map((f) => `"${f.name}"`).join(", ")}: ` +
          "unshare the format first", { formats });
      }
    }
    await t.query(
      `UPDATE public.podcast_teams SET name = COALESCE($3, name), description = COALESCE($4, description), user_seat = $5,
              shared = COALESCE($6, shared), updated_at = now() WHERE id = $1 AND owner_sub = $2`,
      [id, sub, b.name ?? null, b.description ?? null, seat, b.shared ?? null],
    );
    if (b.members) await writeMembers(t, id, b.members);
    return await getTeam(t, sub, id);
  });
}

export async function deleteTeam(db: Db, sub: string, id: string) {
  return await db.tx(async (t) => {
    await writable(t, sub, "podcast_teams", id, "team");
    const formats = await t.query<{ id: string; name: string }>(
      `SELECT id, name FROM public.podcast_formats WHERE team_id = $1 AND owner_sub = $2 ORDER BY name, id`, [id, sub],
    );
    if (formats.length) {
      throw new Conflict(`this team has the format${formats.length > 1 ? "s" : ""} ${formats.map((f) => `"${f.name}"`).join(", ")}: delete or move ${formats.length > 1 ? "them" : "it"} first`,
        { formats });
    }
    const used = (await t.query<{ n: number }>(
      `SELECT ((SELECT count(*) FROM public.podcast_episodes WHERE team_id = $1 AND owner_sub = $2) +
               (SELECT count(*) FROM public.podcast_render_requests WHERE team_id = $1 AND requester_sub = $2))::int AS n`, [id, sub],
    ))[0].n;
    // a team another user's row could name does not exist: a team's episodes and requests are its owner's own
    if (used) throw new Conflict("this team has episodes or render requests: it stays, so they keep their cast", { episodes_and_requests: used });
    await t.query(`DELETE FROM public.podcast_teams WHERE id = $1 AND owner_sub = $2`, [id, sub]);
    return { id, deleted: true };
  });
}

async function uniqueName(t: Db, table: string, sub: string, base: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const name = i === 0 ? base : `${base} (copy${i > 1 ? ` ${i}` : ""})`;
    if (!(await t.query(`SELECT 1 FROM public.${table} WHERE owner_sub = $1 AND name = $2`, [sub, name])).length) return name;
  }
  return `${base} (${crypto.randomUUID().slice(0, 8)})`;
}

// A copy of a team the caller can see: every presenter copied too (with its voice), in the same order and seat.
async function copyTeamRow(t: Db, sub: string, src: Row): Promise<string> {
  const members = await t.query<Row>(
    `SELECT p.* FROM public.podcast_team_members m JOIN public.podcast_presenters p ON p.id = m.presenter_id AND p.owner_sub = $2
      WHERE m.team_id = $1 ORDER BY m.position`, [src.id, src.owner_sub],
  );
  const ids: string[] = [];
  for (const p of members) ids.push(await copyPresenterRow(t, sub, p));
  const id = newId("team");
  await t.query(`INSERT INTO public.podcast_teams (id, owner_sub, name, description, user_seat, shared, copied_from) VALUES ($1, $2, $3, $4, $5, false, $6)`,
    [id, sub, await uniqueName(t, "podcast_teams", sub, String(src.name)), src.description, src.user_seat ?? null, src.id]);
  await writeMembers(t, id, ids);
  return id;
}

export async function copyTeam(db: Db, sub: string, id: string) {
  return await db.tx(async (t) => {
    const src = await visibleRow(t, sub, "podcast_teams", id, "team");
    return await getTeam(t, sub, await copyTeamRow(t, sub, src));
  });
}

// ── formats ───────────────────────────────────────────────────────────────────────────────────
const FORMAT_COLS = `f.id, f.name, f.description, f.team_id, t.name AS team_name, f.briefing, f.segments, f.language, f.script_route, f.kind,
  to_json(f.use_for) AS use_for, (f.is_default AND f.owner_sub = $1) AS is_default, f.shared, (f.owner_sub = $1) AS mine,
  CASE WHEN EXISTS (SELECT 1 FROM public.podcast_formats o WHERE o.id = f.copied_from AND (o.owner_sub = $1 OR o.shared))
       THEN f.copied_from END AS copied_from,
  f.origin, f.created_at, f.updated_at`;
const FORMAT_FROM = `public.podcast_formats f JOIN public.podcast_teams t ON t.id = f.team_id AND t.owner_sub = f.owner_sub`;

export async function listFormats(db: Db, sub: string, o: { shared: boolean; limit: number }) {
  const where = o.shared ? `f.shared` : `f.owner_sub = $1`;
  const formats = await db.query<Row>(`SELECT ${FORMAT_COLS} FROM ${FORMAT_FROM} WHERE ${where} ORDER BY f.name, f.id LIMIT $2`, [sub, o.limit]);
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${FORMAT_FROM} WHERE ${where} AND $1::text IS NOT NULL`, [sub]))[0].n;
  return { formats, total };
}

export async function getFormat(db: Db, sub: string, id: string) {
  return (await db.query<Row>(`SELECT ${FORMAT_COLS} FROM ${FORMAT_FROM} WHERE f.id = $2 AND (f.owner_sub = $1 OR f.shared)`, [sub, id]))[0] ?? null;
}

export interface FormatIn {
  name?: string;
  team_id?: string;
  description?: string;
  briefing?: string;
  segments?: number;
  language?: string;
  script_route?: string;
  kind?: string;
  use_for?: string[];
  is_default?: boolean;
  shared?: boolean;
  share_digest?: string;
}

async function checkFormatRegistries(reg: RegistryReader, b: FormatIn) {
  if (b.kind !== undefined) await requireRegistered(reg, REGISTRY.podcastFormatKinds, b.kind);
  for (const u of b.use_for ?? []) await requireRegistered(reg, REGISTRY.podcastFormatUses, u);
  if (b.use_for && new Set(b.use_for).size !== b.use_for.length) throw new BadRequest("a use is listed twice");
}

async function ownTeam(t: Db, sub: string, id: string) {
  const r = (await t.query<{ id: string; shared: boolean; name: string }>(`SELECT id, shared, name FROM public.podcast_teams WHERE id = $1 AND owner_sub = $2`, [id, sub]))[0];
  if (!r) throw new NotFound(NO_SUCH.team);
  return r;
}

function refuseUnsharedTeam(team: { id: string; name: string }) {
  throw new Conflict(`a shared format shares its team: share "${team.name}" first`, { team: { id: team.id, name: team.name } });
}

export async function createFormat(db: Db, reg: RegistryReader, sub: string, b: FormatIn & { name: string; team_id: string }) {
  await checkFormatRegistries(reg, b);
  return await db.tx(async (t) => {
    await ownTeam(t, sub, b.team_id);
    if (b.is_default) await t.query(`UPDATE public.podcast_formats SET is_default = false, updated_at = now() WHERE owner_sub = $1 AND is_default`, [sub]);
    const id = newId("format");
    await t.query(
      `INSERT INTO public.podcast_formats (id, owner_sub, name, description, team_id, briefing, segments, language, script_route, kind, use_for, is_default, shared)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12, $13)`,
      [id, sub, b.name, b.description ?? "", b.team_id, b.briefing ?? "", b.segments ?? 5, b.language ?? "en-US", b.script_route ?? "local-large",
        b.kind ?? "conversation", b.use_for ?? [], b.is_default ?? false, false], // made private: sharing is its own step
    );
    return await getFormat(t, sub, id);
  });
}

export async function updateFormat(db: Db, reg: RegistryReader, sub: string, id: string, b: FormatIn) {
  await checkFormatRegistries(reg, b);
  return await db.tx(async (t) => {
    const cur = await writable(t, sub, "podcast_formats", id, "format");
    if (b.shared === true && !cur.shared) await shareStep(t, sub, "format", cur, b as Record<string, unknown>);
    const team = await ownTeam(t, sub, b.team_id ?? String(cur.team_id));
    const willShare = b.shared ?? (cur.shared as boolean);
    if (willShare && !team.shared) refuseUnsharedTeam(team);
    if (b.is_default) {
      await t.query(`UPDATE public.podcast_formats SET is_default = false, updated_at = now() WHERE owner_sub = $1 AND is_default AND id <> $2`, [sub, id]);
    }
    await t.query(
      `UPDATE public.podcast_formats SET name = COALESCE($3, name), team_id = COALESCE($4, team_id), description = COALESCE($5, description),
              briefing = COALESCE($6, briefing), segments = COALESCE($7, segments), language = COALESCE($8, language),
              script_route = COALESCE($9, script_route), kind = COALESCE($10, kind), use_for = COALESCE($11::text[], use_for),
              is_default = COALESCE($12, is_default), shared = COALESCE($13, shared), updated_at = now()
        WHERE id = $1 AND owner_sub = $2`,
      [id, sub, b.name ?? null, b.team_id ?? null, b.description ?? null, b.briefing ?? null, b.segments ?? null, b.language ?? null,
        b.script_route ?? null, b.kind ?? null, b.use_for ?? null, b.is_default ?? null, b.shared ?? null],
    );
    return await getFormat(t, sub, id);
  });
}

export async function deleteFormat(db: Db, sub: string, id: string) {
  return await db.tx(async (t) => {
    await writable(t, sub, "podcast_formats", id, "format");
    await t.query(`DELETE FROM public.podcast_formats WHERE id = $1 AND owner_sub = $2`, [id, sub]);
    return { id, deleted: true };
  });
}

// A copy of a format the caller can see: its team (and the team's presenters) copied too, so the copy is fully the
// caller's. Never the caller's default until they say so.
export async function copyFormat(db: Db, sub: string, id: string) {
  return await db.tx(async (t) => {
    const src = await visibleRow(t, sub, "podcast_formats", id, "format");
    const team = (await t.query<Row>(`SELECT * FROM public.podcast_teams WHERE id = $1 AND owner_sub = $2`, [src.team_id, src.owner_sub]))[0];
    if (!team) throw new NotFound(NO_SUCH.format);
    // one's own format keeps its own team; someone else's brings a copy of theirs
    const teamId = src.owner_sub === sub ? String(team.id) : await copyTeamRow(t, sub, team);
    const nid = newId("format");
    await t.query(
      `INSERT INTO public.podcast_formats (id, owner_sub, name, description, team_id, briefing, segments, language, script_route, kind, use_for,
                                           is_default, shared, copied_from)
       SELECT $1, $2, $3, description, $4, briefing, segments, language, script_route, kind, use_for, false, false, id
         FROM public.podcast_formats WHERE id = $5`,
      [nid, sub, await uniqueName(t, "podcast_formats", sub, String(src.name)), teamId, src.id],
    );
    return await getFormat(t, sub, nid);
  });
}

// ── the share step (Q12 + the operator's standing rule of 2026-11-22: a share first reveals what would be shared) ──────
// GET .../share-preview lists everything every account would see, what blocks the share, what stays the owner's, and a
// digest of exactly that. A share is a PATCH {shared: true, share_digest} and nothing else: a digest that is missing or
// no longer matches (the row, its links or its members changed since) is refused, so no path shares a row without its
// owner having been shown what it shares.
export type ShareKind = "presenter" | "team" | "format";
const TABLE: Record<ShareKind, string> = { presenter: "podcast_presenters", team: "podcast_teams", format: "podcast_formats" };
const FIELD_LABELS: [string, string][] = [["personality", "personality"], ["backstory", "backstory"], ["role", "role"], ["focus", "focus"],
  ["stance", "stance"], ["tone", "tone"], ["speaking_style", "speaking style"], ["system_prompt", "system prompt"]];

async function sha256Hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function previewOf(t: Db, sub: string, kind: ShareKind, row: Row) {
  const would: { label: string; detail: string }[] = [];
  const blocked: { ref: string; label: string; detail: string }[] = [];
  let never: string[] = [];
  if (kind === "presenter") {
    const set = FIELD_LABELS.filter(([k]) => String(row[k] ?? "").trim() !== "").map(([, l]) => l);
    would.push({ label: String(row.name), detail: `the presenter: name, ${[...set, "language", "its voice"].join(", ")}` });
    const links = await t.query<{ kind: string; ref: string; title: string | null; is_shared: boolean }>(
      `SELECT g.kind, g.ref, s.title, s.id IS NOT NULL AS is_shared FROM public.podcast_presenter_grounding g
         LEFT JOIN public.sources s ON g.kind = 'source' AND s.id::text = g.ref
        WHERE g.presenter_id = $1 AND g.owner_sub = $2 ORDER BY g.position`, [row.id, sub],
    );
    for (const g of links) {
      if (g.kind !== "source") would.push({ label: g.ref, detail: `a grounded-in ${g.kind}` });
      else if (g.is_shared) would.push({ label: g.title ?? "", detail: "a grounded-in source (a shared source)" });
      else blocked.push({ ref: g.ref, label: (await privateSourceTitle(t, sub, g.ref)) ?? "(a private source)", detail: "a private source: remove the link first" });
    }
    never = ["notes", "which of your teams it sits in"];
  } else if (kind === "team") {
    would.push({ label: String(row.name), detail: "the team: name, description, speaking order, your seat" });
    const members = await t.query<{ id: string; name: string; shared: boolean }>(
      `SELECT p.id, p.name, p.shared FROM public.podcast_team_members m JOIN public.podcast_presenters p ON p.id = m.presenter_id AND p.owner_sub = $2
        WHERE m.team_id = $1 ORDER BY m.position`, [row.id, sub],
    );
    for (const m of members) {
      if (m.shared) would.push({ label: m.name, detail: "a presenter of the team (already shared)" });
      else blocked.push({ ref: m.id, label: m.name, detail: "a presenter of the team that is not shared: share it first" });
    }
    never = ["which of your formats use it"];
  } else {
    would.push({ label: String(row.name), detail: "the format: name, description, briefing, segments, language, script route, kind, use-for" });
    const team = (await t.query<{ id: string; name: string; shared: boolean }>(
      `SELECT id, name, shared FROM public.podcast_teams WHERE id = $1 AND owner_sub = $2`, [row.team_id, sub],
    ))[0];
    if (team?.shared) would.push({ label: team.name, detail: "its team (already shared)" });
    else if (team) blocked.push({ ref: team.id, label: team.name, detail: "its team is not shared: share it first" });
    never = ["whether it is your default"];
  }
  const at = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at);
  const share_digest = await sha256Hex(JSON.stringify({ kind, id: row.id, at, would, blocked }));
  return { id: String(row.id), already_shared: !!row.shared, shareable: blocked.length === 0, would_share: would, blocked_by: blocked, never_shared: never, share_digest };
}

// The owner's preview (someone else's shared row: read-only 403; anything else: not found)
export async function sharePreview(db: Db, sub: string, kind: ShareKind, id: string) {
  return await db.tx(async (t) => previewOf(t, sub, kind, await writable(t, sub, TABLE[kind], id, kind)));
}

async function shareStep(t: Db, sub: string, kind: ShareKind, cur: Row, b: Record<string, unknown>) {
  const others = Object.keys(b).filter((k) => k !== "shared" && k !== "share_digest" && b[k] !== undefined);
  if (others.length) throw new BadRequest("share on its own: read GET .../share-preview, then PATCH {shared: true, share_digest} with nothing else");
  const pv = await previewOf(t, sub, kind, cur);
  if (pv.blocked_by.length) {
    if (kind === "presenter") refusePrivateShare(pv.blocked_by);
    if (kind === "team") refuseUnsharedMembers(pv.blocked_by.map((x) => ({ id: x.ref, name: x.label })));
    refuseUnsharedTeam({ id: pv.blocked_by[0].ref, name: pv.blocked_by[0].label });
  }
  if (b.share_digest !== pv.share_digest) {
    throw new Conflict(
      "review what would be shared first: GET .../share-preview, then send its share_digest (this one is missing or out of date)",
      { needs: "share-preview" },
    );
  }
}
