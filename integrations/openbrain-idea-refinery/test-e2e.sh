#!/usr/bin/env bash
# ==============================================================================
# Idea Refinery — consolidated end-to-end rollout gate (§12.1) + regression test.
#
# Spins the whole drain/delivery loop against THROWAWAY containers (Postgres +
# a mock research service + a mock Mattermost + the real built service) and
# asserts every stage: research→deliver (new thread), dirty→UPDATE-append (root
# preserved), research_now priority, attempts-cap exclusion, the redelivery
# recovery pass, dormancy (fizzle), resurface cross-links, and the backfill
# migration (parked + idempotent). Exit 0 = GATE GREEN.
#
# Nothing touches the live stack. Windows + Git-Bash + Docker Desktop.
#   Usage:  bash OB1/integrations/openbrain-idea-refinery/test-e2e.sh
# ==============================================================================
set -u
export MSYS_NO_PATHCONV=1

cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
SVC_WIN="$(pwd -W)"                                   # D:/... for docker build/cp
MIG_WIN="$SVC_WIN/migrate-ideas-backfill.py"
DOCKER_DIR="$(cd ../../docker && pwd)"                # /d/... for < redirects
INITSQL="$DOCKER_DIR/init.sql"
IDEASQL="$DOCKER_DIR/init-ideas.sql"

