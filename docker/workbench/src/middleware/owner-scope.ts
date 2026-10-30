// The owner scope (rw-p2b-workspace round 2, tester attempt 1 F1-F6): the ONE layer every
// /workbench/* request and every JSON response passes through, so per-user front-end context cannot
// leak through a route that was written before user documents had owners - whatever the route.
//
// Per user (operator 2026-10-28): user documents (the documents/ tree and its listing), ideas
// (refineries), the bell's read state, refinery pick-ups, the original prompt a user typed. Shared:
// everything research produces.
//
// 1. Requests. Every place a request can name a vault path - the URL (its path and query) and the
//    string fields of a JSON or form body (bar a document's own text) - is searched for a
//    `documents/...` path; each one must be the caller's own (their documents/<key>/ directory, or a
//    pre-P2b documents/<file> whose listing row they own). Otherwise 404, before any route runs:
//    export, note-history, holders?ref=, a contract reference into another user's holder.
// Round 3 (tester attempt 2 F7): the walk below is a BACKSTOP only. Ownership is decided where the
// data is read - in SQL and the repositories (documents/ownership.ts: sessions, the stream, jobs,
// dependence, quality, references, held sources) - and every gated route checks ownership itself.
// The walk now covers text/event-stream as well as JSON. WORKSPACE_RESPONSE_WALK=off turns the
// walk off (LAB ONLY: the isolation sweep runs with it off to prove the routes need no net).
// 2. Responses. Every JSON (and event-stream) response is walked: a string naming another user's document path is
//    replaced (and an object carrying it loses its title), and a string that is another user's
//    refinery (idea) id becomes null (inside a longer string, the id is withheld). A route's own SQL filters too (timeline, notifications); this
//    is the net under all of them, nested fields included.
import type { Context, Next } from "hono";
import type { Db } from "../contracts/db.ts";
import { identityOf, type Identity, seamPath } from "./identity.ts";
import { documentPathsIn, ownsDocumentPaths } from "../documents/ownership.ts";

const OTHER = "(another user's document)";
// a body field holding a document's TEXT, not a path: never searched (a document may quote a path)
const TEXT_FIELDS = new Set(["content", "body", "text", "markdown", "exact", "note", "summary"]);
const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// the documents API's own URL prefixes are routes, not vault paths
const ROUTE_PREFIX = /^\/workbench\/(?:documents|contract\/documents)(?=\/|$)/;

export { documentPathsIn };

function stringsOf(v: unknown, out: string[], key = ""): void {
  if (typeof v === "string") {
    if (!TEXT_FIELDS.has(key)) out.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) stringsOf(x, out, key);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) stringsOf(x, out, k);
  }
}

class BodyRefused extends Error {
  constructor(readonly status: 400 | 415, msg: string) { super(msg); }
}

const MUTATING = (m: string) => !["GET", "HEAD", "OPTIONS"].includes(m);

async function requestStrings(c: Context): Promise<string[]> {
  const url = new URL(c.req.url); // the query only - the path is the seam's (rw-identity3, B1b)
  const route = seamPath(c);
  const out: string[] = [];
  let path = route;
  try { path = decodeURIComponent(path); } catch { /* keep raw */ }
  out.push(path.replace(ROUTE_PREFIX, ""));
  for (const [, v] of url.searchParams) out.push(v);
  if (!MUTATING(c.req.method)) return out;
  const media = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const raw = await c.req.raw.clone().text();
  if (!raw.length) return out;
  const isJson = media === "application/json" || media.endsWith("+json");
  // the contract API takes JSON bodies only: any other type is refused here, never handed to a route
  // that would read it as no body (attempt 2: a 500 on application/vnd.x+json and text/plain)
  if (route.startsWith("/workbench/contract/") && media !== "application/json") {
    throw new BodyRefused(415, "the contract API takes application/json");
  }
  if (isJson) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new BodyRefused(400, "the body is not valid JSON"); }
    stringsOf(parsed, out);
  } else if (media === "multipart/form-data" || media === "application/x-www-form-urlencoded") {
    try {
      for (const [k, v] of (await c.req.raw.clone().formData()).entries()) if (typeof v === "string" && !TEXT_FIELDS.has(k)) out.push(v);
    } catch { throw new BodyRefused(400, "the form body cannot be read"); }
  }
  // any other type outside the contract API is a document's or note's text (a note save): not a path
  return out;
}

