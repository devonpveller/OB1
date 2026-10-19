# Read-only Quartz 4 viewer (D15) for the compiled wiki.
# Quartz is fetched at build time (build-time network is fine; the
# "no cloud" rule governs runtime model/data, not image builds — same
# as pulling node:22-alpine). Pinned for reproducibility.
FROM node:22-slim

ARG QUARTZ_REF=v4.5.1
# rsync: hardlink snapshots in entrypoint.sh (--link-dest) — a snapshot of an
# unchanged build costs MBs instead of copying the full ~750MB tree.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates rsync \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /quartz
RUN git clone --depth 1 --branch ${QUARTZ_REF} https://github.com/jackyzha0/quartz.git . \
  && npm ci

# CodeMirror 6 for the NotesEditor Live-Preview overlay (P3.5). Bundled into the
# client by Quartz's inline-script-loader (`NotesEditor.inline.ts`). Installed
# here (own layer) so it's cached independent of overlay/source changes. No
# runtime CDN — these ship inside the image (self-hosted rule).
RUN npm install --no-audit --no-fund \
  @codemirror/state \
  @codemirror/view \
  @codemirror/language \
  @codemirror/commands \
  @codemirror/autocomplete \
  @codemirror/lang-markdown \
  @lezer/markdown \
  @lezer/highlight

# Fork-drift guard for the two FORKED client scripts (research-workbench P1b):
# quartz-overlay/ replaces stock explorer.inline.ts and search.inline.ts with
# forks that read the database one request at a time (/workbench/nav,
# /workbench/search) instead of the whole vault's index. The forks also carry
# what used to be sed/script patches here (idempotent re-render, explorer
# state fixes, V0/V1 of PLAN-VIEWER-PERF, the API search provider). If a
# QUARTZ_REF bump changes either stock file, the build fails here so the fork
# gets re-based instead of silently shipping stale upstream behaviour.
RUN set -e; \
  echo "c0c27bac6488f3eba16774f5e1c735dd0a3d74e4cfff714c9104be6441d30b4a  quartz/components/scripts/explorer.inline.ts" | sha256sum -c -; \
  echo "6ccbf8dd65d8f3cb12ab73e467a8c1313dfa119e69e37b0468bf286e744516f0  quartz/components/scripts/search.inline.ts" | sha256sum -c -

# Disable the dev hot-reload client injection entirely (2026-08-23; supersedes
# the old "editor open" reload gate). The builder runs `--serve` purely as an
# internal watcher — no reader ever browses it directly, and serve.mjs had to
# regex-strip the injected ws://localhost reload script out of EVERY page on
# EVERY request (a tempered-greedy scan over up-to-2MB HTML). Not injecting it
# removes that cost at the source. Re-enable for interactive builder debugging
# with WIKI_HOT_RELOAD=1. grep-asserted so a QUARTZ_REF bump fails loudly.
RUN set -e; \
  P=/quartz/quartz/plugins/index.ts; \
  grep -q 'if (ctx.argv.serve) {' "$P"; \
  sed -i 's#if (ctx.argv.serve) {#if (ctx.argv.serve \&\& process.env.WIKI_HOT_RELOAD === "1") {#' "$P"; \
  grep -q 'WIKI_HOT_RELOAD' "$P"

# ── Index diet (2026-08-23) ─────────────────────────────────────────────────
# The stock head script fetches static/contentIndex.json on EVERY page load.
# Repoint the shared fetchData at static/graphIndex.json, which the viewer
# answers LIVE from wiki_pages. Since P1b nothing reads it on navigation (the
# explorer and search forks use the API); the graph's offline fallback is its
# only fetchData reader, and fetchData is a lazy thenable (below), so the
# index is fetched only if that fallback runs. grep-asserted.
RUN set -e; \
  R=quartz/components/renderPage.tsx; \
  grep -q 'static/contentIndex.json' "$R"; \
  sed -i 's#static/contentIndex.json#static/graphIndex.json#' "$R"; \
  grep -q 'static/graphIndex.json' "$R"

