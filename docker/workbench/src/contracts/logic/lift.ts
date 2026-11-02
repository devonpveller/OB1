// Who may lift a tombstone (operator decision 2026-11-02, rw-p8a1-core round 3). PURE - the ONE rule: the trail's
// lift (POST /contract/tombstones/:id/lift) and the cleanup view's lift (rw-p8a2-cleanup) both reach it through
// liftTombstoneAs (repo/lifecycle.ts), and a tombstone read answers it as `may_lift`.
//
//   - an admin (the signed-in token's admin group; while impersonating, the admin is who acts) may lift any;
//   - a user may lift a tombstone a USER erased when they are that eraser: eraser_user is the identity seam's
//     subject the erase recorded (the erase route takes it from the seam, never from the body);
//   - an automation's tombstone, or one with no recorded eraser, is an admin's to lift;
//   - the single-user install (no sign-in, no identity header: the one default identity, who owns everything
//     there) may lift - it is the operator. A service may not.
// The request's `by` is never the actor.
import type { Identity } from "../../middleware/identity.ts";

export interface LiftFacts {
  eraser_kind: string;
  eraser_user: string | null;
}

export function mayLiftTombstone(t: LiftFacts, who: Identity): boolean {
  if (who.admin) return true;
  if (who.kind === "default") return true;
  if (who.kind !== "user" && who.kind !== "header") return false;
  if (t.eraser_kind !== "user" || !t.eraser_user || !who.sub) return false;
  return t.eraser_user === who.sub;
}
