// The per-person front-end state the shell shows, kept with the ACCOUNT (rwr-ui-state-keys): the LOCKED document,
// the LAST document, the start screen and the Recently viewed list. They are four user-tier settings keys of the
// workbench (slot 490: ui.locked_document, ui.last_document, ui.start_screen, library.recent), so they follow the
// signed-in subject (or the default subject while sign-in is off) to any browser. The server decides whose they
// are (the identity seam); this file never names an owner and talks to the back end only through lib/api.ts.
//
// Two layers:
//  1. the SHELL SEAM (rwr-shell-nav's signatures, unchanged): typed synchronous getters, setters, subscribeState,
//     resetState, DocRef. The page reads the in-memory copy; a setter updates it at once and writes the account in
//     the background (one queued, versioned write per key, so two quick calls never refuse each other).
//  2. the account primitives: loadUiState / saveX / isLiveDocument / resolveDocument and the useUiState hook.
//
// Nothing is kept in the browser: no localStorage, cookie or console output. The account holds IDENTIFIERS only
// (a document path, a screen name, {kind, id} pairs); a title is fetched, shown from memory, never stored or logged.
//
// resetState() (a different person on this page, and tests) clears ONLY the local copy: it never writes to the
// account (not even null), it drops every queued write of the previous person, and it bumps the epoch so a
// request already in flight can no longer change what the page shows and an Undo captured before the switch
// (stateEpoch() unchanged?) can tell it must not restore the previous person's document.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api, ApiError } from "./api";

export const UI_KEYS = {
  lockedDocument: "ui.locked_document",
  lastDocument: "ui.last_document",
  startScreen: "ui.start_screen",
  recent: "library.recent",
} as const;
export type UiKey = (typeof UI_KEYS)[keyof typeof UI_KEYS];

// the menu's screens (the registry's enum for ui.start_screen)
export const START_SCREENS = ["home", "research", "chat", "documents", "ideas", "podcasts", "library"] as const;
export type StartScreen = (typeof START_SCREENS)[number];

// the registry's limits (init-ui-state.sql): the list holds at most RECENT_CAP items, an id at most ID_MAX characters,
// a document path at most DOC_MAX, and ANY stored value at most VALUE_MAX characters of its jsonb text
export const RECENT_CAP = 24;
export const ID_MAX = 120;
export const DOC_MAX = 400;
export const VALUE_MAX = 4096;
// what a Recently viewed item may be (a fixed set: the database refuses any other kind)
export const RECENT_KINDS = ["source", "claim", "topic", "gap", "document", "idea", "run"] as const;
export type RecentKind = (typeof RECENT_KINDS)[number];

export type DocRef = { id: string; title: string };
export interface RecentItem {
  kind: RecentKind;
  id: string;
  locked?: boolean;
}

// A stored value and the version to send back with the next write (a deleted value keeps counting: the
// version of a key never goes back).
export interface Versioned<T> {
  value: T | null;
  version: number;
}
export interface UiState {
  lockedDocument: Versioned<string>;
  lastDocument: Versioned<string>;
  startScreen: Versioned<StartScreen>;
  recent: Versioned<RecentItem[]>;
}
export const emptyUiState = (): UiState => ({
  lockedDocument: { value: null, version: 0 },
  lastDocument: { value: null, version: 0 },
  startScreen: { value: null, version: 0 },
  recent: { value: null, version: 0 },
});

// The write was refused because the stored version moved on (another browser wrote first). Nothing changed.
export class StaleVersion extends Error {
  constructor(public key: UiKey, message: string) {
    super(message);
  }
}

// ── validation, mirrored from the registry so a bad value fails before a request, with a clear reason ──
// C0 + DEL + C1 controls (U+0085 included), the bidi controls and the zero-width / invisible characters
const BAD_CHAR = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
// a value shaped like a credential, anywhere in the text (the database's own rule for text values)
const CREDENTIAL = /(^|[^A-Za-z0-9])(sk-|sk_|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|AIza|ya29\.|eyJ)|(^|[^a-z0-9])bearer\s/i;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const kindOk = (k: unknown): k is RecentKind => typeof k === "string" && (RECENT_KINDS as readonly string[]).includes(k);

