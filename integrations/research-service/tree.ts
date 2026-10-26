/**
 * tree.ts - research-workbench P4a (rw-p4a-trees): a research session is a TREE.
 *
 * An operator steer opens a branch rooted at the step it names while the main line keeps running;
 * branches inherit the anchor and the tree's current topic estimate; every steer is recorded with
 * what it was made against; the report is cumulative over the tree. Gap work (D15) and inter-hub
 * gaps (D1) open branches from inside the run, always scheduled below a pending human steer (D3).
 * Branches run in llm-queue's `research-branch` lane, whose concurrency is a share of the plane's
 * declared capacity (D16) - read back from the queue, never hand-set here.
 *
 * Storage: init-research-trees.sql (research_jobs tree columns, research_steers,
 * research_job_events). No topic or hub table: hubs are neighbourhoods computed from the claim
 * graph on demand (D1, emergent).
 *
 * Pure helpers (stage kinds, contract narrowing, gap split, neighbourhoods, tree report, learning
 * records) are unit-tested in tree.test.ts; the SQL paths run against a lab database in
 * trees.e2e.test.ts.
 */
import { ContractError, type ResearchContract, type ResolvedContract } from "./contract.ts";
import { claimFloor, classifyClaimKind, type CredibilityModel } from "./credibility.ts";
import type { TrailEntry } from "./admission.ts";

/** The minimal client surface (deno-postgres PoolClient fits; the harness's QueryClient too). */
export interface Q {
  queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[]; rowCount?: number }>;
}

// ── branch kinds and scheduling (D3) ────────────────────────────────────────────────────────
export type BranchKind = "root" | "steer" | "gap" | "interhub" | "idea";
export type SteerKind = "human" | "gap" | "interhub";
export const STEER_KIND_OF: Record<"steer" | "gap" | "interhub", SteerKind> = {
  steer: "human", gap: "gap", interhub: "interhub",
};
/** Branch kinds that run in llm-queue's research-branch lane (under its own virtual key). */
export const LANE_KINDS: ReadonlySet<string> = new Set(["steer", "gap", "interhub", "idea"]);
/** Kinds that may open gap work. A gap branch never opens more gap work (no runaway trees). */
export const GAP_OPENERS: ReadonlySet<string> = new Set(["root", "steer", "idea"]);

/**
 * Claim order (D3): a human steer's branch first, then main lines (a root, an idea's research),
 * then system gap work (per-claim gaps, inter-hub gaps). FIFO within a rank.
 */
export const BRANCH_RANK_SQL =
  `CASE branch_kind WHEN 'steer' THEN 0 WHEN 'gap' THEN 2 WHEN 'interhub' THEN 2 ELSE 1 END`;
export function branchRank(kind: string): number {
  return kind === "steer" ? 0 : kind === "gap" || kind === "interhub" ? 2 : 1;
}

// ── the event schema (AG-UI-shaped) ─────────────────────────────────────────────────────────
export type EventKind = "steering" | "due_process";
export type EventType =
  | "stage" | "source" | "human_steer" | "gap" | "interhub_gap" | "branch_open" | "branch_close" | "topic";

/**
 * Every stage the harness reports, with its marker. `steering` = the stage decides where the
 * research goes next (what to ask, what to deepen, which gaps to close); `due_process` = the stage
 * applies a fixed procedure (recall, screening, fetching, judging, filing). tree.test.ts fails when
 * the harness reports a phase this table does not name.
 */
export const STAGE_KINDS: Record<string, EventKind> = {
  plan: "steering", deepen: "steering", gap_pass: "steering",
  reuse: "due_process", seed: "due_process", screen: "due_process", fold: "due_process",
  gather: "due_process", synthesize: "due_process", entail: "due_process", persist: "due_process",
  // terminal / queue phases written by the service around the harness
  done: "due_process", error: "due_process", cancelled: "due_process", model_down: "due_process",
};
export function stageKind(phase: string): EventKind {
  return STAGE_KINDS[phase] ?? "due_process";
}

export interface TreeEvent {
  type: EventType;
  kind: EventKind;
  /** per-source events: the source's admission trail entry (required by the schema). */
  trail?: Record<string, unknown> | null;
  payload?: Record<string, unknown>;
}

export function stageEvent(phase: string, message: string, counters: Record<string, number> = {}): TreeEvent {
  return { type: "stage", kind: stageKind(phase), payload: { phase, message, counters } };
}
export function sourceEvent(entry: TrailEntry): TreeEvent {
  return {
    type: "source", kind: "due_process", trail: entry as unknown as Record<string, unknown>,
    payload: { url: entry.url, outcome: entry.kind },
  };
}

