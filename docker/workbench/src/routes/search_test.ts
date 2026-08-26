// deno test src/routes/search_test.ts
// Gate for the search endpoint's parameter handling (wiki-dynamic-index P3).
// The SQL itself is parameter-bound and exercised live; what MUST be pinned
// here is that no caller-controlled value reaches the DB unclamped and that a
// too-short query never ranks the whole table.
import { assertEquals } from "jsr:@std/assert@1";
import { parseSearchParams } from "./search.ts";

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
