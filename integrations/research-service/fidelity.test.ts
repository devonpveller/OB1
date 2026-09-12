/**
 * fidelity.test.ts — the per-sentence check on the rendered report.
 *
 * The case it exists for is the tester's X1: a table cell citing [Source 13]
 * that read "no off-the-shelf ATX or SFX drop-in available" over a line saying
 * the proprietary connector "makes it difficult" to fit aftermarket PSUs. Two
 * moves in one cell, and only one of them was detectable — `renderGroundingDiff`
 * compares numbers, URLs and names, and a hedge becoming an absolute is none of
 * those. The tester proved the blindness: "It is impossible to install
 * aftermarket PSUs" and "The unit always fails within a year" both pass that
 * diff clean.
 *
 * The judge here is a model, so these cases mock it. What they pin is the
 * MACHINERY around it: what gets presented for judging, what happens to a
 * sentence the judge condemns, and - the case that matters most - what happens
 * when the judge itself breaks.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  absenceLines, applyUnit, CELL_NOTE_WORDS, checkRenderFidelity, citedUnits, countUnits,
  FLIP_JUDGE_SYS, namesIn, nearestLines, normaliseCitations, parseDuplicate, parseFlip, polarityOf,
  polarityVerdict, referenceLines, splitSentences, supersetCitations, verbatimFallback,
} from "./fidelity.ts";
import { renderSys, templateById } from "./templates.ts";
import { expansionMatch, renderGroundingDiff } from "./grounding.ts";
import type { Polarity } from "./fidelity.ts";
import { coverageFooter, emptySearchRecord } from "./report.ts";
import type { Deps } from "./harness.ts";

const SYNTH = [
  "[SOURCED] The Dell OptiPlex 3050 SFF uses a proprietary power supply and proprietary power " +
  "connector, which makes it difficult for users to install aftermarket PSUs to support " +
  "higher-power GPUs. [Source 13]",
  "[SOURCED] The Dell OptiPlex 3050 SFF supports up to 32 GB of DDR4 RAM across two DIMM slots. [Source 13]",
  "[SOURCED] A community user reported bent processor pins on an OptiPlex 3050 motherboard. [Source 14]",
  "[GAP] What are the water-damage failure modes?",
].join("\n");

/**
 * THE FLIP JUDGE, mocked. Attempt 5 puts every proposed correction to it before
 * anything is applied, and an unparseable answer is a refusal - so a mock that
 * does not answer it refuses everything. Tests about the correction machinery
 * wrap their deps in `keeps(...)`; tests about polarity wrap in `flips(...)`
 * and assert the sentence survives.
 */
const FLIP_SYS_HEAD = "You are given a sentence from a report";
function flipping(inner: Deps, verdict: "KEEP" | "FLIP"): Deps {
  return {
    ...inner,
    chat: (sys: string, user: string, opts?: { json?: boolean; nothink?: boolean }) =>
      sys.startsWith(FLIP_SYS_HEAD)
        ? Promise.resolve(JSON.stringify({ verdict }))
        : inner.chat(sys, user, opts),
  } as unknown as Deps;
}
const keeps = (d: Deps) => flipping(d, "KEEP");
const flips = (d: Deps) => flipping(d, "FLIP");

/** A judge that answers from a script, and counts how often it was asked. */
function mockJudge(script: string[][], rewrite?: Record<string, string>) {
  const calls = { judge: 0, rewrite: 0, items: [] as string[] };
  const deps = {
    chat: (sys: string, user: string) => {
      if (sys.startsWith("You compare SENTENCES")) {
        calls.items.push(user);
        const verdicts = script[Math.min(calls.judge, script.length - 1)];
        calls.judge++;
        return Promise.resolve(JSON.stringify({ verdicts }));
      }
      if (sys.startsWith("You repair sentences")) {
        calls.rewrite++;
        return Promise.resolve(JSON.stringify({ fixed: rewrite ?? {} }));
      }
      return Promise.resolve("{}");
    },
  } as unknown as Deps;
  return { deps, calls };
}

// ── What is presented for judging ──────────────────────────────────────────

Deno.test("only sentences and cells that CITE something are checked", () => {
  const doc = [
    "# A title that cites nothing",
    "",
    "The summary says something general. The PSU fails in a documented way [Source 13].",
    "",
    "| Subsystem | What goes wrong | Source |",
    "|---|---|---|",
    "| Power supply | The connector makes aftermarket fitting difficult | [Source 13] |",
    "",
    "- What are the water-damage failure modes?",
  ].join("\n");
  const units = citedUnits(doc);
  const texts = units.map((u) => u.text);
  // The uncited sentence, the title, the [GAP] question and the table HEADER
  // are all absent - there is nothing to compare them against, and the gap
  // questions must survive untouched.
  assert(!texts.some((t) => /title/.test(t)), texts.join(" | "));
  assert(!texts.some((t) => /something general/.test(t)), texts.join(" | "));
  assert(!texts.some((t) => /water-damage/.test(t)), texts.join(" | "));
  assert(!texts.some((t) => /^Subsystem$/.test(t)), texts.join(" | "));
  // …and the row LABEL is not a claim either: judging "Power supply" against
  // the row's sources got it rewritten into a paragraph, which shifted every
  // column of that row.
  assert(!texts.includes("Power supply"), texts.join(" | "));
  assertEquals(texts, [
    "The PSU fails in a documented way [Source 13].",
    "The connector makes aftermarket fitting difficult",
  ]);
  // A cell inherits its ROW's citations: the row cites once, in the Source
  // column, and the sentence that overstates it is in a different cell.
  assertEquals(units[1].citations, [13]);
  assertEquals(units[1].cell >= 0, true);
});

Deno.test("a sentence is matched to the lines IT cites, not to the whole synthesis", () => {
  assertEquals(referenceLines(SYNTH, [14]).length, 1);
  assertEquals(referenceLines(SYNTH, [13]).length, 2);
  assertEquals(referenceLines(SYNTH, [99]).length, 0);
  // …and the [GAP] line cites nothing, so it is never a reference.
  assert(!referenceLines(SYNTH, [13, 14]).some((l) => /\[GAP\]/.test(l)));
});

Deno.test("sentences split without breaking citations, decimals or abbreviations", () => {
  const line = "The PSU is 180 W [Source 7]. It supports 2.5 in drives, e.g. SSDs [Source 13]. Done.";
  assertEquals(splitSentences(line), [
    "The PSU is 180 W [Source 7].",
    "It supports 2.5 in drives, e.g. SSDs [Source 13].",
    "Done.",
  ]);
});

// ── What happens to a sentence that says more than its source ──────────────

const HEDGE_DOC = [
  "| Subsystem | What goes wrong | Source |",
  "|---|---|---|",
  "| Power connector | Physical connector is non-standard; no off-the-shelf ATX or SFX drop-in available | [Source 13] |",
].join("\n");

Deno.test("X1: a hedge turned into an absolute is rewritten back to its source", async () => {
  const { deps, calls } = mockJudge(
    [["STRONGER"], ["SAME"]],
    { "1": "Proprietary connector makes aftermarket PSU fitting difficult" },
  );
  const out = await checkRenderFidelity(keeps(deps), HEDGE_DOC, SYNTH);
  assertEquals(out.record.checked, 1);
  assertEquals(out.record.stronger, 1);
  assertEquals(out.record.rewritten, 1);
  assertEquals(out.record.replaced, 0);
  assert(out.rendered.includes("makes aftermarket PSU fitting difficult"), out.rendered);
  assert(!out.rendered.includes("ATX"), out.rendered);
  // The table is still a table: three cells and the row's Source column.
  assertEquals(out.rendered.split("\n")[2].split("|").length, HEDGE_DOC.split("\n")[2].split("|").length);
  assertEquals(calls.rewrite, 1);
});

