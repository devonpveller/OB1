// The per-user front-end state the shell keeps with the ACCOUNT, not the browser (rwr-ui-state-keys):
//   locked document · last document · start screen · Recently viewed list.
// They are four user-tier settings keys of the workbench (slot 490), so they follow the signed-in subject
// (or the default subject while sign-in is off) to any browser. The server decides whose they are (the
// identity seam); this file never names an owner, and it talks to the back end only through lib/api.ts.
//
// Nothing here is cached or logged outside memory: no localStorage, no cookie, no console output. A
// value is an identifier (a document path, a screen name, {kind, id} pairs) - never document text.
//
// Writes are VERSIONED: every setter takes the version the caller last read (0 = nothing stored yet), and a
// write whose version is stale is refused by the server (409) and surfaces as StaleVersion; nothing is
// changed. The caller reloads (the hook does) and decides again.
//
// A locked document that was trashed or deleted is "no document locked", never an error: see
// resolveLiveDocument() and the hook's `locked`.
import { useCallback, useEffect, useRef, useState } from "react";
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

// the registry caps (init-ui-state.sql): the list is at most RECENT_CAP items, an id at most ID_MAX characters
export const RECENT_CAP = 24;
export const ID_MAX = 120;
export const DOC_MAX = 400;

export interface RecentItem {
  kind: string; // a short lower-case name: "document", "source", "claim", ...
  id: string;
  locked?: boolean;
}

// A stored value and the version to send back with the next write (0 = nothing stored: the default).
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
const KIND_RX = /^[a-z][a-z_]{0,31}$/;
// deno-lint-ignore no-control-regex
const CONTROL_RX = /[\u0000-\u001f\u007f]/;

export function isRecentItem(x: unknown): x is RecentItem {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "kind" && k !== "id" && k !== "locked")) return false;
  if (typeof o.kind !== "string" || !KIND_RX.test(o.kind)) return false;
  if (typeof o.id !== "string" || o.id.trim() === "" || o.id.length > ID_MAX || CONTROL_RX.test(o.id)) return false;
  if ("locked" in o && typeof o.locked !== "boolean") return false;
  return true;
}

// What was read, made safe: keep the well-formed items, at most the cap. (A stored list is always valid - the
// database judges every write - so this only guards an older or hand-edited row.)
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

// ── the writes: a value (PUT, versioned) or null (DELETE: back to "nothing stored") ──
async function write<T>(key: UiKey, value: T | null, version: number): Promise<Versioned<T>> {
  try {
    if (value === null) {
      await api("DELETE", settingsUrl(key));
      return { value: null, version: 0 };
    }
    const { data } = await api<{ version?: number }>("PUT", settingsUrl(key), { value, version });
    return { value, version: typeof data.version === "number" ? data.version : version + 1 };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) throw new StaleVersion(key, e.message);
    throw e;
  }
}

function checkDoc(path: string | null): void {
  if (path === null) return;
  if (path.trim() === "" || path.length > DOC_MAX || CONTROL_RX.test(path)) {
    throw new RangeError(`a document is an identifier (a path) of at most ${DOC_MAX} characters, with no control characters`);
  }
}

export const saveLockedDocument = (path: string | null, version: number) => {
  checkDoc(path);
  return write<string>(UI_KEYS.lockedDocument, path, version);
};
export const saveLastDocument = (path: string | null, version: number) => {
  checkDoc(path);
  return write<string>(UI_KEYS.lastDocument, path, version);
};
export const saveStartScreen = (screen: StartScreen | null, version: number) => {
  if (screen !== null && !isScreen(screen)) throw new RangeError(`the start screen is one of ${START_SCREENS.join(", ")}`);
  return write<StartScreen>(UI_KEYS.startScreen, screen, version);
};
export const saveRecent = (items: RecentItem[] | null, version: number) => {
  if (items !== null) {
    if (items.length > RECENT_CAP) throw new RangeError(`the Recently viewed list holds at most ${RECENT_CAP} items`);
    if (!items.every(isRecentItem)) throw new RangeError("every item is {kind, id[, locked]}: identifiers only");
  }
  return write<RecentItem[]>(UI_KEYS.recent, items, version);
};

// ── a locked document that is trashed or gone is "no document locked", never an error ──
// The documents API answers a path that is not the caller's live document as 404 (a trashed one is moved
// out of its live path; another user's is "no such document"), or as listed:false / trashed:true. Every
// such answer is `false`. Only a failure that says nothing about the document (a server error, no network)
// is thrown - the caller keeps what it had instead of guessing.
export async function isLiveDocument(path: string): Promise<boolean> {
  try {
    const { data } = await api<{ listed?: boolean; trashed?: boolean }>(
      "GET",
      `/workbench/documents/state?path=${encodeURIComponent(path)}`,
    );
    return data.listed === true && data.trashed !== true;
  } catch (e) {
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) return false;
    throw e;
  }
}

// ── the hook ──
export interface UiStateApi {
  loading: boolean;
  error: string | null; // a failed read or write that says nothing about the state (server down)
  state: UiState; // what is stored, as read
  locked: string | null; // the locked document if it is still a live document, else null ("no document locked")
  reload: () => Promise<void>;
  // each setter resolves true when stored, false when refused as stale (the state was reloaded - decide again)
  setLockedDocument: (path: string | null) => Promise<boolean>;
  setLastDocument: (path: string | null) => Promise<boolean>;
  setStartScreen: (screen: StartScreen | null) => Promise<boolean>;
  setRecent: (items: RecentItem[] | null) => Promise<boolean>;
}

export function useUiState(): UiStateApi {
  const [state, setState] = useState<UiState>(emptyUiState);
  const [locked, setLocked] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const current = useRef(state);
  current.current = state;

  const load = useCallback(async () => {
    try {
      const s = await loadUiState();
      const doc = s.lockedDocument.value;
      const live = doc !== null && (await isLiveDocument(doc));
      if (!alive.current) return;
      setState(s);
      setLocked(live ? doc : null);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "the state could not be read");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  // one write: the version is the one this hook last read; a stale refusal reloads and answers false
  const run = useCallback(async <T,>(
    field: keyof UiState,
    doWrite: (version: number) => Promise<Versioned<T>>,
    after?: (v: Versioned<T>) => void,
  ): Promise<boolean> => {
    try {
      const v = await doWrite(current.current[field].version);
      if (!alive.current) return true;
      setState((s) => ({ ...s, [field]: v }));
      after?.(v);
      setError(null);
      return true;
    } catch (e) {
      if (e instanceof StaleVersion) {
        await load();
        return false;
      }
      if (alive.current) setError(e instanceof Error ? e.message : "the change was not saved");
      return false;
    }
  }, [load]);

  return {
    loading,
    error,
    state,
    locked,
    reload: load,
    // a document just locked is live by the user's own act; a cleared lock is none
    setLockedDocument: (path) => run<string>("lockedDocument", (v) => saveLockedDocument(path, v), (v) => setLocked(v.value)),
    setLastDocument: (path) => run<string>("lastDocument", (v) => saveLastDocument(path, v)),
    setStartScreen: (screen) => run<StartScreen>("startScreen", (v) => saveStartScreen(screen, v)),
    setRecent: (items) => run<RecentItem[]>("recent", (v) => saveRecent(items, v)),
  };
}
