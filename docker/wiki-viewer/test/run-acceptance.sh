#!/usr/bin/env bash
# rw-p1a-render: run every acceptance case, in the test plan's order, against
# the disposable environment (test/p1a-env.sh). Prints each command's output
# and a PASS/FAIL line per case; exits non-zero if any case fails.
#
#   bash OB1/docker/wiki-viewer/test/run-acceptance.sh                  # build + up + all cases + down
#   KEEP=1 bash .../run-acceptance.sh                                   # leave the environment up afterwards
#   P1A_PREFIX=wt-t-x P1A_TAG=wt-t-x P1A_SUBNET=10.233.91.0/24 P1A_PORT=18900 bash .../run-acceptance.sh
#                                                                       # a tester's own names (p1a-env.sh header)
#   ONLY="C12" bash .../run-acceptance.sh                               # (debug) only these cases, after C0
#
# Nothing here touches a live container, network, volume or image: every
# name is $P1A_PREFIX-* (default wt-rw-p1a-render-*), the network is private,
# the LLM is a stub, and :local images are never built or tagged.
set -uo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E="$HERE/p1a-env.sh"
eval "$(bash "$E" vars)" || { echo "p1a-env.sh vars failed"; exit 2; }
export P1A_PREFIX="$P" P1A_TAG="$TAG" P1A_SUBNET="$SUBNET" P1A_PORT="$PORT"
results=()
pass() { results+=("PASS $1"); echo "==> PASS $1"; }
fail() { results+=("FAIL $1 - $2"); echo "==> FAIL $1 - $2"; }
hdr() { echo; echo "################ $1"; }
want() { [ -z "${ONLY:-}" ] || [[ " $ONLY " == *" $1 "* ]]; }
curl_() { bash "$E" curl "$@"; }
health() { bash "$E" health; }
notes_count() { bash "$E" notes | grep -c '"class"' || true; }
newnotes() { bash "$E" notes | tail -n +$(( $1 + 1 )) | grep '"class"' || true; }
T() { timeout "${1}" "${@:2}"; } # every long wait is bounded
echo "names: prefix=$P tag=$TAG subnet=$SUBNET port=$PORT net=$NET viewer image=$IMG wiki-service image=$WSIMG"
NURL="$(grep -cE '^ *\["' "$HERE/parity-diff-urls.mjs")"   # the fixed URL list (attempt 3: 34)
echo "fixed URL list: $NURL URLs"

hdr "C0 build + environment"
bash "$E" down >/dev/null 2>&1
T 1800 bash "$E" build 2>&1 | grep -E "# (tests|pass|fail)|label org|ERROR|error:" | tail -6
T 900 bash "$E" wsbuild 2>&1 | grep -E "# (tests|pass|fail)|ERROR|naming to" | tail -4
T 300 bash "$E" up 2>&1 | tail -6
bash "$E" wait_built 300 && pass C0 || fail C0 "viewer never served"

if want C1; then
hdr "C1+C2 (acceptance 1, 2): $NURL URLs x-wiki-render: db, chrome elements, body diff vs built page (attempt 3: + kitchen sink, transclusions, frontmatter-only note, alias redirects)"
out="$(T 300 bash "$E" parity 2>&1)"; echo "$out" | tail -42
if echo "$out" | grep -q "PARITY: PASS" && [ "$(echo "$out" | grep -c '^200 x-wiki-render=db ')" = "$NURL" ] \
   && echo "$out" | grep -q '/content/source/00000000-0000-4000-8000-000000000002 .*"D8-unsafe-url":3' \
   && echo "$out" | grep -E '/content/ +built=yes .* unlisted=0' >/dev/null \
   && echo "$out" | grep -E '^200 x-wiki-render=db legacy user note /notes/kitchen-sink +built=yes .* unlisted=0' >/dev/null \
   && echo "$out" | grep -E '^200 x-wiki-render=db legacy user note /notes/transclude-fixture +built=yes .* unlisted=0' >/dev/null \
   && echo "$out" | grep -E '^200 x-wiki-render=db legacy user note /notes/empty-body-note +built=yes .* unlisted=0' >/dev/null \
   && [ "$(echo "$out" | grep -c '^200 x-wiki-render=db alias redirect .*whole document identical')" = 3 ]; then pass "C1+C2 parity"; else fail "C1+C2 parity" "see output"; fi
fi

if want C2b; then
hdr "C2b (clean replacement, tester A3): no remnant of the takeover poll in the image or the bundle; mermaid strict"
src="$(docker run --rm --network none --entrypoint sh "$IMG" -c 'grep -rln "__neDirty\|__neSaving\|__neEditing\|page-document\|takeover poll" /quartz/serve.mjs /quartz/lib /quartz/quartz/components /entrypoint.sh 2>/dev/null | grep -v "\.quartz-cache" ; true')"
echo "source/image hits: [${src}]"
bund="$(docker exec "$P-viewer" sh -c 'f=/srv/current/postscript.js; echo "__neDirty=$(grep -o __neDirty $f | wc -l) __neSaving=$(grep -o __neSaving $f | wc -l) __neEditing=$(grep -o __neEditing $f | wc -l)"')"
echo "bundle (postscript.js): $bund"
# mermaid's init is an INLINE after-body script: on the built page and, through
# the chrome cut from it, on every live page
mb="$(docker exec "$P-viewer" sh -c 'f=/srv/current/content/person/person-ada-fixture.html; echo "strict=$(grep -o "securityLevel:\"strict\"" $f | wc -l) loose=$(grep -o "securityLevel:\"loose\"" $f | wc -l)"')"
ml="$(curl_ /content/person/person-ada-fixture body)"; ml="strict=$(echo "$ml" | grep -o 'securityLevel:"strict"' | wc -l) loose=$(echo "$ml" | grep -o 'securityLevel:"loose"' | wc -l)"
echo "mermaid built page: $mb; live page: $ml"
if [ -z "$src" ] && echo "$bund" | grep -q "__neDirty=0 __neSaving=0 __neEditing=0" && [ "$mb" = "strict=1 loose=0" ] && [ "$ml" = "strict=1 loose=0" ]; then pass C2b; else fail C2b "remnant present or mermaid not strict"; fi
fi

