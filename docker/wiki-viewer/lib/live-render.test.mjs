// node --test lib/ - image-build gate for the live page route (research-
// workbench P1a): chrome parity elements, D13 order of operations, the
// ONE-editor identity contract, and expansion by registration.
//
// A stub PostgREST answers wiki_pages from rows the COMPILE RULE produced
// (parseWikiPage over the committed synthetic fixture vault), so the renderer
// is tested against compile's output, never a hand-written copy of it.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let mode = "up"; // up | down | starting
let rows = [];
let failSlug = null; // attempt 3: one row's read fails (503) while the rest answer

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (mode !== "up") {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify(mode === "starting"
      ? { code: "PGRST000", message: "Database connection error", details: "FATAL: the database system is starting up" }
      : { code: "PGRST001", message: "Database client error. Retrying the connection.", details: "connection refused" }));
    return;
  }
  if (!u.pathname.endsWith("/wiki_pages")) { res.writeHead(404); res.end("[]"); return; }
  if (failSlug && u.searchParams.get("slug") === `eq.${failSlug}`) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "PGRST001", message: "Database client error. Retrying the connection.", details: "connection refused" }));
    return;
  }
  let out = [...rows].sort((a, b) => a.slug.localeCompare(b.slug));
  for (const [k, v] of u.searchParams) {
    if (k !== "slug") continue;
    if (v.startsWith("eq.")) out = out.filter((r) => r.slug === v.slice(3));
    else if (v.startsWith("like.*/")) out = out.filter((r) => r.slug.endsWith("/" + v.slice(7)));
    else if (v.startsWith("gt.")) out = out.filter((r) => r.slug > v.slice(3));
  }
  const limit = Number(u.searchParams.get("limit") || "100000");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(out.slice(0, limit)));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const vaultTmp = mkdtempSync(join(tmpdir(), "p1a-vault-"));
process.env.OPEN_BRAIN_URL = `http://127.0.0.1:${server.address().port}`;
process.env.WIKI_NAV_MIN_ROWS = "0";
process.env.WIKI_NAV_TTL_MS = "5000";
process.env.WIKI_DB_CONNECT_GRACE_MS = "0";
process.env.WIKI_VAULT_DIR = vaultTmp;

const { parseWikiPage } = await import("./shared/wiki-pages.mjs");
const { renderLive } = await import("./live-route.mjs");
const { loadPageClassDir, registerPageClass, unregisterPageClass, pageClasses } = await import("./page-classes.mjs");
const nav = await import("./nav-index.mjs");
const db = await import("./wiki-db.mjs");
await loadPageClassDir();

// The committed fixture vault -> rows via the compile rule.
const VAULT = join(HERE, "..", "test", "fixtures", "vault");
const walk = (d, r = "") => readdirSync(d).flatMap((n) => statSync(join(d, n)).isDirectory()
  ? walk(join(d, n), r ? `${r}/${n}` : n) : n.endsWith(".md") ? [r ? `${r}/${n}` : n] : []);
function seed() {
  rows = walk(VAULT).map((rel) => ({ ...parseWikiPage(rel, readFileSync(join(VAULT, rel), "utf8")), updated_at: "2026-10-18T00:00:00.000Z" }));
  nav._resetForTests();
}
seed();
test.after(() => server.close());

const URLS = {
  entity: "/content/person/person-ada-fixture",
  source: "/content/source/00000000-0000-4000-8000-000000000001",
  "research-report": "/content/source/00000000-0000-4000-8000-000000000101",
  thought: "/content/thought/9001",
  "notebook-hub": "/content/notebooks/fixture-notebook/fixture-notebook",
  "notebooks-index": "/content/notebooks/",
  note: "/notes/fixture-note",
  folder: "/content/person/",
  tag: "/tags/fixture-tag",
  retired: "/content/topic/fixture-retired-topic",
  root: "/",
};

