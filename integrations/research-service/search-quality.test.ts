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
  const v = classifyHits(q, hits, "OptiPlex 3050");
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

// ── T11 (tester, attempt 2, 2026-09-11) ────────────────────────────────────
// The four probes that failed attempt 2, captured from the live gateway. Two of
// them were classified `ok` at overlap 0.9 and 0.7 by a detector whose safety
// argument was a 7-character threshold: `ANCHOR_MIN_LEN` separated SHORT
// collapse tokens from LONG ones, not collapse tokens from subject entities,
// and `capacitor` / `motherboard` / `vestibular` / `semaglutide` are the head
// nouns of exactly the technical and clinical questions this engine is for.
//
// The rule is now structural instead of fitted: a result set answers the query
// only if the SUBJECT ENTITY — the thing KEYWORDIZE already extracts and the
// harness already enforces into every query — is actually present in the hits.
type Probe = { query: string; entity: string; hits: SearchHit[] };
const probe = (n: string): Probe =>
  JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));

Deno.test("T11: the tester's live probes are search failures, not 'ok'", () => {
  for (const name of [
    "probe-collapsed-capacitor",     // was ok @ 0.90
    "probe-collapsed-motherboard",   // was ok @ 0.70
    "probe-collapsed-vestibular",
  ]) {
    const p = probe(name);
    const v = classifyHits(p.query, p.hits, p.entity);
    assert(v.verdict !== "ok", `${name} classified ${v.verdict} (overlap ${v.overlap})`);
    assertEquals(v.entityShare, 0, `${name}: the entity is absent from every hit`);
  }
});

Deno.test("T11: entity PRESENT in every hit is never collapsed, whatever the token lengths", () => {
  for (const name of ["probe-good-oomkilled", "probe-good-iphone"]) {
    const p = probe(name);
    const v = classifyHits(p.query, p.hits, p.entity);
    assertEquals(v.verdict, "ok", `${name} classified ${v.verdict}`);
  }
  // Property: synthesise a set whose only query word is the entity, with the
  // entity in a dominating position — the exact shape that used to collapse.
  for (const entity of ["CrashLoopBackOff", "OOMKilled", "semaglutide", "XJ", "e5"]) {
    const hits: SearchHit[] = Array.from({ length: 10 }, (_, i) => ({
      url: `https://example.org/${i}`,
      title: `${entity}: what it means`,
      snippet: `everything about ${entity}`,
    }));
    const v = classifyHits(`${entity} diagnose fix guide`, hits, entity);
    assertEquals(v.verdict, "ok", `${entity} -> ${v.verdict}`);
  }
});

Deno.test("T11: the three ORIGINAL collapse fixtures still collapse under the entity rule", () => {
  for (const [name, entity, token] of [
    ["search-collapsed-dell", "OptiPlex 3050", "dell"],
    ["search-collapsed-most", "OptiPlex 3050", "most"],
    ["search-collapsed-the100", "100 Hz", "100"],
  ]) {
    const f = load(name);
    const v = classifyHits(f.query, f.hits, entity);
    assertEquals(v.verdict, "collapsed", name);
    assertEquals((v.collapsedOn || "").toLowerCase(), token, name);
  }
});

Deno.test("T11: an entity-present set whose hits miss the NEED is a weak search, not a broken engine", () => {
  // `semaglutide gastroparesis incidence` returned ten real semaglutide pages
  // that say nothing about gastroparesis. The engine understood the subject;
  // the relevance gate is what rejects a page that does not answer the need.
  // Calling this "the search failed" would be the same overreach that failed
  // attempts 1 and 2, in the other direction.
  const p = probe("probe-collapsed-semaglutide");
  const v = classifyHits(p.query, p.hits, p.entity);
  assertEquals(v.verdict, "ok");
  assertEquals(v.entityShare, 1);
  assert(v.overlap < 0.5, `overlap ${v.overlap} — low, and recorded as secondary evidence`);
});

