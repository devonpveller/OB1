/** Tests for executing a review decision.
 *
 * Run: deno test agent-memory-ops.test.ts
 *
 * A stubbed pool proves CONTROL FLOW and the shape of the statements - which columns are
 * touched, what runs inside the transaction, what never runs at all. It cannot prove the
 * SQL is valid against the schema; the writeback shipped with an insert into a `detail`
 * column that does not exist and every stubbed test passed. That half is covered by
 * executing these same statements against the real schema in
 * scripts/checks/test-quartz4-offline.ps1, and end to end by the smoke script.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { listForReview, performReview } from "./agent-memory-ops.ts";
import { REVIEW_ACTIONS } from "./agent-memory-review.ts";

/** A pool that RECORDS every statement, so the test can assert on the sequence. */
function recordingPool(
  rowFor: (sql: string) => unknown[] | undefined = () => undefined,
  initial: Record<string, unknown> = { review_status: "evidence_only", lifecycle_status: "active" },
) {
  const sql: string[] = [];
  const args: unknown[][] = [];
  let released = 0;
  const deps = {
    pool: {
      connect: () =>
        Promise.resolve({
          queryObject: (s: string, a?: unknown[]) => {
            sql.push(s);
            args.push(a ?? []);
            const custom = rowFor(s);
            if (custom) return Promise.resolve({ rows: custom });
            if (s.includes("FOR UPDATE")) return Promise.resolve({ rows: [initial] });
            if (s.startsWith("UPDATE agent_memories")) {
              return Promise.resolve({
                rows: [{
                  review_status: "confirmed",
                  lifecycle_status: "active",
                  workspace_id: "ws-1",
                  project_id: "p-1",
                }],
              });
            }
            return Promise.resolve({ rows: [] });
          },
          release: () => { released++; },
        }),
    },
  };
  return { deps, sql, args, releases: () => released };
}

const ACTOR = { label: "devon" };

// ── the transaction, and the lock ────────────────────────────────────────────
Deno.test("the read is FOR UPDATE and everything happens inside one transaction", async () => {
  // Without the lock two reviewers both read 'pending', both plan a legal transition from
  // it, and the second silently overwrites the first - so a reject can be erased by a
  // concurrent confirm while the audit trail shows both as validly applied.
  const { deps, sql } = recordingPool();
  const out = await performReview(deps, { memory_id: "m-1", action: "confirm", actor: ACTOR });
  assertEquals(out.ok, true);
  assertEquals(sql[0], "BEGIN");
  assertEquals(sql[1].includes("FOR UPDATE"), true);
  assertEquals(sql.some((s) => s.startsWith("UPDATE agent_memories")), true);
  assertEquals(sql.some((s) => s.includes("INSERT INTO agent_memory_audit_events")), true);
  assertEquals(sql[sql.length - 1], "COMMIT");
});

Deno.test("the audit event is inside the transaction, BEFORE the commit", async () => {
  // A promotion nobody can trace is worse than no promotion: recall hands the memory out as
  // confirmed and there is no record of who said so.
  const { deps, sql } = recordingPool();
  await performReview(deps, { memory_id: "m-1", action: "confirm", actor: ACTOR });
  const audit = sql.findIndex((s) => s.includes("INSERT INTO agent_memory_audit_events"));
  const commit = sql.findIndex((s) => s === "COMMIT");
  assertEquals(audit > 0 && commit > audit, true, sql.join(" | "));
});

Deno.test("the connection is released on the refusal paths too", async () => {
  const { deps, releases } = recordingPool(() => [], { review_status: "rejected", lifecycle_status: "rejected" });
  await performReview(deps, { memory_id: "m-1", action: "confirm", actor: ACTOR });
  assertEquals(releases(), 1);
});