/** Append one event. A stage event gets the job's next step id (`s1`, `s2`, ...): a steer names one. */
export async function appendEvent(c: Q, jobId: string, rootId: string, ev: TreeEvent): Promise<{ id: string; step_id: string | null }> {
  const r = await c.queryObject<{ id: string; step_id: string | null }>(
    `INSERT INTO public.research_job_events (job_id, root_job_id, step_id, type, kind, trail, payload)
     SELECT $1::uuid, $2::uuid,
            CASE WHEN $3::text = 'stage'
                 THEN 's' || (SELECT count(*) + 1 FROM public.research_job_events e
                               WHERE e.job_id = $1::uuid AND e.type = 'stage') END,
            $3::text, $4::text, $5::jsonb, $6::jsonb
     RETURNING id::text, step_id`,
    [jobId, rootId, ev.type, ev.kind, ev.trail ? JSON.stringify(ev.trail) : null, JSON.stringify(ev.payload ?? {})],
  );
  return r.rows[0];
}

// ── contract inheritance (child <= parent) ──────────────────────────────────────────────────
type Rule = { kind: "host"; base: string } | { kind: "prefix"; host: string; segs: string[] };
function ruleOf(entry: string): Rule {
  const slash = entry.indexOf("/");
  if (slash === -1) return { kind: "host", base: entry.replace(/^\*\./, "") };
  return { kind: "prefix", host: entry.slice(0, slash), segs: entry.slice(slash + 1).split("/") };
}
const underHost = (h: string, base: string) => h === base || h.endsWith("." + base);
/** Is every url `inner` admits also admitted by `outer`? (canonical entries, contract.ts spelling) */
export function entryWithin(inner: string, outer: string): boolean {
  const i = ruleOf(inner), o = ruleOf(outer);
  if (o.kind === "host") return underHost(i.kind === "host" ? i.base : i.host, o.base);
  if (i.kind === "host") return false;
  return i.host === o.host && o.segs.length <= i.segs.length && o.segs.every((s, k) => i.segs[k] === s);
}

/**
 * The child's contract: built NEW from the parent's resolved contract, narrowed by what the steer
 * asks for. Budgets are clampCeiling'd against the parent's (a request can only lower one), deny
 * entries and red lines are the union, and a parent allow-list is kept or narrowed - a requested
 * allow entry the parent does not cover is a WIDENING and throws ContractError. Returns the raw
 * contract to store in the child's options (resolveContract re-validates it when the child runs),
 * or null when neither side constrains anything.
 */
export function narrowContract(parent: ResolvedContract | null, requested: unknown): ResearchContract | null {
  if (requested !== undefined && requested !== null && (typeof requested !== "object" || Array.isArray(requested))) {
    throw new ContractError("steer contract must be an object");
  }
  const req = (requested ?? {}) as ResearchContract;
  const reqSources = req.sources ?? {};
  const reqAllow = [...(reqSources.allow ?? [])];
  if (reqSources.classes?.length) throw new ContractError("a steer narrows by allow/deny entries, not classes");
  const reqDeny = reqSources.deny ?? [];
  const reqBudget = req.budget ?? {};
  const reqRed = req.redlines ?? [];
  const pAllow = parent?.allowDomains ?? [];
  const pBudget = parent?.budget ?? {};

  let allow: string[];
  if (reqAllow.length === 0) allow = [...pAllow];
  else if (pAllow.length === 0) allow = reqAllow;
  else {
    for (const e of reqAllow) {
      const canon = e.trim().toLowerCase();
      if (!pAllow.some((p) => entryWithin(canon, p))) {
        throw new ContractError(`steer contract widens the parent's: allow entry ${JSON.stringify(e)} is outside the parent's allow-list`);
      }
    }
    allow = reqAllow;
  }
  const lower = (p: number | undefined, r: number | undefined, name: string): number | undefined => {
    if (r !== undefined && (typeof r !== "number" || !Number.isInteger(r) || r <= 0)) {
      throw new ContractError(`steer contract budget.${name} must be a positive integer`);
    }
    if (p === undefined) return r;
    return Math.min(p, r ?? Infinity);
  };
  const budget: NonNullable<ResearchContract["budget"]> = {};
  const mf = lower(pBudget.maxFetch, reqBudget.max_fetch, "max_fetch");
  const wm = lower(pBudget.wallMs, reqBudget.wall_ms, "wall_ms");
  const rd = lower(pBudget.rounds, reqBudget.rounds, "rounds");
  if (mf !== undefined) budget.max_fetch = mf;
  if (wm !== undefined) budget.wall_ms = wm;
  if (rd !== undefined) budget.rounds = rd;
  const deny = [...new Set([...(parent?.denyDomains ?? []), ...reqDeny])];
  const redlines = [...new Set([...(parent?.redlines ?? []), ...reqRed])];
  if (!allow.length && !deny.length && !Object.keys(budget).length && !redlines.length) return null;
  const out: ResearchContract = {};
  if (allow.length || deny.length) out.sources = { ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}) };
  if (Object.keys(budget).length) out.budget = budget;
  if (redlines.length) out.redlines = redlines;
  return out;
}

