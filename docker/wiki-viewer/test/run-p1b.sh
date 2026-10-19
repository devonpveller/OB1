#!/usr/bin/env bash
# rw-p1b-ready (research-workbench P1b): the P1b acceptance cases, in the test
# plan's order, against the disposable environment (test/p1a-env.sh +
# test/p1b-env.sh). PASS/FAIL per case; exit non-zero if any case fails.
# The P1a runner (run-acceptance.sh) is the frozen P1a bar and runs on its own.
#
#   bash OB1/docker/wiki-viewer/test/run-p1b.sh                         # build + env + every case + down
#   ONLY="B1 B8" bash .../run-p1b.sh                                    # (debug) only these cases, after B0
#   P1A_PREFIX=wt-t-x P1A_TAG=wt-t-x P1A_SUBNET=10.198.x.0/24 bash .../run-p1b.sh   # a tester's own names
#   P1A_NO_BUILD=1                                                      # use the images already tagged $P1A_TAG
#   P1B_RED_IMG=openbrain-wiki-viewer:<base>                            # B1/B2/B9 also run against the BASE image (RED)
#   P1B_SOAK_MIN=1440                                                   # acceptance 6's soak (default 20 min)
#   P1B_PERF_SCALES="76542 382710"                                      # acceptance 3's vault sizes (rows)
#   KEEP=1                                                              # leave the environment up
#
# Nothing here touches a live container, network, volume or image; every name
# is $P1A_PREFIX-*; images are $P1A_TAG (never :local). Every wait is bounded.
set -uo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E="$HERE/p1a-env.sh"; B="$HERE/p1b-env.sh"
export P1A_PREFIX="${P1A_PREFIX:-wt-rw-p1b-ready}" P1A_TAG="${P1A_TAG:-${P1A_PREFIX:-wt-rw-p1b-ready}}" P1A_SUBNET="${P1A_SUBNET:-10.198.181.0/24}"
eval "$(bash "$E" vars)" || { echo "p1a-env.sh vars failed"; exit 2; }
REPO="$(cd "$OB1/.." && (pwd -W 2>/dev/null || pwd))"   # git.exe needs a Windows path under MSYS_NO_PATHCONV
SUBNET_MAIN="$SUBNET"
RUNDIR="$(mktemp -d)"; RUNDIR_W="$(cd "$RUNDIR" && (pwd -W 2>/dev/null || pwd))"   # host scratch, mounted by its Windows path
trap 'rm -rf "$RUNDIR"' EXIT
results=()
pass() { results+=("PASS $1"); echo "==> PASS $1"; }
fail() { results+=("FAIL $1 - $2"); echo "==> FAIL $1 - $2"; }
hdr() { echo; echo "################ $1"; }
want() { [ -z "${ONLY:-}" ] || [[ " $ONLY " == *" $1 "* ]]; }
T() { timeout "${1}" "${@:2}"; }
FRONT="http://$P-front:8080"
chk() { timeout 900 docker run --rm -i --network "$NET" -v "$OB1:/ob1:ro" --entrypoint node "$IMG" /ob1/docker/wiki-viewer/test/p1b-checks.mjs "$@"; }
psqlq() { docker exec -i "$P-db" psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -tA "$@"; }
viewer_fresh() { # [image] [WIKI_BUILDER]: a viewer on a NEW, EMPTY /srv volume
  docker rm -f -v "$P-viewer" >/dev/null 2>&1 || true
  docker volume rm "$P-srv-empty" >/dev/null 2>&1 || true
  P1A_SRV="$P-srv-empty" P1A_VIEWER_IMG="${1:-$IMG}" WIKI_BUILDER="${2:-0}" bash "$E" viewer >/dev/null
}
wait_db_page() { # bounded: until / answers 200 db (or 60 s)
  local i=0
  until [ "$(bash "$E" curl / 2>/dev/null | awk '{print $1, $2}')" = "200 x-wiki-render=db" ]; do
    i=$((i + 1)); [ "$i" -gt "${1:-60}" ] && return 1; sleep 1
  done
}
echo "names: prefix=$P tag=$TAG subnet=$SUBNET net=$NET viewer=$IMG workbench=openbrain-workbench:$TAG front=$FRONT"

hdr "B0 build + environment (db, rest, vault, seed, llm stub, viewer on an EMPTY /srv with WIKI_BUILDER=0, contract db, workbench, front door)"
bash "$B" down >/dev/null 2>&1; bash "$E" down >/dev/null 2>&1
if [ -z "${P1A_NO_BUILD:-}" ]; then
  T 2400 bash "$E" build 2>&1 | grep -E "# (tests|pass|fail)|label org|ERROR|error:" | tail -5
  T 900 bash "$E" wsbuild 2>&1 | grep -E "# (tests|pass|fail)|ERROR|naming to" | tail -3
  T 1200 bash "$B" wbbuild 2>&1 | grep -E "ok \||FAILED|ERROR|naming to" | tail -4
fi
P1A_SRV="$P-srv-empty" WIKI_BUILDER=0 T 600 bash "$E" up 2>&1 | tail -4
T 600 bash "$B" cdb 2>&1 | tail -2
T 300 bash "$B" wb 2>&1 | tail -2
T 120 bash "$B" front 2>&1 | tail -2
wait_db_page 90 && pass B0 || fail B0 "the viewer never served / as db"

