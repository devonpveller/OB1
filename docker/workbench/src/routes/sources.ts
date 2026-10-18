// /workbench/sources sub-router (P4). Update-with-history, staged retract /
// restore, per-notebook unlink, and operator-confirmed purge. Retract +
// (P6) grounding write a Changes-log entry (G11). The purge is the contract's D5 suppress
// (rw-p0b-purge-door): reason type required, trail event, claims re-scored, restorable.
import { Hono } from "hono";
import type { Context, Next } from "hono";
import * as repo from "../repositories/sources.ts";
import { config } from "../config.ts";
import { logChange } from "../util/changeslog.ts";
import { pool } from "../db/pool.ts";
import { poolDb } from "../contracts/db.ts";
import { RegistryReader } from "../contracts/registry.ts";
import * as lifecycle from "../contracts/repo/lifecycle.ts";

// The contract's lifecycle over this router's pool (the same pool src/contracts/wiring.ts uses).
const contractDb = poolDb(pool);
const registry = new RegistryReader(contractDb);

export const sources = new Hono();

// Change author = the Authelia-forwarded user (P4.7). Caddy/Authelia inject one
// of these on the authenticated request; the preview has no auth → "operator".
// The id can later be mapped to a display name.
function authorOf(c: Context): string {
  return (
    c.req.header("Remote-User") ||
    c.req.header("X-Forwarded-User") ||
    c.req.header("X-Remote-User") ||
    c.req.header("X-Forwarded-Preferred-Username") ||
    "operator"
  ).toString();
}

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

// GET /workbench/sources/:id/notebooks — notebooks this source belongs to
// (SourceLinker: membership from the source side).
sources.get("/:id/notebooks", async (c) => {
  return c.json({ notebooks: await repo.listSourceNotebooks(c.req.param("id")) });
});

// DELETE /workbench/sources/:id/notebooks/:threadId — unlink from one notebook
// (soft → hidden; the source stays elsewhere + in generation).
sources.delete("/:id/notebooks/:threadId", async (c) => {
  const row = await repo.unlinkFromNotebook(c.req.param("threadId"), c.req.param("id"));
  return c.json({ link: row });
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

// POST /workbench/sources/:id/commit — deliberate "commit now" (head → revision).
sources.post("/:id/commit", async (c) => {
  return c.json(await repo.commitOne(c.req.param("id"), authorOf(c)));
});

// POST /workbench/sources/:id/revert/:rev — commit current, restore revision :rev.
sources.post("/:id/revert/:rev", async (c) => {
  const res = await repo.revertToRevision(c.req.param("id"), Number(c.req.param("rev")), authorOf(c));
  if (!res) return c.json({ error: "revision not found" }, 404);
  return c.json(res);
});

// POST /workbench/sources/:id/discard — drop uncommitted edits (reset to latest).
sources.post("/:id/discard", async (c) => {
  const res = await repo.discardToLatest(c.req.param("id"), authorOf(c));
  if (!res) return c.json({ error: "nothing to discard (no committed revision)" }, 400);
  return c.json(res);
});

// PATCH /workbench/sources/:id { content?, title? } — UPDATE (records a
// revision). No "replace" affordance exists; "a better source" = add a new one.
sources.patch("/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const res = await repo.updateSource(
    c.req.param("id"),
    body?.content ?? null,
    body?.title ?? null,
    authorOf(c),
  );
  if (!res) return c.json({ error: "not found" }, 404);
  return c.json(res);
});

// POST /workbench/sources/:id/replace-from-upload (multipart file) — re-upload a
// new version (P4.7 "upload-to-merge"): extract the document's text and set it as
// the working head (diffed vs the prior in the revision history). Preserves the
// source's legitimacy — the text comes from a real file, not free hand-editing.
// NOTE: needs the raised Caddy body cap (added to the @import matcher in prod).
sources.post("/:id/replace-from-upload", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) return c.json({ error: "a file is required" }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const fd = new FormData();
    fd.append("file", new Blob([bytes]), file.name);
    const er = await fetch(`${config.extractUrl}/extract`, { method: "POST", body: fd });
    if (!er.ok) {
      return c.json({ error: `extract failed (${er.status}): ${(await er.text()).slice(0, 200)}` }, 422);
    }
    const ex = await er.json();
    const res = await repo.updateSource(c.req.param("id"), ex.markdown ?? "", null, authorOf(c));
    if (!res) return c.json({ error: "not found" }, 404);
    return c.json({ source: res.source, extracted_title: ex.title ?? null, from: file.name });
  } catch (e) {
    return c.json({ error: String((e as Error).message) }, 500);
  }
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
  let src;
  try {
    src = await repo.retractStaged(id, body?.by ?? "operator");
  } catch (e) {
    // D5 (rw-p0-contract attempt 2): never un-commit a suppression
    if (e instanceof repo.LifecycleConflict) return c.json({ error: e.message, lifecycle: e.lifecycle }, 409);
    throw e;
  }
  if (!src) return c.json({ error: "not found" }, 404);
  const g = await repo.gravity(id);
  await logChange({
    action: "retract (staged)",
    detail: `source ${id} "${src.title || src.url || id}"`,
    affected: `${g.notebooks} notebook(s), ${g.pages} page(s)`,
  });
  return c.json({ scope: "global", staged: true, source: src, gravity: g });
});

