FROM node:22-alpine

# git: D16 local commit-per-compile of the wiki volume.
# openssh-client: optional private-remote push (deploy key over SSH).
# tzdata: so TZ=America/New_York resolves (Alpine has no zone data by
# default) — makes the daily compile hour the user's local time.
RUN apk add --no-cache git openssh-client tzdata

WORKDIR /app
COPY wiki-service.mjs ./

# generate-wiki.mjs is bind-mounted read-only at /recipes (compose).
# The wiki volume mounts at /wiki (content + .git live there).
EXPOSE 8000

CMD ["node", "wiki-service.mjs"]
