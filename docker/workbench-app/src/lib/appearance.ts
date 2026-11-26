// Appearance (rwr-appearance): how the workbench looks for ONE person, kept with the ACCOUNT so it follows them to every
// device. Five user-tier settings keys (slot 700, section 'ui', tag only_you): ui.theme, ui.accent, ui.density, ui.text_size
// and ui.saved_themes (at most 10). They are read and written through /workbench/settings for the identity seam's subject
// only; this file never names an owner and talks to the back end only through lib/api.ts.
//
// What is applied: data-theme (explicit light / dark; none = follow the device), data-accent, data-density and
// data-text-size on <html>; no attribute means the default. The CSS is theme/tokens.css, accents.css and look.css.
//
// What the browser keeps: ONLY `workbench.theme` (lib/theme.ts), a first-paint cache so the page does not flash light before
// the account answers. The account's value overwrites it as soon as it is read (an account with no stored theme clears it).
// Nothing else is kept in the browser, and no private name (a saved theme's name) is ever put in the page title.
//
// A value read from the account is never trusted: a stored value outside the offered lists, of another type, or for a choice
// that no longer exists reads as the default for that key (parseLook / parseSaved), never as an error.
//
// The person changing under a mounted page (no reload): resetAppearance() forgets everything held for the earlier person and
// bumps an epoch, so a read or a save that was in flight for them lands on nothing and never writes to the next person.
import { useSyncExternalStore } from "react";
import { api, ApiError } from "./api";
import { applyTheme, readTheme, type ThemeChoice } from "./theme";

export const APPEARANCE_KEYS = {
  theme: "ui.theme", accent: "ui.accent", density: "ui.density", textSize: "ui.text_size", saved: "ui.saved_themes",
} as const;
type LookKey = "theme" | "accent" | "density" | "textSize";
const LOOK_KEYS: LookKey[] = ["theme", "accent", "density", "textSize"];

// The offered choices: the registry's lists (init-appearance.sql, slot 700). The test fails if the accent list drifts.
export const THEMES = [
  { id: "light", label: "Light", means: "Light all the time." },
  { id: "dark", label: "Dark", means: "Dark all the time." },
  { id: "system", label: "System", means: "Follows your device: light by day, dark if your device is dark." },
] as const;
export const ACCENTS = [
  { id: "teal", label: "Teal" }, { id: "indigo", label: "Indigo" }, { id: "amber", label: "Amber" }, { id: "rose", label: "Rose" }, { id: "slate", label: "Slate" },
] as const;
export const DENSITIES = [
  { id: "comfortable", label: "Comfortable", means: "Comfortable: roomier rows." },
  { id: "compact", label: "Compact", means: "Compact: tighter rows in Documents, Research and the Library." },
] as const;
export const TEXT_SIZES = ["13", "14", "15", "16", "18"] as const;

export type AccentId = (typeof ACCENTS)[number]["id"];
export type Density = (typeof DENSITIES)[number]["id"];
export type TextSize = (typeof TEXT_SIZES)[number];
export interface Look { theme: ThemeChoice; accent: AccentId; density: Density; textSize: TextSize }
export interface SavedTheme { name: string; look: Look }

export const DEFAULT_LOOK: Look = { theme: "system", accent: "teal", density: "comfortable", textSize: "14" };
export const SAVED_CAP = 10; // the coordinator's default; the registry's validation.max_items is the guard
export const NAME_MAX = 40;

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback;
const themeOf = (v: unknown) => oneOf(THEMES.map((t) => t.id) as ThemeChoice[], v, DEFAULT_LOOK.theme);
const accentOf = (v: unknown) => oneOf(ACCENTS.map((a) => a.id) as AccentId[], v, DEFAULT_LOOK.accent);
const densityOf = (v: unknown) => oneOf(DENSITIES.map((d) => d.id) as Density[], v, DEFAULT_LOOK.density);
const sizeOf = (v: unknown) => oneOf(TEXT_SIZES, v, DEFAULT_LOOK.textSize);

// ── what is read, made safe ──
interface Row { key: string; value?: unknown; is_default?: boolean; version?: number }
const rowOf = (rows: Row[], key: string) => rows.find((r) => r && r.key === key);
const valueOf = (rows: Row[], key: string): unknown => { const r = rowOf(rows, key); return r && r.is_default !== true ? r.value : undefined; };

