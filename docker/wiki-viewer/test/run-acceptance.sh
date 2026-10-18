#!/usr/bin/env bash
# rw-p1a-render: run every acceptance case, in the test plan's order, against
# the disposable environment (test/p1a-env.sh). Prints each command's output
# and a PASS/FAIL line per case; exits non-zero if any case fails.
#
#   bash OB1/docker/wiki-viewer/test/run-acceptance.sh            # build + up + all cases + down
#   KEEP=1 bash .../run-acceptance.sh                             # leave the environment up afterwards
#
# Nothing here touches a live container, network, volume or image: every
# name is wt-rw-p1a-render-*, the network is private, the LLM is a stub.
set -uo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E="$HERE/p1a-env.sh"
OB1="$(cd "$HERE/../../.." && (pwd -W 2>/dev/null || pwd))"  # a path git.exe and docker accept (MSYS_NO_PATHCONV=1 is set)
IMG=openbrain-wiki-viewer:wt-rw-p1a-render
results=()
pass() { results+=("PASS $1"); echo "==> PASS $1"; }
fail() { results+=("FAIL $1 - $2"); echo "==> FAIL $1 - $2"; }
hdr() { echo; echo "################ $1"; }
curl_() { bash "$E" curl "$@"; }
health() { docker run --rm --network wt-rw-p1a-render-net --entrypoint node "$IMG" -e "fetch('http://wt-rw-p1a-render-viewer:8080/__health').then(async r=>console.log(r.status, await r.text()))"; }
notes_count() { bash "$E" notes | grep -c '"class"' || true; }

hdr "C0 build + environment"
bash "$E" down >/dev/null 2>&1
bash "$E" build 2>&1 | grep -E "# (tests|pass|fail)|label org" | tail -4
bash "$E" up 2>&1 | tail -6
bash "$E" wait_built 300 || fail C0 "viewer never served"

hdr "C1+C2 (acceptance 1, 2): 20 URLs x-wiki-render: db, chrome elements, body diff vs built page"
out="$(bash "$E" parity 2>&1)"; echo "$out" | tail -23
echo "$out" | grep -q "PARITY: PASS" && pass "C1+C2 parity" || fail "C1+C2 parity" "see output"

hdr "C3 (acceptance 3): deleted row -> pending-compile, no-store, never the file"
bash "$E" psql "delete from wiki_pages where slug='content/person/person-ada-fixture' returning slug"
o="$(curl_ /content/person/person-ada-fixture body)"; echo "$o" | head -1
if echo "$o" | head -1 | grep -q "x-wiki-render=pending .*cache-control=no-store" && echo "$o" | grep -q 'data-render-state="pending"' \
   && ! echo "$o" | grep -q "Ada Fixture is a synthetic person"; then pass C3; else fail C3 "not the pending state, or file content present"; fi

hdr "C5 (acceptance 5): reconciliation names the deleted row and a row older than its file"
bash "$E" psql "update wiki_pages set updated_at='2020-01-01T00:00:00Z' where slug='content/tool/tool-fixture-db' returning slug, updated_at"
o="$(bash "$E" node /ob1/recipes/_shared/reconcile-wiki-pages.mjs --vault /wiki 2>&1)"; rc=$?; echo "$o"; echo "exit=$rc"
sleep 7; h="$(health)"; echo "health: $h" | cut -c1-400
if [ "$rc" = 1 ] && echo "$o" | grep -q "missing: content/person/person-ada-fixture" && echo "$o" | grep -q "stale: content/tool/tool-fixture-db" \
   && echo "$h" | grep -q '^503 .*"missing":\["content/person/person-ada-fixture"\].*"stale":\["content/tool/tool-fixture-db"\]'; then pass C5; else fail C5 "a slug not named, or a clean report"; fi

hdr "C6 (acceptance 6): database stopped / starting / reconnect"
docker stop wt-rw-p1a-render-db >/dev/null; sleep 8
o="$(bash "$E" node /ob1/docker/wiki-viewer/test/outage-probe.mjs sweep --expect unreachable 2>&1)"; rc=$?; echo "$o" | cut -c1-260
h="$(health)"; echo "health(stopped): $h" | cut -c1-300
docker rm -f -v wt-rw-p1a-render-watch >/dev/null 2>&1
docker run -d --name wt-rw-p1a-render-watch --network wt-rw-p1a-render-net -v "$OB1:/ob1:ro" --entrypoint node "$IMG" \
  /ob1/docker/wiki-viewer/test/outage-probe.mjs watch --seconds 90 >/dev/null
