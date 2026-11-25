// rw-settings-registry-tier (settings-shell review R1): every rule in the Settings screen's stylesheet applies only inside
// .settings, so a bare .seg / .tag / .legend / .seg-o / button.link / .saved / .err / .ro / .srow never reaches another
// screen (Start research's own .seg keeps its look: .startres .seg alone styles it).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/screens/settings/settings.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const selectors = [...css.matchAll(/(?:^|[}{])\s*([^{}@]+)\{/g)].flatMap((m) => m[1].split(",").map((s) => s.trim())).filter(Boolean);

describe("settings.css is scoped to the Settings screen", () => {
  it("has rules to check", () => expect(selectors.length).toBeGreaterThan(20));
  it("no selector applies outside .settings (every one starts with .settings)", () => {
    expect(selectors.filter((s) => !/^\.settings(?![\w-])/.test(s))).toEqual([]);
  });
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
});
