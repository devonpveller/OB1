// rw-p8a1-core round 3 (operator decision 2026-11-02): a tombstone is lifted only by the user who erased it, or an
// admin - one rule, mayLiftTombstone (logic/lift.ts), which the trail's lift route and the cleanup view's lift both
// call through liftTombstoneAs (repo/lifecycle.ts). Pure half; the database half is panels_integration_test.ts T8.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { mayLiftTombstone } from "./logic/lift.ts";
import { buildDocument } from "./gen.ts";

const who = (o: Record<string, unknown>) => ({ sub: "u-a", actor: "u-a", name: "A", key: "u-a", kind: "header", admin: false, impersonating: null, ...o }) as never;
// rw-p8a2-cleanup round 3b: ownership is the eraser ref's PRIVATE record (erased_by_caller, computed by the caller
// from cleanup_actions); the shared eraser_user holds an action ref, never a subject
const t = (o: Record<string, unknown> = {}) => ({ eraser_kind: "user", eraser_user: "cleanup-action:a", erased_by_caller: true, ...o }) as never;

Deno.test("lift rule: the user who erased it may lift it", () => {
  assert(mayLiftTombstone(t(), who({})));
});

Deno.test("lift rule: another user may not - whatever name they send", () => {
  assertEquals(mayLiftTombstone(t({ erased_by_caller: false }), who({ sub: "u-b", actor: "u-b", name: "u-a" })), false);
  // round 3b: a subject in the shared row is not ownership
  assertEquals(mayLiftTombstone(t({ eraser_user: "u-b", erased_by_caller: false }), who({ sub: "u-b", actor: "u-b" })), false);
});

Deno.test("lift rule: an admin may lift any tombstone, an automation's too", () => {
  assert(mayLiftTombstone(t({ erased_by_caller: false }), who({ sub: "u-b", actor: "u-b", admin: true })));
  assert(mayLiftTombstone(t({ eraser_kind: "automation", eraser_user: null }), who({ admin: true })));
});

Deno.test("lift rule: an automation's tombstone, or one with no recorded eraser, is an admin's to lift", () => {
  assertEquals(mayLiftTombstone(t({ eraser_kind: "automation", eraser_user: null, erased_by_caller: false }), who({})), false);
  assertEquals(mayLiftTombstone(t({ eraser_user: null, erased_by_caller: false }), who({})), false);
  assertEquals(mayLiftTombstone(t({ eraser_user: "", erased_by_caller: false }), who({ sub: "" })), false);
});

Deno.test("lift rule: while an admin impersonates a user, the admin acts (the actor), not the user", () => {
  // the impersonated user erased it: the impersonating admin may lift it (an admin may lift any)
  assert(mayLiftTombstone(t(), who({ sub: "u-a", actor: "admin-1", admin: true, impersonating: { reason: "r", since: "x" } })));
});

Deno.test("lift rule: the single-user install (no sign-in, no header: the one operator) may lift", () => {
  assert(mayLiftTombstone(t({ erased_by_caller: false }), who({ kind: "default", sub: "operator" })));
  assertEquals(mayLiftTombstone(t({ erased_by_caller: false }), who({ kind: "service", sub: "service:x" })), false);
});

Deno.test("lift contract: the request's `by` is not the actor, and the route answers 403", () => {
  const doc = buildDocument() as Record<string, any>;
  const op = doc.paths["/workbench/contract/tombstones/{id}/lift"].post;
  assert(op.responses["403"], "403 documented");
  const req = doc.components.schemas.LiftRequest;
  assert(!(req.required ?? []).includes("by"), "by is not required (it is ignored: the identity seam names the actor)");
  assert(doc.components.schemas.Tombstone.properties.may_lift, "a tombstone read says whether the caller may lift it");
});
