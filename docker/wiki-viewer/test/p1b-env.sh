#!/usr/bin/env bash
# rw-p1b-ready (research-workbench P1b) - the disposable pieces P1b adds to the
# P1a environment (test/p1a-env.sh: db, rest, vault, seed, llm stub, viewer).
# Same names, same rules: every container/volume is $P1A_PREFIX-*, the network
# is the P1a env's private one, images are tagged $P1A_TAG (never :local), no
# live container, network or volume is touched, nothing publishes a port.
#
#   bash OB1/docker/wiki-viewer/test/p1b-env.sh wbbuild        # openbrain-workbench:$P1A_TAG from this tree
#   bash OB1/docker/wiki-viewer/test/p1b-env.sh cdb            # $P-cdb: the REAL initdb chain (docker-compose.yml order) -> the P0 contract
#   bash OB1/docker/wiki-viewer/test/p1b-env.sh wb             # $P-wb: the workbench on $P-cdb (alias openbrain-workbench), VIEWER_NAV_URL -> the viewer's nav worker
#   bash OB1/docker/wiki-viewer/test/p1b-env.sh front          # $P-front: caddy running the portal Caddyfile's REAL (wiki_app) snippet
#   bash OB1/docker/wiki-viewer/test/p1b-env.sh post <class> <subject> [slug] [entity]   # post_research_notification on $P-cdb
#   bash OB1/docker/wiki-viewer/test/p1b-env.sh copyrows       # copy the fixture db's wiki_pages rows into $P-cdb (the workbench's search reads its own db)
#   bash OB1/docker/wiki-viewer/test/p1b-env.sh fget <path> [hdr...]  # GET through the front door: status, x-wiki-render, etag, server-timing, bytes
#   bash OB1/docker/wiki-viewer/test/p1b-env.sh chrome         # $P-chrome: headless Chromium (CDP on :9222) for the perf runs
#   bash OB1/docker/wiki-viewer/test/p1b-env.sh perfseed <rows> # replace wiki_pages with a SYNTHETIC vault of <rows> rows shaped like the live table
#   bash OB1/docker/wiki-viewer/test/p1b-env.sh health_status  # docker inspect .State.Health.Status of the viewer
#   bash OB1/docker/wiki-viewer/test/p1b-env.sh down           # remove the P1b pieces (then p1a-env.sh down for the rest)
set -euo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && (pwd -W 2>/dev/null || pwd))"
eval "$(bash "$HERE/p1a-env.sh" vars)"
WBIMG="openbrain-workbench:$TAG"
PG_IMAGE="${P1B_PG_IMAGE:-pgvector/pgvector:pg16}"
INITDB="$P-initdb"
REPO="$(cd "$OB1/.." && (pwd -W 2>/dev/null || pwd))"
log() { printf '[p1b-env] %s\n' "$*"; }

nodeq() { # run a node snippet on the env network (viewer image)
  docker run --rm -i --network "$NET" -e BODY --entrypoint node "$IMG" --input-type=module -e "$1" "${@:2}"
}

cmd_wbbuild() {
  local sha
  sha="$(git -C "$OB1" rev-parse HEAD)"
  log "building $WBIMG (OB1_SHA=$sha)"
  docker build --build-arg "OB1_SHA=$sha" -t "$WBIMG" "$OB1/docker/workbench"
}

cmd_cdb() { # the contract database: every init*.sql docker-compose.yml mounts on openbrain-db, in its order
  docker rm -f -v "$P-cdb" >/dev/null 2>&1 || true
  docker volume rm "$INITDB" >/dev/null 2>&1 || true
  docker volume create "$INITDB" >/dev/null
  local pairs
  pairs="$(grep -oE '\.{1,2}/[A-Za-z0-9_./-]+\.sql:/docker-entrypoint-initdb\.d/[0-9]{3}-[a-z0-9.-]+\.sql' "$OB1/docker/docker-compose.yml" | sed 's#:/docker-entrypoint-initdb\.d/# #')"
  local n; n="$(echo "$pairs" | grep -c .)"
  [ "$n" -ge 30 ] || { log "only $n migrations found in docker-compose.yml"; return 1; }
  echo "$pairs" | grep -q ' 230-init-research-contract.sql$' || { log "the chain has no 230-init-research-contract.sql"; return 1; }
  local script=""
  while read -r src dst; do script="${script}cp '/ob1/docker/$src' '/stage/$dst' && "; done <<<"$pairs"
  docker run --rm -v "$OB1:/ob1:ro" -v "$INITDB:/stage" --entrypoint sh "$IMG" -c "${script}true"
  docker run -d --name "$P-cdb" --network "$NET" -e POSTGRES_PASSWORD=fixture -e POSTGRES_DB=openbrain \
    -v "$INITDB:/docker-entrypoint-initdb.d:ro" "$PG_IMAGE" >/dev/null
  local i=0
  until docker logs "$P-cdb" 2>&1 | grep -q "PostgreSQL init process complete" && docker exec "$P-cdb" pg_isready -h 127.0.0.1 -U postgres -d openbrain -q 2>/dev/null; do
    i=$((i + 1)); [ "$i" -gt 240 ] && { log "contract db did not come up"; return 1; }; sleep 1
  done
  local errs; errs="$(docker logs "$P-cdb" 2>&1 | grep -c 'ERROR:' || true)"
  log "contract db up ($n migrations staged; initdb ERROR lines: $errs)"
}

