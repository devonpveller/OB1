/**
 * report-doc.test.ts — the delivered DOCUMENT: is it one a person could hand to
 * a colleague, and is every word of it still grounded?
 *
 * The artefact this exists for is the live OWUI run 33250e9b, kept whole at
 * ./fixtures/live-owui-33250e9b.result.json (the parent repo keeps a
 * human-facing copy under documentation/evidence/research-trust-report/).
 * It answered a buyer's question about a used Dell OptiPlex 3050 with 26 cited
 * lines from 17 sources, and delivered them as:
 *   - a bare "facts / sources / gaps" list, because the template classifier is
 *     only consulted at three ANSWERED needs and the coverage judge had marked
 *     all seven `partial`;
 *   - a footer reading "needs answered 0 of 7 (7 partly)" above a report full
 *     of findings;
 *   - the same open questions printed twice, the second copy under "Open gaps
 *     (NOT grounded)";
 *   - and a paragraph addressed to the reading MODEL, in the reader's document.
 *
 * The BEFORE and AFTER documents are committed beside the result, in this same
 * fixtures directory, so the difference is a file and not a claim.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ANSWERED_MIN_LINES, gapQuestions, groundedNeedCounts, reconcileNeedsStatus,
  shouldClassifyTemplate, type NeedState,
} from "./report.ts";
import { renderGroundingDiff } from "./grounding.ts";
import {
  buildCitedAndRenumber, HANDOFF_WAIT_LINE, rewriteChatBody, stripEngineBlocks,
} from "./lib.ts";
import {
  classifyReport, LIMITATIONS_SECTION, renderSys, TEMPLATES, templateById,
} from "./templates.ts";
import type { Deps } from "./harness.ts";

// INSIDE the submodule, like every other fixture. This file used to read the
// parent repo's documentation/evidence/ directory, which works in a full
// checkout and fails the moment OB1 is tested on its own - which is how OB1 is
// built and how every attempt of this item is verified. An OB1 test may never
// read a file outside OB1. The parent keeps human-facing copies of all three,
// with a note pointing here.
const EV = new URL("./fixtures/", import.meta.url);
const RUN = JSON.parse(Deno.readTextFileSync(new URL("live-owui-33250e9b.result.json", EV)));
const AFTER = Deno.readTextFileSync(new URL("rendered-AFTER-33250e9b.md", EV));
const AFTER_V1 = Deno.readTextFileSync(new URL("rendered-AFTER-v1-33250e9b.md", EV));
const BEFORE = Deno.readTextFileSync(new URL("rendered-BEFORE-33250e9b.md", EV));
const QUERY =
  "Dell OptiPlex 3050 used purchase: common failure modes, known defects, red flags, " +
  "thermal issues, capacitor/CPU socket problems, how to verify hardware health";

// ── Coverage: the count, not the flag ───────────────────────────────────────

Deno.test("ACCEPTANCE 2: the live run's synthesis renders as answered 6 of 7, not 0 of 7", () => {
  // As the run recorded it: the judge marked every need open, and one grounded
  // line could only lift it to `partial`.
  const asJudged: NeedState[] = RUN.needs.map((need: string) => ({ need, status: "open" }));
  const out = reconcileNeedsStatus(asJudged, RUN.synthesis);
  const answered = out.filter((n) => n.status === "answered").length;
  assert(answered >= 5, `answered ${answered} of ${out.length}`);
  assertEquals(answered, 6);
  assertEquals(out.filter((n) => n.status === "partial").length, 1);
  // The one that stays partly-answered is the red-flags/water-damage need: the
  // synthesis really does carry a single line about it. A measurement that
  // called all seven answered would be measuring the subject, not the needs.
  assertEquals(out[6].status, "partial");
});

Deno.test("the per-need line counts are the subject's, not the needs', unless they discriminate", () => {
  const counts = groundedNeedCounts(RUN.needs, RUN.synthesis);
  // Pinned: 19 grounded lines in the synthesis, and no need may claim all of
  // them. Before the discriminating-term subtraction every need scored 17-19
  // because "dell", "optiplex" and "3050" are in all seven needs and nearly
  // every line - which would have made `answered` free for any run.
  assertEquals(counts, [7, 5, 6, 4, 6, 9, 1]);
  assert(Math.max(...counts) < 19, `a need matched every line: ${counts}`);
});

Deno.test("two grounded lines is answered, one is partly, none leaves the judge alone", () => {
  const needs: NeedState[] = [
    { need: "What are the PSU failure modes?", status: "open" },
    { need: "What is the RAM slot capacity?", status: "open" },
    { need: "What about water damage corrosion?", status: "open" },
    { need: "Are the fans loud?", status: "search_failed" },
  ];
  const synthesis = [
    "[SOURCED] The PSU failure modes include a dead green LED. [Source 1]",
    "[SOURCED] A second PSU failure was reported after a power outage. [Source 2]",
    "[SOURCED] The RAM slot capacity is 32 GB over two slots. [Source 3]",
    "[SOURCED] The fans are loud after a thermal service. [Source 4]",
  ].join("\n");
  const out = reconcileNeedsStatus(needs, synthesis);
  assertEquals(out.map((n) => n.status), ["answered", "partial", "open", "search_failed"]);
  assertEquals(ANSWERED_MIN_LINES, 2);
});

Deno.test("a line that names only the SUBJECT grounds nothing", () => {
  const needs: NeedState[] = [
    { need: "What are the OptiPlex 3050 capacitor symptoms?", status: "open" },
    { need: "What are the OptiPlex 3050 BIOS update procedures?", status: "open" },
  ];
  // Both lines are about the subject and about NEITHER need in particular.
  const synthesis = [
    "[SOURCED] The Dell OptiPlex 3050 is a small form factor desktop. [Source 1]",
    "[SOURCED] The Dell OptiPlex 3050 was sold from 2017. [Source 2]",
  ].join("\n");
  assertEquals(reconcileNeedsStatus(needs, synthesis).map((n) => n.status), ["open", "open"]);
});

Deno.test("an UNTAGGED or UNCITED line is not evidence, however well it matches", () => {
  const needs: NeedState[] = [{ need: "What are the PSU failure modes?", status: "open" }];
  const untagged = "The PSU failure modes include a dead green LED. [Source 1]\n" +
                   "The PSU failure modes also include a fan fault. [Source 2]";
  const uncited = "[SOURCED] The PSU failure modes include a dead green LED.\n" +
                  "[SOURCED] The PSU failure modes also include a fan fault.";
  assertEquals(reconcileNeedsStatus(needs, untagged)[0].status, "open");
  assertEquals(reconcileNeedsStatus(needs, uncited)[0].status, "open");
});

Deno.test("ACCEPTANCE 5: partly-answered needs count toward the template threshold", () => {
  // This is the whole reason 33250e9b was delivered as a fact list: seven needs
  // with findings in all of them, `answered` = 0, so the classifier was skipped.
  assertEquals(shouldClassifyTemplate(0, 7), true);
  assertEquals(shouldClassifyTemplate(3, 0), true);
  assertEquals(shouldClassifyTemplate(1, 1), false);
  assertEquals(shouldClassifyTemplate(0, 0), false);
});

// ── What the gap-closing pass goes looking for ──────────────────────────────

Deno.test("gap queries come from the synthesis's own [GAP] lines, not the needs", () => {
  const needs = [
    "What are the specific symptoms of capacitor degradation in the OptiPlex 3050?",
    "What are the BIOS modding risks for the OptiPlex 3050?",
    "How loud are the fans in the OptiPlex 3050?",
  ];
  const synthesis = [
    "[SOURCED] Something grounded. [Source 1]",
    "[GAP] What is the measured capacitor degradation rate on this board?",
    "[GAP] Which BIOS modding steps brick the machine?",
  ].join("\n");
  const out = gapQuestions(needs, synthesis);
  assertEquals(out[0].question, "What is the measured capacitor degradation rate on this board?");
  assertEquals(out[1].question, "Which BIOS modding steps brick the machine?");
  // A need with no gap line of its own falls back to the need itself, which is
  // never worse than not searching.
  assertEquals(out[2].question, needs[2]);
});

Deno.test("gap queries on the live run resolve to that run's own open questions", () => {
  const out = gapQuestions(RUN.needs, RUN.synthesis);
  assertEquals(out.length, 7);
  for (const { need, question } of out) assert(question.length > 0, need);
  // At least one need is matched to a REAL gap line rather than falling back.
  assert(out.some(({ need, question }) => question !== need),
    "no need matched a [GAP] line on the recorded run");
});

// ── The document's shape ───────────────────────────────────────────────────

Deno.test("ACCEPTANCE 1: the re-rendered document has the shape a buyer can use", () => {
  const headings = AFTER.split("\n").filter((l) => l.startsWith("#"));
  assert(headings[0].startsWith("# "), headings[0]);
  // A title that states the finding, not the topic, and never an absence.
  assert(/PSU|Socket|Connector|Failure/i.test(headings[0]), headings[0]);
  assert(!/absence of evidence|no evidence (for|of)/i.test(headings[0]), headings[0]);
  for (const h of ["## Executive summary", "## What to check in person",
                   "## Failure modes by subsystem", "## Limitations and open questions"]) {
    assert(AFTER.includes(h), `missing ${h}`);
  }
  // The checklist is a checklist.
  assert((AFTER.match(/^- \[ \] /gm) || []).length >= 5, "no inspection checklist");
  // The subsystem table has a Source column and every row carries a citation.
  const rows = AFTER.split("\n").filter((l) => /^\|/.test(l) && !/^\|\s*-+/.test(l));
  assert(rows.length >= 6, `only ${rows.length} table rows`);
  for (const r of rows.slice(1)) assert(/\[Source \d/.test(r), `uncited row: ${r.slice(0, 60)}`);
  for (const sub of ["PSU", "socket", "RAM", "BIOS", "capacitor"]) {
    assert(new RegExp(sub, "i").test(AFTER), `no ${sub} row`);
  }
  // ONE limitations section, and it ends by asking for the run that would close
  // what is left - in the reader's terms.
  assertEquals((AFTER.match(/^## Limitations and open questions$/gm) || []).length, 1);
  assertEquals((AFTER.match(/^## What was not found$/gm) || []).length, 0);
  assertEquals((AFTER.match(/\*\*Open gaps\*\*/g) || []).length, 0);
  assert(/A further run focused on/i.test(AFTER), "no recommendation for what is still open");
  // Nothing in the body is addressed to the model.
  assert(!/Do NOT fill/i.test(AFTER), "the model directive is in the body");
  assert(!/\[SOURCED\]|\[GAP\]|\[UNCERTAIN\]/.test(AFTER), "the tags leaked into the report");
});