// why a document path is refused, or null
export function docPathProblem(s: unknown, max = DOC_MAX): string | null {
  if (typeof s !== "string" || s.trim() === "") return "a document is an identifier (a path), not empty";
  if (s.length > max) return `a document path is at most ${max} characters`;
  if (BAD_CHAR.test(s) || s.includes("\\")) return "a document path has no control, invisible or direction characters";
  if (!s.startsWith("documents/") || s.length === "documents/".length) return "a document path starts with documents/";
  if (s.split("/").some((seg) => seg === ".." || seg === ".")) return "a document path has no dot segments";
  if (CREDENTIAL.test(s)) return "this looks like a credential; secrets are not stored";
  return null;
}
export function recentItemProblem(x: unknown): string | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return "every item is {kind, id[, locked]}";
  const o = x as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "kind" && k !== "id" && k !== "locked")) return "every item is {kind, id[, locked]}: identifiers only";
  if (!kindOk(o.kind)) return `kind is one of ${RECENT_KINDS.join(", ")}`;
  if ("locked" in o && typeof o.locked !== "boolean") return "locked is true or false";
  if (typeof o.id !== "string") return "an id is text";
  if (o.kind === "document") return docPathProblem(o.id, ID_MAX);
  if (!OPAQUE_ID.test(o.id) || o.id.includes("..")) return "an id is an opaque identifier (letters, digits, . _ : -)";
  if (CREDENTIAL.test(o.id)) return "this looks like a credential; secrets are not stored";
  return null;
}
export const isRecentItem = (x: unknown): x is RecentItem => recentItemProblem(x) === null;

// The length of a value as the database counts it: the text of the jsonb (`": "` and `", "` between members, object
// keys by length then bytes). Used to mirror the registry's 4096-character cap before a request.
export function jsonbTextLength(v: unknown): number {
  const t = (x: unknown): string => {
    if (Array.isArray(x)) return "[" + x.map(t).join(", ") + "]";
    if (x && typeof x === "object") {
      const keys = Object.keys(x as object).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
      return "{" + keys.map((k) => JSON.stringify(k) + ": " + t((x as Record<string, unknown>)[k])).join(", ") + "}";
    }
    return JSON.stringify(x);
  };
  return t(v).length;
}

// What was read, made safe: keep the well-formed items, at most the cap.
export function normalizeRecent(v: unknown): RecentItem[] | null {
  if (!Array.isArray(v)) return null;
  const out: RecentItem[] = [];
  for (const x of v) {
    if (isRecentItem(x)) out.push(x.locked === undefined ? { kind: x.kind, id: x.id } : { kind: x.kind, id: x.id, locked: x.locked });
    if (out.length === RECENT_CAP) break;
  }
  return out;
}

const isScreen = (v: unknown): v is StartScreen => typeof v === "string" && (START_SCREENS as readonly string[]).includes(v);
const asDoc = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

// ── the one read: the four keys of the signed-in subject, in one request ──
interface SettingOut {
  key: string;
  value: unknown;
  version: number;
}
const settingsUrl = (key: UiKey) => `/workbench/settings/${encodeURIComponent(key)}`;

function pick(settings: SettingOut[], key: UiKey): { value: unknown; version: number } {
  const s = settings.find((x) => x.key === key);
  return { value: s?.value ?? null, version: typeof s?.version === "number" ? s.version : 0 };
}

