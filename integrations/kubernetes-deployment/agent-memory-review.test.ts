/** Tests for the review-transition policy.
 *
 * Run: deno test agent-memory-review.test.ts
 *
 * The composed test is first, for the same reason it is first in the policy suite: the
 * per-rule assertions guard details, and that one guards whether the door is worth having.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isReviewAction,
  planTransition,
  REVIEW_ACTIONS,
  type ReviewAction,
  validateActor,
} from "./agent-memory-review.ts";
import {
  DEFAULT_RECALL_STATUSES,
  recallReviewStatuses,
  WRITEBACK_DEFAULTS,
} from "./agent-memory-policy.ts";
import type { ReviewStatus } from "./agent-memory-policy.ts";

// ── THE DOOR-IS-USEFUL INVARIANT ─────────────────────────────────────────────
// The reason this module exists: before it, every memory was written 'evidence_only' and
// no code path could change that. These compose the review side against the RECALL side,
// so "confirming works" cannot be true in isolation while meaning nothing downstream.

Deno.test("INVARIANT: confirming a default writeback produces a recallable state", () => {
  const plan = planTransition(WRITEBACK_DEFAULTS.review_status, "confirm");
  assertEquals(plan.ok, true);
  if (!plan.ok) return;
  assertEquals(DEFAULT_RECALL_STATUSES.includes(plan.review_status), true);
});

Deno.test("INVARIANT: rejecting removes it from EVERY recall path, not just the default", () => {
  const plan = planTransition("confirmed", "reject");
  assertEquals(plan.ok, true);
  if (!plan.ok) return;
  // Both gates - including the permissive one. An opt-in flag named include_unconfirmed
  // must never quietly also mean "include the things we threw away".
  for (const flag of [false, true]) {
    assertEquals(recallReviewStatuses(flag).includes(plan.review_status), false);
  }
});

Deno.test("INVARIANT: a memory the reviewer has NOT seen is not recallable by default", () => {
  // The other half: 'pending' must stay out until someone acts. If this ever passes, the
  // review door has become decorative - everything is recallable whether reviewed or not.
  assertEquals(DEFAULT_RECALL_STATUSES.includes("pending" as ReviewStatus), false);
});

// ── rejection is terminal ────────────────────────────────────────────────────
Deno.test("a rejected memory cannot be confirmed, superseded, disputed or re-rejected", () => {
  for (const action of REVIEW_ACTIONS) {
    const plan = planTransition("rejected", action);
    assertEquals(plan.ok, false, `${action} must be refused on a rejected memory`);
    if (!plan.ok) assertEquals(plan.reason, "terminal_state");
  }
});

Deno.test("the refusal EXPLAINS itself rather than just saying no", () => {
  const plan = planTransition("rejected", "confirm");
  assertEquals(plan.ok, false);
  if (plan.ok) return;
  // A reviewer who is told "illegal transition" edits the database by hand. One who is told
  // why, and what to do instead, does the safe thing.
  assertEquals(plan.message.includes("rejection is final"), true);
  assertEquals(plan.message.includes("Write a new memory"), true);
});

// ── what confirm actually changes ────────────────────────────────────────────
Deno.test("confirm sets provenance to user_confirmed and clears the confirmation flag", () => {
  const plan = planTransition("evidence_only", "confirm");
  assertEquals(plan.ok, true);
  if (!plan.ok) return;
  assertEquals(plan.review_status, "confirmed");
  assertEquals(plan.provenance_status, "user_confirmed");
  assertEquals(plan.clears_confirmation_requirement, true);
  assertEquals(plan.event, "memory_confirmed");
  // Lifecycle is untouched: a confirmed memory is still simply active.
  assertEquals(plan.lifecycle_status, null);
});

Deno.test("NOTHING here sets can_use_as_instruction - not even confirm", () => {
  // Confirming makes a memory ELIGIBLE for instruction-grade (the schema CHECK at
  // init-agent-memory.sql:94 requires provenance user_confirmed/imported) but does not
  // grant it. Minting instruction-grade stays a separate, deliberate act; a plan object
  // that carried that field would make it a side effect of clicking approve.
  const plan = planTransition("pending", "confirm");
  assertEquals(plan.ok, true);
  if (!plan.ok) return;
  assertEquals("can_use_as_instruction" in plan, false);
});

Deno.test("only confirm touches provenance", () => {
  for (const action of ["reject", "supersede", "dispute"] as ReviewAction[]) {
    const plan = planTransition("confirmed", action);
    assertEquals(plan.ok, true, action);
    if (!plan.ok) continue;
    assertEquals(plan.provenance_status, null, action);
    assertEquals(plan.clears_confirmation_requirement, false, action);
  }
});

// ── lifecycle side of each action ────────────────────────────────────────────
Deno.test("reject, supersede and dispute each move lifecycle_status out of active", () => {
  const expected: Record<string, string> = {
    reject: "rejected",
    supersede: "superseded",
    dispute: "disputed",
  };
  for (const [action, lifecycle] of Object.entries(expected)) {
    const plan = planTransition("evidence_only", action as ReviewAction);
    assertEquals(plan.ok, true, action);
    if (!plan.ok) continue;
    assertEquals(plan.lifecycle_status, lifecycle, action);
  }
});

Deno.test("every lifecycle value used here is one the schema permits", () => {
  // Mirrors init-agent-memory.sql:50. A value outside this set is rejected by the CHECK at
  // runtime and by nothing at test time, which is how a wrong string ships.
  const allowed = ["active", "stale", "superseded", "disputed", "rejected"];
  for (const action of REVIEW_ACTIONS) {
    const plan = planTransition("evidence_only", action);
    if (!plan.ok || plan.lifecycle_status === null) continue;
    assertEquals(allowed.includes(plan.lifecycle_status), true, `${action} -> ${plan.lifecycle_status}`);
  }
});

Deno.test("every review_status used here is one the schema permits", () => {
  const allowed = ["pending", "confirmed", "evidence_only", "restricted", "rejected", "stale", "merged"];
  for (const action of REVIEW_ACTIONS) {
    const plan = planTransition("evidence_only", action);
    if (!plan.ok) continue;
    assertEquals(allowed.includes(plan.review_status), true, `${action} -> ${plan.review_status}`);
  }
});

Deno.test("every audit event used here is one the schema permits", () => {
  // Mirrors init-agent-memory.sql:230. The writeback shipped with an insert into a column
  // that did not exist and every test passed; a bad enum value is the same failure with a
  // different name, and only a list checked against the schema catches it before runtime.
  const allowed = [
    "recall_requested", "memory_returned", "memory_used", "memory_ignored",
    "memory_written", "memory_confirmed", "memory_edited", "memory_rejected",
    "memory_superseded", "memory_disputed",
  ];
  for (const action of REVIEW_ACTIONS) {
    const plan = planTransition("evidence_only", action);
    if (!plan.ok) continue;
    assertEquals(allowed.includes(plan.event), true, `${action} -> ${plan.event}`);
  }
});

// ── stale and merged are not re-reviewable ───────────────────────────────────
Deno.test("a merged or stale memory is not silently re-reviewed", () => {
  for (const state of ["merged", "stale"] as ReviewStatus[]) {
    for (const action of REVIEW_ACTIONS) {
      const plan = planTransition(state, action);
      assertEquals(plan.ok, false, `${action} on ${state}`);
      if (!plan.ok) assertEquals(plan.reason, "illegal_transition", `${action} on ${state}`);
    }
  }
});

// ── the actor ────────────────────────────────────────────────────────────────
Deno.test("an action with no named actor is refused", () => {
  assertEquals(validateActor(undefined), null);
  assertEquals(validateActor({}), null);
  assertEquals(validateActor({ label: "" }), null);
  assertEquals(validateActor({ label: "   " }), null);
  assertEquals(validateActor("someone"), null);
});

Deno.test("a named actor is accepted and trimmed", () => {
  assertEquals(validateActor({ label: "  devon  " }), { label: "devon" });
});

Deno.test("isReviewAction refuses anything not in the closed set", () => {
  for (const a of REVIEW_ACTIONS) assertEquals(isReviewAction(a), true, a);
  for (const bad of ["delete", "approve", "", "CONFIRM", null, 7, {}]) {
    assertEquals(isReviewAction(bad), false, String(bad));
  }
});
