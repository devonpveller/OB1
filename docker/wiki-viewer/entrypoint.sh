#!/bin/sh
set -e

# Quartz renders the WHOLE vault: generated `content/` + hand-written
# `notes/` + the vault-root `index.md` home, so cross-layer
# [[wikilinks]] resolve. A single directory symlink (not per-entry)
# means Quartz's file watcher tracks the real /wiki dir and picks up
# every recompile, including the home page (per-entry symlinks broke
# both: the watcher missed symlinked-file target changes).
rm -rf /quartz/content
ln -sfn /wiki /quartz/content

# Don't let Quartz scan .git / build caches / local state. NOTE: `.git` alone
# does NOT exclude files INSIDE the repo metadata (e.g. `.git/index.lock`); the
# `.git/**` glob is required, otherwise Quartz tries to copy the live git
# directory and crashes on git's transient lock files when another container
# (the compiler, or the workbench writing notes/Changes) commits mid-rebuild.
sed -i 's#ignorePatterns: \[[^]]*\]#ignorePatterns: ["private", "templates", ".obsidian", ".git", ".git/**", "**/.git/**", ".quartz-cache", "public", "node_modules", ".wikistate.json"]#' \
  /quartz/quartz.config.ts

# Disable Quartz's CustomOgImages emitter. It throws on ZWJ-sequence emojis
# (e.g. codepoint 1f9d1-200d-1f4bc / 🧑‍💼) absent from its emoji map, which
# crashes the ENTIRE build → viewer crash-loop (the splash never clears). OG /
# social-preview images are pointless for a private Authelia/tailnet-gated wiki.
# The upstream quartz.config.ts ships CustomOgImages ENABLED; this comments it
# out. Idempotent (no-op if already commented).
sed -i 's#^\([[:space:]]*\)Plugin.CustomOgImages(),#\1// Plugin.CustomOgImages(), // DISABLED: ZWJ-emoji codepoint crashes emit#' \
  /quartz/quartz.config.ts

# On a cold stack the compiler may not have produced pages yet. Quartz
# build errors on empty content, so wait (bounded) for the home page.
i=0
while [ "$i" -lt 60 ]; do
  if [ -f /wiki/index.md ] || ls /wiki/content/*.md >/dev/null 2>&1; then
    echo "[wiki-viewer] vault present, starting Quartz"
    break
  fi
  echo "[wiki-viewer] waiting for first compile... ($i)"
  i=$((i + 1))
  sleep 10
done

# build --serve: build, then watch + serve (fast incremental for live edits).
# BUT `--serve` never deletes the emitted HTML of removed/trashed/moved notes, so
# once a day (WIKI_VIEWER_REBUILD_HOUR, default 0 = midnight, before the 1am
# compile + after the workbench empties trash at 23:55) we restart it for a CLEAN
# build that sweeps those orphans. At that hour no one is using the wiki, so the
# ~5-min rebuild is invisible. node computes the sleep (this minimal image has no
# `date -d`); the loop manages its own restarts + forwards container stop.
set +e
REBUILD_HOUR="${WIKI_VIEWER_REBUILD_HOUR:-0}"
export REBUILD_HOUR
SERVE_PID=""
trap 'kill "$SERVE_PID" 2>/dev/null; exit 0' TERM INT
while true; do
  npx quartz build --serve --port 8080 &
  SERVE_PID=$!
  node -e '
    const h = Math.min(23, Math.max(0, parseInt(process.env.REBUILD_HOUR || "0", 10)));
    const now = new Date();
    const next = new Date(now);
    next.setHours(h, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(() => process.exit(0), next.getTime() - now.getTime());
  '
  echo "[wiki-viewer] nightly clean rebuild — restarting quartz"
  kill "$SERVE_PID" 2>/dev/null
  wait "$SERVE_PID" 2>/dev/null
done
