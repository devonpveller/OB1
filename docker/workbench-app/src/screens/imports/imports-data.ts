// What the Imports screen reads and writes (rwr-imports), all through lib/api.ts (the one door) for the subject the
// server resolves: no user is named by this code, a body never carries one, and nothing read here is written to
// storage, a cache or the console.
//
// The back end is today's intake routes (workbench/src/intake/routes.ts, repo.ts):
//   GET  /workbench/intake/jobs?kinds=import,add&limit=N      the caller's own jobs (another person's is never listed)
//   POST /workbench/intake/jobs/:kind/:id/retry | /cancel     404 for a job that is not the caller's (same as a missing one)
//   POST /workbench/intake/add                                JSON {url, path | refinery_id} or multipart (file)
// A job's `detail` carries what the screen shows; `detail.actions` says what the server would allow now.
import { api, apiForm, ApiError } from "../../lib/api";

export const JOBS_LIMIT = 200; // the server's per-kind maximum (parseLimit(.., 50, 200))
export const WEEK_MS = 7 * 24 * 3600 * 1000;
// The forwarder in front of the workbench (wiki-viewer/lib/workbench-proxy.mjs bodyCap) refuses a request body over
// 1 MB except on the old import route, so a file add through this door is limited to that. Checked by a test that
// reads the forwarder's source, so a change there is seen here.
export const FILE_LIMIT_BYTES = 1024 * 1024;

export type JobKind = "import" | "add";
export type Job = {
  id: string; kind: JobKind; status: string; created: string; updated: string;
  origin: string; url: string; filename: string; contentType: string;
  refineryId: string; docPath: string; sourceId: string; error: string; attempts: number; actions: string[];
};
export type JobsRead = { jobs: Job[]; capped: boolean };

const str = (x: unknown): string => (x == null ? "" : String(x));
const time = (s: unknown) => { const t = Date.parse(String(s ?? "")); return Number.isFinite(t) ? t : 0; };

// A 200 that is not the expected shape is a FAILED read, never an empty list.
function shape(j: any): Job {
  if (!j || typeof j !== "object" || typeof j.id !== "string" || typeof j.status !== "string" || !j.detail || typeof j.detail !== "object") throw new Error("unexpected answer: a job");
  if (j.kind !== "import" && j.kind !== "add") throw new Error("unexpected answer: a job kind");
  const d = j.detail;
  return {
    id: j.id, kind: j.kind, status: j.status, created: str(j.created_at), updated: str(j.updated_at),
    origin: str(d.origin), url: str(d.url), filename: str(d.filename), contentType: str(d.content_type),
    refineryId: str(d.refinery_id), docPath: str(d.doc_path), sourceId: str(d.held_source_id || d.source_id),
    error: str(d.error), attempts: Number.isInteger(d.attempts) ? d.attempts : 1,
    actions: Array.isArray(d.actions) ? d.actions.filter((a: unknown) => a === "retry" || a === "cancel") : [],
  };
}

export async function readJobs(): Promise<JobsRead> {
  const { data } = await api("GET", `/workbench/intake/jobs?kinds=import,add&limit=${JOBS_LIMIT}`);
  if (!data || !Array.isArray(data.jobs)) throw new Error("unexpected answer: no jobs");
  const jobs = data.jobs.map(shape).sort((a: Job, b: Job) => time(b.created) - time(a.created));
  // the server lists up to JOBS_LIMIT of EACH kind: a full kind means older jobs were not read
  const capped = (["import", "add"] as const).some((k) => jobs.filter((j: Job) => j.kind === k).length >= JOBS_LIMIT);
  return { jobs, capped };
}

// ── what a job means on the screen ───────────────────────────────────────────────────────────────────────────
export type Tone = "ok" | "run" | "wait" | "fail" | "skip";
const STATUS: Record<string, [string, Tone]> = {
  queued: ["Waiting", "wait"], fetching: ["Fetching", "run"], extracting: ["Reading", "run"], embedding: ["Embedding", "run"],
  linking: ["Linking", "run"], holding: ["Holding", "run"], held: ["Held", "ok"], done: ["Done", "ok"], failed: ["Failed", "fail"], cancelled: ["Cancelled", "skip"],
};
export const statusOf = (j: Job): { label: string; tone: Tone } => {
  const [label, tone] = STATUS[j.status] ?? [j.status || "Unknown", "wait" as Tone];
  return { label, tone };
};
export const isActive = (j: Job) => ["queued", "fetching", "extracting", "embedding", "linking", "holding"].includes(j.status);
export const needsLook = (j: Job) => j.status === "failed";

