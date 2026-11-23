// What the Documents screen (rwr-docs-list) reads and writes. Every call goes through lib/api.ts (the one door)
// for the subject the server resolves: this code never names a user, and nothing read here is written to
// storage, a cache or the console. The server decides whose a document is (the identity seam and the owner
// scope); another person's document answers exactly like a missing one (404), and this file turns every such
// answer into the same fixed sentence, so the page cannot tell the two apart either.
//
// The routes (all landed): contract/documents (the listing: title, path, updated, outbound links), documents/
// folders, POST documents (new), documents/folders (new folder), archive, unarchive, trash, restore,
// delete-forever and empty-trash (both need confirm: true), documents/state and documents/file.
import { api, ApiError } from "../../lib/api";

export type Tab = "active" | "archived" | "trash";
export type Link = { kind: string; id: string };
export type DocRow = {
  title: string;
  path: string;      // the full vault path, as the server gives it (documents/<key>/[.trash|.archive/]folder/x.md)
  updated: string;
  links: Link[];
  tab: Tab;          // where it is: from the path alone (the .trash / .archive sub-trees of the person's directory)
  folder: string;    // its folder relative to the person's root ("" = Unfiled), the same in every tab
};
export type Listing = { root: string; folders: string[]; docs: DocRow[]; capped: boolean };

export const LIST_LIMIT = 500;          // the contract's maximum page
export const TRASH_KEEP_DAYS = 30;      // Q9 (decided 2026-11-20): the nightly removes a document trashed more than 30 days ago
const DAY_MS = 86_400_000;
export const NOT_FOUND = "There is no such document."; // one sentence for "missing" and "someone else's"

// documents/<key>/.trash/a/b.md (or documents/.trash/b.md, a document from before per-person directories):
// the same rule as the workbench's paths.ts
const SUBTREE = /^(documents\/(?:[^./][^/]*\/)?)\.(trash|archive)\//;
export const tabOf = (path: string): Tab => {
  const m = SUBTREE.exec(path)?.[2];
  return m === "trash" ? "trash" : m === "archive" ? "archived" : "active";
};
export const livePath = (path: string) => path.replace(SUBTREE, "$1");

export function folderOf(path: string, root: string): string {
  const live = livePath(path);
  const rel = root && live.startsWith(root + "/") ? live.slice(root.length + 1) : live.replace(/^documents\//, "");
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const time = (s: unknown) => { const t = Date.parse(String(s ?? "")); return Number.isFinite(t) ? t : 0; };
// a 200 that is not the expected JSON (a sign-in page, a wrong shape) is a FAILED read, never an empty list
const listOf = (data: any, key: string): any[] => {
  if (!data || typeof data !== "object" || !Array.isArray(data[key])) throw new Error("unexpected answer");
  return data[key];
};

export async function readListing(): Promise<Listing> {
  const [docs, fol] = await Promise.all([
    api("GET", "/workbench/contract/documents?limit=" + LIST_LIMIT),
    api("GET", "/workbench/documents/folders"),
  ]);
  const root = typeof fol.data?.root === "string" ? fol.data.root : "";
  const folders = listOf(fol.data, "folders").filter((f): f is string => typeof f === "string");
  const raw = listOf(docs.data, "documents");
  const rows: DocRow[] = raw
    .filter((d) => d && typeof d.path === "string" && d.path !== "")
    .map((d) => ({
      title: String(d.title ?? ""), path: d.path, updated: String(d.updated ?? ""),
      links: arr(d.outbound_links).map((l) => ({ kind: String(l?.kind ?? ""), id: String(l?.id ?? "") })),
      tab: tabOf(d.path), folder: folderOf(d.path, root),
    }))
    .sort((a, b) => time(b.updated) - time(a.updated));
  return { root, folders, docs: rows, capped: raw.length >= LIST_LIMIT };
}

// The folders the side list shows for a tab: every folder the server lists (they hold active documents or none),
// plus any folder a document of this tab still names (a trashed document's folder may since have gone), each
// with the number of THIS tab's documents in it. "" (the person's root) is "Unfiled".
export function foldersFor(l: Listing, tab: Tab): { folder: string; count: number }[] {
  const inTab = l.docs.filter((d) => d.tab === tab);
  const names = new Set<string>(l.folders);
  for (const d of inTab) names.add(d.folder);
  return [...names].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map((folder) => ({ folder, count: inTab.filter((d) => d.folder === folder).length }));
}

const PLURAL: Record<string, [string, string]> = {
  source: ["source", "sources"], claim: ["claim", "claims"], idea: ["idea", "ideas"], session: ["research run", "research runs"],
  run: ["research run", "research runs"], topic: ["topic", "topics"],
};
// "6 sources · 1 idea", in a fixed order; nothing = "nothing yet"
export function linkedText(links: Link[]): string {
  const n = new Map<string, number>();
  for (const l of links) if (l.kind) n.set(l.kind, (n.get(l.kind) ?? 0) + 1);
  if (n.size === 0) return "nothing yet";
  const order = Object.keys(PLURAL);
  return [...n.entries()].sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99))
    .map(([k, c]) => `${c} ${(PLURAL[k] ?? [k, k])[c === 1 ? 0 : 1]}`).join(" · ");
}

