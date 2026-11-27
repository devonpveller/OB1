// The STRUCTURAL one-picker guard (rwr-picker round 3). It parses every source file of the app with the TypeScript
// compiler (not a regex over names), resolves each import / re-export / dynamic import to the file it really names
// (relative paths and tsconfig `paths` aliases), and reports violations of these rules:
//
//   R1  role="listbox" / "option" / "combobox", aria-activedescendant, and the native <select> / <datalist> list
//       widgets appear only in components/picker/ItemPicker.tsx (the one list UI). Found as JSX attributes AND as
//       string literals, so React.createElement / spread props are caught too.
//   R2  the search exports (SEARCH_URL, SEARCH_LIMIT, MIN_QUERY, searchUrl, searchLibrary, useLibrarySearch) may be
//       imported only by files on SEARCH_ALLOW (the picker itself and, later, the Ctrl+K overlay - extending the list
//       is a reviewed change to this file). A namespace import or `export *` of the picker's modules counts as importing
//       all of them.
//   R3  outside components/picker/, the picker is reached only through its index.ts (a relative path, an alias, a
//       re-export or a dynamic import that resolves to ItemPicker.tsx / search.ts / model.ts is a violation), and
//       only index.ts re-exports ItemPicker.
//   R4  the contract search path is built in exactly ONE place (components/picker/search.ts): no other file contains it
//       as a string, as constant-folded concatenation / template / join of literals, or as split literal pieces
//       ("contract" and "search" pieces in one file outside the picker).
//   R6  a src file may not import, re-export, dynamically import or require anything whose path resolves outside src/
//       (a relative path that climbs out of it). Whatever lives outside src/ is therefore not part of the app's bundle
//       by import, and a list UI cannot be parked there. Package imports (bare names) are unaffected.
//   R5  every .ts .tsx .js .jsx .mjs .mts .cjs file under src/ is read (a .jsx cannot hide a picker).
//
// Role strings are constant-folded before matching (concatenation, template literals, .concat, join, and `const`
// identifiers holding foldable strings), and the list-widget roles include grid / treegrid / row / tree / treeitem.
// R2 also applies inside components/picker/ (a new file there, e.g. in harness/, must be added to SEARCH_ALLOW).
//
// RESIDUAL, precisely (what it cannot see; stated, not hidden):
//   - a search path or role assembled from runtime DATA (a function result, a prop, a fetched value, a `let` that is
//     reassigned, an object property); only `const` and literal-only expressions are folded;
//   - a list UI that uses no role/aria and no native list element (plain <ul>/<div> rows with only click handlers);
//   - a role outside the folded list-widget set (e.g. role="menu", "listitem", "table") - not blocked;
//   - a second list UI INSIDE ItemPicker.tsx itself (the allowed file);
//   - non-JS list renderers reached some other way than a src import (e.g. a second Vite HTML entry): R6 stops src
//     importing them, but a new entry is a build-config change, reviewed with vite.config.ts. The runtime backstop for the first is that
// every request goes through lib/api.ts's door and its log (test/picker.test.tsx asserts what the picker sends).
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const SEARCH_NAMES = ["SEARCH_URL", "SEARCH_LIMIT", "MIN_QUERY", "searchUrl", "searchLibrary", "useLibrarySearch"];
export const PICKER_DIR = "src/components/picker/";
export const LIST_UI_FILE = "src/components/picker/ItemPicker.tsx";
// Files that may import the search exports. rwr-search (Ctrl+K) adds its overlay file here, in its own reviewed change.
export const SEARCH_ALLOW = [
  "src/components/picker/ItemPicker.tsx",
  "src/components/picker/index.ts",
  "src/components/picker/search.ts",
  "src/components/picker/harness/main.tsx",
];
const ROUTE_FILE = "src/components/picker/search.ts";
const EXT = /\.(ts|tsx|js|jsx|mjs|mts|cjs)$/;
const LIST_ROLES = new Set(["listbox", "option", "combobox", "grid", "treegrid", "row", "tree", "treeitem"]);
const LIST_TAGS = new Set(["select", "datalist"]);

export type Files = Map<string, string>; // path relative to the app root, "/" separators

export function readApp(root: string): Files {
  const out: Files = new Map();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (EXT.test(n)) out.set(relative(root, p).split(sep).join("/"), readFileSync(p, "utf8"));
    }
  };
  walk(join(root, "src"));
  return out;
}

