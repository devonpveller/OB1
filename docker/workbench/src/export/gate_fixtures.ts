// Authored fixtures for the export verification gate (research-workbench P6b, rw-p6b-gate). No live
// data: every id is generated, every title made up. The same documents are in the lab vault
// (contract-test/export-gate-vault/), exported there through the real route.
import type { RegistryEntry } from "../contracts/registry.ts";
import { FX_ENTRIES } from "./registry_fixtures.ts";
import type { RequiredSection } from "./gate.ts";

// A table wider than the page: eight columns of long unbreakable cells. Typst lays it out at the
// text width, so the cells run into each other and the first runs off the left of the text area -
// the "clipped table" the gate must block (acceptance 1).
export const CLIPPED_TABLE_MD = `---
title: Clipped table fixture
---

# Results

The measurements are in the table below.

| Identifier | Measurement | Another | Long | More | Even more | Seven | Eight |
|---|---|---|---|---|---|---|---|
| AAAAAAAAAAAAAAAAAAAAAAAA | BBBBBBBBBBBBBBBBBBBBBBBBBBBB | CCCCCCCCCCCCCCCCCCCCCC | DDDDDDDDDDDDDDDDDDDDDDDD | EEEEEEEEEEEEEEEEEEEE | FFFFFFFFFFFFFFFFFFFFFFFFF | GGGGGGGGGGGGGGGGGGGGGGGGGG | HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHZZ |
| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
`;

// The same content in a table that fits: the clean fixture (acceptance 1).
export const CLEAN_TABLE_MD = `---
title: Clean table fixture
---

# Results

The measurements are in the table below.

| Identifier | Measurement | Note |
|---|---|---|
| A1 | 2.5 | fits the page |
| B2 | 3.1 | also fits |
`;

export const ROLLUP_HEADING = "Report credibility";

// A research report (the wiki's research-report page class: content_type research_synthesis), with or
// without the credibility roll-up section P3b writes (acceptance 5). The wording of the section is the
// registry row's (export_required_sections credibility-rollup), not P3b's final text.
export function reportMd(withRollup: boolean, contentType = "research_synthesis"): string {
  return [
    "---", "title: Gate report fixture", `content_type: ${contentType}`, "---", "",
    "# Findings", "", "The fixture report states two findings and their support.", "",
    ...(withRollup
      ? [`## ${ROLLUP_HEADING}`, "", "Report credibility 0.72 (credibility-v1, kind report).", "",
        "| Claim kind | Weight | Claims |", "|---|---|---|", "| empirical | 1.0 | 3 |", "| definitional | 0.5 | 1 |", "",
        "The claim-kind weights used: empirical 1.0, definitional 0.5.", ""]
      : []),
    "## Notes", "", "Nothing further.", "",
  ].join("\n");
}

// The P6b registry rows (init-export-gate.sql): gate_test.ts checks they are exactly what the
// migration writes whenever the migration is reachable (the repo, not the image).
export const GATE_SECTION_ROWS: RegistryEntry[] = [{
  registry: "export_required_sections", key: "credibility-rollup", version: 1, label: "Report credibility roll-up (D15, P3b)",
  definition: { when: { frontmatter: { content_type: ["research_synthesis"] } }, heading: "Report credibility", must_include: ["weights"], formats: ["pdf"], owner: "P3b" },
  retired_at: null, superseded_by: null,
}];

// The registries as the gated export sees them: P6a's rows with the pdf row's gate flag, plus P6b's.
export const gatedEntries = (registry: string): RegistryEntry[] =>
  [...FX_ENTRIES.map((e) => e.registry === "export_formats" && e.key === "pdf" ? { ...e, definition: { ...e.definition, gate: true } } : e), ...GATE_SECTION_ROWS]
    .filter((x) => x.registry === registry);

export const sectionsOf = (rows: RegistryEntry[]): RequiredSection[] =>
  rows.map((e) => ({ key: e.key, ...(e.definition as Omit<RequiredSection, "key">) }));

