// What the Research screen reads and writes (rwr-research-runs). Every call goes through lib/api.ts (same-origin /workbench/*
// only), for the signed-in subject the server resolves: this code names no person, and nothing is kept in the browser (no
// storage, no cache, no module state): a run's question is its owner's text. A 200 that is not the route's shape is a FAILED
// read, never an empty list.
import { api, apiStream, ApiError } from "../../lib/api";

export type Group = "running" | "queued" | "done" | "stopped";
export type RunRow = {
  id: string; question: string; topic: string | null; document: string | null; status: string; group: Group; branches: number;
  created_at: string; finished_at: string | null; archived: boolean; archived_at: string | null;
};
export type Counts = { running: number; queued: number; done: number; stopped: number; archived: number; total: number };
export type NodeSource = { url: string; title: string | null; stages: string[] };
export type NodeClaim = { id: string; text: string };
export type RunNode = {
  id: string; parent_job_id: string | null; branch_kind: string; status: string; open: boolean; pending: boolean;
  query: string; created_at: string; sources: NodeSource[]; claims: NodeClaim[]; has_report: boolean;
};
export type RunDetail = { run: RunRow; can_act: boolean; running: boolean; next_steering_point: { step_id: string | null; phase: string } | null; nodes: RunNode[] };

const BASE = "/workbench/contract/research/runs";
const GROUPS: Group[] = ["running", "queued", "done", "stopped"];
const str = (v: unknown, what: string): string => { if (typeof v !== "string") throw new Error("unexpected answer: " + what); return v; };
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown, what: string): number => { if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error("unexpected answer: " + what); return v; };

function rowOf(r: any): RunRow {
  if (!r || typeof r !== "object" || !GROUPS.includes(r.group)) throw new Error("unexpected answer: run");
  return {
    id: str(r.id, "id"), question: typeof r.question === "string" ? r.question : "", topic: strOrNull(r.topic), document: strOrNull(r.document),
    status: String(r.status ?? ""), group: r.group, branches: int(r.branches, "branches"), created_at: String(r.created_at ?? ""),
    finished_at: strOrNull(r.finished_at), archived: r.archived === true, archived_at: strOrNull(r.archived_at),
  };
}

// the caller's runs (every state group and the archived ones: the screen filters and groups them) and the server's counts
export async function readRuns(): Promise<{ runs: RunRow[]; counts: Counts }> {
  const { data } = await api("GET", BASE + "?view=all&limit=1000");
  if (!data || !Array.isArray(data.runs) || !data.counts || typeof data.counts !== "object") throw new Error("unexpected answer: no runs");
  const c = data.counts;
  return {
    runs: data.runs.map(rowOf),
    counts: { running: int(c.running, "running"), queued: int(c.queued, "queued"), done: int(c.done, "done"), stopped: int(c.stopped, "stopped"), archived: int(c.archived, "archived"), total: int(c.total, "total") },
  };
}

function nodeOf(n: any): RunNode {
  if (!n || typeof n !== "object" || typeof n.id !== "string") throw new Error("unexpected answer: node");
  return {
    id: n.id, parent_job_id: strOrNull(n.parent_job_id), branch_kind: String(n.branch_kind ?? ""), status: String(n.status ?? ""), open: n.open === true,
    pending: n.pending === true, query: typeof n.query === "string" ? n.query : "", created_at: String(n.created_at ?? ""),
    sources: (Array.isArray(n.sources) ? n.sources : []).map((s: any) => ({ url: String(s?.url ?? ""), title: strOrNull(s?.title), stages: Array.isArray(s?.stages) ? s.stages.map(String) : [] })),
    claims: (Array.isArray(n.claims) ? n.claims : []).map((c: any) => ({ id: String(c?.id ?? ""), text: String(c?.text ?? "") })),
    has_report: n.has_report === true,
  };
}

