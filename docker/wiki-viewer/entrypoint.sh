#!/bin/sh
set -e

# Quartz renders the WHOLE vault: generated `content/` + hand-written
# `notes/` + the vault-root `index.md` home, so cross-layer [[wikilinks]]
# resolve. A single directory symlink means Quartz reads the real /wiki dir.
rm -rf /quartz/content
ln -sfn /wiki /quartz/content

# Don't let Quartz scan .git / build caches / local state (live git lock files
# crash a build mid-commit). `.git/**` glob is required (not just `.git`).
sed -i 's#ignorePatterns: \[[^]]*\]#ignorePatterns: ["private", "templates", ".obsidian", ".git", ".git/**", "**/.git/**", ".quartz-cache", "public", "node_modules", ".wikistate.json", "**/.failed-entity-ids.json", "planned.json"]#' \
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

# A build is COMPLETE only when index.html AND the core ComponentResources
# (styles + client JS) are all present. A crashed / mid-emit build (page HTML but
# no CSS/JS) must NEVER be published — serving it 404s every asset as text/plain
# (the 2026-06-15 wiki-render incident: a racey nightly builder restart hit
# EADDRINUSE :3001, crashed mid-emit, and the asset-less public got snapshotted +
# served). This single gate is the durable fix; the self-heal + port-wait below
# remove the trigger and stop a dead builder from freezing public forever.
is_complete() {
  d="$1"
  [ -f "$d/index.html" ] && [ -f "$d/index.css" ] && \
  [ -f "$d/prescript.js" ] && [ -f "$d/postscript.js" ]
}
# Quartz's search/graph index (static/contentIndex.json) is the LARGEST and
# LAST-written emit (~32MB here). A snapshot cp that races a rebuild captures it
# TORN — truncated mid-string — which the browser fails to parse ("Unterminated
# string in JSON", the 2026-06-16 incident). Guard it: present AND terminated with
# `}`. `tail -c 1` seeks to EOF, so this is cheap even on a 32MB file. If no index
# is emitted (config without ContentIndex) there's nothing to guard → pass.
index_ok() {
  ci="$1/static/contentIndex.json"
  [ -f "$ci" ] || return 0
  [ "$(tail -c 1 "$ci")" = "}" ] || return 1
  # (A 2026-06-16 searchIndex.json split was reverted the same day; the guard
  # below is kept as a harmless no-op for any snapshot that still carries one.
  # The 2026-08-23 index diet works differently: static/graphIndex.json is
  # DERIVED from contentIndex at publish time — see derive-graph-index.mjs —
  # so it can never be torn and needs no guard here.)
  si="$1/static/searchIndex.json"
  [ ! -f "$si" ] || [ "$(tail -c 1 "$si")" = "}" ]
}
# Launch/kill the builder as a PROCESS GROUP. `npx` is only a wrapper: killing
# $BUILD_PID alone orphans the real node builder, which keeps :8081/:3001 —
# every relaunch then dies EADDRINUSE mid-emit, the completeness gate keeps
# refusing to publish, and the site freezes on the last good snapshot until the
# container is recreated (the 2026-08-24 nightly crash-loop: 9-min 500%-CPU
# builds forever, zero swaps). setsid makes $BUILD_PID the group leader so
# `kill -- -PID` reaps wrapper + node + esbuild together; the :3001 port-wait
# below stays as the backstop.
start_builder() {
  setsid npx quartz build --serve --port "$BUILD_PORT" &
  BUILD_PID=$!
}
kill_builder() {
  # NB: no `--` separator — BusyBox ash's kill builtin rejects it.
  kill -TERM "-$BUILD_PID" 2>/dev/null || kill "$BUILD_PID" 2>/dev/null || true
  wait "$BUILD_PID" 2>/dev/null || true
}

# Quartz --serve binds a hot-reload WebSocket on :3001. Relaunching the builder
# before the old one frees it → EADDRINUSE → the new build dies mid-emit. Wait
# (bounded) for :3001 to be free. Uses /proc/net/tcp* (no tools needed): port
# 3001 = 0x0BB9, listen state = 0A.
wait_port_3001_free() {
  k=0
  while [ "$k" -lt 20 ]; do
    if ! grep -qiE ':0BB9 .* 0A ' /proc/net/tcp /proc/net/tcp6 2>/dev/null; then return 0; fi
    sleep 1; k=$((k + 1))
  done
  echo "[wiki-viewer] WARN :3001 still busy after ${k}s — relaunching anyway (self-heal will retry)"
}

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
# Marker BEFORE the builder starts: a vault file written DURING the initial
# parse can be missed by both the parse set and the (later-armed) watcher —
# its page then never emits until the next mtime bump (found 2026-08-23:
# organization-anthropic.md written mid-cold-build stayed unemitted for
# 45+ min). The post-first-build check below catches exactly that window.
touch /tmp/builder-start
start_builder