Deno.test("the BEFORE document is the defect, and it is kept to prove it", () => {
  // Both lists of unknowns, and the banner, in the delivered document.
  assert(BEFORE.includes("## What was not found"), "BEFORE lost its first gap list");
  assert(BEFORE.includes("**Open gaps** (NOT grounded"), "BEFORE lost its second gap list");
  assert(/INCOMPLETE/.test(BEFORE), "BEFORE lost the banner");
  assert(BEFORE.includes("needs answered 0 of 7 (7 partly)"), "BEFORE lost its footer");
  // …and none of it survives.
  assert(!AFTER.includes("**Open gaps**"));
  assert(!/INCOMPLETE/.test(AFTER));
});

Deno.test("every template has exactly one limitations section, spelled the same way", () => {
  for (const t of TEMPLATES) {
    const sys = renderSys(t);
    assertEquals((sys.match(/## Limitations and open questions/g) || []).length, 1, t.id);
    assertEquals(/## Open questions/.test(sys), false, `${t.id} still has a second gap section`);
    assertEquals(/## What was not found/.test(sys), false, `${t.id} still has a second gap section`);
    assert(sys.includes("A further run focused on"), `${t.id} never asks for the next run`);
  }
  assert(LIMITATIONS_SECTION.includes("One section, once."));
});

Deno.test("the buyer's guide is a template like any other - one entry, nothing else wired", () => {
  const t = templateById("buyers-guide");
  assertEquals(t.id, "buyers-guide");
  assert(t.structure.includes("What to check in person"));
  assert(t.structure.includes("| Subsystem | What goes wrong | What it looks like | Source |"));
  assert(renderSys(t).includes("GROUNDING RULES"));
});

// ── The classifier is told the reader's purpose ─────────────────────────────

function chatDeps(reply: string): Deps {
  return {
    embed: () => Promise.resolve([]),
    chat: () => Promise.resolve(reply),
    searchWeb: () => Promise.resolve([]),
    fetchPage: () => Promise.resolve({ outcome: "ok", page: null }),
    delegateToCurator: () => Promise.resolve({}),
  } as unknown as Deps;
}

Deno.test("ACCEPTANCE 5: the classifier states the PURPOSE and picks for it", async () => {
  const c = await classifyReport(chatDeps('{"purpose":"buy","template":"buyers-guide"}'), "q", "s");
  assertEquals(c.purpose, "buy");
  assertEquals(c.template.id, "buyers-guide");
});

Deno.test("a purpose with an unusable template id still decides the shape", async () => {
  // The half the model got right is not thrown away because of the half it
  // got wrong: "buyers guide" is not an id, but "buy" is a purpose.
  const c = await classifyReport(chatDeps('{"purpose":"buy","template":"buyers guide"}'), "q", "s");
  assertEquals(c.template.id, "buyers-guide");
  const c2 = await classifyReport(chatDeps('{"purpose":"compare","template":"???"}'), "q", "s");
  assertEquals(c2.template.id, "product-comparison");
});

Deno.test("garbage, or a chat failure, still falls closed to the general report", async () => {
  assertEquals((await classifyReport(chatDeps("not json"), "q", "s")).template.id, "general-report");
  assertEquals((await classifyReport(chatDeps('{"purpose":"vibes"}'), "q", "s")).template.id, "general-report");
  assertEquals((await classifyReport(chatDeps("not json"), "q", "s")).purpose, "");
});

// ── The chat message is rewritten, not stacked ─────────────────────────────

Deno.test("ACCEPTANCE 4+9: the callback can write twice, and the final body starts with the report", () => {
  const interim = rewriteChatBody(HANDOFF_WAIT_LINE, "_First pass complete: 4 of 7 needs answered_");
  assert(interim.includes("First pass complete"), interim);
  assert(!interim.includes(HANDOFF_WAIT_LINE), "the waiting line survived the interim write");

  const final = rewriteChatBody(interim, "# The report\nBody.");
  assert(!final.includes("First pass complete"), "the interim status survived the final write");
  assert(!final.includes(HANDOFF_WAIT_LINE));
  assertEquals(stripEngineBlocks(final), "");
  // The body a reader sees starts with the title.
  assertEquals(final.split("\n").filter((l) => !l.startsWith("<!--"))[0], "# The report");
});

Deno.test("anything the model actually SAID is kept; only the line the tool asked for is taken", () => {
  const said = "Sure - I'll run that research now, and I'll flag the socket question specially.";
  const out = rewriteChatBody(`${said}\n${HANDOFF_WAIT_LINE}`, "# The report");
  assert(out.startsWith(said), out);
  assert(out.includes("# The report"));
  assert(!out.includes(HANDOFF_WAIT_LINE));
  // …and a second write does not stack a second copy.
  const again = rewriteChatBody(out, "# The report v2");
  assertEquals((again.match(/# The report/g) || []).length, 1);
  assert(again.startsWith(said));
});

// ── Grounding: nothing new may enter in the rendering ──────────────────────

Deno.test("ACCEPTANCE 6: every [Source N] in the document resolves to the same source", () => {
  const nums = (t: string) =>
    new Set((t.match(/\[Sources?[^\]]*\]/g) || []).flatMap((b) => b.match(/\d+/g) || []).map(Number));
  const inDoc = nums(AFTER);
  const inSynth = nums(RUN.synthesis);
  assert(inDoc.size > 0, "the document cites nothing");
  for (const n of inDoc) {
    assert(inSynth.has(n), `[Source ${n}] is in the report and not in the synthesis`);
    assert(n >= 1 && n <= RUN.cited_sources.length, `[Source ${n}] resolves to no source`);
  }
});

Deno.test("renumbering keeps each citation pointing at ITS source", () => {
  const sources = ["A", "B", "C", "D", "E"];
  const raw = "[SOURCED] one [Source 2]\n[SOURCED] two [Source 5, 2]\n[SOURCED] three [Source 4]";
  const { synthesis, cited } = buildCitedAndRenumber(raw, sources);
  // The cited list is the USED sources in ascending original order, compacted:
  // 2,4,5 -> 1,2,3. Nothing is dropped and nothing is reordered by appearance.
  assertEquals(cited, ["B", "D", "E"]);
  const lines = synthesis.split("\n");
  assertEquals(lines[0].endsWith("[Source 1]"), true, lines[0]);
  assertEquals(lines[1].endsWith("[Source 3, 1]"), true, lines[1]);
  assertEquals(lines[2].endsWith("[Source 2]"), true, lines[2]);
  // The pairing is what matters: each line's new number indexes the source it
  // was grounded in. Line 2 was grounded in E and B; it now says 3 and 1.
  assertEquals(cited[0], sources[1]);   // [Source 1] -> B, was 2
  assertEquals(cited[2], sources[4]);   // [Source 3] -> E, was 5
  assertEquals(cited[1], sources[3]);   // [Source 2] -> D, was 4
});

Deno.test("ACCEPTANCE 6: the grounding diff over the re-rendered document", () => {
  const diff = renderGroundingDiff(AFTER, RUN.synthesis, QUERY);
  // No figure and no URL in the report that the grounded answer does not hold.
  assertEquals(diff.numbers, []);
  assertEquals(diff.urls, []);
  // ONE name still leaks, and it is pinned rather than tolerated: the model
  // abbreviates "Blue Screen of Death", which the synthesis spells out. ATX and
  // SFX - the standards the model named for a connector the sources only call
  // proprietary - are GONE: the grounding rules now forbid naming a standard
  // the answer does not name, and rendered-AFTER-v1 keeps the render that had
  // them. A SECOND name appearing here fails this test.
  assertEquals(diff.names, ["BSOD"]);
});

Deno.test("the diff sees a planted fact, a planted figure and a planted URL", () => {
  // A check that never fires is not a check.
  const synth = "[SOURCED] The unit uses a proprietary connector. [Source 1]";
  const diff = renderGroundingDiff(
    "The unit uses a proprietary connector, unlike the 450 W ATX standard, " +
    "see https://example.invalid/spec.", synth, "",
  );
  assertEquals(diff.numbers, ["450"]);
  assertEquals(diff.urls, ["https://example.invalid/spec."]);
  assertEquals(diff.names, ["ATX"]);
  // …and says nothing about a document that only repeats what it was given.
  const clean = renderGroundingDiff("The unit uses a proprietary connector [Source 1].", synth, "");
  assertEquals([clean.numbers.length, clean.urls.length, clean.names.length], [0, 0, 0]);
});

// ── The defect the tester read, and its fix ────────────────────────────────

Deno.test("X1: the hedge that became an absolute is in v1 and gone from the shipped render", () => {
  // What the tester found by reading: a table cell citing [Source 13] that said
  // "no off-the-shelf ATX or SFX drop-in available", where the line it cites
  // says the proprietary connector "makes it difficult" to fit aftermarket
  // PSUs. Two moves in one cell - names the answer does not have, and a hedge
  // turned into an absolute - and only the first was detectable.
  const v1Body = AFTER_V1.replace(/<!--[\s\S]*?-->/g, "");
  assert(/no off-the-shelf ATX or SFX drop-in available/.test(v1Body), "v1 lost the defect it exists to show");

  const body = AFTER.replace(/<!--[\s\S]*?-->/g, "");
  assertEquals(/ATX|SFX/.test(body), false, "the shipped render still names the standards");
  assertEquals(/no off-the-shelf/.test(body), false, "the absolute survived");
  // …and the same row now says what its source says.
  const row = body.split("\n").find((l) => /^\|/.test(l) && /Power supply|connector/i.test(l)) || "";
  assert(/difficult|limit/i.test(row), `the connector row lost its hedge: ${row}`);
});

Deno.test("the shipped render records what the fidelity check did to it", () => {
  // The header is the run's own record, not a claim in prose: a reader of the
  // fixture can see how much of it was corrected and why.
  assert(/"checked":32/.test(AFTER), "the fidelity record is missing from the fixture header");
  assert(/"replaced":2/.test(AFTER));
  assert(/names \[BSOD\]/.test(AFTER));
});
