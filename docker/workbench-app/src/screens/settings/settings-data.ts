// Settings (rwr-settings-shell): what the screen reads and writes, all through lib/api.ts and /workbench/settings.
// The SERVER decides who is an admin and what an admin sees: GET /workbench/settings answers the caller's own (user-tier)
// settings and `admin: true|false`; the shared settings are asked for (GET /workbench/settings/admin) only when that
// says true, and the server refuses everyone else, so nothing here hides an admin key - it never receives one.
// Every key says who can see it by `tag`, a column of its registry row (slot 550); the legend below names the four tags.
import { api, ApiError } from "../../lib/api";

export type Tag = "only_you" | "on_server" | "cloud" | "admin_all";

// The legend, in the order the screen shows it. `cloud` is defined so a key that ever carries it is drawn honestly, but
// the registry refuses it on every key until the models / keys / egress phase: no setting carries it today.
export const LEGEND: { tag: Tag; label: string; means: string }[] = [
  { tag: "only_you", label: "Only you", means: "Kept with your account. No other person is shown it." },
  { tag: "on_server", label: "Stays on this server", means: "A service on this server reads it on your behalf. It does not leave the server." },
  { tag: "cloud", label: "Sent to a cloud provider", means: "The value leaves this server for a cloud provider. No setting carries this tag yet." },
  { tag: "admin_all", label: "Admin changes it for everyone", means: "One value for everybody. Only an admin sees and changes it here." },
];
export const TAG_LABEL: Record<string, string> = Object.fromEntries(LEGEND.map((l) => [l.tag, l.label]));

export type Setting = {
  key: string;
  tier: "user" | "admin";
  type: string;
  section: string;
  position: number;
  label: string;
  help: string;
  default: unknown;
  env: string | null;
  read_by?: string; // which service or screen reads it, and when (the registry's words)
  validation: Record<string, unknown>;
  editable: boolean;
  tag: string | null;
  ceiling?: number; // rwr-settings-defaults: the highest value the admin's limit allows this key (only a key that has one)
  ceiling_phrase?: string; // what that ceiling is, in the server's words
  value: unknown;
  is_default: boolean;
  version: number;
};

export type Loaded = { admin: boolean; user: Setting[]; shared: Setting[] };

// A section of the list: what it is called and what it says about itself. A section the registry has but this table does
// not know still shows (under its own name), so a later item's keys are never silently dropped.
const SECTION_TITLE: Record<string, string> = {
  "user:ui": "Start screen",
  "user:refinery": "My ideas",
  "user:research": "Research defaults",
  "user:library": "Library",
  "user:digest": "Daily digest and podcast",
  "admin:digest": "Podcast archive",
  "admin:research": "Research and curator limits",
};
export const sectionTitle = (tier: "user" | "admin", section: string) => SECTION_TITLE[`${tier}:${section}`] ?? section;

// Keys the app keeps for itself (the locked / last document, Recently viewed): identifiers it writes as you work, not
// preferences, so the frame does not offer them as a form.
export const isAppState = (s: Setting) => s.type === "ref_list" || s.validation?.ref === "doc_path";

// The Library's keys sit in the registry's 'ui' section next to the start screen; the screen draws them as their own section.
export const sectionOf = (s: Setting) => (s.tier === "user" && s.key.startsWith("library.") ? "library" : s.section);
// A hidden-suggestions list is app state (its own control below), so the generic form does not draw it.
export const HIDDEN_SUGGESTIONS = "library.hidden_suggestions";

export type Section = { id: string; tier: "user" | "admin"; section: string; title: string; keys: Setting[] };
export function sectionsOf(tier: "user" | "admin", list: Setting[]): Section[] {
  const by = new Map<string, Setting[]>();
  for (const s of list) {
    if (s.tier !== tier || (tier === "user" && isAppState(s) && s.key !== HIDDEN_SUGGESTIONS)) continue;
    const sec = sectionOf(s);
    by.set(sec, [...(by.get(sec) ?? []), s]);
  }
  return [...by.entries()].map(([section, keys]) => ({
    id: `${tier}-${section}`, tier, section, title: sectionTitle(tier, section),
    keys: keys.sort((a, b) => a.position - b.position || a.key.localeCompare(b.key)),
  }));
}

// A key no screen or service reads yet says so, in the registry's own words ("... (kept now, applied when the Library opens)"): the
// row shows "Kept now; applied when the Library opens." so a stored value never looks like it does something. null = it is applied.
export function notAppliedNote(s: Pick<Setting, "read_by">): string | null {
  const m = /kept now, applied when ([^)]+?) opens\)/i.exec(s.read_by ?? "");
  return m ? `Kept now; applied when ${m[1]} opens.` : null;
}

