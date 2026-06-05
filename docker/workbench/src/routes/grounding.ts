// /workbench/grounding sub-router (P6.1). The live grounding-state badge reads
// this at the moment of reading the page (hydrated via the P0.6 frontmatter
// entity_id). Distinguishes by-design thought-only (cause 1) from extraction
// backlog (cause 2) via source_extraction_queue health, so a backlog page is
// never mislabeled "ungrounded".
import { Hono } from "hono";
import { query } from "../db/pool.ts";

export const grounding = new Hono();

// GET /workbench/grounding/:entityId
grounding.get("/:entityId", async (c) => {
  const entityId = Number(c.req.param("entityId"));
  if (!Number.isInteger(entityId)) return c.json({ error: "entityId must be an integer" }, 400);

  // Grounded sources = non-retracted sources linked to this entity.
  const grounded = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM public.source_entities se
       JOIN public.sources s ON s.id = se.source_id
      WHERE se.entity_id = $1 AND s.retraction_committed_at IS NULL`,
    [entityId],
  );
  const groundedCount = grounded[0]?.n ?? 0;

  // Staged / failed grounding attempts for this entity (import_jobs).
  const jobRows = await query<{ status: string; staged: boolean; committed: boolean }>(
    `SELECT status, staged, committed FROM public.import_jobs
      WHERE $1 = ANY(target_entity_ids)
      ORDER BY created_at DESC LIMIT 10`,
    [entityId],
  );
  const failed = jobRows.some((j) => j.status === "failed");
  const pendingJob = jobRows.some((j) => j.staged && !j.committed && j.status !== "failed");

  // Extraction-queue health for this entity's sources (backlog vs by-design).
  const backlog = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM public.source_extraction_queue q
       JOIN public.source_entities se ON se.source_id = q.source_id
      WHERE se.entity_id = $1 AND q.status IN ('pending','started')`,
    [entityId],
  ).catch(() => [{ n: 0 }]);
  const backlogCount = backlog[0]?.n ?? 0;

  let state: string;
  if (groundedCount > 0) state = "grounded";
  else if (failed && !pendingJob) state = "ingest_failed";
  else if (pendingJob || backlogCount > 0) state = "grounding_pending";
  else state = "mental_model"; // ungrounded belief — by design (§1.4)

  return c.json({
    entity_id: entityId,
    state,
    grounded_sources: groundedCount,
    pending: pendingJob || backlogCount > 0,
    failed,
    extraction_backlog: backlogCount,
  });
});
