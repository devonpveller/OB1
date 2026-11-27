// What the Cast and voices screen reads and writes (rwr-voices). Every call goes through lib/api.ts (the one door) for the
// subject the server resolves: this code never names a user, and a presenter's text, notes or a team's name is never written to
// storage, the page title, a URL or the browser log. Anything that is not the caller's own row is one answer here ("not
// available"): the server gives the same 404 for a missing id, someone else's row and a malformed id.
//
// Only the caller's own rows are asked for (the server's default scope, always sent as scope=mine): the shared pool is the
// share item's. Nothing here asks for a model route (the server has none: phase J), a pitch (the voice engine has none) or a
// user: a field the screen shows is a field the server stores.
import { api, ApiError, blob } from "../../lib/api";

export const LIMIT = 500;
const enc = encodeURIComponent;
const CAST = "/workbench/contract/cast";

export type Voice = { id: string; route: string; voice: string; speed: number; usedBy: { id: string; name: string }[] };
export type Grounding = { kind: string; ref: string; label: string; private: boolean };
export type Presenter = {
  id: string; name: string; personality: string; backstory: string; language: string; role: string; focus: string; stance: string; tone: string;
  speakingStyle: string; systemPrompt: string; promptMode: string; notes: string; voice: { id: string; route: string; voice: string; speed: number };
  grounded: Grounding[]; teams: { id: string; name: string }[]; origin: string;
};
export type Team = { id: string; name: string; description: string; members: { presenterId: string; name: string }[]; userSeat: number; formats: { id: string; name: string }[]; origin: string };
export type Format = {
  id: string; name: string; description: string; teamId: string; teamName: string; briefing: string; segments: number; language: string; scriptRoute: string;
  kind: string; useFor: string[]; isDefault: boolean; origin: string;
};
export type Listed<T> = { rows: T[]; total: number };

// The Kokoro voices the voice engine ships (the engine, not the database, owns this catalogue). A voice the engine does not
// have fails at the sample, with a plain sentence; a voice a presenter already has that is not listed is kept as its own choice.
export const KOKORO_VOICES: { group: string; ids: string[] }[] = [
  { group: "American, female", ids: ["af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky"] },
  { group: "American, male", ids: ["am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa"] },
  { group: "British, female", ids: ["bf_alice", "bf_emma", "bf_isabella", "bf_lily"] },
  { group: "British, male", ids: ["bm_daniel", "bm_fable", "bm_george", "bm_lewis"] },
];
// the LiteLLM route the voice engine is served under (inference/config/litellm/model_list/local.tts.yaml): used only for a person's FIRST voice
export const DEFAULT_ROUTE = "local-tts";
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;
export const MAX_SEATS = 26;
// the registries' keys (podcast_format_kinds, podcast_format_uses, podcast_prompt_modes), with what each means in a sentence
export const FORMAT_KINDS: { key: string; label: string; meaning: string }[] = [
  { key: "conversation", label: "Conversation", meaning: "the hosts talk it through together" },
  { key: "briefing", label: "Briefing", meaning: "a short run through the points" },
  { key: "debate", label: "Debate", meaning: "the hosts take sides" },
  { key: "interview", label: "Interview", meaning: "one host asks, the others answer" },
];
export const FORMAT_USES: { key: string; label: string }[] = [
  { key: "daily", label: "the daily episode" }, { key: "research", label: "a research run" }, { key: "document", label: "a document" }, { key: "discussion", label: "a live discussion" },
];

const str = (x: unknown) => (typeof x === "string" ? x : "");
const num = (x: unknown, d = 0) => (typeof x === "number" && Number.isFinite(x) ? x : d);
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const pairs = (x: unknown) => arr(x).map((o: any) => ({ id: str(o?.id), name: str(o?.name) })).filter((o) => o.id);

