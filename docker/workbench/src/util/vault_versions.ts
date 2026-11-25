// Git reads for a document's versions (rwr-doc-versions-api). Read-only: nothing here writes the vault.
import { git } from "./vault.ts";

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
// move only when git's rename detection (renames only, never copies) pairs it, in that same commit, with a file it
// removed; the chase then continues from that file's last commit before it. The chase stops at the commit that
// created the file, or at a commit that deleted the path (what is older was another document). Never reads a
// file's content; the blobs say whether the TEXT changed (`oldBlob === blob`: a move that left it alone).
export async function vaultFileCommits(relPath: string): Promise<FileCommit[]> {
  const out: FileCommit[] = [];
  let path = relPath;
  let rev = "HEAD";
  for (let hop = 0; hop < 1000; hop++) {
    const log = await git([
      "-c", "core.quotepath=false", "log", "--raw", "--no-abbrev", "--no-renames", "--no-color",
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
        const moved = await renamedInFrom(hash, path);
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

// Did this commit move a file to `path` (git's rename detection, renames only)? The path and blob it had before.
async function renamedInFrom(hash: string, path: string): Promise<{ from: string; oldBlob: string } | null> {
  const r = await git(["-c", "core.quotepath=false", "diff-tree", "--root", "-r", "-M", "--raw", "--no-abbrev", "--no-commit-id", hash]);
  if (!r.ok) return null;
  for (const l of r.out.split("\n")) {
    if (!l.startsWith(":")) continue;
    const [meta, ...p] = l.split("\t");
    const f = meta.slice(1).split(" ");
    if ((f[4] ?? "").startsWith("R") && p[1] === path) return { from: p[0], oldBlob: blobOf(f[2]) };
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

// `git diff <from> <to> -- <paths>` exactly as git prints it (no colour, no external diff or textconv).
// Both commits are hashes git itself gave; the two paths are the file's path in each (the same path twice
// is passed once).
export async function vaultDiff(from: { hash: string; path: string }, to: { hash: string; path: string }): Promise<string> {
  for (const h of [from.hash, to.hash]) if (!/^[0-9a-f]{40}$/.test(h)) throw new Error("bad commit hash");
  const paths = from.path === to.path ? [from.path] : [from.path, to.path];
  const r = await git(["-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", from.hash, to.hash, "--", ...paths]);
  if (!r.ok) throw new Error(`git diff failed: ${r.err.slice(0, 200)}`);
  return r.out;
}