if want B1; then
hdr "B1 (acceptance 1): a viewer with an EMPTY /srv serves the fixed URL list with x-wiki-render: db - no 503 splash; the bundle from the image"
b1=1
echo "-- /srv entries in the running viewer (WIKI_BUILDER=0): $(docker exec "$P-viewer" sh -c 'ls -A /srv | wc -l')"
[ "$(docker exec "$P-viewer" sh -c 'ls -A /srv | wc -l')" = 0 ] || { echo "x /srv is not empty"; b1=0; }
o="$(chk urls --base "$FRONT" 2>&1)"; echo "$o" | tail -20
echo "$o" | grep -q "URLS: PASS" || b1=0
# the bundle answered from the image's baked copy: the same bytes
for f in index.css prescript.js postscript.js; do
  a="$(docker exec "$P-viewer" sha256sum "/quartz/bundle/$f" | cut -c1-16)"; s="$(echo "$o" | grep -E "^asset 200 /$f " | sed -E 's/.*sha256=([0-9a-f]+).*/\1/')"
  echo "baked $f $a served $s"; [ -n "$a" ] && [ "$a" = "$s" ] || { echo "x $f not the baked bundle"; b1=0; }
done
# WIKI_BUILDER=1 on an empty /srv: served BEFORE the builder publishes anything
viewer_fresh "$IMG" 1; sleep 3
pre="$(docker exec "$P-viewer" sh -c 'test -e /srv/current && echo present || echo absent')"
o1="$(chk urls --base "$FRONT" 2>&1)"; post="$(docker exec "$P-viewer" sh -c 'test -e /srv/current && echo present || echo absent')"
echo "WIKI_BUILDER=1 cold: /srv/current before=$pre after=$post"; echo "$o1" | grep -E "^URLS|^x " | head -12
if [ "$pre" = absent ] && echo "$o1" | grep -q "URLS: PASS"; then :; else echo "x builder-on cold start not db from the first request (or /srv/current already there)"; b1=0; fi
[ "$b1" = 1 ] && pass B1 || fail B1 "an empty /srv did not serve every URL as db"
if [ -n "${P1B_RED_IMG:-}" ]; then
  echo "-- RED: the same check against $P1B_RED_IMG on an empty /srv (WIKI_BUILDER=0)"
  viewer_fresh "$P1B_RED_IMG" 0; sleep 4
  chk urls --base "$FRONT" 2>&1 | grep -E "^(URLS|503|x )" | head -6
fi
viewer_fresh "$IMG" 0; wait_db_page 60
fi

if want B2; then
hdr "B2 (acceptance 2): folder and tag pages list exactly as many entries as a wiki_pages query counts"
pagefilter="slug !~ '^(private|templates|\.obsidian)(/|\$)' AND slug !~ '(^|/)\\.'"
cnt_folder() { # folder ('' = root): distinct direct child names (a file and a folder of one name count once)
  local f="$1" pre; [ -n "$f" ] && pre="$f/" || pre=""
  psqlq -c "SELECT count(DISTINCT split_part(substr(slug, length('$pre') + 1), '/', 1)) FROM wiki_pages
            WHERE slug LIKE '$pre%' AND substr(slug, length('$pre') + 1) <> 'index' AND $pagefilter"
}
cnt_tag() {
  psqlq -c "SELECT count(*) FROM wiki_pages w WHERE $pagefilter AND w.slug <> 'tags/$1' AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(w.tags) t WHERE t = '$1' OR t LIKE '$1/%')"
}
cnt_tags() {
  psqlq -c "SELECT count(DISTINCT array_to_string((string_to_array(t, '/'))[1:g], '/')) FROM wiki_pages w,
            jsonb_array_elements_text(w.tags) t, generate_series(1, array_length(string_to_array(t, '/'), 1)) g WHERE $pagefilter"
}
exp="{"
for f in content content/person content/source content/thought content/tool content/notebooks notes notes/private notes/slug-names; do exp="$exp\"/$f/\":$(cnt_folder "$f"),"; done
for t in fixture-tag wiki generated; do exp="$exp\"/tags/$t\":$(cnt_tag "$t"),"; done
exp="$exp\"/tags/\":$(cnt_tags)}"
echo "SQL: $exp"
o="$(chk counts --base "$FRONT" --expect "$exp" 2>&1)"; echo "$o"
echo "$o" | grep -q "COUNTS: PASS" && pass B2 || fail B2 "a listing count differs from the wiki_pages query"
fi

