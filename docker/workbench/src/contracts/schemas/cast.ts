// Cast editing (research-workbench redesign, rwr-cast-edit-api; slot 560): presenters, voice links, teams and formats
// a person writes, with the new presenter fields. Every enumerated kind is a registry (podcast_format_kinds,
// podcast_format_uses, podcast_prompt_modes, podcast_grounding_kinds), never a closed list here. No body has a user
// field: whose row it is comes from the identity seam, and an unknown field is refused (strict schemas).
//
// Not here, deliberately: a per-presenter model route. Choosing a model per task is phase J (models, keys, egress),
// which the operator gated; the renderer keeps the format's script route and the voice link's TTS route, both plain
// LiteLLM model names (ROUTE below: a URL cannot pass).
import { z } from "../deps.ts";
import { REGISTRY, registryValue } from "../registry.ts";
import { Iso } from "./common.ts";
import { FX } from "./fixtures.ts";

// a C0 control character (bar tab, newline, carriage return) or DEL is refused: a NUL would otherwise reach Postgres (22021)
const CLEAN = (s: string) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s);
const CLEAN_MSG = { message: "must not contain control characters" };
const text = (max: number) => z.string().max(max).refine(CLEAN, CLEAN_MSG);
const NAME = z.string().min(1).max(120).refine(CLEAN, CLEAN_MSG).refine((s) => s.trim() !== "", { message: "must not be blank" });
// A LiteLLM model name (the gateway route), never a backend URL: letters, digits and . _ : - only (no slash, no space)
export const ROUTE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const ROUTE = z.string().regex(ROUTE_RE).openapi({ description: "a LiteLLM model name (the gateway route); a URL is refused" });
const VOICE = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const LANG = z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/).openapi({ example: "en-US" });
const ID = z.string().min(1).max(200);
const SPEED = z.number().gt(0.25).lte(4);

const T = "2026-10-17T12:00:00.000Z";
export const CX = {
  voice: "cast-fx-voice",
  voiceDel: "cast-fx-voice-del",
  presenter: "cast-fx-presenter",
  presenterDel: "cast-fx-presenter-del",
  sharedPresenter: "cast-fx-shared-presenter",
  team: "cast-fx-team",
  teamDel: "cast-fx-team-del",
  sharedTeam: "cast-fx-shared-team",
  format: "cast-fx-format",
  formatDel: "cast-fx-format-del",
  sharedFormat: "cast-fx-shared-format",
};

// ── voice links ───────────────────────────────────────────────────────────────────────────────
export const CastVoice = z.object({
  id: z.string().openapi({ example: CX.voice }),
  route: ROUTE.openapi({ example: "local-tts" }),
  voice: VOICE.openapi({ example: "bm_george" }),
  speed: z.number(),
  used_by: z.array(z.object({ id: z.string(), name: z.string() })).openapi({ description: "the caller's presenters this voice voices" }),
  created_at: Iso,
  updated_at: Iso,
}).openapi("CastVoice");
export const CastVoices = z.object({ voices: z.array(CastVoice), total: z.number().int() }).openapi("CastVoices");
export const CastVoiceCreate = z.object({ route: ROUTE, voice: VOICE, speed: SPEED.optional() }).strict().openapi("CastVoiceCreate");
export const CastVoiceUpdate = z.object({ route: ROUTE.optional(), voice: VOICE.optional(), speed: SPEED.optional() }).strict()
  .openapi("CastVoiceUpdate");

// ── presenters ────────────────────────────────────────────────────────────────────────────────
export const GroundingIn = z.object({
  kind: registryValue(REGISTRY.podcastGroundingKinds, "source", "source (a source id: a shared one or one of your private ones) or topic (words)"),
  ref: z.string().min(1).max(200).refine(CLEAN, CLEAN_MSG).openapi({ example: FX.sourceActive }),
}).strict().openapi("CastGroundingIn");

