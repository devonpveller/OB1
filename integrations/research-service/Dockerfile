FROM denoland/deno:2.3.3

WORKDIR /app

# Cache dependencies
COPY deno.json ./
RUN deno install

# Server source + harness modules
COPY index.ts ./
COPY harness.ts ./
COPY lib.ts ./
COPY kb.ts ./

USER deno

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "index.ts"]
