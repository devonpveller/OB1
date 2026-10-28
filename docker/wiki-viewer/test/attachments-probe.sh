#!/usr/bin/env bash
# rw-p1c-retire: vault attachments are served from the vault (no snapshot any more), at Quartz's URL,
# and nothing outside Quartz's page/asset set is. Offline: --network none, one throwaway volume.
#   bash OB1/docker/wiki-viewer/test/attachments-probe.sh <viewer image> [volume name, default wt-p1c-att]
set -euo pipefail
export MSYS_NO_PATHCONV=1
IMG="$1"; VOLN="${2:-wt-p1c-att}"
case "$VOLN" in wt-*) ;; *) echo "volume must start with wt-"; exit 2 ;; esac
docker volume create "$VOLN" >/dev/null
docker run --rm --network none -v "$VOLN:/wiki" --entrypoint sh "$IMG" -c 'mkdir -p /wiki/assets/src1 /wiki/private /wiki/notes/sub && printf PNG1 > "/wiki/notes/sub/a b.png" && printf PNG2 > /wiki/notes/plain.png && printf ASSET > /wiki/assets/src1/x.png && printf SECRET > /wiki/private/x.png && printf DOT > /wiki/notes/.h.png && printf ROOTSVG > /wiki/root.svg'
out="$(timeout 120 docker run --rm --network none -v "$VOLN:/wiki:ro" -e WIKI_NAV_API=0 --entrypoint sh "$IMG" -c 'node /viewer/serve.mjs >/tmp/log 2>&1 & sleep 3; for u in /notes/plain.png /notes/sub/a-b.png /root.svg /assets/src1/x.png /private/x.png /notes/.h.png /notes/../private/x.png "/%2e%2e/etc/passwd.png" /index.css; do node -e "fetch(\"http://127.0.0.1:8080\" + process.argv[1]).then(async r=>console.log(r.status, (await r.text()).slice(0,7), process.argv[1]))" "$u"; done')"
docker volume rm "$VOLN" >/dev/null
echo "$out"
want="200 PNG2 /notes/plain.png
200 PNG1 /notes/sub/a-b.png
200 ROOTSVG /root.svg
404 not fou /assets/src1/x.png
404 not fou /private/x.png
404 not fou /notes/.h.png
404 not fou /notes/../private/x.png
404 not fou /%2e%2e/etc/passwd.png"
if [ "$(echo "$out" | head -8)" = "$want" ] && echo "$out" | tail -1 | grep -q '^200 '; then echo "ATTACHMENTS: PASS"; else echo "ATTACHMENTS: FAIL"; exit 1; fi
