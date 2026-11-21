// rw-owner-private-view (plan 08 PD-PV, slot 480): the owner's private views - "My private claims" (private claims,
// and the shared claims carrying the owner's private link beside their shared grounding), search over the owner's
// moved email-body and podcast-transcript sources (text, and semantic over the kept chunk embeddings), and the owner's
// seeded research jobs with their original text (through PD1's inlet_private_job).
//
// The rules, all of them here or in the SQL:
//   * whose: the identity seam's subject ONLY (seamIdentity), and only when that identity is eligible
//     (identity/private_view.ts: signed in as themselves, or the configured default identity while sign-in is off).
//     No route takes a subject; an extra sub/owner/user parameter is ignored. Anyone else - another user, an admin who
//     is not the owner or impersonates them, a service, an on-behalf caller, a header identity - gets the EMPTY answer
//     (a list) or the unknown-id 404, with no count, and never causes a query or an embedding call.
//   * USER_ONLY (middleware/identity.ts) adds contract/private: a service key gets the seam's generic 403 first.
//   * no MCP tool: no op here carries x-mcp-tool (generated/mcp-tools.json is unchanged).
//   * never cached: every answer is Cache-Control: no-store, private (the viewer's forwarder passes it through).
//   * never shared: these reads feed nothing - no wiki, digest, research, shared search or room context reads them,
//     and no write path starts here (GET only).
//   * semantic search embeds the QUERY only, with the workbench's own key (deps.privateEmbed: PRIVATE_EMBEDDING_API_KEY,
//     no MCP fallback); blank or failing = 503 "search is not available", the same for everyone.
import type { Context } from "hono";
import { createRoute, z } from "../deps.ts";
import { seamIdentity } from "../../middleware/identity.ts";
import { privateEligible, type PrivateViewConfig, privateViewConfig, signInRequired } from "../../identity/private_view.ts";
import * as pv from "../repo/private.ts";
import { limit, pathParam, queryParam, UUID_RE } from "../schemas/common.ts";
import { PrivateClaimOne, PrivateClaims, PrivateHits, PrivateJobs, PrivateJobText } from "../schemas/private.ts";
import { EX } from "../schemas/examples.ts";
import { type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";

const T = ["owner-private (rw-owner-private-view)"];
const NOT_FOUND = { error: "not found" };
const UNAVAILABLE = { error: "search is not available" };

const noStore = (c: Context) => c.header("cache-control", "no-store, private");

// a page cursor: OPAQUE to clients (base64url of "<timestamp>|<uuid>"). The timestamp is the row's created_at at the
// database's own (microsecond) precision, as text (cursor_at): a millisecond Date would skip rows tied with, or inside the
// same millisecond as, the last row of a page. A cursor that does not parse is ignored (the first page).
const b64u = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const AT_RE = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d{1,6})?(Z|[+-]\d\d(:?\d\d)?)$/;
function cursor(raw: string | undefined): pv.Cursor | null {
  const t = (raw ?? "").trim();
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(t)) return null;
  let plain: string;
  try {
    plain = atob(t.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  const i = plain.indexOf("|");
  const at = plain.slice(0, i), id = plain.slice(i + 1);
  if (i < 0 || !AT_RE.test(at) || !UUID_RE.test(id)) return null;
  return { at, id };
}
// the next-page cursor from the rows' internal cursor_at, and the rows as the client sees them (cursor_at removed)
function page<T extends { id: string; cursor_at?: string }>(rows: T[], n: number): { rows: Omit<T, "cursor_at">[]; next: string | null } {
  const last = rows[rows.length - 1];
  const next = rows.length >= n && last?.cursor_at ? b64u(`${last.cursor_at}|${last.id}`) : null;
  return { rows: rows.map(({ cursor_at: _drop, ...r }) => r), next };
}
const clamp = (raw: string | undefined, def: number, max: number) => Math.min(max, Math.max(1, parseInt(raw ?? "", 10) || def));
const word = (raw: string | undefined, allowed: string[], def: string) => allowed.includes((raw ?? "").trim()) ? (raw ?? "").trim() : def;

export function registerPrivate(app: ContractApp, deps: ContractDeps) {
  const cfg: PrivateViewConfig = deps.privateView ?? privateViewConfig();
  // the eligible subject, or null (the empty answer)
  const owner = (c: Context): string | null => {
    const who = seamIdentity(c);
    return privateEligible(who, cfg) ? who!.sub : null;
  };
  const signIn = (c: Context) => signInRequired(seamIdentity(c), cfg) ? { sign_in_required: true } : {};

  op(app, createRoute({
    method: "get", path: `${PREFIX}/private/claims`, operationId: "privateClaims", tags: T,
    summary: "My private claims: the caller's own private claims and the shared claims carrying their private link (the signed-in owner only; anyone else: empty)",
    request: {
      query: z.object({
        q: queryParam("q", "fixture", "text filter (case-insensitive)"),
        kind: queryParam("kind", "all", "all | private | mixed"),
        source_id: queryParam("source_id", "f5000000-0000-4000-8000-000000000001", "only the claims of this private source"),
        before: queryParam("before", "", "the cursor a previous page returned as next"),
        limit: limit(50, 200),
      }),
    },
    responses: { 200: json(PrivateClaims, EX.privateClaims, "newest first; no count"), ...errors },
  }), async (c) => {
    noStore(c);
    try {
      const sub = owner(c);
      if (!sub) return send(c, PrivateClaims, { private: true, claims: [], next: null, ...signIn(c) });
      const q = c.req.valid("query");
      const n = clamp(q.limit, 50, 200);
      const source = q.source_id && UUID_RE.test(q.source_id) ? q.source_id : null;
      if (q.source_id && !source) return send(c, PrivateClaims, { private: true, claims: [], next: null });
      const rows = await pv.claims(deps.db, sub, { q: (q.q ?? "").slice(0, 200) || null, kind: word(q.kind, ["all", "private", "mixed"], "all"), source, before: cursor(q.before), limit: n });
      const pg = page(rows, n);
      return send(c, PrivateClaims, { private: true, claims: pg.rows, next: pg.next });
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/private/claims/{id}`, operationId: "privateClaim", tags: T,
    summary: "one of my private (or mixed) claims, with its private sources beside its shared ones; anyone else: the unknown-id 404",
    request: { params: z.object({ id: pathParam("id", "f5100000-0000-4000-8000-000000000001") }) },
    responses: { 200: json(PrivateClaimOne, EX.privateClaim, "the claim"), ...errors },
  }), async (c) => {
    noStore(c);
    try {
      const sub = owner(c);
      const id = c.req.valid("param").id;
      if (!sub || !UUID_RE.test(id)) return c.json(NOT_FOUND, 404);
      const rows = await pv.claims(deps.db, sub, { id, limit: 1 });
      if (!rows[0]) return c.json(NOT_FOUND, 404);
      const { cursor_at: _drop, ...claim } = rows[0];
      return send(c, PrivateClaimOne, { private: true, claim });
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/private/sources`, operationId: "privateSources", tags: T,
    summary: "search my moved sources (email bodies, podcast transcripts): text, or semantic over their kept embeddings (the query alone is embedded, with the workbench's own key)",
    request: {
      query: z.object({
        q: queryParam("q", "fixture", "at least 2 characters"),
        mode: queryParam("mode", "text", "text | semantic"),
        kind: queryParam("kind", "all", "all | email | podcast"),
        limit: limit(20, 50),
      }),
    },
    responses: {
      200: json(PrivateHits, EX.privateHits, "best first; no count"),
      503: { content: { "application/json": { schema: z.object({ error: z.string() }) } }, description: "semantic search is not available (no key, or the embedder failed): the same for everyone" },
      ...errors,
    },
  }), async (c) => {
    noStore(c);
    try {
      const q = c.req.valid("query");
      const mode = word(q.mode, ["text", "semantic"], "text");
      const sub = owner(c);
      if (!sub) return send(c, PrivateHits, { private: true, mode, hits: [], ...signIn(c) });
      const text = (q.q ?? "").trim().slice(0, 200);
      const kind = word(q.kind, ["all", "email", "podcast"], "all");
      const n = clamp(q.limit, 20, 50);
      if (text.length < 2) return send(c, PrivateHits, { private: true, mode, hits: [] });
      if (mode === "text") return send(c, PrivateHits, { private: true, mode, hits: await pv.textHits(deps.db, sub, text, kind, n) });
      if (!deps.privateEmbed) return c.json(UNAVAILABLE, 503);
      if (!(await pv.hasSources(deps.db, sub))) return send(c, PrivateHits, { private: true, mode, hits: [] });
      let vec: number[];
      try {
        vec = await deps.privateEmbed(text);
      } catch {
        return c.json(UNAVAILABLE, 503);
      }
      return send(c, PrivateHits, { private: true, mode, hits: await pv.knnHits(deps.db, sub, vec, kind, n) });
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/private/jobs`, operationId: "privateJobs", tags: T,
    summary: "my research jobs seeded with my private material, with their original question (read through PD1's inlet_private_job)",
    request: { query: z.object({ before: queryParam("before", "", "the cursor a previous page returned as next"), limit: limit(50, 200) }) },
    responses: { 200: json(PrivateJobs, EX.privateJobs, "newest first; no count"), ...errors },
  }), async (c) => {
    noStore(c);
    try {
      const sub = owner(c);
      if (!sub) return send(c, PrivateJobs, { private: true, jobs: [], next: null, ...signIn(c) });
      const q = c.req.valid("query");
      const n = clamp(q.limit, 50, 200);
      const rows = await pv.jobs(deps.db, sub, cursor(q.before), n);
      const pg = page(rows, n);
      return send(c, PrivateJobs, { private: true, jobs: pg.rows, next: pg.next });
    } catch (e) {
      return fail(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${PREFIX}/private/jobs/{id}`, operationId: "privateJob", tags: T,
    summary: "one of my seeded jobs' own text - question, result, progress, error - through PD1's inlet_private_job; anyone else: the unknown-id 404",
    request: { params: z.object({ id: pathParam("id", "f5200000-0000-4000-8000-000000000001") }) },
    responses: { 200: json(PrivateJobText, EX.privateJob, "the job's own text"), ...errors },
  }), async (c) => {
    noStore(c);
    try {
      const sub = owner(c);
      const id = c.req.valid("param").id;
      if (!sub || !UUID_RE.test(id)) return c.json(NOT_FOUND, 404);
      const j = await pv.job(deps.db, sub, id);
      if (!j) return c.json(NOT_FOUND, 404);
      return send(c, PrivateJobText, { private: true, job: { id, ...j } });
    } catch (e) {
      return fail(c, e);
    }
  });
}
