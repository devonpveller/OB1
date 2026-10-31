// deno test --allow-all src/export/gate_round4_titles_test.ts - rw-p6b-gate round 4, the title comparison
// (gate.ts holdsTitle) for the tester's D13 (hyphenated titles) and D14 (RTL titles); pure. Its own file:
// holdsTitle does not exist at 97cdc95 (this file is that RED).
import { assert } from "jsr:@std/assert@1";
import { holdsTitle } from "./gate.ts";
import { R4_RTL_TITLES } from "./gate_fixtures.ts";

Deno.test("D13: a title the file hyphenates (soft hyphen + line break) or breaks plainly is still the title", () => {
  const t = "Interpretable machine learning for clinical decision support: Opportunities, challenges, and a research agenda";
  assert(holdsTitle("Author (2020). Interpretable machine learning for clinical decision support: Opportunities, chal\u00AD\nlenges, and a research agenda.", t));
  assert(holdsTitle("Author (2020). Interpretable machine learning for clinical decision support: Opportunities, chal\nlenges, and a research agenda.", t));
  assert(!holdsTitle("Author (2020). Interpretable machine learning for clinical decision support: Opportunities, chal\u00AD\nlenges, and a research plan.", t), "another title");
  assert(!holdsTitle("A (2020). Fixture paper number 10. J.", "Fixture paper number 1"), "whole words: number 1 is not number 10");
});

Deno.test("D14: an RTL title is compared as an exact multiset of its words", () => {
  const vis = (s: string) => [...s].reverse().join("");
  for (const t of Object.values(R4_RTL_TITLES)) {
    assert(holdsTitle(`[1] “${t}.” Accessed`, t), `logical: ${t}`);
  }
  assert(holdsTitle(`[1] “${vis("דוח שנתי: סיכום השנה")}” Accessed`, "דוח שנתי: סיכום השנה"), "visual order");
  assert(!holdsTitle(`[1] 2024 ${vis("דוח שנתי")}`, "דוח שנתי 2023"), "another year");
  assert(!holdsTitle(`[1] ${vis("דוח")}`, "דוח שנתי"), "a missing word");
  assert(!holdsTitle(`[1] ${vis("שלום")}`, "שלום שלום"), "a word the title repeats must be there as often");
});

