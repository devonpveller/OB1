/** filtering.test.ts — domain credibility ranking + the relevance gate. */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { scoreDomain, rankHits, isRelevant, partitionRelevant } from "./filtering.ts";
import type { Deps, Page, SearchHit } from "./harness.ts";

function fakeDeps(chatImpl: (sys: string, user: string) => Promise<string>): Deps {
  return { chat: chatImpl } as unknown as Deps;
}
const page = (url: string, content = "x".repeat(100)): Page =>
  ({ url, title: url, content, domain: new URL(url).hostname });

Deno.test("scoreDomain: tiers", () => {
  assertEquals(scoreDomain("https://arxiv.org/abs/1234"), 3);
  assertEquals(scoreDomain("https://cs.stanford.edu/paper"), 3);
  assertEquals(scoreDomain("https://www.nist.gov/x"), 3);
  assertEquals(scoreDomain("https://en.wikipedia.org/wiki/API"), 2);
  assertEquals(scoreDomain("https://docs.stripe.com/api"), 2);
  assertEquals(scoreDomain("https://github.com/anthropics/skills"), 1);
  assertEquals(scoreDomain("https://someproject.org/about"), 1);
  assertEquals(scoreDomain("https://vendor-blog.com/post"), 0);
  assertEquals(scoreDomain("https://www.lowes.com/pl/tools"), -3);
  assertEquals(scoreDomain("https://www.amazon.com/dp/B00X"), -3);
  assertEquals(scoreDomain("not a url"), 0);
});

Deno.test("rankHits: credible first, retail last, stable within tiers", () => {
  const hits: SearchHit[] = [
    { url: "https://www.lowes.com/tools", title: "a", snippet: "" },
    { url: "https://vendorA.com/x", title: "b", snippet: "" },
    { url: "https://arxiv.org/abs/1", title: "c", snippet: "" },
    { url: "https://vendorB.com/y", title: "d", snippet: "" },
    { url: "https://mit.edu/paper", title: "e", snippet: "" },
  ];
  const ranked = rankHits(hits).map((h) => h.url);
  assertEquals(ranked[0], "https://arxiv.org/abs/1");
  assertEquals(ranked[1], "https://mit.edu/paper");
  // engine order preserved within the 0-tier
  assertEquals(ranked[2], "https://vendorA.com/x");
  assertEquals(ranked[3], "https://vendorB.com/y");
  assertEquals(ranked[4], "https://www.lowes.com/tools");
});

Deno.test("isRelevant: confident IRRELEVANT drops; RELEVANT keeps", async () => {
  const yes = await isRelevant(fakeDeps(() => Promise.resolve("RELEVANT")), page("https://a.com"), "q");
  assert(yes);
  const no = await isRelevant(fakeDeps(() => Promise.resolve("IRRELEVANT")), page("https://b.com"), "q");
  assert(!no);
});

Deno.test("isRelevant: fails OPEN on chat error and on tiny content", async () => {
  const err = await isRelevant(fakeDeps(() => Promise.reject(new Error("down"))), page("https://a.com"), "q");
  assert(err, "chat failure must not drop a source");
  const tiny = await isRelevant(fakeDeps(() => Promise.resolve("IRRELEVANT")), page("https://a.com", "hi"), "q");
  assert(tiny, "near-empty content is not judged here");
});

Deno.test("partitionRelevant: splits by verdict, preserves order", async () => {
  const deps = fakeDeps((_sys, user) =>
    Promise.resolve(user.includes("lowes.com") ? "IRRELEVANT" : "RELEVANT"));
  const pages = [page("https://arxiv.org/a"), page("https://www.lowes.com/t"), page("https://b.org/c")];
  const { relevant, rejected } = await partitionRelevant(deps, pages, "SaaS api tools");
  assertEquals(relevant.map((p) => p.url), ["https://arxiv.org/a", "https://b.org/c"]);
  assertEquals(rejected.map((r) => r.url), ["https://www.lowes.com/t"]);
});
