// rw-owner-private-view (plan 08 PD-PV, slot 480): WHO may see the owner's private views - the claims PD1 made
// private, the private links of mixed claims, the moved email-body and podcast-transcript sources, the private job
// text (/workbench/contract/private/*). One rule, decided from the identity the seam resolved (never a subject named
// by the request) and the workbench's identity MODE (decision D4, operator via the coordinator 2026-11-05):
//   * sign-in configured (WORKSPACE_FORWARD_AUTH_*): a signed-in user acting as themselves - kind "user" and
//     actor === sub, not impersonating. An admin impersonating the owner gets the same empty answer as anyone (D2);
//     a service, an on-behalf caller (openbrain-mcp's lane, Open WebUI's intake) or no sign-in gets nothing.
//   * sign-in NOT configured (live today): the ONE default identity, WORKSPACE_DEFAULT_SUB, as every other workbench
//     route serves it - kind "default" with the default subject SET. A header identity (the lab-only
//     WORKSPACE_IDENTITY_HEADER) is never eligible, and a blank default subject (the seam's placeholder "operator",
//     which slot 470 refuses as an owner) gets the empty answer without a query.
// The mode is disclosed: GET /workbench/auth/me says private_views "signed-in" | "default-identity" | "off", and the
// workbench logs once at start-up while it serves the default identity (main.ts).
import { forwardAuthConfig } from "./forward_auth.ts";
import type { Identity } from "../middleware/identity.ts";

export type PrivateViewsMode = "signed-in" | "default-identity" | "off";

export interface PrivateViewConfig {
  signIn: boolean;
  defaultSub: string; // "" when WORKSPACE_DEFAULT_SUB is blank
}

export function privateViewConfig(env = (k: string) => Deno.env.get(k)): PrivateViewConfig {
  return { signIn: forwardAuthConfig(env) !== null, defaultSub: (env("WORKSPACE_DEFAULT_SUB") ?? "").trim() };
}

export function privateViewsMode(cfg: PrivateViewConfig): PrivateViewsMode {
  if (cfg.signIn) return "signed-in";
  return cfg.defaultSub ? "default-identity" : "off";
}

// the start-up disclosure (no subject value)
export const DEFAULT_IDENTITY_LOG =
  "[identity] private views are served to the default identity (WORKSPACE_DEFAULT_SUB) because sign-in (forward-auth) is off";

export function privateEligible(who: Identity | undefined, cfg: PrivateViewConfig): boolean {
  if (!who) return false;
  if (cfg.signIn) return who.kind === "user" && who.actor === who.sub && !who.impersonating && !!who.sub;
  return who.kind === "default" && !!cfg.defaultSub && who.sub === cfg.defaultSub && who.actor === who.sub;
}

// the empty answer says sign-in is needed when sign-in is on and the caller is not a signed-in user
export function signInRequired(who: Identity | undefined, cfg: PrivateViewConfig): boolean {
  return cfg.signIn && who?.kind !== "user";
}
