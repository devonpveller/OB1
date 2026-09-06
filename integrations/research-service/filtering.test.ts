/** filtering.test.ts — domain credibility ranking + the relevance gate. */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { scoreDomain, rankHits, isRelevant, partitionRelevant, floorKeepable } from "./filtering.ts";
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

Deno.test("isRelevant: fails OPEN on chat error", async () => {
  const err = await isRelevant(fakeDeps(() => Promise.reject(new Error("down"))), page("https://a.com"), "q");
  assert(err, "chat failure must not drop a source");
});

// FLIPPED 2026-09-05 (srcadm): the old auto-RELEVANT for tiny content is how a
// 4-char shell ("Qwen") reached grounded-claim citation. A page below
// MIN_JUDGEABLE_CHARS has nothing to judge AND nothing to cite - it fails
// CLOSED, and without spending an LLM call.
Deno.test("isRelevant: a sub-20-char shell is rejected without an LLM call", async () => {
  let chatCalls = 0;
  const deps = fakeDeps(() => { chatCalls++; return Promise.resolve("RELEVANT"); });
  const shell = await isRelevant(deps, page("https://qwen.ai/blog?id=x", "Qwen"), "qwen models");
  assert(!shell, "a contentless shell must not be admitted as evidence");
  assertEquals(chatCalls, 0, "emptiness is not a judgement - no model call");
});

// The measurement's thin-but-TRUE guard: 20 chars is a shell bar, not a length
// floor. Short real snippets are exactly the long-tail evidence this engine
// exists for, and they must still get their day in front of the model.
Deno.test("isRelevant: a thin-but-true snippet (>=20 chars) reaches the LLM verdict", async () => {
  let chatCalls = 0;
  const deps = fakeDeps(() => { chatCalls++; return Promise.resolve("RELEVANT"); });
  const kept = await isRelevant(
    deps, page("https://oakridge.gov/recycling", "Your recycling day is every Wednesday."), "oak ridge recycling schedule");
  assert(kept, "a 38-char true snippet must survive");
  assertEquals(chatCalls, 1, "and it must be the MODEL's verdict, not a bypass");
});

Deno.test("partitionRelevant: splits by verdict with reasons, preserves order, no LLM spend on shells", async () => {
  let judgedUrls: string[] = [];
  const deps = fakeDeps((_sys, user) => {
    judgedUrls.push(user.match(/URL: (\S+)/)?.[1] ?? "?");
    return Promise.resolve(user.includes("lowes.com") ? "IRRELEVANT" : "RELEVANT");
  });
  const pages = [
    page("https://arxiv.org/a"),
    page("https://www.lowes.com/t"),
    page("https://shell.example/x", "MSN"), // sub-20-char shell
    page("https://b.org/c"),
  ];
  const { relevant, rejected } = await partitionRelevant(deps, pages, "SaaS api tools");
  assertEquals(relevant.map((p) => p.url), ["https://arxiv.org/a", "https://b.org/c"]);
  assertEquals(rejected.map((r) => [r.url, r.reason]), [
    ["https://www.lowes.com/t", "irrelevant"],
    ["https://shell.example/x", "no_content"],
  ]);
  assert(!judgedUrls.includes("https://shell.example/x"), "shells never reach the model");
});

// The fail-safe floor asymmetry: the floor exists to second-guess a
// possibly-wrong model verdict, and emptiness is not a verdict. LLM-rejected
// pages stay floor-keepable; shells never are.
Deno.test("floorKeepable: keeps LLM-rejected pages, never shells; all-shells pool stays empty", () => {
  const llmRejected = page("https://maybe-wrong-verdict.org/a"); // 100 chars of content
  const shell = page("https://shell.example/x", "Qwen");
  assertEquals(floorKeepable([llmRejected, shell]).map((p) => p.url), ["https://maybe-wrong-verdict.org/a"]);
  assertEquals(floorKeepable([shell, page("https://s2.example/y", "hi")]), [],
    "a pool of contentless shells must not survive to staging under the floor");
});
