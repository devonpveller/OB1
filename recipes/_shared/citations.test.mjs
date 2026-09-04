// Unit tests for the shared citation grammar — especially the marker shapes
// that used to render raw and unlinked in production (grouped brackets,
// legacy [S:<uuid>]). Run: `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSafeLabel, rewriteCitations, rewriteResearchCitations } from "./citations.mjs";

const U1 = "2cdc1d60-a193-4cd2-8248-7b1f94e95566";
const U2 = "883313e6-d062-4454-8b90-723680555b9e";
const newRun = () => ({ citedThoughtIds: new Set(), citedSourceIds: new Set() });

test("grouped tokens [S1, S2] link each member (the reported raw-citation shape)", () => {
  const run = newRun();
  const map = new Map([["S1", U1], ["S2", U2]]);
  const out = rewriteCitations("Claim [S1, S2].", new Set(), map, run);
  assert.equal(out, `Claim [[[content/source/${U1}|S1]], [[content/source/${U2}|S2]]].`);
  assert.deepEqual([...run.citedSourceIds].sort(), [U1, U2].sort());
});

test("grouped tokens with 'and' / '&' separators", () => {
  const run = newRun();
  const map = new Map([["S1", U1], ["S3", U2]]);
  assert.match(rewriteCitations("[S1 and S3]", new Set(), map, run), /S1\]\], \[\[content/);
  assert.match(rewriteCitations("[S1 & S3]", new Set(), map, run), /S1\]\], \[\[content/);
});

test("unknown token inside a group stays plain text", () => {
  const run = newRun();
  const map = new Map([["S1", U1]]);
  const out = rewriteCitations("[S1, S9]", new Set(), map, run);
  assert.equal(out, `[[[content/source/${U1}|S1]], S9]`);
  assert.deepEqual([...run.citedSourceIds], [U1]);
});

test("legacy [S:<uuid>] resolves for KNOWN uuids, aliased to the stable token", () => {
  const run = newRun();
  const map = new Map([["S1", U1], ["S2", U2]]);
  const out = rewriteCitations(`Both [S:${U1}, S:${U2}] agree.`, new Set(), map, run);
  assert.equal(out, `Both [[[content/source/${U1}|S1]], [[content/source/${U2}|S2]]] agree.`);
});

test("legacy [S:<uuid>] with an UNKNOWN uuid is never speculatively linked", () => {
  const run = newRun();
  const unknown = "aaaaaaaa-0000-4000-8000-000000000000";
  const map = new Map([["S1", U1]]);
  // Wholly unknown group → untouched; mixed group → known linked, unknown plain.
  assert.equal(rewriteCitations(`[S:${unknown}]`, new Set(), map, run), `[S:${unknown}]`);
  const mixed = rewriteCitations(`[S:${U1}, S:${unknown}]`, new Set(), map, run);
  assert.equal(mixed, `[[[content/source/${U1}|S1]], S:${unknown}]`);
  assert.deepEqual([...run.citedSourceIds], [U1]);
});

test("code spans/fences are protected in every grammar", () => {
  const run = newRun();
  const map = new Map([["S1", U1]]);
  assert.equal(rewriteCitations("`[S1]` and ```\n[S1, S2]\n```", new Set(), map, run), "`[S1]` and ```\n[S1, S2]\n```");
  assert.equal(rewriteResearchCitations("`[Source 1]`", [U1]), "`[Source 1]`");
});

test("[Source N] single form matches the old exact output", () => {
  const out = rewriteResearchCitations("Per [Source 2].", [U1, U2]);
  assert.equal(out, `Per [[[content/source/${U2}|Source 2]]].`);
});

test("[Source 1, 3] and [Sources 1 and 2] group forms link each member", () => {
  const out = rewriteResearchCitations("A [Source 1, 2] B [Sources 1 and 2]", [U1, U2]);
  assert.equal(
    out,
    `A [[[content/source/${U1}|Source 1]], [[content/source/${U2}|Source 2]]] ` +
      `B [[[content/source/${U1}|Source 1]], [[content/source/${U2}|Source 2]]]`,
  );
});

test("[Source N] out of range stays plain text", () => {
  assert.equal(rewriteResearchCitations("[Source 5]", [U1]), "[Source 5]");
  assert.equal(rewriteResearchCitations("[Source 1, 5]", [U1]), `[[[content/source/${U1}|Source 1]], Source 5]`);
});

test("linkSafeLabel strips wikilink-breaking characters", () => {
  assert.equal(linkSafeLabel("A | B [draft] C"), "A B draft C");
  assert.equal(linkSafeLabel(null), "");
});

// Quartz's wikilink alias character class excludes '#' as well as the brackets
// and the pipe, so a '#' anywhere in an alias makes the WHOLE link fail to
// match and survive as literal [[...]] text. The daily digest mints
// "Daily #NNN" source titles every day, so this is the highest-volume break.
// (Verified against the regex in the built viewer image, quartz v4.5.1,
// quartz/plugins/transformers/ofm.ts: the alias group is [^\[\]\#]*.)
test("linkSafeLabel strips '#' (breaks Quartz's alias class, e.g. 'Daily #481')", () => {
  assert.equal(linkSafeLabel("Daily #481"), "Daily 481");
  assert.equal(linkSafeLabel("#lead"), "lead");
  assert.equal(linkSafeLabel("A #1 | B [c] #2"), "A 1 B c 2");
});
