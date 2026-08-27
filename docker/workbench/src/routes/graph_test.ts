// deno test — pure gates for the graph endpoint (no DB needed).
import { assertEquals } from "jsr:@std/assert@1";
import { parseGraphParams, buildGraph } from "./graph.ts";

Deno.test("depth is clamped and slug normalised", () => {
  assertEquals(parseGraphParams("/notes/x/", undefined).slug, "notes/x");
  assertEquals(parseGraphParams("a", undefined).depth, 2);
  assertEquals(parseGraphParams("a", "1").depth, 1);
  assertEquals(parseGraphParams("a", "99").depth, 5);   // MAX
  assertEquals(parseGraphParams("a", "0").depth, 2);    // non-positive -> default
  assertEquals(parseGraphParams("a", "abc").depth, 2);
  assertEquals(parseGraphParams("", undefined).valid, false);
  assertEquals(parseGraphParams(undefined, undefined).valid, false);
});

Deno.test("buildGraph keeps only edges with BOTH endpoints present", () => {
  const g = buildGraph([
    { slug: "a", title: "A", tags: [], links: ["b", "missing"] },
    { slug: "b", title: "", tags: null, links: ["a"] },
  ], "a");
  assertEquals(g.nodes.length, 2);
  // a dangling edge would draw a node the client has no data for
  assertEquals(g.links.length, 2);
  assertEquals(g.links.some((l) => l.target === "missing"), false);
  assertEquals(g.nodes.find((n) => n.slug === "a")?.isRoot, true);
  assertEquals(g.nodes.find((n) => n.slug === "b")?.title, "b"); // title fallback
});

Deno.test("buildGraph dedupes repeated edges and tolerates junk", () => {
  const g = buildGraph([
    { slug: "a", title: "A", tags: [], links: ["b", "b", 42 as unknown as string] },
    { slug: "b", title: "B", tags: [], links: null },
  ], "a");
  assertEquals(g.links.length, 1);
});
