// Numbered versions, named snapshots, restore and compare of a user document (rwr-doc-versions-api).
//
// WHAT A VERSION IS. A document's text lives in the vault's git repository; its VERSIONS are the commits
// that CHANGED ITS TEXT, counted from the oldest (v1 is the commit that created it), following the file across
// renames. A commit that only moved the file (move, trash, restore, archive, unarchive: a `git mv`, the blob
// unchanged) is not a version, so those never shift a number; a rename that also edited the text is one. The
// number is derived on every read from git alone (nothing is stored), so it is the same after a reload and
// the same wherever the document now sits. A document deleted for good and written again at the same path
// starts again at v1 (the history older than the deletion is not its own).
//
// SNAPSHOTS. A snapshot is a named marker on one version, kept in public.document_snapshots (slot 620),
// owner-scoped: it holds the commit and the blob the version had, never a path, so a move does not lose it.
// Another user's snapshot, a snapshot of another of the caller's documents and an id that is nothing all answer
// the same 404.
//
// OWNERSHIP. Every function takes the identity the seam resolved and goes through ownedPath() first, the one
// place that decides whether a path is the caller's: another user's document answers exactly like a document
// that does not exist (404 "no such document"), before anything about versions, snapshots or counts is read.
import type { Identity } from "../middleware/identity.ts";
import { afterWrite, commitLocked, DocError, ownedPath, sha256, type DocDeps } from "./repo.ts";
import { isArchived, isTrashed } from "./paths.ts";
import { withPathLock } from "./path_lock.ts";
import { vaultExists, vaultRead, vaultWrite } from "../util/vault.ts";
import { type LegacyOwnerCheck, vaultBlob, vaultDiff, vaultFileCommits, vaultWorkingBlob } from "../util/vault_versions.ts";

export interface Version {
  version: number;
  commit: string;
  blob: string;
  path: string; // the path the file had in that commit
  author: string;
  date: string;
  message: string;
}

export interface SnapshotRow {
  id: string;
  name: string;
  kind: "named" | "before_restore";
  commit_hash: string;
  blob_hash: string;
  created_at: string;
}

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NAME_MAX = 120;

const noDocument = () => new DocError("no such document", 404);
const noVersion = () => new DocError("no such version", 404);
const noSnapshot = () => new DocError("no such snapshot", 404);

// ── the numbering ─────────────────────────────────────────────────────────────────────────────
// The commits that changed this file's text, oldest first, numbered from 1.
// A legacy file (documents/<file>.md, its .trash/.archive: no owner key in the path) is followed across a rename only when it is
// provably the caller's own file moving (legacyOwnerCheck); without `ctx` no legacy pairing is followed.
export async function versionsOf(rel: string, ctx?: { db: DocDeps["db"]; who: Identity }): Promise<Version[]> {
  const out: Version[] = [];
  for (const c of (await vaultFileCommits(rel, ctx && legacyOwnerCheck(ctx.db, ctx.who))).reverse()) {
    if (!c.blob || c.blob === c.oldBlob) continue; // a move (or a mode change): the text is the same
    out.push({ version: out.length + 1, commit: c.hash, blob: c.blob, path: c.path, author: c.author, date: c.date, message: c.message });
  }
  return out;
}

// Is a legacy pairing from -> to the caller's own file moving? Both must hold:
//  1. the commit is the app's own move of `from` (subject `documents: trash|restore|archive|unarchive|move <from>`; the app
//     moves a file only after checking the mover owns `from`). A whole-tree sweep (wiki compile, a note write) is not: its
//     pairing of one legacy file with another is never a move, so history is lost there, never leaked.
//  2. no other owner is on record for `from`: a listing row at `from`, or the removal trail's line for it, names someone else
//     (the listing row's owner is the owner of a legacy file). A failed lookup means not established: not followed.
export function legacyOwnerCheck(db: DocDeps["db"], who: Identity): LegacyOwnerCheck {
  return async (from, _to, message) => {
    const m = /^documents: (trash|restore|archive|unarchive|move) (.+?)(?: -> .*| \(folder .*\))?$/.exec(message);
    if (!m || m[2] !== from) return false;
    try {
      for (const sql of [
        `SELECT owner_sub FROM public.user_document_listings WHERE path = $1`,
        `SELECT owner_sub FROM public.user_document_trail WHERE path = $1`,
      ]) {
        for (const r of (await db.query(sql, [from])) as { owner_sub: string }[]) if (r.owner_sub !== who.sub) return false;
      }
    } catch {
      return false;
    }
    return true;
  };
}

