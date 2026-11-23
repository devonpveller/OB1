// What the writing surface reads and writes (rwr-doc-editor). Every call goes through lib/api.ts (the one door);
// this file never names a user and keeps nothing in the browser. The routes are the workbench's own:
//   GET  documents/file     { path, content, hash }            (hash = SHA-256 hex of the file, repo.ts sha256)
//   PUT  documents/file     { content, if_match } -> { path, hash, listing }; ?commit=1 makes a version.
//                           A stale if_match is 409 { error: "conflict", current_hash } and nothing is written.
//   GET  documents/history  { path, commits: [{ hash, author, date, message }] }, newest first, at most 30
//   GET  documents/folders  { root, folders }                  (the root turns the path into a breadcrumb)
//   POST documents/research { path, query, kind } -> 202 { job_id, refinery_id, kind }
//   GET  contract/references/<id>                  the reference record at its pin and its source
//   GET  contract/chunks/<source>:<idx>/context    the cited passage and its neighbours
import { api, ApiError } from "../../lib/api";
import { parseFrontmatter } from "../../lib/grammar";
import { folderOf, NOT_FOUND, problem, splitFront } from "../documents/docs-data";

export const HISTORY_CAP = 30; // the history route's limit: a count at the cap means "this many or more"
export const AUTOSAVE_MS = 1500;

export type Loaded = { raw: string; hash: string; title: string; front: string; body: string };

// A document's file as the writing surface holds it: the front matter (kept verbatim, never shown or edited here)
// and the body (what the person writes). front + body is exactly the file.
export function splitFile(raw: string, path: string): Pick<Loaded, "front" | "body" | "title"> {
  const fm = parseFrontmatter(raw);
  return { front: raw.slice(0, fm.end), body: raw.slice(fm.end), title: splitFront(raw, path).title };
}

export async function loadDocument(path: string): Promise<Loaded> {
  const { data } = await api<any>("GET", `/workbench/documents/file?path=${encodeURIComponent(path)}`);
  if (!data || typeof data.content !== "string" || typeof data.hash !== "string") throw new Error("unexpected answer");
  return { raw: data.content, hash: data.hash, ...splitFile(data.content, path) };
}

// Is the person signed in NOW the one this screen was opened for? A save is only sent when it is: the shell notices a change
// of person on its own timer, and until then a pending autosave would leave under the next person's session. Unknown (the
// read failed) counts as no: nothing is sent that cannot be tied to the person who wrote it.
export async function isSamePerson(subject: string): Promise<boolean> {
  try {
    const { data } = await api<any>("GET", "/workbench/workspace/whoami");
    return typeof data?.subject_sub === "string" && data.subject_sub === subject;
  } catch { return false; }
}

export type Saved = { hash: string; listingOk: boolean };
export class Conflict extends Error {
  constructor(public currentHash: string) { super("conflict"); }
}
// Write the file. `ifMatch` is the hash of the text this tab last read or wrote: the server refuses (409) when the
// file is now different, and this throws Conflict, never overwriting. Any other refusal is thrown as it is.
export async function saveDocument(path: string, content: string, ifMatch: string, commit: boolean): Promise<Saved> {
  try {
    const r = await api<any>("PUT", `/workbench/documents/file?path=${encodeURIComponent(path)}${commit ? "&commit=1" : ""}`, { content, if_match: ifMatch });
    if (!r.data || typeof r.data.hash !== "string") throw new Error("unexpected answer");
    return { hash: r.data.hash, listingOk: r.status !== 207 && r.data.listing?.ok !== false };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) throw new Conflict(String(e.body?.current_hash ?? ""));
    throw e;
  }
}

export type Version = { n: number; atLeast: boolean; at: string };
// The version number is derived from the history (the vault's commits; no number is stored): how many commits the
// document has, newest date alongside. A history at the route's cap says "this many or more".
export async function readVersion(path: string): Promise<Version> {
  const { data } = await api<any>("GET", `/workbench/documents/history?path=${encodeURIComponent(path)}`);
  if (!data || !Array.isArray(data.commits)) throw new Error("unexpected answer");
  const dates = data.commits.map((c: any) => Date.parse(String(c?.date ?? ""))).filter((t: number) => Number.isFinite(t));
  return { n: data.commits.length, atLeast: data.commits.length >= HISTORY_CAP, at: dates.length ? new Date(Math.max(...dates)).toISOString() : "" };
}
export const versionText = (v: Version | null) => (v ? `v${v.n}${v.atLeast ? "+" : ""}` : "v-");

export async function readRoot(): Promise<string> {
  try {
    const { data } = await api<any>("GET", "/workbench/documents/folders");
    return typeof data?.root === "string" ? data.root : "";
  } catch { return ""; }
}
// "Hardware/Boards" -> ["Hardware", "Boards"]: the breadcrumb between "Documents" and the title
export const crumbsOf = (path: string, root: string): string[] => folderOf(path, root).split("/").filter(Boolean);

// ── the cited passage (the side drawer until the Source screen lands) ──
export type Cited = {
  referenceId: string;
  title: string;
  pinned: number;          // the revision the reference is pinned to
  current: number | null;  // the source's newest revision, when it has moved on
  quote: string;           // the exact words the reference pins (they come from the pinned revision)
  passage: { idx: number; text: string; target: boolean }[]; // the pinned chunk and its neighbours (current text)
  state: string;
};
export async function readCited(referenceId: string): Promise<Cited> {
  const { data } = await api<any>("GET", `/workbench/contract/references/${encodeURIComponent(referenceId)}`);
  // a reference id answers with its record; a plain source id (a [[source:...]] link) answers with the source only
  const rec = data?.record ?? null;
  // a source in the shared library answers `source`; a HELD source (still in an idea's refinery) answers `held`, with its
  // title and excerpt there (references.ts referenceById) - `source` is null for it
  const src = data?.source ?? data?.held ?? null;
  if (!data || typeof data !== "object" || (!rec && !src)) throw new Error("unexpected answer");
  const sourceId = typeof rec?.source_id === "string" ? rec.source_id : "";
  const quote = typeof rec?.selectors?.quote?.exact === "string" ? rec.selectors.quote.exact : typeof src?.excerpt === "string" ? src.excerpt : "";
  const current = typeof data.version === "number" ? data.version : null;
  const pinned = Number(rec?.pinned_revision) || current || 1;
  const idx = typeof rec?.chunk_idx === "number" ? rec.chunk_idx : null;
  let passage: Cited["passage"] = [];
  if (idx !== null && sourceId) {
    try {
      const c = await api<any>("GET", `/workbench/contract/chunks/${encodeURIComponent(sourceId + ":" + idx)}/context?window=1`);
      if (Array.isArray(c.data?.chunks)) {
        passage = c.data.chunks.map((x: any) => ({ idx: Number(x.idx), text: String(x.content ?? ""), target: x.is_target === true }));
      }
    } catch { /* the pinned words below still stand */ }
  }
  return { referenceId, title: String(src?.title ?? "") || "Untitled source", pinned, current, quote, passage, state: String(data.state ?? "") };
}

// ── "Research this" until Start research lands (phase 3): the document's own research route ──
export async function queueResearch(path: string, query: string): Promise<void> {
  await api("POST", "/workbench/documents/research", { path, query, kind: "research" });
}
export function researchProblem(e: unknown): string {
  if (e instanceof ApiError && e.status === 503) return "Research is not set up on this stack yet.";
  return problem(e, "The research could not be queued.");
}
export { NOT_FOUND, problem };
