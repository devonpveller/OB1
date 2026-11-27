// rwr-lib-shell: every rule of the Library's stylesheet applies only inside .library (so a bare .chip / .strip / .tab never reaches
// another screen), and the strip cannot push the screen sideways: it wraps and its text shrinks inside main (the 400 px rule).
// The scope check is the one settings-css-scope.test.ts uses, for the .library root.
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
    if (!/^\.library\s+\S/.test(flat)) out.push(`not .library + descendant: ${sel}`);
    else if (/^\.library\s+[>+~]/.test(flat)) out.push(`a combinator right after .library: ${sel}`);
    if (/[+~]/.test(flat)) out.push(`sibling combinator: ${sel}`);
  }
  return out;
}

const css = readFileSync("src/screens/library/library.css", "utf8");
const selectors = [...strip(css).matchAll(/(?:^|[}{;])\s*([^{}@;]+)\{/g)].flatMap((m) => m[1].split(",").map((s) => s.trim())).filter(Boolean);

describe("library.css is scoped to the Library screen", () => {
  it("has rules to check", () => expect(selectors.length).toBeGreaterThan(15));
  it("the shipped stylesheet has no way out of .library", () => expect(violations(css)).toEqual([]));
  it("mutants: a bare rule, a sibling, an @import and a compound root are each caught", () => {
    const base = ".library .ok { color: red; }\n";
    for (const m of [".chip { gap: 4px; }", ".library ~ .chip { gap: 4px; }", '@import url("x.css");', ".library.chip { gap: 4px; }", "@media (max-width: 700px) { .chip { gap: 1px; } }"]) {
      expect(violations(base + m).length, m).toBeGreaterThan(0);
    }
  });
  it("the strip wraps and its chips can shrink, so nothing inside main is wider than main at 400 px", () => {
    expect(css).toMatch(/\.library \.strip-chips\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.library \.rv-chip\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.library \.rv-open\s*\{[^}]*(overflow-wrap:\s*anywhere|text-overflow:\s*ellipsis)/);
    expect(css).toMatch(/\.library \.tabs\s*\{[^}]*flex-wrap:\s*wrap/);
  });
});
