# openbrain-podcast (research-workbench P7a): the Deno runtime the chain already ran on
# (denoland/deno:alpine, now pinned) plus Alpine's ffmpeg package, run as a SEPARATE, UNMODIFIED
# process by src/podcast/ffmpeg.ts (D9). The recipe source is still bind-mounted at /app by
# compose; the image adds only the binary.
#
#   docker build -t openbrain-podcast:<tag> --build-arg OB1_SHA=$(git -C OB1 rev-parse HEAD) OB1/recipes/daily-digest
#
# The build gate (stage `test`) runs the podcast unit tests and the notices check: an ffmpeg build
# configured with --enable-nonfree, or a notices file without the ffmpeg / Kokoro-FastAPI rows,
# fails the build.
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
      src/podcast/podcast-audio.test.ts src/podcast/notices_test.ts src/on-capture/on-capture.test.ts \
 && PODCAST_REQUIRE_FFMPEG=1 deno test --allow-all src/podcast/chain-audio.e2e.test.ts  && echo "podcast image gate: OK"

FROM runtime
