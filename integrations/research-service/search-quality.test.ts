/**
 * RED-first tests for the query-collapse detector (PLAN-research-trust Phase 1.1).
 *
 * The fixtures are the AUDITED failure, captured from the live gateway on
 * 2026-09-11: three result sets where Bing answered HTTP 200 with ten hits for
 * the query's first salient token ("most" / "Dell" / "100"). The engine
 * reported success; the run treated the junk as "the topic has no sources".
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyHits, overlapRatio, type SearchHit } from "./search-quality.ts";

type Fixture = { query: string; hits: SearchHit[] };
const load = (n: string): Fixture =>
  JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));

Deno.test("collapsed fixture: the OptiPlex need collapses onto 'most'", () => {
  const f = load("search-collapsed-most");
  const v = classifyHits(f.query, f.hits);
  assertEquals(v.verdict, "collapsed");
  assert(v.overlap < 0.3, `overlap ${v.overlap}`);
  assertEquals((v.collapsedOn || "").toLowerCase(), "most");
});

Deno.test("collapsed fixture: the keyword OptiPlex query collapses onto 'dell'", () => {
  const f = load("search-collapsed-dell");
  const v = classifyHits(f.query, f.hits);
  assertEquals(v.verdict, "collapsed");
  assertEquals((v.collapsedOn || "").toLowerCase(), "dell");
});

Deno.test("collapsed fixture: the 100 Hz query collapses onto '100' (the TV series)", () => {
  const f = load("search-collapsed-the100");
  const v = classifyHits(f.query, f.hits);
  assertEquals(v.verdict, "collapsed");
  assertEquals((v.collapsedOn || "").toLowerCase(), "100");
});

Deno.test("good fixture: a real multi-engine OptiPlex result set is ok", () => {
  const f = load("search-good-optiplex");
  const v = classifyHits(f.query, f.hits);
  assertEquals(v.verdict, "ok");
  assert(v.overlap >= 0.3, `overlap ${v.overlap}`);
});

Deno.test("empty result set is 'empty', never 'collapsed'", () => {
  assertEquals(classifyHits("anything at all", []).verdict, "empty");
});

Deno.test("property: every title carrying ALL query terms is never collapsed", () => {
  const q = "dell optiplex 3050 capacitor failure";
  const hits: SearchHit[] = Array.from({ length: 10 }, (_, i) => ({
    url: `https://example.org/${i}`,
    title: "Dell OptiPlex 3050 capacitor failure teardown",
    snippet: "dell optiplex 3050 capacitor failure",
  }));
  const v = classifyHits(q, hits);
  assertEquals(v.verdict, "ok");
  assertEquals(v.overlap, 1);
});

Deno.test("a ONE-term query is not auto-collapsed (the 2-term rule would make overlap 0)", () => {
  // "optiplex" has a single non-stopword token; requiring 2 distinct terms would
  // score every possible hit set 0.00 and declare a perfectly good search broken.
  const hits: SearchHit[] = Array.from({ length: 5 }, (_, i) => ({
    url: `https://example.org/${i}`, title: "OptiPlex owner's manual", snippet: "optiplex",
  }));
  const v = classifyHits("optiplex", hits);
  assertEquals(v.verdict, "ok");
});

Deno.test("overlapRatio is the scorer the search-engine note used (2 distinct terms)", () => {
  const hits: SearchHit[] = [
    { url: "a", title: "Dell OptiPlex 3050", snippet: "" },   // 2 terms -> counts
    { url: "b", title: "Dell", snippet: "" },                 // 1 term  -> does not
  ];
  assertEquals(overlapRatio("dell optiplex 3050 failure", hits), 0.5);
});

Deno.test("a hit set with no shared title token is 'ok' even at low overlap (not our signature)", () => {
  // Low relevance WITHOUT the one-token signature is a weak search, not a
  // collapsed one — the detector must not claim the engine broke.
  const hits: SearchHit[] = [
    { url: "a", title: "Knitting patterns", snippet: "wool" },
    { url: "b", title: "Tax deadlines 2026", snippet: "irs" },
    { url: "c", title: "Sourdough starter", snippet: "flour" },
    { url: "d", title: "Violin rosin", snippet: "strings" },
    { url: "e", title: "Ferry timetable", snippet: "harbour" },
  ];
  assertEquals(classifyHits("dell optiplex 3050 capacitor failure", hits).verdict, "ok");
});