// A 200 that is not the expected JSON (a login page, a wrong shape) is a FAILED read, never an empty list.
async function list<T>(kind: string, key: string, map: (r: any) => T): Promise<Listed<T>> {
  const { data } = await api("GET", `${CAST}/${kind}?scope=mine&limit=${LIMIT}`);
  if (!data || typeof data !== "object" || !Array.isArray((data as any)[key])) throw new Error("unexpected answer: no " + key);
  const rows = (data as any)[key].map(map).filter((r: any) => r.id);
  return { rows, total: Math.max(rows.length, num((data as any).total, rows.length)) };
}

export const mapVoice = (v: any): Voice => ({ id: str(v?.id), route: str(v?.route), voice: str(v?.voice), speed: num(v?.speed, 1), usedBy: pairs(v?.used_by) });
export const mapPresenter = (p: any): Presenter => ({
  id: str(p?.id), name: str(p?.name), personality: str(p?.personality), backstory: str(p?.backstory), language: str(p?.language), role: str(p?.role), focus: str(p?.focus),
  stance: str(p?.stance), tone: str(p?.tone), speakingStyle: str(p?.speaking_style), systemPrompt: str(p?.system_prompt), promptMode: str(p?.system_prompt_mode) || "built",
  notes: str(p?.notes), voice: { id: str(p?.voice?.id), route: str(p?.voice?.route), voice: str(p?.voice?.voice), speed: num(p?.voice?.speed, 1) },
  grounded: arr(p?.grounded_in).map((g: any) => ({ kind: str(g?.kind), ref: str(g?.ref), label: str(g?.label) || str(g?.ref), private: g?.private === true })),
  teams: pairs(p?.teams), origin: str(p?.origin),
});
export const mapTeam = (x: any): Team => ({
  id: str(x?.id), name: str(x?.name), description: str(x?.description),
  members: arr(x?.members).slice().sort((a: any, b: any) => num(a?.position) - num(b?.position)).map((m: any) => ({ presenterId: str(m?.presenter_id), name: str(m?.name) })),
  userSeat: num(x?.user_seat), formats: pairs(x?.formats), origin: str(x?.origin),
});
export const mapFormat = (f: any): Format => ({
  id: str(f?.id), name: str(f?.name), description: str(f?.description), teamId: str(f?.team_id), teamName: str(f?.team_name), briefing: str(f?.briefing),
  segments: num(f?.segments, 1), language: str(f?.language), scriptRoute: str(f?.script_route), kind: str(f?.kind), useFor: arr(f?.use_for).map(str),
  isDefault: f?.is_default === true, origin: str(f?.origin),
});

export const readVoices = () => list("voices", "voices", mapVoice);
export const readPresenters = () => list("presenters", "presenters", mapPresenter);
export const readTeams = () => list("teams", "teams", mapTeam);
export const readFormats = () => list("formats", "formats", mapFormat);

// ---- writes. Each answers one plain sentence; a refusal never speaks of anyone else.
export type Result<T = undefined> = { ok: true; message: string; row?: T } | { ok: false; message: string; notAvailable?: boolean };

function refusal(e: unknown, fallback: string): { ok: false; message: string; notAvailable?: boolean } {
  if (e instanceof ApiError) {
    const msg = str((e.body as any)?.error);
    if (e.status === 404) return { ok: false, message: "That is not available any more.", notAvailable: true };
    if (e.status === 409) return { ok: false, message: msg ? cap(msg) : "That is not possible right now." };
    if (e.status === 422) return { ok: false, message: msg ? cap(msg) : "One of those values is not accepted." };
    if (e.status === 400) return { ok: false, message: msg && msg !== "invalid request" ? cap(msg) : "One of those values is not accepted: check the fields and try again." };
  }
  return { ok: false, message: fallback };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".");

async function write<T>(method: "POST" | "PATCH" | "DELETE", url: string, body: unknown, map: (r: any) => T, fallback: string, done: string): Promise<Result<T>> {
  try {
    const { data } = await api(method, url, body);
    return { ok: true, message: done, row: map(data) };
  } catch (e) { return refusal(e, fallback); }
}

