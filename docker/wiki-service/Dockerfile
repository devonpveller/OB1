FROM node:22-alpine

# git: D16 local commit-per-compile of the wiki volume.
# openssh-client: optional private-remote push (deploy key over SSH).
# tzdata: so TZ=America/New_York resolves (Alpine has no zone data by
# default) - the service's log times and commit dates read as local time.
RUN apk add --no-cache git openssh-client tzdata

WORKDIR /app
COPY wiki-service.mjs ./
COPY lib ./lib
# Build gate: the planner/sweep consistency invariant (lib/entity-links.mjs)
# is unit-tested at image build — a regression cannot ship silently.
RUN node --test ./lib/entity-links.test.mjs ./lib/drain-supervisor.test.mjs ./lib/outage-notify.test.mjs ./lib/vault-gitignore.test.mjs ./lib/staged-sweep.test.mjs

# generate-wiki.mjs is bind-mounted read-only at /recipes (compose).
# The wiki volume mounts at /wiki (content + .git live there).
EXPOSE 8000

# Provenance label (SERVICE-LIFECYCLE row 11; research-workbench P1c): the deploy
# door (scripts/stack/ob1-deploy.ps1) builds with --build-arg OB1_SHA=<the
# parent's OB1 gitlink>. Last, so a new commit does not invalidate the layers above.
ARG OB1_SHA=
LABEL org.opencontainers.image.revision="$OB1_SHA"

CMD ["node", "wiki-service.mjs"]
