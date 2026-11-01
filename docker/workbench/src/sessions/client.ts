// The workspace's door to the research service's P4a writes (steer, cancel) - SHIPPED INERT like the
// documents API's research client (documents/clients.ts): null until RESEARCH_URL and
// RESEARCH_WORKSPACE_KEY are set, and the routes then answer 503 naming them.
//
// Every call goes under the WORKSPACE's own caller key and names, from the identity seam only (never a
// caller-supplied user): the subject it acts for (x-on-behalf-of = subject_sub), who acted
// (x-actor-sub = actor_sub; an admin while impersonating differs from the subject) and, when the actor
// is an admin, x-actor-admin: 1. The research service accepts the last two from this key alone
// (viewer.ts actorOf) and records the actor on the steer (research_steers.actor_sub).
import { logRefusal } from "../identity/refusal_log.ts";

export interface Acting {
  sub: string;
  actor: string;
  admin: boolean;
}

export interface ResearchActions {
  steer(jobId: string, body: Record<string, unknown>, who: Acting): Promise<{ status: number; body: Record<string, unknown> }>;
  cancel(jobId: string, reason: string | null, who: Acting): Promise<{ status: number; body: Record<string, unknown> }>;
}

export function researchActions(env = (k: string) => Deno.env.get(k)): ResearchActions | null {
  const base = (env("RESEARCH_URL") ?? "").replace(/\/+$/, "");
  const key = env("RESEARCH_WORKSPACE_KEY") ?? "";
  if (!base || !key) return null;
  const call = async (path: string, body: unknown, who: Acting) => {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-brain-key": key, "x-on-behalf-of": who.sub,
        ...(who.actor && who.actor !== who.sub ? { "x-actor-sub": who.actor } : {}),
        ...(who.admin ? { "x-actor-admin": "1" } : {}),
      },
      body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json().catch(() => ({}));
    // rw-identity-harden2 round 2 (tester D8): a client of another service never hands its caller that service's
    // error text. The typed refusals the user can act on (400 / 404 / 409 / 422: SteerError and the like) keep
    // their body; any other non-2xx (a 5xx's detail is an exception message) becomes a fixed code, the real
    // answer goes to the log here.
    if (!r.ok && ![400, 404, 409, 422].includes(r.status)) {
      logRefusal("research: upstream", `[research ${path.split("/").pop()}] the research service answered ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
      return { status: r.status, body: { error: "upstream_error" } };
    }
    return { status: r.status, body: (j ?? {}) as Record<string, unknown> };
  };
  return {
    steer: (id, body, who) => call(`/research/jobs/${encodeURIComponent(id)}/steer`, body, who),
    cancel: (id, reason, who) => call(`/research/jobs/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {}, who),
  };
}
