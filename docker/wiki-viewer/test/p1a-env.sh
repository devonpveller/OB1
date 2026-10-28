#!/usr/bin/env bash
# rw-p1a-render disposable test environment (research-workbench P1a).
#
# Everything here is DISPOSABLE and ISOLATED, and PARAMETERISED so a tester
# runs it under their own names (attempt 2, plan finding P1):
#   P1A_PREFIX   container/volume/network prefix   (default wt-rw-p1a-render; must start "wt-")
#   P1A_TAG      image tag for both test images    (default = P1A_PREFIX; must start "wt-")
#   P1A_SUBNET   the private network's subnet      (default 10.231.47.0/24; never 192.168.0.0/16)
#   P1A_PORT     the viewer's 127.0.0.1 port       (default 18899; published ONLY with P1A_PUBLISH=1)
# What it creates:
#   - one private INTERNAL network $P1A_PREFIX-net (never an ai-stack_* network;
#     --internal since rw-p1c-retire: nothing in the env needs a route out);
#   - containers named     $P1A_PREFIX-*  (removed with docker rm -f -v);
#   - two named volumes    $P1A_PREFIX-vault (a COPY of the fixture vault)
#                          and $P1A_PREFIX-ref (rw-p1c-retire: the vault as the
#                          Quartz freeze tool builds it - the parity diff's
#                          "built" side; the viewer image has no builder);
#   - the database is a fresh postgres seeded ONLY with the fixtures in
#     test/fixtures/ (synthetic rows; never the live openbrain-db).
# Network aliases (openbrain-db / openbrain-postgrest / openbrain-rest) exist
# only on the private network, so the real OB1 Caddyfile and the viewer's
# default OPEN_BRAIN_URL work unchanged.
#
# Usage (Git Bash on Windows or any POSIX shell, from anywhere):
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh vars         # print the resolved names (eval-able)
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh build        # viewer image (label = OB1 HEAD) + the freeze tool image
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh ref          # (re)build $P1A_PREFIX-ref from the vault (freeze tool)
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh refcat <p>   # cat a file of the reference build (<p> relative, e.g. index.html)
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh up           # db + rest + llm stub + seed + viewer
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh node <args>  # run node in the viewer image with OB1 at /ob1, vault at /wiki
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh psql "<sql>" # run SQL in the disposable db
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh wsbuild      # the wiki-service image (openbrain-wiki:$P1A_TAG)
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh ws           # start the wiki-service on the env's vault (boot compile)
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh ws_cycle     # POST /recompile and wait (bounded) for it to finish
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh down         # remove everything this script created (not the images)
# rw-p1b-ready adds (test/p1b-env.sh holds the P1b-only pieces):
#   P1A_SRV=<volume>      mount that volume at the viewer's /srv (rw-p1c-retire: the viewer no longer
#                         has a /srv; set it only to prove a leftover snapshot volume is ignored)
#   P1A_VIEWER_IMG=<img>  run the viewer from another image (the RED runs: the base image)
#   the viewer joins the network as openbrain-wiki-viewer too (the front door's
#   upstream name) and reads the notifications endpoint with WORKBENCH_KEY=fixture-key
set -euo pipefail
export MSYS_NO_PATHCONV=1

P="${P1A_PREFIX:-wt-rw-p1a-render}"
TAG="${P1A_TAG:-$P}"
SUBNET="${P1A_SUBNET:-10.231.47.0/24}"
PORT="${P1A_PORT:-18899}"
case "$P" in wt-*) ;; *) echo "[p1a-env] refusing: P1A_PREFIX must start with wt- (got $P)" >&2; exit 2 ;; esac
case "$TAG" in wt-*) ;; *) echo "[p1a-env] refusing: P1A_TAG must start with wt- (got $TAG; never :local)" >&2; exit 2 ;; esac
case "$SUBNET" in 192.168.*) echo "[p1a-env] refusing: P1A_SUBNET $SUBNET is inside 192.168.0.0/16 (the home LAN)" >&2; exit 2 ;; esac
NET="$P-net"
VOL="$P-vault"
SRV="${P1A_SRV:-}"
REF="$P-ref"
IMG="openbrain-wiki-viewer:$TAG"
WSIMG="openbrain-wiki:$TAG"
FRIMG="openbrain-wiki-quartz-freeze:$TAG"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && (pwd -W 2>/dev/null || pwd))"
VIEWER="$(cd "$HERE/.." && (pwd -W 2>/dev/null || pwd))"
OB1="$(cd "$HERE/../../.." && (pwd -W 2>/dev/null || pwd))"