test("every page class renders from its row/listing with the Quartz chrome (acceptance 1 elements)", async () => {
  mode = "up";
  for (const [cls, url] of Object.entries(URLS)) {
    const r = await renderLive(url);
    assert.equal(r.status, 200, `${url}: status`);
    assert.equal(r.headers["x-wiki-render"], "db", `${url}: x-wiki-render`);
    assert.equal(r.headers["x-wiki-page-class"].split("@")[0], cls, `${url}: page class`);
    const b = r.body;
    assert.ok(/<div class="explorer"[^>]*>/.test(b) && b.includes('class="explorer-ul overflow"'), `${url}: explorer root`);
    assert.ok(b.includes('<div class="graph-container"'), `${url}: graph container`);
    assert.ok(/<div class="backlinks"><h3>Backlinks<\/h3><ul id="list-2" class="overflow">/.test(b), `${url}: backlinks list`);
    assert.ok(b.includes('<div class="toc desktop-only">') && b.includes('class="toc-content overflow"'), `${url}: TOC`);
    assert.ok(b.includes('class="popover-hint"') && /<a [^>]*class="internal[^"]*"[^>]*>/.test(b), `${url}: popover anchors`);
    assert.ok(b.includes("postscript.js"), `${url}: the client bundle hydrates it`);
  }
});

test("backlinks come from the rows' links resolved like CrawlLinks", async () => {
  const b = (await renderLive(URLS.entity)).body;
  for (const t of ["Bob Fixture Wiki", "Fixture Article", "Fixture DB Wiki", "Fixture Note"]) {
    assert.ok(b.includes(`class="internal">${t}</a>`), `backlink ${t}`);
  }
});

test("D13: a deleted row is the pending-compile state (no-store), never a file render or an empty leaf", async () => {
  mkdirSync(join(vaultTmp, "content", "person"), { recursive: true });
  writeFileSync(join(vaultTmp, "content/person/person-gone.md"), "---\ntitle: Gone\n---\n# FILE BODY MARKER\n");
  const r = await renderLive("/content/person/person-gone");
  assert.equal(r.headers["x-wiki-render"], "pending");
  assert.equal(r.headers["cache-control"], "no-store");
  assert.ok(r.body.includes('data-render-state="pending"'));
  assert.ok(!r.body.includes("FILE BODY MARKER"), "the file is never rendered");
  const na = await renderLive("/content/person/never-existed");
  assert.equal(na.headers["x-wiki-render"], "not-available");
});

test("D13: database down = ONE screen on every URL; starting = connecting; never a page state", async () => {
  db._resetForTests();
  mode = "down";
  await db.probe(); // first failure starts the outage clock; grace is 0 here
  await db.probe();
  for (const url of Object.values(URLS)) {
    const r = await renderLive(url);
    assert.equal(r.status, 200);
    assert.ok(["unreachable", "connecting"].includes(r.headers["x-wiki-render"]), `${url}: ${r.headers["x-wiki-render"]}`);
    assert.ok(r.body.includes("database"), url);
    assert.ok(!r.body.includes('data-render-state="pending"'), `${url}: never pending`);
  }
  mode = "starting";
  await db.probe();
  assert.equal(db.dbState().state, "connecting");
  const r = await renderLive("/content/thought/9002");
  assert.equal(r.headers["x-wiki-render"], "connecting");
  mode = "up";
  let fired = null;
  db.onConnect((why) => { fired = why; });
  await db.probe();
  await new Promise((r2) => setTimeout(r2, 20));
  assert.equal(fired, "connect", "onConnect fires when the connection is (re)established");
  seed();
});

