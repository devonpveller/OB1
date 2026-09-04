/** Pure-logic tests. Run: deno test lib.test.ts */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractTextFromHtml, extractTitle, domainOf, decodeEntities,
  isStale, revalidateWindow, decideReuse, backstopDecision, reuseMetric,
  citedNumbers, citedSubset, buildCitedAndRenumber, renderResult,
  classifyCuratorOutcome,
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

Deno.test("backstopDecision — OD-6 (sources vs timeouts are separate ceilings)", () => {
  const base = { elapsedMs: 0, maxMs: 1000, sources: 0, maxSources: 10, timeouts: 0, maxTimeouts: 20, openGaps: 3 };
  assertEquals(backstopDecision({ ...base, openGaps: 0 }).reason, "complete");
  assertEquals(backstopDecision({ ...base, elapsedMs: 2000 }).reason, "wall_time");
  // Source-yield ceiling: 10 real sources retrieved.
  assertEquals(backstopDecision({ ...base, sources: 10 }).reason, "max_fetch");
  // Timeout ceiling is SEPARATE: 20 timeouts with ZERO sources still stops, but
  // for a DIFFERENT, nameable reason (the network, not the source budget).
  assertEquals(backstopDecision({ ...base, timeouts: 20 }).reason, "max_timeouts");
  // maxTimeouts=0 disables the timeout ceiling.
  assertEquals(backstopDecision({ ...base, timeouts: 99, maxTimeouts: 0 }).stop, false);
  // Under both ceilings → keep going.
  assertEquals(backstopDecision({ ...base, sources: 1, timeouts: 1 }).stop, false);
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

Deno.test("buildCitedAndRenumber compacts + renumbers (fixes edge-skip misalignment)", () => {
  const staged = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];
  // synthesis cites the FULL staged indices; cited-only subset must renumber.
  const synth = "[SOURCED] Everest is tallest. [Source 1, 2, 4, 6, 7, 9]\n[SOURCED] Height 8848m. [Source 4, 6, 7, 9]";
  const { synthesis, cited } = buildCitedAndRenumber(synth, staged);
  // cited sources = the 6 distinct cited, in order: s1,s2,s4,s6,s7,s9
  assertEquals(cited, ["s1", "s2", "s4", "s6", "s7", "s9"]);
  // renumbered to 1..6: old 1,2,4,6,7,9 -> new 1,2,3,4,5,6
  assertEquals(citedNumbers(synthesis), [1, 2, 3, 4, 5, 6]);
  // every citation now resolves within cited[] (no out-of-range -> no edge skip)
  assertEquals(citedNumbers(synthesis).every((n) => cited[n - 1] != null), true);
});

Deno.test("buildCitedAndRenumber drops citations with no staged source", () => {
  const staged = ["s1", "s2"];
  const { synthesis, cited } = buildCitedAndRenumber("[SOURCED] X. [Source 1, 5]", staged);
  assertEquals(cited, ["s1"]);          // source 5 doesn't exist -> dropped
  assertEquals(citedNumbers(synthesis), [1]);
});

Deno.test("citedNumbers tolerates every bracket shape (live-model regression)", () => {
  // The exact shape the live model produced that broke the old regex.
  assertEquals(citedNumbers("Paris [SOURCED] [Source 1, Source 2, Source 4, Source 7]."), [1, 2, 4, 7]);
  assertEquals(citedNumbers("[Sources 1 and 2]"), [1, 2]);
  assertEquals(citedNumbers("x [Source 1] y [Source 2]"), [1, 2]);
  assertEquals(citedNumbers("[Source 11, 14]"), [11, 14]);
  assertEquals(citedNumbers("no citations here"), []);
});

// ── selectRepoFiles (REPO-SOURCES-WIRING §4) ─────────────────────────────────
import { selectRepoFiles } from "./lib.ts";

Deno.test("selectRepoFiles picks docs + manifests in priority order, skips code", () => {
  const { selected } = selectRepoFiles([
    "src/Murder/Murder.csproj",
    "src/Murder/Game.cs",              // code — never selected
    "docs/getting-started.md",
    "LICENSE.md",                      // excluded
    "README.md",
    ".gitmodules",
    "Murder.sln",
    "Directory.Build.props",
    "CHANGELOG.md",
    "media/logo.png",                  // not a candidate
  ]);
  assertEquals(selected[0], "README.md");                    // root README first
  assertEquals(selected[1], ".gitmodules");
  assertEquals(selected.includes("Murder.sln"), true);
  assertEquals(selected.includes("Directory.Build.props"), true);
  assertEquals(selected.includes("docs/getting-started.md"), true);
  assertEquals(selected.includes("CHANGELOG.md"), true);     // root md, non-license
  assertEquals(selected.includes("src/Murder/Murder.csproj"), true);  // shallow csproj
  assertEquals(selected.includes("LICENSE.md"), false);
  assertEquals(selected.includes("src/Murder/Game.cs"), false);
  assertEquals(selected.includes("media/logo.png"), false);
});

Deno.test("selectRepoFiles caps at maxFiles and reports the overflow as skipped", () => {
  const paths = Array.from({ length: 10 }, (_, i) => `docs/page-${i}.md`);
  const { selected, skipped } = selectRepoFiles(["README.md", ...paths], 5);
  assertEquals(selected.length, 5);
  assertEquals(selected[0], "README.md");
  assertEquals(skipped.length, 6);                           // nothing dropped silently
});

Deno.test("selectRepoFiles takes depth-1 READMEs but not deep ones", () => {
  const { selected } = selectRepoFiles([
    "docs/README.md", "src/deep/nested/README.md", "very/deep/path/x.csproj",
  ]);
  assertEquals(selected.includes("docs/README.md"), true);
  assertEquals(selected.includes("src/deep/nested/README.md"), false);
  assertEquals(selected.includes("very/deep/path/x.csproj"), false);   // >2 deep
});

Deno.test("renderResult: complete run renders synthesis + only cited sources", () => {
  const out = renderResult({
    synthesis: "Answer [1].",
    cited_sources: [{ url: "https://a.example", title: "A" }],
    gaps: [],
    backstop: "complete",
    reuse_ratio: 0.75,
  });
  assertEquals(out.includes("Answer [1]."), true);
  assertEquals(out.includes("1. [A](https://a.example)"), true);
  assertEquals(out.includes("coverage 75%"), true);
  // A complete run must NOT carry the anti-fabrication warning — crying wolf on
  // every result trains the reader to ignore it on the runs that matter.
  assertEquals(out.includes("INCOMPLETE"), false);
});

Deno.test("renderResult: gaps and early stops carry the do-not-fabricate directive", () => {
  const gapped = renderResult({ synthesis: "Partial.", gaps: ["what about X?"], backstop: "complete" });
  assertEquals(gapped.includes("- what about X?"), true);
  assertEquals(gapped.includes("INCOMPLETE"), true);
  assertEquals(gapped.includes("left gaps open"), true);

  const stopped = renderResult({ synthesis: "Partial.", gaps: [], backstop: "wall_time" });
  assertEquals(stopped.includes("INCOMPLETE"), true);
  assertEquals(stopped.includes("stopped early (wall_time)"), true);
  assertEquals(stopped.includes("stopped early: wall_time"), true);
});

Deno.test("renderResult: empty synthesis degrades honestly, never to an empty message", () => {
  const out = renderResult({ synthesis: "   ", cited_sources: [], gaps: [] });
  assertEquals(out.includes("(no synthesis produced)"), true);
});

Deno.test("renderResult: a source without a url is listed, not linked", () => {
  const out = renderResult({ synthesis: "S.", cited_sources: [{ url: null, title: "Untitled paper" }] });
  assertEquals(out.includes("1. Untitled paper"), true);
  assertEquals(out.includes("]("), false);
});

// ── classifyCuratorOutcome ──────────────────────────────────────────────────
// The rule these enforce: a run that lost output must NEVER produce
// status='done' with error=NULL. That combination is exactly what hid 244 lost
// runs for two and a half months.
Deno.test("curator failure => status error, and error names the loss", () => {
  const o = classifyCuratorOutcome({ error: "curator 500: Broken pipe (os error 32)" });
  assertEquals(o.status, "error");
  assertEquals(o.state, "FAILED");
  assertEquals(o.reason, "curator 500: Broken pipe (os error 32)");
  assertEquals(typeof o.error, "string");
  assertEquals(o.error!.includes("NOT filed into Open Brain"), true);
  assertEquals(o.error!.includes("Broken pipe (os error 32)"), true);
});

Deno.test("claims-only failure stays done but the error column is NOT null", () => {
  const o = classifyCuratorOutcome({ thread_id: "t1", claims_error: "deadlock detected" });
  assertEquals(o.status, "done");
  assertEquals(o.state, "partial");
  assertEquals(o.error!.includes("grounded claims NOT written"), true);
  assertEquals(o.error!.includes("deadlock detected"), true);
});

Deno.test("a curator that filed the package leaves error NULL", () => {
  const o = classifyCuratorOutcome({ thread_id: "t1", persist: { sources_written: 4 } });
  assertEquals(o, { status: "done", error: null, reason: null, state: "filed" });
});

Deno.test("no curator report at all is 'skipped', not 'filed'", () => {
  assertEquals(classifyCuratorOutcome(null).state, "skipped");
  assertEquals(classifyCuratorOutcome(undefined).state, "skipped");
  assertEquals(classifyCuratorOutcome(null).status, "done");
});

Deno.test("an empty error string is not a failure", () => {
  assertEquals(classifyCuratorOutcome({ thread_id: "t1", error: "" }).state, "filed");
  assertEquals(classifyCuratorOutcome({ thread_id: "t1", claims_error: "   " }).error, null);
});