// Who sees it. An add is HELD in the person's refinery (workbench/src/intake/pipeline.ts: "held is a quality gate");
// a held source is private to its refinery until it is admitted (init-research-contract.sql, "held sources"). An
// import (the older file / link import) lands in the shared library directly. This is the job's own fact, not a guess.
export const isPrivate = (j: Job) => j.kind === "add";
export const whoSees = (j: Job): { short: string; long: string } =>
  isPrivate(j)
    ? { short: "Only you", long: "Only you. A held source is private to your refinery until it is admitted." }
    : { short: "Shared library", long: "Everyone on the workbench: an import lands in the shared library." };

export const fromOf = (j: Job): string =>
  j.origin === "owui" ? "Open WebUI chat" : j.kind === "add" || j.url || j.filename ? (j.url ? "Link" : "File") : "Import";
export const titleOf = (j: Job): string => j.filename || j.url || "(no name)";

const stem = (p: string) => (p.split("/").pop() ?? p).replace(/\.md$/i, "").replace(/[-_]+/g, " ");
export const landedIn = (j: Job): { text: string; href: string | null } =>
  j.docPath ? { text: "Document: " + stem(j.docPath), href: "/documents/" + encodeURIComponent(j.docPath) }
  : j.refineryId ? { text: "One of your ideas' refineries", href: null }
  : { text: "The shared library", href: null };

// The steps a job goes through, in order (intake/pipeline.ts; routes/import.ts). Which one a FAILED or CANCELLED job
// stopped at is not recorded, so those show no ticks: only the reason.
const PATHS: Record<string, string[]> = {
  "add-url": ["queued", "fetching", "extracting", "holding", "held"],
  "add-file": ["queued", "extracting", "holding", "held"],
  "import-url": ["queued", "embedding", "done"],
  "import-file": ["queued", "extracting", "embedding", "linking", "done"],
};
const STEP_LABEL: Record<string, string> = {
  queued: "Waiting its turn", fetching: "Fetched through the private search gateway", extracting: "Read", embedding: "Stored and embedded",
  linking: "Linked", holding: "Held in your refinery", held: "Held in your refinery", done: "Done",
};
export type Step = { label: string; state: "done" | "now" | "next" };
export function stepsOf(j: Job): Step[] | null {
  if (j.status === "failed" || j.status === "cancelled") return null;
  const path = PATHS[`${j.kind}-${j.url ? "url" : "file"}`];
  const at = path.indexOf(j.status);
  const finished = j.status === "held" || j.status === "done";
  return path.filter((s) => !(s === "holding" && finished)).map((s) => {
    const i = path.indexOf(s);
    return { label: STEP_LABEL[s], state: finished || i < at ? "done" : i === at ? "now" : "next" } as Step;
  });
}

// Try again is offered ONCE: the job's `attempts` starts at 1 and a retry makes it 2 (intake/routes.ts). The server
// would still accept a third go, so the screen does not offer it (and says why).
export const MAX_ATTEMPTS = 2;
export const canRetry = (j: Job) => j.actions.includes("retry") && j.attempts < MAX_ATTEMPTS;
export const retriedAlready = (j: Job) => (j.status === "failed" || j.status === "cancelled") && j.actions.includes("retry") && j.attempts >= MAX_ATTEMPTS;
export const canCancel = (j: Job) => j.actions.includes("cancel");

// "This week" is counted from the jobs read (a job's own created_at), so every number is the caller's.
export type Week = { came: number; landed: number; running: number; failed: number; cancelled: number };
export function weekOf(jobs: Job[], now = Date.now()): Week {
  const w = jobs.filter((j) => now - time(j.created) < WEEK_MS);
  return {
    came: w.length, landed: w.filter((j) => j.status === "held" || j.status === "done").length,
    running: w.filter(isActive).length, failed: w.filter(needsLook).length, cancelled: w.filter((j) => j.status === "cancelled").length,
  };
}