if want C9; then
hdr "C9 (acceptance 9): raw HTML in a source body is dropped"
o="$(curl_ /content/source/00000000-0000-4000-8000-000000000002 body)"
art="$(echo "$o" | tr -d '\n' | grep -o '<article class="popover-hint">.*</article>')"
echo "live article raw-HTML hits: $(echo "$art" | grep -oE '<script|onclick=|onerror=|<iframe' | wc -l)"
built="$(docker exec "$P-viewer" cat /srv/current/content/source/00000000-0000-4000-8000-000000000002.html | tr -d '\n' | grep -o '<article class="popover-hint">.*</article>')"
echo "built article raw-HTML hits: $(echo "$built" | grep -oE '<script|onclick=|onerror=|<iframe' | wc -l)"
echo "live article unsafe-URL hits: $(echo "$art" | grep -oE '(href|src)="(javascript|data|vbscript):' | wc -l); built: $(echo "$built" | grep -oE '(href|src)="(javascript|data|vbscript):' | wc -l)"
if [ -n "$art" ] && ! echo "$art" | grep -qE '<script|onclick=|onerror=|<iframe|(href|src)="(javascript|data|vbscript):'; then pass C9; else fail C9 "raw HTML or an unsafe URL rendered"; fi

hdr "C9b (finding F-T1): the tester's injection probe through every transform, parsed"
o="$(T 120 bash "$E" node /ob1/docker/wiki-viewer/test/security-probe.mjs 2>&1)"; rc=$?; echo "$o"
if [ "$rc" = 0 ] && echo "$o" | grep -q "SECURITY-PROBE: PASS"; then pass C9b; else fail C9b "see output"; fi
fi

if want C3b; then
hdr "C3b (D13 item 5 + tester A5/N1/N2/F-T2): empty, stale and future-dated rows are pending, named, repaired"
bash "$E" psql "update wiki_pages set body='' where slug='content/thought/9002' returning slug"
bash "$E" psql "update wiki_pages set updated_at='2020-01-01T00:00:00Z' where slug='content/person/person-bob-fixture' returning slug"
bash "$E" psql "update wiki_pages set updated_at='2099-01-01T00:00:00Z' where slug='content/source/00000000-0000-4000-8000-000000000101' returning slug"
bash "$E" node -e "const f='/wiki/content/source/00000000-0000-4000-8000-000000000101.md',fs=require('fs');fs.appendFileSync(f,'\nEdited after its row (C3b).\n');console.log('edited',f)"
e1="$(curl_ /content/thought/9002 body)"; s1="$(curl_ /content/person/person-bob-fixture body)"; f1="$(curl_ /content/source/00000000-0000-4000-8000-000000000101 body)"
for x in "$e1" "$s1" "$f1"; do echo "$x" | head -1; echo "$x" | grep -o '<p>This page is known ([^)]*)' | head -1; done
o="$(T 120 bash "$E" node /ob1/recipes/_shared/reconcile-wiki-pages.mjs --vault /wiki 2>&1)"; rc=$?; echo "$o"; echo "exit=$rc"
r="$(T 120 bash "$E" node /ob1/recipes/_shared/reconcile-wiki-pages.mjs --vault /wiki --repair 2>&1)"; rr=$?; echo "$r"; echo "exit(repair)=$rr"
e2="$(curl_ /content/thought/9002)"; s2="$(curl_ /content/person/person-bob-fixture)"; f2="$(curl_ /content/source/00000000-0000-4000-8000-000000000101 body)"
echo "after repair: $e2 | $s2 | $(echo "$f2" | head -1) edited-text-presented=$(echo "$f2" | grep -c 'Edited after its row')"
if echo "$e1" | head -1 | grep -q "x-wiki-render=pending .*cache-control=no-store" && echo "$e1" | grep -q "empty body" \
   && echo "$s1" | head -1 | grep -q "x-wiki-render=pending" && echo "$s1" | grep -q "older than its file" \
   && echo "$f1" | head -1 | grep -q "x-wiki-render=pending" && echo "$f1" | grep -q "dated in the future" \
   && [ "$rc" = 1 ] && echo "$o" | grep -q "empty: content/thought/9002" && echo "$o" | grep -q "stale: .*content/person/person-bob-fixture" \
   && echo "$o" | grep -q "future: content/source/00000000-0000-4000-8000-000000000101" \
   && echo "$r" | grep -q "repair pass: 3 row(s) written" && echo "$e2" | grep -q "x-wiki-render=db" && echo "$s2" | grep -q "x-wiki-render=db" \
   && echo "$f2" | head -1 | grep -q "x-wiki-render=db" && echo "$f2" | grep -q "Edited after its row"; then pass C3b; else fail C3b "see output"; fi
fi

if want C3c; then
hdr "C3c (attempt 3, N2-3/N2-4/N2-5): ONE emptiness rule - an NBSP body over a real file is pending, named empty and repaired; the frontmatter-only note is presented (db) and is not drift"
bash "$E" psql "update wiki_pages set body=U&'\00A0\3000', updated_at=now() + interval '2 seconds' where slug='content/thought/9001' returning slug"
n1="$(curl_ /content/thought/9001 body)"; echo "$n1" | head -1; echo "$n1" | grep -o '<p>This page is known ([^)]*)' | head -1
eb="$(curl_ /notes/empty-body-note body)"; echo "frontmatter-only note: $(echo "$eb" | head -1) article=[$(echo "$eb" | tr -d '\n' | grep -o '<article class="popover-hint">[^<]*</article>')]"
o="$(T 120 bash "$E" node /ob1/recipes/_shared/reconcile-wiki-pages.mjs --vault /wiki 2>&1)"; rc=$?; echo "$o"; echo "exit=$rc"
r="$(T 120 bash "$E" node /ob1/recipes/_shared/reconcile-wiki-pages.mjs --vault /wiki --repair 2>&1)"; rr=$?; echo "$r" | grep -E "repair pass|after-repair\] (clean|DRIFT)"; echo "exit(repair)=$rr"
n2="$(curl_ /content/thought/9001)"; echo "after repair: $n2"
if echo "$n1" | head -1 | grep -q "x-wiki-render=pending" && echo "$n1" | grep -q "empty body" \
   && echo "$eb" | head -1 | grep -q "x-wiki-render=db" && echo "$eb" | tr -d '\n' | grep -q '<article class="popover-hint"></article>' \
   && [ "$rc" = 1 ] && echo "$o" | grep -q "empty: content/thought/9001$" && ! echo "$o" | grep -q "empty-body-note" \
   && echo "$r" | grep -q "repair pass: 1 row(s) written (0 missing, 0 stale, 1 empty)" && echo "$r" | grep -q "after-repair\] clean" \
   && [ "$rr" = 0 ] && echo "$n2" | grep -q "x-wiki-render=db"; then pass C3c; else fail C3c "see output"; fi
fi