Deno.test("X1: a sentence the rewrite does not fix is REPLACED by its source, verbatim", async () => {
  // The judge condemns it, the rewriter cannot mend it, and the run falls back
  // to the grounded line - which reads less smoothly and cannot overstate
  // anything, because it IS the evidence.
  const { deps } = mockJudge([["UNSUPPORTED"], ["STRONGER"]], {});
  const out = await checkRenderFidelity(keeps(deps), HEDGE_DOC, SYNTH);
  assertEquals(out.record.unsupported, 1);
  assertEquals(out.record.replaced, 1);
  assertEquals(out.record.rewritten, 0);
  assert(out.rendered.includes("makes it difficult for users to install aftermarket PSUs"), out.rendered);
  assert(!out.rendered.includes("ATX"), out.rendered);
  // Inside a table the row already has a Source column, so the replacement does
  // not paste the citation a second time.
  assertEquals(out.rendered.split("\n")[2].match(/\[Source/g)?.length, 1);
  // …and the [SOURCED] tag never reaches the reader.
  assert(!/\[SOURCED\]/.test(out.rendered), out.rendered);
});

Deno.test("a SAME or WEAKER document is returned untouched", async () => {
  const doc = "The proprietary connector makes aftermarket PSU fitting difficult [Source 13]. " +
              "The board takes up to 32 GB of memory across two slots [Source 13].";
  const { deps, calls } = mockJudge([["SAME", "WEAKER"]]);
  const out = await checkRenderFidelity(keeps(deps), doc, SYNTH);
  assertEquals(out.rendered, doc);
  assertEquals(out.record.checked, 2);
  assertEquals([out.record.stronger, out.record.unsupported, out.record.rewritten, out.record.replaced], [0, 0, 0, 0]);
  assertEquals(calls.rewrite, 0, "a clean document was sent to the rewriter");
});

// ── What happens when the checker itself breaks ────────────────────────────

Deno.test("a judge that throws leaves the document EXACTLY as it was, and says so", async () => {
  const deps = { chat: () => Promise.reject(new Error("upstream 503")) } as unknown as Deps;
  const out = await checkRenderFidelity(keeps(deps), HEDGE_DOC, SYNTH);
  assertEquals(out.rendered, HEDGE_DOC);
  assertEquals(out.record.checked, 0);
  assert(out.record.error, "a failed check must be recorded, not silently passed");
  assert(/503/.test(out.record.error!));
});

Deno.test("a judge that answers nonsense is a failed check, not a verdict", async () => {
  for (const reply of ["not json", '{"verdicts":["MAYBE"]}', '{"verdicts":[]}', "{}"]) {
    const deps = { chat: () => Promise.resolve(reply) } as unknown as Deps;
    const out = await checkRenderFidelity(keeps(deps), HEDGE_DOC, SYNTH);
    assertEquals(out.rendered, HEDGE_DOC, reply);
    assertEquals(out.record.checked, 0, reply);
    assert(out.record.error, reply);
  }
});

Deno.test("a rewriter that breaks still cannot leave an overstatement standing", async () => {
  // The rewrite is best-effort; the verbatim fallback is the guarantee.
  const deps = {
    chat: (sys: string) => {
      if (sys.startsWith("You compare SENTENCES")) return Promise.resolve(JSON.stringify({ verdicts: ["STRONGER"] }));
      return Promise.reject(new Error("rewriter down"));
    },
  } as unknown as Deps;
  const out = await checkRenderFidelity(keeps(deps), HEDGE_DOC, SYNTH);
  assertEquals(out.record.replaced, 1);
  assert(out.rendered.includes("makes it difficult"), out.rendered);
});

Deno.test("a re-judge that breaks replaces everything the first judge condemned", async () => {
  // Trust nothing that cannot be re-checked: if the second pass cannot run, the
  // condemned sentences go back to their sources rather than keeping a rewrite
  // nobody verified.
  let judged = 0;
  const deps = {
    chat: (sys: string) => {
      if (sys.startsWith("You compare SENTENCES")) {
        judged++;
        if (judged === 1) return Promise.resolve(JSON.stringify({ verdicts: ["STRONGER"] }));
        return Promise.reject(new Error("judge died mid-run"));
      }
      return Promise.resolve(JSON.stringify({ fixed: { "1": "Something plausible but unverified" } }));
    },
  } as unknown as Deps;
  const out = await checkRenderFidelity(keeps(deps), HEDGE_DOC, SYNTH);
  assertEquals(out.record.replaced, 1);
  assert(!out.rendered.includes("Something plausible"), out.rendered);
});

// ── The pieces, on their own ───────────────────────────────────────────────

Deno.test("the verbatim fallback is ONE line for one sentence, and the closest one", () => {
  // It pasted every line sharing a citation once, which turned a summary
  // sentence citing [Source 13] into the whole of that source's evidence.
  const refs = referenceLines(SYNTH, [13]);
  assertEquals(refs.length, 2);
  const chosen = verbatimFallback(refs, "The connector makes aftermarket PSUs hard to fit");
  assert(chosen.includes("aftermarket PSUs"), chosen);
  assert(!chosen.includes("32 GB"), chosen);
  assert(!/^\[SOURCED\]/.test(chosen), chosen);
  // …and it picks the line about the SUBJECT of the sentence being replaced.
  const other = verbatimFallback(refs, "It takes 32 GB of memory in two slots");
  assert(other.includes("32 GB"), other);
});

Deno.test("applyUnit edits the cell it was given and nothing else on the line", () => {
  const lines = ["| A | B | C |"];
  applyUnit(lines, { text: "B", view: "B", line: 0, cell: 2, citations: [], section: "", judgeable: true }, "B rewritten");
  assertEquals(lines[0], "| A | B rewritten | C |");
  const prose = ["One. Two. Three."];
  applyUnit(prose, { text: "Two.", view: "Two.", line: 0, cell: -1, citations: [], section: "", judgeable: true }, "Second.");
  assertEquals(prose[0], "One. Second. Three.");
});

// ── The coverage the tester found missing (research-trust-template) ─────────
//
// rt-tester-evidence-report-2.md, X1 and X2: three shapes that were never
// presented to the judge at all, while the footer reported a confident count.
// Each yields exactly ONE unit now.

const PROBE_SYNTH = [
  "[SOURCED] The Dell OptiPlex 3050 SFF uses a proprietary power supply and a proprietary power " +
  "connector, which makes it difficult for users to install aftermarket PSUs or higher-wattage " +
  "units to support more demanding graphics cards, and a replacement therefore has to be sourced " +
  "from Dell rather than from a generic supplier. [Source 13]",
  "[SOURCED] The fans and vents on the OptiPlex 3050 accumulate dust, which Dell's guidance " +
  "identifies as a cause of overheating. [Source 5]",
].join("\n");

Deno.test("X1: a citation after the full stop is one unit, not zero", () => {
  // "The PSU makes it difficult to upgrade. [Source 13]" split into a claim with
  // no citation and a citation with no claim, and yielded NOTHING.
  const doc = "## Findings\n\nThe PSU makes it difficult to upgrade. [Source 13]";
  const units = citedUnits(normaliseCitations(doc));
  assertEquals(units.length, 1, JSON.stringify(units.map((u) => u.text)));
  assertEquals(units[0].citations, [13]);
  assertEquals(units[0].text, "The PSU makes it difficult to upgrade [Source 13].");
  // The trailing-stop variant too.
  assertEquals(countUnits("## Findings\n\nThe PSU makes it difficult to upgrade. [Source 13]."), 1);
  // …and the form production already used is unchanged.
  assertEquals(countUnits("## Findings\n\nThe PSU makes it difficult to upgrade [Source 13]."), 1);
});

Deno.test("X1: normalising a citation never eats the line it ends", () => {
  // The first version used `\\s*` after the bracket, which matched the NEWLINE:
  // nine checklist items and the heading after them became one line. Found by
  // running the check over the approved document, so the fixture is a checklist.
  const doc = [
    "## What to check in person",
    "",
    "- [ ] Power the unit on and watch the rear LED. [Source 11]",
    "- [ ] Inspect the CPU socket for bent pins. [Source 1, Source 15]",
    "- [ ] Confirm both DIMM slots are recognised. [Source 14]",
    "",
    "## Failure modes by subsystem",
  ].join("\n");
  const out = normaliseCitations(doc);
  assertEquals(out.split("\n").length, doc.split("\n").length, out);
  assert(out.includes("\n## Failure modes by subsystem"), out);
  assertEquals(countUnits(doc), 3);
});

Deno.test("X2: an UNCITED claim in an evidence section is one unit, and is judged", async () => {
  const doc = "## Findings by area\n\nThe unit is impossible to upgrade and always fails within a year.";
  const units = citedUnits(doc);
  assertEquals(units.length, 1);
  assertEquals(units[0].citations, []);
  // Nothing in the evidence is within reach of it - which IS the verdict, and
  // needs no model: a sentence resting on nothing is UNSUPPORTED.
  assertEquals(nearestLines(PROBE_SYNTH, units[0].text), []);
  const never = { chat: () => Promise.reject(new Error("the judge must not be asked")) } as unknown as Deps;
  const out = await checkRenderFidelity(never, doc, PROBE_SYNTH);
  assertEquals(out.record.unsupported, 1);
  assert(!out.record.error, "the run must not have failed open here");
  // and because nothing in the evidence could correct it, the sentence is still
  // in the document. Attempt 4 called that "checked 1 of 1, unchecked 0". A
  // condemned sentence that survives is counted where it can be SEEN: once, as
  // no_candidate, and in the footer's U.
  assertEquals([out.record.checked, out.record.no_candidate, out.record.unchecked], [0, 1, 1]);

  // An uncited sentence that IS about the evidence goes to the judge with the
  // nearest lines instead.
  const near = "## Findings by area\n\nThe proprietary power connector makes fitting an aftermarket PSU difficult.";
  assert(nearestLines(PROBE_SYNTH, citedUnits(near)[0].text).length > 0);
  const deps = {
    chat: (sys: string) =>
      sys.startsWith("You compare SENTENCES")
        ? Promise.resolve(JSON.stringify({ verdicts: ["SAME"] }))
        : Promise.resolve("{}"),
  } as unknown as Deps;
  const ok = await checkRenderFidelity(keeps(deps), near, PROBE_SYNTH);
  assertEquals([ok.record.checked, ok.record.unsupported], [1, 0]);
  assertEquals(ok.rendered, near);
});

Deno.test("X2: a four-word cited table cell is one unit", () => {
  const doc = [
    "## Failure modes by subsystem",
    "| Subsystem | What goes wrong | Source |",
    "|---|---|---|",
    "| Fans | Fans are proprietary | [Source 13] |",
  ].join("\n");
  const units = citedUnits(doc);
  assertEquals(units.length, 1, JSON.stringify(units.map((u) => u.text)));
  assertEquals(units[0].text, "Fans are proprietary");
  assertEquals(units[0].citations, [13]);
  // The row LABEL is still not a claim - that rule did the work the word floor
  // was doing, and the floor is gone from tables entirely.
  assert(!units.some((u) => u.text === "Fans"));
});

Deno.test("the [GAP] questions and the executive summary are still left alone", () => {
  const doc = [
    "## Executive summary",
    "",
    "The evidence says the machine is worth buying if it passes inspection.",
    "",
    "## Limitations and open questions",
    "",
    "- What are the water-damage failure modes for this unit?",
    "- What is the capacitor failure rate on this platform?",
  ].join("\n");
  assertEquals(citedUnits(doc).length, 0, JSON.stringify(citedUnits(doc)));
});

// ── The denominator, and the note layout ──────────────────────────────────

Deno.test("ACCEPTANCE 3: a citation the sentence does not use is REPORTED, not deleted", () => {
  // The tester's X3: citing broadly could only make a verdict look better.
  const doc = [
    "## Failure modes by subsystem",
    "| Subsystem | What goes wrong | Source |",
    "|---|---|---|",
    "| PSU | The proprietary connector makes aftermarket PSUs difficult to fit | [Source 13, 5] |",
  ].join("\n");
  const superset = supersetCitations(doc, PROBE_SYNTH);
  assertEquals(superset.length, 1, JSON.stringify(superset));
  assert(superset[0].startsWith("[Source 5] in "), superset[0]);
  // …and nothing was removed from the document to make that verdict.
  assert(doc.includes("[Source 13, 5]"));
  // A row whose citations all contribute reports nothing.
  const clean = doc.replace("[Source 13, 5]", "[Source 13]");
  assertEquals(supersetCitations(clean, PROBE_SYNTH), []);
});

Deno.test("K.9: a long replaced cell becomes a marker, and the line goes under the table", async () => {
  const long =
    "Because the SFF PSU is proprietary and the 180 W unit has a documented recurring failure " +
    "pattern, a used SFF unit that shows the brief green-LED-then-dead symptom is very likely " +
    "to need a Dell-specific replacement rather than a generic one, which is harder to source.";
  assert(long.split(/\s+/).length > CELL_NOTE_WORDS);
  const doc = [
    "## Failure modes by subsystem",
    "| Subsystem | What goes wrong | Source |",
    "|---|---|---|",
    `| PSU | ${long} | [Source 13] |`,
    "| Fans | Dust accumulates in the vents | [Source 5] |",
    "",
    "## What the evidence does not settle",
  ].join("\n");
  // The judge condemns the long cell; the rewriter cannot mend it.
  const deps = {
    chat: (sys: string) =>
      sys.startsWith("You compare SENTENCES")
        ? Promise.resolve(JSON.stringify({ verdicts: ["UNSUPPORTED", "SAME"] }))
        : Promise.resolve(JSON.stringify({ fixed: {} })),
  } as unknown as Deps;
  const out = await checkRenderFidelity(keeps(deps), doc, PROBE_SYNTH);
  const lines = out.rendered.split("\n");
  const psuRow = lines.find((l) => l.startsWith("| PSU"))!;
  // The cell holds a marker, the row keeps its columns and its Source cell.
  assert(/see Note 1 below the table/.test(psuRow), psuRow);
  assertEquals(psuRow.split("|").length, doc.split("\n")[3].split("|").length);
  assert(/\[Source 13\]/.test(psuRow), psuRow);
  // The verbatim line is beneath the table, whole, with its citation - and
  // AFTER the last row, not in the middle of it.
  const noteAt = lines.findIndex((l) => l.startsWith("> **Note 1.**"));
  const lastRow = lines.findLastIndex((l) => l.startsWith("|"));
  assert(noteAt > lastRow, `note at ${noteAt}, last row at ${lastRow}`);
  assert(lines[noteAt].includes("makes it difficult for users to install aftermarket PSUs"), lines[noteAt]);
  assert(lines[noteAt].includes("[Source 13]"), lines[noteAt]);
  // Nothing was clipped to fit a column (K.9: never a word-clipping rule).
  assertEquals(out.record.replaced, 1);
  // …and the untouched row is untouched.
  assert(out.rendered.includes("| Fans | Dust accumulates in the vents | [Source 5] |"));
});

Deno.test("ACCEPTANCE 3: N and M are counted on the DELIVERED document", async () => {
  const doc = [
    "## Findings",
    "",
    "The proprietary connector makes fitting an aftermarket PSU difficult [Source 13].",
    "The vents accumulate dust, which Dell identifies as a cause of overheating [Source 5].",
  ].join("\n");
  const deps = {
    chat: (sys: string) =>
      sys.startsWith("You compare SENTENCES")
        ? Promise.resolve(JSON.stringify({ verdicts: ["SAME", "SAME"] }))
        : Promise.resolve("{}"),
  } as unknown as Deps;
  const out = await checkRenderFidelity(keeps(deps), doc, PROBE_SYNTH);
  assertEquals(out.record.units, countUnits(out.rendered));
  assertEquals(out.record.checked, 2);
  assertEquals(out.record.unchecked, 0);
  assert(out.record.checked <= out.record.units, "N exceeded M");
});

// ── The invariant the tester's T4 failure is about ─────────────────────────
//
// `normaliseCitations` used to run on the text that SHIPS. Moving a citation
// before the stop also ate the space after it, so a delivered document acquired
// "...services [Source 4, 5].The answer...", "e.g [Source 3].dust" and
// "approx [Source 2].180 W" - the checker editing the thing it was inspecting,
// on documents it had no correction to make to.
//
// Detection now reads a normalised VIEW of each unit and every edit is applied
// to the unit's ORIGINAL span. These two cases are the contract: nothing to
// correct means nothing changes, and a second pass changes nothing either.

// Each document WITH ITS OWN synthesis. Pairing them all with one synthesis was
// harmless while the check only judged claims; the names gate reads the
// evidence, so the wrong evidence makes every name in the document unearned and
// the checker "corrects" a document it should never have been shown.
const DOCS: Array<[string, string]> = [
  ["rendered-64ac38cf-buyers-guide.md", "live-owui-64ac38cf.result.json"],
  ["rendered-a337520c-scientific-paper.md", "dryrun-a337520c-100hz.result.json"],
  ["rendered-5ab36fe0-product-comparison.md", "job-5ab36fe0-git-vs-azuredevops.result.json"],
];
const synthesisOf = (n: string) => {
  const d = JSON.parse(fixtureDoc(n));
  return (d.result ?? d).synthesis as string;
};
// The run's own question. The check reads it, so a test that omits it is
// testing a different check: with query="" the gate flags the words of the
// question itself.
const queryOf = (n: string) => {
  const d = JSON.parse(fixtureDoc(n));
  return ((d.result ?? d).query ?? d.query ?? "") as string;
};
// INSIDE the submodule. Reading the parent repo's copy passed here and died
// the moment the suite ran with only this directory mounted - the same defect
// this workstream fixed one item ago, made again by the test that exists to
// stop documents being edited behind a reader's back.
const APPROVED = new URL("./fixtures/approved-document-64ac38cf.md", import.meta.url);
const fixtureDoc = (n: string) =>
  Deno.readTextFileSync(new URL(`./fixtures/${n}`, import.meta.url)).replace(/\r\n/g, "\n");

/** A judge that blesses everything, so the only thing under test is the writing. */
const blessBase = {
  chat: (sys: string, user: string) => {
    if (!sys.startsWith("You compare SENTENCES")) return Promise.resolve("{}");
    const n = (user.match(/^\d+\. SENTENCE:/gm) || []).length;
    return Promise.resolve(JSON.stringify({ verdicts: new Array(n).fill("SAME") }));
  },
} as unknown as Deps;
const blessAll = keeps(blessBase);

Deno.test("INVARIANT: a document with nothing to correct is returned BYTE-FOR-BYTE", async () => {
  for (const [name, src] of DOCS) {
    const doc = fixtureDoc(name);
    const out = await checkRenderFidelity(blessAll, doc, synthesisOf(src), queryOf(src));
    assertEquals(out.rendered, doc, `the checker edited ${name}, which it had no correction for`);
    assertEquals(out.record.rewritten + out.record.replaced, 0, name);
    assertEquals(out.record.names_blocked, [], name);
  }
});

Deno.test("the gate BLOCKS the names in the two documents kept as records", async () => {
  // The approved document and the attempt-1 ATX/SFX render are historical: they
  // were delivered before this gate existed and they stay exactly as they were.
  // What the gate has to say about them is asserted here instead.
  const cases: Array<[string, string, string[]]> = [
    ["approved-document-64ac38cf.md", "live-owui-64ac38cf.result.json", ["ESR", "HDD"]],
    ["rendered-AFTER-v1-33250e9b.md", "live-owui-33250e9b.result.json", ["ATX", "SFX"]],
  ];
  for (const [name, src, expected] of cases) {
    const doc = fixtureDoc(name).replace(/<!--[\s\S]*?-->/g, "").trim();
    const synthesis = synthesisOf(src);
    assertEquals(renderGroundingDiff(doc, synthesis, "").names, expected, name);
    // A rewriter that does its job removes them, and the record says which.
    const deps = {
      chat: (sys: string, user: string) => {
        if (sys.startsWith("You compare SENTENCES")) {
          const n = (user.match(/^\d+\. SENTENCE:/gm) || []).length;
          return Promise.resolve(JSON.stringify({ verdicts: new Array(n).fill("SAME") }));
        }
        // Strip the offending names out of each item, which is what the model is
        // asked to do; the mock does it mechanically so the TEST is about the
        // machinery and not about a model's willingness.
        const items = user.split(/\n(?=\d+\. SENTENCE: )/).filter((b) => /SENTENCE:/.test(b));
        const fixed: Record<string, string> = {};
        items.forEach((b, i) => {
          const line = (b.match(/SENTENCE: (.*)/) || [])[1] ?? "";
          let out = line;
          for (const n of expected) out = out.replace(new RegExp(`[^\\s]*${n}[^\\s]*`, "g"), "a part");
          if (out !== line) fixed[String(i + 1)] = out;
        });
        return Promise.resolve(JSON.stringify({ fixed }));
      },
    } as unknown as Deps;
    const out = await checkRenderFidelity(keeps(deps), doc, synthesis);
    assertEquals(out.record.names_blocked, expected, name);
    assertEquals(renderGroundingDiff(out.rendered, synthesis, "").names, [], name);
  }
});

Deno.test("INVARIANT: running the check on its own output changes nothing (idempotence)", async () => {
  for (const [name, src] of DOCS) {
    const doc = fixtureDoc(name);
    const synth = synthesisOf(src);
    const once = await checkRenderFidelity(blessAll, doc, synth, queryOf(src));
    const twice = await checkRenderFidelity(blessAll, once.rendered, synth, queryOf(src));
    assertEquals(twice.rendered, once.rendered, name);
    assertEquals(twice.record.units, once.record.units, name);
  }
});

Deno.test("INVARIANT: the three shapes the normaliser used to break", () => {
  // The tester's reproduction, as a unit: a VIEW may move the citation, and the
  // document may not. These are the exact strings from the evidence.
  const cases: Array<[string, string]> = [
    ["...offers integrated services. [Source 4, 5] The answer follows.",
     "...offers integrated services. [Source 4, 5] The answer follows."],
    ["Check the vents, e.g. [Source 3] dust and lint accumulation.",
     "Check the vents, e.g. [Source 3] dust and lint accumulation."],
    ["The unit draws approx. [Source 2] 180 W under load.",
     "The unit draws approx. [Source 2] 180 W under load."],
  ];
  for (const [input, expected] of cases) {
    // The view leaves them alone: a citation with text after it did not close a
    // sentence, so there is nothing to move.
    assertEquals(normaliseCitations(input), expected, input);
  }
  // …and the shape it IS for - a citation that ends the span - is moved in the
  // view only.
  assertEquals(
    normaliseCitations("The PSU makes it difficult to upgrade. [Source 13]"),
    "The PSU makes it difficult to upgrade [Source 13].",
  );
  // The five abbreviations, and two ordinary sentences, on ONE line.
  const line = "Fig. [Source 9] shows it. Acme Inc. [Source 2] ships it. Compare vs. [Source 4] " +
    "the other unit. The PSU fails on cold start [Source 7]. The fan is loud [Source 8].";
  const parts = splitSentences(line);
  assertEquals(parts, [
    "Fig. [Source 9] shows it.",
    "Acme Inc. [Source 2] ships it.",
    "Compare vs. [Source 4] the other unit.",
    "The PSU fails on cold start [Source 7].",
    "The fan is loud [Source 8].",
  ], JSON.stringify(parts));
  // Each abbreviation stayed INSIDE its sentence, and the two ordinary
  // sentences separated - no list of abbreviations anywhere.
});

Deno.test("X2: a bullet that wraps onto the next line is COUNTED, and never edited", () => {
  const doc = [
    "## What to check in person",
    "",
    "- [ ] Power the unit on and watch the rear LED for a brief flash, which is the",
    "  documented signature of the failing PSU [Source 11]",
    "- [ ] Inspect the CPU socket for bent pins before buying [Source 15]",
  ].join("\n");
  const units = citedUnits(doc);
  assertEquals(units.length, 2, JSON.stringify(units.map((u) => u.text)));
  const wrapped = units[0];
  assert(wrapped.text.includes("documented signature"), wrapped.text);
  assertEquals(wrapped.citations, [11]);
  // Counted in M - it was absent from M entirely before - and never edited,
  // because an edit addressed by line and cell cannot span two lines.
  assertEquals(wrapped.judgeable, false);
  assertEquals(countUnits(doc), 2);
  assertEquals(units[1].judgeable, true);
});

Deno.test("X2: a citation inside code is not a citation", () => {
  const doc = [
    "## How to use it",
    "",
    "Call the helper with the flag set [Source 3].",
    "",
    "```ts",
    'const x = fetch("/api"); // [Source 3] is not a claim',
    "```",
    "",
    "The inline form `run --source [Source 3]` is also not a claim.",
  ].join("\n");
  const units = citedUnits(doc);
  // The prose claim, and the inline-code line - which is a unit only because it
  // sits in an evidence section, and carries NO citations.
  assertEquals(units.filter((u) => u.citations.length).length, 1, JSON.stringify(units.map((u) => u.text)));
  assertEquals(units.filter((u) => u.citations.length)[0].text, "Call the helper with the flag set [Source 3].");
  assert(!units.some((u) => u.text.includes("const x = fetch")), "a fenced code line became a unit");
});

Deno.test("the wrapped bullet lands in `unchecked`, out loud", async () => {
  const doc = [
    "## What to check in person",
    "",
    "- [ ] Power the unit on and watch the rear LED for a brief flash, which is the",
    "  documented signature of the failing PSU [Source 11]",
    "- [ ] Inspect the CPU socket for bent pins before buying [Source 15]",
  ].join("\n");
  const synth = [
    "[SOURCED] The green LED on the failing PSU flashes briefly on a cold start. [Source 11]",
    "[SOURCED] The CPU socket pins are fragile and bend easily on inspection. [Source 15]",
  ].join("\n");
  const out = await checkRenderFidelity(blessAll, doc, synth);
  assertEquals(out.rendered, doc);
  assertEquals(out.record.units, 2);
  assertEquals(out.record.checked, 1);
  assertEquals(out.record.unchecked, 1);
});

// ── The names gate (research-trust-names) ─────────────────────────────────
//
// `renderGroundingDiff` has been REPORTING invented names for three items -
// ATX and SFX, then BSOD, then OEM - into a field on a job row that the reader
// of the report never sees. The measurement now has teeth: a unit that uses a
// name the grounded answer never uses is UNSUPPORTED before any judge is asked.

const NAME_SYNTH = [
  "[SOURCED] The Dell OptiPlex 3050 SFF uses a proprietary power supply and a proprietary power " +
  "connector, which makes it difficult for users to install aftermarket PSUs. [Source 13]",
  "[SOURCED] General motherboard-failure guidance notes that a failed POST, unexplained shutdowns " +
  "and Blue Screen of Death errors can point to a defective motherboard. [Source 3]",
  "[GAP] Are there capacitor failures (bulging, leaking, or ESR-degraded capacitors) on this board?",
].join("\n");

Deno.test("ACCEPTANCE: an abbreviation whose EXPANSION is in the evidence is not blocked", () => {
  // BSOD is not in the synthesis; "Blue Screen of Death" is. A report that
  // abbreviates a phrase its sources spell out has invented nothing, and this
  // is decided by an expansion match rather than by a list of abbreviations -
  // the fifth surface-string list this workstream would have shipped.
  assertEquals(expansionMatch("BSOD", NAME_SYNTH), true);
  const doc = "## Findings\n\nA failed POST or a BSOD can indicate a defective motherboard [Source 3].";
  assertEquals(renderGroundingDiff(doc, NAME_SYNTH, "").names, []);

  // …and an unrelated acronym with no expansion anywhere IS blocked.
  assertEquals(expansionMatch("HTC", NAME_SYNTH), false);
  const bad = "## Findings\n\nA failed POST on an HTC headset indicates a defective board [Source 3].";
  assertEquals(renderGroundingDiff(bad, NAME_SYNTH, "").names, ["HTC"]);
  // The whole-word half of the match, too: a name the evidence writes out.
  assertEquals(expansionMatch("PSUs", NAME_SYNTH), true);
});

Deno.test("ACCEPTANCE: a unit using an unearned name is UNSUPPORTED before any judge", async () => {
  const doc = "## What the evidence does not settle\n\n" +
    "The proprietary connector makes substitution difficult [Source 13], but the availability of " +
    "an OEM replacement part is left open.";
  let asked = 0;
  const deps = {
    chat: (sys: string, user: string) => {
      if (sys.startsWith("You compare SENTENCES")) {
        asked++;
        const n = (user.match(/^\d+\. SENTENCE:/gm) || []).length;
        // The judge BLESSES it - and the gate blocks it anyway.
        return Promise.resolve(JSON.stringify({ verdicts: new Array(n).fill("SAME") }));
      }
      // The rewriter is told which name offends.
      assert(/NAMES THE EVIDENCE NEVER USES/.test(user), user.slice(0, 200));
      assert(/OEM/.test(user));
      return Promise.resolve(JSON.stringify({
        fixed: { "1": "The proprietary connector makes substitution difficult [Source 13]." },
      }));
    },
  } as unknown as Deps;
  const out = await checkRenderFidelity(keeps(deps), doc, NAME_SYNTH);
  assert(asked > 0, "the judge was never asked");
  assertEquals(out.record.names_blocked, ["OEM"]);
  assert(!/OEM/.test(out.rendered), out.rendered);
  assertEquals(renderGroundingDiff(out.rendered, NAME_SYNTH, "").names, []);
});

Deno.test("a [GAP] line is the synthesizer's words, not a source's - the limitations list is gated", () => {
  // The decision, stated: ESR appears in the synthesis, but only in a [GAP]
  // line, which is the synthesizer's account of what it could NOT find. A
  // report that carries that name into its limitations list is using a word no
  // source used. Live run a205845d did exactly this with "non-OEM".
  assert(/ESR/.test(NAME_SYNTH), "the fixture lost its [GAP] line");
  const doc = "## Limitations and open questions\n\n" +
    "- Are there capacitor failures (bulging, leaking, or ESR-degraded capacitors) on this board?";
  assertEquals(renderGroundingDiff(doc, NAME_SYNTH, "").names, ["ESR"]);
  // …and the line is presented to the check even though a [GAP] question is
  // never judged for its CLAIMS.
  assertEquals(namesIn(doc, ["ESR"]), ["ESR"]);
});

Deno.test("an open question is rewritten, never answered with evidence", async () => {
  const doc = "## Limitations and open questions\n\n" +
    "- Are there capacitor failures (bulging, leaking, or ESR-degraded capacitors) on this board?";
  const deps = {
    chat: (sys: string) =>
      sys.startsWith("You compare SENTENCES")
        ? Promise.resolve(JSON.stringify({ verdicts: ["UNSUPPORTED"] }))
        // The rewriter declines, twice.
        : Promise.resolve(JSON.stringify({ fixed: {} })),
  } as unknown as Deps;
  const out = await checkRenderFidelity(keeps(deps), doc, NAME_SYNTH);
  // The question survives - no grounded line is pasted over it - and the name
  // is NOT counted as blocked, because it is still there. "Blocked" is a claim
  // about the delivered document.
  assert(/Are there capacitor failures/.test(out.rendered), out.rendered);
  assert(!/\[SOURCED\]|\[Source \d/.test(out.rendered), out.rendered);
  assertEquals(out.record.names_blocked, []);
});

// ── Per-sentence correction inside a coarse unit ──────────────────────────

Deno.test("ACCEPTANCE: only the failing sentence of a coarse unit is replaced", async () => {
  // The tester's sample. One span, two sentences, two citations: a mid-line
  // citation gives the checker one unit covering both, and replacing the span
  // would rewrite a sentence nobody complained about.
  const doc = "## Findings\n\n" +
    "The PSU fails with a brief green LED. [Source 7] The connector is proprietary [Source 13].";
  const synth = [
    "[SOURCED] The PSU fails with a brief green LED on a cold start. [Source 7]",
    "[SOURCED] The Dell OptiPlex 3050 SFF uses a proprietary power supply and a proprietary power " +
    "connector, which makes it difficult for users to install aftermarket PSUs. [Source 13]",
  ].join("\n");
  assertEquals(citedUnits(doc).length, 1, "the span should be ONE coarse unit");

  const seen: string[][] = [];
  const deps = {
    chat: (sys: string, user: string) => {
      if (sys.startsWith("You compare SENTENCES")) {
        const items = (user.match(/^\d+\. SENTENCE: (.*)$/gm) || []).map((l) => l.replace(/^\d+\. SENTENCE: /, ""));
        seen.push(items);
        // First call: the whole span, condemned. Second: per sentence - only
        // the SECOND sentence is wrong.
        if (items.length === 1) return Promise.resolve(JSON.stringify({ verdicts: ["STRONGER"] }));
        return Promise.resolve(JSON.stringify({
          verdicts: items.map((t) => /connector/.test(t) ? "STRONGER" : "SAME"),
        }));
      }
      return Promise.resolve(JSON.stringify({ fixed: {} }));   // no rewrite: fall to verbatim
    },
  } as unknown as Deps;
  const out = await checkRenderFidelity(keeps(deps), doc, synth);
  // The judge WAS re-asked per sentence.
  assert(seen.some((items) => items.length === 2), JSON.stringify(seen));
  // The first sentence is byte-identical; only the second was replaced.
  assert(out.rendered.includes("The PSU fails with a brief green LED. [Source 7]"), out.rendered);
  assert(!out.rendered.includes("The connector is proprietary [Source 13]."), out.rendered);
  assert(out.rendered.includes("makes it difficult for users to install aftermarket PSUs"), out.rendered);
  assertEquals(out.record.replaced, 1);
});

Deno.test("a coarse unit whose every sentence fails is corrected whole", async () => {
  const doc = "## Findings\n\nThe PSU never fails. [Source 7] The connector is universal [Source 13].";
  const synth = "[SOURCED] The PSU fails with a brief green LED on a cold start. [Source 7]";
  const deps = {
    chat: (sys: string, user: string) => {
      if (sys.startsWith("You compare SENTENCES")) {
        const n = (user.match(/^\d+\. SENTENCE:/gm) || []).length;
        return Promise.resolve(JSON.stringify({ verdicts: new Array(n).fill("STRONGER") }));
      }
      return Promise.resolve(JSON.stringify({ fixed: {} }));
    },
  } as unknown as Deps;
  const out = await checkRenderFidelity(keeps(deps), doc, synth);
  // One grounded line replaces the span, rather than two copies of it.
  assertEquals((out.rendered.match(/brief green LED on a cold start/g) || []).length, 1, out.rendered);
});

Deno.test("the footer says how many names were blocked, and only when there were any", () => {
  const needs = [{ need: "a", status: "answered" as const }];
  const rec = { checked: 44, units: 44, unchecked: 0, rewritten: 2, replaced: 1 };
  assertStringIncludes(
    coverageFooter(needs as never, emptySearchRecord(), "complete", null,
      { ...rec, names_blocked: ["ESR", "HDD", "OEM"] }),
    "render checked: 44 of 44, 3 corrected, 0 unchecked \u00b7 names: 3 blocked",
  );
  const quiet = coverageFooter(needs as never, emptySearchRecord(), "complete", null,
    { ...rec, names_blocked: [] });
  assertEquals(/names:/.test(quiet), false, quiet);
});

// ── POLARITY (research-trust-names attempt 3) ──────────────────────────────
//
// What shipped, and what the tester found live: under "What the evidence does
// not settle", sentences saying what the sources do NOT establish were replaced
// by verbatim grounded lines asserting what they DO. The judge reads an absence
// sentence, the lines it cites state positives, the verdict is UNSUPPORTED, and
// the fallback pastes a positive line in - a polarity inversion under a
// citation, in the section whose whole purpose is the opposite.
//
// The three cases below are the tester's, verbatim.

const POLARITY_SYNTH = [
  "[SOURCED] GitLab is described as an enterprise-grade DevOps platform that goes beyond Git " +
  "repository management, integrating issue tracking, CI/CD, code review and security testing. [Source 2]",
  "[INFERRED] The pattern seen in GitLab is analogous to what Azure DevOps does with its " +
  "Repos/Boards/Pipelines triad, representing a broader ALM platform rather than a bare git host. [Source 2]",
  "[SOURCED] VR motion sickness is attributed to a sensory conflict between visual, vestibular " +
  "and proprioceptive signals integrated in the brainstem and cerebellum, as shown by EEG and " +
  "GVS studies of the conflict state. [Source 1, 11, 12, 15]",
  "[UNCERTAIN] Whether the 100 Hz effect is additive with other VR-specific countermeasures is " +
  "not addressed in any provided source. [Source 11, 12]",
  "[GAP] No provided source traces the resolution pathway after the conflict state.",
].join("\n");

/** No synthesis tag may ever reach a reader. */
const TAGGED_START = new RegExp("^\\[(SOURCED|INFERRED|GAP|UNCERTAIN)\\]");

/** A judge that condemns everything, which is what produced all three defects. */
const condemnBase = {
  chat: (sys: string, user: string) => {
    if (sys.startsWith("You compare SENTENCES")) {
      const n = (user.match(/^\d+\. SENTENCE:/gm) || []).length;
      return Promise.resolve(JSON.stringify({ verdicts: new Array(n).fill("UNSUPPORTED") }));
    }
    return Promise.resolve(JSON.stringify({ fixed: {} }));   // no rewrite: fall to verbatim
  },
} as unknown as Deps;
/** …and a flip judge that refuses every correction, which is the verdict every
 *  one of the landed inversions should have drawn. */
const condemnAll = flips(condemnBase);
/** The other side: the same condemning judge with a flip judge that says KEEP,
 *  so a sentence that SHOULD be corrected is seen to be corrected. */
const condemnKeeping = keeps(condemnBase);

Deno.test("POLARITY: an absence sentence is never replaced by an assertion", async () => {
  // 1. product-comparison. The delivered document lost this sentence and gained
  //    an [INFERRED] claim about what Azure DevOps IS - leaving the next
  //    sentence's "The sources ALSO do not address…" with no antecedent.
  const doc = [
    "## What the evidence does not settle",
    "",
    "However, the evidence does not describe the specific Azure DevOps components that would " +
    "differentiate day-to-day use, including the distinction between YAML pipeline-as-code and " +
    "classic UI-based release pipelines [Source 2].",
  ].join("\n");
  const out = await checkRenderFidelity(condemnAll, doc, POLARITY_SYNTH);
  assertEquals(out.rendered, doc, "an absence sentence was rewritten into something else");
  assert(!out.rendered.includes("analogous to what Azure DevOps does"), out.rendered);
  assertEquals(out.record.polarity_skipped >= 1, true, JSON.stringify(out.record));
});

Deno.test("POLARITY: the two scientific-paper sentences, which carried NO flagged name", async () => {
  // 2. "…do not trace the resolution pathway" became a background claim about
  //    what causes the conflict state. 3. "It is unclear whether the effects are
  //    additive, redundant, or potentially antagonistic" became a near-duplicate
  //    of the sentence before it, with three possibilities flattened to one.
  for (const sentence of [
    "The EEG and GVS data [Source 1, 2] characterize the conflict state but do not trace the resolution pathway.",
    "It is unclear whether the effects are additive, redundant, or potentially antagonistic [Source 11, 12].",
  ]) {
    const doc = `## Findings\n\n${sentence}`;
    assertEquals(polarityOf(sentence), "absence", sentence);
    const out = await checkRenderFidelity(condemnAll, doc, POLARITY_SYNTH);
    const after = out.rendered.split("\n").pop() ?? "";
    // The rule is "never FLIP", not "never touch": what stands where an absence
    // stood must still be an absence, and it may never be one of the POSITIVE
    // lines the old fallback reached for.
    assertEquals(polarityOf(after), "absence", `${sentence}\n  -> ${after}`);
    assert(!after.includes("attributed to a sensory conflict"), after);
    assert(!after.includes("analogous to what Azure DevOps does"), after);
    assert(!TAGGED_START.test(after), `a tag reached the reader: ${after}`);
  }
});

Deno.test("POLARITY: an absence MAY be replaced by an absence - a [GAP] or [UNCERTAIN] line", async () => {
  // The rule is not "never touch an absence": it is "never flip it". A
  // same-polarity replacement is allowed, and it is the only one that is.
  const doc = "## What the evidence does not settle\n\n" +
    "No source traces the resolution pathway after the conflict state is reached, and none " +
    "describes what follows [Source 1].";
  const cands = absenceLines(POLARITY_SYNTH);
  assertEquals(cands.length, 2, JSON.stringify(cands));
  assert(cands.every((l) => /^\[(GAP|UNCERTAIN)\]/.test(l)), JSON.stringify(cands));
  const out = await checkRenderFidelity(condemnAll, doc, POLARITY_SYNTH);
  // Whatever it did, what stands is still a statement of absence.
  assertEquals(polarityOf(out.rendered.split("\n").pop() ?? ""), "absence", out.rendered);
});

Deno.test("POLARITY: an ordinary negative CLAIM is still corrected", () => {
  // The distinction is the SUBJECT, not the grammar. "The PSU never fails" is a
  // world claim that happens to be negative, and correcting it is this module's
  // job; "the sources do not describe X" is a claim about the evidence.
  // A world claim needs a findings SECTION to be recognised as one: with no
  // section at all the conservative default applies, which is the whole point
  // of the rule - a document with no headings is judged safely, not loosely.
  assertEquals(polarityOf("The PSU never fails. [Source 7]", "Findings"), "assertion");
  assertEquals(polarityOf("The PSU never fails. [Source 7]"), "absence");
  assertEquals(polarityOf("The connector is universal [Source 13]."), "assertion");
  assertEquals(polarityOf("The sources do not describe the build agents [Source 2]."), "absence");
  assertEquals(polarityOf("It is unclear whether the effects are additive."), "absence");
  // …and a caveat TAIL does not turn a finding into an absence.
  assertEquals(
    polarityOf("The unit uses a proprietary connector, though no source confirms a replacement."),
    "assertion",
  );
  // A SECTION decides it on its own.
  assertEquals(polarityOf("Anything at all.", "What the evidence does not settle"), "absence");
  assertEquals(polarityOf("Anything at all.", "Limitations and open questions"), "absence");
  assertEquals(polarityOf("Anything at all.", "Findings"), "assertion");
});

// ── ONE reference for the gate and the reporter ───────────────────────────

Deno.test("a name from the USER'S OWN QUESTION is not an invented name", async () => {
  // The gate passed query="" and the reporter the real query, so the gate
  // blocked "TFVC" and "UI" - words of the question the person asked - that the
  // reader-facing report would never have flagged. Two numbers about names,
  // able to disagree by construction.
  const synthesis = "[SOURCED] Azure DevOps pipelines are YAML files committed in the repository. [Source 3]";
  const query = "What is the distinction between Azure Repos Git and TFVC, and the UI-based pipelines?";
  const doc = "## Findings\n\nThe distinction between Azure Repos Git and TFVC is not described [Source 3].";
  assertEquals(renderGroundingDiff(doc, synthesis, "").names, ["TFVC"]);
  assertEquals(renderGroundingDiff(doc, synthesis, query).names, []);
  const out = await checkRenderFidelity(condemnAll, doc, synthesis, query);
  assertEquals(out.record.names_blocked, []);
});

Deno.test("the footer's blocked names and prose_ungrounded cannot disagree", async () => {
  // Both sides read the same reference now. Whatever the gate blocks must be
  // absent from what the reporter flags on the delivered document, and whatever
  // the reporter still flags must not be counted as blocked.
  const synthesis = "[SOURCED] The unit uses a proprietary power supply. [Source 13]";
  const query = "what about the PSU";
  const doc = "## Findings\n\nThe unit ships with an ATX power supply [Source 13].";
  const deps = {
    chat: (sys: string, user: string) => {
      if (sys.startsWith("You compare SENTENCES")) {
        const n = (user.match(/^\d+\. SENTENCE:/gm) || []).length;
        return Promise.resolve(JSON.stringify({ verdicts: new Array(n).fill("SAME") }));
      }
      return Promise.resolve(JSON.stringify({
        fixed: { "1": "The unit uses a proprietary power supply [Source 13]." },
      }));
    },
  } as unknown as Deps;
  const out = await checkRenderFidelity(keeps(deps), doc, synthesis, query);
  const stillFlagged = renderGroundingDiff(out.rendered, synthesis, query).names;
  assertEquals(out.record.names_blocked, ["ATX"]);
  assertEquals(stillFlagged, []);
  for (const n of out.record.names_blocked) assert(!stillFlagged.includes(n), n);
});

// ── The default is ABSENCE (attempt 4) ────────────────────────────────────
//
// Attempt 3 decided absence only when a fixed list of evidence nouns fired, and
// a miss was NOT conservative: the unit went down the ordinary path where a
// [SOURCED] line replaced it. The tester ran 21 probes and six missed that way,
// two of them from this plan's own attack list; the sharpest was POLARITY test
// 2 with one noun changed - "data" -> "recordings" - which reproduced the
// attempt-2 inversion with `polarity_skipped: 0`, the guard never engaging and
// nothing able to say so.
//
// Every one of the tester's probes is pinned here, with the verdict AND the
// reason it was reached.

Deno.test("POLARITY: the six probes attempt 3 classified as assertions", () => {
  const probes: Array<[string, string]> = [
    ["The manual does not document a replacement procedure.", "evidence-noun"],
    ["The Owner's Manual does not document the SFF PSU part number.", "evidence-noun"],
    ["Contamination cannot be ruled out.", "default-absence"],
    ["It does not say whether the unit was tested.", "default-absence"],
    ["Nothing in the record confirms the 7th-gen ceiling.", "evidence-noun"],
    ["The report does not state a figure, but the manual does.", "evidence-noun"],
  ];
  for (const [text, source] of probes) {
    const v = polarityVerdict(text, "Findings");
    assertEquals(v.polarity, "absence", text);
    assertEquals(v.source, source, `${text} -> ${v.source}`);
  }
});

Deno.test("POLARITY: the synonym that reproduced the inversion", async () => {
  // One noun changed from the pinned sentence. Under attempt 3 this was an
  // assertion and was replaced by "VR motion sickness is attributed to a
  // sensory conflict…" - the attempt-2 defect, by synonym.
  for (const noun of ["data", "recordings", "measurements", "traces", "logs"]) {
    const sentence =
      `The EEG and GVS ${noun} [Source 1, 2] characterize the conflict state but do not trace ` +
      "the resolution pathway.";
    const v = polarityVerdict(sentence, "Findings");
    assertEquals(v.polarity, "absence", `${noun}: ${v.source}`);
    const out = await checkRenderFidelity(condemnAll, `## Findings\n\n${sentence}`, POLARITY_SYNTH);
    const after = out.rendered.split("\n").pop() ?? "";
    assertEquals(polarityOf(after, "Findings"), "absence", after);
    assert(!after.includes("attributed to a sensory conflict"), `${noun}: ${after}`);
  }
});

Deno.test("POLARITY: the plan's own attack list lands on the safe side", () => {
  const cases: Array<[string, string, Polarity]> = [
    // a double negative
    ["It is not the case that no source documents the ceiling.", "Findings", "absence"],
    // an absence whose evidence noun is a pronoun
    ["It does not say which BIOS version shipped.", "Findings", "absence"],
    // a positive sentence inside the limitations section
    ["The chassis is steel and the PSU is 180 W.", "Limitations and open questions", "absence"],
    // a table cell that is an absence
    ["Not described in the sources", "Failure modes by subsystem", "absence"],
    // "is not addressed" -> "is addressed"
    ["The question is addressed in two sources.", "Findings", "assertion"],
    // a heading-less document falls to the DEFAULT, not to the loose path
    ["The recordings do not trace the pathway.", "", "absence"],
  ];
  for (const [text, section, want] of cases) {
    assertEquals(polarityOf(text, section), want, `${section}: ${text}`);
  }
});

Deno.test("POLARITY: the narrow world-marker, and how narrow it is", () => {
  // It fires only for a negated NON-epistemic predicate about a concrete
  // subject, in a findings section, with no evidence noun anywhere.
  assertEquals(polarityVerdict("The PSU never fails.", "Findings").source, "world-marker");
  assertEquals(polarityVerdict("The unit does not support Windows 11.", "Findings").source, "world-marker");
  // …and every way of falling short lands on absence:
  assertEquals(polarityVerdict("It never fails.", "Findings").source, "default-absence");          // pronoun
  assertEquals(polarityVerdict("The manual never fails.", "Findings").source, "evidence-noun");     // evidence noun
  assertEquals(polarityVerdict("The PSU does not describe the fault.", "Findings").source, "default-absence"); // epistemic verb
  assertEquals(polarityVerdict("The PSU never fails.", "").source, "default-absence");              // no section
  assertEquals(polarityVerdict("The PSU never fails.", "Limitations and open questions").source, "heading");
});

Deno.test("POLARITY: every unit's decision is RECORDED, and every refusal is counted ONCE", async () => {
  const doc = [
    "## Findings",
    "",
    "The PSU fails on a cold start [Source 7].",
    "The recordings do not trace the resolution pathway [Source 1].",
    "",
    "## What the evidence does not settle",
    "",
    "The capacitor failure rate on this platform is stated nowhere in the material.",
  ].join("\n");
  const out = await checkRenderFidelity(condemnAll, doc, POLARITY_SYNTH);
  // The census follows the DECIDER. A unit put to the flip judge is recorded as
  // "judge" and leaves the lexical bucket it was provisionally filed under, so
  // the lexical keys that remain are exactly the units the fast path settled
  // without a call - and the total is still one entry per unit.
  const sources = out.record.polarity_sources;
  assertEquals(Object.values(sources).reduce((a, b) => a + b, 0), out.record.units);
  assert((sources["judge"] ?? 0) >= 1, JSON.stringify(sources));
  // EVERY condemned unit that ends uncorrected is counted exactly once, across
  // the three reasons - and each one comes OUT of the checked count, so it is
  // visible in the footer's U. Attempt 4 could refuse a correction and still
  // report "checked 1 of 1, unchecked 0".
  const left = out.record.polarity_skipped + out.record.duplicate_skipped + out.record.no_candidate;
  assertEquals(left, 2, JSON.stringify(out.record));
  // Three units, two of them judged and both left as written. The third - the
  // [Source 7] sentence, whose citation matches no grounded line - was never
  // judged at all and is counted unchecked for that reason, not as a refusal.
  assertEquals([out.record.units, out.record.checked, out.record.unchecked], [3, 0, 3], JSON.stringify(out.record));
  assertEquals(out.record.rewritten + out.record.replaced, 0, JSON.stringify(out.record));
  assert(out.record.polarity_default <= out.record.polarity_skipped);
});

Deno.test("a duplication is not a polarity refusal", async () => {
  // The tester's honesty nit: attempt 3 booked a duplicate skip to
  // `polarity_skipped`, so that counter over-reported polarity as the cause.
  const line = "The Dell OptiPlex 3050 SFF uses a proprietary power supply and a proprietary " +
    "power connector, which makes it difficult for users to install aftermarket PSUs.";
  const doc = ["## Findings", "", line + " [Source 13]", "", "The connector is standard [Source 13]."].join("\n");
  const synth = `[SOURCED] ${line} [Source 13]`;
  const out = await checkRenderFidelity(condemnAll, doc, synth);
  assertEquals(out.record.duplicate_skipped >= 1, true, JSON.stringify(out.record));
  assertEquals(out.record.polarity_skipped, 0, JSON.stringify(out.record));
});

Deno.test("a NEAR-duplicate is refused too, not only an exact one", async () => {
  // The third row of T3b's own defect table survived attempt 3: the replacement
  // differed from the sentence above it by a parenthetical and a figure
  // annotation, and an exact-substring test cannot see that.
  const above = "The interaction between 100 Hz sound and other VR countermeasures is not " +
    "addressed in any provided source [Source 11, 12].";
  const unit = "It is unclear whether the effects are additive, redundant, or antagonistic [Source 11].";
  const doc = ["## Findings", "", above, unit].join("\n");
  const synth = "[UNCERTAIN] Whether the 100 Hz effect is additive with other VR-specific " +
    "countermeasures (e.g., high frame rates, vignetting) is not addressed in any provided " +
    "source. (unverified figure: 100) [Source 11, 12]";
  // KEEP throughout, so the only thing that can refuse the paste is the
  // duplicate check - which is what this test is about.
  const out = await checkRenderFidelity(condemnKeeping, doc, synth);
  const after = out.rendered.split("\n").pop() ?? "";
  assertEquals(after, unit, "a near-duplicate was pasted under the sentence it duplicates");
  assertEquals(out.record.duplicate_skipped, 1, JSON.stringify(out.record));
});

// -- THE FLIP JUDGE (attempt 5) ---------------------------------------------
//
// Three lexicons failed in a row - evidence nouns, a negation list, and an
// absence-by-default with a narrow world-marker - and each time the tester
// found sentences the words could not see. The words no longer decide: every
// correction, rewrite or verbatim, is put to the judge first, and FLIP or an
// unusable answer leaves the sentence exactly as written.
//
// These are the sentences that LANDED in delivered documents, end to end.

/** The judge's answer, scripted, with a note of what it was shown. */
function flipSpy(verdict: "FLIP" | "KEEP", inner = condemnBase) {
  const seen: string[] = [];
  const deps = {
    ...inner,
    chat: (sys: string, user: string, opts?: { json?: boolean; nothink?: boolean }) => {
      if (sys.startsWith(FLIP_SYS_HEAD)) {
        seen.push(user);
        return Promise.resolve(JSON.stringify({ verdict }));
      }
      return inner.chat(sys, user, opts);
    },
  } as unknown as Deps;
  return { deps, seen };
}

Deno.test("FLIP: the judge's prompt carries BOTH examples, and an unusable answer is a refusal", () => {
  // The distinction the prompt has to draw, drawn by example in the prompt
  // itself: a false claim about the WORLD may be corrected toward the evidence;
  // a claim about what the EVIDENCE settles may not be inverted.
  assertStringIncludes(FLIP_JUDGE_SYS, "Scarcely any of the sources quantify the failure rate.");
  assertStringIncludes(FLIP_JUDGE_SYS, "The PSU is not proprietary.");
  assertStringIncludes(FLIP_JUDGE_SYS, "The test is the SUBJECT of the sentence, not its grammar.");
  // Only a clean KEEP is a KEEP. Everything else - a FLIP, an empty answer,
  // prose, a truncated object, a different word - leaves the sentence alone.
  assertEquals(parseFlip(JSON.stringify({ verdict: "KEEP" })), "KEEP");
  assertEquals(parseFlip(JSON.stringify({ verdict: "keep" })), "KEEP");
  const unusable = ["", "{}", "KEEP", "{\"verdict\":", "I think it is fine",
    JSON.stringify({ verdict: "FLIP" })];
  for (const bad of unusable) assertEquals(parseFlip(bad), "FLIP", bad);
});

Deno.test("FLIP: the five sentences the tester landed, and the plan's own example", async () => {
  // Every one of these was replaced by a line asserting what it denied, under a
  // guard that recorded `polarity_skipped: 0` while it happened. None of them
  // trips any lexicon; all of them are put to the judge.
  const landed = [
    "Scarcely any of the sources quantify the failure rate [Source 11].",
    "Whether 100 Hz helps is far from settled [Source 11].",
    "The resolution pathway is hardly documented anywhere [Source 1].",
    "Does any provided source trace the resolution pathway [Source 1]?",
    "The readings do not capture the resolution pathway [Source 1].",
    // the plan's own escape-hatch example, aimed at the world-marker
    "The trace does not include the fault [Source 1].",
  ];
  for (const sentence of landed) {
    const doc = `## Findings\n\n${sentence}`;
    const { deps, seen } = flipSpy("FLIP");
    const out = await checkRenderFidelity(deps, doc, POLARITY_SYNTH);
    assertEquals(out.rendered, doc, `the check edited: ${sentence}`);
    assertEquals(seen.length >= 1, true, `the judge was never asked about: ${sentence}`);
    assertStringIncludes(seen[0], "ORIGINAL:");
    assertStringIncludes(seen[0], "CORRECTION:");
    // ...and the refusal is COUNTED, and the sentence leaves the checked count.
    assertEquals(out.record.polarity_skipped, 1, `${sentence} -> ${JSON.stringify(out.record)}`);
    assertEquals([out.record.checked, out.record.unchecked], [0, 1], sentence);
  }
});

Deno.test("FLIP: the over-protection side - a false claim about the WORLD is still corrected", async () => {
  // The other half of the bidirectional test. A world negative that contradicts
  // its own cited line is exactly what this module exists to repair; a guard
  // that protects it has stopped doing its job.
  const synth = [
    "[SOURCED] The Dell OptiPlex 3050 SFF supports up to 32 GB of DDR4-2400 RAM across two DIMM slots. [Source 13]",
    "[SOURCED] The Dell OptiPlex 3050 SFF uses a proprietary power supply and a proprietary power connector. [Source 14]",
  ].join("\n");
  const prose = [
    ["The unit does not support DDR4-3200 [Source 13].", "supports up to 32 GB of DDR4-2400"],
    ["The PSU is not proprietary [Source 14].", "uses a proprietary power supply"],
  ];
  for (const [sentence, want] of prose) {
    const { deps } = flipSpy("KEEP");
    const out = await checkRenderFidelity(deps, `## Findings\n\n${sentence}`, synth);
    assertStringIncludes(out.rendered, want);
    assertEquals(out.record.polarity_skipped, 0, JSON.stringify(out.record));
    assertEquals(out.record.replaced, 1, JSON.stringify(out.record));
  }
  // ...and the same inside a TABLE cell, which is where a flip is hardest to see.
  const table = [
    "## Failure modes by subsystem",
    "",
    "| Subsystem | What goes wrong | Source |",
    "|---|---|---|",
    "| Power | The PSU is not proprietary | [Source 14] |",
  ].join("\n");
  const { deps } = flipSpy("KEEP");
  const cell = await checkRenderFidelity(deps, table, synth);
  assert(!/not proprietary/.test(cell.rendered), cell.rendered);
  assertEquals(cell.record.replaced, 1, JSON.stringify(cell.record));
});

Deno.test("FLIP: a condemned sentence nothing could correct is COUNTED, and the footer says so", async () => {
  // "No bent pins were reported" against a synthesis with no [GAP] or
  // [UNCERTAIN] line at all. Attempt 4 left it standing - correctly - and then
  // recorded "checked 1 of 1, unchecked 0" and printed no clause: the
  // disclosure went silent exactly where nothing could be done.
  const synth = "[SOURCED] A community user reported bent processor pins on an OptiPlex 3050 motherboard. [Source 14]";
  assertEquals(absenceLines(synth), []);
  const doc = "## Findings\n\nNo bent pins were reported [Source 14].";
  const { deps } = flipSpy("FLIP");
  const out = await checkRenderFidelity(deps, doc, synth);
  assertEquals(out.rendered, doc);
  assertEquals([out.record.units, out.record.checked, out.record.unchecked], [1, 0, 1], JSON.stringify(out.record));
  assertEquals(out.record.polarity_skipped, 1, JSON.stringify(out.record));
  // ...and the reader is told, in the one line they actually see.
  const footer = coverageFooter(
    [{ need: "bent pins", status: "answered" }] as never, emptySearchRecord(), "complete", null,
    out.record,
  );
  assertStringIncludes(footer, "render checked: 0 of 1, 0 corrected, 1 unchecked");
  assertStringIncludes(footer, "left as written: 1 (1 would invert, 0 already said, 0 nothing to cite)");
});

Deno.test("FLIP: a judge that ERRORS refuses, and a unit with no candidate at all is counted", async () => {
  // An error is not a blessing. The engine may not decide a flip by failing to
  // ask about it.
  const broken = {
    ...condemnBase,
    chat: (sys: string, user: string, opts?: { json?: boolean; nothink?: boolean }) =>
      sys.startsWith(FLIP_SYS_HEAD)
        ? Promise.reject(new Error("the judge is down"))
        : condemnBase.chat(sys, user, opts),
  } as unknown as Deps;
  const doc = "## Findings\n\nThe readings do not capture the resolution pathway [Source 1].";
  const out = await checkRenderFidelity(broken, doc, POLARITY_SYNTH);
  assertEquals(out.rendered, doc);
  assertEquals(out.record.polarity_skipped, 1, JSON.stringify(out.record));

  // ...and a sentence with nothing in the evidence to correct it with is counted
  // under its own reason, not as a polarity refusal.
  const orphan = "## Findings by area\n\nThe unit is impossible to upgrade and always fails within a year.";
  const alone = await checkRenderFidelity(condemnAll, orphan, POLARITY_SYNTH);
  assertEquals(alone.rendered, orphan);
  assertEquals([alone.record.no_candidate, alone.record.polarity_skipped], [1, 0], JSON.stringify(alone.record));
  assertEquals(alone.record.unchecked, 1, JSON.stringify(alone.record));
});

Deno.test("FLIP: the stutter the overlap test cannot see is refused by the JUDGE", async () => {
  // The real pair, from the 100 Hz render: the replacement and the sentence
  // beside it share 6 content words of 10, under the 0.7 the near-duplicate
  // test needs, and the delivered document ended with both. The polarity guard
  // happened to block it in attempt 4; with the judge deciding polarity it is
  // KEEP, so the duplication has to be caught as a duplication.
  const above = "The interaction between 100 Hz sound stimulation and other VR-specific " +
    "countermeasures (high frame rates, reduced artificial locomotion, vignetting) is not " +
    "addressed in any provided source [Source 11, 12].";
  const unit = "It is unclear whether the effects are additive, redundant, or potentially " +
    "antagonistic [Source 11, 12].";
  const doc = ["## What the evidence does not settle", "", `${above} ${unit}`].join("\n");
  const synth = "[UNCERTAIN] Whether the 100 Hz effect is additive with other VR-specific " +
    "countermeasures (e.g., high frame rates, reduced artificial locomotion, vignetting) is not " +
    "addressed in any provided source. (unverified figure: 100) [Source 11, 12]";
  let sawNeighbour = false;
  const deps = {
    ...condemnBase,
    chat: (sys: string, user: string, opts?: { json?: boolean; nothink?: boolean }) => {
      if (sys.startsWith(FLIP_SYS_HEAD)) {
        sawNeighbour = /NEIGHBOUR: .*interaction between 100 Hz/.test(user);
        // Same polarity, so KEEP - and a restatement, so duplicate.
        return Promise.resolve(JSON.stringify({ verdict: "KEEP", duplicate: true }));
      }
      return condemnBase.chat(sys, user, opts);
    },
  } as unknown as Deps;
  const out = await checkRenderFidelity(deps, doc, synth);
  assert(sawNeighbour, "the judge was not shown the sentence beside the unit");
  assertEquals(out.rendered, doc, "the same point was pasted under itself");
  // Both sentences of the span are condemned, and this judge calls both of them
  // restatements of what stands beside them; neither is booked as polarity.
  assertEquals(out.record.duplicate_skipped, 2, JSON.stringify(out.record));
  assertEquals(out.record.polarity_skipped, 0, JSON.stringify(out.record));
  // …and neither is counted as checked: nothing corrected them.
  assertEquals([out.record.units, out.record.unchecked], [2, 2], JSON.stringify(out.record));
  // The prompt asks the question in so many words.
  assertStringIncludes(FLIP_JUDGE_SYS, "NEIGHBOUR");
  assertEquals(parseDuplicate(JSON.stringify({ verdict: "KEEP", duplicate: true })), true);
  assertEquals(parseDuplicate(JSON.stringify({ verdict: "KEEP" })), false);
  assertEquals(parseDuplicate("not json"), false);
});

Deno.test("FLIP: a NAME beats a stutter - the duplicate refusal cannot keep an unearned name", async () => {
  // Found by re-running the three renders through the live judge: on the
  // buyer's guide it called the OEM sentence's repair a restatement of the
  // sentence beside it - correctly - and the refusal left "OEM" standing in a
  // delivered document while the footer named ESR and HDD as blocked. A gate a
  // readability guard can talk out of firing is not a gate.
  const doc = [
    "## What the evidence does not settle",
    "",
    "Whether Dell sells a direct-replacement 180 W SFF PSU separately is not confirmed by any " +
    "source. The proprietary connector makes substitution difficult [Source 13], but the " +
    "availability of an OEM replacement part is left open.",
  ].join("\n");
  const deps = {
    ...condemnBase,
    chat: (sys: string, user: string, opts?: { json?: boolean; nothink?: boolean }) => {
      if (sys.startsWith(FLIP_SYS_HEAD)) {
        // Same polarity, and a restatement of the neighbour: exactly the answer
        // that left the name in.
        return Promise.resolve(JSON.stringify({ verdict: "KEEP", duplicate: true }));
      }
      if (sys.startsWith("You repair sentences")) {
        // The rewriter strips the offending name, mechanically, from whichever
        // items it is handed - the machinery is what is under test, not a
        // model's willingness.
        const items = user.split(/\n(?=\d+\. SENTENCE: )/).filter((b) => /SENTENCE:/.test(b));
        const fixed: Record<string, string> = {};
        items.forEach((b, i) => {
          const line = (b.match(/SENTENCE: (.*)/) || [])[1] ?? "";
          if (/OEM/.test(line)) fixed[String(i + 1)] = line.replace(/an OEM replacement part/, "a direct-replacement part");
        });
        return Promise.resolve(JSON.stringify({ fixed }));
      }
      return condemnBase.chat(sys, user, opts);
    },
  } as unknown as Deps;
  const out = await checkRenderFidelity(deps, doc, NAME_SYNTH);
  assert(!/OEM/.test(out.rendered), out.rendered);
  assertEquals(out.record.names_blocked, ["OEM"]);
  assertEquals(renderGroundingDiff(out.rendered, NAME_SYNTH, "").names, []);
  // …and polarity still refuses even for a named unit: a flip is never worth a
  // name. The same document, with a judge that calls the repair an inversion.
  const flipping = {
    ...condemnBase,
    chat: (sys: string, user: string, opts?: { json?: boolean; nothink?: boolean }) =>
      sys.startsWith(FLIP_SYS_HEAD)
        ? Promise.resolve(JSON.stringify({ verdict: "FLIP", duplicate: true }))
        : condemnBase.chat(sys, user, opts),
  } as unknown as Deps;
  const held = await checkRenderFidelity(flipping, doc, NAME_SYNTH);
  assertEquals(held.rendered, doc, "a flip was applied to get rid of a name");
  assertEquals(held.record.names_blocked, [], "a name still in the document was called blocked");
  assert(held.record.polarity_skipped >= 1, JSON.stringify(held.record));
});
