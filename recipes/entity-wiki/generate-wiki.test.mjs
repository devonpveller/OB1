// Unit tests for the P1 citation rewrite (the real exported function, not a
// copy). Run: `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteCitations, buildEvolutionSection, linkifyEntities, buildEntityIndex } from "./generate-wiki.mjs";

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
