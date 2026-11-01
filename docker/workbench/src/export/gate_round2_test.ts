// deno test --allow-all src/export/gate_round2_test.ts - rw-p6b-gate round 2: the tester's defects
// (t-p6b-gate D1-D5, D7) as failing repros first. The "real" cases render through pandoc + Typst and run
// pdftoppm and the gate's Python (the image's test stage, where the build gate runs this file).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { frontmatterOf, frontmatterValues, type GateInput, requiredSections, runGate } from "./gate.ts";
import type { VisionConfig } from "./vision.ts";
import {
  C1_CLEAN_RICH_MD, C1_LEFT_CODE22_MD, C1_LEFT_TEXT22_MD, E_PROSE_MD, E_WDOT_MD, GATE_SECTION_ROWS, gatedEntries, R_BARE_NUMBER_LATER_WEIGHTS_MD,
  R_BOLD_PARA_MD, REPORT_P3B_ROLLUP_MD, reportMd, sectionsOf,
} from "./gate_fixtures.ts";
import { type FormatDef, render, type StyleDef } from "./render.ts";
import { fxEntries } from "./registry_fixtures.ts";
import { fixtureRefs } from "./test_fixtures.ts";
import { exportsRouter } from "../routes/exports.ts";
import type { RunStore } from "./runs.ts";

const CSL_DIR = new URL("../../csl", import.meta.url).pathname;
const fmt = { key: "pdf", ...gatedEntries("export_formats").find((e) => e.key === "pdf")!.definition } as FormatDef;
const style = { key: "ieee", ...fxEntries("citation_styles").find((e) => e.key === "ieee")!.definition } as StyleDef;
const OFF: VisionConfig = { state: "off", timeoutMs: 1000, reason: "EXPORT_VISION_KEY is blank" };
const SECTIONS = sectionsOf(GATE_SECTION_ROWS);
const gate = async (md: string) => {
  const pdf = (await render({ md, refs: fixtureRefs(0), format: fmt, style, cslDir: CSL_DIR })).bytes;
  const g = await runGate({ vision: OFF }, { pdf, format: fmt, refs: [], numeric: true, frontmatter: frontmatterOf(md), required: SECTIONS } as GateInput);
  return { status: g.status, codes: [...new Set([...g.blocking_findings, ...g.warnings.filter((w) => w.code === "reference-mismatch")].map((f) => f.code))].sort(), g }; // round 5: parity is advisory (a warning)
};

Deno.test("D1 (real): ordinary prose, kerned 'w.' / 'y.' and a rich clean page PASS - kerning is not overlapping text", async () => {
  for (const [name, md] of [["e-wdot", E_WDOT_MD], ["e-prose", E_PROSE_MD], ["c1-clean-rich", C1_CLEAN_RICH_MD]] as const) {
    const r = await gate(md);
    assertEquals([name, r.status, r.codes], [name, "passed", []], `${name}: ${JSON.stringify(r.g.blocking_findings)}`);
  }
});

Deno.test("D2 (real): a cell spilling over a neighbour in ANOTHER font (inline code) is BLOCKED, as the same table in one font is", async () => {
  for (const [name, md] of [["c1-left-code22", C1_LEFT_CODE22_MD], ["c1-left-text22", C1_LEFT_TEXT22_MD]] as const) {
    const r = await gate(md);
    assertEquals([name, r.status], [name, "blocked"]);
    assert(r.codes.includes("overlapping-text"), `${name}: ${r.codes}`);
  }
});

Deno.test("D5: content_type is read as YAML reads it - a trailing comment, a quoted key, quoted values, CRLF", () => {
  for (const fm of [
    "content_type: research_synthesis # a deep research report", "\"content_type\": research_synthesis", "'content_type': research_synthesis",
    "content_type: 'research_synthesis'", "content_type: \"research_synthesis\"  # c", "content_type: !!str research_synthesis",
    "title: \"a: b\"\r\ncontent_type: research_synthesis\r\n", "content_type: [note, research_synthesis]", "content_type:\n  - research_synthesis # x",
  ]) {
    assert(frontmatterValues(fm, "content_type").includes("research_synthesis"), fm);
  }
  assertEquals(frontmatterValues("content_type: research_synthesis_x", "content_type"), ["research_synthesis_x"]);
  assertEquals(frontmatterValues("Content_Type: research_synthesis", "content_type"), [], "YAML keys are case-sensitive");
  assertEquals(frontmatterValues("title: x # content_type: research_synthesis", "content_type"), [], "a key inside a comment is not a key");
  assertEquals(frontmatterValues("content_type: \"research#synthesis\"", "content_type"), ["research#synthesis"], "# inside quotes is text");
  assertEquals(frontmatterOf("---\r\ntitle: t\r\ncontent_type: research_synthesis\r\n---\r\n# x\r\n").includes("research_synthesis"), true);
});

Deno.test("D5: the weights must be INSIDE the roll-up section - a bare number, then 'weights' under a later heading, is missing", () => {
  const fm = frontmatterOf(reportMd(true));
  const L = (text: string, size: number) => ({ text, size, x0: 70 });
  const bare = [L("Findings", 14), L("The report states findings.", 11), L("Report credibility", 13), L("0.72", 11), L("Method", 13), L("We discuss evidence weights here.", 11)];
  assertEquals(requiredSections([], SECTIONS, fm, "pdf", bare).map((f) => f.code), ["required-section-missing"]);
  const good = [L("Report credibility", 13), L("Report credibility 0.41.", 11), L("The weights the roll-up used:", 11), L("Findings", 13), L("Body text.", 11), L("More body.", 11)];
  assertEquals(requiredSections([], SECTIONS, fm, "pdf", good), []);
  const bold = [L("Report credibility", 11), L("Report credibility 0.72.", 11), L("The claim-kind weights used: empirical 1.0.", 11), L("Notes", 13)];
  assertEquals(requiredSections([], SECTIONS, fm, "pdf", bold), [], "a bold-paragraph heading: the section runs to the next heading");
});

Deno.test("D5 (real): bare number + later 'weights' BLOCKED; the roll-up as P3b prints it and a bold-paragraph heading PASS; YAML variants are asked", async () => {
  assertEquals((await gate(R_BARE_NUMBER_LATER_WEIGHTS_MD)).codes, ["required-section-missing"]);
  for (const md of [REPORT_P3B_ROLLUP_MD, R_BOLD_PARA_MD]) assertEquals((await gate(md)).status, "passed");
  const none = (fmLine: string) => `---\ntitle: Probe report\n${fmLine}\n---\n\n# Findings\n\nNo roll-up here.\n`;
  for (const v of ["content_type: research_synthesis # a deep research report", "\"content_type\": research_synthesis", "content_type: 'research_synthesis'"]) {
    assertEquals((await gate(none(v))).codes, ["required-section-missing"], v);
  }
  assertEquals((await gate(none("content_type_x: research_synthesis"))).status, "passed", "not the key");
});

Deno.test("D7: GET /workbench/exports with a non-integer or out-of-range limit is 400, never 500", async () => {
  const runs: RunStore = { record: () => Promise.resolve(""), list: () => Promise.resolve([]), get: () => Promise.resolve(null), file: () => Promise.resolve(null) };
  const app = exportsRouter(runs, () => Promise.resolve({ sub: "a" }));
  for (const q of ["1.5", "abc", "-1", "0", "1e3", "201"]) assertEquals((await app.request(`/?limit=${q}`)).status, 400, q);
  assertEquals((await app.request("/?limit=5")).status, 200);
  assertEquals((await app.request("/")).status, 200);
});
