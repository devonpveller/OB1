# Read-only Quartz 4 viewer (D15) for the compiled wiki.
# Quartz is fetched at build time (build-time network is fine; the
# "no cloud" rule governs runtime model/data, not image builds — same
# as pulling node:22-alpine). Pinned for reproducibility.
FROM node:22-slim

ARG QUARTZ_REF=v4.5.1
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /quartz
RUN git clone --depth 1 --branch ${QUARTZ_REF} https://github.com/jackyzha0/quartz.git . \
  && npm ci

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
