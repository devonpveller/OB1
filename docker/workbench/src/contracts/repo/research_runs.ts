// A person's own research runs (rwr-research-runs). Every read and write is for the identity seam's subject (who.sub), decided
// WHERE it is read:
//   * which runs are theirs: a root job whose recorded prompt is theirs (research_prompts), or that they started through
//     the request boundary (slot 640's run_handbacks_of: the private hand-back's owner - a started run has no prompt row),
//     or, when they are the ownerless default subject, a non-derived root nobody recorded an owner for. Nothing else
//     is listed, counted, grouped, opened, archived or turned into a document: a run that is not theirs is a 404 exactly like
//     a missing one, and a total never includes it.
//   * archive / unarchive: slot 640's per-user view state (run_view_archive / run_view_unarchive); no job, source, claim
//     or event row is touched.
//   * node details: a node's sources (the flow's own events) and the claims its result reused, each claim read from the
//     SHARED claims table by id. A claim that moved to its owner's private store (rw-private-report-claims, slot 570)
//     has no row there: it is never shown, counted or offered here, to its owner or anyone else (the owner's own private
//     claims have their own owner-only read, contract/private/claims).
import type { Db } from "../db.ts";
import type { Identity } from "../../middleware/identity.ts";
import { ownerlessOwner } from "../../documents/ownership.ts";
import { card, flow, type Who } from "../../sessions/repo.ts";
import { Conflict, NotFound } from "./lifecycle.ts";

export const MAX_RUNS = 1000;
const NO_RUN = "no research run with this id";

export type RunGroup = "running" | "queued" | "done" | "stopped";
export interface RunRow {
  id: string; question: string; topic: string | null; document: string | null; status: string; group: RunGroup; branches: number;
  created_at: string; finished_at: string | null; archived: boolean; archived_at: string | null;
}
export interface RunCounts { running: number; queued: number; done: number; stopped: number; archived: number; total: number }

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

export function groupOf(status: string, openBranches: number): RunGroup {
  if (status === "queued") return openBranches > 0 ? "running" : "queued";
  if (status === "running" || openBranches > 0) return "running";
  if (status === "done") return "done";
  return "stopped"; // error, cancelled
}

export function countsOf(rows: RunRow[]): RunCounts {
  const c: RunCounts = { running: 0, queued: 0, done: 0, stopped: 0, archived: 0, total: 0 };
  for (const r of rows) {
    if (r.archived) { c.archived++; continue; }
    c[r.group]++;
    c.total++;
  }
  return c;
}

// The caller's own root runs. $1 = the subject, $2 = the ownerless owner (null when there is none), $3 = a job id or null.
export const OWN_RUNS_SQL = `
  SELECT j.id::text AS id, j.status, j.query, j.boundary ->> 'topic' AS topic, j.created_at, j.finished_at,
         (SELECT count(*) FROM public.research_jobs c WHERE c.root_job_id = j.id)::int AS branches,
         (SELECT count(*) FROM public.research_jobs c WHERE c.root_job_id = j.id AND c.status IN ('queued', 'running'))::int AS open_branches,
         (SELECT hb.document FROM public.run_handbacks_of($1) hb WHERE hb.job_id = j.id LIMIT 1) AS document,
         (SELECT v.archived_at FROM public.run_views_of($1) v WHERE v.job_id = j.id) AS archived_at
    FROM public.research_jobs j
   WHERE j.parent_job_id IS NULL AND ($3::uuid IS NULL OR j.id = $3::uuid)
     AND (EXISTS (SELECT 1 FROM public.research_prompts p WHERE p.job_id = j.id AND p.owner_sub = $1)
          OR EXISTS (SELECT 1 FROM public.run_handbacks_of($1) hb WHERE hb.job_id = j.id)
          OR ($2::text IS NOT NULL AND $2::text = $1 AND j.request_kind <> 'derived'
              AND NOT EXISTS (SELECT 1 FROM public.research_prompts p WHERE p.job_id = j.id)))
   ORDER BY j.created_at DESC, j.id
   LIMIT $4`;