# -- wiki-dynamic-index P2: retire the whole-vault index --------------------
# ContentIndex is the ONLY non-incremental Quartz emitter: it re-walks every
# page and re-serialises the full text of the vault on EVERY rebuild (~75MB /
# ~120s on a 29.6k-page vault, back-to-back forever) - the reason a new note
# took >15 min to appear. The compiler now publishes each page into wiki_pages
# as it writes it and the viewer answers the lean index from that table
# (lib/nav-index.mjs; P1b removed the publish-time derive-graph-index.mjs),
# so the emitter has no consumer left.
# Range-delete the whole plugin block - commenting only its opening line would
# leave its options dangling. Accepted loss: sitemap.xml + RSS (private wiki).
# grep-asserted so a QUARTZ_REF bump fails the build loudly.
RUN set -e; \
  C=/quartz/quartz.config.ts; \
  grep -q 'Plugin.ContentIndex({' "$C"; \
  sed -i '/Plugin\.ContentIndex({/,/^[[:space:]]*}),$/d' "$C"; \
  ! grep -q 'Plugin.ContentIndex' "$C"; \
  grep -q 'Plugin.Assets()' "$C"

# -- wiki-dynamic-index P4: stop fetching the index on every page load ------
# renderPage injects a TOP-LEVEL fetch of the index into every page, so every
# reader paid ~8MB before touching search or the graph. Swap the eager promise
# for a memoising THENABLE: nothing is fetched until a consumer awaits it
# (since P1b the graph's offline fallback is the only one left).
RUN set -e; \
  R=/quartz/quartz/components/renderPage.tsx; \
  grep -q 'const fetchData = fetch(' "$R"; \
  sed -i 's#fetch("${contentIndexPath}").then(data => data.json())#{ _p: null, then(f, r) { return (this._p ??= fetch("${contentIndexPath}").then(d => d.json())).then(f, r) } }#' "$R"; \
  grep -q '_p ??= fetch' "$R"

# -- Mermaid runs STRICT (rw-p1a-render attempt 2, finding F-T1) -----------
# Quartz initialises mermaid with securityLevel "loose", so a diagram in a
# page body could carry a `click X "javascript:..."` that runs on click (and
# loose also lets labels carry HTML). "strict" disables click handlers and
# sanitises labels. The same bundle serves the built and the live page, so the
# rendered HTML of both is unchanged (only the client-side diagram behaviour
# is). mermaid documents securityLevel as one of its `secure` config keys,
# which a diagram's own %%{init}%% directive cannot override (mermaid is
# loaded from its CDN at runtime, not from this image, and no browser runs
# in the item's tests: recorded as not verified, rw-p1a-render findings).
# grep-asserted so a QUARTZ_REF bump fails the build loudly.
RUN set -e; \
  M=/quartz/quartz/components/scripts/mermaid.inline.ts; \
  grep -q 'securityLevel: "loose"' "$M"; \
  sed -i 's#securityLevel: "loose"#securityLevel: "strict"#' "$M"; \
  grep -q 'securityLevel: "strict"' "$M"; \
  ! grep -q 'securityLevel: "loose"' "$M"

# -- Watcher must POLL, or new files are never seen --------------------------
# Root cause of 'my note never appears' (2026-08-26). Full story in the
# patch script; in short: CHOKIDAR_USEPOLLING is not a chokidar feature, so
# the watcher was on inotify across a cross-container symlinked volume where
# `add` events never fire. Applied by script (multi-line replacement).
COPY patches/watcher-polling.mjs /tmp/watcher-polling.mjs
RUN node /tmp/watcher-polling.mjs

# Build resilience: the compiler's orphan-sweep deletes leaf pages while a
# rebuild is mid-flight, so a Quartz parse worker can hit ENOENT on a file that
# vanished underneath it. Upstream trace() then THROWS (in a worker) or
# process.exit(1) (main thread), which deadlocks the shared esbuild service and
# kills the ENTIRE build — a ~30-min loss every time a sweep overlaps a rebuild.
# Make trace() SKIP a vanished file (warn + return) instead; a swept orphan
# SHOULD be absent from the output anyway, and every other error path is
# unchanged. grep-asserted so a QUARTZ_REF bump that moves the signature fails
# the build loudly.
RUN set -e; \
  T=/quartz/quartz/util/trace.ts; \
  grep -q 'export function trace(msg: string, err: Error) {' "$T"; \
  sed -i 's#export function trace(msg: string, err: Error) {#&\n  if ((err as any)?.code === "ENOENT") { console.warn("[skip vanished file] " + msg); return }#' "$T"; \
  grep -q 'skip vanished file' "$T"

