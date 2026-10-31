// deno test --allow-all src/export/gate_round3_test.ts - rw-p6b-gate round 3: the tester's attempt-2 defects
// (t-p6b-gate2 D8-D12) as repros. The "real" cases render through pandoc + Typst and run pdftoppm and the
// gate's Python (the image's test stage, where the build gate runs this file).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { frontmatterOf, type GateInput, referenceParity, runGate } from "./gate.ts";
import type { VisionConfig } from "./vision.ts";
import { GATE_SECTION_ROWS, gatedEntries, ROUND3_MD, sectionsOf } from "./gate_fixtures.ts";
import { type FormatDef, type RefItem, render, type StyleDef } from "./render.ts";
import { fxEntries } from "./registry_fixtures.ts";
import { fixtureCsl, fixtureId, fixtureRefs } from "./test_fixtures.ts";
import { printedTitle } from "./csl.ts";

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
  return { status: g.status, codes: [...new Set(g.blocking_findings.map((f) => f.code))].sort(), g };
}

Deno.test("D8 (real): a table cell overlapping the next one by ONE glyph is BLOCKED (header and rows, text and inline code)", async () => {
  for (const name of ["s-text-01", "s-text-02", "s-code-01", "s-code-02", "s-1row-text-02", "s-1row-text-03"]) {
    const r = await gate(ROUND3_MD[name]);
    assertEquals([name, r.status, r.codes.includes("overlapping-text")], [name, "blocked", true], JSON.stringify(r.g.blocking_findings));
  }
  const ok = await gate(ROUND3_MD["s-lower-22"]);
  assertEquals(["s-lower-22 (its cell wraps: clean)", ok.status], ["s-lower-22 (its cell wraps: clean)", "passed"]);
});

Deno.test("D9 (real): clean math (assembled arrows, braces, accents) PASSES; a formula spilling over prose in a table is BLOCKED", async () => {
  for (const name of ["n-math", "n-math-accents", "n-math-vector", "n-math-brace"]) {
    const r = await gate(ROUND3_MD[name]);
    assertEquals([name, r.status, r.codes], [name, "passed", []], JSON.stringify(r.g.blocking_findings));
  }
  const spill = await gate(ROUND3_MD["s-math-22"]);
  assert(spill.codes.includes("overlapping-text"), `s-math-22: ${spill.codes}`);
});

Deno.test("D8/D9 (real): clean CJK punctuation runs and right-to-left text PASS (the kerning-distance exemption)", async () => {
  for (const name of ["n-cjk-long", "n-arabic-hebrew2"]) {
    const r = await gate(ROUND3_MD[name]);
    assertEquals([name, r.status], [name, "passed"], JSON.stringify(r.g.blocking_findings));
  }
});

Deno.test("D11: a title with Arabic and Hebrew words matches the file's visual-order text", async () => {
  const title = "Ünïcödé — “quotes” 日本語 العربية שלום";
  const visual = ["References\n[1] “Ünïcödé — ‘quotes’ 日本語 םולש ةيبرعلا.” Accessed: Oct. 31, 2026."];
  assertEquals(referenceParity(visual, [{ number: 1, title }], true), []);
  assertEquals(referenceParity(visual, [{ number: 1, title: "Ünïcödé — “quotes” 日本語 العربية שלוםx" }], true).length, 1, "another word still differs");
  const refs: RefItem[] = [{ key: `src-${fixtureId(1)}`, number: 1, csl: { ...fixtureCsl(1), title } }];
  const r = await gate(`# RTL\n\nCites [[source/${fixtureId(1)}|it]].\n`, refs);
  assertEquals([r.status, r.codes], ["passed", []], JSON.stringify(r.g.blocking_findings));
});


Deno.test("round 3 (real): a reference label's ']' before a CJK-face opening quote is not overlapping text (the lab's T2 document)", async () => {
  const titles = ["Gate fixture page one on layout checks", "Gate fixture page two on reference lists", "Gate fixture page four as first pinned", "Gate fixture page three added by hand"];
  const refs: RefItem[] = titles.map((t, i) => ({
    key: `src-${fixtureId(i + 1)}`, number: i + 1,
    csl: { type: "webpage", title: t, URL: `https://example.org/p6b/g${i + 1}`, accessed: { "date-parts": [[2026, 10, 31]] } } as never,
  }));
  const md = `# Gate parity document\n\nThe layout checks [[source/${fixtureId(1)}|page one]] and the reference lists [[source/${fixtureId(2)}|page two]], and again [[source/${fixtureId(3)}|page four]] and [[source/${fixtureId(4)}|three]].\n`;
  const r = await gate(md, refs);
  assertEquals([r.status, r.codes], ["passed", []], JSON.stringify(r.g.blocking_findings));
});