NET=ir-e2e; DB=ir-e2e-db; MR=ir-e2e-mr; MM=ir-e2e-mm; SVC=ir-e2e-svc; PY=ir-e2e-py
cleanup() { docker rm -f "$DB" "$MR" "$MM" "$SVC" "$PY" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT
cleanup

PASS=0; FAIL=0
assert() { if [ "$2" = "$3" ]; then echo "  ✅ $1"; PASS=$((PASS+1)); else echo "  ❌ $1 — expected [$2] got [$3]"; FAIL=$((FAIL+1)); fi; }
q() { docker exec "$DB" psql -U postgres -d openbrain -tAc "$1"; }
val() { echo "$1" | grep -o "\"$2\":[0-9]*" | head -1 | cut -d: -f2; }

echo "== setup =="
docker network create "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=openbrain pgvector/pgvector:pg16 >/dev/null
n=0; until docker exec "$DB" psql -U postgres -d openbrain -tAc 'SELECT 1' >/dev/null 2>&1; do n=$((n+1)); [ $n -gt 200 ] && { echo "DB never ready"; exit 1; }; done

docker exec -i "$DB" psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
SQL
docker exec -i "$DB" psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -q -f - < "$INITSQL" >/dev/null
docker exec -i "$DB" psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -q -c "CREATE TABLE IF NOT EXISTS public.sources (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), url TEXT);" >/dev/null
docker exec -i "$DB" psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -q -f - < "$IDEASQL" >/dev/null

docker exec -i "$DB" psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE FUNCTION vfill(a real,b real) RETURNS vector LANGUAGE sql AS
$$ SELECT ('['||array_to_string(array_fill(a,ARRAY[512])||array_fill(b,ARRAY[512]),',')||']')::vector $$;
-- A: fresh, near Z (resurface)
INSERT INTO ideas (title,summary,status,current_revision,embedding) VALUES ('A','a body','new',1,vfill(1,0)) RETURNING id AS a \gset
INSERT INTO idea_revisions (idea_id,revision,summary) VALUES (:'a',1,'a body');
-- B: dirty with an existing thread (append path)
INSERT INTO ideas (title,summary,status,current_revision,thread_root) VALUES ('B','b v2','dirty',2,'root-B') RETURNING id AS b \gset
INSERT INTO idea_revisions (idea_id,revision,summary,research_job_id) VALUES (:'b',1,'b v1','jb');
INSERT INTO idea_revisions (idea_id,revision,summary) VALUES (:'b',2,'b v2');
-- C: attempts-capped (excluded)
INSERT INTO ideas (title,summary,status,current_revision,metadata) VALUES ('C','c body','new',1,'{"research_attempts":3}') RETURNING id AS c \gset
INSERT INTO idea_revisions (idea_id,revision,summary) VALUES (:'c',1,'c body');
-- D: researched-but-undelivered (redelivery pass)
INSERT INTO ideas (title,summary,status,current_revision,last_job_id) VALUES ('D','d body','queued',1,'jD') RETURNING id AS d \gset
INSERT INTO idea_revisions (idea_id,revision,summary,research_job_id) VALUES (:'d',1,'d body','jD');
-- E: researched + unengaged + stale → dormancy
INSERT INTO ideas (title,summary,status,current_revision,embedding) VALUES ('E','e body','researched',1,vfill(0,1)) RETURNING id AS e \gset
INSERT INTO idea_revisions (idea_id,revision,summary,research_job_id) VALUES (:'e',1,'e body','je');
-- F: researched + ENGAGED → not aged
INSERT INTO ideas (title,summary,status,current_revision,engaged_at) VALUES ('F','f body','researched',1,now()) RETURNING id AS f \gset
INSERT INTO idea_revisions (idea_id,revision,summary,research_job_id) VALUES (:'f',1,'f body','jf');
-- P: research_now priority (engaged so it is not aged; re-selected via the flag)
INSERT INTO ideas (title,summary,status,current_revision,engaged_at,metadata) VALUES ('P','p body','researched',1,now(),'{"research_now":true}') RETURNING id AS p \gset
INSERT INTO idea_revisions (idea_id,revision,summary,research_job_id) VALUES (:'p',1,'p body','jp');
-- Z: dormant, near A (resurface source)
INSERT INTO ideas (title,summary,status,current_revision,embedding) VALUES ('Parked Zebra','z body','dormant',1,vfill(1,0)) RETURNING id AS z \gset
INSERT INTO idea_revisions (idea_id,revision,summary,research_job_id) VALUES (:'z',1,'z body','jz');
SQL

docker run -d --name "$MR" --network "$NET" python:3-slim python -c '
import http.server, json, uuid
class H(http.server.BaseHTTPRequestHandler):
    def _s(self,c,o):
        self.send_response(c); self.send_header("content-type","application/json"); self.end_headers(); self.wfile.write(json.dumps(o).encode())
    def do_POST(self):
        n=int(self.headers.get("content-length",0)); self.rfile.read(n); self._s(202,{"job_id":str(uuid.uuid4()),"status":"queued"})
    def do_GET(self): self._s(200,{"status":"done","result":{"synthesis":"landscape","cited_sources":[{"title":"Acme","url":"http://acme"}],"thread_id":None}})
    def log_message(self,*a): pass
http.server.HTTPServer(("0.0.0.0",8000),H).serve_forever()
' >/dev/null
docker run -d --name "$MM" --network "$NET" python:3-slim python -c '
import http.server, json, uuid
class H(http.server.BaseHTTPRequestHandler):
    def _s(self,c,o):
        self.send_response(c); self.send_header("content-type","application/json"); self.end_headers(); self.wfile.write(json.dumps(o).encode())
    def do_GET(self):
        if self.path.endswith("/users/me/teams"): self._s(200,[{"id":"t1","name":"main"}])
        elif "/channels/name/" in self.path: self._s(200,{"id":"c1"})
        else: self._s(200,{})
    def do_POST(self):
        n=int(self.headers.get("content-length",0)); b=self.rfile.read(n)
        if self.path.endswith("/posts"):
            try: print("POSTED:", json.loads(b).get("message","").replace(chr(10)," "), flush=True)
            except Exception: pass
            self._s(201,{"id":"P-"+uuid.uuid4().hex[:8]})
        elif self.path.endswith("/channels"): self._s(201,{"id":"c1"})
        else: self._s(200,{})
    def log_message(self,*a): pass
http.server.HTTPServer(("0.0.0.0",8065),H).serve_forever()
' >/dev/null

docker build -t openbrain-idea-refinery:e2e "$SVC_WIN" >/dev/null 2>&1
docker run -d --name "$SVC" --network "$NET" -p 18091:8080 \
  -e DB_HOST="$DB" -e DB_PASSWORD=test -e DB_NAME=openbrain \
  -e RESEARCH_URL=http://"$MR":8000 -e MCP_ACCESS_KEY=k \
  -e MATTERMOST_URL=http://"$MM":8065 -e MATTERMOST_TOKEN=t \
  -e IDEA_DORMANCY_DAYS=0 -e PORT=8080 openbrain-idea-refinery:e2e >/dev/null
n=0; until curl -sf http://localhost:18091/health >/dev/null 2>&1; do n=$((n+1)); [ $n -gt 90 ] && { echo "svc never healthy"; docker logs "$SVC"; exit 1; }; done

echo "== run the drain =="
SUMMARY="$(curl -s -X POST 'http://localhost:18091/run?wait=1')"
echo "  summary: $SUMMARY"

echo "== assertions: drain summary =="
assert "3 ideas selected (A,B,P; C excluded by cap)"  3 "$(val "$SUMMARY" selected)"
assert "3 succeeded"                                   3 "$(val "$SUMMARY" succeeded)"
assert "0 failed"                                      0 "$(val "$SUMMARY" failed)"
assert "1 redelivered (D)"                             1 "$(val "$SUMMARY" delivered_pending)"
assert "1 aged to dormant (E)"                         1 "$(val "$SUMMARY" dormant)"

echo "== assertions: lifecycle state =="
assert "A researched"          researched "$(q "SELECT status FROM ideas WHERE title='A'")"
assert "B researched"          researched "$(q "SELECT status FROM ideas WHERE title='B'")"
assert "B thread preserved"    root-B     "$(q "SELECT thread_root FROM ideas WHERE title='B'")"
assert "C untouched (new)"     new        "$(q "SELECT status FROM ideas WHERE title='C'")"
assert "D delivered"           researched "$(q "SELECT status FROM ideas WHERE title='D'")"
assert "E dormant"             dormant    "$(q "SELECT status FROM ideas WHERE title='E'")"
assert "F not aged"            researched "$(q "SELECT status FROM ideas WHERE title='F'")"
assert "P researched"          researched "$(q "SELECT status FROM ideas WHERE title='P'")"
assert "P research_now cleared" "" "$(q "SELECT COALESCE(metadata->>'research_now','') FROM ideas WHERE title='P'")"
A_TR="$(q "SELECT thread_root FROM ideas WHERE title='A'")"
case "$A_TR" in P-*) assert "A got a new thread" ok ok ;; *) assert "A got a new thread" "P-*" "$A_TR" ;; esac
RES="$(docker logs "$MM" 2>&1 | grep -c 'parked earlier: Parked Zebra')"
assert "A dossier has resurface cross-link" 1 "$RES"