export async function loadUiState(): Promise<UiState> {
  const { data } = await api<{ settings?: SettingOut[] }>("GET", "/workbench/settings");
  const list = Array.isArray(data.settings) ? data.settings : [];
  const lock = pick(list, UI_KEYS.lockedDocument);
  const last = pick(list, UI_KEYS.lastDocument);
  const start = pick(list, UI_KEYS.startScreen);
  const rec = pick(list, UI_KEYS.recent);
  return {
    lockedDocument: { value: asDoc(lock.value), version: lock.version },
    lastDocument: { value: asDoc(last.value), version: last.version },
    startScreen: { value: isScreen(start.value) ? start.value : null, version: start.version },
    recent: { value: normalizeRecent(rec.value), version: rec.version },
  };
}

// ── the writes: a value (PUT, versioned) or null (DELETE, versioned too: Unlock never erases a newer lock) ──
async function write<T>(key: UiKey, value: T | null, version: number): Promise<Versioned<T>> {
  try {
    if (value === null) {
      const { data } = await api<{ version?: number }>("DELETE", `${settingsUrl(key)}?version=${version}`);
      return { value: null, version: typeof data.version === "number" ? data.version : version + 1 };
    }
    const { data } = await api<{ version?: number }>("PUT", settingsUrl(key), { value, version });
    return { value, version: typeof data.version === "number" ? data.version : version + 1 };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) throw new StaleVersion(key, e.message);
    throw e;
  }
}

export const saveLockedDocument = (path: string | null, version: number) => {
  if (path !== null) { const why = docPathProblem(path); if (why) throw new RangeError(why); }
  return write<string>(UI_KEYS.lockedDocument, path, version);
};
export const saveLastDocument = (path: string | null, version: number) => {
  if (path !== null) { const why = docPathProblem(path); if (why) throw new RangeError(why); }
  return write<string>(UI_KEYS.lastDocument, path, version);
};
export const saveStartScreen = (screen: StartScreen | null, version: number) => {
  if (screen !== null && !isScreen(screen)) throw new RangeError(`the start screen is one of ${START_SCREENS.join(", ")}`);
  return write<StartScreen>(UI_KEYS.startScreen, screen, version);
};
export const saveRecent = (items: RecentItem[] | null, version: number) => {
  if (items !== null) {
    if (items.length > RECENT_CAP) throw new RangeError(`the Recently viewed list holds at most ${RECENT_CAP} items`);
    for (const x of items) { const why = recentItemProblem(x); if (why) throw new RangeError(why); }
    if (jsonbTextLength(items) > VALUE_MAX) throw new RangeError(`the list is too large (${VALUE_MAX} characters at most)`);
  }
  return write<RecentItem[]>(UI_KEYS.recent, items, version);
};

// ── a locked document that is trashed or gone is "no document locked", never an error ──
// Only a 404 / 410 (or listed:false / trashed:true) says the document is gone. A 401 (signed out), 429 (rate
// limited), any other 4xx or 5xx, or no network says nothing about the document: it is thrown, so the caller
// keeps what it had and reports the failure instead of showing "no document locked".
export async function isLiveDocument(path: string): Promise<boolean> {
  try {
    const { data } = await api<{ listed?: boolean; trashed?: boolean }>("GET", `/workbench/documents/state?path=${encodeURIComponent(path)}`);
    return data.listed === true && data.trashed !== true;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 410)) return false;
    throw e;
  }
}

const baseTitle = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() || path;
// The shell's DocRef for a stored document id, or null when it is not a live document. The title is read from the
// document (its front matter) for display and is never stored; if it cannot be read the file name stands in.
export async function resolveDocument(id: string): Promise<DocRef | null> {
  if (!(await isLiveDocument(id))) return null;
  let title = baseTitle(id);
  try {
    const { data } = await api<{ content?: string }>("GET", `/workbench/documents/file?path=${encodeURIComponent(id)}`);
    const m = typeof data.content === "string" ? /^---\r?\n(?:[^\n]*\n)*?title:\s*(.+?)\s*\r?\n/m.exec(data.content) : null;
    if (m) {
      try { const t = JSON.parse(m[1]); if (typeof t === "string" && t.trim()) title = t.trim().slice(0, 200); } catch { /* keep the file name */ }
    }
  } catch { /* the file name stands in */ }
  return { id, title };
}

