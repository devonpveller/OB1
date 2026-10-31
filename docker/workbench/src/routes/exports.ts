// /workbench/exports - the caller's own export runs (research-workbench P6b, rw-p6b-gate): what the
// export panel lists, and the file of a passed export served again.
//
//   GET /workbench/exports[?path=<vault .md>][&limit=n]   the caller's runs, newest first (no file bytes)
//   GET /workbench/exports/:id                             one of the caller's runs
//   GET /workbench/exports/:id/file                        a passed run's file (a blocked run has none)
//
// Per user (07-MULTI-USER; anchor acceptance 6): the subject is the identity seam's (identityOf), never
// a caller-supplied user; every read filters on owner_sub in SQL (src/export/runs.ts). Another user's
// run by id - and a blocked run's file - is 404, the answer an unknown id gets. The owner scope
// (middleware/owner-scope.ts) still walks the JSON, and refuses a ?path= naming another user's document.
import { Hono } from "hono";
import type { Context } from "hono";
import type { RunStore } from "../export/runs.ts";
import { safeRelPath } from "../util/paths.ts";

export function exportsRouter(runs: RunStore, whoOf: (c: Context) => Promise<{ sub: string }>): Hono {
  const r = new Hono();
  r.get("/", async (c) => {
    const who = await whoOf(c);
    const raw = c.req.query("path");
    let path: string | undefined;
    if (raw) {
      try {
        path = safeRelPath(raw);
      } catch (e) {
        return c.json({ error: String((e as Error).message) }, 400);
      }
    }
    const limit = Number(c.req.query("limit") || 50);
    return c.json({ exports: await runs.list(who.sub, Number.isFinite(limit) ? limit : 50, path) });
  });
  r.get("/:id", async (c) => {
    const run = await runs.get((await whoOf(c)).sub, c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "no such export" }, 404);
  });
  r.get("/:id/file", async (c) => {
    const f = await runs.file((await whoOf(c)).sub, c.req.param("id"));
    if (!f) return c.json({ error: "no such export" }, 404);
    const name = f.filename.replace(/["\\\r\n]/g, "_");
    return new Response(f.file as unknown as BodyInit, {
      headers: {
        "content-type": f.mime || "application/octet-stream",
        "content-disposition": `attachment; filename="${name}"`,
        "content-length": String(f.file.byteLength),
        "x-export-id": c.req.param("id"),
      },
    });
  });
  return r;
}
