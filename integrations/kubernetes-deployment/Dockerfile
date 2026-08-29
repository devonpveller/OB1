FROM denoland/deno:2.3.3

WORKDIR /app

# Copy dependency manifest and cache dependencies
COPY deno.json ./
RUN deno install

# Copy server source. The agent-memory module is a SEPARATE file on purpose (the start of
# the modular split), so it needs its own COPY - a Dockerfile that imports a file it never
# copies fails at container start, not at build.
COPY index.ts ./
COPY agent-memory.ts agent-memory-policy.ts ./

# Run as non-root
USER deno

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "index.ts"]
