// research-workbench P3b - what the trust panels are focused on: a session (and its report), and a
// source. Kept here, not in lib/store.ts, so the trust panels add no field to the shared store. A tiny
// observable, like lib/store.ts.
// rw-p3b-trust2 (review B2): the LATEST of the two selections wins. `source` (set by "Quality of ..." and
// "Show its quality") focuses only the source quality panel, and it is cleared whenever the workspace's
// selected reference changes - so a new selection in the reference panel always moves both the ledger and the
// quality panel. The ledger never reads `source` (its own row action does not re-scope it).
import { useSyncExternalStore } from "react";
import { getState, subscribe as subscribeWorkspace } from "../../lib/store";

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
// the workspace selection changed: drop a source focus picked before it
let lastReference = getState().reference;
subscribeWorkspace(() => {
  const r = getState().reference;
  if (r === lastReference) return;
  lastReference = r;
  if (focus.source !== null) setTrust({ source: null });
});

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
