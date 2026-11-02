// Who erased or lifted a tombstone is the user's own context (07-MULTI-USER), but since the operator's lift rule
// (2026-11-02, rw-p8a1-core) a user's erasure records the identity seam's subject as eraser_user - the lift rule
// compares it. So every contract response that carries a tombstone (an object with `eraser_kind` and
// `eraser_user`: GET /tombstones/{id}, a reference to an erased source, an erase, a lift, an admission decision,
// a refusal's detail) names its eraser and its lifter ONLY to that user (an admin impersonating a user sees that
// user's), or to the single-user install's one default identity (the operator, who owns everything there). Anyone
// else - an admin acting as themself included: they may still lift (may_lift) without being told whom - reads null.
// rw-p8a2-cleanup round 3: one walk for the whole contract app, so no route can forget it.
import type { Context, Next } from "hono";
import { type Identity, identityOf } from "../../middleware/identity.ts";

export function seesActor(value: unknown, who: Identity): boolean {
  if (value === null || value === undefined) return true;
  if (who.kind === "default") return true;
  return typeof value === "string" && value !== "" && (value === who.sub || value === who.name);
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
      if (k in cur && !seesActor(cur[k], who)) (out ??= { ...o }, out)[k] = null;
    }
  }
  return out ?? v;
}

export function tombstoneActorMask() {
  return async (c: Context, next: Next) => {
    await next();
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
