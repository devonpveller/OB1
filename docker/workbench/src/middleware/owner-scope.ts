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
// 2. Responses. Every JSON response is walked: a string naming another user's document path is
//    replaced (and an object carrying it loses its title), and a string that is another user's
//    refinery (idea) id becomes null. A route's own SQL filters too (timeline, notifications); this
//    is the net under all of them, nested fields included.
import type { Context, Next } from "hono";
import type { Db } from "../contracts/db.ts";
import { identityOf, type Identity } from "./identity.ts";

const OTHER = "(another user's document)";
// a body field holding a document's TEXT, not a path: never searched (a document may quote a path)
const TEXT_FIELDS = new Set(["content", "body", "text", "markdown", "exact", "note", "summary"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// the documents API's own URL prefixes are routes, not vault paths
const ROUTE_PREFIX = /^\/workbench\/(?:documents|contract\/documents)(?=\/|$)/;

function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

// Every documents/... path named inside `s` (after `..` resolution: notes/../documents/x is one).
export function documentPathsIn(s: string): string[] {
  const found: string[] = [];
  const t = s.replace(/\\/g, "/");
  const re = /(^|[\/\s"'=:(,])((?:\.{1,2}\/)*documents\/[^\s"'?&#,)]*)/g;
  for (const m of t.matchAll(re)) found.push(m[2]);
  // a path that only becomes documents/ once its `..` segments are resolved
  for (const m of t.matchAll(/[^\s"'?&#,]*\.\.[^\s"'?&#,]*/g)) {
    const n = normalize(m[0]);
    if (n.startsWith("documents/")) found.push(n);
  }
  return [...new Set(found.map(normalize).filter((p) => p.startsWith("documents/") && p.length > "documents/".length))];
}

// Is `rel` (a normalized documents/... path) the caller's? Their own directory, or a pre-P2b
// documents/<file> (no owner directory; also its .trash/.archive forms) whose listing row is theirs.
async function ownsAll(db: Db, paths: string[], who: Identity): Promise<boolean> {
  const legacy: string[] = [];
  for (const p of paths) {
    const seg = p.split("/")[1] ?? "";
    if (seg === who.key) continue;
    if (seg.endsWith(".md") || seg.startsWith(".")) legacy.push(p);
    else return false;
  }
  if (!legacy.length) return true;
  const live = legacy.map((p) => p.replace(/^documents\/\.(?:trash|archive)\//, "documents/"));
  const rows = await db.query<{ path: string }>(
    `SELECT path FROM public.user_document_listings WHERE owner_sub = $2 AND (path = ANY($1) OR path = ANY($3))`,
    [legacy, who.sub, live],
  );
  const mine = new Set(rows.map((r) => r.path));
  return legacy.every((p, i) => mine.has(p) || mine.has(live[i]));
}

function stringsOf(v: unknown, out: string[], key = ""): void {
  if (typeof v === "string") {
    if (!TEXT_FIELDS.has(key)) out.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) stringsOf(x, out, key);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) stringsOf(x, out, k);
  }
}

async function requestStrings(c: Context): Promise<string[]> {
  const url = new URL(c.req.url);
  const out: string[] = [];
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep raw */ }
  out.push(path.replace(ROUTE_PREFIX, ""));
  for (const [, v] of url.searchParams) out.push(v);
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return out;
  const type = c.req.header("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      stringsOf(await c.req.raw.clone().json(), out);
    } else if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
      for (const [k, v] of (await c.req.raw.clone().formData()).entries()) if (typeof v === "string" && !TEXT_FIELDS.has(k)) out.push(v);
    }
  } catch { /* an unparseable body is the route's to refuse */ }
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
    if (UUID.test(s)) uuids.add(s.toLowerCase());
  }
  const foreignPaths = new Set<string>();
  for (const p of docPaths) if (!(await ownsAll(db, [p], who))) foreignPaths.add(p);
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
      return foreignIn(v) ? OTHER : v;
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

export function ownerScope(db: Db) {
  return async (c: Context, next: Next) => {
    const who = await identityOf(c);
    const paths = (await requestStrings(c)).flatMap(documentPathsIn);
    if (paths.length && !(await ownsAll(db, [...new Set(paths)], who))) {
      return c.json({ error: "no such document" }, 404);
    }
    await next();
    const type = c.res.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) return;
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
