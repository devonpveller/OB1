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
 *   - GET /research/jobs lists only the viewer's jobs (research_prompts.owner_sub = the viewer) and
 *     jobs with no recorded owner (before rw-identity: shared, as the workbench treats them).
 *   - a job read by id (detail, stream, tree, events) stays readable - research output is shared - but
 *     when the job's original prompt belongs to ANOTHER USER (not a service), every string field that
 *     carries that prompt (or its first 40 characters: the list truncates) is OMITTED, at any depth:
 *     progress, result, error, branch queries, event payloads. Omitted, not replaced.
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
   SELECT x.prompt FROM f, (SELECT prompt FROM o
                            UNION ALL SELECT j.query FROM research_jobs j JOIN r ON coalesce(j.root_job_id, j.id) = r.root) x
    WHERE f.foreign_ AND x.prompt IS NOT NULL AND x.prompt <> ''`;

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
