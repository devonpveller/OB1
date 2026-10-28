# Third-party notices - openbrain-wiki-viewer

Research-workbench licence policy (D9): permissive-only code is adopted; every
adopted file keeps its notice and gets an entry here.

## Quartz 4.5.1 (MIT)

Ported (rewritten as plain ESM, behaviour kept) into the live renderer
(research-workbench P1a, rw-p1a-render):

| this repo | ported from (jackyzha0/quartz v4.5.1) |
|---|---|
| `lib/quartz-path.mjs` | `quartz/util/path.ts` (slug + link algebra) |
| `../../recipes/_shared/quartz-slug.mjs` (rw-p1a-deploy-prep: the ONE copy of the slug rule, shared by the compile side, the reconciliation/backfill walk and this renderer; the image copies it to `lib/shared/`) | `quartz/util/path.ts` (`sluggify`, `slugifyFilePath`, `getFileExtension`, `stripSlashes`, `endsWith`, verbatim); `quartz/util/glob.ts` (`toPosixPath`, verbatim; the page set) and `quartz.config.ts` `ignorePatterns` |
| `lib/site-index.mjs` (folder names), `lib/page-templates.mjs` + `lib/page-classes/folder.mjs` (a note and a folder of one name) | `quartz/util/fileTrie.ts` (`insert`, `fileSegmentHint`, `displayName`), `quartz/plugins/emitters/folderPage.tsx` (`computeFolderInfo`) |
| `lib/render-page.mjs` | `quartz/plugins/transformers/ofm.ts`, `gfm.ts`, `toc.ts`, `links.ts`, `syntax.ts`, `latex.ts`, `description.ts`; `quartz/util/jsx.tsx`; `quartz/components/renderPage.tsx` (`renderTranscludes`) and `quartz/util/path.ts` (`normalizeHastElement`, `isRelativeURL`) |
| `lib/page-classes/alias.mjs`, `lib/site-index.mjs` (`aliasRedirects`) | `quartz/plugins/emitters/aliases.ts` (the redirect document), `quartz/plugins/transformers/frontmatter.ts` (`getAliasSlugs`, the aliases/alias coalesce) |
| `lib/components.mjs` | `quartz/components/Breadcrumbs.tsx`, `ArticleTitle.tsx`, `ContentMeta.tsx`, `Date.tsx`, `TagList.tsx`, `TableOfContents.tsx`, `Backlinks.tsx`, `OverflowList.tsx`, `PageList.tsx`, `Footer.tsx`, `pages/FolderContent.tsx`, `pages/TagContent.tsx` |
| `lib/chrome.mjs` | `quartz/components/renderPage.tsx`, `Head.tsx` |
| `quartz-overlay/quartz/components/scripts/explorer.inline.ts` (research-workbench P1b, rw-p1b-ready: a FORK - the explorer reads one folder at a time from `/workbench/nav`; the Dockerfile sha256-guards the upstream file) | `quartz/components/scripts/explorer.inline.ts` |
| `quartz-overlay/quartz/components/scripts/search.inline.ts` (rw-p1b-ready: a FORK - search and `#tag` search read `/workbench/search`, no local index; sha256-guarded) | `quartz/components/scripts/search.inline.ts` |
| `lib/nav-tree.mjs` (rw-p1b-ready: the explorer's order and entries, server-side) | `quartz/components/Explorer.tsx` (`defaultOptions.sortFn`, `filterFn`), `quartz/util/fileTrie.ts` (`displayName`, folder slugs) |
| `lib/chrome-static.mjs` (FROZEN since research-workbench P1c: emitted once from a Quartz-built page by the offline freeze tool - deleted in rw-p1c-retire2 - and committed; sha256 in `bundle.sha256`) | the HTML Quartz's `PageTitle`, `Search`, `Darkmode`, `ReaderMode`, `Explorer`, `Graph`, `Flex`, `Spacer`, `MobileOnly`, `DesktopOnly` components emit |

| `bundle/` - `index.css`, `prescript.js`, `postscript.js`, `static/**` (FROZEN since research-workbench P1c, D7: emitted ONCE by Quartz v4.5.1 + this repo's `quartz-overlay/` through the offline freeze tool (deleted in rw-p1c-retire2), committed byte for byte; sha256 in `bundle.sha256`) | Quartz's client bundle as its build emits it (its components' inline scripts and styles, the overlay forks above, and the client libraries Quartz bundles from its own MIT/ISC/Apache-2.0 dependency set) |

Since P1c the viewer image carries NO Quartz clone, and since rw-p1c-retire2
nothing in this tree fetches one (the offline freeze tool that did is in git
history only). This file is copied into the
image as `/viewer/THIRD-PARTY-NOTICES.md`, so the licence below travels with
the frozen bundle and the ported code. The image's runtime npm dependencies
(`package.json`, pinned by `package-lock.json` to the versions Quartz v4.5.1
locks) are MIT (188), ISC (4) and BSD-2-Clause (1) as their own package
manifests declare (one, `format`, declares none and ships an MIT LICENSE),
measured in `openbrain-wiki-viewer:wt-rw-p1c-retire` 2026-10-28; each keeps its
own licence file under `/viewer/node_modules`.

```
MIT License

Copyright (c) 2021 jackyzha0

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Packages the live renderer imports (resolved from Quartz's own node_modules)

Licences read from each installed package's `package.json` in the image
(2026-10-18): unified 11.0.5 MIT, remark-parse 11.0.0 MIT, remark-gfm 4.0.1
MIT, remark-frontmatter 5.0.0 MIT, remark-rehype 11.1.2 MIT,
remark-smartypants 3.0.2 MIT, remark-math 6.0.0 MIT, rehype-raw 7.0.0 MIT,
rehype-pretty-code 0.14.1 MIT, shiki 1.26.2 MIT, rehype-slug 6.0.0 MIT,
rehype-autolink-headings 7.1.0 MIT, rehype-katex 7.0.1 MIT, katex 0.16.21 MIT,
mdast-util-find-and-replace 3.0.2 MIT, mdast-util-to-hast 13.2.0 MIT,
mdast-util-to-string 4.0.0 MIT, hast-util-to-html 9.0.5 MIT,
hast-util-to-string 3.0.1 MIT, hast-util-to-jsx-runtime 2.3.6 MIT,
preact 10.26.7 MIT, preact-render-to-string 6.5.13 MIT, unist-util-visit 5.0.0
MIT, github-slugger 2.0.0 ISC, is-absolute-url 4.0.1 MIT, reading-time 1.5.0
MIT. No new package is installed by this item; P1c (which removes the Quartz
clone) must give the renderer its own pinned manifest for these.
