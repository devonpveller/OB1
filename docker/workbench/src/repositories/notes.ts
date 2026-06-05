// Notes repository (P3). Notes are markdown files in the author-owned `notes/`
// vault layer (NOT the generation pool). The workbench writes them + commits
// (G1 exception). One ingestion surface for both human and AI notes (3.3).
import { config } from "../config.ts";
import { safeRelPath } from "../util/paths.ts";
// @ts-ignore — plain .mjs from the /recipes bind-mount.
import { slugifyNotebook } from "@shared/slug";
import { vaultCommit, vaultExists, vaultRead, vaultWrite } from "../util/vault.ts";

const enc = new TextEncoder();

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// `notePath` is relative to notes/ (e.g. "my-notebook/idea.md"). Must be .md.
function notesRel(notePath: string): string {
  const rel = safeRelPath(notePath);
  if (!rel.endsWith(".md")) throw new Error("notes must be .md files");
  return `notes/${rel}`;
}

export async function readNote(notePath: string): Promise<{ content: string; hash: string } | null> {
  const rel = notesRel(notePath);
  if (!(await vaultExists(rel))) return null;
  const content = await vaultRead(rel);
  return { content, hash: await sha256(content) };
}

// Write a note with optimistic concurrency: if `ifMatch` is given it must equal
// the current on-disk hash, else 409-style conflict. Returns the new hash.
export async function writeNote(
  notePath: string,
  content: string,
  ifMatch?: string | null,
): Promise<{ hash: string } | { conflict: true; current: string }> {
  const rel = notesRel(notePath);
  if (ifMatch != null && (await vaultExists(rel))) {
    const current = await sha256(await vaultRead(rel));
    if (current !== ifMatch) return { conflict: true, current };
  }
  await vaultWrite(rel, content);
  await vaultCommit(`notes: write ${rel}`);
  return { hash: await sha256(content) };
}

// Structured / AI-note hand-off (3.3/3.4): write into notes/<notebook-slug>/ with
// a provenance stamp in frontmatter (source = user_note | ai_note + agent/chat).
// One write path — the same as human notes; ingestNotes tethers it.
export async function writeStructuredNote(input: {
  notebook: string;
  title: string;
  content: string;
  source?: "user_note" | "ai_note";
  agent?: string;
  chat?: string;
}): Promise<{ path: string; hash: string }> {
  const nbSlug = slugifyNotebook(input.notebook);
  const fileSlug = slugifyNotebook(input.title) || "note";
  // AI-authored content lives in the SEPARATE `ai/` tree, segregated from the
  // user-owned `notes/` layer — user notes are NEVER touched by AI (#5). Both
  // tether to their notebook and the wiki ingests both (ai/ as ai_note); they
  // just live in distinct, clearly-owned folders.
  const rel = `ai/${nbSlug}/${fileSlug}.md`;
  const fm = [
    "---",
    `title: ${JSON.stringify(input.title)}`,
    `source: ${input.source ?? "ai_note"}`,
    ...(input.agent ? [`agent: ${JSON.stringify(input.agent)}`] : []),
    ...(input.chat ? [`chat: ${JSON.stringify(input.chat)}`] : []),
    `notebook: ${JSON.stringify(input.notebook)}`,
    "tags: [note, ai]",
    "---",
    "",
  ].join("\n");
  const body = fm + input.content + "\n";
  await vaultWrite(rel, body);
  await vaultCommit(`ai-note: write ${rel}`);
  return { path: rel, hash: await sha256(body) };
}

// Notes index — git-tracked .md, split by ownership: `user` (notes/) vs `ai`
// (ai/). Paths are relative to their tree. READMEs excluded.
export async function notesIndex(): Promise<{ user: string[]; ai: string[] }> {
  const ls = async (dir: string): Promise<string[]> => {
    const cmd = new Deno.Command("git", {
      args: ["-C", config.vault.gitDir, "ls-files", dir],
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout } = await cmd.output();
    return new TextDecoder().decode(stdout)
      .split("\n")
      .filter((f) => f.endsWith(".md") && !/README\.md$/i.test(f));
  };
  return {
    user: (await ls("notes/")).map((f) => f.replace(/^notes\//, "")),
    ai: (await ls("ai/")).map((f) => f.replace(/^ai\//, "")),
  };
}
