// User documents (research-workbench P2b, D12): files in the vault's documents/ tree, written by
// the user, never ingested, never a wiki page. This module is the documents API's file side -
// create, read, save with If-Match, folders, move, trash/restore, archive, history/recover - and
// keeps the listing record (listing.ts) in line with every write.
//
// OWNERSHIP (operator 2026-10-28): a user document is front-end context, isolated per user. Every
// operation takes the identity the seam resolved (src/middleware/identity.ts) and goes through
// owned(), the ONE place that decides whether a path is the user's: a listed document is its row's
// owner_sub's; an unlisted file is the user's when it sits in the user's own directory. Another
// user's document answers exactly like a document that does not exist (404).
//
// ORDER OF OPERATIONS (D12 truth and repair): the FILE is authoritative and is written first; the
// listing update follows. A listing update that fails leaves the file on disk, is reported ONCE (the
// save answers 207 and names it; one notification is posted, deduplicated), and is repaired by the
// reconcile pass - run when the workspace connects (POST /workbench/documents/reconcile) and when
// this service starts. Nothing here writes wiki_pages: a user document never has a row there.
import type { Db } from "../contracts/db.ts";
import type { RegistryReader } from "../contracts/registry.ts";
import { postNotification } from "../contracts/repo/system.ts";
import { config } from "../config.ts";
import type { Identity } from "../middleware/identity.ts";
import {
  gitMv, gitRm, vaultCommitPath, vaultExists, vaultFileHistory, vaultFolderHistory, vaultGitShow, vaultRead, vaultWrite,
} from "../util/vault.ts";
import { safeJoin } from "../util/paths.ts";
import { parseDocument, setFrontmatterField } from "./grammar.ts";
import { deleteListing, listingRow, type ListingRow, moveListing, syncListing } from "./listing.ts";
import {
  ARCHIVE, DOCUMENTS_ROOT, docRel, folderRel, inSubtree, isArchived, isTrashed, liveRel, rootOf, slugify, TRASH,
} from "./paths.ts";

export interface DocDeps {
  db: Db;
  reg: RegistryReader;
}

export class DocError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 | 422 | 502 | 503, public detail: Record<string, unknown> = {}) {
    super(message);
  }
}

const enc = new TextEncoder();
export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── ownership: the one place ──────────────────────────────────────────────────────────────
export async function owned(db: Db, rel: string, who: Identity): Promise<ListingRow | null> {
  const row = await listingRow(db, rel);
  if (row) {
    if (row.owner_sub !== who.sub) throw new DocError("no such document", 404);
    return row;
  }
  if (!rel.startsWith(`${rootOf(who)}/`)) throw new DocError("no such document", 404);
  return null;
}

// The user's document at `path` (full or relative), checked as theirs.
export async function ownedPath(db: Db, path: string, who: Identity): Promise<string> {
  const rel = docRel(path, who);
  await owned(db, rel, who);
  return rel;
}

export interface ListingOutcome {
  ok: boolean;
  error?: string;
}

// Update the listing after a file write; never throws. A failure is reported once: the caller's
// response carries it, and one notification (deduplicated on the document) is posted.
async function afterWrite(deps: DocDeps, rel: string, content: string, who: Identity): Promise<ListingOutcome> {
  try {
    await syncListing(deps.db, deps.reg, rel, content, who, who.name);
    return { ok: true };
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 300);
    console.error(`[documents] listing update failed for ${rel} (the file is saved; the reconcile pass repairs it): ${error}`);
    try {
      await postNotification(deps.db, {
        class: "structural", subject: "a user document's listing could not be updated", entity: `document:${rel}`,
        error: "the file is saved; the listing is repaired when the workspace reconnects",
      });
    } catch { /* the database is what failed; the response still reports it */ }
    return { ok: false, error };
  }
}

export async function readDocument(deps: DocDeps, path: string, who: Identity) {
  const rel = await ownedPath(deps.db, path, who);
  if (!(await vaultExists(rel))) throw new DocError("no such document", 404);
  const content = await vaultRead(rel);
  return { path: rel, content, hash: await sha256(content) };
}

