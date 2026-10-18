// node --test recipes/_shared/wiki-pages.retry.test.mjs
// rw-p1a-render attempt 3 (tester AT2-7): rows a run left unsynced because the
// DATABASE was unavailable are recorded and written from their files by the
// next cycle (retryUnsyncedRows); what fails again stays recorded, a slug
// whose file is gone is dropped.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let answer = 201;
const posted = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (req.method === "POST") posted.push(...JSON.parse(raw || "[]").map((r) => r.slug));
    res.writeHead(answer, { "content-type": "application/json" });
    res.end(answer < 300 ? "" : '{"code":"PGRST001","message":"no connection"}');
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
test.after(() => server.close());
process.env.OPEN_BRAIN_URL = `http://127.0.0.1:${server.address().port}`;
const vault = mkdtempSync(join(tmpdir(), "wp-retry-"));
process.env.WIKI_GIT_DIR = vault;
const outDir = join(vault, "content");
mkdirSync(join(outDir, "person"), { recursive: true });
writeFileSync(join(outDir, "person/person-a.md"), "---\ntitle: A\n---\n# A\n");
const m = await import("./wiki-pages.mjs");
const FILE = join(outDir, m.UNSYNCED_FILE);

test("the next cycle writes the recorded rows from their files; a gone file is dropped; a failure again stays recorded", async () => {
  m.rememberUnsyncedRows(outDir, [{ slug: "content/person/person-a", error: "fetch failed" }, { slug: "content/person/person-gone", error: "fetch failed" }], "generate-wiki");
  answer = 503;
  const logs = [];
  let r = await m.retryUnsyncedRows({ outDir, vaultDir: vault, log: (x) => logs.push(x) });
  assert.deepEqual(r, { retried: 2, landed: 0, failed: 1, dropped: 1 });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(FILE, "utf8")).rows), ["content/person/person-a"], "kept for the cycle after");
  answer = 201;
  r = await m.retryUnsyncedRows({ outDir, vaultDir: vault, log: (x) => logs.push(x) });
  assert.deepEqual(r, { retried: 1, landed: 1, failed: 0, dropped: 0 });
  assert.ok(posted.includes("content/person/person-a"));
  assert.deepEqual(JSON.parse(readFileSync(FILE, "utf8")).rows, {});
  assert.match(logs.at(-1), /retried 1 row\(s\) left unsynced by a database outage: 1 landed, 0 failed again, 0 dropped/);
  assert.deepEqual(await m.retryUnsyncedRows({ outDir, vaultDir: vault }), { retried: 0, landed: 0, failed: 0, dropped: 0 }, "nothing recorded: nothing to do");
});
