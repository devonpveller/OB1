// rw-owner-private-view (slot 480): the owner's private material, read ONLY through the owner-scoped functions slot 480
// grants to ob_workbench (the workbench's own login role) - never a table. Every call passes the subject the identity
// seam resolved; the database answers nothing for any other subject. A missing function (42883: slot 480 not applied)
// or a role that may not run it (42501: the workbench still logs in as ob_app_memory) reads as nothing: fail closed.
import type { Db } from "../db.ts";

export interface PrivateClaimRow {
  id: string;
  kind: string;
  text: string;
  status: string;
  epistemic_tag: string;
  confidence: number;
  contradicted: boolean;
  created_at: string;
  private_sources: { id: string; title: string; kind: string; created_at: string }[];
  private_parents: { id: string; text: string }[];
  shared_sources: { id: string; title: string; url: string }[];
}

export interface PrivateHitRow {
  source_id: string;
  title: string;
  kind: string;
  created_at: string;
  idx: number;
  snippet: string;
  score: number;
}

export interface PrivateJobRow {
  id: string;
  root_job_id: string | null;
  created_at: string;
  state: string;
  query: string | null;
}

export interface Cursor { at: string; id: string }

function closed(e: unknown): boolean {
  const code = (e as { fields?: { code?: string } }).fields?.code;
  return code === "42883" || code === "42501" || code === "42P01";
}

async function guarded<T>(f: () => Promise<T[]>): Promise<T[]> {
  try {
    return await f();
  } catch (e) {
    if (closed(e)) return [];
    throw e;
  }
}

export function claims(db: Db, sub: string, o: { id?: string | null; q?: string | null; kind?: string; source?: string | null; before?: Cursor | null; limit: number }) {
  return guarded(() =>
    db.query<PrivateClaimRow>(
      `SELECT id::text, kind, text, status, epistemic_tag, confidence::float8 AS confidence, contradicted, created_at,
              private_sources, private_parents, shared_sources
         FROM public.owner_private_claims($1, $2::uuid, $3, $4, $5::uuid, $6::timestamptz, $7::uuid, $8)`,
      [sub, o.id ?? null, o.q ?? null, o.kind ?? "all", o.source ?? null, o.before?.at ?? null, o.before?.id ?? null, o.limit],
    )
  );
}

export function textHits(db: Db, sub: string, q: string, kind: string, limit: number) {
  return guarded(() =>
    db.query<PrivateHitRow>(
      `SELECT source_id::text, title, kind, created_at, idx, snippet, rank::float8 AS score
         FROM public.owner_private_source_text($1, $2, $3, $4)`,
      [sub, q, kind, limit],
    )
  );
}

export function knnHits(db: Db, sub: string, vec: number[], kind: string, limit: number) {
  return guarded(() =>
    db.query<PrivateHitRow>(
      `SELECT source_id::text, title, kind, created_at, idx, snippet, (1 - distance)::float8 AS score
         FROM public.owner_private_source_knn($1, $2::vector, $3, $4)`,
      [sub, `[${vec.join(",")}]`, kind, limit],
    )
  );
}

export async function hasSources(db: Db, sub: string): Promise<boolean> {
  const r = await guarded(() => db.query<{ yes: boolean }>(`SELECT public.owner_private_has_sources($1) AS yes`, [sub]));
  return !!r[0]?.yes;
}

export function jobs(db: Db, sub: string, before: Cursor | null, limit: number) {
  return guarded(() =>
    db.query<PrivateJobRow>(
      `SELECT job_id::text AS id, root_job_id::text, created_at, state, query
         FROM public.owner_private_jobs($1, $2::timestamptz, $3::uuid, $4)`,
      [sub, before?.at ?? null, before?.id ?? null, limit],
    )
  );
}

// PD1's own read of a seeded job's text (inlet_private_job): the original question, result, progress, error
export async function job(db: Db, sub: string, id: string) {
  const r = await guarded(() =>
    db.query<{ query: string | null; result: Record<string, unknown> | null; progress: Record<string, unknown> | null; error: string | null }>(
      `SELECT query, result, progress, error FROM public.inlet_private_job($1::uuid, $2)`,
      [id, sub],
    )
  );
  return r[0] ?? null;
}
