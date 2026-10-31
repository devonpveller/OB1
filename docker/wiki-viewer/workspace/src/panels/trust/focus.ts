// research-workbench P3b - what the trust panels are focused on: a session (and its report), and a
// source. Kept here, not in lib/store.ts, so the trust panels add no field to the shared store; a
// selected reference in the workspace store still focuses the source quality panel when nothing here
// names a source. A tiny observable, like lib/store.ts.
import { useSyncExternalStore } from "react";

export interface TrustFocus {
  session: string | null; // a research job id (the coverage panel)
  report: string | null; // that session's report (research synthesis source) - the ledger's scope
  source: string | null; // a source the ledger or the quality panel picked
}

let focus: TrustFocus = { session: null, report: null, source: null };
const subs = new Set<() => void>();

export function getTrust() {
  return focus;
}
export function setTrust(patch: Partial<TrustFocus>) {
  focus = { ...focus, ...patch };
  subs.forEach((f) => f());
}
export function resetTrust() {
  focus = { session: null, report: null, source: null };
  subs.forEach((f) => f());
}
function subscribe(f: () => void) {
  subs.add(f);
  return () => subs.delete(f);
}
export function useTrust<T>(pick: (s: TrustFocus) => T): T {
  return useSyncExternalStore(subscribe, () => pick(focus));
}
