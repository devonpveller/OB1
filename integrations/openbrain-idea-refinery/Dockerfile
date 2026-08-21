FROM denoland/deno:2.3.3

WORKDIR /app

# Cache dependencies
COPY deno.json ./
RUN deno install

# Server source
COPY index.ts ./

USER deno

EXPOSE 8080

CMD ["deno", "run", "--allow-net", "--allow-env", "index.ts"]
