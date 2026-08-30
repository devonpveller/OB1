/**
 * agent-memory-ops - executing a review decision, and listing what is waiting for one.
 *
 * The DECISION lives in agent-memory-review.ts and is pure. This file is the part that
 * touches a database, kept separate so the policy can be tested without one and so this
 * file has nothing in it but plumbing and a transaction.
 *
 * NOT REGISTERED ON THE AGENT-FACING SERVER. Promotion is the single operation that changes
 * what a memory is allowed to be used for, so it must not sit on the surface agents already
 * hold a key to: an agent that can reach the promote route can vouch for its own memory,
 * and the only thing between it and instruction-grade material would be a key check on a
 * server it has already authenticated to. `registerAgentMemoryOps` is called by the ops
 * entrypoint alone, which binds to loopback - a routing mistake cannot expose what is not
 * listening on a reachable interface, which is a stronger property than a correct check.
 */

import {
  isReviewAction,
  REVIEW_ACTIONS,
  planTransition,
  type ReviewAction,
  validateActor,
} from "./agent-memory-review.ts";
import type { ReviewStatus } from "./agent-memory-policy.ts";
import {
  doorPlane,
  listMemoriesOnPlane,
  resolveMemoryOnPlane,
  updateMemoryOnPlane,
} from "./agent-memory-plane.ts";

export interface AgentMemoryOpsDeps {
  /** §1.1: the exposure plane this DOOR reads on. Forced server-side; a caller cannot widen it. */
  doorExposure?: string;
  pool: {
    connect: () => Promise<{
      queryObject: (sql: string, args?: unknown[]) => Promise<{ rows: unknown[] }>;
      release: () => void;
    }>;
  };
}

export interface ReviewInput {
  memory_id?: unknown;
  action?: unknown;
  actor?: unknown;
  note?: unknown;
  /** supersede only: the memory that replaces this one. Recorded, never dereferenced here. */
  superseded_by?: unknown;
}

export type ReviewOutcome =
  | {
    ok: true;
    memory_id: string;
    action: ReviewAction;
    from: ReviewStatus;
    review_status: ReviewStatus;
    lifecycle_status: string;
    exposure: string;
  }
  | { ok: false; refused: string; message: string };

/**
 * Apply a review decision.
 *
 * THE STATE IS READ AND WRITTEN IN ONE TRANSACTION, and the read is `FOR UPDATE`. Without
 * the lock, two reviewers acting at once both read 'pending', both plan a legal transition
 * from it, and the second silently overwrites the first - so a reject can be erased by a
 * concurrent confirm and the audit trail shows both as if each had been applied to the
 * state it saw. That is the same shape as the writeback's partial-commit bug: nothing
 * errors, and the record afterwards is a lie.
 *
 * AND THE READ IS BOUNDED BY THE DOOR'S PLANE. It was not, and that was worse than a read
 * leak. This function SELECTed `exposure` so it could report it and never FILTERED on it,
 * while `agent_memory_review` sits on the ops door's GATEWAY_WRITE_TOOLS and
 * `promote_exposure` is the one action in the system that WIDENS exposure
 * (agent-memory-review.ts: `exposure: "ops"`). An ops-door caller could therefore hand this
 * function a PERSONAL memory's id, promote it onto the ops plane, and afterwards read it
 * through every read tool entirely legitimately - the containment proved on those tools
 * never had to be defeated, only walked around. Both the resolve and the UPDATE now go
 * through agent-memory-plane.ts, which has no overload that omits the plane.
 */
