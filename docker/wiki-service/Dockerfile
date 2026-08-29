FROM node:22-alpine

# git: D16 local commit-per-compile of the wiki volume.
# openssh-client: optional private-remote push (deploy key over SSH).
# tzdata: so TZ=America/New_York resolves (Alpine has no zone data by
# default) — makes the daily compile hour the user's local time.
RUN apk add --no-cache git openssh-client tzdata

WORKDIR /app
COPY wiki-service.mjs ./
COPY lib ./lib
# Build gate: the planner/sweep consistency invariant (lib/entity-links.mjs)
# is unit-tested at image build — a regression cannot ship silently.
RUN node --test ./lib/entity-links.test.mjs ./lib/drain-supervisor.test.mjs

# generate-wiki.mjs is bind-mounted read-only at /recipes (compose).
# The wiki volume mounts at /wiki (content + .git live there).
EXPOSE 8000

CMD ["node", "wiki-service.mjs"]
