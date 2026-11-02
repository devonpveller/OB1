// A BACKSTOP only (rw-p8a2-cleanup round 3b; the reviewer: a mask fails open). The rule that keeps a signed-in
// subject out of shared D5 rows is at the WRITE: every user erasure, lift, suppression and severance writes a private
// action ref (cleanup-action:<id>, repo/actions.ts), and reads answer erased_by_you / may_lift for the viewer. This
// walk only catches a value that slipped past that rule: on any tombstone-shaped object (one with `eraser_kind` and
// `eraser_user`) an eraser_user / lifted_by that is neither an action ref, nor the viewer's own subject, nor read by
// the single-user default identity, is answered as null.
// WORKSPACE_RESPONSE_WALK=off (LAB ONLY, the switch that also turns off the owner-scope walk) turns this off too, so
// the isolation sweep and cleanup_round3b_test.ts prove the routes need no net.
import type { Context, Next } from "hono";
import { type Identity, identityOf } from "../../middleware/identity.ts";
import { ACTION_REF_RE } from "../logic/cleanup.ts";

const OFF = () => (Deno.env.get("WORKSPACE_RESPONSE_WALK") ?? "").trim().toLowerCase() === "off";

export function seesActor(value: unknown, who: Identity): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && ACTION_REF_RE.test(value)) return true; // opaque: names an action, not a person
  if (who.kind === "default") return true;
  return typeof value === "string" && value !== "" && value === who.sub;
}

export function maskTombstoneActors(v: unknown, who: Identity): unknown {
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = maskTombstoneActors(x, who);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const [k, x] of Object.entries(o)) {
    const y = maskTombstoneActors(x, who);
    if (y !== x) (out ??= { ...o })[k] = y;
  }
  const cur = out ?? o;
  if ("eraser_kind" in cur && "eraser_user" in cur) {
    for (const k of ["eraser_user", "lifted_by"]) {
      if (k in cur && !seesActor(cur[k], who)) (out ??= { ...o })[k] = null;
    }
  }
  return out ?? v;
}

export function tombstoneActorMask() {
  return async (c: Context, next: Next) => {
    await next();
    if (OFF()) return;
    if (!(c.res.headers.get("content-type") ?? "").includes("application/json")) return;
    let body: unknown;
    try {
      body = await c.res.clone().json();
    } catch {
      return;
    }
    const masked = maskTombstoneActors(body, await identityOf(c));
    if (masked === body) return;
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    c.res = new Response(JSON.stringify(masked), { status: c.res.status, headers });
  };
}