export async function performReview(
  deps: AgentMemoryOpsDeps,
  input: ReviewInput,
): Promise<ReviewOutcome> {
  const memoryId = typeof input.memory_id === "string" ? input.memory_id.trim() : "";
  if (!memoryId) {
    return { ok: false, refused: "invalid_request", message: "memory_id is required" };
  }
  if (!isReviewAction(input.action)) {
    return {
      ok: false,
      refused: "invalid_request",
      message: `action must be one of: ${REVIEW_ACTIONS.join(", ")}`,
    };
  }
  const actor = validateActor(input.actor);
  if (!actor) {
    return {
      ok: false,
      refused: "invalid_request",
      message:
        "actor.label is required - this door exists to record that a PERSON vouched, and " +
        "an audit row without one records that something happened without recording who " +
        "is answerable for it",
    };
  }
  const action = input.action;

  const plane = doorPlane(deps);
  const client = await deps.pool.connect();
  try {
    await client.queryObject("BEGIN");

    const lookup = await resolveMemoryOnPlane<{
      review_status: ReviewStatus;
      lifecycle_status: string;
      provenance_status: string;
      exposure: string;
    }>({ client, pool: deps.pool }, plane, memoryId, {
      columns: `review_status, lifecycle_status, provenance_status,
              COALESCE(metadata->>'exposure', 'personal') AS exposure`,
      tool: "agent_memory_review",
      forUpdate: true,
    });
    if (!lookup.ok) {
      // not_found covers both "there is no such memory" and "it is on a plane this door
      // does not serve" - telling the two apart would confirm the memory to anyone who can
      // guess an id. The chokepoint has already written the access_refused row for the
      // second case, so the refusal is not silent.
      await client.queryObject("ROLLBACK");
      return { ok: false, refused: "not_found", message: `no memory with id ${memoryId}` };
    }
    const row = lookup.row;

    const plan = planTransition(row.review_status, action);
    if (!plan.ok) {
      await client.queryObject("ROLLBACK");
      return { ok: false, refused: plan.reason, message: plan.message };
    }

    // Built as a list so the columns a given action does NOT touch are genuinely absent
    // from the statement, rather than being set to their current values - which would make
    // every action look like it rewrote the whole row in any future column-level audit.
    // Only the columns this action actually changes. `edit` and `promote_exposure` do not
    // touch review_status at all, and a statement that set it to its current value would
    // make every action look like a full-row rewrite to any later column-level audit.
    const sets = ["updated_at = now()"];
    const args: unknown[] = [memoryId];
    if (plan.review_status) {
      sets.push(`review_status = $${args.length + 1}`);
      args.push(plan.review_status);
    }
    if (plan.lifecycle_status) {
      sets.push(`lifecycle_status = $${args.length + 1}`);
      args.push(plan.lifecycle_status);
    }
    if (plan.provenance_status) {
      sets.push(`provenance_status = $${args.length + 1}`);
      args.push(plan.provenance_status);
      if (plan.provenance_status === "user_confirmed") sets.push("last_confirmed_at = now()");
    }
    // §1.1: exposure lives in metadata, so a change is a jsonb merge rather than a column
    // assignment. jsonb_build_object, never a JSON literal - a literal would also have to
    // survive whatever quoting the caller's transport applies.
    if (plan.exposure) {
      sets.push(
        `metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('exposure', $${args.length + 1}::text)`,
      );
      args.push(plan.exposure);
    }
    if (plan.clears_confirmation_requirement) {
      sets.push("requires_user_confirmation = false");
    }
    // The UPDATE carries the plane predicate too, from the same chokepoint. Belt AND
    // braces: the resolve above is what refuses, and this is what keeps the refusal true
    // if a future edit ever reorders the two or drops one.
    const after = await updateMemoryOnPlane<{
      review_status: ReviewStatus;
      lifecycle_status: string;
      provenance_status: string;
      workspace_id: string;
      project_id: string | null;
      exposure: string;
    }>(
      client,
      plane,
      sets,
      args,
      `review_status, lifecycle_status, provenance_status, workspace_id, project_id,
                 COALESCE(metadata->>'exposure', 'personal') AS exposure`,
    );
    if (!after) {
      // Unreachable through the resolve above, which holds a FOR UPDATE lock on the row.
      // Kept because "the UPDATE matched nothing" must never fall through to reading
      // properties off undefined and reporting a change that did not happen.
      await client.queryObject("ROLLBACK");
      return { ok: false, refused: "not_found", message: `no memory with id ${memoryId}` };
    }

    // THE REVIEW-ACTION ROW. This table exists to record who changed a memory's standing
    // and what it looked like before, and an earlier version of this file never wrote to
    // it - it recorded only the audit event, which carries no before/after. Same
    // transaction as the change, for the same reason the audit event is: a standing change
    // nobody can reconstruct is worse than none, because recall hands the memory out on
    // its new standing and there is no record of what it used to be.
    await client.queryObject(
      `INSERT INTO agent_memory_review_actions
         (memory_id, action, actor_label, notes, before, after)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [
        memoryId,
        action,
        actor.label,
        typeof input.note === "string" ? input.note : null,
        JSON.stringify({
          review_status: row.review_status,
          lifecycle_status: row.lifecycle_status,
          provenance_status: row.provenance_status,
          exposure: row.exposure,
        }),
        JSON.stringify({
          review_status: after.review_status,
          lifecycle_status: after.lifecycle_status,
          provenance_status: after.provenance_status,
          exposure: after.exposure,
        }),
      ],
    );

    // The audit event is part of the SAME transaction as the state change. A promotion
    // nobody can trace is worse than no promotion: the recall path will hand the memory out
    // as confirmed, and there is no record of who said so.
    await client.queryObject(
      `INSERT INTO agent_memory_audit_events
         (memory_id, workspace_id, project_id, event_type, actor_kind, actor_label, payload)
       VALUES ($1, $2, $3, $4, 'user', $5, $6::jsonb)`,
      [
        memoryId,
        after.workspace_id,
        after.project_id,
        plan.event,
        actor.label,
        JSON.stringify({
          from: row.review_status,
          to: plan.review_status,
          action,
          note: typeof input.note === "string" ? input.note : null,
          superseded_by: typeof input.superseded_by === "string" ? input.superseded_by : null,
        }),
      ],
    );

    await client.queryObject("COMMIT");
    return {
      ok: true,
      memory_id: memoryId,
      action,
      from: row.review_status,
      review_status: after.review_status,
      lifecycle_status: after.lifecycle_status,
      exposure: after.exposure,
    };
  } catch (e) {
    try { await client.queryObject("ROLLBACK"); } catch { /* the connection is already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

export interface ReviewQueueInput {
  workspace_id?: unknown;
  /** Defaults to the states a reviewer has not yet acted on. */
  review_status?: unknown;
  limit?: unknown;
}

/**
 * What is waiting for a decision.
 *
 * Defaults to 'pending' and 'evidence_only' - the two states that mean "written, nobody has
 * looked". It deliberately does NOT default to everything: a queue that includes rejected
 * and superseded memories is a list nobody reads, and a review queue nobody reads is the
 * same as not having one.
 */
export async function listForReview(
  deps: AgentMemoryOpsDeps,
  input: ReviewQueueInput,
): Promise<{ ok: true; items: unknown[] }> {
  const wanted = Array.isArray(input.review_status) && input.review_status.length
    ? input.review_status.map(String)
    : ["pending", "evidence_only"];
  const rawLimit = typeof input.limit === "number" ? input.limit : 50;
  // Clamped, like the recall path: one call must not be able to drain the store.
  const limit = Math.max(1, Math.min(200, Math.floor(rawLimit)));

  // THE EXPOSURE PLANE, forced from the door - the queue ENUMERATED the personal plane
  // without it, which an adversarial verifier demonstrated against merged code. The
  // gateway's forced metadata_filter cannot help here: this tool's schema has no such
  // field, so the SDK strips it before the handler runs.
  //
  // It is no longer this function's job to remember that. `listMemoriesOnPlane` starts the
  // WHERE clause WITH the plane predicate and hands back a builder for everything else, so
  // there is no arrangement of the code below that produces a query without it.
  const plane = doorPlane(deps);
  const client = await deps.pool.connect();
  try {
    const items = await listMemoriesOnPlane<unknown>(client, plane, {
      columns: `id, workspace_id, project_id, summary, memory_type, visibility,
              review_status, lifecycle_status, provenance_status, created_at`,
      orderBy: "created_at ASC",
      limit,
      build: (q) => {
        q.and(`review_status = ANY(${q.param(wanted)})`);
        if (typeof input.workspace_id === "string" && input.workspace_id.trim()) {
          q.and(`workspace_id = ${q.param(input.workspace_id.trim())}`);
        }
      },
    });
    return { ok: true, items };
  } finally {
    client.release();
  }
}

/**
 * Register the ops routes. Called ONLY by the loopback ops entrypoint - see the module note.
 */
// deno-lint-ignore no-explicit-any
export function registerAgentMemoryOps(app: any, deps: AgentMemoryOpsDeps) {
  // deno-lint-ignore no-explicit-any
  app.post("/ops/agent-memory/review", async (c: any) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ ok: false, refused: "invalid_json" }, 400);
    const out = await performReview(deps, body as ReviewInput);
    if (out.ok) return c.json(out);
    // 404 for a memory that is not there; 409 for a state that forbids the action (the
    // request was fine, the WORLD says no); 400 for a malformed request.
    const status = out.refused === "not_found"
      ? 404
      : out.refused === "invalid_request"
      ? 400
      : 409;
    return c.json(out, status);
  });

  // deno-lint-ignore no-explicit-any
  app.post("/ops/agent-memory/queue", async (c: any) => {
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    return c.json(await listForReview(deps, body as ReviewQueueInput));
  });
}
