// rwr-own-thoughts-search-api: WHO may search their own thoughts - slot 480's rule (identity/private_view.ts on
// rw-owner-private-view, restated here so this item does not depend on that branch's source), decided from the identity
// the seam resolved and the workbench's identity MODE, never from anything the request names:
//   * sign-in configured (WORKSPACE_FORWARD_AUTH_*): a signed-in user acting as themselves - kind "user", actor === sub, not
//     impersonating. An admin impersonating (or not the owner), a service, an on-behalf caller (openbrain-mcp's lane, Open
//     WebUI's intake) or no sign-in: no.
//   * sign-in NOT configured: the ONE default identity, WORKSPACE_DEFAULT_SUB - kind "default" with the default subject SET
//     and equal to the caller's subject. A header identity is never eligible; a blank default subject (the seam's
//     placeholder "operator") is nobody's.
// The database function (slot 530) applies the subject's shape rule again (owner_private_subject_ok): two locks, one key.
import { forwardAuthConfig } from "./forward_auth.ts";
import type { Identity } from "../middleware/identity.ts";

export interface OwnThoughtsConfig {
  signIn: boolean;
  defaultSub: string; // "" when WORKSPACE_DEFAULT_SUB is blank
}

export function ownThoughtsConfig(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): OwnThoughtsConfig {
  return { signIn: forwardAuthConfig(env) !== null, defaultSub: (env("WORKSPACE_DEFAULT_SUB") ?? "").trim() };
}

export function ownThoughtsEligible(who: Identity | undefined, cfg: OwnThoughtsConfig): boolean {
  if (!who || !who.sub || who.sub !== who.actor || who.impersonating) return false;
  if (cfg.signIn) return who.kind === "user";
  return who.kind === "default" && !!cfg.defaultSub && who.sub === cfg.defaultSub;
}
