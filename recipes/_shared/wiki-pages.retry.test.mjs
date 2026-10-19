// node --test recipes/_shared/wiki-pages.retry.test.mjs
// rw-p1a-render attempt 3 (tester AT2-7): rows a run left unsynced because the
// DATABASE was unavailable are recorded and written from their files by the
// next cycle (retryUnsyncedRows); what fails again stays recorded, a slug
// whose file is gone is dropped.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let answer = 201;
let delayMs = 0; // attempt 4: hold the upsert so another writer can record meanwhile
let onPost = null;
const posted = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    if (req.method === "POST") posted.push(...JSON.parse(raw || "[]").map((r) => r.slug));
    if (req.method === "POST" && onPost) onPost();
    setTimeout(() => {
      res.writeHead(answer, { "content-type": "application/json" });
      res.end(answer < 300 ? "" : '{"code":"PGRST001","message":"no connection"}');
    }, delayMs);
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
  assert.deepEqual(r, { retried: 2, landed: 0, failed: 1, dropped: 1, rejected: 0 });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(FILE, "utf8")).rows), ["content/person/person-a"], "kept for the cycle after");
  answer = 201;
  r = await m.retryUnsyncedRows({ outDir, vaultDir: vault, log: (x) => logs.push(x) });
  assert.deepEqual(r, { retried: 1, landed: 1, failed: 0, dropped: 0, rejected: 0 });
  assert.ok(posted.includes("content/person/person-a"));
  assert.deepEqual(JSON.parse(readFileSync(FILE, "utf8")).rows, {});
  assert.match(logs.at(-1), /retried 1 row\(s\) left unsynced by a database outage: 1 landed, 0 failed again, 0 dropped/);
  assert.deepEqual(await m.retryUnsyncedRows({ outDir, vaultDir: vault }), { retried: 0, landed: 0, failed: 0, dropped: 0, rejected: 0 }, "nothing recorded: nothing to do");
});

// ── attempt 4 (tester NA3-4): the record is locked, confined to the vault, and
// an unreadable record is loud ──────────────────────────────────────────────
const LEDGER_URL = new URL("./structural-ledger.mjs", import.meta.url).href;
const readRows = () => JSON.parse(readFileSync(FILE, "utf8")).rows;

test("NA3-4: a recorded slug outside the vault (.., absolute, backslash) is REJECTED and never read; the vault's own slugs still land", async () => {
  rmSync(FILE, { force: true });
  writeFileSync(join(vault, "..", "outside-the-vault.md"), "---\ntitle: Outside\n---\n# must never be read\n");
  answer = 201; delayMs = 0; posted.length = 0;
  m.rememberUnsyncedRows(outDir, [
    { slug: "../outside-the-vault", error: "fetch failed" },
    { slug: "content/../../outside-the-vault", error: "fetch failed" },
    { slug: join(vault, "..", "outside-the-vault").replace(/\\/g, "/"), error: "fetch failed" },
    { slug: "content\\..\\..\\outside-the-vault", error: "fetch failed" },
    { slug: "content/person/person-a", error: "fetch failed" },
  ], "generate-wiki");
  const logs = [];
  const r = await m.retryUnsyncedRows({ outDir, vaultDir: vault, log: (x) => logs.push(x) });
  assert.deepEqual(r, { retried: 5, landed: 1, failed: 0, dropped: 0, rejected: 4 });
  assert.deepEqual(posted, ["content/person/person-a"], "nothing outside the vault was read or written");
  assert.match(logs.join("\n"), /4 rejected \(not a vault slug\)/);
  assert.deepEqual(readRows(), {}, "a rejected slug is not kept for the next cycle");
});

test("NA3-4: an unreadable record (invalid JSON) is logged LOUDLY and read as empty", async () => {
  writeFileSync(FILE, "{notjson");
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    const r = await m.retryUnsyncedRows({ outDir, vaultDir: vault, log: () => {} });
    assert.deepEqual(r, { retried: 0, landed: 0, failed: 0, dropped: 0, rejected: 0 });
  } finally { console.error = orig; }
  assert.ok(errs.some((e) => /unsynced-row record .* is unreadable .*treated as empty/.test(e)), JSON.stringify(errs));
  rmSync(FILE, { force: true });
});

test("NA3-4: the record is written under the ledger lock - a racing writer's entry is never lost", async () => {
  rmSync(FILE, { force: true });
  m.rememberUnsyncedRows(outDir, [{ slug: "content/person/person-a", error: "fetch failed" }], "generate-wiki");
  // another process holds the record's lock, reads, waits 600 ms, writes its own entry back
  const code = `
    import fs from "node:fs";
    import { withLedgerLock } from ${JSON.stringify(LEDGER_URL)};
    const f = ${JSON.stringify(FILE)};
    withLedgerLock(f, () => {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      process.stdout.write("LOCKED\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
      j.rows["content/person/person-other"] = { error: "fetch failed", tag: "notebook-synth", at: new Date().toISOString() };
      fs.writeFileSync(f, JSON.stringify(j));
    });
  `;
  const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise((resolve) => p.on("close", resolve));
  await new Promise((resolve) => p.stdout.once("data", resolve));
  m.rememberUnsyncedRows(outDir, [{ slug: "content/person/person-b", error: "fetch failed" }], "generate-wiki");
  assert.equal(await closed, 0);
  assert.deepEqual(Object.keys(readRows()).sort(), ["content/person/person-a", "content/person/person-b", "content/person/person-other"]);
});

test("NA3-4: a slug recorded WHILE the retry's upsert is in flight survives the retry's write (the retry applies deltas under the lock)", async () => {
  rmSync(FILE, { force: true });
  answer = 201; delayMs = 300;
  m.rememberUnsyncedRows(outDir, [{ slug: "content/person/person-a", error: "fetch failed" }], "generate-wiki");
  onPost = () => { onPost = null; m.rememberUnsyncedRows(outDir, [{ slug: "content/person/person-late", error: "fetch failed" }], "notebook-synth"); };
  try {
    const r = await m.retryUnsyncedRows({ outDir, vaultDir: vault, log: () => {} });
    assert.equal(r.landed, 1);
  } finally { delayMs = 0; onPost = null; }
  assert.deepEqual(Object.keys(readRows()), ["content/person/person-late"], "the landed row left, the late one stays");
});
