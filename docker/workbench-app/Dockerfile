# The research workbench app (rwr-app-scaffold): a Vite + React 19 app and the small Node server
# (serve.mjs) that serves it and forwards /workbench/* to the workbench. Image: openbrain-workbench-app.
#
# Build (the named context `viewerlib` is the wiki viewer's lib/ directory - the ONE home of the
# /workbench/* forwarder and the security headers; this image copies those files, it does not fork them):
#   docker build --build-context viewerlib=OB1/docker/wiki-viewer/lib -t openbrain-workbench-app:<tag> OB1/docker/workbench-app
#
# Stage `build` is the gate: type check, the app's unit tests, the third-party notices check, the serve.mjs
# tests, and the viewer's OWN forwarder + security-header tests run against the shared files as copied here.
# Any failure fails the image build. Only dist/ and the two shared modules reach the runtime image.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# rwr-picker: PICKER_HARNESS=1 also builds /picker-harness.html (the picker's dev-only test page); the default image has none.
ARG PICKER_HARNESS=
ENV PICKER_HARNESS=$PICKER_HARNESS
# rwr-flag-buttons: FLAG_HARNESS=1 also builds /flag-harness.html (dev-only: the flags list with its link-back builder); the default image has none.
ARG FLAG_HARNESS=
ENV FLAG_HARNESS=$FLAG_HARNESS
# a loaded host can starve the vitest workers ("Timeout calling onTaskUpdate"): --build-arg VITEST_ARGS=--maxWorkers=2 runs the same suite on fewer workers
ARG VITEST_ARGS=
COPY --from=viewerlib workbench-proxy.mjs security-headers.mjs workbench-proxy.test.mjs security-headers.test.mjs /app/lib/shared/
RUN set -e; \
  npx tsc --noEmit; \
  npx vitest run $VITEST_ARGS; \
  node scripts/notices.mjs --check; \
  node --test test/*.test.mjs lib/shared/*.test.mjs; \
  npm run build; \
  test -s dist/index.html; \
  test -s dist/assets/THIRD-PARTY-NOTICES.txt

FROM node:22-slim
WORKDIR /app
COPY serve.mjs /app/serve.mjs
COPY --from=build /app/lib/shared/workbench-proxy.mjs /app/lib/shared/security-headers.mjs /app/lib/shared/
COPY --from=build /app/dist /app/dist
COPY THIRD-PARTY-NOTICES.md /app/

# Provenance label (lifecycle row 11), as the viewer's image carries it.
ARG OB1_SHA=
LABEL org.opencontainers.image.revision="$OB1_SHA"

USER node
# healthy = /__health answers 200 (the build is present)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/__health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"]
EXPOSE 8080
# node is PID 1: serve.mjs exits on SIGTERM/SIGINT itself
ENTRYPOINT ["node", "/app/serve.mjs"]
