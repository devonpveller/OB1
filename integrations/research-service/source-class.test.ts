/**
 * rwr-research-sources - the community classifier (TS twin of slot 750's source_class_of), driven by the
 * registry rows the migration seeds (fixtures/credibility-registry.json, proven equal to the SQL by
 * credibility.test.ts) and the shared case table.
 * Run: deno test --allow-read source-class.test.ts
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildSourceClasses, classifySource, SourceClassError, unwrapUrl } from "./source-class.ts";
import { seedSet } from "./fixtures/credibility-seeds.ts";

const entries = buildSourceClasses(seedSet().rows);
const cases: Array<[string, string | null, string | null]> =
  JSON.parse(Deno.readTextFileSync(new URL("./fixtures/source-class-cases.json", import.meta.url))).cases;

Deno.test("the seeded class list has the five community kinds the operator confirmed", () => {
  assertEquals([...new Set(entries.map((e) => e.kind))].sort(), ["code_discussion", "forum", "qa", "self_published", "social"]);
});

for (const [url, kind, key] of cases) {
  Deno.test(`classify ${url} -> ${kind ?? "not community"}`, () => {
    const c = classifySource(entries, url);
    assertEquals(c?.kind ?? null, kind);
    assertEquals(c?.key ?? null, key);
  });
}

Deno.test("classification reads the URL only: a credible URL stays credible whatever the page says", () => {
  // the classifier takes no content at all - a forum page cannot claim to be a journal, nor a journal be called a forum
  assertEquals(classifySource.length, 3);
  assertEquals(classifySource(entries, "https://www.nature.com/articles/x"), null);
});

Deno.test("the domain is used when the URL names no host", () => {
  assertEquals(classifySource(entries, "", "www.reddit.com")?.kind, "forum");
  assertEquals(classifySource(entries, null, null), null);
});

Deno.test("wrappers unwrap to the URL they stand for", () => {
  assertEquals(unwrapUrl("https://web.archive.org/web/1/https://news.ycombinator.com/item?id=1"), "https://news.ycombinator.com/item?id=1");
  assertEquals(unwrapUrl("https://example.com/a"), "https://example.com/a");
});

Deno.test("a malformed registry row is refused loudly, never skipped", () => {
  const row = (definition: Record<string, unknown>) => [{ registry: "source_classes", key: "x", definition }];
  assertThrows(() => buildSourceClasses(row({ order: 1, kind: "blog", host_patterns: ["a"] })), SourceClassError, "kind");
  assertThrows(() => buildSourceClasses(row({ order: 1, kind: "forum", host_patterns: [] })), SourceClassError, "host_patterns");
  assertThrows(() => buildSourceClasses(row({ order: 1, kind: "forum", host_patterns: ["("] })), SourceClassError, "compile");
  assertThrows(() => buildSourceClasses(row({ order: 1.5, kind: "forum", host_patterns: ["a"] })), SourceClassError, "order");
  assert(buildSourceClasses([{ registry: "source_classes", key: "x", definition: { order: 1, kind: "forum", host_patterns: ["a"] }, retired_at: "2026-01-01" }]).length === 0);
});
