# The wiki viewer (research-workbench P1a-P1c): the LIVE RENDERER only.
#
# Every page is presented from wiki_pages by serve.mjs (D13); the client
# bundle and the static chrome are FROZEN repo files (D7, settled 2026-09-25):
#   bundle/                 index.css, prescript.js, postscript.js, static/**
#   lib/chrome-static.mjs   the static Quartz chrome fragments
#   bundle.sha256           their sha256 (served bytes == committed bytes)
# emitted once by the Quartz freeze tool (freeze/, run by hand, never by a
# build or a deploy). This image has NO Quartz: no clone, no patch step, no
# builder, no watcher, no snapshot loop, no nightly rebuild, no Quartz entry
# in package.json - only the renderer's own runtime dependencies, pinned by
# package-lock.json to the exact versions the frozen bundle was built with.
FROM node:22-slim

WORKDIR /viewer
COPY package.json package-lock.json /viewer/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY serve.mjs /viewer/serve.mjs
COPY lib /viewer/lib
# The compile half of the page-class registry and the files-vs-rows
# reconciler are SHARED with the compiler (research-workbench P1a, D13 item 4).
# They come from OB1/recipes/_shared through the named build context
# `recipes` (compose: build.additional_contexts; by hand:
# docker build --build-context recipes=OB1/recipes ...).
COPY --from=recipes _shared/page-classes.mjs _shared/wiki-pages.mjs _shared/links.mjs _shared/reconcile-wiki-pages.mjs _shared/structural-ledger.mjs _shared/quartz-slug.mjs /viewer/lib/shared/
# The frozen client bundle: copied, never built here.
COPY bundle /viewer/bundle
COPY bundle.sha256 THIRD-PARTY-NOTICES.md /viewer/
# The committed SYNTHETIC fixture vault: the live-render unit test renders its rows.
COPY test/fixtures/vault /viewer/test/fixtures/vault

# Build gates:
# 1. the shipped bundle + chrome are byte-equal to the committed manifest;
# 2. every dependency the renderer leans on resolves (package-lock.json);
# 3. the renderer, chrome, registry, DB-state and nav unit tests.
RUN set -e; cd /viewer; \
  sha256sum -c --quiet bundle.sha256; \
  node -e "await Promise.all(['unified','remark-parse','remark-gfm','remark-frontmatter','remark-rehype','remark-smartypants','remark-math','rehype-raw','rehype-pretty-code','rehype-slug','rehype-autolink-headings','rehype-katex','mdast-util-find-and-replace','mdast-util-to-hast','mdast-util-to-string','hast-util-to-html','hast-util-to-string','hast-util-to-jsx-runtime','hast-util-from-html','preact','preact-render-to-string','unist-util-visit','github-slugger','is-absolute-url','reading-time'].map(m=>import(m)))"; \
  node --test lib/*.test.mjs

# Provenance label (lifecycle row 11). The deploy door
# (scripts/stack/ob1-deploy.ps1) builds with --build-arg OB1_SHA=<the parent's
# OB1 gitlink>; test/p1a-env.sh build passes `git -C OB1 rev-parse HEAD`.
# Last, so a new commit does not invalidate the cached layers above.
ARG OB1_SHA=
LABEL org.opencontainers.image.revision="$OB1_SHA"

# HEALTH: healthy = /__health answers 200 - the site index is warm, the
# database is up, the files-vs-rows reconciliation ran with zero drift, no
# page class is broken and no render failed (serve.mjs health()). The SAME
# command is the compose healthcheck (docker-compose.yml openbrain-wiki-viewer).
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/__health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"]

# 8080: pages; 8082: the nav worker (lib/nav-worker.mjs) the workbench's
# /workbench/nav forwards to (internal network only, never published).
EXPOSE 8080 8082
# node is PID 1: serve.mjs exits on SIGTERM/SIGINT itself (no shell wrapper).
ENTRYPOINT ["node", "--max-semi-space-size=64", "/viewer/serve.mjs"]
