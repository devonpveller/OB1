#!/usr/bin/env node
/**
 * outage-probe - rw-p1a-render acceptance 6 helper (runs inside
 * wt-rw-p1a-render-net). Two modes:
 *   sweep  GET every URL of the fixed list once + /__health; print one line per
 *          URL (status, x-wiki-render, data-render-state) and the health JSON.
 *   watch  poll one URL every 200 ms for --seconds and print every CHANGE of
 *          (status, x-wiki-render) with a timestamp - run it while the
 *          database is being started to see "connecting" before "db".
 * Exit 1 (sweep) when any URL shows a page state other than the expected
 * --expect value(s) (comma-separated x-wiki-render values), a 5xx, or a blank
 * body.
 */
import { URLS } from "./parity-diff-urls.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg("--base", "http://wt-rw-p1a-render-viewer:8080").replace(/\/+$/, "");
const mode = process.argv[2];

async function get(path) {
  try {
    const r = await fetch(BASE + path, { redirect: "manual", signal: AbortSignal.timeout(8000) });
    const t = await r.text();
    return { status: r.status, render: r.headers.get("x-wiki-render"), cc: r.headers.get("cache-control"), state: (/data-render-state="([a-z-]+)"/.exec(t) || [])[1] || null, bytes: t.length, body: t };
  } catch (e) {
    return { status: 0, render: null, state: null, bytes: 0, error: e?.message };
  }
}

if (mode === "sweep") {
  const expect = new Set(String(arg("--expect", "unreachable")).split(","));
  let bad = 0;
  for (const [cls, url] of URLS) {
    const r = await get(url);
    const ok = r.status === 200 && expect.has(r.render) && r.bytes > 200 && r.state === r.render;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "BAD "} ${r.status} x-wiki-render=${r.render} state=${r.state} cache-control=${r.cc} bytes=${r.bytes} ${cls} ${url}`);
  }
  const h = await fetch(BASE + "/__health").then(async (r) => `${r.status} ${await r.text()}`).catch((e) => `ERR ${e.message}`);
  console.log(`health: ${h}`);
  console.log(bad ? `SWEEP: ${bad} URL(s) not showing ${[...expect].join("|")}` : `SWEEP: all ${URLS.length} URLs show ${[...expect].join("|")}`);
  process.exitCode = bad ? 1 : 0;
} else if (mode === "watch") {
  const url = arg("--url", "/content/thought/9002");
  const until = Date.now() + Number(arg("--seconds", "40")) * 1000;
  let last = "";
  const seen = [];
  while (Date.now() < until) {
    const r = await get(url);
    const k = `${r.status} ${r.render}`;
    if (k !== last) {
      console.log(`${new Date().toISOString()} ${k}${r.error ? ` (${r.error})` : ""}`);
      seen.push(r.render);
      last = k;
    }
    if (r.render === "db" && seen.includes("connecting")) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  console.log(`WATCH: sequence ${seen.join(" -> ")}`);
} else {
  console.error("usage: outage-probe.mjs sweep [--expect unreachable] | watch [--url /x] [--seconds 40]");
  process.exitCode = 2;
}
