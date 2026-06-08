#!/bin/sh
set -e

# Quartz renders the WHOLE vault: generated `content/` + hand-written
# `notes/` + the vault-root `index.md` home, so cross-layer [[wikilinks]]
# resolve. A single directory symlink means Quartz reads the real /wiki dir.
rm -rf /quartz/content
ln -sfn /wiki /quartz/content

# Don't let Quartz scan .git / build caches / local state (live git lock files
# crash a build mid-commit). `.git/**` glob is required (not just `.git`).
sed -i 's#ignorePatterns: \[[^]]*\]#ignorePatterns: ["private", "templates", ".obsidian", ".git", ".git/**", "**/.git/**", ".quartz-cache", "public", "node_modules", ".wikistate.json"]#' \
  /quartz/quartz.config.ts

# Disable CustomOgImages emitter (ZWJ-emoji codepoints crash the whole build →
# viewer crash-loop). Pointless for a private gated wiki. Idempotent.
sed -i 's#^\([[:space:]]*\)Plugin.CustomOgImages(),#\1// Plugin.CustomOgImages(), // DISABLED: ZWJ-emoji codepoint crashes emit#' \
  /quartz/quartz.config.ts

# ── Availability rework (Research Engine feedback #3) ───────────────────────
# OLD: `quartz build --serve` served on :8080 AND rebuilt on every /wiki change,
# so a burst of research-source ingestion kept the viewer in near-constant
# rebuild and readers hit a splash / unavailability.
# NEW (two-stage): the SAME proven `quartz build --serve` runs as an INTERNAL
# builder/watcher on :8081 (dev mode — incremental + no minify, so it keeps
# working freely as the compiler churns). A tiny static server serves the last
# GOOD build on :8080 from the /srv/current symlink, which we re-point to a fresh
# snapshot ONLY when (a) the build output has settled AND (b) the viewer is idle
# (no requests for IDLE_SECONDS). The builder never stops; the reader always gets
# a complete build instantly and the swap lands invisibly while no one is looking.
#
# (We keep --serve rather than a one-shot `quartz build` because production build
# minifies the bundled component JS and the workbench overlay inline scripts trip
# esbuild's minifier; --serve/dev mode skips minify and is the proven path.)
IDLE_SECONDS="${WIKI_REBUILD_IDLE_SECONDS:-90}"    # viewer must be quiet this long before a swap
STABLE_SECONDS="${WIKI_REBUILD_STABLE_SECONDS:-8}" # build output must be unchanged this long (build finished)
POLL="${WIKI_REBUILD_POLL_SECONDS:-15}"            # how often to check
BUILD_PORT="${WIKI_BUILD_PORT:-8081}"

# On a cold stack the compiler may not have produced pages yet; Quartz errors on
# empty content, so wait (bounded) for the home page before starting the builder.
i=0
while [ "$i" -lt 60 ]; do
  if [ -f /wiki/index.md ] || ls /wiki/content/*.md >/dev/null 2>&1; then
    echo "[wiki-viewer] vault present, starting builder"; break
  fi
  echo "[wiki-viewer] waiting for first compile... ($i)"; i=$((i + 1)); sleep 10
done

# Stage 1 — the internal builder/watcher (proven dev build; emits /quartz/public).
npx quartz build --serve --port "$BUILD_PORT" &
BUILD_PID=$!

# Wait (bounded) for the first emitted build. Generous — a large vault's first
# build can take several minutes; we want a COMPLETE first snapshot.
i=0
while [ "$i" -lt 240 ]; do
  [ -f /quartz/public/index.html ] && { echo "[wiki-viewer] first build emitted"; break; }
  sleep 2; i=$((i + 1))
done

# Initial snapshot + always-available static server (Stage 2).
mkdir -p /srv
rm -rf /srv/build-0; cp -a /quartz/public /srv/build-0
ln -sfn /srv/build-0 /srv/current
echo 0 > /tmp/last-access
node /serve.mjs &
SERVE_PID=$!
trap 'kill "$BUILD_PID" "$SERVE_PID" 2>/dev/null; exit 0' TERM INT

# Idle-gated snapshot loop.
marker=/tmp/last-snap; touch "$marker"
N=0
while true; do
  sleep "$POLL"
  # Anything new in the build output since our last snapshot?
  changed=$(find /quartz/public -type f -newer "$marker" 2>/dev/null | head -1)
  [ -z "$changed" ] && continue
  now=$(date +%s)
  # Has the build output SETTLED (no writes in the last STABLE_SECONDS)? If the
  # builder is mid-rebuild, wait — never snapshot a half-written site.
  newest=$(find /quartz/public -type f -printf '%T@\n' 2>/dev/null | sort -nr | head -1 | cut -d. -f1)
  [ -n "$newest" ] && [ $((now - newest)) -lt "$STABLE_SECONDS" ] && continue
  # Is the viewer idle? If a reader is active, defer the swap (don't yank content).
  la=$(cat /tmp/last-access 2>/dev/null || echo 0)
  if [ $((now - la)) -lt "$IDLE_SECONDS" ]; then
    echo "[wiki-viewer] new build ready; viewer active ($((now - la))s < ${IDLE_SECONDS}s idle) — deferring swap"
    continue
  fi
  N=$((N + 1))
  rm -rf "/srv/build-$N.tmp" && cp -a /quartz/public "/srv/build-$N.tmp" \
    && rm -rf "/srv/build-$N" && mv "/srv/build-$N.tmp" "/srv/build-$N"
  ln -sfn "/srv/build-$N" /srv/current     # atomic swap; in-flight reads keep the old dir
  rm -rf "/srv/build-$((N - 2))"           # keep current + one previous
  touch "$marker"
  echo "[wiki-viewer] viewer idle — snapshot #$N swapped live"
done
