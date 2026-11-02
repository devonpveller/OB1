// /workbench/import + /workbench/jobs sub-routers (P5.5/5.7, shared by P6
// grounding via target_entity_ids). The SINGLE upload route (only one with the
// raised Caddy body cap). Async: returns a job_id immediately and runs the
// extract→chunk→embed→link pipeline in the background, persisting state to
// import_jobs so a restart never orphans an in-flight import.
import { Hono } from "hono";
import { config } from "../config.ts";
import * as repo from "../repositories/import.ts";
import { logChange } from "../util/changeslog.ts";
import { logRefusal } from "../identity/refusal_log.ts";
import { gateClient, gateErrorBody, type GatePage, isGateError } from "../fetch-gate/client.ts";
import { type Identity, identityOf } from "../middleware/identity.ts";
import { importRows } from "../intake/repo.ts";
import type { Db } from "../contracts/db.ts";

export const imports = new Hono();
// the search gate's /v1/fetch, from the environment once (WORKBENCH_GATE_URL, WORKBENCH_GATE_KEY)
const fetchViaGate = gateClient();

export async function callExtract(bytes: Uint8Array, filename: string): Promise<{
  markdown: string;
  title: string;
  images?: { name: string; b64: string; mime?: string }[];
  metadata?: Record<string, unknown>;
}> {
  const fd = new FormData();
  fd.append("file", new Blob([bytes]), filename);
  const r = await fetch(`${config.extractUrl}/extract`, { method: "POST", body: fd });
  if (!r.ok) {
    // rw-identity-harden2 round 2: the extractor's body is logged, never carried in the error
    logRefusal("import: extractor upstream", `[import] extract ${r.status}: ${(await r.text()).slice(0, 200)}`);
    throw new Error(`extract ${r.status}`);
  }
  return await r.json();
}

function parseEntityIds(raw: unknown): number[] {
  if (raw == null || raw === "") return [];
  const s = String(raw);
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return j.map(Number).filter(Number.isInteger);
  } catch { /* not JSON — fall through to CSV */ }
  return s.split(",").map((x) => Number(x.trim())).filter(Number.isInteger);
}

// Background pipeline. Never throws to the caller — terminal state lands in
// import_jobs (status=done|failed), which the badge + ImportStatus read.
async function runPipeline(
  jobId: string,
  bytes: Uint8Array,
  filename: string,
  targetNotebook: string | null,
  targetEntityIds: number[],
) {
  try {
    // rw-p5a-intake: a job cancelled from the intake panel (while queued or extracting) stops here
    if (!(await repo.advanceJob(jobId, "extracting", ["queued"]))) return;
    const ex = await callExtract(bytes, filename);
    if (!(await repo.advanceJob(jobId, "embedding", ["extracting"]))) return;
    const { sourceId, wasDuplicate } = await repo.ingestSource({
      markdown: ex.markdown,
      title: ex.title || filename,
      contentType: (ex.metadata?.content_type as string) || "web_article",
      targetNotebook,
      targetEntityIds,
      metadata: { source_format: ex.metadata?.source_format },
    });
    await repo.updateJob(jobId, { status: "linking", source_id: sourceId, duplicate: wasDuplicate });
    // Image attach runs POST-commit (assets are filesystem, not in the DB tx).
    // The source + chunks + links are already durable, so an asset-write hiccup
    // (e.g. volume perms) must NOT fail the whole import — log and continue. The
    // text source stays fully usable; only inline images are missing.
    if (ex.images?.length) {
      try {
        await repo.attachImages(sourceId, ex.markdown, ex.images);
      } catch (imgErr) {
        console.error(`[workbench] image attach failed for ${sourceId} (non-fatal):`, (imgErr as Error).message);
      }
    }
    // committed stays false until the compile that regenerates the grounded
    // page completes (the wiki-service flips it); the badge reads that.
    await repo.updateJob(jobId, { status: "done" });
    await repo.dropPayload(jobId);
    if (targetEntityIds.length) {
      await logChange({
        action: "grounding (staged)",
        detail: `source ${sourceId} from ${filename}`,
        affected: `${targetEntityIds.length} entity page(s)`,
      });
    }
  } catch (e) {
    // Failure handling (P6.6): record durably; do NOT regenerate.
    // the job row is read back by GET /workbench/jobs/:id: a fixed text, the real one in the log (round 2, D1)
    console.error(`[import] job ${jobId} failed:`, String((e as Error)?.message ?? e).slice(0, 500));
    await repo.failJob(jobId, "the import failed (see the workbench log)");
  }
}