test("ONE editor: identity on note and source pages is derived from the rendered row, absent elsewhere", async () => {
  mode = "up";
  const note = (await renderLive(URLS.note)).body;
  assert.ok(note.includes('<div class="notes-editor-root " data-notes-root="true"'));
  assert.ok(note.includes('data-wb-edit="true" data-edit-kind="note" data-note-path="fixture-note.md" data-note-slug="notes/fixture-note"'), "note identity from the slug");
  const src = (await renderLive(URLS.source)).body;
  assert.ok(src.includes('data-source-editor="true" data-source-id="00000000-0000-4000-8000-000000000001"'), "source identity from its row");
  const ent = (await renderLive(URLS.entity)).body;
  assert.ok(!ent.includes("data-wb-edit"), "no editor button on a generated page");
  assert.ok(ent.includes('data-grounding-panel="true" data-entity-id="901"'), "entity card keyed on the row's entity_id");
});

test("expansion by registration: a new class renders with its own template; existing entries untouched", async () => {
  const before = pageClasses().map((e) => [e.name, e.version, e.priority, e.resolve, e.template]);
  rows.push({ slug: "content/glossary/term-fixture", page_class: "glossary", title: "Term", body: "# Term\n\nA glossary term.", tags: [], links: [], frontmatter: {}, updated_at: "2026-10-18T00:00:00.000Z" });
  nav._resetForTests();
  const { contentTemplate } = await import("./page-templates.mjs");
  registerPageClass({
    name: "glossary", version: 1, priority: 55,
    async resolve(_req, deps) {
      const r = await deps.row();
      if (!r.ok) return { unreachable: r.state };
      return r.row && r.row.page_class === "glossary" ? { row: r.row } : null;
    },
    async template(ctx, deps) {
      const m = await contentTemplate(ctx, deps);
      return { ...m, articleHtml: `<p data-glossary-template="1"></p>${m.articleHtml}` };
    },
  });
  try {
    const r = await renderLive("/content/glossary/term-fixture");
    assert.equal(r.headers["x-wiki-page-class"], "glossary@1");
    assert.ok(r.body.includes('data-glossary-template="1"'));
    const after = pageClasses().filter((e) => e.name !== "glossary").map((e) => [e.name, e.version, e.priority, e.resolve, e.template]);
    assert.deepEqual(after, before, "no existing entry changed");
    assert.ok(pageClasses().every((e) => Object.isFrozen(e)), "registered entries are frozen");
  } finally {
    unregisterPageClass("glossary");
    rows = rows.filter((x) => x.page_class !== "glossary");
    nav._resetForTests();
  }
});

