// Unit tests for the idempotent-write utility (the churn fix). Run: `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeIfChanged, writeIfChangedStable } from "./write-if-changed.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wic-"));

test("writes a missing file (and creates parent dirs)", () => {
  const f = path.join(tmp(), "a", "b", "page.md");
  assert.equal(writeIfChanged(f, "hello\n"), true);
  assert.equal(fs.readFileSync(f, "utf8"), "hello\n");
});

test("identical content is NOT rewritten — mtime preserved", () => {
  const f = path.join(tmp(), "page.md");
  writeIfChanged(f, "same\n");
  const before = fs.statSync(f).mtimeMs;
  // Backdate so a rewrite would be observable even on coarse mtime clocks.
  fs.utimesSync(f, new Date(0), new Date(0));
  assert.equal(writeIfChanged(f, "same\n"), false);
  assert.equal(fs.statSync(f).mtimeMs, 0);
  void before;
});

test("changed content IS rewritten", () => {
  const f = path.join(tmp(), "page.md");
  writeIfChanged(f, "v1\n");
  assert.equal(writeIfChanged(f, "v2\n"), true);
  assert.equal(fs.readFileSync(f, "utf8"), "v2\n");
});

test("stable: a generated_at-only difference does not rewrite (md frontmatter)", () => {
  const f = path.join(tmp(), "hub.md");
  const page = (ts) => `---\ntitle: "X"\ngenerated_at: ${ts}\nsource_count: 3\n---\n\n# X\nbody\n`;
  writeIfChangedStable(f, page("2026-01-01T00:00:00.000Z"));
  fs.utimesSync(f, new Date(0), new Date(0));
  assert.equal(writeIfChangedStable(f, page("2026-08-23T12:00:00.000Z")), false);
  assert.equal(fs.statSync(f).mtimeMs, 0);
  // The on-disk stamp keeps the OLD value — "when the content last changed".
  assert.match(fs.readFileSync(f, "utf8"), /generated_at: 2026-01-01/);
});

test("stable: a real content change rewrites even with a volatile stamp", () => {
  const f = path.join(tmp(), "hub.md");
  const page = (ts, body) => `---\ngenerated_at: ${ts}\n---\n\n${body}\n`;
  writeIfChangedStable(f, page("2026-01-01T00:00:00.000Z", "old"));
  assert.equal(writeIfChangedStable(f, page("2026-08-23T12:00:00.000Z", "new")), true);
  assert.match(fs.readFileSync(f, "utf8"), /new/);
  assert.match(fs.readFileSync(f, "utf8"), /generated_at: 2026-08-23/);
});

test("stable: JSON form (graph.json manifest)", () => {
  const f = path.join(tmp(), "graph.json");
  const manifest = (ts) => JSON.stringify({ generated_at: ts, node_count: 2 }, null, 2) + "\n";
  writeIfChangedStable(f, manifest("2026-01-01T00:00:00.000Z"));
  fs.utimesSync(f, new Date(0), new Date(0));
  assert.equal(writeIfChangedStable(f, manifest("2026-08-23T12:00:00.000Z")), false);
  assert.equal(fs.statSync(f).mtimeMs, 0);
});
