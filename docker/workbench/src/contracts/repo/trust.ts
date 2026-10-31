// research-workbench P3b - the reads behind the trust panels (coverage, the report credibility
// roll-up) and the roll-up section an exported report carries. Wiring over what P3a and P4a already
// record; nothing here scores anything:
//   - the roll-up is research_jobs.metrics.credibility as the research service wrote it (P3a,
//     rw-p3a-figure-filed: re-stated from the filing result), with the claim-kind weights it used;
//   - needs are research_jobs.result.needs_status, the topic estimate and the anchor are the tree's
//     columns (P4a, init-research-trees.sql);
//   - the hubs are the P2b hub-context computation (documents/hub.ts), seeded with the session's
//     report and the sources its claims stand on.
//
// Multi-user (07-MULTI-USER): the roll-up of a REPORT is shared knowledge (every user reads the same);
// a session's coverage and a document's coverage are the signed-in subject's own - another user's
// session is 404 (FOREIGN_JOB, documents/ownership.ts), another user's document is 404 (ownedPath),
// and a document lists only the subject's own sessions. Nothing here reads a caller-supplied user.
import type { Db } from "../db.ts";
import { adminSeesOwnerless, FOREIGN_JOB, type Viewer } from "../../documents/ownership.ts";
import { hubContext } from "../../documents/hub.ts";
import type { OutboundLink } from "../../documents/listing.ts";
import { docRel, rootOf } from "../../documents/paths.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The job whose filing produced report `reportId` (the curator's persist answer names the synthesis).
const JOB_OF_REPORT = `j.result -> 'curator' -> 'persist' ->> 'synthesis_id'`;

