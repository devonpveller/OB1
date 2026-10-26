/**
 * chrome - the document a built Quartz page is (quartz/components/renderPage.tsx,
 * MIT, (c) jackyzha0), assembled from a page model instead of a build:
 *
 *   <head>  title, fonts, social/meta, the bundle's css + head scripts
 *   <body data-slug>
 *     #quartz-root.page > #quartz-body
 *       .left.sidebar     page title, search, dark/reader mode, explorer
 *       .center           .page-header > .popover-hint (breadcrumbs, title,
 *                         meta, tags | list: + notes editor), the article (or
 *                         the listing), <hr/>, .page-footer (overlay cards)
 *       .right.sidebar    graph, TOC, backlinks, upload modal, notes editor
 *       footer
 *   the bundle's after-body scripts (postscript.js hydrates explorer, graph,
 *   search, popovers, the ONE editor, every overlay card)
 *
 * Two layouts, as quartz.layout.ts declares them: "content" and "list"
 * (folder/tag). The list layout additionally carries the graph, TOC and
 * backlinks in its right sidebar - Quartz leaves it empty; acceptance 1 of
 * rw-p1a-render asks for them on every URL (enumerated parity difference).
 */
import {
  LEFT_SIDEBAR, LEFT_SIDEBAR_LIST, LIST_LAYOUT_EXPLORER_ID, HEAD_FONTS, HEAD_RESOURCES, TAIL_SCRIPTS,
} from "./chrome-static.mjs";
import {
  html, Breadcrumbs, ArticleTitle, ContentMeta, TagList, TableOfContents, Backlinks, Graph, Footer,
  AfterBody, UploadModal, NotesEditor,
} from "./components.mjs";
import { pathToRoot, joinSegments } from "./quartz-path.mjs";

