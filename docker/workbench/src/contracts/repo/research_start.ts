// Starting research from anywhere (rwr-research-start-api): what the routes do, over two seams - the research service's
// request-boundary door (a client) and the owner-checked read of a document (an idea is refused by parseStart). THIS FILE WRITES NOTHING: no
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
import type { Identity } from "../../middleware/identity.ts";
import { NotFound } from "./lifecycle.ts";
import { buildItem, COMMUNITY_OFF_REASON, DEFAULT_SOURCES, type Loaded, type Sources, type StartRequest } from "../logic/research_start.ts";

export class Unavailable extends Error {}
/** rwr-research-sources: community asked for while the admin switch is off (403, a plain reason, nothing sent). */
export class CommunityOff extends Error {
  constructor() { super(COMMUNITY_OFF_REASON); }
}

/** The admin switch: stored false = off; nothing stored = the default (on). A read that fails answers OFF (fail closed). */
export async function communityAllowed(db: Db): Promise<boolean> {
  try {
    const r = await db.query<{ v: unknown }>(`SELECT public.setting_get($1, $2) AS v`, [null, "research.community_allowed"]);
    return r[0]?.v !== false;
  } catch {
    return false;
  }
}

/** The person's own saved default (never anyone else's); anything but a known value reads as the default. */
export async function sourcesDefault(db: Db, who: Identity): Promise<Sources> {
  const r = await db.query<{ v: unknown }>(`SELECT public.setting_get($1, $2) AS v`, [who.sub, "research.sources_default"]).catch(() => []);
  const v = r[0]?.v;
  return v === "community" || v === "credible" ? v : DEFAULT_SOURCES;
}

/** What the Start dialog needs: the preset choice and whether community may be chosen (with the reason when not). */
export async function sourcesOptions(db: Db, who: Identity) {
  const allowed = await communityAllowed(db);
  const def = await sourcesDefault(db, who);
  const sources_default: Sources = allowed ? def : "credible";
  return { sources_default, community_allowed: allowed, reason: allowed ? null : COMMUNITY_OFF_REASON };
}

/** The run's mode: the body's choice, else the person's default. Community with the switch off: an explicit choice is
 *  refused (CommunityOff); a saved default falls back to credible (the dialog shows the choice disabled). */
export async function resolveSources(db: Db, who: Identity, req: StartRequest): Promise<Sources> {
  const want = req.sources ?? await sourcesDefault(db, who);
  if (want !== "community") return want;
  if (await communityAllowed(db)) return want;
  if (req.sources === "community") throw new CommunityOff();
  return "credible";
}

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
    // only the door's own answers (200 / 202 / 409) carry a body to the caller; any other status is the status alone -
    // an upstream error's text never rides out (rw-identity-harden2 D8: a client never hands its caller a service's error text)
    if (![200, 202, 409].includes(r.status)) { await r.body?.cancel(); return { status: r.status, body: {} }; }
    const j = await r.json().catch(() => ({}));
    return { status: r.status, body: (j && typeof j === "object" ? j : {}) as Record<string, unknown> };
  };
  // the preview may fetch pages and ask the local model: it gets the boundary's own time, not the 15 s of a job post
  return { preview: (b) => call("/research/derived/preview", b, 150_000), start: (b) => call("/research/derived", b, 150_000) };
}

export interface StartDeps {
  db: Db;
  door: DoorClient | null;
  /** the owner's document, read as theirs (documents/repo.ts readDocument, injected by src/app.ts): null for another
   *  user's or a missing one. Not imported here: documents/repo.ts would put config.ts in the contract's module graph. */
  readDoc: (path: string, who: Identity) => Promise<{ path: string; content: string } | null>;
  newId?: () => string;
}

const NO_DOC = "no such document";

/** The attached document, read as the caller's. Another user's and a missing one are the same NotFound (the same
 *  words). An idea never gets here: parseStart refuses it (logic/research_start.ts IDEA_REFUSED). */
export async function loadAttach(deps: StartDeps, req: StartRequest, who: Identity): Promise<Loaded | null> {
  if (req.attach.kind === "none") return null;
  const d = await deps.readDoc(req.attach.path, who);
  if (!d) throw new NotFound(NO_DOC);
  const title = (/^#\s+(.+)$/m.exec(d.content)?.[1] ?? "").trim();
  return { ref: d.path, title, text: d.content };
}

function doorBody(who: Identity, req: StartRequest, loaded: Loaded | null, newId: () => string, sources: Sources) {
  return {
    purpose: "user-start",
    item: buildItem(who.sub, req, loaded, newId()),
    run: { depth: req.depth, sources },
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
  /** rwr-research-sources: the mode the run uses (the door's answer, else what was sent) */
  sources: Sources | null;
}

/** The door's answer, reduced to what would leave (the boundary's own output) - the door's other fields are never relayed. */
export function shown(b: Record<string, unknown>, sent: Sources | null = null): Shown {
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
    sources: b.sources === "credible" || b.sources === "community" ? b.sources : sent,
  };
}

export async function previewStart(deps: StartDeps, who: Identity, req: StartRequest) {
  refuseService(who);
  if (!deps.door) throw new Unavailable("the research service is not configured for the workbench (RESEARCH_URL, RESEARCH_WORKSPACE_KEY)");
  const sources = await resolveSources(deps.db, who, req);
  const loaded = await loadAttach(deps, req, who);
  const a = await deps.door.preview(doorBody(who, req, loaded, deps.newId ?? (() => crypto.randomUUID()), sources));
  if (a.status === 403) throw new CommunityOff();
  if (a.status !== 200) throw new Unavailable("the research service could not form the request");
  return shown(a.body, sources);
}

export type StartOutcome =
  | { started: true; job_id: string; shown: Shown }
  | { started: false; changed: boolean; shown: Shown };

export async function startResearch(deps: StartDeps, who: Identity, req: StartRequest): Promise<StartOutcome> {
  refuseService(who);
  if (!deps.door) throw new Unavailable("the research service is not configured for the workbench (RESEARCH_URL, RESEARCH_WORKSPACE_KEY)");
  const sources = await resolveSources(deps.db, who, req);
  const loaded = await loadAttach(deps, req, who);
  const body: Record<string, unknown> = doorBody(who, req, loaded, deps.newId ?? (() => crypto.randomUUID()), sources);
  if (req.approved_question !== undefined) body.approved_question = req.approved_question;
  const a = await deps.door.start(body);
  if (a.status === 403) throw new CommunityOff();
  if (a.status === 202 && typeof a.body.job_id === "string") return { started: true, job_id: a.body.job_id, shown: shown(a.body, sources) };
  if (a.status === 409 && a.body.changed === true) return { started: false, changed: true, shown: shown(a.body, sources) };
  if (a.status === 200 && typeof a.body.refused === "string") return { started: false, changed: false, shown: shown(a.body, sources) };
  throw new Unavailable("the research service could not start the run");
}