export interface RollupRecord {
  value?: unknown;
  claims?: unknown;
  below_floor?: unknown;
  judged_lines?: unknown;
  judged_not_filed?: unknown;
  kind?: unknown;
  model_version?: unknown;
  weights?: unknown;
  filed?: unknown;
  not_filed?: unknown;
  basis?: unknown;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const KIND = /^[a-z0-9][a-z0-9_.-]*$/;

const NOT_FILED_TEXT: Record<string, string> = {
  dry_run: "a dry run, nothing was filed",
  curator_error: "the curator did not file this run",
  claims_error: "the grounded claims were not written",
  no_claim_written: "the curator wrote no claim of this run",
};

export function weightsLine(weights: { family: string; weight: number }[]): string {
  return weights.length ? weights.map((w) => `${w.family} ${w.weight.toFixed(2)}`).join(", ") : "none recorded";
}

// PURE: the roll-up as the contract carries it, from what the job row holds. The statement always
// names the claim kind and the weights - a report never shows a bare number (D15).
export function shapeRollup(rec: RollupRecord | null | undefined, reportId: string | null, jobId: string | null) {
  if (!rec || typeof rec !== "object") {
    return {
      report_id: reportId, job_id: jobId, recorded: false, value: null, claims: 0, below_floor: 0, judged_lines: 0,
      judged_not_filed: 0, claim_kind: null, model_version: null, weights: [], filed: null, not_filed: null, basis: null,
      statement: "Report credibility: not recorded for this report (its run predates the D15 roll-up, or no research job filed it)",
    };
  }
  const weights = rec.weights && typeof rec.weights === "object" && !Array.isArray(rec.weights)
    ? Object.entries(rec.weights as Record<string, unknown>)
      .filter(([f, w]) => KIND.test(f) && num(w) !== null)
      .map(([family, w]) => ({ family, weight: num(w)! }))
      .sort((a, b) => b.weight - a.weight || a.family.localeCompare(b.family))
    : [];
  const kind = str(rec.kind) && KIND.test(rec.kind as string) ? rec.kind as string : null;
  const model = str(rec.model_version);
  const value = num(rec.value);
  const claims = int(rec.claims);
  const below = int(rec.below_floor);
  const notFiled = str(rec.not_filed);
  const used = `claim kind ${kind ?? "not recorded"}, weights ${weightsLine(weights)}; model ${model ?? "not recorded"}`;
  let statement: string;
  if (notFiled) {
    statement = `Report credibility: n/a - not filed (${NOT_FILED_TEXT[notFiled] ?? notFiled}); ${used}`;
  } else if (value === null) {
    statement = `Report credibility: n/a - no filed claim to roll up (${int(rec.judged_lines)} line(s) judged); ${used}`;
  } else {
    statement = `Report credibility ${value.toFixed(2)} - the mean of ${claims} filed claim total(s), ${below} below the claim floor` +
      `${int(rec.judged_not_filed) ? `, ${int(rec.judged_not_filed)} judged line(s) not filed` : ""}; ${used}`;
  }
  return {
    report_id: reportId, job_id: jobId, recorded: true, value, claims, below_floor: below,
    judged_lines: int(rec.judged_lines), judged_not_filed: int(rec.judged_not_filed), claim_kind: kind, model_version: model,
    weights, filed: typeof rec.filed === "boolean" ? rec.filed : null, not_filed: notFiled, basis: str(rec.basis),
    statement,
  };
}

export type Rollup = ReturnType<typeof shapeRollup>;

// The roll-up of a report (shared knowledge): the latest finished job that filed it.
export async function reportCredibility(db: Db, reportId: string): Promise<Rollup | null> {
  if (!UUID.test(reportId)) return null;
  const src = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM public.sources WHERE id = $1::uuid AND content_type = 'research_synthesis'`, [reportId],
  );
  if (!src.length) return null;
  const jobs = await db.query<{ id: string; credibility: RollupRecord | null }>(
    `SELECT j.id::text AS id, j.metrics -> 'credibility' AS credibility
       FROM public.research_jobs j
      WHERE ${JOB_OF_REPORT} = $1
      ORDER BY (j.metrics -> 'credibility') IS NOT NULL DESC, j.finished_at DESC NULLS LAST, j.created_at DESC
      LIMIT 1`,
    [reportId.toLowerCase()],
  );
  return shapeRollup(jobs[0]?.credibility ?? null, reportId.toLowerCase(), jobs[0]?.id ?? null);
}

// The section an exported research report carries (P3b acceptance 4; P6b's gate checks for it): at the
// HEAD of the report, after its frontmatter. Its heading is ROLLUP_HEADING (P6b keys on it).
export const ROLLUP_HEADING = "Report credibility";

export function rollupMarkdown(r: Rollup): string {
  const rows = r.weights.length
    ? ["| Source family | Weight |", "|---|---|", ...r.weights.map((w) => `| ${w.family} | ${w.weight.toFixed(2)} |`)]
    : ["No claim-kind weights were recorded with this report."];
  return [
    `## ${ROLLUP_HEADING}`,
    "",
    r.statement,
    "",
    `Claim kind: ${r.claim_kind ?? "not recorded"}. Model: ${r.model_version ?? "not recorded"}. The weights the roll-up used:`,
    "",
    ...rows,
    "",
  ].join("\n");
}

// PURE: the section inserted at the head of the report, after its frontmatter and its first H1 (when
// the body opens with one), so it is the report's header.
export function withRollupSection(md: string, section: string): string {
  let head = "";
  let rest = md;
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(rest);
  if (fm) {
    head = fm[0];
    rest = rest.slice(fm[0].length);
  }
  const h1 = /^(\s*\n)*# [^\n]*\n/.exec(rest);
  if (h1) {
    head += h1[0];
    rest = rest.slice(h1[0].length);
  }
  return `${head}${head && !head.endsWith("\n\n") ? "\n" : ""}${section}\n${rest}`;
}

const REPORT_PAGE = /^content\/source\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i;

