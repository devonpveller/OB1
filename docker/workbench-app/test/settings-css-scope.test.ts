// rw-settings-registry-tier (settings-shell review R1, attempt 1 tightened): every rule in the Settings screen's stylesheet applies only
// inside .settings, so a bare .seg / .tag / .legend / .seg-o / button.link / .saved / .err / .ro / .srow never reaches another screen
// (Start research's own .seg keeps its look: .startres .seg alone styles it). A selector is in scope only as `.settings <descendant ...>`:
// sibling combinators (`.settings ~ .seg`, `.settings + .tag`), a child combinator right after the root, `.settings.x`, `.settingsx` and
// `@import` are refused, and so is any other at-rule that is not @media.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every way a stylesheet escapes the .settings scope; [] = none. */
export function violations(raw: string): string[] {
  const css = strip(raw);
  const out: string[] = [];
  for (const m of css.matchAll(/@([a-zA-Z-]+)/g)) if (m[1] !== "media") out.push(`@${m[1]} is not allowed`);
  const selectors = [...css.matchAll(/(?:^|[}{;])\s*([^{}@;]+)\{/g)].flatMap((m) => m[1].split(",").map((s) => s.trim())).filter(Boolean);
  for (const sel of selectors) {
    const flat = sel.replace(/\[[^\]]*\]/g, "[]").replace(/\([^)]*\)/g, "()"); // attribute values and :not(...) arguments
    if (!/^\.settings\s+\S/.test(flat)) out.push(`not .settings + descendant: ${sel}`);
    else if (/^\.settings\s+[>+~]/.test(flat)) out.push(`a combinator right after .settings: ${sel}`);
    if (/[+~]/.test(flat)) out.push(`sibling combinator: ${sel}`);
  }
  return out;
}

const css = readFileSync("src/screens/settings/settings.css", "utf8");
const selectors = [...strip(css).matchAll(/(?:^|[}{;])\s*([^{}@;]+)\{/g)].flatMap((m) => m[1].split(",").map((s) => s.trim())).filter(Boolean);

describe("settings.css is scoped to the Settings screen", () => {
  it("has rules to check", () => expect(selectors.length).toBeGreaterThan(20));
  it("the shipped stylesheet has no way out of .settings", () => expect(violations(css)).toEqual([]));
  it("the named globals are each styled, under .settings", () => {
    for (const c of ["tag", "legend", "seg", "seg-o", "saved", "err", "ro", "srow"]) {
      expect(selectors.some((s) => new RegExp(String.raw`\.` + c + String.raw`(?![\w-])`).test(s)), c).toBe(true);
    }
    expect(selectors.some((s) => /^\.settings button\.link/.test(s))).toBe(true);
  });
  it("Start research's .seg is styled by .startres alone, and the Start screen sits outside .settings", () => {
    const start = readFileSync("src/screens/research-start/start.css", "utf8");
    expect(start).toMatch(/\.startres \.seg\s*\{[^}]*display:\s*flex[^}]*gap:\s*8px[^}]*flex-wrap:\s*wrap/);
    const tsx = readFileSync("src/screens/research-start/StartResearch.tsx", "utf8");
    expect(tsx).not.toMatch(/\bsettings\b["' ]/);
  });
  describe("mutants: each of these added to the stylesheet is caught", () => {
    const base = ".settings .ok { color: red; }\n";
    const mutants: Record<string, string> = {
      "a bare rule": ".seg { gap: 4px; }",
      "a bare tag rule": ".tag { color: red; }",
      "sibling ~": ".settings ~ .seg { gap: 4px; }",
      "sibling +": ".settings + .tag { color: red; }",
      "child right after the root": ".settings > .seg { gap: 4px; }",
      "compound root": ".settings.seg { gap: 4px; }",
      "a longer class": ".settingsx .seg { gap: 4px; }",
      "@import": '@import url("x.css");',
      "@font-face": "@font-face { font-family: x; }",
      "a bare rule inside @media": "@media (max-width: 700px) { .seg { gap: 1px; } }",
      "a list where one is bare": ".settings .a, .seg { gap: 4px; }",
      "sibling inside the rule": ".settings .a ~ .b { gap: 4px; }",
    };
    for (const [name, m] of Object.entries(mutants)) it(name, () => expect(violations(base + m).length, name).toBeGreaterThan(0));
    it("legit shapes stay green (attribute ~=, :not(), media with scoped rules)", () => {
      expect(violations('.settings .a[data-x~="y"] { a: b; }\n.settings .b:not(.c) { a: b; }\n@media (max-width: 700px) { .settings .d { a: b; } }')).toEqual([]);
    });
  });
});
