FROM denoland/deno:2.3.3

WORKDIR /app

# Cache dependencies
COPY deno.json ./
RUN deno install

# Server source (globbed so refetch-policy.ts ships; tests removed)
COPY *.ts ./
RUN rm -f *.test.ts

USER deno

EXPOSE 8000

# --unstable-net: Deno.createHttpClient({ proxy }) for the Tor egress (D10).
CMD ["deno", "run", "--unstable-net", "--allow-net", "--allow-env", "index.ts"]
