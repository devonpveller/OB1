/**
 * rwr-research-sources - community evidence in the D15 model (the TS twin; claim_confidence_d15 and the legacy
 * claim_confidence are the SQL twins, credibility-community.e2e.test.ts in the lab).
 *   - community evidence never carries the credible rating alone: a community-only claim is weighted low and capped
 *     floor_margin under the claim floor, however many community sources agree;
 *   - a claim with credible support is scored over its credible sources only, so its rating is the same whichever
 *     mode the run used;
 *   - two or more INDEPENDENT communities stating it give the separate consensus marker;
 *   - a community source neither gives nor receives corroboration.
 * Run: deno test --allow-read credibility-community.test.ts
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildModel, claimFloor, claimTotal, communityClaimTotal, corroborate, CredibilityGateError, filedClaimsCredibility,
  scoreSource,
} from "./credibility.ts";
import { seedSet } from "./fixtures/credibility-seeds.ts";

const seeds = seedSet();
const model = () => buildModel(seeds.rows, seeds.versions);
const KIND = "practical";

Deno.test("the community terms are read from the registry; missing terms stop the gate", () => {
  const m = model();
  assertEquals(m.community, { weight: 0.5, floorMargin: 0.01, legacyFloor: 0.5, consensusMin: 2 });
  assert(m.sourceClasses.length > 0);
  const rows = seeds.rows.filter((r) => !(r.registry === "credibility_terms" && r.key === "community"));
  assertThrows(() => buildModel(rows, seeds.versions), CredibilityGateError, "community");
});

Deno.test("a community-only claim never reaches the claim floor, however strong or numerous its sources", () => {
  const m = model();
  const floor = claimFloor(m, KIND);
  for (const n of [1, 2, 3, 6]) {
    const t = communityClaimTotal(m, floor, Array.from({ length: n }, (_, i) => ({ total: 1, community: `site${i}.example`, agrees: true })));
    assert(t.below_floor, `${n} community source(s) at total 1 stayed below the floor`);
    assert(t.total <= floor - m.community.floorMargin + 1e-12);
    assert(t.community_only);
  }
  // weighted low: a single weak community source keeps weight x its total
  const one = communityClaimTotal(m, floor, [{ total: 0.3, community: "reddit.com/r/a", agrees: true }]);
  assertEquals(one.total, 0.3 * m.community.weight);
});

Deno.test("a claim with credible support scores exactly as if the community sources were absent (mode invariance)", () => {
  const m = model();
  const floor = claimFloor(m, KIND);
  for (const credible of [[0.3], [0.42, 0.3], [0.62]]) {
    const without = claimTotal(m, floor, credible);
    const withCommunity = communityClaimTotal(m, floor, [
      ...credible.map((total) => ({ total, community: null, agrees: true })),
      { total: 0.9, community: "reddit.com/r/a", agrees: true }, { total: 0.9, community: "stackoverflow.com", agrees: true },
    ]);
    assertEquals(withCommunity.total, without.total);
    assertEquals(withCommunity.below_floor, without.below_floor);
    assertEquals(withCommunity.community_only, false);
  }
});

Deno.test("the consensus marker needs two INDEPENDENT communities stating the claim", () => {
  const m = model();
  const floor = claimFloor(m, KIND);
  const c = (community: string, agrees = true) => ({ total: 0.22, community, agrees });
  assertEquals(communityClaimTotal(m, floor, [c("reddit.com/r/a"), c("stackoverflow.com")]).community_consensus, true);
  assertEquals(communityClaimTotal(m, floor, [c("reddit.com/r/a"), c("reddit.com/r/b")]).community_consensus, true);
  assertEquals(communityClaimTotal(m, floor, [c("reddit.com/r/a"), c("reddit.com/r/a")]).community_consensus, false, "two threads in one community count once");
  assertEquals(communityClaimTotal(m, floor, [c("reddit.com/r/a"), c("stackoverflow.com", false)]).community_consensus, false, "an inferred edge is not agreement");
  // the marker never moves the number
  const two = communityClaimTotal(m, floor, [c("reddit.com/r/a"), c("stackoverflow.com")]);
  assert(two.below_floor);
});

Deno.test("filed claims carry the community flags; a credible claim's figure is unchanged by communityOf", () => {
  const m = model();
  const syn = [
    "[SOURCED] Heat pumps cut winter bills in mild climates. [Source 1]",
    "[SOURCED] Many owners report quieter units after a firmware update. [Source 2, 3]",
  ].join("\n");
  const urls = ["https://www.energy.gov/heat-pumps", "https://www.reddit.com/r/heatpumps/comments/1/", "https://stackoverflow.com/questions/9"];
  const community = (n: number) => ({ 1: null, 2: "reddit.com/r/heatpumps", 3: "stackoverflow.com" } as Record<number, string | null>)[n] ?? null;
  const total = (n: number) => [0.42, 0.5, 0.5][n - 1];
  const plain = filedClaimsCredibility(m, KIND, syn, () => null, (n) => total(n));
  const flagged = filedClaimsCredibility(m, KIND, syn, () => null, (n) => total(n), undefined, community);
  assertEquals(flagged[0].total, plain[0].total);
  assertEquals(flagged[0].community_only, false);
  assertEquals(flagged[1].community_only, true);
  assertEquals(flagged[1].community_consensus, true);
  assert(flagged[1].below_floor);
  assert(urls.length === 3);
});

Deno.test("a community source neither gives nor receives corroboration", () => {
  const m = model();
  const paper = { url: "https://doi.org/10.1/x", doi: "10.1/x", score: scoreSource(m, "scholarly", { cited_by: 10, author_works_count: 10, age_years: 1 }) };
  const general = (url: string) => ({
    url, links: ["https://doi.org/10.1/x"],
    score: scoreSource(m, "general", { author_identity: null, domain_class: "general", primary: false,
      link_structure: { inbound_corroborations: 0, found_via: 0 }, entailment_agreement: { supports: 0, partial: 0, unsupported: 0 } }),
  });
  assertEquals(corroborate(m, KIND, "x", "supports", general("https://www.reddit.com/r/a/comments/1/"), paper), []);
  assertEquals(corroborate(m, KIND, "x", "supports", general("https://blog.example.com/p"), paper).length, 2);
});
