#!/usr/bin/env bash
# rw-p1c-retire: one case per anchor clause, each GREEN against this item's
# images and (P1C_RED=1, default) RED against the images it replaces, in the
# disposable environment of p1a-env.sh / p1b-env.sh. PASS/FAIL line per case;
# exits non-zero if any GREEN case fails.
#
#   bash OB1/docker/wiki-viewer/test/run-p1c.sh                 # build + every case + down
#   P1A_NO_BUILD=1 ...                                         # use the images already tagged $P1A_TAG
#   ONLY="C3 C8" ...                                           # only these cases (after C0)
#   KEEP=1 ...                                                 # leave the environment up
#   P1C_RED=0 ...                                              # skip the RED halves
# RED images (read-only, never rebuilt here):
#   P1C_RED_IMG     the viewer it replaces            (default openbrain-wiki-viewer:wt-rw-p1b-ready = OB1 767c461)
#   P1C_SPLASH_IMG  a viewer with a builder wait      (default openbrain-wiki-viewer:wt-rw-p1b-ready-base, the P1a-era splash)
#   P1C_RED_WSIMG   the wiki-service it replaces      (default openbrain-wiki:wt-rw-p1b-ready)
# Names: P1A_PREFIX / P1A_TAG / P1A_SUBNET as p1a-env.sh (default wt-rw-p1c-retire, 10.231.61.0/24).
# Nothing here touches a live container, network, volume or image; the env network is --internal.
set -uo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E="$HERE/p1a-env.sh"
B="$HERE/p1b-env.sh"
export P1A_PREFIX="${P1A_PREFIX:-wt-rw-p1c-retire}" P1A_TAG="${P1A_TAG:-${P1A_PREFIX:-wt-rw-p1c-retire}}" P1A_SUBNET="${P1A_SUBNET:-10.231.61.0/24}"
eval "$(bash "$E" vars)" || { echo "p1a-env.sh vars failed"; exit 2; }
REPO="$(cd "$OB1/.." && pwd)"
RED="${P1C_RED:-1}"
RED_IMG="${P1C_RED_IMG:-openbrain-wiki-viewer:wt-rw-p1b-ready}"
SPLASH_IMG="${P1C_SPLASH_IMG:-openbrain-wiki-viewer:wt-rw-p1b-ready-base}"
RED_WSIMG="${P1C_RED_WSIMG:-openbrain-wiki:wt-rw-p1b-ready}"
VIEWER_W="$OB1/docker/wiki-viewer"
results=()
pass() { results+=("PASS $1"); echo "==> PASS $1"; }
fail() { results+=("FAIL $1 - $2"); echo "==> FAIL $1 - $2"; }
red() { echo "==> RED $1: $2"; }
hdr() { echo; echo "################ $1"; }
want() { [ -z "${ONLY:-}" ] || [[ " $ONLY " == *" $1 "* ]]; }
T() { timeout "${1}" "${@:2}"; }
nodeq() { T 300 docker run --rm -i --network "$NET" -v "$OB1:/ob1:ro" --entrypoint node "$IMG" "$@"; }
chk() { nodeq /ob1/docker/wiki-viewer/test/p1c-checks.mjs "$@"; }
started() { docker inspect -f '{{.State.StartedAt}}' "$P-viewer"; }
fresh_viewer() { # [image]: a NEW viewer container (the redeploy)
  docker rm -f -v "$P-viewer" >/dev/null 2>&1 || true
  P1A_VIEWER_IMG="${1:-$IMG}" bash "$E" viewer >/dev/null
}
have() { docker image inspect "$1" >/dev/null 2>&1; }
echo "names: prefix=$P tag=$TAG net=$NET viewer=$IMG ws=$WSIMG freeze=$FRIMG; RED=$RED ($RED_IMG, $SPLASH_IMG, $RED_WSIMG)"

