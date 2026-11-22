// rwr-picker acceptance 1: there is exactly ONE picker / list-search implementation. The guard is STRUCTURAL
// (test/guard/structure.ts): it parses every source file, resolves imports, and applies rules R1-R5. This file runs it
// on the real tree (must be clean) and on the real tree plus each planted bypass (each must turn it red) - including the
// six the tester of attempt 1 found getting past the earlier name-shaped guard.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, readApp, SEARCH_ALLOW, type Files } from "./guard/structure";

const ROOT = join(__dirname, "..");
const real = readApp(ROOT);
const plus = (extra: Record<string, string>, opts?: Parameters<typeof check>[1]) => check(new Map([...real, ...Object.entries(extra)]) as Files, opts);
const red = (extra: Record<string, string>, rule: RegExp, opts?: Parameters<typeof check>[1]) => {
  const v = plus(extra, opts);
  expect(v.length, `expected a violation, got none for ${Object.keys(extra)}`).toBeGreaterThan(0);
  expect(v.some((x) => rule.test(x)), v.join("\n")).toBe(true);
};

describe("one picker, one list search (structural)", () => {
  it("the real app is clean", () => {
    expect(check(real)).toEqual([]);
  });
  it("walks every script kind under src/ (the guard sees .ts .tsx .css-free sources, and the harness)", () => {
    expect([...real.keys()]).toContain("src/components/picker/ItemPicker.tsx");
    expect([...real.keys()]).toContain("src/components/picker/harness/main.tsx");
    expect([...real.keys()].every((k) => /\.(ts|tsx|js|jsx|mjs|mts|cjs)$/.test(k))).toBe(true);
  });

  describe("the tester's six bypasses of the name-shaped guard now turn it red", () => {
    it("B1 a .jsx file with its own listbox", () => red({ "src/components/OtherPicker.jsx": `export const X = () => <ul role="listbox"><li role="option">a</li></ul>;` }, /R1/));
    it("B2 a relative import of ./picker/ItemPicker that skips the index", () =>
      red({ "src/components/Wrap.tsx": `import { ItemPicker } from "./picker/ItemPicker"; export const W = () => <ItemPicker mode="single" onConfirm={() => {}} />;` }, /R3.*ItemPicker\.tsx/));
    it("B3 a screen using useLibrarySearch with its own listbox", () =>
      red({ "src/screens/Voices.tsx": `import { useLibrarySearch } from "../components/picker";\nexport function VoicesScreen(){ const s = useLibrarySearch("a",{kind:"library"}); return <ul role="listbox">{s.items.map(i=><li key={i.id} role="option">{i.title}</li>)}</ul>; }` }, /R2.*useLibrarySearch/));
    it("B4 an own fetch with the route string split", () =>
      red({ "src/components/SourceFinder.tsx": `import { api } from "../lib/api";\nexport const find = (q: string) => api("GET", "/workbench/contract/" + "search?q=" + q);` }, /R4/));
    it("B5 a re-export of ItemPicker under another name", () =>
      red({ "src/components/Alias.ts": `export { ItemPicker as Chooser2 } from "./picker";` }, /R3.*re-exports/));
    it("B6 a screen importing SEARCH_URL and calling the route itself with its own listbox", () =>
      red({ "src/screens/Cast.tsx": `import { SEARCH_URL } from "../components/picker";\nimport { api } from "../lib/api";\nexport const go = (q: string) => api("GET", \`\${SEARCH_URL}?q=\${q}\`);\nexport const L = () => <div role="listbox"><div role="option" /></div>;` }, /R2.*SEARCH_URL/));
  });

  describe("the tester's attempt-2 bypasses (round 3)", () => {
    it("F1 a list UI outside src/ imported from src through ../../extra/Pick", () =>
      red({ "extra/Pick.tsx": `export const Pick = () => <ul role="listbox"><li role="option">x</li></ul>;`, "src/components/Use.tsx": `import { Pick } from "../../extra/Pick"; export const U = Pick;` }, /R6/));
    it("F1 an import that leaves src/ is refused even when the target is not on disk map, dynamic import and require too", () => {
      red({ "src/components/Out.ts": `export * from "../../../elsewhere/thing";` }, /R6/);
      red({ "src/components/Out2.ts": `export const f = () => import("../../extra/x");` }, /R6/);
      red({ "src/components/Out3.js": `const x = require("../../extra/x");` }, /R6/);
    });
    it("F1 files outside src/ that are handed to the guard are checked as well", () =>
      red({ "extra/Pick.tsx": `export const Pick = () => <ul role="listbox" />;` }, /R1/));
    it("F2 role built by concatenation, through a const, or from a template", () => {
      red({ "src/components/N1.tsx": `const r = "list" + "box"; export const N1 = () => <ul role={r}><li role={"op" + "tion"}>x</li></ul>;` }, /R1/);
      red({ "src/components/N1b.tsx": `export const N = () => <ul role={"list" + "box"} />;` }, /R1/);
      red({ "src/components/N1c.tsx": `export const N = () => <li role={\`op\${"tion"}\`} />;` }, /R1/);
      red({ "src/components/N1d.tsx": `const a = "list"; const b = a + "box"; export const N = () => <ul role={b} />;` }, /R1/);
      red({ "src/components/N1e.tsx": `import { createElement } from "react"; export const N = () => createElement("ul", { role: "list".concat("box") });` }, /R1/);
    });
    it("F2 residual closed cheaply: grid / row / tree roles are list UI too", () => {
      red({ "src/components/N5.tsx": `export const N5 = () => <div role="grid"><div role="row" /></div>;` }, /R1/);
      red({ "src/components/N5b.tsx": `export const N5 = () => <div role={"tr" + "ee"} />;` }, /R1/);
    });
    it("F2 a new file inside picker/harness may not import the search exports (R2 applies inside the picker too)", () =>
      red({ "src/components/picker/harness/Other.tsx": `import { useLibrarySearch } from "../search"; export const O = () => { useLibrarySearch("a", {} as never); return null; };` }, /R2.*Other\.tsx/));
  });

  // Attempt 3: an allow-list entry for a non-picker file (Home's data file) made it a laundering hop. Home's ask box is now
  // a picker consumer (PickerResults through the index); the same shapes from ANY file outside the picker stay red.
  describe("the tester's attempt-3 bypasses: a file outside picker/ re-binds or re-exports a search export", () => {
    const HD = "src/screens/home/home-data.ts";
    const hd = (extra: string) => real.get(HD)! + "\n" + extra;
    const IMP = `import { SEARCH_URL } from "../../components/picker";\n`;
    it("Home's data file and Home itself import no search export (the ask box asks through PickerResults)", () => {
      expect(real.get(HD)).not.toMatch(/SEARCH_URL|useLibrarySearch|searchLibrary|searchUrl|contract\/search/);
      expect(real.get("src/screens/home/Home.tsx")).toMatch(/import \{ PickerResults \} from "\.\.\/\.\.\/components\/picker"/);
    });
    it("H1 home-data re-binds SEARCH_URL as a const; another screen calls the route with it", () =>
      red({
        [HD]: hd(IMP + `export const HOME_URL = SEARCH_URL;`),
        "src/screens/Second.tsx": `import { api } from "../lib/api";\nimport { HOME_URL } from "./home/home-data";\nexport const findAll = (q: string) => api("GET", HOME_URL + "?q=" + encodeURIComponent(q) + "&limit=50");`,
      }, /R2 src\/screens\/home\/home-data\.ts.*SEARCH_URL/));
    it("H2 home-data re-exports SEARCH_URL locally (no module specifier); another screen imports it", () =>
      red({
        [HD]: hd(IMP + `export { SEARCH_URL };`),
        "src/screens/Second.tsx": `import { api } from "../lib/api";\nimport { SEARCH_URL } from "./home/home-data";\nexport const findAll = (q: string) => api("GET", \`\${SEARCH_URL}?q=\${q}\`);`,
      }, /R2 src\/screens\/home\/home-data\.ts.*SEARCH_URL/));
    it("H3 home-data re-exports useLibrarySearch from the picker (module specifier)", () =>
      red({ [HD]: hd(`export { useLibrarySearch } from "../../components/picker";`) }, /R2 src\/screens\/home\/home-data\.ts.*useLibrarySearch/));
    it("H4 home-data imports useLibrarySearch + searchLibrary and hands them on; a screen lists results", () =>
      red({
        [HD]: hd(`import { useLibrarySearch, searchLibrary } from "../../components/picker";\nexport const useHomeSearch = useLibrarySearch;\nexport const homeSearch = searchLibrary;`),
        "src/screens/Sources.tsx": `import { useHomeSearch } from "./home/home-data";\nexport function SourcesScreen(){ const s: any = useHomeSearch("vrm", {kind:"library"} as any); return <ul className="hits">{(s.items ?? []).map((i:any)=><li key={i.key}>{i.title}</li>)}</ul>; }`,
      }, /R2 src\/screens\/home\/home-data\.ts.*useLibrarySearch, searchLibrary/));
    it("H5 home-data's own runSearch over SEARCH_URL; a second ask box elsewhere lists its hits", () =>
      red({
        [HD]: hd(IMP + `export async function runSearch(q: string) { const { data } = await api("GET", SEARCH_URL + "?q=" + encodeURIComponent(q) + "&limit=10"); return (data as any).results as { id: string; title: string }[]; }`),
        "src/screens/Quick.tsx": `import { useState } from "react";\nimport { runSearch } from "./home/home-data";\nexport function QuickAsk(){ const [h,setH]=useState<{ id: string; title: string }[]>([]); return <div><input onChange={(e)=>runSearch(e.target.value).then(setH)} /><ul>{h.map((x)=><li key={x.id}>{x.title}</li>)}</ul></div>; }`,
      }, /R2 src\/screens\/home\/home-data\.ts.*SEARCH_URL/));
    it("H5 with the path written out instead of SEARCH_URL is R4", () =>
      red({ [HD]: hd(`export const runSearch = (q: string) => api("GET", "/workbench/contract/search?q=" + q + "&limit=10");`) }, /R4 src\/screens\/home\/home-data\.ts/));
    it("a screen using the picker's results view through the index stays green", () =>
      expect(plus({ "src/screens/Peek.tsx": `import { PickerResults } from "../components/picker";\nexport const P = () => <PickerResults query="vrm" limit={5} label="r" open={(_i, c) => <a href="/library">{c}</a>} />;` })).toEqual([]));
  });

  describe("further shapes", () => {
    it("an import through a tsconfig-style alias resolves to the picker's files", () =>
      red({ "src/screens/A.tsx": `import { searchLibrary } from "@picker/search";` }, /R2.*searchLibrary|R3/, { paths: { "@picker/*": ["src/components/picker/*"] }, baseUrl: "." }));
    it("an alias import of the index is fine for ItemPicker, red for the search exports", () => {
      const opts = { paths: { "@picker": ["src/components/picker/index.ts"] }, baseUrl: "." };
      expect(plus({ "src/screens/Ok.tsx": `import { ItemPicker } from "@picker";\nexport const X = ItemPicker;` }, opts)).toEqual([]);
      red({ "src/screens/Bad.tsx": `import { SEARCH_URL } from "@picker";` }, /R2/, opts);
    });
    it("a namespace import or an export * of the picker counts as importing the search exports", () => {
      red({ "src/screens/Ns.tsx": `import * as P from "../components/picker"; export const u = P.SEARCH_URL;` }, /R2/);
      red({ "src/screens/Star.ts": `export * from "../components/picker";` }, /R2|R3/);
    });
    it("a dynamic import or require of the picker's search file", () => {
      red({ "src/screens/Dyn.ts": `export const f = () => import("../components/picker/search");` }, /R3|R2/);
      red({ "src/screens/Req.js": `const s = require("../components/picker/search.ts");` }, /R3|R2/);
    });
    it("React.createElement with a role, a spread, a native <select> / <datalist>", () => {
      red({ "src/screens/Ce.tsx": `import { createElement } from "react"; export const x = createElement("ul", { role: "listbox" });` }, /R1/);
      red({ "src/screens/Sel.tsx": `export const x = () => <select multiple><option>a</option></select>;` }, /R1.*select/);
      red({ "src/screens/Dl.tsx": `export const x = () => <datalist id="d" />;` }, /R1.*datalist/);
      red({ "src/screens/Ad.tsx": `export const x = (p: object) => <input aria-activedescendant="x" {...p} />;` }, /R1.*activedescendant/);
    });
    it("other ways to split the route", () => {
      red({ "src/a1.ts": `export const u = ["/workbench", "contract", "search"].join("/");` }, /R4/);
      red({ "src/a2.ts": `export const u = \`/workbench/contract/\${"search"}\`;` }, /R4/);
      red({ "src/a3.ts": `export const u = "/workbench/contract/".concat("search");` }, /R4/);
      red({ "src/a4.ts": `const base = "/workbench/contract/"; export const u = base + dyn(); function dyn(){ return "search"; }` }, /R4/);
      red({ "src/a5.mjs": `export const u = "/workbench/contract/search?q=";` }, /R4/);
    });
    it("legitimate neighbours stay green: another contract route, the picker through its index, a search word in a label", () => {
      expect(plus({
        "src/screens/Refs.tsx": `import { api } from "../lib/api";\nimport { ItemPicker } from "../components/picker";\nexport const r = (id: string) => api("GET", "/workbench/contract/references/" + id);\nexport const L = () => <label>Search for it<ItemPicker mode="multi" onConfirm={() => {}} /></label>;`,
      })).toEqual([]);
    });
    it("the allow-list is the picker's own files only", () => {
      expect(SEARCH_ALLOW.every((f) => f.startsWith("src/components/picker/"))).toBe(true);
    });
    it("the harness page stays out of the production build", () => {
      expect(readFileSync(join(ROOT, "vite.config.ts"), "utf8")).toMatch(/PICKER_HARNESS === "1"/);
    });
  });
});
