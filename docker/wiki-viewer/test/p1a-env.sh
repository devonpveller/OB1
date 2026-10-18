#!/usr/bin/env bash
# rw-p1a-render disposable test environment (research-workbench P1a).
#
# Everything here is DISPOSABLE and ISOLATED:
#   - one private network  wt-rw-p1a-render-net (10.231.47.0/24 - outside
#     192.168.0.0/16, never an ai-stack_* network);
#   - containers named     wt-rw-p1a-render-*  (removed with docker rm -f -v);
#   - two named volumes    wt-rw-p1a-render-vault (a COPY of the fixture vault)
#                          and wt-rw-p1a-render-srv (the viewer's /srv snapshots);
#   - the database is a fresh postgres seeded ONLY with the fixtures in
#     test/fixtures/ (synthetic rows; never the live openbrain-db).
# Network aliases (openbrain-db / openbrain-postgrest / openbrain-rest) exist
# only on the private network, so the real OB1 Caddyfile and the viewer's
# default OPEN_BRAIN_URL work unchanged.
#
# Usage (Git Bash on Windows or any POSIX shell, from anywhere):
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh build        # :wt-rw-p1a-render image (label = OB1 HEAD)
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh up           # db + rest + llm stub + seed + viewer
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh node <args>  # run node in the viewer image with OB1 at /ob1, vault at /wiki
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh psql "<sql>" # run SQL in the disposable db
#   bash OB1/docker/wiki-viewer/test/p1a-env.sh down         # remove everything this script created
set -euo pipefail
export MSYS_NO_PATHCONV=1

P=wt-rw-p1a-render
NET="$P-net"
SUBNET="${P1A_SUBNET:-10.231.47.0/24}"
VOL="$P-vault"
SRV="$P-srv"
IMG="openbrain-wiki-viewer:$P"
PORT="${P1A_PORT:-18899}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && (pwd -W 2>/dev/null || pwd))"
VIEWER="$(cd "$HERE/.." && (pwd -W 2>/dev/null || pwd))"
OB1="$(cd "$HERE/../../.." && (pwd -W 2>/dev/null || pwd))"

log() { printf '[p1a-env] %s\n' "$*"; }

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

cmd_build() {
  local sha
  sha="$(git -C "$OB1" rev-parse HEAD)"
  log "building $IMG from $VIEWER (OB1_SHA=$sha)"
  docker build --build-context "recipes=$OB1/recipes" --build-arg "OB1_SHA=$sha" -t "$IMG" "$VIEWER"
  docker image inspect "$IMG" --format 'label org.opencontainers.image.revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
}

cmd_net() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$SUBNET" "$NET" >/dev/null
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
  docker run --rm -v "$VOL:/wiki" -v "$HERE/fixtures/vault:/src:ro" --entrypoint sh "$IMG" \
    -c 'cp -a /src/. /wiki/ && find /wiki -type f | wc -l' | sed 's/^/[p1a-env] vault files: /'
}

cmd_node() { # run node inside the viewer image: OB1 tree at /ob1 (ro), vault at /wiki (rw)
  docker run --rm -i --network "$NET" -v "$OB1:/ob1:ro" -v "$VOL:/wiki" \
    -e OPEN_BRAIN_URL=http://openbrain-rest -e OPEN_BRAIN_SERVICE_KEY=local-trust \
    -e WIKI_GIT_DIR=/wiki -e WIKI_PAGES_SYNC_TIMEOUT_MS=3000 -e P1A_DISPOSABLE=wt-rw-p1a-render \
    ${P1A_NODE_ENV:-} --entrypoint node "$IMG" "$@"
}

cmd_seed() {
  cmd_node /ob1/docker/wiki-viewer/test/seed-fixtures.mjs
}

cmd_viewer() {
  docker rm -f -v "$P-viewer" >/dev/null 2>&1 || true
  # P1A_EXTRA_CLASS=1 (acceptance 10): bind-mount ONE extra page-class entry
  # file into lib/page-classes/ - nothing in the image or the repo changes.
  local extra=()
  [ -n "${P1A_EXTRA_CLASS:-}" ] && extra=(-v "$HERE/fixtures/extra-class/glossary.mjs:/quartz/lib/page-classes/glossary.mjs:ro")
  docker run -d --name "$P-viewer" --network "$NET" -p "127.0.0.1:$PORT:8080" \
    -v "$VOL:/wiki:ro" -v "$SRV:/srv" \
    -e OPEN_BRAIN_URL=http://openbrain-rest -e GRAPH_INDEX_MIN_ROWS=0 -e WIKI_NAV_MIN_ROWS=0 \
    -e WIKI_REBUILD_IDLE_SECONDS=1 -e WIKI_REBUILD_POLL_SECONDS=2 -e WIKI_REBUILD_STABLE_SECONDS=2 \
    -e WIKI_BUILDER="${WIKI_BUILDER:-1}" -e WIKI_DB_PROBE_MS="${WIKI_DB_PROBE_MS:-1000}" \
    -e WIKI_DB_CONNECT_GRACE_MS="${WIKI_DB_CONNECT_GRACE_MS:-4000}" \
    -e WIKI_RECONCILE_INTERVAL_MS="${WIKI_RECONCILE_INTERVAL_MS:-5000}" \
    -e NODE_OPTIONS=--max-old-space-size=2048 "${extra[@]}" \
    "$IMG" >/dev/null
  log "viewer started on http://127.0.0.1:$PORT (WIKI_BUILDER=${WIKI_BUILDER:-1})"
}

cmd_wait_built() { # wait until THIS viewer published its snapshot (the parity diff target) and serves pages
  local i=0
  until docker exec "$P-viewer" sh -c 'test -f /srv/current/index.html && test -f /srv/current/static/graphIndex.json' 2>/dev/null \
      && docker logs "$P-viewer" 2>&1 | grep -q "first COMPLETE build emitted" \
      && docker run --rm --network "$NET" --entrypoint node "$IMG" -e "fetch('http://$P-viewer:8080/').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt "${1:-300}" ] && { log "viewer not serving after ${1:-300}s"; return 1; }; sleep 1
  done
  log "built snapshot published and pages served after ~${i}s"
}

cmd_parity() { # acceptance 1+2: live body vs built body, enumerated differences only
  docker run --rm -i --network "$NET" -v "$OB1:/ob1:ro" -v "$SRV:/srv:ro" \
    --entrypoint node "$IMG" /ob1/docker/wiki-viewer/test/parity-diff.mjs \
    --base "http://$P-viewer:8080" --built /srv/current "$@"
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
    -e LLM_RETRY_BACKOFF_MS="${LLM_RETRY_BACKOFF_MS:-200}" -e WIKI_GIT_DIR=/wiki -e OB_WIKI_OUT_DIR=/wiki/content \
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

cmd_psql() { docker exec -i "$P-db" psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -tA -c "$1"; }

cmd_up() {
  cmd_db; cmd_rest; cmd_vault; cmd_seed; cmd_llm; cmd_viewer
}

cmd_down() {
  docker rm -f -v "$P-viewer" "$P-llm" "$P-rest" "$P-postgrest" "$P-db" >/dev/null 2>&1 || true
  docker volume rm "$VOL" "$SRV" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  log "removed containers, volumes $VOL $SRV and network $NET"
}

c="${1:-}"; shift || true
case "$c" in
  build|net|db|rest|llm|vault|node|seed|viewer|wait_built|parity|curl|compile|stub|notes|psql|up|down) "cmd_$c" "$@" ;;
  *) sed -n '2,22p' "$0"; exit 2 ;;
esac