interface Raw {
  id: string; status: string; query: string; topic: string | null; created_at: unknown; finished_at: unknown;
  branches: number; open_branches: number; document: string | null; archived_at: unknown;
}
const shape = (r: Raw): RunRow => ({
  id: r.id, question: String(r.query ?? ""), topic: r.topic ?? null, document: r.document ?? null, status: r.status,
  group: groupOf(r.status, Number(r.open_branches)), branches: Number(r.branches),
  created_at: iso(r.created_at) ?? "", finished_at: iso(r.finished_at), archived: r.archived_at != null, archived_at: iso(r.archived_at),
});

async function ownRuns(db: Db, who: Identity, id: string | null, limit: number): Promise<RunRow[]> {
  const rows = await db.query<Raw>(OWN_RUNS_SQL, [who.sub, ownerlessOwner(), id, limit]);
  return rows.map(shape);
}

/** The caller's runs. `view`: active (not archived), archived, or all. The counts are over all the caller's runs. */
export async function listRuns(db: Db, who: Identity, view: "active" | "archived" | "all", limit: number) {
  const all = await ownRuns(db, who, null, MAX_RUNS);
  const shown = all.filter((r) => view === "all" || (view === "archived") === r.archived).slice(0, limit);
  return { runs: shown, counts: countsOf(all) };
}

export async function ownRun(db: Db, who: Identity, id: string): Promise<RunRow | null> {
  return (await ownRuns(db, who, id, 1))[0] ?? null;
}

interface JobResult { id: string; result: Record<string, unknown> | null }
const text = (v: unknown): string => (typeof v === "string" ? v : "");

// slot 440: a tree seeded with private text keeps its own result in an owner-only store; the owner reads it here
async function ownResult(db: Db, id: string, sub: string, shared: Record<string, unknown> | null): Promise<Record<string, unknown> | null> {
  if (!sub || sub.startsWith("service:")) return shared;
  try {
    const r = await db.query<{ result: Record<string, unknown> | null }>(`SELECT result FROM public.inlet_private_job($1::uuid, $2)`, [id, sub]);
    return r[0]?.result ?? shared;
  } catch (e) {
    const code = (e as { fields?: { code?: string } }).fields?.code;
    if (code === "42883" || code === "42501") return shared; // slot 440 not applied / not readable by this role: the shared text
    throw e;
  }
}

