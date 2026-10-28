#!/usr/bin/env node
/**
 * parity-diff - rw-p1a-render acceptance 1 + 2: fetch the fixed URL list from
 * the LIVE renderer and byte-diff each rendered <body> against the page the
 * image's own Quartz builder emitted for the same synthetic fixture vault.
 *
 * Every difference must be explained by a rule ENUMERATED IN ADVANCE in the
 * test plan (test-plans/rw-p1a-render.md, "Allowed differences"); the rules
 * live in RULES below with the same ids. A difference no rule explains is
 * printed as UNLISTED and fails the run (exit 1). Acceptance 1's elements
 * (explorer root, graph container, backlinks list, TOC, popover anchors) and
 * `x-wiki-render: db` are checked on every URL too (exit 1 on a miss).
 *
 * Usage (inside wt-rw-p1a-render-net, the built snapshot mounted read-only):
 *   node parity-diff.mjs --base http://wt-rw-p1a-render-viewer:8080 --built /srv/current [--show] [--urls /a,/b]
 * --show prints every hunk, explained or not; --urls diffs only those URLs of
 * the list (a runner case that changes one page's state).
 * "alias redirect" URLs (attempt 3) are Quartz's AliasRedirects documents: the
 * WHOLE live response is compared with the whole built file, byte for byte.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg("--base", `http://${process.env.P1A_PREFIX || "wt-rw-p1a-render"}-viewer:8080`).replace(/\/+$/, "");
const BUILT = arg("--built", "/srv/current");
const SHOW = process.argv.includes("--show");
const ONLY_URLS = arg("--urls", "") ? new Set(arg("--urls", "").split(",").map((x) => x.trim()).filter(Boolean)) : null;

import { URLS } from "./parity-diff-urls.mjs";
export { URLS };

// The built FILE for a URL: Quartz writes the file under the decoded name
// (notes/adv/back\slash.html for /notes/adv/back%5Cslash; rw-p1a-deploy-prep
// attempt 2 - the attempt-1 tester's copy decoded it the same way).
function builtFile(url) {
  const p = decodeURIComponent(url).replace(/^\/+/, "");
  if (p === "") return join(BUILT, "index.html");
  if (p.endsWith("/")) return join(BUILT, p, "index.html");
  return join(BUILT, `${p}.html`);
}

const bodyOf = (html) => {
  const m = /<body[^>]*>[\s\S]*<\/body>/.exec(html);
  return m ? m[0] : "";
};
// One element boundary per line, so a diff names elements, not bytes.
const lines = (s) => s.replace(/></g, ">\n<").split("\n");

// LCS line diff -> hunks [{ del:[...], ins:[...] }].
function diff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const hunks = [];
  let i = 0, j = 0, cur = null;
  const flush = () => { if (cur) { hunks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; continue; }
    cur ??= { del: [], ins: [], at: i, bj: j };
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) cur.ins.push(b[j++]);
    else cur.del.push(a[i++]);
  }
  flush();
  return hunks;
}

const joined = (h) => h.del.join("\n") + "\n" + h.ins.join("\n");
const only = (arr, re) => arr.length > 0 && arr.every((l) => re.test(l));
const TIME = /^<time datetime="[^"]+">[A-Z][a-z]{2} \d{2}, \d{4}<\/time>$/;

// The exact shapes D3 and D4 allow (attempt 3: whole blocks, nothing more).
// `\d+` in a line stands for a list id; everything else is literal.
const reLine = (l) => l.split("\\d+").map((x) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("\\d+");
const TOC_HEAD = [
  '<div class="toc desktop-only">',
  '<button type="button" class="toc-header" aria-controls="toc-content" aria-expanded="true">',
  "<h3>Table of Contents</h3>",
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="fold">',
  '<polyline points="6 9 12 15 18 9">', "</polyline>", "</svg>", "</button>",
  '<ul class="toc-content overflow" id="list-\\d+">',
];
const TOC_ENTRY = ['<li class="depth-\\d+">', '<a href="#[^"]*" data-for="[^"]*">[^<]*</a>', "</li>"];
const TOC_TAIL = ['<li class="overflow-end">', "</li>", "</ul>", "</div>"];
const TOC_BLOCK = new RegExp(
  "^" + TOC_HEAD.map(reLine).join("\n") +
  "(?:\n" + TOC_ENTRY.map((l, i) => (i === 1 ? l : reLine(l))).join("\n") + ")*" +
  "\n" + TOC_TAIL.map(reLine).join("\n") + "$");
const isTocBlock = (t) => TOC_BLOCK.test(t);
const EMPTY_BACKLINKS = new RegExp("^" + ['<div class="backlinks">', "<h3>Backlinks</h3>", '<ul id="list-\\d+" class="overflow">',
  "<li>No backlinks found</li>", '<li class="overflow-end">', "</li>", "</ul>", "</div>"].map(reLine).join("\n") + "$");

// The ENUMERATED allowed differences (ids match the test plan).
export const RULES = [
  {
    id: "D1-raw-html",
    why: "raw HTML in a row body is dropped (render-page.mjs security property); the built page rendered it. " +
      "Allowed only when the built side carries a raw-HTML element (script/iframe/embed/object, or any element with an on* handler) " +
      "and the live TEXT equals the built text with those tags removed (an inline raw tag: its inner text stays as text) " +
      "or with those elements removed whole (a raw HTML block); AND the live side adds no markup of its own: it carries no " +
      "raw-HTML element or handler, and every live tag also appears on the built side (attempt 2, near-miss N5: a text-only " +
      "comparison would also explain a hunk whose live side KEPT the markup)",
    test: (h) => {
      const built = h.del.join("");
      const RAW = /<(script|iframe|embed|object)\b|<[a-z]+\b[^>]*\son[a-z]+=/i;
      if (!RAW.test(built)) return false;
      const liveHtml = h.ins.join("");
      if (RAW.test(liveHtml)) return false;
      const tags = (s) => s.match(/<\/?[a-z][a-z0-9-]*\b[^>]*>/gi) || [];
      const builtTags = new Set(tags(built));
      if (!tags(liveHtml).every((t) => builtTags.has(t))) return false;
      const text = (s) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      const whole = built.replace(/<(script|iframe|embed|object)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
      const live = text(liveHtml);
      return live === text(built) || live === text(whole);
    },
  },
  {
    id: "D2-date",
    why: "the presented date is the row's (frontmatter modified-keys, else updated_at); the built page used the file mtime",
    test: (h) => h.del.length === h.ins.length && h.del.every((l) => TIME.test(l)) && h.ins.every((l) => TIME.test(l)),
  },
  {
    id: "D3-toc-always",
    why: "a TOC is emitted on every page (acceptance 1); Quartz omits it below two headings. Attempt 3: EXACTLY the TOC block " +
      "(its header button, then a toc-content list of the page's own TOC entries) - the attempt-2 test accepted anything " +
      "after an opening TOC line, so a hunk that also carried the backlinks block passed as D3 alone",
    test: (h) => h.del.length === 0 && isTocBlock(h.ins.join("\n")),
  },
  {
    id: "D4-backlinks-always",
    why: "the backlinks list is emitted on every page (acceptance 1); Quartz hides it when empty. Attempt 3: EXACTLY the empty " +
      "backlinks block (a heading, one 'No backlinks found' item, the overflow end)",
    test: (h) => h.del.length === 0 && EMPTY_BACKLINKS.test(h.ins.join("\n")),
  },
  {
    id: "D3+D4",
    why: "attempt 3: a page with fewer than two headings and no backlinks gets both blocks next to each other, so the line diff " +
      "joins them into one hunk: exactly a D3 TOC block followed by exactly a D4 empty backlinks block",
    test: (h) => {
      if (h.del.length !== 0) return false;
      const t = h.ins.join("\n");
      const i = t.indexOf('\n<div class="backlinks">');
      return i > 0 && isTocBlock(t.slice(0, i)) && EMPTY_BACKLINKS.test(t.slice(i + 1));
    },
  },
  {
    id: "D9-transclude-pending",
    why: "attempt 3: a transcluded page that has no presentable row (missing, stale, empty) is the pending-compile marker inside " +
      "the transclude block, where the built page inlined the embedded file. Allowed only when the live side is exactly ONE " +
      "<p class=\"transclude-pending\" data-render-state=\"pending\">Pending compile: ...</p> line, the built side is non-empty, the " +
      "live line before the hunk opens a <blockquote class=\"transclude\"> and the live line after it is that block's " +
      "\"Link to original\" anchor",
    test: (h, ctx) => h.ins.length === 1 && h.del.length > 0 &&
      /^<p class="transclude-pending" data-render-state="pending">Pending compile: [^<]+<\/p>$/.test(h.ins[0]) &&
      String(ctx.live?.[h.bj - 1] ?? "").startsWith('<blockquote class="transclude"') &&
      /^<a href="[^"]*" class="internal transclude-src">Link to original<\/a>$/.test(String(ctx.live?.[h.bj + 1] ?? "")),
  },
  {
    id: "D7-retired",
    why: "a retired slug has no built page (the builder emitted nothing; served the generic 404); the live page is the retired-class " +
      "explanation - and ONLY that: the live response must carry x-wiki-page-class: retired@1 (rw-p1a-deploy-prep, NA4-3: any live " +
      "body used to pass, so a retired URL served from an orphan row by another class read as parity)",
    // attempt 4 (tester AT3-3): only when the builder wrote NO file at all - a
    // built redirect document (an alias claiming the slug) has no <body>, and
    // it used to read as "no built page" here
    test: (h, ctx) => ctx.cls === "retired slug" && ctx.builtFileExists === false && ctx.pageClass === "retired@1",
  },
];

// D5 is a NORMALISATION applied before the diff (one block, not a hunk
// pattern): on list-layout pages (folder index, notebooks index, tag page) the
// live right sidebar's content is set aside - it must be exactly graph + TOC +
// backlinks (acceptance 1), and the built list layout's right sidebar must be
// empty. Anything else in either sidebar stays in the diff.
const LIST_CLASSES = new Set(["folder index", "notebooks index", "tag page"]);
const SIDEBAR_RE = /<div class="right sidebar">([\s\S]*?)<\/div><footer/;
function normalizeListSidebar(live, built, ctx) {
  if (!LIST_CLASSES.has(ctx.cls)) return { live, fired: false };
  const m = SIDEBAR_RE.exec(live);
  const b = SIDEBAR_RE.exec(built);
  if (!m || !b || b[1] !== "") return { live, fired: false };
  const inner = m[1];
  const shape = /^<div class="graph">[\s\S]*<\/div><div class="toc desktop-only">[\s\S]*<\/div><div class="backlinks">[\s\S]*<\/div>$/.test(inner);
  if (!shape) return { live, fired: false };
  return { live: live.replace(SIDEBAR_RE, '<div class="right sidebar"></div><footer'), fired: true };
}
// D6 is a NORMALISATION too: in a listing (<ul class="section-ul">), entries
// are sorted by date then title; the dates differ (D2: row date vs file
// mtime), so the ORDER can differ. Both bodies' entries are put in href order
// before the diff; every entry (href, title, tags, date line) is still
// compared, so a missing, extra or altered entry stays an unlisted hunk.
const SECTION_UL = /<ul class="section-ul">([\s\S]*?)<\/ul><\/div><\/div>/g;
function sortListing(body) {
  let fired = false;
  const out = body.replace(SECTION_UL, (all, inner) => {
    const items = inner.split(/(?=<li class="section-li">)/).filter(Boolean);
    const key = (it) => (/<h3><a href="([^"]+)"/.exec(it) || [])[1] || it;
    const sorted = [...items].sort((a, b) => key(a).localeCompare(key(b)));
    if (sorted.join("") !== items.join("")) fired = true;
    return `<ul class="section-ul">${sorted.join("")}</ul></div></div>`;
  });
  return { body: out, fired };
}
// D8 is a NORMALISATION of the BUILT body (attempt 2, finding F-T1): the live
// renderer refuses javascript:/vbscript:/data: URLs (a data:image/<raster>
// src excepted) - an unsafe link is its text, an unsafe image its alt text.
// The built page still carries them, so the built body has exactly that
// transformation applied before the diff; anything else stays in the diff. A
// LIVE body that carries an unsafe URL fails outright (unsafeLive below).
const UNSAFE = String.raw`\s*(?:javascript|vbscript|data):`;
const UNSAFE_A = new RegExp(String.raw`<a href="${UNSAFE}[^"]*"[^>]*>([\s\S]*?)<\/a>`, "gi");
const UNSAFE_IMG = new RegExp(String.raw`<img [^>]*?src="(?!data:image\/(?:png|gif|jpe?g|webp|avif)[;,])${UNSAFE}[^"]*"[^>]*>`, "gi");
const EXT_ICON = /<svg [^>]*class="external-icon"[^>]*>[\s\S]*?<\/svg>/gi;
function refuseUnsafeBuilt(body) {
  let fired = 0;
  const out = body
    .replace(UNSAFE_A, (_all, inner) => { fired++; return inner.replace(EXT_ICON, ""); })
    .replace(UNSAFE_IMG, (all) => { fired++; return (/\salt="([^"]*)"/.exec(all) || [])[1] || ""; });
  return { body: out, fired };
}
const unsafeLive = (body) => new RegExp(String.raw`\s(?:href|src|poster|cite|action|formaction|data)="${UNSAFE}`, "i").test(body);
RULES.push({ id: "D8-unsafe-url", why: "the live page refuses javascript:/vbscript:/data: URLs (a link becomes its text, an image its alt text); the built page kept them (pre-diff normalisation of the built body; a live unsafe URL fails)", test: () => false });
RULES.push({ id: "D6-listing-order", why: "listing entries are compared in href order: the live order follows the row dates, the built order the file mtimes (pre-diff normalisation; entries themselves still diffed)", test: () => false });
RULES.push({ id: "D5-list-sidebar", why: "list pages carry graph + TOC + backlinks in the right sidebar (acceptance 1); Quartz's list layout leaves it empty (pre-diff normalisation)", test: () => false });
// D11 retired (rw-p2b-workspace): the P1b notifications strip left every page - the workspace's title
// bar bell replaced it (D13) - so nothing is normalised away and a live page carrying one fails below.

function explain(h, ctx) {
  for (const r of RULES) if (r.test(h, ctx)) return r.id;
  return null;
}


// D10 (attempt 3; whole-document comparison of an alias redirect page): the
// live page escapes & < > " inside the three slug interpolations, Quartz does
// not. Allowed only when un-escaping the live document gives the built one
// exactly (no fixture slug carries those characters, so it does not fire).
RULES.push({ id: "D10-alias-escape", why: "an alias redirect page escapes & < > \" in its slug values (Quartz interpolates them raw); un-escaped, the two documents are identical", test: () => false });
const unescapeHtml = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const ELEMENTS = {
  "NO notifications strip": (b) => !/wiki-notifications/.test(b),
  "explorer root": (b) => /<div class="explorer"[^>]*>/.test(b) && b.includes('class="explorer-ul overflow"'),
  "graph container": (b) => b.includes('<div class="graph-container"'),
  "backlinks list": (b) => /<div class="backlinks"><h3>Backlinks<\/h3><ul id="list-\d+" class="overflow">/.test(b),
  TOC: (b) => b.includes('<div class="toc desktop-only">') && b.includes('class="toc-content overflow"'),
  "popover anchors": (b) => b.includes('class="popover-hint"') && /<a [^>]*class="internal[^"]*"[^>]*>/.test(b),
};

let failed = false;
const summary = [];
for (const [cls, url] of URLS) {
  if (ONLY_URLS && !ONLY_URLS.has(url)) continue;
  const r = await fetch(BASE + url, { redirect: "manual" });
  const html = await r.text();
  const render = r.headers.get("x-wiki-render");
  if (cls === "alias redirect") {
    // the whole document, byte for byte (no chrome: it is a redirect page)
    const bf = builtFile(url);
    const built = existsSync(bf) ? readFileSync(bf, "utf8") : "";
    const fired = {};
    let unlisted = 0;
    if (r.status !== 200 || render !== "db") failed = true;
    if (!built || html !== built) {
      if (built && unescapeHtml(html) === built) fired["D10-alias-escape"] = 1;
      else {
        unlisted = 1;
        failed = true;
        console.log(`--- ${url} [UNLISTED] (whole document)`);
        for (const l of lines(built)) console.log(`  - ${l.slice(0, 220)}`);
        for (const l of lines(html)) console.log(`  + ${l.slice(0, 220)}`);
      }
    }
    summary.push(`${String(r.status)} x-wiki-render=${render} ${cls.padEnd(16)} ${url.padEnd(56)} ` +
      `built=${built ? "yes" : "NO"} hunks=${html === built ? 0 : 1} unlisted=${unlisted} rules=${JSON.stringify(fired)} missing=none (whole document ${html === built ? "identical" : "differs"})`);
    continue;
  }
  const liveRaw = bodyOf(html);
  const missing = Object.entries(ELEMENTS).filter(([, f]) => !f(liveRaw)).map(([k]) => k);
  const live = liveRaw;
  if (render !== "db") failed = true;
  if (missing.length) failed = true;
  const bf = builtFile(url);
  const built = existsSync(bf) ? bodyOf(readFileSync(bf, "utf8")) : "";
  const pageClass = r.headers.get("x-wiki-page-class");
  const ctx = { cls, url, builtFileExists: existsSync(bf), pageClass };
  const fired = {};
  const norm = normalizeListSidebar(live, built, ctx);
  if (norm.fired) fired["D5-list-sidebar"] = 1;
  const safeBuilt = refuseUnsafeBuilt(built);
  if (safeBuilt.fired) fired["D8-unsafe-url"] = safeBuilt.fired;
  if (unsafeLive(live)) { failed = true; missing.push("NO unsafe URL (live carries one)"); }
  const sb = sortListing(safeBuilt.body), sl = sortListing(norm.live);
  if (sb.fired || sl.fired) fired["D6-listing-order"] = 1;
  const liveLines = lines(sl.body);
  ctx.live = liveLines;
  const hunks = cls === "retired slug" && !ctx.builtFileExists ? [{ del: [], ins: lines(live) }] : diff(lines(sb.body), liveLines);
  const unlisted = [];
  for (const h of hunks) {
    const id = explain(h, ctx);
    if (id) fired[id] = (fired[id] || 0) + 1;
    else unlisted.push(h);
    if (SHOW || !id) {
      console.log(`--- ${url} ${id ? `[${id}]` : "[UNLISTED]"}`);
      for (const l of h.del) console.log(`  - ${l.slice(0, 220)}`);
      for (const l of h.ins) console.log(`  + ${l.slice(0, 220)}`);
    }
  }
  if (unlisted.length) failed = true;
  summary.push(`${String(r.status)} x-wiki-render=${render} ${cls.padEnd(16)} ${url.padEnd(56)} ` +
    `built=${built ? "yes" : "NO"} hunks=${hunks.length} unlisted=${unlisted.length} ` +
    `rules=${JSON.stringify(fired)} missing=${missing.length ? missing.join(",") : "none"} class=${pageClass}`);
}
console.log("\n== parity summary ==");
for (const l of summary) console.log(l);
console.log(failed ? "PARITY: FAIL" : "PARITY: PASS (every difference enumerated; every element present; every URL x-wiki-render: db)");
process.exitCode = failed ? 1 : 0;
