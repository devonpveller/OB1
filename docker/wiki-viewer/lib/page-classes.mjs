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
 * Entry shape (validated on registration; loading FAILS LOUD - the viewer
 * does not start - on a duplicate name, a priority tie, an entry file with no
 * default export, or an invalid shape: a second file reusing a built-in's
 * name must never silently replace it, and a tie must never be decided by
 * spelling):
 *   name       unique, the class name (x-wiki-page-class response header)
 *   version    integer, bumped when the template's output changes
 *   priority   number, UNIQUE, higher resolves first (URL-shape classes
 *              high, row-backed classes in the middle, folder listings low)
 *   resolve    async (req, deps) => ctx | null
 *                req:  { key, isDir }
 *                deps: { row(), rowByBase(), site, fileExists(rel) }
 *              row()/rowByBase() return { ok, row } | { ok:false, state } and
 *              are memoised per request, so asking twice costs one query.
 *              Return null to pass; return { unreachable: state } when the
 *              database did not answer.
 *   template   async (ctx, deps) => page model for chrome.renderDocument
 * A resolve() or template() that THROWS is isolated: the error is logged
 * (first time per entry, then counted), the entry is reported broken by
 * brokenPageClasses() (the health probe lists it), and resolution falls
 * through to the next entry in the same fixed order - a code bug is never
 * shown as "connecting to database".
 */
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const _entries = new Map();

// The entry's own shape (throws).
function validateEntry(entry) {
  if (!entry || typeof entry !== "object") throw new Error(`page class: an entry must be an object (got ${typeof entry})`);
  const e = entry;
  if (typeof e.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(e.name)) {
    throw new Error(`page class: invalid name ${JSON.stringify(e?.name)}`);
  }
  if (!Number.isInteger(e.version) || e.version < 1) throw new Error(`page class ${e.name}: version must be a positive integer`);
  if (typeof e.priority !== "number" || !Number.isFinite(e.priority)) throw new Error(`page class ${e.name}: priority must be a finite number`);
  if (typeof e.resolve !== "function") throw new Error(`page class ${e.name}: resolve() required`);
  if (typeof e.template !== "function") throw new Error(`page class ${e.name}: template() required`);
}

// Against what is registered (throws): a duplicate name, a priority tie.
function checkAgainstRegistry(e) {
  if (_entries.has(e.name)) throw new Error(`page class ${e.name}: already registered (a duplicate never replaces an entry)`);
  const tie = [..._entries.values()].find((x) => x.priority === e.priority);
  if (tie) throw new Error(`page class ${e.name}: priority ${e.priority} is already ${tie.name}'s (priorities are unique)`);
}

export function registerPageClass(entry) {
  validateEntry(entry);
  const e = { ...entry };
  checkAgainstRegistry(e);
  _entries.set(e.name, Object.freeze(e));
  return e;
}

export function unregisterPageClass(name) {
  _broken.delete(name);
  return _entries.delete(name);
}

// Entries whose resolve()/template() threw: name -> { name, version, phase,
// error, count, firstAt, lastAt }.
const _broken = new Map();
function noteBroken(entry, phase, key, e) {
  const now = new Date().toISOString();
  const b = _broken.get(entry.name);
  if (b) {
    b.count++;
    b.lastAt = now;
    b.error = String(e?.message || e).slice(0, 300);
    b.phase = phase;
    return;
  }
  _broken.set(entry.name, { name: entry.name, version: entry.version, phase, error: String(e?.message || e).slice(0, 300), count: 1, firstAt: now, lastAt: now, key });
  console.error(`[wiki-viewer] page class ${entry.name}@${entry.version} ${phase}() THREW for ${key} - isolated, falling through: ${e?.stack || e}`);
}
export function brokenPageClasses() {
  return [..._broken.values()].map((b) => ({ ...b }));
}

export function pageClasses() {
  // Stable order: priority desc, then name (deterministic resolution).
  return [..._entries.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
}

// Load every entry module in a directory (default: lib/page-classes/). Each
// module's default export is one entry (or an array of entries).
// Every file is checked before any is registered, and any problem throws
// naming the file - the viewer then fails to start (fail loud) instead of
// rendering with a silently different registry.
export async function loadPageClassDir(dir = join(dirname(fileURLToPath(import.meta.url)), "page-classes")) {
  let names = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs")).sort();
  } catch (e) {
    if (e?.code === "ENOENT") return 0;
    throw new Error(`page classes: cannot read ${dir}: ${e?.message || e}`);
  }
  const found = [];
  for (const f of names) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    if (mod.default == null) throw new Error(`page class entry ${f}: no default export (an entry file must export its entry)`);
    const list = [].concat(mod.default);
    if (!list.length) throw new Error(`page class entry ${f}: default export is an empty list`);
    for (const e of list) found.push({ f, e });
  }
  // Validate EVERYTHING before registering anything: a bad file leaves the
  // registry as it was (and the caller - serve.mjs at start - fails).
  const names2 = new Map([..._entries.keys()].map((n) => [n, "a registered entry"]));
  const prios = new Map([..._entries.values()].map((x) => [x.priority, `${x.name} (registered)`]));
  for (const { f, e } of found) {
    try {
      validateEntry(e);
    } catch (err) {
      throw new Error(`page class entry ${f}: ${err?.message || err}`);
    }
    if (names2.has(e.name)) {
      throw new Error(`page class entry ${f}: name ${JSON.stringify(e.name)} is already declared by ${names2.get(e.name)} (a duplicate never replaces an entry)`);
    }
    names2.set(e.name, f);
    if (prios.has(e.priority)) throw new Error(`page class entry ${f}: ${e.name} priority ${e.priority} ties with ${prios.get(e.priority)} (priorities are unique)`);
    prios.set(e.priority, `${e.name} (${f})`);
  }
  for (const { e } of found) registerPageClass(e);
  return found.length;
}

/**
 * Resolve a request against the registry (entries in `skip` are passed
 * over). Returns
 *   { entry, ctx }                 - an entry claimed it (ctx.pending: it is
 *                                    the entry's page but its row is not
 *                                    presentable as-is - stale/empty)
 *   { unreachable: state }         - the database did not answer
 *   null                           - nobody claimed it (caller decides
 *                                    pending vs not-available)
 */
export async function resolvePage(req, deps, skip = new Set()) {
  for (const entry of pageClasses()) {
    if (skip.has(entry.name)) continue;
    let ctx;
    try {
      ctx = await entry.resolve(req, deps);
    } catch (e) {
      noteBroken(entry, "resolve", req.key, e);
      continue;
    }
    if (!ctx) continue;
    if (ctx.unreachable) return { unreachable: ctx.unreachable };
    return { entry, ctx };
  }
  return null;
}

// Run an entry's template, isolated like resolve(): null when it threw (the
// caller resolves again without that entry).
export async function renderTemplate(entry, ctx, deps, key) {
  try {
    return await entry.template(ctx, deps);
  } catch (e) {
    noteBroken(entry, "template", key, e);
    return null;
  }
}
