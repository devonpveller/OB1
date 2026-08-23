// Unit tests for the dirty-aware notebook synthesis (the LLM-churn fix).
// Run: `node --test`. Importing is safe — main() is guarded behind a
// direct-execution check.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { existingHubHash, synthesisInputHash } from "./synthesize-notebooks.mjs";

const THREAD = { name: "Blender pipeline", description: "3D asset research" };
const SRC = {
  id: "3f8a1c2d-1111-4aaa-9bbb-0123456789ab",
  title: "Article",
  url: "https://example.com/a",
  content_type: "web_article",
  research_query: "",
  content: "body text",
  metadata: { foo: 1 },
};

test("hash is deterministic for identical inputs", () => {
  assert.equal(
    synthesisInputHash(THREAD, [SRC], "qwen36-27b"),
    synthesisInputHash(THREAD, [{ ...SRC }], "qwen36-27b"),
  );
});

test("hash changes when source content, source set, model, or thread changes", () => {
  const base = synthesisInputHash(THREAD, [SRC], "m");
  assert.notEqual(synthesisInputHash(THREAD, [{ ...SRC, content: "edited" }], "m"), base);
  assert.notEqual(synthesisInputHash(THREAD, [], "m"), base);
  assert.notEqual(synthesisInputHash(THREAD, [SRC], "other-model"), base);
  assert.notEqual(synthesisInputHash({ ...THREAD, name: "Renamed" }, [SRC], "m"), base);
  // metadata drives the source-leaf render (prose_synthesis) — must be in the hash
  assert.notEqual(
    synthesisInputHash(THREAD, [{ ...SRC, metadata: { prose_synthesis: "x" } }], "m"),
    base,
  );
});

test("existingHubHash reads the frontmatter stamp; absent file/stamp → null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-"));
  const hub = path.join(dir, "hub.md");
  const hash = synthesisInputHash(THREAD, [SRC], "m");
  fs.writeFileSync(hub, `---\ntitle: "X"\ninput_hash: "${hash}"\n---\n\nbody\n`, "utf8");
  assert.equal(existingHubHash(hub), hash);
  assert.equal(existingHubHash(path.join(dir, "missing.md")), null);
  fs.writeFileSync(hub, `---\ntitle: "X"\n---\n\nbody\n`, "utf8");
  assert.equal(existingHubHash(hub), null);
});
