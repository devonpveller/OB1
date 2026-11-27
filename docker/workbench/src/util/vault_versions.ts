// Git reads for a document's versions (rwr-doc-versions-api). Read-only: nothing here writes the vault.
import { git } from "./vault.ts";
import { liveRel } from "../documents/paths.ts";

// One commit of a file's history, as git's raw diff reports it: the path the file had in that commit, its blob
// before and after, and the status letter (A, M, or R for a commit that moved the file in from `from`).
export interface FileCommit {
  hash: string;
  author: string;
  date: string;
  message: string;
  status: string;
  path: string;
  from?: string; // for status R: the path it was moved from
  oldBlob: string;
  blob: string;
}

const ZERO_BLOB = /^0+$/;
const blobOf = (s: string | undefined) => (!s || ZERO_BLOB.test(s) ? "" : s);
const RS = "\x1e";
const US = "\x1f";

// A document's commits, newest first, chased across the renames that brought it to `relPath` (a move, a trash, a
// restore, an archive: each a `git mv` commit). NOT `git log --follow`: that also follows COPIES, so a new document
// whose text equals another's would inherit the other's whole history. Here a commit that added the path counts as a
// move only when it is a rename (git's -M, exact or with an edit) from a file in the SAME owner's tree, in that same commit
// (see renamedInFrom); the chase then continues from that file's last commit before it. The chase stops at the commit that
// created the file, or at a commit that deleted the path (what is older was another document). Never reads a
// file's content; the blobs say whether the TEXT changed (`oldBlob === blob`: a move that left it alone).
export async function vaultFileCommits(relPath: string, legacyOwnerOk?: LegacyOwnerCheck): Promise<FileCommit[]> {
  const out: FileCommit[] = [];
  let path = relPath;
  let rev = "HEAD";
  for (let hop = 0; hop < 1000; hop++) {
    const log = await git([
      "--literal-pathspecs", "-c", "core.quotepath=false", "log", "--raw", "--no-abbrev", "--no-renames", "--no-color",
      `--format=%x1e%H%x1f%an%x1f%aI%x1f%s`, rev, "--", path,
    ]);
    if (!log.ok) return out;
    let next: { rev: string; path: string } | null = null;
    for (const block of log.out.split(RS).filter((b) => b.trim())) {
      const lines = block.split("\n");
      const [hash, author, date, message] = (lines.shift() ?? "").split(US);
      const raw = lines.find((l) => l.startsWith(":"));
      if (!hash || !raw) continue;
      const f = raw.split("\t")[0].slice(1).split(" ");
      const status = f[4] ?? "";
      if (status === "D") return out; // deleted here: what is older was another document
      const c: FileCommit = { hash, author, date, message, status, path, oldBlob: blobOf(f[2]), blob: blobOf(f[3]) };
      if (status === "A") {
        const moved = await renamedInFrom(hash, path, message, legacyOwnerOk);
        if (moved) {
          out.push({ ...c, status: "R", from: moved.from, oldBlob: moved.oldBlob });
          next = { rev: `${hash}~1`, path: moved.from };
          break;
        }
        out.push(c);
        return out; // the commit that created the file
      }
      out.push(c);
    }
    if (!next) return out;
    rev = next.rev;
    path = next.path;
  }
  return out;
}

// Whose tree a vault path is in, for the rename chase: documents/<key>/... is the user's own directory (their
// trash and archive are sub-trees of it); a legacy file at documents/<file>.md or under documents/.trash|.archive
// has no directory key (its owner is its listing row's), so all of those share one scope. Not a path: a scope.
export function ownerScope(path: string): string {
  const p = path.split("/");
  if (p[0] !== "documents" || p.length < 3 || p[1].startsWith(".")) return "";
  return p[1];
}