# Stage 2 — the always-up static server starts IMMEDIATELY so :8080 is bound from
# the start. Until the first snapshot is published (cold start / first build) it
# serves a self-refreshing "Building…" splash instead of a connection error; once
# /srv/current exists it serves the real site (serve.mjs decides per request).
mkdir -p /srv
echo 0 > /tmp/last-access
node /serve.mjs &
SERVE_PID=$!
trap 'kill -TERM "-$BUILD_PID" 2>/dev/null; kill "$SERVE_PID" 2>/dev/null; exit 0' TERM INT

# Wait (bounded) for the first COMPLETE build (index.html + css + js, not just
# index.html — the old check published build-0 too early, before ComponentResources
# emitted, which is itself a way to serve an asset-less site). Generous — a large
# vault's first build can take several minutes.
i=0
while [ "$i" -lt 240 ]; do
  is_complete /quartz/public && index_ok /quartz/public && { echo "[wiki-viewer] first COMPLETE build emitted"; break; }
  sleep 2; i=$((i + 1))
done

# Publish the initial snapshot ONLY if complete (render assets) AND its search
# index is intact — serve.mjs serves the splash until /srv/current is a complete
# build, so a slow/failed first build shows "Building…" rather than a broken page.
if is_complete /quartz/public && index_ok /quartz/public; then
  rm -rf /srv/build-0; cp -a /quartz/public /srv/build-0
  # Lean graph/explorer index (see derive-graph-index.mjs) — derived on the
  # immutable copy so it can never be torn; a failed derive = no publish.
  if is_complete /srv/build-0 && index_ok /srv/build-0 \
    && node /derive-graph-index.mjs /srv/build-0; then
    ln -sfn /srv/build-0 /srv/current
  fi
fi

# Cold-build race check: any compiler-tree markdown written since the builder
# started whose HTML is missing from the build output was born inside the
# parse window and is invisible to the watcher (the vault is :ro here, so we
# cannot touch it) — restart the builder once for a fresh full parse. The
# compiler tree is slug-named, so md→html mapping is the plain basename.
missed=""
for f in $(find /wiki/content /wiki/notes -name "*.md" -newer /tmp/builder-start 2>/dev/null | head -50); do
  rel="${f#/wiki/}"
  [ -f "/quartz/public/${rel%.md}.html" ] || { missed="$rel"; break; }
done
if [ -n "$missed" ]; then
  echo "[wiki-viewer] cold-build race: $missed written mid-parse and unemitted — restarting builder once"
  kill_builder
  wait_port_3001_free
  touch /tmp/builder-start
  start_builder
fi

