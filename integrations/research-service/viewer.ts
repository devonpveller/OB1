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

/** SQL: job `j` is listed for viewer $n - its prompt is the viewer's, or it has no recorded owner. */
export const LISTED_FOR = (j: string, param: string) =>
  `(NOT EXISTS (SELECT 1 FROM research_prompts p WHERE p.job_id = ${j}.id)
     OR EXISTS (SELECT 1 FROM research_prompts p WHERE p.job_id = ${j}.id AND p.owner_sub = ${param}))`;

/** SQL returning the prompts of the root job's tree that belong to another USER than the viewer. */
export const FOREIGN_PROMPTS_SQL =
  `SELECT p.prompt FROM research_prompts p
     JOIN research_jobs j ON j.id = p.job_id
    WHERE j.id = (SELECT coalesce(root_job_id, id) FROM research_jobs WHERE id = $1::uuid)
      AND p.owner_sub <> $2 AND p.owner_sub NOT LIKE 'service:%'`;

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