// Is a rename pairing `from` -> `to` provably ONE owner's document moving? Only inside documents/. A path outside it (notes/,
// content/, anything else) is never followed into or out of documents/. documents/<key>/... pairs only within the same key. A
// LEGACY pairing (scope '': documents/<file>.md, documents/.trash|.archive/...: no key, many listing owners share it) is
// followed only for the app's own trash, restore or archive move of the SAME file: both sides have one live path
// (liveRel(from) === liveRel(to)), so a different legacy name, a note or a wiki file is never taken for a move.
// The route layer's proof that a LEGACY pairing (scope '': no owner key in the path) is the requesting owner's own file moving:
// it gets the pairing's two paths and the commit subject. Without one, a legacy pairing is never followed (history lost, never leaked).
export type LegacyOwnerCheck = (from: string, to: string, message: string) => Promise<boolean>;

export function sameOwnerMove(from: string, to: string): boolean {
  if (!from.startsWith("documents/") || !to.startsWith("documents/")) return false;
  const s = ownerScope(from);
  if (s !== ownerScope(to)) return false;
  return s !== "" || liveRel(from) === liveRel(to);
}

// Did this commit move a file to `path`? A rename (git's -M: the same file, with or without an edit in the same commit)
// whose source sits in the SAME owner's tree is followed. Every move, trash, restore and archive this app makes is an
// exact rename, but a writer that commits the whole tree (a note write's `git add -A`) can land an edit in the same
// commit as the move, and the history must survive that. A pairing with a file of ANOTHER owner is never a move of this
// document, however similar or even identical the bytes: a commit can carry two owners' files, and following a pairing
// across them would hand one user the other's history and text (ownerScope).
// `-z` output: paths are NUL-terminated and never quoted, so a path with a quote, a backslash or any other
// character git would quote still compares equal.
async function renamedInFrom(hash: string, path: string, message: string, legacyOwnerOk?: LegacyOwnerCheck): Promise<{ from: string; oldBlob: string } | null> {
  const r = await git(["diff-tree", "--root", "-r", "-z", "-M", "--raw", "--no-abbrev", "--no-commit-id", hash]);
  if (!r.ok) return null;
  const t = r.out.split("\0");
  for (let i = 0; i < t.length; i++) {
    if (!t[i].startsWith(":")) continue;
    const f = t[i].slice(1).split(" ");
    const status = f[4] ?? "";
    if (status.startsWith("R")) {
      const from = t[i + 1] ?? "";
      const to = t[i + 2] ?? "";
      i += 2;
      if (to === path && sameOwnerMove(from, to)) {
        // keyed pairings are the owner's by the path; a legacy one has no key in it, so the caller must prove whose file `from` was
        if (ownerScope(from) === "" && !(legacyOwnerOk && (await legacyOwnerOk(from, to, message)))) continue;
        return { from, oldBlob: blobOf(f[2]) };
      }
    } else {
      i += 1;
    }
  }
  return null;
}

// The text of a blob, by its id (never a path: the file may have been renamed since).
export async function vaultBlob(blob: string): Promise<string | null> {
  if (!/^[0-9a-f]{40}$/.test(blob)) return null;
  const r = await git(["cat-file", "blob", blob]);
  return r.ok ? r.out : null;
}

// The blob id the working file would have if committed as it is now (null: no such file).
export async function vaultWorkingBlob(relPath: string): Promise<string | null> {
  const r = await git(["hash-object", "--", relPath]);
  return r.ok && /^[0-9a-f]{40}$/.test(r.out.trim()) ? r.out.trim() : null;
}

// The diff of two versions of one document, exactly as `git diff` prints it (no colour, no external diff or
// textconv): blob against blob, `<commit>:<path the file had there>` on each side, so a different document that
// now sits at the old path is never part of it. For one path the output equals `git diff <c1> <c2> -- <path>`;
// across a move the header names both paths. Both commits are hashes git itself gave.
export async function vaultDiff(from: { hash: string; path: string }, to: { hash: string; path: string }): Promise<string> {
  for (const h of [from.hash, to.hash]) if (!/^[0-9a-f]{40}$/.test(h)) throw new Error("bad commit hash");
  const r = await git(["-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", `${from.hash}:${from.path}`, `${to.hash}:${to.path}`]);
  if (!r.ok) throw new Error(`git diff failed: ${r.err.slice(0, 200)}`);
  return r.out;
}