export function parseLook(rows: Row[]): Look {
  return {
    theme: themeOf(valueOf(rows, APPEARANCE_KEYS.theme)),
    accent: accentOf(valueOf(rows, APPEARANCE_KEYS.accent)),
    density: densityOf(valueOf(rows, APPEARANCE_KEYS.density)),
    textSize: sizeOf(valueOf(rows, APPEARANCE_KEYS.textSize)),
  };
}

// C0 + DEL + C1 controls, the bidi controls and the zero-width / invisible characters (the registry's rule for text)
const BAD_CHAR = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
const CREDENTIAL = /(^|[^A-Za-z0-9])(sk-|sk_|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|AIza|ya29\.|eyJ)|(^|[^a-z0-9])bearer\s/i;

// why a saved theme's name is refused, or null
export function nameProblem(name: unknown): string | null {
  if (typeof name !== "string" || name.trim() === "") return "Give the theme a name.";
  if (name.length > NAME_MAX) return `A name is at most ${NAME_MAX} characters.`;
  if (BAD_CHAR.test(name)) return "A name has no control or invisible characters.";
  if (CREDENTIAL.test(name)) return "That looks like a credential; secrets are not stored in a name.";
  return null;
}

export function parseSaved(v: unknown): SavedTheme[] {
  if (!Array.isArray(v)) return [];
  const out: SavedTheme[] = [];
  const seen = new Set<string>();
  for (const e of v) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const o = e as Record<string, unknown>;
    if (nameProblem(o.name) !== null) continue;
    const name = (o.name as string).trim();
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, look: { theme: themeOf(o.theme), accent: accentOf(o.accent), density: densityOf(o.density), textSize: sizeOf(o.text_size) } });
    if (out.length === SAVED_CAP) break;
  }
  return out;
}
const toWire = (list: SavedTheme[]) => list.map((t) => ({ name: t.name, theme: t.look.theme, accent: t.look.accent, density: t.look.density, text_size: t.look.textSize }));

// ── what is applied to the page ──
function setAttr(name: string, value: string | null) {
  const el = document.documentElement;
  if (value === null) el.removeAttribute(name); else el.setAttribute(name, value);
}
export function applyLook(l: Look) {
  applyTheme(l.theme); // data-theme + the localStorage cache (guarded: storage may be unavailable)
  setAttr("data-accent", l.accent === DEFAULT_LOOK.accent ? null : l.accent);
  setAttr("data-density", l.density === DEFAULT_LOOK.density ? null : l.density);
  setAttr("data-text-size", l.textSize === DEFAULT_LOOK.textSize ? null : l.textSize);
}

// ── the store: this person's look, in memory ──
type Status = "idle" | "loading" | "ready" | "failed";
export interface Snapshot { look: Look; saved: SavedTheme[]; status: Status; error: string | null; stored: Record<LookKey, boolean> }
const KEY_OF: Record<LookKey, string> = { theme: APPEARANCE_KEYS.theme, accent: APPEARANCE_KEYS.accent, density: APPEARANCE_KEYS.density, textSize: APPEARANCE_KEYS.textSize };
const WIRE_OF: Record<LookKey, (l: Look) => string> = { theme: (l) => l.theme, accent: (l) => l.accent, density: (l) => l.density, textSize: (l) => l.textSize };

let epoch = 0;
let subject: string | null = null;
let snap: Snapshot = fresh();
let versions: Record<string, number> = {};
let touched: Record<string, number> = {};
let chains: Record<string, Promise<unknown>> = {};
const subs = new Set<() => void>();
function fresh(): Snapshot {
  return { look: { ...DEFAULT_LOOK, theme: readTheme() }, saved: [], status: "idle", error: null, stored: { theme: false, accent: false, density: false, textSize: false } };
}
const emit = () => { snap = { ...snap }; subs.forEach((f) => f()); };
export const getAppearance = (): Snapshot => snap;
export const appearanceEpoch = (): number => epoch;
export function subscribeAppearance(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }
export function useAppearance(): Snapshot { return useSyncExternalStore(subscribeAppearance, getAppearance); }

// Forget everything held for the person on this page and show the defaults. LOCAL ONLY: nothing is written to any account.
// The browser's theme cache goes too (it was the earlier person's).
export function resetAppearance() {
  epoch++;
  subject = null;
  versions = {}; touched = {}; chains = {};
  snap = { look: { ...DEFAULT_LOOK }, saved: [], status: "idle", error: null, stored: { theme: false, accent: false, density: false, textSize: false } };
  applyLook(DEFAULT_LOOK);
  subs.forEach((f) => f());
}

