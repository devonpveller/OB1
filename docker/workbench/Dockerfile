# openbrain-workbench. Stages:
#   tools    fetches the pinned pandoc and Typst release archives (sha256-checked) and unpacks them
#   base     the runtime: Deno, git, pandoc, Typst, the CJK fonts, the manifest and the styles (no source)
#   app      base + the whole source tree (tests included) and its dependency cache
#   app-src  the source tree the service runs: app's src without *_test.ts and the test oracle
#            (rw-p6a-followups: the runtime image ships no test and no oracle)
#   test     app: the build test gate (poppler-utils - pdftoppm/pdftotext/pdffonts/pdfinfo - comes from
#            base since P6b). The runtime stage copies its marker, so the gate cannot be skipped.
#   parity   test + WeasyPrint: the P6a parity fixture (Typst vs the retired WeasyPrint path). Built
#            only on request (`docker build --target parity`), never shipped.
#   runtime-deps  base + app-src, and the dependency cache of the RUNTIME module graph only (round 2:
#            app's cache held transpiled tests, /deno-dir/gen/.../*_test.ts.js)
#   runtime  (the default target) base + runtime-deps' source, lockfile and cache + the gate marker.

FROM denoland/deno:2.3.3 AS tools
# research-workbench P6a: pandoc 3.11 (GPL-2.0-or-later; a SEPARATE PROCESS, never linked - D9) and
# Typst 0.15.1 (Apache-2.0), the upstream release binaries, checked against the sha256 below.
ARG PANDOC_VERSION=3.11
ARG PANDOC_SHA256=37edb3bbcf722f921a009941bf5874e2e0c09263226c9b4a2d980788cb062ab6
ARG TYPST_VERSION=0.15.1
ARG TYPST_SHA256=a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c
RUN apt-get update \
  && apt-get install -y --no-install-recommends xz-utils \
  && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:${PANDOC_SHA256} https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-linux-amd64.tar.gz /tmp/pandoc.tar.gz
ADD --checksum=sha256:${TYPST_SHA256} https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz /tmp/typst.tar.xz
RUN mkdir -p /out/bin /out/doc/typst \
  && tar -xzf /tmp/pandoc.tar.gz -C /tmp \
  && install -m 0755 /tmp/pandoc-${PANDOC_VERSION}/bin/pandoc /out/bin/pandoc \
  && tar -xJf /tmp/typst.tar.xz -C /tmp \
  && install -m 0755 /tmp/typst-x86_64-unknown-linux-musl/typst /out/bin/typst \
  && cp /tmp/typst-x86_64-unknown-linux-musl/LICENSE /tmp/typst-x86_64-unknown-linux-musl/NOTICE /out/doc/typst/

FROM denoland/deno:2.3.3 AS base

# Provenance label (research-workbench P0). The ai-stack deploy door (scripts/stack/ob1-deploy.ps1)
# builds with --build-arg OB1_SHA=<the parent repo's OB1 gitlink> so `docker inspect` can say
# which OB1 commit a running image was built from. OPTIONAL: a plain `docker build` still
# succeeds and leaves the label empty. Same two lines as research-curator's Dockerfile.
ARG OB1_SHA=
LABEL org.opencontainers.image.revision="$OB1_SHA"

# git: the workbench commits notes + the Changes log into the vault repo (P3 /
# the G1 exception). The Deno base image doesn't ship it.
# fonts-noto-cjk (OFL-1.1): the PDF's main face, Noto Serif CJK SC, pan-CJK, so Typst renders
# Chinese, Japanese and Korean text with real glyphs (P6a acceptance 4).
# fonts-noto-color-emoji (OFL-1.1): an emoji face Typst falls back to (rw-p6a-resolve attempt 2: an
# emoji rendered as a tofu box with status 200). A character no installed face covers is refused
# before Typst runs (src/export/glyphs.ts), so a PDF never carries a box.
# fonts-dejavu-core (DejaVu fonts licence, Bitstream Vera based, permissive): Hebrew, Arabic and other
# scripts Typst draws from its own embedded DejaVu Sans Mono - installed so the coverage scan sees
# them too. It came into the TEST stage only through poppler's fontconfig dependency; named here, the
# runtime and test stages carry the same font files (run-export-tests.ps1 checks it).
# The export (P6a) converts markdown to PDF/DOCX/MD/TXT with pandoc --citeproc, locally (no
# network); Typst is pandoc's PDF engine. WeasyPrint, the PDF engine before P6a, is removed: the
# parity fixture passed (see the parity stage).
# research-workbench P6b (rw-p6b-gate): the export verification gate runs on every PDF before it is
# served (src/export/gate.ts), so its programs are in the RUNTIME image:
#   poppler-utils (GPL-2.0-only OR GPL-3.0-only): pdftoppm rasterises the PDF - a SEPARATE, unmodified
#     program run over files, never linked or imported (D9 rule 4); the notices list it with its version.
#   python3 + python3-venv (PSF-2.0): the interpreter of gate/structure.py, a separate process; its
#     libraries, pikepdf (MPL-2.0, unmodified) and pdfplumber (MIT) with their dependencies, go in their
#     own environment /opt/export-gate from gate/requirements.txt - every wheel pinned by version AND
#     hash, binary only, no dependency resolution (--no-deps); pip itself is removed afterwards.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates fonts-noto-cjk fonts-noto-color-emoji fonts-dejavu-core \
     poppler-utils python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*