export const GroundingOut = z.object({
  kind: registryValue(REGISTRY.podcastGroundingKinds, "source"),
  ref: z.string(),
  label: z.string().openapi({ description: "the source's title, or the topic's words" }),
  private: z.boolean().openapi({ description: "a private source of the caller's own (only its owner ever sees such a link)" }),
}).openapi("CastGrounding");

const PRESENTER_FIELDS = {
  personality: text(4000),
  backstory: text(8000),
  language: LANG,
  role: text(500).openapi({ description: "new (rwr-cast-edit-api): the presenter's role in the show" }),
  focus: text(1000).openapi({ description: "new: what the presenter pays attention to" }),
  stance: text(1000).openapi({ description: "new: the position the presenter argues from" }),
  tone: text(500).openapi({ description: "new: how the presenter sounds" }),
  speaking_style: text(1000).openapi({ description: "new: how the presenter talks" }),
  system_prompt: text(8000).openapi({ description: "new: the owner's own system prompt (used when system_prompt_mode is own)" }),
  system_prompt_mode: registryValue(REGISTRY.podcastPromptModes, "built", "built (from the fields; the default) or own (system_prompt)"),
};

export const CastPresenter = z.object({
  id: z.string().openapi({ example: CX.presenter }),
  name: z.string(),
  personality: z.string(),
  backstory: z.string(),
  language: z.string(),
  role: z.string().openapi({ description: "new (rwr-cast-edit-api): the presenter's role in the show" }),
  focus: z.string().openapi({ description: "new: what the presenter pays attention to" }),
  stance: z.string().openapi({ description: "new: the position the presenter argues from" }),
  tone: z.string().openapi({ description: "new: how the presenter sounds" }),
  speaking_style: z.string().openapi({ description: "new: how the presenter talks" }),
  system_prompt: z.string().openapi({ description: "new: the owner's own system prompt (used when system_prompt_mode is own)" }),
  system_prompt_mode: registryValue(REGISTRY.podcastPromptModes, "built", "built (from the fields; the default) or own (system_prompt)"),
  notes: z.string().nullable().openapi({ description: "the owner's own notes: null for anyone else" }),
  voice: z.object({ id: z.string(), route: z.string(), voice: z.string(), speed: z.number() }),
  grounded_in: z.array(GroundingOut).openapi({ description: "in order; a private source link only to its owner" }),
  teams: z.array(z.object({ id: z.string(), name: z.string() })).openapi({ description: "the owner's teams it sits in: [] for anyone else" }),
  shared: z.boolean(),
  mine: z.boolean(),
  copied_from: z.string().nullable().openapi({ description: "the presenter this one was copied from, while the caller can still see it" }),
  origin: z.string().openapi({ description: "operator | on-capture" }),
  created_at: Iso,
  updated_at: Iso,
}).openapi("CastPresenter");
export const CastPresenters = z.object({
  presenters: z.array(CastPresenter),
  total: z.number().int().openapi({ description: "every row of the scope (the caller's own, or the shared pool), not only this page" }),
}).openapi("CastPresenters");

const PRESENTER_WRITE = {
  personality: PRESENTER_FIELDS.personality.optional(),
  backstory: PRESENTER_FIELDS.backstory.optional(),
  language: LANG.optional(),
  role: PRESENTER_FIELDS.role.optional(),
  focus: PRESENTER_FIELDS.focus.optional(),
  stance: PRESENTER_FIELDS.stance.optional(),
  tone: PRESENTER_FIELDS.tone.optional(),
  speaking_style: PRESENTER_FIELDS.speaking_style.optional(),
  system_prompt: PRESENTER_FIELDS.system_prompt.optional(),
  system_prompt_mode: registryValue(REGISTRY.podcastPromptModes, "built").optional(),
  notes: text(4000).optional(),
  grounded_in: z.array(GroundingIn).max(50).optional().openapi({ description: "replaces the whole list, in order" }),
  shared: z.boolean().optional().openapi({ description: "share it to the one shared pool (Q12); refused while it links a private source" }),
};
export const CastPresenterCreate = z.object({ name: NAME, voice_id: ID, ...PRESENTER_WRITE }).strict().openapi("CastPresenterCreate");
export const CastPresenterUpdate = z.object({ name: NAME.optional(), voice_id: ID.optional(), ...PRESENTER_WRITE }).strict()
  .openapi("CastPresenterUpdate");

