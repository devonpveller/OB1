// deno test src/contracts/cleanup_test.ts - the cleanup view's decisions and request shapes (rw-p8a2-cleanup;
// D5 items 4-7), no database. The DB behaviour and the two-user isolation are in
// src/contracts/cleanup_integration_test.ts (run by contract-test/run-workspace-tests.ps1).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type CandidateAttempt, type CandidateTombstone, candidateOf, eraseOffered, tallyCounts } from "./logic/cleanup.ts";
import { kindDefs } from "./logic/dependence.ts";
import { CleanupEraseRequest, CleanupLiftRequest, CleanupSeverRequest, ProcessAllRequest, ReopenCandidate } from "./schemas/cleanup.ts";
import { buildDocument } from "./gen.ts";

const AT = "2026-11-01T00:00:00.000Z";
const clears = { available: true, value: 0.8, floor: 0.5, version: "v2", reason: "stub" };
const below = { available: true, value: 0.3, floor: 0.5, version: "v2", reason: "stub" };
const att = (outcome: string, over: Partial<CandidateAttempt> = {}): CandidateAttempt => ({
  path: "intake", outcome, session_id: null, note: null, attempted_at: AT, reason: "why", score: null, ...over,
});
const tomb = (over: Partial<CandidateTombstone> = {}): CandidateTombstone => ({
  id: "t1", reason_type: "debunked", note: "it was debunked", erased_at: AT, lifted_at: null, readmitted_source_id: null, attempts: [], ...over,
});

Deno.test("D5 item 5: erase is offered only for an unlinked source with zero blocking connections", () => {
  assertEquals(eraseOffered("unlinked", 0), true);
  assertEquals(eraseOffered("unlinked", 1), false, "an erase button on a source with dependence FAILS");
  assertEquals(eraseOffered("suppressed", 0), false);
  assertEquals(eraseOffered("active", 0), false);
});

Deno.test("dependence counts tally by the registry: trail events never block; an undeclared kind blocks and is not severable", () => {
  const defs = kindDefs([
    { key: "chunk", definition: { blocks_erase: true, severable: true } },
    { key: "trail_event", definition: { blocks_erase: false, severable: false } },
    { key: "document_link", definition: { blocks_erase: true, severable: false } },
  ]);
  assertEquals(tallyCounts({ chunk: 3, trail_event: 5, document_link: 1, brand_new_kind: 2 }, defs),
    { counts: { chunk: 3, trail_event: 5, document_link: 1, brand_new_kind: 2 }, blocking: 6, severable: 3, total: 11 });
  assertEquals(tallyCounts({}, defs), { counts: {}, blocking: 0, severable: 0, total: 0 });
});

Deno.test("D5 item 7: a user-erased debunked return that cleared its floor is a proposed contesting source, dispute previewed", () => {
  const c = candidateOf(tomb({ attempts: [att("refused"), att("candidate", { score: clears })] }), "rescore_contest", "candidate");
  assert(c);
  assertEquals(c.kind, "proposed_contesting");
  assertEquals(c.evidence.length, 1, "the evidence is the attempt that made it a candidate");
  assertEquals(c.dispute_preview, {
    criticism: { tombstone_id: "t1", reason_type: "debunked", note: "it was debunked", erased_at: AT }, score: clears,
  });
});

Deno.test("D5 item 7: a user-erased credibility return over its bar is a credibility candidate; deliberate notes are candidates", () => {
  const c = candidateOf(tomb({ reason_type: "credibility", attempts: [att("candidate", { score: clears })] }), "bar_check", "candidate");
  assertEquals([c?.kind, c?.evidence.length, c?.dispute_preview], ["credibility_cleared", 1, null]);
  for (const gate of ["candidate", "auto"]) {
    const n = candidateOf(tomb({ reason_type: "deliberate", attempts: [att("note_appended", { path: "query", session_id: "s1", note: "looks promising" })] }), "note_only", gate);
    assertEquals([n?.kind, n?.evidence[0].note], ["reopen_note", "looks promising"], gate);
  }
});

Deno.test("never a candidate: automation-erased readmissions, lifted / readmitted tombstones, attempts without evidence", () => {
  // automation-erased: the gate readmits it itself - a trail event, never parked as a candidate
  assertEquals(candidateOf(tomb({ attempts: [att("admitted_contesting", { score: clears })], readmitted_source_id: "s9" }), "rescore_contest", "auto"), null);
  assertEquals(candidateOf(tomb({ attempts: [att("candidate", { score: clears })] }), "rescore_contest", "auto"), null);
  assertEquals(candidateOf(tomb({ attempts: [att("candidate", { score: clears })], lifted_at: AT }), "rescore_contest", "candidate"), null);
  assertEquals(candidateOf(tomb({ attempts: [att("candidate", { score: clears })], readmitted_source_id: "s9" }), "rescore_contest", "candidate"), null);
  // a candidate without its evidence FAILS: a refused attempt, a score below the floor, no score at all
  assertEquals(candidateOf(tomb({ attempts: [att("refused", { score: below })] }), "rescore_contest", "candidate"), null);
  assertEquals(candidateOf(tomb({ attempts: [att("candidate", { score: below })] }), "rescore_contest", "candidate"), null);
  assertEquals(candidateOf(tomb({ attempts: [att("candidate")] }), "bar_check", "candidate"), null);
  assertEquals(candidateOf(tomb({ attempts: [] }), "note_only", "candidate"), null);
  assertEquals(candidateOf(tomb({ attempts: [att("candidate", { score: clears })] }), "a_new_path", "candidate"), null);
});

