/** Pure-logic tests. Run: deno test lib.test.ts */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractTextFromHtml, extractTitle, domainOf, decodeEntities,
  isStale, revalidateWindow, decideReuse, backstopDecision, reuseMetric,
  citedNumbers, citedSubset, buildCitedAndRenumber, renderResult,
  classifyCuratorOutcome, proxyPolicy,
  shouldRetryCuratorError, curatorBackoffMs, curatorRefusedWorstCaseMs, curatorTimeoutWorstCaseMs, delegateCuratorWithRetry,
  CuratorHttpError, CuratorTimeoutError, CuratorAfterSendError, CuratorNoVerdictError, curatorTimeoutMsFromEnv, curatorRetriesFromEnv, type FetchLike,
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
    needs_status: [
      { need: "a", status: "answered" }, { need: "b", status: "answered" },
      { need: "c", status: "answered" }, { need: "d", status: "open" },
    ],
    search_record: { hits: 40, fetched: 30, readable: 28, relevant: 9, collapsed: 0 },
  });
  assertEquals(out.includes("Answer [1]."), true);
  assertEquals(out.includes("1. [A](https://a.example)"), true);
  // CHANGED 2026-09-11 (research-trust): was `coverage 75%`, which was
  // 1 - gap_ratio over synthesis LINES and had nothing to do with how much of
  // the question was answered. `reuse_ratio` is still accepted and still
  // ignored here on purpose.
  assertEquals(out.includes("needs answered 3 of 4"), true);
  assertEquals(out.includes("sources 9 relevant of 30 fetched"), true);
  assertEquals(/coverage \d+%/.test(out), false);
  // A complete run must NOT carry the anti-fabrication warning — crying wolf on
  // every result trains the reader to ignore it on the runs that matter.
  assertEquals(out.includes("INCOMPLETE"), false);
});

Deno.test("renderResult: a job recorded BEFORE needs_status prints no coverage number at all", () => {
  const out = renderResult({
    synthesis: "Answer [1].",
    cited_sources: [{ url: "https://a.example", title: "A" }],
    gaps: [], backstop: "complete", reuse_ratio: 0.22,
  });
  assertEquals(/coverage \d+%/.test(out), false);
  assertEquals(/needs answered/.test(out), false);
});

