#!/bin/sh
# reference <vault dir> <out dir> - build a vault the way the RETIRED builder
# did (entrypoint.sh at OB1 767c461: `quartz build --serve` over
# /quartz/content -> the vault; publish once the output is complete - index.html
# + index.css + prescript.js + postscript.js - and settled, no write for 8 s).
# The output is the parity diff's "built" side (test/parity-diff.mjs --built).
# Runs inside the freeze tool image only (freeze.sh reference).
set -e
V="${1:-/vault}"; OUT="${2:-/ref}"
cd /quartz
rm -rf /quartz/content /quartz/public
ln -sfn "$V" /quartz/content
setsid npx quartz build --serve --port 8081 > /tmp/ref-build.log 2>&1 &
pid=$!
i=0
until [ -f public/index.html ] && [ -f public/index.css ] && [ -f public/prescript.js ] && [ -f public/postscript.js ]; do
  i=$((i + 1)); if [ "$i" -gt 600 ]; then cat /tmp/ref-build.log; kill -TERM "-$pid" 2>/dev/null || true; exit 1; fi; sleep 1
done
j=0
while [ "$j" -lt 120 ]; do
  newest=$(find public -type f -printf '%T@\n' | sort -nr | head -1 | cut -d. -f1)
  [ $(( $(date +%s) - newest )) -ge 8 ] && break
  sleep 2; j=$((j + 1))
done
kill -TERM "-$pid" 2>/dev/null || true
mkdir -p "$OUT"
cp -a public/. "$OUT"/
echo "[freeze] reference built from $V: $(find "$OUT" -name '*.html' | wc -l) html files"
