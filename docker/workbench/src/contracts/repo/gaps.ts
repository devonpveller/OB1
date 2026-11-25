// Document gaps (research-workbench redesign, rwr-doc-gaps-api): the reads and writes over public.document_gaps
// (init-document-gaps.sql, slot 650), and "research these".
//
// Per user (07-MULTI-USER): a gap is its owner's own context. owner_sub is the identity seam's subject_sub, actor_sub
// who acted; EVERY statement here filters by owner_sub = who.sub, and another user's gap by id is NOT FOUND, never
// forbidden - the same words as a missing one. A duplicate is only ever looked up among the caller's own gaps, so the
// refusal that names "the existing gap" can name only a gap of the caller's.
//
// THE ROTATE-OUT RULE (new in this item; stated here, in the findings and in test-plans/rwr-doc-gaps-api.md):
//   a gap rotates out (state covered) when the run it was queued in has FINISHED (research_jobs.status = done) AND the
//   gap's question has at least one claim, filed by that run, that is backed by TWO AGREEING SOURCES; or when the person
//   marks it covered. A run finishing alone never covers a gap.
//   - "the gap's question has a claim": a claim the run filed (research_jobs.result.curator.claims.filed) whose embedding
//     is at least GAP_COVER_MIN_SIM (default 0.55, cosine, the same bge-m3 space the claims are embedded in) close to the
//     gap's text. The claim must be active and not contradicted.
//   - "two agreeing sources": two DISTINCT, independent shared sources each linked to that claim by a supporting edge
//     (states or corroborates - never contradicts), neither retracted, suppressed or unlinked. Independent = a different
//     host (sources.domain; a source with no domain counts as its own host), so two pages of one site count once.
//   A run that ended without covering the gap (done but no such claim, or error / cancelled) returns it to open, its
//   job_id kept; the person may research it again. The settle happens when the caller reads (list / get), for the
//   caller's own researching gaps only - there is no background writer.
import type { Db } from "../db.ts";
import { type RegistryReader, REGISTRY, requireRegistered } from "../registry.ts";
import { BadRequest } from "../logic/scope.ts";
import { Conflict, NotFound } from "./lifecycle.ts";
import type { Identity } from "../../middleware/identity.ts";
import { documentPathsIn, ownsDocumentPaths } from "../../documents/ownership.ts";

export interface GapRow {
  id: string;
  path: string;
  text: string;
  origin: string;
  state: string;
  job_id: string | null;
  covered_at: string | null;
  created_at: string;
  updated_at: string;
}
interface Raw {
  id: string;
  doc_path: string;
  text: string;
  origin: string;
  state: string;
  job_id: string | null;
  covered_at: string | null;
  created_at: string;
  updated_at: string;
}
const COLS = `id, doc_path, text, origin, state, job_id, covered_at, created_at, updated_at`;
const shape = (r: Raw): GapRow => ({
  id: r.id, path: r.doc_path, text: r.text, origin: r.origin, state: r.state, job_id: r.job_id,
  covered_at: r.covered_at, created_at: r.created_at, updated_at: r.updated_at,
});

export const NO_SUCH_GAP = "no such gap";
export class ResearchUnavailable extends Error {}

