# quartz-overlay

Custom Quartz layer for the Open Brain workbench (plan §2.5). **Layer, don't
fork:** these files are `COPY`'d over the pinned Quartz clone in the viewer
[Dockerfile](../Dockerfile) **after** `git clone` + `npm ci`, so
`QUARTZ_REF=v4.5.1` stays upgradeable. Nothing here edits Quartz's own source
in place — additive component files are copied in, and the handful of upstream
files that must change (`quartz.layout.ts`, `components/index.ts`,
`quartz.config.ts`) are touched by **grep-asserted `sed` patches** in the
Dockerfile (same convention as the existing Explorer/Search idempotency patch),
so a future `QUARTZ_REF` bump fails the build loudly instead of silently
dropping a wiring change.

## Layout

```
quartz-overlay/
  quartz/
    components/
      WorkbenchProbe.tsx              # P0.4 proving component (no-op + health probe)
      scripts/workbench-probe.inline.ts
      <added per phase: NotebookPage.tsx, SourceEditor.tsx, ImportDropzone.tsx, …>
```

Each interactive component is a Quartz constructor component (`.tsx`, built at
compile time, thin) plus an optional `.inline.ts` client script (where the heavy
logic lives — D-A static-build friction). Client scripts call the workbench
same-origin at `/workbench/*`; the secret is injected by Caddy server-side (G7),
so **no bearer is ever embedded here**.

## Hydration id contract (G12 / P0.6)

Hydrated components read their backing id from **frontmatter**, never from the
URL: entity pages expose `entity_id` + `wiki_slug`; notebook hubs `thread_id` +
`slug`; leaf pages `type` + `id`. Read them from
`document.querySelector('[data-slug]')` / the page's frontmatter JSON that
Quartz emits, never by parsing `location.pathname`.

## Assets (P0.4)

Binary assets live on the `wiki-assets` volume mounted at the vault-root
`assets/` path. Quartz copies non-markdown static files through to the output by
default; the asset path must be **served but not paginated** (it is not a
content page). Confirm via `ignorePatterns` / the static-file handling in the
copied `quartz.config.ts` patch.