// ── teams ─────────────────────────────────────────────────────────────────────────────────────
export const MAX_SEATS = 26; // HOST A .. HOST Z: the presenters plus the user's own seat
export const CastTeam = z.object({
  id: z.string().openapi({ example: CX.team }),
  name: z.string(),
  description: z.string(),
  members: z.array(z.object({ position: z.number().int(), presenter_id: z.string(), name: z.string() })).openapi({ description: "in speaking order" }),
  user_seat: z.number().int().openapi({ description: "where the user sits in the speaking order: 0 (first) .. members (after the last)" }),
  seats: z.number().int().openapi({ description: "members + the user's seat; at most 26" }),
  formats: z.array(z.object({ id: z.string(), name: z.string() })).openapi({ description: "the owner's formats of this team: [] for anyone else" }),
  shared: z.boolean(),
  mine: z.boolean(),
  copied_from: z.string().nullable(),
  origin: z.string(),
  created_at: Iso,
  updated_at: Iso,
}).openapi("CastTeam");
export const CastTeams = z.object({ teams: z.array(CastTeam), total: z.number().int() }).openapi("CastTeams");
const MEMBERS = z.array(ID).min(1).max(MAX_SEATS - 1).openapi({ description: "the caller's presenter ids in speaking order (at most 25: the 26th seat is the user's)" });
const SEAT = z.number().int().min(0).max(MAX_SEATS - 1);
export const CastTeamCreate = z.object({
  name: NAME, description: text(2000).optional(), members: MEMBERS, user_seat: SEAT.optional().openapi({ description: "default: after the last presenter" }),
  shared: z.boolean().optional(),
}).strict().openapi("CastTeamCreate");
export const CastTeamUpdate = z.object({
  name: NAME.optional(), description: text(2000).optional(), members: MEMBERS.optional(), user_seat: SEAT.optional(), shared: z.boolean().optional(),
}).strict().openapi("CastTeamUpdate");

// ── formats ───────────────────────────────────────────────────────────────────────────────────
export const CastFormat = z.object({
  id: z.string().openapi({ example: CX.format }),
  name: z.string(),
  description: z.string(),
  team_id: z.string(),
  team_name: z.string(),
  briefing: z.string(),
  segments: z.number().int(),
  language: z.string(),
  script_route: z.string().openapi({ description: "the LiteLLM model name that writes the script" }),
  kind: registryValue(REGISTRY.podcastFormatKinds, "conversation"),
  use_for: z.array(registryValue(REGISTRY.podcastFormatUses, "daily")).openapi({ description: "what it is for; [] = anything" }),
  is_default: z.boolean().openapi({ description: "the owner's default format (at most one); false for anyone else" }),
  shared: z.boolean(),
  mine: z.boolean(),
  copied_from: z.string().nullable(),
  origin: z.string(),
  created_at: Iso,
  updated_at: Iso,
}).openapi("CastFormat");
export const CastFormats = z.object({ formats: z.array(CastFormat), total: z.number().int() }).openapi("CastFormats");
const FORMAT_WRITE = {
  description: text(2000).optional(),
  briefing: text(8000).optional(),
  segments: z.number().int().min(1).max(50).optional(),
  language: LANG.optional(),
  script_route: ROUTE.optional(),
  kind: registryValue(REGISTRY.podcastFormatKinds, "conversation").optional(),
  use_for: z.array(registryValue(REGISTRY.podcastFormatUses, "daily")).max(10).optional(),
  is_default: z.boolean().optional(),
  shared: z.boolean().optional(),
};
export const CastFormatCreate = z.object({ name: NAME, team_id: ID, ...FORMAT_WRITE }).strict().openapi("CastFormatCreate");
export const CastFormatUpdate = z.object({ name: NAME.optional(), team_id: ID.optional(), ...FORMAT_WRITE }).strict().openapi("CastFormatUpdate");