hdr "C0 build + environment"
bash "$B" down >/dev/null 2>&1; bash "$E" down >/dev/null 2>&1
if [ -z "${P1A_NO_BUILD:-}" ]; then
  T 2400 bash "$E" build 2>&1 | grep -E "# (tests|pass|fail)|label org|ERROR|error:" | tail -5
  T 900 bash "$E" wsbuild 2>&1 | grep -E "# (tests|pass|fail)|ERROR|naming to" | tail -3
fi
T 600 bash "$E" up 2>&1 | tail -3
T 900 bash "$E" ref 2>&1 | tail -1
bash "$E" wait_serving 120 && pass C0 || fail C0 "the viewer never served"

if want C1; then
hdr "C1 (clause 1): the P1a parity diff passes with no builder in the image; a regression FAILS"
o="$(T 300 bash "$E" parity 2>&1)"; echo "$o" | tail -4
echo "$o" | grep -q "PARITY: PASS" && c1=1 || c1=0
# the regression: the SAME image with one renderer component changed (the footer text) - bind-mounted, nothing committed
docker run --rm --network none -v "$OB1:/ob1:ro" --entrypoint sh "$IMG" -c 'sed "s/\"Created with \"/\"Made with \"/" /viewer/lib/components.mjs' > "$HERE/.p1c-regress-components.mjs"
grep -q '"Made with "' "$HERE/.p1c-regress-components.mjs" || { echo "x the regression fixture did not apply"; c1=0; }
docker rm -f -v "$P-viewer" >/dev/null 2>&1
HERE_W="$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))"
docker run -d --name "$P-viewer" --network "$NET" --network-alias openbrain-wiki-viewer -v "$VOL:/wiki:ro" \
  -v "$HERE_W/.p1c-regress-components.mjs:/viewer/lib/components.mjs:ro" \
  -e OPEN_BRAIN_URL=http://openbrain-rest -e WIKI_NAV_MIN_ROWS=0 -e WORKBENCH_KEY=fixture-key "$IMG" >/dev/null
bash "$E" wait_serving 60 >/dev/null
r="$(T 300 bash "$E" parity 2>&1)"; echo "regression run: $(echo "$r" | grep -E "^PARITY" | tail -1) unlisted-lines=$(echo "$r" | grep -c UNLISTED)"
echo "$r" | grep -q "PARITY: PASS" && { echo "x the parity diff did not catch the regression"; c1=0; }
rm -f "$HERE/.p1c-regress-components.mjs"; fresh_viewer; bash "$E" wait_serving 60 >/dev/null
[ "$c1" = 1 ] && pass C1 || fail C1 "parity did not pass, or did not fail on a regression"
fi

if want C2; then
hdr "C2 (clause 2): docker top - no quartz build process after a (re)deploy"
fresh_viewer; bash "$E" wait_serving 60 >/dev/null; sleep 15
top="$(docker top "$P-viewer" -eo pid,args 2>&1)"; echo "$top"
if echo "$top" | grep -q "serve.mjs" && ! echo "$top" | grep -qiE "quartz|npx|esbuild|entrypoint"; then pass C2; else fail C2 "a builder process (or no server)"; fi
if [ "$RED" = 1 ] && have "$RED_IMG"; then
  fresh_viewer "$RED_IMG"; sleep 20
  rt="$(docker top "$P-viewer" -eo pid,args 2>&1 | grep -iE "quartz|npx" | head -3)"; red C2 "$RED_IMG processes: ${rt:-(none)}"
  fresh_viewer; bash "$E" wait_serving 60 >/dev/null
fi
fi