type Paths = Record<string, string[]>;
function resolveSpec(from: string, spec: string, files: Files, paths: Paths, baseUrl: string): string | null {
  const cands: string[] = [];
  if (spec.startsWith(".")) cands.push(join(dirname(from), spec).split(sep).join("/"));
  else {
    for (const [pat, targets] of Object.entries(paths)) {
      const star = pat.indexOf("*");
      const hit = star < 0 ? pat === spec : spec.startsWith(pat.slice(0, star)) && spec.endsWith(pat.slice(star + 1));
      if (!hit) continue;
      const mid = star < 0 ? "" : spec.slice(star, spec.length - (pat.length - star - 1));
      for (const t of targets) cands.push(join(baseUrl, t.replace("*", mid)).split(sep).join("/"));
    }
    if (baseUrl && !cands.length) cands.push(join(baseUrl, spec).split(sep).join("/"));
  }
  for (const c of cands) {
    const base = c.replace(/\.(js|jsx|mjs)$/, "");
    for (const t of [c, ...["ts", "tsx", "js", "jsx", "mjs", "mts"].map((e) => `${base}.${e}`), ...["ts", "tsx", "js", "jsx"].map((e) => `${c}/index.${e}`)]) {
      if (files.has(t)) return t;
    }
  }
  return null;
}

// a relative specifier whose normalised path climbs out of src/ (from a file under src/)
function leavesSrc(from: string, spec: string): boolean {
  if (!spec.startsWith(".") || !from.startsWith("src/")) return false;
  return !join(dirname(from), spec).split(sep).join("/").startsWith("src/");
}

// constant-fold a string expression made of literals (+, template without holes, .concat, [..].join(sep)); else null
type Env = Map<string, string>;
function fold(n: ts.Node, env: Env = new Map()): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isParenthesizedExpression(n)) return fold(n.expression, env);
  if (ts.isIdentifier(n)) return env.get(n.text) ?? null;
  if (ts.isAsExpression(n) || ts.isNonNullExpression(n)) return fold(n.expression, env);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = fold(n.left, env), b = fold(n.right, env);
    return a !== null && b !== null ? a + b : null;
  }
  if (ts.isTemplateExpression(n)) {
    let s = n.head.text;
    for (const sp of n.templateSpans) { const v = fold(sp.expression, env); if (v === null) return null; s += v + sp.literal.text; }
    return s;
  }
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
    const m = n.expression.name.text;
    if (m === "concat") {
      const parts = [fold(n.expression.expression, env), ...n.arguments.map((a) => fold(a, env))];
      return parts.every((p) => p !== null) ? parts.join("") : null;
    }
    if (m === "join" && ts.isArrayLiteralExpression(n.expression.expression)) {
      const els = n.expression.expression.elements.map((e) => fold(e, env));
      const sep = n.arguments.length ? fold(n.arguments[0], env) : ",";
      return els.every((e) => e !== null) && sep !== null ? (els as string[]).join(sep) : null;
    }
  }
  return null;
}

const PARSED = new Map<string, ts.SourceFile>();

