// /workbench/documents - the lifecycle's last steps (rwr-docs-lifecycle-api): unarchive, delete forever,
// empty trash now, and the caller's own removal trail. Mounted beside documentsRouter at the same prefix
// (src/app.ts, registered first); the logic is src/documents/lifecycle.ts.
//
// Delete forever and empty trash cannot be undone: each needs `confirm: true` in the body and is refused
// (400, nothing touched) without it, before the document is even looked up. WHO the user is comes from
// the identity seam alone.
import { Hono } from "hono";
import type { Context } from "hono";
import { type Identity, identityOf } from "../middleware/identity.ts";
import { DocError, type DocDeps } from "../documents/repo.ts";
import { deleteForever, emptyOwnTrash, unarchiveDocument } from "../documents/lifecycle.ts";
import { readTrail } from "../documents/trail.ts";
import { confirmed } from "../documents/trash_age.ts";
import { reopenRefinery } from "../documents/refinery.ts";
import type { RefineryDeps } from "../documents/refinery.ts";
import { isValidatorMessage } from "../util/public-error.ts";

async function body(c: Context): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : {};
}
const str = (v: unknown) => (v == null ? "" : String(v));

function fail(c: Context, e: unknown) {
  if (e instanceof DocError) return c.json({ error: e.message, ...e.detail }, e.status);
  const msg = String((e as Error)?.message ?? e);
  if (isValidatorMessage(e)) return c.json({ error: msg }, 400);
  console.error("[documents] error:", msg);
  return c.json({ error: "internal" }, 500);
}

const wrap = (fn: (c: Context, who: Identity) => Promise<Response>) => async (c: Context) => {
  try {
    return await fn(c, await identityOf(c));
  } catch (e) {
    return fail(c, e);
  }
};

export function documentsLifecycleRouter(rdeps: RefineryDeps) {
  const deps: DocDeps = { db: rdeps.db, reg: rdeps.reg };
  const r = new Hono();

  // archive's way back: the document returns to its folder; a refinery archived with it is reopened
  r.post("/unarchive", wrap(async (c, who) => {
    const path = str((await body(c)).path);
    const out = await unarchiveDocument(deps, path, who);
    const refinery = await reopenRefinery(rdeps, out.unarchived, who).catch((e) => {
      if (e instanceof DocError && e.status === 404) return { refinery_id: null, archived: false }; // no refinery: nothing to reopen
      throw e;
    });
    return c.json({ ...out, refinery });
  }));

  r.post("/delete-forever", wrap(async (c, who) => {
    const b = await body(c);
    if (!confirmed(b)) return c.json({ error: "delete forever cannot be undone: send confirm: true" }, 400);
    return c.json(await deleteForever(deps, str(b.path), who));
  }));

  r.post("/empty-trash", wrap(async (c, who) => {
    if (!confirmed(await body(c))) return c.json({ error: "empty trash cannot be undone: send confirm: true" }, 400);
    return c.json(await emptyOwnTrash(deps, who));
  }));

  // the caller's own removal lines: kind, path, who, when - never a title or text
  r.get("/trail", wrap(async (c, who) => c.json(await readTrail(deps.db, who, Number(c.req.query("limit") ?? 100)))));
  return r;
}