// POST /workbench/sources/:id/restore — clear a (staged or committed) retract. Restoring a
// suppressed / unlinked source is a recorded D5 transition (a 'restored' trail event; the
// response carries `transition`); restoring an active one is unchanged (`transition: null`).
sources.post("/:id/restore", async (c) => {
  const res = await repo.restore(c.req.param("id"), authorOf(c));
  if (!res) return c.json({ error: "not found" }, 404);
  await logChange({
    action: "restore",
    detail: `source ${res.source.id}` + (res.transition ? ` (${res.transition.from} -> ${res.transition.to})` : ""),
  });
  return c.json({ source: res.source, transition: res.transition });
});

// DELETE /workbench/sources/:id { confirm: true, reason_type, note? } — purge = the D5 SUPPRESS
// (rw-p0b-purge-door, tester finding T2-1). The reason type is a key of the erasure_reasons
// registry (the reason the source is on its way out; erase later names its own). The contract's
// lifecycle.suppress does the move: active -> suppressed, one 'suppressed' trail event (from, to,
// actor, reason, this door), the claims the source grounds re-scored. It stays reversible
// through POST /:id/restore until a gated erase (POST /workbench/contract/sources/:id/erase,
// refused unless unlinked). A source that is not active is refused (409), nothing written.
const ERASURE_REASONS = "erasure_reasons";
sources.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  if (body?.confirm !== true) {
    return c.json({ error: "purge requires { confirm: true }" }, 400);
  }
  const reasonType = typeof body?.reason_type === "string" ? body.reason_type.trim() : "";
  if (!reasonType) {
    return c.json({
      error: `purge requires a reason_type: a key of the ${ERASURE_REASONS} registry (GET /workbench/contract/registries/${ERASURE_REASONS})`,
      missing: "reason_type",
    }, 400);
  }
  if (!(await registry.has(ERASURE_REASONS, reasonType))) {
    return c.json({
      error: `purge requires a reason_type registered in ${ERASURE_REASONS}; '${reasonType}' is not`,
      missing: "reason_type",
    }, 400);
  }
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim() : null;
  const by = (typeof body?.by === "string" && body.by) || authorOf(c);
  let res;
  try {
    res = await lifecycle.suppress(contractDb, id, reasonType, by, {
      door: "DELETE /workbench/sources/:id", reason_type: reasonType, note,
    });
  } catch (e) {
    if (e instanceof lifecycle.NotFound) return c.json({ error: "not found" }, 404);
    if (e instanceof lifecycle.Conflict) {
      return c.json({ error: `purge refused: ${e.message} (D5)`, lifecycle: e.detail.lifecycle ?? null }, 409);
    }
    throw e;
  }
  await logChange({
    action: `purge (suppressed, reason ${reasonType}; reversible by restore until erased)`,
    detail: `source ${id}`,
  });
  return c.json({
    purged: true,
    lifecycle: res.lifecycle,
    transition: { from: "active", to: res.lifecycle },
    reason_type: reasonType,
    rescored_claims: res.rescored_claims,
    blocking: res.blocking,
  });
});

// Separate router (no :id UUID guard) — the wiki-service POSTs this at compile
// start to commit every dirty working head as ONE revision (P4.7). Mounted at
// /workbench/source-commit in main.ts.
export const sourceCommit = new Hono();
sourceCommit.post("/", async (c) => {
  const res = await repo.commitPending();
  if (res.committed > 0) {
    await logChange({ action: "source revisions committed", detail: `${res.committed} source(s) at compile` });
  }
  return c.json(res);
});
