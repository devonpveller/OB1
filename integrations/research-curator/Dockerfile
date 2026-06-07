FROM denoland/deno:2.3.3

WORKDIR /app

# Cache dependencies
COPY deno.json ./
RUN deno install

# Server source + operator-run one-time scripts (backfill, consolidation)
COPY index.ts ./
COPY claims.ts ./
COPY backfill-thread-embeddings.ts ./
COPY consolidate-threads.ts ./

USER deno

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "index.ts"]
