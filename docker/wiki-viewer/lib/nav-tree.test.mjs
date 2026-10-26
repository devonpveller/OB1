// node --test lib/ - research-workbench P1b: the explorer's per-folder nav.
// The order must be Quartz Explorer's default (folders first, then display
// name, numeric, base sensitivity), the entries Quartz's trie entries (URL
// slugs, folder display names, a page named like a folder listed once as the
// folder, "tags" filtered), and a page of a large folder must be a slice.
import test from "node:test";
import assert from "node:assert/strict";
import { buildSiteIndex } from "./site-index.mjs";
import { folderChildren, navPage, normalizeFolder, explorerOrder, _resetNavTreeForTests, NAV_MAX_LIMIT } from "./nav-tree.mjs";

const row = (slug, title) => ({ slug, title: title ?? slug.split("/").pop(), links: [], tags: [], updated_at: "2026-10-18T00:00:00Z" });

function site(rows) {
  _resetNavTreeForTests();
  return buildSiteIndex(rows, `t-${Math.random()}`);
}

test("folderChildren: folders first, then Quartz's numeric/base collation of display names", () => {
  const s = site([
    row("index", "Home"),
    row("content/person/index", "People"),
    row("content/person/person-b", "bob"),
    row("content/person/person-a", "Ada"),
    row("content/tool/tool-10", "Tool 10"),
    row("content/tool/tool-9", "Tool 9"),
    row("notes/zeta", "Zeta"),
    row("notes/Alpha", "alpha"),
    row("readme", "Readme"),
  ]);
  const root = folderChildren(s, "");
  assert.deepEqual(root.map((e) => [e.name, e.folder, e.title]), [
    ["content", true, "content"], ["notes", true, "notes"], ["readme", false, "Readme"],
  ]);
  const content = folderChildren(s, "content");
  assert.deepEqual(content.map((e) => e.title), ["People", "tool"]); // folder display name = its index page's title
  assert.deepEqual(content.map((e) => e.slug), ["content/person/index", "content/tool/index"]);
  assert.deepEqual(content.map((e) => e.href), ["/content/person/", "/content/tool/"]);
  assert.deepEqual(content.map((e) => e.count), [2, 2]);
  assert.deepEqual(folderChildren(s, "content/tool").map((e) => e.title), ["Tool 9", "Tool 10"]); // numeric
  assert.deepEqual(folderChildren(s, "notes").map((e) => e.title), ["alpha", "Zeta"]); // case-insensitive
  assert.deepEqual(folderChildren(s, "content/person").map((e) => [e.slug, e.href]), [
    ["content/person/person-a", "/content/person/person-a"], ["content/person/person-b", "/content/person/person-b"],
  ]);
  assert.equal(folderChildren(s, "nope"), null);
});

test("explorerOrder equals Quartz's localeCompare comparator on a mixed sample", () => {
  const names = ["b", "B", "a10", "a9", "á", "Zed", "_x", "10", "9", "éclair", "eclair", "ä"];
  const entries = names.map((t, i) => ({ title: t, folder: i % 3 === 0 }));
  const quartz = (a, b) => {
    if (a.folder === b.folder) return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
    return !a.folder && b.folder ? 1 : -1;
  };
  assert.deepEqual([...entries].sort(explorerOrder).map((e) => e.title), [...entries].sort(quartz).map((e) => e.title));
});

test("Quartz URL slugs, the one-entry rule and the tags filter", () => {
  const s = site([
    row("notes/sp ace", "Spacey"),
    row("notes/up", "Up page"),
    row("notes/up/inner", "Inner"),
    row("tags/whatever", "not a real folder"),
    row("private/secret", "never a page"),
  ]);
  const notes = folderChildren(s, "notes");
  assert.deepEqual(notes.map((e) => [e.name, e.folder, e.title, e.href]), [
    ["up", true, "Up page", "/notes/up/"], // listed ONCE, as the folder, with the page's title
    ["sp-ace", false, "Spacey", "/notes/sp-ace"], // Quartz's URL, not the vault path
  ]);
  assert.deepEqual(folderChildren(s, "").map((e) => e.name), ["notes"]); // no tags/, no private/
});