# Fault isolation (2026-08-25): both per-file try/catch blocks in parse.ts call
# trace(), which process.exit(1)s on the main thread — so ONE unparseable page
# killed the whole --serve builder. (Live incident: a Template-Toolkit man page
# whose raw "[% ... %] (x)" text parses as a markdown link with a bare-% target
# → decodeURI "URI malformed" → builder crash-looped every ~8min and snapshot
# publishing froze.) Replace both catch bodies with log-and-skip: the poisoned
# page drops out of the build, every other page publishes. grep-asserted like
# the trace patch above so a QUARTZ_REF bump fails the build loudly.
RUN set -e; \
  P=/quartz/quartz/processors/parse.ts; \
  grep -q 'Failed to process markdown' "$P"; \
  grep -q 'Failed to process html' "$P"; \
  sed -i \
    -e 's#trace(`\\nFailed to process markdown \\`${fp}\\``, err as Error)#console.error(`[parse] SKIPPED (md) ${fp}: ${(err as Error).message}`)#' \
    -e 's#trace(`\\nFailed to process html \\`${file.data.filePath}\\``, err as Error)#console.error(`[parse] SKIPPED (html) ${file.data.filePath}: ${(err as Error).message}`)#' \
    "$P"; \
  test "$(grep -c 'SKIPPED' "$P")" = "2"

# Fork-drift guard (2026-08-23): the overlay REPLACES stock graph.inline.ts
# with a patched fork (O(1) graph data prep + global-view scoping — changes too
# structural for seds). If a QUARTZ_REF bump changes the stock file, fail the
# build loudly so the fork gets re-based instead of silently shipping stale
# upstream behavior.
RUN set -e; \
  echo "3a1d516df85c68eca29f547f813acb09200fdc25468c7e7536038e8f38db8dfd  /quartz/quartz/components/scripts/graph.inline.ts" | sha256sum -c -

# ── Workbench overlay (plan §2.5 / P0.4) ────────────────────────────────────
# Layer custom Quartz components over the pinned clone ADDITIVELY, so
# QUARTZ_REF stays upgradeable. New component files are copied in; the upstream
# files that must change are touched with append-only / grep-asserted edits so
# a future QUARTZ_REF bump fails the build loudly instead of silently dropping
# the wiring (graph.inline.ts is the one FORKED file — guarded by the sha check
# above). Later phases (P2–P6) add their components into quartz-overlay/.
COPY quartz-overlay/quartz/ /quartz/quartz/
# Compile gate for the OVERLAY sources (they only exist after the COPY above):
# a fork that writes text but no longer parses fails the image build, not the site.
RUN set -e; for f in NotesEditor explorer search; do \
  node_modules/.bin/esbuild --log-level=error --outfile=/dev/null "quartz/components/scripts/$f.inline.ts"; done

# -- Page-scoped graph (see patches/graph-api.mjs) --------------------------
COPY patches/graph-api.mjs /tmp/graph-api.mjs
RUN node /tmp/graph-api.mjs
RUN node_modules/.bin/esbuild --log-level=error --outfile=/dev/null quartz/components/scripts/graph.inline.ts

# Register overlay components. Append-only re-export needs NO upstream anchor —
# Quartz's `import * as Component from "./components"` picks up every named
# export, so appending here can never conflict with an upstream edit. Each
# component self-gates on frontmatter (returns null where it doesn't apply), so
# placing them all in one rail is harmless on non-matching page classes.
RUN { \
  echo ''; \
  echo '// --- openbrain workbench overlay components (additive) ---'; \
  echo 'export { default as GroundingBadge } from "./GroundingBadge"'; \
  echo 'export { default as UploadModal } from "./UploadModal"'; \
  echo 'export { default as SourceRetractor } from "./SourceRetractor"'; \
  echo 'export { default as NotesEditor } from "./NotesEditor"'; \
  echo 'export { default as NotebookPage } from "./NotebookPage"'; \
  echo 'export { default as GroundingPanel } from "./GroundingPanel"'; \
  echo 'export { default as NoteReferences } from "./NoteReferences"'; \
  echo 'export { default as PageTools } from "./PageTools"'; \
  echo 'export { default as NotebookIndex } from "./NotebookIndex"'; \
  echo 'export { default as SourceEditor } from "./SourceEditor"'; \
  echo 'export { default as SourceLinker } from "./SourceLinker"'; \
  echo 'export { default as ImportStatus } from "./ImportStatus"'; \
  echo 'export { default as RevisionHistory } from "./RevisionHistory"'; \
  } >> /quartz/quartz/components/index.ts

