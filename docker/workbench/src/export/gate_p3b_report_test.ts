// deno test --allow-all src/export/gate_p3b_report_test.ts - rw-p6b-gate round 5 (coordinator, after P3b landed):
// a REAL P3b research report passes the gate's roll-up check. Not a fixture section: the report page is run
// through P3b's own export path (contracts/repo/trust.ts exportWithRollup -> reportCredibility -> shapeRollup ->
// rollupMarkdown -> withRollupSection) over a database answering as the live one does for a filed research job,
// rendered through pandoc + Typst and checked by runGate with the shipped registry row
// (export_required_sections/credibility-rollup). The image's test stage runs it.
import { assertEquals } from "jsr:@std/assert@1";
import { exportWithRollup, ROLLUP_HEADING } from "../contracts/repo/trust.ts";
import type { Db } from "../contracts/db.ts";
import { frontmatterOf, type GateInput, runGate } from "./gate.ts";
import { GATE_SECTION_ROWS, gatedEntries, sectionsOf } from "./gate_fixtures.ts";
import { type FormatDef, render, type StyleDef } from "./render.ts";
import { fxEntries } from "./registry_fixtures.ts";
import type { VisionConfig } from "./vision.ts";

const CSL_DIR = new URL("../../csl", import.meta.url).pathname;
const fmt = { key: "pdf", ...gatedEntries("export_formats").find((e) => e.key === "pdf")!.definition } as FormatDef;
const ieee = { key: "ieee", ...fxEntries("citation_styles").find((e) => e.key === "ieee")!.definition } as StyleDef;
const OFF: VisionConfig = { state: "off", timeoutMs: 1000, reason: "EXPORT_VISION_KEY is blank" };
const REPORT = "5b3b0000-0000-4000-8000-000000000001";
// the report page as the wiki writes it (research-report page class: content_type research_synthesis)
const PAGE = `---\ntitle: "Research: groundwater policy"\ntype: source\ncontent_type: "research_synthesis"\nreport_type: "deep_research"\n---\n\n` +
  `# Research: groundwater policy\n\n## Findings\n\nGroundwater withdrawals fell where metering was enforced.\n\n` +
  `_report credibility 0.41 (d15 weights v1 paper p1, kind general_theory)_\n`;
// a database answering as the live one does: the report is a research_synthesis source, filed by a finished
// job whose metrics carry the D15 roll-up (P3a's record shape)
function db(credibility: Record<string, unknown> | null): Db {
  const d: Db = {
    query: <T>(sql: string): Promise<T[]> => {
      if (/FROM public\.sources/.test(sql)) return Promise.resolve([{ id: REPORT }] as T[]);
      if (/FROM public\.research_jobs/.test(sql)) return Promise.resolve([{ id: "5b3b0000-0000-4000-8000-0000000000aa", credibility }] as T[]);
      return Promise.resolve([] as T[]);
    },
    tx: (fn) => fn(d),
  };
  return d;
}
async function gateOf(md: string) {
  const pdf = (await render({ md, refs: [], format: fmt, style: ieee, cslDir: CSL_DIR })).bytes;
  const g = await runGate({ vision: OFF }, { pdf, format: fmt, numeric: true, refs: [], frontmatter: frontmatterOf(md), required: sectionsOf(GATE_SECTION_ROWS) } as GateInput);
  return { status: g.status, codes: g.blocking_findings.map((f) => f.code) };
}

Deno.test("P3b (real): a research report exported through P3b's exportWithRollup carries `## Report credibility` and PASSES the gate", async () => {
  assertEquals(ROLLUP_HEADING, (GATE_SECTION_ROWS[0].definition as { heading: string }).heading, "the registry row names P3b's heading");
  const rec = { value: 0.41, claims: 5, below_floor: 1, judged_lines: 7, judged_not_filed: 0, kind: "general_theory", model_version: "d15 weights v1",
    weights: { paper: 1, web_article: 0.6, report: 0.8 }, filed: true, basis: "filed claims" };
  const md = await exportWithRollup(db(rec), `content/source/${REPORT}.md`, PAGE);
  assertEquals(md.includes(`## ${ROLLUP_HEADING}`), true, "P3b inserted its section");
  assertEquals(await gateOf(md), { status: "passed", codes: [] });
  // the same page WITHOUT P3b's section (the report as exported before P3b) is blocked: the check is real
  assertEquals(await gateOf(PAGE), { status: "blocked", codes: ["required-section-missing"] });
});

Deno.test("P3b (real): a report whose run recorded no weights still carries P3b's section (its 'No claim-kind weights' line) and passes", async () => {
  const md = await exportWithRollup(db({ value: null, judged_lines: 3, kind: "general_theory", model_version: "d15 weights v1", weights: {} }), `content/source/${REPORT}.md`, PAGE);
  assertEquals(await gateOf(md), { status: "passed", codes: [] });
});