if want B8; then
hdr "B8 (ETag on pages): a db page carries a weak ETag over its bytes; If-None-Match -> 304, no body; a changed row -> a new ETag; states that are not pages carry none"
b8=1
l1="$(bash "$B" fget /content/person/person-ada-fixture)"; echo "$l1"
et="$(echo "$l1" | sed -E 's/.*etag=(W\/"p-[0-9a-f]{16}").*/\1/')"
echo "$et" | grep -qE '^W/"p-[0-9a-f]{16}"$' || { echo "x no page ETag"; b8=0; }
l2="$(bash "$B" fget /content/person/person-ada-fixture "if-none-match=$et")"; echo "$l2"
echo "$l2" | grep -qE '^304 .* bytes=0 ' || { echo "x If-None-Match did not give 304 with no body"; b8=0; }
psqlq -c "UPDATE wiki_pages SET body = body || E'\n\nETag probe line.', updated_at = now() WHERE slug = 'content/person/person-ada-fixture'" >/dev/null
l3="$(bash "$B" fget /content/person/person-ada-fixture "if-none-match=$et")"; echo "$l3"
echo "$l3" | grep -qE '^200 x-wiki-render=db etag=W/"p-' && ! echo "$l3" | grep -qF "etag=$et " || { echo "x a changed row kept the old ETag / answered 304"; b8=0; }
l4="$(bash "$B" fget /content/person/person-nobody-at-all)"; echo "$l4"
echo "$l4" | grep -qE 'x-wiki-render=not-available etag=null' || { echo "x a non-page state carries an ETag"; b8=0; }
n1="$(bash "$B" fget '/workbench/nav?folder=content')"; echo "$n1"
net="$(echo "$n1" | sed -E 's/.*etag=(W\/"navf-[0-9a-f]{16}").*/\1/')"
n2="$(bash "$B" fget '/workbench/nav?folder=content' "if-none-match=$net")"; echo "$n2"
echo "$n2" | grep -qE '^304 ' || { echo "x the nav did not revalidate through the workbench"; b8=0; }
[ "$b8" = 1 ] && pass B8 || fail B8 "page/nav validators"
fi

if want B10; then
hdr "B10 (/workbench/nav): one folder per request through the front door and the workbench; the order is Quartz's explorer comparator over the SQL rows; paged; focus; refuses traversal"
b10=1
nexp="$RUNDIR/navorder.json"
docker exec -i "$P-db" psql -U postgres -d openbrain -tA -c "
  WITH r AS (SELECT slug, title FROM wiki_pages WHERE slug !~ '^(private|templates|\.obsidian)(/|\$)' AND slug !~ '(^|/)\\.')
  SELECT json_object_agg(f, items) FROM (
    SELECT f, json_agg(json_build_array(name, coalesce(dt, name), is_dir)) AS items FROM (
      SELECT DISTINCT ON (f, name) f, name, is_dir,
             CASE WHEN is_dir THEN (SELECT r2.title FROM r r2 WHERE r2.slug IN (f2 || '/index', f2) ORDER BY (r2.slug = f2) DESC LIMIT 1)
                  ELSE (SELECT r3.title FROM r r3 WHERE r3.slug = f2) END AS dt
        FROM (SELECT CASE WHEN f = '' THEN '' ELSE f END AS f, name, is_dir, CASE WHEN f = '' THEN name ELSE f || '/' || name END AS f2
                FROM (SELECT x.f, split_part(substr(r.slug, length(x.p) + 1), '/', 1) AS name,
                             position('/' in substr(r.slug, length(x.p) + 1)) > 0 AS is_dir
                        FROM r, (VALUES ('', ''), ('content', 'content/'), ('content/person', 'content/person/')) AS x(f, p)
                       WHERE r.slug LIKE x.p || '%' AND substr(r.slug, length(x.p) + 1) <> 'index') q) q2
       ORDER BY f, name, is_dir DESC) q3 GROUP BY f) q4" > "$nexp"
head -c 400 "$nexp"; echo
docker run --rm -i --network "$NET" -v "$OB1:/ob1:ro" -v "$RUNDIR_W:/x:ro" --entrypoint node "$IMG" \
  /ob1/docker/wiki-viewer/test/p1b-checks.mjs navorder --base "$FRONT" --expect /x/navorder.json > "$nexp.out" 2>&1; cat "$nexp.out"
grep -q "NAVORDER: PASS" "$nexp.out" || b10=0
rm -f "$nexp" "$nexp.out"
for p in '/workbench/nav?folder=content/person&limit=1' '/workbench/nav?folder=content/person&limit=1&offset=1' \
         '/workbench/nav?folder=content/person&limit=1&focus=content/person/person-bob-fixture' '/workbench/nav?folder=content/../x' '/workbench/nav?folder=nope'; do
  BODY=1 bash "$B" fget "$p" | head -2 | cut -c1-260
done
BODY=1 bash "$B" fget '/workbench/nav?folder=content/person&limit=1&focus=content/person/person-bob-fixture' | grep -q '"slug":"content/person/person-bob-fixture"' || { echo "x focus did not return the page holding the entry"; b10=0; }
bash "$B" fget '/workbench/nav?folder=content/../x' | grep -q '^400 ' || { echo "x traversal not refused"; b10=0; }
bash "$B" fget '/workbench/nav?folder=nope' | grep -q '^404 ' || { echo "x unknown folder not 404"; b10=0; }
[ "$b10" = 1 ] && pass B10 || fail B10 "nav API"
fi