cmd_wb() {
  docker rm -f -v "$P-wb" >/dev/null 2>&1 || true
  docker run -d --name "$P-wb" --network "$NET" --network-alias openbrain-workbench \
    -e PORT=8000 -e WORKBENCH_KEY=fixture-key -e DB_HOST="$P-cdb" -e DB_USER=postgres -e DB_PASSWORD=fixture \
    -e OPEN_BRAIN_URL=http://openbrain-rest -e VIEWER_NAV_URL="http://$P-viewer:8082" \
    -e EMBEDDING_API_BASE=http://unreachable.invalid/v1 -e EXTRACT_URL=http://unreachable.invalid \
    -e WIKI_GIT_DIR=/tmp/wiki -e WIKI_ASSETS_DIR=/tmp/wiki/assets -e CONTRACT_MOUNTS_ROOT=/mounts \
    -v "$OB1/recipes:/recipes:ro" "$WBIMG" >/dev/null
  local i=0
  until nodeq "const r = await fetch('http://$P-wb:8000/health').catch(() => null); process.exit(r && r.ok ? 0 : 1)" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 90 ] && { log "workbench not healthy"; docker logs --tail 30 "$P-wb"; return 1; }; sleep 1
  done
  log "workbench up ($WBIMG; alias openbrain-workbench; VIEWER_NAV_URL -> $P-viewer:8082)"
}

cmd_front() { # the portal Caddyfile's (wiki_app) snippet, verbatim, as the env's front door
  docker rm -f -v "$P-front" >/dev/null 2>&1 || true
  local cf="$REPO/portal/config/caddy/Caddyfile"
  local snip
  snip="$(awk '/^\(wiki_app\) \{/{f=1} f{print} f&&/^\}/{exit}' "$cf")"
  [ -n "$snip" ] || { log "no (wiki_app) snippet in $cf"; return 1; }
  docker volume rm "$P-frontcfg" >/dev/null 2>&1 || true
  docker volume create "$P-frontcfg" >/dev/null
  printf '{\n\tadmin off\n\tauto_https off\n}\n%s\n:8080 {\n\timport wiki_app\n}\n' "$snip" |
    docker run --rm -i -v "$P-frontcfg:/c" --entrypoint sh "$IMG" -c 'cat > /c/Caddyfile'
  docker run -d --name "$P-front" --network "$NET" -e WORKBENCH_KEY=fixture-key \
    -v "$P-frontcfg:/etc/caddy:ro" -v "$REPO/portal/config/caddy/site:/srv/site:ro" caddy:2-alpine >/dev/null
  local i=0
  until nodeq "const r = await fetch('http://$P-front:8080/__health').catch(() => null); process.exit(r ? 0 : 1)" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 60 ] && { log "front door not answering"; docker logs --tail 30 "$P-front"; return 1; }; sleep 1
  done
  log "front door up: http://$P-front:8080 (the portal's (wiki_app): /workbench/* -> openbrain-workbench:8000, else -> openbrain-wiki-viewer:8080, handle_errors)"
}

cmd_post() { # class subject [slug] [entity]: through the contract's producer API (psql variables: never spliced into SQL)
  printf '%s
' "select id, class, subject from public.post_research_notification(:'cls', :'subj', NULLIF(:'slug', ''), NULLIF(:'ent', ''));" |
    docker exec -i "$P-cdb" psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -tA       -v cls="$1" -v subj="$2" -v slug="${3:-}" -v ent="${4:-}"
}

cmd_copyrows() { # the fixture db's wiki_pages rows -> $P-cdb (the workbench's search reads its own database)
  docker exec "$P-cdb" psql -U postgres -d openbrain -q -c "TRUNCATE wiki_pages" >/dev/null
  docker exec "$P-db" pg_dump -U postgres -d openbrain -t public.wiki_pages --data-only --column-inserts |
    docker exec -i "$P-cdb" psql -U postgres -d openbrain -q -v ON_ERROR_STOP=1 >/dev/null
  docker exec "$P-cdb" psql -U postgres -d openbrain -tAc "select count(*) from wiki_pages"
}

cmd_fget() { # path [header=value ...]: GET through the front door
  nodeq "
    const [p, ...hs] = process.argv.slice(1);
    const headers = Object.fromEntries(hs.map((h) => h.split(/=(.*)/s).slice(0, 2)));
    const t0 = performance.now();
    const r = await fetch('http://$P-front:8080' + p, { redirect: 'manual', headers });
    const t = Buffer.from(await r.arrayBuffer());
    console.log(r.status, 'x-wiki-render=' + r.headers.get('x-wiki-render'), 'etag=' + r.headers.get('etag'),
      'server-timing=' + r.headers.get('server-timing'), 'bytes=' + t.length, 'ms=' + (performance.now() - t0).toFixed(1));
    if (process.env.BODY) console.log(t.toString('utf8'));
  " "$@"
}

