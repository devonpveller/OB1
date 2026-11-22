// Starting research from anywhere (rwr-research-start-api): the pure part - the request's validation and the
// personal item the request boundary is given. No I/O.
//
// Every personal input (the typed question, a document's text, selected passages) leaves here only as the `fields` of
// ONE item for the research service's request boundary (POST /research/derived[/preview]): the boundary forms the
// public question, and only that question reaches a job. The attach choice (nothing, a document) changes what the
// item holds, never the path: there is no second one.
//
// An IDEA is not attachable here (refused, 400, before anything is read - the same answer for the owner, another user
// and a missing idea). Operator rule PD0b (slot 580, rw-boundary-ideas): an idea is researched only through its
// owner's request path - the database queues it (POST /workbench/ideas/:id/research-now -> idea_research), the
// research service's drain forms the question from the idea's revision, and a refusal waits for the owner's review
// (approve, or idea_handback_run_private). The shared derived door refuses an idea item, and slot 580's trigger
// refuses a user-start hand-back on an idea; that path takes neither this request's question nor its passages, starts
// asynchronously (a request id, not a job) and is not a private run unless the owner chooses one in review - so a
// start from here could not do what its preview shows. See the item's findings (rwr-research-start-api).
import { BadRequest } from "./scope.ts";

export const DEPTHS = ["quick", "standard", "deep"] as const;
export type Depth = (typeof DEPTHS)[number];
export const DEFAULT_DEPTH: Depth = "standard";

export type Attach = { kind: "none" } | { kind: "document"; path: string };

export interface StartRequest {
  attach: Attach;
  question: string;
  depth: Depth;
  passages: string[];
  approved_question?: string;
}

export const MAX_QUESTION = 2000;
export const MAX_PASSAGES = 20;
export const MAX_PASSAGE = 4000;
export const MAX_DOC_TEXT = 20_000; // the door's own per-field cap (parseDoorBody)

/** The one answer to an idea attach (preview and start alike; nothing is read first, so it says nothing about the idea). */
export const IDEA_REFUSED = "an idea is researched from the idea itself (its research-now), through its owner's request path - not attached here";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The request body, validated. Anything unexpected is the caller's error (400); no value is echoed back. */
export function parseStart(body: unknown): StartRequest {
  if (!isObj(body)) throw new BadRequest("the body must be a JSON object");
  const extra = Object.keys(body).filter((k) => !["attach", "question", "depth", "passages", "approved_question"].includes(k));
  if (extra.length) throw new BadRequest("unknown field in the request");
  const a = body.attach === undefined ? { kind: "none" } : body.attach;
  if (!isObj(a) || typeof a.kind !== "string") throw new BadRequest("attach is {kind: none | document, ...}");
  let attach: Attach;
  if (a.kind === "none") attach = { kind: "none" };
  else if (a.kind === "document") {
    if (typeof a.path !== "string" || !a.path.trim() || a.path.length > 500) throw new BadRequest("attach.path names a document");
    attach = { kind: "document", path: a.path.trim() };
  } else if (a.kind === "idea") throw new BadRequest(IDEA_REFUSED);
  else throw new BadRequest("attach.kind is none or document");
  if (typeof body.question !== "string" || !body.question.trim()) throw new BadRequest("question is required");
  if (body.question.length > MAX_QUESTION) throw new BadRequest(`question is at most ${MAX_QUESTION} characters`);
  const depth = body.depth === undefined ? DEFAULT_DEPTH : body.depth;
  if (typeof depth !== "string" || !(DEPTHS as readonly string[]).includes(depth)) throw new BadRequest("depth is quick, standard or deep");
  const passages = body.passages === undefined ? [] : body.passages;
  if (!Array.isArray(passages) || passages.length > MAX_PASSAGES || passages.some((p) => typeof p !== "string" || p.length > MAX_PASSAGE)) {
    throw new BadRequest(`passages are at most ${MAX_PASSAGES} strings of at most ${MAX_PASSAGE} characters`);
  }
  if (attach.kind === "none" && passages.length) throw new BadRequest("passages belong to a document");
  const out: StartRequest = { attach, question: body.question.trim(), depth: depth as Depth, passages: passages as string[] };
  if (body.approved_question !== undefined) {
    if (typeof body.approved_question !== "string" || !body.approved_question.trim() || body.approved_question.length > 300) {
      throw new BadRequest("approved_question is the question the preview showed (at most 300 characters)");
    }
    out.approved_question = body.approved_question;
  }
  return out;
}

/** http(s) URLs written in the given texts: candidates for the public links the boundary may use as evidence. Each is
 *  judged by the boundary (canonical, public address, fetched anonymously); here they are only found. */
export function extractLinks(...texts: string[]): string[] {
  const seen = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) {
      const u = m[0].replace(/[.,;:!?]+$/, "");
      if (u.length <= 2000) seen.add(u);
      if (seen.size >= 50) return [...seen];
    }
  }
  return [...seen];
}

export interface Loaded {
  /** the document's path as the owner holds it */
  ref: string;
  title?: string;
  text?: string;
}

export interface DoorItem {
  kind: string;
  id: string;
  owner_sub: string;
  fields: Record<string, string>;
  links: string[];
}

/** The item the boundary is given. `startId` makes every start its own hand-back (the hand-back coalesces on
 *  inlet + purpose, and two starts from one document must not overwrite each other). */
export function buildItem(owner_sub: string, req: StartRequest, loaded: Loaded | null, startId: string): DoorItem {
  const fields: Record<string, string> = { question: req.question };
  req.passages.forEach((p, i) => { fields[`passage_${i + 1}`] = p; });
  let kind = "chat";
  let id = `start:${startId}`;
  if (req.attach.kind === "document" && loaded) {
    kind = "document";
    id = `${loaded.ref}#${startId}`;
    fields.document_title = loaded.title ?? "";
    fields.document = (loaded.text ?? "").slice(0, MAX_DOC_TEXT);
  }
  const links = extractLinks(...Object.values(fields));
  return { kind, id: id.slice(0, 500), owner_sub, fields, links };
}
