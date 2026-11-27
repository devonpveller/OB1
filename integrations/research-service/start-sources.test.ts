/**
 * rwr-research-sources - the start door carries `run.sources` (credible | community) into the job, a gap branch inherits
 * it, and the door refuses `community` when the admin switch is off. A credible-only start whose public links are
 * community pages is refused with a reason (operator 2026-11-27, Q7). The DB allow-list twin is slot 750
 * (start-sources.e2e.test.ts in the lab).
 * Run: deno test --allow-read --allow-env start-sources.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseRun, runOptions } from "./boundary.ts";
import { inheritOptions } from "./tree.ts";
import { COMMUNITY_LINK_REFUSAL, COMMUNITY_OFF, communityLinks, previewBody, sourcesRefusal } from "./start.ts";

const ceilings = { rounds: 3, max_fetch: 24, wall_ms: 180_000 };

Deno.test("run.sources is credible or community; anything else is refused", () => {
  assertEquals(parseRun({ sources: "credible" }), { run: { sources: "credible" } });
  assertEquals(parseRun({ sources: "community" }), { run: { sources: "community" } });
  for (const bad of ["Community", "all", 1, true, null]) {
    assert("error" in parseRun({ sources: bad }), `refused ${JSON.stringify(bad)}`);
  }
});

Deno.test("the mode rides in the job's options; absent = no key (every other inlet unchanged)", () => {
  assertEquals(runOptions({ sources: "community", depth: "quick" }, ceilings).sources, "community");
  assertEquals("sources" in runOptions({}, ceilings), false);
});

Deno.test("a gap branch inherits the parent's mode", () => {
  assertEquals(inheritOptions({ sources: "credible", queue_origin: "manual" }, null).sources, "credible");
});

Deno.test("the preview says which mode the run will use", () => {
  const v = { ok: true, request: { question: "q", topic: "t", links: [] } } as unknown as Parameters<typeof previewBody>[0];
  assertEquals(previewBody(v, { sources: "community" }, ceilings).sources, "community");
  assertEquals(previewBody(v, {}, ceilings).sources, null);
});

Deno.test("the admin switch off refuses community, never credible; on refuses nothing", () => {
  assertEquals(sourcesRefusal({ sources: "community" }, false), COMMUNITY_OFF);
  assertEquals(sourcesRefusal({ sources: "credible" }, false), null);
  assertEquals(sourcesRefusal({}, false), null);
  assertEquals(sourcesRefusal({ sources: "community" }, true), null);
  assert(/admin/.test(COMMUNITY_OFF), "a plain reason");
});

Deno.test("a credible-only start refuses community public links; a community start keeps them", () => {
  const isC = (u: string) => u.includes("reddit.com");
  assertEquals(communityLinks({ sources: "credible" }, ["https://www.reddit.com/r/a/", "https://energy.gov/x"], isC), ["https://www.reddit.com/r/a/"]);
  assertEquals(communityLinks({ sources: "community" }, ["https://www.reddit.com/r/a/"], isC), []);
  assertEquals(communityLinks({}, ["https://www.reddit.com/r/a/"], isC), []);
  assert(COMMUNITY_LINK_REFUSAL.length > 0);
});
