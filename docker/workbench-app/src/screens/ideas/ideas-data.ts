// What the Ideas screen reads and writes (rwr-ideas). Every call goes through lib/api.ts (the one door) for the subject
// the server resolves: this code never names a user, and an idea's text or title is never written to storage, the page
// title, a URL or the console. A 404 for any idea id is ONE answer here ("not available"), whether the idea is missing,
// someone else's or not an id at all.
import { api, ApiError } from "../../lib/api";

export const LIST_LIMIT = 200;
const enc = encodeURIComponent;

export type IdeaRow = { id: string; title: string; status: string; summary: string; revision: number; updated: string; lastSession: string; resurfaced: boolean };
export type Revision = { revision: number; summary: string; runId: string; at: string };
export type Run = { id: string; query: string; status: string; at: string };
export type IdeaDetail = {
  id: string; title: string; status: string; summary: string; revision: number; created: string; updated: string;
  revisions: Revision[]; runs: Run[]; from: string;
  document: { path: string; title: string } | null; podcasts: number; chat: { entries: number } | null; sources: { id: string; title: string }[];
};
export type ResearchState = { state: string; review: { candidate: string; failing: string[] } | null };

// the groups of the list, in order; a status the screen does not know sits in Refining (never hidden)
export const GROUPS: { key: string; name: string; statuses: string[] }[] = [
  { key: "new", name: "New", statuses: ["new", "queued"] },
  { key: "refining", name: "Refining", statuses: ["engaged", "dirty", "researched"] },
  { key: "document", name: "Has a document", statuses: ["promoted"] },
  { key: "parked", name: "Parked", statuses: ["dormant"] },
  { key: "archived", name: "Archived", statuses: ["archived"] },
];
export const groupOf = (status: string) => (GROUPS.find((g) => g.statuses.includes(status)) ?? GROUPS[1]).key;
export const STATE_LABEL: Record<string, string> = {
  new: "new", queued: "queued", researched: "researched", engaged: "refining", dirty: "revised", dormant: "parked", promoted: "has a document", archived: "archived",
};
export const isArchived = (status: string) => status === "archived";

const str = (x: unknown) => (typeof x === "string" ? x : "");
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
const obj = (x: unknown): Record<string, any> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, any>) : {});

// A 200 that is not the expected JSON (a login page, a wrong shape) is a FAILED read, never an empty list.
export async function readIdeas(): Promise<IdeaRow[]> {
  const { data } = await api("GET", "/workbench/contract/ideas?limit=" + LIST_LIMIT);
  if (!data || typeof data !== "object" || !Array.isArray((data as any).ideas)) throw new Error("unexpected answer: no ideas");
  return (data as any).ideas.map((i: any) => ({
    id: str(i?.id), title: str(i?.title), status: str(i?.status), summary: str(i?.summary), revision: Number(i?.current_revision) || 1,
    updated: str(i?.updated_at), lastSession: str(i?.last_session_at), resurfaced: !!i?.resurfaced_at,
  })).filter((i: IdeaRow) => i.id);
}

export class NotAvailable extends Error {}

export async function readIdea(id: string): Promise<IdeaDetail> {
  let data: any;
  try {
    data = (await api("GET", "/workbench/contract/ideas/" + enc(id))).data;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new NotAvailable();
    throw e;
  }
  if (!data || typeof data !== "object" || typeof data.id !== "string" || !Array.isArray(data.revisions)) throw new Error("unexpected answer: no idea");
  const rf = obj(data.refinery), mem = obj(rf.members), room = obj(data.room);
  const doc = obj(mem.document);
  const from = obj(rf.origin).kind === "document" ? "a document of yours" : room.thread_root ? "a Mattermost message" : "a thought you captured";
  return {
    id: data.id, title: str(data.title), status: str(data.status), summary: str(data.summary), revision: Number(data.current_revision) || 1,
    created: str(data.created_at), updated: str(data.updated_at),
    revisions: data.revisions.map((r: any) => ({ revision: Number(r?.revision) || 0, summary: str(r?.summary), runId: str(r?.research_job_id), at: str(r?.created_at) }))
      .sort((a: Revision, b: Revision) => b.revision - a.revision),
    runs: arr(data.sessions).map((s: any) => ({ id: str(s?.id), query: str(s?.query), status: str(s?.status), at: str(s?.created_at) })),
    from,
    document: typeof doc.path === "string" ? { path: doc.path, title: str(doc.title) } : null,
    podcasts: arr(mem.podcasts).length,
    chat: room.state === "current" ? { entries: Number(room.entries) || 0 } : null,
    sources: arr(rf.user_sources).map((u: any) => ({ id: str(u?.source_id), title: str(u?.title) })),
  };
}

