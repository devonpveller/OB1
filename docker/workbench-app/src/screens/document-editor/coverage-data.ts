// What the Coverage tab reads and writes (rwr-doc-coverage). Every call goes through lib/api.ts (the one door); this file
// never names a user, never sends a user field, and keeps nothing in the browser (no storage, no cache, no title).
//   GET    contract/gaps?path=&limit=            { gaps, total, counts } the caller's own gaps of this document (dismissed ones left out);
//                                                reading settles a finished run's gaps (covered, or back to open)
//   POST   contract/gaps                         { path, text, origin } -> 201 gap; 409 { detail: { existing } } the text is already there
//   PATCH  contract/gaps/<id>                    { state } open | covered | dismissed
//   DELETE contract/gaps/<id>                    open or covered gaps only
//   POST   contract/gaps/research                { ids } -> 202 { job_id, gaps }: ONE run for the ticked gaps
//   GET    contract/documents/coverage?path=     { sessions: [{ id, status, created_at }] } the person's own research runs for the document
//   GET    contract/sessions/<id>/coverage       { needs: [{ need, status }], gaps: [text] } what that run says is still needed
// A gap has no field for the passage it came from (the store is another item); a gap added from selected text therefore IS
// the passage: its text is the selected words and its origin is "selection", and "Show in the text" finds those words again.
import { StateEffect, StateField } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { api, ApiError } from "../../lib/api";

export const GAP_MAX = 2000;           // characters (code points), the server's limit
export const SESSIONS_READ = 10;       // the newest research runs whose needs are read (one request each)
export const POLL_MS = 20_000;         // while a run is out, the list is read again (the server settles on a read)

export type GapState = "open" | "researching" | "covered" | "dismissed";
export type Gap = { id: string; path: string; text: string; origin: string; state: GapState; job_id: string | null; covered_at: string | null; created_at: string; updated_at: string };
export type GapList = { gaps: Gap[]; total: number; counts: Record<GapState, number> };
export type Found = { key: string; text: string; kind: "need" | "gap"; status: string; run: string; at: string };

const STATES: GapState[] = ["open", "researching", "covered", "dismissed"];
const isGap = (g: any): g is Gap => !!g && typeof g.id === "string" && typeof g.text === "string" && typeof g.origin === "string" && STATES.includes(g.state);

export const chars = (s: string) => Array.from(s).length;
// a control character other than tab / newline would be refused by the server (400): the words keep their place as spaces
export const cleanText = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();

// The server's de-dup key (OB1/docker/workbench/src/contracts/repo/gaps.ts normalizeGapText): used only to say "on your list"
// beside a research-found need; the server still decides. Keep equal to it.
export function normalizeGapText(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[​‌⁠﻿]/g, "").replace(/\s+/g, " ").trim()
    .replace(/^[\s"'“”‘’(\[{]+/, "").replace(/[\s"'“”‘’)\]}.,;:!?…]+$/, "");
}

export async function readGaps(path: string): Promise<GapList> {
  const { data } = await api<any>("GET", `/workbench/contract/gaps?path=${encodeURIComponent(path)}&limit=500`);
  if (!data || !Array.isArray(data.gaps) || !data.gaps.every(isGap) || !data.counts) throw new Error("unexpected answer");
  const c = data.counts;
  return { gaps: data.gaps, total: Number.isFinite(+data.total) ? +data.total : data.gaps.length, counts: { open: +c.open || 0, researching: +c.researching || 0, covered: +c.covered || 0, dismissed: +c.dismissed || 0 } };
}

export async function addGap(path: string, text: string, origin: "user" | "selection" | "research"): Promise<Gap> {
  const { data } = await api<any>("POST", "/workbench/contract/gaps", { path, text, origin });
  if (!isGap(data)) throw new Error("unexpected answer");
  return data;
}
export async function markGap(id: string, state: "open" | "covered"): Promise<void> {
  await api("PATCH", `/workbench/contract/gaps/${encodeURIComponent(id)}`, { state });
}
export async function removeGap(id: string): Promise<void> {
  await api("DELETE", `/workbench/contract/gaps/${encodeURIComponent(id)}`);
}
export async function researchGaps(ids: string[]): Promise<{ job: string; n: number }> {
  const { data } = await api<any>("POST", "/workbench/contract/gaps/research", { ids });
  if (!data || typeof data.job_id !== "string" || !Array.isArray(data.gaps)) throw new Error("unexpected answer");
  return { job: data.job_id, n: data.gaps.length };
}

// What the person's own research runs for this document say is still needed: the needs that were not answered, and the
// run's own gap lines. Newest run first; the same words from a later run are shown once, under the newest run that said them.
export async function readFound(path: string): Promise<{ found: Found[]; unread: number; unseen: number }> {
  const { data } = await api<any>("GET", `/workbench/contract/documents/coverage?path=${encodeURIComponent(path)}`);
  const runs: { id: string; created_at: string }[] = (Array.isArray(data?.sessions) ? data.sessions : [])
    .filter((s: any) => s && typeof s.id === "string" && typeof s.created_at === "string")
    .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)));
  const unseen = Math.max(0, runs.length - SESSIONS_READ); // older runs than the newest SESSIONS_READ are not read: the tab says so
  runs.length = Math.min(runs.length, SESSIONS_READ);
  const out: Found[] = [];
  const seen = new Set<string>();
  let unread = 0;
  const per = await Promise.all(runs.map(async (r) => {
    try { return { r, d: (await api<any>("GET", `/workbench/contract/sessions/${encodeURIComponent(r.id)}/coverage`)).data }; } catch { return { r, d: null }; }
  }));
  for (const { r, d } of per) {
    if (!d) { unread++; continue; }
    const add = (text: unknown, kind: Found["kind"], status: string) => {
      if (typeof text !== "string" || !text.trim()) return;
      const key = normalizeGapText(text);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ key, text: text.trim(), kind, status, run: r.id, at: r.created_at });
    };
    for (const n of Array.isArray(d.needs) ? d.needs : []) if (n && n.status !== "answered") add(n.need, "need", String(n.status));
    for (const g of Array.isArray(d.gaps) ? d.gaps : []) add(g, "gap", "gap");
  }
  return { found: out, unread, unseen };
}

