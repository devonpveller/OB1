// rwr-own-thoughts-search-api: WHO may search their own thoughts. One rule, decided from the identity the seam
// resolved (middleware/identity.ts) and never from anything the request names: a PERSON acting as themselves.
//   yes: a signed-in user (kind "user"); the configured default identity or the edge identity header while sign-in is
//        off (kind "default" / "header" - the one person the workbench serves then).
//   no:  a service key (a service is nobody's owner), an on-behalf caller (openbrain-mcp's user token, Open WebUI's
//        intake), no identity at all (a router mounted without the seam), an anonymous request, an admin who is not the
//        owner or is impersonating one (actor !== sub: an admin gets nothing of anyone else's thoughts), a blank subject.
import type { Identity } from "../middleware/identity.ts";

export function ownThoughtsEligible(who: Identity | undefined): boolean {
  if (!who) return false;
  if (who.kind !== "user" && who.kind !== "default" && who.kind !== "header") return false;
  if (!who.sub || who.sub !== who.actor) return false;
  return !who.impersonating;
}
