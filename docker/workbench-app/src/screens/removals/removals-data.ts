// What the Removals and trail screen reads and does. Every read is a GET and every action a POST through
// lib/api.ts (the one door), each to a route that already exists (nothing new on the server):
//   sources     GET  contract/cleanup/sources            hidden / cut loose, with what depends on them (shared)
//   trail       GET  contract/trail                       what happened to sources (shared, append-only)
//   my actions  GET  contract/cleanup/actions             the caller's OWN actions: how the trail says "you"
//   documents   GET  contract/documents                  the caller's own documents (path says trashed / archived)
//   ideas       GET  contract/ideas                       the caller's own ideas (status archived)
//   doc trail   GET  documents/trail                      the caller's own document removal lines
//   Show it again   POST sources/:id/restore | documents/restore | documents/unarchive | ideas/:id/reopen
//   Lift the marker POST contract/cleanup/tombstones/:id/lift
//   Erase for good  POST contract/cleanup/sources/:id/erase
//   Delete forever  POST documents/delete-forever
// Nothing read here is kept in the browser. A refusal is turned into a plain sentence here: the server's
// own words are never shown (a refusal for someone else's row reads like a missing row).
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api";

export type Read<T> = { state: "loading" } | { state: "failed" } | { state: "ok"; data: T };

export type SourceRow = {
  id: string; title: string; url: string | null; stage: "hidden" | "cut"; reason: string; at: string;
  counts: Record<string, number>; eraseAllowed: boolean; blocked: boolean;
};
export type TrailEntry = {
  kind: string; sourceId: string; tombstoneId: string | null; state: string; reason: string; context: Record<string, unknown>;
  at: string;
};
export type MyAction = { id: string; kind: string; sourceId: string | null; tombstoneId: string | null; at: string };
export type DocItem = { title: string; path: string; updated: string; where: "live" | "trashed" | "archived" };
export type IdeaItem = { id: string; title: string; status: string; updated: string; documentPath: string | null };
export type DocTrailLine = { id: string; kind: string; path: string; actor: string; at: string };

// A 200 that is not the expected JSON (a login page, a wrong shape) is a FAILURE of the read, never an empty list.
const listOf = (data: any, key: string): any[] => {
  if (!data || typeof data !== "object" || !Array.isArray(data[key])) throw new Error("unexpected answer: no " + key);
  return data[key];
};
const str = (x: unknown) => (typeof x === "string" ? x : "");
const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

export function useRead<T>(fn: () => Promise<T>, tick: number): Read<T> & { retry: () => void } {
  const [s, setS] = useState<Read<T>>({ state: "loading" });
  const [again, setAgain] = useState(0);
  const seq = useRef(0);
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => {
    const mine = ++seq.current;
    // what is shown stays while a reload runs (after an action), so the list does not flash empty
    f.current().then((data) => { if (mine === seq.current) setS({ state: "ok", data }); }, () => { if (mine === seq.current) setS({ state: "failed" }); });
  }, [tick, again]);
  const retry = useCallback(() => { setS({ state: "loading" }); setAgain((n) => n + 1); }, []);
  return { ...s, retry };
}

// ---- reads
export async function readSources(): Promise<SourceRow[]> {
  const { data } = await api("GET", "/workbench/contract/cleanup/sources?limit=500");
  return listOf(data, "sources").map((s) => ({
    id: str(s.id), title: str(s.title), url: typeof s.url === "string" ? s.url : null,
    stage: s.lifecycle === "unlinked" ? "cut" : "hidden", reason: str(s.reason), at: str(s.suppressed_at),
    counts: rec(s.counts) as Record<string, number>, eraseAllowed: s.erase_allowed === true, blocked: Number(s.blocking) > 0,
  }) as SourceRow);
}
export async function readTrail(): Promise<TrailEntry[]> {
  const { data } = await api("GET", "/workbench/contract/trail?limit=500");
  return listOf(data, "entries").map((e) => ({
    kind: str(e.kind), sourceId: str(e.source_id), tombstoneId: typeof e.tombstone_id === "string" ? e.tombstone_id : null,
    state: str(e.state), reason: str(e.reason), context: rec(e.context), at: str(e.at),
  }));
}
export async function readMyActions(): Promise<MyAction[]> {
  const { data } = await api("GET", "/workbench/contract/cleanup/actions?limit=200");
  return listOf(data, "actions").map((a) => ({
    id: str(a.id), kind: str(a.kind), sourceId: typeof a.source_id === "string" ? a.source_id : null,
    tombstoneId: typeof a.tombstone_id === "string" ? a.tombstone_id : null, at: str(a.created_at),
  }));
}
const TRASHED = /^documents\/(?:[^./][^/]*\/)?\.trash\//;
const ARCHIVED = /^documents\/(?:[^./][^/]*\/)?\.archive\//;
const whereOf = (p: string): DocItem["where"] => (TRASHED.test(p) ? "trashed" : ARCHIVED.test(p) ? "archived" : "live");
export async function readDocs(): Promise<DocItem[]> {
  const { data } = await api("GET", "/workbench/contract/documents?limit=500");
  return listOf(data, "documents").map((d) => ({ title: str(d.title), path: str(d.path), updated: str(d.updated), where: whereOf(str(d.path)) }));
}
export async function readIdeas(): Promise<IdeaItem[]> {
  const { data } = await api("GET", "/workbench/contract/ideas?limit=200");
  return listOf(data, "ideas").map((i) => ({
    id: str(i.id), title: str(i.title), status: str(i.status), updated: str(i.updated_at), documentPath: typeof i.document_path === "string" ? i.document_path : null,
  }));
}
export async function readDocTrail(): Promise<DocTrailLine[]> {
  const { data } = await api("GET", "/workbench/documents/trail?limit=500");
  return listOf(data, "lines").map((l) => ({ id: str(l.id), kind: str(l.kind), path: str(l.path), actor: str(l.actor_sub), at: str(l.created_at) }));
}
export type TombstoneFacts = { mayLift: boolean; byYou: boolean };
export async function readTombstone(id: string): Promise<TombstoneFacts> {
  const { data } = await api("GET", "/workbench/contract/tombstones/" + encodeURIComponent(id));
  return { mayLift: data?.may_lift === true, byYou: data?.erased_by_you === true };
}

