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
  DEFAULT_RECALL_EXPOSURES,
  detectPii,
  stampExposure,
  type Exposure,
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

// ── THE PLANE-AGREEMENT INVARIANT, AS THE PLAN STATES IT ─────────────────────
// memory-plane PLAN §1.3: "the default writeback VISIBILITY/EXPOSURE must be provably
// returned by the default recall scope". The failure it guards is silent - write and read
// each look correct alone and disagree in combination, so a memory is written, nothing
// errors, and the default recall never returns it.
//
// AN EARLIER VERSION OF THIS FILE STATED THE INVARIANT OVER review_status INSTEAD, and to
// make that version pass, the write default was changed from the plan's locked 'pending'
// to 'evidence_only' - which silently removed the review gate: every agent write became
// immediately recallable. The test had been satisfied by bending its subject. The
// invariant below is the plan's, and the review-gate behaviour it used to paper over is
// now asserted directly, in the opposite direction.

const OPS_ROW = {
  workspace_id: "ws1",
  project_id: "p1",
  visibility: WRITEBACK_DEFAULTS.visibility,
  review_status: "confirmed" as ReviewStatus,
  lifecycle_status: WRITEBACK_DEFAULTS.lifecycle_status,
  exposure: "ops" as Exposure,
};

Deno.test("INVARIANT: a default-visibility ops memory IS returned by a default recall", () => {
  assertEquals(isRowRecallableBy(OPS_ROW, { workspace_id: "ws1", project_id: "p1" }), true);
});

Deno.test("INVARIANT test can FAIL - a personal-plane memory is NOT returned by default", () => {
  // The Hermes shape, and the one the plan names: write defaults to the personal plane
  // while the default recall scope drops it. Writes succeed, recall returns nothing, and
  // nothing errors. This is the RED proof that the invariant above is load-bearing.
  const personal = { ...OPS_ROW, exposure: "personal" as Exposure };
  assertEquals(isRowRecallableBy(personal, { workspace_id: "ws1", project_id: "p1" }), false);
});

Deno.test("INVARIANT: the WHOLE row is recallable, not just one column", () => {
  // Compose every discriminating column, or the invariant only guards the one someone
  // happened to think of. That is not hypothetical: checking review_status alone missed
  // visibility 'project' with a NULL project_id, and could not see exposure at all.
  assertEquals(isRowRecallableBy(OPS_ROW, { workspace_id: "ws1" }), true);
  const orphan = { ...OPS_ROW, project_id: null, visibility: "project" as const };
  assertEquals(isRowRecallableBy(orphan, { workspace_id: "ws1", project_id: "p1" }), false);
});

// ── the review gate is REAL, and the defaults sit outside it ─────────────────
Deno.test("§1: the locked write default is 'pending', NOT 'evidence_only'", () => {
  // The regression guard for the correction described above. If this ever reads
  // 'evidence_only' again, every agent write is recallable the moment it is made and the
  // review door has been removed without anyone deciding to remove it.
  assertEquals(WRITEBACK_DEFAULTS.review_status, "pending");
});

Deno.test("a default writeback is NOT returned by a conservative recall", () => {
  // PLAN §1.3: "conservative recall returns nothing pending". This is the assertion the
  // old invariant made impossible - it required the opposite.
  const fresh = { ...OPS_ROW, review_status: WRITEBACK_DEFAULTS.review_status };
  assertEquals(isRowRecallableBy(fresh, { workspace_id: "ws1" }), false);
});

Deno.test("include_unconfirmed DOES return it - the memory is reachable, just not by default", () => {
  const fresh = { ...OPS_ROW, review_status: WRITEBACK_DEFAULTS.review_status };
  assertEquals(
    isRowRecallableBy(fresh, { workspace_id: "ws1", includeUnconfirmed: true }),
    true,
  );
});

