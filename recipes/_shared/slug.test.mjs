// Unit tests for the canonical slug module (G5). Run: `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugifyBase, slugifyEntity, slugifyNotebook } from "./slug.mjs";

test("slugifyBase: lowercase, non-alnum→hyphen, trim", () => {
  assert.equal(slugifyBase("Hello, World!"), "hello-world");
  assert.equal(slugifyBase("  spaced   out  "), "spaced-out");
  assert.equal(slugifyBase("C++ / C#"), "c-c");
});

test("slugifyBase: NFKD strips diacritics", () => {
  assert.equal(slugifyBase("Résumé Café"), "resume-cafe");
  assert.equal(slugifyBase("naïve coöperate"), "naive-cooperate");
});

test("slugifyEntity: type prefix + unnamed fallback", () => {
  assert.equal(slugifyEntity("PostgreSQL", "tool"), "tool-postgresql");
  assert.equal(slugifyEntity("", "tool"), "tool-unnamed");
  assert.equal(slugifyEntity("!!!", "person"), "person-unnamed");
  assert.equal(slugifyEntity("Bare"), "bare"); // no type → base only
});

test("slugifyNotebook: base + default fallback", () => {
  assert.equal(slugifyNotebook("My Research Notes"), "my-research-notes");
  assert.equal(slugifyNotebook(""), "default");
  assert.equal(slugifyNotebook("###"), "default");
});

test("idempotent on already-slugged input", () => {
  assert.equal(slugifyBase("already-a-slug"), "already-a-slug");
  assert.equal(slugifyEntity("tool-postgresql", undefined), "tool-postgresql");
});
