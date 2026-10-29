// Where user documents live (research-workbench P2b, D12): the vault's `documents/` tree, distinct
// from the legacy `notes/` tree, with ONE directory per user (operator 2026-10-28: user documents are
// front-end context, isolated per user): documents/<owner key>/... where the key is the identity
// seam's filesystem-safe form of the subject. Trash and archive are sub-trees of the user's
// directory, so the listing record (title, path, updated, links - nothing else) tells them apart by
// path alone. Listings written before P2b may sit at documents/<file> (no owner directory); their
// owner is the listing row's owner_sub.
import { safeFolderRel, safeRelPath } from "../util/paths.ts";
import type { Identity } from "../middleware/identity.ts";

export const DOCUMENTS_ROOT = "documents";
export const TRASH = ".trash";
export const ARCHIVE = ".archive";
export const HOLDER_KIND = "user_document"; // a key of reference_holder_kinds (P2a)

export function rootOf(who: Identity): string {
  return `${DOCUMENTS_ROOT}/${who.key}`;
}

// A document path as the API takes it: the full vault path ("documents/<key>/ideas/x.md", as every
// response gives it), or relative to the user's own directory ("ideas/x.md"). Traversal-safe, .md only.
export function docRel(path: string, who: Identity): string {
  const safe = safeRelPath(path);
  if (!safe.endsWith(".md")) throw new Error("a user document is a .md file");
  return safe.startsWith(`${DOCUMENTS_ROOT}/`) ? safe : `${rootOf(who)}/${safe}`;
}

export function folderRel(folder: string, who: Identity): string {
  const f = (folder ?? "").trim();
  if (!f || f === DOCUMENTS_ROOT || f === rootOf(who)) return rootOf(who);
  const safe = safeFolderRel(f);
  if (safe.split("/").some((p) => p.startsWith("."))) throw new Error("invalid folder name");
  if (safe.startsWith(`${rootOf(who)}/`)) return safe;
  if (safe.startsWith(`${DOCUMENTS_ROOT}/`)) throw new Error("invalid folder name");
  return `${rootOf(who)}/${safe}`;
}

const SUBTREE = /^(documents\/(?:[^./][^/]*\/)?)\.(trash|archive)\//;

export function isTrashed(rel: string): boolean {
  return SUBTREE.exec(rel)?.[2] === "trash";
}

export function isArchived(rel: string): boolean {
  return SUBTREE.exec(rel)?.[2] === "archive";
}

// documents/<key>/.trash/a/b.md -> documents/<key>/a/b.md (the same for .archive)
export function liveRel(rel: string): string {
  return rel.replace(SUBTREE, "$1");
}

export function inSubtree(rel: string, sub: string, who: Identity): string {
  const live = liveRel(rel);
  const root = live.startsWith(`${rootOf(who)}/`) ? rootOf(who) : DOCUMENTS_ROOT;
  return `${root}/${sub}/${live.slice(root.length + 1)}`;
}

export function slugify(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
}
