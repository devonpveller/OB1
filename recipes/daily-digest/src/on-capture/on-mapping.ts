/**
 * Open Notebook -> the presenter model (research-workbench P7a capture, D6). Pure functions: ON
 * records in, presenter-model records out, plus a FIELD LEDGER naming, for every ON field seen,
 * where it went (mapped) or why it did not (unmapped). The capture writes the ledger beside the
 * archive and the findings sink lists it.
 *
 *   speaker_profile  -> one Team (its speakers -> Presenters, each with a VoiceLink)
 *   episode_profile  -> one Format (of the team its speaker_config names)
 *   podcast_config   -> none exist (the table is SCHEMALESS with no defined field); a row here has
 *                       no mapping and the capture REFUSES rather than drop it silently.
 *
 * Voices: ON voiced each speaker with the Piper model its `voice_model` names (the OpenAI-style
 * `voice_id` was passed as Piper's voice and ignored by it - what listeners heard was the Piper
 * model). Each Piper voice maps to the Kokoro voice nearest in accent and register (PIPER_TO_KOKORO);
 * an unknown Piper voice refuses the capture. Provider/model fields map to LiteLLM routes.
 *
 * This module is the ONLY place that knows ON's shapes; the renderer never sees them.
 */
import type { Format, Presenter, Team, VoiceLink } from "../podcast/presenters.ts";
import type { Meta } from "../podcast/presenter-store.ts";

export type OnRecord = Record<string, unknown>;

/** Piper voice (ON's live TTS, stt-tts-server) -> Kokoro voice. The operator may relink any
 *  presenter later; this is the capture's starting point. */
export const PIPER_TO_KOKORO: Readonly<Record<string, string>> = Object.freeze({
  "en_GB-alan-medium": "bm_george", // British male
  "en_GB-jenny_dioco-medium": "bf_emma", // British female
  "en_US-amy-medium": "af_heart", // US female
  "en_US-lessac-medium": "af_bella", // US female
  "en_US-ryan-medium": "am_michael", // US male
});

/** ON's language-model names -> LiteLLM routes (model-roles R1/R2: callers name a role). */
export const ON_LLM_TO_ROUTE: Readonly<Record<string, string>> = Object.freeze({
  "qwen36-27b": "local-large",
  "qwen36-27b:nothink": "local-large:nothink",
});

export const TTS_ROUTE = "local-tts";

export interface LedgerRow {
  table: string;
  field: string;
  status: "mapped" | "unmapped";
  to: string; // where it went, or why not
}

export interface Mapped {
  voices: (VoiceLink & Meta)[];
  presenters: (Presenter & Meta)[];
  teams: (Team & Meta)[];
  formats: (Format & Meta)[];
  ledger: LedgerRow[];
  /** ON profile id -> presenter-model id (team or format) */
  ids: Record<string, string>;
}

const idPart = (onId: string) => onId.replace(/^[a-z_]+:/, "").replace(/[^A-Za-z0-9]/g, "");

function ledgerFor(ledger: LedgerRow[], table: string, rec: OnRecord, rules: Record<string, [LedgerRow["status"], string]>, prefix = "") {
  for (const k of Object.keys(rec)) {
    const name = prefix + k;
    const rule = rules[k];
    if (!rule) throw new Error(`ON ${table}.${name} has no mapping rule: the capture refuses an unlisted field`);
    if (!ledger.some((l) => l.table === table && l.field === name)) ledger.push({ table, field: name, status: rule[0], to: rule[1] });
  }
}

const SPEAKER_PROFILE_RULES: Record<string, [LedgerRow["status"], string]> = {
  id: ["mapped", "podcast_teams.origin_ref"],
  name: ["mapped", "podcast_teams.name"],
  description: ["mapped", "podcast_teams.description"],
  speakers: ["mapped", "podcast_presenters (one per speaker, in order) + podcast_team_members.position"],
  voice_model: ["unmapped", "the profile-level default Piper voice; every speaker carries its own, which is what was voiced (kept in the archive's profile.json)"],
  tts_provider: ["mapped", `podcast_voice_links.route = '${TTS_ROUTE}' (provider/model fields map to LiteLLM routes; null in every ON profile)`],
  tts_model: ["mapped", `podcast_voice_links.route = '${TTS_ROUTE}' (null in every ON profile)`],
  created: ["unmapped", "ON's timestamp; podcast_teams.created_at is the capture time (kept in profile.json)"],
  updated: ["unmapped", "ON's timestamp (kept in profile.json)"],
};
const SPEAKER_RULES: Record<string, [LedgerRow["status"], string]> = {
  name: ["mapped", "podcast_presenters.name"],
  personality: ["mapped", "podcast_presenters.personality"],
  backstory: ["mapped", "podcast_presenters.backstory"],
  voice_model: ["mapped", "podcast_voice_links.voice (the Piper model -> its Kokoro voice, PIPER_TO_KOKORO) and route local-tts"],
  voice_id: ["unmapped", "an OpenAI voice name ON passed to Piper, which ignored it (the Piper model decided the voice); recorded in voice_links.origin_ref"],
  tts_provider: ["mapped", `podcast_voice_links.route = '${TTS_ROUTE}'`],
  tts_model: ["mapped", `podcast_voice_links.route = '${TTS_ROUTE}'`],
  tts_config: ["unmapped", "provider credentials resolved at run time by ON; never carried"],
};
const EPISODE_PROFILE_RULES: Record<string, [LedgerRow["status"], string]> = {
  id: ["mapped", "podcast_formats.origin_ref"],
  name: ["mapped", "podcast_formats.name"],
  description: ["mapped", "podcast_formats.description"],
  speaker_config: ["mapped", "podcast_formats.team_id (the team mapped from the speaker_profile of that name)"],
  default_briefing: ["mapped", "podcast_formats.briefing"],
  num_segments: ["mapped", "podcast_formats.segments"],
  language: ["mapped", "podcast_formats.language and the team's presenters' language"],
  transcript_llm: ["mapped", "podcast_formats.script_route (ON_LLM_TO_ROUTE: the model -> its LiteLLM role)"],
  outline_llm: ["unmapped", "the new pipeline has no outline stage (ON's outline/transcript generator is design-only, D6/D9); recorded in the framework study"],
  outline_provider: ["unmapped", "null in every ON profile; the outline stage is not carried"],
  outline_model: ["unmapped", "null in every ON profile; the outline stage is not carried"],
  transcript_provider: ["mapped", "podcast_formats.script_route (null in every ON profile: transcript_llm decides)"],
  transcript_model: ["mapped", "podcast_formats.script_route (null in every ON profile: transcript_llm decides)"],
  created: ["unmapped", "ON's timestamp (kept in profile.json)"],
  updated: ["unmapped", "ON's timestamp (kept in profile.json)"],
};

