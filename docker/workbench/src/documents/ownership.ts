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
import { ENCODED_DOTS } from "../util/paths.ts";
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
// job `j` has no recorded owner (its root has no research_prompts row) and that owner is not `sub`.
// rw-boundary-core (plan 09 2.7): a DERIVED job is nobody's - the request boundary formed its question from public
// words only (slot 420 refuses it a prompt row), so it is shown to everyone, never "ownerless foreign".
export const OWNERLESS_FOREIGN = (j: string, sub: string, adminSees = false) => {
  const o = ownerlessOwner();
  const notMine = adminSees ? "false" : o === null ? "true" : `(${sub} <> ${lit(o)})`;
  return `(${j}.request_kind <> 'derived' AND NOT EXISTS (SELECT 1 FROM public.research_prompts own_r WHERE own_r.job_id IN (${j}.id, ${ROOT(j)})) AND ${notMine})`;
};

// rw-boundary-core (plan 09 2.7, decision D5): a SERVICE's prompt (owner_sub service:<caller>) is shared only on a
// job the research service recorded as request_kind 'service' (a RESEARCH_SERVICE_CALLERS caller: no personal data),
// or to an admin (the signed-in admin flag the identity seam records in workspace_users; an admin impersonating
// someone reads as that someone). Every other service:-owned prompt - the shared key's above all - is hidden.
export const SERVICE_PROMPT_SHARED = (j: string, sub: string) =>
  `(${j}.request_kind = 'service' OR EXISTS (SELECT 1 FROM public.workspace_users own_u WHERE own_u.sub = ${sub} AND own_u.is_admin))`;

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

// rw-held-owner-scope round 2: a reference RECORD whose target is another user's HELD source. `src` is the
// SQL expression of the record's source id. A held row that exists, is not the caller's, and has no admitted
// source behind it makes the record unreadable: the caller meets it as a MISSING record (never as an erased
// one). No held row at all (a genuinely erased source) is NOT foreign. One predicate for every record lookup.
export const FOREIGN_HELD_TARGET = (src: string, sub: string) =>
  `(EXISTS (SELECT 1 FROM public.held_sources fh WHERE fh.id::text = (${src})::text AND ${FOREIGN_IDEA("fh.refinery_id", sub)})
    AND NOT EXISTS (SELECT 1 FROM public.sources fs WHERE fs.id::text = (${src})::text))`;

// research job `j` belongs to another user (see the header).
// rw-report-isolation: ALSO when it is the research of another user's idea by the database's one rule
// (research_job_report_owner, slot 390: the idea's branch, its refinery, a revision stamped with the job, or the root
// of its tree) - an idea job tied to its idea only by a revision stamp carries no refinery_id, and its result holds
// the idea's private report. An idea job whose idea has no owner is no one's (foreign to all).
export const FOREIGN_JOB = (j: string, sub: string, key: string, adminSees = false) =>
  `(EXISTS (SELECT 1 FROM public.research_prompts own_p WHERE own_p.job_id IN (${j}.id, ${ROOT(j)}) AND own_p.owner_sub <> ${sub}
             AND NOT (own_p.owner_sub LIKE 'service:%' AND ${SERVICE_PROMPT_SHARED(j, sub)}))
     OR ${OWNERLESS_FOREIGN(j, sub, adminSees)}
     OR ${FOREIGN_IDEA(`${j}.refinery_id`, sub)}
     OR EXISTS (SELECT 1 FROM public.research_job_report_owner(${j}.id) own_f WHERE own_f.owner_sub IS DISTINCT FROM ${sub})
     OR (${j}.inlet_ref ->> 'kind' = 'refinery' AND ${FOREIGN_IDEA(`${j}.inlet_ref ->> 'id'`, sub)})
     OR ${FOREIGN_DOC(`${j}.inlet_ref ->> 'id'`, sub, key)})`;