if want C4; then
hdr "C4 (clause 4): the served bundle sha equals the image asset sha (= the committed bundle.sha256); a difference FAILS"
c4=1
img="$(T 60 docker run --rm --network none --entrypoint sh "$IMG" -c 'cd /viewer && sha256sum -c bundle.sha256' 2>&1)"; echo "image assets vs committed manifest:"; echo "$img"
echo "$img" | grep -qv ': OK$' && { echo "x an image asset differs from the committed manifest"; c4=0; }
o="$(chk bundle --base "http://$P-viewer:8080" --manifest /ob1/docker/wiki-viewer/bundle.sha256 2>&1)"; echo "$o"
echo "$o" | grep -q "BUNDLE: PASS" || c4=0
# negative control: the same check against a viewer serving a CHANGED postscript.js must FAIL
docker run --rm --network none --entrypoint sh "$IMG" -c 'cat /viewer/bundle/postscript.js; echo "/* p1c tamper */"' > "$HERE/.p1c-tamper.js"
docker rm -f -v "$P-viewer" >/dev/null 2>&1; HERE_W="$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))"
docker run -d --name "$P-viewer" --network "$NET" --network-alias openbrain-wiki-viewer -v "$VOL:/wiki:ro" \
  -v "$HERE_W/.p1c-tamper.js:/viewer/bundle/postscript.js:ro" -e OPEN_BRAIN_URL=http://openbrain-rest -e WIKI_NAV_MIN_ROWS=0 "$IMG" >/dev/null
bash "$E" wait_serving 60 >/dev/null
n="$(chk bundle --base "http://$P-viewer:8080" --manifest /ob1/docker/wiki-viewer/bundle.sha256 2>&1)"; echo "tampered: $(echo "$n" | grep -E "BAD|BUNDLE")"
echo "$n" | grep -q "BUNDLE: FAIL" || { echo "x a changed bundle was not detected"; c4=0; }
rm -f "$HERE/.p1c-tamper.js"; fresh_viewer; bash "$E" wait_serving 60 >/dev/null
[ "$c4" = 1 ] && pass C4 || fail C4 "see output"
fi

if want C7; then
hdr "C7 (clause 7): no Quartz clone, no patch step, no Quartz entry in the package manifest, no bundle build at image build; served CSS/JS = the committed asset"
probe='for p in /quartz /quartz/quartz.config.ts /entrypoint.sh /viewer/quartz /tmp/watcher-polling.mjs /tmp/graph-api.mjs; do [ -e "$p" ] && echo "PRESENT $p"; done
find / -xdev \( -name quartz.config.ts -o -name quartz.layout.ts -o -name "watcher-polling.mjs" -o -name "graph-api.mjs" -o -name ".quartz-cache" \) 2>/dev/null | sed "s/^/FOUND /"
ls /viewer/node_modules 2>/dev/null | grep -iE "^quartz|^@jackyzha0" | sed "s/^/NODE_MODULE /"
ls /viewer/node_modules/.bin 2>/dev/null | grep -iE "^(quartz|esbuild)$" | sed "s/^/BIN /"
for f in /viewer/package.json /viewer/package-lock.json /quartz/package.json; do [ -f "$f" ] && grep -il quartz "$f" | sed "s/^/MANIFEST-MENTIONS-QUARTZ /"; done
true'
g="$(T 120 docker run --rm --network none --entrypoint sh "$IMG" -c "$probe" 2>&1)"; echo "GREEN image: [${g}]"
hist="$(docker history --no-trunc --format '{{.CreatedBy}}' "$IMG" | grep -iE "quartz build|git clone|esbuild|patches/|npx quartz|sed -i" | head -5)"
echo "GREEN image history build steps naming Quartz/patches: [${hist}]"
df="$(grep -nE "quartz build|git clone|esbuild|npx|sed -i|patches/" "$VIEWER_W/Dockerfile" | head -5)"; echo "viewer Dockerfile build/patch steps: [${df}]"
pk="$(grep -ic quartz "$VIEWER_W/package.json" "$VIEWER_W/package-lock.json" | tr '\n' ' ')"; echo "package manifest quartz mentions: $pk"
o="$(chk bundle --base "http://$P-viewer:8080" --manifest /ob1/docker/wiki-viewer/bundle.sha256 2>&1 | tail -1)"; echo "$o"
if [ -z "$g" ] && [ -z "$hist" ] && [ -z "$df" ] && [ "$pk" = "$VIEWER_W/package.json:0 $VIEWER_W/package-lock.json:0 " ] && echo "$o" | grep -q "BUNDLE: PASS"; then pass C7; else fail C7 "Quartz tooling in the image or the manifest"; fi
if [ "$RED" = 1 ] && have "$RED_IMG"; then
  r="$(T 120 docker run --rm --network none --entrypoint sh "$RED_IMG" -c "$probe" 2>&1 | head -8)"; red C7 "$RED_IMG: $(echo "$r" | tr '\n' ' ' | cut -c1-400)"
