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
  _tickForTests,
  indexChunks,
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

// P1b: a refresh first asks for the table's signature (one cheap request);
// these fakes answer it WITHOUT a content-range header (no signature), so
// every refresh walks - the pre-P1b behaviour the V5 tests pin. `calls`
// counts refreshes started (signature requests); `walks` counts row walks.
// (fix round 1: the delta read is also ordered by updated_at; it is told apart)
const SIG = (url) => String(url).includes("order=updated_at.desc");
const DELTA = (url) => String(url).includes("updated_at=gte.");
const indexJson = (c) => [...indexChunks(c)].join("");
const noSig = { ok: true, headers: { get: () => null }, json: async () => [] };

test("getNavIndex: cold blocks once, then NEVER blocks again", async () => {
  _resetForTests();
  let calls = 0;
  let marker = "a";
  const fetchImpl = async (url) => {
    if (SIG(url)) { calls += 1; return noSig; }
    return { ok: true, json: async () => fakeRows(200, marker) };
  };
  let clock = 1_000;
  const now = () => clock;

  const cold = await getNavIndex({ fetchImpl, now, ttlMs: 1000 });
  assert.equal(calls, 1, "cold cache must build");
  assert.ok(indexJson(cold).includes("a0"));

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
  assert.ok(indexJson(stale).includes("a0"), "still the previous payload");
  assert.equal(calls, 2, "refresh was kicked off");

  await _pendingRefresh();
  const next = await getNavIndex({ fetchImpl, now, ttlMs: 1000 });
  assert.ok(indexJson(next).includes("b0"), "background refresh landed");
  assert.notEqual(next.etag, cold.etag, "new bytes -> new ETag");
});