const URL = "/workbench/settings";
const keyUrl = (key: string, admin: boolean) => `${URL}${admin ? "/admin" : ""}/${encodeURIComponent(key)}`;

export async function loadSettings(): Promise<Loaded> {
  const { data } = await api<{ admin?: boolean; settings?: Setting[] }>("GET", URL);
  const admin = data.admin === true; // the server's answer, never a guess
  const user = Array.isArray(data.settings) ? data.settings : [];
  let shared: Setting[] = [];
  if (admin) {
    const r = await api<{ settings?: Setting[] }>("GET", `${URL}/admin`);
    shared = Array.isArray(r.data.settings) ? r.data.settings : [];
  }
  return { admin, user, shared };
}

export type SaveResult = { ok: true; row: Setting } | { ok: false; status: number; message: string };
const fail = (e: unknown): SaveResult =>
  e instanceof ApiError ? { ok: false, status: e.status, message: e.message } : { ok: false, status: 0, message: "could not reach the server" };

// One write, versioned: the version is the one this screen last read, so a change made on another browser meanwhile is
// refused (409) instead of overwritten; the answer is the row as stored.
export async function saveSetting(s: Setting, value: unknown): Promise<SaveResult> {
  try {
    const { data } = await api<Setting>("PUT", keyUrl(s.key, s.tier === "admin"), s.tier === "admin" ? { value } : { value, version: s.version });
    return { ok: true, row: { ...s, ...data } };
  } catch (e) {
    return fail(e);
  }
}

// Back to the default: a user key is deleted at the version last read (a delete is itself a version).
export async function resetSetting(s: Setting): Promise<SaveResult> {
  try {
    const q = s.tier === "admin" ? "" : `?version=${s.version}`;
    const { data } = await api<Setting>("DELETE", keyUrl(s.key, s.tier === "admin") + q);
    return { ok: true, row: { ...s, ...data } };
  } catch (e) {
    return fail(e);
  }
}

// ---- the admin research limits (rwr-settings-defaults): named presets inside fixed ranges, never a number typed in ----
export type LimitValue = { key: string; label: string; value: unknown; is_default: boolean; min: number | null; max: number | null };
export type LimitPreset = { preset: string; label: string; help: string; values: { key: string; label: string; value: unknown }[] };
export type LimitGroup = { group: string; label: string; help: string; current: string; presets: LimitPreset[]; values: LimitValue[] };
export type LogLine = { id: number; at: string; actor: string; action: string; key: string; old_value: unknown; new_value: unknown; group: string | null; preset: string | null };

const LIMITS = `${URL}/admin/limits`;
export async function loadLimits(): Promise<LimitGroup[]> {
  const { data } = await api<{ groups?: LimitGroup[] }>("GET", LIMITS);
  return Array.isArray(data.groups) ? data.groups : [];
}
export type LimitResult = { ok: true; group: LimitGroup } | { ok: false; status: number; message: string };
const limitFail = (e: unknown): LimitResult =>
  e instanceof ApiError ? { ok: false, status: e.status, message: e.message } : { ok: false, status: 0, message: "could not reach the server" };
export async function applyPreset(group: string, preset: string): Promise<LimitResult> {
  try {
    const { data } = await api<LimitGroup>("PUT", `${LIMITS}/${encodeURIComponent(group)}`, { preset });
    return { ok: true, group: data };
  } catch (e) {
    return limitFail(e);
  }
}
export async function resetGroup(group: string): Promise<LimitResult> {
  try {
    const { data } = await api<LimitGroup>("DELETE", `${LIMITS}/${encodeURIComponent(group)}`);
    return { ok: true, group: data };
  } catch (e) {
    return limitFail(e);
  }
}
export async function loadLog(): Promise<LogLine[]> {
  const { data } = await api<{ log?: LogLine[] }>("GET", `${LIMITS}/log?limit=30`);
  return Array.isArray(data.log) ? data.log : [];
}

// The server's own rules for a typed number (the registry's min / max, a whole number for an integer, and the admin ceiling for a
// key that has one), in the server's words, so the field refuses what the server would refuse before it is sent. A null is fine.
export function numberProblem(s: Setting, n: number): string | null {
  if (!Number.isFinite(n)) return "must be a number";
  if (s.type === "integer" && n !== Math.trunc(n)) return "must be a whole number";
  const v = s.validation ?? {};
  if (typeof v.min === "number" && n < v.min) return `must be at least ${v.min}`;
  if (typeof v.max === "number" && n > v.max) return `must be at most ${v.max}`;
  if (typeof s.ceiling === "number" && n > s.ceiling) return `must be at most ${s.ceiling}${s.ceiling_phrase ? ` (${s.ceiling_phrase})` : ""}`;
  return null;
}

// What a value looks like in words (read-only rows, the default beside a field).
export function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "not set";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${String(x)}`).join(", ");
  return String(v);
}
