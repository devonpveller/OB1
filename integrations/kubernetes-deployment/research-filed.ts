/**
 * research-filed.ts - rw-curator-filed. The typed 'filed' event (research_job_events, P4a +
 * docker/init-research-filed.sql), written by POST /research/persist INSIDE the filing transaction:
 * the synthesis, its sessions and sources, and the event commit together or not at all. The research
 * service reads the event to learn whether a curator call it gave up on actually filed the run.
 *
 * No imports: the module takes any client with queryObject, so the lab e2e drives the very SQL
 * persist runs.
 */
export interface FiledClient {
  queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A job id as persist accepts it: absent/blank = no event (an interactive or legacy caller), else a UUID. */
export function parseFiledJobId(raw: unknown): { jobId: string | null; error: string | null } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return { jobId: null, error: null };
  if (typeof raw !== "string" || !UUID_RE.test(raw.trim())) return { jobId: null, error: "job_id must be a uuid" };
  return { jobId: raw.trim().toLowerCase(), error: null };
}

/**
 * Record that `jobId` was filed as `synthesisId`. Call it on the filing's transaction client, before
 * COMMIT. Throws when the job does not exist (the whole filing then rolls back: an event without a
 * job, or a filing the research service cannot find, is refused). A second call for the same job
 * (a retried hand-off) updates the one event instead of adding another.
 */
export async function recordFiledEvent(
  c: FiledClient,
  f: { jobId: string; researchKey: string; synthesisId: string; sourcesWritten: number; threadId: string | null; sessionId: string },
): Promise<number> {
  const r = await c.queryObject<{ id: string }>(
    `INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, payload)
     SELECT j.id, COALESCE(j.root_job_id, j.id), 'filed', 'due_process', $2::jsonb
       FROM public.research_jobs j WHERE j.id = $1
     ON CONFLICT (job_id) WHERE type = 'filed'
     DO UPDATE SET payload = EXCLUDED.payload, created_at = now()
     RETURNING id::text AS id`,
    [f.jobId, JSON.stringify({
      synthesis_id: f.synthesisId,
      research_key: f.researchKey,
      sources_written: f.sourcesWritten,
      thread_id: f.threadId,
      session_id: f.sessionId,
    })],
  );
  if (r.rows.length === 0) throw new Error(`filed event: research job ${f.jobId} does not exist`);
  return Number(r.rows[0].id);
}
