/**
 * components - server-side JSX (preact `h` + preact-render-to-string, the same
 * renderer and version Quartz uses, so attribute and whitespace serialisation
 * is byte-identical) for every component a built page carries that is not a
 * static fragment (chrome-static.mjs).
 *
 * Quartz components ported (MIT, (c) jackyzha0; THIRD-PARTY-NOTICES.md):
 * Breadcrumbs, ArticleTitle, ContentMeta + Date, TagList, TableOfContents,
 * Backlinks, PageList, FolderContent, TagContent, Footer.
 * This repo's overlay components ported from quartz-overlay/ (same contract,
 * same self-gating on the page's frontmatter + slug - the components are
 * data-driven, the renderer never asks which page class it is drawing):
 * PageTools, NotebookPage, NotebookIndex, ImportStatus, GroundingPanel,
 * SourceEditor, SourceLinker, SourceRetractor, NoteReferences,
 * RevisionHistory, UploadModal, NotesEditor.
 *
 * ONE-editor contract (viewer README invariant 4): NotesEditor and
 * SourceEditor emit exactly the DOM a built page emits (data-notes-root +
 * data-wb-edit, data-source-editor + data-wb-edit) with every identity value
 * DERIVED from the slug / row being rendered, never inherited from other
 * markup. The bundle (postscript.js) wires the one CodeMirror editor to it.
 */
import { h, Fragment } from "preact";
import renderToString from "preact-render-to-string";
import { pathToRoot, resolveRelative, simplifySlug } from "./quartz-path.mjs";
import { folderDisplayName } from "./site-index.mjs";
import { GRAPH, TOC_HEADER, UPLOAD_MODAL_BODY, GROUNDING_PANEL_BODY } from "./chrome-static.mjs";

export const html = (vnode) => (vnode == null ? "" : renderToString(vnode));
const cls = (...c) => c.filter(Boolean).join(" ");

// ── Date (Quartz components/Date.tsx) ───────────────────────────────────────
export function formatDate(d) {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" });
}
const DateEl = (d) => h("time", { datetime: d.toISOString() }, formatDate(d));

// ── Breadcrumbs (Quartz Breadcrumbs.tsx; trie ancestry from the site index) ─
export function Breadcrumbs(page) {
  const { slug, site } = page;
  const parts = slug.split("/");
  const crumbs = [];
  // root node, folders, then the page itself (a folder page's own folder is last)
  const folderParts = parts.at(-1) === "index" ? parts.slice(0, -1) : parts.slice(0, -1);
  crumbs.push({ name: "Home", target: "index" });
  for (let i = 1; i <= folderParts.length; i++) {
    const f = folderParts.slice(0, i).join("/");
    crumbs.push({ name: folderDisplayName(site, f).replaceAll("-", " "), target: `${f}/index` });
  }
  if (parts.at(-1) !== "index") crumbs.push({ name: String(page.title).replaceAll("-", " "), target: slug });
  if (!page.breadcrumbsKnown) return null;
  return h("nav", { class: "breadcrumb-container", "aria-label": "breadcrumbs" },
    crumbs.map((c, i) => h("div", { class: "breadcrumb-element" },
      h("a", { href: i === crumbs.length - 1 ? "" : resolveRelative(slug, simplifySlug(c.target)) }, c.name),
      i !== crumbs.length - 1 && h("p", null, ` ❯ `))));
}

export const ArticleTitle = (page) => (page.title ? h("h1", { class: "article-title" }, page.title) : null);

export function ContentMeta(page) {
  if (!page.text) return null;
  const segs = [];
  if (page.date) segs.push(DateEl(page.date));
  segs.push(h("span", null, `${page.readingMinutes} min read`));
  return h("p", { "show-comma": true, class: "content-meta" }, segs);
}

export function TagList(page) {
  if (!page.tags || page.tags.length === 0) return null;
  return h("ul", { class: "tags" }, page.tags.map((tag) =>
    h("li", null, h("a", { href: resolveRelative(page.slug, `tags/${tag}`), class: "internal tag-link" }, tag))));
}

// ── TableOfContents (Quartz TableOfContents.tsx, modern layout) ─────────────
// ALWAYS emitted (acceptance 1 of rw-p1a-render: every page carries a TOC);
// Quartz omits it when the page has fewer than two headings - an enumerated
// parity difference.
export function TableOfContents(page, listId) {
  const toc = page.toc || [];
  return `<div class="toc desktop-only">${TOC_HEADER}` + html(
    h("ul", { class: "toc-content overflow", id: listId },
      toc.map((e) => h("li", { key: e.slug, class: `depth-${e.depth}` },
        h("a", { href: `#${e.slug}`, "data-for": e.slug }, e.text))),
      h("li", { class: "overflow-end" }))) + "</div>";
}

