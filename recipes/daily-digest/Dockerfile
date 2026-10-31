# openbrain-podcast (research-workbench P7a): the Deno runtime the chain already ran on
# (denoland/deno:alpine, now pinned) plus Alpine's ffmpeg package, run as a SEPARATE, UNMODIFIED
# process by src/podcast/ffmpeg.ts (D9). The recipe source is still bind-mounted at /app by
# compose; the image adds only the binary.
#
#   docker build -t openbrain-podcast:<tag> --build-arg OB1_SHA=$(git -C OB1 rev-parse HEAD) OB1/recipes/daily-digest
#
# The build gate (stage `test`) runs the podcast unit tests, the notices check and the chain e2e: an
# ffmpeg build configured with --enable-nonfree, a notices file without the ffmpeg / Kokoro-FastAPI rows,
# or a red test fails the build. The FINAL stage copies the gate's marker out of `test`, so EVERY build
# of the default target - `docker compose build`, ob1-deploy.ps1 - runs the gate (round 2, tester D2;
# the workbench's pattern).
ARG DENO_IMAGE=denoland/deno:alpine-2.9.5
FROM ${DENO_IMAGE} AS runtime
# Alpine 3.24's ffmpeg 8.1.3-r0 (a GPL build: --enable-gpl --enable-version3; no nonfree). Pinned here and in
# THIRD-PARTY-NOTICES.md and checked by src/podcast/notices_test.ts against `ffmpeg -version`.
RUN apk add --no-cache ffmpeg=8.1.3-r0
ARG OB1_SHA=unknown
LABEL org.opencontainers.image.revision=$OB1_SHA \
      org.opencontainers.image.title="openbrain-podcast" \
      org.opencontainers.image.description="Deno + ffmpeg (separate process) for the daily podcast chain"
WORKDIR /app

FROM runtime AS test
COPY . /app
RUN PODCAST_REQUIRE_FFMPEG=1 deno test --allow-read --allow-write --allow-env --allow-run --allow-net=127.0.0.1 \
      src/podcast/podcast-audio.test.ts src/podcast/round2.test.ts src/podcast/notices_test.ts src/on-capture/on-capture.test.ts \
 && PODCAST_REQUIRE_FFMPEG=1 deno test --allow-all src/podcast/chain-audio.e2e.test.ts  && touch /podcast-test-gate-passed && echo "podcast image gate: OK"

FROM runtime
# the default target depends on the gate: no marker, no image
COPY --from=test /podcast-test-gate-passed /podcast-test-gate-passed
