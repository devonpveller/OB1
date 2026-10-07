FROM denoland/deno:2.3.3

WORKDIR /app

# Cache dependencies
COPY deno.json ./
RUN deno install

# Server source. GLOBBED, not listed, then type-checked (the research-curator model).
#
# A listed COPY drifts silently: a module added to the source and imported by index.ts
# but never added here ships an image that builds and then crash-loops on "Module not
# found" at container start - the defect that hit research-service and research-curator.
# Tests are stripped rather than never-copied, so a new module ships automatically and
# a new test still does not.
COPY *.ts ./
RUN rm -f ./*.test.ts

# Fail the BUILD on a missing or mistyped module instead of discovering it as a
# restart loop in production.
RUN deno check index.ts

USER deno

EXPOSE 8000

# --unstable-net: Deno.createHttpClient({ proxy }) for the Tor egress (D10).
CMD ["deno", "run", "--unstable-net", "--allow-net", "--allow-env", "index.ts"]