// The export's wiring (routes/export.ts readNote): a research report's page gets its roll-up section;
// any other page is returned unchanged.
export async function exportWithRollup(db: Db, rel: string, md: string): Promise<string> {
  const m = REPORT_PAGE.exec(rel);
  if (!m) return md;
  const r = await reportCredibility(db, m[1]);
  return r ? withRollupSection(md, rollupMarkdown(r)) : md;
}

// ── coverage ─────────────────────────────────────────────────────────────────────────────────────

interface JobRow {
  id: string;
  status: string;
  created_at: string;
  others: boolean;
  needs_status: unknown;
  gaps: unknown;
  topic_estimate: string | null;
  anchor: string | null;
  root_query: string | null;
  query: string;
  is_root: boolean;
  report_id: string | null;
  source_ids: unknown;
  credibility: RollupRecord | null;
}

const STATUSES = ["answered", "partial", "open", "search_failed"];

export function needsOf(v: unknown): { need: string; status: string }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((n) => {
    const o = n as Record<string, unknown>;
    return typeof o?.need === "string" && typeof o?.status === "string" ? [{ need: o.need, status: o.status }] : [];
  }).slice(0, 200);
}

// PURE: needs counted by status - every status the panel names is present (0 when none); never a percent.
export function countByStatus(needs: { status: string }[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const n of needs) out[n.status] = (out[n.status] ?? 0) + 1;
  return out;
}

function gapsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => typeof x === "string" ? x : String((x as Record<string, unknown>)?.query ?? (x as Record<string, unknown>)?.text ?? ""))
    .filter(Boolean).slice(0, 50);
}

const JOB_COLS = (who: string, key: string, admin: boolean) => `
  j.id::text AS id, j.status, j.created_at,
  ${FOREIGN_JOB("j", who, key, admin)} AS others,
  j.result -> 'needs_status' AS needs_status, j.result -> 'gaps' AS gaps,
  COALESCE(j.topic_estimate, r.topic_estimate) AS topic_estimate, j.anchor, r.query AS root_query, j.query,
  (j.root_job_id IS NULL OR j.root_job_id = j.id) AS is_root,
  ${JOB_OF_REPORT} AS report_id, j.result -> 'curator' -> 'persist' -> 'source_ids' AS source_ids,
  j.metrics -> 'credibility' AS credibility`;

async function sessionLinks(db: Db, reportId: string | null, sourceIds: unknown): Promise<OutboundLink[]> {
  const ids = new Set<string>(Array.isArray(sourceIds) ? sourceIds.filter((x): x is string => typeof x === "string" && UUID.test(x)) : []);
  if (reportId && UUID.test(reportId)) {
    const rows = await db.query<{ source_id: string }>(
      `SELECT DISTINCT cs.source_id::text AS source_id FROM public.claims c JOIN public.claim_sources cs ON cs.claim_id = c.id
        WHERE c.synthesis_id = $1::uuid AND cs.source_id IS NOT NULL`,
      [reportId],
    );
    for (const r of rows) ids.add(r.source_id);
  }
  const links: OutboundLink[] = [...ids].sort().map((id) => ({ kind: "source", id, pin: null, reference_id: null }));
  if (reportId && UUID.test(reportId)) links.unshift({ kind: "report", id: reportId, pin: null, reference_id: null });
  return links;
}