if want C3d; then
hdr "C3d (attempt 3, AT2-1a): a transcluded page without a presentable row is the pending-compile marker inside the block (D9); the host page stays db"
bash "$E" psql "update wiki_pages set updated_at='2020-01-01T00:00:00Z' where slug='notes/block-source' returning slug"
b="$(curl_ /notes/block-source)"; echo "embedded page: $b"
h="$(curl_ /notes/transclude-fixture body)"; echo "host: $(echo "$h" | head -1)"; echo "markers: $(echo "$h" | grep -o 'class="transclude-pending" data-render-state="pending">Pending compile: notes/block-source' | wc -l)"
out="$(T 120 bash "$E" parity --urls /notes/transclude-fixture --show 2>&1)"; echo "$out" | grep -E "D9-transclude-pending|UNLISTED|^200 |PARITY" | cut -c1-260
T 120 bash "$E" node /ob1/recipes/_shared/reconcile-wiki-pages.mjs --vault /wiki --repair 2>&1 | grep -E "repair pass|after-repair\]" | head -2
a="$(curl_ /notes/block-source)"; echo "after repair: $a"
if echo "$b" | grep -q "x-wiki-render=pending" && echo "$h" | head -1 | grep -q "x-wiki-render=db" \
   && [ "$(echo "$h" | grep -o 'Pending compile: notes/block-source' | wc -l)" = 2 ] \
   && echo "$out" | grep -q "PARITY: PASS" && echo "$out" | grep -E '/notes/transclude-fixture .*unlisted=0 .*"D9-transclude-pending":2' >/dev/null \
   && echo "$a" | grep -q "x-wiki-render=db"; then pass C3d; else fail C3d "see output"; fi
fi

if want C3; then
hdr "C3 (acceptance 3): deleted row -> pending-compile, no-store, never the file"
bash "$E" psql "delete from wiki_pages where slug='content/person/person-ada-fixture' returning slug"
o="$(curl_ /content/person/person-ada-fixture body)"; echo "$o" | head -1
if echo "$o" | head -1 | grep -q "x-wiki-render=pending .*cache-control=no-store" && echo "$o" | grep -q 'data-render-state="pending"' \
   && ! echo "$o" | grep -q "Ada Fixture is a synthetic person"; then pass C3; else fail C3 "not the pending state, or file content present"; fi
fi

if want C5; then
hdr "C5 (acceptance 5): reconciliation names the deleted row and a row older than its file"
bash "$E" psql "update wiki_pages set updated_at='2020-01-01T00:00:00Z' where slug='content/tool/tool-fixture-db' returning slug, updated_at"
o="$(T 120 bash "$E" node /ob1/recipes/_shared/reconcile-wiki-pages.mjs --vault /wiki 2>&1)"; rc=$?; echo "$o"; echo "exit=$rc"
sleep 7; h="$(health)"; echo "health: $h" | cut -c1-500
if [ "$rc" = 1 ] && echo "$o" | grep -q "missing: content/person/person-ada-fixture" && echo "$o" | grep -q "stale: content/tool/tool-fixture-db" \
   && echo "$h" | grep -q '^503 .*"missing":\["content/person/person-ada-fixture"\].*"stale":\["content/tool/tool-fixture-db"\]'; then pass C5; else fail C5 "a slug not named, or a clean report"; fi
fi

if want C6; then
hdr "C6 (acceptance 6): database stopped / starting / reconnect"
docker stop "$P-db" >/dev/null; sleep 8
o="$(T 300 bash "$E" node /ob1/docker/wiki-viewer/test/outage-probe.mjs sweep --expect unreachable --base "http://$P-viewer:8080" 2>&1)"; rc=$?; echo "$o" | cut -c1-260
h="$(health)"; echo "health(stopped): $h" | cut -c1-300
docker rm -f -v "$P-watch" >/dev/null 2>&1
docker run -d --name "$P-watch" --network "$NET" -v "$OB1:/ob1:ro" --entrypoint node "$IMG" \
  /ob1/docker/wiki-viewer/test/outage-probe.mjs watch --seconds 90 --base "http://$P-viewer:8080" >/dev/null
# start the database only once the watcher is sampling (its first line is the
# "unreachable" state), so the connecting window cannot fall before its first sample
for _ in $(seq 1 30); do docker logs "$P-watch" 2>&1 | grep -q " unreachable" && break; sleep 1; done
docker start "$P-db" >/dev/null
for _ in $(seq 1 60); do docker logs "$P-watch" 2>&1 | grep -q "WATCH:" && break; sleep 2; done
w="$(docker logs "$P-watch" 2>&1)"; echo "$w"; docker rm -f -v "$P-watch" >/dev/null
sleep 3; vlog="$(docker logs "$P-viewer" 2>&1 | grep -E "database (unreachable|connecting|up)|reconcile pass \(reconnect|repair pass" | tail -6)"; echo "$vlog" | cut -c1-300
h2="$(health)"; echo "health(after): $h2" | cut -c1-200
if [ "$rc" = 0 ] && echo "$o" | grep -q "SWEEP: all $NURL URLs show unreachable" && echo "$h" | grep -q '^503 .*"database unreachable"' \
   && echo "$w" | grep -q "WATCH: sequence .*unreachable.*connecting.*db" \
   && echo "$vlog" | grep -q "reconcile pass (reconnect" && echo "$h2" | grep -q '^200 '; then pass C6; else fail C6 "see output"; fi
fi

if want C7; then
hdr "C7a (acceptance 7): chat 503 x3 then success -> page lands, no notification"
n0="$(notes_count)"; bash "$E" stub '{"mode":"flaky503","n":3}' >/dev/null
o="$(T 300 bash "$E" compile generate --ids 904 --out-dir /wiki/content --no-graph 2>&1)"; rc=$?; echo "$o"; echo "exit=$rc"
s="$(bash "$E" stub)"; echo "stub: $s"; n1="$(notes_count)"; c="$(curl_ /content/person/person-carol-fixture)"; echo "$c"
if [ "$rc" = 0 ] && echo "$s" | grep -q '"chatCalls":4' && [ "$n0" = "$n1" ] && echo "$c" | grep -q "x-wiki-render=db"; then pass C7a; else fail C7a "see output"; fi

hdr "C7b (acceptance 7): failing throughout, /v1/models failing -> one 'model unavailable', entity in the ledger, no page written"
before="$(bash "$E" node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('/wiki/content/person/person-bob-fixture.md')).digest('hex'))")"
rowb="$(bash "$E" psql "select updated_at from wiki_pages where slug='content/person/person-bob-fixture'")"
n0="$(notes_count)"; bash "$E" stub '{"mode":"fail","modelsOk":false}' >/dev/null
o="$(T 300 bash "$E" compile generate --ids 902 --out-dir /wiki/content --no-graph 2>&1)"; rc=$?; echo "$o"; echo "exit=$rc"
s="$(bash "$E" stub)"; echo "stub: $s"; nl="$(newnotes "$n0")"; echo "new notifications: $nl"
ledger="$(bash "$E" cat content/.failed-entity-ids.json)"; echo "ledger: $ledger"
after="$(bash "$E" node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('/wiki/content/person/person-bob-fixture.md')).digest('hex'))")"
rowa="$(bash "$E" psql "select updated_at from wiki_pages where slug='content/person/person-bob-fixture'")"
echo "bob file sha before=$before after=$after; row updated_at before=$rowb after=$rowa"
if echo "$s" | grep -q '"chatCalls":4' && [ "$(echo "$nl" | grep -c '"subject":"model unavailable: stub-model"')" = 1 ] && [ "$(echo "$nl" | grep -c '"class"')" = 1 ] \
   && echo "$ledger" | grep -q '902' && [ "$before" = "$after" ] && [ "$rowb" = "$rowa" ]; then pass C7b; else fail C7b "see output"; fi

