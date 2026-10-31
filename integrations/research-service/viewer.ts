/**
 * Whose jobs a READ of the research service shows (rw-identity round 2; 07-MULTI-USER: the user's
 * original prompt and its link to the user are private, everything research produces is shared).
 *
 * The viewer of a read is decided by the caller's KEY, as the origin is (origin.ts):
 *   - Open WebUI's key (origin owui) and the workspace's key (origin workspace) may name the user they
 *     read for, in the `x-on-behalf-of` header (the OWUI tool sends its chatting user's Authentik
 *     subject; the workbench its signed-in user's). Without it they read as their service.
 *   - every other key reads as its service, `service:<caller>`; naming a user is refused (403).
 * What a viewer gets:
 *   - GET /research/jobs lists only the viewer's jobs (research_prompts.owner_sub = the viewer) and,
 *     when the viewer is WORKSPACE_DEFAULT_SUB, jobs with no recorded owner (round 3).
 *   - a job read by id (detail, stream, tree, events) stays readable - research output is shared - but
 *     when the job's original prompt belongs to ANOTHER USER (not a service), every string field that
 *     carries that prompt (or its first 40 characters: the list truncates) is OMITTED, at any depth:
 *     progress, result, error, branch queries, event payloads. Omitted, not replaced.
 * Round 4 (tester attempt 1, Case 7: prompt FRAGMENTS - a prefix, a case change, an escape, a middle
 * chunk - survive any matching): a non-owner gets an ALLOW-LIST instead. Detail and stream: id, status,
 * queue position/depth/eta and, of the result, the shared research output only - the grounded report
 * (synthesis, when the run found something), its cited sources (title, url) and claims (id, text), the
 * outcome and report type. Tree: ids, kinds, steps and status. Events: ids, kinds, steps and time.
 * Every other field is omitted; the prompt omission still runs over what is left.
 */
import type { Caller } from "./origin.ts";
import { ON_BEHALF_ORIGINS } from "./origin.ts";

export const READ_ON_BEHALF_ORIGINS: ReadonlySet<string> = new Set([...ON_BEHALF_ORIGINS, "workspace"]);

export type Viewer = { sub: string } | { error: string; status: 400 | 403 };

export function readViewer(caller: Caller, header: string | null): Viewer {
  const raw = (header ?? "").trim();
  const svc = `service:${caller.name}`;
  if (!raw) return { sub: svc };
  if (caller.shared || !READ_ON_BEHALF_ORIGINS.has(caller.origin)) {
    return { error: "x-on-behalf-of is accepted only from Open WebUI's or the workspace's caller key", status: 403 };
  }
  if (raw.length > 255 || /[\u0000-\u001f\u007f]/.test(raw) || /^(service|system|anonymous):/i.test(raw)) {
    return { error: "x-on-behalf-of is not a usable subject id", status: 400 };
  }
  return { sub: raw };
}

/** SQL: job `j` is listed for viewer `param` - its root's prompt is the viewer's, or it has no recorded
 *  owner and the viewer is WORKSPACE_DEFAULT_SUB (`dflt`; blank = an ownerless job is listed for nobody).
 *  rw-identity round 3 (operator 2026-10-28: all existing private content is the one operator's). */
export const LISTED_FOR = (j: string, param: string, dflt: string) =>
  `(EXISTS (SELECT 1 FROM research_prompts p WHERE p.job_id = coalesce(${j}.root_job_id, ${j}.id) AND p.owner_sub = ${param})
     OR (NOT EXISTS (SELECT 1 FROM research_prompts p WHERE p.job_id = coalesce(${j}.root_job_id, ${j}.id))
         AND ${dflt} <> '' AND ${param} = ${dflt}))`;

/** SQL ($1 job, $2 viewer, $3 WORKSPACE_DEFAULT_SUB or ''): the texts to omit - the root's prompt and
 *  every query of the tree (steer texts are the owner's too) - when the tree belongs to another USER:
 *  its root's owner is a user other than the viewer, or it has no owner and the viewer is not the
 *  default subject (no default = nobody's). Empty when the viewer may read the prompt. */
export const FOREIGN_PROMPTS_SQL =
  `WITH r AS (SELECT coalesce(root_job_id, id) AS root FROM research_jobs WHERE id = $1::uuid),
        o AS (SELECT p.owner_sub, p.prompt FROM research_prompts p JOIN r ON p.job_id = r.root),
        f AS (SELECT CASE WHEN EXISTS (SELECT 1 FROM o)
                          THEN EXISTS (SELECT 1 FROM o WHERE o.owner_sub <> $2 AND o.owner_sub NOT LIKE 'service:%')
                          ELSE ($3 = '' OR $2 <> $3) END AS foreign_)
   SELECT f.foreign_ AS foreign_,
          coalesce((SELECT array_agg(x.prompt) FROM (SELECT prompt FROM o
                      UNION ALL SELECT j.query FROM research_jobs j JOIN r ON coalesce(j.root_job_id, j.id) = r.root) x
                     WHERE x.prompt IS NOT NULL AND x.prompt <> ''), '{}') AS prompts
     FROM f`;

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** The job as a non-owner reads it (detail and stream): the allow-list above. */
export function sharedJobView(job: Obj): Obj {
  const r = job.result && typeof job.result === "object" ? job.result as Obj : null;
  const result = r === null ? null : {
    outcome: str(r.outcome),
    report_type: str(r.report_type),
    synthesis: r.outcome === "no_relevant_sources" ? "" : (str(r.synthesis) ?? ""),
    cited_sources: Array.isArray(r.cited_sources)
      ? r.cited_sources.map((s) => ({ title: str((s as Obj)?.title), url: str((s as Obj)?.url) })) : [],
    reuse_claims: Array.isArray(r.reuse_claims)
      ? r.reuse_claims.map((c) => ({ id: str((c as Obj)?.id) ?? String((c as Obj)?.id ?? ""), text: str((c as Obj)?.text) })) : [],
  };
  return {
    id: job.id, status: job.status, queue_position: job.queue_position ?? null, queue_depth: job.queue_depth ?? null,
    eta_seconds: job.eta_seconds ?? null, result,
  };
}

