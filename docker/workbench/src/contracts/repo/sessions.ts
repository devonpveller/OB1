// session(id), the jobs queue view, and the snapshot the stream emits. Research jobs carry no
// metadata, so a metadata filter returns nothing (fail closed).
import type { Db } from "../db.ts";
import { FOREIGN_IDEA, FOREIGN_JOB, type Viewer } from "../../documents/ownership.ts";

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

// rw-p2b-workspace (operator 2026-10-28): the text a user typed to start research is the user's own
// (research_prompts); the job and everything it produces are shared. A job started from the workspace
// shows its query to its owner only - to anyone else the query reads as empty.
export const OWN_QUERY = (alias: string, ownerParam: string) =>
  `CASE WHEN EXISTS (SELECT 1 FROM public.research_prompts p WHERE p.job_id = ${alias}.id AND p.owner_sub <> ${ownerParam})
        THEN '' ELSE ${alias}.query END`;

// A job is shared research output; its private fields (the original prompt, inlet_ref, refinery_id,
// thread_id) are selected for its owner only - for anyone else the SQL itself answers them empty
// (documents/ownership.ts), so the JSON read and the event stream carry one owner-filtered row.
export async function session(db: Db, id: string, who: Viewer) {
  const rows = await db.query<JobRow>(
    `SELECT j.id, j.status, j.origin, j.origin_claimed, j.caller,
            CASE WHEN o.others THEN NULL ELSE j.inlet_ref END AS inlet_ref,
            CASE WHEN o.others THEN NULL ELSE j.refinery_id END AS refinery_id,
            CASE WHEN o.others THEN '' ELSE j.query END AS query,
            j.progress, j.result, j.session_id,
            CASE WHEN o.others THEN NULL ELSE j.thread_id END AS thread_id,
            j.created_at, j.started_at, j.finished_at, j.error
       FROM public.research_jobs j CROSS JOIN LATERAL (SELECT ${FOREIGN_JOB("j", "$2", "$3")} AS others) o
      WHERE j.id = $1`,
    [id, who.sub, who.key],
  );
  return rows[0] ? shapeSession(rows[0]) : null;
}

// The kinds a caller gets when it names none (the two queues P0 shipped). The kinds P2b registered
// (init-documents.sql) are answered when named: the title bar's progress indicators ask for them.
const DEFAULT_KINDS = new Set(["import", "research"]);

// jobs(state): the import queue and the research queue (and, when asked, pages waiting for a
// compile and held user sources), newest first, one shape.
export async function jobs(db: Db, state: string | null, kinds: string[], limit: number, who: Viewer) {
  const want = (k: string) => kinds.length === 0 ? DEFAULT_KINDS.has(k) : kinds.includes(k);
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
              jsonb_build_object('origin', origin,
                                 'query', CASE WHEN o.others THEN '' ELSE left(j.query, 200) END,
                                 'refinery_id', CASE WHEN o.others THEN NULL ELSE j.refinery_id END,
                                 'phase', progress ->> 'phase', 'error', error) AS detail
         FROM public.research_jobs j CROSS JOIN LATERAL (SELECT ${FOREIGN_JOB("j", "$3", "$4")} AS others) o
        WHERE ($1::text IS NULL OR j.status = $1) ORDER BY j.created_at DESC LIMIT $2`,
      [state, limit, who.sub, who.key],
    );
    out.push(...rows.map((r) => ({ kind: "research", state: isTerminal(r.status) ? "current" : "loading", ...r })));
  }
  if (want("compile") && (state === null || state === "pending")) {
    // a page marked pending-compile (D13) that has not been recompiled since the mark
    const rows = await db.query<{ id: string; created_at: string; updated_at: string; detail: Record<string, unknown> }>(
      `SELECT m.source_id::text AS id, m.marked_at AS created_at, m.marked_at AS updated_at,
              jsonb_build_object('page_ref', m.page_ref, 'reason', m.reason) AS detail
         FROM public.page_compile_marks m
         LEFT JOIN public.wiki_pages w ON w.slug = m.page_ref
        WHERE w.slug IS NULL OR m.marked_at >= w.updated_at
        ORDER BY m.marked_at DESC LIMIT $1`,
      [limit],
    );
    out.push(...rows.map((r) => ({ kind: "compile", status: "pending", state: "loading", ...r })));
  }
  if (want("held") && (state === null || state === "held")) {
    const rows = await db.query<{ id: string; created_at: string; updated_at: string; detail: Record<string, unknown> }>(
      `SELECT rus.source_id::text AS id, rus.added_at AS created_at, COALESCE(h.updated_at, rus.added_at) AS updated_at,
              jsonb_build_object('refinery_id', CASE WHEN ${FOREIGN_IDEA("rus.refinery_id", "$2")} THEN NULL ELSE rus.refinery_id END,
                                 'title', COALESCE(h.title, '')) AS detail
         FROM public.refinery_user_sources rus LEFT JOIN public.held_sources h ON h.id = rus.source_id
        WHERE rus.status = 'held' ORDER BY rus.added_at DESC LIMIT $1`,
      [limit, who.sub],
    );
    out.push(...rows.map((r) => ({ kind: "held", status: "held", state: "current", ...r })));
  }
  return { jobs: out };
}