// A session's coverage: its owner's only (another user's session is null -> 404, as if it did not exist).
export async function sessionCoverage(db: Db, id: string, who: Viewer & { admin?: boolean; impersonating?: unknown }) {
  if (!UUID.test(id)) return null;
  const rows = await db.query<JobRow>(
    `SELECT ${JOB_COLS("$2", "$3", adminSeesOwnerless(who))}
       FROM public.research_jobs j LEFT JOIN public.research_jobs r ON r.id = COALESCE(j.root_job_id, j.id)
      WHERE j.id = $1::uuid`,
    [id, who.sub, who.key],
  );
  const j = rows[0];
  if (!j || j.others) return null;
  const needs = needsOf(j.needs_status);
  const reportId = j.report_id && UUID.test(j.report_id) ? j.report_id.toLowerCase() : null;
  const hubs = (await hubContext(db, `session:${j.id}`, await sessionLinks(db, reportId, j.source_ids))).hubs;
  const anchor = j.anchor ?? (j.is_root ? j.query : j.root_query) ?? null;
  return {
    session_id: j.id, status: j.status, created_at: new Date(j.created_at).toISOString(),
    needs, by_status: countByStatus(needs), gaps: gapsOf(j.gaps),
    topic_estimate: j.topic_estimate ?? null,
    anchor: anchor && anchor.trim() ? anchor : null,
    anchor_basis: j.anchor ? "the branch's anchor (its parent's question)" : j.is_root ? "the session's own question (a root has no other anchor)" : "the tree root's question",
    report_id: reportId,
    credibility: shapeRollup(j.credibility, reportId, j.id),
    hubs,
  };
}

// The signed-in subject's document at `path`, or null (404): documents/repo.ts ownedPath's rule - its
// listing row is the subject's, or (no row yet) it lies in the subject's own documents/<key>/ directory.
// Re-stated here, not imported: documents/repo.ts pulls config.ts (and the vault) into the contract's
// module graph, which reads DB_* at import time (integration_test.ts sets them before its legacy import).
export async function ownedDocument(db: Db, path: string, who: Viewer): Promise<string | null> {
  const rel = docRel(path, who as Parameters<typeof docRel>[1]);
  const row = (await db.query<{ owner_sub: string }>(
    `SELECT owner_sub FROM public.user_document_listings WHERE path = $1`, [rel],
  ))[0];
  if (row) return row.owner_sub === who.sub ? rel : null;
  return rel.startsWith(`${rootOf(who as Parameters<typeof rootOf>[0])}/`) ? rel : null;
}

// A user document's coverage (the signed-in subject's own document - ownedPath has already refused
// another user's): its hubs (the P2b hub context) and the subject's own sessions started from it or its
// refinery, each with its needs by status and its roll-up statement.
export async function documentCoverage(db: Db, rel: string, who: Viewer & { admin?: boolean; impersonating?: unknown }) {
  // the document's outbound links, from its listing record (as documents/refinery.ts linksOf reads them)
  const links = (await db.query<{ outbound_links: OutboundLink[] }>(
    `SELECT outbound_links FROM public.user_document_listings WHERE path = $1 AND owner_sub = $2`, [rel, who.sub],
  ))[0]?.outbound_links ?? [];
  const hub = await hubContext(db, rel, links);
  const rows = await db.query<JobRow>(
    `SELECT ${JOB_COLS("$2", "$3", adminSeesOwnerless(who))}
       FROM public.research_jobs j LEFT JOIN public.research_jobs r ON r.id = COALESCE(j.root_job_id, j.id)
       LEFT JOIN public.user_document_listings l ON l.path = $1
      WHERE (j.inlet_ref ->> 'kind' = 'document' AND j.inlet_ref ->> 'id' = $1)
         OR (l.refinery_id IS NOT NULL AND (j.refinery_id = l.refinery_id
              OR (j.inlet_ref ->> 'kind' = 'refinery' AND j.inlet_ref ->> 'id' = l.refinery_id::text)))
      ORDER BY j.created_at DESC
      LIMIT 50`,
    [rel, who.sub, who.key],
  );
  const sessions = rows.filter((j) => !j.others).map((j) => {
    const needs = needsOf(j.needs_status);
    const reportId = j.report_id && UUID.test(j.report_id) ? j.report_id.toLowerCase() : null;
    return {
      id: j.id, status: j.status, created_at: new Date(j.created_at).toISOString(), by_status: countByStatus(needs),
      credibility: shapeRollup(j.credibility, reportId, j.id).statement,
    };
  });
  return { path: rel, computed_at: hub.computed_at, hubs: hub.hubs, sessions };
}