cmd_chrome() {
  docker rm -f -v "$P-chrome" >/dev/null 2>&1 || true
  docker run -d --name "$P-chrome" --network "$NET" --shm-size=1g chromedp/headless-shell:latest >/dev/null
  local i=0
  until nodeq "const {lookup} = await import('node:dns/promises'); const a = await lookup('$P-chrome'); const r = await fetch('http://' + a.address + ':9222/json/version').catch(() => null); process.exit(r && r.ok ? 0 : 1)" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 60 ] && { log "chrome not answering"; return 1; }; sleep 1
  done
  log "headless chromium up ($P-chrome:9222)"
}

cmd_perfseed() { # <rows>: wiki_pages := a synthetic vault of <rows> rows, folder shape of the LIVE table
  # The live table on 2026-10-19 (aggregates only, read-only query): 76,542
  # rows; content/tool 19,159, organization 11,903, person 11,677, source
  # 9,581, project 8,389, thought 6,882, place 4,723, topic 3,927; the other
  # 301 are notebook hubs (one per content/notebooks/<s>/ folder), notes and
  # the root pages. Titles ~25 chars, ~3 links, ~2 tags per row. Scaled by
  # <rows>/76542; synthetic names only.
  local rows="$1" db="${P1B_SEED_DB:-$P-db}"
  docker exec -i "$db" psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -q -v rows="$rows" <<'SQL'
\set k (:rows / 76542.0)
TRUNCATE wiki_pages;
WITH f(folder, cls, et, n) AS (VALUES
  ('content/tool','entity','tool',19159), ('content/organization','entity','organization',11903),
  ('content/person','entity','person',11677), ('content/source','source',NULL,9581),
  ('content/project','entity','project',8389), ('content/thought','thought',NULL,6882),
  ('content/place','entity','place',4723), ('content/topic','entity','topic',3927))
INSERT INTO wiki_pages (slug, page_class, entity_type, title, body, tags, links, updated_at)
SELECT f.folder || '/' || coalesce(f.et, f.cls) || '-syn-' || i,
       f.cls, f.et,
       initcap(coalesce(f.et, f.cls)) || ' synthetic page ' || i,
       '', jsonb_build_array('wiki', 'syn-' || (i % 50)),
       jsonb_build_array('content/person/person-syn-' || ((i * 7) % 1000 + 1), 'content/tool/tool-syn-' || ((i * 13) % 1000 + 1), 'content/source/source-syn-' || ((i * 17) % 1000 + 1)),
       now()
  FROM f, generate_series(1, round(f.n * :k)::int) AS i;
INSERT INTO wiki_pages (slug, page_class, title, body, tags, links, updated_at)
SELECT 'content/notebooks/nb-syn-' || i || '/nb-syn-' || i, 'note', 'Notebook synthetic ' || i, '', '["notebook"]', '[]', now()
  FROM generate_series(1, round(270 * :k)::int) AS i;
INSERT INTO wiki_pages (slug, page_class, title, body, tags, links, updated_at)
SELECT 'notes/syn-folder-' || (i % 8) || '/note-syn-' || i, 'note', 'Note synthetic ' || i, '', '[]', '[]', now()
  FROM generate_series(1, round(28 * :k)::int) AS i;
INSERT INTO wiki_pages (slug, page_class, title, body, tags, links, updated_at) VALUES
  ('index', 'root', 'Knowledge Vault', '', '[]', '[]', now()),
  ('content/index', 'root', 'Content', '', '[]', '[]', now()),
  ('content/notebooks/index', 'note', 'Notebooks', '', '[]', '[]', now());
ANALYZE wiki_pages;
SQL
  docker exec "$db" psql -U postgres -d openbrain -tAc "select count(*), count(distinct regexp_replace(slug,'/[^/]*$','')) from wiki_pages"
}

cmd_health_status() { docker inspect --format '{{.State.Health.Status}}' "$P-viewer"; }

cmd_down() {
  docker rm -f -v "$P-wb" "$P-cdb" "$P-front" "$P-chrome" "$P-perf" >/dev/null 2>&1 || true
  docker volume rm "$INITDB" "$P-frontcfg" >/dev/null 2>&1 || true
  log "removed $P-wb $P-cdb $P-front $P-chrome and volumes $INITDB $P-frontcfg (images kept)"
}

c="${1:-}"; shift || true
case "$c" in
  wbbuild|cdb|wb|front|post|copyrows|fget|chrome|perfseed|health_status|down) "cmd_$c" "$@" ;;
  *) sed -n '2,24p' "$0"; exit 2 ;;
esac
