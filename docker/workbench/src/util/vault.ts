// Vault read/write + git commit (P3/P4/P6). The workbench's OWN programmatic
// commits INSIDE the vault repo are the sanctioned exception to G1 (that IS the
// notes + Changes-log write mechanism) — LOCAL only, no remote push (the
// wiki-service handles any remote). All writes go through the shared path
// validator (safeJoin) so nothing escapes the vault.
import { config } from "../config.ts";
import { safeJoin } from "./paths.ts";

const dec = new TextDecoder();

async function git(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const cmd = new Deno.Command("git", {
    args: ["-C", config.vault.gitDir, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const { success, stdout, stderr } = await cmd.output();
  return { ok: success, out: dec.decode(stdout), err: dec.decode(stderr) };
}

// Ensure the vault is a git repo the workbench can commit to (notes + Changes
// log). Idempotent — `git init` is a no-op on an existing repo, and we only set
// a default identity if none exists, so this never disturbs the wiki-service's
// repo config in prod. Best-effort; logged, never fatal.
export async function ensureVaultRepo(): Promise<void> {
  try {
    await Deno.mkdir(config.vault.gitDir, { recursive: true });
    if (!(await vaultExists(".git"))) {
      await git(["init", "-q"]);
    }
    const who = await git(["config", "user.email"]);
    if (!who.out.trim()) {
      await git(["config", "user.email", "workbench@openbrain.local"]);
      await git(["config", "user.name", "openbrain-workbench"]);
    }
  } catch (e) {
    console.error("[workbench] ensureVaultRepo (non-fatal):", (e as Error).message);
  }
}

export async function vaultRead(relPath: string): Promise<string> {
  return await Deno.readTextFile(safeJoin(config.vault.gitDir, relPath));
}

// Commit ONLY the given path (a note, or a dir like "notes/") if it has staged
// changes, optionally attributing the commit to `author` (the Authelia user, for
// note "commit now" / Done). P4.7-style working-draft model for notes: writes
// don't commit; this does. Retries once on the wiki-service's index lock.
export async function vaultCommitPath(
  relPath: string,
  message: string,
  author?: string,
): Promise<{ committed: boolean }> {
  await git(["add", relPath]);
  const status = await git(["status", "--porcelain", relPath]);
  if (!status.out.trim()) return { committed: false };
  const args = ["commit", "-q"];
  if (author) args.push(`--author=${author} <${author}@notes.local>`);
  args.push("-m", message);
  let res = await git(args);
  if (!res.ok && /index\.lock/.test(res.err)) {
    await new Promise((r) => setTimeout(r, 500));
    res = await git(args);
  }
  if (!res.ok) throw new Error(`git commit failed: ${res.err.slice(0, 300)}`);
  return { committed: true };
}

// File content at a specific commit (for revert) — `git show <hash>:<path>`.
export async function vaultGitShow(hash: string, relPath: string): Promise<string | null> {
  const r = await git(["show", `${hash}:${relPath}`]);
  return r.ok ? r.out : null;
}

// Discard uncommitted working changes to a file — restore it from HEAD.
export async function vaultDiscard(relPath: string): Promise<void> {
  await git(["checkout", "HEAD", "--", relPath]);
}

// Git history of a single file: recent commits (hash, author, date, message) +
// the file content at each (for line diffs). Bounded to `limit` commits.
export async function vaultFileHistory(
  relPath: string,
  limit = 20,
): Promise<{ hash: string; author: string; date: string; message: string; content: string }[]> {
  const log = await git([
    "log",
    `-n${limit}`,
    "--format=%H%x1f%an%x1f%aI%x1f%s",
    "--",
    relPath,
  ]);
  if (!log.ok) return [];
  const rows = log.out.split("\n").filter((l) => l.trim());
  const out: { hash: string; author: string; date: string; message: string; content: string }[] = [];
  for (const r of rows) {
    const [hash, author, date, message] = r.split("\x1f");
    const show = await git(["show", `${hash}:${relPath}`]);
    out.push({ hash, author, date, message, content: show.ok ? show.out : "" });
  }
  return out;
}

// Recent git history of a DIRECTORY: commits touching anything under it, each with
// its changed-file list + status (A/M/D/R…). Powers the folder-history view and
// recover-a-trashed-note. Bounded to `limit` commits.
export async function vaultFolderHistory(
  relDir: string,
  limit = 40,
): Promise<
  { hash: string; author: string; date: string; message: string; files: { status: string; path: string }[] }[]
> {
  const log = await git(["log", `-n${limit}`, "--name-status", "--format=%x1e%H%x1f%an%x1f%aI%x1f%s", "--", relDir]);
  if (!log.ok) return [];
  const out: { hash: string; author: string; date: string; message: string; files: { status: string; path: string }[] }[] = [];
  for (const block of log.out.split("\x1e").filter((b) => b.trim())) {
    const lines = block.split("\n");
    const [hash, author, date, message] = (lines.shift() || "").split("\x1f");
    if (!hash) continue;
    const files = lines
      .filter((l) => l.trim())
      .map((l) => {
        const parts = l.split("\t");
        return { status: parts[0], path: parts[parts.length - 1] };
      });
    out.push({ hash, author, date, message, files });
  }
  return out;
}

export async function vaultExists(relPath: string): Promise<boolean> {
  try {
    await Deno.stat(safeJoin(config.vault.gitDir, relPath));
    return true;
  } catch {
    return false;
  }
}

export async function vaultWrite(relPath: string, content: string): Promise<string> {
  const abs = safeJoin(config.vault.gitDir, relPath);
  const dir = abs.slice(0, abs.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(abs, content);
  return abs;
}

// Binary write — used for image assets under assets/<source-id>/ (P5.6). These
// live on the wiki-assets volume (gitignored), so they never enter vault git.
export async function vaultWriteBinary(relPath: string, bytes: Uint8Array): Promise<string> {
  const abs = safeJoin(config.vault.gitDir, relPath);
  const dir = abs.slice(0, abs.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeFile(abs, bytes);
  return abs;
}

export async function vaultDelete(relPath: string): Promise<void> {
  try {
    await Deno.remove(safeJoin(config.vault.gitDir, relPath));
  } catch { /* already gone */ }
}

// Move/rename a file with `git mv` (history preserved), then commit — optionally
// authored. Falls back to a plain filesystem move for an untracked draft note
// (never-committed); git still detects the rename by content at diff time, so
// `log --follow` history survives. Creates the destination's parent dir first;
// retries once on the wiki-service's index lock (same volume).
export async function gitMv(
  fromRel: string,
  toRel: string,
  message: string,
  author?: string,
): Promise<{ committed: boolean }> {
  const absFrom = safeJoin(config.vault.gitDir, fromRel);
  const absTo = safeJoin(config.vault.gitDir, toRel);
  await Deno.mkdir(absTo.slice(0, absTo.lastIndexOf("/")), { recursive: true });

  let mv = await git(["mv", fromRel, toRel]);
  if (!mv.ok && /index\.lock/.test(mv.err)) {
    await new Promise((r) => setTimeout(r, 500));
    mv = await git(["mv", fromRel, toRel]);
  }
  if (!mv.ok) {
    if (/not under version control|bad source|source.*not exist|did not match/i.test(mv.err)) {
      // Untracked draft (autosave never committed): git mv can't move it. Plain
      // rename, then stage ONLY the new path — the old path was never tracked, so
      // there is nothing in the index to clean up (and `git add` of a now-deleted
      // untracked pathspec errors and stages nothing).
      await Deno.rename(absFrom, absTo);
      await git(["add", "--", toRel]);
    } else {
      throw new Error(`git mv failed: ${mv.err.slice(0, 300)}`);
    }
  }

  const args = ["commit", "-q"];
  if (author) args.push(`--author=${author} <${author}@notes.local>`);
  args.push("-m", message);
  let res = await git(args);
  if (!res.ok && /index\.lock/.test(res.err)) {
    await new Promise((r) => setTimeout(r, 500));
    res = await git(args);
  }
  if (!res.ok) throw new Error(`git commit failed: ${res.err.slice(0, 300)}`);
  return { committed: true };
}

// Commit whatever is currently staged under `pathspec` (if anything), optionally
// authored. Lock-retry like the other commit helpers. Used by the delete ops,
// where `git rm` has already staged the removal.
async function commitIfStaged(
  pathspec: string,
  message: string,
  author?: string,
): Promise<{ committed: boolean }> {
  const staged = await git(["diff", "--cached", "--name-only", "--", pathspec]);
  if (!staged.out.trim()) return { committed: false };
  const args = ["commit", "-q"];
  if (author) args.push(`--author=${author} <${author}@notes.local>`);
  args.push("-m", message);
  let res = await git(args);
  if (!res.ok && /index\.lock/.test(res.err)) {
    await new Promise((r) => setTimeout(r, 500));
    res = await git(args);
  }
  if (!res.ok) throw new Error(`git commit failed: ${res.err.slice(0, 300)}`);
  return { committed: true };
}

// Delete a single file: `git rm` the tracked file (the removal is a recorded
// commit, so the prior content stays recoverable via history), then commit. An
// untracked draft (never committed) is just removed — no revision to preserve.
export async function gitRm(
  relPath: string,
  message: string,
  author?: string,
): Promise<{ committed: boolean }> {
  let rm = await git(["rm", "--quiet", "--", relPath]);
  if (!rm.ok && /index\.lock/.test(rm.err)) {
    await new Promise((r) => setTimeout(r, 500));
    rm = await git(["rm", "--quiet", "--", relPath]);
  }
  if (!rm.ok) {
    if (/did not match|not under version control/i.test(rm.err)) {
      try {
        await Deno.remove(safeJoin(config.vault.gitDir, relPath));
      } catch { /* already gone */ }
      return { committed: false };
    }
    throw new Error(`git rm failed: ${rm.err.slice(0, 300)}`);
  }
  return await commitIfStaged(relPath, message, author);
}

// Delete a folder and ALL its contents: `git rm -r` the tracked files (recorded
// for recovery), then remove the directory (sweeping any untracked drafts), then
// commit. `--ignore-unmatch` so a folder of only-untracked files doesn't error.
export async function gitRmRecursive(
  relPath: string,
  message: string,
  author?: string,
): Promise<{ committed: boolean }> {
  await git(["rm", "-r", "--quiet", "--ignore-unmatch", "--", relPath]);
  try {
    await Deno.remove(safeJoin(config.vault.gitDir, relPath), { recursive: true });
  } catch { /* already gone */ }
  return await commitIfStaged(relPath, message, author);
}

// Commit the working tree if (and only if) something changed. Best-effort: a
// failure is surfaced but never corrupts state. Retries once on an index lock
// (the wiki-service may be mid-commit on the same volume).
export async function vaultCommit(message: string): Promise<{ committed: boolean }> {
  await git(["add", "-A"]);
  const status = await git(["status", "--porcelain"]);
  if (!status.out.trim()) return { committed: false };
  let res = await git(["commit", "-q", "-m", message]);
  if (!res.ok && /index\.lock/.test(res.err)) {
    await new Promise((r) => setTimeout(r, 500));
    res = await git(["commit", "-q", "-m", message]);
  }
  if (!res.ok) throw new Error(`git commit failed: ${res.err.slice(0, 300)}`);
  return { committed: true };
}