// The words for a refusal. Never the server's text (it may carry another person's words in a future change), always ours.
export function gapProblem(e: unknown, what: "add" | "research" | "change" | "remove" | "read"): string {
  const s = e instanceof ApiError ? e.status : 0;
  if (what === "read") return "Could not read your gaps. Nothing was changed.";
  if (s === 409 && what === "add") return "That is already on your list.";
  // the document has no listing row yet (the server's own fixed sentence says so): not "a gap changed"
  if (s === 409 && what === "research" && e instanceof ApiError && /not listed yet/i.test(String(e.body?.error ?? ""))) return "This document has not been saved yet, so it cannot be researched. Save it first, then try again.";
  if (s === 409) return "A gap changed since this list was read. The list is up to date now.";
  if (s === 404 && what === "add") return "This document is not available to add a gap to.";
  if (s === 404) return what === "research" ? "One of the ticked gaps is no longer there. The list is up to date now." : "That gap is no longer there. The list is up to date now.";
  if (s === 503) return "Research is not available right now. Your gaps are unchanged.";
  if (s === 400 || s === 422) return "That was not accepted. Check its length and try again.";
  const did = { add: "add that gap", research: "start the research", change: "change that gap", remove: "remove that gap" }[what];
  return `Could not ${did}. Nothing was changed.`;
}

// "22 Nov 2026 10:00 UTC (run 5e550000)": two runs on one day read differently
export function runLabel(iso: string, id: string): string {
  const d = new Date(iso);
  const t = Number.isNaN(d.getTime()) ? "" : ` ${d.toISOString().slice(11, 16)} UTC`;
  return `${runDate(iso)}${t} (run ${id.slice(0, 8)})`;
}

// "22 Nov 2026" in UTC (a run's date does not move with the browser's zone)
export function runDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "an unknown date" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// "Show in the text". The store keeps no position, so the words are searched for (any run of white space matches any other:
// the text may have been re-wrapped since). A gap added from the selection on THIS page also remembers where its words STARTED:
// the position (the first character of the words, so mapPos with association +1: text typed right at it goes before it) is carried
// through every edit by the editor's own change mapping, so a copy deleted or typed above it does
// not move it. Press: if a copy starts at the carried position that is the one shown, with no note; if none does (the passage
// was edited, or the page was reloaded and nothing is remembered) and the words stand more than once, the first is shown and the
// caller says "N times, press again". The store has no field for any of this: a reload forgets it.
export type Shown = { n: number; at: number; exact: boolean };
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function places(view: EditorView, passage: string): { from: number; to: number }[] {
  const words = passage.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const re = new RegExp(words.map(esc).join("\\s+"), "g");
  return [...view.state.doc.toString().matchAll(re)].map((m) => ({ from: m.index!, to: m.index! + m[0].length }));
}
const place = StateEffect.define<{ id: string; pos: number }>();
const placed = StateField.define<Map<string, number>>({
  create: () => new Map(),
  update(m, tr) {
    let n = m;
    if (tr.docChanged) { n = new Map(); for (const [id, pos] of m) n.set(id, tr.changes.mapPos(pos, 1)); }
    for (const e of tr.effects) if (e.is(place)) { if (n === m) n = new Map(m); n.set(e.value.id, e.value.pos); }
    return n;
  },
});
const ready = (view: EditorView) => { if (view.state.field(placed, false) === undefined) view.dispatch({ effects: StateEffect.appendConfig.of(placed) }); };
// Where the selected words start (the trimmed words), or null with nothing selected.
export function startOfSelection(view: EditorView | null): number | null {
  if (!view) return null;
  const r = view.state.selection.main;
  if (r.empty) return null;
  const text = view.state.sliceDoc(r.from, r.to);
  return r.from + (text.length - text.trimStart().length);
}
// Remember (for this page) where gap `id` words start; carried through edits by the editor's own change mapping.
export function rememberPlace(view: EditorView | null, id: string, pos: number): void {
  if (!view) return;
  ready(view);
  view.dispatch({ effects: place.of({ id, pos: Math.min(pos, view.state.doc.length) }) });
}
// Select the place where these words stand and scroll to it: the one that starts where gap `id` was remembered (exact), else the
// first; `nth` moves on from there (wrapping round). null = not in the text any more.
export function locatePassage(view: EditorView | null, passage: string, nth = 0, id?: string): Shown | null {
  if (!view) return null;
  const all = places(view, passage);
  if (!all.length) return null;
  const mapped = id ? view.state.field(placed, false)?.get(id) : undefined;
  const hit = mapped === undefined ? -1 : all.findIndex((p) => p.from === mapped);
  const at = ((Math.max(hit, 0) + nth) % all.length + all.length) % all.length;
  view.dispatch({ selection: { anchor: all[at].from, head: all[at].to }, scrollIntoView: true });
  view.focus();
  return { n: all.length, at, exact: hit >= 0 && nth === 0 };
}