sleep 1; docker start wt-rw-p1a-render-db >/dev/null
for _ in $(seq 1 60); do docker logs wt-rw-p1a-render-watch 2>&1 | grep -q "WATCH:" && break; sleep 2; done
w="$(docker logs wt-rw-p1a-render-watch 2>&1)"; echo "$w"; docker rm -f -v wt-rw-p1a-render-watch >/dev/null
sleep 3; vlog="$(docker logs wt-rw-p1a-render-viewer 2>&1 | grep -E "database (unreachable|connecting|up)|reconcile pass \(reconnect|repair pass" | tail -6)"; echo "$vlog" | cut -c1-300
h2="$(health)"; echo "health(after): $h2" | cut -c1-200
if [ "$rc" = 0 ] && echo "$h" | grep -q '^503 .*"database unreachable"' && echo "$w" | grep -q "WATCH: sequence .*unreachable.*connecting.*db" \
   && echo "$vlog" | grep -q "reconcile pass (reconnect" && echo "$h2" | grep -q '^200 '; then pass C6; else fail C6 "see output"; fi

hdr "C9 (acceptance 9): raw HTML in a source body is dropped"
o="$(curl_ /content/source/00000000-0000-4000-8000-000000000002 body)"
art="$(echo "$o" | tr -d '\n' | grep -o '<article class="popover-hint">.*</article>')"
echo "live article raw-HTML hits: $(echo "$art" | grep -oE '<script|onclick=|onerror=|<iframe' | wc -l)"
built="$(docker exec wt-rw-p1a-render-viewer cat /srv/current/content/source/00000000-0000-4000-8000-000000000002.html | tr -d '\n' | grep -o '<article class="popover-hint">.*</article>')"
echo "built article raw-HTML hits: $(echo "$built" | grep -oE '<script|onclick=|onerror=|<iframe' | wc -l)"
if [ -n "$art" ] && ! echo "$art" | grep -qE '<script|onclick=|onerror=|<iframe'; then pass C9; else fail C9 "raw HTML rendered"; fi

hdr "C7a (acceptance 7): chat 503 x3 then success -> page lands, no notification"
n0="$(notes_count)"; bash "$E" stub '{"mode":"flaky503","n":3}' >/dev/null
o="$(bash "$E" compile generate --ids 904 --out-dir /wiki/content --no-graph 2>&1)"; rc=$?; echo "$o"; echo "exit=$rc"
s="$(bash "$E" stub)"; echo "stub: $s"; n1="$(notes_count)"; c="$(curl_ /content/person/person-carol-fixture)"; echo "$c"
if [ "$rc" = 0 ] && echo "$s" | grep -q '"chatCalls":4' && [ "$n0" = "$n1" ] && echo "$c" | grep -q "x-wiki-render=db"; then pass C7a; else fail C7a "see output"; fi

hdr "C7b (acceptance 7): failing throughout, /v1/models failing -> one 'model unavailable', entity in the ledger, no page written"
before="$(bash "$E" node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('/wiki/content/person/person-bob-fixture.md')).digest('hex'))")"
rowb="$(bash "$E" psql "select updated_at from wiki_pages where slug='content/person/person-bob-fixture'")"
n0="$(notes_count)"; bash "$E" stub '{"mode":"fail","modelsOk":false}' >/dev/null
o="$(bash "$E" compile generate --ids 902 --out-dir /wiki/content --no-graph 2>&1)"; rc=$?; echo "$o"; echo "exit=$rc"
s="$(bash "$E" stub)"; echo "stub: $s"; nl="$(bash "$E" notes | tail -n +$((n0 + 1)))"; echo "new notifications: $nl"
ledger="$(docker run --rm -v wt-rw-p1a-render-vault:/wiki:ro --entrypoint cat "$IMG" /wiki/content/.failed-entity-ids.json 2>&1)"; echo "ledger: $ledger"
after="$(bash "$E" node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('/wiki/content/person/person-bob-fixture.md')).digest('hex'))")"
rowa="$(bash "$E" psql "select updated_at from wiki_pages where slug='content/person/person-bob-fixture'")"
echo "bob file sha before=$before after=$after; row updated_at before=$rowb after=$rowa"
if echo "$s" | grep -q '"chatCalls":4' && [ "$(echo "$nl" | grep -c '"subject":"model unavailable: stub-model"')" = 1 ] && [ "$(echo "$nl" | grep -c '"class"')" = 1 ] \
   && echo "$ledger" | grep -q '902' && [ "$before" = "$after" ] && [ "$rowb" = "$rowa" ]; then pass C7b; else fail C7b "see output"; fi

hdr "C7c (acceptance 7): failing throughout, /v1/models healthy -> 'LLM call failing for this task'"
n0="$(notes_count)"; bash "$E" stub '{"mode":"fail","modelsOk":true}' >/dev/null
o="$(bash "$E" compile generate --ids 901 --out-dir /wiki/content --no-graph 2>&1)"; rc=$?; echo "$o"; echo "exit=$rc"
s="$(bash "$E" stub)"; echo "stub: $s"; nl="$(bash "$E" notes | tail -n +$((n0 + 1)))"; echo "new notifications: $nl"
if echo "$s" | grep -q '"chatCalls":4' && echo "$nl" | grep -q '"subject":"LLM call failing for this task: #901 Ada Fixture"' && [ "$(echo "$nl" | grep -c '"class"')" = 1 ]; then pass C7c; else fail C7c "see output"; fi

