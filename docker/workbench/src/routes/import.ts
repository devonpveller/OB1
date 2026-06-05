// /workbench/import + /workbench/jobs sub-routers (P5.5/5.7, shared by P6
// grounding via target_entity_ids). The SINGLE upload route (only one with the
// raised Caddy body cap). Async: returns a job_id immediately and runs the
// extract→chunk→embed→link pipeline in the background, persisting state to
// import_jobs so a restart never orphans an in-flight import.
import { Hono } from "hono";
import { config } from "../config.ts";
import * as repo from "../repositories/import.ts";
import { logChange } from "../util/changeslog.ts";

export const imports = new Hono();
export const jobs = new Hono();

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
    const { sourceId } = await repo.ingestSource({
      markdown: ex.markdown,
      title: ex.title || filename,
      contentType: (ex.metadata?.content_type as string) || "web_article",
      targetNotebook,
      targetEntityIds,
      metadata: { source_format: ex.metadata?.source_format },
    });
    await repo.updateJob(jobId, { status: "linking", source_id: sourceId });
    if (ex.images?.length) await repo.attachImages(sourceId, ex.markdown, ex.images);
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

// POST /workbench/import  (multipart: file, [target_notebook], [target_entity_ids])
imports.post("/", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) return c.json({ error: "file is required (multipart)" }, 400);
  const targetNotebook = (body["target_notebook"] as string) || null;
  const targetEntityIds = parseEntityIds(body["target_entity_ids"]);
  const bytes = new Uint8Array(await file.arrayBuffer());

  const job = await repo.createJob(targetEntityIds, targetNotebook, targetEntityIds.length > 0);
  // Fire-and-forget; state is durable in import_jobs.
  runPipeline(job.id, bytes, file.name, targetNotebook, targetEntityIds);
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
