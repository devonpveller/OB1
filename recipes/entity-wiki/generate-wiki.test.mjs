// Unit tests for the P1 citation rewrite (the real exported function, not a
// copy). Run: `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rewriteCitations, buildEvolutionSection, linkifyEntities, buildEntityIndex, mergeFailedEntityIds,
  structuralContext, skipOpenStructural, entityInputs, runEntities, clearStructuralCli,
} from "./generate-wiki.mjs";
import { updateLedger, recordFailure, readLedger } from "../_shared/structural-ledger.mjs";

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
  // Thought "#" stays OUTSIDE the wikilink (Quartz parser fails on `|#…` alias).
  assert.equal(out, `Aurora ships Q3 [[content/source/${UUID}|S1]], contradicting #[[content/thought/11173|11173]].`);
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
  assert.equal(out, "real #[[content/thought/1|1]] but `code [#1]`");
});

test("does not double-rewrite an already-wikilinked citation", () => {
  const run = newRun();
  const src = `[[content/source/${UUID}|S1]] and #[[content/thought/1|1]]`;
  assert.equal(rewriteCitations(src, new Set([1]), new Map([["S1", UUID]]), run), src);
});

test("Sources bullet line gets the source leaf link", () => {
  const run = newRun();
  const out = rewriteCitations("- [S1] Title — https://ex.com/a?b=1", new Set(), new Map([["S1", UUID]]), run);
  assert.equal(out, `- [[content/source/${UUID}|S1]] Title — https://ex.com/a?b=1`);
});