// rw-p6b-gate round 2: the tester's repros (t-p6b-gate, journal/evidence/rw-p6b-gate/tester/probe-inputs),
// verbatim; the same files are in the lab vault (contract-test/export-gate-vault/notes/p6b/).
//   D1 ordinary prose and a rich clean page (kerning "w." "y.", CJK quotes) must PASS;
//   D2 a left-aligned table whose first cell spills over an inline-code cell (two fonts) must be BLOCKED;
//   D5 a roll-up heading with a bare number and "weights" only in a LATER section must be BLOCKED;
//      the roll-up as P3b prints it (contracts/repo/trust.ts rollupMarkdown, `## Report credibility`) passes.
export const E_WDOT_MD = "---\ntitle: Plain English sentences\n---\n\n# Method\n\nThe steps are listed below. We know how. The results follow below. Start now.\n";
export const E_PROSE_MD = "---\ntitle: Plain English prose\n---\n\n# Summary\n\nThe survey ran for a year. Most answers were narrow, and the review was slow. Each reply was read by two people, who agreed on nearly every entry. The study is small, but the view it gives is new.\n\nThe next round will follow. We will show how the panel changed, why, and by how much.\n";
export const C1_CLEAN_RICH_MD = "---\ntitle: A rich but clean document\n---\n\n# Introduction\n\nThis document has *emphasis*, **strong text**, `inline code`, a footnote,[^1] a link to <https://example.org/page>, and AVAST To Ty kerning pairs: AV AW Yo Te Ta.\n\n> A block quote with a sentence that is long enough to wrap onto a second line in the rendered output, to check quotes.\n\n1. First item\n2. Second item with a longer sentence that wraps across the line so the list item continues below.\n   - nested bullet\n   - another nested bullet\n10. Tenth item\n\n## Scripts\n\nChinese: 研究工作台导出验证门。 Japanese: 日本語のテキスト。 Hebrew: שָׁלוֹם עוֹלָם. Arabic: مَرْحَبًا بِالْعَالَمِ. Vietnamese: Tiếng Việt có dấu.\n\n## A table\n\n| Name | Value | Unit | Note | Flag | Extra |\n|---|---|---|---|---|---|\n| alpha | 1.0 | m | ok | y | - |\n| beta | 22.5 | kg | fine | n | - |\n| gamma | 0.003 | s | small | y | - |\n\n## Math\n\nThe energy is $E = mc^2$ and the sum is $\\sum_{i=1}^{n} x_i$.\n\n---\n\nFinal paragraph with \"quotes\", 'single', em—dash, en–dash, ellipsis… and hyphen-ated words.\n\n[^1]: The footnote text, which is short.";
export const C1_LEFT_CODE22_MD = "---\ntitle: Left rel cols code 22\n---\n\n# Table\n\n| Key | Description of the item in a very long column that makes pandoc emit relative widths for this table here |\n|:-|:-----------------------------------------------------------------------------------------------------------|\n| XXXXXXXXXXXXXXXXXXXXXX | `alpha beta gamma delta epsilon zeta eta theta iota kappa` |\n| XXXXXXXXXXXXXXXXXXXXXX | `alpha beta gamma delta epsilon zeta eta theta iota kappa` |\n";
export const C1_LEFT_TEXT22_MD = "---\ntitle: Left rel cols text 22\n---\n\n# Table\n\n| Key | Description of the item in a very long column that makes pandoc emit relative widths for this table here |\n|:-|:-----------------------------------------------------------------------------------------------------------|\n| XXXXXXXXXXXXXXXXXXXXXX | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n| XXXXXXXXXXXXXXXXXXXXXX | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n";
export const R_BARE_NUMBER_LATER_WEIGHTS_MD = "---\ntitle: Probe report\ncontent_type: research_synthesis\n---\n\n# Findings\n\nThe report states findings.\n\n## Report credibility\n\n0.72\n\n## Method\n\nWe discuss evidence weights in general terms here.\n";
export const R_BOLD_PARA_MD = "---\ntitle: Probe report\ncontent_type: research_synthesis\n---\n\n# Findings\n\nThe report states findings.\n\n**Report credibility**\n\nReport credibility 0.72 (credibility-v1).\n\nThe claim-kind weights used: empirical 1.0, definitional 0.5.\n\n## Notes\n\nNothing.\n";
export const REPORT_P3B_ROLLUP_MD = "---\ntitle: \"Research: P3b-shaped report\"\ntype: source\ncontent_type: \"research_synthesis\"\nreport_type: \"deep_research\"\n---\n\n# Research: P3b-shaped report\n\n## Report credibility\n\nReport credibility 0.41 (d15 weights v1, kind general_theory), from 12 judged lines.\n\nClaim kind: general_theory. Model: d15 weights v1. The weights the roll-up used:\n\n| Source family | Weight |\n|---|---|\n| paper | 1.00 |\n| web | 0.60 |\n\n## Findings\n\nA finding.\n";