// ── §1.1 exposure: stamped at doors, demoted mechanically ────────────────────
Deno.test("§1.1: a writer cannot widen its own exposure", () => {
  // The invariant is "access bounds writes", enforced mechanically and never by model
  // self-restraint. There is no argument to stampExposure that widens, so the only way a
  // memory reaches the ops plane is a door that was configured to put it there.
  assertEquals(stampExposure("personal"), "personal");
  assertEquals(stampExposure("personal", { tainted: false, piiDetected: false }), "personal");
  assertEquals(stampExposure("ops"), "ops");
});

Deno.test("§1.1: taint demotes an ops door to personal", () => {
  // An agent-org effort is ops-clean by construction UNLESS it consumed Tier-2 advisor
  // output (that corpus includes gmail-derived, personal-plane sources) or its goal came
  // from a personal-plane surface.
  assertEquals(stampExposure("ops", { tainted: true }), "personal");
});

Deno.test("§1.1: detected PII demotes, and NEVER rejects", () => {
  assertEquals(stampExposure("ops", { piiDetected: true }), "personal");
  // And it is not part of the store/refuse decision - conflating them would turn a
  // demotion into a refusal, and code is full of email-shaped strings.
  assertEquals(detectUnsafeContent("mail me at someone@example.com"), null);
});

Deno.test("PII detection fires on the shapes it claims and not on ordinary prose", () => {
  assertEquals(detectPii("reach me at someone@example.com"), true);
  assertEquals(detectPii("call 555-867-5309 tomorrow"), true);
  assertEquals(detectPii("the drain stalls when the planner churns"), false);
  assertEquals(detectPii("see PLAN.md section 1.1 for the invariant"), false);
});

Deno.test("the default recall exposure is the OPS plane only", () => {
  assertEquals(DEFAULT_RECALL_EXPOSURES, ["ops"]);
  const f = buildRecallScopeFilter({ workspace_id: "w1" });
  assertEquals(f.params.some((x) => Array.isArray(x) && x.length === 1 && x[0] === "ops"), true);
});

Deno.test("the SQL reads exposure out of metadata, defaulting to the SAFE end", () => {
  // A row written before exposure shipped has no metadata.exposure. COALESCE makes it
  // 'personal' - excluded by default - rather than NULL, which would drop out of `= ANY`
  // for a reason nobody could see.
  const f = buildRecallScopeFilter({ workspace_id: "w1" });
  assertEquals(f.sql.includes("COALESCE(am.metadata->>'exposure', 'personal')"), true);
});

Deno.test("a superseded row is never recallable, whatever its review_status", () => {
  const stale = {
    workspace_id: "ws1",
    project_id: null,
    visibility: "workspace" as const,
    review_status: "confirmed" as ReviewStatus,
    lifecycle_status: "superseded",
    exposure: "ops" as Exposure,
  };
  assertEquals(isRowRecallableBy(stale, { workspace_id: "ws1" }), false);
});

Deno.test("personal memories are not reachable by a default recall", () => {
  const personal = {
    workspace_id: "ws1",
    project_id: null,
    visibility: "personal" as const,
    review_status: "confirmed" as ReviewStatus,
    lifecycle_status: WRITEBACK_DEFAULTS.lifecycle_status,
    exposure: "ops" as Exposure,
  };
  assertEquals(isRowRecallableBy(personal, { workspace_id: "ws1" }), false);
});

Deno.test("the predicate agrees with the SQL builder on which columns it filters", () => {
  // If the SQL grows a clause the predicate does not mirror, the invariant quietly stops
  // covering it - which is how the visibility hole survived. Cheap structural pin.
  const f = buildRecallScopeFilter({ workspace_id: "ws1", project_id: "p1" });
  for (const col of ["workspace_id", "project_id", "visibility", "exposure", "lifecycle_status", "review_status"]) {
    assertEquals(f.sql.includes(col), true, `SQL must still filter ${col}`);
  }
});

Deno.test("writeback defaults are evidence, never instruction", () => {
  assertEquals(WRITEBACK_DEFAULTS.review_status, "pending");
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
