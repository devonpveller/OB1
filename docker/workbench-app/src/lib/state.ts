// The per-person front-end state the shell shows: the LOCKED document and the LAST document.
// rwr-ui-state-keys replaces the body of this module (it keeps both in the account, through
// /workbench/settings/ui.locked_document and ui.last_document, via lib/api.ts). The shape the shell
// depends on is only this: typed synchronous getters, setters, and subscribe(). Today the values live in
// memory for the page's life and are never written to the browser's storage or logged: a title is the
// person's own data and must not reach a shared surface (a cache, a log, localStorage).
export type DocRef = { id: string; title: string };

let locked: DocRef | null = null;
let last: DocRef | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const getLockedDocument = (): DocRef | null => locked;
export const getLastDocument = (): DocRef | null => last;
export function setLockedDocument(d: DocRef | null) { locked = d; emit(); }
export function setLastDocument(d: DocRef | null) { last = d; emit(); }
export function subscribeState(f: () => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}
// Forget everything (a different person signing in on this page, and tests).
export function resetState() { locked = null; last = null; emit(); }
