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
COPY injection.ts ./

USER deno

EXPOSE 8000

# --unstable-net: required for Deno.createHttpClient({proxy}) — page fetches
# egress through the Tor SOCKS proxy (socks5h://tor:9050) for privacy.
CMD ["deno", "run", "--unstable-net", "--allow-net", "--allow-env", "index.ts"]
