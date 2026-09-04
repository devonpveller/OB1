// node --test recipes/_shared/wiki-pages.warnonce.test.mjs
// warnOnce must be once-per-KIND, not once-per-process: with a single flag,
// an upsert outage warning silenced a later parse/delete failure for the
// process lifetime (daemon = forever). The 08-28 mirror outage survived on
// stacked silence, so this file pins the degradation-visibility contract.
//
// Lives in its OWN file because the module reads OPEN_BRAIN_URL at load time:
// the env must be poisoned BEFORE import, and the sibling test file's static
// imports would already have cached the module. node --test runs each file in
// its own process, so a dynamic import here gets a fresh module instance.
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPEN_BRAIN_URL = "http://127.0.0.1:9"; // nothing listens: fetch rejects fast
process.env.WIKI_PAGES_SYNC_TIMEOUT_MS = "1000";   // module floor; keeps a stall bounded

const m = await import("./wiki-pages.mjs");

test("warnOnce fires once PER KIND, and repeats of a kind stay silent", async () => {
  const lines = [];
  const orig = console.error;
  console.error = (msg) => lines.push(String(msg));
  try {
    // Two DIFFERENT kinds must both surface...
    assert.equal(await m.upsertWikiPages({ slug: "content/x", page_class: "root" }), false);
    assert.equal(await m.deleteWikiPages(["content/x"]), false);
    // ...and a REPEAT of an already-warned kind must not add a line.
    assert.equal(await m.upsertWikiPages({ slug: "content/y", page_class: "root" }), false);
  } finally {
    console.error = orig;
  }
  const degraded = lines.filter((l) => l.includes("sync degraded"));
  assert.equal(degraded.length, 2,
    `expected one warning per kind (upsert, delete), got ${degraded.length}: ${JSON.stringify(degraded)}`);
  assert.ok(degraded[0].includes("(upsert)"), `first warning should name upsert: ${degraded[0]}`);
  assert.ok(degraded[1].includes("(delete)"), `second warning should name delete: ${degraded[1]}`);
});
