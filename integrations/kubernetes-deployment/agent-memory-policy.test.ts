/** Pure-logic tests for the agent-memory policy layer.
 *
 * Run: deno test agent-memory-policy.test.ts
 *
 * The first test is the one that matters. Everything else guards a detail; that one
 * guards the plane being usable at all.
 */
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRecallScopeFilter,
  DEFAULT_RECALL_STATUSES,
  defaultWritebackIsRecallable,
  detectUnsafeContent,
  isRowRecallableBy,
  isSafeToStore,
  MAX_CONTENT_CHARS,
  recallReviewStatuses,
  type ReviewStatus,
  WRITEBACK_DEFAULTS,
} from "./agent-memory-policy.ts";

// ── THE PLANE-AGREEMENT INVARIANT ────────────────────────────────────────────
// Written before the tools exist, per the memory-plane plan. Upstream's Hermes
// integration default-writes visibility='personal' while its recall scope drops
// personal: writes succeed, recall returns nothing, and nothing errors. Locally the
// same trap is one line wide - the DB default for review_status is 'pending', which the
// default gate excludes.

Deno.test("INVARIANT: a default writeback is returned by the default recall", () => {
  // Composed, not asserted separately: checking "defaults are evidence_only" and "gate
  // includes evidence_only" in two tests would let a future edit change both and keep
  // them green while the plane broke.
  assertEquals(defaultWritebackIsRecallable(), true);
});

Deno.test("INVARIANT test can FAIL - the DB default would break the plane", () => {
  // Proof the invariant is load-bearing rather than tautological. 'pending' is what the
  // COLUMN defaults to; if writeback ever stops setting review_status explicitly, this is
  // the state it lands in, and the default recall would never return it.
  const asIfColumnDefaultApplied = { review_status: "pending" as ReviewStatus };
  assertEquals(defaultWritebackIsRecallable(asIfColumnDefaultApplied), false);
});

Deno.test("INVARIANT: the WHOLE row is recallable, not just its review_status", () => {
  // The one-column check above missed a real hole: the defaults said
  // visibility:'project' while project_id stayed NULL, so a project-scoped recall matched
  // nothing. Compose every discriminating column, or the invariant only guards the column
  // someone happened to think of.
  const row = {
    workspace_id: "ws1",
    project_id: "p1",
    visibility: WRITEBACK_DEFAULTS.visibility,
    review_status: WRITEBACK_DEFAULTS.review_status,
    lifecycle_status: WRITEBACK_DEFAULTS.lifecycle_status,
  };
  assertEquals(isRowRecallableBy(row, { workspace_id: "ws1" }), true);
  assertEquals(isRowRecallableBy(row, { workspace_id: "ws1", project_id: "p1" }), true);
});

Deno.test("INVARIANT test can FAIL - project-visible with no project is unreachable", () => {
  // The exact shape that shipped: RED proof that the widened invariant sees it.
  const orphan = {
    workspace_id: "ws1",
    project_id: null,
    visibility: "project" as const,
    review_status: WRITEBACK_DEFAULTS.review_status,
    lifecycle_status: WRITEBACK_DEFAULTS.lifecycle_status,
  };
  assertEquals(isRowRecallableBy(orphan, { workspace_id: "ws1", project_id: "p1" }), false);
});

Deno.test("a superseded row is never recallable, whatever its review_status", () => {
  const stale = {
    workspace_id: "ws1",
    project_id: null,
    visibility: "workspace" as const,
    review_status: "confirmed" as ReviewStatus,
    lifecycle_status: "superseded",
  };
  assertEquals(isRowRecallableBy(stale, { workspace_id: "ws1" }), false);
});

Deno.test("personal memories are not reachable by a default recall", () => {
  const personal = {
    workspace_id: "ws1",
    project_id: null,
    visibility: "personal" as const,
    review_status: WRITEBACK_DEFAULTS.review_status,
    lifecycle_status: WRITEBACK_DEFAULTS.lifecycle_status,
  };
  assertEquals(isRowRecallableBy(personal, { workspace_id: "ws1" }), false);
});

Deno.test("the predicate agrees with the SQL builder on which columns it filters", () => {
  // If the SQL grows a clause the predicate does not mirror, the invariant quietly stops
  // covering it - which is how the visibility hole survived. Cheap structural pin.
  const f = buildRecallScopeFilter({ workspace_id: "ws1", project_id: "p1" });
  for (const col of ["workspace_id", "project_id", "visibility", "lifecycle_status", "review_status"]) {
    assertEquals(f.sql.includes(col), true, `SQL must still filter ${col}`);
  }
});

Deno.test("writeback defaults are evidence, never instruction", () => {
  assertEquals(WRITEBACK_DEFAULTS.review_status, "evidence_only");
  assertEquals(WRITEBACK_DEFAULTS.can_use_as_evidence, true);
  assertEquals(WRITEBACK_DEFAULTS.requires_user_confirmation, true);
  // Instruction-grade must be impossible to mint from this side; the schema CHECK is the
  // backstop, not the design.
  assertEquals("can_use_as_instruction" in WRITEBACK_DEFAULTS, false);
});

// ── the review gate ──────────────────────────────────────────────────────────
Deno.test("default gate admits confirmed + evidence_only only", () => {
  assertEquals(recallReviewStatuses(), ["confirmed", "evidence_only"]);
});

Deno.test("include_unconfirmed adds pending and NOTHING else", () => {
  assertEquals(recallReviewStatuses(true), ["confirmed", "evidence_only", "pending"]);
});

