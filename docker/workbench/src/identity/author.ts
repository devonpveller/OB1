// The CHANGE AUTHOR of a write (vault commits, source revisions, contract trail actors) - edge-b5-portal-retire,
// tester t-edge-b5 D1. It comes from the identity seam alone (middleware/identity.ts): the signed-in user
// (a verified Authentik token; while an admin impersonates, the admin - who acted) or the configured edge
// identity header (WORKSPACE_IDENTITY_HEADER, which the viewer's forwarder strips from every client and
// only an edge that sets it itself can supply). Anything else - the shipped single-user default, a
// service key, a request mounted without the seam - gets the caller's fallback.
//
// It NEVER reads Remote-User, X-Forwarded-User, X-Remote-User or X-Forwarded-Preferred-Username. Those
// were the retired portal's (Authelia behind Caddy, which stripped client-sent copies first). With the
// portal gone nothing sets them legitimately, and the tailnet route reaches the viewer with no proxy in
// front, so any client could have named any author through them.
import type { Context } from "hono";
import { seamIdentity } from "../middleware/identity.ts";

export function changeAuthor(c: Context, fallback: string): string;
export function changeAuthor(c: Context, fallback?: string | null): string | null;
export function changeAuthor(c: Context, fallback: string | null = null): string | null {
  const who = seamIdentity(c);
  if (who && (who.kind === "user" || who.kind === "header")) return (who.actorName || who.name || who.actor) ?? fallback;
  return fallback;
}