Deno.test("T11: the subject is matched in every spelling engines write it", () => {
  const mk = (title: string): SearchHit[] =>
    Array.from({ length: 10 }, (_, i) => ({ url: `u${i}`, title, snippet: "" }));
  for (const t of ["OptiPlex 3050 manual", "optiplex 3050 teardown", "Dell OptiPlex-3050 SFF",
                   "OPTIPLEX  3050 owner's guide"]) {
    assertEquals(classifyHits("optiplex 3050 repair", mk(t), "OptiPlex 3050").verdict, "ok", t);
  }
  // CHANGED by research-trust-core attempt 2, and declared rather than hidden:
  // the subject is a SET of tokens, not a phrase, so ADJACENCY NO LONGER
  // MATTERS. "OptiPlex 7080 and the 3050-era chipset" now carries the subject.
  // Requiring adjacency is what produced four successive false search failures
  // (subject.test.ts header), and a page mentioning OptiPlex models and 3050 IS
  // evidence the engine understood the subject - which is the only question
  // this detector asks. Whether such a page answers the NEED is the relevance
  // gate's job, one page at a time.
  const scattered = mk("OptiPlex 7080 and the 3050-era chipset");
  assertEquals(classifyHits("optiplex 3050 repair", scattered, "OptiPlex 3050").verdict, "ok");
  // The line that matters is unmoved: junk carrying ONE token is still refused.
  const junk = mk("Computers, Monitors & Technology Solutions | Dell USA");
  assert(classifyHits("optiplex 3050 repair", junk, "Dell OptiPlex 3050").verdict !== "ok");
});

Deno.test("T11: with NO entity the classifier falls back, and the fallback is weaker", () => {
  // Article-mode preliminary gap searches and legacy callers pass no entity.
  // This is the set that separates the two rules: every hit carries two or more
  // query terms (capacitor / failure / repair), so the overlap rule scores it
  // 1.00 and calls it a healthy search — while not one page is about the
  // OptiPlex 3050. Only the entity gate can tell.
  const q = "OptiPlex 3050 capacitor failure repair";
  const hits: SearchHit[] = Array.from({ length: 10 }, (_, i) => ({
    url: `https://example.org/${i}`,
    title: "Capacitor failure and repair: a general guide",
    snippet: "how capacitor failure happens and how repair is done",
  }));
  const without = classifyHits(q, hits);
  assertEquals(without.verdict, "ok", "the fallback cannot see what it is not told");
  assertEquals(without.overlap, 1);
  assertEquals(without.entityShare, undefined);

  const withEntity = classifyHits(q, hits, "OptiPlex 3050");
  assert(withEntity.verdict !== "ok", `entity gate said ${withEntity.verdict}`);
  assertEquals(withEntity.entityShare, 0);
  assertEquals(withEntity.overlap, 1, "overlap is reported, and is not the gate");
});

// ── B1 (tester, 2026-09-11) ────────────────────────────────────────────────
// The mirror image of the failure this detector exists for: a PERFECT result
// set reported as a broken search. `overlapRatio` demanded two distinct query
// terms per hit, so a query whose subject is one strong token plus generic
// words scored 0.00 on hits that all carry that one token — and
// dominantTitleTerm then found it in 100 % of titles, which is the collapse
// signature exactly. The run would then tell the user "search failure, not
// evidence of absence" about a search that worked.
Deno.test("B1: a hit set whose only query word is the ENTITY is ok, not collapsed", () => {
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
  const v = classifyHits(q, hits, "CrashLoopBackOff");
  assertEquals(v.verdict, "ok");
});

Deno.test("B1: a distinctive token in the junk cannot rescue it — only the entity can", () => {
  // Attempt 2 tried to solve B1 with a token-LENGTH rule. It separated short
  // collapse tokens from long ones, not collapse tokens from subject entities,
  // and `capacitor` / `motherboard` / `vestibular` walked straight through it.
  // These three recorded failures are the floor that rule had to hold.
  const f = load("search-collapsed-dell");
  assertEquals(classifyHits(f.query, f.hits, "OptiPlex 3050").verdict, "collapsed");
  const m = load("search-collapsed-most");
  assertEquals(classifyHits(m.query, m.hits, "OptiPlex 3050").verdict, "collapsed");
  const t = load("search-collapsed-the100");
  assertEquals(classifyHits(t.query, t.hits, "100 Hz").verdict, "collapsed");
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
  const v = classifyHits("OptiPlex 3050 capacitor bulging repair", hits, "OptiPlex 3050");
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