// ---- actions: one POST each, to the route that already exists
const enc = encodeURIComponent;
export const showSourceAgain = (id: string) => api("POST", `/workbench/sources/${enc(id)}/restore`, {});
export const eraseSource = (id: string, reason_type: string) => api("POST", `/workbench/contract/cleanup/sources/${enc(id)}/erase`, { reason_type });
export const liftMarker = (id: string) => api("POST", `/workbench/contract/cleanup/tombstones/${enc(id)}/lift`, {});
export const restoreDocument = (path: string) => api("POST", "/workbench/documents/restore", { path });
export const unarchiveDocument = (path: string) => api("POST", "/workbench/documents/unarchive", { path });
// By the idea's id (contracts/routes/idea_archive.ts): works with or without a document. 404 = not yours or missing, 409 = not archived.
export const reopenIdea = (id: string) => api("POST", `/workbench/ideas/${enc(id)}/reopen`, {});
export const deleteForever = (path: string) => api("POST", "/workbench/documents/delete-forever", { path, confirm: true });

// A refusal in plain words. The server's text is never shown, so a row that is someone else's and a row that is
// gone read the same.
export function plainFailure(e: unknown, what: string): string {
  const st = e instanceof ApiError ? e.status : 0;
  if (st === 404) return "That is not there any more, so nothing was changed.";
  if (st === 403 && what === "lift") return "Only the person who erased this, or an administrator, can lift its marker. Nothing was changed.";
  if (st === 409) return "That is no longer possible: it changed while you were looking. Nothing was changed.";
  return "That did not work. Nothing was changed.";
}

// ---- who did it
// A shared trail line never names a person: it names an action by an opaque reference, or nothing. "You" is
// answered from the caller's OWN action log (a read the server scopes to the caller); everything else reads "Someone else".
const REF = /^cleanup-action:([0-9a-f-]{36})$/i;
const KIND_OF: Record<string, string[]> = {
  suppressed: ["suppress", "retract"], unlinked: ["sever"], severed: ["sever"], restored: ["restore", "retract"], lifted: ["lift"], erased: ["erase"],
};
const WINDOW_MS = 120_000;
const ms = (s: string) => { const t = Date.parse(s); return Number.isFinite(t) ? t : 0; };

// The marker a trail line is about. An "erased" line carries it in the tombstone_id column; a real "lifted" line has
// tombstone_id NULL and names it only in its detail (contracts/repo/lifecycle.ts:36-41 trail() writes no tombstone_id,
// :343 writes { tombstone_id, note }; contracts/repo/knowledge.ts:484 returns the column, the detail comes back as context).
export function tombstoneOf(e: TrailEntry): string | null {
  if (e.tombstoneId) return e.tombstoneId;
  const d = e.context.tombstone_id;
  return typeof d === "string" && d !== "" ? d : null;
}

export function isMine(e: TrailEntry, mine: MyAction[]): boolean {
  const tid = tombstoneOf(e);
  const ids = new Set(mine.map((a) => a.id.toLowerCase()));
  const own = (ref: unknown) => { const m = typeof ref === "string" ? REF.exec(ref) : null; return !!m && ids.has(m[1].toLowerCase()); };
  // a line that names its action settles it: that action is mine or it is not (never guessed from the time)
  const named = [e.context.suppressed_by, e.context.retracted_by, e.context.batch_run_id].filter((r) => typeof r === "string" && r !== "");
  if (named.length > 0) return named.some(own);
  const kinds = KIND_OF[e.kind];
  if (!kinds) return false;
  return mine.some((a) => kinds.includes(a.kind) && (
    (tid !== null && a.tombstoneId === tid) ||
    (a.sourceId !== null && a.sourceId === e.sourceId && Math.abs(ms(a.at) - ms(e.at)) <= WINDOW_MS)));
}

export const when = (s: string) => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "unknown date"; };

// Dependence kinds a person can own (their documents, references and reports) are NOT counted on screen: a count
// of them would tell one person about another's private work. The screen says only that something keeps the source.
export const SHARED_KINDS: Record<string, string> = {
  claim_edge: "claims", chunk: "text pieces", citing_page: "pages that cite it", entity_grounding: "named things grounded on it", found_via_lead: "leads found through it",
};
const PRIVATE_KINDS = ["document_link", "reference_record", "report_session", "report_citation"];
export function dependsOn(counts: Record<string, number>): { shared: string[]; private: boolean } {
  const shared = Object.entries(SHARED_KINDS).filter(([k]) => (counts[k] ?? 0) > 0).map(([k, label]) => `${counts[k]} ${label}`);
  return { shared, private: PRIVATE_KINDS.some((k) => (counts[k] ?? 0) > 0) };
}
