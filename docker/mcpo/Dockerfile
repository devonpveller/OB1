# openbrain-mcpo:local - the pinned mcpo image with ONE change: anyio 4.14.2.
#
# Why: mcpo v0.0.20 (the newest release; :latest and :main are this digest on
# 2026-10-05) ships anyio 4.12.1. After an upstream fault on a streamable-http
# session (a 502, a SIGKILLed upstream, or an upstream that is down when mcpo
# starts) anyio's CancelScope._deliver_cancellation keeps rescheduling itself
# for a task that is already done and pins one core at 100% for good
# (open-webui/mcpo#302 -> agronholm/anyio#1111, fixed in anyio 4.14.x). The
# disposable rig in ./repro reproduces it on the stock digest and shows this
# image idle under the same triggers.
#
# What it does NOT change: the base's entrypoint (mcpo), CMD, working dir,
# env, user (root, as upstream) and its absence of a HEALTHCHECK (compose
# supplies one). Only anyio moves; ./repro/repro_spin.py `resolution` prints
# the installed-distribution diff against the stock digest.
#
# Drop this layer when an mcpo release ships anyio >= 4.14.2: point both
# services back at that release's digest and rerun ./repro (the stock image
# must come out IDLE on all three triggers).
#
# Build from the digest, never a tag. Both services share this one image, so
# deploy it through the ai-stack door (SERVICE-LIFECYCLE row 11) once:
#   scripts/stack/ob1-deploy.ps1 -Service openbrain-mcpo -Recreate openbrain-mcpo-ext
# It builds with --build-arg OB1_SHA=<gitlink> and recreates only those two.
FROM ghcr.io/open-webui/mcpo@sha256:1e82c9555c19e50b80745705f32b47a2647589f35279527b5118ecd3a71bd467

# Provenance (lifecycle row 11). This REPLACES the base's
# org.opencontainers.image.revision (mcpo's 788ff92e), which the door would
# otherwise read as a pin MISMATCH; mcpo's revision is kept below under
# ai-stack.mcpo.upstream-revision. A hand `docker build` leaves it empty.
ARG OB1_SHA=
LABEL org.opencontainers.image.revision="$OB1_SHA"

COPY requirements-anyio.txt /tmp/requirements-anyio.txt
RUN uv pip install --python /app/.venv/bin/python --no-cache --no-deps --require-hashes \
        -r /tmp/requirements-anyio.txt \
    && uv pip check --python /app/.venv/bin/python \
    && /app/.venv/bin/python -c "import importlib.metadata as m; v = m.version('anyio'); assert v == '4.14.2', v" \
    && rm /tmp/requirements-anyio.txt

LABEL ai-stack.mcpo.anyio="4.14.2" \
      ai-stack.mcpo.upstream-revision="788ff92e5288a899a743a252edd5748f4ad4ab1f" \
      ai-stack.mcpo.base="ghcr.io/open-webui/mcpo@sha256:1e82c9555c19e50b80745705f32b47a2647589f35279527b5118ecd3a71bd467"