// ── Backlinks (Quartz Backlinks.tsx) ────────────────────────────────────────
// ALWAYS emitted (acceptance 1); Quartz hides it when empty (hideWhenEmpty).
// Every page whose links include this one - the page ITSELF too when it links
// to its own heading, as Quartz lists it (Backlinks.tsx: allFiles.filter(
// (file) => file.links?.includes(slug)); rw-p1a-render attempt 3, AT2-1b).
export function Backlinks(page, listId) {
  const simple = simplifySlug(page.slug);
  const from = page.site?.backlinks.get(simple) || [];
  return html(h("div", { class: "backlinks" },
    h("h3", null, "Backlinks"),
    h("ul", { id: listId, class: "overflow" },
      from.length > 0
        ? from.map((s) => h("li", null, h("a", { href: resolveRelative(page.slug, s), class: "internal" }, page.site.bySlug.get(s)?.title)))
        : h("li", null, "No backlinks found"),
      h("li", { class: "overflow-end" }))));
}

export const Graph = () => GRAPH;

// ── Footer (Quartz Footer.tsx with quartz.layout.ts links) ──────────────────
export const Footer = () => html(h("footer", { class: "" },
  h("p", null, "Created with ", h("a", { href: "https://quartz.jzhao.xyz/" }, "Quartz v4.5.1"), " © ", new Date().getFullYear()),
  h("ul", null,
    h("li", null, h("a", { href: "https://github.com/jackyzha0/quartz" }, "GitHub")),
    h("li", null, h("a", { href: "https://discord.gg/cRFFHYye7t" }, "Discord Community")))));

// ── PageList / FolderContent / TagContent (Quartz) ──────────────────────────
function byDateAndAlphabetical(folderFirst) {
  return (a, b) => {
    if (folderFirst) {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
    }
    if (a.date && b.date) return b.date.getTime() - a.date.getTime();
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    return String(a.title).toLowerCase().localeCompare(String(b.title).toLowerCase());
  };
}

export function PageList(page, items, folderFirst = true) {
  const list = [...items].sort(byDateAndAlphabetical(folderFirst));
  return h("ul", { class: "section-ul" }, list.map((it) => h("li", { class: "section-li" },
    h("div", { class: "section" },
      h("p", { class: "meta" }, it.date && DateEl(it.date)),
      h("div", { class: "desc" }, h("h3", null, h("a", { href: resolveRelative(page.slug, it.slug), class: "internal" }, it.title))),
      h("ul", { class: "tags" }, (it.tags || []).map((tag) =>
        h("li", null, h("a", { class: "internal tag-link", href: resolveRelative(page.slug, `tags/${tag}`) }, tag))))))));
}

export function ListingBody(page, articleHtml, countText, items, folderFirst) {
  return html(h("div", { class: "popover-hint" },
    h("article", { class: (page.cssclasses || []).join(" "), dangerouslySetInnerHTML: { __html: articleHtml || "" } }),
    h("div", { class: "page-listing" },
      h("p", null, countText),
      h("div", null, PageList(page, items, folderFirst)))));
}

// ── overlay components (quartz-overlay/quartz/components/*.tsx) ─────────────
const isFolderSlug = (slug) => slug === "index" || slug.endsWith("/index");
const isUserNote = (slug) => !isFolderSlug(slug) && slug.startsWith("notes/") && !slug.startsWith("notes/Changes");

const PageTools = ({ slug }) => {
  if (!slug || slug.endsWith("/index")) return null;
  return h("div", { class: "page-tools ", "data-page-tools": true, "data-vault-path": `${slug}.md` },
    h("span", { class: "pt-group" },
      h("span", { class: "pt-label" }, "⬇ Export"),
      ["md", "pdf", "txt", "docx"].map((f) => h("button", { class: "pt-btn", "data-pt-export": f }, f === "txt" ? "TEXT" : f.toUpperCase()))),
    h("button", { class: "pt-btn pt-copy", "data-pt-copy": true }, "⧉ Copy page"),
    h("span", { class: "pt-status", "data-pt-status": true }));
};