// The shell (and the Settings screen) say who is on the page; this is idempotent. A different person than the one held resets
// first; then the account is read.
export function syncAppearanceSubject(next: string | null): void {
  if (next === subject) return;
  if (subject !== null) resetAppearance();
  subject = next;
  if (next !== null) void loadAppearance();
}

const message = (e: unknown, d: string) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : d);

export async function loadAppearance(): Promise<void> {
  const my = epoch;
  snap.status = "loading"; emit();
  try {
    const { data } = await api<{ settings?: Row[] }>("GET", "/workbench/settings");
    if (epoch !== my) return;
    const rows = Array.isArray(data.settings) ? data.settings : [];
    for (const r of rows) if (r && typeof r.key === "string" && Object.values(APPEARANCE_KEYS).includes(r.key as never)) versions[r.key] = typeof r.version === "number" ? r.version : 0;
    const look = parseLook(rows);
    const next: Look = { ...snap.look };
    const stored = { ...snap.stored };
    for (const k of LOOK_KEYS) {
      if (touched[KEY_OF[k]]) continue; // changed on this page since: newer than the read
      (next as any)[k] = look[k];
      stored[k] = valueOf(rows, KEY_OF[k]) !== undefined;
    }
    snap = { ...snap, look: next, stored, saved: touched[APPEARANCE_KEYS.saved] ? snap.saved : parseSaved(valueOf(rows, APPEARANCE_KEYS.saved)), status: "ready", error: null };
    applyLook(next);
    subs.forEach((f) => f());
  } catch (e) {
    if (epoch !== my) return;
    snap.status = "failed"; snap.error = message(e, "your appearance could not be read"); emit();
  }
}

// one queued write per key, so two quick choices never refuse each other
function push(key: string, run: () => Promise<void>): Promise<void> {
  const prev = chains[key] ?? Promise.resolve();
  const next = prev.then(run, run);
  chains[key] = next;
  return next;
}
async function write(key: string, value: unknown | null): Promise<number> {
  const version = versions[key] ?? 0;
  const url = `/workbench/settings/${encodeURIComponent(key)}`;
  if (value === null) {
    const { data } = await api<{ version?: number }>("DELETE", `${url}?version=${version}`);
    return typeof data.version === "number" ? data.version : version + 1;
  }
  const { data } = await api<{ version?: number }>("PUT", url, { value, version });
  return typeof data.version === "number" ? data.version : version + 1;
}
const STALE = "Changed on another browser. Showing the latest values.";
// a refused write: stale (409) = another browser wrote first: read the account again; any other = say why, keep the page's
// choice for this device
async function failed(my: number, e: unknown, key: string) {
  if (epoch !== my) return;
  if (e instanceof ApiError && e.status === 409) {
    for (const k of Object.keys(touched)) delete touched[k];
    await loadAppearance();
    if (epoch === my) { snap.error = STALE; emit(); }
    return;
  }
  snap.error = `Not saved (${key}): ${message(e, "could not reach the server")}. It applies on this device only until it is saved.`;
  emit();
}

// Change some of the four look choices: applied at once, then saved (a value equal to the default is still a stored choice).
// Resolves true when stored.
export function chooseLook(patch: Partial<Look>): Promise<boolean> {
  const my = epoch;
  const next: Look = { ...snap.look };
  const keys: LookKey[] = [];
  for (const k of LOOK_KEYS) {
    if (!(k in patch) || patch[k] === undefined) continue;
    const v = k === "theme" ? themeOf(patch[k]) : k === "accent" ? accentOf(patch[k]) : k === "density" ? densityOf(patch[k]) : sizeOf(patch[k]);
    (next as any)[k] = v;
    keys.push(k);
  }
  snap = { ...snap, look: next, error: null };
  for (const k of keys) touched[KEY_OF[k]] = (touched[KEY_OF[k]] ?? 0) + 1;
  applyLook(next);
  emit();
  return Promise.all(keys.map((k) => push(KEY_OF[k], async () => {
    if (epoch !== my) return;
    try {
      const v = await write(KEY_OF[k], WIRE_OF[k](next));
      if (epoch !== my) return;
      versions[KEY_OF[k]] = v;
      snap.stored = { ...snap.stored, [k]: true };
      emit();
    } catch (e) { await failed(my, e, KEY_OF[k]); throw e; }
  }).then(() => true, () => false))).then((r) => r.every(Boolean));
}

