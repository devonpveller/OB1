// node --test recipes/_shared/quartz-slug.test.mjs
// rw-p1a-deploy-prep (NA4-1, RV-1): the port is Quartz's rule exactly. The
// expected values are Quartz 4.5.1's OWN slugifyFilePath output for these
// names (quartz/util/path.ts bundled and run inside the viewer image,
// 2026-10-18; the test plan's NA4-1 case re-derives them), and the page set
// is what the image's globby call returned for the same tree.
import test from "node:test";
import assert from "node:assert/strict";
import { slugifyFilePath, urlSlugOf, isPagePath, isContentDir, sluggifySegment } from "./quartz-slug.mjs";

const QUARTZ = {
  "notes/slug-names/sp ace.md": "notes/slug-names/sp-ace",
  "notes/slug-names/pv.1.md": "notes/slug-names/pv.1",
  "notes/slug-names/a&b.md": "notes/slug-names/a-and-b",
  "notes/slug-names/q?x.md": "notes/slug-names/qx",
  "notes/slug-names/h#t.md": "notes/slug-names/ht",
  "notes/slug-names/50%.md": "notes/slug-names/50-percent",
  "notes/slug-names/up.md": "notes/slug-names/up",
  "notes/slug-names/up/inner.md": "notes/slug-names/up/inner",
  "notes/slug-names/deep folder/sub dir/leaf note.md": "notes/slug-names/deep-folder/sub-dir/leaf-note",
  "notes/_index.md": "notes/index",
  "notes/x/_index.md": "notes/x/index",
  "a.b.c.md": "a.b.c",
  "x.png.md": "x.png",
  "tags/ta g.md": "tags/ta-g",
  "notes/Tab\there.md": "notes/Tab-here",
  "notes/pv.1": "notes/pv.1",
  "notes/v1.0 final.md": "notes/v1.0-final",
};

test("NA4-1: slugifyFilePath = Quartz 4.5.1's own output for every fixture name", () => {
  for (const [fp, want] of Object.entries(QUARTZ)) assert.equal(slugifyFilePath(fp), want, fp);
});

test("NA4-1: urlSlugOf(row slug) is the URL Quartz builds for the row's file", () => {
  assert.equal(urlSlugOf("notes/slug-names/sp ace"), "notes/slug-names/sp-ace");
  assert.equal(urlSlugOf("notes/slug-names/pv.1"), "notes/slug-names/pv.1");
  assert.equal(urlSlugOf("content/person/person-ada-fixture"), "content/person/person-ada-fixture");
  assert.equal(urlSlugOf("index"), "index");
  assert.equal(urlSlugOf("notes/fixture-folder/index"), "notes/fixture-folder/index");
  assert.equal(sluggifySegment("deep folder"), "deep-folder");
});

test("RV-1: isPagePath is Quartz's page set (root-anchored ignore patterns, no dot entries, .md only)", () => {
  const yes = ["index.md", "notes/x.md", "notes/private/kept.md", "notes/templates/t.md", "content/person/p.md", "notes/sp ace.md"];
  const no = ["private/secret.md", "templates/t.md", ".obsidian/o.md", "notes/.hidden/h.md", "notes/.dot-note.md", ".git/x.md",
    "notes/readme.txt", "public/x.md", "notes/assets/a.md", "node_modules/m.md", ".quartz-cache/c.md", "content/.structural-failures.json"];
  for (const p of yes) assert.equal(isPagePath(p), true, p);
  for (const p of no) assert.equal(isPagePath(p), false, p);
  assert.equal(isContentDir(""), true);
  assert.equal(isContentDir("private"), false);
  assert.equal(isContentDir("notes/private"), true);
});
