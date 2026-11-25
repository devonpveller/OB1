// /workbench/documents - numbered versions, named snapshots, restore and compare (rwr-doc-versions-api).
// Mounted beside documentsRouter at the same prefix (src/app.ts, registered before it); the logic is
// src/documents/versions.ts. WHO the user is comes from the identity seam alone; every route acts for that
// identity on that user's documents. These are workbench routes, not contract routes (a user document is never
// a contract page): no operation is added to the retrieval contract's OpenAPI document.
//
//   GET  /versions?path=&limit=&before=      the versions, newest first, with their snapshots
//   GET  /snapshots?path=                    the document's snapshots, newest first
//   POST /snapshot        {path, name, version?}            a named marker on a version (default: the newest)
//   POST /restore-version {path, version | snapshot_id}    "Before restoring vN", then the old text as a new version
//   GET  /compare?path=&from=&to=            git's diff of two versions
// Literal paths only (the existing /restore is the trash's way back, not this).
import { Hono } from "hono";
import type { Context } from "hono";
import { type Identity, identityOf } from "../middleware/identity.ts";
import { DocError, type DocDeps } from "../documents/repo.ts";
import type { RefineryDeps } from "../documents/refinery.ts";
import { compareVersions, createSnapshot, LIMIT_MAX, listSnapshots, listVersions, restoreVersion, versionNumber } from "../documents/versions.ts";
import { jsonOnly } from "./documents_lifecycle.ts";
import { isValidatorMessage } from "../util/public-error.ts";

async function body(c: Context): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : {};
}
const str = (v: unknown) => (v == null ? "" : String(v));

// Never echoes the caller's input (a path, a name, an id): a refusal says what is wrong with the request's shape
// or that the thing is not there, in the same words for another user's row and for a missing one.
function fail(c: Context, e: unknown) {
  if (e instanceof DocError) return c.json({ error: e.message, ...e.detail }, e.status);
  const msg = String((e as Error)?.message ?? e);
  if (isValidatorMessage(e)) return c.json({ error: msg }, 400);
  console.error("[documents] versions error:", msg.slice(0, 200));
  return c.json({ error: "internal" }, 500);
}

const wrap = (fn: (c: Context, who: Identity) => Promise<Response>) => async (c: Context) => {
  try {
    return await fn(c, await identityOf(c));
  } catch (e) {
    return fail(c, e);
  }
};

export function documentsVersionsRouter(rdeps: RefineryDeps) {
  const deps: DocDeps = { db: rdeps.db, reg: rdeps.reg };
  const r = new Hono();

  r.get("/versions", wrap(async (c, who) => {
    const limitQ = c.req.query("limit");
    const beforeQ = c.req.query("before");
    const limit = limitQ == null ? undefined : versionNumber(limitQ, "limit");
    if (limit != null && limit > LIMIT_MAX) throw new DocError(`limit is at most ${LIMIT_MAX}`, 400);
    const before = beforeQ == null ? null : versionNumber(beforeQ, "before");
    return c.json(await listVersions(deps, str(c.req.query("path")), who, { limit, before }));
  }));

  r.get("/snapshots", wrap(async (c, who) => c.json(await listSnapshots(deps, str(c.req.query("path")), who))));

  r.post("/snapshot", jsonOnly, wrap(async (c, who) => {
    const b = await body(c);
    return c.json(await createSnapshot(deps, { path: str(b.path), name: b.name, version: b.version }, who), 201);
  }));

  r.post("/restore-version", jsonOnly, wrap(async (c, who) => {
    const b = await body(c);
    return c.json(await restoreVersion(deps, { path: str(b.path), version: b.version, snapshot_id: b.snapshot_id }, who));
  }));

  r.get("/compare", wrap(async (c, who) =>
    c.json(await compareVersions(deps, str(c.req.query("path")), c.req.query("from"), c.req.query("to"), who))));

  return r;
}