// "2 h ago", "yesterday", "3 days ago"
export function ago(iso: string, now = Date.now()): string {
  const t = time(iso);
  if (!t) return "";
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + " h ago";
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : d + " days ago";
}

// Days left before the nightly removes a document trashed at `trashedAt` (the listing's date: the trash move
// sets it). The nightly removes it once MORE than 30 days have passed, so it is never less than 0; unknown = null.
export function daysLeft(trashedAt: string, now = Date.now()): number | null {
  const t = time(trashedAt);
  if (!t) return null;
  return Math.max(0, Math.ceil((t + TRASH_KEEP_DAYS * DAY_MS - now) / DAY_MS));
}
export function goesText(trashedAt: string, now = Date.now()): string {
  const n = daysLeft(trashedAt, now);
  if (n === null) return "goes by itself 30 days after it was trashed";
  return n === 0 ? "goes by itself tonight" : `goes by itself in ${n} ${n === 1 ? "day" : "days"}`;
}

// A failure the person can read. A 404 (missing, or someone else's) is always the one fixed sentence; any other
// refusal shows the server's own short reason (the workbench answers fixed texts, never another person's data).
export function problem(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return NOT_FOUND;
    if (e.status >= 400 && e.status < 500 && e.message && e.message.length < 200) return e.message;
  }
  return fallback;
}

// ── the actions: each answers the document's new path (or nothing for a removal) ──
const post = <T,>(url: string, body: unknown) => api<T>("POST", url, body).then((r) => r.data);

export const archive = (path: string) => post<{ archived: string }>("/workbench/documents/archive", { path }).then((d) => String(d.archived));
export const unarchive = (path: string) => post<{ unarchived: string }>("/workbench/documents/unarchive", { path }).then((d) => String(d.unarchived));
export const trash = (path: string) => post<{ trashed: string }>("/workbench/documents/trash", { path }).then((d) => String(d.trashed));
export const restore = (path: string) => post<{ restored: string }>("/workbench/documents/restore", { path }).then((d) => String(d.restored));
export const deleteForever = (path: string) => post<{ removed: boolean }>("/workbench/documents/delete-forever", { path, confirm: true });
export const emptyTrash = () => post<{ removed: number; failed: number }>("/workbench/documents/empty-trash", { confirm: true });
export const createDocument = (title: string, folder: string) => post<{ path: string }>("/workbench/documents", { title, folder }).then((d) => String(d.path));
export const createFolder = (path: string) => post<{ path: string; created: boolean }>("/workbench/documents/folders", { path });

// ── one document, for the document screen ──
export type DocState = { path: string; listed: boolean; trashed: boolean; archived: boolean };
export async function readState(path: string): Promise<DocState> {
  const { data } = await api<any>("GET", `/workbench/documents/state?path=${encodeURIComponent(path)}`);
  if (!data || typeof data.path !== "string") throw new Error("unexpected answer");
  return { path: data.path, listed: data.listed === true, trashed: data.trashed === true, archived: data.archived === true };
}
export async function readFile(path: string): Promise<{ title: string; body: string }> {
  const { data } = await api<any>("GET", `/workbench/documents/file?path=${encodeURIComponent(path)}`);
  if (!data || typeof data.content !== "string") throw new Error("unexpected answer");
  return splitFront(data.content, path);
}

const baseTitle = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() || path;
// The front matter's title (a JSON string, as the workbench writes it) and the body after it.
export function splitFront(content: string, path: string): { title: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  let title = baseTitle(path);
  if (!m) return { title, body: content };
  const t = /^title:\s*(.+?)\s*$/m.exec(m[1]);
  if (t) {
    try { const v = JSON.parse(t[1]); if (typeof v === "string" && v.trim()) title = v.trim(); } catch { if (t[1].trim()) title = t[1].trim(); }
  }
  return { title, body: content.slice(m[0].length) };
}

// The href that opens a document: the path is ONE segment (its slashes encoded), so the router hands it back whole.
export const docHref = (path: string) => "/documents/" + encodeURIComponent(path);