// Quartz renders its chrome with preact-render-to-string, whose encodeEntities
// escapes & < " - and NOT > - in text and attribute values alike (6.5.13 in the
// image, measured 2026-10-18: <title>a&quot;b>c&lt;d&amp;e</title>). The same
// rule here, so a slug or title with ">" is byte-identical to the built page
// (rw-p1a-deploy-prep attempt 2, tester N1: data-slug="notes/adv/lt&lt;gt>").
const escText = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const escAttr = escText;
const unescapeHTML = (s) => String(s ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'");

const BASE_URL = "quartz.jzhao.xyz"; // quartz.config.ts baseUrl (as built)

function head(page) {
  const root = pathToRoot(page.slug);
  const title = page.title || "Untitled";
  const description = page.fm.socialDescription ?? page.fm.description ?? unescapeHTML(page.description?.trim() || "No description provided");
  const og = `https://${BASE_URL}/static/og-image.png`;
  const socialUrl = joinSegments(`https://${BASE_URL}/`, page.slug);
  return `<head><title>${escText(title)}</title><meta charset="utf-8"/>${HEAD_FONTS}` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0"/>` +
    `<meta name="og:site_name" content="Quartz 4"/><meta property="og:title" content="${escAttr(title)}"/>` +
    `<meta property="og:type" content="website"/><meta name="twitter:card" content="summary_large_image"/>` +
    `<meta name="twitter:title" content="${escAttr(title)}"/><meta name="twitter:description" content="${escAttr(description)}"/>` +
    `<meta property="og:description" content="${escAttr(description)}"/><meta property="og:image:alt" content="${escAttr(description)}"/>` +
    `<meta property="og:image" content="${og}"/><meta property="og:image:url" content="${og}"/><meta name="twitter:image" content="${og}"/>` +
    `<meta property="og:image:type" content="image/.png"/><meta property="twitter:domain" content="${BASE_URL}"/>` +
    `<meta property="og:url" content="${escAttr(socialUrl)}"/><meta property="twitter:url" content="${escAttr(socialUrl)}"/>` +
    `<link rel="icon" href="${escAttr(joinSegments(root, "static/icon.png"))}"/><meta name="description" content="${escAttr(description)}"/>` +
    `<meta name="generator" content="Quartz"/>` + HEAD_RESOURCES.split("@@ROOT@@").join(root) + `</head>`;
}

/**
 * page: {
 *   slug, title, fm, tags, text, description, readingMinutes, date, toc,
 *   site, layout: "content"|"list", articleHtml, listingHtml (list layout),
 *   breadcrumbsKnown, cssclasses,
 *   notificationsHtml (P1b: the notifications strip, lib/notifications.mjs)
 * }
 * Returns the full HTML document.
 */
export function renderDocument(page) {
  const root = pathToRoot(page.slug);
  const list = page.layout === "list";
  const left = (list ? LEFT_SIDEBAR_LIST : LEFT_SIDEBAR)
    .replace("@@ROOT@@", root)
    .replace("@@LIST@@", list ? LIST_LAYOUT_EXPLORER_ID : "list-0");
  const before = [
    page.slug !== "index" || list ? html(Breadcrumbs(page)) : "",
    html(ArticleTitle(page)),
    html(ContentMeta(page)),
    list ? NotesEditor(page) : html(TagList(page)),
  ].join("");
  const center = list
    ? page.listingHtml
    : `<article class="${escAttr(["popover-hint", ...(page.cssclasses || [])].join(" "))}">${page.articleHtml || ""}</article>`;
  // Overflow-list ids follow Quartz's component construction order:
  // content layout explorer list-0, TOC list-1, backlinks list-2; the list
  // layout's own explorer is LIST_LAYOUT_EXPLORER_ID, and the TOC/backlinks it
  // carries here reuse the content layout's ids (they are the same components).
  const right = [
    Graph(),
    TableOfContents(page, "list-1"),
    Backlinks(page, "list-2"),
    list ? "" : UploadModal(page),
    list ? "" : NotesEditor(page),
  ].join("");
  const lang = page.fm.lang ?? "en";
  return "<!DOCTYPE html>\n" +
    `<html lang="${escAttr(lang)}">${head(page)}<body data-slug="${escAttr(page.slug)}">` +
    `<div id="quartz-root" class="page"><div id="quartz-body">${left}` +
    // P1b (D13 item 7): the research notifications strip, server-rendered
    // (lib/notifications.mjs) - first in the center column of every page.
    `<div class="center">${page.notificationsHtml || ""}<div class="page-header"><div class="popover-hint">${before}</div></div>` +
    `${center}<hr/><div class="page-footer">${AfterBody(page)}</div></div>` +
    `<div class="right sidebar">${right}</div>${Footer()}</div></div></body>` +
    TAIL_SCRIPTS.split("@@ROOT@@").join(root) + `</html>`;
}

// ── the two D13 screens that are NOT pages ──────────────────────────────────
// Same visual shape as the existing planned/not-available mini pages (themed,
// self-contained, no bundle, no identity attributes).
const mini = (badge, heading, bodyHtml, refreshSeconds, attr) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}<title>${escText(badge)}</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;
font-family:system-ui,-apple-system,sans-serif;background:#1e1e24;color:#d4d4dc}
.box{text-align:center;max-width:34rem;padding:2rem}
.badge{display:inline-block;padding:.15rem .6rem;border:1px solid #44454f;border-radius:1rem;
font-size:.75rem;color:#9a9ba6;margin-bottom:1rem}
h1{font-size:1.15rem;font-weight:600;margin:0 0 .5rem}
p{font-size:.9rem;color:#9a9ba6;margin:.3rem 0;line-height:1.55}
a{color:#84a9ff;text-decoration:none}</style>
</head><body ${attr}><div class="box"><div class="badge">${escText(badge)}</div><h1>${heading}</h1>
${bodyHtml}<p><a href="/">← Knowledge Vault home</a></p></div></body></html>`;

// D13 items 3 + 5: no row - or a row that is not presentable as-is (stale,
// future-dated, empty) - is the typed pending-compile state, never an empty
// leaf and never a render of the file.
export function pendingDocument({ slug, reason }) {
  const name = escText(String(slug || "").split("/").pop() || "This page");
  return mini("Pending compile", `${name} is waiting for its compile`,
    `<p>This page is known (${escText(reason)}) but has no presentable compiled row, so there is nothing to present.</p>
<p>It appears here as soon as the compile that owns it writes its row. If a compile failed on it, the failure is in the research notifications.</p>`,
    15, `data-render-state="pending" data-slug="${escAttr(slug)}"`);
}

// D13 item 3: database unreachable is ONE front-end screen, never a page state.
export function databaseDocument(state) {
  const connecting = state === "connecting";
  return mini(connecting ? "connecting to database" : "database unreachable",
    connecting ? "Connecting to the database…" : "The database is unreachable",
    connecting
      ? "<p>The wiki is reconnecting to Open Brain. This screen refreshes on its own and the page you asked for appears once the connection is up.</p>"
      : "<p>The wiki cannot reach Open Brain's database, so no page can be presented. This screen refreshes on its own; the operator's health checks report the outage.</p>",
    connecting ? 3 : 10, `data-render-state="${connecting ? "connecting" : "unreachable"}"`);
}

// A renderer bug (a page-class entry or the route itself threw). Its own
// state, never shown as a database condition; the health probe names it.
export function errorDocument({ slug }) {
  const name = escText(String(slug || "").split("/").pop() || "This page");
  return mini("render error", `${name} could not be rendered`,
    "<p>The wiki renderer failed on this page. This is a bug in the viewer, not a database or compile condition; the viewer's health probe reports it.</p>",
    30, `data-render-state="error" data-slug="${escAttr(slug)}"`);
}

export function notAvailableDocument({ slug }) {
  const name = escText(String(slug || "").split("/").pop() || "This page");
  return mini("Not in the knowledge base", name,
    `<p><strong>${name}</strong> isn't in the knowledge base. Nothing is broken — there is simply nothing to show.</p>`,
    0, `data-render-state="not-available" data-not-available="1"`);
}
