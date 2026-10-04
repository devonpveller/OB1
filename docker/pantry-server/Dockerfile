# openbrain-pantry - HTTP service for the household pantry (pantry-core).
# Same toolchain as ../extensions-server (Deno + hono + deno.land/x/postgres).
# DENO_IMAGE is an ARG only so a test build can use a base already on the host;
# the default is the tag extensions-server pins.
ARG DENO_IMAGE=denoland/deno:2.3.3
FROM ${DENO_IMAGE}

WORKDIR /app

COPY deno.json ./
# Cache the dependencies in the image (dev tests import @std/assert too).
RUN deno install

COPY src ./src
RUN deno cache src/main.ts

USER deno

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["deno", "eval", "const r = await fetch('http://127.0.0.1:' + (Deno.env.get('PORT') || '8000') + '/health'); Deno.exit(r.ok ? 0 : 1)"]

CMD ["deno", "run", "--allow-net", "--allow-env", "src/main.ts"]
