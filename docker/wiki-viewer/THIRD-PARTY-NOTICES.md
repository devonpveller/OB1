# Third-party notices - openbrain-wiki-viewer

Research-workbench licence policy (D9): permissive-only code is adopted; every
adopted file keeps its notice and gets an entry here.

## Quartz 4.5.1 (MIT)

Ported (rewritten as plain ESM, behaviour kept) into the live renderer
(research-workbench P1a, rw-p1a-render):

| this repo | ported from (jackyzha0/quartz v4.5.1) |
|---|---|
| `lib/quartz-path.mjs` | `quartz/util/path.ts` (slug + link algebra) |
| `../../recipes/_shared/quartz-slug.mjs` (rw-p1a-deploy-prep: the ONE copy of the slug rule, shared by the compile side, the reconciliation/backfill walk and this renderer; the image copies it to `lib/shared/`) | `quartz/util/path.ts` (`sluggify`, `slugifyFilePath`, `getFileExtension`, `stripSlashes`, `endsWith`, verbatim); the page set from `quartz/util/glob.ts` and `quartz.config.ts` `ignorePatterns` |
| `lib/site-index.mjs` (folder names), `lib/page-templates.mjs` + `lib/page-classes/folder.mjs` (a note and a folder of one name) | `quartz/util/fileTrie.ts` (`insert`, `fileSegmentHint`, `displayName`), `quartz/plugins/emitters/folderPage.tsx` (`computeFolderInfo`) |
| `lib/render-page.mjs` | `quartz/plugins/transformers/ofm.ts`, `gfm.ts`, `toc.ts`, `links.ts`, `syntax.ts`, `latex.ts`, `description.ts`; `quartz/util/jsx.tsx`; `quartz/components/renderPage.tsx` (`renderTranscludes`) and `quartz/util/path.ts` (`normalizeHastElement`, `isRelativeURL`) |
| `lib/page-classes/alias.mjs`, `lib/site-index.mjs` (`aliasRedirects`) | `quartz/plugins/emitters/aliases.ts` (the redirect document), `quartz/plugins/transformers/frontmatter.ts` (`getAliasSlugs`, the aliases/alias coalesce) |
| `lib/components.mjs` | `quartz/components/Breadcrumbs.tsx`, `ArticleTitle.tsx`, `ContentMeta.tsx`, `Date.tsx`, `TagList.tsx`, `TableOfContents.tsx`, `Backlinks.tsx`, `OverflowList.tsx`, `PageList.tsx`, `Footer.tsx`, `pages/FolderContent.tsx`, `pages/TagContent.tsx` |
| `lib/chrome.mjs` | `quartz/components/renderPage.tsx`, `Head.tsx` |
| `lib/chrome-static.mjs` (generated at image build by `test/extract-chrome-static.mjs`) | the HTML Quartz's `PageTitle`, `Search`, `Darkmode`, `ReaderMode`, `Explorer`, `Graph`, `Flex`, `Spacer`, `MobileOnly`, `DesktopOnly` components emit |

The Quartz clone itself (`/quartz` in the image, fetched at build) carries its
own `LICENSE.txt`.

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
