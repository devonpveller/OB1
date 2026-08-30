/**
 * agent-memory-review - who may change a memory's standing, and into what.
 *
 * Pure logic, no database and no network, for the same reason the write/read policy is:
 * the interesting failures are DISAGREEMENTS between two sides, and they only show up when
 * the sides can be composed in a test.
 *
 * THE ACTION SET IS THE SCHEMA'S, NOT A SUBSET OF IT. `agent_memory_review_actions`
 * (init-agent-memory.sql:156) has a CHECK listing nine actions. An earlier version of this
 * module implemented four of them and wrote only `agent_memory_audit_events` - it never
 * touched the review-actions table at all, which exists precisely to record who changed a
 * memory's standing and what it looked like before. The table was in a file I had read.
 *
 * `promote_exposure` is a TENTH, added by migration: PLAN §1.1 makes human review the only
 * path that widens a memory's exposure, "a `promote_exposure` action beside the existing
 * `restrict_scope`". Without it a demoted memory could never be elevated - the conservative
 * direction, but not the designed one.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: a rejection must mean something. The recall gate
 * returns 'rejected' on NO path, including under `include_unconfirmed`, because a reviewer
 * who throws a memory away has to be able to trust it stays thrown away. That guarantee is
 * worth nothing if a later confirm can quietly walk it back, so 'rejected' is TERMINAL.
 * Reversing one is a deliberate act with a new memory and a new review, not an UPDATE that
 * leaves no trace of the disagreement.
 */

import type { Exposure, ReviewStatus } from "./agent-memory-policy.ts";

/** The schema's nine, plus the migration's `promote_exposure`. */
export type ReviewAction =
  | "confirm"
  | "edit"
  | "evidence_only"
  | "restrict_scope"
  | "promote_exposure"
  | "mark_stale"
  | "merge"
  | "reject"
  | "dispute"
  | "supersede";

/** Audit event types the schema permits (init-agent-memory.sql:230). */
export type ReviewAuditEvent =
  | "memory_confirmed"
  | "memory_edited"
  | "memory_rejected"
  | "memory_superseded"
  | "memory_disputed";

export type LifecycleStatus = "active" | "stale" | "superseded" | "disputed" | "rejected";

/** Everything a reviewer may act on. 'rejected' is absent from every list - see the note. */
const REVIEWABLE: readonly ReviewStatus[] = Object.freeze([
  "pending",
  "evidence_only",
  "restricted",
  "confirmed",
]);

interface Rule {
  from: readonly ReviewStatus[];
  review_status?: ReviewStatus;
  lifecycle?: LifecycleStatus;
  provenance?: "user_confirmed" | "superseded" | "disputed";
  /** Only two actions touch the exposure axis, and only one of them widens. */
  exposure?: Exposure;
  event: ReviewAuditEvent;
  clears_confirmation_requirement?: boolean;
}

const TRANSITIONS: Readonly<Record<ReviewAction, Rule>> = Object.freeze({
  // A human vouches. This is the only action that sets provenance 'user_confirmed', which
  // is what makes a memory ELIGIBLE for instruction-grade under the schema CHECK - it does
  // not grant it, and nothing here does.
  confirm: {
    from: ["pending", "evidence_only", "restricted"],
    review_status: "confirmed",
    provenance: "user_confirmed",
    event: "memory_confirmed",
    clears_confirmation_requirement: true,
  },
  // Usable as evidence, but nobody is vouching for it as instruction. The deliberate
  // middle rung of the trust ladder.
  evidence_only: {
    from: ["pending", "restricted", "confirmed"],
    review_status: "evidence_only",
    event: "memory_edited",
  },
  // The content changed. Standing is untouched on purpose: an edit is not an endorsement,
  // and silently promoting an edited memory would let a reviewer confirm by rewording.
  edit: { from: REVIEWABLE, event: "memory_edited" },
  // Narrow it. Moves the memory to the personal plane as well as restricting its review
  // standing - "restrict scope" that left the exposure axis alone would restrict nothing
  // an agent-facing recall can see.
  restrict_scope: {
    from: ["pending", "evidence_only", "confirmed"],
    review_status: "restricted",
    exposure: "personal",
    event: "memory_edited",
  },
  // THE ONLY WIDENING PATH IN THE SYSTEM (PLAN §1.1). It requires a human, it is recorded
  // in agent_memory_review_actions with the before/after, and it also stamps provenance
  // 'user_confirmed' - widening exposure IS a human vouching for what the memory contains.
  promote_exposure: {
    from: REVIEWABLE,
    exposure: "ops",
    provenance: "user_confirmed",
    event: "memory_edited",
  },
  mark_stale: {
    from: REVIEWABLE,
    review_status: "stale",
    lifecycle: "stale",
    event: "memory_edited",
  },
  // merge and supersede reach the same STATE and record different INTENT. The schema has
  // one review_status ('merged') and one lifecycle ('superseded') between them, so the
  // distinction lives where distinctions belong - in the action row and its payload
  // (`superseded_by`), not in a status value that does not exist.
  merge: {
    from: REVIEWABLE,
    review_status: "merged",
    lifecycle: "superseded",
    provenance: "superseded",
    event: "memory_superseded",
  },
  supersede: {
    from: REVIEWABLE,
    review_status: "merged",
    lifecycle: "superseded",
    provenance: "superseded",
    event: "memory_superseded",
  },
  // Confirmed IS rejectable: a reviewer who later finds a confirmed memory wrong must be
  // able to withdraw it, and that is the direction that makes the store safer.
  reject: {
    from: REVIEWABLE,
    review_status: "rejected",
    lifecycle: "rejected",
    event: "memory_rejected",
  },
  dispute: {
    from: REVIEWABLE,
    review_status: "restricted",
    lifecycle: "disputed",
    provenance: "disputed",
    event: "memory_disputed",
  },
});