export type PresenterFields = Partial<{
  name: string; personality: string; backstory: string; language: string; role: string; focus: string; stance: string; tone: string; speaking_style: string;
  system_prompt: string; system_prompt_mode: string; notes: string; voice_id: string;
}>;

export const createVoice = (b: { route: string; voice: string; speed: number }) => write("POST", `${CAST}/voices`, b, mapVoice, "Could not set up the voice. Try again.", "Voice set up.");
export const updateVoice = (id: string, b: { voice?: string; speed?: number }) => write("PATCH", `${CAST}/voices/${enc(id)}`, b, mapVoice, "Could not change the voice. Try again.", "Voice changed.");
export const deleteVoice = (id: string) => write("DELETE", `${CAST}/voices/${enc(id)}`, undefined, () => undefined, "Could not remove the voice.", "Voice removed.");

export const createPresenter = (b: PresenterFields & { name: string; voice_id: string }) => write("POST", `${CAST}/presenters`, b, mapPresenter, "Could not create the presenter. Try again.", "Presenter created.");
export const updatePresenter = (id: string, b: PresenterFields) => write("PATCH", `${CAST}/presenters/${enc(id)}`, b, mapPresenter, "Could not save the presenter. Try again.", "Saved.");
export const deletePresenter = (id: string) => write("DELETE", `${CAST}/presenters/${enc(id)}`, undefined, () => undefined, "Could not delete the presenter. Try again.", "Presenter deleted.");

export const createTeam = (b: { name: string; description?: string; members: string[]; user_seat: number }) => write("POST", `${CAST}/teams`, b, mapTeam, "Could not create the team. Try again.", "Team created.");
export const updateTeam = (id: string, b: { name?: string; description?: string; members?: string[]; user_seat?: number }) => write("PATCH", `${CAST}/teams/${enc(id)}`, b, mapTeam, "Could not save the team. Try again.", "Saved.");
export const deleteTeam = (id: string) => write("DELETE", `${CAST}/teams/${enc(id)}`, undefined, () => undefined, "Could not delete the team. Try again.", "Team deleted.");

export type FormatFields = Partial<{
  name: string; team_id: string; description: string; briefing: string; segments: number; language: string; script_route: string; kind: string; use_for: string[]; is_default: boolean;
}>;
export const createFormat = (b: FormatFields & { name: string; team_id: string }) => write("POST", `${CAST}/formats`, b, mapFormat, "Could not create the format. Try again.", "Format created.");
export const updateFormat = (id: string, b: FormatFields) => write("PATCH", `${CAST}/formats/${enc(id)}`, b, mapFormat, "Could not save the format. Try again.", "Saved.");
export const deleteFormat = (id: string) => write("DELETE", `${CAST}/formats/${enc(id)}`, undefined, () => undefined, "Could not delete the format. Try again.", "Format deleted.");

// ---- the sample: ONE request to the workbench's sample route (the workbench asks the podcast service, which speaks through the
// gateway). Never a direct address of a voice engine: lib/api.ts refuses anything that is not /workbench/*.
export type SampleResult = { ok: true; blob: Blob } | { ok: false; message: string };
export async function fetchSample(voiceId: string): Promise<SampleResult> {
  try {
    const r = await blob("POST", `${CAST}/voices/${enc(voiceId)}/sample`);
    if (!r.type.toLowerCase().startsWith("audio/") || r.blob.size === 0) return { ok: false, message: "The server did not send a sample. Try again." };
    return { ok: true, blob: r.blob };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 404) return { ok: false, message: "This voice is not available." };
      if (e.status === 503) return { ok: false, message: "Samples are not set up on this server yet." };
      if (e.status === 429) return { ok: false, message: "Wait a moment before the next sample." };
      if (e.status === 502) return { ok: false, message: "The voice engine did not answer. Try again in a moment." };
    }
    return { ok: false, message: "Could not get a sample. Try again." };
  }
}
