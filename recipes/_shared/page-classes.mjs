/**
 * page-classes - the COMPILE half of the page-class registry (research-
 * workbench 03-PLAN section 4 "expansion by registration", 06-EXPANSION
 * section 1: a page class is one compile rule + one renderer template).
 *
 * A compile rule says which vault files belong to the class and what
 * `wiki_pages.page_class` (and entity_type) their row carries. The renderer
 * half lives in the viewer (docker/wiki-viewer/lib/page-classes/, the same
 * names); reconciliation (reconcile-wiki-pages.mjs) counts files vs rows per
 * the page_class these rules write.
 *
 * Adding a class = registerCompileClass({...}) (or one more built-in entry
 * below) - no existing entry changes. classify() asks the entries, highest
 * priority first; the first whose match() accepts the path wins.
 *
 * The built-in entries reproduce, value for value, the mapping
 * classifySlug() hard-coded before (pinned by wiki-pages.test.mjs), so no
 * existing row changes class. PURE: no env, no I/O (the Deno workbench and
 * the viewer image import it too).
 *
 * Entry: { name, version, pageClass, priority, match(rel, parts) -> boolean,
 *          entityType?(parts) -> string|null }
 *   rel    vault-relative path without the .md ("content/person/person-x")
 *   parts  rel.split("/")
 */
const _entries = new Map();

export function registerCompileClass(entry) {
  const e = { ...entry };
  if (!e || typeof e.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(e.name)) throw new Error(`compile class: invalid name ${JSON.stringify(e?.name)}`);
  if (!Number.isInteger(e.version) || e.version < 1) throw new Error(`compile class ${e.name}: version must be a positive integer`);
  if (typeof e.pageClass !== "string" || !e.pageClass) throw new Error(`compile class ${e.name}: pageClass required`);
  if (typeof e.priority !== "number") throw new Error(`compile class ${e.name}: priority must be a number`);
  if (typeof e.match !== "function") throw new Error(`compile class ${e.name}: match() required`);
  if (_entries.has(e.name)) throw new Error(`compile class ${e.name}: already registered`);
  _entries.set(e.name, Object.freeze(e));
  return e;
}

export function unregisterCompileClass(name) {
  return _entries.delete(name);
}

export function compileClasses() {
  return [..._entries.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
}

// Vault-relative path (no leading slash, forward slashes, with or without
// .md) -> { slug, page_class, entity_type, class }.
export function classify(relPath) {
  const clean = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const slug = clean.replace(/\.md$/i, "");
  const parts = slug.split("/");
  for (const e of compileClasses()) {
    if (e.match(slug, parts)) {
      return { slug, page_class: e.pageClass, entity_type: e.entityType ? e.entityType(parts) : null, class: e.name };
    }
  }
  return { slug, page_class: "root", entity_type: null, class: "root" };
}

// ── built-in classes (the pre-registry mapping, unchanged) ──────────────────
// The legacy Quartz note tree (notes/...), written by the workbench at save.
registerCompileClass({ name: "note", version: 1, pageClass: "note", priority: 100,
  match: (_s, p) => p[0] === "notes" });
// Everything outside content/, and content/<file> one level deep: roots/MOCs.
registerCompileClass({ name: "root", version: 1, pageClass: "root", priority: 90,
  match: (_s, p) => p[0] !== "content" || p.length < 3 });
// content/notebooks/<nb>/... - notebook hubs, the notebooks MOC and AI notes
// inside a notebook (stored as "note", as before the registry).
registerCompileClass({ name: "notebook-tree", version: 1, pageClass: "note", priority: 80,
  match: (_s, p) => p[1] === "notebooks" });
registerCompileClass({ name: "source", version: 1, pageClass: "source", priority: 80,
  match: (_s, p) => p[1] === "source" });
registerCompileClass({ name: "thought", version: 1, pageClass: "thought", priority: 80,
  match: (_s, p) => p[1] === "thought" });
registerCompileClass({ name: "notebook", version: 1, pageClass: "notebook", priority: 80,
  match: (_s, p) => p[1] === "notebook" });
// content/<entity_type>/<slug> - every other generated page is an entity page
// whose directory IS its entity_type.
registerCompileClass({ name: "entity", version: 1, pageClass: "entity", priority: 10,
  match: (_s, p) => p[0] === "content" && p.length >= 3, entityType: (p) => p[1] });
