// rwr-appearance acceptance 2: AA contrast holds for EVERY accent offered, in light and dark. FAILS if any accent is below AA.
// The numbers come from theme/accents.css (the stylesheet the page ships), against the base tokens of theme/tokens.css.
// An accent drives: the filled button (on-accent on accent, and on accent-strong when hovered), links and the current menu
// item (accent-strong on the panel, the ground, the sunken ground and accent-soft), and the focus ring (3:1 on the ground).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ACCENTS } from "../src/lib/appearance";

const tokens = readFileSync("src/theme/tokens.css", "utf8");
const accents = readFileSync("src/theme/accents.css", "utf8");
const hexes = (block: string) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)].map((m) => [m[1], m[2]]));
const baseLight = hexes(tokens.slice(tokens.indexOf(":root {"), tokens.indexOf("@media")));
const baseDark = hexes(tokens.slice(tokens.indexOf(':root[data-theme="dark"]')));

// the three places accents.css declares its swatches: light (:root), system dark (media query) and explicit dark
const mediaStart = accents.indexOf("@media (prefers-color-scheme: dark)");
const explicitDark = accents.indexOf(':root[data-theme="dark"] {');
const lightBlock = accents.slice(accents.indexOf(":root {"), mediaStart);
const mediaBlock = accents.slice(mediaStart, explicitDark);
const darkBlock = accents.slice(explicitDark, accents.indexOf("}", explicitDark));
const light = hexes(lightBlock), darkSystem = hexes(mediaBlock), darkExplicit = hexes(darkBlock);

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

it("the accent list in the code is the list in the stylesheet, and every accent has all three values in all three places", () => {
  expect(ACCENTS.length).toBeGreaterThanOrEqual(5);
  for (const a of ACCENTS) for (const [name, set] of [["light", light], ["system dark", darkSystem], ["explicit dark", darkExplicit]] as const) {
    for (const suffix of ["", "-strong", "-soft"]) expect(set[`swatch-${a.id}${suffix}`], `${a.id}${suffix} in ${name}`).toBeTruthy();
  }
});
it("the two dark paths (follow-the-device and explicit dark) hold identical accent values", () => {
  expect(darkSystem).toEqual(darkExplicit);
});

for (const [mode, base, set] of [["light", baseLight, light], ["dark", baseDark, darkExplicit]] as const) {
  describe(`${mode}: every accent offered is AA`, () => {
    for (const a of ACCENTS) {
      const accent = set[`swatch-${a.id}`], strong = set[`swatch-${a.id}-strong`], soft = set[`swatch-${a.id}-soft`];
      const pairs: [string, string, string, number][] = [
        ["on-accent text on the accent (filled button)", base["on-accent"], accent, 4.5],
        ["on-accent text on the strong accent (hovered button)", base["on-accent"], strong, 4.5],
        ["strong accent text on the panel (links, cards)", strong, base.panel, 4.5],
        ["strong accent text on the ground", strong, base.bg, 4.5],
        ["strong accent text on the sunken ground", strong, base.sunken, 4.5],
        ["strong accent text on the soft accent (current menu item, tag)", strong, soft, 4.5],
        ["the accent as a control edge on the panel (3:1)", accent, base.panel, 3],
        ["the focus ring on the ground (3:1)", strong, base.bg, 3],
      ];
      for (const [what, fg, bg, min] of pairs) {
        it(`${a.id}: ${what} is at least ${min}:1`, () => {
          expect(fg && bg, `${a.id} ${what}`).toBeTruthy();
          expect(ratio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
        });
      }
    }
  });
}