test("no closed list: nothing outside lib/page-classes/ decides on a page_class", () => {
  for (const f of ["live-route.mjs", "chrome.mjs", "components.mjs", "page-templates.mjs", "page-classes.mjs", "../serve.mjs"]) {
    const src = readFileSync(join(HERE, f), "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
    assert.ok(!/page_class/.test(src), `${f} must not switch on page_class`);
  }
});

// ── rw-p1a-render attempt 2: the tester's findings as tests ────────────────

test("A1 parity: a folder listing gives a subfolder entry its index page's tags (Quartz FolderContent)", async () => {
  mode = "up";
  const r = await renderLive("/content/");
  assert.equal(r.headers["x-wiki-render"], "db");
  const items = r.body.split('<li class="section-li">').slice(1);
  const nb = items.find((it) => /<h3><a [^>]*>Notebooks<\/a><\/h3>/.test(it));
  assert.ok(nb, `the Notebooks subfolder entry is listed: ${items.map((it) => it.slice(0, 160)).join(" || ")}`);
  for (const t of ["wiki", "notebooks"]) assert.ok(nb.includes(`>${t}</a>`), `subfolder entry carries tag ${t}: ${nb.slice(0, 600)}`);
});

function withRow(slug, patch) {
  const i = rows.findIndex((x) => x.slug === slug);
  const saved = { ...rows[i] };
  Object.assign(rows[i], patch);
  nav._resetForTests();
  return () => { rows[i] = saved; nav._resetForTests(); };
}

test("A5/N1: a row with an empty body is the pending-compile state, never an empty leaf", async () => {
  mode = "up";
  const undo = withRow("content/thought/9002", { body: "  \n" });
  try {
    const r = await renderLive("/content/thought/9002");
    assert.equal(r.headers["x-wiki-render"], "pending");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.ok(r.body.includes('data-render-state="pending"') && r.body.includes("empty body"));
  } finally { undo(); }
});

test("A5/F-T2 (D13 item 5, stale is a miss): a row older than its file is pending, not presented", async () => {
  mode = "up";
  mkdirSync(join(vaultTmp, "content", "person"), { recursive: true });
  writeFileSync(join(vaultTmp, "content/person/person-bob-fixture.md"), "---\ntitle: Bob\n---\n# FILE BODY MARKER\n");
  const undo = withRow("content/person/person-bob-fixture", { updated_at: "2020-01-01T00:00:00.000Z" });
  try {
    const r = await renderLive("/content/person/person-bob-fixture");
    assert.equal(r.headers["x-wiki-render"], "pending");
    assert.ok(r.body.includes("older than its file"));
    assert.ok(!r.body.includes("FILE BODY MARKER"), "the file is never rendered");
  } finally { undo(); }
  // the same row, newer than its file: presented
  const undo2 = withRow("content/person/person-bob-fixture", { updated_at: new Date(Date.now() + 1000).toISOString() });
  try {
    assert.equal((await renderLive("/content/person/person-bob-fixture")).headers["x-wiki-render"], "db");
  } finally { undo2(); rmSync(join(vaultTmp, "content/person/person-bob-fixture.md")); }
});

test("A5/N2: a row dated in the future cannot hide a newer file - pending", async () => {
  mode = "up";
  const undo = withRow("content/tool/tool-fixture-db", { updated_at: "2099-01-01T00:00:00.000Z" });
  try {
    const r = await renderLive("/content/tool/tool-fixture-db");
    assert.equal(r.headers["x-wiki-render"], "pending");
    assert.ok(r.body.includes("dated in the future"));
  } finally { undo(); }
});

test("A5: a folder index row may be empty (the listing is the page); a stale one is pending", async () => {
  mode = "up";
  const undo = withRow("content/notebooks/index", { body: "" });
  try {
    assert.equal((await renderLive("/content/notebooks/")).headers["x-wiki-render"], "db");
  } finally { undo(); }
  mkdirSync(join(vaultTmp, "content", "notebooks"), { recursive: true });
  writeFileSync(join(vaultTmp, "content/notebooks/index.md"), "---\ntitle: N\n---\n# N\n");
  const undo2 = withRow("content/notebooks/index", { updated_at: "2020-01-01T00:00:00.000Z" });
  try {
    assert.equal((await renderLive("/content/notebooks/")).headers["x-wiki-render"], "pending");
  } finally { undo2(); rmSync(join(vaultTmp, "content/notebooks/index.md")); }
});

// A7: loading entry files fails LOUD on every bad shape; nothing is replaced.
async function loadDirWith(files) {
  const d = mkdtempSync(join(tmpdir(), "p1a-classes-"));
  for (const [name, src] of Object.entries(files)) writeFileSync(join(d, name), src);
  return loadPageClassDir(d);
}
const TPL = 'import { rowBacked, contentTemplate } from "' + pathToFileURL(join(HERE, "page-templates.mjs")).href + '";';

test("A7: an entry file that reuses a built-in's name fails the load (never replaces the built-in)", async () => {
  const before = pageClasses().map((e) => `${e.name}@${e.version}/p${e.priority}`);
  await assert.rejects(() => loadDirWith({ "a-dup-entity.mjs": `${TPL}\nexport default { name: "entity", version: 2, priority: 57, resolve: rowBacked((r) => r.page_class === "entity"), template: contentTemplate };` }),
    /a-dup-entity\.mjs: name "entity" is already declared/);
  assert.deepEqual(pageClasses().map((e) => `${e.name}@${e.version}/p${e.priority}`), before, "registry unchanged");
  const r = await renderLive(URLS.entity);
  assert.equal(r.headers["x-wiki-page-class"], "entity@1");
});

test("A7: duplicate names inside one directory, a priority tie, no default export, an invalid shape - all fail loud", async () => {
  const before = pageClasses().length;
  await assert.rejects(() => loadDirWith({
    "x1.mjs": `${TPL}\nexport default { name: "dupx", version: 1, priority: 31, resolve: rowBacked(() => false), template: contentTemplate };`,
    "x2.mjs": `${TPL}\nexport default { name: "dupx", version: 1, priority: 32, resolve: rowBacked(() => false), template: contentTemplate };`,
  }), /x2\.mjs: name "dupx" is already declared by x1\.mjs/);
  await assert.rejects(() => loadDirWith({ "tie.mjs": `${TPL}\nexport default { name: "tied", version: 1, priority: 54, resolve: rowBacked(() => false), template: contentTemplate };` }),
    /tie\.mjs: tied priority 54 ties with entity/);
  await assert.rejects(() => loadDirWith({ "nodefault.mjs": "export const entry = { name: 'nodef' };" }), /nodefault\.mjs: no default export/);
  await assert.rejects(() => loadDirWith({ "bad.mjs": "export default { name: 'Bad Shape', version: 0 };" }), /bad\.mjs: page class: invalid name "Bad Shape"/);
  await assert.rejects(() => loadDirWith({ "noprio.mjs": `${TPL}\nexport default { name: "noprio", version: 1, resolve: rowBacked(() => false), template: contentTemplate };` }), /noprio\.mjs: page class noprio: priority must be a finite number/);
  assert.throws(() => registerPageClass({ name: "tie2", version: 1, priority: 0, resolve: async () => null, template: async () => ({}) }), /priority 0 is already row's/);
  assert.equal(pageClasses().length, before, "nothing was registered by a failed load");
});

test("A7/N4: an entry whose resolve() throws is isolated - pages render db, health names it, never 'connecting'", async () => {
  mode = "up";
  const { brokenPageClasses } = await import("./page-classes.mjs");
  registerPageClass({ name: "aaa-throws", version: 1, priority: 95, resolve: async () => { throw new Error("boom in resolve"); }, template: async () => ({}) });
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    for (const url of [URLS.entity, URLS.note, URLS.source]) {
      const r = await renderLive(url);
      assert.equal(r.headers["x-wiki-render"], "db", `${url} falls through to its real class`);
      assert.ok(!r.body.includes("connecting"), url);
    }
    const b = brokenPageClasses().find((x) => x.name === "aaa-throws");
    assert.ok(b && b.phase === "resolve" && b.count === 3 && /boom in resolve/.test(b.error), JSON.stringify(b));
    assert.equal(errs.filter((l) => /aaa-throws@1 resolve\(\) THREW/.test(l)).length, 1, "logged once, then counted");
  } finally {
    console.error = orig;
    unregisterPageClass("aaa-throws");
  }
});

test("A7/N4: an entry whose template() throws is isolated the same way (the next entry renders)", async () => {
  mode = "up";
  const { brokenPageClasses } = await import("./page-classes.mjs");
  registerPageClass({
    name: "tpl-throws", version: 1, priority: 96,
    async resolve(req) { return req.key === "content/person/person-ada-fixture" ? { row: { slug: req.key } } : null; },
    async template() { throw new Error("boom in template"); },
  });
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await renderLive(URLS.entity);
    assert.equal(r.headers["x-wiki-render"], "db");
    assert.equal(r.headers["x-wiki-page-class"], "entity@1");
    assert.equal(brokenPageClasses().find((x) => x.name === "tpl-throws")?.phase, "template");
  } finally {
    console.error = orig;
    unregisterPageClass("tpl-throws");
  }
});