// ── P6.7 derived ## Evolution timeline ─────────────────────────────────────
test("Evolution: first-seen from earliest thought + sorted grounding events", () => {
  const out = buildEvolutionSection(
    { created_at: null },
    [
      { id: UUID, title: "Architecture review", content_type: "pdf", linked_at: "2026-03-02T10:00:00Z" },
      { id: "aaaaaaaa-2222-4bbb-8ccc-1111deadbeef", title: "RFC", content_type: "web_article", linked_at: "2026-01-15T00:00:00Z" },
    ],
    [{ created_at: "2025-12-01T00:00:00Z" }, { created_at: "2026-02-01T00:00:00Z" }],
  );
  assert.match(out, /^\n\n## Evolution\n/);
  // first-seen uses the earliest thought date
  assert.match(out, /\*\*2025-12-01\*\* — First captured/);
  // grounding links + dates, sorted ascending (RFC 2026-01-15 before review 2026-03-02)
  const iRfc = out.indexOf("2026-01-15");
  const iRev = out.indexOf("2026-03-02");
  assert.ok(iRfc > -1 && iRev > -1 && iRfc < iRev, "events sorted by date");
  assert.ok(out.includes("[[content/source/" + UUID + "|Architecture review]] (pdf)"), "review source link present");
});

test("Evolution: empty when no first-seen and no sources", () => {
  assert.equal(buildEvolutionSection({ created_at: null }, [], []), "");
});

test("Evolution: source title sanitized of wikilink-breaking chars", () => {
  const out = buildEvolutionSection({ created_at: "2026-01-01T00:00:00Z" }, [
    { id: UUID, title: "Weird [title] | with ]] chars", linked_at: "2026-01-02T00:00:00Z" },
  ], []);
  // the bracket/pipe chars in the title were neutralised so they can't break
  // the wikilink (no leftover "[title]" or "]] chars" leaking through)
  assert.ok(out.includes("[[content/source/" + UUID + "|"), "link prefix present");
  assert.ok(!out.includes("[title]") && !out.includes("]] chars"), "title sanitized");
});

// -- '#'-bearing entity names survive each emitter as a WORKING link --------
// The parser below is Quartz's own wikilinkRegex, copied VERBATIM out of the
// deployed viewer image (openbrain-wiki-viewer, quartz v4.5.1,
// quartz/plugins/transformers/ofm.ts:120). Its alias group is [^\[\]\#]*, so a
// '#' anywhere in an alias makes the WHOLE [[...]] fail to match and survive
// on the page as literal text. These tests drive the EMITTED markdown through
// that parser; an assertion on the source of generate-wiki.mjs would prove
// only that a call was written, never that the page renders a link.
const WIKILINK_RE = /!?\[\[([^\[\]\|\#\\]+)?(#+[^\[\]\|\#\\]+)?(\\?\|[^\[\]\#]*)?\]\]/g;

// Every [[...]] the parser accepts, with its target and alias.
function parsedLinks(md) {
  const re = new RegExp(WIKILINK_RE.source, "g");
  const out = [];
  let m;
  while ((m = re.exec(md)) !== null) out.push({ whole: m[0], target: m[1], alias: m[3] });
  return out;
}
// Any "[[" the parser did NOT consume is a broken link left as literal text --
// exactly what a reader sees on the page. This is the assertion that matters.
function unparsedOpeners(md) {
  return (md.replace(new RegExp(WIKILINK_RE.source, "g"), "").match(/\[\[/g) || []).length;
}

test("auto-linker: a '#' in an entity name still emits a link Quartz can parse", () => {
  const out = linkifyEntities("We ship C# services.", [{ name: "C#", slug: "technology/c-sharp" }]);
  assert.equal(unparsedOpeners(out), 0, `broken wikilink left as literal text: ${out}`);
  const links = parsedLinks(out);
  assert.equal(links.length, 1, `expected exactly one parsed wikilink, got ${links.length}: ${out}`);
  assert.equal(links[0].target, "technology/c-sharp", out);
});

test("auto-linker: a '#'-free name is linked exactly as before", () => {
  const out = linkifyEntities("We ship Aurora daily.", [{ name: "Aurora", slug: "project/aurora" }]);
  assert.equal(out, "We ship [[project/aurora|Aurora]] daily.");
});

test("auto-linker: a name that sanitises to nothing stays plain text, not an empty alias", () => {
  const out = linkifyEntities("see ## here", [{ name: "##", slug: "x/y" }]);
  assert.equal(out, "see ## here");
  assert.equal(unparsedOpeners(out), 0, out);
});

test("entity index: a '#' in an entity label still emits a link Quartz can parse", () => {
  const md = buildEntityIndex([{ slug: "source/daily-481", label: "Daily #481", type: "source" }], []);
  assert.equal(unparsedOpeners(md), 0, `broken wikilink left as literal text: ${md}`);
  const links = parsedLinks(md);
  assert.ok(links.some((l) => l.target === "source/daily-481"), `entity link not parseable: ${md}`);
});

test("entity index: a '#'-free label is listed exactly as before", () => {
  const md = buildEntityIndex([{ slug: "project/aurora", label: "Aurora", type: "project" }], []);
  assert.ok(md.includes("- [[project/aurora|Aurora]]"), md);
  assert.equal(unparsedOpeners(md), 0, md);
});

test("entity index: a label that sanitises to nothing falls back to the slug, never an empty alias", () => {
  const md = buildEntityIndex([{ slug: "source/x", label: "#", type: "source" }], []);
  assert.equal(unparsedOpeners(md), 0, md);
  assert.ok(md.includes("- [[source/x]]"), md);
  assert.ok(!md.includes("|]]"), `empty alias emitted: ${md}`);
});

// rw-p1a-render attempt 2 (tester near-miss N6): the transient ledger is
// STABLE - a run without transient failures never wipes other runs' entries,
// so "905 is not in the ledger" is a real check, not an empty file.
test("N6: the failed-ids ledger keeps untouched ids, drops resolved ones, adds new transient ones", () => {
  assert.deepEqual(mergeFailedEntityIds([902, 901], { failed: [], resolved: [905] }), [901, 902], "a structural-only run keeps the ledger");
  assert.deepEqual(mergeFailedEntityIds([902, 901], { failed: [], resolved: [901] }), [902], "a clean recompile resolves its id");
  assert.deepEqual(mergeFailedEntityIds([902], { failed: [904], resolved: [905] }), [902, 904]);
  assert.deepEqual(mergeFailedEntityIds(null, { failed: [], resolved: [] }), []);
  assert.deepEqual(mergeFailedEntityIds(["x", 3], { failed: [], resolved: [] }), [3], "junk entries are dropped");
});

// ── attempt 3 (tester N2-6): the structural SKIP has its own unit test (a
// revert of skipOpenStructural used to be caught only by the runner's C8b) ──
const ARGS = (outDir) => ({ outputMode: "file", dryRun: false, outDir, model: "stub-model", graph: false });
const DAVE = { id: 905, entity_type: "person", canonical_name: "Dave Fixture", updated_at: "2026-10-18T00:00:00.000Z" };
function ledgerWithDave(outDir, entity = DAVE) {
  const sctx = structuralContext(ARGS(outDir), {}, outDir);
  updateLedger(outDir, (l) => recordFailure(l, {
    key: `entity:${entity.id}`, slug: "content/person/person-dave-fixture", entity: entity.id,
    error: "reply failed the page parser", replySha256: "aa", inputs: entityInputs(entity, sctx),
  }));
  return sctx;
}

test("N2-6: an open structural failure with unchanged inputs is SKIPPED; changed inputs are retried", () => {
  const outDir = mkdtempSync(join(tmpdir(), "gw-skip-"));
  const sctx = ledgerWithDave(outDir);
  const open = skipOpenStructural(DAVE, sctx);
  assert.ok(open, "unchanged inputs: skipped");
  assert.equal(open.key, "entity:905");
  assert.equal(sctx.skipped.length, 1);
  assert.equal(skipOpenStructural({ ...DAVE, updated_at: "2026-10-19T00:00:00.000Z" }, sctx), null, "a new source revision: retried");
  assert.equal(skipOpenStructural({ ...DAVE, id: 902 }, sctx), null, "another entity: not skipped");
});

test("N2-6: runEntities makes NO compile call for a skipped entity (the database and the LLM are never reached)", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "gw-skip-run-"));
  ledgerWithDave(outDir);
  let touched = 0;
  const sb = new Proxy({}, { get() { touched++; throw new Error("compile reached the database for a skipped entity"); } });
  const orig = console.error;
  console.error = () => {};
  let res;
  try {
    res = await runEntities(sb, {}, ARGS(outDir), [async () => DAVE], [DAVE.id]);
  } finally { console.error = orig; }
  assert.equal(res.skipped, 1);
  assert.equal(res.ok, 0);
  assert.deepEqual(res.structural, [], "not compiled, so not failed");
  assert.equal(touched, 0, "no compile ran");
  assert.ok(readLedger(outDir).failures["entity:905"], "the open failure stays");
});

test("N2-2: --clear-structural of an id that is not open exits 1 naming it", () => {
  const outDir = mkdtempSync(join(tmpdir(), "gw-clear-"));
  ledgerWithDave(outDir);
  const lines = [];
  const oe = console.error;
  const ol = console.log;
  console.error = (m) => lines.push(String(m));
  console.log = (m) => lines.push(String(m));
  let a; let b;
  try {
    a = clearStructuralCli({ outDir, clearStructural: "123456" }, {});
    b = clearStructuralCli({ outDir, clearStructural: "905" }, {});
  } finally { console.error = oe; console.log = ol; }
  assert.equal(a, 1);
  assert.ok(lines.some((l) => l.includes("not an open structural failure: entity:123456")), JSON.stringify(lines));
  assert.equal(b, 0);
  assert.ok(lines.some((l) => l.includes("cleared 1 open structural failure(s): entity:905; 0 still open")));
});