COPY gate/requirements.txt /tmp/export-gate-requirements.txt
RUN python3 -m venv /opt/export-gate \
  && /opt/export-gate/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --only-binary=:all: --no-deps \
     -r /tmp/export-gate-requirements.txt \
  && /opt/export-gate/bin/pip uninstall -y --disable-pip-version-check pip \
  && rm /tmp/export-gate-requirements.txt \
  && /opt/export-gate/bin/python -I -c "import pikepdf, pdfplumber; print('export gate:', pikepdf.__version__, pdfplumber.__version__)"
COPY --from=tools /out/bin/pandoc /out/bin/typst /usr/local/bin/
# Typst's LICENSE and NOTICE carried through (Apache-2.0 section 4).
COPY --from=tools /out/doc/typst /usr/local/share/doc/typst
ARG PANDOC_VERSION=3.11
ARG TYPST_VERSION=0.15.1
ENV EXPORT_PANDOC_VERSION=${PANDOC_VERSION} EXPORT_TYPST_VERSION=${TYPST_VERSION} EXPORT_CSL_DIR=/app/csl

WORKDIR /app

# Dependency manifest, lockfile and import map first (better layer caching). The lockfile pins
# every jsr/npm/remote module to the version its licence was verified at (D9 rule 6).
COPY deno.json deno.lock ./
COPY THIRD-PARTY-NOTICES.md ./
# the export gate's structure checks (P6b): one Python file, run by the workbench as a separate process
COPY gate ./gate
# The CSL styles, upstream files used unmodified (CC BY-SA 3.0; their sha256 is in the
# citation_styles registry and checked by src/export/export_test.ts).
COPY csl ./csl

FROM base AS app
COPY src ./src

# Pre-cache the deps actually imported by the entrypoint (hono, postgres; rw-p6a-resolve attempt 3 adds
# the export's markdown parser - micromark and the mdast utilities, MIT, pinned in deno.lock and noticed
# in THIRD-PARTY-NOTICES.md - which the frozen step below caches through src/routes/export.ts).
# The "@shared/slug" map points at a RUNTIME bind-mount (/recipes/_shared) and
# is only imported by later phases, so it is not resolvable at build time —
# `|| true` keeps the build green; runtime resolves it from the mount.
RUN deno cache src/main.ts || true
# The retrieval contract and its tests import nothing from the runtime mount, so they cache
# FROZEN: a dependency that drifted from deno.lock fails the build.
RUN deno cache --frozen src/contracts/app.ts src/contracts/gen.ts src/contracts/integration_test.ts   src/contracts/references_integration_test.ts src/documents/documents_integration_test.ts src/contracts/migrate-references.ts src/routes/export.ts src/routes/documents.ts src/export/render_test.ts src/export/prepare_worker.ts

# The tests (every *_test.ts) and the test oracle (src/export/credentials_oracle.ts, imported only by
# resolve2_cost_test.ts) are the test stage's; the runtime copies the source tree from here, so no layer
# of the runtime image holds them (rw-p6a-followups; the review r-rw-p6a2's tester finding 5).
FROM app AS app-src
RUN find src -name '*_test.ts' -delete && rm src/export/credentials_oracle.ts

