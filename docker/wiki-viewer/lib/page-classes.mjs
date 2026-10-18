/**
 * page-classes - the page-class REGISTRY of the live renderer (research-
 * workbench 03-PLAN section 4 "expansion by registration"; 06-EXPANSION
 * section 1: a page class = one compile rule + one renderer template).
 *
 * The renderer never names a page class. A request is resolved by asking the
 * registered entries, highest priority first, and the first entry that
 * resolves it renders it with its own template. Adding a class means adding
 * ONE entry file to lib/page-classes/ (loaded at start) or calling
 * registerPageClass() - no existing entry, and nothing in serve.mjs, changes.
 * The compile half of every entry lives with the compiler
 * (recipes/_shared/page-classes.mjs, the same names) and is what writes the
 * row's page_class; reconciliation counts files vs rows per that value.
 *
 * Entry shape (validated on registration):
 *   name       unique, the class name (x-wiki-page-class response header)
 *   version    integer, bumped when the template's output changes
 *   priority   number, higher resolves first (URL-shape classes high,
 *              row-backed classes in the middle, folder listings low)
 *   resolve    async (req, deps) => ctx | null
 *                req:  { key, isDir }
 *                deps: { row(), rowByBase(), site, fileExists(rel) }
 *              row()/rowByBase() return { ok, row } | { ok:false, state } and
 *              are memoised per request, so asking twice costs one query.
 *              Return null to pass; return { unreachable: state } when the
 *              database did not answer.
 *   template   async (ctx, deps) => page model for chrome.renderDocument
 */
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const _entries = new Map();

export function registerPageClass(entry) {
  const e = { ...entry };
  if (!e || typeof e.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(e.name)) {
    throw new Error(`page class: invalid name ${JSON.stringify(e?.name)}`);
  }
  if (!Number.isInteger(e.version) || e.version < 1) throw new Error(`page class ${e.name}: version must be a positive integer`);
  if (typeof e.priority !== "number") throw new Error(`page class ${e.name}: priority must be a number`);
  if (typeof e.resolve !== "function") throw new Error(`page class ${e.name}: resolve() required`);
  if (typeof e.template !== "function") throw new Error(`page class ${e.name}: template() required`);
  if (_entries.has(e.name)) throw new Error(`page class ${e.name}: already registered`);
  _entries.set(e.name, Object.freeze(e));
  return e;
}

export function unregisterPageClass(name) {
  return _entries.delete(name);
}

export function pageClasses() {
  // Stable order: priority desc, then name (deterministic resolution).
  return [..._entries.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
}

// Load every entry module in a directory (default: lib/page-classes/). Each
// module's default export is one entry (or an array of entries).
export async function loadPageClassDir(dir = join(dirname(fileURLToPath(import.meta.url)), "page-classes")) {
  let names = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs")).sort();
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of names) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    for (const e of [].concat(mod.default || [])) {
      if (!_entries.has(e.name)) { registerPageClass(e); n++; }
    }
  }
  return n;
}

/**
 * Resolve a request against the registry. Returns
 *   { entry, ctx }                 - an entry claimed it
 *   { unreachable: state }         - the database did not answer
 *   null                           - nobody claimed it (caller decides
 *                                    pending vs not-available)
 */
export async function resolvePage(req, deps) {
  for (const entry of pageClasses()) {
    const ctx = await entry.resolve(req, deps);
    if (!ctx) continue;
    if (ctx.unreachable) return { unreachable: ctx.unreachable };
    return { entry, ctx };
  }
  return null;
}