const NotebookPage = ({ fm }) => {
  if (fm.type !== "notebook" || fm.thread_id == null) return null;
  return h("div", { class: "notebook-page ", "data-notebook-page": true, "data-thread-id": String(fm.thread_id), "data-slug": String(fm.slug ?? "") },
    h("div", { class: "nbp-head" },
      h("span", { class: "nbp-title" }, "📓 Notebook — live"),
      h("span", { class: "nbp-status", "data-nbp-status": true }, "loading…")),
    h("section", { class: "nbp-sec", "data-nbp-sources": true, hidden: true },
      h("h3", { class: "nbp-h" }, "Sources ", h("span", { class: "nbp-count", "data-nbp-src-count": true }),
        h("button", { class: "nbp-add", "data-nbp-add": true }, "+ Add source"),
        h("button", { class: "nbp-copy", "data-nbp-copy": true, hidden: true }, "⧉ copy")),
      h("p", { class: "nbp-help" }, "Linked sources are this notebook's ", h("strong", null, "evidence"),
        ": on the next wiki compile they ground its generated synthesis (the page text above) with real material, and they appear here and on the hub. Unlinking removes a source from ",
        h("em", null, "this"), " notebook only — it stays in its other notebooks and in generation, and isn't deleted."),
      h("ul", { class: "nbp-list", "data-nbp-src-list": true })),
    h("section", { class: "nbp-sec", "data-nbp-suggestions": true, hidden: true },
      h("h3", { class: "nbp-h" }, "Suggested sources ", h("span", { class: "nbp-count", "data-nbp-sug-count": true })),
      h("ul", { class: "nbp-list", "data-nbp-sug-list": true })),
    h("section", { class: "nbp-sec", "data-nbp-notes": true, hidden: true },
      h("h3", { class: "nbp-h" }, "Notes"),
      h("div", { class: "nbp-notes-group", "data-nbp-notes-user": true }),
      h("div", { class: "nbp-notes-group", "data-nbp-notes-ai": true })));
};

const isNotebooksMoc = (slug) => slug === "notebooks" || slug.endsWith("/notebooks");

const NotebookIndex = ({ slug }) => {
  if (!isNotebooksMoc(slug)) return null;
  return h("div", { class: "notebook-index ", "data-notebook-index": true },
    h("div", { class: "ni-head" },
      h("span", { class: "ni-title" }, "📚 Notebooks — live"),
      h("span", { class: "ni-status", "data-ni-status": true }, "loading…")),
    h("p", { class: "ni-help" }, "Every research group. Open one to manage its sources, notes and suggestions. Create a new notebook here — its hub page is generated on the next wiki compile."),
    h("ul", { class: "ni-list", "data-ni-list": true }),
    h("div", { class: "ni-create" },
      h("input", { class: "ni-name", "data-ni-name": true, placeholder: "new notebook name…" }),
      h("button", { class: "ni-create-btn", "data-ni-create": true }, "+ Create notebook")));
};

const ImportStatus = ({ slug }) => {
  if (!isNotebooksMoc(slug)) return null;
  return h("div", { class: "import-status ", "data-import-status": true },
    h("div", { class: "is-head" },
      h("span", { class: "is-title" }, "📥 Recent imports"),
      h("button", { class: "is-refresh", "data-is-refresh": true, title: "refresh" }, "↻")),
    h("p", { class: "is-help" }, "Document/URL imports and their outcome (durable across restarts). Duplicates are flagged; failed imports/grounding attempts show their error."),
    h("ul", { class: "is-list", "data-is-list": true }));
};

const GroundingPanel = ({ fm }) => {
  if (fm.type !== "wiki" || fm.entity_id == null) return null;
  return h("div", { class: "grounding-panel ", "data-grounding-panel": true, "data-entity-id": String(fm.entity_id), dangerouslySetInnerHTML: { __html: GROUNDING_PANEL_BODY.replace(/<\/div>$/, "") } });
};

const isSourceFm = (fm) => fm.type === "source" && fm.id != null;

const SourceEditor = ({ fm }) => {
  if (!isSourceFm(fm)) return null;
  const id = String(fm.id);
  return h("div", { class: "source-editor ", "data-source-editor": true, "data-source-id": id },
    h("button", { class: "ne-launch ne-edit", "data-wb-edit": true, "data-edit-kind": "source", "data-source-id": id }, "✎ Edit this source"),
    h("button", { class: "se-reupload", "data-se-reupload": true }, "↻ Re-upload new version"),
    h("input", { type: "file", "data-se-file": true, hidden: true }),
    h("span", { class: "se-reup-status", "data-se-status": true }));
};

