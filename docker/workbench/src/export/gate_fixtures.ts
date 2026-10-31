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

// rw-p6b-gate round 3: the tester's attempt-2 repros (t-p6b-gate2, journal/evidence/rw-p6b-gate/tester/attempt2/
// probe-inputs), verbatim, keyed by file name; the same files are in the lab vault. s-* tables BLOCKED (D8;
// s-lower-22 is the clean control: its cell wraps), n-* clean pages PASS (D9 math, CJK punctuation, RTL text).
export const ROUND3_MD: Record<string, string> = {
  "s-text-01": "---\ntitle: Spill text 1\n---\n\n# Table\n\n| Key | Description of the item in a very long column that makes pandoc emit relative widths for this table here |\n|:-|:-----------------------------------------------------------------------------------------------------------|\n| X | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n| X | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n| X | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n| X | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n",
  "s-text-02": "---\ntitle: Spill text 2\n---\n\n# Table\n\n| Key | Description of the item in a very long column that makes pandoc emit relative widths for this table here |\n|:-|:-----------------------------------------------------------------------------------------------------------|\n| XX | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n| XX | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n| XX | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n| XX | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n",
  "s-code-01": "---\ntitle: Spill code 1\n---\n\n# Table\n\n| Key | Description of the item in a very long column that makes pandoc emit relative widths for this table here |\n|:-|:-----------------------------------------------------------------------------------------------------------|\n| X | `alpha beta gamma delta epsilon zeta eta theta iota kappa` |\n| X | `alpha beta gamma delta epsilon zeta eta theta iota kappa` |\n| X | `alpha beta gamma delta epsilon zeta eta theta iota kappa` |\n| X | `alpha beta gamma delta epsilon zeta eta theta iota kappa` |\n",
  "s-code-02": "---\ntitle: Spill code 2\n---\n\n# Table\n\n| Key | Description of the item in a very long column that makes pandoc emit relative widths for this table here |\n|:-|:-----------------------------------------------------------------------------------------------------------|\n| XX | `alpha beta gamma delta epsilon zeta eta theta iota kappa` |\n| XX | `alpha beta gamma delta epsilon zeta eta theta iota kappa` |\n| XX | `alpha beta gamma delta epsilon zeta eta theta iota kappa` |\n| XX | `alpha beta gamma delta epsilon zeta eta theta iota kappa` |\n",
  "s-1row-text-02": "---\ntitle: One row spill 2\n---\n\n# Table\n\n| Key | Description of the item in a very long column that makes pandoc emit relative widths for this table here |\n|:-|:-----------------------------------------------------------------------------------------------------------|\n| XX | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n",
  "s-1row-text-03": "---\ntitle: One row spill 3\n---\n\n# Table\n\n| Key | Description of the item in a very long column that makes pandoc emit relative widths for this table here |\n|:-|:-----------------------------------------------------------------------------------------------------------|\n| XXX | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n",
  "s-math-22": "---\ntitle: Spill math\n---\n\n# Table\n\n| Key | Description of the item in a very long column that makes pandoc emit relative widths for this table here |\n|:-|:-----------------------------------------------------------------------------------------------------------|\n| $xxxxxxxxxxxxxxxxxxxxxx$ | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n| $xxxxxxxxxxxxxxxxxxxxxx$ | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n| $xxxxxxxxxxxxxxxxxxxxxx$ | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n| $xxxxxxxxxxxxxxxxxxxxxx$ | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n",
  "s-lower-22": "---\ntitle: Spill lower\n---\n\n# Table\n\n| Key | Description of the item in a very long column that makes pandoc emit relative widths for this table here |\n|:-|:-----------------------------------------------------------------------------------------------------------|\n| iiiiiiiiiiiiiiiiiiiiii | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n| iiiiiiiiiiiiiiiiiiiiii | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n| iiiiiiiiiiiiiiiiiiiiii | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n| iiiiiiiiiiiiiiiiiiiiii | alpha beta gamma delta epsilon zeta eta theta iota kappa |\n",
  "n-math": "---\ntitle: Math rich page\n---\n\n# Math\n\nInline: $E = mc^2$, $a_i^2 + b_i^2$, $x_{ij}^{2}$, $x_{i,j}^{k+1}$, $\\hat{x}$, $\\vec{v}$, $\\bar{y}$, $\\tilde{z}$, $\\dot{q}$, $x'$, $f''(x)$.\n\nDisplay sums and integrals:\n\n$$\\sum_{i=1}^{n} x_i^2 = \\int_{0}^{1} f(x)\\,dx + \\prod_{k=1}^{m} a_k$$\n\n$$\\lim_{n \\to \\infty} \\left(1 + \\frac{1}{n}\\right)^n = e$$\n\nFractions and roots:\n\n$$\\frac{a+b}{c+d} + \\sqrt{x^2 + y^2} + \\sqrt[3]{z} + \\binom{n}{k}$$\n\nAccents over several letters:\n\n$$\\overline{AB} + \\widehat{xyz} + \\widetilde{abc} + \\overrightarrow{PQ} + \\underline{uv}$$\n\nStacked scripts: $T_{\\mu\\nu}^{\\alpha\\beta}$, $R^{\\rho}_{\\sigma\\mu\\nu}$, $\\Gamma^{i}_{jk}$, $A_{ij}^{kl}$, $e^{i\\pi} + 1 = 0$.\n\nMatrices:\n\n$$\\begin{pmatrix} a_{11} & a_{12} \\\\ a_{21} & a_{22} \\end{pmatrix} \\begin{bmatrix} x_1 \\\\ x_2 \\end{bmatrix}$$\n",
  "n-math-accents": "---\ntitle: Math accents\n---\n\n# Accents and limits\n\n$$\\widehat{abcdef} \\quad \\overline{ABCDEF} \\quad \\widetilde{uvwxyz} \\quad \\overbrace{a+b+c}^{n} \\quad \\underbrace{x+y+z}_{m}$$\n\n$$\\sum_{i=1}^{n}\\sum_{j=1}^{m} a_{ij} \\quad \\bigcup_{k=1}^{\\infty} A_k \\quad \\bigcap_{k=1}^{\\infty} B_k \\quad \\max_{x \\in X} f(x)$$\n\nInline limits $\\sum_{i=1}^{n} i$, $\\int_a^b g$, $\\oint_C F$ and $\\iint_{D} h$.\n",
  "n-math-vector": "---\ntitle: Vectors in a physics note\n---\n\n# Kinematics\n\nThe displacement from $P$ to $Q$ is $\\overrightarrow{PQ}$ and the velocity is $\\vec{v} = \\frac{d\\vec{r}}{dt}$.\n",
  "n-math-brace": "---\ntitle: A brace in a derivation\n---\n\n# Counting\n\n$$\\underbrace{1 + 1 + \\cdots + 1}_{n} = n$$\n",
  "n-cjk-long": "---\ntitle: CJK prose\n---\n\n# 中文与日本語\n\n研究工作台的导出验证门检查每一个导出的文件。「引号」『双引号』、顿号，逗号。句号！感叹号？问号；分号：冒号（括号）《书名号》——破折号……省略号。\n\n日本語の文章です。「かぎ括弧」、読点。句点！「引用」（括弧）『二重』・中黒、カタカナ、ひらがな、漢字。長い文章が次の行へ折り返すことを確認するための文です。\n\n한국어 문장입니다. 「인용」, 쉼표. 마침표! 물음표? 괄호(예) 그리고 긴 문장이 다음 줄로 넘어가는지 확인합니다.\n\nMixed: the term 研究 (research), 「study」, 'survey', and 《review》, 1。2、3，4！\n",
  "n-arabic-hebrew2": "---\ntitle: RTL scripts\n---\n\n# RTL\n\nالعربية: مَرْحَبًا بِالْعَالَمِ. اللُّغَةُ الْعَرَبِيَّةُ جَمِيلَةٌ، وَالْكِتَابَةُ مِنَ الْيَمِينِ إِلَى الْيَسَارِ. لا إله. الأرقام ١٢٣٤٥٦٧٨٩٠ و 2026.\n\nفارسی: زبان فارسی زیباست.\n\nעברית: שָׁלוֹם עוֹלָם. בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ. מספרים 2026.\n\nMixed direction: the word مرحبا means hello, and שלום means peace (both 2026).\n",
};