hdr "C8 (acceptance 8): a reply the page parser rejects -> structural, no retry, one notification, non-zero exit, pending, not in the ledger"
n0="$(notes_count)"; bash "$E" stub '{"mode":"badparse"}' >/dev/null
o="$(bash "$E" compile generate --ids 905 --out-dir /wiki/content --no-graph 2>&1)"; rc=$?; echo "$o"; echo "exit=$rc"
s="$(bash "$E" stub)"; echo "stub: $s"; nl="$(bash "$E" notes | tail -n +$((n0 + 1)))"; echo "new notifications: $nl"
ledger="$(docker run --rm -v wt-rw-p1a-render-vault:/wiki:ro --entrypoint sh "$IMG" -c 'cat /wiki/content/.failed-entity-ids.json 2>/dev/null || echo "(no ledger file)"')"; echo "ledger: $ledger"
c="$(curl_ /content/person/person-dave-fixture)"; echo "$c"
if [ "$rc" != 0 ] && echo "$s" | grep -q '"chatCalls":1' && echo "$nl" | grep -q '"subject":"compile structural failure: content/person/person-dave-fixture","slug":"content/person/person-dave-fixture"' \
   && [ "$(echo "$nl" | grep -c '"class"')" = 1 ] && ! echo "$ledger" | grep -q 905 && echo "$c" | grep -q "x-wiki-render=pending"; then pass C8; else fail C8 "see output"; fi

hdr "C4 (acceptance 4): row flush made to fail -> non-zero exit, unsynced count + first slugs, never 'compile ok'"
bash "$E" stub '{"mode":"ok"}' >/dev/null
bash "$E" psql "REVOKE INSERT, UPDATE ON wiki_pages FROM service_role"
og="$(bash "$E" compile generate --ids 906 --out-dir /wiki/content --no-graph 2>&1)"; rg=$?; echo "$og"; echo "exit=$rg"
os="$(bash "$E" compile synth 2>&1)"; rs=$?; echo "$os"; echo "exit=$rs"
bash "$E" psql "GRANT ALL ON wiki_pages TO service_role"
if [ "$rg" != 0 ] && [ "$rs" != 0 ] && echo "$og" | grep -q "generate-wiki FAILED: 1 page(s) UNSYNCED .*first: content/person/person-erin-fixture" \
   && echo "$os" | grep -q "notebook-synth FAILED: [0-9]* page(s) UNSYNCED .*first: content/notebooks/" && ! echo "$og$os" | grep -qi "compile ok"; then pass C4; else fail C4 "see output"; fi

hdr "C10 (acceptance 10): a new page class registered (one compile rule, one renderer template), existing entries untouched"
o="$(bash "$E" node /ob1/docker/wiki-viewer/test/fixtures/extra-class/compile-glossary.mjs 2>&1)"; rc=$?; echo "$o"
d="$(curl_ /content/glossary/term-fixture)"; echo "without the entry file: $d"
P1A_EXTRA_CLASS=1 bash "$E" viewer; bash "$E" wait_built 200
g="$(curl_ /content/glossary/term-fixture body)"; echo "with the entry file: $(echo "$g" | head -1)"; echo "marker: $(echo "$g" | grep -o 'data-glossary-template="1"' | head -1)"
st="$(git -C "$OB1" status --porcelain -- docker/wiki-viewer/lib/page-classes recipes/_shared/page-classes.mjs 2>&1)" || st="GIT-ERROR: $st"; echo "tracked entry files changed by this case: [${st}]"
if [ "$rc" = 0 ] && echo "$o" | grep -q "glossary: files=1 rows=1" && echo "$d" | grep -q "x-wiki-page-class=row@1" \
   && echo "$g" | head -1 | grep -q "x-wiki-page-class=glossary@1" && echo "$g" | grep -q 'data-glossary-template="1"' && [ -z "$st" ]; then pass C10; else fail C10 "see output"; fi

hdr "C11 (acceptance 11): image revision label = the OB1 commit it was built from (= the gitlink at deploy)"
label="$(docker image inspect "$IMG" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
head_="$(git -C "$OB1" rev-parse HEAD 2>&1)" || head_="GIT-ERROR"; dirty="$(git -C "$OB1" status --porcelain -- docker/wiki-viewer recipes/_shared 2>&1 | grep -v '^??' | head -3)"
echo "label=$label OB1 HEAD=$head_ tracked-dirty=[${dirty}]"
if [ -n "$label" ] && [ "$label" = "$head_" ] && [ -z "$dirty" ]; then pass C11; else fail C11 "label empty or not HEAD (or the tree is dirty)"; fi

[ -n "${KEEP:-}" ] || bash "$E" down
echo; echo "================ SUMMARY"; printf '%s\n' "${results[@]}"
printf '%s\n' "${results[@]}" | grep -q '^FAIL' && exit 1 || exit 0