FROM app AS test
# poppler-utils (GPL): pdftoppm, pdftotext, pdffonts and pdfinfo, run as SEPARATE PROCESSES by the
# export tests to read the PDFs back (glyph coverage, numbering, parity) - installed in base since P6b
# (the verification gate rasterises with pdftoppm at runtime), so the test and runtime stages carry
# the same poppler and the same fonts.
# Build gate (wiki-dynamic-index P3): pure-logic tests run at image build so a
# regression cannot ship silently - mirrors the wiki-service image, which runs
# lib/entity-links.test.mjs. Only tests that need no DB/network AND no
# "@shared/*" import (the /recipes mount exists only at runtime) can run here —
# which is why pure note parsing lives in src/util/, not repositories/.
# research-workbench P0 adds src/contracts/: the document coverage, the registry rule, every
# example against its schema, the generated artifacts current, the notices check (D9 rule 5).
# Its integration test is skipped here (no CONTRACT_TEST_DB_HOST); run-contract-tests.ps1 runs it.
# research-workbench P6a adds src/export/: the resolver (keys, egress, hard failure), the CSL
# styles unmodified, and real renders through pandoc + Typst read back with poppler (numbering,
# CJK glyphs, process separation). parity_fixture.ts runs only in the parity stage.
# research-workbench P6b adds src/export/gate_test.ts: the verification gate over real renders (the
# clipped-table and clean fixtures, the reference list, the roll-up section, pdftoppm as a separate
# program) and the vision pass's routing and schema; src/contracts/notices_test.ts checks the gate's
# Python environment and pdftoppm's version against the notices.
# research-workbench P2b adds src/documents/: the user document grammar and the hub clustering (pure);
# its integration test is skipped here (no DOCS_TEST_BASE); run-workspace-tests.ps1 runs it.
# rw-identity adds src/identity/: the forward-auth config, every check of the outpost's signed token
# (HS256 only), the key ring and the seam's modes (pure), and (rw-identity3) the raw-request-target
# cases over a loopback socket; its integration test is skipped here (no IDENTITY_TEST_BASE).
RUN deno test --allow-net --allow-env --allow-read --allow-write --allow-run src/routes/search_test.ts src/routes/graph_test.ts src/routes/nav_test.ts src/routes/idea_schedule_test.ts src/util/ src/contracts/ src/export/ src/documents/ src/identity/ \
  && touch /app/.test-gate-passed

FROM test AS parity
# WeasyPrint (BSD-3-Clause) - the PDF engine the export used before P6a - only to render the
# parity fixture through the retired path. Never in the runtime image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends weasyprint \
  && rm -rf /var/lib/apt/lists/*
CMD ["deno", "test", "--allow-env", "--allow-read", "--allow-write", "--allow-run", "src/export/parity_fixture.ts"]

# The runtime's dependency cache, built from a source tree that never held a test: only the service's
# entrypoints and its workers are cached, so no test module (nor its transpiled form) is in it.
FROM base AS runtime-deps
COPY --from=app-src /app/src ./src
RUN deno cache src/main.ts || true
RUN deno cache --frozen src/contracts/app.ts src/contracts/gen.ts src/contracts/migrate-references.ts src/routes/export.ts src/routes/documents.ts src/export/prepare_worker.ts src/export/judge_worker.ts

FROM base AS runtime
COPY --from=runtime-deps /app/src ./src
COPY --from=runtime-deps /app/deno.lock ./deno.lock
COPY --from=runtime-deps ${DENO_DIR} ${DENO_DIR}
COPY --from=test /app/.test-gate-passed /app/.test-gate-passed

# Runs as root: the workbench WRITES the shared vault (notes, the Changes log,
# and image assets under /wiki/assets), which the root-running wiki-service
# owns. A non-root user can't write that root-owned volume. The workbench does
# not parse untrusted files (that's the sandboxed openbrain-extract sidecar), so
# root here is the low-risk way to share the vault. It is internal-only (behind
# Caddy + Authelia, never host-published except the loopback debug port).

EXPOSE 8000

# --allow-read/write: vault notes + wiki-assets (P3/P5) + the export's scratch dir. --allow-run:
# `git` commit in the vault repo (P3), `pandoc` for the export (P6a), `pdftoppm` and the gate's Python
# for the verification gate (P6b). --allow-net/env: DB, REST, embeddings, extract, the export's resolver
# (through FETCH_PROXY_URL only), the gate's vision pass (through the LiteLLM alias only).
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-run", "src/main.ts"]
