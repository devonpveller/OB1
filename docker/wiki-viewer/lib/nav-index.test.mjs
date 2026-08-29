// node --test lib/ — Phase C gate + PLAN-VIEWER-PERF V5 gate.
import test from "node:test";
import assert from "node:assert/strict";
import {
  rowsToIndex,
  pageUrl,
  etagFor,
  fetchAllRows,
  getNavIndex,
  _resetForTests,
  _pendingRefresh,
} from "./nav-index.mjs";

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

// ── V5: keyset pagination ───────────────────────────────────────────────────

test("pageUrl uses a keyset cursor, never OFFSET", () => {
  const first = pageUrl(null);
  assert.ok(!first.includes("offset"), "first page must not use OFFSET");
  assert.ok(!first.includes("slug=gt."), "first page has no cursor");
  assert.ok(first.includes("order=slug.asc"), "cursor requires a total order on the key");

  const next = pageUrl("content/tool/tool-a b&c");
  assert.ok(!next.includes("offset"), "OFFSET re-walks skipped rows: 46ms@0 -> 289ms@25k");
  // A slug can contain characters that are syntax in a query string.
  assert.ok(next.includes("slug=gt.content%2Ftool%2Ftool-a%20b%26c"), next);
});

test("fetchAllRows walks pages by cursor and stops on a short page", async () => {
  const seen = [];
  const page = (n, size) =>
    Array.from({ length: size }, (_, i) => ({ slug: `s${String(n * 5000 + i).padStart(6, "0")}` }));
  const fetchImpl = async (url) => {
    seen.push(url);
    const body = seen.length === 1 ? page(0, 5000) : seen.length === 2 ? page(1, 5000) : page(2, 7);
    return { ok: true, json: async () => body };
  };
  const rows = await fetchAllRows(undefined, fetchImpl);
  assert.equal(rows.length, 10_007);
  assert.equal(seen.length, 3, "must stop on the short page, not fetch an empty one");
  // Page 2 must resume AFTER the last slug of page 1 — this is the invariant
  // that keeps a keyset walk from skipping or repeating rows.
  assert.ok(seen[1].includes("slug=gt.s004999"), seen[1]);
  assert.ok(seen[2].includes("slug=gt.s009999"), seen[2]);
});

test("fetchAllRows propagates a non-ok response instead of truncating the nav", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => [] });
  await assert.rejects(() => fetchAllRows(undefined, fetchImpl), /wiki_pages 503/);
});

// ── V5: stable ETag ─────────────────────────────────────────────────────────

test("etagFor is stable for identical payloads and changes when bytes change", () => {
  const a = JSON.stringify({ x: 1 });
  assert.equal(etagFor(a), etagFor(JSON.stringify({ x: 1 })));
  assert.notEqual(etagFor(a), etagFor(JSON.stringify({ x: 2 })));
  assert.match(etagFor(a), /^W\/"nav-[0-9a-f]{16}"$/);
});

// ── V5: stale-while-revalidate ──────────────────────────────────────────────

function fakeRows(n, marker) {
  return Array.from({ length: n }, (_, i) => ({ slug: `p/${i}`, title: `${marker}${i}` }));
}

test("getNavIndex: cold blocks once, then NEVER blocks again", async () => {
  _resetForTests();
  let calls = 0;
  let marker = "a";
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => fakeRows(200, marker) };
  };
  let clock = 1_000;
  const now = () => clock;

  const cold = await getNavIndex({ fetchImpl, now, ttlMs: 1000 });
  assert.equal(calls, 1, "cold cache must build");
  assert.ok(cold.json.includes("a0"));

  // Warm, inside TTL/2: served from cache, no refetch.
  clock += 100;
  const warm = await getNavIndex({ fetchImpl, now, ttlMs: 1000 });
  assert.equal(calls, 1, "must not refetch while fresh");
  assert.equal(warm.etag, cold.etag);

  // Past TTL/2: the reader is served the OLD copy immediately and a refresh
  // starts in the background. This is the 3.4s stall the plan removes.
  clock += 500;
  marker = "b";
  const stale = await getNavIndex({ fetchImpl, now, ttlMs: 1000 });
  assert.equal(stale.etag, cold.etag, "stale copy served without waiting");
  assert.ok(stale.json.includes("a0"), "still the previous payload");
  assert.equal(calls, 2, "refresh was kicked off");

  await _pendingRefresh();
  const next = await getNavIndex({ fetchImpl, now, ttlMs: 1000 });
  assert.ok(next.json.includes("b0"), "background refresh landed");
  assert.notEqual(next.etag, cold.etag, "new bytes -> new ETag");
});

test("getNavIndex: concurrent stale reads trigger ONE refresh (single-flight)", async () => {
  _resetForTests();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return { ok: true, json: async () => fakeRows(200, "x") };
  };
  let clock = 1_000;
  const now = () => clock;
  await getNavIndex({ fetchImpl, now, ttlMs: 1000 });
  assert.equal(calls, 1);

  clock += 10_000;
  await Promise.all([
    getNavIndex({ fetchImpl, now, ttlMs: 1000 }),
    getNavIndex({ fetchImpl, now, ttlMs: 1000 }),
    getNavIndex({ fetchImpl, now, ttlMs: 1000 }),
  ]);
  await _pendingRefresh();
  assert.equal(calls, 2, "three stale readers must not stampede the database");
});

test("getNavIndex: a failing refresh keeps serving the last good copy", async () => {
  _resetForTests();
  let fail = false;
  const fetchImpl = async () => {
    if (fail) throw new Error("db down");
    return { ok: true, json: async () => fakeRows(200, "good") };
  };
  let clock = 1_000;
  const now = () => clock;
  const good = await getNavIndex({ fetchImpl, now, ttlMs: 1000 });

  fail = true;
  clock += 10_000;
  const during = await getNavIndex({ fetchImpl, now, ttlMs: 1000 });
  await _pendingRefresh();
  const after = await getNavIndex({ fetchImpl, now, ttlMs: 1000 });
  assert.equal(during.etag, good.etag);
  assert.equal(after.etag, good.etag, "a failed refresh must never empty the nav");
});

test("getNavIndex: a truncated read below MIN_ROWS is rejected, not published", async () => {
  _resetForTests();
  const fetchImpl = async () => ({ ok: true, json: async () => fakeRows(3, "tiny") });
  const res = await getNavIndex({ fetchImpl, now: () => 1000, ttlMs: 1000 });
  assert.equal(res, null, "3 rows is a broken read, not a 48k-page wiki");
});
