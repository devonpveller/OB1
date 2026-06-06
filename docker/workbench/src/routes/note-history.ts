// /workbench/note-history + /workbench/note-commit (P4.7) — a note's revision
// history, git-backed (notes live in the vault repo). Notes follow the same
// working-draft model as sources: edits write the file; a revision is COMMITTED
// either by "commit now" here (authored = Authelia user) or by the next compile.
// Separate routers (not under notes/:notePath{.+}, which would swallow these).
import { Hono } from "hono";
import type { Context } from "hono";
import { safeRelPath } from "../util/paths.ts";
import { vaultCommitPath, vaultExists, vaultFileHistory, vaultRead } from "../util/vault.ts";

function authorOf(c: Context): string {
  return (
    c.req.header("Remote-User") ||
    c.req.header("X-Forwarded-User") ||
    c.req.header("X-Remote-User") ||
    "operator"
  ).toString();
}

// `path` is the FULL vault-relative note path (notes/…/x.md).
function notePath(c: Context): string {
  const rel = safeRelPath(c.req.query("path") || "");
  if (!rel.startsWith("notes/") || !rel.endsWith(".md")) {
    throw new Error("path must be a notes/*.md file");
  }
  return rel;
}

// GET /workbench/note-history?path=notes/…/x.md
// → committed git revisions (with content for diffs) + the current WORKING
//   content (head) so the UI can show the live "uncommitted changes" diff.
export const noteHistory = new Hono();
noteHistory.get("/", async (c) => {
  let rel: string;
  try {
    rel = notePath(c);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
  if (!(await vaultExists(rel))) return c.json({ error: "note not found" }, 404);
  const revisions = await vaultFileHistory(rel, 20);
  const working = await vaultRead(rel).catch(() => "");
  return c.json({ revisions, working });
});

// POST /workbench/note-commit?path=notes/…/x.md → commit THIS note's working file
//   (authored — "commit now"). No path → commit ALL pending notes (the
//   wiki-service calls this at compile start; operator-attributed fallback).
export const noteCommit = new Hono();
noteCommit.post("/", async (c) => {
  const p = c.req.query("path");
  if (p) {
    let rel: string;
    try {
      rel = notePath(c);
    } catch (e) {
      return c.json({ error: String((e as Error).message) }, 400);
    }
    const res = await vaultCommitPath(rel, `notes: commit ${rel}`, authorOf(c));
    return c.json(res);
  }
  const res = await vaultCommitPath("notes/", "notes: commit pending edits (compile)");
  return c.json(res);
});