# Mount the overlay components in the content page (after Backlinks).
# grep-asserts the upstream anchor so a QUARTZ_REF bump that moves it fails
# loudly (same convention as the Explorer/Search patch above).
RUN set -e; \
  L=/quartz/quartz.layout.ts; \
  grep -q 'Component.Backlinks(),' "$L"; \
  sed -i 's#\(\s*\)Component.Backlinks(),#\1Component.Backlinks(),\n\1Component.UploadModal(),\n\1Component.NotesEditor(),#' "$L"; \
  grep -q 'Component.NotesEditor(),' "$L"

# Wide hydrated CARDS (NotebookPage on hubs, GroundingPanel on entity pages) go
# in the center column (sharedPageComponents.afterBody, full content width), NOT
# the narrow right rail. Each self-gates by frontmatter, so only one renders per
# page. GroundingPanel SUPERSEDES the old rail GroundingBadge (a consistent,
# full-width "add sources / ground this claim" UX everywhere).
RUN set -e; \
  L=/quartz/quartz.layout.ts; \
  grep -q 'afterBody: \[\],' "$L"; \
  sed -i 's#afterBody: \[\],#afterBody: [Component.PageTools(), Component.NotebookPage(), Component.NotebookIndex(), Component.ImportStatus(), Component.GroundingPanel(), Component.SourceEditor(), Component.SourceLinker(), Component.SourceRetractor(), Component.NoteReferences(), Component.RevisionHistory()],#' "$L"; \
  grep -q 'Component.NoteReferences(), Component.RevisionHistory()' "$L"

# Also mount NotesEditor on the LIST/FOLDER page layout (its beforeBody is a
# single-line array), so "✎ Write a note" is reachable from every folder level,
# not just the notebook hub. grep-asserted anchor.
RUN set -e; \
  L=/quartz/quartz.layout.ts; \
  grep -q 'Component.ContentMeta()]' "$L"; \
  sed -i 's#Component.ContentMeta()]#Component.ContentMeta(), Component.NotesEditor()]#' "$L"; \
  grep -q 'Component.ContentMeta(), Component.NotesEditor()]' "$L"

# Quartz's runtime config, set at BUILD time as entrypoint.sh also sets it at
# start (idempotent): vault ignore patterns, and CustomOgImages off (ZWJ-emoji
# codepoints crash its emit). Needed here because the chrome extraction below
# runs a real Quartz build of the fixture vault.
RUN set -e; C=/quartz/quartz.config.ts; \
  sed -i 's#ignorePatterns: \[[^]]*\]#ignorePatterns: ["private", "templates", ".obsidian", ".git", ".git/**", "**/.git/**", ".quartz-cache", "public", "node_modules", ".wikistate.json", "**/.failed-entity-ids.json", "planned.json"]#' "$C"; \
  sed -i 's#^\([[:space:]]*\)Plugin.CustomOgImages(),#\1// Plugin.CustomOgImages(), // DISABLED: ZWJ-emoji codepoint crashes emit#' "$C"; \
  grep -q '// Plugin.CustomOgImages()' "$C"

# serve.mjs lives INSIDE /quartz (with lib/ beside it) so its unified/remark
# imports resolve against /quartz/node_modules — ESM ignores NODE_PATH, and a
# server at /serve.mjs would fail at the first lib import (Phase B).
COPY serve.mjs /quartz/serve.mjs
COPY lib /quartz/lib
# The compile half of the page-class registry and the files-vs-rows
# reconciler are SHARED with the compiler (research-workbench P1a, D13 item 4:
# one reconciler for the post-compile check, the health probe and the repair
# pass). They come from OB1/recipes/_shared through the named build context
# `recipes` (compose: build.additional_contexts; by hand:
# docker build --build-context recipes=OB1/recipes ...).
COPY --from=recipes _shared/page-classes.mjs _shared/wiki-pages.mjs _shared/links.mjs _shared/reconcile-wiki-pages.mjs _shared/structural-ledger.mjs _shared/quartz-slug.mjs /quartz/lib/shared/