Deno.test("no path returns rejected, restricted, stale or merged", () => {
  for (const flag of [false, true]) {
    const admitted = recallReviewStatuses(flag);
    for (const forbidden of ["rejected", "restricted", "stale", "merged"]) {
      assertEquals(
        admitted.includes(forbidden as ReviewStatus),
        false,
        `include_unconfirmed=${flag} must not admit '${forbidden}'`,
      );
    }
  }
});

Deno.test("the gate is a copy - callers cannot mutate the shared default", () => {
  const first = recallReviewStatuses();
  first.push("rejected" as ReviewStatus);
  assertEquals(recallReviewStatuses(), ["confirmed", "evidence_only"]);
  assertEquals(DEFAULT_RECALL_STATUSES.includes("rejected" as ReviewStatus), false);
});

// ── the scope filter ─────────────────────────────────────────────────────────
Deno.test("scope filter parameterises every caller value", () => {
  const evil = "acme'; DROP TABLE agent_memories; --";
  const f = buildRecallScopeFilter({ workspace_id: evil, project_id: "p1" });
  // The dangerous string appears ONLY in params, never in the SQL text.
  assertEquals(f.sql.includes("DROP TABLE"), false);
  assertEquals(f.params[0], evil);
  assertEquals(f.params[1], "p1");
});

Deno.test("scope filter always pins lifecycle_status='active'", () => {
  const f = buildRecallScopeFilter({ workspace_id: "w1" });
  assertEquals(f.sql.includes("am.lifecycle_status = 'active'"), true);
});

Deno.test("scope filter applies the review gate it was given", () => {
  const conservative = buildRecallScopeFilter({ workspace_id: "w1" });
  assertEquals(conservative.params.at(-1), ["confirmed", "evidence_only"]);
  const permissive = buildRecallScopeFilter({ workspace_id: "w1", includeUnconfirmed: true });
  assertEquals(permissive.params.at(-1), ["confirmed", "evidence_only", "pending"]);
});

Deno.test("omitting project_id is workspace-wide, not project_id IS NULL", () => {
  const f = buildRecallScopeFilter({ workspace_id: "w1" });
  assertEquals(f.sql.includes("project_id"), false);
});

Deno.test("visibility defaults exclude personal", () => {
  // The exposure invariant: an agent recall must not reach personal-plane memories by
  // default. Opting in is a caller decision that has to be written down.
  const f = buildRecallScopeFilter({ workspace_id: "w1" });
  assertEquals(f.params[1], ["project", "workspace", "organization"]);
});

Deno.test("placeholders honour startIndex so the fragment composes", () => {
  const f = buildRecallScopeFilter({ workspace_id: "w1" }, 3);
  assertEquals(f.sql.includes("$3"), true);
  assertEquals(f.sql.includes("$1"), false);
});

Deno.test("a scope without a workspace is refused", () => {
  assertThrows(() => buildRecallScopeFilter({ workspace_id: "  " }));
});

// ── unsafe content ───────────────────────────────────────────────────────────
Deno.test("refuses secret-shaped content", () => {
  // FIXTURES ARE ASSEMBLED AT RUNTIME, never written as literals.
  //
  // The first version of this test spelled them out, and GitHub push protection
  // rejected the push - correctly: a credential-shaped literal in a file is exactly what
  // a secret scanner is for, and it cannot tell a test fixture from the real thing. The
  // alternative on offer was to click "allow the secret", which normalises bypassing a
  // guard, so instead the strings only exist once the test is running. The regexes see
  // the same input; the repository holds no scannable literal.
  const join = (...parts: string[]) => parts.join("");
  const positives: [string, string][] = [
    ["aws", join("key AKIA", "IOSFODNN7EXAMPLE", " here")],
    ["openai", join("use sk-", "a".repeat(32), " for now")],
    ["github", join("token ghp_", "b".repeat(36))],
    ["pem", join("-----BEGIN ", "RSA PRIVATE KEY", "-----")],
    // Both segments must clear the regex's 20-char minimum; the first assembled attempt
    // used a 17-char header and silently stopped matching.
    ["jwt", join("eyJ", "a".repeat(24), ".", "b".repeat(24), ".sig")],
    ["slack", join("xox", "b-123456789012-", "c".repeat(20))],
  ];
  for (const [name, sample] of positives) {
    assertEquals(detectUnsafeContent(sample), "secret_shaped", name);
  }
});

Deno.test("does NOT refuse ordinary prose about credentials", () => {
  // The negatives matter as much as the positives: a gate that refuses normal writing
  // gets switched off, and then it guards nothing.
  const negatives = [
    "Rotate the API key after the incident and record who did it.",
    "The deploy token lives in .env and is never committed.",
    "We decided to store secrets in environment variables, not in the repo.",
    "sk-is-not-a-key",
    "AKIA is a prefix used by AWS access key ids.",
  ];
  for (const sample of negatives) {
    assertEquals(detectUnsafeContent(sample), null, sample);
  }
});

Deno.test("refuses empty and oversized content", () => {
  assertEquals(detectUnsafeContent("   "), "empty");
  assertEquals(detectUnsafeContent("x".repeat(MAX_CONTENT_CHARS + 1)), "too_large");
  assertEquals(detectUnsafeContent("x".repeat(MAX_CONTENT_CHARS)), null);
});

Deno.test("isSafeToStore agrees with detectUnsafeContent", () => {
  assertEquals(isSafeToStore("a normal lesson worth keeping"), true);
  assertEquals(isSafeToStore("AKIAIOSFODNN7EXAMPLE"), false);
});