export function check(files: Files, opts: { paths?: Paths; baseUrl?: string } = {}): string[] {
  const paths = opts.paths ?? {};
  const baseUrl = opts.baseUrl ?? "";
  const v: string[] = [];
  for (const [file, text] of files) {
    const inPicker = file.startsWith(PICKER_DIR);
    const kind = file.endsWith("x") ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    // a file's tree is parsed once per (name, text): every case re-checks the whole real tree plus one planted file, and the tree has grown
    // with each screen (the image build's vitest worker timed out on this file's ~30 cases once Cast and voices was added)
    const key = file + "|" + text;
    let sf = PARSED.get(key);
    if (!sf) { sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith(".jsx") ? ts.ScriptKind.JSX : kind); PARSED.set(key, sf); }
    const pieces: string[] = [];
    // `const NAME = <foldable>` anywhere in the file (two passes so a const may build on an earlier one)
    const env: Env = new Map();
    for (let pass = 0; pass < 2; pass++) {
      const collect = (n: ts.Node) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isVariableDeclarationList(n.parent) && n.parent.flags & ts.NodeFlags.Const) {
          const f = fold(n.initializer, env);
          if (f !== null) env.set(n.name.text, f);
        }
        ts.forEachChild(n, collect);
      };
      collect(sf);
    }
    const folded = new Set<ts.Node>();
    const importsOf = (spec: string, names: string[] | "*", reexportsAs: string[]) => {
      // R6: nothing under src/ reaches outside src/
      if (leavesSrc(file, spec)) v.push(`R6 ${file}: imports "${spec}", which resolves outside src/`);
      const target = resolveSpec(file, spec, files, paths, baseUrl);
      if (!target || !target.startsWith(PICKER_DIR)) return;
      // R2: the search exports (inside the picker too: a new file there must be on the allow-list)
      const bad = names === "*" ? SEARCH_NAMES : names.filter((n) => SEARCH_NAMES.includes(n));
      if (bad.length && !SEARCH_ALLOW.includes(file)) v.push(`R2 ${file}: imports ${bad.join(", ")} from the picker (not on the search allow-list)`);
      if (inPicker) return;
      // R3: outside the picker folder only the index
      if (target !== "src/components/picker/index.ts") v.push(`R3 ${file}: imports ${target} (not the picker index)`);
      if (reexportsAs.length) v.push(`R3 ${file}: re-exports from the picker (${reexportsAs.join(", ")})`);
    };
    const visit = (n: ts.Node) => {
      // imports / re-exports
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        const c = n.importClause;
        let names: string[] | "*" = [];
        if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) names = "*";
        else {
          if (c?.name) names.push("default");
          if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) names.push((e.propertyName ?? e.name).text);
        }
        importsOf(n.moduleSpecifier.text, names, []);
      }
      if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const names: string[] | "*" = n.exportClause && ts.isNamedExports(n.exportClause) ? n.exportClause.elements.map((e) => (e.propertyName ?? e.name).text) : "*";
        importsOf(n.moduleSpecifier.text, names, names === "*" ? ["*"] : names);
      }
      if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")) && n.arguments[0]) {
        const s = fold(n.arguments[0], env);
        if (s !== null) importsOf(s, "*", []);
        else if (!inPicker) v.push(`R3 ${file}: dynamic import/require of a non-literal path (cannot be resolved)`);
      }
      // R1: list UI vocabulary
      if (file !== LIST_UI_FILE) {
        if (ts.isJsxAttribute(n)) {
          const name = n.name.getText(sf);
          const init = n.initializer;
          if (name === "aria-activedescendant") v.push(`R1 ${file}: aria-activedescendant outside ItemPicker.tsx`);
          const rv = init && ts.isStringLiteral(init) ? init.text : init && ts.isJsxExpression(init) && init.expression ? fold(init.expression, env) : null;
          if (name === "role" && rv !== null && LIST_ROLES.has(rv)) v.push(`R1 ${file}: role="${rv}" outside ItemPicker.tsx`);
        }
        if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && LIST_TAGS.has(n.tagName.getText(sf))) v.push(`R1 ${file}: <${n.tagName.getText(sf)}> outside ItemPicker.tsx`);
        // a role / marker word produced by folding (concatenation, template, const) rather than written whole
        if ((ts.isBinaryExpression(n) || ts.isTemplateExpression(n) || ts.isCallExpression(n)) && !ts.isJsxAttribute(n.parent)) {
          const f = fold(n, env);
          if (f !== null && (LIST_ROLES.has(f) || f === "aria-activedescendant")) v.push(`R1 ${file}: the folded string "${f}" outside ItemPicker.tsx`);
        }
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !ts.isImportDeclaration(n.parent)) {
          const asRoleValue = ts.isPropertyAssignment(n.parent) && ["role"].includes(n.parent.name.getText(sf).replace(/["']/g, "")) && LIST_ROLES.has(n.text);
          if (n.text === "listbox" || n.text === "combobox" || n.text === "aria-activedescendant" || asRoleValue) v.push(`R1 ${file}: the string "${n.text}" outside ItemPicker.tsx`);
        }
      }
      // R4: the route
      if (file !== ROUTE_FILE) {
        const f = (ts.isBinaryExpression(n) || ts.isTemplateExpression(n) || ts.isCallExpression(n)) && !folded.has(n) ? fold(n, env) : null;
        if (f !== null) {
          n.forEachChild((c) => folded.add(c));
          if (/contract\/search/.test(f)) v.push(`R4 ${file}: builds the contract search path ("${f}")`);
        }
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) pieces.push(n.text);
        if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) pieces.push(n.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (file !== ROUTE_FILE) {
      for (const p of pieces) if (/contract\/search/.test(p)) v.push(`R4 ${file}: contains the contract search path`);
      const hasContract = pieces.some((p) => /(^|\/)contract\/?$/.test(p.replace(/^\/workbench/, "")) || /\/workbench\/contract\/?$/.test(p));
      const hasSearch = pieces.some((p) => /^\/?search(\?|$)/.test(p));
      if (hasContract && hasSearch) v.push(`R4 ${file}: holds split pieces of the contract search path ("contract" and "search")`);
    }
  }
  // R4 counterpart: the path really is built in the one place
  if (files.has(ROUTE_FILE) && !/\/workbench\/contract\/search/.test(files.get(ROUTE_FILE)!)) v.push(`R4 ${ROUTE_FILE}: no longer builds the contract search path (the guard's anchor moved)`);
  // R3: only index re-exports ItemPicker
  for (const [file, text] of files) {
    if (file === "src/components/picker/index.ts" || file === LIST_UI_FILE) continue;
    if (/export\s*\{[^}]*\bItemPicker\b/.test(text) && file.startsWith(PICKER_DIR) === false) v.push(`R3 ${file}: exports ItemPicker`);
  }
  return [...new Set(v)];
}

export const appRoot = (here: string) => resolve(here, "..");