const SourceLinker = ({ fm }) => {
  if (!isSourceFm(fm)) return null;
  return h("div", { class: "source-linker ", "data-source-linker": true, "data-source-id": String(fm.id) },
    h("div", { class: "sl-head" },
      h("span", { class: "sl-title" }, "🔗 Notebooks"),
      h("span", { class: "sl-status", "data-sl-status": true })),
    h("p", { class: "sl-help" }, "The notebooks this source belongs to. Add it to more, or unlink it from one — it stays in its other notebooks and in wiki generation (unlink isn't deletion). To make a wiki ",
      h("em", null, "page"), " cite this source, use “Ground this claim” on that page instead."),
    h("ul", { class: "sl-list", "data-sl-list": true }),
    h("div", { class: "sl-add" },
      h("select", { class: "sl-select", "data-sl-select": true }, h("option", { value: "" }, "add to a notebook…")),
      h("button", { class: "sl-add-btn", "data-sl-add": true }, "+ Add")));
};

const SourceRetractor = ({ fm }) => {
  if (!isSourceFm(fm)) return null;
  return h("div", { class: "source-retractor ", "data-source-retractor": true, "data-source-id": String(fm.id) },
    h("div", { class: "sr-head" },
      h("span", { class: "sr-title" }, "🗂 Source lifecycle"),
      h("span", { class: "sr-state-pill", "data-sr-pill": true }, "…"),
      h("span", { class: "sr-gravity", "data-sr-gravity": true }, "checking impact…")),
    h("p", { class: "sr-help", "data-sr-help": true }, "…"),
    h("div", { class: "sr-verbs" },
      h("button", { "data-sr": "retract", class: "sr-default" }, "Retract (reversible)"),
      h("button", { "data-sr": "restore", class: "sr-alt" }, "Restore")),
    h("div", { class: "sr-purge-row" },
      h("label", { class: "sr-purge-toggle" }, h("input", { type: "checkbox", "data-sr-show-purge": true }), " show purge — suppression with a reason (record kept)"),
      h("button", { "data-sr": "purge", class: "sr-danger", hidden: true }, "Purge")),
    h("div", { class: "sr-status", "data-sr-status": true }));
};

const NoteReferences = ({ slug }) => {
  if (!isUserNote(slug)) return null;
  return h("div", { class: "note-refs ", "data-note-refs": true, "data-note-path": slug + ".md" },
    h("div", { class: "nr-head" },
      h("span", { class: "nr-title" }, "🔗 References"),
      h("span", { class: "nr-head-right" },
        h("button", { class: "nr-copy", "data-nr-copy": true, hidden: true }, "⧉ copy list"),
        h("span", { class: "nr-status", "data-nr-status": true }))),
    // "addedones" (no space) is what the overlay's JSX renders - a line break
    // after </strong> collapses to nothing in JSX - kept for byte parity.
    h("p", { class: "nr-help" }, "This note's sources. ", h("strong", null, "Cited"), " ones are linked in the text; ", h("strong", null, "added"),
      "ones you attached deliberately (e.g. to organize evidence without quoting it inline). On export, both fold into one clean References list."),
    h("section", { class: "nr-sec", "data-nr-cited": true, hidden: true },
      h("h3", { class: "nr-h" }, "Cited in this note ", h("span", { class: "nr-count", "data-nr-cited-count": true })),
      h("ul", { class: "nr-list", "data-nr-cited-list": true })),
    h("section", { class: "nr-sec", "data-nr-added": true, hidden: true },
      h("h3", { class: "nr-h" }, "Added references ", h("span", { class: "nr-count", "data-nr-added-count": true })),
      h("ul", { class: "nr-list", "data-nr-added-list": true })),
    h("div", { class: "nr-add" },
      h("button", { class: "nr-add-btn", "data-nr-add-toggle": true }, "+ Add reference"),
      h("div", { class: "nr-search", "data-nr-search": true, hidden: true },
        h("input", { class: "nr-q", "data-nr-q": true, placeholder: "search existing sources by title / content…" }),
        h("div", { class: "nr-results", "data-nr-results": true }))));
};

