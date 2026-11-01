// deno test --allow-all src/export/gate_round5_skeleton_test.ts - rw-p6b-gate round 5: the SKELETON comparison
// (gate.ts skeleton, sameEntry) for the tester's D15-D18 shapes; pure. Its own file: the functions do not exist
// at 9cfc2ba (this file is that RED).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { sameEntry, skeleton } from "./gate.ts";
import { R5_FA_ZWNJ } from "./gate_fixtures.ts";

Deno.test("round 5: the skeleton - letters and digits only, NFKC, case-folded; LTR equal, RTL an equal character multiset", () => {
  assertEquals(skeleton("Gesund­heits­reform: Was sich für Ver­sicherte ändert"), "gesundheitsreformwassichfürversicherteändert");
  assertEquals(skeleton("Climate​policy after Paris"), skeleton("Climate policy after Paris"));
  assertEquals(skeleton("Zero⁠trust ﬁnance"), "zerotrustfinance");
  assert(sameEntry("A mixed-\nmethods analysis of sub­Saharan data", "A mixed-methods analysis of sub-Saharan data"), "D15: hyphens at and inside a break");
  assert(!sameEntry("Fixture paper number 10. J.", "Fixture paper number 1. J."), "number 1 is not number 10");
  assert(!sameEntry("A study of water and soil", "A study of soil and water"), "swapped words (LTR) differ");
  assert(!sameEntry("A study of water", "A study of water use"), "a missing word");
  assert(!sameEntry("A study of water use now", "A study of water use"), "an extra word");
  const vis = (s: string) => [...s].reverse().join("");
  assert(sameEntry(vis("דוח שנתי: סיכום השנה"), "דוח שנתי: סיכום השנה"), "RTL visual order");
  // D18: an EXTRA RTL word (and an extra repetition) no longer passes - equal counts both ways
  assert(!sameEntry("דוח שנתי מתוקן: סיכום השנה", "דוח שנתי: סיכום השנה"), "D18 extra word");
  assert(!sameEntry("שנה אחר שנה שנה", "שנה אחר שנה"), "D18 extra repetition");
  // D16: a ZWNJ is a format character - dropped on both sides
  assert(sameEntry(vis(R5_FA_ZWNJ[0]).replace("‌", ""), R5_FA_ZWNJ[0]), "Persian ZWNJ");
});

