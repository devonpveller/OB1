// Unit tests for the P1 citation rewrite (the real exported function, not a
// copy). Run: `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteCitations } from "./generate-wiki.mjs";

const UUID = "3f8a1c2d-1111-4aaa-9bbb-0123456789ab";
const newRun = () => ({ citedThoughtIds: new Set(), citedSourceIds: new Set() });

test("rewrites valid thought + source citations into wikilinks", () => {
  const run = newRun();
  const out = rewriteCitations(
    "Aurora ships Q3 [S1], contradicting [#11173].",
    new Set([11173]),
    new Map([["S1", UUID]]),
    run,
  );
  assert.equal(out, `Aurora ships Q3 [[source/${UUID}|S1]], contradicting [[thought/11173|#11173]].`);
  assert.deepEqual([...run.citedSourceIds], [UUID]);
  assert.deepEqual([...run.citedThoughtIds], [11173]);
});

test("mis-cites (unknown token / not-on-page id) stay plain text", () => {
  const run = newRun();
  const out = rewriteCitations("bad [S9] and [#999]", new Set([1]), new Map([["S1", UUID]]), run);
  assert.equal(out, "bad [S9] and [#999]");
  assert.equal(run.citedSourceIds.size + run.citedThoughtIds.size, 0);
});

test("code spans are protected", () => {
  const run = newRun();
  const out = rewriteCitations("real [#1] but `code [#1]`", new Set([1]), new Map(), run);
  assert.equal(out, "real [[thought/1|#1]] but `code [#1]`");
});

test("does not double-rewrite an already-wikilinked citation", () => {
  const run = newRun();
  const src = `[[source/${UUID}|S1]] and [[thought/1|#1]]`;
  assert.equal(rewriteCitations(src, new Set([1]), new Map([["S1", UUID]]), run), src);
});

test("Sources bullet line gets the source leaf link", () => {
  const run = newRun();
  const out = rewriteCitations("- [S1] Title — https://ex.com/a?b=1", new Set(), new Map([["S1", UUID]]), run);
  assert.equal(out, `- [[source/${UUID}|S1]] Title — https://ex.com/a?b=1`);
});
