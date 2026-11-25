// rwr-ideas review R6: the Ideas screen's generic-looking classes (.lab, .kind, .mem, .plain, .rev, .review, .revise) are styled
// only inside the Ideas screen, so Start research's own `.lab` labels (StartResearch.tsx) and every other screen keep their look.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/styles.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const GENERIC = ["lab", "kind", "mem", "plain", "rev", "review", "revise"];
// every selector of every rule (media blocks included), one string each
const selectors = [...css.matchAll(/(?:^|[}{])\s*([^{}@]+)\{/g)].flatMap((m) => m[1].split(",").map((s) => s.trim())).filter(Boolean);
const mentions = (sel: string, cls: string) => new RegExp(String.raw`\.` + cls + String.raw`(?![\w-])`).test(sel);

describe("the Ideas screen's generic class names are scoped to the Ideas screen", () => {
  it("no rule styles a bare .lab, .kind, .mem, .plain, .rev, .review or .revise outside .ideas / .ideas-list / .idea-col", () => {
    const loose = selectors.filter((s) => GENERIC.some((c) => mentions(s, c)) && !/\.ideas(?![\w-])|\.ideas-list|\.idea-col/.test(s));
    expect(loose).toEqual([]);
  });
  it("the scoped rules exist (the screen is still styled)", () => {
    for (const c of GENERIC) expect(selectors.some((s) => mentions(s, c) && /\.ideas(?![\w-])|\.ideas-list|\.idea-col/.test(s))).toBe(true);
  });
  it("Start research's labels are outside any Ideas container, so none of those rules reach them", () => {
    const start = readFileSync("src/screens/research-start/StartResearch.tsx", "utf8");
    expect(start.match(/className="lab"/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(start).not.toMatch(/\bideas\b["' ]/);
  });
});