log() { printf '[p1a-env] %s\n' "$*"; }

# Every one-off container runs with --entrypoint (the image's own entrypoint
# is the server, which never exits) and a bounded wait.
wait_http() { # url, seconds
  local url="$1" n="${2:-60}" i=0
  while [ "$i" -lt "$n" ]; do
    if docker run --rm --network "$NET" --entrypoint node "$IMG" -e "fetch('$url').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1; i=$((i + 1))
  done
  log "TIMEOUT waiting for $url"; return 1
}

cmd_vars() {
  printf 'P=%q\nTAG=%q\nSUBNET=%q\nPORT=%q\nNET=%q\nVOL=%q\nSRV=%q\nREF=%q\nIMG=%q\nWSIMG=%q\nFRIMG=%q\nOB1=%q\n' \
    "$P" "$TAG" "$SUBNET" "$PORT" "$NET" "$VOL" "$SRV" "$REF" "$IMG" "$WSIMG" "$FRIMG" "$OB1"
}

cmd_build() {
  local sha
  sha="$(git -C "$OB1" rev-parse HEAD)"
  log "building $IMG from $VIEWER (OB1_SHA=$sha)"
  docker build --build-context "recipes=$OB1/recipes" --build-arg "OB1_SHA=$sha" -t "$IMG" "$VIEWER"
  docker image inspect "$IMG" --format 'label org.opencontainers.image.revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
  # the Quartz freeze tool (test-only: the parity reference and the slug check; never deployed)
  FREEZE_TAG="$TAG" bash "$VIEWER/freeze/freeze.sh" image
}

cmd_wsbuild() {
  log "building $WSIMG from $OB1/docker/wiki-service"
  docker build -t "$WSIMG" "$OB1/docker/wiki-service"
}

cmd_net() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create --internal --subnet "$SUBNET" "$NET" >/dev/null
}

cmd_db() {
  cmd_net
  docker rm -f -v "$P-db" >/dev/null 2>&1 || true
  docker run -d --name "$P-db" --network "$NET" --network-alias openbrain-db \
    -e POSTGRES_PASSWORD=fixture -e POSTGRES_DB=openbrain \
    -v "$HERE/fixtures/db/00-roles.sql:/docker-entrypoint-initdb.d/00-roles.sql:ro" \
    -v "$OB1/docker/init-wiki-pages.sql:/docker-entrypoint-initdb.d/10-wiki-pages.sql:ro" \
    -v "$HERE/fixtures/db/20-brain.sql:/docker-entrypoint-initdb.d/20-brain.sql:ro" \
    postgres:16-alpine >/dev/null
  local i=0
  until docker exec "$P-db" pg_isready -U postgres -d openbrain -q 2>/dev/null \
      && docker exec "$P-db" psql -U postgres -d openbrain -tAc "select 1 from threads limit 1" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 60 ] && { log "db did not come up"; return 1; }; sleep 1
  done
  log "db up"
}

cmd_rest() {
  cmd_net
  docker rm -f -v "$P-postgrest" "$P-rest" >/dev/null 2>&1 || true
  docker run -d --name "$P-postgrest" --network "$NET" --network-alias openbrain-postgrest \
    -e PGRST_DB_URI=postgres://postgres:fixture@openbrain-db:5432/openbrain \
    -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=service_role -e PGRST_DB_POOL=4 \
    -e PGRST_SERVER_PORT=3000 postgrest/postgrest:v12.2.3 >/dev/null
  docker run -d --name "$P-rest" --network "$NET" --network-alias openbrain-rest \
    -v "$OB1/docker/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine >/dev/null
  wait_http "http://openbrain-rest/rest/v1/wiki_pages?limit=1" 60
  log "rest up"
}

cmd_llm() {
  cmd_net
  docker rm -f -v "$P-llm" >/dev/null 2>&1 || true
  docker run -d --name "$P-llm" --network "$NET" --network-alias llm-stub \
    -v "$HERE:/t:ro" --entrypoint node "$IMG" /t/stub-llm.mjs >/dev/null
  wait_http "http://llm-stub:8080/__stub/state" 30
  log "llm stub up (http://llm-stub:8080)"
}

cmd_vault() {
  docker volume inspect "$VOL" >/dev/null 2>&1 && docker volume rm "$VOL" >/dev/null
  docker volume create "$VOL" >/dev/null
  # the committed fixture vault, then (rw-p1a-deploy-prep, NA4-1/RV-1) the
  # legacy notes whose names Quartz slugifies and the paths Quartz never
  # builds - written here because a Windows checkout cannot hold "q?x.md"
  docker run --rm -v "$VOL:/wiki" -v "$HERE/fixtures/vault:/src:ro" -v "$HERE/fixtures:/fx:ro" --entrypoint sh "$IMG" \
    -c 'cp -a /src/. /wiki/ && node /fx/slug-vault.mjs /wiki >/dev/null && find /wiki -type f | wc -l' | sed 's/^/[p1a-env] vault files: /'
}