export async function readResearch(id: string): Promise<ResearchState> {
  let data: any;
  try {
    data = (await api("GET", "/workbench/ideas/" + enc(id) + "/research")).data;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new NotAvailable();
    throw e;
  }
  const rv = obj(data?.review);
  return {
    state: str(data?.state) || "none",
    review: data?.state === "awaiting_owner" ? { candidate: str(rv.candidate), failing: arr(rv.failing).map(String) } : null,
  };
}

// ---- writes. Each says what happened in one plain sentence; a refusal never says why in terms of anyone else.
export type Result = { ok: boolean; message: string; revision?: number; path?: string };
const refusal = (e: unknown, fallback: string): Result => {
  if (e instanceof ApiError) {
    if (e.status === 404) return { ok: false, message: "This idea is not available." };
    if (e.status === 409) return { ok: false, message: String((e.body as any)?.error ?? "That is not possible right now.") };
    if (e.status === 400) return { ok: false, message: String((e.body as any)?.error ?? fallback) };
  }
  return { ok: false, message: fallback };
};

export async function researchNow(id: string): Promise<Result> {
  try {
    await api("POST", "/workbench/ideas/" + enc(id) + "/research-now", {});
    return { ok: true, message: "Research on this idea was requested." };
  } catch (e) { return refusal(e, "Could not ask for research. Try again."); }
}
export async function revise(id: string, summary: string): Promise<Result> {
  try {
    const { data } = await api("POST", "/workbench/ideas/" + enc(id) + "/edit", { summary });
    if ((data as any)?.outcome === "unchanged") return { ok: true, message: "That is already the idea's wording. Nothing changed." };
    const n = Number((data as any)?.revision) || undefined;
    return { ok: true, revision: n, message: "Saved as " + (n ? "revision " + n : "a new revision") + ". The next research uses it; earlier runs stay with their wording." };
  } catch (e) { return refusal(e, "Could not save the new wording. Try again."); }
}
export async function archive(id: string): Promise<Result> {
  try {
    await api("POST", "/workbench/ideas/" + enc(id) + "/archive", {});
    return { ok: true, message: "Idea archived. Scheduled research for it has stopped." };
  } catch (e) { return refusal(e, "Could not archive the idea. Try again."); }
}
export async function reopen(id: string): Promise<Result> {
  try {
    await api("POST", "/workbench/ideas/" + enc(id) + "/reopen", {});
    return { ok: true, message: "Idea reopened, as it was." };
  } catch (e) { return refusal(e, "Could not reopen the idea. Try again."); }
}
// create its document: the documents API's seed (it also promotes the idea). A 409 that names the path means the document
// already exists: open that one.
export async function createDocument(id: string): Promise<Result> {
  try {
    const { data } = await api("POST", "/workbench/documents/seed", { idea_id: id });
    return typeof (data as any)?.path === "string" ? { ok: true, message: "Document created.", path: (data as any).path } : { ok: false, message: "Could not create the document. Try again." };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && typeof (e.body as any)?.path === "string") return { ok: true, message: "It already has a document.", path: (e.body as any).path };
    return refusal(e, "Could not create the document. Try again.");
  }
}
export async function approveQuestion(id: string, question: string): Promise<Result> {
  try {
    const { data } = await api("POST", "/workbench/ideas/" + enc(id) + "/research/approve", { question });
    return (data as any)?.outcome === "refused"
      ? { ok: false, message: "That question still carries wording that cannot go out. Edit it, or run it privately." }
      : { ok: true, message: "Approved. The question is queued as shared research." };
  } catch (e) { return refusal(e, "Could not approve the question. Try again."); }
}
export async function runPrivately(id: string, question: string): Promise<Result> {
  try {
    await api("POST", "/workbench/ideas/" + enc(id) + "/research/private", { question });
    return { ok: true, message: "Running privately. The report will be yours alone." };
  } catch (e) { return refusal(e, "Could not start the private run. Try again."); }
}
