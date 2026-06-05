// /workbench/sources sub-router (P4). Update-with-history, staged retract /
// restore, per-notebook unlink, and operator-confirmed purge. Retract +
// (P6) grounding write a Changes-log entry (G11).
import { Hono } from "hono";
import type { Context, Next } from "hono";
import * as repo from "../repositories/sources.ts";
import { logChange } from "../util/changeslog.ts";

export const sources = new Hono();

// Reject a non-UUID :id with a clean 400 up front, instead of letting Postgres
// 500 on "invalid input syntax for type uuid" (e.g. an entity id typed into a
// source field). Guards every /:id and /:id/* route.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function requireUuid(c: Context, next: Next) {
  if (!UUID_RE.test(c.req.param("id") ?? "")) {
    return c.json({ error: "not a valid source id (expected a UUID)" }, 400);
  }
  await next();
}
sources.use("/:id", requireUuid);
sources.use("/:id/*", requireUuid);

// GET /workbench/sources?q=… — search existing sources (the modal's "link
// existing" mode). No :id, so the UUID guard doesn't apply.
sources.get("/", async (c) => {
  return c.json({ sources: await repo.searchSources(c.req.query("q") || "") });
});

// POST /workbench/sources/:id/link-entity { entity_id } — ground an entity with
// an EXISTING source (#3). POST …/link-notebook { thread_id } — add to a notebook.
sources.post("/:id/link-entity", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const eid = Number(body?.entity_id);
  if (!Number.isInteger(eid)) return c.json({ error: "entity_id (integer) required" }, 400);
  const link = await repo.linkEntity(c.req.param("id"), eid);
  await logChange({ action: "grounding (linked existing source)", detail: `source ${c.req.param("id")}`, affected: `entity #${eid}` });
  return c.json({ link });
});
sources.post("/:id/link-notebook", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const threadId = (body?.thread_id ?? "").toString();
  if (!threadId) return c.json({ error: "thread_id required" }, 400);
  return c.json({ link: await repo.linkNotebook(threadId, c.req.param("id")) });
});

// GET /workbench/sources/:id — read view (+ live staged-retract marker fields).
sources.get("/:id", async (c) => {
  const src = await repo.getSource(c.req.param("id"));
  if (!src) return c.json({ error: "not found" }, 404);
  return c.json({ source: src, gravity: await repo.gravity(src.id) });
});

// GET /workbench/sources/:id/revisions — version history.
sources.get("/:id/revisions", async (c) => {
  return c.json({ revisions: await repo.listRevisions(c.req.param("id")) });
});

// PATCH /workbench/sources/:id { content?, title? } — UPDATE (records a
// revision). No "replace" affordance exists; "a better source" = add a new one.
sources.patch("/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const res = await repo.updateSource(
    c.req.param("id"),
    body?.content ?? null,
    body?.title ?? null,
    body?.edited_by ?? "operator",
  );
  if (!res) return c.json({ error: "not found" }, 404);
  return c.json(res);
});

// POST /workbench/sources/:id/refetch — URL re-fetch → new revision.
sources.post("/:id/refetch", async (c) => {
  try {
    const res = await repo.refetch(c.req.param("id"));
    if (!res) return c.json({ error: "not found" }, 404);
    return c.json(res);
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 400);
  }
});

// POST /workbench/sources/:id/retract { scope: 'notebook'|'global', thread_id? }
// notebook → soft unlink; global (default) → STAGED retract (reversible).
sources.post("/:id/retract", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const scope = body?.scope ?? "global";
  if (scope === "notebook") {
    const threadId = (body?.thread_id ?? "").toString();
    if (!threadId) return c.json({ error: "thread_id required for notebook scope" }, 400);
    const row = await repo.unlinkFromNotebook(threadId, id);
    return c.json({ scope, link: row });
  }
  const src = await repo.retractStaged(id, body?.by ?? "operator");
  if (!src) return c.json({ error: "not found" }, 404);
  const g = await repo.gravity(id);
  await logChange({
    action: "retract (staged)",
    detail: `source ${id} "${src.title || src.url || id}"`,
    affected: `${g.notebooks} notebook(s), ${g.pages} page(s)`,
  });
  return c.json({ scope: "global", staged: true, source: src, gravity: g });
});

// POST /workbench/sources/:id/restore — clear a (staged or committed) retract.
sources.post("/:id/restore", async (c) => {
  const src = await repo.restore(c.req.param("id"));
  if (!src) return c.json({ error: "not found" }, 404);
  await logChange({ action: "restore", detail: `source ${src.id}` });
  return c.json({ source: src });
});

// DELETE /workbench/sources/:id { confirm: true } — irreversible purge.
sources.delete("/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body?.confirm !== true) {
    return c.json({ error: "purge requires { confirm: true } (irreversible)" }, 400);
  }
  const ok = await repo.purge(c.req.param("id"));
  if (!ok) return c.json({ error: "not found" }, 404);
  await logChange({ action: "purge (irreversible)", detail: `source ${c.req.param("id")}` });
  return c.json({ purged: true });
});
