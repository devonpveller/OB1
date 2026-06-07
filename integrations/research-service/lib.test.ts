/** Pure-logic tests. Run: deno test lib.test.ts */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractTextFromHtml, extractTitle, domainOf, decodeEntities,
  isStale, revalidateWindow, decideReuse, backstopDecision, reuseMetric,
  citedNumbers, citedSubset,
} from "./lib.ts";

Deno.test("extractTextFromHtml strips scripts/styles/tags, keeps text", () => {
  const html = `<html><head><title>T</title><style>.x{}</style></head>
    <body><nav>menu</nav><script>evil()</script>
    <h1>Hello</h1><p>World &amp; stuff</p><footer>foot</footer></body></html>`;
  const txt = extractTextFromHtml(html);
  assertEquals(txt.includes("Hello"), true);
  assertEquals(txt.includes("World & stuff"), true);
  assertEquals(txt.includes("evil"), false);
  assertEquals(txt.includes("menu"), false);
  assertEquals(txt.includes("foot"), false);
});

Deno.test("extractTitle + decodeEntities", () => {
  assertEquals(extractTitle("<title>My &amp; Page</title>"), "My & Page");
  assertEquals(decodeEntities("a&#39;b &lt;c&gt;"), "a'b <c>");
});

Deno.test("domainOf strips www", () => {
  assertEquals(domainOf("https://www.oakridgetn.gov/x"), "oakridgetn.gov");
  assertEquals(domainOf("not a url"), "");
});

Deno.test("revalidateWindow by volatility", () => {
  assertEquals(revalidateWindow("fast"), 7);
  assertEquals(revalidateWindow("medium"), 180);
  assertEquals(revalidateWindow("slow"), 1095);
  assertEquals(revalidateWindow(null, 42), 42);
});

Deno.test("isStale", () => {
  const now = new Date("2026-06-07");
  assertEquals(isStale("2026-06-01", "fast", null, now), false);   // 6d < 7d
  assertEquals(isStale("2026-05-01", "fast", null, now), true);    // 37d > 7d
  assertEquals(isStale(null, "slow", null, now), true);
});

Deno.test("decideReuse — OD-5 strict+stale", () => {
  const now = new Date("2026-06-07");
  const base = { confidence: 0.9, contradicted: false, hasStrongEdge: true, grounded: true,
                 researchedOn: "2026-06-01", volatility: "slow" as string | null, revalidateDays: null };
  assertEquals(decideReuse(base, 0.5, now), "reuse");
  assertEquals(decideReuse({ ...base, hasStrongEdge: false }, 0.5, now), "revalidate"); // inferred-only
  assertEquals(decideReuse({ ...base, researchedOn: "2020-01-01", volatility: "fast" }, 0.5, now), "revalidate"); // stale
  assertEquals(decideReuse({ ...base, contradicted: true }, 0.5, now), "research");
  assertEquals(decideReuse({ ...base, grounded: false }, 0.5, now), "research");
  assertEquals(decideReuse({ ...base, confidence: 0.3 }, 0.5, now), "research"); // below floor
});

Deno.test("backstopDecision — OD-6", () => {
  assertEquals(backstopDecision({ elapsedMs: 0, maxMs: 1000, fetches: 0, maxFetches: 10, openGaps: 0 }).reason, "complete");
  assertEquals(backstopDecision({ elapsedMs: 2000, maxMs: 1000, fetches: 0, maxFetches: 10, openGaps: 3 }).reason, "wall_time");
  assertEquals(backstopDecision({ elapsedMs: 0, maxMs: 1000, fetches: 10, maxFetches: 10, openGaps: 3 }).reason, "max_fetch");
  assertEquals(backstopDecision({ elapsedMs: 0, maxMs: 1000, fetches: 1, maxFetches: 10, openGaps: 3 }).stop, false);
});

Deno.test("reuseMetric gap ratio", () => {
  assertEquals(reuseMetric(8, 2, 0).gap_ratio, 0);
  assertEquals(reuseMetric(0, 0, 4).gap_ratio, 1);
  assertEquals(reuseMetric(2, 2, 1).gap_ratio, 0.2);
});

Deno.test("citedNumbers + citedSubset (cited-only)", () => {
  const synth = "[SOURCED] A. [Source 1] [INFERRED] B. [Source 1, 3]";
  assertEquals(citedNumbers(synth), [1, 3]);
  const sources = ["s1", "s2", "s3"];
  assertEquals(citedSubset(synth, sources), ["s1", "s3"]); // s2 found-but-uncited dropped
});
