// rwr-picker acceptance 1: there is exactly ONE picker / list-search implementation. This is an import check over
// the whole app source: it fails if a second picker or list-search component is added anywhere under src/.
// If it fails for a legitimate reason, the answer is to extend components/picker, not to add another list.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(__dirname, "..", "src");
const PICKER = join(SRC, "components", "picker") + sep;
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const all = walk(SRC).filter((p) => /\.(ts|tsx|css)$/.test(p));
const outside = all.filter((p) => !p.startsWith(PICKER));
const rel = (p: string) => relative(SRC, p).split(sep).join("/");

describe("one picker, one list search", () => {
  it("no file outside components/picker is named like a picker or a list search", () => {
    const bad = outside.map(rel).filter((p) => /(picker|chooser|selector|combobox|autocomplete|typeahead|listsearch|itemlist|searchlist|multiselect)/i.test(p.split("/").pop()!));
    expect(bad).toEqual([]);
  });
  it("no file outside components/picker declares a picker-like component or hook", () => {
    const re = /\b(?:function|const|class)\s+(\w*(?:Picker|Chooser|Combobox|Typeahead|Autocomplete|MultiSelect|ListSearch|ItemList|SearchList|useLibrarySearch|useSearch\w*)\w*)/;
    const bad = outside.filter((p) => !p.endsWith(".css")).flatMap((p) => { const m = re.exec(readFileSync(p, "utf8")); return m ? [`${rel(p)}: ${m[1]}`] : []; });
    expect(bad).toEqual([]);
  });
  it("the contract search route is called from one place: components/picker/search.ts", () => {
    const callers = all.filter((p) => /contract\/search|\/workbench\/search/.test(readFileSync(p, "utf8"))).map(rel);
    expect(callers).toEqual(["components/picker/search.ts"]);
  });
  it("outside the picker folder, the picker is reached only through its index", () => {
    const bad = outside.filter((p) => p.endsWith(".ts") || p.endsWith(".tsx")).flatMap((p) =>
      [...readFileSync(p, "utf8").matchAll(/from\s+["']([^"']*components\/picker\/[^"']+)["']/g)].map((m) => `${rel(p)}: ${m[1]}`));
    expect(bad).toEqual([]);
  });
  it("inside the folder there is exactly one component file and one search file (the harness only mounts it)", () => {
    const inside = all.filter((p) => p.startsWith(PICKER)).map(rel);
    expect(inside.filter((p) => /\.tsx$/.test(p) && !p.includes("/harness/"))).toEqual(["components/picker/ItemPicker.tsx"]);
    expect(inside.filter((p) => /search\.ts$/.test(p))).toEqual(["components/picker/search.ts"]);
    const h = readFileSync(join(PICKER, "harness", "main.tsx"), "utf8");
    expect(h).toMatch(/<ItemPicker/);
    expect(h).not.toMatch(/role="listbox"|role="option"/);
  });
  it("the harness page is not part of the production build", () => {
    const cfg = readFileSync(join(SRC, "..", "vite.config.ts"), "utf8");
    expect(cfg).toMatch(/PICKER_HARNESS === "1"/);
  });
});
