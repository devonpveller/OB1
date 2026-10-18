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