// ── saved themes ──
async function writeSaved(my: number, list: SavedTheme[]): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const v = await write(APPEARANCE_KEYS.saved, toWire(list));
    if (epoch !== my) return { ok: false, message: "The person changed." };
    versions[APPEARANCE_KEYS.saved] = v;
    touched[APPEARANCE_KEYS.saved] = (touched[APPEARANCE_KEYS.saved] ?? 0) + 1;
    snap = { ...snap, saved: list, error: null };
    emit();
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) { await failed(my, e, APPEARANCE_KEYS.saved); return { ok: false, message: STALE }; }
    const m = `Not saved: ${message(e, "could not reach the server")}`;
    if (epoch === my) { snap.error = m; emit(); }
    return { ok: false, message: m };
  }
}

// Save the current look under a name. Refused before any request: a bad name, a repeated name, the cap.
export async function saveTheme(name: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const my = epoch;
  const refuse = (m: string) => { snap.error = m; emit(); return { ok: false as const, message: m }; };
  const problem = nameProblem(name);
  if (problem) return refuse(problem);
  const clean = name.trim();
  if (snap.saved.some((t) => t.name.toLowerCase() === clean.toLowerCase())) return refuse(`You already have a theme called "${clean}".`);
  if (snap.saved.length >= SAVED_CAP) return refuse(`You can keep ${SAVED_CAP} saved themes. Delete one first.`);
  let res: { ok: true } | { ok: false; message: string } = { ok: false, message: "not saved" };
  await push(APPEARANCE_KEYS.saved, async () => {
    if (epoch !== my) return;
    res = await writeSaved(my, [...snap.saved, { name: clean, look: { ...snap.look } }]);
  });
  return res;
}
export async function deleteSavedTheme(name: string): Promise<boolean> {
  const my = epoch;
  if (!snap.saved.some((t) => t.name === name)) return false;
  let ok = false;
  await push(APPEARANCE_KEYS.saved, async () => {
    if (epoch !== my) return;
    ok = (await writeSaved(my, snap.saved.filter((t) => t.name !== name))).ok;
  });
  return ok;
}
// Apply a saved theme: its four choices become the current look (and are stored). A theme another device has since deleted is
// not applied: the account is read again and the person is told.
export async function applySavedTheme(name: string): Promise<boolean> {
  const my = epoch;
  const t = snap.saved.find((s) => s.name === name);
  if (!t) return false;
  // is it still there? (another device may have deleted it): one read, then apply
  try {
    const { data } = await api<{ settings?: Row[] }>("GET", "/workbench/settings");
    if (epoch !== my) return false;
    const rows = Array.isArray(data.settings) ? data.settings : [];
    const now = parseSaved(valueOf(rows, APPEARANCE_KEYS.saved));
    if (!now.some((s) => s.name === name)) {
      versions[APPEARANCE_KEYS.saved] = rowOf(rows, APPEARANCE_KEYS.saved)?.version ?? 0;
      snap = { ...snap, saved: now, error: `"${name}" is no longer in your saved themes (it was changed on another device).` };
      emit();
      return false;
    }
  } catch { /* the read failed: apply what this page holds; the writes below report any trouble */ }
  return chooseLook(t.look);
}

// "Workbench default": every stored look choice goes back to the default (a delete is versioned) and the look is applied at once.
// The Settings section also puts the start screen back (it is a registry row the generic frame owns). Saved themes are the
// person's own list and stay.
export async function resetToWorkbenchDefault(): Promise<boolean> {
  const my = epoch;
  const keys = LOOK_KEYS.filter((k) => snap.stored[k]);
  snap = { ...snap, look: { ...DEFAULT_LOOK }, error: null };
  for (const k of LOOK_KEYS) touched[KEY_OF[k]] = (touched[KEY_OF[k]] ?? 0) + 1;
  applyLook(DEFAULT_LOOK);
  emit();
  const results = await Promise.all(keys.map((k) => push(KEY_OF[k], async () => {
    if (epoch !== my) return;
    try {
      versions[KEY_OF[k]] = await write(KEY_OF[k], null);
      snap.stored = { ...snap.stored, [k]: false };
      emit();
    } catch (e) { await failed(my, e, KEY_OF[k]); throw e; }
  }).then(() => true, () => false)));
  return results.every(Boolean);
}