export interface TransitionPlan {
  ok: true;
  action: ReviewAction;
  /** Absent when the action does not change review standing (`edit`, `promote_exposure`). */
  review_status: ReviewStatus | null;
  lifecycle_status: LifecycleStatus | null;
  provenance_status: "user_confirmed" | "superseded" | "disputed" | null;
  exposure: Exposure | null;
  event: ReviewAuditEvent;
  clears_confirmation_requirement: boolean;
}

export interface TransitionRefusal {
  ok: false;
  reason: "unknown_action" | "terminal_state" | "illegal_transition";
  message: string;
}

export function planTransition(
  current: ReviewStatus,
  action: ReviewAction,
): TransitionPlan | TransitionRefusal {
  const rule = TRANSITIONS[action];
  if (!rule) {
    return { ok: false, reason: "unknown_action", message: `unknown review action '${action}'` };
  }
  if (current === "rejected") {
    return {
      ok: false,
      reason: "terminal_state",
      message:
        "this memory was rejected, and rejection is final. The recall gate returns rejected " +
        "memories on no path, and that guarantee is only worth something if a rejection " +
        "cannot be walked back. Write a new memory and review that.",
    };
  }
  if (!rule.from.includes(current)) {
    return {
      ok: false,
      reason: "illegal_transition",
      message: `cannot ${action} a memory whose review_status is '${current}'`,
    };
  }
  return {
    ok: true,
    action,
    review_status: rule.review_status ?? null,
    lifecycle_status: rule.lifecycle ?? null,
    provenance_status: rule.provenance ?? null,
    exposure: rule.exposure ?? null,
    event: rule.event,
    clears_confirmation_requirement: rule.clears_confirmation_requirement === true,
  };
}

export const REVIEW_ACTIONS: readonly ReviewAction[] = Object.freeze(
  Object.keys(TRANSITIONS) as ReviewAction[],
);

/** The nine the schema's CHECK already permits, i.e. everything except the migrated one. */
export const SCHEMA_REVIEW_ACTIONS: readonly ReviewAction[] = Object.freeze(
  REVIEW_ACTIONS.filter((a) => a !== "promote_exposure"),
);

export function isReviewAction(x: unknown): x is ReviewAction {
  return typeof x === "string" && (REVIEW_ACTIONS as readonly string[]).includes(x);
}

/**
 * An actor is REQUIRED, and it must be a person.
 *
 * The whole point of this door is that a human vouched. An audit row saying
 * actor_kind='system' would record that something happened without recording who is
 * answerable for it, which is the same as not recording it. `actor_kind` is pinned to
 * 'user' rather than accepted from the caller for exactly that reason.
 */
export interface ReviewActor {
  label: string;
}

export function validateActor(actor: unknown): ReviewActor | null {
  if (!actor || typeof actor !== "object") return null;
  const label = (actor as { label?: unknown }).label;
  if (typeof label !== "string" || !label.trim()) return null;
  return { label: label.trim() };
}