/** What a branch inherits from its parent's options: the run shape, never the parent's inlet. */
export function inheritOptions(parent: Record<string, unknown>, contract: ResearchContract | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const keep = ["mode", "disable_web_search", "sources_only", "gap_research", "dry_run", "seed_sources",
                "confidence_floor", "deadline_at", "depth", "freshness"];
  const o: Record<string, unknown> = {};
  for (const k of keep) if (parent[k] !== undefined) o[k] = parent[k];
  if (contract) o.contract = contract;
  return { ...o, ...extra };
}

// ── steers ──────────────────────────────────────────────────────────────────────────────────
export class SteerError extends Error {
  constructor(readonly status: number, readonly code: string, msg: string) { super(msg); this.name = "SteerError"; }
}

interface JobRow {
  id: string; status: string; query: string; options: Record<string, unknown> | null; thread_id: string | null;
  origin: string; root_job_id: string | null; branch_kind: string; anchor: string | null; topic_estimate: string | null;
}
const JOB_COLS = `id::text, status, query, options, thread_id::text, origin, root_job_id::text, branch_kind, anchor, topic_estimate`;

export interface BranchOpened {
  child_job_id: string; steer_id: string; root_job_id: string; parent_job_id: string; step_id: string;
  steer_kind: SteerKind; topic_estimate: string; anchor: string;
}

/** The tree's current topic estimate: the root's, or (before any re-estimate) the origin prompt. */
export async function treeEstimate(c: Q, rootId: string): Promise<{ estimate: string; origin: string }> {
  const r = await c.queryObject<{ query: string; topic_estimate: string | null }>(
    `SELECT query, topic_estimate FROM public.research_jobs WHERE id = $1::uuid`, [rootId]);
  const row = r.rows[0];
  if (!row) throw new SteerError(404, "no_root", `tree root ${rootId} not found`);
  return { estimate: (row.topic_estimate ?? "").trim() || row.query, origin: row.query };
}

async function insertBranch(
  c: Q, parent: JobRow, o: {
    kind: "steer" | "gap" | "interhub"; text: string; query: string; stepId: string; contract: ResearchContract | null;
    gapRef?: string | null; gap?: Record<string, unknown> | null; caller?: string | null; context?: unknown;
  },
): Promise<BranchOpened | null> {
  const rootId = parent.root_job_id ?? parent.id;
  const { estimate } = await treeEstimate(c, rootId);
  const anchor = parent.query; // the child's anchor IS the parent's research_jobs.query (never a fresh one)
  const options = inheritOptions(parent.options ?? {}, o.contract, { lane: "research-branch" });
  const ins = await c.queryObject<{ id: string }>(
    `INSERT INTO public.research_jobs
       (status, origin, query, thread_id, options, parent_job_id, root_job_id, rooted_step_id, branch_kind, anchor, gap_ref)
     VALUES ('queued', $1, $2, $3::uuid, $4::jsonb, $5::uuid, $6::uuid, $7, $8, $9, $10)
     ON CONFLICT (root_job_id, gap_ref) WHERE gap_ref IS NOT NULL DO NOTHING
     RETURNING id::text`,
    [parent.origin, o.query, parent.thread_id, JSON.stringify(options), parent.id, rootId, o.stepId, o.kind, anchor, o.gapRef ?? null],
  );
  if (!ins.rows.length) return null; // this gap already has its branch in this tree
  const childId = ins.rows[0].id;
  const steerKind = STEER_KIND_OF[o.kind];
  const st = await c.queryObject<{ id: string }>(
    `INSERT INTO public.research_steers
       (root_job_id, parent_job_id, child_job_id, steer_kind, step_id, text, topic_estimate, anchor, gap, caller, context_snapshot)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb)
     RETURNING id::text`,
    [rootId, parent.id, childId, steerKind, o.stepId, o.text, estimate, anchor,
     o.gap ? JSON.stringify(o.gap) : null, o.caller ?? null, o.context === undefined ? null : JSON.stringify(o.context)],
  );
  const steerId = st.rows[0].id;
  if (o.kind === "steer") {
    // The session record shows where the operator steered: a human_steer event on the parent at the step.
    await appendEvent(c, parent.id, rootId, {
      type: "human_steer", kind: "steering",
      payload: { steer_id: steerId, child_job_id: childId, step_id: o.stepId, text: o.text, topic_estimate: estimate, anchor },
    });
  }
  await appendEvent(c, childId, rootId, {
    type: "branch_open", kind: "steering",
    payload: { steer_id: steerId, steer_kind: steerKind, parent_job_id: parent.id, step_id: o.stepId, topic_estimate: estimate, anchor },
  });
  return { child_job_id: childId, steer_id: steerId, root_job_id: rootId, parent_job_id: parent.id, step_id: o.stepId, steer_kind: steerKind, topic_estimate: estimate, anchor };
}