/** The tree as a non-owner reads it: its shape and state, no text. */
export function sharedTree(t: Obj): Obj {
  const branches = Array.isArray(t.branches) ? t.branches as Obj[] : [];
  return {
    root_job_id: t.root_job_id,
    // round 5: no step ids - they serve only the owner's steering
    branches: branches.map((b) => ({ id: b.id, parent_job_id: b.parent_job_id, branch_kind: b.branch_kind, status: b.status })),
  };
}

/** The events as a non-owner reads them: what kind, when - no step id (it serves only the owner's
 *  steering, round 5), no trail, no payload. */
export function sharedEvents(rows: Obj[]): Obj[] {
  return rows.map((e) => ({ id: e.id, job_id: e.job_id, root_job_id: e.root_job_id, type: e.type, kind: e.kind, created_at: e.created_at }));
}

/** SQL ($1 job, $2 viewer, $3 WORKSPACE_DEFAULT_SUB or ''): may the viewer ACT on the job - steer it,
 *  cancel it (round 5, tester attempt 2)? Only its owner: the identity its root's research_prompts row
 *  names (a user, or the service that started it), or - for a job with no recorded owner - the default
 *  subject. Anyone else is answered as if the job did not exist. */
/* rw-p4b-sessions (operator 2026-10-30, option "Admins"): $4 = the actor is an admin, which only the
 *  workspace's key may assert (actorOf). An admin may act on a job a SERVICE owns (service:<caller>,
 *  e.g. a Mattermost / agent-org job); a USER's job stays its owner's alone, admin or not. */
export const MAY_ACT_SQL =
  `WITH r AS (SELECT coalesce(root_job_id, id) AS root FROM research_jobs WHERE id = $1::uuid),
        o AS (SELECT p.owner_sub FROM research_prompts p JOIN r ON p.job_id = r.root)
   SELECT EXISTS (SELECT 1 FROM r) AND CASE WHEN EXISTS (SELECT 1 FROM o)
                                            THEN EXISTS (SELECT 1 FROM o WHERE o.owner_sub = $2 OR ($4::boolean AND o.owner_sub LIKE 'service:%'))
                                            ELSE ($3 <> '' AND $2 = $3) END AS ok`;

/**
 * Who ACTS on a job (rw-p4b-sessions): steer and cancel record their actor (research_steers.actor_sub).
 * By default the actor is the viewer (the user named by x-on-behalf-of, or the caller's service).
 * Only the workspace's own key (origin workspace, not the shared key) may say more, and only together
 * with the user it acts for: `x-actor-sub` (who acted: an admin while impersonating differs from the
 * subject) and `x-actor-admin: 1` (the actor is an admin - the workbench reads it from the signed-in
 * token on every request). Any other key naming either is refused (403); a malformed value is 400.
 */
export type Actor = { actor: string; admin: boolean } | { error: string; status: 400 | 403 };

export function actorOf(caller: Caller, header: (name: string) => string | null, viewerSub: string): Actor {
  const sub = (header("x-actor-sub") ?? "").trim();
  const adm = header("x-actor-admin");
  if (!sub && adm === null) return { actor: viewerSub, admin: false };
  if (caller.shared || caller.origin !== "workspace") {
    return { error: "x-actor-sub / x-actor-admin are accepted only from the workspace's caller key", status: 403 };
  }
  if (!(header("x-on-behalf-of") ?? "").trim()) return { error: "x-actor-* needs the user it acts for (x-on-behalf-of)", status: 400 };
  if (adm !== null && adm !== "1") return { error: "x-actor-admin is 1 or absent", status: 400 };
  if (sub && (sub.length > 255 || /[\u0000-\u001f\u007f]/.test(sub) || /^(service|system|anonymous):/i.test(sub))) {
    return { error: "x-actor-sub is not a usable subject id", status: 400 };
  }
  return { actor: sub || viewerSub, admin: adm === "1" };
}

function needles(prompts: string[]): string[] {
  const out = new Set<string>();
  for (const p of prompts) {
    const t = p.trim();
    if (!t) continue;
    out.add(t);
    if (t.length > 40) out.add(t.slice(0, 40));
  }
  return [...out];
}

/** The value with every string that carries one of `prompts` omitted (object keys dropped, array items removed). */
export function omitPrompts<T>(value: T, prompts: string[]): T {
  const n = needles(prompts);
  if (!n.length) return value;
  const carries = (s: string) => n.some((x) => s.includes(x));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return carries(v) ? undefined : v;
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== undefined);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const w = walk(x);
        if (w !== undefined) o[k] = w;
      }
      return o;
    }
    return v;
  };
  return walk(value) as T;
}
