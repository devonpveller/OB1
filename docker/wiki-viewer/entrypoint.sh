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

# Don't let Quartz scan .git / build caches / local state.
sed -i 's#ignorePatterns: \[[^]]*\]#ignorePatterns: ["private", "templates", ".obsidian", ".git", ".quartz-cache", "public", "node_modules", ".wikistate.json"]#' \
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

# build --serve: build, then watch + serve. Quartz binds 0.0.0.0:8080.
exec npx quartz build --serve --port 8080