if want B11; then
hdr "B11 (tag search on the API): /workbench/search?tag= returns the pages whose tags contain it (= SQL); #tag term is the full-text search filtered by the tag"
b11=1
bash "$B" copyrows | sed 's/^/rows copied to the workbench db: /'
for t in fixture-tag FIXTURE gener; do
  sql="$(docker exec "$P-cdb" psql -U postgres -d openbrain -tA -c "SELECT string_agg(slug, ',' ORDER BY slug) FROM wiki_pages WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) v WHERE lower(v) LIKE '%' || lower('$t') || '%')")"
  api="$(BODY=1 bash "$B" fget "/workbench/search?tag=$t&limit=50" | tail -1 | docker run --rm -i --entrypoint node "$IMG" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.results.map(r=>r.slug).sort().join(','))})")"
  echo "tag=$t sql=[${sql}] api=[${api}]"
  [ "$sql" = "$api" ] || { echo "x tag $t: API differs from SQL"; b11=0; }
done
o="$(BODY=1 bash "$B" fget '/workbench/search?tag=fixture-tag&q=ada' | tail -1)"; echo "$o" | cut -c1-300
echo "$o" | grep -q '"tag":"fixture-tag"' || { echo "x tag+term mode"; b11=0; }
[ "$b11" = 1 ] && pass B11 || fail B11 "tag search"
fi