test("navPage: slices of a sorted folder, next offset, focus, bounded limit, stable ETag", () => {
  const rows = [];
  for (let i = 0; i < 1234; i++) rows.push(row(`content/tool/tool-${i}`, `Tool ${i}`));
  const s = site(rows);
  const p0 = navPage(s, "content/tool", { limit: 500 });
  assert.equal(p0.body.total, 1234);
  assert.equal(p0.body.entries.length, 500);
  assert.equal(p0.body.entries[0].title, "Tool 0");
  assert.equal(p0.body.entries[499].title, "Tool 499");
  assert.equal(p0.body.next, 500);
  const p2 = navPage(s, "content/tool", { offset: 1000, limit: 500 });
  assert.equal(p2.body.entries.length, 234);
  assert.equal(p2.body.next, null);
  const f = navPage(s, "content/tool", { limit: 500, focus: "content/tool/tool-777" });
  assert.equal(f.body.offset, 500);
  assert.ok(f.body.entries.some((e) => e.slug === "content/tool/tool-777"));
  assert.equal(navPage(s, "content/tool", { limit: 99999 }).body.entries.length, Math.min(1234, NAV_MAX_LIMIT));
  assert.equal(navPage(s, "content/tool", { limit: 500 }).etag, p0.etag);
  assert.notEqual(p2.etag, p0.etag);
  assert.match(p0.etag, /^W\/"navf-[0-9a-f]{16}"$/);
  assert.equal(navPage(s, "content/nope"), null);
});

test("normalizeFolder accepts the URL forms and refuses traversal", () => {
  assert.equal(normalizeFolder(""), "");
  assert.equal(normalizeFolder("/"), "");
  assert.equal(normalizeFolder("index"), "");
  assert.equal(normalizeFolder("content/person/"), "content/person");
  assert.equal(normalizeFolder("/content/person/index"), "content/person");
  assert.equal(normalizeFolder("content%2Fperson"), "content/person");
  assert.equal(normalizeFolder("content/../x"), null);
  assert.equal(normalizeFolder("a//b"), null);
  assert.equal(normalizeFolder("%E0%A4%A"), null);
});

test("a large folder answers as a slice: 100k children, the memo makes a page cheap", () => {
  const rows = [];
  for (let i = 0; i < 100_000; i++) rows.push(row(`content/tool/tool-${i}`, `Tool ${i}`));
  const s = site(rows);
  let t = performance.now();
  navPage(s, "content/tool", { limit: 500 }); // first: sorts once
  const first = performance.now() - t;
  t = performance.now();
  const p = navPage(s, "content/tool", { offset: 50_000, limit: 500 });
  const again = performance.now() - t;
  assert.equal(p.body.entries.length, 500);
  assert.ok(Buffer.byteLength(p.json) < 2_000_000, `page payload ${Buffer.byteLength(p.json)} bytes`);
  assert.ok(again < 50, `a memoised page took ${again.toFixed(1)} ms (first ${first.toFixed(1)} ms)`);
});

test("the yielding site-index build (the nav refresh's) equals the synchronous one, past several sort slices", async () => {
  const { buildSiteIndexYielding } = await import("./site-index.mjs");
  const rows = [];
  // > 4 merge slices, unsorted input, URL collisions, aliases, nested folders, tags
  for (let i = 20_000; i > 0; i--) {
    const f = ["content/tool", "content/person", "notes/a b", "notes/a-b"][i % 4];
    rows.push({ slug: `${f}/p-${i % 7 === 0 ? "x" : ""}${i}`, title: `T ${i}`, links: [`p-${(i * 7) % 20000}`], tags: [`t${i % 9}/s${i % 3}`],
      updated_at: "2026-10-18T00:00:00Z", aliases: i % 50 === 0 ? [`alias-${i % 100}`] : null });
  }
  const a = buildSiteIndex(rows, "e");
  const b = await buildSiteIndexYielding(rows, "e");
  const plain = (x) => JSON.stringify({
    slugs: x.slugs, allSlugs: x.allSlugs, bySlug: [...x.bySlug], backlinks: [...x.backlinks], byTag: [...x.byTag],
    aliases: [...x.aliases], rowSlugOf: [...x.rowSlugOf], folderHint: [...x.folderHint],
    folders: [...x.folders].map(([k, v]) => [k, [...v.files], [...v.folders]]), byBase: [...x.byBase],
  });
  assert.equal(plain(b), plain(a));
  // and the merge sort is Array.prototype.sort: the slugs, and the row order the index was filled in
  assert.deepEqual(a.slugs, [...a.bySlug.keys()].sort());
  const { quartzPathOrder, aliasRedirects } = await import("./site-index.mjs");
  assert.deepEqual([...a.aliases], [...aliasRedirects([...a.bySlug.values()])]); // presorted = Array.sort order
  const winners = rows.filter((r) => a.rowSlugOf.get(r.slug.replace(/ /g, "-")) === r.slug).sort((x, y) => quartzPathOrder(x.slug, y.slug)).map((r) => r.slug);
  assert.deepEqual([...a.bySlug.values()].map((e) => e.rowSlug).filter((s) => winners.includes(s)).length, winners.length);
});

