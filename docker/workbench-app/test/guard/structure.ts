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
//   R5  every .ts .tsx .js .jsx .mjs .mts .cjs file under src/ is read (a .jsx cannot hide a picker).
//
// What it cannot see (stated, not hidden): a search path assembled from data at runtime (a variable holding the
// pieces), and a list UI that uses no role/aria and no native list element. The runtime backstop for the first is that
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
const LIST_ROLES = new Set(["listbox", "option", "combobox"]);
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

// constant-fold a string expression made of literals (+, template without holes, .concat, [..].join(sep)); else null
function fold(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isParenthesizedExpression(n)) return fold(n.expression);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = fold(n.left), b = fold(n.right);
    return a !== null && b !== null ? a + b : null;
  }
  if (ts.isTemplateExpression(n)) {
    let s = n.head.text;
    for (const sp of n.templateSpans) { const v = fold(sp.expression); if (v === null) return null; s += v + sp.literal.text; }
    return s;
  }
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
    const m = n.expression.name.text;
    if (m === "concat") {
      const parts = [fold(n.expression.expression), ...n.arguments.map(fold)];
      return parts.every((p) => p !== null) ? parts.join("") : null;
    }
    if (m === "join" && ts.isArrayLiteralExpression(n.expression.expression)) {
      const els = n.expression.expression.elements.map(fold);
      const sep = n.arguments.length ? fold(n.arguments[0]) : ",";
      return els.every((e) => e !== null) && sep !== null ? (els as string[]).join(sep) : null;
    }
  }
  return null;
}

export function check(files: Files, opts: { paths?: Paths; baseUrl?: string } = {}): string[] {
  const paths = opts.paths ?? {};
  const baseUrl = opts.baseUrl ?? "";
  const v: string[] = [];
  for (const [file, text] of files) {
    const inPicker = file.startsWith(PICKER_DIR);
    const kind = file.endsWith("x") ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith(".jsx") ? ts.ScriptKind.JSX : kind);
    const pieces: string[] = [];
    const folded = new Set<ts.Node>();
    const importsOf = (spec: string, names: string[] | "*", reexportsAs: string[]) => {
      const target = resolveSpec(file, spec, files, paths, baseUrl);
      if (!target || !target.startsWith(PICKER_DIR) || inPicker) return;
      // R3: outside the picker folder only the index
      if (target !== "src/components/picker/index.ts") v.push(`R3 ${file}: imports ${target} (not the picker index)`);
      // R2: the search exports
      const bad = names === "*" ? SEARCH_NAMES : names.filter((n) => SEARCH_NAMES.includes(n));
      if (bad.length && !SEARCH_ALLOW.includes(file)) v.push(`R2 ${file}: imports ${bad.join(", ")} from the picker (not on the search allow-list)`);
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
        const s = fold(n.arguments[0]);
        if (s !== null) importsOf(s, "*", []);
        else if (!inPicker) v.push(`R3 ${file}: dynamic import/require of a non-literal path (cannot be resolved)`);
      }
      // R1: list UI vocabulary
      if (file !== LIST_UI_FILE) {
        if (ts.isJsxAttribute(n)) {
          const name = n.name.getText(sf);
          const init = n.initializer;
          if (name === "aria-activedescendant") v.push(`R1 ${file}: aria-activedescendant outside ItemPicker.tsx`);
          if (name === "role" && init && ts.isStringLiteral(init) && LIST_ROLES.has(init.text)) v.push(`R1 ${file}: role="${init.text}" outside ItemPicker.tsx`);
        }
        if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && LIST_TAGS.has(n.tagName.getText(sf))) v.push(`R1 ${file}: <${n.tagName.getText(sf)}> outside ItemPicker.tsx`);
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !ts.isImportDeclaration(n.parent)) {
          const asRoleValue = ts.isPropertyAssignment(n.parent) && ["role"].includes(n.parent.name.getText(sf).replace(/["']/g, "")) && LIST_ROLES.has(n.text);
          if (n.text === "listbox" || n.text === "combobox" || n.text === "aria-activedescendant" || asRoleValue) v.push(`R1 ${file}: the string "${n.text}" outside ItemPicker.tsx`);
        }
      }
      // R4: the route
      if (file !== ROUTE_FILE) {
        const f = (ts.isBinaryExpression(n) || ts.isTemplateExpression(n) || ts.isCallExpression(n)) && !folded.has(n) ? fold(n) : null;
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
