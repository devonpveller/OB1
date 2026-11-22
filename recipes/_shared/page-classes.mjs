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
 * priority first; the first whose match() accepts the path wins. Names and
 * priorities are unique (a duplicate or a tie throws at registration).
 *
 * The built-in entries reproduce, value for value, the mapping
 * classifySlug() hard-coded before (pinned by wiki-pages.test.mjs), so no
 * existing row changes class. PURE: no env, no I/O (the Deno workbench and
 * the viewer image import it too).
 *
 * Entry: { name, version, pageClass, priority, match(rel, parts) -> boolean,
 *          entityType?(parts) -> string|null,
 *          regenerable?: boolean | (parts) -> boolean }
 *   regenerable  true when the compile WRITES this file and writes it again
 *                from Open Brain (so moving it aside loses nothing a person
 *                wrote); false / absent = the file may be its own source of
 *                truth (an owner's note, an AI note) - never moved or deleted
 *                by a tool that tidies refused pages (rw-wiki-guarded-pages-r2).
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
  if (e.regenerable !== undefined && typeof e.regenerable !== "boolean" && typeof e.regenerable !== "function") throw new Error(`compile class ${e.name}: regenerable must be a boolean or a function`);
  if (_entries.has(e.name)) throw new Error(`compile class ${e.name}: already registered`);
  // A tie would decide by name, i.e. silently by spelling: refuse it.
  const tie = [..._entries.values()].find((x) => x.priority === e.priority);
  if (tie) throw new Error(`compile class ${e.name}: priority ${e.priority} is already ${tie.name}'s (priorities are unique)`);
  _entries.set(e.name, Object.freeze(e));
  return e;
}

export function unregisterCompileClass(name) {
  return _entries.delete(name);
}

export function compileClasses() {
  return [..._entries.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
}

// Vault-relative path ("/"-separated, with or without .md; a leading slash is
// dropped) -> { slug, page_class, entity_type, class }. A "\" is a character
// of a file name, as Quartz on Linux reads it - never a separator (rw-p1a-
// deploy-prep attempt 2: "back\slash.md" was keyed notes/adv/back/slash, a
// row Quartz has no page for). An OS path is made a vault path by vaultRel
// (wiki-pages.mjs), which splits on the OS's own separator.
export function classify(relPath) {
  const clean = String(relPath || "").replace(/^\/+/, "");
  const slug = clean.replace(/\.md$/i, "");
  const parts = slug.split("/");
  for (const e of compileClasses()) {
    if (e.match(slug, parts)) {
      return { slug, page_class: e.pageClass, entity_type: e.entityType ? e.entityType(parts) : null, class: e.name };
    }
  }
  return { slug, page_class: "root", entity_type: null, class: "root" };
}

// Is this vault file regenerable compile output? (rw-wiki-guarded-pages-r2, review B2.) The class that classify() picks
// for the path decides; a class that does not say is NOT regenerable (fail safe: the file is kept).
export function isRegenerable(relPath) {
  const c = classify(relPath);
  const e = _entries.get(c.class);
  const r = e ? e.regenerable : false;
  return typeof r === "function" ? r(c.slug.split("/")) === true : r === true;
}

// ── built-in classes (the pre-registry mapping, unchanged) ──────────────────
// The legacy Quartz note tree (notes/...), written by the workbench at save.
// Author-owned (the workbench writes it; the compiler never edits notes/): never regenerable.
registerCompileClass({ name: "note", version: 1, pageClass: "note", priority: 100,
  match: (_s, p) => p[0] === "notes", regenerable: false });
// Everything outside content/, and content/<file> one level deep: roots/MOCs.
// Not regenerable as a class: it also holds whatever a person puts outside content/.
registerCompileClass({ name: "root", version: 1, pageClass: "root", priority: 90,
  match: (_s, p) => p[0] !== "content" || p.length < 3, regenerable: false });
// content/notebooks/<nb>/... - notebook hubs, the notebooks MOC and AI notes
// inside a notebook (stored as "note", as before the registry). Regenerable:
// only what the notebook synthesis writes (synthesize-notebooks.mjs) - the hub
// content/notebooks/<nb>/<nb> (the one file the hub sweep removes, wiki-
// service.mjs) and the MOC content/notebooks/index. Every other file there is
// an AI note (workbench writeStructuredNote): author-owned-in-content, its
// file the source of truth, never regenerated.
registerCompileClass({ name: "notebook-tree", version: 1, pageClass: "note", priority: 84,
  match: (_s, p) => p[1] === "notebooks",
  regenerable: (p) => p[0] === "content" && ((p.length === 4 && p[3] === p[2]) || (p.length === 3 && p[2] === "index")) });
// The leaves and the retired hubs layer: written by the compile, swept against their own kept-sets.
registerCompileClass({ name: "source", version: 1, pageClass: "source", priority: 83,
  match: (_s, p) => p[1] === "source", regenerable: true });
registerCompileClass({ name: "thought", version: 1, pageClass: "thought", priority: 82,
  match: (_s, p) => p[1] === "thought", regenerable: true });
registerCompileClass({ name: "notebook", version: 1, pageClass: "notebook", priority: 81,
  match: (_s, p) => p[1] === "notebook", regenerable: true });
// content/<entity_type>/<slug> - every other generated page is an entity page
// whose directory IS its entity_type.
// (topic pages are entity pages of type topic.)
registerCompileClass({ name: "entity", version: 1, pageClass: "entity", priority: 10,
  match: (_s, p) => p[0] === "content" && p.length >= 3, entityType: (p) => p[1], regenerable: true });
