// Ownership at the query (rw-p2b-workspace round 3, tester attempt 2 F7): per-user front-end context
// is filtered by the request's subject_sub WHERE IT IS READ - in SQL and in the repositories - so a
// row or field of another user is never fetched, whatever shape (JSON, an event stream, a count)
// carries the answer out. The owner-scope response walk (middleware/owner-scope.ts) stays only as a
// backstop under these.
//
// Per user (07-MULTI-USER, operator 2026-10-28): user documents (documents/<key>/..., or a pre-P2b
// documents/<file> whose listing row the user owns), ideas (refineries) and membership of them, the
// ORIGINAL prompt and its link to the user. Shared: everything research produces.
//
// A research job is research output: shared. Every user sees it in lists and can open it; its
// PRIVATE fields - the original prompt (query), what it was started from (inlet_ref), which refinery
// it belongs to (refinery_id) and the chat thread (thread_id) - are answered to its owner only and
// are absent (null / "") for anyone else. A job is another user's when that user's original prompt
// is recorded for it (research_prompts), or its refinery or inlet document is another user's.
// rw-identity: a job started from Open WebUI on behalf of a user carries that user's research_prompts
// row (the research service writes it, origin owui only); agent-started research is recorded under a
// service identity (owner_sub service:<caller>) - a service is not a user, so its prompt is shared.
import type { Context, Next } from "hono";
import type { Db } from "../contracts/db.ts";
import { DOCUMENTS_ROOT } from "./paths.ts";
import { identityConfig } from "../middleware/identity.ts";

// rw-identity round 3 (operator 2026-10-28: all existing private content is the one operator's): who
// owns a research job with no recorded owner (started before rw-identity; init-identity.sql back-fills
// them when WORKSPACE_DEFAULT_SUB is known at deploy). WORKSPACE_DEFAULT_SUB when set; unset and no
// sign-in = the one default identity (exactly the single-user behaviour); unset with sign-in = nobody
// (null) - then only an admin, not impersonating, reads them.
export function ownerlessOwner(env = (k: string) => Deno.env.get(k)): string | null {
  const d = (env("WORKSPACE_DEFAULT_SUB") ?? "").trim();
  if (d) return d;
  const cfg = identityConfig(env);
  return cfg.signIn ? null : cfg.defaultSub;
}
export function adminSeesOwnerless(who: unknown): boolean {
  const w = who as { admin?: boolean; impersonating?: unknown };
  return !!w?.admin && !w?.impersonating && ownerlessOwner() === null;
}
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ROOT = (j: string) => `coalesce(${j}.root_job_id, ${j}.id)`;
// job `j` has no recorded owner (its root has no research_prompts row) and that owner is not `sub`
export const OWNERLESS_FOREIGN = (j: string, sub: string, adminSees = false) => {
  const o = ownerlessOwner();
  const notMine = adminSees ? "false" : o === null ? "true" : `(${sub} <> ${lit(o)})`;
  return `(NOT EXISTS (SELECT 1 FROM public.research_prompts own_r WHERE own_r.job_id IN (${j}.id, ${ROOT(j)})) AND ${notMine})`;
};

// The caller as the SQL needs it: the subject (owner_sub) and its directory key in documents/.
export interface Viewer {
  sub: string;
  key: string;
}

// `p` (a text expression) is a documents/ path that is NOT the viewer's.
export const FOREIGN_DOC = (p: string, sub: string, key: string) =>
  `(COALESCE(${p}, '') LIKE '${DOCUMENTS_ROOT}/%' AND split_part(${p}, '/', 2) <> ${key}
     AND NOT EXISTS (SELECT 1 FROM public.user_document_listings own_l WHERE own_l.owner_sub = ${sub}
                      AND own_l.path IN (${p}, regexp_replace(${p}, '^${DOCUMENTS_ROOT}/\.(trash|archive)/', '${DOCUMENTS_ROOT}/'))))`;

// `id` (an expression) is an idea (refinery) another user owns.
export const FOREIGN_IDEA = (id: string, sub: string) =>
  `EXISTS (SELECT 1 FROM public.ideas own_i WHERE own_i.id::text = (${id})::text AND own_i.owner_sub <> ${sub})`;

// research job `j` belongs to another user (see the header).
export const FOREIGN_JOB = (j: string, sub: string, key: string, adminSees = false) =>
  `(EXISTS (SELECT 1 FROM public.research_prompts own_p WHERE own_p.job_id IN (${j}.id, ${ROOT(j)}) AND own_p.owner_sub <> ${sub}
             AND own_p.owner_sub NOT LIKE 'service:%')
     OR ${OWNERLESS_FOREIGN(j, sub, adminSees)}
     OR ${FOREIGN_IDEA(`${j}.refinery_id`, sub)}
     OR (${j}.inlet_ref ->> 'kind' = 'refinery' AND ${FOREIGN_IDEA(`${j}.inlet_ref ->> 'id'`, sub)})
     OR ${FOREIGN_DOC(`${j}.inlet_ref ->> 'id'`, sub, key)})`;

// The same rule in code, for a path a route is handed (holders, diff-check, export, note-history).
// Every path must be the viewer's own directory, or a pre-P2b documents/<file> (also its .trash /
// .archive form) whose listing row the viewer owns. A path outside documents/ is not per-user.
export async function ownsDocumentPaths(db: Db, paths: string[], who: Viewer): Promise<boolean> {
  const legacy: string[] = [];
  for (const p of paths) {
    if (!p.startsWith(`${DOCUMENTS_ROOT}/`)) continue;
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

function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

// Every documents/... path named inside a string (after `..` resolution: notes/../documents/x is one).
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


// A route's own check on the vault path it is handed in ?path= (export, note-history): another user's
// document is 404, as if it did not exist - the same answer the request gate gives, kept in the route
// so the route stays closed without the gate (defence in depth, round 3).
export function ownedPathParam(db: Db, whoOf: (c: Context) => Promise<Viewer>) {
  return async (c: Context, next: Next) => {
    const p = c.req.query("path") ?? "";
    if (p && !(await ownsDocumentPaths(db, documentPathsIn(p), await whoOf(c)))) {
      return c.json({ error: "no such document" }, 404);
    }
    await next();
  };
}