hdr "C7c (acceptance 7): failing throughout, /v1/models healthy -> 'LLM call failing for this task'"
n0="$(notes_count)"; bash "$E" stub '{"mode":"fail","modelsOk":true}' >/dev/null
o="$(T 300 bash "$E" compile generate --ids 901 --out-dir /wiki/content --no-graph 2>&1)"; rc=$?; echo "$o"; echo "exit=$rc"
s="$(bash "$E" stub)"; echo "stub: $s"; nl="$(newnotes "$n0")"; echo "new notifications: $nl"
ledger="$(bash "$E" cat content/.failed-entity-ids.json)"; echo "ledger: $ledger"
if echo "$s" | grep -q '"chatCalls":4' && echo "$nl" | grep -q '"subject":"LLM call failing for this task: #901 Ada Fixture"' && [ "$(echo "$nl" | grep -c '"class"')" = 1 ] \
   && [ "$ledger" = "[901,902]" ]; then pass C7c; else fail C7c "see output (the ledger must keep 902 and add 901)"; fi
fi

if want C8; then
hdr "C8 (acceptance 8): a reply the page parser rejects -> structural, no retry, one notification, run fails, pending, not in the ledger"
n0="$(notes_count)"; bash "$E" stub '{"mode":"badparse"}' >/dev/null
o="$(T 300 bash "$E" compile generate --ids 905 --out-dir /wiki/content --no-graph 2>&1)"; rc=$?; echo "$o"; echo "exit=$rc"
s="$(bash "$E" stub)"; echo "stub: $s"; nl="$(newnotes "$n0")"; echo "new notifications: $nl"
ledger="$(bash "$E" cat content/.failed-entity-ids.json)"; echo "transient ledger: $ledger"
sl="$(bash "$E" cat content/.structural-failures.json)"; echo "structural ledger: $sl" | tr -d '\n' | cut -c1-500; echo
c="$(curl_ /content/person/person-dave-fixture)"; echo "$c"
if [ "$rc" = 3 ] && echo "$s" | grep -q '"chatCalls":1' && echo "$nl" | grep -q '"subject":"compile structural failure: content/person/person-dave-fixture","slug":"content/person/person-dave-fixture"' \
   && [ "$(echo "$nl" | grep -c '"class"')" = 1 ] && [ "$ledger" = "[901,902]" ] && echo "$sl" | grep -q '"entity:905"' \
   && echo "$c" | grep -q "x-wiki-render=pending"; then pass C8; else fail C8 "see output (exit 3; the transient ledger must still hold [901,902] and not 905)"; fi

hdr "C8b (tester A9 at recipe level): the next run SKIPS the open structural failure - no LLM call, no notification"
n0="$(notes_count)"; bash "$E" stub '{"mode":"badparse"}' >/dev/null
o="$(T 300 bash "$E" compile generate --ids 905 --out-dir /wiki/content --no-graph 2>&1)"; rc=$?; echo "$o"; echo "exit=$rc"
s="$(bash "$E" stub)"; echo "stub: $s"; n1="$(notes_count)"
if [ "$rc" = 0 ] && echo "$s" | grep -q '"chatCalls":0' && [ "$n0" = "$n1" ] && echo "$o" | grep -q "skipped 1 entity page(s) with an OPEN structural failure"; then pass C8b; else fail C8b "see output"; fi

hdr "C8c: its inputs change (a new source revision bumps the entity) -> retried once; the SAME failure is not notified again"
bash "$E" psql "update entities set updated_at=now() where id=905 returning id"
n0="$(notes_count)"; bash "$E" stub '{"mode":"badparse"}' >/dev/null
o="$(T 300 bash "$E" compile generate --ids 905 --out-dir /wiki/content --no-graph 2>&1)"; rc=$?; echo "$o"; echo "exit=$rc"
s="$(bash "$E" stub)"; echo "stub: $s"; n1="$(notes_count)"
sl="$(bash "$E" cat content/.structural-failures.json)"; echo "occurrences: $(echo "$sl" | grep -o '"occurrences": [0-9]*')"
if [ "$rc" = 3 ] && echo "$s" | grep -q '"chatCalls":1' && [ "$n0" = "$n1" ] && echo "$o" | grep -q "not notified again" && echo "$sl" | grep -q '"occurrences": 2'; then pass C8c; else fail C8c "see output"; fi

hdr "C8d: a manual clear (--clear-structural) removes it; nothing else runs"
o="$(T 120 bash "$E" compile generate --clear-structural 905 --out-dir /wiki/content 2>&1)"; rc=$?; echo "$o"; echo "exit=$rc"
sl="$(bash "$E" cat content/.structural-failures.json)"; echo "structural ledger: $(echo "$sl" | tr -d '\n ')"
if [ "$rc" = 0 ] && echo "$o" | grep -q "cleared 1 open structural failure(s): entity:905" && ! echo "$sl" | grep -q "entity:905"; then pass C8d; else fail C8d "see output"; fi
fi

