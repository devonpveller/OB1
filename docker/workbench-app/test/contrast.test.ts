// WCAG AA (4.5:1) for every text-on-background pair the shell and its components use, in the light and the
// dark token sets, computed from tokens.css. The browser suite (axe) checks what is on screen; this also
// covers the parts that are not on a route yet (the locked-document chip, the For document bar, the toast,
// the typed-confirm button).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("src/theme/tokens.css", "utf8");
function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)].map((m) => [m[1], m[2]]));
}
const light = tokens(css.slice(css.indexOf(":root {"), css.indexOf("@media")));
const dark = tokens(css.slice(css.indexOf(':root[data-theme="dark"]')));
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [text token, background token, where it is used]
const PAIRS: [string, string, string][] = [
  ["fg", "bg", "body"], ["fg", "panel", "cards, top bar, rail"], ["fg-2", "panel", "lead text"], ["fg-2", "sunken", "grey chip"],
  ["muted", "panel", "section labels, counts, kbd"], ["muted", "panel-2", "search box"], ["muted", "sunken", "hovered muted item"],
  ["accent-strong", "accent-soft", "current menu item, teal chip"], ["accent-strong", "panel", "links"], ["accent-strong", "bg", "links on the ground"],
  ["amber-text", "amber-soft", "banner, For document bar, amber chip, current document"], ["amber-text", "panel", "Locked document label"],
  ["on-accent", "accent", "+ Start research"], ["on-accent", "accent-strong", "+ Start research hovered"],
  ["lock-fg", "lock-bg", "locked-document chip"], ["lock-fg", "lock-btn", "chip buttons"],
  ["danger", "panel", "Settings: a refused save"], ["accent-strong", "sunken", "Settings: a hovered section"], ["bg", "fg", "toast, avatar"], ["bg", "danger", "typed-confirm button"], ["fg", "panel-2", "typed-confirm input"],
];
for (const [name, t] of [["light", light], ["dark", dark]] as const) {
  describe(`${name} tokens: AA text contrast`, () => {
    for (const [fg, bg, where] of PAIRS) {
      it(`${fg} on ${bg} (${where}) is at least 4.5:1`, () => {
        expect(t[fg], fg).toBeTruthy();
        expect(t[bg], bg).toBeTruthy();
        expect(ratio(t[fg], t[bg]), `${t[fg]} on ${t[bg]}`).toBeGreaterThanOrEqual(4.5);
      });
    }
  });
}