// ── 2. the response walk ───────────────────────────────────────────────────────────────────────
async function scrub(db: Db, body: unknown, who: Identity): Promise<unknown> {
  const strings: string[] = [];
  stringsOf(body, strings);
  const docPaths = new Set<string>();
  const uuids = new Set<string>();
  for (const s of strings) {
    for (const p of documentPathsIn(s)) docPaths.add(p);
    for (const m of s.matchAll(UUID_IN)) uuids.add(m[0].toLowerCase());
  }
  const foreignPaths = new Set<string>();
  for (const p of docPaths) if (!(await ownsDocumentPaths(db, [p], who))) foreignPaths.add(p);
  let foreignIdeas = new Set<string>();
  if (uuids.size) {
    const rows = await db.query<{ id: string }>(
      `SELECT id::text AS id FROM public.ideas WHERE id::text = ANY($1) AND owner_sub <> $2`, [[...uuids], who.sub],
    );
    foreignIdeas = new Set(rows.map((r) => r.id.toLowerCase()));
  }
  if (!foreignPaths.size && !foreignIdeas.size) return body;
  const foreignIn = (s: string) => documentPathsIn(s).some((p) => foreignPaths.has(p));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (foreignIdeas.has(v.toLowerCase())) return null;
      if (foreignIn(v)) return OTHER;
      // an id inside a longer string (idea:<id>, a sentence): the id itself is withheld
      return foreignIdeas.size ? v.replace(UUID_IN, (m) => foreignIdeas.has(m.toLowerCase()) ? "(another user's refinery)" : m) : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const names = Object.values(o).some((x) => typeof x === "string" && foreignIn(x));
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) {
        // an object that names another user's document does not carry its title either
        if (names && (k === "title" || k === "name")) continue;
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(body);
}

const OFF = () => (Deno.env.get("WORKSPACE_RESPONSE_WALK") ?? "").trim().toLowerCase() === "off";

// The backstop over an event stream: each `data:` line holding JSON is walked as a JSON body is.
function scrubStream(db: Db, body: ReadableStream<Uint8Array>, who: Identity): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  const line = async (l: string) => {
    const m = /^data:\s?(.*)$/.exec(l);
    if (!m) return l;
    try {
      const v = JSON.parse(m[1]);
      const out = await scrub(db, v, who);
      return out === v ? l : `data: ${JSON.stringify(out)}`;
    } catch {
      // not JSON: a path in plain text is withheld wholesale if it is another user's
      const paths = documentPathsIn(m[1]);
      return paths.length && !(await ownsDocumentPaths(db, paths, who)) ? `data: ${OTHER}` : l;
    }
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      const done: string[] = [];
      for (const p of parts) done.push(await line(p));
      if (done.length) ctl.enqueue(enc.encode(done.join("\n") + "\n"));
    },
    async flush(ctl) {
      if (buf) ctl.enqueue(enc.encode(await line(buf)));
    },
  }));
}

export function ownerScope(db: Db) {
  return async (c: Context, next: Next) => {
    const who = await identityOf(c);
    // rw-identity3 (B1b): the path the seam judged and the router routed, never new URL(...).pathname
    const route = seamPath(c);
    let strings: string[];
    try {
      strings = await requestStrings(c);
    } catch (e) {
      if (e instanceof BodyRefused) return c.json({ error: e.message }, e.status);
      throw e;
    }
    const paths = strings.flatMap(documentPathsIn);
    if (paths.length && !(await ownsDocumentPaths(db, [...new Set(paths)], who))) {
      return c.json({ error: "no such document" }, 404);
    }
    await next();
    // rw-identity: the sign-in routes answer the caller's own identity and, to an admin, the audit
    // log (whose routes may name any user's document - the log must show them as they were)
    if (OFF() || route.startsWith("/workbench/auth/")) return;
    const type = c.res.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream") && c.res.body) {
      const headers = new Headers(c.res.headers);
      headers.delete("content-length");
      c.res = new Response(scrubStream(db, c.res.body, who), { status: c.res.status, headers });
      return;
    }
    if (!type.includes("json")) return;
    let body: unknown;
    try { body = await c.res.clone().json(); } catch { return; }
    const scrubbed = await scrub(db, body, who);
    if (scrubbed === body) return;
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    headers.delete("etag");
    c.res = new Response(JSON.stringify(scrubbed), { status: c.res.status, headers });
  };
}
