#!/usr/bin/env node
/**
 * d7-selftest - rw-p1a-deploy-prep (NA4-3): parity rule D7 ("a retired slug
 * has no built page; the live page is the retired-class explanation") must
 * explain a retired URL ONLY when the live response is the retired class.
 *
 * Runs parity-diff.mjs (PARITY_DIFF overrides the path: the RED run points it
 * at the 7e61837 copy) against a stub viewer that serves the retired fixture
 * URL with full chrome, an EMPTY built snapshot (the builder wrote no file),
 * and the page class the case names:
 *   retired@1 -> D7 fires, PARITY: PASS (exit 0)
 *   entity@1  -> the body is UNLISTED, PARITY: FAIL (exit 1) - another class
 *                serving a retired URL (e.g. an orphan row) is not parity
 *   note@1    -> the same
 * Prints D7-SELFTEST: PASS when every expectation holds (exit 0), else FAIL.
 * No network beyond 127.0.0.1; runs anywhere node runs (the plan runs it in
 * the viewer image with --network none).
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.PARITY_DIFF || join(HERE, "parity-diff.mjs");
const URL_ = "/content/topic/fixture-retired-topic";
const BODY = '<body data-slug="content/topic/fixture-retired-topic"><div class="page"><div class="left sidebar">' +
  '<div class="explorer" data-behavior="collapse"><ul class="explorer-ul overflow"></ul></div></div><div class="center">' +
  '<div class="page-header"></div><div class="popover-hint"><article><p><a href="../../index" class="internal">Home</a></p></article></div></div>' +
  '<div class="right sidebar"><div class="graph"><div class="graph-container"></div></div><div class="toc desktop-only">' +
  '<ul class="toc-content overflow" id="list-1"></ul></div><div class="backlinks"><h3>Backlinks</h3><ul id="list-2" class="overflow">' +
  "<li>No backlinks found</li></ul></div></div></div></body>";

let cls = "retired@1";
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-wiki-render": "db", "x-wiki-page-class": cls });
  res.end(`<!DOCTYPE html><html><head><title>t</title></head>${BODY}</html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const built = mkdtempSync(join(tmpdir(), "d7-built-"));

const run = () => new Promise((resolve) => {
  const c = spawn(process.execPath, [SCRIPT, "--base", `http://127.0.0.1:${server.address().port}`, "--built", built, "--urls", URL_],
    { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (d) => { out += d; });
  c.stderr.on("data", (d) => { out += d; });
  c.on("close", (code) => resolve({ code, out }));
});

let ok = true;
for (const [c, wantCode] of [["retired@1", 0], ["entity@1", 1], ["note@1", 1]]) {
  cls = c;
  const r = await run();
  const line = r.out.split("\n").find((l) => l.includes(URL_) && l.includes("built=")) || "(no summary line)";
  const verdict = (r.out.match(/PARITY: (PASS|FAIL)/) || [])[0] || "(no verdict)";
  const good = r.code === wantCode && (wantCode === 0 ? /"D7-retired":1/.test(line) : /unlisted=[1-9]/.test(line));
  if (!good) ok = false;
  console.log(`${good ? "ok  " : "BAD "} live x-wiki-page-class=${c}: exit=${r.code} (want ${wantCode}) ${verdict} :: ${line.replace(/\s+/g, " ").trim()}`);
}
server.close();
rmSync(built, { recursive: true, force: true });
console.log(ok ? "D7-SELFTEST: PASS (D7 explains a retired URL only when it is served as retired@1)" : "D7-SELFTEST: FAIL");
process.exitCode = ok ? 0 : 1;
