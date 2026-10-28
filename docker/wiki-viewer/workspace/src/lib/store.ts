// The workspace's shared state: which document is open, which reference is selected (the reference
// panel follows it), a search the editor mirrored to the panels, and the active editor (inject puts
// a reference at ITS cursor). A tiny observable - no library.
import { useSyncExternalStore } from "react";

export interface SelectedReference {
  reference_id: string | null; // a reference record (a chip, a transclusion), or null for a bare source
  source_id: string;
  chunk_idx: number | null;
  from?: { path: string; pos: number }; // where it was selected, for jump-and-return
}

export interface EditorHandle {
  path: string;
  insertAtCursor(text: string): void;
  selection(): string;
  focusAt(pos: number): void;
  replaceText(oldText: string, newText: string): boolean;
}

export interface WorkspaceState {
  documentPath: string | null;
  documentRev: number; // bumps when the open document changed on the server (refresh views)
  reference: SelectedReference | null;
  mirror: { query: string; at: number } | null;
  editor: EditorHandle | null;
  stale: Set<string>; // reference ids the diff-id check flagged out of date in the open document
}

let state: WorkspaceState = { documentPath: null, documentRev: 0, reference: null, mirror: null, editor: null, stale: new Set() };
const subs = new Set<() => void>();

export function getState() {
  return state;
}
export function setState(patch: Partial<WorkspaceState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
export function subscribe(f: () => void) {
  subs.add(f);
  return () => subs.delete(f);
}
export function useWorkspace<T>(pick: (s: WorkspaceState) => T): T {
  return useSyncExternalStore(subscribe, () => pick(state));
}
export function resetState() {
  state = { documentPath: null, documentRev: 0, reference: null, mirror: null, editor: null, stale: new Set() };
  subs.forEach((f) => f());
}