fi
fi

if want C3; then
hdr "C3 (clause 3): a viewer redeploy serves the fixed URL list within 10 s of container start; a rebuild wait FAILS"
c3=1
for i in 1 2 3; do
  fresh_viewer; st="$(started)"
  o="$(chk ready --base "http://$P-viewer:8080" --started "$st" --budget 10 --timeout 60 2>&1)"; echo "run $i (StartedAt $st): $(echo "$o" | tail -2 | tr '\n' ' ')"
  echo "$o" | grep -q "READY: PASS" || c3=0
done
[ "$c3" = 1 ] && pass C3 || fail C3 "over 10 s"
if [ "$RED" = 1 ] && have "$SPLASH_IMG"; then
  fresh_viewer "$SPLASH_IMG"; st="$(started)"
  o="$(chk ready --base "http://$P-viewer:8080" --started "$st" --budget 10 --timeout 90 2>&1)"; red C3 "$SPLASH_IMG (builder wait): $(echo "$o" | grep -E "not yet|READY" | head -3 | tr '\n' ' ')"
fi
fresh_viewer; bash "$E" wait_serving 60 >/dev/null
fi

if want C8; then
hdr "C8 (clause 8): compile pacing is purely performance-based - change-watch + on-demand stay, no daily compile, the wiki's own caller key, nothing waits for the viewer; + the boot sweep of staged leftovers"
c8=1
WS="$OB1/docker/wiki-service/wiki-service.mjs"
echo "-- static: wiki-service.mjs"
for pat in scheduleDaily RECOMPILE_HOUR viewerIdleMs "__last-access" BACKFILL_IDLE_MIN '"daily"'; do n="$(grep -c -- "$pat" "$WS")"; echo "  $pat: $n"; done
[ "$(grep -cE 'scheduleDaily|RECOMPILE_HOUR =|viewerIdleMs|fetch\(`\$\{VIEWER_URL\}|BACKFILL_IDLE_MIN =|compile\("daily"\)' "$WS")" = 0 ] || { echo "x a daily schedule or the idle gate is still in the code"; c8=0; }
grep -q 'setInterval(() => changeWatchTick(), WATCH_INTERVAL_MIN \* 60_000)' "$WS" && grep -q 'url.pathname === "/recompile"' "$WS" || { echo "x change-watch or the on-demand trigger is gone"; c8=0; }
echo "-- static: compose (openbrain-wiki): $(grep -nE 'WIKI_RECOMPILE_HOUR:|WIKI_BACKFILL_IDLE_MIN:' "$OB1/docker/docker-compose.yml" | wc -l) schedule/idle env lines; keys: $(grep -nE '^\s+(LLM_API_KEY|EMBEDDING_API_KEY): \$\{OB_WIKI_LLM_KEY' "$OB1/docker/docker-compose.yml" | wc -l) of 2 on OB_WIKI_LLM_KEY; other services on that key: $(grep -c 'OB_WIKI_LLM_KEY' "$OB1/docker/docker-compose.yml")"
[ "$(grep -cE 'WIKI_RECOMPILE_HOUR:|WIKI_BACKFILL_IDLE_MIN:' "$OB1/docker/docker-compose.yml")" = 0 ] && [ "$(grep -cE '^\s+(LLM_API_KEY|EMBEDDING_API_KEY): \$\{OB_WIKI_LLM_KEY' "$OB1/docker/docker-compose.yml")" = 2 ] \
  && [ "$(grep -c 'OB_WIKI_LLM_KEY' "$OB1/docker/docker-compose.yml")" = 2 ] || { echo "x compose: schedule/idle env, or the wiki's calls not on its own key"; c8=0; }