/** States a steer may branch from. A cancelled or failed line is not steered (re-run it instead). */
export const STEERABLE = new Set(["queued", "running", "done"]);

/**
 * An operator steer on a job: one transaction creates the child (queued in the branch lane,
 * parent_job_id + rooted_step_id), the steer record (with the estimate and anchor it was made
 * against) and the events. The parent row is read FOR UPDATE and never written: its status does
 * not change.
 */
export async function createSteer(
  c: Q, req: { parentId: string; stepId: string; text: string; contract?: unknown; caller?: string | null; contextSnapshot?: unknown },
  resolve: (options: Record<string, unknown> | null) => ResolvedContract | null,
): Promise<BranchOpened> {
  const text = (req.text ?? "").trim();
  if (!text) throw new SteerError(400, "bad_request", "steer text is required");
  if (!req.stepId?.trim()) throw new SteerError(400, "bad_request", "step_id is required");
  await c.queryObject("BEGIN");
  try {
    const p = await c.queryObject<JobRow>(`SELECT ${JOB_COLS} FROM public.research_jobs WHERE id = $1::uuid FOR UPDATE`, [req.parentId]);
    const parent = p.rows[0];
    if (!parent) throw new SteerError(404, "not_found", "job not found");
    if (!STEERABLE.has(parent.status)) throw new SteerError(409, "not_steerable", `a ${parent.status} job is not steered`);
    const s = await c.queryObject<{ step_id: string }>(
      `SELECT step_id FROM public.research_job_events WHERE job_id = $1::uuid AND step_id = $2`, [req.parentId, req.stepId.trim()]);
    if (!s.rows.length) throw new SteerError(400, "unknown_step", `job ${req.parentId} has no step ${JSON.stringify(req.stepId)}`);
    let contract: ResearchContract | null;
    try { contract = narrowContract(resolve(parent.options), req.contract); }
    catch (e) { if (e instanceof ContractError) throw new SteerError(400, "contract", e.message); throw e; }
    const opened = await insertBranch(c, parent, {
      kind: "steer", text, query: text, stepId: req.stepId.trim(), contract, caller: req.caller ?? null, context: req.contextSnapshot,
    });
    await c.queryObject("COMMIT");
    return opened!;
  } catch (e) {
    await c.queryObject("ROLLBACK").catch(() => {});
    throw e;
  }
}

// ── gap work (D15) ──────────────────────────────────────────────────────────────────────────
export interface GapClaim { claim_id: string; text: string; score: number; threshold: number; claim_kind: string }
/**
 * Split recalled claims at their kind's confidence threshold (the D15 claim floor). A claim held
 * below it is gap work (its own event, a gap branch); a claim at or above it is left alone.
 */
export function splitAtThreshold(m: CredibilityModel, claims: Array<{ id: string; text: string; confidence: number }>):
  { below: GapClaim[]; above: string[] } {
  const below: GapClaim[] = [], above: string[] = [];
  for (const c of claims) {
    const kind = classifyClaimKind(m, c.text).kind;
    const threshold = claimFloor(m, kind);
    if (Number(c.confidence) < threshold) {
      below.push({ claim_id: c.id, text: c.text, score: Number(c.confidence), threshold, claim_kind: kind });
    } else above.push(c.id);
  }
  return { below, above };
}
export function gapEvent(g: GapClaim): TreeEvent {
  return { type: "gap", kind: "steering", payload: { ...g } };
}

