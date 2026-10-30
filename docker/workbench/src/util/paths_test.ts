// Unit tests for the shared path validator (G9). Run: `deno test`.
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { safeJoin, safeRelPath } from "./paths.ts";

Deno.test("normalizes ./ and backslashes", () => {
  assertEquals(safeRelPath("a/./b.md"), "a/b.md");
  assertEquals(safeRelPath("foo\\bar.md"), "foo/bar.md");
  assertEquals(safeRelPath("notes/x.md"), "notes/x.md");
});

Deno.test("rejects parent-traversal in any position", () => {
  assertThrows(() => safeRelPath("../etc/passwd"));
  assertThrows(() => safeRelPath("a/../../b"));
  assertThrows(() => safeRelPath("notes/../../x"));
});

Deno.test("rejects empty / all-separators", () => {
  assertThrows(() => safeRelPath(""));
  assertThrows(() => safeRelPath("///"));
  assertThrows(() => safeRelPath("./."));
});

Deno.test("safeJoin stays under base; traversal throws", () => {
  assertEquals(safeJoin("/wiki", "notes/x.md"), "/wiki/notes/x.md");
  assertEquals(safeJoin("/wiki/", "notes/x.md"), "/wiki/notes/x.md");
  assertThrows(() => safeJoin("/wiki", "../x"));
});

// rw-identity2 (review r-identity B1): a segment that only becomes "." or ".." once decoded is refused
// too, so a still-encoded traversal can never be stored as a name and decoded later.
Deno.test("rejects percent-encoded dot segments (any case, any depth of %25)", () => {
  for (const p of ["%2e%2e/health/foo.md", "x/%2E%2E/y.md", "%2e/a.md", ".%2e/a.md", "%2e./a.md", "%252e%252e/a.md", "%25252E%25252e/a.md"]) {
    assertThrows(() => safeRelPath(p), Error, undefined, p);
  }
  assertEquals(safeRelPath("a%2eb.md"), "a%2eb.md", "an encoded dot inside a name is a name");
});
