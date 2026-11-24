/**
 * The presenter model and render records in openbrain-db (init-podcasts.sql), through the
 * openbrain-rest PostgREST proxy this service already uses (BRAIN_REST_URL). A server-side job's
 * door, not a user route: every read is filtered by the owner it is given (the chain's
 * PODCAST_OWNER_SUB, the request's requester), every write stamps it.
 */
import type { Format, Presenter, Team, VoiceLink } from "./presenters.ts";

import { restAuthHeaders } from "../clients/rest-auth.ts";
type Row = Record<string, unknown>;

// rwr-cast-edit-api (slot 560): the presenter columns the renderer reads (castBlock); never the owner's notes or
// grounded-in links, which no render uses.
export const CAST_FIELDS = ",role,focus,stance,tone,speaking_style,system_prompt,system_prompt_mode";

/** The new fields of a presenter row, only those set (a row without them - slot 560 not applied - adds nothing). */
export function castFieldsOf(p: Row): Partial<Presenter> {
  const s = (k: string) => (typeof p[k] === "string" && p[k] !== "" ? String(p[k]) : undefined);
  const out: Partial<Presenter> = {
    role: s("role"), focus: s("focus"), stance: s("stance"), tone: s("tone"), speakingStyle: s("speaking_style"),
    systemPrompt: s("system_prompt"), systemPromptMode: s("system_prompt_mode"),
  };
  for (const k of Object.keys(out) as (keyof Presenter)[]) if (out[k] === undefined) delete out[k];
  return out;
}

export class PresenterStore {
  readonly #base: string;
  readonly #f: typeof fetch;
  constructor(baseUrl: string, fetchFn?: typeof fetch) {
    this.#base = `${baseUrl.replace(/\/+$/, "")}/rest/v1`;
    this.#f = fetchFn ?? fetch;
  }

  async #req<T>(method: string, path: string, body?: unknown, prefer = "return=representation"): Promise<T> {
    const res = await this.#f(`${this.#base}/${path}`, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json", Prefer: prefer, ...restAuthHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`PostgREST ${method} ${path.split("?")[0]}: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** A team of `owner` by id or name, with its presenters in speaking order and their voices. */
  async team(owner: string, idOrName: string): Promise<Team | null> {
    const q = encodeURIComponent(idOrName);
    const o = encodeURIComponent(owner);
    // rwr-cast-edit-api (slot 560): the presenter's new fields, read where the database has them. A database without
    // slot 560 (PostgREST 42703: no such column) is read as before, so this image never needs 560 to render.
    const sel = (extra: string) =>
      `id,name,description,podcast_team_members(position,podcast_presenters(id,name,personality,backstory,language${extra},podcast_voice_links(id,route,voice,speed)))`;
    const get = async (s: string) => {
      let rows = await this.#req<Row[]>("GET", `podcast_teams?select=${s}&owner_sub=eq.${o}&id=eq.${q}`);
      if (!rows.length) rows = await this.#req<Row[]>("GET", `podcast_teams?select=${s}&owner_sub=eq.${o}&name=eq.${q}`);
      return rows;
    };
    let rows: Row[];
    try {
      rows = await get(sel(CAST_FIELDS));
    } catch (e) {
      if (!/: 400 .*42703/s.test(String((e as Error)?.message ?? ""))) throw e;
      rows = await get(sel(""));
    }
    const t = rows[0];
    if (!t) return null;
    const members = (t.podcast_team_members as Row[]).sort((a, b) => Number(a.position) - Number(b.position));
    return {
      id: String(t.id), name: String(t.name), description: String(t.description ?? ""),
      presenters: members.map((m) => {
        const p = m.podcast_presenters as Row;
        const v = p.podcast_voice_links as Row;
        return {
          id: String(p.id), name: String(p.name), personality: String(p.personality ?? ""), backstory: String(p.backstory ?? ""),
          language: String(p.language ?? "en-US"),
          voice: { id: String(v.id), route: String(v.route), voice: String(v.voice), speed: Number(v.speed) },
          ...castFieldsOf(p),
        };
      }),
    };
  }