// ── inter-hub gaps (D1): neighbourhoods by link density, no topic table ──────────────────────
export interface GraphNode { id: string; text: string }
export interface GraphEdge { a: string; b: string; w: number }
/** Label propagation (deterministic: nodes in id order, ties to the smallest label). */
export function neighbourhoods(nodes: GraphNode[], edges: GraphEdge[], maxIter = 30): Map<string, string> {
  const ids = nodes.map((n) => n.id).sort();
  const adj = new Map<string, Map<string, number>>();
  for (const id of ids) adj.set(id, new Map());
  for (const e of edges) {
    if (!adj.has(e.a) || !adj.has(e.b) || e.a === e.b) continue;
    adj.get(e.a)!.set(e.b, (adj.get(e.a)!.get(e.b) ?? 0) + e.w);
    adj.get(e.b)!.set(e.a, (adj.get(e.b)!.get(e.a) ?? 0) + e.w);
  }
  const label = new Map(ids.map((id) => [id, id]));
  for (let it = 0; it < maxIter; it++) {
    let changed = false;
    for (const id of ids) {
      const score = new Map<string, number>();
      // a node's own label counts once at weight 1 (it is part of its own neighbourhood)
      score.set(label.get(id)!, 1);
      for (const [nb, w] of adj.get(id)!) score.set(label.get(nb)!, (score.get(label.get(nb)!) ?? 0) + w);
      let best = label.get(id)!, bestW = -1;
      for (const [l, w] of [...score.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) if (w > bestW) { best = l; bestW = w; }
      if (best !== label.get(id)) { label.set(id, best); changed = true; }
    }
    if (!changed) break;
  }
  return label;
}

export interface Hub { label: string; members: string[]; sample: string }
export interface InterHubGap { a: Hub; b: Hub; density: number; links: number }
/**
 * Pairs of neighbourhoods whose connection is thin (link density below `thinBelow`, 0 included):
 * density = distinct cross links / (|A| x |B|). Neighbourhoods smaller than `minSize` are not hubs.
 */
export function interHubGaps(nodes: GraphNode[], edges: GraphEdge[], o: { thinBelow?: number; minSize?: number } = {}): InterHubGap[] {
  const thin = o.thinBelow ?? 0.2, minSize = o.minSize ?? 2;
  const lab = neighbourhoods(nodes, edges);
  const text = new Map(nodes.map((n) => [n.id, n.text]));
  const groups = new Map<string, string[]>();
  for (const [id, l] of lab) groups.set(l, [...(groups.get(l) ?? []), id]);
  const hubs: Hub[] = [...groups.entries()].filter(([, m]) => m.length >= minSize)
    .map(([l, m]) => ({ label: l, members: m.sort(), sample: text.get(m.sort()[0]) ?? "" }))
    .sort((x, y) => (x.label < y.label ? -1 : 1));
  const pairs = new Set(edges.map((e) => (e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`)));
  const out: InterHubGap[] = [];
  for (let i = 0; i < hubs.length; i++) {
    for (let j = i + 1; j < hubs.length; j++) {
      let links = 0;
      for (const x of hubs[i].members) for (const y of hubs[j].members) if (pairs.has(x < y ? `${x}|${y}` : `${y}|${x}`)) links++;
      const density = links / (hubs[i].members.length * hubs[j].members.length);
      if (density < thin) out.push({ a: hubs[i], b: hubs[j], density: Math.round(density * 1000) / 1000, links });
    }
  }
  return out;
}
export function interHubEvent(g: InterHubGap): TreeEvent {
  return {
    type: "interhub_gap", kind: "steering",
    payload: { a: { label: g.a.label, members: g.a.members, sample: g.a.sample },
               b: { label: g.b.label, members: g.b.members, sample: g.b.sample }, density: g.density, links: g.links },
  };
}
export const interHubRef = (g: InterHubGap) => `interhub:${[g.a.label, g.b.label].sort().join("|")}`;

/** The claim graph around a run: its claims and their co-cited neighbours, linked by shared live sources. */
export async function loadClaimGraph(c: Q, claimIds: string[], citedUrls: string[], limit = 300): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  if (!claimIds.length && !citedUrls.length) return { nodes: [], edges: [] };
  const n = await c.queryObject<{ id: string; text: string }>(
    `WITH seed AS (
       SELECT unnest($1::uuid[]) AS id
       UNION SELECT cs.claim_id FROM public.claim_sources cs JOIN public.sources s ON s.id = cs.source_id
              WHERE s.url = ANY($2::text[]) AND s.retraction_committed_at IS NULL),
     srcs AS (SELECT DISTINCT cs.source_id FROM public.claim_sources cs JOIN seed ON seed.id = cs.claim_id
              JOIN public.sources s ON s.id = cs.source_id WHERE s.retraction_committed_at IS NULL),
     ids AS (SELECT id FROM seed UNION SELECT cs.claim_id FROM public.claim_sources cs JOIN srcs USING (source_id))
     SELECT c.id::text, c.text FROM public.claims c JOIN ids USING (id) WHERE c.status = 'active' ORDER BY c.id LIMIT $3`,
    [claimIds, citedUrls, limit],
  );
  const ids = n.rows.map((r) => r.id);
  if (!ids.length) return { nodes: [], edges: [] };
  const e = await c.queryObject<{ a: string; b: string; w: number }>(
    `SELECT a.claim_id::text AS a, b.claim_id::text AS b, count(*)::int AS w
       FROM public.claim_sources a JOIN public.claim_sources b ON a.source_id = b.source_id AND a.claim_id < b.claim_id
       JOIN public.sources s ON s.id = a.source_id
      WHERE a.claim_id = ANY($1::uuid[]) AND b.claim_id = ANY($1::uuid[]) AND s.retraction_committed_at IS NULL
      GROUP BY 1, 2`,
    [ids],
  );
  return { nodes: n.rows, edges: e.rows.map((r) => ({ a: r.a, b: r.b, w: Number(r.w) })) };
}

/**
 * Open system gap branches (per-claim gaps and inter-hub gaps) from a finished job: deduplicated
 * per tree (gap_ref), capped per tree, never from a gap branch. They queue at rank 2, so a pending
 * human steer always starts first.
 */
export async function openGapBranches(
  c: Q, parentId: string, stepId: string,
  gaps: Array<{ kind: "gap" | "interhub"; text: string; query: string; ref: string; gap: Record<string, unknown> }>,
  maxPerTree: number,
  resolve: (options: Record<string, unknown> | null) => ResolvedContract | null,
): Promise<BranchOpened[]> {
  const p = await c.queryObject<JobRow>(`SELECT ${JOB_COLS} FROM public.research_jobs WHERE id = $1::uuid`, [parentId]);
  const parent = p.rows[0];
  if (!parent || !GAP_OPENERS.has(parent.branch_kind)) return [];
  const rootId = parent.root_job_id ?? parent.id;
  const out: BranchOpened[] = [];
  for (const g of gaps) {
    const n = await c.queryObject<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.research_jobs WHERE root_job_id = $1::uuid AND branch_kind IN ('gap','interhub')`, [rootId]);
    if (Number(n.rows[0]?.n ?? 0) >= maxPerTree) break;
    const contract = narrowContract(resolve(parent.options), undefined); // a gap branch keeps the parent's contract
    const opened = await insertBranch(c, parent, { kind: g.kind, text: g.text, query: g.query, stepId, contract, gapRef: g.ref, gap: g.gap });
    if (opened) out.push(opened);
  }
  return out;
}

// ── the tree, its report and its learning records ───────────────────────────────────────────
export interface TreeNode {
  id: string; parent_job_id: string | null; branch_kind: string; query: string; anchor: string | null;
  rooted_step_id: string | null; status: string; result: Record<string, unknown> | null; metrics: Record<string, unknown> | null;
  created_at: string; finished_at: string | null;
}
export interface SteerRow {
  id: string; parent_job_id: string; child_job_id: string; steer_kind: SteerKind; step_id: string; text: string;
  topic_estimate: string; anchor: string; gap: Record<string, unknown> | null; created_at: string;
}
export interface Tree { root: TreeNode; nodes: TreeNode[]; steers: SteerRow[]; estimate: string }

export async function loadTree(c: Q, jobId: string): Promise<Tree | null> {
  const r = await c.queryObject<{ root: string }>(
    `SELECT coalesce(root_job_id, id)::text AS root FROM public.research_jobs WHERE id = $1::uuid`, [jobId]);
  const rootId = r.rows[0]?.root;
  if (!rootId) return null;
  const nodes = (await c.queryObject<TreeNode>(
    `SELECT id::text, parent_job_id::text, branch_kind, query, anchor, rooted_step_id, status, result, metrics,
            created_at::text, finished_at::text
       FROM public.research_jobs WHERE id = $1::uuid OR root_job_id = $1::uuid ORDER BY created_at, id`, [rootId])).rows;
  const steers = (await c.queryObject<SteerRow>(
    `SELECT id::text, parent_job_id::text, child_job_id::text, steer_kind, step_id, text, topic_estimate, anchor, gap, created_at::text
       FROM public.research_steers WHERE root_job_id = $1::uuid ORDER BY created_at, id`, [rootId])).rows;
  const root = nodes.find((n) => n.id === rootId)!;
  const { estimate } = await treeEstimate(c, rootId);
  return { root, nodes, steers, estimate };
}

const CLOSED = new Set(["done", "error", "cancelled"]);
const firstPara = (s: string) => {
  const t = String(s ?? "").replace(/^#+\s.*$/gm, "").trim();
  return ((t.split(/\n\s*\n/)[0] ?? t).replace(/\s+/g, " ").trim()).slice(0, 600);
};
function coverage(result: Record<string, unknown> | null): { answered: number; of: number } {
  const ns = Array.isArray(result?.needs_status) ? result!.needs_status as Array<{ status?: string }> : [];
  return { answered: ns.filter((n) => n.status === "answered").length, of: ns.length };
}
function credibility(metrics: Record<string, unknown> | null): { value: number | null; claims: number } {
  const c = (metrics?.credibility ?? null) as { value?: number | null; claims?: number } | null;
  return { value: c?.value ?? null, claims: Number(c?.claims ?? 0) };
}
const gapsOf = (result: Record<string, unknown> | null) => (Array.isArray(result?.gaps) ? (result!.gaps as unknown[]).map(String) : []);

export interface TreeReport {
  heading: string; origin: string; topic_estimate: string;
  branches: Array<{
    job_id: string; branch_kind: string; opened_by: string | null; steer_kind: SteerKind | null; rooted_step_id: string | null;
    status: string; summary: string; credibility: { value: number | null; claims: number }; coverage: { answered: number; of: number }; gaps: string[];
  }>;
  markdown: string;
}
/**
 * The cumulative report over the parent and every CLOSED child, organised around the tree's topic
 * estimate (the heading) with the original prompt shown as the origin - never headed by the prompt.
 */
export function buildTreeReport(t: Tree): TreeReport {
  const steerOf = new Map(t.steers.map((s) => [s.child_job_id, s]));
  const covered = t.nodes.filter((n) => n.id === t.root.id || CLOSED.has(n.status));
  const branches = covered.map((n) => {
    const s = steerOf.get(n.id) ?? null;
    return {
      job_id: n.id, branch_kind: n.branch_kind, opened_by: s?.text ?? null, steer_kind: s?.steer_kind ?? null,
      rooted_step_id: n.rooted_step_id, status: n.status,
      summary: firstPara(String((n.result?.synthesis as string) ?? "")) || (n.status === "done" ? "nothing citable was found" : `(${n.status})`),
      credibility: credibility(n.metrics), coverage: coverage(n.result), gaps: gapsOf(n.result),
    };
  });
  const lines: string[] = [`# ${t.estimate}`, "", `_Origin: ${t.root.query}_`, ""];
  for (const b of branches) {
    const title = b.job_id === t.root.id ? "Main line" : `Branch (${b.steer_kind === "human" ? "operator steer" : b.steer_kind + " gap"}): ${b.opened_by}`;
    lines.push(`## ${title}`, "", b.summary, "");
    const cred = b.credibility.value === null ? "no filed claims" : `${b.credibility.value} over ${b.credibility.claims} claim(s)`;
    lines.push(`- credibility: ${cred}; coverage: ${b.coverage.answered} of ${b.coverage.of} need(s) answered`);
    if (b.gaps.length) lines.push(`- remaining gaps: ${b.gaps.join("; ")}`);
    lines.push("");
  }
  return { heading: t.estimate, origin: t.root.query, topic_estimate: t.estimate, branches, markdown: lines.join("\n").trim() + "\n" };
}

/** The exploratory learning record (06-EXPANSION §3.3, learning-record.schema.json v1), per branch - derived, nothing authored. */
export interface ExploratoryRecord {
  schema_version: 1; fidelity: "exploratory"; producer: "job-tree";
  source_ref: { session_id: string; branch_id: string };
  domains: string[]; steer: string; red: string;
  outcome: { kind: "found" | "gap-remains"; summary: string; evidence: string[] };
  deviation: string; created_at: string;
}
export function learningRecords(t: Tree): ExploratoryRecord[] {
  const steerOf = new Map(t.steers.map((s) => [s.child_job_id, s]));
  return t.nodes.map((n) => {
    const opened = steerOf.get(n.id);
    const gaps = gapsOf(n.result);
    const answeredBy = t.steers.filter((s) => s.parent_job_id === n.id);
    const cred = credibility(n.metrics), cov = coverage(n.result);
    const summary = firstPara(String((n.result?.synthesis as string) ?? "")) || (n.status === "done" ? "nothing citable was found" : `branch ${n.status}`);
    const deviation = answeredBy.length
      ? answeredBy.map((s) => `${s.steer_kind === "human" ? "a human steer" : `a ${s.steer_kind} gap steer`} answered it at ${s.step_id} (branch ${s.child_job_id})`).join("; ")
      : "no steer answered it";
    return {
      schema_version: 1, fidelity: "exploratory", producer: "job-tree",
      source_ref: { session_id: t.root.id, branch_id: n.id },
      domains: [t.estimate],
      steer: opened ? `${opened.steer_kind === "human" ? "human steer" : `${opened.steer_kind} gap steer`} at ${opened.step_id}: ${opened.text}` : `question: ${n.query}`,
      red: gaps.length ? gaps.join("; ") : "no gap remained",
      outcome: {
        kind: gaps.length ? "gap-remains" : "found", summary,
        evidence: [`credibility ${cred.value === null ? "none" : cred.value} over ${cred.claims} claim(s)`, `coverage ${cov.answered}/${cov.of}`, `job ${n.id} ${n.status}`],
      },
      deviation,
      created_at: new Date(n.finished_at ?? n.created_at).toISOString(),
    };
  });
}

/**
 * Re-estimate the tree's topic at a branch closer: one JSON chat over the origin, the steers and
 * what each closed branch found. A failed or empty answer keeps the previous estimate.
 */
export async function reestimateTopic(t: Tree, chat: (sys: string, user: string) => Promise<string>): Promise<string> {
  const sys = "You name the CURRENT TOPIC of a research tree: where the research has drifted to, given its origin " +
    "question, the steers it took and what each branch found. Answer JSON {\"topic\": \"<under 15 words>\"}.";
  const r = buildTreeReport(t);
  const user = [`ORIGIN: ${t.root.query}`, `PREVIOUS TOPIC: ${t.estimate}`,
    ...t.steers.map((s) => `STEER (${s.steer_kind}): ${s.text}`),
    ...r.branches.map((b) => `FOUND (${b.opened_by ?? "main line"}): ${b.summary}`)].join("\n").slice(0, 6000);
  try {
    const raw = await chat(sys, user);
    const j = JSON.parse(raw) as { topic?: unknown };
    const topic = typeof j?.topic === "string" ? j.topic.replace(/\s+/g, " ").trim() : "";
    return topic && topic.length <= 200 ? topic : t.estimate;
  } catch { return t.estimate; }
}

/** A branch closed: re-estimate the topic, store it and the cumulative report on the root, log both. */
export async function closeBranch(c: Q, jobId: string, chat: (sys: string, user: string) => Promise<string>): Promise<TreeReport | null> {
  const t = await loadTree(c, jobId);
  if (!t) return null;
  const topic = await reestimateTopic(t, chat);
  const t2: Tree = { ...t, estimate: topic };
  const report = buildTreeReport(t2);
  await c.queryObject(`UPDATE public.research_jobs SET topic_estimate = $2, tree_report = $3::jsonb WHERE id = $1::uuid`,
    [t.root.id, topic, JSON.stringify(report)]);
  if (topic !== t.estimate) {
    await appendEvent(c, t.root.id, t.root.id, { type: "topic", kind: "steering", payload: { from: t.estimate, to: topic, at_branch: jobId } });
  }
  if (jobId !== t.root.id) {
    await appendEvent(c, jobId, t.root.id, { type: "branch_close", kind: "due_process", payload: { topic_estimate: topic } });
  }
  return report;
}

// ── the research-branch lane's derived concurrency (D16) ───────────────────────────────────
export const LANE_FLOOR = 2;
/**
 * Read the lane's derived concurrency back from llm-queue (GET /observe/queue/estimate through the
 * gateway's read-only pass-through). Unreadable (no answer, no number, below the floor) = the floor
 * with a logged warning. There is no local, hand-set cap.
 */
export async function readLaneConcurrency(
  url: string, apiKey: string, log: (line: string) => void, fetchFn: typeof fetch = fetch, timeoutMs = 5000,
): Promise<number> {
  try {
    const u = new URL(url);
    u.searchParams.set("key", "research-branch");
    const r = await fetchFn(u, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) { await r.body?.cancel(); log(`[lane] WARNING research-branch capacity unreadable (HTTP ${r.status}); running at the floor ${LANE_FLOOR}`); return LANE_FLOOR; }
    const j = await r.json() as { max_concurrency?: unknown; capacity_declared?: unknown };
    const n = Number(j?.max_concurrency);
    if (!Number.isInteger(n) || n < LANE_FLOOR) {
      log(`[lane] WARNING research-branch capacity unreadable (max_concurrency=${JSON.stringify(j?.max_concurrency)}); running at the floor ${LANE_FLOOR}`);
      return LANE_FLOOR;
    }
    if (j?.capacity_declared === false) log(`[lane] WARNING llm-queue reports LLM_QUEUE_SLOTS undeclared; the lane runs at ${n}`);
    return n;
  } catch (e) {
    log(`[lane] WARNING research-branch capacity unreadable (${(e as Error).message}); running at the floor ${LANE_FLOOR}`);
    return LANE_FLOOR;
  }
}