pol="$REPO/inference/llm-queue/src/llm_queue/policy.py"
rw="$(grep -oE '"ob-wiki": PriorityClass\("ob-wiki", rank=[0-9]+' "$pol" | grep -oE '[0-9]+$')"; rc="$(grep -oE '"owui-chat": PriorityClass\("owui-chat", rank=[0-9]+' "$pol" | grep -oE '[0-9]+$')"
echo "-- llm-queue policy: ob-wiki rank=$rw, owui-chat rank=$rc (lower = first)"; [ -n "$rw" ] && [ -n "$rc" ] && [ "$rw" -gt "$rc" ] || { echo "x the wiki lane is not below interactive"; c8=0; }
ws_run() { # image label: stub reset, a staged leftover in the vault, boot compile + one incremental cycle, with a viewer that is ALWAYS in use
  local img="$1" lab="$2"
  bash "$E" stub '{"mode":"ok"}' >/dev/null
  bash "$E" node -e "require('fs').writeFileSync('/wiki/content/person/.person-ada-fixture.md.wp-staged-999','# staged leftover\n');console.log('staged leftover written')"
  P1A_WS_IMG="$img" P1A_WS_VIEWER_URL=http://llm-stub:8080 P1A_WS_ENV="-e LLM_API_KEY=ob-wiki-fixture-key -e EMBEDDING_API_KEY=ob-wiki-fixture-key" bash "$E" ws >/dev/null
  T 300 bash "$E" ws_wait >/dev/null; T 300 bash "$E" ws_cycle >/dev/null
  local logs st left tracked
  logs="$(docker logs "$P-ws" 2>&1)"
  st="$(bash "$E" stub)"
  left="$(bash "$E" node -e "console.log(require('fs').existsSync('/wiki/content/person/.person-ada-fixture.md.wp-staged-999')?'PRESENT':'gone')")"
  tracked="$(docker run --rm --network none -v "$VOL:/wiki:ro" --entrypoint sh "$WSIMG" -c 'git config --global --add safe.directory /wiki; git -C /wiki ls-files | grep -c wp-staged' 2>/dev/null)"
  echo "$lab listening: $(echo "$logs" | grep -m1 'listening on' | cut -c1-200)"
  echo "$lab daily: $(echo "$logs" | grep -c 'next daily compile') | deferred-for-viewer: $(echo "$logs" | grep -c 'backfill deferred') | staged sweep: $(echo "$logs" | grep -m1 'staged sweep' | cut -c1-120)"
  echo "$lab stub: lastAccessCalls=$(echo "$st" | grep -oE '"lastAccessCalls":[0-9]+' | cut -d: -f2) callers=$(echo "$st" | grep -oE '"callers":\{[^}]*\}')"
  echo "$lab staged leftover: $left; tracked by vault git: ${tracked:-0}"
  docker rm -f -v "$P-ws" >/dev/null 2>&1
}
g="$(ws_run "$WSIMG" GREEN)"; echo "$g"
echo "$g" | grep -q "GREEN daily: 0 | deferred-for-viewer: 0 | staged sweep: \[wiki-service\] staged sweep: removed 1" || { echo "x daily / deferral / sweep"; c8=0; }
echo "$g" | grep -q "no daily compile" || { echo "x the service does not say it is demand-driven"; c8=0; }
echo "$g" | grep -q 'GREEN stub: lastAccessCalls=0 callers={"ob-wiki-fixture-key":[0-9]*}$' || { echo "x the viewer was asked, or a call carried another key"; c8=0; }
echo "$g" | grep -q "GREEN staged leftover: gone; tracked by vault git: 0" || { echo "x the staged leftover survived or was committed"; c8=0; }
[ "$c8" = 1 ] && pass C8 || fail C8 "see output"
if [ "$RED" = 1 ] && have "$RED_WSIMG"; then r="$(ws_run "$RED_WSIMG" RED)"; red C8 "$(echo "$r" | tr '\n' ' ' | cut -c1-900)"; fi
fi

