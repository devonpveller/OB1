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