if want C7d; then
hdr "C7d (tester A6, failure classes): every stub failure mode classified, attempts counted, exit codes"
LEDGER0="$(bash "$E" cat content/.failed-entity-ids.json)"
c7d_ok=1
c7d() { # mode ids expect-chatCalls expect-exit expect-text [env]
  local mode="$1" ids="$2" calls="$3" code="$4" text="$5"
  bash "$E" stub "{\"mode\":\"$mode\"}" >/dev/null
  local o rc s
  o="$(LLM_TIMEOUT_MS="${6:-600000}" T 300 bash "$E" compile generate --ids "$ids" --out-dir /wiki/content --no-graph 2>&1)"; rc=$?
  s="$(bash "$E" stub)"
  echo "-- mode=$mode ids=$ids exit=$rc stub=$(echo "$s" | grep -o '"chatCalls":[0-9]*') :: $(echo "$o" | grep -E "transient \(|STRUCTURAL|\[notify\]" | tail -2 | cut -c1-200 | tr '\n' ' ')"
  if [ "$rc" != "$code" ] || ! echo "$s" | grep -q "\"chatCalls\":$calls" || ! echo "$o" | grep -q -- "$text"; then echo "   ^ UNEXPECTED (want exit=$code chatCalls=$calls text='$text')"; c7d_ok=0; fi
}
c7d empty200 902 4 0 "LLM call failing for this task: #902"
c7d emptycontent 902 4 0 "attempt 4/4 transient (empty reply)"
c7d 429 902 4 0 "LLM call failing for this task: #902"
c7d timeout 902 4 0 "transient (call failed: timeout)" 1000
c7d 400 902 1 3 "STRUCTURAL FAILURE #902 .*LLM request refused: HTTP 400"
T 120 bash "$E" compile generate --clear-structural 902 --out-dir /wiki/content >/dev/null 2>&1
c7d 503x2-badparse 902 3 3 "STRUCTURAL FAILURE #902 .*reply failed the page parser"
T 120 bash "$E" compile generate --clear-structural 902 --out-dir /wiki/content >/dev/null 2>&1
c7d mixed 904,905 5 3 "STRUCTURAL FAILURE #905"
ledger="$(bash "$E" cat content/.failed-entity-ids.json)"; echo "transient ledger before=$LEDGER0 after=$ledger (904 added; 905 never)"
T 120 bash "$E" compile generate --clear-structural all --out-dir /wiki/content 2>&1 | tail -1
if [ "$c7d_ok" = 1 ] && echo "$ledger" | grep -q "904" && ! echo "$ledger" | grep -q "905"; then pass C7d; else fail C7d "see output"; fi
fi

if want C14; then
hdr "C14 (attempt 3, tester AT2-4): two compiles RACING on the structural ledger - no lost entry, one notification per distinct failure, a racing first occurrence of one page notified once"
T 120 bash "$E" compile generate --clear-structural all --out-dir /wiki/content >/dev/null 2>&1
c14_ok=1
sl() { bash "$E" cat content/.structural-failures.json | tr -d '\n ' ; }
race() { # ids-a ids-b: start both inside the stub's reply delay; print both outputs and exit codes
  local fa fb
  fa="$(mktemp)"; fb="$(mktemp)"
  ( T 300 bash "$E" compile generate --ids "$1" --out-dir /wiki/content --no-graph >"$fa" 2>&1; echo "exit=$?" >>"$fa" ) &
  local pa=$!
  sleep 2
  ( T 300 bash "$E" compile generate --ids "$2" --out-dir /wiki/content --no-graph >"$fb" 2>&1; echo "exit=$?" >>"$fb" ) &
  local pb=$!
  wait "$pa" "$pb"
  echo "-- a (--ids $1): $(grep -E 'STRUCTURAL|skipped|not notified|exit=' "$fa" | cut -c1-200 | tr '\n' ' ')"
  echo "-- b (--ids $2): $(grep -E 'STRUCTURAL|skipped|not notified|exit=' "$fb" | cut -c1-200 | tr '\n' ' ')"
  RA="$(grep -o 'exit=[0-9]*' "$fa" | tail -1)"; RB="$(grep -o 'exit=[0-9]*' "$fb" | tail -1)"
  rm -f "$fa" "$fb"
}
echo "== round 1: 905 and 902 fail structurally at the same time (stub badparse, every reply 6 s late)"
n0="$(notes_count)"; bash "$E" stub '{"mode":"badparse","delayMs":6000}' >/dev/null
race 905 902
nl="$(newnotes "$n0")"; echo "new notifications: $(echo "$nl" | grep -o '"subject":"[^"]*"' | tr '\n' ' ')"; L1="$(sl)"; echo "ledger keys: $(echo "$L1" | grep -o '"entity:[0-9]*":' | tr '\n' ' ')"
[ "$RA" = exit=3 ] && [ "$RB" = exit=3 ] || { echo "x round 1 exits $RA $RB"; c14_ok=0; }
echo "$L1" | grep -q '"entity:905":' && echo "$L1" | grep -q '"entity:902":' || { echo "x round 1: an entry was lost"; c14_ok=0; }
[ "$(echo "$nl" | grep -c '"class"')" = 2 ] && echo "$nl" | grep -q 'person-dave-fixture' && echo "$nl" | grep -q 'person-bob-fixture' || { echo "x round 1: not exactly one notification each"; c14_ok=0; }
echo "== round 2: the same two again, inputs unchanged -> both SKIPPED: no LLM call, no notification"
n0="$(notes_count)"; bash "$E" stub '{"mode":"badparse","delayMs":6000}' >/dev/null
race 905 902
s="$(bash "$E" stub)"; echo "stub: $(echo "$s" | grep -o '"chatCalls":[0-9]*')"; n1="$(notes_count)"
echo "$s" | grep -q '"chatCalls":0' && [ "$n0" = "$n1" ] && [ "$RA" = exit=0 ] && [ "$RB" = exit=0 ] || { echo "x round 2"; c14_ok=0; }
echo "== round 3: 905 cleared, then compiled by TWO racing runs -> its first occurrence is notified ONCE"
T 120 bash "$E" compile generate --clear-structural 905 --out-dir /wiki/content 2>&1 | tail -1
n0="$(notes_count)"; bash "$E" stub '{"mode":"badparse","delayMs":6000}' >/dev/null
race 905 905
s="$(bash "$E" stub)"; echo "stub: $(echo "$s" | grep -o '"chatCalls":[0-9]*')"; nl="$(newnotes "$n0")"; echo "new notifications: $(echo "$nl" | grep -o '"subject":"[^"]*"' | tr '\n' ' ')"
echo "occurrences: $(bash "$E" cat content/.structural-failures.json | tr -d '\n ' | grep -o '"entity:905":{[^}]*' | grep -o '"occurrences":[0-9]*')"
echo "$s" | grep -q '"chatCalls":2' && [ "$(echo "$nl" | grep -c '"class"')" = 1 ] && echo "$nl" | grep -q 'person-dave-fixture' || { echo "x round 3"; c14_ok=0; }
bash "$E" stub '{"mode":"ok"}' >/dev/null
[ "$c14_ok" = 1 ] && pass C14 || fail C14 "see output"

hdr "C15 (attempt 3, tester AT2-4 + N2-2): a --clear-structural made DURING a compile is never written back; an unknown id exits non-zero naming it"
c15_ok=1
echo "before: $(sl | grep -o '"entity:[0-9]*":' | tr '\n' ' ')"
bash "$E" stub '{"mode":"ok","delayMs":10000}' >/dev/null
fc="$(mktemp)"
( T 300 bash "$E" compile generate --ids 904 --out-dir /wiki/content --no-graph >"$fc" 2>&1; echo "compile exit=$?" >>"$fc" ) &
pc=$!
sleep 4
o="$(T 120 bash "$E" compile generate --clear-structural 905 --out-dir /wiki/content 2>&1)"; rc=$?; echo "$o"; echo "clear exit=$rc"
echo "right after the clear: $(sl | grep -o '"entity:[0-9]*":' | tr '\n' ' ')"
wait "$pc"; tail -1 "$fc"; rm -f "$fc"
after="$(sl)"; echo "after the compile ended: $(echo "$after" | grep -o '"entity:[0-9]*":' | tr '\n' ' ')"
[ "$rc" = 0 ] && echo "$o" | grep -q "cleared 1 open structural failure(s): entity:905" || c15_ok=0
echo "$after" | grep -q '"entity:905":' && { echo "x the clear was written back"; c15_ok=0; }
echo "$after" | grep -q '"entity:902":' || { echo "x 902 lost"; c15_ok=0; }
o="$(T 120 bash "$E" compile generate --clear-structural 123456,notebook:nope --out-dir /wiki/content 2>&1)"; rc=$?; echo "$o"; echo "unknown-id exit=$rc"
[ "$rc" = 1 ] && echo "$o" | grep -q "not an open structural failure: entity:123456, notebook:nope" || c15_ok=0
T 120 bash "$E" compile generate --clear-structural all --out-dir /wiki/content 2>&1 | tail -1
bash "$E" stub '{"mode":"ok"}' >/dev/null
[ "$c15_ok" = 1 ] && pass C15 || fail C15 "see output"
fi

if want C4; then
hdr "C4 (acceptance 4 + F-T4): row flush made to fail -> exit 3, unsynced count + first slugs, ONE structural notification per run"
bash "$E" stub '{"mode":"ok"}' >/dev/null
bash "$E" psql "REVOKE INSERT, UPDATE ON wiki_pages FROM service_role"
n0="$(notes_count)"
og="$(T 300 bash "$E" compile generate --ids 906 --out-dir /wiki/content --no-graph 2>&1)"; rg=$?; echo "$og"; echo "exit=$rg"
n1="$(notes_count)"; ng="$(newnotes "$n0")"
os="$(T 300 bash "$E" compile synth 2>&1)"; rs=$?; echo "$os"; echo "exit=$rs"
ns="$(newnotes "$n1")"
bash "$E" psql "GRANT ALL ON wiki_pages TO service_role"
echo "new notifications (generate): $ng"; echo "new notifications (synth): $ns"
if [ "$rg" = 3 ] && [ "$rs" = 3 ] && echo "$og" | grep -q "generate-wiki FAILED: 1 page(s) UNSYNCED .*first: content/person/person-erin-fixture" \
   && echo "$os" | grep -q "notebook-synth FAILED: [0-9]* page(s) UNSYNCED .*first: content/notebooks/" && ! echo "$og$os" | grep -qi "compile ok" \
   && [ "$(echo "$ng" | grep -c '"class"')" = 1 ] && echo "$ng" | grep -q '"subject":"compile structural failure: row write rejected (generate-wiki)","slug":"content/person/person-erin-fixture"' \
   && [ "$(echo "$ns" | grep -c '"class"')" = 1 ] && echo "$ns" | grep -q '"subject":"compile structural failure: row write rejected (notebook-synth)"'; then pass C4; else fail C4 "see output"; fi
fi

if want C10; then
hdr "C10 (acceptance 10): a new page class registered (one compile rule, one renderer template), existing entries untouched"
o="$(T 120 bash "$E" node /ob1/docker/wiki-viewer/test/fixtures/extra-class/compile-glossary.mjs 2>&1)"; rc=$?; echo "$o"
d="$(curl_ /content/glossary/term-fixture)"; echo "without the entry file: $d"
P1A_EXTRA_CLASS=1 bash "$E" viewer; bash "$E" wait_built 200
g="$(curl_ /content/glossary/term-fixture body)"; echo "with the entry file: $(echo "$g" | head -1)"; echo "marker: $(echo "$g" | grep -o 'data-glossary-template="1"' | head -1)"
st="$(git -C "$OB1" status --porcelain -- docker/wiki-viewer/lib/page-classes recipes/_shared/page-classes.mjs 2>&1)" || st="GIT-ERROR: $st"; echo "tracked entry files changed by this case: [${st}]"
if [ "$rc" = 0 ] && echo "$o" | grep -q "glossary: files=1 rows=1" && echo "$d" | grep -q "x-wiki-page-class=row@1" \
   && echo "$g" | head -1 | grep -q "x-wiki-page-class=glossary@1" && echo "$g" | grep -q 'data-glossary-template="1"' && [ -z "$st" ]; then pass C10; else fail C10 "see output"; fi

hdr "C10b (tester A7, N3, N4): the registry fails LOUD on a duplicate name, a tie, no default export; a throwing resolve() is isolated"
c10b_ok=1
# (the production mode, WIKI_BUILDER=1: the container must EXIT, not keep a builder running)
for f in a-dup-entity.mjs tie-priority.mjs no-default.mjs; do
  P1A_EXTRA_ENTRY="$f" bash "$E" viewer >/dev/null; bash "$E" wait_serving 90; ws=$?
  lg="$(docker logs "$P-viewer" 2>&1 | grep "page class entry" | grep -F "$f" | head -1 | cut -c1-260)"
  ex="$(docker logs "$P-viewer" 2>&1 | grep -c "serve.mjs EXITED")"
  echo "-- $f: wait=$ws running=$(docker inspect -f '{{.State.Running}}' "$P-viewer") exit=$(docker inspect -f '{{.State.ExitCode}}' "$P-viewer") :: $lg"
  [ "$ws" = 3 ] && [ -n "$lg" ] && [ "$ex" = 1 ] || c10b_ok=0
done
WIKI_BUILDER=0 P1A_EXTRA_ENTRY=aaa-throws.mjs bash "$E" viewer >/dev/null; bash "$E" wait_serving 60
for u in /content/person/person-bob-fixture /notes/fixture-note /tags/fixture-tag /; do r="$(curl_ "$u")"; echo "$r $u"; echo "$r" | grep -q "x-wiki-render=db" || c10b_ok=0; done
sleep 6; h="$(health)"; echo "health: $(echo "$h" | grep -o '"reasons":\[[^]]*\]')"
echo "$h" | grep -q 'page class aaa-throws@1 resolve() threw' || c10b_ok=0
echo "$h" | grep -q '"brokenPageClasses":\[{"name":"aaa-throws"' || c10b_ok=0
# attempt 3 (tester N2-1): a resolve() returning a hand-built { unreachable: true } is a registry fault, never the database screen
WIKI_BUILDER=0 P1A_EXTRA_ENTRY=shape-unreach.mjs bash "$E" viewer >/dev/null; bash "$E" wait_serving 60
r="$(curl_ /notes/fixture-note)"; echo "$r /notes/fixture-note (shape-unreach.mjs claims it with { unreachable: true })"
echo "$r" | grep -q "x-wiki-render=db x-wiki-page-class=note@1" || c10b_ok=0
sleep 6; h="$(health)"; echo "health: $(echo "$h" | grep -o '"reasons":\[[^]]*\]')"
echo "$h" | grep -q 'page class shape-unreach@1 resolve() returned an invalid result [0-9]*x: returned {\\"unreachable\\":true}' || c10b_ok=0
bash "$E" viewer >/dev/null; bash "$E" wait_built 200 >/dev/null
[ "$c10b_ok" = 1 ] && pass C10b || fail C10b "see output"
fi

if want C11; then
hdr "C11 (acceptance 11): image revision label = the OB1 commit it was built from (= the gitlink at deploy)"
label="$(docker image inspect "$IMG" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
head_="$(git -C "$OB1" rev-parse HEAD 2>&1)" || head_="GIT-ERROR"; dirty="$(git -C "$OB1" status --porcelain -- docker/wiki-viewer recipes/_shared 2>&1 | grep -v '^??' | head -3)"
echo "label=$label OB1 HEAD=$head_ tracked-dirty=[${dirty}]"
if [ -n "$label" ] && [ "$label" = "$head_" ] && [ -z "$dirty" ]; then pass C11; else fail C11 "label empty or not HEAD (or the tree is dirty)"; fi
fi

if want C12; then
hdr "C12 (tester A9, F-T3; acceptance 8 across cycles): the wiki-service over several cycles, a structural failure never retried by the next cycle"
bash "$E" down >/dev/null 2>&1; T 300 bash "$E" up 2>&1 | tail -2; bash "$E" wait_built 300 >/dev/null
bash "$E" stub '{"mode":"davebad"}' >/dev/null
c12_ok=1
state() { bash "$E" cat .wikistate.json | grep -o '"last_compile_iso": "[^"]*"'; }
davenotes() { bash "$E" notes | grep -c '"slug":"content/person/person-dave-fixture"' || true; }
cyc() { # name: print the compile's status, its log lines, the stub and the watermark
  local t0="$1" st="$2"
  echo "status: $(echo "$st" | cut -c1-700)"
  docker logs --since "$t0" "$P-ws" 2>&1 | grep -E "FULL|incremental compile|STRUCTURAL|skipped|not notified|notify\]|notebook-synth\] done|planned|swept|\[reconcile\]|wiki-pages\] wiki-service|compile (ok|FAILED)|open structural" | cut -c1-260
  echo "stub: $(bash "$E" stub | grep -o '"chatCalls":[0-9]*,.*"perTask":{[^}]*}')"; echo "watermark: $(state)"; echo "dave notifications: $(davenotes)"
}
t0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; bash "$E" ws; boot="$(bash "$E" ws_wait)"
echo "== boot (FULL) compile, stub davebad"; cyc "$t0" "$boot"; w0="$(state)"; d0="$(davenotes)"; L0="$(docker logs --since "$t0" "$P-ws" 2>&1)"
# the rest of the cycle ran: synthesis, sweeps, planned manifest, this service's rows, the reconcile, the commit
echo "$L0" | grep -q "compile FAILED (.*watermark advanced)" || { echo "x boot: not FAILED-with-watermark"; c12_ok=0; }
echo "$boot" | grep -q "notebook-synth: all" || { echo "x boot: no synthesis"; c12_ok=0; }
echo "$L0" | grep -q "planned manifest:" || { echo "x boot: no planned manifest"; c12_ok=0; }
echo "$L0" | grep -q "wiki-pages\] wiki-service: all" || { echo "x boot: service rows"; c12_ok=0; }
# F-T3: every page the compile wrote has its row - the ONLY drift is Dave's open failure
echo "$L0" | grep -q "\[reconcile\] DRIFT: .* 0 missing, 0 stale, 0 empty, 0 orphan, 1 failed" || { echo "x boot: reconcile is not exactly Dave's failure"; c12_ok=0; }
echo "$L0" | grep -q "failed: content/person/person-dave-fixture" || c12_ok=0
echo "$boot" | grep -q '"committed":true' || { echo "x boot: not committed"; c12_ok=0; }
[ -n "$w0" ] && [ "$d0" = 1 ] || c12_ok=0

echo "== cycle 1: nothing changed -> Dave is SKIPPED (no LLM call for him, no notification), the cycle completes"
bash "$E" stub '{"mode":"davebad"}' >/dev/null
t1="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; s1="$(bash "$E" ws_cycle)"; cyc "$t1" "$s1"; w1="$(state)"; L1="$(docker logs --since "$t1" "$P-ws" 2>&1)"
bash "$E" stub | grep -q '"Dave Fixture"' && { echo "Dave was sent to the LLM again"; c12_ok=0; }
[ "$(davenotes)" = 1 ] && [ "$w1" != "$w0" ] || c12_ok=0
echo "$s1" | grep -q "notebook-synth: all" && echo "$L1" | grep -q "\[reconcile\]" && echo "$L1" | grep -q "planned manifest:" || { echo "x cycle 1: rest of cycle"; c12_ok=0; }

echo "== cycle 2: Dave's inputs change (entity bumped) -> retried ONCE, same failure, NOT notified again"
bash "$E" psql "update entities set updated_at=now() where id=905 returning id" >/dev/null
bash "$E" stub '{"mode":"davebad"}' >/dev/null
t2="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; s2="$(bash "$E" ws_cycle)"; cyc "$t2" "$s2"; w2="$(state)"; L2="$(docker logs --since "$t2" "$P-ws" 2>&1)"
bash "$E" stub | grep -q '"Dave Fixture":1' || c12_ok=0
[ "$(davenotes)" = 1 ] && [ "$w2" != "$w1" ] || c12_ok=0
echo "$L2" | grep -q "not notified again" && echo "$L2" | grep -q "compile FAILED (.*watermark advanced)" || c12_ok=0

echo "== cycle 3: nothing changed -> skipped again"
bash "$E" stub '{"mode":"davebad"}' >/dev/null
t3="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; s3="$(bash "$E" ws_cycle)"; cyc "$t3" "$s3"
bash "$E" stub | grep -q '"Dave Fixture"' && c12_ok=0

echo "== cycle 4: the model is fixed and the operator clears Dave -> he compiles, the ledger empties, the page is presented"
bash "$E" stub '{"mode":"ok"}' >/dev/null
docker exec "$P-ws" node /recipes/entity-wiki/generate-wiki.mjs --clear-structural 905 --out-dir /wiki/content
t4="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; s4="$(bash "$E" ws_cycle)"; cyc "$t4" "$s4"; L4="$(docker logs --since "$t4" "$P-ws" 2>&1)"
sleep 6; dv="$(curl_ /content/person/person-dave-fixture)"; echo "dave URL: $dv"
echo "$L4" | grep -q "compile ok" && echo "$dv" | grep -q "x-wiki-render=db" && echo "$s4" | grep -q '"structural_open":\[\]' \
  && echo "$L4" | grep -q "\[reconcile\] clean: " || { echo "x cycle 4"; c12_ok=0; }
echo "== attempt 3: the 'landed' count is PER CYCLE (it used to count up across cycles: 2, 4, 6, ...)"
lc="$(docker logs --since "$t0" "$P-ws" 2>&1 | grep -o 'wiki-pages\] wiki-service: all [0-9]* written' | grep -o '[0-9]*' | tr '\n' ' ')"; echo "per-cycle landed counts: $lc"
[ "$(echo "$lc" | wc -w)" -ge 5 ] && [ "$(echo "$lc" | tr ' ' '\n' | grep -v '^$' | sort -u | wc -l)" = 1 ] || { echo "x the landed count is not per cycle"; c12_ok=0; }

if want C16; then
echo "== C16 (attempt 3, tester AT2-7): the DATABASE goes down while a compile's rows are written -> TRANSIENT notification (not structural), the rows are retried next cycle"
c16_ok=1
bash "$E" stub '{"mode":"ok","delayMs":8000}' >/dev/null
bash "$E" psql "update entities set updated_at=now() where id in (901, 906) returning id" >/dev/null
n0="$(notes_count)"
t5="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker run --rm --network "$NET" --entrypoint node "$IMG" -e "fetch('http://$P-ws:8000/recompile', { method: 'POST', headers: { 'x-brain-key': 'fixture-key' } }).then(async r=>console.log('recompile', r.status))"
for _ in $(seq 1 60); do docker logs --since "$t5" "$P-ws" 2>&1 | grep -q "incremental compile" && break; sleep 1; done
sleep 3; docker stop "$P-db" >/dev/null; echo "db stopped (the stub is still holding the compile's LLM replies)"
sleep 14; docker start "$P-db" >/dev/null; echo "db started"
s5="$(P1A_WS_WAIT_S=300 bash "$E" ws_wait "$t5")"; L5="$(docker logs --since "$t5" "$P-ws" 2>&1)"
echo "$L5" | grep -E "UNSYNCED|database was unavailable|notify\]|compile (ok|FAILED)|FAILED" | cut -c1-260 | head -12
nl="$(newnotes "$n0")"; echo "new notifications: $(echo "$nl" | grep -o '"class":"[a-z]*","subject":"[^"]*"' | tr '\n' ' ')"
echo "$nl" | grep -q '"class":"transient","subject":"row write failed: database unavailable (' || { echo "x no transient row-write notification"; c16_ok=0; }
echo "$nl" | grep -q 'row write rejected' && { echo "x an outage was notified as a structural rejection"; c16_ok=0; }
pend="$(bash "$E" cat content/.unsynced-rows.json | grep -c '"error"')"; echo "rows recorded for retry: $pend"
[ "$pend" -ge 1 ] || { echo "x nothing recorded for the next cycle"; c16_ok=0; }
for _ in $(seq 1 60); do curl_ /content/person/person-ada-fixture | grep -q "x-wiki-render=" && break; sleep 1; done
bash "$E" stub '{"mode":"ok"}' >/dev/null
t6="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; s6="$(bash "$E" ws_cycle)"; L6="$(docker logs --since "$t6" "$P-ws" 2>&1)"
echo "$L6" | grep -E "retried [0-9]+ row\(s\) left unsynced|\[reconcile\]|compile (ok|FAILED)" | cut -c1-260 | head -6
echo "$L6" | grep -qE "retried [0-9]+ row\(s\) left unsynced by a database outage: [1-9][0-9]* landed, 0 failed again" || { echo "x the next cycle did not retry the rows"; c16_ok=0; }
left="$(bash "$E" cat content/.unsynced-rows.json | grep -c '"error"')"; echo "left for retry after the next cycle: $left"
[ "$left" = 0 ] || c16_ok=0
echo "$L6" | grep -q "\[reconcile\] clean: " || { echo "x not clean after the retry"; c16_ok=0; }
[ "$c16_ok" = 1 ] && pass C16 || fail C16 "see output"
fi
docker rm -f -v "$P-ws" >/dev/null 2>&1
[ "$c12_ok" = 1 ] && pass C12 || fail C12 "see output"
fi

if want C13; then
hdr "C13 existing suites: recipes on the host, viewer in a CLEAN container"
o1="$(cd "$OB1" && T 600 node --test recipes/_shared/*.test.mjs recipes/entity-wiki/generate-wiki.test.mjs recipes/wiki-synthesis/scripts/synthesize-notebooks.test.mjs 2>&1)"; echo "$o1" | grep -E "^# (tests|pass|fail)"
o2="$(T 600 docker run --rm --network none --entrypoint sh "$IMG" -c 'cd /quartz && node --test lib/*.test.mjs' 2>&1)"; echo "$o2" | grep -E "^# (tests|pass|fail)"
if echo "$o1" | grep -q "^# fail 0" && echo "$o2" | grep -q "^# fail 0"; then pass C13; else fail C13 "a suite failed"; fi
fi

[ -n "${KEEP:-}" ] || bash "$E" down
echo; echo "================ SUMMARY"; printf '%s\n' "${results[@]}"
printf '%s\n' "${results[@]}" | grep -q '^FAIL' && exit 1 || exit 0
