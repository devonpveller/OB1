// deno test src/routes/nav_test.ts
// Gate for /workbench/nav (research-workbench P1b) and the search endpoint's
// tag mode: what reaches the viewer / the database is bounded and literal.
import { assertEquals } from "jsr:@std/assert@1";
import { navQuery } from "./nav.ts";
import { parseSearchParams, tagPattern } from "./search.ts";

Deno.test("navQuery forwards only folder/offset/limit/focus, clamped", () => {
  assertEquals(navQuery({ folder: "content/tool" }), "folder=content%2Ftool");
  assertEquals(navQuery({}), "folder=");
  assertEquals(navQuery({ folder: "", offset: "500", limit: "9999" }), "folder=&offset=500&limit=2000");
  assertEquals(navQuery({ folder: "x", offset: "-3", limit: "abc" }), "folder=x");
  assertEquals(navQuery({ folder: "x", offset: "7.9", limit: "2.5" }), "folder=x&offset=7&limit=2");
  const q = navQuery({ folder: "a", focus: "a/b&evil=1" });
  assertEquals(new URLSearchParams(q).get("focus"), "a/b&evil=1"); // a value, never a second parameter
  assertEquals([...new URLSearchParams(q).keys()], ["folder", "focus"]);
  assertEquals(navQuery({ folder: "x".repeat(5000) }).length, "folder=".length + 1024);
});

Deno.test("tag search: a tag alone is a query; # is dropped; LIKE wildcards are literal", () => {
  const p = parseSearchParams(undefined, undefined, undefined, " #fixture-tag ");
  assertEquals(p.tag, "fixture-tag");
  assertEquals(p.tooShort, false);
  assertEquals(parseSearchParams("a", undefined, undefined, "t").tooShort, true); // a 1-char term is still too short
  assertEquals(parseSearchParams("ab", undefined, undefined, "t").tooShort, false);
  assertEquals(parseSearchParams(undefined, undefined, undefined, "  ").tooShort, true); // no tag, no term
  assertEquals(tagPattern("Fix_ture%"), "%fix\\_ture\\%%");
  assertEquals(tagPattern("a\\b"), "%a\\\\b%");
});
