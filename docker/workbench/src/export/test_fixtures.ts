// Authored fixtures for the export's tests (research-workbench P6a). No live data: every id is
// generated here, every DOI is under the 10.5555 test prefix, every title is made up.
import type { CslItem } from "./csl.ts";
import type { RefItem } from "./render.ts";

export const fixtureId = (n: number) => `f6a00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const fixtureDoi = (n: number) => `10.5555/p6a.${String(n).padStart(3, "0")}`;

export function fixtureCsl(n: number): CslItem {
  return {
    type: "article-journal",
    title: `Fixture paper number ${n}`,
    author: [{ family: `Author${n}`, given: "Ann" }],
    "container-title": "Journal of Fixtures",
    volume: String(n),
    page: `${n}-${n + 9}`,
    issued: { "date-parts": [[2020, 1, 1]] },
    DOI: fixtureDoi(n),
  };
}

export const fixtureRefs = (count: number): RefItem[] =>
  Array.from({ length: count }, (_, i) => ({ key: `src-${fixtureId(i + 1)}`, number: i + 1, csl: fixtureCsl(i + 1) }));

const WORDS = "evidence model source claim result method sample analysis review signal measure network corpus figure study data paper effect value record".split(" ");

// A seeded sentence generator, so the fixture is the same on every run.
function sentence(seed: number, n: number): string {
  let x = seed;
  const w: string[] = [];
  for (let i = 0; i < n; i++) {
    x = ((Math.imul(x, 1103515245) + 12345) >>> 0) % 2147483648;
    w.push(WORDS[x % WORDS.length]);
  }
  const s = w.join(" ");
  return s[0].toUpperCase() + s.slice(1) + ".";
}

export const PARITY_HEADINGS = ["Parity fixture", "Introduction", "Methods", "Results", "Discussion", "References"];

// The parity fixture: headings, paragraphs, a list, twelve numbered references, NO math.
export function parityDocument(): { md: string; refs: RefItem[] } {
  const refs = fixtureRefs(12);
  const out = ["# Parity fixture", "", sentence(1, 40), ""];
  let k = 0;
  for (const h of PARITY_HEADINGS.slice(1, 5)) {
    out.push(`## ${h}`, "");
    for (let p = 0; p < 3; p++) {
      k++;
      out.push(`${sentence(k * 7, 55)} See [[content/source/${fixtureId(k)}|study ${k}]].`, "");
    }
    out.push(`- ${sentence(k * 11, 8)}`, `- ${sentence(k * 13, 9)}`, "");
  }
  return { md: out.join("\n"), refs };
}

export const CJK_TEXT = "这是中文文本。日本語のテキストです。한국어 텍스트입니다。";

export function cjkDocument(): { md: string; refs: RefItem[] } {
  const refs = fixtureRefs(1);
  return {
    md: `# CJK fixture\n\n${CJK_TEXT}\n\n中文段落引用 [[source/${fixtureId(1)}|文献]]。\n`,
    refs,
  };
}

// A document citing `count` references in the body, in order.
export function numberedDocument(count: number): { md: string; refs: RefItem[] } {
  const refs = fixtureRefs(count);
  const body = refs.map((_r, i) => `Claim ${i + 1} [[source/${fixtureId(i + 1)}|cited]].`).join("\n\n");
  return { md: `# Numbered fixture\n\n${body}\n`, refs };
}
