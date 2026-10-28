#!/usr/bin/env bash
# freeze.sh - the Quartz freeze tool (research-workbench P1c, D7). Offline,
# never part of a deploy; nothing it runs joins a network or publishes a port.
#
#   bash freeze/freeze.sh image                  build openbrain-wiki-quartz-freeze:$FREEZE_TAG
#   bash freeze/freeze.sh bundle                 re-emit ../bundle/ + ../lib/chrome-static.mjs + ../bundle.sha256
#   bash freeze/freeze.sh check                  exit 1 unless the committed assets are byte-equal to what the tool emits
#   bash freeze/freeze.sh reference <vault-vol> <out-vol>   Quartz-build a vault volume into another volume
#   bash freeze/freeze.sh slugcheck <vault-vol> <ref-vol>   quartz-slug-check.mjs (Quartz's own slug + page set)
#
# FREEZE_TAG must start with wt- (default wt-quartz-freeze); FREEZE_NO_BUILD=1
# reuses an image already tagged. The viewer image never runs any of this.
set -euo pipefail
export MSYS_NO_PATHCONV=1
TAG="${FREEZE_TAG:-wt-quartz-freeze}"
case "$TAG" in wt-*) ;; *) echo "[freeze] refusing: FREEZE_TAG must start with wt- (got $TAG)" >&2; exit 2 ;; esac
IMG="openbrain-wiki-quartz-freeze:$TAG"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIEWER="$(cd "$HERE/.." && pwd)"
VIEWER_W="$(cd "$VIEWER" && (pwd -W 2>/dev/null || pwd))"
OB1_W="$(cd "$VIEWER/../.." && (pwd -W 2>/dev/null || pwd))"
log() { printf '[freeze] %s\n' "$*"; }

image() {
  [ -n "${FREEZE_NO_BUILD:-}" ] && docker image inspect "$IMG" >/dev/null 2>&1 && { log "using $IMG as tagged"; return 0; }
  log "building $IMG (Quartz + overlay; minutes)"
  docker build -f "$VIEWER_W/freeze/Dockerfile" -t "$IMG" "$VIEWER_W" >/dev/null
}

emit() { # tar of /out on stdout
  docker run --rm --network none --entrypoint sh "$IMG" -c 'cd /out && tar cf - lib bundle'
}

manifest() { # sha256 of every bundle file + chrome-static.mjs, relative paths, sorted
  (cd "$1" && find bundle -type f | LC_ALL=C sort | xargs sha256sum; sha256sum lib/chrome-static.mjs) | sed "s/ [*]/  /"
}

c="${1:-}"; shift || true
case "$c" in
  image) image ;;
  bundle)
    image
    rm -rf "$VIEWER/bundle"
    emit | tar xf - -C "$VIEWER"
    manifest "$VIEWER" > "$VIEWER/bundle.sha256"
    log "wrote bundle/ ($(find "$VIEWER/bundle" -type f | wc -l) files), lib/chrome-static.mjs, bundle.sha256"
    ;;
  check)
    image
    t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
    emit | tar xf - -C "$t"
    if diff <(manifest "$t") "$VIEWER/bundle.sha256" && diff <(manifest "$VIEWER") "$VIEWER/bundle.sha256"; then
      log "CHECK: PASS (the committed bundle + chrome = what Quartz emits; bundle.sha256 matches the files)"
    else
      log "CHECK: FAIL (see the diff above)"; exit 1
    fi
    ;;
  reference)
    image
    docker run --rm --network none -v "$1:/vault:ro" -v "$2:/ref" --entrypoint sh "$IMG" /quartz/freeze/reference.sh /vault /ref
    ;;
  slugcheck)
    image
    docker run --rm --network none -v "$OB1_W:/ob1:ro" -v "$1:/wiki:ro" -v "$2:/ref:ro" --entrypoint node "$IMG" \
      /quartz/freeze/quartz-slug-check.mjs --vault /wiki --built /ref
    ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
