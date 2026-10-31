// /workbench/import + /workbench/jobs sub-routers (P5.5/5.7, shared by P6
// grounding via target_entity_ids). The SINGLE upload route (only one with the
// raised Caddy body cap). Async: returns a job_id immediately and runs the
// extract→chunk→embed→link pipeline in the background, persisting state to
// import_jobs so a restart never orphans an in-flight import.
import { Hono } from "hono";
import { config } from "../config.ts";
import * as repo from "../repositories/import.ts";
import { logChange } from "../util/changeslog.ts";
import { gateClient, gateErrorBody, type GatePage, isGateError } from "../fetch-gate/client.ts";

export const imports = new Hono();
export const jobs = new Hono();
// the search gate's /v1/fetch, from the environment once (WORKBENCH_GATE_URL, WORKBENCH_GATE_KEY)
const fetchViaGate = gateClient();

async function callExtract(bytes: Uint8Array, filename: string): Promise<{
  markdown: string;
  title: string;
  images?: { name: string; b64: string; mime?: string }[];
  metadata?: Record<string, unknown>;
}> {
  const fd = new FormData();
  fd.append("file", new Blob([bytes]), filename);
  const r = await fetch(`${config.extractUrl}/extract`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`extract ${r.status}: ${(await r.text()).slice(0, 200)}`);
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
    await repo.updateJob(jobId, { status: "extracting" });
    const ex = await callExtract(bytes, filename);
    await repo.updateJob(jobId, { status: "embedding" });
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
    if (targetEntityIds.length) {
      await logChange({
        action: "grounding (staged)",
        detail: `source ${sourceId} from ${filename}`,
        affected: `${targetEntityIds.length} entity page(s)`,
      });
    }
  } catch (e) {
    // Failure handling (P6.6): record durably; do NOT regenerate.
    await repo.updateJob(jobId, { status: "failed", error: String((e as Error).message).slice(0, 500) });
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
    await repo.updateJob(jobId, { status: "embedding" });
    const { sourceId, wasDuplicate } = await repo.ingestSource({
      markdown: page.text, title: url, contentType: "web_article", url, targetNotebook, targetEntityIds,
      metadata: { media_type: page.mediaType, fetch: page.provenance },
    });
    await repo.updateJob(jobId, { status: "done", source_id: sourceId, duplicate: wasDuplicate });
    if (targetEntityIds.length) {
      await logChange({ action: "grounding (staged)", detail: `URL ${url}`, affected: `${targetEntityIds.length} entity page(s)` });
    }
  } catch (e) {
    await repo.updateJob(jobId, { status: "failed", error: String((e as Error).message).slice(0, 500) });
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
  const job = await repo.createJob(targetEntityIds, targetNotebook, targetEntityIds.length > 0);
  // Fire-and-forget; state is durable in import_jobs.
  if (file instanceof File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    runPipeline(job.id, bytes, file.name, targetNotebook, targetEntityIds);
  } else {
    runUrlPipeline(job.id, url, page!, targetNotebook, targetEntityIds);
  }
  return c.json({ job_id: job.id, status: job.status }, 202);
});

// GET /workbench/jobs/:id — progress (ImportStatus polls this).
jobs.get("/:id", async (c) => {
  const job = await repo.getJob(c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  return c.json({ job });
});

// GET /workbench/jobs — recent history.
jobs.get("/", async (c) => {
  return c.json({ jobs: await repo.recentJobs() });
});