export const CastDeleted = z.object({ id: z.string(), deleted: z.boolean() }).openapi("CastDeleted");

// ── examples (the Dredd lab's fixtures: contract-test/fixtures.sql, owner lab-caster-0001; shared rows lab-caster-0002) ──
const voiceEx = { id: CX.voice, route: "local-tts", voice: "bm_george", speed: 1, used_by: [{ id: CX.presenter, name: "Fixture Morgan" }], created_at: T, updated_at: T };
const presenterEx = {
  id: CX.presenter, name: "Fixture Morgan", personality: "Calm and precise", backstory: "A fixture researcher", language: "en-US",
  role: "host", focus: "retrieval contracts", stance: "sceptical of unsourced claims", tone: "warm", speaking_style: "short sentences",
  system_prompt: "", system_prompt_mode: "built", notes: "fixture notes",
  voice: { id: CX.voice, route: "local-tts", voice: "bm_george", speed: 1 },
  grounded_in: [{ kind: "source", ref: FX.sourceActive, label: "Active fixture source", private: false }, { kind: "topic", ref: "retrieval", label: "retrieval", private: false }],
  teams: [{ id: CX.team, name: "Fixture cast team" }], shared: false, mine: true, copied_from: null, origin: "operator", created_at: T, updated_at: T,
};
const teamEx = {
  id: CX.team, name: "Fixture cast team", description: "One fixture presenter and the user", members: [{ position: 0, presenter_id: CX.presenter, name: "Fixture Morgan" }],
  user_seat: 1, seats: 2, formats: [{ id: CX.format, name: "Fixture cast format" }], shared: false, mine: true, copied_from: null, origin: "operator", created_at: T, updated_at: T,
};
const formatEx = {
  id: CX.format, name: "Fixture cast format", description: "A fixture format", team_id: CX.team, team_name: "Fixture cast team", briefing: "Discuss the fixture.",
  segments: 3, language: "en-US", script_route: "local-large:nothink", kind: "conversation", use_for: ["daily"], is_default: true, shared: false, mine: true,
  copied_from: null, origin: "operator", created_at: T, updated_at: T,
};
export const CASTX = {
  voice: voiceEx,
  voices: { voices: [voiceEx], total: 1 },
  voiceCreate: { route: "local-tts", voice: "af_bella", speed: 1.1 },
  voiceUpdate: { speed: 0.9 },
  presenter: presenterEx,
  presenters: { presenters: [presenterEx], total: 1 },
  presenterCreate: {
    name: "Dredd presenter", voice_id: CX.voice, personality: "Curious", role: "co-host", stance: "optimistic", tone: "bright",
    grounded_in: [{ kind: "topic", ref: "contracts" }],
  },
  presenterUpdate: { stance: "cautious", speaking_style: "asks before answering" },
  presenterCopy: { ...presenterEx, id: "presenter-00000000-0000-4000-8000-000000000001", notes: "", teams: [], copied_from: CX.sharedPresenter },
  team: teamEx,
  teams: { teams: [teamEx], total: 1 },
  teamCreate: { name: "Dredd team", description: "made by the contract run", members: [CX.presenter], user_seat: 0 },
  teamUpdate: { description: "changed by the contract run", user_seat: 1 },
  teamCopy: { ...teamEx, id: "team-00000000-0000-4000-8000-000000000001", formats: [], copied_from: CX.sharedTeam },
  format: formatEx,
  formats: { formats: [formatEx], total: 1 },
  formatCreate: { name: "Dredd format", team_id: CX.team, kind: "briefing", use_for: ["research"], segments: 2 },
  formatUpdate: { briefing: "Changed by the contract run.", kind: "debate" },
  formatCopy: { ...formatEx, id: "format-00000000-0000-4000-8000-000000000001", is_default: false, copied_from: CX.sharedFormat },
  deleted: { id: CX.presenterDel, deleted: true },
};
