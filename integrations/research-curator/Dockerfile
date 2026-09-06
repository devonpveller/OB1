FROM denoland/deno:2.3.3

# Provenance label. The ai-stack deploy door (scripts/stack/ob1-deploy.ps1) builds
# with --build-arg OB1_SHA=<the parent repo's OB1 gitlink> so `docker inspect` can
# say which OB1 commit a running image was built from - the operator compares the
# label to the pin instead of trusting a tag. The arg is OPTIONAL: a plain
# `docker build` (gate 5d, a hand build) still succeeds and leaves the label empty.
ARG OB1_SHA=
LABEL org.opencontainers.image.revision="$OB1_SHA"

WORKDIR /app

# Cache dependencies
COPY deno.json ./
RUN deno install

# Server source + operator-run one-time scripts (backfill, consolidation).
#
# Copy the whole module set rather than listing files. An explicit list drifts
# silently: `pool.ts` (the ResilientPool, curator2) was added to the source and
# imported by index.ts, but never added here, so the image shipped without it
# and crash-looped on "Module not found file:///app/pool.ts" the next time it
# was rebuilt - the same drift that hit research-service (`contract.ts`,
# `skeptic.ts`). Tests are stripped rather than never-copied, so a new module
# ships automatically and a new test still does not.
COPY *.ts ./
RUN rm -f ./*.test.ts

# Fail the BUILD on a missing or mistyped module instead of discovering it as a
# restart loop in production. This is the check that would have caught the above.
RUN deno check index.ts

USER deno

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "index.ts"]
