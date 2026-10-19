FROM denoland/deno:2.3.3

# Provenance label (research-workbench P0). The ai-stack deploy door (scripts/stack/ob1-deploy.ps1)
# builds with --build-arg OB1_SHA=<the parent repo's OB1 gitlink> so `docker inspect` can say
# which OB1 commit a running image was built from. OPTIONAL: a plain `docker build` still
# succeeds and leaves the label empty. Same two lines as research-curator's Dockerfile.
ARG OB1_SHA=
LABEL org.opencontainers.image.revision="$OB1_SHA"

# git: the workbench commits notes + the Changes log into the vault repo (P3 /
# the G1 exception). The Deno base image doesn't ship it.
# pandoc + weasyprint: the note exporter (P3.5) converts markdown → DOCX/HTML/
# PDF/ODT/EPUB locally (no network). weasyprint is pandoc's PDF engine (HTML/CSS
# based — avoids a full TeX install; wkhtmltopdf was dropped from Debian).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates pandoc weasyprint \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency manifest, lockfile and import map first (better layer caching). The lockfile pins
# every jsr/npm/remote module to the version its licence was verified at (D9 rule 6).
COPY deno.json deno.lock ./
COPY THIRD-PARTY-NOTICES.md ./
COPY src ./src

# Pre-cache the deps actually imported by the entrypoint (hono, postgres).
# The "@shared/slug" map points at a RUNTIME bind-mount (/recipes/_shared) and
# is only imported by later phases, so it is not resolvable at build time —
# `|| true` keeps the build green; runtime resolves it from the mount.
RUN deno cache src/main.ts || true
# The retrieval contract and its tests import nothing from the runtime mount, so they cache
# FROZEN: a dependency that drifted from deno.lock fails the build.
RUN deno cache --frozen src/contracts/app.ts src/contracts/gen.ts src/contracts/integration_test.ts   src/contracts/references_integration_test.ts src/contracts/migrate-references.ts

# Build gate (wiki-dynamic-index P3): pure-logic tests run at image build so a
# regression cannot ship silently - mirrors the wiki-service image, which runs
# lib/entity-links.test.mjs. Only tests that need no DB/network AND no
# "@shared/*" import (the /recipes mount exists only at runtime) can run here —
# which is why pure note parsing lives in src/util/, not repositories/.
# research-workbench P0 adds src/contracts/: the document coverage, the registry rule, every
# example against its schema, the generated artifacts current, the notices check (D9 rule 5).
# Its integration test is skipped here (no CONTRACT_TEST_DB_HOST); run-contract-tests.ps1 runs it.
RUN deno test --allow-net --allow-env --allow-read src/routes/search_test.ts src/routes/graph_test.ts src/routes/nav_test.ts src/util/ src/contracts/

# Runs as root: the workbench WRITES the shared vault (notes, the Changes log,
# and image assets under /wiki/assets), which the root-running wiki-service
# owns. A non-root user can't write that root-owned volume. The workbench does
# not parse untrusted files (that's the sandboxed openbrain-extract sidecar), so
# root here is the low-risk way to share the vault. It is internal-only (behind
# Caddy + Authelia, never host-published except the loopback debug port).

EXPOSE 8000

# --allow-read/write: vault notes + wiki-assets (P3/P5). --allow-run: `git`
# commit in the vault repo (P3). --allow-net/env: DB, REST, embeddings, extract.
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-run", "src/main.ts"]
