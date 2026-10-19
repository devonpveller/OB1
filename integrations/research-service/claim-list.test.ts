/**
 * rw-p3a-entail attempt 6 (the structural round), offline: the report scores EXACTLY the curator's claim
 * list of the package (claim-list.ts, the curator's own file, byte-identical copy - claim-edges.test.ts
 * holds the identity), and the report figure is over those claims only. The DB halves (the curator's
 * real writeClaims, claim_confidence_d15, the view) are credibility-attempt6.e2e.test.ts.
 * Run: deno test --allow-read claim-list.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { claimList } from "./claim-list.ts";
import { buildModel } from "./credibility.ts";
import * as C from "./credibility.ts";
import { citedLines } from "./entailment.ts";
import { scoreCuratorPackage } from "./harness.ts";
import { seedSet } from "./fixtures/credibility-seeds.ts";

const seeds = seedSet();
const SYNTH = [
  "[SOURCED] Doctors say the widget is common among travellers. [Source 1]",
  "[SOURCED] Doctors say the widget is common among travellers. [Source 2, 3]",
  "[INFERRED] Clinicians report the widget in commuters. [Source 2]",
  "[SOURCED] CLINICIANS REPORT THE WIDGET IN COMMUTERS. [Source 1]",
  "[SOURCED] [Source 2]",
  "[SOURCED] -- [Source 1]",
  "[SOURCED] The provided sources contain no information about the widget in children. [Source 1]",
  "[GAP] Nothing on the long-term course of the widget.",
  "[SOURCED] The widget is in the news. [Source 1, 2, 3, 4, 5]",
  "[SOURCED] The widget worsens at sea. [Source 1] [INFERRED] The widget eases on land. [Source 2]",
  "[SOURCED] The widget follows screen motion.",
  "as the study shows [Source 3]",
].join("\n");

Deno.test("attempt 6: scoreCuratorPackage scores exactly claimList(package).claims - order, text, tag, edges - and the report is over those claims only", () => {
  const m = buildModel(seeds.rows, seeds.versions);
  const pages = [0.9, 0.6, 0.3, 0.5, 0.7].map((total, i) => ({ url: `https://p${i + 1}.example/`, total }));
  const lines = SYNTH.split("\n");
  const verdicts = citedLines(SYNTH).map((l) => ({ line: l.index, verdict: "supports" }));
  const { claims, report } = scoreCuratorPackage(m, "practical", SYNTH, pages, lines, verdicts, (p) => p.total);
  const list = claimList(SYNTH).claims;
  assertEquals(claims.map((c) => [c.text, c.filed_tag, c.edges.map((e) => [e.cite, e.edge_type, e.weight])]),
    list.map((c) => [c.text, c.tag, c.edges.map((e) => [e.sourceIndex, e.edgeType, e.weight])]));
  assertEquals(claims.map((c) => c.claim), list.map((_c, i) => i));
  // the claim on line 0 and the two-tag line both map to their judged line; the continuation claim is on no judged line
  assertEquals(claims.map((c) => c.line), [0, 2, 8, 9, 9, null]);
  // the report: the mean and the below-floor count of the FILED claims; judged lines with no filed claim are counted
  const mean = Math.round(claims.reduce((a, c) => a + c.total, 0) / claims.length * 1000) / 1000;
  assertEquals(report.value, mean);
  assertEquals(report.claims, 6);
  assertEquals(report.below_floor, claims.filter((c) => c.below_floor).length);
  assertEquals(report.judged_lines, verdicts.length);
  assertEquals(report.judged_not_filed, 5, "the two duplicates, the two empty texts and the meta-claim");
  assert(claims.every((c) => c.total > 0));
});

Deno.test("attempt 6: no second derivation is left in the research service - credibility.ts exports no per-line scorer of its own", () => {
  // deno-lint-ignore no-explicit-any
  const X = C as any;
  for (const gone of ["finalLineCredibility", "filedLineCredibility", "filedLineOf"]) assertEquals(X[gone], undefined, gone);
  assertEquals(typeof X.filedClaimsCredibility, "function");
});
