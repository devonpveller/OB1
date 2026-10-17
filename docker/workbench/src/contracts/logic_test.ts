// deno test src/contracts/logic_test.ts - the pure decision logic of the contract, no database.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { decideReopen, type ReopenInput, type ScoreResult } from "./logic/reopen.ts";
import { aggregateDependence, kindDefs } from "./logic/dependence.ts";
import { admissionScore, refineryScopedScore, termDef } from "./logic/credibility.ts";
import { BadRequest, parseFlag, parseLimit, parseMetadataFilter } from "./logic/scope.ts";
import { evidenceVisibleStates, sourceRecordState } from "./logic/state.ts";

const score = (value: number | null, floor = 0.5, version = "v2"): ScoreResult => ({
  available: value !== null, value, floor, version, reason: value === null ? "unavailable" : "scored",
});
const tomb = { confidence: 0.4, score_version: "v1", fingerprint: "f-old" };
const input = (over: Partial<ReopenInput>): ReopenInput => ({
  path: "rescore_contest", gate: "auto", tombstone: tomb, score: score(0.8), candidateFingerprint: "f-new", ...over,
});

// ── D5 items 6-7: reason type = path, eraser = gate ────────────────────────────────────────
Deno.test("debunked + automation: clears its floor -> admitted as contesting, no confirmation", () => {
  const d = decideReopen(input({}));
  assertEquals(d.outcome, "admitted_contesting");
  assertEquals(d.admits, true);
});

Deno.test("debunked + automation below the floor -> refused", () => {
  const d = decideReopen(input({ score: score(0.3) }));
  assertEquals([d.outcome, d.admits], ["refused", false]);
});

Deno.test("debunked + user: clears its floor -> only a candidate", () => {
  const d = decideReopen(input({ gate: "candidate" }));
  assertEquals([d.outcome, d.admits], ["candidate", false]);
});

Deno.test("credibility + automation: bar cleared on all three facts -> admitted outright", () => {
  const d = decideReopen(input({ path: "bar_check" }));
  assertEquals([d.outcome, d.admits], ["admitted", true]);
});

Deno.test("credibility + user: bar cleared -> candidate (a user-erased tombstone never readmits without a lift)", () => {
  const d = decideReopen(input({ path: "bar_check", gate: "candidate" }));
  assertEquals([d.outcome, d.admits], ["candidate", false]);
});

Deno.test("credibility without the bar computable (missing confidence / version / fingerprint) -> refused", () => {
  for (const missing of ["confidence", "score_version", "fingerprint"] as const) {
    const d = decideReopen(input({ path: "bar_check", tombstone: { ...tomb, [missing]: null } }));
    assertEquals([d.outcome, d.admits], ["refused", false], missing);
    assert(d.reason.includes("cannot be computed"));
  }
});

Deno.test("credibility: unchanged content under the same score version -> refused", () => {
  const d = decideReopen(input({ path: "bar_check", candidateFingerprint: "f-old", score: score(0.9, 0.5, "v1") }));
  assertEquals(d.outcome, "refused");
});

Deno.test("credibility: re-scored but not above the confidence at removal -> refused", () => {
  const d = decideReopen(input({ path: "bar_check", score: score(0.4, 0.3) }));
  assertEquals(d.outcome, "refused");
});

Deno.test("deliberate: appends a reopen note, admits nothing, whoever erased", () => {
  for (const gate of ["auto", "candidate"]) {
    const d = decideReopen(input({ path: "note_only", gate }));
    assertEquals([d.outcome, d.admits], ["note_appended", false]);
  }
});

Deno.test("no score available (P3a not landed) -> refused on both scoring paths", () => {
  for (const path of ["rescore_contest", "bar_check"]) {
    assertEquals(decideReopen(input({ path, score: score(null) })).admits, false);
  }
});

Deno.test("an unknown path or gate fails closed", () => {
  assertEquals(decideReopen(input({ path: "teleport" })).admits, false);
  assertEquals(decideReopen(input({ gate: "maybe" })).admits, false);
});

// ── D5 stage 2: dependence aggregation, declared by the registry ───────────────────────────
Deno.test("dependence: counts by kind and by claim edge type; blocking follows the registry", () => {
  const defs = kindDefs([
    { key: "claim_edge", definition: { blocks_erase: true, severable: true } },
    { key: "trail_event", definition: { blocks_erase: false, severable: false } },
  ]);
  const agg = aggregateDependence([
    { kind: "claim_edge", ref: "1", detail: { edge_type: "states" } },
    { kind: "claim_edge", ref: "2", detail: { edge_type: "corroborates" } },
    { kind: "claim_edge", ref: "3", detail: { edge_type: "states" } },
    { kind: "trail_event", ref: "9", detail: {} },
    { kind: "undeclared_kind", ref: "x", detail: {} },
  ], defs);
  assertEquals(agg.total, 5);
  assertEquals(agg.blocking, 4); // trail events do not block; an undeclared kind does (fail closed)
  assertEquals(agg.claims_by_edge_type, { states: 2, corroborates: 1 });
  assertEquals(agg.counts.claim_edge, 3);
  assertEquals(agg.connections.find((c) => c.kind === "undeclared_kind")?.severable, false);
});

// ── ingestion model item 4: user_provided is refinery-scoped only, zero for admission ──────
Deno.test("user_provided raises the refinery-scoped score and never the admission score", () => {
  const t = termDef({ term_version: 1, refinery_weight: 0.15, admission_weight: 0.9 });
  assertEquals(refineryScopedScore(0, true, t), 0.15);
  assertEquals(refineryScopedScore(0, false, t), 0);
  // even a registry entry claiming an admission weight cannot make the term count for admission
  assertEquals(admissionScore(0, true, t), 0);
  assertEquals(admissionScore(0.3, true, t), 0.3);
});

// ── scope ──────────────────────────────────────────────────────────────────────────────────
Deno.test("metadata filter: empty is unconstrained, an object constrains, anything else is refused", () => {
  assertEquals(parseMetadataFilter(undefined), null);
  assertEquals(parseMetadataFilter("{}"), null);
  assertEquals(parseMetadataFilter('{"share":"cloud"}'), { share: "cloud" });
  assertThrows(() => parseMetadataFilter("[1]"), BadRequest);
  assertThrows(() => parseMetadataFilter("not json"), BadRequest);
  assertEquals(parseLimit("9999", 25, 50), 50);
  assertEquals(parseLimit("abc", 25, 50), 25);
  assertEquals(parseFlag("true"), true);
  assertEquals(parseFlag("1"), false);
});

// ── states ─────────────────────────────────────────────────────────────────────────────────
Deno.test("record state: a staged retract on an active source reads as redaction; lifecycle wins otherwise", () => {
  assertEquals(sourceRecordState({ lifecycle: "active", staged_retract: true }), "redaction");
  assertEquals(sourceRecordState({ lifecycle: "active", staged_retract: false }), "active");
  assertEquals(sourceRecordState({ lifecycle: "suppressed", staged_retract: false }), "suppressed");
});

Deno.test("evidence-only visibility is declared per state; an undeclared state is not visible", () => {
  const v = evidenceVisibleStates([
    { key: "active", definition: { database_wide: true } },
    { key: "held", definition: { database_wide: false } },
    { key: "new_state", definition: {} },
  ]);
  assertEquals([...v], ["active"]);
});