// ── refusals never write ─────────────────────────────────────────────────────
Deno.test("a rejected memory is refused with 'terminal_state' and NOTHING is written", async () => {
  const { deps, sql } = recordingPool(undefined, { review_status: "rejected", lifecycle_status: "rejected" });
  const out = await performReview(deps, { memory_id: "m-1", action: "confirm", actor: ACTOR });
  assertEquals(out.ok, false);
  if (out.ok) return;
  assertEquals(out.refused, "terminal_state");
  assertEquals(sql.some((s) => s.startsWith("UPDATE agent_memories")), false);
  assertEquals(sql.some((s) => s.includes("INSERT INTO")), false);
  assertEquals(sql[sql.length - 1], "ROLLBACK");
});

Deno.test("a missing memory is not_found and rolls back", async () => {
  const { deps, sql } = recordingPool((s) => (s.includes("FOR UPDATE") ? [] : undefined));
  const out = await performReview(deps, { memory_id: "nope", action: "confirm", actor: ACTOR });
  assertEquals(out.ok, false);
  if (!out.ok) assertEquals(out.refused, "not_found");
  assertEquals(sql[sql.length - 1], "ROLLBACK");
});

Deno.test("an unnamed actor is refused BEFORE the database is touched", async () => {
  // The refusal has to come first: connecting and beginning a transaction to reject a
  // malformed request is how a door becomes a way to hold locks.
  for (const actor of [undefined, {}, { label: "  " }, "devon"]) {
    const { deps, sql } = recordingPool();
    const out = await performReview(deps, { memory_id: "m-1", action: "confirm", actor });
    assertEquals(out.ok, false, JSON.stringify(actor));
    if (!out.ok) assertEquals(out.refused, "invalid_request");
    assertEquals(sql.length, 0, "no statement should have run");
  }
});

Deno.test("an unknown action is refused before the database is touched", async () => {
  const { deps, sql } = recordingPool();
  const out = await performReview(deps, { memory_id: "m-1", action: "approve", actor: ACTOR });
  assertEquals(out.ok, false);
  if (!out.ok) assertEquals(out.refused, "invalid_request");
  assertEquals(sql.length, 0);
});

Deno.test("a missing memory_id is refused before the database is touched", async () => {
  const { deps, sql } = recordingPool();
  const out = await performReview(deps, { action: "confirm", actor: ACTOR });
  assertEquals(out.ok, false);
  assertEquals(sql.length, 0);
});

// ── what the UPDATE actually sets ────────────────────────────────────────────
/** Only the SET clause. The statement's RETURNING list names lifecycle_status on EVERY
 * action, so matching the whole string made "confirm does not touch lifecycle" fail and
 * "reject does touch it" pass for a reason that had nothing to do with the SET clause. A
 * substring assertion is only as good as the substring it is scoped to. */
function setClause(sql: string[]): string {
  const update = sql.find((s) => s.startsWith("UPDATE agent_memories")) ?? "";
  return update.split("RETURNING")[0];
}

Deno.test("confirm sets provenance and last_confirmed_at and clears the flag", async () => {
  const { deps, sql } = recordingPool();
  await performReview(deps, { memory_id: "m-1", action: "confirm", actor: ACTOR });
  const set = setClause(sql);
  assertEquals(set.includes("review_status = $2"), true);
  assertEquals(set.includes("provenance_status"), true);
  assertEquals(set.includes("last_confirmed_at = now()"), true);
  assertEquals(set.includes("requires_user_confirmation = false"), true);
  // Confirm leaves lifecycle alone - a confirmed memory is still simply active.
  assertEquals(set.includes("lifecycle_status"), false);
});

Deno.test("reject sets lifecycle and does NOT touch provenance", async () => {
  const { deps, sql } = recordingPool();
  await performReview(deps, { memory_id: "m-1", action: "reject", actor: ACTOR });
  const set = setClause(sql);
  assertEquals(set.includes("lifecycle_status"), true);
  assertEquals(set.includes("provenance_status"), false);
  assertEquals(set.includes("last_confirmed_at"), false);
  assertEquals(set.includes("requires_user_confirmation"), false);
});

Deno.test("the SET-clause helper can tell the two apart", () => {
  // Guards the scoping itself: if setClause ever stopped trimming RETURNING, both tests
  // above would go back to asserting against a string that always contains the word.
  const withReturning = "UPDATE agent_memories SET review_status = $2 RETURNING lifecycle_status";
  assertEquals(setClause([withReturning]).includes("lifecycle_status"), false);
});

