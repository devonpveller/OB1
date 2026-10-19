/** Pure-logic tests for the Phase 2 Skeptic. Run: deno test skeptic.test.ts */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseSkepticResult, applyDowngrades, deriveRequeries, emptySkepticResult,
} from "./skeptic.ts";

// ── parseSkepticResult (fail-open) ───────────────────────────────────────────
Deno.test("parseSkepticResult: well-formed verdict", () => {
  const r = parseSkepticResult(JSON.stringify({
    challenges: [{ claim: "X is true", type: "currency", evidence: "stale", confidenceDelta: -0.4 }],
    downgrades: [{ claim: "X is true", to: "UNCERTAIN" }],
    refuted: ["Y is false"],
    droppedSources: [{ url: "https://bad.example/x", reason: "spammy" }],
  }));
  assertEquals(r.challenges.length, 1);
  assertEquals(r.downgrades, [{ claim: "X is true", to: "UNCERTAIN" }]);
  assertEquals(r.refuted, ["Y is false"]);
  assertEquals(r.droppedSources, [{ url: "https://bad.example/x", reason: "spammy" }]);
});

Deno.test("parseSkepticResult: fail-open on garbage ⇒ empty", () => {
  assertEquals(parseSkepticResult("not json"), emptySkepticResult());
  assertEquals(parseSkepticResult("[]"), emptySkepticResult());
  assertEquals(parseSkepticResult("null"), emptySkepticResult());
  assertEquals(parseSkepticResult('"a string"'), emptySkepticResult());
});

Deno.test("parseSkepticResult: a skeptic never UPGRADES", () => {
  const r = parseSkepticResult(JSON.stringify({
    downgrades: [
      { claim: "a", to: "SOURCED" },   // upgrade — dropped
      { claim: "b", to: "INFERRED" },  // upgrade — dropped
      { claim: "c", to: "UNCERTAIN" }, // valid
      { claim: "d", to: "GAP" },       // valid
    ],
  }));
  assertEquals(r.downgrades, [{ claim: "c", to: "UNCERTAIN" }, { claim: "d", to: "GAP" }]);
});

Deno.test("parseSkepticResult: drops malformed entries, keeps valid ones", () => {
  const r = parseSkepticResult(JSON.stringify({
    challenges: [{ type: "x" }, { claim: "keep", type: "currency", confidenceDelta: -0.2 }],
    refuted: ["", "real", 42],
    droppedSources: [{ reason: "no url" }, { url: "https://ok/x" }],
  }));
  assertEquals(r.challenges.length, 1);
  assertEquals(r.challenges[0].claim, "keep");
  assertEquals(r.refuted, ["real"]);
  assertEquals(r.droppedSources, [{ url: "https://ok/x", reason: "" }]);
});

// ── applyDowngrades (index-safe tag rewrite) ─────────────────────────────────
const SYNTH = [
  "[SOURCED] Cats purr at 25Hz. [Source 1]",
  "[SOURCED] Cats can fly unaided. [Source 2]",
  "[INFERRED] Cats are mammals. [Source 3]",
].join("\n");

Deno.test("applyDowngrades: rewrites the matched line's tag, preserves citation + others", () => {
  const { synthesis, applied } = applyDowngrades(SYNTH, [{ claim: "Cats can fly unaided", to: "UNCERTAIN" }]);
  const lines = synthesis.split("\n");
  assertEquals(applied, 1);
  assertEquals(lines[0], "[SOURCED] Cats purr at 25Hz. [Source 1]");        // untouched
  assertEquals(lines[1], "[UNCERTAIN] Cats can fly unaided. [Source 2]");   // downgraded, [Source 2] kept
  assertEquals(lines[2], "[INFERRED] Cats are mammals. [Source 3]");        // untouched
});

Deno.test("applyDowngrades: to GAP strips the citation", () => {
  const { synthesis } = applyDowngrades(SYNTH, [{ claim: "Cats can fly unaided", to: "GAP" }]);
  assertEquals(synthesis.split("\n")[1], "[GAP] Cats can fly unaided.");
});

Deno.test("applyDowngrades: line count + other citations unchanged (index-safe)", () => {
  const { synthesis } = applyDowngrades(SYNTH, [{ claim: "Cats can fly unaided", to: "GAP" }]);
  assertEquals(synthesis.split("\n").length, 3);
  // [Source 1] and [Source 3] still present at their original positions
  assertEquals(synthesis.includes("[Source 1]"), true);
  assertEquals(synthesis.includes("[Source 3]"), true);
});

Deno.test("applyDowngrades: no matching downgrade ⇒ untouched", () => {
  const { synthesis, applied } = applyDowngrades(SYNTH, [{ claim: "dogs bark", to: "GAP" }]);
  assertEquals(applied, 0);
  assertEquals(synthesis, SYNTH);
});

Deno.test("applyDowngrades: two downgrades hit two distinct lines", () => {
  const { applied } = applyDowngrades(SYNTH, [
    { claim: "Cats purr", to: "UNCERTAIN" },
    { claim: "Cats can fly", to: "GAP" },
  ]);
  assertEquals(applied, 2);
});

// ── deriveRequeries ──────────────────────────────────────────────────────────
Deno.test("deriveRequeries: corroborating + negated per claim, capped", () => {
  const qs = deriveRequeries(["quantum chip ships in 2026"], 6);
  assertEquals(qs[0], "quantum chip ships in 2026");
  assertEquals(qs[1].startsWith("quantum chip ships in 2026 "), true);
  assertEquals(qs[1].includes("debunked"), true);
});

Deno.test("deriveRequeries: respects the cap and skips blanks", () => {
  const qs = deriveRequeries(["a", "", "b", "c"], 3);
  assertEquals(qs.length, 3);
});
