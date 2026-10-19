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
 *              Returns a PAGE (a plain ctx object) or null (pass), and
 *              nothing else. When the database did not answer it returns
 *              deps.unavailable(r) - a value only the route can make (the
 *              DB_UNAVAILABLE symbol), never a hand-built { unreachable }
 *              (rw-p1a-render attempt 3, near-miss N2-1: a wrong-shape
 *              { unreachable: true } used to fake the database screen).
 *   template   async (ctx, deps) => page model for chrome.renderDocument
 *              (or deps.unavailable(r) when a row it needs - a transcluded
 *              page's - did not answer)
 * A resolve() or template() that THROWS, or that returns anything other than
 * a page / null / deps.unavailable(r), is isolated: the error is logged
 * (first time per entry, then counted), the entry is reported broken by
 * brokenPageClasses() (the health probe lists it), and resolution falls
 * through to the next entry in the same fixed order - a code bug is never
 * shown as "connecting to database".
 */
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const _entries = new Map();

// The database did not answer. Only the route makes these (deps.unavailable),
// so a resolve()/template() cannot fake the database screen by shape.
export const DB_UNAVAILABLE = Symbol("wiki-db-unavailable");
const DB_STATES = new Set(["connecting", "unreachable"]);
export function makeUnavailable(state) {
  if (!DB_STATES.has(state)) throw new Error(`page classes: not a database state: ${JSON.stringify(state)}`);
  return Object.freeze({ [DB_UNAVAILABLE]: state });
}
export const unavailableState = (v) => (v && typeof v === "object" && DB_STATES.has(v[DB_UNAVAILABLE]) ? v[DB_UNAVAILABLE] : null);

// What a resolve() returned: "page" | "pass" | "unavailable" | an error text.
function resultKind(ctx) {
  if (ctx == null) return "pass";
  if (unavailableState(ctx)) return "unavailable";
  if (typeof ctx !== "object" || Array.isArray(ctx)) return `returned ${Array.isArray(ctx) ? "an array" : typeof ctx} (an entry returns a page object, null, or deps.unavailable(r))`;
  if (Object.prototype.hasOwnProperty.call(ctx, "unreachable")) {
    return `returned ${JSON.stringify({ unreachable: ctx.unreachable })} - a database state is deps.unavailable(r), never a hand-built object`;
  }
  return "page";
}

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
function noteBroken(entry, phase, key, e, kind = "threw") {
  const now = new Date().toISOString();
  const b = _broken.get(entry.name);
  if (b) {
    b.count++;
    b.lastAt = now;
    b.error = String(e?.message || e).slice(0, 300);
    b.phase = phase;
    b.kind = kind;
    return;
  }
  _broken.set(entry.name, { name: entry.name, version: entry.version, phase, kind, error: String(e?.message || e).slice(0, 300), count: 1, firstAt: now, lastAt: now, key });
  console.error(`[wiki-viewer] page class ${entry.name}@${entry.version} ${phase}() ${kind === "threw" ? "THREW" : "RETURNED AN INVALID RESULT"} for ${key} - isolated, falling through: ${kind === "threw" ? e?.stack || e : e?.message || e}`);
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
    const kind = resultKind(ctx);
    if (kind === "pass") continue;
    if (kind === "unavailable") return { unreachable: unavailableState(ctx) };
    if (kind !== "page") {
      noteBroken(entry, "resolve", req.key, new Error(kind), "invalid");
      continue;
    }
    return { entry, ctx };
  }
  return null;
}

// Run an entry's template, isolated like resolve(): null when it threw or
// returned something that is not a page model (the caller resolves again
// without that entry); { unreachable: state } when it returned
// deps.unavailable(r).
export async function renderTemplate(entry, ctx, deps, key) {
  let model;
  try {
    model = await entry.template(ctx, deps);
  } catch (e) {
    noteBroken(entry, "template", key, e);
    return null;
  }
  const st = unavailableState(model);
  if (st) return { unreachable: st };
  if (!model || typeof model !== "object" || Array.isArray(model) || Object.prototype.hasOwnProperty.call(model, "unreachable")) {
    noteBroken(entry, "template", key, new Error(`returned ${model === null ? "null" : Array.isArray(model) ? "an array" : typeof model === "object" ? "an object with an 'unreachable' key" : typeof model} (a template returns a page model)`), "invalid");
    return null;
  }
  return model;
}
