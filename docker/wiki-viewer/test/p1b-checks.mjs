#!/usr/bin/env node
/**
 * p1b-checks - rw-p1b-ready's in-network checks (run with the viewer image's
 * node on the env network; the runner run-p1b.sh calls each mode).
 *
 *   node p1b-checks.mjs urls  --base <url>                  acceptance 1: the fixed URL list (parity-diff-urls.mjs)
 *        each 200, x-wiki-render: db, no splash, every chrome element incl. the notifications strip,
 *        and the bundle every page references (css/js/static) answered 200
 *   node p1b-checks.mjs counts --base <url> --expect <json>   acceptance 2: the listing counts of folder / tag
 *        pages equal the counts the runner computed with SQL ({"<url>": n, ...}); the tag index's "Found N"
 *   node p1b-checks.mjs crawl --base <url> --min 200           acceptance 5: walk the explorer (/workbench/nav)
 *        from the root, then folder pages, tag pages and the bundle, until >= --min URLs; none may be the
 *        front door's error path (x-wiki-render: front-door-error) or a 5xx
 *   node p1b-checks.mjs navorder --base <url> --expect <json>  the nav order = Quartz's comparator over SQL rows
 */
import { URLS } from "./parity-diff-urls.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const MODE = process.argv[2];
const BASE = String(arg("--base", "")).replace(/\/+$/, "");
const get = async (p, opts = {}) => {
  const r = await fetch(BASE + p, { redirect: "manual", ...opts });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, h: r.headers, body: buf.toString("utf8"), buf };
};

// The chrome elements (parity-diff.mjs ELEMENTS, the same regexes) + the P1b strip.
const ELEMENTS = {
  "notifications strip": (b) => /<div class="center"><div class="wiki-notifications" data-wiki-notifications="1" data-unread="[^"]*">/.test(b),
  "explorer root": (b) => /<div class="explorer"[^>]*>/.test(b) && b.includes('class="explorer-ul overflow"'),
  "graph container": (b) => b.includes('<div class="graph-container"'),
  "backlinks list": (b) => /<div class="backlinks"><h3>Backlinks<\/h3><ul id="list-\d+" class="overflow">/.test(b),
  TOC: (b) => b.includes('<div class="toc desktop-only">') && b.includes('class="toc-content overflow"'),
  "popover anchors": (b) => b.includes('class="popover-hint"') && /<a [^>]*class="internal[^"]*"[^>]*>/.test(b),
};

let failed = false;
const bad = (m) => { failed = true; console.log("x " + m); };