Deno.test("NO path ever sets can_use_as_instruction", async () => {
  // Confirming makes a memory ELIGIBLE for instruction-grade (the schema CHECK requires
  // provenance user_confirmed/imported); it must never GRANT it. Minting instruction-grade
  // stays a separate deliberate act rather than a side effect of clicking approve.
  for (const action of ["confirm", "reject", "supersede", "dispute"]) {
    const { deps, sql } = recordingPool();
    await performReview(deps, { memory_id: "m-1", action, actor: ACTOR });
    for (const s of sql) {
      assertEquals(s.includes("can_use_as_instruction"), false, `${action}: ${s}`);
    }
  }
});

// ── the audit payload ────────────────────────────────────────────────────────
Deno.test("the audit row names the actor as a USER and records the from/to states", async () => {
  const { deps, sql, args } = recordingPool();
  await performReview(deps, {
    memory_id: "m-1", action: "confirm", actor: { label: "devon" }, note: "checked by hand",
  });
  const i = sql.findIndex((s) => s.includes("INSERT INTO agent_memory_audit_events"));
  assertEquals(sql[i].includes("'user'"), true, "actor_kind must be pinned to 'user'");
  const payload = JSON.parse(String(args[i][5]));
  assertEquals(payload.from, "evidence_only");
  assertEquals(payload.to, "confirmed");
  assertEquals(payload.action, "confirm");
  assertEquals(payload.note, "checked by hand");
  assertEquals(args[i][4], "devon");
});

Deno.test("a supersede records what replaced the memory", async () => {
  const { deps, sql, args } = recordingPool();
  await performReview(deps, {
    memory_id: "m-1", action: "supersede", actor: ACTOR, superseded_by: "m-2",
  });
  const i = sql.findIndex((s) => s.includes("INSERT INTO agent_memory_audit_events"));
  assertEquals(JSON.parse(String(args[i][5])).superseded_by, "m-2");
});

// ── the queue ────────────────────────────────────────────────────────────────
// ── THE PLANE ESCALATION ─────────────────────────────────────────────────────
// Found by a verifier reading this branch, in code whose READ boundary had just been
// proved live. performReview SELECTed `exposure` so it could report it and never FILTERED
// on it, `agent_memory_review` is on the ops door's GATEWAY_WRITE_TOOLS, and
// `promote_exposure` is the ONLY action that widens exposure (agent-memory-review.ts:
// `exposure: "ops"`). So an ops-door caller could take a PERSONAL memory's id, promote it
// onto the ops plane, and then read it through every closed read tool entirely
// legitimately. The containment was never defeated - the memory was moved past it.
//
// The refusal is not_found for the same reason inspect's is: "it exists but you may not
// see it" confirms the memory to anyone who can guess an id.

/** A pool where the FOR UPDATE resolve finds nothing (off plane) but the id DOES exist. */
function offPlanePool() {
  const sql: string[] = [];
  const args: unknown[][] = [];
  const deps = {
    doorExposure: "ops",
    pool: {
      connect: () =>
        Promise.resolve({
          queryObject: (s: string, a?: unknown[]) => {
            sql.push(s);
            args.push(a ?? []);
            if (s.includes("SELECT 1 FROM agent_memories")) {
              return Promise.resolve({ rows: [{ x: 1 }] as unknown[] });
            }
            return Promise.resolve({ rows: [] as unknown[] });
          },
          release: () => {},
        }),
    },
  };
  return { deps, sql, args };
}

Deno.test("promote_exposure CANNOT widen a memory this door may not see", async () => {
  const { deps, sql } = offPlanePool();
  const out = await performReview(deps, {
    memory_id: "personal-1",
    action: "promote_exposure",
    actor: ACTOR,
  });
  assertEquals(out.ok, false);
  if (!out.ok) assertEquals(out.refused, "not_found");
  assertEquals(sql.some((s) => s.startsWith("UPDATE agent_memories")), false, "nothing may be written");
  assertEquals(sql[sql.length - 1], "ROLLBACK");
});

