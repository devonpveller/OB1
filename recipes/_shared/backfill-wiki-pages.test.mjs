// node --test recipes/_shared/backfill-wiki-pages.test.mjs
// rw-p1a-deploy-prep (reviewer RV-1): the one-time backfill over an AUTHORED
// vault with hand-written wikilinks. Its note rows carry the links the repair
// pass writes (resolved, never the raw target), it writes no row for a path
// the reconciliation's walk excludes (private/ and templates/ at the vault
// root, dot-directories, dot-files), and --prune never deletes a row for an
// excluded path. The script is run as the CLI the operator runs, against a
// stub PostgREST, so the same test runs against the 7e61837 script (RED).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.BACKFILL_SCRIPT || join(HERE, "backfill-wiki-pages.mjs");
const RECONCILE = join(HERE, "reconcile-wiki-pages.mjs");

// The stub's table: slug -> row. Records every POST and DELETE.
let table = new Map();
let posted = [];
let deleted = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-range": `0-0/${table.size}` });
      return res.end();
    }
    if (req.method === "POST") {
      for (const r of JSON.parse(raw || "[]")) { table.set(r.slug, r); posted.push(r); }
      res.writeHead(201);
      return res.end();
    }
    if (req.method === "DELETE") {
      const m = /^in\.\((.*)\)$/.exec(u.searchParams.get("slug") || "");
      const slugs = m ? m[1].split(",").map((s) => s.replace(/^"|"$/g, "")) : [];
      for (const s of slugs) { table.delete(s); deleted.push(s); }
      res.writeHead(204);
      return res.end();
    }
    // GET: a keyset page (the cursor's next page is empty) or the body prefilter (none empty)
    const rows = u.searchParams.has("slug") || u.searchParams.has("body") ? [] : [...table.values()]
      .sort((a, b) => (a.slug < b.slug ? -1 : 1))
      .map((r) => ({ slug: r.slug, page_class: r.page_class, updated_at: r.updated_at || new Date().toISOString(), links: r.links || [] }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(rows));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
test.after(() => server.close());
const OB = `http://127.0.0.1:${server.address().port}`;

// The authored vault (file names a Windows checkout can hold).
const vault = mkdtempSync(join(tmpdir(), "backfill-rv1-"));
test.after(() => rmSync(vault, { recursive: true, force: true }));
const put = (rel, text) => { mkdirSync(dirname(join(vault, rel)), { recursive: true }); writeFileSync(join(vault, rel), text); };
put("index.md", "---\ntitle: Home\n---\n# Home\n");
put("content/tool/tool-pg.md", "---\ntitle: PostgreSQL\n---\n# PostgreSQL\n");
put("content/person/person-ada.md", "---\ntitle: Ada\n---\n# Ada\n");
// a note with hand-written links: a basename, a full slug, a basename with an
// alias, an unknown target, and a target two pages end in (ambiguous: stays raw)
put("notes/intermediary.md", "# Intermediary\n\nUses [[tool-pg|PostgreSQL]], see [[notes/other]] and [[person-ada]].\n" +
  "Unknown: [[missing-target]]. Ambiguous: [[dup]].\n");
put("notes/other.md", "# Other\n\nBack to [[intermediary]].\n");
put("notes/a/dup.md", "# dup a\n");
put("notes/b/dup.md", "# dup b\n");
put("notes/private/kept.md", "# Nested private folder\n\nQuartz builds this page (its ignore patterns are root-anchored).\n");
// excluded from the walk (Quartz never builds them)
put("private/secret.md", "# Secret\n");
put("templates/tpl.md", "# Template {{title}}\n");
put("notes/.hidden/h.md", "# Hidden dir\n");
put(".obsidian/o.md", "# Obsidian\n");
put("notes/.dot-note.md", "# Dot file\n");
put("notes/readme.txt", "not markdown\n");

const run = (script, args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, OPEN_BRAIN_URL: OB, WIKI_GIT_DIR: vault, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  c.stdout.on("data", (d) => { out += d; });
  c.stderr.on("data", (d) => { out += d; });
  c.on("close", (code) => resolve({ code, out }));
});

const WANT_SLUGS = [
  "content/person/person-ada", "content/tool/tool-pg", "index", "notes/a/dup", "notes/b/dup",
  "notes/intermediary", "notes/other", "notes/private/kept",
];

test("RV-1: backfill writes a row for exactly the walk's pages - none for private/, templates/, dot-directories or dot-files", async () => {
  table = new Map(); posted = []; deleted = [];
  const r = await run(SCRIPT, []);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([...new Set(posted.map((x) => x.slug))].sort(), WANT_SLUGS, r.out);
});

test("RV-1: a backfilled note row carries the links the repair pass writes (resolved, never a raw target it resolves)", async () => {
  table = new Map(); posted = []; deleted = [];
  const b = await run(SCRIPT, []);
  assert.equal(b.code, 0, b.out);
  const back = Object.fromEntries(posted.filter((x) => x.page_class === "note").map((x) => [x.slug, x.links]));
  assert.deepEqual(back["notes/intermediary"],
    ["content/tool/tool-pg", "notes/other", "content/person/person-ada", "missing-target", "dup"], b.out);
  assert.deepEqual(back["notes/other"], ["notes/intermediary"], b.out);
  // the reference: the repair pass over the same vault, the table empty (every row missing)
  table = new Map(); posted = [];
  const rp = await run(RECONCILE, ["--repair", "--vault", vault]);
  assert.match(rp.out, /repair pass: 8 row\(s\) written/, rp.out);
  const repaired = Object.fromEntries(posted.filter((x) => x.page_class === "note").map((x) => [x.slug, x.links]));
  assert.deepEqual(back, repaired);
});

test("RV-1: --prune deletes a walkable row with no file, never a row for a path the walk excludes", async () => {
  table = new Map([
    ["private/secret", { slug: "private/secret", page_class: "root", links: [] }],
    ["templates/tpl", { slug: "templates/tpl", page_class: "root", links: [] }],
    ["notes/.hidden/h", { slug: "notes/.hidden/h", page_class: "note", links: [] }],
    ["notes/gone", { slug: "notes/gone", page_class: "note", links: [] }],
  ]);
  posted = []; deleted = [];
  const r = await run(SCRIPT, ["--prune"], { BACKFILL_PRUNE_MIN: "1" });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(deleted, ["notes/gone"], r.out);
  assert.ok(table.has("private/secret") && table.has("templates/tpl") && table.has("notes/.hidden/h"), r.out);
  assert.match(r.out, /3 row\(s\) for a path the walk EXCLUDES/, r.out);
});

test("RV-1: the database's row list unreadable -> exit 2, nothing written", async () => {
  table = new Map(); posted = [];
  const r = await run(SCRIPT, [], { OPEN_BRAIN_URL: "http://127.0.0.1:9" });
  assert.equal(r.code, 2, r.out);
  assert.equal(posted.length, 0);
  assert.match(r.out, /CANNOT RUN/);
});
