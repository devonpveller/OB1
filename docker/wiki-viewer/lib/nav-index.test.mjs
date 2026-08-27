// node --test lib/ — Phase C gate.
import test from "node:test";
import assert from "node:assert/strict";
import { rowsToIndex } from "./nav-index.mjs";

test("rowsToIndex matches the published graphIndex projection", () => {
  const idx = rowsToIndex([
    { slug: "content/person/person-ada", title: "Ada", links: ["notes/x"], tags: ["wiki"], updated_at: "2026-08-26T00:00:00Z" },
    { slug: "notes/y", title: null, links: null, tags: null },
  ]);
  const a = idx["content/person/person-ada"];
  // slug INSIDE the value: FileTrieNode.add does file.slug.split("/") and the
  // Explorer crashed on every page load when it was omitted (2026-08-24).
  assert.equal(a.slug, "content/person/person-ada");
  assert.equal(a.filePath, "content/person/person-ada.md");
  assert.deepEqual(a.links, ["notes/x"]);
  assert.equal(a.date, "2026-08-26T00:00:00Z");
  // Defensive defaults so a null column can never break the client.
  const b = idx["notes/y"];
  assert.equal(b.title, "y");
  assert.deepEqual(b.links, []);
  assert.deepEqual(b.tags, []);
  assert.ok(!("date" in b));
});

test("rowsToIndex ignores junk rows without throwing", () => {
  assert.deepEqual(rowsToIndex([null, {}, { slug: "" }]), {});
  assert.deepEqual(rowsToIndex(null), {});
});