Deno.test("the refused review leaves an access_refused row naming the tool", async () => {
  const { deps, sql, args } = offPlanePool();
  await performReview(deps, { memory_id: "personal-1", action: "promote_exposure", actor: ACTOR });
  const i = sql.findIndex((s) => s.includes("access_refused"));
  assertEquals(i >= 0, true, "stopped, but invisible - U5 requires the attempt to be recorded");
  assertEquals(args[i][0], "personal-1");
  assertEquals(JSON.parse(String(args[i][1])).tool, "agent_memory_review");
});

Deno.test("EVERY review action is bounded by the plane, not just promote_exposure", async () => {
  // The enumerate-and-patch failure mode, closed at the level of the set: the guard is on
  // the RESOLVE, so there is no action that reaches an off-plane row. A new action added to
  // TRANSITIONS is covered the day it is added, without anyone remembering to cover it.
  for (const action of REVIEW_ACTIONS) {
    const { deps, sql } = offPlanePool();
    const out = await performReview(deps, { memory_id: "personal-1", action, actor: ACTOR });
    assertEquals(out.ok, false, action);
    assertEquals(
      sql.some((s) => s.startsWith("UPDATE agent_memories")),
      false,
      `${action} reached the UPDATE on an off-plane memory`,
    );
  }
});

Deno.test("the review resolve and the UPDATE are BOTH plane-bounded", async () => {
  // Belt and braces on purpose. The resolve is what refuses; the WHERE is what keeps the
  // refusal true if a future edit reorders them or drops one.
  const { deps, sql, args } = recordingPool();
  await performReview(deps, { memory_id: "m-1", action: "confirm", actor: ACTOR });
  const sel = sql.findIndex((s) => s.includes("FOR UPDATE"));
  assertEquals(sql[sel].includes("COALESCE(metadata->>'exposure', 'personal') = ANY($2)"), true);
  assertEquals(args[sel][1], ["ops"]);
  const upd = sql.findIndex((s) => s.startsWith("UPDATE agent_memories"));
  assertEquals(sql[upd].includes("COALESCE(metadata->>'exposure', 'personal') = ANY("), true);
  assertEquals(args[upd][args[upd].length - 1], ["ops"]);
});

// The queue's args are built by agent-memory-plane.ts's PlaneQuery, so $1 is the door's
// exposure plane and everything else follows it. That ordering is not incidental: the
// builder emits the plane predicate BEFORE the caller's build() callback runs, which is
// what makes a queue query without the plane unconstructible rather than merely unusual.
Deno.test("the queue is plane-bounded FIRST, then filtered", async () => {
  const { deps, sql, args } = recordingPool();
  await listForReview(deps, {});
  assertEquals(
    sql[0].includes("WHERE COALESCE(metadata->>'exposure', 'personal') = ANY($1)"),
    true,
    sql[0],
  );
  assertEquals(args[0][0], ["ops"]);
});

Deno.test("the queue defaults to the states nobody has acted on", async () => {
  const { deps, args } = recordingPool();
  await listForReview(deps, {});
  assertEquals(args[0][1], ["pending", "evidence_only"]);
});

Deno.test("the queue limit is clamped, so one call cannot drain the store", async () => {
  const { deps, args } = recordingPool();
  await listForReview(deps, { limit: 100000 });
  assertEquals(args[0][2], 200);
  const b = recordingPool();
  await listForReview(b.deps, { limit: -5 });
  assertEquals(b.args[0][2], 1);
});

Deno.test("the queue parameterises the workspace filter", async () => {
  const evil = "ws'; DROP TABLE agent_memories; --";
  const { deps, sql, args } = recordingPool();
  await listForReview(deps, { workspace_id: evil });
  assertEquals(sql[0].includes("DROP TABLE"), false);
  assertEquals(args[0].includes(evil), true);
});

Deno.test("omitting the workspace lists every workspace, rather than none", async () => {
  const { deps, sql } = recordingPool();
  await listForReview(deps, {});
  assertEquals(sql[0].includes("workspace_id ="), false);
});
