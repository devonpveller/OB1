FROM denoland/deno:2.3.3

WORKDIR /app

# Cache dependencies
COPY deno.json ./
RUN deno install

# Server source + harness modules.
#
# Copy the whole module set rather than listing files. An explicit list drifts
# silently: `contract.ts` (Phase 1) and `skeptic.ts` (Phase 2) were added to the
# source and imported by index.ts/harness.ts, but never added here, so the image
# shipped without them and crash-looped on "Module not found" the next time it
# was rebuilt. Tests are stripped rather than never-copied, so a new module
# ships automatically and a new test still does not.
COPY *.ts ./
RUN rm -f ./*.test.ts

# Fail the BUILD on a missing or mistyped module instead of discovering it as a
# restart loop in production. This is the check that would have caught the above.
RUN deno check index.ts

USER deno

EXPOSE 8000

# --unstable-net: required for Deno.createHttpClient({proxy}) — page fetches
# egress through the Tor SOCKS proxy (socks5h://tor:9050) for privacy.
CMD ["deno", "run", "--unstable-net", "--allow-net", "--allow-env", "index.ts"]
