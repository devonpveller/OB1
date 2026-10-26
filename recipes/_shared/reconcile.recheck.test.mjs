// node --test recipes/_shared/reconcile.recheck.test.mjs
// rw-p1b-ready round 3 (operator 2026-10-26, option 1): a page CREATED inside a reconcile pass has its file before
// its row for one row write (10-27 ms measured), so the pass can see the file and not the row. The reconcile re-reads
// every slug it finds `missing` ONCE, after a short delay (default 250 ms, capped at 270 ms = 10 x the measured
// window), before counting it. A page still missing on the re-read counts; the zero-drift bar is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { diffFilesRows, recheckMissing, RECHECK_MAX_MS } from "./reconcile-wiki-pages.mjs";

const cls = () => "entity";
const T = "2026-10-26T12:00:00.000Z";
const files = () => new Map([
  ["content/person/old", { rel: "content/person/old.md", mtimeMs: Date.parse(T) - 60_000 }],
  ["content/person/created-in-pass", { rel: "content/person/created-in-pass.md", mtimeMs: Date.parse(T) }],
  ["content/person/really-missing", { rel: "content/person/really-missing.md", mtimeMs: Date.parse(T) - 60_000 }],
]);
const rowsAtPass = () => new Map([["content/person/old", { slug: "content/person/old", page_class: "entity", updated_at: T, empty: false }]]);
// the database AFTER the pass: the created page's row has landed; the really-missing one never will
const dbAfter = [{ slug: "content/person/created-in-pass", page_class: "entity", updated_at: T, links: [], body: "# Created" }];
const fakeFetch = (seen) => async (url) => {
  seen.push(String(url));
  const m = /slug=in\.\(([^)]*)\)/.exec(decodeURIComponent(String(url)));
  const asked = m ? m[1].split(",").map((s) => s.replace(/^"|"$/g, "")) : [];
  return { ok: true, json: async () => dbAfter.filter((r) => asked.includes(r.slug)) };
};

test("without the re-check a page created inside the pass is reported missing (the residual the operator decided on)", () => {
  const r = diffFilesRows(files(), rowsAtPass(), cls, { now: Date.parse(T) });
  assert.deepEqual(r.missing, ["content/person/created-in-pass", "content/person/really-missing"]);
  assert.equal(r.drift, 2);
});

test("with the re-check the created page is not counted; a genuinely missing page STILL counts", async () => {
  const f = files(), rows = rowsAtPass(), seen = [];
  const first = diffFilesRows(f, rows, cls, { now: Date.parse(T) });
  const t0 = Date.now();
  const rc = await recheckMissing({ rows, missing: first.missing, fetchImpl: fakeFetch(seen), delayMs: 50 });
  assert.ok(Date.now() - t0 >= 45, "it waited the delay once");
  assert.equal(seen.length, 1, "ONE re-read (one request for the missing slugs)");
  assert.deepEqual(rc, { asked: 2, resolved: 1, delayMs: 50 });
  const r = diffFilesRows(f, rows, cls, { now: Date.parse(T) });
  assert.deepEqual(r.missing, ["content/person/really-missing"], "still missing on the re-read: counted");
  assert.equal(r.drift, 1);
});

test("the re-check is bounded: the delay is capped at 10x the measured window and nothing is re-read without a missing slug", async () => {
  assert.equal(RECHECK_MAX_MS, 270);
  const seen = [];
  const rc = await recheckMissing({ rows: rowsAtPass(), missing: [], fetchImpl: fakeFetch(seen), delayMs: 99_999 });
  assert.deepEqual(rc, { asked: 0, resolved: 0, delayMs: 0 });
  assert.equal(seen.length, 0);
  const rows = rowsAtPass();
  const t0 = Date.now();
  await recheckMissing({ rows, missing: ["content/person/created-in-pass"], fetchImpl: fakeFetch([]), delayMs: 99_999 });
  assert.ok(Date.now() - t0 < 1000, "a huge delay is clamped to RECHECK_MAX_MS");
});

test("a re-read that fails leaves every missing slug counted (never read as resolved)", async () => {
  const rows = rowsAtPass();
  const rc = await recheckMissing({ rows, missing: ["content/person/created-in-pass"], fetchImpl: async () => { throw new Error("db down"); }, delayMs: 0 });
  assert.equal(rc.resolved, 0);
  assert.ok(rc.error);
  assert.equal(diffFilesRows(files(), rows, cls, { now: Date.parse(T) }).missing.length, 2);
});