export type Filter = "all" | "run" | "fail" | "mine";
export const FILTERS: [Filter, string][] = [["all", "All"], ["run", "In progress"], ["fail", "Needs a look"], ["mine", "Private to me"]];
export const passes = (f: Filter, j: Job) => f === "all" || (f === "run" && isActive(j)) || (f === "fail" && needsLook(j)) || (f === "mine" && isPrivate(j));

// ── the writes ───────────────────────────────────────────────────────────────────────────────────────────────
export const reasonOf = (e: unknown, fallback: string): string =>
  e instanceof ApiError && typeof e.body?.error === "string" && e.body.error ? e.body.error : fallback;

const jobPath = (j: Job, verb: "retry" | "cancel") => `/workbench/intake/jobs/${j.kind}/${encodeURIComponent(j.id)}/${verb}`;
export const retryJob = (j: Job) => api("POST", jobPath(j, "retry"));
export const cancelJob = (j: Job) => api("POST", jobPath(j, "cancel"));

export type Landing = { kind: "doc"; path: string } | { kind: "idea"; id: string };
export type AddInput = { link: string } | { file: File };
export async function addOne(input: AddInput, landing: Landing): Promise<{ jobId: string }> {
  const where = landing.kind === "doc" ? { path: landing.path } : { refinery_id: landing.id };
  if ("file" in input) {
    const form = new FormData();
    form.append("file", input.file);
    for (const [k, v] of Object.entries(where)) form.append(k, v);
    const { data } = await apiForm("/workbench/intake/add", form);
    return { jobId: str(data?.job_id) };
  }
  const { data } = await api("POST", "/workbench/intake/add", { url: input.link, ...where });
  return { jobId: str(data?.job_id) };
}

// The link, checked the way the server checks it (intake/routes.ts: "the link must be an http or https address").
export function linkProblem(s: string): string | null {
  const t = s.trim();
  if (!t) return "Paste a link first.";
  let u: URL | null = null;
  try { u = new URL(t); } catch { /* below */ }
  return u && (u.protocol === "http:" || u.protocol === "https:") ? null : "The link must be an http or https address.";
}
export const FILE_TYPES = /\.(pdf|html?|xhtml)$/i;
export function fileProblem(f: File): string | null {
  if (!FILE_TYPES.test(f.name)) return "A file is a PDF or a saved web page. Other kinds can't be read yet.";
  if (f.size > FILE_LIMIT_BYTES) return "This file is over 1 MB, which is the most that can be added here for now. Add its link instead if it has one.";
  return null;
}

// Where it can land: the caller's own documents and ideas (the add accepts exactly one document or one idea's refinery).
export type LandingOption = { key: string; label: string; landing: Landing };
const listOf = (data: any, key: string): any[] => {
  if (!data || typeof data !== "object" || !Array.isArray(data[key])) throw new Error("unexpected answer: no " + key);
  return data[key];
};
export async function readLandings(): Promise<{ docs: LandingOption[]; ideas: LandingOption[] }> {
  const [d, i] = await Promise.all([api("GET", "/workbench/contract/documents?limit=100"), api("GET", "/workbench/contract/ideas?limit=100")]);
  const docs = listOf(d.data, "documents")
    .map((x) => ({ title: str(x.title), path: str(x.path) }))
    .filter((x) => x.path && !/(^|\/)\.(trash|archive)\//.test(x.path))
    .map((x) => ({ key: "doc:" + x.path, label: x.title || stem(x.path), landing: { kind: "doc", path: x.path } as Landing }));
  const ideas = listOf(i.data, "ideas")
    .filter((x) => x && x.id && x.status !== "archived")
    .map((x) => ({ key: "idea:" + x.id, label: str(x.title) || "(untitled idea)", landing: { kind: "idea", id: str(x.id) } as Landing }));
  return { docs, ideas };
}