async function treeResults(db: Db, rootId: string, sub: string): Promise<JobResult[]> {
  const rows = await db.query<JobResult>(
    `SELECT id::text AS id, result FROM public.research_jobs WHERE coalesce(root_job_id, id) = $1::uuid ORDER BY created_at, id LIMIT 500`, [rootId]);
  const out: JobResult[] = [];
  for (const r of rows) out.push({ id: r.id, result: await ownResult(db, r.id, sub, r.result) });
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One run: its tree, each node with its sources and the shared claims its result reused. Null = not the caller's. */
export async function runDetail(db: Db, who: Identity & Partial<Who>, id: string, owui: string) {
  const run = await ownRun(db, who, id);
  if (!run) return null;
  const c = await card(db, id, who as Who, owui);
  if (!c) return null;
  const results = new Map((await treeResults(db, id, who.sub)).map((r) => [r.id, r.result]));
  const fl = await flow(db, id, who as Who);
  const byJob = new Map<string, { url: string; title: string | null; stages: string[] }[]>();
  for (const s of fl?.sources ?? []) {
    const list = byJob.get(s.job_id) ?? [];
    list.push({ url: s.url, title: null, stages: s.stages.map((x) => x.kind).filter(Boolean) });
    byJob.set(s.job_id, list);
  }
  // the claims a node's result reused: only those that still exist in the SHARED claims table, by their text there
  const wanted = new Set<string>();
  for (const r of results.values()) {
    const rc = r?.reuse_claims;
    if (Array.isArray(rc)) for (const x of rc) { const cid = String((x as Record<string, unknown>)?.id ?? ""); if (UUID.test(cid)) wanted.add(cid.toLowerCase()); }
  }
  const claimText = new Map<string, string>();
  if (wanted.size) {
    const rows = await db.query<{ id: string; text: string }>(`SELECT id::text AS id, text FROM public.claims WHERE id = ANY($1::uuid[])`, [[...wanted]]);
    for (const r of rows) claimText.set(r.id.toLowerCase(), r.text);
  }
  const nodes = c.card.tree.map((b) => {
    const res = results.get(b.id) ?? null;
    const sources = [...(byJob.get(b.id) ?? [])];
    const have = new Set(sources.map((s) => s.url));
    const cited = Array.isArray(res?.cited_sources) ? res!.cited_sources as unknown[] : [];
    for (const s of cited) {
      const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
      const url = text(o.url);
      if (url && !have.has(url)) { have.add(url); sources.push({ url, title: text(o.title) || null, stages: [] }); }
      else if (url) { const e = sources.find((x) => x.url === url); if (e && !e.title) e.title = text(o.title) || null; }
    }
    const claims: { id: string; text: string }[] = [];
    const rc = Array.isArray(res?.reuse_claims) ? res!.reuse_claims as unknown[] : [];
    for (const x of rc) {
      const cid = String((x as Record<string, unknown>)?.id ?? "").toLowerCase();
      const t = claimText.get(cid);
      if (t !== undefined && !claims.some((k) => k.id === cid)) claims.push({ id: cid, text: t });
    }
    return { ...b, sources, claims, has_report: reportOf(res) !== "" };
  });
  return {
    run, can_act: c.card.can_act, running: c.card.state === "loading", next_steering_point: c.card.next_steering_point, nodes,
  };
}

export function reportOf(result: Record<string, unknown> | null): string {
  if (!result) return "";
  return (text(result.prose).trim() || text(result.synthesis).trim());
}

export async function setArchived(db: Db, who: Identity, id: string, archived: boolean) {
  const run = await ownRun(db, who, id);
  if (!run) throw new NotFound(NO_RUN);
  const rows = await db.query<{ ok: boolean }>(
    archived ? `SELECT public.run_view_archive($1, $2::uuid) AS ok` : `SELECT public.run_view_unarchive($1, $2::uuid) AS ok`, [who.sub, id]);
  if (!rows[0]?.ok) throw new Conflict(archived ? "this run is already archived" : "this run is not archived");
  const after = await ownRun(db, who, id);
  return { id, archived: !!after?.archived, archived_at: after?.archived_at ?? null };
}

export interface DocSeam { createOwnDocument?: (input: { title: string; body: string; fields: Record<string, string> }, who: Identity) => Promise<{ path: string }> }
export class Unavailable extends Error {}

const titleOf = (q: string) => {
  const t = q.replace(/\s+/g, " ").trim().slice(0, 120);
  return t || "Research report";
};

/** The run's report as a new document in the caller's own folder. Nothing but the document file and its own listing is written. */
export async function reportAsDocument(db: Db, seam: DocSeam, who: Identity, id: string) {
  const run = await ownRun(db, who, id);
  if (!run) throw new NotFound(NO_RUN);
  if (!seam.createOwnDocument) throw new Unavailable("documents are not available here");
  const res = (await treeResults(db, id, who.sub)).find((r) => r.id === id)?.result ?? null;
  const report = reportOf(res);
  if (!report) throw new Conflict("this run has no report yet");
  const title = titleOf(run.question);
  const d = await seam.createOwnDocument({ title, body: report + "\n", fields: { research_run: id } }, who);
  return { path: d.path, title };
}
