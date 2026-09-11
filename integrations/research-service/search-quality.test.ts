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

// ── B1 (tester, 2026-09-11) ────────────────────────────────────────────────
// The mirror image of the failure this detector exists for: a PERFECT result
// set reported as a broken search. `overlapRatio` demanded two distinct query
// terms per hit, so a query whose subject is one strong token plus generic
// words scored 0.00 on hits that all carry that one token — and
// dominantTitleTerm then found it in 100 % of titles, which is the collapse
// signature exactly. The run would then tell the user "search failure, not
// evidence of absence" about a search that worked.
Deno.test("B1: a hit set carrying only the ANCHOR term is ok, not collapsed", () => {
  const q = "Kubernetes CrashLoopBackOff diagnose";
  const titles = [
    "Debug CrashLoopBackOff",
    "CrashLoopBackOff explained",
    "Fixing CrashLoopBackOff",
    "CrashLoopBackOff troubleshooting",
    "CrashLoopBackOff: root causes",
  ];
  const hits: SearchHit[] = titles.map((title, i) => ({
    url: `https://k8s.example.org/${i}`, title,
    snippet: "how to debug a pod stuck in CrashLoopBackOff",
  }));
  const v = classifyHits(q, hits);
  assertEquals(v.verdict, "ok");
  assertEquals(v.overlap, 1);
});

Deno.test("B1: the anchor term must be DISTINCTIVE — 'dell' cannot rescue the Dell junk", () => {
  // The collapsed-dell fixture's own collapse token is short and generic. If any
  // single query token counted as an anchor, the recorded failure would classify
  // ok and the whole item would be undone.
  const f = load("search-collapsed-dell");
  assertEquals(classifyHits(f.query, f.hits).verdict, "collapsed");
  const m = load("search-collapsed-most");
  assertEquals(classifyHits(m.query, m.hits).verdict, "collapsed");
  const t = load("search-collapsed-the100");
  assertEquals(classifyHits(t.query, t.hits).verdict, "collapsed");
});

// ── B2 (tester, 2026-09-11) ────────────────────────────────────────────────
// Ten pages of pure noise were recorded as a SUCCESSFUL search, because no
// single QUERY token dominated their titles. They then spent the fetch and
// relevance-gate budget, and `SearchStats.ok` counted them as engine health.
Deno.test("B2: zero overlap across a full page of hits is never 'ok'", () => {
  const hits: SearchHit[] = Array.from({ length: 10 }, (_, i) => ({
    url: `https://shop.example.com/${i}`,
    title: `Best Buy Deals ${i}`,
    snippet: "Shop laptops and desktops on sale today.",
  }));
  const v = classifyHits("OptiPlex 3050 capacitor bulging repair", hits);
  assertEquals(v.verdict, "offtopic");
  assertEquals(v.overlap, 0);
});

Deno.test("B2: a THIN result set is not condemned — three hits is not a verdict", () => {
  const hits: SearchHit[] = Array.from({ length: 3 }, (_, i) => ({
    url: `https://example.org/${i}`, title: `Unrelated ${i}`, snippet: "nothing",
  }));
  assertEquals(classifyHits("dell optiplex 3050 capacitor failure", hits).verdict, "ok");
});

Deno.test("B2: a weak-but-not-empty set stays 'ok' (some hits do mention the subject)", () => {
  const hits: SearchHit[] = [
    ...Array.from({ length: 3 }, (_, i) => ({
      url: `https://good.example.org/${i}`,
      title: "Dell OptiPlex 3050 capacitor replacement",
      snippet: "optiplex 3050 capacitor",
    })),
    ...Array.from({ length: 7 }, (_, i) => ({
      url: `https://shop.example.com/${i}`, title: `Deals ${i}`, snippet: "sale",
    })),
  ];
  const v = classifyHits("dell optiplex 3050 capacitor failure", hits);
  assertEquals(v.verdict, "ok");
  assertEquals(v.overlap, 0.3);
});
