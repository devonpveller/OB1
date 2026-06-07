// /workbench/notes sub-router (P3). Read/write notes in the author-owned vault
// layer + a notes index + the AI-note hand-off. Path is validated under notes/
// by the ONE shared no-`../`-escape validator (in the repository).
import { Hono } from "hono";
import type { Context } from "hono";
import * as repo from "../repositories/notes.ts";

export const notes = new Hono();

// Change author = the Authelia-forwarded user (preview has no auth → "operator").
function authorOf(c: Context): string {
  return (
    c.req.header("Remote-User") ||
    c.req.header("X-Forwarded-User") ||
    c.req.header("X-Remote-User") ||
    "operator"
  ).toString();
}

// GET /workbench/notes — index split by ownership: { user: [...], ai: [...] }.
notes.get("/", async (c) => {
  return c.json(await repo.notesIndex());
});

// POST /workbench/notes — structured / AI-note hand-off (3.3/3.4).
// { notebook, title, content, source?, agent?, chat? }
notes.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body?.notebook || !body?.title || body?.content == null) {
    return c.json({ error: "notebook, title, content are required" }, 400);
  }
  const res = await repo.writeStructuredNote(body);
  return c.json(res, 201);
});

// ── Folder management (MUST be registered before the /:notePath wildcards below
// — Hono matches in registration order, else "folders"/"move" get captured as a
// note path). ──

// GET /workbench/notes/folders — the user notes/ folder tree (for the move
// picker). { folders: ["", "ideas", "notebooks/<slug>", ...] }.
notes.get("/folders", async (c) => {
  return c.json(await repo.notesFolders());
});

// GET /workbench/notes/trashed — paths of all currently-trashed notes, so the
// viewer can 🗑-mark them live in every listing/Explorer entry. MUST precede the
// /:notePath wildcard (registration order).
notes.get("/trashed", async (c) => {
  return c.json(await repo.listTrashed());
});

// GET /workbench/notes/folder-history?path=<rel> — recent git history of a folder
// (added/edited/trashed/removed notes) for the history panel + recover. Literal
// path, MUST precede the /:notePath wildcard.
notes.get("/folder-history", async (c) => {
  return c.json(await repo.folderHistory(c.req.query("path") ?? ""));
});

// POST /workbench/notes/folders — create a folder under notes/. { path }.
notes.post("/folders", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const path = (body?.path ?? "").toString();
  if (!path.trim()) return c.json({ error: "path is required" }, 400);
  try {
    const res = await repo.createFolder(path, authorOf(c));
    return c.json(res, res.created ? 201 : 200);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
});

// POST /workbench/notes/move — move a note to another folder (git mv; history
// preserved; frontmatter unchanged). { from, to_folder, if_match? }.
notes.post("/move", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const from = (body?.from ?? "").toString();
  const toFolder = (body?.to_folder ?? "").toString();
  const ifMatch = body?.if_match ?? c.req.header("If-Match") ?? null;
  if (!from.trim()) return c.json({ error: "from is required" }, 400);
  try {
    const res = await repo.moveNote(from, toFolder, ifMatch, authorOf(c));
    if ("conflict" in res) return c.json({ error: "conflict", current_hash: res.current }, 409);
    if ("error" in res) return c.json({ error: res.error }, res.code);
    return c.json(res);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
});

// DELETE /workbench/notes/folders — TRASH a folder + its contents (soft; the
// nightly cleanup hard-removes). { path }. Root + `notebooks` protected. MUST
// precede the /:notePath wildcard (registration order).
notes.delete("/folders", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const path = (body?.path ?? "").toString();
  if (!path.trim()) return c.json({ error: "path is required" }, 400);
  try {
    const res = await repo.trashFolder(path, authorOf(c));
    if ("error" in res) return c.json({ error: res.error }, res.code);
    return c.json(res);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
});

// POST /workbench/notes/empty-trash — hard-remove every trashed note (run by the
// nightly cleanup, just before the daily wiki rebuild).
notes.post("/empty-trash", async (c) => {
  try {
    return c.json(await repo.emptyTrash(authorOf(c)));
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
});

// POST /workbench/notes/folders/restore — un-trash a folder + its contents.
// Before /:notePath/restore so it isn't captured as a note path.
notes.post("/folders/restore", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const path = (body?.path ?? "").toString();
  if (!path.trim()) return c.json({ error: "path is required" }, 400);
  try {
    const res = await repo.restoreFolder(path, authorOf(c));
    if ("error" in res) return c.json({ error: res.error }, res.code);
    return c.json(res);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
});

// DELETE /workbench/notes/<path> — TRASH a single note (soft; recoverable). The
// trash card + nightly cleanup live on top of this.
notes.delete("/:notePath{.+}", async (c) => {
  try {
    const res = await repo.trashNote(c.req.param("notePath"), authorOf(c));
    if ("error" in res) return c.json({ error: res.error }, res.code);
    return c.json(res);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
});

// POST /workbench/notes/<path>/restore — un-trash a note (clears the flag).
notes.post("/:notePath{.+}/restore", async (c) => {
  try {
    const res = await repo.restoreNote(c.req.param("notePath"), authorOf(c));
    if ("error" in res) return c.json({ error: res.error }, res.code);
    return c.json(res);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
});

// POST /workbench/notes/<path>/recover { from } — restore a note's content from a
// past commit (recovers even after the nightly cleanup hard-removed it).
notes.post("/:notePath{.+}/recover", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const from = (body?.from ?? "").toString();
  if (!from.trim()) return c.json({ error: "from (commit) is required" }, 400);
  try {
    const res = await repo.recoverNote(c.req.param("notePath"), from, authorOf(c));
    if ("error" in res) return c.json({ error: res.error }, res.code);
    return c.json(res);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
});

// GET /workbench/notes/<path> — read a note + its content hash (for If-Match).
notes.get("/:notePath{.+}", async (c) => {
  try {
    const res = await repo.readNote(c.req.param("notePath"));
    if (!res) return c.json({ error: "not found" }, 404);
    return c.json(res);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
});

// PUT /workbench/notes/<path> — write a note. Body: raw markdown, or JSON
// { content, if_match }. Optimistic concurrency via the If-Match header or
// if_match field (content-hash). 409 on a two-session edit conflict.
notes.put("/:notePath{.+}", async (c) => {
  const notePath = c.req.param("notePath");
  const ct = c.req.header("content-type") || "";
  let content = "";
  let ifMatch: string | null = c.req.header("If-Match") ?? null;
  if (ct.includes("application/json")) {
    const body = await c.req.json().catch(() => ({}));
    content = (body?.content ?? "").toString();
    if (body?.if_match != null) ifMatch = body.if_match;
  } else {
    content = await c.req.text();
  }
  // ?commit=1 → record a git revision (Done / commit-now), authored. Otherwise
  // it's a working-draft write (autosave) — committed later at the next compile.
  const commit = c.req.query("commit") === "1";
  try {
    const res = await repo.writeNote(notePath, content, ifMatch, { commit, author: authorOf(c) });
    if ("conflict" in res) {
      return c.json({ error: "conflict", current_hash: res.current }, 409);
    }
    return c.json(res);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
});