// The same rule in code, for a path a route is handed (holders, diff-check, export, note-history).
// Every path must be the viewer's own directory, or a pre-P2b documents/<file> (also its .trash /
// .archive form) whose listing row the viewer owns. A path outside documents/ is not per-user.
// rw-identity-harden round 2 (tester F-T1): `documents/` in ANY letter case - on a case-insensitive
// vault mount (a Windows or macOS bind) `Documents/<other>/x.md` opens the same file, so it is judged as
// a documents path; another user's key in any case is not the caller's own (only the exact key is).
// The characters documentPathsIn stops a path at (its `[^\s"'?&#,)]` class), one place for the legacy-prefix check: a character
// either cuts a scanned path or it does not, in the scanner and in that check alike (tested over every code point).
export const CUT_AFTER = /^[\s"'?&#,)]/;
// the runs between the characters that end a `..` token (no `)`: the `..` scan has never cut at one)
const CUT_RUN = /[\s"'?&#,]+/;
const isDocumentsPath = (p: string) => p.slice(0, DOCUMENTS_ROOT.length + 1).toLowerCase() === `${DOCUMENTS_ROOT}/`;

export async function ownsDocumentPaths(db: Db, paths: string[], who: Viewer): Promise<boolean> {
  const legacy: string[] = [];
  const bare: string[] = []; // exactly documents/<own key>: the caller's directory - or the cut of someone's file name (review B1)
  for (const raw of paths) {
    if (!isDocumentsPath(raw)) continue;
    // review 2 / B2: the listing rows (and so every comparison below) are lower-case `documents/`; a path that reached here through
    // `Documents/` or `DOCUMENTS/` (case-insensitive mount) is judged as the same path with the root lower-cased, the rest byte-exact
    const p = `${DOCUMENTS_ROOT}/${raw.slice(DOCUMENTS_ROOT.length + 1)}`;
    const parts = p.split("/");
    const seg = parts[1] ?? "";
    if (seg === who.key) {
      // the own-key skip is for documents/<key>/... only: the key with nothing after it can be the scanner's cut of
      // `documents/<key> notes.md` (a legacy root file of someone else), so it is a prefix like any other
      if (parts.length <= 2) bare.push(p);
      continue;
    }
    if (seg.endsWith(".md") || seg.startsWith(".")) legacy.push(p);
    else return false;
  }
  if (!legacy.length && !bare.length) return true;
  const live = legacy.map((p) => p.replace(/^documents\/\.(?:trash|archive)\//i, "documents/"));
  if (legacy.length) {
    const rows = await db.query<{ path: string }>(
      `SELECT path FROM public.user_document_listings WHERE owner_sub = $2 AND (path = ANY($1) OR path = ANY($3))`,
      [legacy, who.sub, live],
    );
    const mine = new Set(rows.map((r) => r.path));
    if (!legacy.every((p, i) => mine.has(p) || mine.has(live[i]))) return false;
  }
  // rw-doc-path-spaces: a path the scanner cut short (a space or " ' ? & # , ) in a file name) reaches here as its own
  // prefix. If that prefix is the caller's file but it is also the start, at one of those characters, of ANOTHER
  // user's path, the full path the route will read may be theirs: refuse, exactly as for a missing document.
  // The database only finds the other owners' paths that START with the prefix (starts_with is exact bytes); WHETHER the next
  // character is one the scanner stops at is decided HERE, by the scanner's own class (CUT_AFTER), because Postgres's \s
  // and JavaScript's \s are different sets (U+00A0, U+FEFF, U+202F, U+2007 ... are whitespace only to JavaScript).
  const prefixes = [...new Set([...legacy, ...live, ...bare])];
  const others = await db.query<{ path: string }>(
    `SELECT path FROM public.user_document_listings WHERE owner_sub <> $2
       AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS pre WHERE starts_with(path, pre) AND length(path) > length(pre))`,
    [prefixes, who.sub],
  );
  return !others.some((o) => prefixes.some((pre) => o.path.startsWith(pre) && CUT_AFTER.test(o.path.slice(pre.length))));
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

// A field known to hold EXACTLY ONE document path (flag from.ref): the whole string is the path - never scanned,
// so a space or & , ' ( ) # ? in a folder name cannot cut it short (rw-doc-path-spaces). Returns the path, or null
// when it is not a plain documents/<...> path: no `..`/`.` segment, no empty segment (`//`, trailing `/`), no
// control character, nothing at or above the documents/ root. It resolves nothing: a path that would need
// resolving is refused, not rewritten, so the string judged is the string stored and read back.
export function singleDocumentPath(ref: string): string | null {
  // deno-lint-ignore no-control-regex
  if (typeof ref !== "string" || /[\x00-\x1f\x7f]/.test(ref)) return null;
  const p = ref.replace(/\\/g, "/");
  if (!p.startsWith(`${DOCUMENTS_ROOT}/`) || p.length <= DOCUMENTS_ROOT.length + 1) return null;
  // no `.`, `..` or empty segment, nor one that decodes to dots (%2e, %252e ...): the same refusal as safeRelPath
  if (p.split("/").some((seg) => seg === "" || seg === "." || seg === ".." || ENCODED_DOTS.test(seg))) return null;
  return p;
}

// Every documents/... path named inside a string (after `..` resolution: notes/../documents/x is one).
export function documentPathsIn(s: string): string[] {
  const found: string[] = [];
  const t = s.replace(/\\/g, "/");
  // (rw-body-size-stall: this was `(^|[\/\s"'=:(,])((?:\.{1,2}\/)*documents\/...)`. The `(?:\.{1,2}\/)*` run is read again from every
  // `/` of a long `../../..` string, which is again the square of the length. Each of its units ends in `/`, itself a start
  // character, so a `documents/` after such a run is found by the plain start just before it: the same path once
  // normalize() has dropped the leading `./` and `../` units, with the same end.)
  const re = /(^|[\/\s"'=:(,])(documents\/[^\s"'?&#,)]*)/gi;
  for (const m of t.matchAll(re)) found.push(m[2]);
  // a path that only becomes documents/ once its `..` segments are resolved
  // (rw-body-size-stall: the scan was `/[^\s"'?&#,]*\.\.[^\s"'?&#,]*/g`, which retries from every character of a long
  // token with no `..` and so grew with the square of the length - 40 KB took 4.6 s, 160 KB over 30 s. A match of that
  // pattern is exactly one whole run of non-cut characters that contains `..`, so the runs are split once, in one pass.)
  for (const tok of t.split(CUT_RUN)) {
    if (!tok.includes("..")) continue;
    const n = normalize(tok);
    if (isDocumentsPath(n)) found.push(n);
  }
  return [...new Set(found.map(normalize).filter((p) => isDocumentsPath(p) && p.length > "documents/".length))];
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