const RevisionHistory = ({ slug, fm }) => {
  const isFolder = isFolderSlug(slug);
  const isSource = isSourceFm(fm);
  const note = isUserNote(slug);
  const isWikiGen = !isFolder && !isSource && !note && (fm.type === "wiki" || fm.type === "notebook" || fm.type === "thought");
  if (!isSource && !note && !isWikiGen) return null;
  const kind = isSource ? "source" : note ? "note" : "wiki";
  return h("div", { class: "revision-history ", "data-revision-history": true, "data-kind": kind, "data-ref": isSource ? String(fm.id) : `${slug}.md` },
    h("div", { class: "rh-head" },
      h("span", { class: "rh-title" }, "🕘 Revision history"),
      h("span", { class: "rh-right" },
        kind !== "wiki" && h("button", { class: "rh-commit", "data-rh-commit": true, hidden: true }, "Commit now"),
        h("span", { class: "rh-status", "data-rh-status": true }))),
    kind === "wiki"
      ? h("p", { class: "rh-help" }, "This page is ", h("strong", null, "generated each compile"),
        ", so its history is read-only. Each entry is a compile that changed the page — expand one to see what changed. Edit the underlying",
        " ", h("strong", null, "sources & notes"), " to shape what the next compile produces here.")
      : h("p", { class: "rh-help" }, "Edits are a working draft. ", h("strong", null, "Commit now"),
        " (or Done) records an authored revision — otherwise the next compile commits it. ", h("strong", null, "Revert"),
        " a revision to restore it (current edits are committed first); ", h("strong", null, "Discard"), " drops uncommitted edits."),
    h("div", { class: "rh-list", "data-rh-list": true }));
};

// Quartz sharedPageComponents.afterBody, in layout order (Dockerfile sed).
const AFTER_BODY = [PageTools, NotebookPage, NotebookIndex, ImportStatus, GroundingPanel,
  SourceEditor, SourceLinker, SourceRetractor, NoteReferences, RevisionHistory];
export function AfterBody(page) {
  return AFTER_BODY.map((C) => html(C(page))).join("");
}

export const UploadModal = ({ fm }) =>
  `<div class="upload-modal-root " data-upload-root="true"${fm.thread_id != null && fm.thread_id !== "" ? ` data-notebook-id="${escAttr(fm.thread_id)}"` : " data-notebook-id"}>${UPLOAD_MODAL_BODY}`;

const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// NotesEditor (the ONE editor's mount point): every identity value derived
// from the slug being rendered (README invariant 4).
export function NotesEditor({ slug, fm }) {
  const isFolder = isFolderSlug(slug);
  const folder = slug.replace(/\/index$/, "");
  const fParts = folder.split("/");
  const note = isUserNote(slug);
  const noteApiPath = slug.replace(/^notes\//, "") + ".md";
  const isTrashed = !!fm.trashed && fm.trashed !== "false";
  let canCreate = false;
  let createNbSlug = "";
  let createNbName = "";
  if (isFolder && (folder === "notes" || folder.startsWith("notes/"))) {
    canCreate = true;
    if (fParts[1] === "notebooks" && fParts[2]) { createNbSlug = fParts[2]; createNbName = fParts[2]; }
  }
  const folderRel = folder.replace(/^notes\/?/, "");
  return html(h("div", {
    class: "notes-editor-root ", "data-notes-root": true, "data-notebook-id": String(fm.thread_id ?? ""),
    "data-notebook-slug": createNbSlug, "data-notebook-name": createNbName, "data-folder-rel": folderRel,
    "data-trashed": isTrashed ? "1" : "",
  },
  isTrashed ? h("div", { class: "ne-trash-card", "data-ne-trash": true, "data-note-path": noteApiPath, "data-folder-rel": folderRel, "data-is-folder": isFolder ? "1" : "" },
    h("span", { class: "ne-trash-title" }, "🗑 In Trash"),
    h("span", { class: "ne-trash-msg" }, `This ${isFolder ? "folder and its notes are" : "note is"} in the trash and will be permanently removed at the nightly cleanup. Until then it's fully recoverable.`),
    h("button", { class: "ne-launch", "data-ne-restore": true }, "↩ Restore"),
    h("span", { class: "ne-status", "data-ne-trash-status": true })) : null,
  canCreate && !isTrashed ? h("button", { class: "ne-launch", "data-ne-launch": true }, "✎ Write a note") : null,
  canCreate && !isTrashed ? h("button", { class: "ne-launch", "data-nf-launch": true }, "📁 New folder") : null,
  canCreate && !isTrashed && folder !== "notes" && folder !== "notes/notebooks" ? h("button", { class: "ne-launch ne-danger", "data-nf-delete": true }, "🗑 Delete folder") : null,
  canCreate && !isTrashed ? h("button", { class: "ne-launch", "data-nf-history": true }, "📜 History") : null,
  canCreate && !isTrashed ? h("span", { class: "ne-fresh-note" }, "ℹ Newly created or restored notes can take a moment to appear in this list — the wiki rebuilds periodically. Trashed notes are marked 🗑 and removed at the nightly cleanup.") : null,
  note && !isTrashed ? h("button", { class: "ne-launch ne-edit", "data-wb-edit": true, "data-edit-kind": "note", "data-note-path": noteApiPath, "data-note-slug": slug }, "✎ Edit this note") : null));
}

export { Fragment, cls, pathToRoot };