cmd_node() { # run node inside the viewer image: OB1 tree at /ob1 (ro), vault at /wiki (rw)
  docker run --rm -i --network "$NET" -v "$OB1:/ob1:ro" -v "$VOL:/wiki" \
    -e OPEN_BRAIN_URL=http://openbrain-rest -e OPEN_BRAIN_SERVICE_KEY=local-trust \
    -e WIKI_GIT_DIR=/wiki -e WIKI_PAGES_SYNC_TIMEOUT_MS=3000 -e P1A_DISPOSABLE="$P" \
    -e P1A_BASE="http://$P-viewer:8080" \
    ${P1A_NODE_ENV:-} --entrypoint node "$IMG" "$@"
}

cmd_seed() {
  cmd_node /ob1/docker/wiki-viewer/test/seed-fixtures.mjs
}

cmd_viewer() {
  docker rm -f -v "$P-viewer" >/dev/null 2>&1 || true
  # P1A_EXTRA_CLASS=1 (acceptance 10): bind-mount ONE extra page-class entry
  # file into lib/page-classes/ - nothing in the image or the repo changes.
  # P1A_EXTRA_ENTRY=<file in test/fixtures/extra-class>: bind-mount that file
  # instead (the registry's adversarial cases: duplicate, tie, no default
  # export, a throwing resolve()).
  local extra=()
  [ -n "${P1A_EXTRA_CLASS:-}" ] && extra=(-v "$HERE/fixtures/extra-class/glossary.mjs:/quartz/lib/page-classes/glossary.mjs:ro")
  [ -n "${P1A_EXTRA_ENTRY:-}" ] && extra=(-v "$HERE/fixtures/extra-class/${P1A_EXTRA_ENTRY}:/quartz/lib/page-classes/${P1A_EXTRA_ENTRY}:ro")
  local pub=() srv=()
  [ -n "${P1A_PUBLISH:-}" ] && pub=(-p "127.0.0.1:$PORT:8080")
  [ -n "$SRV" ] && srv=(-v "$SRV:/srv")
  docker run -d --name "$P-viewer" --network "$NET" --network-alias openbrain-wiki-viewer "${pub[@]}" \
    -v "$VOL:/wiki:ro" "${srv[@]}" \
    -e OPEN_BRAIN_URL=http://openbrain-rest -e WIKI_NAV_MIN_ROWS=0 \
    -e WORKBENCH_KEY=fixture-key -e WIKI_NOTIFY_TTL_MS="${WIKI_NOTIFY_TTL_MS:-1000}" -e WIKI_NOTIFY_TIMEOUT_MS="${WIKI_NOTIFY_TIMEOUT_MS:-1000}" \
    -e WIKI_DB_PROBE_MS="${WIKI_DB_PROBE_MS:-1000}" \
    -e WIKI_DB_CONNECT_GRACE_MS="${WIKI_DB_CONNECT_GRACE_MS:-4000}" \
    -e WIKI_RECONCILE_INTERVAL_MS="${WIKI_RECONCILE_INTERVAL_MS:-5000}" \
    -e NODE_OPTIONS=--max-old-space-size="${P1A_HEAP_MB:-2048}" ${P1B_VIEWER_ENV:-} "${extra[@]}" \
    "${P1A_VIEWER_IMG:-$IMG}" >/dev/null
  log "viewer started ($P-viewer on $NET${P1A_PUBLISH:+, published on 127.0.0.1:$PORT})"
}

cmd_ref() { # the parity diff's "built" side: the env's vault as Quartz builds it (freeze tool; rw-p1c-retire)
  docker volume rm "$REF" >/dev/null 2>&1 || true
  docker volume create "$REF" >/dev/null
  FREEZE_TAG="$TAG" FREEZE_NO_BUILD=1 bash "$VIEWER/freeze/freeze.sh" reference "$VOL" "$REF" | sed 's/^/[p1a-env] /'
}

cmd_refcat() { # cat a file of the reference build (path relative to its root), or "(absent)"
  docker run --rm --network none -v "$REF:/ref:ro" --entrypoint sh "$IMG" -c "cat '/ref/${1#/}' 2>/dev/null || echo '(absent)'"
}