// ── attempt 3 ───────────────────────────────────────────────────────────────
const article = (b) => (/<article class="popover-hint">([\s\S]*?)<\/article>/.exec(b) || [])[1];

test("AT2-1a transclusion PORTED: ![[note]] is the embedded page's compiled body (h1 title, rebased links, Link to original), as Quartz", async () => {
  mode = "up";
  const r = await renderLive("/notes/kitchen-sink");
  assert.equal(r.headers["x-wiki-render"], "db");
  const a = article(r.body);
  const bq = (/<blockquote class="transclude" data-url="fixture-note"[\s\S]*?<\/blockquote>/.exec(a) || [])[0];
  assert.ok(bq, "the transclude block");
  assert.ok(bq.startsWith('<blockquote class="transclude" data-url="fixture-note" data-block data-embed-alias="undefined"><h1>Fixture Note</h1><h1 id="fixture-note">Fixture Note'), bq.slice(0, 200));
  assert.ok(bq.includes('href="../notes/fixture-note/../../content/person/person-ada-fixture"'), "relative links rebased like normalizeHastElement");
  assert.ok(bq.includes("<li>one thought</li>"), "the embedded body");
  assert.ok(bq.endsWith('<a href="../notes/fixture-note" class="internal transclude-src">Link to original</a></blockquote>'), bq.slice(-200));
  assert.ok(!a.includes("Transclude of fixture-note"), "not the placeholder");
});

