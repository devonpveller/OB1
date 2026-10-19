// deno test — pure gates for the graph endpoint (no DB needed).
import { assertEquals } from "jsr:@std/assert@1";
import { parseGraphParams, buildGraph } from "./graph.ts";

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

Deno.test("parseGraphParams: limit clamps to [1, 800], defaults 400", () => {
  assertEquals(parseGraphParams("a", "1").limit, 400);
  assertEquals(parseGraphParams("a", "1", "800").limit, 800);
  assertEquals(parseGraphParams("a", "1", "9999").limit, 800);
  assertEquals(parseGraphParams("a", "1", "0").limit, 400);
  assertEquals(parseGraphParams("a", "1", "junk").limit, 400);
  assertEquals(parseGraphParams("a", "1", "250.9").limit, 250);
});
