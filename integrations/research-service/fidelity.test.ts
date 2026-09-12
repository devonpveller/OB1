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
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyUnit, checkRenderFidelity, citedUnits, referenceLines, splitSentences, verbatimFallback,
} from "./fidelity.ts";
import type { Deps } from "./harness.ts";

const SYNTH = [
  "[SOURCED] The Dell OptiPlex 3050 SFF uses a proprietary power supply and proprietary power " +
  "connector, which makes it difficult for users to install aftermarket PSUs to support " +
  "higher-power GPUs. [Source 13]",
  "[SOURCED] The Dell OptiPlex 3050 SFF supports up to 32 GB of DDR4 RAM across two DIMM slots. [Source 13]",
  "[SOURCED] A community user reported bent processor pins on an OptiPlex 3050 motherboard. [Source 14]",
  "[GAP] What are the water-damage failure modes?",
].join("\n");

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
  const out = await checkRenderFidelity(deps, HEDGE_DOC, SYNTH);
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
  const out = await checkRenderFidelity(deps, HEDGE_DOC, SYNTH);
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
  const out = await checkRenderFidelity(deps, doc, SYNTH);
  assertEquals(out.rendered, doc);
  assertEquals(out.record.checked, 2);
  assertEquals([out.record.stronger, out.record.unsupported, out.record.rewritten, out.record.replaced], [0, 0, 0, 0]);
  assertEquals(calls.rewrite, 0, "a clean document was sent to the rewriter");
});

// ── What happens when the checker itself breaks ────────────────────────────

Deno.test("a judge that throws leaves the document EXACTLY as it was, and says so", async () => {
  const deps = { chat: () => Promise.reject(new Error("upstream 503")) } as unknown as Deps;
  const out = await checkRenderFidelity(deps, HEDGE_DOC, SYNTH);
  assertEquals(out.rendered, HEDGE_DOC);
  assertEquals(out.record.checked, 0);
  assert(out.record.error, "a failed check must be recorded, not silently passed");
  assert(/503/.test(out.record.error!));
});

Deno.test("a judge that answers nonsense is a failed check, not a verdict", async () => {
  for (const reply of ["not json", '{"verdicts":["MAYBE"]}', '{"verdicts":[]}', "{}"]) {
    const deps = { chat: () => Promise.resolve(reply) } as unknown as Deps;
    const out = await checkRenderFidelity(deps, HEDGE_DOC, SYNTH);
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
  const out = await checkRenderFidelity(deps, HEDGE_DOC, SYNTH);
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
  const out = await checkRenderFidelity(deps, HEDGE_DOC, SYNTH);
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
  applyUnit(lines, { text: "B", line: 0, cell: 2, citations: [] }, "B rewritten");
  assertEquals(lines[0], "| A | B rewritten | C |");
  const prose = ["One. Two. Three."];
  applyUnit(prose, { text: "Two.", line: 0, cell: -1, citations: [] }, "Second.");
  assertEquals(prose[0], "One. Second. Three.");
});
