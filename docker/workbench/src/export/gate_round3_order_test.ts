// deno test --allow-all src/export/gate_round3_order_test.ts - rw-p6b-gate round 3, the ORDER defects (t-p6b-gate2 D10
// author-date order, D12 reading order) as repros; their own file because at 0b77118 biborder.ts and
// readingOrder do not exist (this file is that RED). The "real" cases render through pandoc + Typst and run pdftoppm and the
// gate's Python (the image's test stage, where the build gate runs this file).
import { assertEquals } from "jsr:@std/assert@1";
import { frontmatterOf, type GateInput, runGate } from "./gate.ts";
import type { VisionConfig } from "./vision.ts";
import { GATE_SECTION_ROWS, gatedEntries, sectionsOf } from "./gate_fixtures.ts";
import { closeParserPool, type FormatDef, type RefItem, render, type StyleDef } from "./render.ts";
import { fxEntries } from "./registry_fixtures.ts";
import { fixtureCsl, fixtureId, fixtureRefs } from "./test_fixtures.ts";
import { printedTitle } from "./csl.ts";
import { bibliographyOrder } from "./biborder.ts";
import { readingOrder } from "./repo.ts";
import { exportOrder } from "../contracts/logic/citations.ts";

const CSL_DIR = new URL("../../csl", import.meta.url).pathname;
const fmt = { key: "pdf", ...gatedEntries("export_formats").find((e) => e.key === "pdf")!.definition } as FormatDef;
const style = (k: string) => ({ key: k, ...fxEntries("citation_styles").find((e) => e.key === k)!.definition }) as StyleDef;
const OFF: VisionConfig = { state: "off", timeoutMs: 1000, reason: "EXPORT_VISION_KEY is blank" };
const SECTIONS = sectionsOf(GATE_SECTION_ROWS);
async function gate(md: string, refs: RefItem[] = fixtureRefs(0), s = "ieee", expected?: RefItem[]) {
  const pdf = (await render({ md, refs, format: fmt, style: style(s), cslDir: CSL_DIR })).bytes;
  const g = await runGate({ vision: OFF }, {
    pdf, format: fmt, numeric: style(s).citation_format === "numeric", frontmatter: frontmatterOf(md), required: SECTIONS,
    refs: (expected ?? refs).map((r) => ({ number: r.number, title: printedTitle(r.csl) })),
  } as GateInput);
  return { status: g.status, codes: [...new Set([...g.blocking_findings, ...g.warnings.filter((w) => w.code === "reference-mismatch")].map((f) => f.code))].sort(), g }; // round 5: parity is advisory (a warning)
}

Deno.test("D10 (real): an author-date (APA) export lists in the style's order; the gate compares by position in that order", async () => {
  // cited in the order 3, 1, 2 - APA sorts by author: Author1, Author2, Author3
  const refs = [3, 1, 2].map((n, i) => ({ key: `src-${fixtureId(n)}`, number: i + 1, csl: fixtureCsl(n) }));
  const md = `# APA\n\n${[3, 1, 2].map((n) => `Claim [[source/${fixtureId(n)}|c${n}]].`).join("\n\n")}\n`;
  const ordered = await bibliographyOrder(refs, style("apa"), CSL_DIR);
  assertEquals(ordered.map((r) => r.csl.title), ["Fixture paper number 1", "Fixture paper number 2", "Fixture paper number 3"]);
  assertEquals((await gate(md, refs, "apa", ordered)).status, "passed");
  assertEquals((await gate(md, refs, "apa", refs)).codes, ["reference-mismatch"], "the citation order is not an author-date list's order");
  const ieee = await bibliographyOrder(refs, style("ieee"), CSL_DIR);
  assertEquals(ieee.length, 3);
});

Deno.test("D12: the numbering follows the reading order - a citation in a footnote counts at its marker, a link in code is not a citation", async () => {
  const [one, two, three] = [fixtureId(1), fixtureId(2), fixtureId(3)];
  const later = `Lead sentence.[^n] Then two [[source/${two}|two]].\n\n[^n]: The note cites one [[source/${one}|one]].\n`;
  const first = `[^m]: The note cites one [[source/${one}|one]].\n\nThen two [[source/${two}|two]], and the note at last.[^m]\n`;
  const code = `A citation inside code: \`[[source/${two}|two]]\` and a real one [[source/${one}|one]].\n\n\`\`\`\n[[source/${three}|three]]\n\`\`\`\n`;
  assertEquals(readingOrder(later, []), [one, two]);
  assertEquals(readingOrder(first, []), [two, one]);
  assertEquals(readingOrder(code, []), [one, two, three], "code-only links after the cited ones (nocite)");
  assertEquals(exportOrder(first, []), [one, two], "the raw text order differs - the round-2 bug");
  for (const md of [later, first, code]) {
    const ids = readingOrder(md, []);
    const refs = ids.map((id, i) => ({ key: `src-${id}`, number: i + 1, csl: fixtureCsl(Number(id.slice(-3))) }));
    const r = await gate(`# Notes\n\n${md}`, refs);
    assertEquals([r.status, r.codes], ["passed", []], `${md.slice(0, 40)}: ${JSON.stringify(r.g.blocking_findings)}`);
  }
  closeParserPool();
});