echo "== assertions: backfill migration (IR.7) =="
docker exec -i "$DB" psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -q -c \
  "INSERT INTO thoughts (content, metadata) VALUES ('a backfilled idea', '{\"type\":\"idea\"}'), ('not an idea', '{\"type\":\"observation\"}');" >/dev/null
docker run -d --name "$PY" --network "$NET" python:3-slim sleep 300 >/dev/null
docker exec "$PY" pip install -q psycopg2-binary >/dev/null 2>&1
docker cp "$MIG_WIN" "$PY":/mig.py
R1="$(docker exec -e DB_HOST="$DB" -e DB_PASSWORD=test -e DB_NAME=openbrain "$PY" python /mig.py | tail -1)"
R2="$(docker exec -e DB_HOST="$DB" -e DB_PASSWORD=test -e DB_NAME=openbrain "$PY" python /mig.py)"
assert "backfill migrated 1 (idea-typed only)"  "migrated 1 idea(s) as dormant/parked." "$R1"
assert "backfill is idempotent (re-run 0)"      0 "$(val "$(echo "$R2" | head -1 | sed 's/candidates: \([0-9]*\).*/{\"candidates\":\1}/')" candidates)"
assert "backfilled idea is dormant"    dormant "$(q "SELECT status FROM ideas WHERE title='a backfilled idea'")"
assert "backfilled idea NOT owed (parked)" 0 "$(q "SELECT count(*) FROM ideas_owed_research WHERE title='a backfilled idea'")"

echo
echo "=============================================="
echo "  PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then echo "  ROLLOUT GATE: 🟢 GREEN"; else echo "  ROLLOUT GATE: 🔴 RED"; fi
echo "=============================================="
[ "$FAIL" -eq 0 ]