if want C5; then
hdr "C5 (clause 5): the pre-commit project-config check passes with the changed container"
o="$(cd "$REPO" && T 600 powershell -NoProfile -ExecutionPolicy Bypass -File scripts/checks/check-project-configs.ps1 2>&1)"; rc=$?; echo "$o" | tail -12; echo "exit=$rc"
[ "$rc" = 0 ] && pass C5 || fail C5 "check-project-configs.ps1 exit $rc"
fi

if want C6; then
hdr "C6 (clause 6): every SERVICE-LIFECYCLE surface is changed on this branch (the file:line table is in the findings / PR)"
c6=1; base="${P1C_BASE:-development}"; mb="$(git -C "$REPO" merge-base "$base" HEAD)"; pin="$(git -C "$REPO" rev-parse "$mb:OB1")"
for f in OB1/docker/docker-compose.yml OB1/docker/.env.example OB1/docker/wiki-viewer/Dockerfile OB1/docker/wiki-service/Dockerfile \
         scripts/recovery/emergency-recovery.ps1 scripts/checks/check-backup-coverage.ps1 .claude/skills/stack-map/references/workspace-stacks.md \
         .claude/skills/stack-map/SKILL.md documentation/CONTAINER-REGISTRY.md stack.manifest.toml; do
  case "$f" in OB1/*) ch="$(git -C "$OB1" diff --stat "$pin" -- "${f#OB1/}" | tail -1)" ;; *) ch="$(git -C "$REPO" diff --stat "$mb" -- "$f" | tail -1)" ;; esac
  echo "surface $f: ${ch:-UNCHANGED}"; [ -n "$ch" ] || c6=0
done
[ "$c6" = 1 ] && pass C6 || fail C6 "a lifecycle surface unchanged"
fi

if want C3b; then
hdr "C3b (r-p1b review A, in clause 3's scope): the site index is warmed at start - /__health says 'site index warming' until it is, and the first page after a start no longer pays the cold build (synthetic ${P1C_ROWS:=200000} rows)"
c3b=1; export P1A_HEAP_MB="${P1A_HEAP_MB:-6144}"
T 600 bash "$B" perfseed "$P1C_ROWS" | tail -1
first_after() { # image label
  fresh_viewer "$1"; local st i=0 h w=0; st="$(started)"
  while [ "$i" -lt 240 ]; do
    h="$(bash "$E" health 2>/dev/null)"
    echo "$h" | grep -q 'site index warming' && w=1
    echo "$h" | grep -qE '"warm":true' && break
    [ "$1" != "$IMG" ] && [ "$i" -ge 60 ] && break   # a pre-P1c image has no siteIndex field: give it 60 s
    sleep 1; i=$((i + 1))
  done
  echo "$2 health said warming: $w; warm after ~${i}s: $(echo "$h" | grep -oE '"siteIndex":\{[^}]*\}')"
  echo "$2 $(chk first --base "http://$P-viewer:8080" --path / 2>&1)"
}
g="$(first_after "$IMG" GREEN)"; echo "$g"
s="$(echo "$g" | grep -oE 'in [0-9.]+ s' | grep -oE '[0-9.]+')"
echo "$g" | grep -q "GREEN health said warming: 1" && echo "$g" | grep -q '"warm":true' && awk "BEGIN{exit !($s < 2)}" || { echo "x not warmed at start (first page ${s}s)"; c3b=0; }
[ "$c3b" = 1 ] && pass C3b || fail C3b "see output"
if [ "$RED" = 1 ] && have "$RED_IMG"; then r="$(first_after "$RED_IMG" RED)"; red C3b "$(echo "$r" | tr '\n' ' ')"; fi
fi

echo; echo "################ SUMMARY"
for r in "${results[@]}"; do echo "$r"; done
if [ -z "${KEEP:-}" ]; then bash "$B" down >/dev/null 2>&1; bash "$E" down >/dev/null 2>&1; echo "environment removed"; fi
printf '%s\n' "${results[@]}" | grep -q '^FAIL' && exit 1 || exit 0
