/**
 * template-renders.test.ts — the shared skeleton, on three real syntheses.
 *
 * The operator read the buyer's guide job 64ac38cf delivered and said "this
 * looks good... set this as a template for future use". The question this file
 * answers is whether that shape survives contact with subjects it was not
 * written for: a literature question about 100 Hz bone-conducted sound, and a
 * comparison of plain git hosting against Azure DevOps.
 *
 * Each fixture was rendered through the deployed LiteLLM path and then through
 * the SHIPPED fidelity check - the same two steps, in the same order, a live run
 * performs - and committed with the numbers the pipeline recorded in its header.
 * Nothing here mocks the writer: a test that asserted the skeleton over a
 * hand-written document would be asserting that I can write markdown.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkRenderFidelity, countUnits } from "./fidelity.ts";
import { SECTION_NAMES } from "./templates.ts";
import { coverageFooter, type NeedState, emptySearchRecord } from "./report.ts";

const F = new URL("./fixtures/", import.meta.url);
// A Windows checkout hands these back with CRLF; the documents are the same
// documents. Normalising HERE keeps the assertions about content, and the
// byte-identity invariant below still compares the checker against the exact
// bytes it was given.
const read = (n: string) =>
  Deno.readTextFileSync(new URL(n, F)).replace(/\r\n/g, "\n");
const body = (n: string) => read(n).replace(/<!--[\s\S]*?-->/g, "").trim();
const fx = (n: string) => {
  const d = JSON.parse(read(n));
  return d.result ?? d;
};

const citations = (t: string) =>
  new Set((t.match(/\[Sources?[^\]]*\]/g) || []).flatMap((b) => b.match(/\d+/g) || []).map(Number));

const headings = (t: string) => t.split("\n").filter((l) => /^#{1,2} /.test(l));

// ── The approved exemplar, re-rendered ─────────────────────────────────────

Deno.test("ACCEPTANCE 2: 64ac38cf through buyers-guide reproduces the approved document's sections", () => {
  const doc = body("rendered-64ac38cf-buyers-guide.md");
  const want = [
    "## Executive summary",
    "## What to check in person",
    "## Failure modes by subsystem",
    "## What the evidence does not settle",
    "## Limitations and open questions",
  ];
  const got = headings(doc);
  assert(got[0].startsWith("# "), got[0]);
  assertEquals(got.slice(1), want, JSON.stringify(got));
  // The title states a finding about the purchase, not a topic.
  assert(/PSU|socket|inspection|failure/i.test(got[0]), got[0]);
  // The checklist is a checklist and the table is a table with a Source column.
  assert((doc.match(/^- \[ \] /gm) || []).length >= 5, "no inspection checklist");
  assert(doc.includes("| Subsystem | What goes wrong | What it looks like | Source |"), "no subsystem table");
  const rows = doc.split("\n").filter((l) => /^\|/.test(l) && !/^\|\s*-+/.test(l));
  for (const r of rows.slice(1)) assert(/\[Source \d/.test(r), `uncited row: ${r.slice(0, 60)}`);
  assertEquals((doc.match(/^## Limitations and open questions$/gm) || []).length, 1);
});

Deno.test("ACCEPTANCE 2: the re-render invents no citation, and its numbers resolve", () => {
  for (const [doc, src] of [
    ["rendered-64ac38cf-buyers-guide.md", "live-owui-64ac38cf.result.json"],
    ["rendered-a337520c-scientific-paper.md", "dryrun-a337520c-100hz.result.json"],
    ["rendered-5ab36fe0-product-comparison.md", "job-5ab36fe0-git-vs-azuredevops.result.json"],
  ]) {
    const inDoc = citations(body(doc));
    const inSynth = citations(fx(src).synthesis);
    const invented = [...inDoc].filter((n) => !inSynth.has(n));
    assertEquals(invented, [], `${doc} cites sources the synthesis does not`);
    // MEASURED, and not the same as "keeps every citation": a report that
    // summarises drops some. What it may never do is add one.
    //   buyers-guide  15 of 16   scientific-paper 13 of 16   comparison 6 of 7
    assert(inDoc.size / inSynth.size >= 0.8,
      `${doc} re-cited only ${inDoc.size} of ${inSynth.size}`);
  }
});

// ── The same skeleton, two other subjects ──────────────────────────────────

Deno.test("ACCEPTANCE 2: the 100 Hz synthesis through scientific-paper gets THAT template's names", () => {
  const doc = body("rendered-a337520c-scientific-paper.md");
  const names = SECTION_NAMES["scientific-paper"];
  assertEquals(names.action, "Findings");
  assertEquals(names.table, "Findings by theme");
  const got = headings(doc).filter((h) => h.startsWith("## "));
  assertEquals(got, [
    "## Executive summary",
    `## ${names.action}`,
    `## ${names.table}`,
    "## What the evidence does not settle",
    "## Limitations and open questions",
  ], JSON.stringify(got));
  // A literature question divides into themes, and the template allows that
  // INSIDE a section - the skeleton is not broken by sub-headings.
  assert(doc.split("\n").some((l) => l.startsWith("### ")), "no sub-headings under Findings");
  // The table's area column is the one this template names.
  assert(doc.includes(`| ${names.area} `), `no ${names.area} column`);
});

Deno.test("ACCEPTANCE 2: the comparison synthesis renders the table AS the comparison grid", () => {
  const doc = body("rendered-5ab36fe0-product-comparison.md");
  const names = SECTION_NAMES["product-comparison"];
  assertEquals(names.action, "Comparison at a glance");
  assertEquals(names.table, "Options by criterion");
  const got = headings(doc).filter((h) => h.startsWith("## "));
  assertEquals(got, [
    "## Executive summary",
    `## ${names.action}`,
    `## ${names.table}`,
    "## What the evidence does not settle",
    "## Limitations and open questions",
  ], JSON.stringify(got));
  const rows = doc.split("\n").filter((l) => /^\|/.test(l) && !/^\|\s*-+/.test(l));
  const header = rows[0];
  // A grid: the criterion column, one column per OPTION named in the header,
  // and a Source column - not "what goes wrong / what it looks like".
  assert(/^\|\s*Criterion\s*\|/.test(header), header);
  assert(/git/i.test(header) && /Azure DevOps/i.test(header), header);
  assert(header.trim().endsWith("Source |"), header);
  assert(rows.length >= 6, `only ${rows.length - 1} criteria`);
  for (const r of rows.slice(1)) assert(/\[?\bSource|\[\d/.test(r), `uncited row: ${r.slice(0, 60)}`);
});

// ── The footer's denominator is a function of the document ─────────────────

Deno.test("ACCEPTANCE 3: the footer's M is countUnits of the delivered document", () => {
  // The three renders carry the record their own run produced, in the header.
  const cases: Array<[string, number, number]> = [
    ["rendered-64ac38cf-buyers-guide.md", 43, 44],
    ["rendered-a337520c-scientific-paper.md", 65, 67],
    ["rendered-5ab36fe0-product-comparison.md", 25, 25],
  ];
  for (const [name, checked, units] of cases) {
    const doc = body(name);
    // M is reproducible from the file alone - which is the whole point of the
    // tester's X4 and the reviewer's K.10: three artifacts carried four counts
    // of "the same" document and none could be recomputed.
    assertEquals(countUnits(doc), units, name);
    assert(checked <= units, `${name}: N exceeds M`);
    const needs: NeedState[] = [{ need: "a", status: "answered" }];
    const footer = coverageFooter(needs, emptySearchRecord(), "complete", null, {
      checked, units, unchecked: units - checked, rewritten: 0, replaced: 0,
    });
    assert(footer.includes(`render checked: ${checked} of ${units}, 0 corrected, ${units - checked} unchecked`),
      footer);
    // …and the header of the fixture records the same numbers the test asserts.
    assert(read(name).includes(`"checked":${checked}`), `${name}: header disagrees with the test`);
    assert(read(name).includes(`"units":${units}`), `${name}: header disagrees with the test`);
  }
});

Deno.test("INVARIANT: the check leaves every COMMITTED render exactly as it is", async () => {
  // The fixtures claim in their headers that they came through this branch's
  // check. Attempt 1's did, and the check still changed two of them when run
  // again - it normalised the text that ships. Applying it to each committed
  // file must now return that file.
  const blessAll = {
    chat: (sys: string, user: string) => {
      if (!sys.startsWith("You compare SENTENCES")) return Promise.resolve("{}");
      const n = (user.match(/^\d+\. SENTENCE:/gm) || []).length;
      return Promise.resolve(JSON.stringify({ verdicts: new Array(n).fill("SAME") }));
    },
  } as unknown as Parameters<typeof checkRenderFidelity>[0];
  for (const [name, src] of [
    ["rendered-64ac38cf-buyers-guide.md", "live-owui-64ac38cf.result.json"],
    ["rendered-a337520c-scientific-paper.md", "dryrun-a337520c-100hz.result.json"],
    ["rendered-5ab36fe0-product-comparison.md", "job-5ab36fe0-git-vs-azuredevops.result.json"],
  ] as Array<[string, string]>) {
    const doc = read(name);
    // Each document against ITS OWN synthesis: the names gate reads the
    // evidence, so the wrong evidence makes every name unearned.
    const out = await checkRenderFidelity(blessAll, doc, fx(src).synthesis, fx(src).query ?? "");
    assertEquals(out.rendered, doc, name);
  }
});
