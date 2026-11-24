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
import { identityConfig, type Identity, ownerKey } from "../middleware/identity.ts";
import {
  gitMv, gitRm, VaultNotFound, vaultCommitPath, vaultExists, vaultFileHistory, vaultFolderHistory, vaultGitShow, vaultLastCommitDate, vaultRead, vaultWrite,
} from "../util/vault.ts";
import { safeJoin } from "../util/paths.ts";
import { parseDocument, setFrontmatterField } from "./grammar.ts";
import { expired, later, TRASH_KEEP_DAYS } from "./trash_age.ts";
import { VAULT_GIT, withPathLock } from "./path_lock.ts";
import { NIGHTLY_ACTOR, type TrailKind, writeTrail } from "./trail.ts";
import { deleteListing, listingById, listingRow, type ListingRow, moveListing, syncListing } from "./listing.ts";
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
    return { ok: false, error: "the listing could not be updated (the file is saved; the reconcile pass repairs it)" };
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
export async function moveTo(
  deps: DocDeps, from: string, to: string, message: string, who: Identity, opts: { trail?: "restored" | "unarchived" } = {},
) {
  // under the source path's lock: a removal of the same path (delete forever, empty trash, the nightly) and
  // a move out of it never interleave (rwr-docs-lifecycle-api round 2)
  return await withPathLock(from, () => moveToLocked(deps, from, to, message, who, opts.trail));
}