if (MODE === "urls") {
  const assets = new Set();
  let n = 0;
  for (const [cls, url] of URLS) {
    const r = await get(url);
    const render = r.h.get("x-wiki-render");
    const splash = /Building the wiki|<meta http-equiv="refresh" content="6">/.test(r.body);
    let missing = [];
    if (cls !== "alias redirect") {
      missing = Object.entries(ELEMENTS).filter(([, f]) => !f(r.body)).map(([k]) => k);
      for (const m of r.body.matchAll(/(?:href|src)="((?:\.\.\/)*(?:\.\/)?(?:index\.css|prescript\.js|postscript\.js|static\/[^"]+))"/g)) {
        assets.add(new URL(m[1], BASE + url).pathname);
      }
    }
    const ok = r.status === 200 && render === "db" && !splash && missing.length === 0;
    if (!ok) bad(`${url} status=${r.status} render=${render} splash=${splash} missing=${missing.join(",") || "none"}`);
    console.log(`${r.status} x-wiki-render=${render} splash=${splash} ${cls.padEnd(16)} ${url} missing=${missing.join(",") || "none"}`);
    n++;
  }
  for (const a of [...assets].sort()) {
    const r = await get(a);
    const sha = createHash("sha256").update(r.buf).digest("hex").slice(0, 16);
    console.log(`asset ${r.status} ${a} bytes=${r.buf.length} sha256=${sha}`);
    if (r.status !== 200 || r.buf.length === 0) bad(`asset ${a} -> ${r.status}`);
  }
  console.log(`URLS: ${n} urls, ${assets.size} bundle assets`);
  console.log(failed ? "URLS: FAIL" : "URLS: PASS (every URL 200 + db + every element + the strip; every bundle asset 200)");
} else if (MODE === "counts") {
  const expect = JSON.parse(arg("--expect"));
  for (const [url, want] of Object.entries(expect)) {
    const r = await get(url);
    const body = r.body;
    let got = null;
    if (url === "/tags/" || url === "/tags") got = Number((/Found (\d+) total tags\./.exec(body) || [])[1]);
    else got = Number((/(\d+) items? (?:under this folder|with this tag)\./.exec(body) || [])[1] ?? (/1 item (?:under this folder|with this tag)\./.test(body) ? 1 : NaN));
    // the listed entries themselves (a count line that disagrees with its own list is a bug too)
    const listed = (body.match(/<li class="section-li">/g) || []).length;
    const okList = url.startsWith("/tags") && (url === "/tags/" || url === "/tags") ? true : listed === got;
    console.log(`${r.status} ${r.h.get("x-wiki-render")} ${url} page=${got} listed=${listed} sql=${want}`);
    if (r.status !== 200 || r.h.get("x-wiki-render") !== "db" || got !== want || !okList) bad(`${url}: page says ${got}, lists ${listed}, SQL says ${want}`);
  }
  console.log(failed ? "COUNTS: FAIL" : `COUNTS: PASS (${Object.keys(expect).length} folder/tag pages equal the SQL counts)`);
} else if (MODE === "crawl") {
  const MIN = Number(arg("--min", "200"));
  const seen = new Set();
  const queue = [];
  const add = (u) => { if (!seen.has(u)) { seen.add(u); queue.push(u); } };
  // the explorer's own walk (BFS over /workbench/nav), every page and folder href
  const folders = [""];
  const tags = new Set();
  while (folders.length && seen.size < MIN * 2) {
    const f = folders.shift();
    for (let off = 0; off != null;) {
      const r = await get(`/workbench/nav?folder=${encodeURIComponent(f)}&limit=500${off ? `&offset=${off}` : ""}`);
      if (r.status !== 200) { bad(`nav ${f} -> ${r.status} ${r.h.get("x-wiki-render")}`); break; }
      const j = JSON.parse(r.body);
      for (const e of j.entries) { add(e.href); if (e.folder) folders.push(e.href.replace(/^\/|\/$/g, "")); }
      off = j.next;
    }
  }
  add("/"); add("/tags/");
  for (const t of String(arg("--tags", "")).split(",").filter(Boolean)) add(`/tags/${t}`);
  for (const a of ["/index.css", "/prescript.js", "/postscript.js", "/static/icon.png"]) add(a);
  let hits = 0, n = 0, five = 0;
  const kinds = {};
  for (const u of queue) {
    const r = await get(u);
    n++;
    const k = r.h.get("x-wiki-render") || (r.h.get("content-type") || "").split(";")[0];
    kinds[k] = (kinds[k] || 0) + 1;
    if (r.h.get("x-wiki-render") === "front-door-error" || /data-wiki-error="front-door"/.test(r.body)) { hits++; bad(`front door error path: ${u} (${r.status})`); }
    if (r.status >= 500) { five++; bad(`${u} -> ${r.status}`); }
  }
  console.log(`CRAWL: ${n} URLs through the front door; kinds=${JSON.stringify(kinds)}; front-door-error hits=${hits}; 5xx=${five}`);
  if (n < MIN) bad(`only ${n} URLs (< ${MIN})`);
  console.log(failed ? "CRAWL: FAIL" : `CRAWL: PASS (${n} >= ${MIN} URLs, the Caddy handle_errors path never hit)`);
} else if (MODE === "navorder") {
  // --expect: {"<folder>": [[name, title, isFolder], ...]} from SQL (unsorted); the nav must list exactly
  // those, in Quartz Explorer's order (folders first, localeCompare numeric/base on the display name).
  const expect = JSON.parse(readFileSync(arg("--expect"), "utf8"));
  const quartz = (a, b) => (a[2] === b[2] ? a[1].localeCompare(b[1], undefined, { numeric: true, sensitivity: "base" }) : a[2] ? -1 : 1);
  for (const [folder, rows] of Object.entries(expect)) {
    const r = await get(`/workbench/nav?folder=${encodeURIComponent(folder)}&limit=2000`);
    const j = JSON.parse(r.body);
    const got = j.entries.map((e) => `${e.folder ? "D" : "F"}:${e.title}`);
    const want = [...rows].sort(quartz).map((x) => `${x[2] ? "D" : "F"}:${x[1]}`);
    const same = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${r.status} nav ${folder || "(root)"} entries=${got.length} sql=${want.length} order=${same ? "same" : "DIFFERS"}`);
    if (!same) { bad(`nav ${folder}: got ${JSON.stringify(got.slice(0, 8))} want ${JSON.stringify(want.slice(0, 8))}`); }
  }
  console.log(failed ? "NAVORDER: FAIL" : "NAVORDER: PASS");
} else if (MODE === "tagindex") {
  // the tag index (/tags/) shows, under each tag, the FIRST N of that tag's pages in Quartz's
  // PageList order (date desc, then title) - sorted, then sliced (P1a F7: the live index sliced first).
  const tag = arg("--tag");
  const want = JSON.parse(arg("--expect")); // titles, in SQL order (updated_at desc, lower(title))
  const r = await get("/tags/");
  const at = r.body.indexOf(`>${tag}</a></h2>`);
  const end = r.body.indexOf("<h2>", at + 1);
  const sec = at < 0 ? "" : r.body.slice(at, end < 0 ? undefined : end);
  const got = [...sec.matchAll(/<h3><a href="[^"]*" class="internal">([^<]*)<\/a><\/h3>/g)].map((m) => m[1]);
  const same = JSON.stringify(got) === JSON.stringify(want);
  console.log(`/tags/ "${tag}" shows ${got.length}: ${JSON.stringify(got)}`);
  console.log(`SQL first ${want.length}: ${JSON.stringify(want)}`);
  if (!same) bad(`the tag index's "${tag}" entries are not the first ${want.length} in order`);
  console.log(failed ? "TAGINDEX: FAIL" : "TAGINDEX: PASS");
} else {
  console.log("usage: p1b-checks.mjs urls|counts|crawl|navorder|tagindex ...");
  process.exit(2);
}
process.exitCode = failed ? 1 : 0;