export async function saveDocument(
  deps: DocDeps, path: string, content: string, ifMatch: string | null, who: Identity, opts: { commit?: boolean } = {},
) {
  const rel = await ownedPath(deps.db, path, who);
  if (ifMatch != null && (await vaultExists(rel))) {
    const current = await sha256(await vaultRead(rel));
    if (current !== ifMatch) throw new DocError("conflict", 409, { current_hash: current });
  }
  await vaultWrite(rel, content);
  const listing = await afterWrite(deps, rel, content, who);
  if (opts.commit) await vaultCommitPath(rel, `documents: edit ${rel}`, who.name);
  return { path: rel, hash: await sha256(content), listing };
}

export function newDocumentText(title: string, extra: Record<string, string> = {}, body = ""): string {
  const fm = [`title: ${JSON.stringify(title)}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${JSON.stringify(v)}`)];
  return `---\n${fm.join("\n")}\n---\n\n# ${title}\n\n${body}`;
}

export async function createDocument(
  deps: DocDeps, input: { title: string; folder?: string; body?: string; fields?: Record<string, string> }, who: Identity,
) {
  const title = input.title.trim();
  if (!title) throw new DocError("title is required", 400);
  const dir = folderRel(input.folder ?? "", who);
  let rel = `${dir}/${slugify(title)}.md`;
  for (let n = 2; await vaultExists(rel); n++) rel = `${dir}/${slugify(title)}-${n}.md`;
  const content = newDocumentText(title, input.fields ?? {}, input.body ?? "");
  await vaultWrite(rel, content);
  const listing = await afterWrite(deps, rel, content, who);
  await vaultCommitPath(rel, `documents: create ${rel}`, who.name);
  return { path: rel, hash: await sha256(content), listing };
}

// ── folders ───────────────────────────────────────────────────────────────────────────────
async function walk(rel: string, out: { files: string[]; dirs: string[] }) {
  let entries: Deno.DirEntry[] = [];
  try {
    for await (const e of Deno.readDir(safeJoin(config.vault.gitDir, rel))) entries.push(e);
  } catch {
    return;
  }
  for (const e of entries) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory && e.name !== ".git") {
      out.dirs.push(child);
      await walk(child, out);
    } else if (e.isFile && e.name.endsWith(".md")) out.files.push(child);
  }
}

export async function documentFiles(sub: string): Promise<string[]> {
  const out = { files: [] as string[], dirs: [] as string[] };
  await walk(sub, out);
  return out.files.sort();
}

export async function folders(who: Identity) {
  const out = { files: [] as string[], dirs: [] as string[] };
  const root = rootOf(who);
  await walk(root, out);
  const rel = (d: string) => d.slice(root.length + 1);
  return { root, folders: ["", ...out.dirs.map(rel).filter((d) => !d.startsWith(TRASH) && !d.startsWith(ARCHIVE))].sort() };
}

export async function createFolder(path: string, who: Identity) {
  const dir = folderRel(path, who);
  if (dir === rootOf(who)) throw new DocError("not a folder you can create", 400);
  if (await vaultExists(dir)) return { path: dir, created: false };
  await vaultWrite(`${dir}/.keep`, "");
  await vaultCommitPath(`${dir}/.keep`, `documents: create folder ${dir}`, who.name);
  return { path: dir, created: true };
}

// Delete a folder = trash every document in it (recoverable), then remove the empty folder.
export async function deleteFolder(deps: DocDeps, path: string, who: Identity) {
  const dir = folderRel(path, who);
  if (dir === rootOf(who)) throw new DocError("this folder is protected", 403);
  if (!(await vaultExists(dir))) throw new DocError("no such folder", 404);
  const files = await documentFiles(dir);
  for (const f of files) await moveTo(deps, f, inSubtree(f, TRASH, who), `documents: trash ${f} (folder ${dir})`, who);
  await gitRm(`${dir}/.keep`, `documents: delete folder ${dir}`, who.name);
  try {
    await Deno.remove(safeJoin(config.vault.gitDir, dir), { recursive: true });
  } catch { /* already gone */ }
  return { deleted: dir, trashed: files.length };
}