async function moveToLocked(deps: DocDeps, from: string, to: string, message: string, who: Identity, trailKind?: "restored" | "unarchived") {
  await owned(deps.db, from, who);
  if (!(await vaultExists(from))) throw new DocError("no such document", 404);
  if (await vaultExists(to)) throw new DocError("a document with that name already exists there", 409);
  await withPathLock(VAULT_GIT, () => gitMv(from, to, message, who.name));
  // The listing follows the file first, in its own transaction. A document put back (restore, unarchive) then writes its
  // one trail line AFTER that has committed, so a failing trail write (a table without the slot-510 re-run, a refused
  // insert) can never roll the listing row back: the document id, its refinery link and its reference holders stay with
  // the file. Only a move that really happened reaches here (404, 409 and a failing git mv throw above): no move, no line.
  const row = trailKind ? await listingRow(deps.db, from).catch(() => null) : null;
  try {
    await moveListing(deps.db, from, to);
  } catch (e) {
    console.error(`[documents] listing move ${from} -> ${to} failed (the reconcile pass repairs it):`, (e as Error).message);
  }
  if (trailKind) {
    try {
      await writeTrail(deps.db, {
        owner_sub: row?.owner_sub ?? who.sub, actor_sub: who.sub, kind: trailKind, document_id: row?.id ?? null, path: to, trashed_at: null,
      });
    } catch (e) {
      console.error(`[documents] ${to} was put back (${trailKind}) but its trail line could not be written:`, (e as Error).message);
    }
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
  return { restored: await moveTo(deps, from, liveRel(from), `documents: restore ${from}`, who, { trail: "restored" }) };
}

export async function archiveDocument(deps: DocDeps, path: string, who: Identity) {
  const from = await ownedPath(deps.db, path, who);
  if (isArchived(from)) throw new DocError("already archived", 400);
  return { archived: await moveTo(deps, from, inSubtree(from, ARCHIVE, who), `documents: archive ${from}`, who) };
}

// ── hard removal from the trash (rwr-docs-lifecycle-api) ──────────────────────────────────
// When a trashed document went into the trash: the LATER of the listing record's date (set when the
// move was recorded) and the trash move's COMMITTER date in the vault, so no clock skewed behind can make
// a document older than it is. Unknown = null, and a document with no known date is never removed by
// age (trash_age.ts).
export async function trashedAtOf(row: ListingRow | null, rel: string): Promise<Date | null> {
  let listed: Date | null = null;
  if (row?.updated_at) {
    const d = new Date(row.updated_at);
    listed = Number.isNaN(d.getTime()) ? null : d;
  }
  let committed: Date | null = null;
  try {
    committed = await vaultLastCommitDate(rel);
  } catch { /* no history: the listing's date stands */ }
  return later(listed, committed);
}

// Whose an unlisted document in documents/<key>/... is: the user whose directory key it is (the subjects
// the workbench knows: signed-in users, listing owners, the default identity); otherwise nobody.
export async function ownerOfDirectory(db: Db, rel: string): Promise<string> {
  const key = rel.split("/")[1] ?? "";
  const subs = new Set<string>([identityConfig().defaultSub]);
  for (const q of [`SELECT sub FROM public.workspace_users`, `SELECT DISTINCT owner_sub AS sub FROM public.user_document_listings`]) {
    try {
      for (const r of await db.query<{ sub: string }>(q)) if (r.sub) subs.add(r.sub);
    } catch { /* the other source still answers */ }
  }
  for (const sub of subs) if ((await ownerKey(sub)) === key) return sub;
  return "system:unowned";
}

export interface RemoveResult {
  removed: boolean;
  trail: string | null;
  why?: "gone" | "young";
}

// Remove ONE trashed document for good, under the path's lock: the file is looked at again inside the lock
// (a document restored, unarchived or already removed a moment ago is "gone": nothing removed, no line), the
// optional age rule is re-checked there too, then `git rm` (strict: recoverable from the vault's history),
// and only after the file is really gone the trail line (one per removal) and the listing row.
export async function removeTrashed(
  deps: DocDeps, rel: string, kind: TrailKind,
  o: { actor: string; author: string; owner?: string; expiredAt?: { now: Date; days: number } },
): Promise<RemoveResult> {
  if (!isTrashed(rel)) throw new DocError("not in the trash", 400);
  return await withPathLock(rel, async () => {
    if (!(await vaultExists(rel))) return { removed: false, trail: null, why: "gone" as const };
    const row = await listingRow(deps.db, rel);
    const trashedAt = await trashedAtOf(row, rel);
    if (o.expiredAt && !expired(trashedAt, o.expiredAt.now, o.expiredAt.days)) return { removed: false, trail: null, why: "young" as const };
    const owner = row?.owner_sub ?? o.owner ?? (await ownerOfDirectory(deps.db, rel));
    try {
      await withPathLock(VAULT_GIT, () => gitRm(rel, `documents: remove for good ${rel} (${kind})`, o.author, { strict: true }));
    } catch (e) {
      if (e instanceof VaultNotFound) return { removed: false, trail: null, why: "gone" as const };
      throw e;
    }
    let trail: string | null = null;
    try {
      trail = await writeTrail(deps.db, {
        owner_sub: owner, actor_sub: o.actor, kind, document_id: row?.id ?? null, path: rel, trashed_at: trashedAt,
      });
    } catch (e) {
      // the file is gone (the vault commit keeps the text); say so loudly rather than undo it
      console.error(`[documents] removed ${rel} but its trail line could not be written:`, (e as Error).message);
    }
    await deleteListing(deps.db, rel).catch((e) => console.error(`[documents] listing delete ${rel} failed:`, (e as Error).message));
    return { removed: true, trail };
  });
}

// The nightly hard removal, for every user: only a document trashed MORE than `days` days ago (Q9,
// 30; before rwr-docs-lifecycle-api this removed every trashed document whatever its age). `now` is
// injectable. One failing document is logged and the rest still run.
export async function emptyTrash(deps: DocDeps, by: string, opts: { now?: Date; days?: number } = {}) {
  const now = opts.now ?? new Date();
  const days = opts.days ?? TRASH_KEEP_DAYS;
  const removed: string[] = [];
  let kept = 0;
  const failed: string[] = [];
  for (const f of (await documentFiles(DOCUMENTS_ROOT)).filter(isTrashed)) {
    try {
      const r = await removeTrashed(deps, f, "nightly_expired", { actor: NIGHTLY_ACTOR, author: by, expiredAt: { now, days } });
      if (r.removed) removed.push(f);
      else if (r.why === "young") kept++;
    } catch (e) {
      console.error(`[documents] nightly empty-trash: ${f} failed:`, (e as Error).message);
      failed.push(f);
    }
  }
  return { removed, kept, failed };
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
      console.error(`[documents] reconcile of ${f} failed:`, String((e as Error)?.message ?? e).slice(0, 200));
      failed.push({ path: f, error: "the listing could not be repaired" });
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
// The opaque id of a document to its state, for the caller's OWN documents only. Another person's id, a deleted
// one and a value that is no id at all answer the same 404 with the same words (never a way to tell them apart).
export async function documentById(deps: DocDeps, id: string, who: Identity) {
  const row = await listingById(deps.db, id);
  if (!row || row.owner_sub !== who.sub) throw new DocError("no such document", 404);
  return await documentState(deps, row.path, who);
}

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
    id: row?.id ?? null, path: rel, listed: !!row, trashed: isTrashed(rel), archived: isArchived(rel), carries_idea: !!idea,
    refinery, tags: refinery?.archived ? ["refinery archived"] : [],
  };
}