// ── the shell seam: the in-memory copy of this person's state ──
let epoch = 0;
let locked: DocRef | null = null;
let last: DocRef | null = null;
let startScreen: StartScreen | null = null;
let recent: RecentItem[] = [];
let ver: Record<UiKey, number> = { [UI_KEYS.lockedDocument]: 0, [UI_KEYS.lastDocument]: 0, [UI_KEYS.startScreen]: 0, [UI_KEYS.recent]: 0 };
let chains: Record<string, Promise<unknown>> = {};
// bumped by every local change of a key (reset by resetState and by a stale refusal): a read never overwrites a touched key
let touched: Record<UiKey, number> = { [UI_KEYS.lockedDocument]: 0, [UI_KEYS.lastDocument]: 0, [UI_KEYS.startScreen]: 0, [UI_KEYS.recent]: 0 };
let loading = false;
let accountError: string | null = null;
let snap = 0; // bumped on every change: what useSyncExternalStore watches
const subs = new Set<() => void>();
const emit = () => { snap++; subs.forEach((f) => f()); };

export const getLockedDocument = (): DocRef | null => locked;
export const getLastDocument = (): DocRef | null => last;
export const getStartScreen = (): StartScreen | null => startScreen;
export const getRecent = (): RecentItem[] => recent;
export const getAccountError = (): string | null => accountError;
export const isLoadingState = (): boolean => loading;
export const stateEpoch = (): number => epoch;
export const stateVersions = (): Readonly<Record<UiKey, number>> => ({ ...ver });
export function subscribeState(f: () => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}

// Forget everything held for the person on this page. LOCAL ONLY: nothing is written to the account.
export function resetState() {
  epoch++;
  locked = null; last = null; startScreen = null; recent = [];
  ver = { [UI_KEYS.lockedDocument]: 0, [UI_KEYS.lastDocument]: 0, [UI_KEYS.startScreen]: 0, [UI_KEYS.recent]: 0 };
  chains = {};
  touched = { [UI_KEYS.lockedDocument]: 0, [UI_KEYS.lastDocument]: 0, [UI_KEYS.startScreen]: 0, [UI_KEYS.recent]: 0 };
  loading = false;
  accountError = null;
  emit();
}

const msg = (e: unknown, d: string) => (e instanceof Error ? e.message : d);

// Reads the account into the page's copy. A document that is no longer live shows as "none"; a read that fails
// (a 5xx, no network, signed out) keeps what the page had and reports an error. A reset during the read drops it.
export async function loadAccountState(): Promise<void> {
  const my = epoch;
  // a key this page has changed (this epoch) is newer than any read: the read does not overwrite it. (A stale
  // refusal resets that key's mark first, so the account's value then wins.)
  const fresh = (k: UiKey) => touched[k] === 0;
  loading = true; emit();
  try {
    const s = await loadUiState();
    if (epoch !== my) return;
    ver = {
      [UI_KEYS.lockedDocument]: s.lockedDocument.version, [UI_KEYS.lastDocument]: s.lastDocument.version,
      [UI_KEYS.startScreen]: s.startScreen.version, [UI_KEYS.recent]: s.recent.version,
    };
    if (fresh(UI_KEYS.startScreen)) startScreen = s.startScreen.value;
    if (fresh(UI_KEYS.recent)) recent = s.recent.value ?? [];
    const lk = s.lockedDocument.value ? await resolveDocument(s.lockedDocument.value) : null;
    const ls = s.lastDocument.value ? await resolveDocument(s.lastDocument.value) : null;
    if (epoch !== my) return;
    if (fresh(UI_KEYS.lockedDocument)) locked = lk;
    if (fresh(UI_KEYS.lastDocument)) last = ls;
    accountError = null;
  } catch (e) {
    if (epoch === my) accountError = msg(e, "the saved state could not be read");
  } finally {
    if (epoch === my) { loading = false; emit(); }
  }
}