// ── move, trash, restore, archive ─────────────────────────────────────────────────────────
async function moveTo(deps: DocDeps, from: string, to: string, message: string, who: Identity) {
  await owned(deps.db, from, who);
  if (!(await vaultExists(from))) throw new DocError("no such document", 404);
  if (await vaultExists(to)) throw new DocError("a document with that name already exists there", 409);
  await gitMv(from, to, message, who.name);
  try {
    await moveListing(deps.db, from, to);
  } catch (e) {
    console.error(`[documents] listing move ${from} -> ${to} failed (the reconcile pass repairs it):`, (e as Error).message);
  }
  return to;
}

export async function moveDocument(deps: DocDeps, path: string, toFolder: string, ifMatch: string | null, who: Identity) {
  const from = await ownedPath(deps.db, path, who);
  if (ifMatch != null && (await vaultExists(from)) && (await sha256(await vaultRead(from))) !== ifMatch) {
    throw new DocError("conflict", 409, { current_hash: await sha256(await vaultRead(from)) });
  }
  const to = `${folderRel(toFolder, who)}/${from.split("/").pop()}`;
  if (to === from) throw new DocError("the document is already in that folder", 400);
  await moveTo(deps, from, to, `documents: move ${from} -> ${to}`, who);
  return { from, to, hash: await sha256(await vaultRead(to)) };
}

export async function trashDocument(deps: DocDeps, path: string, who: Identity) {
  const from = await ownedPath(deps.db, path, who);
  if (isTrashed(from)) throw new DocError("already in the trash", 400);
  return { trashed: await moveTo(deps, from, inSubtree(from, TRASH, who), `documents: trash ${from}`, who) };
}

export async function restoreDocument(deps: DocDeps, path: string, who: Identity) {
  const from = await ownedPath(deps.db, path, who);
  if (!isTrashed(from) && !isArchived(from)) throw new DocError("not in the trash or the archive", 400);
  return { restored: await moveTo(deps, from, liveRel(from), `documents: restore ${from}`, who) };
}

export async function archiveDocument(deps: DocDeps, path: string, who: Identity) {
  const from = await ownedPath(deps.db, path, who);
  if (isArchived(from)) throw new DocError("already archived", 400);
  return { archived: await moveTo(deps, from, inSubtree(from, ARCHIVE, who), `documents: archive ${from}`, who) };
}

// The trash's nightly hard removal (the legacy notes' rule), for every user: git rm (recoverable from
// history); the listing row and the document's references go with it.
export async function emptyTrash(deps: DocDeps, by: string) {
  const removed: string[] = [];
  for (const f of (await documentFiles(DOCUMENTS_ROOT)).filter(isTrashed)) {
    await gitRm(f, `documents: empty trash - remove ${f}`, by);
    await deleteListing(deps.db, f).catch((e) => console.error(`[documents] listing delete ${f} failed:`, (e as Error).message));
    removed.push(f);
  }
  return { removed };
}

// ── history + recover ─────────────────────────────────────────────────────────────────────
export async function history(deps: DocDeps, path: string, who: Identity) {
  const rel = await ownedPath(deps.db, path, who);
  const commits = (await vaultFileHistory(rel, 30)).map(({ content: _c, ...c }) => c);
  const folder = await vaultFolderHistory(rootOf(who), 40);
  // a commit that moved the document here is part of its history too (trash, restore, move)
  const moves = folder.filter((c) => c.files.some((f) => f.path === rel || liveRel(f.path) === liveRel(rel)));
  const seen = new Set(commits.map((c) => c.hash));
  return { path: rel, commits: [...commits, ...moves.filter((m) => !seen.has(m.hash)).map(({ files: _f, ...m }) => m)] };
}

