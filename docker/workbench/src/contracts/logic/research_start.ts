// Starting research from anywhere (rwr-research-start-api): the pure part - the request's validation and the
// personal item the request boundary is given. No I/O.
//
// Every personal input (the typed question, a document's text, an idea's text, selected passages) leaves here only as
// the `fields` of ONE item for the research service's request boundary (POST /research/derived[/preview]): the
// boundary forms the public question, and only that question reaches a job. The attach choice (nothing, a
// document, an idea) changes what the item holds, never the path: there is no second one.
import { BadRequest } from "./scope.ts";

export const DEPTHS = ["quick", "standard", "deep"] as const;
export type Depth = (typeof DEPTHS)[number];
export const DEFAULT_DEPTH: Depth = "standard";

export type Attach = { kind: "none" } | { kind: "document"; path: string } | { kind: "idea"; id: string };

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

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The request body, validated. Anything unexpected is the caller's error (400); no value is echoed back. */
export function parseStart(body: unknown): StartRequest {
  if (!isObj(body)) throw new BadRequest("the body must be a JSON object");
  const extra = Object.keys(body).filter((k) => !["attach", "question", "depth", "passages", "approved_question"].includes(k));
  if (extra.length) throw new BadRequest("unknown field in the request");
  const a = body.attach === undefined ? { kind: "none" } : body.attach;
  if (!isObj(a) || typeof a.kind !== "string") throw new BadRequest("attach is {kind: none | document | idea, ...}");
  let attach: Attach;
  if (a.kind === "none") attach = { kind: "none" };
  else if (a.kind === "document") {
    if (typeof a.path !== "string" || !a.path.trim() || a.path.length > 500) throw new BadRequest("attach.path names a document");
    attach = { kind: "document", path: a.path.trim() };
  } else if (a.kind === "idea") {
    if (typeof a.id !== "string" || !a.id.trim() || a.id.length > 100) throw new BadRequest("attach.id names an idea");
    attach = { kind: "idea", id: a.id.trim() };
  } else throw new BadRequest("attach.kind is none, document or idea");
  if (typeof body.question !== "string" || !body.question.trim()) throw new BadRequest("question is required");
  if (body.question.length > MAX_QUESTION) throw new BadRequest(`question is at most ${MAX_QUESTION} characters`);
  const depth = body.depth === undefined ? DEFAULT_DEPTH : body.depth;
  if (typeof depth !== "string" || !(DEPTHS as readonly string[]).includes(depth)) throw new BadRequest("depth is quick, standard or deep");
  const passages = body.passages === undefined ? [] : body.passages;
  if (!Array.isArray(passages) || passages.length > MAX_PASSAGES || passages.some((p) => typeof p !== "string" || p.length > MAX_PASSAGE)) {
    throw new BadRequest(`passages are at most ${MAX_PASSAGES} strings of at most ${MAX_PASSAGE} characters`);
  }
  if (attach.kind === "none" && passages.length) throw new BadRequest("passages belong to a document or an idea");
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
  /** document: the path as the owner holds it; idea: the idea id */
  ref: string;
  title?: string;
  text?: string;
  revision?: number;
}

export interface DoorItem {
  kind: string;
  id: string;
  revision?: number;
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
  let revision: number | undefined;
  if (req.attach.kind === "document" && loaded) {
    kind = "document";
    id = `${loaded.ref}#${startId}`;
    fields.document_title = loaded.title ?? "";
    fields.document = (loaded.text ?? "").slice(0, MAX_DOC_TEXT);
  } else if (req.attach.kind === "idea" && loaded) {
    kind = "idea";
    id = `${loaded.ref}#${startId}`;
    revision = loaded.revision;
    fields.title = loaded.title ?? "";
    fields.summary = (loaded.text ?? "").slice(0, MAX_DOC_TEXT);
  }
  const links = extractLinks(...Object.values(fields));
  return { kind, id: id.slice(0, 500), ...(revision !== undefined ? { revision } : {}), owner_sub, fields, links };
}