async function loadDocument(deps: DocDeps, path: string, who: Identity) {
  const rel = await ownedPath(deps.db, path, who);
  if (!(await vaultExists(rel))) throw noDocument();
  return rel;
}

// Whether the file on disk differs from its last version (a save that was not committed): the text is
// not yet a version, so a snapshot or a restore first makes it one.
async function pendingText(rel: string, versions: Version[]): Promise<boolean> {
  const working = await vaultWorkingBlob(rel);
  return working !== null && working !== (versions[versions.length - 1]?.blob ?? "");
}

// Commit the text the file has now as a version (if it differs from the last one); the new list.
async function settle(deps: DocDeps, rel: string, versions: Version[], who: Identity): Promise<Version[]> {
  if (!(await pendingText(rel, versions))) return versions;
  await commitLocked(rel, `documents: edit ${rel}`, who.name);
  return await versionsOf(rel, { db: deps.db, who });
}

// ── snapshots (the table) ─────────────────────────────────────────────────────────────────────
function missingTable(e: unknown): boolean {
  const code = (e as { fields?: { code?: string } })?.fields?.code ?? (e as { code?: string })?.code;
  return code === "42P01" || /document_snapshots/.test(String((e as Error)?.message ?? "")) && /does not exist/.test(String((e as Error)?.message ?? ""));
}

async function snapshotQuery<T>(deps: DocDeps, sql: string, args: unknown[]): Promise<T[]> {
  try {
    return await deps.db.query<T>(sql, args);
  } catch (e) {
    // the slot is not applied: fail closed, say nothing about why
    if (missingTable(e)) throw new DocError("snapshots are not available", 503);
    throw e;
  }
}

async function snapshotsAmong(deps: DocDeps, who: Identity, versions: Version[]): Promise<Map<string, SnapshotRow[]>> {
  const out = new Map<string, SnapshotRow[]>();
  if (!versions.length) return out;
  const rows = await snapshotQuery<SnapshotRow>(
    deps,
    `SELECT id::text AS id, name, kind, commit_hash, blob_hash, created_at::text AS created_at
       FROM public.document_snapshots WHERE owner_sub = $1 AND commit_hash = ANY($2::text[]) ORDER BY created_at, id`,
    [who.sub, versions.map((v) => v.commit)],
  );
  const keys = new Set(versions.map((v) => `${v.commit}:${v.blob}`));
  for (const r of rows) {
    const k = `${r.commit_hash}:${r.blob_hash}`;
    if (!keys.has(k)) continue; // the same commit marked for another of the owner's documents
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return out;
}

const snapshotOut = (r: SnapshotRow, version: number) => ({ id: r.id, name: r.name, kind: r.kind, version, created_at: r.created_at });

async function addSnapshot(deps: DocDeps, who: Identity, v: Version, name: string, kind: "named" | "before_restore") {
  const rows = await snapshotQuery<SnapshotRow>(
    deps,
    `INSERT INTO public.document_snapshots (owner_sub, actor_sub, commit_hash, blob_hash, name, kind)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id::text AS id, name, kind, commit_hash, blob_hash, created_at::text AS created_at`,
    [who.sub, who.actor, v.commit, v.blob, name, kind],
  );
  return rows[0];
}

// A commit can carry more than one owner's files, and a writer that commits the whole tree (a note write, the
// changes log, the wiki compile: `git add -A`) can sweep this document's staged or unsaved change into ITS commit. So
// what a commit says is not always about this document: its author is shown only when it is the caller's own name, and
// its message only when that commit is one the caller made through the documents API (author is the caller, message
// starts "documents: ") and every document path it names is a path this document has had. A version made inside someone
// else's commit stays a numbered version (the text did change) with its author and message withheld.
const ownAuthor = (author: string, who: Identity) => (author === who.name ? author : null);
function ownMessage(message: string, author: string, versions: Version[], who: Identity): string {
  if (author !== who.name || !message.startsWith("documents: ")) return "";
  const mine = new Set(versions.map((v) => v.path));
  for (const m of message.matchAll(/documents\/\S*/g)) if (!mine.has(m[0].replace(/\)+$/, ""))) return "";
  return message;
}