test("the nav worker's nav-only index answers exactly what the full index answers", async () => {
  const { buildSiteIndexYielding } = await import("./site-index.mjs");
  const rows = [row("index", "Home"), row("content/person/index", "People"), row("notes/up", "Up page"), row("notes/up/inner", "Inner"),
    row("notes/sp ace", "Spacey"), row("tags/x", "t"), row("private/p", "p")];
  for (let i = 0; i < 3000; i++) rows.push(row(`content/tool/tool-${i}`, `Tool ${i}`));
  _resetNavTreeForTests();
  const full = buildSiteIndex(rows, "full");
  const nav = await buildSiteIndexYielding(rows, "nav", { navOnly: true });
  assert.equal(nav.navOnly, true);
  assert.equal(nav.backlinks, undefined, "no backlinks/tags/aliases in the worker's heap");
  for (const f of ["", "content", "content/person", "content/tool", "notes", "notes/up"]) {
    assert.deepEqual(folderChildren(nav, f), folderChildren(full, f), `folder ${f || "(root)"}`);
  }
  assert.equal(navPage(nav, "content/tool", { limit: 100, focus: "content/tool/tool-2999" }).json,
    navPage(full, "content/tool", { limit: 100, focus: "content/tool/tool-2999" }).json);
});

test("focus on a page deeper down pages an ancestor's list to the subfolder that holds it", () => {
  const rows = [];
  for (let i = 1; i <= 300; i++) rows.push(row(`content/notebooks/nb-${i}/nb-${i}`, `NB ${i}`));
  const s = site(rows);
  const p = navPage(s, "content/notebooks", { limit: 50, focus: "content/notebooks/nb-277/nb-277" });
  assert.ok(p.body.entries.some((e) => e.slug === "content/notebooks/nb-277/index"), `offset ${p.body.offset}`);
  assert.equal(p.body.offset, 250);
});

test("the nav worker's delta: new pages and new titles land in the sorted lists exactly as a rebuild would", async () => {
  const { buildSiteIndexYielding } = await import("./site-index.mjs");
  const { applyNavDelta, warmFolders } = await import("./nav-tree.mjs");
  const base = [row("index", "Home"), row("content/tool/index", "Tools")];
  for (let i = 0; i < 2000; i++) base.push(row(`content/tool/tool-${i}`, `Tool ${i}`));
  for (let i = 0; i < 10; i++) base.push(row(`content/person/p-${i}`, `P ${i}`));
  _resetNavTreeForTests();
  const live = await buildSiteIndexYielding(base, "a", { navOnly: true });
  await warmFolders(live, 1);
  const delta = [row("content/tool/tool-new", "Aardvark tool"), row("content/tool/tool-5", "Zebra tool"), row("content/person/p-new", "P 4.5"), row("content/tool/tool-7", "Tool 7")];
  const res = applyNavDelta(live, delta, 2);
  assert.equal(res.ok, true);
  assert.deepEqual([res.added, res.retitled], [2, 1]);
  const after = base.map((r) => (r.slug === "content/tool/tool-5" ? { ...r, title: "Zebra tool" } : r)).concat([delta[0], delta[2]]);
  const fresh = await buildSiteIndexYielding(after, "b", { navOnly: true });
  for (const f of ["", "content", "content/tool", "content/person"]) {
    assert.deepEqual(navPage(live, f, { limit: 2000 }).body.entries, navPage(fresh, f, { limit: 2000 }).body.entries, `folder ${f || "(root)"}`);
  }
  // a deletion (the table grew by fewer pages than the rows account for), a new folder, an index page: rebuild
  assert.equal(applyNavDelta(live, [row("content/tool/tool-x", "X")], 0).ok, false);
  assert.equal(applyNavDelta(live, [row("content/newfolder/a", "A")], 1).ok, false);
  assert.equal(applyNavDelta(live, [row("content/tool/index", "Renamed tools")], 0).ok, false);
});