Deno.test("renderResult: the footer is not printed twice when prose already carries it", () => {
  const out = renderResult({
    prose: "# Report\nBody.\n\n_— needs answered 1 of 2_",
    needs_status: [{ need: "a", status: "answered" }, { need: "b", status: "open" }],
    search_record: { hits: 10, fetched: 8, readable: 8, relevant: 2, collapsed: 0 },
    backstop: "complete",
  });
  assertEquals(out.match(/needs answered/g)?.length, 1);
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

Deno.test("a DELIBERATE skip reports 'skipped' with its reason, never 'filed'", () => {
  // research-trust: runResearch returns { state: "skipped", reason } when it
  // refuses to hand the curator a run that retrieved nothing. That object is
  // truthy, so before this branch existed it read as a successful filing.
  const o = classifyCuratorOutcome({ state: "skipped", reason: "search_degraded" });
  assertEquals(o.state, "skipped");
  assertEquals(o.status, "done");
  assertEquals(o.error, null);
  assertEquals(o.reason, "search_degraded");
});

Deno.test("an empty error string is not a failure", () => {
  assertEquals(classifyCuratorOutcome({ thread_id: "t1", error: "" }).state, "filed");
  assertEquals(classifyCuratorOutcome({ thread_id: "t1", claims_error: "   " }).error, null);
});

// srcadm 2026-09-05: a configured-but-unbuildable proxy REFUSES (the old code
// fell back to DIRECT and silently un-proxied every page fetch). Direct is
// reachable only by the operator explicitly emptying FETCH_PROXY_URL.
Deno.test("proxyPolicy: configured+built proxies; configured+unbuildable refuses; only explicit empty goes direct", () => {
  assertEquals(proxyPolicy("http://vpn:8888", true), "proxy");
  assertEquals(proxyPolicy("http://vpn:8888", false), "refuse");
  assertEquals(proxyPolicy("", false), "direct");
  assertEquals(proxyPolicy("   ", false), "direct", "whitespace-only is the same explicit choice as empty");
});

// ── researchretry 2026-09-06: curator call timeout + bounded retry ───────────
// Every case drives delegateCuratorWithRetry with an INJECTED fetch, an injected
// sleep and an injected clock: no network, no real waiting. The wrapper builds
// the per-attempt AbortSignal.timeout itself, so a fake fetch that only resolves
// via the signal is the mutation detector for "remove the signal".
//
// Policy under test (anchor, amended 2026-09-06; tester's refutations 1, 2b, 3
// folded in): connect-phase failures are retried up to `retries` TOTAL
// attempts; a TIMEOUT - in the connect, header OR body phase - is NOT retried
// and fails once naming the elapsed time; a failure after the request was sent
// is NOT retried and says the package may have been received; a 2xx without a
// JSON object body is NOT filed; an HTTP answer of any status is never retried.

const CURATOR_URL = "http://curator.test:8000/ingest/research-package";
const INIT: RequestInit = { method: "POST", body: "{}" };

/** Deno's real message for a refused TCP connect (verified live, T3(a)). */
function refusedError(): Error {
  return new TypeError(
    "error sending request for url (http://curator.test:8000/ingest/research-package): " +
      "client error (Connect): tcp connect error: Connection refused (os error 111)",
  );
}
/** Deno's real message when the peer closes AFTER the request went out (tester's refutation 1). */
function closedAfterSendError(): Error {
  return new TypeError(
    "error sending request from 172.17.0.8:47846 for http://curator.test:8000/ingest/research-package (172.17.0.4:8000): " +
      "client error (SendRequest): connection closed before message completed",
  );
}

interface Trace {
  calls: number; sleeps: number[]; logs: string[]; clock: number;
  opts: { sleep: (ms: number) => Promise<void>; log: (l: string) => void; now: () => number };
}
function trace(): Trace {
  const t: Trace = { calls: 0, sleeps: [], logs: [], clock: 1_000_000, opts: { sleep: async () => {}, log: () => {}, now: () => 0 } };
  t.opts.sleep = async (ms) => { t.sleeps.push(ms); t.clock += ms; };
  t.opts.log = (l) => { t.logs.push(l); };
  t.opts.now = () => t.clock;
  return t;
}
async function failing(fn: () => Promise<unknown>): Promise<Error> {
  try { await fn(); } catch (e) { return e as Error; }
  throw new Error("expected the call to throw");
}

Deno.test("curator: connection refused (Connect phase) is retried CURATOR_RETRIES times, then surfaces with the attempt count and the last cause", async () => {
  const t = trace();
  const fetchImpl: FetchLike = async () => { t.calls++; t.clock += 5; throw refusedError(); };
  const err = await failing(() => delegateCuratorWithRetry(fetchImpl, CURATOR_URL, INIT, { retries: 3, timeoutMs: 180_000, ...t.opts }));
  assertEquals(t.calls, 3, "three attempts in total");
  assertEquals(t.sleeps, [2000, 4000], "backoff between attempts, none after the last");
  assertEquals(t.logs.length, 2, "one retry line per failed-and-retried attempt");
  assertEquals(t.logs[0].startsWith("curator attempt 1/3 failed: TypeError: error sending request"), true, t.logs[0]);
  assertEquals(/after 3 attempt\(s\) in 6015 ms/.test(err.message), true, err.message);
  assertEquals(err.message.includes("Connection refused"), true, "the last cause is named");
});

Deno.test("curator: a per-attempt timeout before any response is NOT retried - fails once naming the elapsed time", async () => {
  const t = trace();
  // Resolves ONLY through the signal: without one, the real call would hang forever
  // and this fake refuses instead of hanging the suite.
  const fetchImpl: FetchLike = (_url, init) => {
    t.calls++;
    const sig = init.signal;
    if (!sig) return Promise.reject(new Error("fake fetch: no AbortSignal supplied - the real call would hang forever"));
    return new Promise<Response>((_resolve, reject) => {
      sig.addEventListener("abort", () => { t.clock += 20; reject(sig.reason ?? new DOMException("signal timed out", "TimeoutError")); });
    });
  };
  const err = await failing(() => delegateCuratorWithRetry(fetchImpl, CURATOR_URL, INIT, { retries: 3, timeoutMs: 20, ...t.opts }));
  assertEquals(t.calls, 1, "ONE attempt: a timeout is never retried");
  assertEquals(t.sleeps, [], "no backoff was slept");
  assertEquals(t.logs, [], "no retry line was logged");
  assertEquals(err.name, "CuratorTimeoutError");
  assertEquals(err.message, "curator timed out after 20 ms (CURATOR_TIMEOUT_MS=20, attempt 1/3, not retried - the curator may still be working on the package)");
  assertEquals(shouldRetryCuratorError(err), false);
});

Deno.test("curator: a 2xx whose BODY stalls past the timeout is a timeout, not `{}` filed (tester's refutation 2b)", async () => {
  const t = trace();
  // 200 headers arrive at once; the body stream only errors when the wrapper's signal fires.
  const fetchImpl: FetchLike = async (_url, init) => {
    t.calls++;
    const sig = init.signal!;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"thread_id":'));
        sig.addEventListener("abort", () => { t.clock += 25; controller.error(sig.reason); });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  const err = await failing(() => delegateCuratorWithRetry(fetchImpl, CURATOR_URL, INIT, { retries: 3, timeoutMs: 25, ...t.opts }));
  assertEquals(t.calls, 1, "one attempt - the curator may still be working");
  assertEquals(t.sleeps, []);
  assertEquals(err.name, "CuratorTimeoutError");
  assertEquals(err.message, "curator timed out after 25 ms while reading its answer (CURATOR_TIMEOUT_MS=25, attempt 1/3, not retried - the curator may still be working on the package)");
  assertEquals(classifyCuratorOutcome({ error: err.message }).state, "FAILED", "research_jobs reads it as NOT filed");
});

Deno.test("curator: a 2xx whose body is empty, truncated or not an object is NOT filed - no JSON verdict", async () => {
  for (const [body, bytes] of [["", 0], ['{"thread_id":', 13], ["<html>ok</html>", 15], ["[]", 2], ["null", 4]] as Array<[string, number]>) {
    const t = trace();
    const fetchImpl: FetchLike = async () => { t.calls++; return new Response(body, { status: 200 }); };
    const err = await failing(() => delegateCuratorWithRetry(fetchImpl, CURATOR_URL, INIT, { retries: 3, timeoutMs: 180_000, ...t.opts }));
    assertEquals(t.calls, 1, body);
    assertEquals(err.name, "CuratorNoVerdictError", body);
    assertEquals(err.message, `curator answered 200 with no JSON verdict (${bytes} bytes)`);
    assertEquals(classifyCuratorOutcome({ error: err.message }).state, "FAILED", body);
    assertEquals(shouldRetryCuratorError(err), false);
  }
});

Deno.test("curator: the peer closing AFTER the request was sent (SendRequest) is NOT retried - one attempt, says the package may have been received", async () => {
  const t = trace();
  const fetchImpl: FetchLike = async () => { t.calls++; throw closedAfterSendError(); };
  const err = await failing(() => delegateCuratorWithRetry(fetchImpl, CURATOR_URL, INIT, { retries: 3, timeoutMs: 180_000, ...t.opts }));
  assertEquals(t.calls, 1, "no resend after the package may have been received");
  assertEquals(t.sleeps, []);
  assertEquals(t.logs, []);
  assertEquals(err.name, "CuratorAfterSendError");
  assertEquals(err.message.startsWith("curator connection failed after the request was sent (attempt 1/3, not retried - the package may have been received): TypeError: error sending request"), true, err.message);
  assertEquals(err.message.includes("(SendRequest)"), true);
  assertEquals(shouldRetryCuratorError(err), false);
  // A body-read failure after headers is the same class.
  const t2 = trace();
  const bodyFails: FetchLike = async () => {
    t2.calls++;
    const body = new ReadableStream<Uint8Array>({ start(c) { c.error(new TypeError("error reading a body from connection: connection reset")); } });
    return new Response(body, { status: 200 });
  };
  const err2 = await failing(() => delegateCuratorWithRetry(bodyFails, CURATOR_URL, INIT, { retries: 3, timeoutMs: 180_000, ...t2.opts }));
  assertEquals(t2.calls, 1);
  assertEquals(err2.name, "CuratorAfterSendError");
  assertEquals(err2.message.includes("error reading a body"), true, err2.message);
});

Deno.test("curator: an HTTP 500 JSON answer is a verdict - returned on the first attempt, NOT retried; a non-JSON 5xx keeps the `curator <status>: {}` shape", async () => {
  const t = trace();
  const fetchImpl: FetchLike = async () => {
    t.calls++;
    return Response.json({ error: "persist_failed", stage: "persist" }, { status: 500 });
  };
  const err = await failing(() => delegateCuratorWithRetry(fetchImpl, CURATOR_URL, INIT, { retries: 3, timeoutMs: 180_000, ...t.opts }));
  assertEquals(t.calls, 1, "no retry on an answer");
  assertEquals(t.sleeps, []);
  assertEquals(t.logs, []);
  assertEquals(err.message.startsWith("curator 500: "), true, err.message);
  assertEquals(err.message.includes("persist_failed"), true);
  assertEquals(shouldRetryCuratorError(err), false);
  // 4xx is the same kind of thing.
  const fetch400: FetchLike = async () => Response.json({ error: "claim required" }, { status: 400 });
  const e400 = await failing(() => delegateCuratorWithRetry(fetch400, CURATOR_URL, INIT, { retries: 3, timeoutMs: 180_000, ...t.opts }));
  assertEquals(e400.message, 'curator 400: {"error":"claim required"}');
  // A plain-text 500 keeps today's shape (body lost, status kept).
  const fetchText500: FetchLike = async () => new Response("Internal Server Error", { status: 500 });
  const eText = await failing(() => delegateCuratorWithRetry(fetchText500, CURATOR_URL, INIT, { retries: 3, timeoutMs: 180_000, ...t.opts }));
  assertEquals(eText.message, "curator 500: {}");
  assertEquals(eText.name, "CuratorHttpError");
});

Deno.test("curator: HTTP 200 with a JSON object returns it on the first attempt", async () => {
  const t = trace();
  const fetchImpl: FetchLike = async (url, init) => {
    t.calls++;
    assertEquals(url, CURATOR_URL);
    assertEquals(init.method, "POST");
    assertEquals(init.signal instanceof AbortSignal, true, "every attempt carries a signal");
    return Response.json({ thread_id: "t1", sources_written: 4 });
  };
  const out = await delegateCuratorWithRetry(fetchImpl, CURATOR_URL, INIT, { retries: 3, timeoutMs: 180_000, ...t.opts });
  assertEquals(out, { thread_id: "t1", sources_written: 4 });
  assertEquals(t.calls, 1);
  assertEquals(t.sleeps, []);
});

Deno.test("curator: a refusal that clears on the second attempt succeeds (the transient case this exists for)", async () => {
  const t = trace();
  const fetchImpl: FetchLike = async () => {
    t.calls++;
    if (t.calls === 1) throw refusedError();
    return Response.json({ thread_id: "t1" });
  };
  const out = await delegateCuratorWithRetry(fetchImpl, CURATOR_URL, INIT, { retries: 3, timeoutMs: 180_000, ...t.opts });
  assertEquals(out, { thread_id: "t1" });
  assertEquals(t.calls, 2);
  assertEquals(t.sleeps, [2000]);
});

Deno.test("curator: an error that is neither transport nor timeout surfaces unchanged on the first attempt", async () => {
  const t = trace();
  const fetchImpl: FetchLike = async () => { t.calls++; throw new SyntaxError("boom"); };
  const err = await failing(() => delegateCuratorWithRetry(fetchImpl, CURATOR_URL, INIT, { retries: 3, timeoutMs: 180_000, ...t.opts }));
  assertEquals(t.calls, 1);
  assertEquals(err.message, "boom");
});

Deno.test("shouldRetryCuratorError: connect-phase yes; after-send, timeouts/aborts, any HTTP answer, unknown errors, null no", () => {
  for (const m of ["ECONNREFUSED", "connect EHOSTUNREACH 10.0.0.1", "connect ENETUNREACH", "getaddrinfo EAI_AGAIN curator",
    "error sending request for url (http://x): client error (Connect): tcp connect error: Connection refused (os error 111)",
    "error sending request for url (http://x): client error (Connect): tcp connect error: No route to host (os error 113)",
    "error sending request for url (http://x): client error (Connect): tcp connect error: Connection reset by peer (os error 104)"]) {
    assertEquals(shouldRetryCuratorError(new Error(m)), true, m);
  }
  for (const m of ["error sending request for url (http://x): client error (SendRequest): connection closed before message completed",
    "read ECONNRESET", "write EPIPE", "connection reset by peer", "request timed out", "error reading a body from connection"]) {
    assertEquals(shouldRetryCuratorError(new Error(m)), false, `after the send, or time-shaped: ${m}`);
  }
  assertEquals(shouldRetryCuratorError(new DOMException("signal timed out", "TimeoutError")), false, "our deadline: the curator may be working");
  assertEquals(shouldRetryCuratorError(new DOMException("aborted", "AbortError")), false);
  assertEquals(shouldRetryCuratorError(new CuratorTimeoutError(5000, 5000, 1, 3, "request")), false);
  assertEquals(shouldRetryCuratorError(new CuratorAfterSendError("x", 1, 3)), false);
  assertEquals(shouldRetryCuratorError(new CuratorNoVerdictError(200, 0)), false);
  assertEquals(shouldRetryCuratorError(new CuratorHttpError(503, '{"error":"db"}')), false, "an HTTP status is an answer");
  assertEquals(shouldRetryCuratorError(new Error("curator 502: persist_failed")), false, "a verdict rendered as a plain Error");
  assertEquals(shouldRetryCuratorError(new Error("boom")), false);
  assertEquals(shouldRetryCuratorError(new SyntaxError("Unexpected token")), false);
  assertEquals(shouldRetryCuratorError(null), false);
  assertEquals(shouldRetryCuratorError(undefined), false);
});

Deno.test("curator env parsing: CURATOR_TIMEOUT_MS <= 0, non-numeric or unset -> default 180000; CURATOR_RETRIES floors at 1", () => {
  assertEquals(curatorTimeoutMsFromEnv("-1"), 180_000, "-1 used to reach AbortSignal.timeout and throw on every attempt");
  assertEquals(curatorTimeoutMsFromEnv("0"), 180_000);
  assertEquals(curatorTimeoutMsFromEnv("abc"), 180_000);
  assertEquals(curatorTimeoutMsFromEnv(""), 180_000);
  assertEquals(curatorTimeoutMsFromEnv(undefined), 180_000);
  assertEquals(curatorTimeoutMsFromEnv("5000"), 5000);
  assertEquals(curatorTimeoutMsFromEnv("5000abc"), 5000, "parseInt prefix, as before");
  assertEquals(curatorRetriesFromEnv("0"), 1);
  assertEquals(curatorRetriesFromEnv("-2"), 1);
  assertEquals(curatorRetriesFromEnv("abc"), 3);
  assertEquals(curatorRetriesFromEnv(undefined), 3);
  assertEquals(curatorRetriesFromEnv("2.7"), 2);
  assertEquals(curatorRetriesFromEnv("5"), 5);
});

Deno.test("curator: a non-positive timeoutMs handed to the wrapper falls back to the default instead of throwing on every attempt", async () => {
  const t = trace();
  let seenSignal = false;
  const fetchImpl: FetchLike = async (_url, init) => { t.calls++; seenSignal = init.signal instanceof AbortSignal; return Response.json({ thread_id: "t1" }); };
  const out = await delegateCuratorWithRetry(fetchImpl, CURATOR_URL, INIT, { retries: 3, timeoutMs: -1, ...t.opts });
  assertEquals(out, { thread_id: "t1" });
  assertEquals(seenSignal, true, "AbortSignal.timeout was built with a valid value");
});

Deno.test("curator backoff is bounded (2s, 4s, 8s, cap 10s); refused worst case = attempts x connect-fail + backoff; timeout worst case = exactly one CURATOR_TIMEOUT_MS", () => {
  assertEquals(curatorBackoffMs(1), 2000);
  assertEquals(curatorBackoffMs(2), 4000);
  assertEquals(curatorBackoffMs(3), 8000);
  assertEquals(curatorBackoffMs(4), 10_000, "cap");
  assertEquals(curatorBackoffMs(50), 10_000, "still the cap");
  assertEquals(curatorBackoffMs(0), 2000, "clamped to the first step");
  // Refused: CURATOR_RETRIES=3, a refused connect fails in ~5 ms -> 3 x 5 + 2000 + 4000.
  assertEquals(curatorRefusedWorstCaseMs(3, 5), 6015);
  assertEquals(curatorRefusedWorstCaseMs(1, 5), 5, "one attempt = one connect-fail, no backoff");
  assertEquals(curatorRefusedWorstCaseMs(6, 1_000), 6_000 + 2000 + 4000 + 8000 + 10_000 + 10_000);
  // Timeout: never retried, so the bound is the timeout itself - 180 s at the default, 5 s in the live tests.
  assertEquals(curatorTimeoutWorstCaseMs(180_000), 180_000);
  assertEquals(curatorTimeoutWorstCaseMs(5_000), 5_000);
});