// URL-ingest pipeline (P6.2: ground with a document OR a URL). The page comes from the search gate
// (rw-workbench-fetch-posture): `page` is the gate's `ok` answer - intake's clean text, never the raw
// page - fetched BEFORE the job exists (the route below), so this stage only stores it. The media type
// and the provenance (origin URL, every redirect hop the gate judged, the final URL) go on the source.
async function runUrlPipeline(
  jobId: string,
  url: string,
  page: GatePage,
  targetNotebook: string | null,
  targetEntityIds: number[],
) {
  try {
    if (!(await repo.advanceJob(jobId, "embedding", ["queued"]))) return;
    const { sourceId, wasDuplicate } = await repo.ingestSource({
      markdown: page.text, title: url, contentType: "web_article", url, targetNotebook, targetEntityIds,
      metadata: { media_type: page.mediaType, fetch: page.provenance },
    });
    await repo.updateJob(jobId, { status: "done", source_id: sourceId, duplicate: wasDuplicate });
    if (targetEntityIds.length) {
      await logChange({ action: "grounding (staged)", detail: `URL ${url}`, affected: `${targetEntityIds.length} entity page(s)` });
    }
  } catch (e) {
    // the job row is read back by GET /workbench/jobs/:id: a fixed text, the real one in the log (round 2, D1)
    console.error(`[import] job ${jobId} failed:`, String((e as Error)?.message ?? e).slice(0, 500));
    await repo.failJob(jobId, "the import failed (see the workbench log)");
  }
}

// POST /workbench/import  (multipart: file OR url, [target_notebook], [target_entity_ids])
imports.post("/", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  const url = ((body["url"] as string) || "").trim();
  if (!(file instanceof File) && !url) return c.json({ error: "a file or a url is required" }, 400);
  const targetNotebook = (body["target_notebook"] as string) || null;
  const targetEntityIds = parseEntityIds(body["target_entity_ids"]);

  // A URL: ONE call to the search gate, before any job exists. Not configured / unreachable = 503;
  // refused / withheld / error = the gate's reason unchanged; nothing is stored either way.
  let page: GatePage | null = null;
  if (!(file instanceof File)) {
    try {
      page = await fetchViaGate(url);
    } catch (e) {
      if (isGateError(e)) return c.json(gateErrorBody(e), e.httpStatus as 422 | 502 | 503);
      throw e;
    }
  }
  // rw-p5a-intake: the job is the identity seam's subject's (its intake panel lists, retries and cancels it);
  // a file's bytes are kept until the import ends well, so a failed one can be retried from the panel
  const who = await identityOf(c);
  const job = await repo.createJob(targetEntityIds, targetNotebook, targetEntityIds.length > 0, {
    owner: who.sub, actor: who.actor, url: file instanceof File ? null : url, filename: file instanceof File ? file.name : null,
  });
  // Fire-and-forget; state is durable in import_jobs.
  if (file instanceof File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await repo.storePayload(job.id, file.name, bytes);
    runPipeline(job.id, bytes, file.name, targetNotebook, targetEntityIds);
  } else {
    runUrlPipeline(job.id, url, page!, targetNotebook, targetEntityIds);
  }
  return c.json({ job_id: job.id, status: job.status }, 202);
});

// rw-p5a-intake: an import's retry from the intake panel (the route set it back to queued): the same
// pipeline again - a file from its kept bytes, a URL through the search gate again (one /v1/fetch call,
// its refusal recorded as the import's failure; never a direct fetch)
export async function retryImport(jobId: string, _who: Identity): Promise<void> {
  const job = await repo.getJob(jobId);
  if (!job || job.status !== "queued") return;
  const targetEntityIds = (job.target_entity_ids ?? []).map(Number);
  const jobUrl = (job as unknown as { url?: string | null }).url;
  if (jobUrl) {
    let page: GatePage;
    try {
      page = await fetchViaGate(jobUrl);
    } catch (e) {
      const why = isGateError(e) ? String((gateErrorBody(e) as { error?: unknown }).error ?? "the search gate refused the link") : "the import failed (see the workbench log)";
      if (!isGateError(e)) console.error(`[import] retry ${jobId} failed:`, String((e as Error)?.message ?? e).slice(0, 500));
      await repo.failJob(jobId, why.slice(0, 300));
      return;
    }
    await runUrlPipeline(jobId, jobUrl, page, job.target_notebook ?? null, targetEntityIds);
    return;
  }
  const p = await repo.getPayload(jobId);
  if (!p) return void await repo.failJob(jobId, "the file is gone; import it again");
  await runPipeline(jobId, p.bytes, p.filename, job.target_notebook ?? null, targetEntityIds);
}

// GET /workbench/jobs/:id — progress (ImportStatus polls this). rw-p5a-intake: the subject's own job
// only (another user's is 404, as on the intake panel), through the intake panel's one owner rule.
export function jobsRouter(db: Db) {
  const jobs = new Hono();
  jobs.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return c.json({ error: "not found" }, 404);
    const who = await identityOf(c);
    const mine = (await importRows(db, who, "import", null, 1, id.toLowerCase()))[0] ?? (await importRows(db, who, "add", null, 1, id.toLowerCase()))[0];
    if (!mine) return c.json({ error: "not found" }, 404);
    const job = await repo.getJob(id);
    if (!job) return c.json({ error: "not found" }, 404);
    return c.json({ job });
  });

  // GET /workbench/jobs — recent history (the subject's own).
  jobs.get("/", async (c) => {
    const who = await identityOf(c);
    const ids = new Set([...(await importRows(db, who, "import", null, 50)), ...(await importRows(db, who, "add", null, 50))].map((j) => j.id));
    return c.json({ jobs: (await repo.recentJobs(200)).filter((j) => ids.has(String(j.id))).slice(0, 50) });
  });
  return jobs;
}