test("AT2-1a transclusion: a heading section (and the transclusion inside it, nested), a block, a list-item block; an unknown page keeps the placeholder", async () => {
  mode = "up";
  const a = article((await renderLive("/notes/transclude-fixture")).body);
  const blocks = a.match(/<blockquote class="transclude"[\s\S]*?Link to original<\/a><\/blockquote>|<blockquote class="transclude" data-url="no-such-page"[\s\S]*?<\/blockquote>/g) || [];
  const sec = a.slice(a.indexOf('data-url="kitchen-sink"'));
  assert.ok(sec.includes('<h2 id="second-heading">Second heading'), "the section starts at its heading");
  assert.ok(!sec.slice(0, sec.indexOf("Link to original")).includes('<h1 id="kitchen-sink-fixture">'), "and not before it");
  assert.ok(/data-url="fixture-note"[^>]*><h1>Fixture Note<\/h1>/.test(sec), "the section's own ![[fixture-note]] is filled too (nested, as Quartz's visit does)");
  assert.ok(a.includes('<p id="key-point">The key point of this note is that a block can be embedded on its own.</p><a href="../notes/block-source#^key-point" class="internal transclude-src">Link to original</a>')
    || /<p id="key-point">[^<]*<\/p><a [^>]*class="internal transclude-src">Link to original<\/a>/.test(a), "the block");
  assert.ok(/<ul><li id="li-point">a list item another page embeds\s*<\/li><\/ul><a [^>]*class="internal transclude-src">/.test(a), "a list item is wrapped in a ul");
  assert.ok(/<blockquote class="transclude" data-url="no-such-page"[^>]*><a [^>]*class="transclude-inner[^"]*"[^>]*>Transclude of no-such-page<\/a><\/blockquote>/.test(a), "unknown page: Quartz's placeholder");
  assert.ok(blocks.length >= 4, String(blocks.length));
});

test("AT2-1a transclusion: an embedded page with no presentable row is the pending-compile marker INSIDE the block (D9); the host stays db", async () => {
  mode = "up";
  mkdirSync(join(vaultTmp, "notes"), { recursive: true });
  writeFileSync(join(vaultTmp, "notes/block-source.md"), "---\ntitle: B\n---\n# FILE BODY MARKER\n");
  const undo = withRow("notes/block-source", { updated_at: "2020-01-01T00:00:00.000Z" }); // older than its file: not presentable
  try {
    const r = await renderLive("/notes/transclude-fixture");
    assert.equal(r.headers["x-wiki-render"], "db");
    const a = article(r.body);
    assert.ok(a.includes('<p class="transclude-pending" data-render-state="pending">Pending compile: notes/block-source is not presented yet (its row is older than its file'), a.slice(0, 400));
    assert.ok(!a.includes("FILE BODY MARKER"), "never the file");
  } finally { undo(); rmSync(join(vaultTmp, "notes/block-source.md")); }
});