// ── reads ─────────────────────────────────────────────────────────────────────────────────────
export const LIMIT_DEFAULT = 100;
export const LIMIT_MAX = 500;

// The versions, newest first, each with its snapshots. Paged on `before` (a version number): `next` is the
// value to send as `before` for the following page, null at the end. `total` is the number of versions this
// document has (the caller's own).
export async function listVersions(deps: DocDeps, path: string, who: Identity, opts: { limit?: number; before?: number | null } = {}) {
  const rel = await loadDocument(deps, path, who);
  const versions = await versionsOf(rel, { db: deps.db, who });
  const snaps = await snapshotsAmong(deps, who, versions);
  const limit = Math.min(Math.max(opts.limit ?? LIMIT_DEFAULT, 1), LIMIT_MAX);
  const older = versions.filter((v) => opts.before == null || v.version < opts.before).reverse();
  const page = older.slice(0, limit);
  return {
    path: rel,
    current_version: versions.length ? versions[versions.length - 1].version : null,
    unsaved_changes: await pendingText(rel, versions),
    total: versions.length,
    versions: page.map((v) => ({
      version: v.version, commit: v.commit, saved_at: v.date, author: ownAuthor(v.author, who), message: ownMessage(v.message, v.author, versions, who),
      snapshots: (snaps.get(`${v.commit}:${v.blob}`) ?? []).map((s) => snapshotOut(s, v.version)),
    })),
    next: older.length > limit ? page[page.length - 1].version : null,
  };
}

// Every snapshot of this document, newest first.
export async function listSnapshots(deps: DocDeps, path: string, who: Identity) {
  const rel = await loadDocument(deps, path, who);
  const versions = await versionsOf(rel, { db: deps.db, who });
  const snaps = await snapshotsAmong(deps, who, versions);
  const all: ReturnType<typeof snapshotOut>[] = [];
  for (const v of versions) for (const s of snaps.get(`${v.commit}:${v.blob}`) ?? []) all.push(snapshotOut(s, v.version));
  all.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.version - a.version));
  return { path: rel, total: all.length, snapshots: all };
}

// ── snapshot ──────────────────────────────────────────────────────────────────────────────────
export function cleanName(v: unknown): string {
  const name = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  // deno-lint-ignore no-control-regex
  if (!name || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new DocError(`a snapshot needs a name of 1 to ${NAME_MAX} characters`, 400);
  }
  return name;
}

export function versionNumber(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new DocError(`${what} is a whole number, 1 or more`, 400);
  return n;
}

// A named marker on one version (the newest when none is named). Unsaved text is made a version first, so the
// marker is on what the caller sees.
export async function createSnapshot(deps: DocDeps, input: { path: string; name: unknown; version?: unknown }, who: Identity) {
  const rel = await loadDocument(deps, input.path, who);
  const name = cleanName(input.name);
  const want = input.version == null ? null : versionNumber(input.version, "version");
  return await withPathLock(rel, async () => {
    let versions = await versionsOf(rel, { db: deps.db, who });
    if (want == null) versions = await settle(deps, rel, versions, who);
    const v = want == null ? versions[versions.length - 1] : versions.find((x) => x.version === want);
    if (!v) throw noVersion();
    const s = await addSnapshot(deps, who, v, name, "named");
    return { snapshot: snapshotOut(s, v.version), current_version: versions[versions.length - 1].version };
  });
}

