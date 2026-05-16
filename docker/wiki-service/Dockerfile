FROM node:22-alpine

# git: D16 local commit-per-compile of the wiki volume.
RUN apk add --no-cache git

WORKDIR /app
COPY wiki-service.mjs ./

# generate-wiki.mjs is bind-mounted read-only at /recipes (compose).
# The wiki volume mounts at /wiki (content + .git live there).
EXPOSE 8000

CMD ["node", "wiki-service.mjs"]