test("getNavIndex: concurrent stale reads trigger ONE refresh (single-flight)", async () => {
  _resetForTests();
  let calls = 0;
  const fetchImpl = async (url) => {
    if (SIG(url)) calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return SIG(url) ? noSig : { ok: true, json: async () => fakeRows(200, "x") };
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

test("getNavIndex (P1b): an unchanged table signature refreshes WITHOUT walking the rows; a changed one walks", async () => {
  _resetForTests();
  let walks = 0;
  let sig = "200|2026-10-19T00:00:00Z";
  let marker = "a";
  const fetchImpl = async (url) => {
    if (SIG(url)) {
      const [count, at] = sig.split("|");
      return { ok: true, headers: { get: (h) => (h === "content-range" ? `0-0/${count}` : null) }, json: async () => [{ updated_at: at }] };
    }
    if (DELTA(url)) return { ok: false, json: async () => [] }; // a delta that cannot be read: the walk
    walks += 1;
    return { ok: true, json: async () => fakeRows(200, marker) };
  };
  let clock = 1_000;
  const now = () => clock;
  const cold = await getNavIndex({ fetchImpl, now, ttlMs: 1000 });
  assert.equal(walks, 1);
  assert.ok(cold.site && cold.site.bySlug.has("p/0"), "the site index is built in the refresh, not on a request");
  clock += 600;
  await getNavIndex({ fetchImpl, now, ttlMs: 1000 });
  await _pendingRefresh();
  assert.equal(walks, 1, "same signature: no walk");
  const same = await getNavIndex({ fetchImpl, now, ttlMs: 1000 });
  assert.equal(same, cold, "the same snapshot (and site index) is kept");
  clock += 600;
  sig = "200|2026-10-19T00:00:05Z";
  marker = "b";
  await getNavIndex({ fetchImpl, now, ttlMs: 1000 });
  await _pendingRefresh();
  assert.equal(walks, 2, "a row was written: walk");
  const next = await getNavIndex({ fetchImpl, now, ttlMs: 1000 });
  assert.ok(indexJson(next).includes("b0"));
  assert.notEqual(next.site, cold.site);
});

// ── rw-p1b-ready fix round 1 (tester attempt 1, defect 3) ────────────────────
// The stated bound: a listing follows a write within WIKI_NAV_TTL_MS, with no
// first-reader penalty after a quiet period. Before: a refresh started only
// when a request arrived, and that request got the old snapshot (and its
// old ETag). Now a background tick (every TTL/4) checks the signature and
// applies the rows written since the snapshot in place (applySiteDelta), so
// after a quiet period the FIRST read is already fresh.
function sigFake(state) {
  // state: { rows: [...], sig: "count|max", walks, deltas }
  return async (url) => {
    const u = String(url);
    if (u.includes("order=updated_at.desc")) {
      const [count, at] = state.sig.split("|");
      return { ok: true, headers: { get: (h) => (h === "content-range" ? `0-0/${count}` : null) }, json: async () => [{ updated_at: at }] };
    }
    if (u.includes("updated_at=gte.")) {
      state.deltas += 1;
      const from = decodeURIComponent(/updated_at=gte\.([^&]+)/.exec(u)[1]);
      return { ok: true, json: async () => state.rows.filter((r) => r.updated_at >= from).sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1)) };
    }
    state.walks += 1;
    return { ok: true, json: async () => state.rows.slice() };
  };
}
const T0 = "2026-10-20T00:00:00.000Z";
function baseRows() {
  const rows = [];
  for (let i = 0; i < 150; i++) rows.push({ slug: `content/tool/tool-${i}`, title: `Tool ${i}`, tags: ["kitt"], links: [], updated_at: T0 });
  rows.push({ slug: "notes/adv3/old-note", title: "Old note", tags: [], links: [], updated_at: T0 });
  return rows;
}

test("defect 3: after a quiet period of 4x the TTL the FIRST read sees a write (no first-reader penalty, no request needed)", async () => {
  _resetForTests();
  const state = { rows: baseRows(), sig: `151|${T0}`, walks: 0, deltas: 0 };
  const fetchImpl = sigFake(state);
  let clock = 1_000_000;
  const now = () => clock;
  const ttl = 30_000;
  await getNavIndex({ fetchImpl, now, ttlMs: ttl });
  assert.equal(state.walks, 1);
  // a write: a new page in an existing folder with a NEW tag, and a retag of an existing one
  const at = "2026-10-20T00:00:10.000Z";
  state.rows.push({ slug: "notes/adv3/fresh-note", title: "Fresh", tags: ["fresh-one"], links: ["content/tool/tool-1"], updated_at: at });
  state.rows[2] = { ...state.rows[2], tags: ["kitt", "fresh-one"], updated_at: at };
  state.sig = `152|${at}`;
  // quiet: no request at all for 4x the TTL, only the background ticks run
  for (let t = 0; t < 4 * ttl; t += ttl / 4) { clock += ttl / 4; await _tickForTests({ fetchImpl, now }); }
  const t1 = state.walks;
  const first = await getNavIndex({ fetchImpl, now, ttlMs: ttl });
  assert.ok(now() - first.at <= ttl, "the snapshot served is within the bound");
  assert.deepEqual(first.site.byTag.get("fresh-one"), ["content/tool/tool-2", "notes/adv3/fresh-note"], "the FIRST read after the quiet period lists both");
  assert.ok(first.site.folders.get("notes/adv3").files.has("notes/adv3/fresh-note"), "the folder lists the new page");
  assert.equal(state.walks, t1, "the first read did not start (or wait for) a walk");
  assert.ok(state.deltas >= 1, "the write arrived as a delta");
  await _pendingRefresh();
});

test("defect 3: a snapshot older than the TTL is never served while the database answers (the read waits for the tick)", async () => {
  _resetForTests();
  const state = { rows: baseRows(), sig: `151|${T0}`, walks: 0, deltas: 0 };
  const fetchImpl = sigFake(state);
  let clock = 1_000_000;
  const now = () => clock;
  await getNavIndex({ fetchImpl, now, ttlMs: 30_000 });
  const at = "2026-10-20T00:00:20.000Z";
  state.rows.push({ slug: "content/tool/tool-new", title: "Tool new", tags: ["kitt"], links: [], updated_at: at });
  state.sig = `152|${at}`;
  clock += 120_000; // no tick ran (a stalled timer): the read itself must not get the old listing
  const nav = await getNavIndex({ fetchImpl, now, ttlMs: 30_000 });
  assert.ok(nav.site.byTag.get("kitt").includes("content/tool/tool-new"));
  assert.ok(now() - nav.at <= 30_000);
  await _pendingRefresh();
});

test("defect 3: the ETag of the served snapshot changes with a delta (a revalidating reader never gets 304 for the old listing)", async () => {
  _resetForTests();
  const state = { rows: baseRows(), sig: `151|${T0}`, walks: 0, deltas: 0 };
  const fetchImpl = sigFake(state);
  let clock = 1_000_000;
  const now = () => clock;
  const a = await getNavIndex({ fetchImpl, now, ttlMs: 30_000 });
  const e1 = a.etag;
  const at = "2026-10-20T00:00:30.000Z";
  state.rows[5] = { ...state.rows[5], title: "Retitled", updated_at: at };
  state.sig = `151|${at}`;
  clock += 10_000; await _tickForTests({ fetchImpl, now });
  const b = await getNavIndex({ fetchImpl, now, ttlMs: 30_000 });
  assert.equal(b.site.bySlug.get("content/tool/tool-5").title, "Retitled");
  assert.notEqual(b.etag, e1);
  await _pendingRefresh();
});

test("defect 3: a deletion is not applied as a delta: the full rebuild runs (and is equal to a fresh build)", async () => {
  _resetForTests();
  const state = { rows: baseRows(), sig: `151|${T0}`, walks: 0, deltas: 0 };
  const fetchImpl = sigFake(state);
  let clock = 1_000_000;
  const now = () => clock;
  await getNavIndex({ fetchImpl, now, ttlMs: 30_000 });
  state.rows.splice(3, 1);
  state.sig = `150|${T0}`;
  clock += 10_000; await _tickForTests({ fetchImpl, now }); await _pendingRefresh();
  assert.equal(state.walks, 2);
  const c = await getNavIndex({ fetchImpl, now, ttlMs: 30_000 });
  assert.ok(!c.site.bySlug.has("content/tool/tool-3"));
});

test("defect 1: the graphIndex payload is produced in slices (indexChunks), never as one whole-vault string on a request", async () => {
  _resetForTests();
  const state = { rows: baseRows(), sig: `151|${T0}`, walks: 0, deltas: 0 };
  const c = await getNavIndex({ fetchImpl: sigFake(state), now: () => 1, ttlMs: 30_000 });
  assert.equal(c.json, undefined, "no whole-vault JSON string on the snapshot");
  const parts = [...indexChunks(c, 40)];
  assert.ok(parts.length >= 4, "sliced");
  assert.deepEqual(JSON.parse(parts.join("")), rowsToIndex(state.rows));
});

test("defect 3: applySiteDelta leaves the listings equal to a fresh build of the new rows (folders, tags, backlinks, titles)", async () => {
  const { buildSiteIndex, applySiteDelta } = await import("./site-index.mjs");
  const rows = baseRows();
  rows.push({ slug: "content/tool/linker", title: "Linker", tags: ["a/b"], links: ["tool-1", "tool-2"], updated_at: T0 });
  const site = buildSiteIndex(rows, "s1");
  const at = "2026-10-20T00:01:00.000Z";
  const next = rows.map((r) => ({ ...r }));
  next.push({ slug: "notes/adv3/brand-new", title: "Brand new", tags: ["a/c", "kitt"], links: ["tool-3"], updated_at: at });
  next[7] = { ...next[7], title: "Seven retitled", tags: ["a/b"], updated_at: at };
  next[next.length - 2] = { ...next[next.length - 2], links: ["tool-4"], updated_at: at }; // the linker relinks
  const res = applySiteDelta(site, next.filter((r) => r.updated_at === at), 1);
  assert.equal(res.ok, true);
  assert.equal(res.needsRebuild, true);
  const fresh = buildSiteIndex(next, "s2");
  const norm = (m) => JSON.stringify([...m.entries()].sort().map(([k, v]) => [k, v instanceof Set ? [...v] : v]));
  assert.equal(norm(site.byTag), norm(fresh.byTag), "tag listings");
  assert.equal(JSON.stringify([...site.folders.entries()].sort().map(([k, v]) => [k, [...v.files], [...v.folders]])),
    JSON.stringify([...fresh.folders.entries()].sort().map(([k, v]) => [k, [...v.files], [...v.folders]])), "folder listings");
  assert.equal(norm(site.backlinks), norm(fresh.backlinks), "backlinks (no other page links to the new one here)");
  assert.deepEqual(site.slugs, fresh.slugs);
  for (const [k, v] of fresh.bySlug) assert.equal(site.bySlug.get(k)?.title, v.title, k);
  // shapes a delta must refuse: a deletion, a basename that exists, a new folder
  assert.equal(applySiteDelta(buildSiteIndex(rows, "x"), [], -1).ok, false);
  assert.equal(applySiteDelta(buildSiteIndex(rows, "x"), [{ slug: "notes/adv3/tool-1", title: "dup base", updated_at: at }], 1).ok, false);
  assert.equal(applySiteDelta(buildSiteIndex(rows, "x"), [{ slug: "brand/new-folder/p", title: "p", updated_at: at }], 1).ok, false);
});

test("defect 3: a delta also reaches the graphIndex payload (rows), not only the listings", async () => {
  _resetForTests();
  const state = { rows: baseRows(), sig: `151|${T0}`, walks: 0, deltas: 0 };
  const fetchImpl = sigFake(state);
  let clock = 1_000_000;
  const now = () => clock;
  await getNavIndex({ fetchImpl, now, ttlMs: 30_000 });
  const at = "2026-10-20T00:02:00.000Z";
  state.rows[9] = { ...state.rows[9], title: "Nine retitled", updated_at: at };
  state.sig = `151|${at}`;
  clock += 10_000; await _tickForTests({ fetchImpl, now });
  const c = await getNavIndex({ fetchImpl, now, ttlMs: 30_000 });
  assert.deepEqual(JSON.parse(indexJson(c)), rowsToIndex(state.rows));
  await _pendingRefresh();
});
