// /workbench/notes sub-router (P3). Read/write notes in the author-owned vault
// layer + a notes index + the AI-note hand-off. Path is validated under notes/
// by the ONE shared no-`../`-escape validator (in the repository).
import { Hono } from "hono";
import * as repo from "../repositories/notes.ts";

export const notes = new Hono();

// GET /workbench/notes — index of all notes (paths relative to notes/).
notes.get("/", async (c) => {
  return c.json({ notes: await repo.notesIndex() });
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
  try {
    const res = await repo.writeNote(notePath, content, ifMatch);
    if ("conflict" in res) {
      return c.json({ error: "conflict", current_hash: res.current }, 409);
    }
    return c.json(res);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
});