// rw-p6b-gate round 4: the tester's attempt-3 titles (t-p6b-gate3, journal/evidence/rw-p6b-gate/tester/attempt3/
// probe-inputs/p4-sources.sql and probe-runner-a3b.ps1), verbatim. D13: long titles Typst hyphenates in an
// author-date list; D14: Hebrew/Arabic titles with neutrals and digits between RTL words.
export const R4_REAL_TITLES: string[] = ["Attention is all you need: Revisiting transformer architectures for long-context sequence modelling in low-resource settings", "A systematic review of groundwater management interventions and their measured effects on agricultural productivity", "Deep residual learning for image recognition", "Climate change adaptation strategies among smallholder farmers in sub-Saharan Africa: Evidence from household surveys", "The economics of information security investment under uncertainty", "Interpretable machine learning for clinical decision support: Opportunities, challenges, and a research agenda"];
export const R4_MANY_TITLES: string[] = ["Zebra study: and drought administrative in", "Apple study: conditions drought implications conditions", "Mango study: regional water conditions implications municipal levels with practices drought", "Quartz study: administrative infrastructure basins with", "Delta study: administrative across for with with levels water water arid planning conditions with in several of practices", "Harbor study: municipal with with including across basins infrastructure implications and regional policy infrastructure and infrastructure administrative and term with under long arid and practices arid basins of across under administrative and", "Kestrel study: basins drought provincial basins infrastructure municipal administrative water drought design under drought basins basins infrastructure semi", "Bramble study: and water national agencies design across national regional drought", "Orchid study: conditions national of policy national and planning for analysis under several and municipal arid regional conditions drought water with basins long arid provincial agencies", "Vector study: agencies administrative implications basins provincial long provincial term conditions across drought planning basins and several semi regional drought including with in for several long with including long for design regional", "Juniper study: and design policy basins", "Falcon study: across with administrative regional municipal several basins for with term planning long across drought with management for and national municipal design arid levels regional", "Nimbus study: and in long and", "Cobalt study: analysis design several design", "Willow study: long for long administrative implications for in term under basins of across national long and policy", "Lantern study: several administrative with implications levels water for for water levels term design under water term for", "Ember study: including in water long term regional levels implications municipal in management of national and municipal design and and analysis infrastructure for semi practices provincial", "Ivory study: water administrative term several basins levels implications water municipal regional levels municipal administrative conditions term including", "Pioneer study: policy practices provincial water conditions long basins conditions several", "Saffron study: implications design infrastructure infrastructure levels term design municipal levels infrastructure management arid implications policy semi drought under long design municipal including basins practices agencies", "Zebra second study: infrastructure national and planning", "Apple second study: including and in water policy term term long water", "Mango second study: drought implications agencies arid policy conditions long several municipal term policy management semi in in and", "Quartz second study: in including provincial arid arid provincial agencies conditions planning several national basins and infrastructure analysis national across basins conditions and long semi with under provincial national planning conditions management and", "Delta second study: management under of water planning arid for management across", "Harbor second study: levels long water long administrative under management under administrative semi agencies and semi regional planning management in administrative and under term for for and", "Kestrel second study: levels including semi policy analysis for with of in under design basins national implications planning provincial", "Bramble second study: and provincial across implications design planning design provincial infrastructure", "Orchid second study: basins including levels regional of provincial infrastructure and levels practices agencies provincial national of analysis for agencies water administrative and administrative design practices municipal", "Vector second study: semi municipal for administrative arid national implications conditions design", "Juniper second study: regional policy design under of administrative administrative regional provincial under municipal drought agencies provincial several long", "Falcon second study: management infrastructure across semi and across design conditions drought", "Nimbus second study: policy management management with national regional long municipal with", "Cobalt second study: under water several water regional regional basins in policy drought municipal practices practices management management conditions", "Willow second study: several and term drought across water semi including national implications and implications of water planning for", "Lantern second study: implications in water provincial in drought administrative across practices policy and infrastructure and administrative agencies planning under several water in across analysis in for drought national conditions basins planning basins", "Ember second study: of policy design administrative several and across with term basins practices including term policy in for", "Ivory second study: provincial management regional long planning agencies infrastructure policy policy planning agencies including analysis with municipal term management long term across administrative analysis administrative regional analysis practices long with levels including", "Pioneer second study: including term arid under water implications practices basins several practices including national design semi under for including planning levels water agencies design policy arid", "Saffron second study: term under infrastructure administrative"];
export const R4_RTL_TITLES: Record<string, string> = {"he-colon": "דוח שנתי: סיכום השנה", "he-year": "דוח שנתי 2023", "ar-comma": "التقرير السنوي، الجزء الأول", "ar-indic": "تقرير عام ٢٠٢٣", "he-paren": "ספר (מהדורה שנייה)", "he-latin": "מדריך Python למתחילים", "he-plain": "שלום עולם", "lat-colon-he": "Annual report: דוח שנתי", "ar-hyphen": "دليل المستخدم - الإصدار الثاني", "he-quote": "המאמר \"שלום\" והתגובות"};
