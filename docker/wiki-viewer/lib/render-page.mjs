/**
 * render-page - a wiki_pages row body (markdown) -> the SAFE article HTML a
 * built Quartz page carries, plus what the chrome needs (TOC, plain text,
 * outgoing links, inline tags, whether mermaid/math appear).
 *
 * THE TRANSFORM SET (research-workbench P1a, Quartz-chrome parity). The
 * pipeline is Quartz 4.5.1's own, in Quartz's order (quartz.config.ts ->
 * processors/parse.ts), ported from its transformer plugins (MIT, (c)
 * jackyzha0; THIRD-PARTY-NOTICES.md), using the SAME remark/rehype packages
 * Quartz itself resolves:
 *   ported  ObsidianFlavoredMarkdown: %%comments%%, wikilinks (alias, anchor,
 *           block ref, embeds: image/video/audio/pdf), ==highlights==, arrows,
 *           #tags, callouts (incl. foldable), mermaid, block references,
 *           YouTube image embeds
 *   ported  GitHubFlavoredMarkdown: GFM (tables, task lists, footnotes,
 *           strikethrough, autolinks), smartypants, heading slugs +
 *           appended anchor links
 *   ported  TableOfContents (maxDepth 3, the same slugger)
 *   ported  SyntaxHighlighting (rehype-pretty-code, github-light/dark)
 *   ported  CrawlLinks (strategy "shortest", internal/external classes,
 *           external-link icon, data-slug, pretty link text)
 *   ported  Description (the text the reading time is computed from)
 *   ported  Latex (remark-math + rehype-katex, html output)
 *   ported  Content's htmlToJsx (preact serialisation; tables wrapped in
 *           div.table-container)
 *   DROPPED raw HTML from the body (see SAFETY) - by design;
 *   DROPPED transclusion CONTENT: ![[page]] keeps Quartz's transclude
 *           blockquote + "Transclude of" link but is not filled with the
 *           other page's body (that needs a second row per embed; recorded
 *           in the rw-p1a-render findings);
 *   DROPPED CreatedModifiedDate's git/filesystem dates (the row's date is
 *           presented; see page-classes), RemoveDrafts (compile's job).
 *
 * SAFETY: page bodies can contain raw HTML from ingested web sources
 * (confirmed 2026-08-25: a literal <script> survived into a built page - the
 * built path runs rehype-raw over it). Here every `html` node the PARSER
 * produced from the body is removed before any transform runs; only the
 * html nodes this module itself generates (callout titles, highlights,
 * embeds - each interpolated value escaped) reach rehype-raw. Do not "fix"
 * this - it is the security property, pinned by render-page.test.mjs.
 *
 * PURE apart from shiki's lazily-loaded grammar cache: string in, object out.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import smartypants from "remark-smartypants";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeKatex from "rehype-katex";
import { findAndReplace } from "mdast-util-find-and-replace";
import { toHast } from "mdast-util-to-hast";
import { toHtml } from "hast-util-to-html";
import { toString as mdToString } from "mdast-util-to-string";
import { toString as hastToString } from "hast-util-to-string";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "preact/jsx-runtime";
import { h } from "preact";
import renderToString from "preact-render-to-string";
import { visit, SKIP } from "unist-util-visit";
import Slugger from "github-slugger";
import isAbsoluteUrl from "is-absolute-url";
import readingTime from "reading-time";
import path from "node:path";
import {
  slugifyFilePath, splitAnchor, slugTag, pathToRoot, transformLink, canonicalDest, simplifySlug,
} from "./quartz-path.mjs";

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── OFM constants (verbatim from quartz/plugins/transformers/ofm.ts) ────────
const calloutMapping = {
  note: "note", abstract: "abstract", summary: "abstract", tldr: "abstract", info: "info",
  todo: "todo", tip: "tip", hint: "tip", important: "tip", success: "success", check: "success",
  done: "success", question: "question", help: "question", faq: "question", warning: "warning",
  attention: "warning", caution: "warning", failure: "failure", missing: "failure", fail: "failure",
  danger: "danger", error: "danger", bug: "bug", example: "example", quote: "quote", cite: "quote",
};
const arrowMapping = {
  "->": "&rarr;", "-->": "&rArr;", "=>": "&rArr;", "==>": "&rArr;",
  "<-": "&larr;", "<--": "&lArr;", "<=": "&lArr;", "<==": "&lArr;",
};
const canonicalizeCallout = (name) => calloutMapping[name.toLowerCase()] ?? name;
const externalLinkRegex = /^https?:\/\//i;
const arrowRegex = /(-{1,2}>|={1,2}>|<-{1,2}|<={1,2})/g;
const wikilinkRegex = /!?\[\[([^\[\]\|\#\\]+)?(#+[^\[\]\|\#\\]+)?(\\?\|[^\[\]\#]*)?\]\]/g;
const tableRegex = /^\|([^\n])+\|\n(\|)( ?:?-{3,}:? ?\|)+\n(\|([^\n])+\|\n?)+/gm;
const tableWikilinkRegex = /(!?\[\[[^\]]*?\]\]|\[\^[^\]]*?\])/g;
const highlightRegex = /==([^=]+)==/g;
const commentRegex = /%%[\s\S]*?%%/g;
const calloutRegex = /^\[\!([\w-]+)\|?(.+?)?\]([+-]?)/;
const calloutLineRegex = /^> *\[\!\w+\|?.*?\][+-]?.*$/gm;
const tagRegex = /(?<=^| )#((?:[-_\p{L}\p{Emoji}\p{M}\d])+(?:\/[-_\p{L}\p{Emoji}\p{M}\d]+)*)/gu;
const blockReferenceRegex = /\^([-_A-Za-z0-9]+)$/g;
const ytLinkRegex = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
const ytPlaylistLinkRegex = /[?&]list=([^#?&]*)/;
const videoExtensionRegex = /\.(mp4|webm|ogg|avi|mov|flv|wmv|mkv|mpg|mpeg|3gp|m4v)$/;
const wikilinkImageEmbedRegex = /^(?<alt>(?!^\d*x?\d*$).*?)?(\|?\s*?(?<width>\d+)(x(?<height>\d+))?)?$/;
const capitalize = (s) => s.substring(0, 1).toUpperCase() + s.substring(1);

// OFM textTransform (runs on the raw text BEFORE parsing, as in Quartz).
export function ofmTextTransform(src) {
  src = src.replace(commentRegex, "");
  src = src.replace(calloutLineRegex, (value) => value + "\n> ");
  src = src.replace(tableRegex, (value) =>
    value.replace(tableWikilinkRegex, (_value, raw) => {
      let escaped = raw ?? "";
      escaped = escaped.replace("#", "\\#");
      escaped = escaped.replace(/((^|[^\\])(\\\\)*)\|/g, "$1\\|");
      return escaped;
    }));
  src = src.replace(wikilinkRegex, (value, ...capture) => {
    const [rawFp, rawHeader, rawAlias] = capture;
    const [fp, anchor] = splitAnchor(`${rawFp ?? ""}${rawHeader ?? ""}`);
    const blockRef = rawHeader?.startsWith("#^") ? "^" : "";
    const displayAnchor = anchor ? `#${blockRef}${anchor.trim().replace(/^#+/, "")}` : "";
    const displayAlias = rawAlias ?? rawHeader?.replace("#", "|") ?? "";
    const embedDisplay = value.startsWith("!") ? "!" : "";
    if (rawFp?.match(externalLinkRegex)) {
      return `${embedDisplay}[${displayAlias.replace(/^\|/, "")}](${rawFp})`;
    }
    return `${embedDisplay}[[${fp}${displayAnchor}${displayAlias}]]`;
  });
  return src;
}

// SECURITY: drop every raw-HTML node the PARSER produced from the body. Runs
// first, so the only html nodes left are the ones generated below.
function dropSourceHtml() {
  return (tree) => {
    visit(tree, "html", (_node, index, parent) => {
      if (parent && index != null) {
        parent.children.splice(index, 1);
        return [SKIP, index];
      }
    });
  };
}

function ofmReplacements() {
  return (tree, file) => {
    const ctx = file.data.ctx;
    const base = pathToRoot(ctx.slug);
    const mdastToHtml = (ast) => toHtml(toHast(ast, { allowDangerousHtml: true }), { allowDangerousHtml: true });
    void mdastToHtml;
    const replacements = [];
    replacements.push([wikilinkRegex, (value, ...capture) => {
      const [rawFp, rawHeader, rawAlias] = capture;
      const fp = rawFp?.trim() ?? "";
      const anchor = rawHeader?.trim() ?? "";
      const alias = rawAlias?.slice(1).trim();
      if (value.startsWith("!")) {
        const ext = path.extname(fp).toLowerCase();
        const url = slugifyFilePath(fp);
        if ([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp"].includes(ext)) {
          const match = wikilinkImageEmbedRegex.exec(alias ?? "");
          return {
            type: "image", url,
            data: { hProperties: {
              width: match?.groups?.width ?? "auto",
              height: match?.groups?.height ?? "auto",
              alt: match?.groups?.alt ?? "",
            } },
          };
        } else if ([".mp4", ".webm", ".ogv", ".mov", ".mkv"].includes(ext)) {
          return { type: "html", value: `<video src="${esc(url)}" controls></video>` };
        } else if ([".mp3", ".webm", ".wav", ".m4a", ".ogg", ".3gp", ".flac"].includes(ext)) {
          return { type: "html", value: `<audio src="${esc(url)}" controls></audio>` };
        } else if ([".pdf"].includes(ext)) {
          return { type: "html", value: `<iframe src="${esc(url)}" class="pdf"></iframe>` };
        }
        // Transclusion: Quartz's placeholder shape, content not filled (DROPPED, see header).
        return {
          type: "html",
          data: { hProperties: { transclude: true } },
          value: `<blockquote class="transclude" data-url="${esc(url)}" data-block="${esc(anchor)}" data-embed-alias="${esc(alias)}"><a href="${esc(url + anchor)}" class="transclude-inner">Transclude of ${esc(url)}${esc(anchor)}</a></blockquote>`,
        };
      }
      return { type: "link", url: fp + anchor, children: [{ type: "text", value: alias ?? fp }] };
    }]);
    replacements.push([highlightRegex, (_value, inner) =>
      ({ type: "html", value: `<span class="text-highlight">${esc(inner)}</span>` })]);
    replacements.push([arrowRegex, (value) => {
      const maybeArrow = arrowMapping[value];
      if (maybeArrow === undefined) return SKIP;
      return { type: "html", value: `<span>${maybeArrow}</span>` };
    }]);
    replacements.push([tagRegex, (_value, tag) => {
      if (/^[\/\d]+$/.test(tag)) return false;
      tag = slugTag(tag);
      ctx.inlineTags.add(tag);
      return {
        type: "link", url: base + `/tags/${tag}`,
        data: { hProperties: { className: ["tag-link"] } },
        children: [{ type: "text", value: tag }],
      };
    }]);
    findAndReplace(tree, replacements);
  };
}

function ofmVideoEmbed() {
  return (tree) => {
    visit(tree, "image", (node, index, parent) => {
      if (parent && index != undefined && videoExtensionRegex.test(node.url)) {
        parent.children.splice(index, 1, { type: "html", value: `<video controls src="${esc(node.url)}"></video>` });
        return SKIP;
      }
    });
  };
}

function ofmCallouts() {
  const mdastToHtml = (ast) => toHtml(toHast(ast, { allowDangerousHtml: true }), { allowDangerousHtml: true });
  return (tree) => {
    visit(tree, "blockquote", (node) => {
      if (node.children.length === 0) return;
      const [firstChild, ...calloutContent] = node.children;
      if (firstChild.type !== "paragraph" || firstChild.children[0]?.type !== "text") return;
      const text = firstChild.children[0].value;
      const restOfTitle = firstChild.children.slice(1);
      const [firstLine, ...remainingLines] = text.split("\n");
      const remainingText = remainingLines.join("\n");
      const match = firstLine.match(calloutRegex);
      if (!(match && match.input)) return;
      const [calloutDirective, typeString, calloutMetaData, collapseChar] = match;
      const calloutType = canonicalizeCallout(typeString.toLowerCase());
      const collapse = collapseChar === "+" || collapseChar === "-";
      const defaultState = collapseChar === "-" ? "collapsed" : "expanded";
      const titleContent = match.input.slice(calloutDirective.length).trim();
      const useDefaultTitle = titleContent === "" && restOfTitle.length === 0;
      const titleNode = {
        type: "paragraph",
        children: [
          { type: "text", value: useDefaultTitle ? capitalize(typeString).replace(/-/g, " ") : titleContent + " " },
          ...restOfTitle,
        ],
      };
      const title = mdastToHtml(titleNode);
      const toggleIcon = `<div class="fold-callout-icon"></div>`;
      const titleHtml = {
        type: "html",
        value: `<div
                  class="callout-title"
                >
                  <div class="callout-icon"></div>
                  <div class="callout-title-inner">${title}</div>
                  ${collapse ? toggleIcon : ""}
                </div>`,
      };
      const blockquoteContent = [titleHtml];
      if (remainingText.length > 0) {
        blockquoteContent.push({ type: "paragraph", children: [{ type: "text", value: remainingText }] });
      }
      if (calloutContent.length > 0) {
        node.children = [
          node.children[0],
          {
            data: { hProperties: { className: ["callout-content"] }, hName: "div" },
            type: "blockquote",
            children: [{
              data: { hProperties: { className: ["callout-content-inner"] }, hName: "div" },
              type: "blockquote",
              children: [...calloutContent],
            }],
          },
        ];
      }
      node.children.splice(0, 1, ...blockquoteContent);
      const classNames = ["callout", calloutType];
      if (collapse) classNames.push("is-collapsible");
      if (defaultState === "collapsed") classNames.push("is-collapsed");
      node.data = {
        hProperties: {
          ...(node.data?.hProperties ?? {}),
          className: classNames.join(" "),
          "data-callout": calloutType,
          "data-callout-fold": collapse,
          "data-callout-metadata": calloutMetaData,
        },
      };
    });
  };
}

function ofmMermaidMd() {
  return (tree, file) => {
    visit(tree, "code", (node) => {
      if (node.lang === "mermaid") {
        file.data.ctx.hasMermaid = true;
        node.data = { hProperties: { className: ["mermaid"], "data-clipboard": JSON.stringify(node.value) } };
      }
    });
  };
}

const TOC_MAX_DEPTH = 3;
function tableOfContents() {
  const slugAnchor = new Slugger();
  return (tree, file) => {
    const ctx = file.data.ctx;
    const display = ctx.frontmatter?.enableToc ?? true;
    if (!display || display === "false") return;
    slugAnchor.reset();
    const toc = [];
    let highestDepth = TOC_MAX_DEPTH;
    visit(tree, "heading", (node) => {
      if (node.depth <= TOC_MAX_DEPTH) {
        const text = mdToString(node);
        highestDepth = Math.min(highestDepth, node.depth);
        toc.push({ depth: node.depth, text, slug: slugAnchor.slug(text) });
      }
    });
    if (toc.length > 0 && toc.length > 1) {
      ctx.toc = toc.map((e) => ({ ...e, depth: e.depth - highestDepth }));
    }
  };
}

function ofmBlockReferences() {
  const inlineTagTypes = new Set(["p", "li"]);
  const blockTagTypes = new Set(["blockquote"]);
  return (tree) => {
    const blocks = {};
    visit(tree, "element", (node, index, parent) => {
      if (blockTagTypes.has(node.tagName)) {
        const nextChild = parent?.children.at(index + 2);
        if (nextChild && nextChild.tagName === "p") {
          const text = nextChild.children.at(0);
          if (text && text.value && text.type === "text") {
            const matches = text.value.match(blockReferenceRegex);
            if (matches && matches.length >= 1) {
              parent.children.splice(index + 2, 1);
              const block = matches[0].slice(1);
              if (!Object.keys(blocks).includes(block)) {
                node.properties = { ...node.properties, id: block };
                blocks[block] = node;
              }
            }
          }
        }
      } else if (inlineTagTypes.has(node.tagName)) {
        const last = node.children.at(-1);
        if (last && last.value && typeof last.value === "string") {
          const matches = last.value.match(blockReferenceRegex);
          if (matches && matches.length >= 1) {
            last.value = last.value.slice(0, -matches[0].length);
            const block = matches[0].slice(1);
            if (last.value === "") {
              let idx = (index ?? 1) - 1;
              while (idx >= 0) {
                const element = parent?.children.at(idx);
                if (!element) break;
                if (element.type !== "element") {
                  idx -= 1;
                } else {
                  if (!Object.keys(blocks).includes(block)) {
                    element.properties = { ...element.properties, id: block };
                    blocks[block] = element;
                  }
                  return;
                }
              }
            } else if (!Object.keys(blocks).includes(block)) {
              node.properties = { ...node.properties, id: block };
              blocks[block] = node;
            }
          }
        }
      }
    });
  };
}

function ofmYouTube() {
  return (tree) => {
    visit(tree, "element", (node) => {
      if (node.tagName === "img" && typeof node.properties.src === "string") {
        const match = node.properties.src.match(ytLinkRegex);
        const videoId = match && match[2].length == 11 ? match[2] : null;
        const playlistId = node.properties.src.match(ytPlaylistLinkRegex)?.[1];
        if (videoId || playlistId) {
          node.tagName = "iframe";
          node.properties = {
            class: "external-embed youtube", allow: "fullscreen", frameborder: 0, width: "600px",
            src: videoId
              ? (playlistId ? `https://www.youtube.com/embed/${videoId}?list=${playlistId}` : `https://www.youtube.com/embed/${videoId}`)
              : `https://www.youtube.com/embed/videoseries?list=${playlistId}`,
          };
        }
      }
    });
  };
}

function ofmMermaidHtml() {
  return (tree) => {
    visit(tree, "element", (node, _idx, parent) => {
      if (node.tagName === "code" && (node.properties?.className ?? []).includes?.("mermaid")) {
        parent.children = [
          {
            type: "element", tagName: "button",
            properties: { className: ["expand-button"], "aria-label": "Expand mermaid diagram", "data-view-component": true },
            children: [{
              type: "element", tagName: "svg",
              properties: { width: 16, height: 16, viewBox: "0 0 16 16", fill: "currentColor" },
              children: [{
                type: "element", tagName: "path",
                properties: {
                  fillRule: "evenodd",
                  d: "M3.72 3.72a.75.75 0 011.06 1.06L2.56 7h10.88l-2.22-2.22a.75.75 0 011.06-1.06l3.5 3.5a.75.75 0 010 1.06l-3.5 3.5a.75.75 0 11-1.06-1.06l2.22-2.22H2.56l2.22 2.22a.75.75 0 11-1.06 1.06l-3.5-3.5a.75.75 0 010-1.06l3.5-3.5z",
                },
                children: [],
              }],
            }],
          },
          node,
          {
            type: "element", tagName: "div", properties: { id: "mermaid-container", role: "dialog" },
            children: [{
              type: "element", tagName: "div", properties: { id: "mermaid-space" },
              children: [{ type: "element", tagName: "div", properties: { className: ["mermaid-content"] }, children: [] }],
            }],
          },
        ];
      }
    });
  };
}

const AUTOLINK = [rehypeAutolinkHeadings, {
  behavior: "append",
  properties: { role: "anchor", ariaHidden: true, tabIndex: -1, "data-no-popover": true },
  content: {
    type: "element", tagName: "svg",
    properties: {
      width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round",
    },
    children: [
      { type: "element", tagName: "path", properties: { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }, children: [] },
      { type: "element", tagName: "path", properties: { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" }, children: [] },
    ],
  },
}];

const EXTERNAL_ICON = {
  type: "element", tagName: "svg",
  properties: { "aria-hidden": "true", class: "external-icon", style: "max-width:0.8em;max-height:0.8em", viewBox: "0 0 512 512" },
  children: [{
    type: "element", tagName: "path",
    properties: { d: "M320 0H288V64h32 82.7L201.4 265.4 178.7 288 224 333.3l22.6-22.6L448 109.3V192v32h64V192 32 0H480 320zM32 32H0V64 480v32H32 456h32V480 352 320H424v32 96H64V96h96 32V32H160 32z" },
    children: [],
  }],
};

function crawlLinks() {
  return (tree, file) => {
    const ctx = file.data.ctx;
    const outgoing = new Set();
    const opts = { strategy: "shortest", byBase: ctx.byBase };
    visit(tree, "element", (node) => {
      if (node.tagName === "a" && node.properties && typeof node.properties.href === "string") {
        let dest = node.properties.href;
        const classes = node.properties.className ?? [];
        const isExternal = isAbsoluteUrl(dest);
        classes.push(isExternal ? "external" : "internal");
        if (isExternal) node.children.push(structuredClone(EXTERNAL_ICON));
        if (node.children.length === 1 && node.children[0].type === "text" && node.children[0].value !== dest) {
          classes.push("alias");
        }
        node.properties.className = classes;
        const isInternal = !(isAbsoluteUrl(dest) || dest.startsWith("#"));
        if (isInternal) {
          dest = node.properties.href = transformLink(ctx.slug, dest, opts);
          const full = canonicalDest(ctx.slug, dest);
          outgoing.add(simplifySlug(full));
          node.properties["data-slug"] = full;
        }
        if (isInternal && node.children.length === 1 && node.children[0].type === "text" &&
            !node.children[0].value.startsWith("#")) {
          node.children[0].value = path.basename(node.children[0].value);
        }
      }
      if (["img", "video", "audio", "iframe"].includes(node.tagName) && node.properties &&
          typeof node.properties.src === "string" && !isAbsoluteUrl(node.properties.src)) {
        node.properties.src = transformLink(ctx.slug, node.properties.src, opts);
      }
    });
    ctx.links = [...outgoing];
  };
}

function description() {
  return (tree, file) => {
    // Quartz Description: fileData.text = escapeHTML(toString(tree)) with
    // external URLs shortened; used for the reading time and meta description.
    const urlRegex = /(https?:\/\/)?(?<domain>([\da-z\.-]+)\.([a-z\.]{2,6})(:\d+)?)(?<path>[\/\w\.-]*)(\?[\/\w\.=&;-]*)?/g;
    const text = esc(hastToString(tree)).replace(/'/g, "&#039;").replace(urlRegex, "$<domain>$<path>");
    file.data.ctx.text = text;
    const sentences = text.replace(/\s+/g, " ").split(/\.\s/);
    let finalDesc = "";
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      if (!sentence) break;
      const cur = sentence.endsWith(".") ? sentence : sentence + ".";
      if (finalDesc.length + cur.length + (finalDesc ? 1 : 0) <= 150 || i === 0) finalDesc += (finalDesc ? " " : "") + cur;
      else break;
    }
    file.data.ctx.description = finalDesc.length > 300 ? finalDesc.slice(0, 300) + "..." : finalDesc;
  };
}

const PRETTY_CODE = [rehypePrettyCode, { theme: { light: "github-light", dark: "github-dark" }, keepBackground: false }];

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml", "toml"])
  .use(dropSourceHtml)
  .use(ofmReplacements)
  .use(ofmVideoEmbed)
  .use(ofmCallouts)
  .use(ofmMermaidMd)
  .use(remarkGfm)
  .use(smartypants)
  .use(tableOfContents)
  .use(remarkMath)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use([PRETTY_CODE])
  .use(rehypeRaw)
  .use(ofmBlockReferences)
  .use(ofmYouTube)
  .use(ofmMermaidHtml)
  .use(rehypeSlug)
  .use([AUTOLINK])
  .use(crawlLinks)
  .use(description)
  .use(rehypeKatex, { output: "html", macros: {} });

// Content's htmlToJsx + preact render: the serialisation a built page has.
export function hastToArticleHtml(tree) {
  const vnode = toJsxRuntime(tree, {
    Fragment, jsx, jsxs, elementAttributeNameCase: "html",
    components: { table: (props) => h("div", { class: "table-container" }, h("table", props)) },
  });
  return renderToString(vnode);
}

/**
 * Render one page body. ctx: { slug, frontmatter?, byBase? (basename->slugs) }.
 * Returns { html, toc, text, description, links, inlineTags, hasMermaid, readingMinutes }.
 */
export async function renderPage(body, ctx = {}) {
  const c = {
    slug: ctx.slug || "index",
    frontmatter: ctx.frontmatter || {},
    byBase: ctx.byBase || new Map(),
    inlineTags: new Set(),
    toc: null, text: "", description: "", links: [], hasMermaid: false,
  };
  const src = ofmTextTransform(String(body ?? "").replace(/\r\n?/g, "\n"));
  const file = { value: src, data: { ctx: c } };
  const mdast = processor.parse(file.value);
  const hast = await processor.run(mdast, file);
  const html = hastToArticleHtml(hast);
  return {
    html,
    toc: c.toc,
    text: c.text,
    description: c.description,
    links: c.links,
    inlineTags: [...c.inlineTags],
    hasMermaid: c.hasMermaid,
    readingMinutes: Math.ceil(readingTime(c.text).minutes),
  };
}

// Back-compat convenience (Phase B callers + tests): body -> article HTML.
export async function renderMarkdown(body, ctx) {
  return (await renderPage(body, ctx)).html;
}