cmd_wait_built() { # the reference build exists (built once per vault) and THIS viewer serves pages
  # (rw-p1c-retire: the viewer has no builder; the "built" side is the freeze tool's build of the vault)
  docker run --rm --network none -v "$REF:/ref:ro" --entrypoint sh "$IMG" -c 'test -f /ref/index.html' >/dev/null 2>&1 || cmd_ref
  cmd_wait_serving "${1:-300}"
}

cmd_wait_serving() { # wait until the viewer answers a page (bounded), or report that it exited
  local i=0
  until docker run --rm --network "$NET" --entrypoint node "$IMG" -e "fetch('http://$P-viewer:8080/').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$P-viewer" 2>/dev/null)" != "true" ]; then log "viewer EXITED (code $(docker inspect -f '{{.State.ExitCode}}' "$P-viewer"))"; return 3; fi
    i=$((i + 1)); [ "$i" -gt "${1:-120}" ] && { log "viewer not serving after ${1:-120}s"; return 1; }; sleep 1
  done
  log "viewer serving after ~${i}s"
}

cmd_parity() { # acceptance 1+2: live body vs built body, enumerated differences only
  docker run --rm -i --network "$NET" -v "$OB1:/ob1:ro" -v "$REF:/ref:ro" \
    --entrypoint node "$IMG" /ob1/docker/wiki-viewer/test/parity-diff.mjs \
    --base "http://$P-viewer:8080" --built /ref "$@"
}

cmd_curl() { # GET a viewer URL from inside the network: status, x-wiki-* headers, cache-control, body bytes (add "body" to print it)
  docker run --rm --network "$NET" --entrypoint node "$IMG" --input-type=module -e "
    const r = await fetch('http://$P-viewer:8080' + process.argv[1], { redirect: 'manual' });
    const t = await r.text();
    console.log(r.status, 'x-wiki-render=' + r.headers.get('x-wiki-render'), 'x-wiki-page-class=' + r.headers.get('x-wiki-page-class'),
      'cache-control=' + r.headers.get('cache-control'), 'bytes=' + t.length);
    if (process.argv[2]) console.log(t);
  " "$@"
}

cmd_health() { # the viewer's /__health
  docker run --rm --network "$NET" --entrypoint node "$IMG" -e "fetch('http://$P-viewer:8080/__health').then(async r=>console.log(r.status, await r.text())).catch(e=>console.log('ERR', e.message))"
}

cmd_compile() { # generate|synth [recipe args...]: run a compile recipe against the disposable rest + the STUB llm
  local script
  case "$1" in
    generate) script=/ob1/recipes/entity-wiki/generate-wiki.mjs ;;
    synth) script=/ob1/recipes/wiki-synthesis/scripts/synthesize-notebooks.mjs ;;
    *) log "compile: generate|synth"; return 2 ;;
  esac
  shift
  docker run --rm --network "$NET" -v "$OB1:/ob1:ro" -v "$VOL:/wiki" -w /tmp \
    -e OPEN_BRAIN_URL=http://openbrain-rest -e OPEN_BRAIN_SERVICE_KEY=local-trust \
    -e LLM_API_KEY=stub -e LLM_BASE_URL=http://llm-stub:8080/v1 -e LLM_MODEL=stub-model \
    -e LLM_RETRY_BACKOFF_MS="${LLM_RETRY_BACKOFF_MS:-200}" -e LLM_TIMEOUT_MS="${LLM_TIMEOUT_MS:-600000}" \
    -e WIKI_GIT_DIR=/wiki -e OB_WIKI_OUT_DIR=/wiki/content \
    -e WIKI_PAGES_SYNC_TIMEOUT_MS=3000 --entrypoint node "$IMG" "$script" "$@"
}

cmd_stub() { # '<json>': set the stub llm's mode, e.g. '{"mode":"flaky503","n":3}'; no arg: print its state
  docker run --rm --network "$NET" --entrypoint node "$IMG" --input-type=module -e "
    const body = process.argv[1];
    const r = await fetch('http://llm-stub:8080/__stub/' + (body ? 'mode' : 'state'), body ? { method: 'POST', body } : {});
    console.log(await r.text());
  " "${1:-}"
}

cmd_notes() { # the compile notification ledger (front-end sink while P0's contract table is absent)
  docker run --rm -v "$VOL:/wiki:ro" --entrypoint sh "$IMG" -c 'cat /wiki/content/.compile-notifications.jsonl 2>/dev/null || echo "(no notifications)"'
}