if want B7; then
hdr "B7 (acceptance 7): a transient and a structural notification posted through the contract appear in the strip on the next page load - class, subject, jump; acknowledge; nothing routed elsewhere"
b7=1
bash "$B" post structural "compile structural failure: content/person/person-bob-fixture" content/person/person-bob-fixture 902
bash "$B" post transient "LLM call failing for this task: #901" "" "#901"
sleep 2
pg="$(BODY=1 bash "$B" fget /content/thought/9001)"
strip="$(echo "$pg" | tr -d '\n' | grep -o '<div class="wiki-notifications"[^§]*</ul></div><div class="page-header">' | head -1)"
echo "$strip" | sed 's/<style>[^<]*<\/style>//' | cut -c1-900
echo "$strip" | grep -q 'data-class="structural"[^>]*><span class="wn-class">structural</span> <a class="wn-jump" href="/content/person/person-bob-fixture">compile structural failure: content/person/person-bob-fixture</a>' || { echo "x structural not in the strip with class/subject/jump"; b7=0; }
echo "$strip" | grep -q 'data-class="transient"[^>]*><span class="wn-class">transient</span> <a class="wn-jump" href="/content/person/person-ada-fixture">LLM call failing for this task: #901</a>' || { echo "x transient not in the strip, or its entity jump is not the entity's page"; b7=0; }
for j in /content/person/person-bob-fixture /content/person/person-ada-fixture; do bash "$B" fget "$j" | grep -q '^200 x-wiki-render=db' || { echo "x jump $j not a db page"; b7=0; }; done
ack="$(echo "$strip" | grep -o 'href="/__notifications/ack?[^"]*"' | head -1 | sed -e 's/^href="//' -e 's/"$//' -e 's/&amp;/\&/g')"
echo "ack link: $ack"
ah="$(docker run --rm --network "$NET" --entrypoint node "$IMG" --input-type=module -e "
  const r = await fetch('$FRONT' + process.argv[1], { redirect: 'manual' }); const c = r.headers.get('set-cookie');
  console.log(r.status, r.headers.get('location'), c);
  const p = await fetch('$FRONT/content/thought/9001', { headers: { cookie: c.split(';')[0] } }); const t = await p.text();
  console.log('after-ack', (/data-unread=\"([^\"]*)\"/.exec(t) || [])[1]);" "$ack")"
echo "$ah"
echo "$ah" | grep -q '^303 /content/thought/9001 wiki_notif_ack=' && echo "$ah" | grep -q '^after-ack 0$' || { echo "x acknowledge"; b7=0; }
lst="$(BODY=1 bash "$B" fget /__notifications)"; echo "$lst" | grep -o '<li id="n-[^"]*" class="[a-z]*"><b>[a-z]*</b> <a href="[^"]*">[^<]*' | head -5
[ "$(echo "$lst" | grep -o '<li id="n-' | wc -l)" -ge 2 ] || { echo "x the list page"; b7=0; }
# nothing routed elsewhere: the strip only reads; no chat/status-pipe sink anywhere in the viewer
if grep -nEi 'mattermost|telegram|status[-_ ]?pipe|webhook|post_research_notification' "$OB1/docker/wiki-viewer/lib/notifications.mjs" "$OB1/docker/wiki-viewer/serve.mjs" | grep -v '^\s*//' | grep -v ':\s*//\|:\s*\*' ; then echo "x a sink outside the front end"; b7=0; fi
grep -c 'notification' "$OB1/docker/wiki-viewer/lib/notifications.mjs" >/dev/null
docker logs "$P-wb" 2>&1 | grep -Ei 'mattermost|telegram|status' | head -3
[ "$b7" = 1 ] && pass B7 || fail B7 "the notifications strip"
fi

if want B12; then
hdr "B12 (consumers): the compiler's idle gate - healthchecks and probes never count as reader activity, a page does; the compose healthcheck = the image HEALTHCHECK"
b12=1
la() { bash "$E" node -e "fetch('http://$P-viewer:8080/__last-access').then(r=>r.json()).then(j=>console.log(j.ts))"; }
t1="$(la)"; sleep 6
for i in 1 2 3; do docker exec "$P-viewer" node -e "fetch('http://127.0.0.1:8080/__health').then(r=>r.text())" >/dev/null; done
t2="$(la)"; echo "last-access before=$t1 after 3 health probes=$t2"
[ "$t1" = "$t2" ] || { echo "x a health probe counted as activity"; b12=0; }
bash "$B" fget /content/thought/9001 >/dev/null; t3="$(la)"; echo "after a page: $t3"
[ "$t3" != "$t2" ] || { echo "x a page did not count"; b12=0; }
img="$(docker image inspect "$IMG" --format '{{json .Config.Healthcheck.Test}}')"
cmp="$(grep -A1 'openbrain-wiki-viewer' -m1 "$OB1/docker/docker-compose.yml" >/dev/null; awk '/^  openbrain-wiki-viewer:/{f=1} f&&/test: \[/{print; exit}' "$OB1/docker/docker-compose.yml" | sed -E 's/^ *test: //')"
echo "image  : $img"; echo "compose: $cmp"
python - "$img" "$cmp" <<'PY' || { echo "x compose healthcheck differs from the image's"; b12=0; }
import json, sys
a = json.loads(sys.argv[1]); b = json.loads(sys.argv[2])
print("same command:", a[1:] == b[1:] and a[0] in ("CMD", "CMD-SHELL") and b[0] == a[0])
sys.exit(0 if a == b else 1)
PY
[ "$b12" = 1 ] && pass B12 || fail B12 "consumer behaviour"
fi

if want B9; then
hdr "B9 (E3): graphIndex.json readiness retired - no derive step, no published index, the live index answers from the db, no file fallback; no splash code"
b9=1
docker run --rm --entrypoint sh "$IMG" -c 'test ! -e /derive-graph-index.mjs && echo "no /derive-graph-index.mjs"; grep -c "node /derive-graph-index" /entrypoint.sh || true; grep -cE "bundleReady|const SPLASH|const REQUIRED" /quartz/serve.mjs || true; ls /quartz/bundle /quartz/bundle/static | head -20' > "$RUNDIR/b9" 2>&1
cat "$RUNDIR/b9"
[ "$(sed -n 2p "$RUNDIR/b9")" = 0 ] && [ "$(sed -n 3p "$RUNDIR/b9")" = 0 ] && grep -q 'no /derive-graph-index.mjs' "$RUNDIR/b9" || { echo "x a builder-era readiness remnant in the image"; b9=0; }
g="$(docker run --rm --network "$NET" --entrypoint node "$IMG" -e "fetch('$FRONT/static/graphIndex.json').then(async r=>console.log(r.status, r.headers.get('x-wiki-nav'), (await r.text()).length))")"; echo "graphIndex.json: $g"
echo "$g" | grep -q '^200 db ' || { echo "x the live index"; b9=0; }
# the builder-on viewer publishes NO graphIndex.json
viewer_fresh "$IMG" 1; T 400 bash "$E" wait_built 360 >/dev/null 2>&1
pub="$(docker exec "$P-viewer" sh -c 'ls /srv/current/static/ 2>/dev/null | tr "\n" " "; test -e /srv/current/static/graphIndex.json && echo PUBLISHED || echo none')"; echo "published static/: $pub"
echo "$pub" | grep -q 'none$' || { echo "x a graph index was published"; b9=0; }
# the built bundle and the baked one: same bytes? (informational - which one serves is in B1)
for f in index.css prescript.js postscript.js; do echo "$f built=$(docker exec "$P-viewer" sha256sum "/srv/current/$f" | cut -c1-16) baked=$(docker exec "$P-viewer" sha256sum "/quartz/bundle/$f" | cut -c1-16)"; done
docker stop "$P-db" >/dev/null; sleep 4
g2="$(docker run --rm --network "$NET" --entrypoint node "$IMG" -e "fetch('$FRONT/static/graphIndex.json').then(async r=>console.log(r.status, r.headers.get('x-wiki-nav')))")"; echo "graphIndex.json with the db stopped (after the cache): $g2"
docker start "$P-db" >/dev/null; T 120 bash -c "until docker exec $P-db pg_isready -U postgres -q 2>/dev/null; do sleep 1; done"
viewer_fresh "$IMG" 0; wait_db_page 90
[ "$b9" = 1 ] && pass B9 || fail B9 "graphIndex readiness"
fi

if want B4; then
hdr "B4 (acceptance 4): docker inspect shows the viewer's healthcheck healthy; it goes unhealthy with the database down and back to healthy"
b4=1
s=""; for i in $(seq 1 30); do s="$(bash "$B" health_status)"; [ "$s" = healthy ] && break; sleep 5; done
echo "health after start: $s ($(docker inspect --format '{{len .State.Health.Log}}' "$P-viewer") probes)"; [ "$s" = healthy ] || { echo "x never healthy"; bash "$E" health | cut -c1-400; b4=0; }
docker stop "$P-db" >/dev/null
for i in $(seq 1 40); do s="$(bash "$B" health_status)"; [ "$s" = unhealthy ] && break; sleep 5; done
echo "db stopped -> $s"; [ "$s" = unhealthy ] || { echo "x not unhealthy with the db down"; b4=0; }
docker start "$P-db" >/dev/null
for i in $(seq 1 40); do s="$(bash "$B" health_status)"; [ "$s" = healthy ] && break; sleep 5; done
echo "db back -> $s"; [ "$s" = healthy ] || { echo "x not healthy again"; b4=0; }
[ "$b4" = 1 ] && pass B4 || fail B4 "healthcheck"
fi

if want B6; then
hdr "B6+B5 (acceptance 6, 5): one-time backfill (notes excluded) -> zero drift; a 200-URL crawl through the front door never hits handle_errors; zero drift after it; soak with the compiler running"
b6=1
# 160 more pages so a crawl has >= 200 distinct URLs (tool pages tagged "crawl", > 10 so the tag index truncates)
bash "$E" node -e "
  const fs=require('fs'); fs.mkdirSync('/wiki/content/tool',{recursive:true});
  for(let i=1;i<=160;i++){const n=String(i).padStart(3,'0');fs.writeFileSync('/wiki/content/tool/tool-crawl-'+n+'.md','---\ntitle: \"Crawl tool '+n+'\"\ntags: [crawl, wiki]\nentity_id: '+(5000+i)+'\n---\n# Crawl tool '+n+'\n\nSee [[tool-crawl-'+String(i%160+1).padStart(3,'0')+']] and [[person-ada-fixture]].\n')}
  console.log('wrote 160 crawl pages')"
bf="$(T 600 bash "$E" node /ob1/recipes/_shared/backfill-wiki-pages.mjs 2>&1)"; echo "$bf" | tail -6
echo "rows: $(psqlq -c "select count(*) || ' rows, notes ' || count(*) filter (where page_class='note') from wiki_pages")"
hrep() { bash "$E" health | sed -E 's/^([0-9]+) .*"drift":([0-9]+).*"missing":(\[[^]]*\]).*"stale":(\[[^]]*\]).*/\1 drift=\2 missing=\3 stale=\4/' | cut -c1-300; }
# B2b (acceptance 2, P1a F7): the tag index sorts THEN keeps the first 10 (Quartz TagContent; > 10 "crawl" pages now)
for i in $(seq 1 90); do bash "$B" fget /tags/crawl | grep -q '^200 x-wiki-render=db' && BODY=1 bash "$B" fget /tags/crawl | grep -q '160 items with this tag' && break; sleep 1; done
tw="$(psqlq -c "SELECT json_agg(title) FROM (SELECT title FROM wiki_pages WHERE tags ? 'crawl' ORDER BY updated_at DESC, lower(title) LIMIT 10) x")"
o="$(chk tagindex --base "$FRONT" --tag crawl --expect "$tw" 2>&1)"; echo "$o"
echo "$o" | grep -q "TAGINDEX: PASS" && pass B2b || fail B2b "the tag index does not show a tag's first 10 pages in order"
sleep 7; h="$(hrep)"; echo "after backfill: $h"
echo "$h" | grep -q '^200 drift=0 ' || { echo "x drift after the backfill"; bash "$E" health | cut -c1-1200; b6=0; }
o="$(chk crawl --base "$FRONT" --min 200 --tags crawl,fixture-tag,wiki 2>&1)"; echo "$o" | tail -4
echo "$o" | grep -q "CRAWL: PASS" && b5=1 || b5=0
sleep 7; h="$(hrep)"; echo "after the crawl: $h"; echo "$h" | grep -q '^200 drift=0 ' || { echo "x drift after the crawl"; b6=0; }
# the detector works: with the viewer stopped the front door's error path answers (and says so)
docker stop "$P-viewer" >/dev/null; e="$(bash "$B" fget /content/thought/9001)"; docker start "$P-viewer" >/dev/null; echo "viewer stopped: $e"
echo "$e" | grep -q 'x-wiki-render=front-door-error' || { echo "x the error path is not detectable"; b5=0; }
wait_db_page 90
# consumers: every listed file is changed on this branch (file:line in the PR / findings)
base="${P1B_BASE:-development}"
for f in OB1/docker/wiki-service/wiki-service.mjs scripts/checks/wiki-latency-probe.ps1 scripts/checks/test-quartz4-offline.ps1 \
         scripts/checks/check-openbrain-health.ps1 scripts/recovery/emergency-recovery.ps1 scripts/lib/stack-services.json \
         OB1/docker/wiki-viewer/README.md OB1/docker/docker-compose.preview.yml frontend/status-pipe .claude/skills/stack-map/SKILL.md \
         .claude/skills/stack-map/references/workspace-stacks.md portal/config/caddy/Caddyfile; do
  mb="$(git -C "$REPO" merge-base "$base" HEAD)"   # the branch point: a development that moved since is not this item's change
  case "$f" in OB1/*) ch="$(git -C "$OB1" diff --stat "$(git -C "$REPO" rev-parse "$mb:OB1" 2>/dev/null || echo d79b7db)" -- "${f#OB1/}" | tail -1)" ;;
               *) ch="$(git -C "$REPO" diff --stat "$mb" -- "$f" | tail -1)" ;; esac
  echo "consumer $f: ${ch:-UNCHANGED}"; [ -n "$ch" ] || { echo "x consumer $f not changed"; b5=0; }
done
[ "$b5" = 1 ] && pass B5 || fail B5 "crawl / consumers"
# soak: the compiler cycles while the reconcile is read every 30 s
SOAK="${P1B_SOAK_MIN:-20}"
T 300 bash "$E" ws >/dev/null 2>&1; T 300 bash "$E" ws_wait >/dev/null 2>&1
echo "soak: ${SOAK} min, a compile every 3 min, the reconcile every 30 s"
end=$(( $(date +%s) + SOAK * 60 )); nxt=$(date +%s); worst=0; samples=0
while [ "$(date +%s)" -lt "$end" ]; do
  if [ "$(date +%s)" -ge "$nxt" ]; then T 300 bash "$E" ws_cycle >/dev/null 2>&1; nxt=$(( $(date +%s) + 180 )); fi
  hj="$(bash "$E" health)"; d="$(echo "$hj" | grep -oE '"drift":[0-9]+' | head -1 | cut -d: -f2)"; samples=$((samples + 1))
  if [ -n "$d" ] && [ "$d" -gt 0 ]; then
    worst=$(( d > worst ? d : worst ))
    # name the writer that skipped the row (by the page class the slug belongs to)
    echo "$hj" | grep -oE '"(missing|stale|orphan|empty|failed)":\[[^]]*\]' | sed -E \
      -e 's#"content/(person|organization|tool|project|place|topic)/#&<generate-wiki entity pages>#g' -e 's#"content/source/#&<source leaves (wiki-service)>#g' \
      -e 's#"content/thought/#&<generate-wiki thought leaves>#g' -e 's#"content/notebooks/#&<synthesize-notebooks>#g' -e 's#"notes/#&<workbench notes>#g' | head -5
  fi
  sleep 30
done
echo "soak done: $samples reconcile samples, worst drift $worst"
[ "$worst" = 0 ] || b6=0
[ "$b6" = 1 ] && pass B6 || fail B6 "drift (see the named writers above)"
fi

if want B3; then
hdr "B3 (acceptance 3): explorer per navigation, nav TTFB, nav payload - the current vault's size, five times it, and through Slow 4G"
b3=1
PP="$P-p"; export P1A_PREFIX="$PP" P1A_SUBNET="${P1B_PERF_SUBNET:-10.198.183.0/24}"
eval "$(bash "$E" vars)"; FRONT="http://$P-front:8080"
bash "$B" down >/dev/null 2>&1; bash "$E" down >/dev/null 2>&1
WIKI_BUILDER=0 WIKI_RECONCILE_INTERVAL_MS=600000 P1A_HEAP_MB=6144 T 600 bash "$E" up 2>&1 | tail -2
T 600 bash "$B" cdb >/dev/null 2>&1; T 300 bash "$B" wb 2>&1 | tail -1; T 120 bash "$B" front 2>&1 | tail -1; T 120 bash "$B" chrome 2>&1 | tail -1
TARGETS="index content/tool/tool-syn-1 content/person/person-syn-500 content/organization/organization-syn-9000 content/source/source-syn-30 content/thought/thought-syn-6000 content/place/place-syn-4000 content/tool/tool-syn-18000 content/project/project-syn-8000 notes/syn-folder-1/note-syn-9 content/topic/topic-syn-3000 content/notebooks/nb-syn-77/nb-syn-77"
for rows in ${P1B_PERF_SCALES:-76542 382710}; do
  echo "-- vault of $rows rows"
  T 900 bash "$B" perfseed "$rows" | sed 's/^/seeded (rows|folders): /'
  # the workbench reads its own database (graph, search): the same synthetic rows there
  P1B_SEED_DB="$P-cdb" T 900 bash "$B" perfseed "$rows" | sed 's/^/seeded the workbench db (rows|folders): /'
  bash "$E" node -e "
    const fs=require('fs'),p=require('path');
    for (const s of process.argv.slice(1)) { const f='/wiki/'+s+'.md'; fs.mkdirSync(p.dirname(f),{recursive:true}); fs.writeFileSync(f,'---\ntitle: \"'+s.split('/').pop()+'\"\n---\n# '+s+'\n\nA synthetic perf page. [[tool-syn-2]] [[person-syn-3]]\n'); }
    console.log('target files', process.argv.length - 1)" $TARGETS
  inlist="$(printf "'%s'," $TARGETS)"; psqlq -c "UPDATE wiki_pages SET body = 'A synthetic perf page. [[tool-syn-2]] [[person-syn-3]]', updated_at = now() + interval '1 second' WHERE slug IN (${inlist%,})" | tail -1
  docker restart "$P-viewer" >/dev/null; wait_db_page 600 || echo "x viewer not serving after restart"
  want_tool="$(psqlq -c "select count(*) from wiki_pages where slug like 'content/tool/%'")"
  for i in $(seq 1 180); do BODY=1 bash "$B" fget '/workbench/nav?folder=content/tool&limit=1' | grep -q "\"total\":$want_tool," && break; sleep 5; done
  echo "nav shows content/tool with $want_tool children after ~$((i * 5)) s"
  docker logs "$P-viewer" 2>&1 | grep "nav index refreshed" | tail -2
  for w in 1 2 3; do bash "$B" fget '/workbench/nav?folder=content' >/dev/null; done
  pages="$(echo $TARGETS | tr ' ' ',')"
  for mode in "" "--throttle" "--throttle --mobile"; do
    o="$(T 1800 docker run --rm --network "$NET" -v "$OB1:/ob1:ro" --entrypoint node "$IMG" /ob1/docker/wiki-viewer/test/perf-nav.mjs \
         --front "$FRONT" --chrome "$P-chrome" --pages "$pages" --label "${rows}${mode:+ $mode}" $mode $( [ -n "$mode" ] && echo --browser-only ) 2>&1)"
    echo "== $rows rows ${mode:-unthrottled desktop}"; echo "$o" | grep -v '^PERF-RESULT'
    echo "$o" | grep '^PERF-RESULT' > "$RUNDIR/perf-$rows-$(echo "${mode:-plain}" | tr -dc 'a-z').json"
    echo "$o" | grep -q '^PERF-RESULT' || { echo "x no perf result"; b3=0; }
  done
  # a burst across a refresh: a row is written, the half-TTL passes, the next reader starts the refresh
  psqlq -c "UPDATE wiki_pages SET updated_at = now() + interval '2 second' WHERE slug = 'content/tool/tool-syn-1'" >/dev/null; sleep 16
  o="$(T 120 docker run --rm --network "$NET" -v "$OB1:/ob1:ro" --entrypoint node "$IMG" /ob1/docker/wiki-viewer/test/perf-nav.mjs --front "$FRONT" --refresh-burst --burst-ms 20000 2>&1)"
  echo "$o" | grep -v '^PERF-RESULT'; echo "$o" | grep '^PERF-RESULT' > "$RUNDIR/perf-$rows-burst.json"
  docker logs --since 60s "$P-viewer" 2>&1 | grep "nav index refreshed" | tail -2
done
# the judge: floor in every run (explorer < 200 ms per navigation, nav TTFB < 300 ms server-attributable, payload < 2 MB per navigation)
docker run --rm -i -v "$RUNDIR_W:/r:ro" --entrypoint node "$IMG" --input-type=module -e "
  import { readdirSync, readFileSync } from 'node:fs';
  let fail = 0; const L = (m) => console.log(m);
  for (const f of readdirSync('/r').filter((x) => /^perf-\d+-/.test(x)).sort()) {
    const r = JSON.parse(readFileSync('/r/' + f, 'utf8').replace(/^PERF-RESULT /, ''));
    const lat = r.throttle ? r.throttle.latency : 0;
    if (r.server) for (const [k, v] of Object.entries(r.server)) if (v.ttfb) { const ok = v.ttfb.max < 300 && v.bytesMax < 2e6; if (!ok) fail++; L(f + ' server ' + k + ' ttfb max ' + v.ttfb.max + ' p95 ' + v.ttfb.p95 + ' bytes ' + v.bytesMax + (ok ? ' ok' : ' OVER')); }
    if (r.refreshBurst) { const ok = r.refreshBurst.max < 300; if (!ok) fail++; L(f + ' refresh-burst ttfb max ' + r.refreshBurst.max + ' p95 ' + r.refreshBurst.p95 + (ok ? ' ok' : ' OVER')); }
    if (r.browser) {
      for (const n of r.browser.navs) {
        const t = n.navTtfb.filter((x) => x != null); const tm = t.length ? Math.max(...t) - lat : 0;
        const ex = n.explorerMs ?? 0;
        const ok = (r.mobile || ex < 200) && tm < 300 && n.navBytes < 2e6 && n.indexFetched.length === 0;
        if (!ok) fail++;
        L(f + ' nav ' + n.to + ' explorer ' + ex + 'ms ttfb(server part) ' + tm.toFixed(1) + 'ms bytes ' + n.navBytes + ' index ' + n.indexFetched.length + (ok ? ' ok' : ' OVER'));
      }
      if (r.browser.mobileOpen) { const m = r.browser.mobileOpen; const ok = m.explorerOpenMs < 200 && m.navBytes < 2e6; if (!ok) fail++; L(f + ' mobile open explorer ' + m.explorerOpenMs + 'ms bytes ' + m.navBytes + (ok ? ' ok' : ' OVER')); }
    }
  }
  console.log(fail ? 'PERF-FLOOR: FAIL (' + fail + ' over)' : 'PERF-FLOOR: PASS');
  process.exit(fail ? 1 : 0);" || b3=0
cp "$RUNDIR"/perf-*.json "${P1B_PERF_OUT:-$RUNDIR}/" 2>/dev/null || true
bash "$B" down >/dev/null 2>&1; bash "$E" down >/dev/null 2>&1
export P1A_PREFIX="${P%-p}" P1A_SUBNET="$SUBNET_MAIN"; eval "$(bash "$E" vars)"
[ "$b3" = 1 ] && pass B3 || fail B3 "a perf floor exceeded (see the judge above)"
fi

if [ -z "${KEEP:-}" ]; then bash "$B" down >/dev/null 2>&1; bash "$E" down >/dev/null 2>&1; docker volume rm "$P-srv-empty" >/dev/null 2>&1; echo "environment removed"; fi
echo; echo "================ P1b summary"; for r in "${results[@]}"; do echo "$r"; done
printf '%s\n' "${results[@]}" | grep -q '^FAIL' && exit 1 || exit 0
