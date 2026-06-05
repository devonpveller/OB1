// /workbench/notebooks sub-router (P2.5). Hono resource router over the
// notebooks repository (G9). Prefix-inclusive routes (mounted at
// /workbench/notebooks) to match the prefix-preserving Caddy `handle`.
import { Hono } from "hono";
import * as repo from "../repositories/notebooks.ts";

export const notebooks = new Hono();

// GET /workbench/notebooks — list active notebooks (for the index + pickers).
notebooks.get("/", async (c) => {
  return c.json({ notebooks: await repo.listNotebooks() });
});

// POST /workbench/notebooks — create (slug pinned at create, de-collided).
notebooks.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = (body?.name ?? "").toString().trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  const nb = await repo.createNotebook(name, body?.description ?? null);
  return c.json({ notebook: nb }, 201);
});

// GET /workbench/notebooks/:id — single notebook + live membership/suggestions
// (what NotebookPage.inline.ts hydrates).
notebooks.get("/:id", async (c) => {
  const id = c.req.param("id");
  const nb = await repo.getNotebook(id);
  if (!nb) return c.json({ error: "not found" }, 404);
  const [sources, suggestions] = await Promise.all([
    repo.listNotebookSources(id),
    repo.listSuggestions(id),
  ]);
  return c.json({ notebook: nb, sources, suggestions });
});

// PATCH /workbench/notebooks/:id — rename / re-describe (slug immutable, G6).
notebooks.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const nb = await repo.updateNotebook(id, body?.name ?? null, body?.description ?? null);
  if (!nb) return c.json({ error: "not found" }, 404);
  return c.json({ notebook: nb });
});

// POST /workbench/notebooks/:id/sources { source_id } — add membership.
notebooks.post("/:id/sources", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const sourceId = (body?.source_id ?? "").toString();
  if (!sourceId) return c.json({ error: "source_id is required" }, 400);
  const row = await repo.linkSource(id, sourceId, body?.link_type ?? "deliberate", body?.reason ?? null);
  return c.json({ link: row }, 201);
});

// DELETE /workbench/notebooks/:id/sources/:sourceId — unlink (soft → hidden).
// NOT a deletion; the source stays in its other notebooks + in generation.
notebooks.delete("/:id/sources/:sourceId", async (c) => {
  const row = await repo.setStatus(c.req.param("id"), c.req.param("sourceId"), "hidden");
  return c.json({ link: row });
});

// POST /workbench/notebooks/:id/suggestions/:sourceId { action } — triage.
// action=accept → confirmed; action=hide → hidden (sticky: suppresses
// re-suggestion via the worker's ON CONFLICT DO NOTHING, 2.5).
notebooks.post("/:id/suggestions/:sourceId", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const action = (body?.action ?? "").toString();
  const status = action === "accept" ? "confirmed" : action === "hide" ? "hidden" : null;
  if (!status) return c.json({ error: "action must be accept|hide" }, 400);
  const row = await repo.setStatus(c.req.param("id"), c.req.param("sourceId"), status);
  return c.json({ link: row });
});
