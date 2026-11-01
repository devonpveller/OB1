// /workbench/intake - the intake and queue panel's server (research-workbench P5a, rw-p5a-intake).
//
//   GET  /workbench/intake/jobs?kinds=import,add,chunk,extract,entity&state=&limit=   the panel's list
//   GET  /workbench/intake/jobs/:kind/:id                                              one job (404: not
//                                                                                      the subject's)
//   POST /workbench/intake/jobs/:kind/:id/retry | /cancel                              its actions
//   POST /workbench/intake/add      a user add: multipart (file) or JSON {url, refinery_id | path, content_type?}
//   GET  /workbench/intake/content-types                                               the declared three
//
// WHO comes from the identity seam alone (identityOf: subject_sub; the OWUI inlet's on-behalf-of subject
// is the seam's too, accepted only from Open WebUI's service key on the add - middleware/identity.ts).
// A body never names a user. Every read and write is the subject's own (intake/repo.ts).
import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../contracts/db.ts";
import type { RefineryDeps } from "../documents/refinery.ts";
import { ownedPath } from "../documents/repo.ts";
import { DocError } from "../documents/repo.ts";
import { type Identity, identityOf } from "../middleware/identity.ts";
import { CONTENT_TYPE_LABELS, fileContentType, INTAKE_CONTENT_TYPES, isIntakeContentType } from "./content_types.ts";
import { type Extract, runAdd } from "./pipeline.ts";
import type { IntakeFetch } from "./research_fetch.ts";
import * as repo from "./repo.ts";

export interface IntakeDeps {
  db: Db;
  rdeps: RefineryDeps;
  fetch: IntakeFetch | null;
  extract: Extract;
  // an import's retry re-runs the import route's own pipeline (routes/import.ts)
  retryImport: (jobId: string, who: Identity) => Promise<void>;
  maxFileBytes?: number;
}

const str = (v: unknown) => (v == null ? "" : String(v));
const parseLimit = (v: string | undefined, d: number, max: number) => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : d;
};

// the origin is the identity's, never the body's: Open WebUI's service key acting for its user = owui
export function originOf(who: Identity): "owui" | "workspace" {
  return who.actor === "service:owui" && who.sub !== who.actor ? "owui" : "workspace";
}

async function refineriesOf(db: Db, sub: string) {
  return await db.query<{ id: string; title: string }>(
    `SELECT i.id::text AS id, i.title FROM public.ideas i LEFT JOIN public.refinery_state rs ON rs.refinery_id = i.id
      WHERE i.owner_sub = $1 AND i.status <> 'archived' AND rs.archived_at IS NULL ORDER BY i.updated_at DESC LIMIT 200`, [sub],
  );
}