/** The de-dup key: lower case, whitespace collapsed, quotes / brackets and sentence punctuation off the edges. */
export function normalizeGapText(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()
    .replace(/^[\s"'“”‘’(\[{]+/, "").replace(/[\s"'“”‘’)\]}.,;:!?…]+$/, "");
}

const isUnique = (e: unknown) => (e as { fields?: { code?: string } })?.fields?.code === "23505";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function checkDocument(db: Db, who: Identity, path: string): Promise<string> {
  const paths = documentPathsIn(path);
  const norm = path.replace(/\\/g, "/");
  if (paths.length !== 1 || paths[0] !== norm) throw new BadRequest("path must be a document path (documents/...)");
  // another user's document and a missing one are the same refusal
  if (!(await ownsDocumentPaths(db, paths, who))) throw new NotFound("no such document");
  return norm;
}

/** The caller's own gap that blocks this text: an active one, or a dismissed one of the same origin. */
async function blocker(db: Db, who: Identity, path: string, norm: string, origin: string, exceptId?: string): Promise<GapRow | null> {
  const r = await db.query<Raw>(
    `SELECT ${COLS} FROM public.document_gaps
      WHERE owner_sub = $1 AND doc_path = $2 AND text_norm = $3 AND ($5::uuid IS NULL OR id <> $5)
        AND (state IN ('open', 'researching') OR (state = 'dismissed' AND origin = $4))
      ORDER BY (state = 'dismissed'), created_at LIMIT 1`,
    [who.sub, path, norm, origin, exceptId ?? null],
  );
  return r[0] ? shape(r[0]) : null;
}

function refuse(existing: GapRow): never {
  throw new Conflict(
    existing.state === "dismissed"
      ? "this gap was dismissed from the same origin; reopen it instead"
      : "this gap is already on the list",
    { existing },
  );
}

export interface GapInput { path: string; text: string; origin?: string }

export async function createGap(db: Db, reg: RegistryReader, who: Identity, b: GapInput): Promise<GapRow> {
  const origin = b.origin ?? "user";
  await requireRegistered(reg, REGISTRY.gapOrigins, origin);
  const path = await checkDocument(db, who, b.path);
  const text = b.text.trim();
  const norm = normalizeGapText(text);
  if (!norm) throw new BadRequest("a gap needs some words");
  const dup = await blocker(db, who, path, norm, origin);
  if (dup) refuse(dup);
  const r = await db.query<Raw>(
    `INSERT INTO public.document_gaps (owner_sub, actor_sub, doc_path, text, text_norm, origin)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING ${COLS}`,
    [who.sub, who.actor, path, text, norm, origin],
  );
  if (r[0]) return shape(r[0]);
  // lost a race with the same text: name the row that won
  const again = await blocker(db, who, path, norm, origin);
  if (again) refuse(again);
  throw new Conflict("this gap is already on the list");
}

export interface ListOpts { limit: number; path?: string; state?: string }

export async function listGaps(db: Db, who: Identity, o: ListOpts) {
  const args: unknown[] = [who.sub];
  const where = [`owner_sub = $1`];
  if (o.path) { args.push(o.path.replace(/\\/g, "/")); where.push(`doc_path = $${args.length}`); }
  const base = where.join(" AND ");
  const f = [...where];
  if (o.state) { args.push(o.state); f.push(`state = $${args.length}`); } else f.push(`state <> 'dismissed'`);
  const fw = f.join(" AND ");
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.document_gaps WHERE ${fw}`, args))[0].n;
  const counts = await db.query<{ state: string; n: number }>(
    `SELECT state, count(*)::int AS n FROM public.document_gaps WHERE ${base} GROUP BY state`, args.slice(0, o.path ? 2 : 1));
  const c = { open: 0, researching: 0, covered: 0, dismissed: 0 } as Record<string, number>;
  for (const r of counts) if (r.state in c) c[r.state] = r.n;
  args.push(o.limit);
  const rows = await db.query<Raw>(`SELECT ${COLS} FROM public.document_gaps WHERE ${fw} ORDER BY created_at DESC, id LIMIT $${args.length}`, args);
  return { gaps: rows.map(shape), total, counts: c };
}

export async function getGap(db: Db, who: Identity, id: string): Promise<GapRow | null> {
  if (!UUID.test(id)) return null;
  const r = await db.query<Raw>(`SELECT ${COLS} FROM public.document_gaps WHERE id = $1 AND owner_sub = $2`, [id, who.sub]);
  return r[0] ? shape(r[0]) : null;
}

export interface GapPatch { text?: string; state?: string }

export async function updateGap(db: Db, reg: RegistryReader, who: Identity, id: string, p: GapPatch): Promise<GapRow | null> {
  if (p.text === undefined && p.state === undefined) throw new BadRequest("give text or state");
  if (p.state !== undefined) {
    await requireRegistered(reg, REGISTRY.gapStates, p.state);
    if (p.state === "researching") throw new BadRequest("a gap becomes researching only by researching it");
  }
  const cur = await getGap(db, who, id);
  if (!cur) return null;
  if (cur.state === "researching" && p.text !== undefined) throw new Conflict("a gap that is being researched cannot be reworded");
  const text = p.text !== undefined ? p.text.trim() : cur.text;
  const norm = normalizeGapText(text);
  if (!norm) throw new BadRequest("a gap needs some words");
  const state = p.state ?? cur.state;
  if (state === "open" || state === "researching" || state === "dismissed") {
    const dup = await blocker(db, who, cur.path, norm, cur.origin, id);
    if (dup) refuse(dup);
  }
  try {
    const r = await db.query<Raw>(
      `UPDATE public.document_gaps
          SET text = $3, text_norm = $4, state = $5, updated_at = now(),
              covered_at = CASE WHEN $5 = 'covered' THEN coalesce(covered_at, now()) ELSE NULL END
        WHERE id = $1 AND owner_sub = $2 RETURNING ${COLS}`,
      [id, who.sub, text, norm, state],
    );
    return r[0] ? shape(r[0]) : null;
  } catch (e) {
    if (!isUnique(e)) throw e;
    const again = await blocker(db, who, cur.path, norm, cur.origin, id);
    if (again) refuse(again);
    throw new Conflict("this gap is already on the list");
  }
}

/** Remove the caller's own gap. A dismissed gap is kept: it is what stops its origin bringing it back. */
export async function deleteGap(db: Db, who: Identity, id: string): Promise<boolean> {
  const cur = await getGap(db, who, id);
  if (!cur) return false;
  if (cur.state === "dismissed") throw new Conflict("a dismissed gap is kept so its origin cannot bring it back; reopen it instead");
  if (cur.state === "researching") throw new Conflict("a gap that is being researched cannot be removed");
  await db.query(`DELETE FROM public.document_gaps WHERE id = $1 AND owner_sub = $2`, [id, who.sub]);
  return true;
}

export type QueueResearch = (path: string, query: string, who: Identity) => Promise<{ job_id: string }>;

/** The ONE question a run is queued with: the gap's own words, or the numbered list for several. */
export function runQuery(texts: string[]): string {
  if (texts.length === 1) return texts[0];
  return `What does this document still need? Research each of these:\n${texts.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;
}

/** "Research these": ONE run for the ticked gaps, through the existing research path; marks them researching. */
export async function researchGaps(db: Db, queue: QueueResearch | undefined, who: Identity, ids: string[]) {
  const want = [...new Set(ids.map((i) => i.toLowerCase()))];
  if (!want.length || !want.every((i) => UUID.test(i))) throw new NotFound(NO_SUCH_GAP);
  if (!queue) throw new ResearchUnavailable("the research service is not configured for the workbench");
  let held: { path: string; texts: string[] } | undefined;
  // 1. a short transaction: lock the rows, check them, mark them researching (no run yet). A second request for the
  //    same gaps waits on the lock, then finds them researching - so one set of ticked gaps never makes two runs.
  //    No connection is held while the research service is called.
  await db.tx(async (t) => {
    const rows = await t.query<Raw>(
      `SELECT ${COLS} FROM public.document_gaps WHERE id = ANY($1::uuid[]) AND owner_sub = $2 ORDER BY created_at, id FOR UPDATE`,
      [want, who.sub],
    );
    // another user's gap and a missing one: the same refusal, before anything else is said
    if (rows.length !== want.length) throw new NotFound(NO_SUCH_GAP);
    if (new Set(rows.map((r) => r.doc_path)).size !== 1) throw new BadRequest("tick gaps of one document");
    if (rows.some((r) => r.state !== "open")) throw new Conflict("only open gaps can be researched");
    held = { path: rows[0].doc_path, texts: rows.map((r) => r.text) };
    await t.query(`UPDATE public.document_gaps SET state = 'researching', job_id = NULL, updated_at = now() WHERE id = ANY($1::uuid[]) AND owner_sub = $2`, [want, who.sub]);
  });
  // 2. ONE run for all of them, through the existing research path; if it cannot be queued the gaps are open again
  let jobId: string;
  try {
    jobId = (await queue(held!.path, runQuery(held!.texts), who)).job_id;
  } catch (e) {
    await db.query(
      `UPDATE public.document_gaps SET state = 'open', updated_at = now() WHERE id = ANY($1::uuid[]) AND owner_sub = $2 AND state = 'researching' AND job_id IS NULL`,
      [want, who.sub],
    );
    throw e;
  }
  // 3. both (all) gaps carry that one job id
  await db.query(`UPDATE public.document_gaps SET job_id = $3, updated_at = now() WHERE id = ANY($1::uuid[]) AND owner_sub = $2 AND state = 'researching'`, [want, who.sub, jobId]);
  const rows = await db.query<Raw>(`SELECT ${COLS} FROM public.document_gaps WHERE job_id = $1 AND owner_sub = $2 ORDER BY created_at, id`, [jobId, who.sub]);
  return { job_id: jobId, gaps: rows.map(shape) };
}

// ── the rotate-out rule ────────────────────────────────────────────────────────────────────
export const DEFAULT_MIN_SIM = 0.55;

/** Does ANY of these claims (ids the run filed) answer the gap and stand on two agreeing sources? */
export async function coveredBy(db: Db, claimIds: string[], vec: number[], minSim: number): Promise<boolean> {
  if (!claimIds.length) return false;
  const r = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM public.claims c
        WHERE c.id = ANY($1::uuid[]) AND c.status = 'active' AND NOT c.contradicted AND c.embedding IS NOT NULL
          AND 1 - (c.embedding <=> $2::vector) >= $3
          AND (SELECT count(DISTINCT coalesce(nullif(lower(s.domain), ''), s.id::text))
                 FROM public.claim_sources cs JOIN public.sources s ON s.id = cs.source_id
                WHERE cs.claim_id = c.id AND cs.edge_type IN ('states', 'corroborates')
                  AND s.retracted_at IS NULL AND s.suppression_reason IS NULL AND s.unlinked_at IS NULL) >= 2
     ) AS ok`,
    [claimIds, JSON.stringify(vec), minSim],
  );
  return !!r[0]?.ok;
}

/** Settle the caller's researching gaps whose run has ended: covered (the rule above) or back to open. */
export async function settleGaps(db: Db, embed: (t: string) => Promise<number[]>, who: Identity, minSim = DEFAULT_MIN_SIM): Promise<number> {
  const ended = await db.query<{ id: string; text: string; status: string | null; filed: unknown }>(
    `SELECT g.id, g.text, j.status, j.result -> 'curator' -> 'claims' -> 'filed' AS filed
       FROM public.document_gaps g LEFT JOIN public.research_jobs j ON j.id = g.job_id
      WHERE g.owner_sub = $1 AND g.state = 'researching'
        AND ((g.job_id IS NOT NULL AND (j.id IS NULL OR j.status IN ('done', 'error', 'cancelled')))
             OR (g.job_id IS NULL AND g.updated_at < now() - interval '2 minutes'))`,
    [who.sub],
  );
  let n = 0;
  for (const g of ended) {
    let covered = false;
    if (g.status === "done") {
      const filed = (Array.isArray(g.filed) ? g.filed : []).filter((x): x is string => typeof x === "string" && UUID.test(x));
      if (filed.length) {
        try {
          covered = await coveredBy(db, filed, await embed(g.text), minSim);
        } catch {
          continue; // the question could not be embedded just now: still researching, settled on a later read
        }
      }
    }
    const r = await db.query(
      `UPDATE public.document_gaps
          SET state = $2, covered_at = CASE WHEN $2 = 'covered' THEN now() ELSE NULL END, updated_at = now()
        WHERE id = $1 AND owner_sub = $3 AND state = 'researching' RETURNING id`,
      [g.id, covered ? "covered" : "open", who.sub],
    );
    n += r.length;
  }
  return n;
}
