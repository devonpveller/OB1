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
