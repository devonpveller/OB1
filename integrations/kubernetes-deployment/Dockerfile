FROM denoland/deno:2.3.3

WORKDIR /app

# Copy dependency manifest and cache dependencies
COPY deno.json ./
RUN deno install

# Copy server source. GLOBBED, not listed.
#
# The list said it out loud - "a Dockerfile that imports a file it never copies fails at
# container start, not at build" - and then went stale anyway: the review modules landed
# and were not in it, so the ops entrypoint would have died on first start with a missing
# import, after a build that succeeded. A list that has to be edited to stay true
# eventually stops being true, and this one names the consequence in its own comment.
#
# Tests are removed rather than never copied, so the glob needs no exceptions and no
# test file ships in the image.
COPY *.ts ./
RUN rm -f *.test.ts

# Run as non-root
USER deno

EXPOSE 8000

# The default entrypoint is the agent-facing MCP server. The ops door runs from the SAME
# image with a different command (see the openbrain-memory-ops service) - one image, two
# processes, so they can never drift to different versions of the review policy.
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "index.ts"]
