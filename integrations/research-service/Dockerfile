# ── stage 1: the test gate (research-workbench P3a, rw-p3a-entail) ─────────────
# The image is built only if the offline test suite passes. Until P3a this file
# copied the sources, stripped the tests and only ran `deno check`, so a change
# that broke every replay still produced a deployable image. The suite needs no
# database, model or search engine: DB-backed e2e tests skip themselves without
# DB_* env, `orchestrator.test.ts` is a `deno run` script (excluded in deno.json),
# and the entailment judge, OpenAlex and Crossref are recorded fixtures.
FROM denoland/deno:2.3.3 AS test
WORKDIR /app
COPY deno.json ./
RUN deno install
COPY *.ts ./
COPY fixtures ./fixtures
RUN deno test --allow-net --allow-env --allow-read && touch /app/.tests-passed

# ── stage 2: the runtime image ─────────────────────────────────────────────────
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

# The marker makes this stage DEPEND on the test stage: BuildKit skips a stage
# nothing copies from, and a skipped test stage is a gate that never ran.
COPY --from=test /app/.tests-passed /app/.tests-passed

# Server source + harness modules, the SAME files the test stage passed.
#
# Copy the whole module set rather than listing files. An explicit list drifts
# silently: `contract.ts` (Phase 1) and `skeptic.ts` (Phase 2) were added to the
# source and imported by index.ts/harness.ts, but never added here, so the image
# shipped without them and crash-looped on "Module not found" the next time it
# was rebuilt. Tests (already run above) and fixtures do not ship.
COPY --from=test /app/*.ts ./
RUN rm -f ./*.test.ts

# Fail the BUILD on a missing or mistyped module instead of discovering it as a
# restart loop in production. This is the check that would have caught the above.
RUN deno check index.ts

USER deno

EXPOSE 8000

# --unstable-net: required for Deno.createHttpClient({proxy}) - page fetches and
# the scholarly resolver (OpenAlex / Crossref) egress through FETCH_PROXY_URL,
# the Mullvad HTTP proxy (http://vpn:8888) in compose. Tor was retired 2026-08-21.
CMD ["deno", "run", "--unstable-net", "--allow-net", "--allow-env", "index.ts"]