# Idle-gated snapshot loop + nightly clean rebuild.
REBUILD_HH=$(printf '%02d' "${WIKI_VIEWER_REBUILD_HOUR:-0}" 2>/dev/null || echo 00)
last_rebuild_day=""
marker=/tmp/last-snap; touch "$marker"
# Notes reconciliation cadence (see the loop body).
NOTES_CHECK_SECONDS="${WIKI_NOTES_CHECK_SECONDS:-60}"
NOTES_FIX_COOLDOWN="${WIKI_NOTES_FIX_COOLDOWN:-900}"
last_notes_check=0
last_notes_fix=0
N=0
while true; do
  sleep "$POLL"
  now=$(date +%s)
  la=$(cat /tmp/last-access 2>/dev/null || echo 0)
  idle=$((now - la))

  # Nightly CLEAN rebuild (idle only) — restart the builder so its fresh boot
  # build wipes orphaned HTML of removed/trashed/moved notes (--serve's
  # incremental build never deletes them). The static server keeps serving the
  # current snapshot throughout, so readers see no downtime; the clean build is
  # snapshotted in below once it settles.
  if [ "$idle" -ge "$IDLE_SECONDS" ] && [ "$(date +%H)" = "$REBUILD_HH" ] && [ "$(date +%j)" != "$last_rebuild_day" ]; then
    last_rebuild_day="$(date +%j)"
    echo "[wiki-viewer] nightly clean rebuild — restarting builder (sweeps orphan pages)"
    kill_builder
    wait_port_3001_free   # avoid EADDRINUSE :3001 on relaunch (the incident trigger)
    start_builder
    continue
  fi

  # Self-heal: if the builder process died (e.g. a crash mid-rebuild), restart it.
  # Without this, public goes stale and the wiki freezes on the last snapshot
  # forever — exactly how the 2026-06-15 incident persisted after the crash.
  if ! kill -0 "$BUILD_PID" 2>/dev/null; then
    echo "[wiki-viewer] builder process is dead — restarting"
    # Reap any orphaned group members first (a dead wrapper can leave the
    # node builder holding :3001 — the freeze trigger).
    kill -TERM "-$BUILD_PID" 2>/dev/null || true
    wait_port_3001_free
    start_builder
    continue
  fi

  # Notes reconciliation (operator report 2026-08-26): a USER NOTE whose page
  # was never emitted is invisible forever - the vault is read-only here, so we
  # cannot touch it into the watcher; restarting the builder re-parses the whole
  # vault and picks it up. Rate-limited, and only for notes/ (a handful of
  # files) so this can never thrash on the 24/7 knowledge churn.
  if [ "$((now - last_notes_check))" -ge "$NOTES_CHECK_SECONDS" ]; then
    last_notes_check="$now"
    missing_note=""
    for f in $(find /wiki/notes -name "*.md" 2>/dev/null | head -200); do
      rel="${f#/wiki/}"
      case "$rel" in */README.md) continue;; esac
      [ -f "/quartz/public/${rel%.md}.html" ] || { missing_note="$rel"; break; }
    done
    if [ -n "$missing_note" ] && [ "$((now - last_notes_fix))" -ge "$NOTES_FIX_COOLDOWN" ]; then
      last_notes_fix="$now"
      echo "[wiki-viewer] note without a page ($missing_note) - restarting builder to re-parse"
      kill_builder
      wait_port_3001_free
      touch /tmp/builder-start
      start_builder
      continue
    fi
  fi

  # Anything new in the build output since our last snapshot?
  changed=$(find /quartz/public -type f -newer "$marker" 2>/dev/null | head -1)
  [ -z "$changed" ] && continue
  # Has the build output SETTLED (no writes in the last STABLE_SECONDS)? If the
  # builder is mid-rebuild, wait — never snapshot a half-written site.
  newest=$(find /quartz/public -type f -printf '%T@\n' 2>/dev/null | sort -nr | head -1 | cut -d. -f1)
  [ -n "$newest" ] && [ $((now - newest)) -lt "$STABLE_SECONDS" ] && continue
  # COMPLETENESS gate: never publish an asset-less build (missing css/js) OR one
  # whose search index is still mid-write (torn JSON). Keep serving the last good
  # snapshot until the build is whole.
  if ! is_complete /quartz/public; then
    echo "[wiki-viewer] build output incomplete (missing css/js) — NOT publishing; keeping last good snapshot"
    continue
  fi
  if ! index_ok /quartz/public; then
    echo "[wiki-viewer] search index mid-write (contentIndex.json not terminated) — NOT publishing yet"
    continue
  fi
  # Is the viewer idle? If a reader is active, defer the swap (don't yank content)
  # — UNLESS a user just created a note/folder (serve.mjs set /tmp/ne-publish when
  # it served fresh content from the live output), in which case publish promptly
  # so the nav/contentIndex catch up in seconds instead of waiting out the idle gate.
  if [ "$idle" -lt "$IDLE_SECONDS" ] && [ ! -f /tmp/ne-publish ]; then
    echo "[wiki-viewer] new build ready; viewer active (${idle}s < ${IDLE_SECONDS}s idle) — deferring swap"
    continue
  fi
  N=$((N + 1))
  # Snapshot via rsync --link-dest against the previous snapshot: unchanged
  # files become hardlinks (no data copied), so a snapshot costs MBs, not the
  # full ~750MB tree (102GB/6h of disk writes before this). Snapshots are
  # immutable once published (only ever deleted), so sharing inodes is safe.
  prev=$(readlink /srv/current 2>/dev/null || true)
  rm -rf "/srv/build-$N.tmp"
  if command -v rsync >/dev/null 2>&1 && [ -n "$prev" ] && [ -d "$prev" ]; then
    rsync -a --delete --link-dest="$prev" /quartz/public/ "/srv/build-$N.tmp/"
  else
    cp -a /quartz/public "/srv/build-$N.tmp"
  fi
  # Re-verify the COPY is complete AND its search index is intact — guards against
  # cp racing a build that started rewriting public mid-snapshot (the torn-index
  # 2026-06-16 incident: render assets fine but contentIndex.json truncated).
  # The lean graph/explorer index is derived here too (immutable copy → can't
  # tear); a parse failure means the copy raced the build — discard.
  if ! is_complete "/srv/build-$N.tmp" || ! index_ok "/srv/build-$N.tmp" \
    || ! node /derive-graph-index.mjs "/srv/build-$N.tmp"; then
    echo "[wiki-viewer] snapshot copy was torn (build raced the cp) — discarding, will retry"
    rm -rf "/srv/build-$N.tmp"; N=$((N - 1)); continue
  fi
  rm -rf "/srv/build-$N" && mv "/srv/build-$N.tmp" "/srv/build-$N"
  ln -sfn "/srv/build-$N" /srv/current     # atomic swap; in-flight reads keep the old dir
  rm -rf "/srv/build-$((N - 2))"           # keep current + one previous
  touch "$marker"
  rm -f /tmp/ne-publish                    # consumed: prompt-publish request satisfied
  echo "[wiki-viewer] snapshot #$N swapped live"
done
