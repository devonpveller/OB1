// Vault read/write + git commit (P3/P4/P6). The workbench's OWN programmatic
// commits INSIDE the vault repo are the sanctioned exception to G1 (that IS the
// notes + Changes-log write mechanism) — LOCAL only, no remote push (the
// wiki-service handles any remote). All writes go through the shared path
// validator (safeJoin) so nothing escapes the vault.
import { config } from "../config.ts";
import { safeJoin } from "./paths.ts";

const dec = new TextDecoder();

export async function git(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
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

// The COMMITTER date of the latest commit touching `relPath` (the trash move's, for a trashed file): the
// date git stamped when the commit was made, not the author date a caller can pass. null when unknown.
export async function vaultLastCommitDate(relPath: string): Promise<Date | null> {
  const r = await git(["log", "-1", "--format=%cI", "--", relPath]);
  if (!r.ok || !r.out.trim()) return null;
  const d = new Date(r.out.trim());
  return Number.isNaN(d.getTime()) ? null : d;
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
  // The commit below is limited to this move's own paths (git commit --only): a file that anyone else has staged (a whole-tree
  // `git add -A` of a note write, the wiki compile, a hand-staged change) stays staged and never rides in this commit under this
  // move's subject. `from` is a pathspec only when git knew it (a plain-renamed untracked draft was never in the index).
  const paths = mv.ok ? [fromRel, toRel] : [toRel];
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

  // A TRACKED file's move is committed ALONE and AS STAGED (renameCommit), and ONLY that way: never `git commit -- <paths>`, which
  // takes the WORKING-TREE text of the moved file - an autosave left unsaved on disk would then ride in the move commit and,
  // when it rewrites most of the file, turn the rename into a delete plus an add and cut the document's numbered history
  // (rwr-doc-versions-api attempts 5 and 6). Anything anyone else has staged stays staged, and the moved file's unsaved text stays
  // unsaved. When another writer's commit lands inside renameCommit's window, `update-ref HEAD <new> <old>` refuses (it must:
  // that is what keeps the other commit); the move is then rebuilt on the new HEAD and tried again, a few times with a short
  // backoff. If it still cannot be committed, the move is UNDONE (git mv back) and fails with an error: nothing is committed.
  if (mv.ok) {
    let last: "cas" | "fail" = "cas";
    for (let attempt = 0; attempt < RENAME_TRIES; attempt++) {
      const r = await renameCommit(fromRel, toRel, message, author);
      if (r === "done") return { committed: true };
      last = r;
      if (r === "fail") break;
      await new Promise((res) => setTimeout(res, 20 * (attempt + 1)));
    }
    const undone = await git(["mv", toRel, fromRel]); // the staged rename goes back: the file, its index entry and its text as they were
    throw new Error(
      `git move of ${fromRel} not committed (${last === "cas" ? `HEAD kept moving, ${RENAME_TRIES} tries` : "a plumbing step failed"}); ` +
        `${undone.ok ? "the move was undone" : "the move could NOT be undone: " + undone.err.slice(0, 120)}`,
    );
  }

  // An untracked draft that git mv could not move (never in the index, so no history to lose): a commit limited to its new path
  // (`git commit --only`), so a file that anyone else has staged still never rides in it.
  const args = ["commit", "-q"];
  if (author) args.push(`--author=${author} <${author}@notes.local>`);
  args.push("-m", message, "--", ...paths);
  const cargs = ["--literal-pathspecs", ...args];
  let res = await git(cargs);
  if (!res.ok && /index\.lock/.test(res.err)) {
    await new Promise((r) => setTimeout(r, 500));
    res = await git(cargs);
  }
  if (!res.ok) throw new Error(`git commit failed: ${res.err.slice(0, 300)}`);
  return { committed: true };
}

// how many times a tracked move is rebuilt on a new HEAD after another writer's commit landed in its window
const RENAME_TRIES = 6;

// Commit exactly the staged rename `from` -> `to`: HEAD's tree, minus `from`, plus `to` with the blob and mode the INDEX
// holds (what `git mv` staged), through a private index file and git's plumbing; the real index and the working tree are
// not touched. "cas": HEAD moved while this was built (update-ref refused: the other commit is kept, nothing of ours is
// recorded); "fail": a plumbing step failed. The branch moves only if HEAD is still the commit this was built on.
async function renameCommit(fromRel: string, toRel: string, message: string, author?: string): Promise<"done" | "cas" | "fail"> {
  const gd = await git(["rev-parse", "--absolute-git-dir"]);
  const head = await git(["rev-parse", "--verify", "-q", "HEAD"]);
  if (!gd.ok || !head.ok) return "fail";
  const tmp = `${gd.out.trim()}/index.rename.${crypto.randomUUID().slice(0, 8)}`;
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const r = await new Deno.Command("git", {
      args: ["-C", config.vault.gitDir, "--literal-pathspecs", ...args], env: { GIT_INDEX_FILE: tmp, ...env }, stdout: "piped", stderr: "piped",
    }).output();
    return { ok: r.success, out: dec.decode(r.stdout) };
  };
  try {
    const staged = await git(["--literal-pathspecs", "ls-files", "-s", "-z", "--", toRel]);
    const m = /^(\d{6}) ([0-9a-f]{40}) \d\t/.exec(staged.out);
    if (!staged.ok || !m) return "fail";
    if (!(await run(["read-tree", head.out.trim()])).ok) return "fail";
    if (!(await run(["update-index", "--force-remove", "--", fromRel])).ok) return "fail";
    if (!(await run(["update-index", "--add", "--cacheinfo", `${m[1]},${m[2]},${toRel}`])).ok) return "fail";
    const tree = await run(["write-tree"]);
    if (!tree.ok) return "fail";
    const env: Record<string, string> = {};
    if (author) Object.assign(env, { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author}@notes.local` });
    const made = await run(["commit-tree", tree.out.trim(), "-p", head.out.trim(), "-m", message], env);
    if (!made.ok) return "fail";
    const moved = await git(["update-ref", "-m", message.split("\n")[0], "HEAD", made.out.trim(), head.out.trim()]);
    return moved.ok ? "done" : "cas";
  } catch {
    return "fail";
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
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
// `strict`: a file that is not there at all is not "removed" - it throws VaultNotFound, so a second
// caller racing the first learns it removed nothing (rwr-docs-lifecycle-api).
export class VaultNotFound extends Error {
  constructor(relPath: string) {
    super(`not in the vault: ${relPath}`);
  }
}

export async function gitRm(
  relPath: string,
  message: string,
  author?: string,
  opts: { strict?: boolean } = {},
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
      } catch (e) {
        if (opts.strict && e instanceof Deno.errors.NotFound) throw new VaultNotFound(relPath);
        /* already gone */
      }
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
