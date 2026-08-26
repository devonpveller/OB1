FROM denoland/deno:2.3.3

# git: the workbench commits notes + the Changes log into the vault repo (P3 /
# the G1 exception). The Deno base image doesn't ship it.
# pandoc + weasyprint: the note exporter (P3.5) converts markdown → DOCX/HTML/
# PDF/ODT/EPUB locally (no network). weasyprint is pandoc's PDF engine (HTML/CSS
# based — avoids a full TeX install; wkhtmltopdf was dropped from Debian).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates pandoc weasyprint \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency manifest + import map first (better layer caching).
COPY deno.json ./
COPY src ./src

# Pre-cache the deps actually imported by the entrypoint (hono, postgres).
# The "@shared/slug" map points at a RUNTIME bind-mount (/recipes/_shared) and
# is only imported by later phases, so it is not resolvable at build time —
# `|| true` keeps the build green; runtime resolves it from the mount.
RUN deno cache src/main.ts || true

# Build gate (wiki-dynamic-index P3): pure-logic tests run at image build so a
# regression cannot ship silently - mirrors the wiki-service image, which runs
# lib/entity-links.test.mjs. Only tests that need no DB/network run here;
# anything requiring a live pool is exercised against the running stack.
RUN deno test --allow-net --allow-env --allow-read src/routes/search_test.ts src/util/

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
