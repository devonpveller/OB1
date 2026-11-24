// The Start research dialog's data (rwr-start-research): the request it builds, and its two calls. Nothing here
// reaches anything but the workbench's own routes (lib/api.ts: same-origin /workbench/* only), and nothing here is
// kept: no storage, no URL, no module-level cache (the question and the document are private text).
//
// ONE body: the preview and the start are built from the same StartBody; the start adds only approved_question (the
// exact text the preview showed), so what the person read is what the start sends, or the server refuses (409).
import { api, ApiError } from "../../lib/api";
import { readDocuments } from "../home/home-data";

export type Depth = "quick" | "standard" | "deep";
export const DEPTHS: { id: Depth; label: string; blurb: string; estimate: string }[] = [
  { id: "quick", label: "Quick", blurb: "one pass, a short answer", estimate: "Quick: usually a few minutes." },
  { id: "standard", label: "Standard", blurb: "sources, claims and a report", estimate: "Standard: usually under an hour. You can steer it while it runs." },
  { id: "deep", label: "Deep, with gaps", blurb: "follows up what is missing", estimate: "Deep: longer, and it may ask you to choose between branches." },
];

// What the run is about. There is no idea here, on purpose (operator decision 2026-11-22): an idea is researched from
// the idea itself (its own research-now), and the back end refuses an idea attach.
export type Attach = { kind: "none" } | { kind: "document"; path: string };
export type StartBody = { attach: Attach; question: string; depth: Depth };
export type Shown = {
  question: string | null;
  topic: string | null;
  links: string[];
  depth: { name: string; rounds: number; max_fetch: number; wall_ms: number } | null;
  refusal: string | null;
};
export type PreviewOut = Shown & { ok: boolean };

export const MAX_QUESTION = 2000;

// the one place the request body is made (trimmed question; the shape the route's strict schema takes)
export function bodyOf(attach: Attach, question: string, depth: Depth): StartBody {
  return { attach: attach.kind === "document" ? { kind: "document", path: attach.path } : { kind: "none" }, question: question.trim(), depth };
}
export const sameBody = (a: StartBody, b: StartBody) => JSON.stringify(a) === JSON.stringify(b);
export const startBodyOf = (b: StartBody, approved: string) => ({ ...b, approved_question: approved });

const strOrNull = (v: unknown) => (typeof v === "string" ? v : null);
function shownOf(d: any): Shown {
  const dep = d?.depth;
  return {
    question: strOrNull(d?.question),
    topic: strOrNull(d?.topic),
    links: Array.isArray(d?.links) ? d.links.filter((x: unknown): x is string => typeof x === "string") : [],
    depth: dep && typeof dep === "object" && typeof dep.rounds === "number" && typeof dep.max_fetch === "number" && typeof dep.wall_ms === "number"
      ? { name: String(dep.name ?? ""), rounds: dep.rounds, max_fetch: dep.max_fetch, wall_ms: dep.wall_ms } : null,
    refusal: strOrNull(d?.refusal),
  };
}

// What would leave. A 200 that is not the route's answer is a FAILED preview, never an empty one.
export async function previewResearch(body: StartBody): Promise<PreviewOut> {
  const { data } = await api("POST", "/workbench/research/preview", body);
  if (!data || typeof data !== "object" || typeof (data as any).ok !== "boolean") throw new Error("unexpected answer");
  const s = shownOf(data);
  const ok = (data as any).ok === true && s.question !== null && s.question !== "";
  return { ...s, ok };
}

export type StartOutcome =
  | { kind: "started"; jobId: string }
  | { kind: "refused"; shown: Shown } // the boundary refused: nothing was created
  | { kind: "changed" } // what would leave changed since the preview: nothing was created
  | { kind: "gone" } // the document is not available (a 404: missing, trashed or not yours: one answer)
  | { kind: "unavailable" }
  | { kind: "failed" };

export async function startResearch(body: StartBody, approved: string): Promise<StartOutcome> {
  try {
    const { status, data } = await api("POST", "/workbench/research", startBodyOf(body, approved));
    const d = data as any;
    if (status === 202 && d?.started === true && typeof d.job_id === "string" && d.job_id !== "") return { kind: "started", jobId: d.job_id };
    if (d?.started === false) return { kind: "refused", shown: shownOf(d) };
    return { kind: "failed" };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 409) return { kind: "changed" };
      if (e.status === 404) return { kind: "gone" };
      if (e.status === 503) return { kind: "unavailable" };
    }
    return { kind: "failed" };
  }
}

// ---- the document the dialog is for ----
export type DocChoice = { path: string; title: string; ref: string }; // ref: the opaque id (the only thing an address carries)
const baseTitle = (path: string) => (path.split("/").pop() ?? path).replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() || path;

// A document the person could research: their own, live (not in the trash or the archive). The listing is the
// caller's own (the server scopes it); a path that is not in it is never offered.
const HIDDEN = /(^|\/)\.(trash|archive)\//;
export async function readMyDocuments(): Promise<DocChoice[]> {
  const rows = await readDocuments();
  return rows.filter((r) => r.path && !HIDDEN.test(r.path)).map((r) => ({ path: r.path, title: r.title.trim() || baseTitle(r.path), ref: r.ref }));
}

// The document named in the address (?document=<opaque id>), if it looks like an id at all. Nothing is read from the
// address but this one identifier; anything else (a path, a title) is "no document": the address never carries one.
const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
export function documentFromSearch(search: string): string | null {
  const v = new URLSearchParams(search).get("document");
  return v !== null && REF_SHAPE.test(v) ? v : null;
}

// "Research this" from a document: the address that opens the dialog for it. It takes the document's opaque id (the
// listing's), never its path.
export const startResearchHref = (documentRef?: string | null) =>
  documentRef && REF_SHAPE.test(documentRef) ? `/research/start?document=${encodeURIComponent(documentRef)}` : "/research/start";

// plain words for the boundary's refusal codes; an unknown code is shown as it is, after a plain sentence
const REFUSALS: Record<string, string> = {
  no_public_evidence: "There is no public page it could use to back this question. Add a link to a public page that covers it, then try again.",
  no_candidate_passed: "It could not make a question from this that is safe to send. Try saying it more generally, or add a link to a public page.",
};
export function refusalText(code: string | null): string {
  return REFUSALS[(code ?? "").slice(0, 80)] ?? "Nothing can leave the workbench from this as written. Try saying it more generally, or add a link to a public page.";
}

export const minutes = (ms: number) => Math.max(1, Math.round(ms / 60000));
export function limitsText(d: NonNullable<Shown["depth"]>): string {
  return `Up to ${d.rounds} ${d.rounds === 1 ? "round" : "rounds"} of searching, up to ${d.max_fetch} pages read, and it stops after ${minutes(d.wall_ms)} minutes.`;
}
