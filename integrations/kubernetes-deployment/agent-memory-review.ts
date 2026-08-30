/**
 * agent-memory-review - who may change a memory's standing, and into what.
 *
 * Pure logic, no database and no network, for the same reason the write/read policy is:
 * the interesting failures are DISAGREEMENTS between two sides, and they only show up when
 * the sides can be composed in a test.
 *
 * WHY THIS EXISTS. Verified before it was written: there is no `UPDATE agent_memories` and
 * no `SET review_status` anywhere in this codebase. Every memory is written 'evidence_only'
 * and stays there for ever. 'pending' can never become 'confirmed'; nothing can be
 * 'rejected', 'superseded' or 'merged'. The schema defines the entire lifecycle
 * (init-agent-memory.sql:74) and reserves the audit event types for it (:230) - and nothing
 * could emit one. The recall gate was a gate onto a room with no other door.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: a rejection must mean something. The recall gate
 * deliberately returns 'rejected' on NO path, including under `include_unconfirmed`,
 * because a reviewer who throws a memory away has to be able to trust it stays thrown away.
 * That guarantee is worth nothing if a later promote can quietly walk it back, so
 * 'rejected' is TERMINAL here. Reversing one is a deliberate act with a new memory and a
 * new review, not an UPDATE that leaves no trace of the disagreement.
 */

import type { ReviewStatus } from "./agent-memory-policy.ts";

/** What a reviewer can ask for. Deliberately a small closed set. */
export type ReviewAction = "confirm" | "reject" | "supersede" | "dispute";

/** Audit event types the schema permits for these actions (init-agent-memory.sql:230). */
export type ReviewAuditEvent =
  | "memory_confirmed"
  | "memory_rejected"
  | "memory_superseded"
  | "memory_disputed";

export type LifecycleStatus = "active" | "stale" | "superseded" | "disputed" | "rejected";

/**
 * The states an action may be applied FROM.
 *
 * 'rejected' appears in no source list - see the module note. 'merged' and 'stale' are also
 * absent: both describe a memory that has already been dealt with, and quietly re-reviewing
 * one would hide that it had been.
 */
const TRANSITIONS: Readonly<Record<ReviewAction, {
  from: readonly ReviewStatus[];
  to: ReviewStatus;
  lifecycle?: LifecycleStatus;
  event: ReviewAuditEvent;
}>> = Object.freeze({
  confirm: {
    from: ["pending", "evidence_only", "restricted"],
    to: "confirmed",
    event: "memory_confirmed",
  },
  reject: {
    // Confirmed IS rejectable: a reviewer who later finds a confirmed memory wrong must be
    // able to withdraw it, and that is the direction that makes the store safer.
    from: ["pending", "evidence_only", "restricted", "confirmed"],
    to: "rejected",
    lifecycle: "rejected",
    event: "memory_rejected",
  },
  supersede: {
    from: ["pending", "evidence_only", "restricted", "confirmed"],
    to: "merged",
    lifecycle: "superseded",
    event: "memory_superseded",
  },
  dispute: {
    from: ["pending", "evidence_only", "restricted", "confirmed"],
    to: "restricted",
    lifecycle: "disputed",
    event: "memory_disputed",
  },
});

export interface TransitionPlan {
  ok: true;
  action: ReviewAction;
  review_status: ReviewStatus;
  lifecycle_status: LifecycleStatus | null;
  event: ReviewAuditEvent;
  /** Set only by `confirm`: a human vouching is what 'user_confirmed' means. */
  provenance_status: "user_confirmed" | null;
  /** Set only by `confirm`: the row no longer needs a confirmation it has received. */
  clears_confirmation_requirement: boolean;
}

export interface TransitionRefusal {
  ok: false;
  reason: "unknown_action" | "terminal_state" | "illegal_transition";
  message: string;
}

/**
 * Decide what an action does to a memory in a given state - or refuse, with a reason a
 * caller can show a human.
 *
 * Returns the WHOLE change as data rather than performing it, so the SQL and the policy can
 * be tested against each other instead of only through a database.
 */
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
    review_status: rule.to,
    lifecycle_status: rule.lifecycle ?? null,
    event: rule.event,
    provenance_status: action === "confirm" ? "user_confirmed" : null,
    clears_confirmation_requirement: action === "confirm",
  };
}

/** Every action this module accepts. Exported so a route can validate before touching a DB. */
export const REVIEW_ACTIONS: readonly ReviewAction[] = Object.freeze(
  Object.keys(TRANSITIONS) as ReviewAction[],
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
