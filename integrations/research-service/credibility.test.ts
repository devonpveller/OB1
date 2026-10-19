/**
 * The D15 credibility model (research-workbench P3a, rw-p3a-entail). Offline: the model is built
 * from the seeded registry rows (fixtures/credibility-registry.json, which the first test proves
 * IS what the migrations seed).
 * Run: deno test --allow-read credibility.test.ts
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildModel, classifyClaimKind, corroborate, CredibilityGateError, domainClassOf, type GeneralSignals,
  lineCredibility, maxGeneralScore, minPaperScore, paperScore, type RegistryRow, reportCredibility,
  scoreSource, type SourceScore, weightedTotal, weightFor,
} from "./credibility.ts";
import { CREDIBILITY_SQL, parseSeeds, seedSet } from "./fixtures/credibility-seeds.ts";

const seeds = seedSet();
const model = () => buildModel(seeds.rows, seeds.versions);
const sqlReadable = (() => { try { CREDIBILITY_SQL.forEach((u) => Deno.statSync(u)); return true; } catch { return false; } })();

const general = (over: Partial<GeneralSignals> = {}): GeneralSignals => ({
  author_identity: null, domain_class: "general", primary: false,
  link_structure: { inbound_corroborations: 0, found_via: 0 },
  entailment_agreement: { supports: 0, partial: 0, unsupported: 0 }, ...over,
});

Deno.test({
  name: "the test registry IS the migrations' seed set (no hand-written table)",
  ignore: !sqlReadable,
  fn() {
    const parsed = parseSeeds(CREDIBILITY_SQL.map((u) => Deno.readTextFileSync(u)));
    assertEquals(seeds.rows, parsed.rows);
    assertEquals(seeds.versions, parsed.versions);
  },
});

Deno.test("the model builds from the registries and names its versions", () => {
  const m = model();
  assertEquals(m.weightsVersion, "weights v1");
  assertEquals(m.paperVersion, "paper p1");
  assertEquals(m.modelVersion, "d15 weights v1 paper p1");
  assertEquals([...m.families.keys()].sort(), ["general", "scholarly"]);
  assertEquals(m.kinds.filter((k) => k.fallback).map((k) => k.key), ["practical"]);
});

// ── the weight table (acceptance: keyed by claim kind AND family; no single global weight) ──
Deno.test("general theory: the weakest paper outranks the strongest general source of any class", () => {
  const m = model();
  const paper = weightFor(m, "general_theory", "scholarly").weight * minPaperScore(m);
  const g = weightFor(m, "general_theory", "general");
  const strongestGeneral = g.weight * Math.min(1, maxGeneralScore(m) + g.primaryBonus);
  assert(paper > strongestGeneral, `paper ${paper} vs general ${strongestGeneral}`);
  // and concretely: a government page with an author, link structure and agreement at their caps
  const gov = scoreSource(m, "general", general({
    domain_class: "government", author_identity: "A. Author", primary: true,
    link_structure: { inbound_corroborations: 9, found_via: 9 }, entailment_agreement: { supports: 9, partial: 0, unsupported: 0 },
  }));
  const weakPaper = scoreSource(m, "scholarly", { cited_by: 0, author_works_count: 0, age_years: 30 });
  assert(weightedTotal(m, "general_theory", weakPaper).total > weightedTotal(m, "general_theory", gov).total);
});

Deno.test("other kinds: a primary non-paper source ranks above a weak paper", () => {
  const m = model();
  const vendor = scoreSource(m, "general", general({ author_identity: "Release Team Lead", primary: true }));
  const weakPaper = scoreSource(m, "scholarly", { cited_by: 0, author_works_count: 0, age_years: 30 });
  for (const kind of ["release", "price", "outage", "product_change"]) {
    const v = weightedTotal(m, kind, vendor).total;
    const p = weightedTotal(m, kind, weakPaper).total;
    assert(v > p, `${kind}: primary general ${v} should outrank weak paper ${p}`);
  }
  // ...while for general theory the same vendor page is far below that paper
  assert(weightedTotal(m, "general_theory", vendor).total < weightedTotal(m, "general_theory", weakPaper).total);
});

Deno.test("there is no single global weight: the scholarly and general weights differ by kind", () => {
  const m = model();
  const s = new Set(m.kinds.map((k) => weightFor(m, k.key, "scholarly").weight));
  const g = new Set(m.kinds.map((k) => weightFor(m, k.key, "general").weight));
  assert(s.size > 1 && g.size > 1, `scholarly weights ${[...s]} general weights ${[...g]}`);
  assert(weightFor(m, "general_theory", "scholarly").weight > weightFor(m, "general_theory", "general").weight);
  assert(weightFor(m, "release", "general").weight > weightFor(m, "release", "scholarly").weight);
});

// ── the table fails loudly (acceptance: a kind with no row stops the gate, naming it) ──
Deno.test("a claim kind not in the registry stops the gate with the kind named", () => {
  const m = model();
  const e = assertThrows(() => weightFor(m, "horoscope", "general"), CredibilityGateError);
  assert(e.message.includes("'horoscope'"), e.message);
});

Deno.test("a registered kind with no row for a family stops the gate - no default weight", () => {
  const rows: RegistryRow[] = [
    ...seeds.rows,
    { registry: "claim_kinds", key: "benchmark", version: 1, definition: { order: 6, cues: ["\\bbenchmark\\b"] } },
    { registry: "credibility_weights", key: "benchmark.general", version: 1,
      definition: { kind: "benchmark", family: "general", weight: 1, admission_floor: 0.2, claim_floor: 0.5 } },
  ];
  const e = assertThrows(() => buildModel(rows, seeds.versions), CredibilityGateError);
  assert(e.message.includes("'benchmark'") && e.message.includes("'scholarly'"), e.message);
});

Deno.test("a weight row naming an unregistered family, or a broken papers_outrank, is refused", () => {
  const bad = [...seeds.rows, { registry: "credibility_weights", key: "practical.video", version: 1,
    definition: { kind: "practical", family: "video", weight: 1, admission_floor: 0.2, claim_floor: 0.5 } }];
  assertThrows(() => buildModel(bad, seeds.versions), CredibilityGateError, "'video'");
  const flat = seeds.rows.map((r) => r.key === "general_theory.general"
    ? { ...r, definition: { ...r.definition, weight: 1.0 } } : r);
  assertThrows(() => buildModel(flat, seeds.versions), CredibilityGateError, "papers_outrank");
});

// ── families: the signals of the family, never the other's ──
Deno.test("a general source is never scored from scholarly signals, nor a paper as general", () => {
  const m = model();
  assertThrows(() => scoreSource(m, "general", { cited_by: 5, author_works_count: 9, age_years: 1 }), CredibilityGateError, "general source");
  assertThrows(() => scoreSource(m, "scholarly", general()), CredibilityGateError, "scholarly source");
  assertThrows(() => scoreSource(m, "video", general()), CredibilityGateError, "'video'");
});

Deno.test("paper score p1: credible on publication, citations read against age, unknowns stated not zeroed", () => {
  const m = model();
  const fresh = paperScore(m, { cited_by: 0, author_works_count: 40, age_years: 0.3 });
  const stale = paperScore(m, { cited_by: 0, author_works_count: 40, age_years: 9 });
  assert(fresh.score > stale.score, "a new paper is favoured until time passes");
  const cited = paperScore(m, { cited_by: 900, author_works_count: 40, age_years: 9 });
  assert(cited.score > stale.score, "citations grow credibility");
  const unknown = paperScore(m, { cited_by: null, author_works_count: null, age_years: null });
  assertEquals(unknown.score, 0.6);
  assert(unknown.reasons.some((r) => r.includes("cited_by unresolved") && r.includes("not a count of 0")));
  assert(unknown.reasons.some((r) => r.includes("works_count unresolved") && r.includes("not a count of 0")));
});

Deno.test("domain classes come from the registry's host patterns", () => {
  const m = model();
  assertEquals(domainClassOf(m, "https://www.cdc.gov/x").key, "government");
  assertEquals(domainClassOf(m, "https://www.frontiersin.org/a").key, "academic");
  assertEquals(domainClassOf(m, "https://www.reuters.com/a").key, "news");
  assertEquals(domainClassOf(m, "https://www.lowes.com/a").key, "commerce");
  assertEquals(domainClassOf(m, "https://example.com/a").key, "general");
});

Deno.test("claim kind: the first registered cue, else the declared fallback", () => {
  const m = model();
  const hz = JSON.parse(Deno.readTextFileSync(new URL("./fixtures/job-100hz.json", import.meta.url))).query;
  const opt = JSON.parse(Deno.readTextFileSync(new URL("./fixtures/job-optiplex.json", import.meta.url))).query;
  assertEquals(classifyClaimKind(m, hz).kind, "general_theory");
  const o = classifyClaimKind(m, opt);
  assertEquals(o.kind, "practical");
  assert(o.basis.includes("fallback"));
  assertEquals(classifyClaimKind(m, "What changed in the Python 3.13 release?").kind, "release");
});

// ── corroboration (acceptance: transfer only on `supports`) ──
const paperS = (): SourceScore => scoreSource(model(), "scholarly", { cited_by: 30, author_works_count: 80, age_years: 3 });
const postS = (): SourceScore => scoreSource(model(), "general", general());

Deno.test("a post linking a paper gains the paper's corroboration only on supports; the paper gains a weaker one", () => {
  const m = model();
  const edges = corroborate(m, "general_theory", "claim", "supports",
    { url: "https://blog.example.com/p", score: postS(), links: ["https://doi.org/10.1/abc"] },
    { url: "https://journal.example.org/a", doi: "10.1/abc", score: paperS() });
  assertEquals(edges.length, 2);
  const toPost = edges.find((e) => e.to_url === "https://blog.example.com/p")!;
  const toPaper = edges.find((e) => e.to_url === "https://journal.example.org/a")!;
  assertEquals(toPost.strength, "strong");
  assertEquals(toPaper.strength, "weak");
  assert(toPost.amount > toPaper.amount, "asymmetric: the paper carries the higher weight");
});

Deno.test("NO transfer on partial or unsupported, or when the post does not link the paper", () => {
  const m = model();
  for (const v of ["partial", "unsupported"]) {
    assertEquals(corroborate(m, "general_theory", "c", v,
      { url: "https://b.example/p", score: postS(), links: ["https://doi.org/10.1/abc"] },
      { url: "https://j.example/a", doi: "10.1/abc", score: paperS() }), [], `transferred on ${v}`);
  }
  assertEquals(corroborate(m, "general_theory", "c", "supports",
    { url: "https://b.example/p", score: postS(), links: ["https://elsewhere.example/x"] },
    { url: "https://j.example/a", doi: "10.1/abc", score: paperS() }), []);
  assertThrows(() => corroborate(m, "general_theory", "c", "maybe",
    { url: "a", score: postS(), links: [] }, { url: "b", doi: null, score: paperS() }), CredibilityGateError, "'maybe'");
});

// ── the claim total (D15 item 6: single-source non-paper starts below the floor) ──
Deno.test("a single uncorroborated general source starts below the 0.50 floor, for every kind and class", () => {
  const m = model();
  for (const k of m.kinds) {
    for (const cls of m.domainClasses) {
      const s = scoreSource(m, "general", general({ domain_class: cls.key, author_identity: "Named Author", primary: true }));
      const l = lineCredibility(m, k.key, 0, "supports", [{ total: weightedTotal(m, k.key, s).total }]);
      assert(l.below_floor, `${k.key}/${cls.key}: ${l.total}`);
    }
  }
});

Deno.test("corroboration lifts a general claim over the floor; a paper alone is over it", () => {
  const m = model();
  const t = weightedTotal(m, "practical", scoreSource(m, "general", general({ domain_class: "news", author_identity: "X Y" }))).total;
  assert(lineCredibility(m, "practical", 0, "supports", [{ total: t }]).below_floor);
  assert(!lineCredibility(m, "practical", 0, "supports", [{ total: t }, { total: t }, { total: t }]).below_floor);
  const p = weightedTotal(m, "general_theory", paperS()).total;
  assert(!lineCredibility(m, "general_theory", 0, "supports", [{ total: p }]).below_floor);
  assertEquals(lineCredibility(m, "general_theory", 0, "unsupported", [{ total: p }]).total, 0);
});

Deno.test("the report roll-up names the kind, the model version and the weights it used", () => {
  const m = model();
  const r = reportCredibility(m, "general_theory", [
    lineCredibility(m, "general_theory", 0, "supports", [{ total: 0.8 }]),
    lineCredibility(m, "general_theory", 1, "unsupported", [{ total: 0.8 }]),
  ]);
  assertEquals(r.value, 0.4);
  assertEquals(r.below_floor, 1);
  assertEquals(r.model_version, "d15 weights v1 paper p1");
  assertEquals(r.weights, { scholarly: 1, general: 0.5 });
});