// ── restore ───────────────────────────────────────────────────────────────────────────────────
// First an automatic snapshot of the CURRENT version, "Before restoring vN", then the old text written as a
// NEW version (history is only ever added to). Restoring text the document already has changes nothing.
// A trashed or archived document is put back first (restore from the trash), never restored in place.
export async function restoreVersion(deps: DocDeps, input: { path: string; version?: unknown; snapshot_id?: unknown }, who: Identity) {
  const rel = await loadDocument(deps, input.path, who);
  if (isTrashed(rel) || isArchived(rel)) throw new DocError("put the document back from the trash or the archive before restoring a version", 400);
  const hasV = input.version != null;
  const hasS = input.snapshot_id != null;
  if (hasV === hasS) throw new DocError("name the version or the snapshot to restore, not both and not neither", 400);
  const wantV = hasV ? versionNumber(input.version, "version") : null;
  let snapId: string | null = null;
  if (hasS) {
    snapId = typeof input.snapshot_id === "string" ? input.snapshot_id : "";
    if (!UUIDISH.test(snapId)) throw noSnapshot();
  }
  return await withPathLock(rel, async () => {
    // the target is looked up on the COMMITTED versions first: a restore that answers 404 changes nothing (unsaved
    // text becomes a version only once the target is known); settling only appends, so the target stays valid
    let versions = await versionsOf(rel, { db: deps.db, who });
    let target: Version | undefined;
    if (snapId) {
      const row = (await snapshotQuery<SnapshotRow>(
        deps,
        `SELECT id::text AS id, name, kind, commit_hash, blob_hash, created_at::text AS created_at
           FROM public.document_snapshots WHERE id = $1::uuid AND owner_sub = $2`,
        [snapId, who.sub],
      ))[0];
      target = row ? versions.find((v) => v.commit === row.commit_hash && v.blob === row.blob_hash) : undefined;
      if (!target) throw noSnapshot();
    } else {
      target = versions.find((v) => v.version === wantV);
      if (!target) throw noVersion();
    }
    versions = await settle(deps, rel, versions, who);
    const current = versions[versions.length - 1];
    if (target.blob === current.blob) {
      return { restored: false, unchanged: true, from_version: target.version, version: current.version, snapshot: null };
    }
    const text = await vaultBlob(target.blob);
    if (text == null) throw noVersion();
    const before = await addSnapshot(deps, who, current, `Before restoring v${target.version}`, "before_restore");
    const prior = await vaultRead(rel);
    let listing;
    try {
      await vaultWrite(rel, text);
      listing = await afterWrite(deps, rel, text, who);
      await commitLocked(rel, `documents: restore ${rel} to v${target.version}`, who.name);
    } catch (e) {
      await vaultWrite(rel, prior).catch(() => {}); // the file is what it was; the marker on the current version stays (it is true)
      throw e;
    }
    const after = await versionsOf(rel, { db: deps.db, who });
    return {
      restored: true, unchanged: false, from_version: target.version, version: after[after.length - 1].version,
      snapshot: snapshotOut(before, current.version), hash: await sha256(text), listing,
    };
  });
}

// ── compare ───────────────────────────────────────────────────────────────────────────────────
// Two versions of one document: git's own diff of the two commits on this file, read-only.
export async function compareVersions(deps: DocDeps, path: string, from: unknown, to: unknown, who: Identity) {
  const rel = await loadDocument(deps, path, who);
  const a = versionNumber(from, "from");
  const b = versionNumber(to, "to");
  const versions = await versionsOf(rel, { db: deps.db, who });
  const va = versions.find((v) => v.version === a);
  const vb = versions.find((v) => v.version === b);
  if (!va || !vb) throw noVersion();
  const diff = va.blob === vb.blob ? "" : await vaultDiff({ hash: va.commit, path: va.path }, { hash: vb.commit, path: vb.path });
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const l of diff.split("\n")) {
    if (l.startsWith("@@")) inHunk = true;
    else if (l.startsWith("diff --git")) inHunk = false;
    else if (inHunk && l.startsWith("+")) added++;
    else if (inHunk && l.startsWith("-")) removed++;
  }
  const meta = (v: Version) => ({ version: v.version, commit: v.commit, saved_at: v.date });
  return { path: rel, from: meta(va), to: meta(vb), identical: va.blob === vb.blob, added, removed, diff };
}
