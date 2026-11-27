// rwr-voices: every rule in the Cast and voices stylesheet applies only inside .voices, so a bare .f / .opt / .order / .sample / .vrow
// never reaches another screen (the same rule as settings-css-scope.test.ts). A selector is in scope only as `.voices <descendant ...>`;
// sibling combinators, a child combinator right after the root, `.voices.x` and every at-rule but @media are refused.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

export function violations(raw: string): string[] {
  const css = strip(raw);
  const out: string[] = [];
  for (const m of css.matchAll(/@([a-zA-Z-]+)/g)) if (m[1] !== "media") out.push(`@${m[1]} is not allowed`);
  const selectors = [...css.matchAll(/(?:^|[}{;])\s*([^{}@;]+)\{/g)].flatMap((m) => m[1].split(",").map((s) => s.trim())).filter(Boolean);
  for (const sel of selectors) {
    const flat = sel.replace(/\[[^\]]*\]/g, "[]").replace(/\([^)]*\)/g, "()");
    if (!/^\.voices(\s+\S|$)/.test(flat)) out.push(`not .voices + descendant: ${sel}`);
    else if (/^\.voices\s+[>+~]/.test(flat)) out.push(`a combinator right after .voices: ${sel}`);
    if (/[+~]/.test(flat)) out.push(`sibling combinator: ${sel}`);
  }
  return out;
}

const css = readFileSync("src/screens/voices/voices.css", "utf8");
const selectors = [...strip(css).matchAll(/(?:^|[}{;])\s*([^{}@;]+)\{/g)].flatMap((m) => m[1].split(",").map((s) => s.trim())).filter(Boolean);

describe("voices.css is scoped to the Cast and voices screen", () => {
  it("has rules to check", () => expect(selectors.length).toBeGreaterThan(25));
  it("the shipped stylesheet has no way out of .voices", () => expect(violations(css)).toEqual([]));
  it("every inner flex row wraps and the grid collapses at phone width (no sideways scroll inside main at 400 px)", () => {
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.voices \.vgrid \{ grid-template-columns: minmax\(0, 1fr\)/);
    const rules = strip(css).split("}");
    for (const sel of [".voices .vtabs", ".voices .opt", ".voices .vopts", ".voices .sample", ".voices .order li", ".voices .vfoot-row", ".voices .vform-top"]) {
      const rule = rules.find((r) => r.trim().startsWith(sel + " {")) ?? "";
      expect(rule, sel).toMatch(/flex-wrap:\s*wrap|overflow-wrap:\s*anywhere/);
    }
  });
  describe("mutants: each of these added to the stylesheet is caught", () => {
    const base = ".voices .ok { color: red; }\n";
    const mutants: Record<string, string> = {
      "a bare rule": ".opt { gap: 4px; }", "sibling ~": ".voices ~ .f { gap: 4px; }", "sibling +": ".voices + .f { gap: 4px; }",
      "child right after the root": ".voices > .f { gap: 4px; }", "compound root": ".voices.f { gap: 4px; }", "a longer class": ".voicesx .f { gap: 4px; }",
      "@import": '@import url("x.css");', "@font-face": "@font-face { font-family: x; }", "a bare rule inside @media": "@media (max-width: 700px) { .f { gap: 1px; } }",
      "a list where one is bare": ".voices .a, .f { gap: 4px; }", "sibling inside the rule": ".voices .a ~ .b { gap: 4px; }",
    };
    for (const [name, m] of Object.entries(mutants)) it(name, () => expect(violations(base + m).length, name).toBeGreaterThan(0));
  });
});
