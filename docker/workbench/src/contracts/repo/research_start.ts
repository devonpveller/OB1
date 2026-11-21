// Starting research from anywhere (rwr-research-start-api): what the routes do, over two seams - the research service's
// request-boundary door (a client) and the owner-checked reads of a document or an idea. THIS FILE WRITES NOTHING: no
// INSERT, no UPDATE, no job row, no hand-back row. The job and its private hand-back are written by the
// research service's door (boundary.ts), from the boundary's output alone; the
// workbench only hands it the personal item (transient) and relays its answer.
//
//   preview  -> POST <RESEARCH_URL>/research/derived/preview   forms the request; writes nothing anywhere
//   start    -> POST <RESEARCH_URL>/research/derived           forms the SAME request (the same function), writes the job
//
// The workbench's own caller key (RESEARCH_WORKSPACE_KEY, as documents/clients.ts) is used; no new key, no new egress:
// the service's model call stays on its own LiteLLM key. Shipped inert: no URL or key = the stated 503.
import type { Db } from "../db.ts";
import { DocError } from "../../documents/repo.ts";
import type { Identity } from "../../middleware/identity.ts";
import { NotFound } from "./lifecycle.ts";
import { buildItem, type Loaded, type StartRequest } from "../logic/research_start.ts";

export class Unavailable extends Error {}

export interface DoorAnswer { status: number; body: Record<string, unknown> }
export interface DoorClient {
  preview(body: Record<string, unknown>): Promise<DoorAnswer>;
  start(body: Record<string, unknown>): Promise<DoorAnswer>;
}

/** The door's client from the environment; null (inert) unless RESEARCH_URL and RESEARCH_WORKSPACE_KEY are set. */
export function doorClient(env = (k: string) => Deno.env.get(k)): DoorClient | null {
  const base = (env("RESEARCH_URL") ?? "").replace(/\/+$/, "");
  const key = env("RESEARCH_WORKSPACE_KEY") ?? "";
  if (!base || !key) return null;
  const call = async (path: string, body: Record<string, unknown>, timeoutMs: number): Promise<DoorAnswer> => {
    let r: Response;
    try {
      r = await fetch(`${base}${path}`, {
        method: "POST", headers: { "content-type": "application/json", "x-brain-key": key },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Unavailable("the research service did not answer");
    }
    const j = await r.json().catch(() => ({}));
    return { status: r.status, body: (j && typeof j === "object" ? j : {}) as Record<string, unknown> };
  };
  // the preview may fetch pages and ask the local model: it gets the boundary's own time, not the 15 s of a job post
  return { preview: (b) => call("/research/derived/preview", b, 150_000), start: (b) => call("/research/derived", b, 150_000) };
}

export interface StartDeps {
  db: Db;
  door: DoorClient | null;
  /** the owner's document, read as theirs (documents/repo.ts readDocument): throws DocError 404 for another user's or a missing one */
  readDoc: (path: string, who: Identity) => Promise<{ path: string; content: string }>;
  newId?: () => string;
}

const NO_DOC = "no such document";
const NO_IDEA = "no idea with this id";
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The attached thing, read as the caller's. Another user's and a missing one are the same NotFound (the same words). */
export async function loadAttach(deps: StartDeps, req: StartRequest, who: Identity): Promise<Loaded | null> {
  if (req.attach.kind === "none") return null;
  if (req.attach.kind === "document") {
    try {
      const d = await deps.readDoc(req.attach.path, who);
      const title = (/^#\s+(.+)$/m.exec(d.content)?.[1] ?? "").trim();
      return { ref: d.path, title, text: d.content };
    } catch (e) {
      if (e instanceof DocError) throw new NotFound(NO_DOC);
      throw e;
    }
  }
  if (!UUIDISH.test(req.attach.id)) throw new NotFound(NO_IDEA);
  const rows = await deps.db.query<{ id: string; title: string; summary: string; current_revision: number }>(
    `SELECT id::text AS id, title, summary, current_revision FROM public.ideas WHERE id = $1::uuid AND owner_sub = $2`,
    [req.attach.id, who.sub],
  );
  if (!rows.length) throw new NotFound(NO_IDEA);
  return { ref: rows[0].id, title: rows[0].title, text: rows[0].summary, revision: rows[0].current_revision };
}

function doorBody(who: Identity, req: StartRequest, loaded: Loaded | null, newId: () => string) {
  return {
    purpose: "user-start",
    item: buildItem(who.sub, req, loaded, newId()),
    run: { depth: req.depth },
    // where the result goes: nowhere private beyond the hand-back itself
    deliver: { attach: req.attach.kind },
  };
}

function refuseService(who: Identity) {
  // a service key has no user front end (as the documents and workspace routes): no owner, nothing to start
  if (who.kind === "service" || /^(service|system|anonymous):/i.test(who.sub)) throw new NotFound(NO_DOC);
}

export interface Shown {
  ok: boolean;
  refusal: string | null;
  question: string | null;
  topic: string | null;
  links: string[];
  depth: { name: string; rounds: number; max_fetch: number; wall_ms: number } | null;
}

/** The door's answer, reduced to what would leave (the boundary's own output) - the door's other fields are never relayed. */
export function shown(b: Record<string, unknown>): Shown {
  const d = b.depth as { name?: unknown; budget?: Record<string, unknown> } | null | undefined;
  const budget = d?.budget ?? {};
  return {
    ok: b.ok === true,
    refusal: typeof b.refusal === "string" ? b.refusal : typeof b.refused === "string" ? b.refused : null,
    question: typeof b.question === "string" ? b.question : null,
    topic: typeof b.topic === "string" ? b.topic : null,
    links: Array.isArray(b.links) ? b.links.filter((x): x is string => typeof x === "string") : [],
    depth: d && typeof d.name === "string"
      ? { name: d.name, rounds: Number(budget.rounds), max_fetch: Number(budget.max_fetch), wall_ms: Number(budget.wall_ms) }
      : null,
  };
}

export async function previewStart(deps: StartDeps, who: Identity, req: StartRequest) {
  refuseService(who);
  if (!deps.door) throw new Unavailable("the research service is not configured for the workbench (RESEARCH_URL, RESEARCH_WORKSPACE_KEY)");
  const loaded = await loadAttach(deps, req, who);
  const a = await deps.door.preview(doorBody(who, req, loaded, deps.newId ?? (() => crypto.randomUUID())));
  if (a.status !== 200) throw new Unavailable("the research service could not form the request");
  return shown(a.body);
}

export type StartOutcome =
  | { started: true; job_id: string; shown: Shown }
  | { started: false; changed: boolean; shown: Shown };

export async function startResearch(deps: StartDeps, who: Identity, req: StartRequest): Promise<StartOutcome> {
  refuseService(who);
  if (!deps.door) throw new Unavailable("the research service is not configured for the workbench (RESEARCH_URL, RESEARCH_WORKSPACE_KEY)");
  const loaded = await loadAttach(deps, req, who);
  const body: Record<string, unknown> = doorBody(who, req, loaded, deps.newId ?? (() => crypto.randomUUID()));
  if (req.approved_question !== undefined) body.approved_question = req.approved_question;
  const a = await deps.door.start(body);
  if (a.status === 202 && typeof a.body.job_id === "string") return { started: true, job_id: a.body.job_id, shown: shown(a.body) };
  if (a.status === 409 && a.body.changed === true) return { started: false, changed: true, shown: shown(a.body) };
  if (a.status === 200 && typeof a.body.refused === "string") return { started: false, changed: false, shown: shown(a.body) };
  throw new Unavailable("the research service could not start the run");
}