test("AT2-1a transclusion: a cycle (a page transcluding itself, or A -> B -> A) is left as the placeholder at the repeat - it terminates", async () => {
  mode = "up";
  rows.push(
    { slug: "notes/cyc-self", page_class: "note", title: "Cyc Self", body: "# Self\n\n![[cyc-self]]\n", tags: [], links: ["cyc-self"], frontmatter: {}, updated_at: "2026-10-18T00:00:00.000Z" },
    { slug: "notes/cyc-a", page_class: "note", title: "Cyc A", body: "# A\n\n![[cyc-b]]\n", tags: [], links: ["cyc-b"], frontmatter: {}, updated_at: "2026-10-18T00:00:00.000Z" },
    { slug: "notes/cyc-b", page_class: "note", title: "Cyc B", body: "# B\n\n![[cyc-a]]\n", tags: [], links: ["cyc-a"], frontmatter: {}, updated_at: "2026-10-18T00:00:00.000Z" },
  );
  nav._resetForTests();
  try {
    const s = article((await renderLive("/notes/cyc-self")).body);
    assert.ok(s.includes("Transclude of cyc-self"), "self: placeholder");
    const a = article((await renderLive("/notes/cyc-a")).body);
    assert.ok(a.includes("<h1>Cyc B</h1>"), "B is filled");
    assert.ok(a.includes("Transclude of cyc-a"), "A inside B is the placeholder");
  } finally { seed(); }
});

test("AT2-1a transclusion: the database not answering for an embedded page's row is the database screen for the request, never half a page", async () => {
  mode = "up";
  failSlug = "notes/block-source";
  try {
    const r = await renderLive("/notes/transclude-fixture");
    assert.notEqual(r.headers["x-wiki-render"], "db");
    assert.ok(["connecting", "unreachable"].includes(r.headers["x-wiki-render"]), r.headers["x-wiki-render"]);
    assert.equal(r.headers["cache-control"], "no-store");
  } finally {
    failSlug = null;
    db._resetForTests();
    await db.probe();
  }
});

test("AT2-1b self-backlink: a page that links to its own heading lists itself under Backlinks, as Quartz", async () => {
  mode = "up";
  const b = (await renderLive("/notes/kitchen-sink")).body;
  const bl = (/<div class="backlinks">[\s\S]*?<\/div>/.exec(b) || [])[0];
  assert.ok(bl.includes('<a href="../notes/kitchen-sink" class="internal">Kitchen Sink Fixture</a>'), bl);
  assert.ok(!bl.includes("No backlinks found"));
});

test("F7 alias redirects: an alias URL is Quartz's AliasRedirects page byte for byte; a real page at a slug is never shadowed", async () => {
  mode = "up";
  const { aliasDocument } = await import("./page-classes/alias.mjs");
  const quartz = (og, url) => `
        <!DOCTYPE html>
        <html lang="en-us">
        <head>
        <title>${og}</title>
        <link rel="canonical" href="${url}">
        <meta name="robots" content="noindex">
        <meta charset="utf-8">
        <meta http-equiv="refresh" content="0; url=${url}">
        </head>
        </html>
        `;
  for (const [u, og, url] of [
    ["/old-kitchen-sink", "notes/kitchen-sink", "./notes/kitchen-sink"],
    ["/Ada-Fixture", "content/person/person-ada-fixture", "./content/person/person-ada-fixture"],
    ["/Second-Notebook", "content/notebooks/second-notebook/second-notebook", "./content/notebooks/second-notebook/second-notebook"],
  ]) {
    const r = await renderLive(u);
    assert.equal(r.status, 200, u);
    assert.equal(r.headers["x-wiki-render"], "db", u);
    assert.equal(r.headers["x-wiki-page-class"], "alias@1", u);
    assert.equal(r.body, quartz(og, url), u);
  }
  assert.equal(aliasDocument("a<b", "./x\"y"), quartz("a&lt;b", "./x&quot;y"), "D10: escaped only where a slug carries & < > \"");
  assert.equal((await renderLive("/notes/kitchen-sink")).headers["x-wiki-page-class"], "note@1");
  assert.equal((await renderLive("/not-an-alias-at-all")).headers["x-wiki-render"], "not-available");
});

