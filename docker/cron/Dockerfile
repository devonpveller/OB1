# openbrain-cron — minimal alpine + supercronic + curl image.
#
# Reads /etc/openbrain-crontab and fires the configured jobs on
# schedule via curl against the obnet-internal /run endpoints of each
# scheduled service. No Docker socket, no privileged caps, runs as
# uid=1000.
#
# Supercronic is cron-syntax-compatible but designed for containers:
# logs to stdout, no daemon assumptions, exits cleanly on SIGTERM.

FROM alpine:3.20

# Pin to a known supercronic release. Bumping is a SHA update + version
# bump together; never bump one without the other.
ARG SUPERCRONIC_VERSION=0.2.33
ARG SUPERCRONIC_SHA1SUM=71b0d58cc53f6bd72cf2f293e09e294b79c666d8

RUN apk add --no-cache curl ca-certificates tini \
 && wget -O /usr/local/bin/supercronic \
        "https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
 && echo "${SUPERCRONIC_SHA1SUM}  /usr/local/bin/supercronic" | sha1sum -c - \
 && chmod +x /usr/local/bin/supercronic

COPY crontab /etc/openbrain-crontab

# Drop root — cron jobs are plain curl calls, nothing needs uid=0.
# alpine already ships a 'cron' user (uid 16), so use a distinct name.
RUN adduser -D -u 1000 supercron
USER supercron

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["supercronic", "/etc/openbrain-crontab"]
