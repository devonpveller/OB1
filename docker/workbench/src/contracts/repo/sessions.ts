// session(id), the jobs queue view, and the snapshot the stream emits. Research jobs carry no
// metadata, so a metadata filter returns nothing (fail closed).
import type { Db } from "../db.ts";

interface JobRow {
  id: string;
  status: string;
  origin: string;
  origin_claimed: string | null;
  caller: string | null;
  inlet_ref: Record<string, unknown> | null;
  refinery_id: string | null;
  query: string;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  session_id: string | null;
  thread_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

const TERMINAL = new Set(["done", "error", "cancelled"]);

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

function arrayLen(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function gapsOf(result: Record<string, unknown> | null): string[] {
  const g = result?.gaps;
  if (!Array.isArray(g)) return [];
  return g.map((x) => typeof x === "string" ? x : String((x as Record<string, unknown>)?.query ?? (x as Record<string, unknown>)?.text ?? JSON.stringify(x)))
    .slice(0, 50);
}

export function shapeSession(r: JobRow) {
  const running = r.status === "queued" || r.status === "running";
  return {
    id: r.id,
    state: running ? "loading" : "current",
    state_detail: running
      ? { action: String(r.progress?.phase ?? r.status), message: String(r.progress?.message ?? "") }
      : r.error ? { error: r.error } : {},
    status: r.status, origin: r.origin, origin_claimed: r.origin_claimed, caller: r.caller,
    inlet_ref: r.inlet_ref, refinery_id: r.refinery_id, query: r.query, progress: r.progress ?? {},
    session_id: r.session_id, thread_id: r.thread_id,
    created_at: r.created_at, started_at: r.started_at, finished_at: r.finished_at,
    result_summary: {
      claims: arrayLen(r.result?.claims),
      cited_sources: arrayLen(r.result?.cited_sources),
      gaps: gapsOf(r.result),
    },
  };
}

export async function session(db: Db, id: string) {
  const rows = await db.query<JobRow>(
    `SELECT id, status, origin, origin_claimed, caller, inlet_ref, refinery_id, query, progress, result,
            session_id, thread_id, created_at, started_at, finished_at, error
       FROM public.research_jobs WHERE id = $1`,
    [id],
  );
  return rows[0] ? shapeSession(rows[0]) : null;
}

// jobs(state): the import queue and the research queue, newest first, one shape.
export async function jobs(db: Db, state: string | null, kinds: string[], limit: number) {
  const want = (k: string) => kinds.length === 0 || kinds.includes(k);
  const out: unknown[] = [];
  if (want("import")) {
    const rows = await db.query<{ id: string; status: string; created_at: string; updated_at: string; detail: Record<string, unknown> }>(
      `SELECT id, status, created_at, updated_at,
              jsonb_build_object('source_id', source_id, 'target_notebook', target_notebook, 'error', error,
                                 'staged', staged, 'committed', committed, 'duplicate', duplicate) AS detail
         FROM public.import_jobs WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT $2`,
      [state, limit],
    );
    out.push(...rows.map((r) => ({ kind: "import", state: ["done", "failed"].includes(r.status) ? "current" : "loading", ...r })));
  }
  if (want("research")) {
    const rows = await db.query<{ id: string; status: string; created_at: string; updated_at: string; detail: Record<string, unknown> }>(
      `SELECT id, status, created_at, updated_at,
              jsonb_build_object('origin', origin, 'query', left(query, 200), 'refinery_id', refinery_id,
                                 'phase', progress ->> 'phase', 'error', error) AS detail
         FROM public.research_jobs WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT $2`,
      [state, limit],
    );
    out.push(...rows.map((r) => ({ kind: "research", state: isTerminal(r.status) ? "current" : "loading", ...r })));
  }
  return { jobs: out };
}