export async function recoverDocument(deps: DocDeps, path: string, from: string, who: Identity) {
  const rel = await ownedPath(deps.db, path, who);
  if (!/^[0-9a-fA-F]{7,40}$/.test(from)) throw new DocError("bad commit hash", 400);
  const content = (await vaultGitShow(from, rel)) ?? (await vaultGitShow(`${from}~1`, rel));
  if (content == null) throw new DocError("the document does not exist at that revision", 404);
  const live = liveRel(rel);
  await vaultWrite(live, content);
  const listing = await afterWrite(deps, live, content, who);
  await vaultCommitPath(live, `documents: recover ${live} @ ${from.slice(0, 8)}`, who.name);
  return { recovered: live, hash: await sha256(content), listing };
}

// ── properties (frontmatter) ──────────────────────────────────────────────────────────────
export async function setProperty(deps: DocDeps, path: string, key: string, value: string | null, ifMatch: string | null, who: Identity) {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new DocError("a property key is letters, digits, - and _", 400);
  const doc = await readDocument(deps, path, who);
  return await saveDocument(deps, doc.path, setFrontmatterField(doc.content, key, value), ifMatch ?? doc.hash, who, { commit: true });
}

// ── reconcile (D12 truth and repair) ──────────────────────────────────────────────────────
// One walk of the user's own directory: a file whose listing row is missing, or older than the file,
// is re-listed from the file (a new row is the user's); a row of theirs whose file is gone is removed.
// Idempotent. The default identity's pass also covers the documents written before P2b at the root.
export async function reconcile(deps: DocDeps, who: Identity, opts: { legacyRoot?: boolean } = {}) {
  const files = await documentFiles(rootOf(who));
  if (opts.legacyRoot) {
    for (const f of await documentFiles(DOCUMENTS_ROOT)) {
      const second = f.split("/")[1] ?? "";
      if (f.split("/").length === 2 || second.startsWith(".")) files.push(f); // documents/<file>, documents/.trash/...
    }
  }
  const rows = await deps.db.query<{ path: string; updated_at: string; owner_sub: string }>(
    `SELECT path, updated_at, owner_sub FROM public.user_document_listings`,
  );
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const repaired: string[] = [];
  const failed: { path: string; error: string }[] = [];
  for (const f of [...new Set(files)]) {
    const row = byPath.get(f);
    if (row && row.owner_sub !== who.sub) continue; // another user's row: theirs to repair
    const st = await Deno.stat(safeJoin(config.vault.gitDir, f));
    if (row && new Date(row.updated_at).getTime() >= (st.mtime?.getTime() ?? 0)) continue;
    try {
      await syncListing(deps.db, deps.reg, f, await vaultRead(f), who, "reconcile");
      repaired.push(f);
    } catch (e) {
      failed.push({ path: f, error: String((e as Error).message).slice(0, 200) });
    }
  }
  const removed: string[] = [];
  for (const r of rows) {
    if (r.owner_sub !== who.sub || !r.path.startsWith(`${DOCUMENTS_ROOT}/`)) continue;
    if (await vaultExists(r.path)) continue;
    await deleteListing(deps.db, r.path);
    removed.push(r.path);
  }
  return { files: files.length, repaired, removed, failed };
}

// For a document that is open: whether it is listed, trashed or archived, whether it carries an idea,
// and its refinery (with the "refinery archived" tag).
export async function documentState(deps: DocDeps, path: string, who: Identity) {
  const rel = await ownedPath(deps.db, path, who);
  const row = await listingRow(deps.db, rel);
  const content = (await vaultExists(rel)) ? await vaultRead(rel) : null;
  const idea = content ? parseDocument(content, rel).idea : "";
  let refinery: { id: string; status: string; archived: boolean } | null = null;
  if (row?.refinery_id) {
    const r = (await deps.db.query<{ status: string; archived_at: string | null }>(
      `SELECT i.status, rs.archived_at FROM public.ideas i LEFT JOIN public.refinery_state rs ON rs.refinery_id = i.id WHERE i.id = $1`,
      [row.refinery_id],
    ))[0];
    if (r) refinery = { id: row.refinery_id, status: r.status, archived: !!r.archived_at };
  }
  return {
    path: rel, listed: !!row, trashed: isTrashed(rel), archived: isArchived(rel), carries_idea: !!idea,
    refinery, tags: refinery?.archived ? ["refinery archived"] : [],
  };
}