cmd_cat() { # cat a file of the vault (read-only), or "(absent)"
  docker run --rm -v "$VOL:/wiki:ro" --entrypoint sh "$IMG" -c "cat '/wiki/$1' 2>/dev/null || echo '(absent)'"
}

cmd_psql() { docker exec -i "$P-db" psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -tA -c "$1"; }

# The wiki-service (the orchestrator), disposable: the env's vault, the
# fixture database, /recipes read-only from THIS worktree, the stub LLM; the
# worker and workbench URLs point at a dead port (non-fatal there), no git
# remote, no watcher, no scheduled drains. (VIEWER_URL is still passed so a
# PRE-P1c wiki-service image - a RED run - finds its idle probe dead too.)
cmd_ws() {
  docker rm -f -v "$P-ws" >/dev/null 2>&1 || true
  docker run -d --name "$P-ws" --network "$NET" -v "$VOL:/wiki" -v "$OB1/recipes:/recipes:ro" \
    -e OPEN_BRAIN_URL=http://openbrain-rest -e OPEN_BRAIN_SERVICE_KEY=local-trust -e MCP_ACCESS_KEY=fixture-key \
    -e LLM_API_KEY=stub -e LLM_BASE_URL=http://llm-stub:8080/v1 -e LLM_MODEL=stub-model -e LLM_RETRY_BACKOFF_MS=200 \
    -e WIKI_GIT_DIR=/wiki -e WIKI_OUT_DIR=/wiki/content -e COMPILE_ON_BOOT=true -e WIKI_WATCH_ENABLED=false \
    -e DRAIN_BEFORE_COMPILE=false -e WORKER_URL=http://127.0.0.1:9 -e WORKBENCH_URL=http://127.0.0.1:9 \
    -e VIEWER_URL=http://127.0.0.1:9 -e WIKI_BACKFILL_SUPERVISOR_MIN=0 -e WIKI_BACKFILL_CONTINUE_MIN=0 \
    -e WIKI_BATCH_MIN_LINKED=1 -e WIKI_PAGES_SYNC_TIMEOUT_MS=3000 -e P1A_DISPOSABLE="$P" \
    "$WSIMG" >/dev/null
  log "wiki-service started ($WSIMG); boot compile running"
}

cmd_ws_wait() { # wait (bounded) until the wiki-service finished a compile newer than $1 (an ISO time, default: any)
  docker run --rm --network "$NET" --entrypoint node "$IMG" --input-type=module -e "
    const since = process.argv[1] || '';
    const until = Date.now() + ${P1A_WS_WAIT_S:-240} * 1000;
    for (;;) {
      try {
        const r = await fetch('http://$P-ws:8000/status', { headers: { 'x-brain-key': 'fixture-key' } });
        const j = await r.json();
        if (!j.running && j.last && j.last.at && j.last.state === 'idle' && j.last.at > since) { console.log(JSON.stringify(j.last)); break; }
      } catch {}
      if (Date.now() > until) { console.log('TIMEOUT waiting for the wiki-service compile'); process.exit(1); }
      await new Promise((r) => setTimeout(r, 1000));
    }
  " "${1:-}"
}

cmd_ws_cycle() { # POST /recompile and wait for that compile to finish; prints its /status
  local t0
  t0="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  docker run --rm --network "$NET" --entrypoint node "$IMG" -e "fetch('http://$P-ws:8000/recompile', { method: 'POST', headers: { 'x-brain-key': 'fixture-key' } }).then(async r=>console.log('recompile', r.status, await r.text()))"
  cmd_ws_wait "$t0"
}

cmd_up() {
  cmd_db; cmd_rest; cmd_vault; cmd_seed; cmd_llm; cmd_viewer
}

cmd_down() {
  docker rm -f -v "$P-viewer" "$P-ws" "$P-llm" "$P-rest" "$P-postgrest" "$P-db" "$P-watch" >/dev/null 2>&1 || true
  docker volume rm "$VOL" "$REF" "$P-srv" "$P-srv-empty" "$P-srv-stale" >/dev/null 2>&1 || true
  [ -n "$SRV" ] && docker volume rm "$SRV" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  log "removed containers $P-*, volumes $VOL $REF and network $NET (images $IMG / $WSIMG / $FRIMG kept)"
}

c="${1:-}"; shift || true
case "$c" in
  vars|build|wsbuild|net|db|rest|llm|vault|node|seed|viewer|ref|refcat|wait_built|wait_serving|parity|curl|health|compile|stub|notes|cat|psql|ws|ws_wait|ws_cycle|up|down) "cmd_$c" "$@" ;;
  *) sed -n '2,38p' "$0"; exit 2 ;;
esac