/** One run. null = not available: the caller's no-such-run answer (missing and another person's are the same 404). */
export async function readRun(id: string): Promise<RunDetail | null> {
  try {
    const { data } = await api("GET", `${BASE}/${encodeURIComponent(id)}`);
    if (!data || typeof data !== "object" || !Array.isArray(data.nodes)) throw new Error("unexpected answer: run");
    const sp = data.next_steering_point;
    return {
      run: rowOf(data.run), can_act: data.can_act === true, running: data.running === true,
      next_steering_point: sp && typeof sp === "object" ? { step_id: strOrNull(sp.step_id), phase: String(sp.phase ?? "") } : null,
      nodes: data.nodes.map(nodeOf),
    };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export type Outcome = { ok: true } | { ok: false; kind: "gone" | "conflict" | "bad" | "unavailable" | "failed" };
async function post(url: string, body?: unknown): Promise<{ out: Outcome; data: any }> {
  try {
    const { data } = await api("POST", url, body);
    return { out: { ok: true }, data };
  } catch (e) {
    if (e instanceof ApiError) {
      const kind = e.status === 404 ? "gone" : e.status === 409 ? "conflict" : e.status === 400 ? "bad" : e.status === 503 ? "unavailable" : "failed";
      return { out: { ok: false, kind }, data: null };
    }
    return { out: { ok: false, kind: "failed" }, data: null };
  }
}
export const archiveRun = async (id: string) => (await post(`${BASE}/${encodeURIComponent(id)}/archive`)).out;
export const unarchiveRun = async (id: string) => (await post(`${BASE}/${encodeURIComponent(id)}/unarchive`)).out;
export const cancelRun = async (id: string) => (await post(`/workbench/contract/sessions/${encodeURIComponent(id)}/cancel`, {})).out;
// steer and "add a follow-up" are ONE route: a branch rooted at the run's next steering point, with the person's words
export const steerRun = async (id: string, stepId: string, text: string) => (await post(`/workbench/contract/sessions/${encodeURIComponent(id)}/steer`, { step_id: stepId, text })).out;
export async function reportAsDocument(id: string): Promise<Outcome & { path?: string }> {
  const { out, data } = await post(`${BASE}/${encodeURIComponent(id)}/document`);
  if (!out.ok) return out;
  if (!data || typeof data.path !== "string") return { ok: false, kind: "failed" };
  return { ok: true, path: data.path };
}
export const documentHref = (path: string) => "/documents/" + encodeURIComponent(path);

/** The live stream of one run: calls onEvent for every event; resolves when it ends (the HTTP status, 0 = no connection). */
export const streamRun = (id: string, onEvent: (name: string) => void, signal: AbortSignal) =>
  apiStream(`/workbench/contract/sessions/${encodeURIComponent(id)}/stream`, (name) => onEvent(name), signal);

// ── grouping (pure) ────────────────────────────────────────────────────────────────────────
export type GroupBy = "date" | "document" | "topic";
export type RunGroupView = { key: string; header: string; runs: RunRow[] };
const DAY = 24 * 3600 * 1000;
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function dateBucket(iso: string, now = Date.now()): { key: string; header: string; order: number } {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return { key: "earlier", header: "Earlier", order: 3 };
  const today = startOfDay(now);
  if (t >= today) return { key: "today", header: "Today", order: 0 };
  if (t >= today - DAY) return { key: "yesterday", header: "Yesterday", order: 1 };
  if (t >= today - 6 * DAY) return { key: "week", header: "Earlier this week", order: 2 };
  return { key: "earlier", header: "Earlier", order: 3 };
}
// a document's path as a name: its file name, without the extension and the dashes of a slug
export const documentName = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() || path;

export function groupRuns(runs: RunRow[], by: GroupBy, now = Date.now()): RunGroupView[] {
  const map = new Map<string, { header: string; order: number; runs: RunRow[] }>();
  for (const r of runs) {
    let key: string, header: string, order = 0;
    if (by === "date") { const b = dateBucket(r.created_at, now); key = b.key; header = b.header; order = b.order; }
    else if (by === "document") { key = r.document ?? ""; header = r.document ? documentName(r.document) : "Not attached to a document"; order = r.document ? 0 : 1; }
    else { key = r.topic ?? ""; header = r.topic ?? "No topic"; order = r.topic ? 0 : 1; }
    const g = map.get(key) ?? { header, order, runs: [] };
    g.runs.push(r);
    map.set(key, g);
  }
  return [...map.entries()].sort((a, b) => a[1].order - b[1].order || a[1].header.localeCompare(b[1].header))
    .map(([key, g]) => ({ key, header: g.header, runs: g.runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)) }));
}

export const GROUP_LABEL: Record<Group | "archived", string> = { running: "Running", queued: "Queued", done: "Finished", stopped: "Stopped", archived: "Archived" };
export const KIND_LABEL: Record<string, string> = { root: "Question", steer: "Steer or follow-up", gap: "Gap pass", interhub: "Cross-hub pass", idea: "Idea" };