  /** Insert a whole presenter model for `owner` (voice links, presenters, teams, members, formats). */
  async insertModel(owner: string, m: { voices: (VoiceLink & Meta)[]; presenters: (Presenter & Meta)[]; teams: (Team & Meta)[]; formats: (Format & Meta)[] }) {
    const meta = (x: Meta) => ({ owner_sub: owner, origin: x.origin, origin_ref: x.originRef ?? null });
    if (m.voices.length) await this.#req("POST", "podcast_voice_links", m.voices.map((v) => ({ id: v.id, route: v.route, voice: v.voice, speed: v.speed, ...meta(v) })), "return=minimal");
    if (m.presenters.length) {
      await this.#req("POST", "podcast_presenters", m.presenters.map((p) => ({
        id: p.id, name: p.name, personality: p.personality, backstory: p.backstory, language: p.language, voice_link_id: p.voice.id, ...meta(p),
      })), "return=minimal");
    }
    if (m.teams.length) {
      await this.#req("POST", "podcast_teams", m.teams.map((t) => ({ id: t.id, name: t.name, description: t.description, ...meta(t) })), "return=minimal");
      await this.#req("POST", "podcast_team_members", m.teams.flatMap((t) => t.presenters.map((p, position) => ({ team_id: t.id, position, presenter_id: p.id }))), "return=minimal");
    }
    if (m.formats.length) {
      await this.#req("POST", "podcast_formats", m.formats.map((f) => ({
        id: f.id, name: f.name, description: f.description, team_id: f.teamId, briefing: f.briefing, segments: f.segments,
        language: f.language, script_route: f.scriptRoute, ...meta(f),
      })), "return=minimal");
    }
  }

  async counts(owner: string, origin: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of ["podcast_voice_links", "podcast_presenters", "podcast_teams", "podcast_formats"]) {
      out[t] = (await this.#req<Row[]>("GET", `${t}?select=id&owner_sub=eq.${encodeURIComponent(owner)}&origin=eq.${encodeURIComponent(origin)}`)).length;
    }
    return out;
  }

  async setVoice(owner: string, voiceLinkId: string, voice: string): Promise<void> {
    await this.#req("PATCH", `podcast_voice_links?id=eq.${encodeURIComponent(voiceLinkId)}&owner_sub=eq.${encodeURIComponent(owner)}`,
      { voice, updated_at: new Date().toISOString() }, "return=minimal");
  }

  async recordEpisode(e: { ownerSub: string; shared: boolean; title: string; teamId: string; audioFormat: string; seconds: number; archiveDir: string; requestId?: string | null }): Promise<string> {
    const rows = await this.#req<Row[]>("POST", "podcast_episodes", {
      owner_sub: e.ownerSub, shared: e.shared, origin: "render", title: e.title, team_id: e.teamId, audio_format: e.audioFormat,
      seconds: e.seconds, archive_dir: e.archiveDir, request_id: e.requestId ?? null,
    });
    return String(rows[0].id);
  }

  /** rw-boundary-digest (slot 460, plan 09 P6): the episode's script on the OWNER's own episode row (owner_sub
   *  filter: never another user's row). Returns whether a row took it. */
  async setTranscript(id: string, owner: string, transcript: string): Promise<boolean> {
    const rows = await this.#req<Row[]>("PATCH",
      `podcast_episodes?id=eq.${encodeURIComponent(id)}&owner_sub=eq.${encodeURIComponent(owner)}&select=id`, { transcript });
    return Array.isArray(rows) && rows.length === 1;
  }

  async request(id: string): Promise<Row | null> {
    return (await this.#req<Row[]>("GET", `podcast_render_requests?id=eq.${encodeURIComponent(id)}&select=*`))[0] ?? null;
  }

  async updateRequest(id: string, patch: Row): Promise<void> {
    await this.#req("PATCH", `podcast_render_requests?id=eq.${encodeURIComponent(id)}`, { ...patch, updated_at: new Date().toISOString() }, "return=minimal");
  }
}

export interface Meta {
  origin: "operator" | "on-capture";
  originRef?: string | null;
}