// One queued, versioned write per key. A write of a previous epoch never runs; a refused-as-stale write reloads
// the account (the page then shows what the other browser wrote) and answers false.
function push<T>(key: UiKey, save: (version: number) => Promise<Versioned<T>>): Promise<boolean> {
  const my = epoch;
  const run = async (): Promise<boolean> => {
    if (epoch !== my) return false;
    try {
      const v = await save(ver[key]);
      if (epoch !== my) return true;
      ver[key] = v.version;
      accountError = null; emit();
      return true;
    } catch (e) {
      if (epoch !== my) return false;
      if (e instanceof StaleVersion) { touched[key] = 0; await loadAccountState(); return false; }
      accountError = msg(e, "the change was not saved"); emit();
      return false;
    }
  };
  const prev = chains[key] ?? Promise.resolve();
  const next = prev.then(run, run);
  chains[key] = next;
  return next;
}

export function setLockedDocumentSaved(d: DocRef | null): Promise<boolean> {
  locked = d; touched[UI_KEYS.lockedDocument]++; emit();
  return push<string>(UI_KEYS.lockedDocument, (v) => saveLockedDocument(d ? d.id : null, v));
}
export function setLockedDocument(d: DocRef | null): void {
  void setLockedDocumentSaved(d);
}
export function setLastDocumentSaved(d: DocRef | null): Promise<boolean> {
  last = d; touched[UI_KEYS.lastDocument]++; emit();
  return push<string>(UI_KEYS.lastDocument, (v) => saveLastDocument(d ? d.id : null, v));
}
export function setLastDocument(d: DocRef | null): void {
  void setLastDocumentSaved(d);
}
export function setStartScreenSaved(s: StartScreen | null): Promise<boolean> {
  startScreen = s; touched[UI_KEYS.startScreen]++; emit();
  return push<StartScreen>(UI_KEYS.startScreen, (v) => saveStartScreen(s, v));
}
export function setStartScreen(s: StartScreen | null): void {
  void setStartScreenSaved(s);
}
export function setRecentSaved(items: RecentItem[] | null): Promise<boolean> {
  recent = items ?? []; touched[UI_KEYS.recent]++; emit();
  return push<RecentItem[]>(UI_KEYS.recent, (v) => saveRecent(items, v));
}
export function setRecent(items: RecentItem[] | null): void {
  void setRecentSaved(items);
}

// The setters above return nothing (the shell's signature: a click handler fires and forgets). The *Saved variants
// are the same change and answer true when the account stored it, false when it was refused as stale or not saved.

// ── the hook ──
export interface UiStateApi {
  loading: boolean;
  error: string | null; // a failed read or write that says nothing about the state (server down, signed out)
  locked: DocRef | null; // the locked document if it is still a live document, else null ("no document locked")
  last: DocRef | null;
  startScreen: StartScreen | null;
  recent: RecentItem[];
  versions: Readonly<Record<UiKey, number>>;
  reload: () => Promise<void>;
  // each setter resolves true when stored, false when refused as stale (the state was reloaded) or not saved
  setLockedDocument: (d: DocRef | null) => Promise<boolean>;
  setLastDocument: (d: DocRef | null) => Promise<boolean>;
  setStartScreen: (s: StartScreen | null) => Promise<boolean>;
  setRecent: (items: RecentItem[] | null) => Promise<boolean>;
}

export function useUiState(): UiStateApi {
  useSyncExternalStore(subscribeState, () => snap);
  useEffect(() => { void loadAccountState(); }, []);
  const reload = useCallback(() => loadAccountState(), []);
  return {
    loading, error: accountError, locked, last, startScreen, recent, versions: stateVersions(),
    reload, setLockedDocument: setLockedDocumentSaved, setLastDocument: setLastDocumentSaved, setStartScreen: setStartScreenSaved, setRecent: setRecentSaved,
  };
}
