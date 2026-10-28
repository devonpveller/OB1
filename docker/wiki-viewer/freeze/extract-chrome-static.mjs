#!/usr/bin/env node
/**
 * extract-chrome-static - cut the STATIC chrome fragments out of two pages
 * the freeze tool's Quartz emitted for the committed synthetic fixture vault,
 * and print lib/chrome-static.mjs (run by freeze/Dockerfile; the output is a
 * COMMITTED, frozen asset since research-workbench P1c). Fails on a missing
 * anchor so a Quartz change that moves one fails the freeze.
 *   node extract-chrome-static.mjs <built content page> <built folder page> > lib/chrome-static.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
// argv[2]: a built CONTENT page (the fixture entity page); argv[3]: a built
// FOLDER page (list layout: no reader-mode button, its own explorer list id).
const html = readFileSync(process.argv[2], "utf8");
const listHtml = readFileSync(process.argv[3], "utf8");
const cut = (a, b) => { const i = html.indexOf(a); const j = html.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error("anchor " + a); return html.slice(i, j); };
let left = cut('<div class="left sidebar">', '<div class="center">');
if (!left.includes('<a href="../..">Quartz 4</a>') || !left.includes('id="list-0"')) throw new Error("left anchors");
const li = listHtml.indexOf('<div class="left sidebar">');
const lj = listHtml.indexOf('<div class="center">', li);
const leftList = listHtml.slice(li, lj);
const listId = (leftList.match(/id="(list-\d+)"/) || [])[1];
if (li < 0 || lj < 0 || !listId || !leftList.includes('<a href="../..">Quartz 4</a>')) throw new Error("list left anchors");
const graph = cut('<div class="graph">', '<div class="toc desktop-only">');
let upload = cut('<div class="upload-modal-root " data-upload-root="true" data-notebook-id>', '<div class="notes-editor-root');
upload = upload.slice('<div class="upload-modal-root " data-upload-root="true" data-notebook-id>'.length);
let grounding = cut('<div class="grounding-panel " data-grounding-panel="true" data-entity-id="901">', '<div class="revision-history');
grounding = grounding.slice('<div class="grounding-panel " data-grounding-panel="true" data-entity-id="901">'.length);
const tocHead = cut('<button type="button" class="toc-header"', '<ul class="toc-content');
const R = "../../";
const headRes = cut('<link href="../../index.css"', '</head>');
const tail = cut('</body>', '</html>').slice('</body>'.length);
const fontsEtc = cut('<link rel="preconnect" href="https://fonts.googleapis.com"/>', '<meta name="viewport"');
const root = (s) => s.split(R).join("@@ROOT@@/");
const js = (s) => JSON.stringify(s);
const out = `/**
 * chrome-static - the STATIC fragments of a built Quartz 4.5.1 page (left
 * sidebar: page title, search, dark/reader mode, explorer shell; the graph
 * shell; the upload-modal and grounding-panel bodies; the TOC header).
 *
 * FROZEN (research-workbench P1c, D7): emitted ONCE by freeze/extract-chrome-static.mjs from a page the
 * freeze tool's Quartz emitted for the synthetic fixture vault (no live content), and committed.
 * These are byte-for-byte what Quartz's components (MIT, (c) jackyzha0;
 * THIRD-PARTY-NOTICES.md) and this repo's overlay components render with the
 * configuration in this image; the client bundle (postscript.js) hydrates
 * them exactly as it hydrates a built page. Never hand-edited: re-emit it
 * with the bundle (freeze/freeze.sh bundle; its sha256 is in bundle.sha256).
 * Placeholders: @@ROOT@@ (pathToRoot of the page), @@LIST@@ (overflow-list id).
 * Fails (non-zero) when an anchor it cuts on is missing, so a Quartz change
 * that moves one fails the freeze instead of shipping wrong chrome.
 */
export const LEFT_SIDEBAR = ${js(left.replace('<a href="../..">Quartz 4</a>', '<a href="@@ROOT@@">Quartz 4</a>').replace('id="list-0"', 'id="@@LIST@@"'))};
export const LEFT_SIDEBAR_LIST = ${js(leftList.replace('<a href="../..">Quartz 4</a>', '<a href="@@ROOT@@">Quartz 4</a>').replace(`id="${listId}"`, 'id="@@LIST@@"'))};
export const LIST_LAYOUT_EXPLORER_ID = ${js(listId)};
export const GRAPH = ${js(graph)};
export const TOC_HEADER = ${js(tocHead)};
export const HEAD_FONTS = ${js(fontsEtc)};
export const HEAD_RESOURCES = ${js(root(headRes))};
export const TAIL_SCRIPTS = ${js(root(tail))};
export const UPLOAD_MODAL_BODY = ${js(upload)};
export const GROUNDING_PANEL_BODY = ${js(grounding)};
`;
process.stdout.write(out);