export function intakeRouter(deps: IntakeDeps) {
  const r = new Hono();
  const db = deps.db;
  const maxFile = deps.maxFileBytes ?? 25 * 1024 * 1024;
  const kindOf = (c: Context) => str(c.req.param("kind"));

  r.get("/content-types", (c) => c.json({
    content_types: INTAKE_CONTENT_TYPES.map((k) => ({ key: k, label: CONTENT_TYPE_LABELS[k], link: true, file: k !== "youtube_transcript" })),
  }));

  r.get("/jobs", async (c) => {
    const who = await identityOf(c);
    const kinds = str(c.req.query("kinds")).split(",").map((k) => k.trim()).filter(Boolean);
    const bad = kinds.filter((k) => !repo.isIntakeKind(k));
    if (bad.length) return c.json({ error: `not a queue the panel shows: ${bad.join(", ")}`, kinds: repo.INTAKE_KINDS }, 400);
    return c.json(await repo.listJobs(db, who, kinds, c.req.query("state") || null, parseLimit(c.req.query("limit"), 50, 200)));
  });

  const found = async (c: Context) => {
    const kind = kindOf(c);
    if (!repo.isIntakeKind(kind)) return null;
    return await repo.getJob(db, await identityOf(c), kind, str(c.req.param("id")));
  };
  r.get("/jobs/:kind/:id", async (c) => {
    const job = await found(c);
    return job ? c.json({ job }) : c.json({ error: "no such job" }, 404);
  });
  r.post("/jobs/:kind/:id/cancel", async (c) => {
    const job = await found(c);
    if (!job) return c.json({ error: "no such job" }, 404);
    try {
      await repo.cancel(db, job);
    } catch (e) {
      if (e instanceof repo.ActionRefused) return c.json({ error: e.message }, 409);
      throw e;
    }
    return c.json({ job: await repo.getJob(db, await identityOf(c), job.kind, job.id) ?? { ...job, status: "cancelled" } });
  });
  r.post("/jobs/:kind/:id/retry", async (c) => {
    const job = await found(c);
    if (!job) return c.json({ error: "no such job" }, 404);
    const who = await identityOf(c);
    try {
      if (job.kind === "import" || job.kind === "add") {
        if (!repo.actionsOf(job.kind, job.status).actions.includes("retry")) return c.json({ error: `a ${job.status} ${job.kind} job cannot be retried` }, 409);
        const moved = await db.query(
          `UPDATE public.import_jobs SET status = 'queued', error = NULL, attempts = attempts + 1 WHERE id = $1 AND status IN ('failed', 'cancelled') RETURNING id`, [job.id]);
        if (!moved.length) return c.json({ error: "the job moved on before it could be retried" }, 409);
        if (job.kind === "add") runAdd({ db, rdeps: deps.rdeps, fetch: deps.fetch, extract: deps.extract }, job.id).catch(() => {});
        else deps.retryImport(job.id, who).catch(() => {});
      } else {
        await repo.retryQueue(db, job);
      }
    } catch (e) {
      if (e instanceof repo.ActionRefused) return c.json({ error: e.message }, 409);
      throw e;
    }
    return c.json({ job: await repo.getJob(db, who, job.kind, job.id) }, 202);
  });

  // ── the add (general: a named refinery; contextual: a document's refinery, or a refinery opened) ──
  r.post("/add", async (c) => {
    const who = await identityOf(c);
    const media = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    let url = "", refineryId = "", path = "", declared = "";
    let file: File | null = null;
    if (media === "multipart/form-data") {
      const form = await c.req.parseBody();
      url = str(form["url"]).trim(); refineryId = str(form["refinery_id"]).trim(); path = str(form["path"]).trim();
      declared = str(form["content_type"]).trim();
      file = form["file"] instanceof File ? form["file"] as File : null;
    } else {
      const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      url = str(b.url).trim(); refineryId = str(b.refinery_id).trim(); path = str(b.path).trim(); declared = str(b.content_type).trim();
    }
    if (!url && !file) return c.json({ error: "a link or a file is required" }, 400);
    if (url && file) return c.json({ error: "a link or a file, not both" }, 400);
    if (declared && !isIntakeContentType(declared)) {
      return c.json({ error: `not a declared content type: ${declared}`, content_types: INTAKE_CONTENT_TYPES }, 415);
    }
    if (url) {
      let u: URL | null = null;
      try { u = new URL(url); } catch { /* below */ }
      if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return c.json({ error: "the link must be an http or https address" }, 400);
    }
    // WHERE it lands: exactly one existing refinery. The general add asks which; the contextual add has it.
    if (refineryId && path) return c.json({ error: "a refinery or a document, not both" }, 400);
    if (!refineryId && !path) {
      return c.json({
        error: "choose the refinery it joins (a user add lands only in an existing idea refinery)", needs: "refinery_id",
        refineries: await refineriesOf(db, who.sub),
      }, 400);
    }
    let docPath: string | null = null;
    try {
      if (refineryId) {
        const mine = await refineriesOf(db, who.sub);
        if (!mine.some((x) => x.id === refineryId.toLowerCase())) return c.json({ error: "no such refinery (an add joins one of your existing refineries)" }, 404);
      } else {
        docPath = await ownedPath(db, path, who);
        const tethered = await db.query<{ id: string }>(
          `SELECT l.refinery_id::text AS id FROM public.user_document_listings l JOIN public.ideas i ON i.id = l.refinery_id
             LEFT JOIN public.refinery_state rs ON rs.refinery_id = i.id
            WHERE l.path = $1 AND l.owner_sub = $2 AND rs.archived_at IS NULL`, [docPath, who.sub]);
        if (!tethered.length) {
          return c.json({ error: "this document has no open refinery: open the document's refinery first (a user source lands only in an existing refinery)" }, 409);
        }
      }
    } catch (e) {
      if (e instanceof DocError) return c.json({ error: e.message }, e.status as 400 | 404 | 409);
      throw e;
    }
    let bytes: Uint8Array | null = null;
    if (file) {
      if (file.size > maxFile) return c.json({ error: `the file is larger than ${maxFile} bytes` }, 413);
      bytes = new Uint8Array(await file.arrayBuffer());
      const type = fileContentType(file.name, bytes);
      if (!type) return c.json({ error: "a file add is a PDF or a saved web page (a YouTube transcript is added by its link)", content_types: INTAKE_CONTENT_TYPES }, 415);
      if (declared && declared !== type) return c.json({ error: `this file is a ${CONTENT_TYPE_LABELS[type]}, not ${declared}` }, 415);
      declared = type;
    }
    if (url && !deps.fetch) {
      return c.json({ error: "the research service is not configured for the workspace (RESEARCH_URL, RESEARCH_WORKSPACE_KEY)" }, 503);
    }
    const job = await db.tx(async (t) => {
      const row = (await t.query<{ id: string; status: string }>(
        `INSERT INTO public.import_jobs (status, mode, origin, owner_sub, actor_sub, actor_name, url, filename, refinery_id, doc_path, content_type)
         VALUES ('queued', 'add', $1, $2, $3, $4, $5, $6, $7::uuid, $8, $9) RETURNING id::text AS id, status`,
        [originOf(who), who.sub, who.actor, who.name, url || null, file?.name ?? null, refineryId ? refineryId.toLowerCase() : null, docPath, declared || null],
      ))[0];
      if (file && bytes) await t.query(`INSERT INTO public.import_job_payloads (job_id, filename, bytes) VALUES ($1, $2, $3)`, [row.id, file.name, bytes]);
      return row;
    });
    runAdd({ db, rdeps: deps.rdeps, fetch: deps.fetch, extract: deps.extract }, job.id).catch((e) =>
      console.error(`[intake] add ${job.id}:`, (e as Error).message));
    return c.json({ job_id: job.id, kind: "add", status: job.status, origin: originOf(who) }, 202);
  });
  return r;
}
