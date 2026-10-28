#!/usr/bin/env node
/**
 * p1c-checks - rw-p1c-retire's in-network checks (run with the viewer image's
 * node on the env network by run-p1c.sh).
 *
 *   node p1c-checks.mjs ready  --base <url> --started <ISO> [--budget 10] [--timeout 120]
 *        acceptance 3: poll until EVERY URL of the fixed list (parity-diff-urls.mjs) answers
 *        200 x-wiki-render: db, then print the seconds since the container's StartedAt;
 *        PASS only within --budget seconds (a builder / splash wait FAILS)
 *   node p1c-checks.mjs bundle --base <url> --manifest <bundle.sha256>
 *        acceptance 4/7: every frozen bundle file (bundle/<p> served at /<p>) answers 200 with
 *        the sha256 the committed manifest records; a difference FAILS
 *   node p1c-checks.mjs first  --base <url> [--path /]
 *        the first page's wall time (the cold site-index wait, r-p1b review A)
 */
import { URLS } from "./parity-diff-urls.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const MODE = process.argv[2];
const BASE = String(arg("--base", "")).replace(/\/+$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => {
  const r = await fetch(BASE + p, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, h: r.headers, buf };
};
const urlOf = (e) => (Array.isArray(e) ? e[1] : e.url || e);

if (MODE === "ready") {
  const started = Date.parse(arg("--started", ""));
  const budget = Number(arg("--budget", "10"));
  const until = Date.now() + Number(arg("--timeout", "120")) * 1000;
  if (!Number.isFinite(started)) { console.log("READY: FAIL (no --started)"); process.exit(2); }
  const urls = URLS.map(urlOf);
  let last = "";
  for (;;) {
    const bad = [];
    for (const u of urls) {
      try {
        const r = await get(u);
        if (r.status !== 200 || r.h.get("x-wiki-render") !== "db") bad.push(`${r.status} ${r.h.get("x-wiki-render")} ${u}`);
      } catch (e) { bad.push(`ERR ${e?.cause?.code || e?.message} ${u}`); }
      if (bad.length) break;
    }
    const t = (Date.now() - started) / 1000;
    if (!bad.length) {
      console.log(`all ${urls.length} URLs 200 db at ${t.toFixed(1)} s after container start (budget ${budget} s)`);
      console.log(t <= budget ? "READY: PASS" : "READY: FAIL (over budget)");
      process.exit(t <= budget ? 0 : 1);
    }
    if (bad[0] !== last) { console.log(`  t=${t.toFixed(1)}s not yet: ${bad[0]}`); last = bad[0]; }
    if (Date.now() > until) { console.log(`READY: FAIL (not serving after ${t.toFixed(1)} s: ${bad[0]})`); process.exit(1); }
    await sleep(250);
  }
} else if (MODE === "bundle") {
  const lines = readFileSync(arg("--manifest", ""), "utf8").split("\n").filter(Boolean);
  let bad = 0, n = 0;
  for (const l of lines) {
    const [sha, rel] = l.split(/\s+\*?/);
    if (!rel.startsWith("bundle/")) continue;
    n++;
    const u = "/" + rel.slice("bundle/".length);
    const r = await get(u);
    const got = createHash("sha256").update(r.buf).digest("hex");
    const ok = r.status === 200 && got === sha;
    if (!ok) bad++;
    console.log(`${ok ? "ok " : "BAD"} ${r.status} ${u} served=${got.slice(0, 16)} committed=${sha.slice(0, 16)}`);
  }
  console.log(bad || !n ? `BUNDLE: FAIL (${bad} of ${n} differ)` : `BUNDLE: PASS (${n} files: served sha256 = committed bundle.sha256)`);
  process.exit(bad || !n ? 1 : 0);
} else if (MODE === "first") {
  const p = arg("--path", "/");
  const t0 = Date.now();
  const r = await get(p);
  console.log(`first ${p}: ${r.status} ${r.h.get("x-wiki-render")} in ${((Date.now() - t0) / 1000).toFixed(2)} s`);
} else {
  console.log("usage: p1c-checks.mjs ready|bundle|first ...");
  process.exit(2);
}
