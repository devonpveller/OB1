/**
 * Parser tests (P1.3). Run: deno test claims.test.ts
 * Covers the GROUNDING-MODEL §4 mapping + the rule #1 gate.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseSynthesisClaims } from "./claims.ts";

Deno.test("SOURCED single → states edge", () => {
  const { claims } = parseSynthesisClaims(
    "[SOURCED] Curbside recycling uses a brown cart. [Source 1]",
  );
  assertEquals(claims.length, 1);
  assertEquals(claims[0].tag, "sourced");
  assertEquals(claims[0].text, "Curbside recycling uses a brown cart.");
  assertEquals(claims[0].edges, [{ sourceIndex: 1, edgeType: "states", weight: 1.0 }]);
});

Deno.test("SOURCED multi → states then corroborates", () => {
  const { claims } = parseSynthesisClaims(
    "[SOURCED] The number is 865-482-3656. [Source 1, 2]",
  );
  assertEquals(claims[0].edges, [
    { sourceIndex: 1, edgeType: "states", weight: 1.0 },
    { sourceIndex: 2, edgeType: "corroborates", weight: 1.0 },
  ]);
});

Deno.test("INFERRED multi → all inferred_from", () => {
  const { claims } = parseSynthesisClaims(
    "[INFERRED] Glass goes to the Convenience Center, not curbside. [Source 1, 2]",
  );
  assertEquals(claims[0].tag, "inferred");
  assertEquals(claims[0].edges, [
    { sourceIndex: 1, edgeType: "inferred_from", weight: 1.0 },
    { sourceIndex: 2, edgeType: "inferred_from", weight: 1.0 },
  ]);
});

Deno.test("UNCERTAIN with source → half-weight inferred_from", () => {
  const { claims } = parseSynthesisClaims("[UNCERTAIN] Pickup may be biweekly. [Source 3]");
  assertEquals(claims[0].edges, [{ sourceIndex: 3, edgeType: "inferred_from", weight: 0.5 }]);
});

Deno.test("rule #1 — tagged claim with NO citation is dropped (ungrounded)", () => {
  const { claims, gaps } = parseSynthesisClaims("[SOURCED] Call 1-800-438-8657.");
  assertEquals(claims.length, 0); // never admitted — the poisoning case
  assertEquals(gaps.length, 0);   // not a gap either; just an untethered assertion
});

Deno.test("GAP → recorded, not a claim", () => {
  const { claims, gaps } = parseSynthesisClaims(
    "[SOURCED] A is true. [Source 1]\n[GAP] The recycling schedule for holidays is unknown.",
  );
  assertEquals(claims.length, 1);
  assertEquals(gaps, ["The recycling schedule for holidays is unknown."]);
});

Deno.test("multiple claims segmented by tag; bullets stripped", () => {
  const synth = [
    "## Findings",
    "- [SOURCED] Brown cart for curbside. [Source 1]",
    "- [INFERRED] Glass is separate. [Source 1, 2]",
    "- [GAP] Holiday schedule unknown.",
  ].join("\n");
  const { claims, gaps } = parseSynthesisClaims(synth);
  assertEquals(claims.length, 2);
  assertEquals(claims[0].text, "Brown cart for curbside.");
  assertEquals(claims[1].text, "Glass is separate.");
  assertEquals(gaps, ["Holiday schedule unknown."]);
});

Deno.test("'Sources 1 and 2' phrasing parses", () => {
  const { claims } = parseSynthesisClaims("[SOURCED] X holds. [Sources 1 and 2]");
  assertEquals(claims[0].edges.map((e) => e.sourceIndex), [1, 2]);
});

Deno.test("duplicate claim text is deduped within a parse", () => {
  const { claims } = parseSynthesisClaims(
    "[SOURCED] Same fact. [Source 1]\n[SOURCED] Same fact. [Source 2]",
  );
  assertEquals(claims.length, 1);
});