Deno.test("D5 item 4: the process-all body is ONE reason type and the marked sources - a note is refused", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  assert(ProcessAllRequest.safeParse({ reason_type: "deliberate", source_ids: [id] }).success);
  assertEquals(ProcessAllRequest.safeParse({ reason_type: "deliberate", source_ids: [id], note: "a note" }).success, false, "a bulk run that takes a note FAILS");
  assertEquals(ProcessAllRequest.safeParse({ source_ids: [id] }).success, false, "no reason type");
  assertEquals(ProcessAllRequest.safeParse({ reason_type: "", source_ids: [id] }).success, false);
  assertEquals(ProcessAllRequest.safeParse({ reason_type: "deliberate", source_ids: [] }).success, false);
  assertEquals(ProcessAllRequest.safeParse({ reason_type: "deliberate", source_ids: ["not-a-uuid"] }).success, false);
});

Deno.test("D5 item 4: a manual erase takes a required reason type and an optional note", () => {
  assert(CleanupEraseRequest.safeParse({ reason_type: "credibility" }).success);
  assert(CleanupEraseRequest.safeParse({ reason_type: "credibility", note: "why" }).success);
  assertEquals(CleanupEraseRequest.safeParse({ note: "why" }).success, false, "an erase without a reason type FAILS");
  assertEquals(CleanupEraseRequest.safeParse({ reason_type: "" }).success, false);
});

Deno.test("07-MULTI-USER: no cleanup body takes a user - the actor is the identity seam's, never the caller's", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  assertEquals(CleanupEraseRequest.safeParse({ reason_type: "deliberate", eraser: { kind: "user", user: "someone" } }).success, false);
  assertEquals(CleanupEraseRequest.safeParse({ reason_type: "deliberate", by: "someone" }).success, false);
  assertEquals(ProcessAllRequest.safeParse({ reason_type: "deliberate", source_ids: [id], by: "someone" }).success, false);
  assertEquals(CleanupSeverRequest.safeParse({ all: true, by: "someone" }).success, false);
  // round 3 (with rw-p8a1-core's trail lift): a lift's `by` is accepted and IGNORED - the route acts as the seam
  assert(CleanupLiftRequest.safeParse({ by: "someone" }).success);
  assertEquals(CleanupLiftRequest.safeParse({ lifted_by: "someone" }).success, false);
  // the document says the same: no cleanup request body has a user-shaped property
  const doc = buildDocument() as { paths: Record<string, Record<string, Record<string, any>>>; components: { schemas: Record<string, any> } };
  const cleanupOps = Object.entries(doc.paths).filter(([p]) => p.includes("/cleanup/")).flatMap(([, item]) => Object.values(item));
  assertEquals(cleanupOps.length, 8, "the cleanup routes are in the OpenAPI document");
  for (const o of cleanupOps) {
    const ref = o.requestBody?.content?.["application/json"]?.schema?.$ref as string | undefined;
    if (!ref) continue;
    const props = Object.keys(doc.components.schemas[ref.split("/").pop()!].properties ?? {});
    for (const bad of ["by", "user", "eraser", "owner_sub", "actor_sub", "sub"]) {
      if (bad === "by" && o.operationId === "cleanupLift") continue; // accepted and ignored (round 3)
      assert(!props.includes(bad), `${o.operationId} takes ${bad}`);
    }
    if (o.operationId === "cleanupProcessAll") assertEquals(props.sort(), ["reason_type", "source_ids"]);
  }
});

Deno.test("a reopen candidate cannot be sent without its evidence (the schema refuses an empty evidence list)", () => {
  const base = {
    kind: "reopen_note",
    tombstone: { id: "66666666-6666-4666-8666-666666666666", source_id: "55555555-5555-4555-8555-555555555555", url: "u", title: "t", reason_type: "deliberate", note: null, eraser_kind: "user", erased_by_you: false, erased_at: AT, confidence: null, score_version: null },
    dispute_preview: null,
  };
  assertEquals(ReopenCandidate.safeParse({ ...base, evidence: [] }).success, false);
  assert(ReopenCandidate.safeParse({ ...base, evidence: [{ path: "query", outcome: "note_appended", session_id: null, note: "n", attempted_at: AT, reason: null, score: null }] }).success);
});
