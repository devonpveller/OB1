# The workspace (research-workbench P2b)

A Vite + React 19 panel workspace served by the wiki viewer at `/workspace`: a dockview shell with
the standard title bar (Settings, Theme, the notifications bell with its progress indicators, the
universal `+`), a fixed left nav, the writing surface (CodeMirror 6) and the side panels. Every
panel and nav entry is **registered** by its own module (`src/shell/registry.ts`,
`src/panels/index.ts`); the shell names none of them.

## Build

Built inside the viewer image (Dockerfile stage `workspace`) from `package-lock.json` with `npm ci`,
so CodeMirror 6, dockview and every other package is the version the lockfile pins. The stage runs
`vitest`, the D9 notices check (`node scripts/notices.mjs --check`) and `npm run build`
(`tsc --noEmit` + `vite build`); only `dist/` reaches the runtime image (`/quartz/workspace`).

```bash
npm ci && npm test && npm run build      # by hand
node scripts/notices.mjs                 # after a dependency change: regenerate THIRD-PARTY-NOTICES.md
```

## What it talks to

Only same-origin `/workbench/*` (`src/lib/api.ts`, the one fetch door): the retrieval contract
(`/workbench/contract/*`), the documents API (`/workbench/documents/*`) and `/workbench/workspace/*`
(who the user is, the bell's read state). The key is injected server-side - by the portal Caddy, or
by the viewer itself for an edge that targets the viewer alone (`lib/workbench-proxy.mjs`).

## User documents

A user document is a file in the vault's `documents/<owner>/` tree plus a body-less listing record
(title, path, updated, outbound links). It is never a wiki page. The grammar (`src/lib/grammar.ts`,
a byte-identical copy of `OB1/docker/workbench/src/documents/grammar.ts`):

| form | meaning |
|---|---|
| `[[slug\|alias]]` | a wiki page, live |
| `[[source:<id>\|alias]]` | a source or held source; the document pins it (a whole-source reference record) |
| `[[claim:<id>]]`, `[[report:<id>]]`, `[[doc:<path>]]` | a claim, a research report, another document |
| `[@ref:<reference id>]` | a citation chip: a P2a reference record, frozen to its pin |
| `{{ref:<reference id>}}text{{/ref}}` | a protected transclusion (atomic in the editor); the deliberate break (Mod-Shift-B, or the toolbar) turns it into `text [@ref:<id>]` |

## Per-user state

The front-end context is the user's own (operator 2026-10-28): the workbench's identity seam decides
who the user is; the browser keys its layout, theme and toolbar state by that subject
(`src/lib/owner.ts`). The knowledge base is shared.

## Tests

`test/` (vitest, happy-dom) runs in the image build; `e2e/` is the headless-Chromium run the lab
runner (`OB1/docker/workbench/contract-test/run-workspace-tests.ps1`) drives through the front door.
