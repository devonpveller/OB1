FROM denoland/deno:2.3.3

WORKDIR /app

# Dependency manifest + import map first (better layer caching).
COPY deno.json ./
COPY src ./src

# Pre-cache the deps actually imported by the entrypoint (hono, postgres).
# The "@shared/slug" map points at a RUNTIME bind-mount (/recipes/_shared) and
# is only imported by later phases, so it is not resolvable at build time —
# `|| true` keeps the build green; runtime resolves it from the mount.
RUN deno cache src/main.ts || true

USER deno

EXPOSE 8000

# --allow-read/write: vault notes + wiki-assets (P3/P5). --allow-run: `git`
# commit in the vault repo (P3). --allow-net/env: DB, REST, embeddings, extract.
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-run", "src/main.ts"]