test("N2-4/N2-5: a note whose source is frontmatter only is presented as Quartz presents it (an empty article, db) - not pending forever", async () => {
  mode = "up";
  mkdirSync(join(vaultTmp, "notes"), { recursive: true });
  writeFileSync(join(vaultTmp, "notes/empty-body-note.md"), "---\ntitle: \"Empty Body Note\"\ntags: [fixture-tag]\n---\n");
  const undo = withRow("notes/empty-body-note", { updated_at: new Date(Date.now() + 1000).toISOString() });
  try {
    const r = await renderLive("/notes/empty-body-note");
    assert.equal(r.headers["x-wiki-render"], "db");
    assert.equal(article(r.body), "");
  } finally { undo(); rmSync(join(vaultTmp, "notes/empty-body-note.md")); }
  // the same empty row WITHOUT a file showing it is meant to be empty: pending (never an empty leaf standing in)
  assert.equal((await renderLive("/notes/empty-body-note")).headers["x-wiki-render"], "pending");
});

test("N2-3: an NBSP / ideographic-space body over a file with content is pending (the reconcile's rule, shared)", async () => {
  mode = "up";
  mkdirSync(join(vaultTmp, "content", "thought"), { recursive: true });
  writeFileSync(join(vaultTmp, "content/thought/9002.md"), "---\ntitle: T\n---\n# Real thought\n");
  for (const body of [" 　", "%% only a comment %%", "<div onclick=\"x()\"></div>", "---\nfm: only\n---\n"]) {
    const undo = withRow("content/thought/9002", { body, updated_at: new Date(Date.now() + 1000).toISOString() });
    try {
      const r = await renderLive("/content/thought/9002");
      assert.equal(r.headers["x-wiki-render"], "pending", JSON.stringify(body));
      assert.ok(r.body.includes("empty body"));
    } finally { undo(); }
  }
  rmSync(join(vaultTmp, "content/thought/9002.md"));
});

test("N2-1: a resolve() returning a hand-built { unreachable } (or a non-object) is a registry fault named in health - never the database screen", async () => {
  mode = "up";
  const { brokenPageClasses } = await import("./page-classes.mjs");
  registerPageClass({ name: "shape-unreach", version: 1, priority: 98, async resolve(req) { return req.key.includes("fixture-note") ? { unreachable: true } : null; }, async template() { return {}; } });
  registerPageClass({ name: "shape-string", version: 1, priority: 97, async resolve(req) { return req.key.includes("nested-note") ? "a string" : null; }, async template() { return {}; } });
  registerPageClass({ name: "tpl-shape", version: 1, priority: 94, async resolve(req) { return req.key === "content/thought/9001" ? { row: { slug: req.key } } : null; }, async template() { return { unreachable: "connecting" }; } });
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await renderLive("/notes/fixture-note");
    assert.equal(r.headers["x-wiki-render"], "db", "not a fake database screen");
    assert.equal(r.headers["x-wiki-page-class"], "note@1");
    assert.equal((await renderLive("/notes/fixture-folder/nested-note")).headers["x-wiki-page-class"], "note@1");
    const t = await renderLive("/content/thought/9001");
    assert.equal(t.headers["x-wiki-render"], "db");
    assert.equal(t.headers["x-wiki-page-class"], "thought@1");
    const b = brokenPageClasses();
    assert.match(b.find((x) => x.name === "shape-unreach")?.error || "", /hand-built/);
    assert.match(b.find((x) => x.name === "shape-string")?.error || "", /returned string/);
    assert.equal(b.find((x) => x.name === "tpl-shape")?.phase, "template");
  } finally {
    console.error = orig;
    for (const n of ["shape-unreach", "shape-string", "tpl-shape"]) unregisterPageClass(n);
  }
});
