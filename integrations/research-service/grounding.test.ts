/**
 * RED-first tests for the numeric grounding check (PLAN-research-trust Phase 2.3).
 *
 * The artefact: job ce398d06 stored, at confidence 0.51, the line
 *   "[INFERRED] Thermal throttling and automatic shutdown at approximately 95°C
 *    is documented for the NVIDIA DGX Spark … [Source 5, 6]"
 * The digits "95" appear in NEITHER cited source's held text (verified against
 * the exported fixture below, not taken from the audit's word). A fabricated
 * figure with a citation is the worst output this engine can produce.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyNumericGrounding, groundNumbers, numbersIn } from "./grounding.ts";

type Job = {
  synthesis: string;
  cited_texts: Array<{ content: string } | null>;
};
const job = (n: string): Job =>
  JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));

Deno.test("numbersIn: unit-aware extraction, citations excluded", () => {
  assertEquals(numbersIn("shutdown at approximately 95 °C [Source 5, 6]"), ["95"]);
  assertEquals(numbersIn("a 26% and 56% drop, p = 0.0055 [Source 2]"), ["26", "56", "0.0055"]);
  assertEquals(numbersIn("14 healthy subjects [Source 1]"), ["14"]);
  assertEquals(numbersIn("no figures here [Source 3]"), []);
});

Deno.test("the audited 95 °C line is UNGROUNDED against its own two cited sources", () => {
  const j = job("job-optiplex");
  // Match the DEGREE line, not merely a line containing the digits 95 — the
  // meta-claim line above it contains "GB-BSCEA-3955", which is why the first
  // version of this test passed against the wrong line.
  const line = j.synthesis.split("\n").find((l) => /95\s*°?\s*C/.test(l)) || "";
  assert(line.includes("[Source 5, 6]"), `unexpected line: ${line}`);
  const texts = [j.cited_texts[4]?.content || "", j.cited_texts[5]?.content || ""];
  const r = groundNumbers(line, texts);
  assertEquals(r.ok, false);
  // "95" is the fabricated figure the audit names. "3050" comes out with it:
  // the line also asserts a model number neither DGX Spark source mentions.
  // Both are true misses; the plan's expected `missing: ["95"]` was written
  // from the audit's prose, not from the line.
  assertEquals(r.missing, ["95", "3050"]);
});

Deno.test("the 100 Hz GVS line (26% / 56% / p = 0.0055) is GROUNDED in [Source 2]", () => {
  const j = job("job-100hz");
  const line = j.synthesis.split("\n").find((l) => l.includes("0.0055")) || "";
  assert(line.length > 0, "the GVS line is missing from the fixture");
  const r = groundNumbers(line, [j.cited_texts[1]?.content || ""]);
  assertEquals(r.ok, true);
  assertEquals(r.missing, []);
});

Deno.test("applyNumericGrounding downgrades the 95 °C line and is index-safe", () => {
  const j = job("job-optiplex");
  const texts = j.cited_texts.map((t) => t?.content || "");
  const { synthesis, ungrounded } = applyNumericGrounding(j.synthesis, texts);
  assert(ungrounded.some((u) => u.includes("95")), `ungrounded=${JSON.stringify(ungrounded)}`);
  const before = j.synthesis.split("\n");
  const after = synthesis.split("\n");
  assertEquals(after.length, before.length, "line count must not change");
  const i = before.findIndex((l) => /95\s*°?\s*C/.test(l));
  assert(i >= 0);
  assert(after[i].startsWith("[UNCERTAIN]"), after[i].slice(0, 40));
  assert(after[i].includes("unverified figure"), after[i]);
  assert(after[i].includes("[Source 5, 6]"), "the citation must survive verbatim");
  // Every [Source N] marker in the document is preserved, in order.
  const cites = (s: string) => (s.match(/\[Sources?\b[^\]]*\]/g) || []).join("|");
  assertEquals(cites(synthesis), cites(j.synthesis));
});

Deno.test("applyNumericGrounding leaves the 100 Hz [SOURCED] lines alone", () => {
  const j = job("job-100hz");
  const texts = j.cited_texts.map((t) => t?.content || "");
  const { synthesis } = applyNumericGrounding(j.synthesis, texts);
  const sourcedBefore = j.synthesis.split("\n").filter((l) => l.startsWith("[SOURCED]"));
  const sourcedAfter = synthesis.split("\n").filter((l) => l.startsWith("[SOURCED]"));
  assertEquals(sourcedAfter.length, sourcedBefore.length,
    "no [SOURCED] line in the accurate run may be downgraded");
  assertEquals(sourcedAfter.join("\n"), sourcedBefore.join("\n"));
});

Deno.test("a [GAP] line is never touched (it carries no citation and asserts nothing)", () => {
  const s = "[GAP] No source gives a figure for the 3050's 95 W PSU.";
  const { synthesis, ungrounded } = applyNumericGrounding(s, ["unrelated text"]);
  assertEquals(synthesis, s);
  assertEquals(ungrounded, []);
});

Deno.test("an uncitable number with NO resolvable source text is left alone, not invented into a failure", () => {
  // [Source 9] does not exist in a 2-source pool: the citation is unresolvable,
  // so there is no held text to check against and no verdict to give.
  const s = "[SOURCED] The unit draws 300 W. [Source 9]";
  const { synthesis, ungrounded } = applyNumericGrounding(s, ["a", "b"]);
  assertEquals(synthesis, s);
  assertEquals(ungrounded, []);
});
