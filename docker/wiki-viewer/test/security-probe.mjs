#!/usr/bin/env node
/**
 * security-probe - rw-p1a-render acceptance 9 + finding F-T1 (attempt 2): the
 * attempt-1 tester's injection probe (test/fixtures/security/injection-probe.md)
 * seeded as three rows (a source, an entity, a note) with hostile values in
 * the title, tags and frontmatter too, then every page that presents them is
 * fetched from the LIVE viewer and PARSED (hast-util-from-html, as a browser
 * would - a regex also matches inside escaped attribute values):
 *   - no element carries an on* handler attribute
 *   - no <script>, <object>, <embed> element; an <iframe> only with a
 *     relative or http(s) src (the PDF-embed shape)
 *   - no URL attribute (href, src, ...) with a javascript:/vbscript:/data:
 *     scheme (a data:image/<raster> src excepted)
 * Each row gets its FILE in the vault first (rw-p1a-deploy-prep, NA4-2: a
 * row without a file is an orphan and never presented - the probe must hit
 * presented pages, so it also requires x-wiki-render: db on the three row
 * URLs); rows and files are removed again at the end.
 * Runs inside the viewer image on the env's network: p1a-env.sh node ...
 * Exit 1 on any hit, 2 if the probe could not run.
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const { fromHtml } = await import("/quartz/node_modules/hast-util-from-html/index.js");
const { visit } = await import("/quartz/node_modules/unist-util-visit/index.js");

if (!/^wt-/.test(process.env.P1A_DISPOSABLE || "")) { console.error("refusing: not the disposable env"); process.exit(2); }
const OB = (process.env.OPEN_BRAIN_URL || "").replace(/\/+$/, "");
const BASE = (process.env.P1A_BASE || "").replace(/\/+$/, "");
const body = readFileSync("/ob1/docker/wiki-viewer/test/fixtures/security/injection-probe.md", "utf8").replace(/^# .*\n/, "");
const HOSTILE = '"><img src=x onerror=alert(201)>';
const VAULT = process.env.WIKI_GIT_DIR || "/wiki";
const SLUGS = ["content/source/00000000-0000-4000-8000-000000000003", "content/person/person-probe-fixture", "notes/probe-note"];
for (const s of SLUGS) {
  mkdirSync(dirname(`${VAULT}/${s}.md`), { recursive: true });
  writeFileSync(`${VAULT}/${s}.md`, `# Probe\n\n${body}`);
}
await new Promise((res) => setTimeout(res, 50));
const rows = [
  { slug: "content/source/00000000-0000-4000-8000-000000000003", page_class: "source", entity_type: null },
  { slug: "content/person/person-probe-fixture", page_class: "entity", entity_type: "person" },
  { slug: "notes/probe-note", page_class: "note", entity_type: null },
].map((r) => ({
  ...r,
  title: `Probe ${HOSTILE}`,
  body: `# Probe\n\n${body}`,
  tags: ["probe", "<svg onload=alert(202)>"],
  links: [],
  frontmatter: {
    title: `Probe ${HOSTILE}`, description: "<script>alert(203)</script>", socialDescription: HOSTILE,
    cssclasses: 'x" onmouseover="alert(204)', lang: '"><script>alert(205)</script>', entity_id: HOSTILE,
    thread_id: HOSTILE, id: HOSTILE, aliases: [HOSTILE], type: "source",
  },
  updated_at: new Date().toISOString(),
}));
const rest = (method, path, payload) => fetch(`${OB}/rest/v1/${path}`, {
  method, headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" },
  body: payload === undefined ? undefined : JSON.stringify(payload),
});
let r = await rest("POST", "wiki_pages?on_conflict=slug", rows);
if (!r.ok) { console.error(`[probe] seeding failed: ${r.status} ${await r.text()}`); process.exit(2); }
await new Promise((res) => setTimeout(res, Number(process.env.P1A_NAV_WAIT_MS || "6000"))); // nav index refresh

const URLS = [...rows.map((x) => `/${x.slug}`), "/tags/probe", "/tags/", "/content/person/", "/notes/"];
const UNSAFE = /^(?:javascript|vbscript|data):/i;
const RASTER = /^data:image\/(?:png|gif|jpe?g|webp|avif)[;,]/i;
const URL_KEYS = ["href", "src", "poster", "cite", "action", "formAction", "xLinkHref", "data", "background", "srcSet"];
// The chrome's scripts, from two fixture pages that carry no probe content.
const scriptSig = (n) => String(n.properties?.src || "") || String(n.children?.map((c) => c.value || "").join("") || "");
const baseline = new Set();
for (const u of ["/content/thought/9001", "/tags/fixture-tag"]) {
  visit(fromHtml(await (await fetch(BASE + u)).text()), "element", (n) => { if (n.tagName === "script") baseline.add(scriptSig(n)); });
}
let hits = 0;
let notDb = 0;
for (const u of URLS) {
  const res = await fetch(BASE + u, { redirect: "manual" });
  if (SLUGS.includes(u.slice(1)) && res.headers.get("x-wiki-render") !== "db") notDb++;
  const html = await res.text();
  const found = [];
  visit(fromHtml(html), "element", (n) => {
    if (["object", "embed"].includes(n.tagName)) found.push(`<${n.tagName}>`);
    // The chrome's own scripts are on every page; anything else is injected.
    if (n.tagName === "script" && !baseline.has(scriptSig(n))) found.push(`<script> ${scriptSig(n).slice(0, 80)}`);
    for (const [k, v] of Object.entries(n.properties || {})) {
      if (/^on/i.test(k)) found.push(`${n.tagName}.${k}`);
      if (URL_KEYS.includes(k)) {
        const val = String(Array.isArray(v) ? v.join(" ") : v).replace(/[\x00-\x20]/g, "");
        if (UNSAFE.test(val) && !(n.tagName === "img" && k === "src" && RASTER.test(val))) found.push(`${n.tagName}.${k}=${val.slice(0, 80)}`);
      }
    }
    if (n.tagName === "iframe") {
      const src = String(n.properties?.src || "");
      if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^https?:/i.test(src)) found.push(`iframe.src=${src}`);
    }
  });
  hits += found.length;
  console.log(`${found.length ? "HIT " : "ok  "} ${res.status} x-wiki-render=${res.headers.get("x-wiki-render")} ${u}${found.length ? ` :: ${found.join(" | ")}` : ""}`);
}
r = await rest("DELETE", `wiki_pages?slug=in.(${rows.map((x) => `"${x.slug}"`).join(",")})`);
console.log(`[probe] rows removed: ${r.status}`);
for (const s of SLUGS) rmSync(`${VAULT}/${s}.md`, { force: true });
console.log(`[probe] files removed: ${SLUGS.length}`);
if (notDb) console.log(`SECURITY-PROBE: FAIL (${notDb} probe page(s) not presented as x-wiki-render: db - nothing was probed there)`);
else console.log(hits ? `SECURITY-PROBE: FAIL (${hits} hit(s))` : `SECURITY-PROBE: PASS (${URLS.length} pages parsed; no handler, no script, no unsafe URL)`);
process.exitCode = hits || notDb ? 1 : 0;
