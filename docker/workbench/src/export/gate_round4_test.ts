// deno test --allow-all src/export/gate_round4_test.ts - rw-p6b-gate round 4 (operator-approved narrow round):
// the tester's attempt-3 clause-2 defects (t-p6b-gate3 D13 hyphenated author-date titles, D14 RTL titles with
// neutrals or digits) as repros. The "real" cases render through pandoc + Typst and run the gate's Python.
import { assertEquals } from "jsr:@std/assert@1";
import { frontmatterOf, type GateInput, runGate } from "./gate.ts";
import type { VisionConfig } from "./vision.ts";
import { GATE_SECTION_ROWS, gatedEntries, R4_MANY_TITLES, R4_REAL_TITLES, R4_RTL_TITLES, sectionsOf } from "./gate_fixtures.ts";
import { type FormatDef, type RefItem, render, type StyleDef } from "./render.ts";
import { fxEntries } from "./registry_fixtures.ts";
import { printedTitle } from "./csl.ts";
import { bibliographyOrder } from "./biborder.ts";

const CSL_DIR = new URL("../../csl", import.meta.url).pathname;
const fmt = { key: "pdf", ...gatedEntries("export_formats").find((e) => e.key === "pdf")!.definition } as FormatDef;
const style = (k: string) => ({ key: k, ...fxEntries("citation_styles").find((e) => e.key === k)!.definition }) as StyleDef;
const OFF: VisionConfig = { state: "off", timeoutMs: 1000, reason: "EXPORT_VISION_KEY is blank" };
const id = (n: number) => `f6b00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const webRefs = (titles: string[], base = 400): RefItem[] => titles.map((t, i) => ({
  key: `src-${id(base + i)}`, number: i + 1,
  csl: { type: "webpage", title: t, URL: `https://example.org/p6b/r4-${base + i}`, accessed: { "date-parts": [[2026, 10, 31]] } } as never,
}));
const docOf = (refs: RefItem[]) => `# Findings\n\n${refs.map((r, i) => `Finding ${i + 1} is supported [[source/${r.key.slice(4)}|r${i + 1}]].`).join(" ")}\n`;
async function gate(refs: RefItem[], s: string, expectedTitles?: string[]) {
  const st = style(s);
  const pdf = (await render({ md: docOf(refs), refs, format: fmt, style: st, cslDir: CSL_DIR })).bytes;
  const ordered = st.citation_format === "numeric" ? refs : await bibliographyOrder(refs, st, CSL_DIR);
  const want = ordered.map((r, i) => ({ number: r.number, title: expectedTitles?.[i] ?? printedTitle(r.csl) }));
  const g = await runGate({ vision: OFF }, {
    pdf, format: fmt, numeric: st.citation_format === "numeric", frontmatter: frontmatterOf(""), required: sectionsOf(GATE_SECTION_ROWS), refs: want,
  } as GateInput);
  return { status: g.status, codes: [...new Set(g.blocking_findings.map((f) => f.code))].sort(), g };
}

Deno.test("D13 (real): the tester's six-title and 40-reference documents export in APA (and still in IEEE)", async () => {
  for (const [name, titles] of [["six realistic titles", R4_REAL_TITLES], ["40 references", R4_MANY_TITLES]] as const) {
    for (const s of ["apa", "ieee", "elsevier-vancouver"]) {
      const r = await gate(webRefs([...titles]), s);
      assertEquals([name, s, r.status, r.codes], [name, s, "passed", []], JSON.stringify(r.g.blocking_findings.slice(0, 3)));
    }
  }
  const wrong = await gate(webRefs(R4_REAL_TITLES), "apa", [...R4_REAL_TITLES].reverse());
  assertEquals(wrong.codes, ["reference-mismatch"], "a wrong order still blocks");
});

Deno.test("D14 (real): every RTL title of the tester's set exports (IEEE; he-colon / he-year in APA too); a real title mismatch blocks", async () => {
  for (const [k, t] of Object.entries(R4_RTL_TITLES)) {
    const refs = webRefs([t, "Gate fixture page one on layout checks"], 200);
    const r = await gate(refs, "ieee");
    assertEquals([k, r.status, r.codes], [k, "passed", []], JSON.stringify(r.g.blocking_findings));
    if (k === "he-colon" || k === "he-year") {
      const a = await gate(refs, "apa");
      assertEquals([k, "apa", a.status], [k, "apa", "passed"], JSON.stringify(a.g.blocking_findings));
    }
  }
  const refs = webRefs([R4_RTL_TITLES["he-year"], "Gate fixture page one on layout checks"], 200);
  const wrong = await gate(refs, "ieee", ["דוח שנתי 2024", "Gate fixture page one on layout checks"]);
  assertEquals(wrong.codes, ["reference-mismatch"]);
});
