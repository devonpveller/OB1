// node --test lib/  (runs at image build — the Dockerfile gates on it, so
// a planner/sweep consistency regression cannot ship).
import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeLinkCounts,
  entitySlug,
  keptEntityPages,
  planEntityQueue,
  backfillSlice,
} from "./entity-links.mjs";

const slugify = (name, type) => `${type}-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

// Fixture: the shapes the live tables produce.
const entities = [
  { id: 1, canonical_name: "San Francisco", entity_type: "place", metadata: { wiki_slug: "place-san-francisco" }, updated_at: "2026-08-25T06:00:00Z" },
  { id: 2, canonical_name: "Nancy Kissinger", entity_type: "person", metadata: {}, updated_at: "2026-08-24T05:24:58Z" }, // zero-link
  { id: 3, canonical_name: "Cicero Institute", entity_type: "organization", metadata: null, updated_at: "2026-08-24T05:24:57Z" }, // zero-link
  { id: 4, canonical_name: "Old Topic", entity_type: "topic", metadata: {}, updated_at: "2026-08-23T00:00:00Z" }, // retired type
  { id: 5, canonical_name: "Built Page", entity_type: "tool", metadata: {}, updated_at: "2026-08-20T00:00:00Z" }, // linked + on disk
  { id: 6, canonical_name: "Linked Backlog", entity_type: "person", metadata: {}, updated_at: "2026-08-10T00:00:00Z" }, // linked, missing
  { id: 7, canonical_name: "", entity_type: "person", metadata: {}, updated_at: "2026-08-09T00:00:00Z" }, // nameless
];
const thoughtRows = [{ entity_id: 1 }, { entity_id: 5 }, { entity_id: 6 }];
const sourceRows = [{ entity_id: 1 }, { entity_id: 1 }, { entity_id: 6 }];
const counts = mergeLinkCounts(thoughtRows, sourceRows);
const onDisk = new Set(["tool/tool-built-page.md"]);
const pageExists = (rel) => onDisk.has(rel);

test("mergeLinkCounts sums both junction tables", () => {
  assert.equal(counts.get(1), 3);
  assert.equal(counts.get(6), 2);
  assert.equal(counts.get(2), undefined);
  assert.deepEqual(mergeLinkCounts([], undefined), new Map());
});

test("entitySlug prefers a non-empty metadata.wiki_slug", () => {
  assert.equal(entitySlug(entities[0], slugify), "place-san-francisco");
  assert.equal(entitySlug(entities[1], slugify), "person-nancy-kissinger");
  assert.equal(entitySlug({ canonical_name: "X", entity_type: "t", metadata: { wiki_slug: "  " } }, slugify), "t-x");
});

test("keptEntityPages keeps only entities meeting the threshold", () => {
  const kept = keptEntityPages(entities, counts, 1, slugify);
  assert.ok(kept.has("place/place-san-francisco.md"));
  assert.ok(kept.has("tool/tool-built-page.md"));
  assert.ok(kept.has("person/person-linked-backlog.md"));
  assert.ok(!kept.has("person/person-nancy-kissinger.md"));
  assert.ok(!kept.has("organization/organization-cicero-institute.md"));
});

test("planEntityQueue splits linked vs unlinked and skips built/retired/nameless", () => {
  const { planned, linkedQueued, unlinkedQueued } = planEntityQueue({
    entities, counts, minLinked: 1, retiredTypes: new Set(["topic"]), slugifyEntity: slugify, pageExists,
  });
  // On-disk page, retired type and nameless entity are absent entirely.
  assert.equal(planned["content/tool/tool-built-page"], undefined);
  assert.equal(planned["content/topic/topic-old-topic"], undefined);
  assert.equal(Object.values(planned).some((p) => p.id === 7), false);
  // Linked-but-missing is queued WITHOUT the flag; zero-link carries it.
  assert.equal(planned["content/person/person-linked-backlog"].unlinked, undefined);
  assert.equal(planned["content/person/person-nancy-kissinger"].unlinked, true);
  assert.equal(planned["content/organization/organization-cicero-institute"].unlinked, true);
  assert.equal(linkedQueued, 2); // san-francisco + linked-backlog
  assert.equal(unlinkedQueued, 2);
});

test("backfillSlice orders by recency, honors limit, skips unlinked + bad ids", () => {
  const { planned } = planEntityQueue({
    entities, counts, minLinked: 1, retiredTypes: new Set(["topic"]), slugifyEntity: slugify, pageExists,
  });
  planned["content/junk/junk"] = { id: "not-a-number", updated_at: "2026-08-26T00:00:00Z" };
  assert.deepEqual(backfillSlice(planned, 10), [1, 6]); // SF (newest) then backlog; zero-links excluded
  assert.deepEqual(backfillSlice(planned, 1), [1]);
  // Pre-fix manifests carry no flags: entries stay eligible (documented transitional churn).
  assert.deepEqual(backfillSlice({ a: { id: 9, updated_at: "" } }, 5), [9]);
});

test("INVARIANT: every backfill-eligible planned page is in the sweep kept-set", () => {
  const { planned } = planEntityQueue({
    entities, counts, minLinked: 1, retiredTypes: new Set(["topic"]), slugifyEntity: slugify,
    pageExists: () => false, // worst case: nothing on disk, everything queued
  });
  const kept = keptEntityPages(entities, counts, 1, slugify);
  for (const [key, p] of Object.entries(planned)) {
    if (p.unlinked) continue;
    const rel = `${key.replace(/^content\//, "")}.md`;
    assert.ok(kept.has(rel), `backfill-eligible ${key} would be deleted by the sweep`);
  }
});
