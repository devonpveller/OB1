// /workbench/note-refs (P3.5 follow-up) — a note's dynamic reference list.
// A note's sources have TWO origins, kept distinct here:
//   • cited  — source leaves referenced in the body ([[…source/<uuid>…]])
//   • added  — sources the author deliberately attached
// research-workbench P2a: both are REFERENCE RECORDS now (reference_records, held by the note
// through reference_holders), each pinned to its source's revision when it was placed. GET reads
// them (reconciling with the file first when it changed outside the workbench); POST/DELETE
// manage the added ones in the record - the note file is no longer written (the frontmatter
// `sources:` list was the added list's home before P2a and is read once, by the migration).
// On export the union is emitted as a numbered "## References" list — see routes/export.ts.
import { Hono } from "hono";
import { pool } from "../db/pool.ts";
import { poolDb } from "../contracts/db.ts";
import { ensureLegacyNote, MigrationRefused, noteRefsView, syncLegacyNote } from "../contracts/repo/references.ts";
import { UUID_STRICT } from "../contracts/logic/citations.ts";
import { safeRelPath } from "../util/paths.ts";
import { vaultExists, vaultRead } from "../util/vault.ts";

export const noteRefs = new Hono();
const db = poolDb(pool);

function notePath(c: { req: { query: (k: string) => string | undefined } }): string {
  const raw = c.req.query("path") || "";
  const rel = safeRelPath(raw);
  if (!rel.startsWith("notes/") || !rel.endsWith(".md")) throw new Error("path must be a notes/*.md file");
  return rel;
}

function refused(e: unknown) {
  return e instanceof MigrationRefused
    ? { status: 409 as const, body: { error: e.message, detail: e.detail } }
    : null;
}

// GET /workbench/note-refs?path=notes/...md
noteRefs.get("/", async (c) => {
  let rel: string;
  try {
    rel = notePath(c);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
  if (!(await vaultExists(rel))) return c.json({ error: "note not found" }, 404);
  try {
    await ensureLegacyNote(db, rel, await vaultRead(rel));
  } catch (e) {
    const r = refused(e);
    if (r) return c.json(r.body, r.status);
    throw e;
  }
  return c.json(await noteRefsView(db, rel));
});

// POST /workbench/note-refs?path=... { source_id } — deliberately add a source. The reference is
// pinned at the source's current revision; one already cited keeps its pin and becomes added.
noteRefs.post("/", async (c) => {
  let rel: string;
  try {
    rel = notePath(c);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const sourceId = (body?.source_id ?? "").toString();
  if (!UUID_STRICT.test(sourceId)) return c.json({ error: "source_id must be a uuid" }, 400);
  if (!(await vaultExists(rel))) return c.json({ error: "note not found" }, 404);
  const content = await vaultRead(rel);
  try {
    await ensureLegacyNote(db, rel, content);
    await syncLegacyNote(db, rel, content, { addAdded: sourceId });
  } catch (e) {
    const r = refused(e);
    if (r) return c.json(r.body, r.status);
    throw e;
  }
  return c.json(await noteRefsView(db, rel), 201);
});

// DELETE /workbench/note-refs?path=...&source_id=... — remove a deliberate add (a source the body
// still cites stays, as cited, with its pin).
noteRefs.delete("/", async (c) => {
  let rel: string;
  try {
    rel = notePath(c);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
  const sourceId = (c.req.query("source_id") || "").toString();
  if (!(await vaultExists(rel))) return c.json({ error: "note not found" }, 404);
  const content = await vaultRead(rel);
  try {
    await ensureLegacyNote(db, rel, content);
    await syncLegacyNote(db, rel, content, { removeAdded: sourceId });
  } catch (e) {
    const r = refused(e);
    if (r) return c.json(r.body, r.status);
    throw e;
  }
  return c.json(await noteRefsView(db, rel));
});