export interface OnInput {
  speakerProfiles: OnRecord[];
  episodeProfiles: OnRecord[];
  podcastConfigs: OnRecord[];
  models: OnRecord[]; // ON's model table: id -> name
}

export function mapOn(on: OnInput): Mapped {
  if (on.podcastConfigs.length) {
    throw new Error(`ON has ${on.podcastConfigs.length} podcast_config row(s): the table defines no fields and has no mapping - refusing to drop them`);
  }
  const modelName = new Map(on.models.map((m) => [String(m.id), String(m.name)]));
  const ledger: LedgerRow[] = [];
  const out: Mapped = { voices: [], presenters: [], teams: [], formats: [], ledger, ids: {} };
  const meta = (ref: string): Meta => ({ origin: "on-capture", originRef: ref });
  const langOfTeam = new Map<string, string>();
  for (const ep of on.episodeProfiles) langOfTeam.set(String(ep.speaker_config), String(ep.language ?? "en-US"));

  for (const sp of on.speakerProfiles) {
    ledgerFor(ledger, "speaker_profile", sp, SPEAKER_PROFILE_RULES);
    const onId = String(sp.id);
    const teamId = `on-team-${idPart(onId)}`;
    const speakers = (sp.speakers as OnRecord[]) ?? [];
    if (!speakers.length) throw new Error(`ON speaker_profile ${onId} has no speakers`);
    const presenters: (Presenter & Meta)[] = speakers.map((s, i) => {
      ledgerFor(ledger, "speaker_profile", s, SPEAKER_RULES, "speakers[*].");
      const piper = modelName.get(String(s.voice_model ?? sp.voice_model));
      if (!piper) throw new Error(`ON speaker ${s.name} of ${onId}: voice_model ${s.voice_model} is not in ON's model table`);
      const kokoro = PIPER_TO_KOKORO[piper];
      if (!kokoro) throw new Error(`ON speaker ${s.name} of ${onId}: Piper voice ${piper} has no Kokoro mapping`);
      const voice: VoiceLink & Meta = {
        id: `on-voice-${idPart(onId)}-${i}`, route: TTS_ROUTE, voice: kokoro, speed: 1.0,
        ...meta(`${onId}#speakers[${i}] voice_model=${s.voice_model} (piper ${piper}) voice_id=${s.voice_id ?? ""}`),
      };
      out.voices.push(voice);
      return {
        id: `on-presenter-${idPart(onId)}-${i}`, name: String(s.name), personality: String(s.personality ?? ""),
        backstory: String(s.backstory ?? ""), language: langOfTeam.get(String(sp.name)) ?? "en-US", voice, ...meta(`${onId}#speakers[${i}]`),
      };
    });
    out.presenters.push(...presenters);
    out.teams.push({ id: teamId, name: String(sp.name), description: String(sp.description ?? ""), presenters, ...meta(onId) });
    out.ids[onId] = teamId;
  }
  for (const ep of on.episodeProfiles) {
    ledgerFor(ledger, "episode_profile", ep, EPISODE_PROFILE_RULES);
    const onId = String(ep.id);
    const team = out.teams.find((t) => t.name === String(ep.speaker_config));
    if (!team) throw new Error(`ON episode_profile ${onId}: speaker_config ${ep.speaker_config} names no speaker_profile`);
    const llm = modelName.get(String(ep.transcript_llm)) ?? "";
    const route = ON_LLM_TO_ROUTE[llm];
    if (!route) throw new Error(`ON episode_profile ${onId}: transcript model "${llm}" has no LiteLLM route mapping`);
    const id = `on-format-${idPart(onId)}`;
    out.formats.push({
      id, name: String(ep.name), description: String(ep.description ?? ""), teamId: team.id, briefing: String(ep.default_briefing ?? ""),
      segments: Number(ep.num_segments ?? 5), language: String(ep.language ?? "en-US"), scriptRoute: route, ...meta(onId),
    });
    out.ids[onId] = id;
  }
  return out;
}

/** Profile count on both sides (the clause: the presenter-model count equals the ON profile count). */
export function profileCounts(on: OnInput, m: Mapped) {
  return {
    on: { speaker_profile: on.speakerProfiles.length, episode_profile: on.episodeProfiles.length, podcast_config: on.podcastConfigs.length },
    model: { teams: m.teams.length, formats: m.formats.length, configs: 0, presenters: m.presenters.length, voice_links: m.voices.length },
    equal: on.speakerProfiles.length + on.episodeProfiles.length + on.podcastConfigs.length === m.teams.length + m.formats.length,
  };
}
