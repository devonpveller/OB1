// deno test src/routes/search_test.ts
// Gate for the search endpoint's parameter handling (wiki-dynamic-index P3).
// The SQL itself is parameter-bound and exercised live; what MUST be pinned
// here is that no caller-controlled value reaches the DB unclamped and that a
// too-short query never ranks the whole table.
import { assertEquals } from "jsr:@std/assert@1";
import { parseSearchParams } from "./search.ts";

// rw-p6a-resolve attempt 4 (tester N1): importing the route imports src/db/pool.ts, whose Pool opens
// its connections when it is created. These tests need no database; but with no network (the export
// runner's cached-layer gate re-run, --network none) that lookup fails at once and its rejection - no
// test's - failed the whole file, while in a build it usually lost the race and nothing was reported.
// So the outcome no longer depends on the network: that one rejection (the postgres pool's own
// connect) is absorbed here; any other unhandled rejection stays fatal.
globalThis.addEventListener("unhandledrejection", (e) => {
  const r = (e as PromiseRejectionEvent).reason as { stack?: string } | undefined;
  if (/deno\.land\/x\/postgres@[^/]+\/pool\.ts/.test(String(r?.stack ?? ""))) e.preventDefault();
});

Deno.test("limit is clamped into range and defaults sanely", () => {
  assertEquals(parseSearchParams("hello", undefined, undefined).limit, 25);
  assertEquals(parseSearchParams("hello", "10", undefined).limit, 10);
  assertEquals(parseSearchParams("hello", "9999", undefined).limit, 50);   // MAX
  assertEquals(parseSearchParams("hello", "0", undefined).limit, 25);      // non-positive -> default
  assertEquals(parseSearchParams("hello", "-5", undefined).limit, 25);
  assertEquals(parseSearchParams("hello", "abc", undefined).limit, 25);    // NaN -> default
  assertEquals(parseSearchParams("hello", "7.9", undefined).limit, 7);     // truncated
});

Deno.test("short and empty queries short-circuit instead of scanning", () => {
  assertEquals(parseSearchParams("", undefined, undefined).tooShort, true);
  assertEquals(parseSearchParams("  ", undefined, undefined).tooShort, true);
  assertEquals(parseSearchParams("a", undefined, undefined).tooShort, true);
  assertEquals(parseSearchParams(undefined, undefined, undefined).tooShort, true);
  assertEquals(parseSearchParams("ab", undefined, undefined).tooShort, false);
});

Deno.test("query and class are trimmed; injection-shaped input stays a value", () => {
  const p = parseSearchParams("  san francisco  ", undefined, " entity ");
  assertEquals(p.q, "san francisco");
  assertEquals(p.cls, "entity");
  // Passed through verbatim as a BOUND parameter - websearch_to_tsquery treats
  // it as text, never as SQL or tsquery syntax.
  const evil = parseSearchParams("'; DROP TABLE wiki_pages; --", undefined, undefined);
  assertEquals(evil.q, "'; DROP TABLE wiki_pages; --");
  assertEquals(evil.tooShort, false);
});
