#!/bin/sh
set -e

# Point Quartz at the shared compiled-wiki content (read-only volume).
# Replace Quartz's bundled docs with our compiled pages.
rm -rf /quartz/content
ln -sfn /wiki/content /quartz/content

# On a cold stack the compiler may not have produced pages yet. Quartz
# build errors on an empty content dir, so wait for the first page
# (bounded — then build anyway so failures are visible in logs).
i=0
while [ "$i" -lt 60 ]; do
  if ls /wiki/content/*.md >/dev/null 2>&1; then
    echo "[wiki-viewer] content present, starting Quartz"
    break
  fi
  echo "[wiki-viewer] waiting for first compiled page... ($i)"
  i=$((i + 1))
  sleep 10
done

# build --serve: build, then watch + serve. Quartz binds 0.0.0.0:8080.
exec npx quartz build --serve --port 8080