# The STATIC chrome (left sidebar, graph shell, head resources, after-body
# scripts, ...) is cut from a page this image's own Quartz builds from the
# committed SYNTHETIC fixture vault (kept in the image: the live-render unit
# test renders its rows), so the live renderer's chrome is the
# chrome this Quartz emits - a QUARTZ_REF bump regenerates it, and an anchor
# the extractor cannot find fails the build. No live content is involved.
#
# The same build's CLIENT BUNDLE is kept as /quartz/bundle (research-workbench
# P1b, the readiness contract): index.css, prescript.js, postscript.js and
# static/ are what every page loads, and they are emitted from this image's
# components and config - not from the vault - so a viewer with an EMPTY /srv
# serves every page with them (serve.mjs resolves an asset from /srv/current
# first, then from here). No page HTML and no index file is kept.
COPY test/fixtures/vault /quartz/test/fixtures/vault
COPY test/extract-chrome-static.mjs /tmp/extract-chrome-static.mjs
RUN set -e; cd /quartz; \
  npx quartz build -d /quartz/test/fixtures/vault -o /tmp/fixture-out > /tmp/fixture-build.log 2>&1 || { cat /tmp/fixture-build.log; exit 1; }; \
  node /tmp/extract-chrome-static.mjs /tmp/fixture-out/content/person/person-ada-fixture.html /tmp/fixture-out/content/person/index.html > /quartz/lib/chrome-static.mjs; \
  mkdir -p /quartz/bundle; \
  cp /tmp/fixture-out/index.css /tmp/fixture-out/prescript.js /tmp/fixture-out/postscript.js /quartz/bundle/; \
  cp -a /tmp/fixture-out/static /quartz/bundle/static; \
  rm -f /quartz/bundle/static/contentIndex.json /quartz/bundle/static/graphIndex.json; \
  rm -rf /tmp/fixture-out /tmp/fixture-build.log /quartz/.quartz-cache; \
  test -s /quartz/lib/chrome-static.mjs; \
  for f in index.css prescript.js postscript.js static/icon.png; do test -s "/quartz/bundle/$f" || { echo "baked bundle lacks $f"; exit 1; }; done

# Build gates for the live renderer:
# 1. every transitive dependency the renderer leans on must resolve - they are
#    QUARTZ'S deps (MIT/ISC, THIRD-PARTY-NOTICES.md), not ours, and a
#    QUARTZ_REF bump may drop one silently;
# 2. the renderer, chrome, registry, DB-state and nav unit tests (incl. the
#    raw-HTML security property and the ONE-editor identity invariants).
RUN set -e; cd /quartz; \
  node -e "await Promise.all(['unified','remark-parse','remark-gfm','remark-frontmatter','remark-rehype','remark-smartypants','remark-math','rehype-raw','rehype-pretty-code','rehype-slug','rehype-autolink-headings','rehype-katex','mdast-util-find-and-replace','mdast-util-to-hast','mdast-util-to-string','hast-util-to-html','hast-util-to-string','hast-util-to-jsx-runtime','preact','preact-render-to-string','unist-util-visit','github-slugger','is-absolute-url','reading-time'].map(m=>import(m)))"; \
  node --test lib/*.test.mjs

COPY entrypoint.sh /entrypoint.sh
# Normalise line endings IN THE IMAGE. This repo is checked out on Windows,
# where git restores CRLF; a CRLF shebang makes the kernel fail exec with
# 'no such file or directory' and the container crash-loops (hit twice:
# 2026-08-25 and again 2026-08-26 when building from the main checkout
# rather than the LF worktree). Doing it here means the build is correct
# regardless of how the tree was checked out.
RUN sed -i 's/$//' /entrypoint.sh && chmod +x /entrypoint.sh

# Provenance label (lifecycle row 11; research-workbench P1a acceptance 11).
# The deploy door (scripts/stack/ob1-deploy.ps1) builds with
# --build-arg OB1_SHA=<the parent's OB1 gitlink> and refuses a dirty build
# context; test/p1a-env.sh build passes `git -C OB1 rev-parse HEAD`. A hand
# `docker build` without it leaves the label EMPTY (and the door says so).
# Last, so a new commit does not invalidate the cached layers above.
ARG OB1_SHA=
LABEL org.opencontainers.image.revision="$OB1_SHA"

# HEALTH (research-workbench P1b): healthy = /__health answers 200 - the
# database is up, the files-vs-rows reconciliation ran with zero drift, no page
# class is broken and no render failed (serve.mjs health()). The SAME command
# is the compose healthcheck (docker-compose.yml openbrain-wiki-viewer); it is
# here too so a plain `docker run` of the image (the test environments) carries
# it. start-period covers the first reconciliation of a large vault.
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/__health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"]

# 8080: pages; 8082: the nav worker (lib/nav-worker.mjs) the workbench's
# /workbench/nav forwards to (internal network only, never published).
EXPOSE 8080 8082
ENTRYPOINT ["/entrypoint.sh"]
