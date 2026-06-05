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

export async function vaultRead(relPath: string): Promise<string> {
  return await Deno.readTextFile(safeJoin(config.vault.gitDir, relPath));
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
