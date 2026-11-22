# run-withheld-text-rescan-lab.ps1 - rw-withheld-text-rescan's disposable lab: the stored wiki rows that already carry
# withheld text are withheld by rescan-withheld-text.sql, with 440's text rule unchanged; resumable; revert byte-identical.
#
#   powershell -NoProfile -File OB1\docker\withheld-text-rescan\run-withheld-text-rescan-lab.ps1 [-Id <owner id>]
#       [-Evidence <dir>] [-Filler 2400] [-Chunk 100]
#
# What it does, and ONLY this:
#   1. stages this checkout's initdb chain from docker/docker-compose.yml
#   2. ONE --internal bridge network on a documentation range and one postgres container, both labelled
#      ai-stack.harness.owner=<Id>; no image is built, no host port, no compose, no ai-stack_* / open-brain_* network
#   3. the database: the chain; ob_app_memory as production has it; an empty-store scan (withholds nothing); three
#      unowned thoughts and their leaves; slot 440 with owner A (the leaves withheld, their text kept for the rule);
#      then the rows stored BEFORE the text rule (lab-plant.sql phase=legacy: flagged note A / note B / 2 sources /
#      2 entities, 6 controls incl. two near misses, :Filler ordinary rows)
#   4. RED, before the scan: the flagged rows ARE presented to A and B (the viewer's role and the workbench role: the
#      row read and the search) - the defect; the read-only count sees exactly the 6
#   5. the scan, interrupted twice (a clean stop after 3 chunks; a killed backend mid-chunk), then continued to the
#      end: no row scanned twice, every chunk range disjoint, every flagged row archived once and withheld, every
#      control and filler row untouched; output carries no planted text or slug
#   6. after: nothing flagged presented to A or B; the guard keeps a re-write out; the count reads 0; a re-run on the
#      clean database withholds nothing; the revert restores the whole table byte-identically; a second revert no-ops
#   7. tears down exactly what it created and verifies nothing labelled <Id> is left
# Exit code 0 = every check passed.
param(
  [string]$Id = 'wt-rw-withheld-text-rescan',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Evidence = '',
  [int]$Filler = 2400,
  [int]$Chunk = 100
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$label = "ai-stack.harness.owner=$Id"
$labDir = $PSScriptRoot
$dockerDir = Split-Path -Parent $labDir
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rwtr-net-$rand"; $db = "rwtr-db-$rand"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "rwtr-evidence-$rand" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$work = Join-Path $env:TEMP "rwtr-work-$rand"
$A = "lab-owner-a-$rand"; $B = "lab-owner-b-$rand"
$Mark = "rescanmark$rand"

$script:fail = 0
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }
function Save([string]$name, [string]$text) {
  [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false))
}
function Get-Chain([string]$dir) {
  $cf = Join-Path $dir 'docker-compose.yml'
  $compose = (@(Get-Content $cf) | ForEach-Object { $_ -replace '(^|\s)#.*$', '' }) -join "`n"
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  return , @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
}
function Q([string]$sql) { $r = Dk exec $db psql -U postgres -d openbrain -X -A -t -c $sql; return "$r".Trim() }
# a read as a shared surface: the role (service_role = the viewer's PostgREST anon; ob_app_memory = the workbench) and
# the identity it serves
function QAs([string]$role, [string]$sub, [string]$sql) {
  $r = Dk exec $db psql -U postgres -d openbrain -X -A -t -q -c "SET ROLE $role; SET ob.user_id = '$sub'; $sql"
  return "$r".Trim()
}
function PsqlFile([string]$local, [string[]]$vars) {
  $name = '/tmp/' + [IO.Path]::GetFileName($local)
  $null = Dk cp $local "${db}:$name"
  $a = @('exec', $db, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'openbrain', '-X') + $vars + @('-f', $name)
  $o = Dk @a
  return @{ rc = $script:rc; out = $o }
}
function NoText([string]$what, [string]$out) {
  $leak = ($out -match [regex]::Escape($Mark)) -or ($out -match 'alpha|bravo|charlie|secret dinner|content/|notes/')
  Check (-not $leak) "$what printed no planted text and no slug (counts and md5 prefixes only)"
}
$fp = "SELECT md5(string_agg(to_jsonb(w)::text, '|' ORDER BY slug)) || ':' || count(*) FROM public.wiki_pages w"
$flagSlugs = "(SELECT slug FROM public.lab_rescan_plant WHERE flagged)"
$ctlSlugs = "(SELECT slug FROM public.lab_rescan_plant WHERE NOT flagged)"
# what a shared surface presents of the planted rows: the row read (the viewer's page route, the workbench's knowledge
# read) and the search (the viewer's and the workbench's FTS over search_tsv), as "flagged|controls"
function Presented([string]$role, [string]$sub) {
  $sql = "SELECT (SELECT count(*) FROM public.wiki_pages w WHERE w.slug IN $flagSlugs) || '/' ||
                 (SELECT count(*) FROM public.wiki_pages w WHERE w.search_tsv @@ (plainto_tsquery('english', 'alpha${Mark}w20') || plainto_tsquery('english', 'bravo${Mark}w60') || plainto_tsquery('english', 'charlie${Mark}')) AND w.slug IN $flagSlugs) || '|' ||
                 (SELECT count(*) FROM public.wiki_pages w WHERE w.slug IN $ctlSlugs)"
  return QAs $role $sub $sql
}

Write-Host "== rw-withheld-text-rescan disposable run  owner=$Id  net=$net  evidence=$Evidence"
$null = Dk version --format '{{.Server.Version}}'
if ($script:rc -ne 0) { Write-Host 'docker is not reachable'; exit 2 }

try {
  Write-Host '[1] the chain under test (this checkout)'
  $stage = Join-Path $work 'initdb'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = Get-Chain $dockerDir
  foreach ($mig in $chain) { Copy-Item (Join-Path $dockerDir $mig[0]) (Join-Path $stage $mig[1]) }
  $staged = @(Get-ChildItem $stage -Filter *.sql).Count
  Check ($chain.Count -ge 50 -and $staged -eq $chain.Count) "staged $staged of $($chain.Count) migrations"
  Check (@($chain | Where-Object { $_[1] -eq '440-init-inlet-owner.sql' }).Count -eq 1) 'the chain mounts 440 (rw-inlet-owner)'
  $guardBefore = (Get-FileHash (Join-Path $dockerDir 'init-inlet-owner.sql') -Algorithm SHA256).Hash

  Write-Host '[2] disposable internal network (a documentation range) and the database'
  $sub = ''
  foreach ($s in @('203.0.113.0/24', '198.51.100.0/24', '192.0.2.0/24')) {
    $null = Dk network create --driver bridge --internal --subnet $s --label $label $net
    if ($script:rc -eq 0) { $sub = $s; break }
  }
  Check ($sub -ne '') "network $net created (bridge, internal, labelled, --subnet $sub)"
  if ($sub -eq '') { throw 'network' }
  $o = Dk run -d --name $db --label $label --network $net -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=openbrain -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
  if ($script:rc -ne 0) { Fail "postgres did not start: $o"; throw 'db' }
  for ($i = 0; $i -lt 150; $i++) {
    $logs = Dk logs $db
    if ($logs -match 'PostgreSQL init process complete') { break }
    if ((Dk inspect -f '{{.State.Running}}' $db) -ne 'true') { break }
    Start-Sleep -Seconds 2
  }
  $logs = Dk logs $db
  Save 'initdb.log' $logs
  Check ($logs -match 'PostgreSQL init process complete') 'the initdb chain ran to completion'
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "initdb logged no ERROR ($($errs.Count))"
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $null = Q "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN CREATE ROLE ob_app_memory LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE service_role; END IF; END `$`$"
  Check ((Q "SELECT count(*) FROM pg_roles WHERE rolname IN ('ob_app_memory', 'service_role')") -eq '2') 'ob_app_memory (non-superuser, service_role) - the production shape'

  Write-Host '[3] an empty store: the scan withholds nothing'
  $r = PsqlFile (Join-Path $labDir 'lab-plant.sql') @('-v', "mark=$Mark", '-v', 'phase=legacy', '-v', 'filler=0')
  Check ($r.rc -eq 0) 'planted the legacy rows (no withheld page in the store yet)'
  $fp0 = Q $fp
  $n0 = Q 'SELECT count(*) FROM public.wiki_pages'
  Check ((Q 'SELECT count(*) FROM public.inlet_owner_withheld_pages') -eq '0') 'the store of withheld text is empty (a fresh volume)'
  $r = PsqlFile (Join-Path $labDir 'rescan-withheld-text.sql') @('-v', "chunk=$Chunk")
  Save 'scan-0-empty-store.log' $r.out
  $run0 = Q "SELECT n_scanned || '/' || n_withheld || '/' || (finished_at IS NOT NULL) FROM public.inlet_owner_rescan_runs"
  Check ($r.rc -eq 0 -and $run0 -eq "$n0/0/true" -and (Q $fp) -eq $fp0) "a scan with no withheld page in the store: $n0 scanned, nothing withheld, the table unchanged ($run0)"
  NoText 'the empty-store scan' $r.out
  # (the legacy rows go and come back after 440: rows stored before the text rule, but after 440's move)
  $null = Q "DELETE FROM public.wiki_pages WHERE slug IN (SELECT slug FROM public.lab_rescan_plant); TRUNCATE public.lab_rescan_plant"

  Write-Host '[4] the live order: unowned thoughts before PD1, slot 440 with owner A, 470; then the rows stored before the text rule'
  # (the fresh chain's 470 refuses an unowned thought; the live database got 470 after 440's window - as rw-inlet-stamp's lab)
  $r = PsqlFile (Join-Path $dockerDir 'revert-inlet-stamp.sql') @()
  Check ($r.rc -eq 0) 'the fresh chain''s 470 taken off (the state before PD1)'
  $r = PsqlFile (Join-Path $labDir 'lab-plant.sql') @('-v', "mark=$Mark", '-v', 'phase=pre440')
  Check ($r.rc -eq 0) 'planted three unowned thoughts and their leaves'
  $r = PsqlFile (Join-Path $dockerDir 'init-inlet-owner.sql') @('-v', "owner_sub=$A")
  Save '440-init.log' $r.out
  $r2 = PsqlFile (Join-Path $dockerDir 'init-inlet-stamp.sql') @()
  Save '470-init.log' $r2.out
  Check ($r2.rc -eq 0) '470 applied after 440 (the live order)'
  $store = Q "SELECT count(*) || '/' || sum(n_chunks) FROM public.inlet_owner_withheld_pages"
  Check ($r.rc -eq 0 -and $store -eq '3/56') "440 (owner A): the three leaves withheld, their text kept for the rule (pages/chunks $store; 41 + 15 + 0)"
  $r = PsqlFile (Join-Path $labDir 'lab-plant.sql') @('-v', "mark=$Mark", '-v', 'phase=legacy', '-v', "filler=$Filler")
  Check ($r.rc -eq 0) "planted the legacy rows again (6 flagged, 6 controls) and $Filler filler rows"
  $rule = Q "SELECT string_agg(p.kind || ':' || p.owner || ':' || p.flagged || '=' || public.inlet_owner_text_withheld(w.body), ',' ORDER BY p.flagged DESC, p.kind, p.owner, p.slug) FROM public.lab_rescan_plant p JOIN public.wiki_pages w USING (slug)"
  $ruleOk = Q "SELECT bool_and(public.inlet_owner_text_withheld(w.body) = p.flagged) FROM public.lab_rescan_plant p JOIN public.wiki_pages w USING (slug)"
  Save 'rule-on-planted.txt' $rule
  Save 'store-shape.txt' (Q "SELECT string_agg(p.page_ref || ':' || p.n_chunks || ':' || coalesce(array_length(string_to_array(nullif(public.inlet_owner_norm(a.row_data ->> 'body'), ''), ' '), 1), 0) || ':' || (a.row_data ->> 'page_class') || ':' || left(md5(a.ref), 8), ',' ORDER BY p.page_ref) FROM public.inlet_owner_withheld_pages p JOIN public.inlet_owner_archive a ON a.id = p.page_ref")
  Save 'planted-words.txt' (Q "SELECT string_agg(p.kind || ':' || p.flagged || ':' || array_length(string_to_array(public.inlet_owner_norm(w.body), ' '), 1), ',' ORDER BY p.flagged DESC, p.kind, p.slug) FROM public.lab_rescan_plant p JOIN public.wiki_pages w USING (slug)")
  Check ($ruleOk -eq 't') "the existing rule itself answers true for exactly the 6 planted flagged rows and false for the 6 controls ($rule)"
  $fillOk = Q "SELECT count(*) FILTER (WHERE public.inlet_owner_text_withheld(body)) FROM public.wiki_pages WHERE slug NOT IN (SELECT slug FROM public.lab_rescan_plant)"
  Check ($fillOk -eq '0') "no other row is flagged by the rule ($fillOk)"
  $total = [int](Q 'SELECT count(*) FROM public.wiki_pages')
  $fpBefore = Q $fp

  Write-Host '[5] RED, before the scan: the flagged rows are presented on the shared surfaces'
  foreach ($who in @(@('service_role', $A, 'A (viewer role)'), @('service_role', $B, 'B (viewer role)'), @('ob_app_memory', $A, 'A (workbench role)'), @('ob_app_memory', $B, 'B (workbench role)'))) {
    $p = Presented $who[0] $who[1]
    Check ($p -eq '6/6|6') "RED reproduced: as $($who[2]) the 6 flagged rows are presented (row read / search | controls: $p)"
  }
  $c = PsqlFile (Join-Path $labDir 'count-withheld-text.sql') @()
  Save 'count-before.log' $c.out
  Check ($c.rc -eq 0 -and $c.out -match '\(all\)\s*\|\s*' + $total + '\s*\|\s*6\s*\|') "the read-only count: $total rows, 6 flagged"
  Check ($c.out -match '\bon\s*\|\s*3\s*\|\s*t\b') 'the count ran in a READ ONLY transaction (transaction_read_only = on)'
  NoText 'the count' $c.out
  Check ((Q $fp) -eq $fpBefore) 'the count changed nothing'
  $ro = Dk exec $db psql -U postgres -d openbrain -X -A -t -c "BEGIN READ ONLY; DELETE FROM public.wiki_pages WHERE false; ROLLBACK;"
  Check ($ro -match 'read-only transaction') "a write inside BEGIN READ ONLY is refused by the server (the count's guarantee)"

  Write-Host '[6] the scan: a clean stop, a killed backend, then continued'
  $r = PsqlFile (Join-Path $labDir 'rescan-withheld-text.sql') @('-v', "chunk=$Chunk", '-v', 'max_chunks=3')
  Save 'scan-1-stop.log' $r.out
  $s1 = Q "SELECT n_chunks || '/' || n_scanned || '/' || (finished_at IS NULL) FROM public.inlet_owner_rescan_runs WHERE reverted_at IS NULL AND finished_at IS NULL"
  Check ($r.rc -eq 0 -and $s1 -eq "3/$(3 * $Chunk)/true") "stopped after 3 chunks: the run is open with 3 chunks, $(3 * $Chunk) rows scanned ($s1)"
  NoText 'the first scan session' $r.out
  $null = Dk cp (Join-Path $labDir 'rescan-withheld-text.sql') "${db}:/tmp/rescan-kill.sql"
  $null = Dk exec -d $db sh -c "psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -v chunk=$Chunk -v pause_ms=1500 -f /tmp/rescan-kill.sql > /tmp/scan-kill.log 2>&1"
  $killedAt = ''
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $n = Q "SELECT n_chunks FROM public.inlet_owner_rescan_runs WHERE finished_at IS NULL AND reverted_at IS NULL"
    if ($n -match '^\d+$' -and [int]$n -ge 6) {
      Start-Sleep -Milliseconds 700   # inside chunk n+1's pause: its rows are archived and deleted, not committed
      $killedAt = Q "SELECT n_chunks FROM public.inlet_owner_rescan_runs WHERE finished_at IS NULL AND reverted_at IS NULL"
      $k = Q "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE '%rescan.pause_ms%'"
      break
    }
  }
  Start-Sleep -Seconds 2
  Save 'scan-2-killed.log' (Dk exec $db cat /tmp/scan-kill.log)
  $s2 = Q "SELECT n_chunks || '/' || n_scanned || '/' || (finished_at IS NULL) FROM public.inlet_owner_rescan_runs WHERE reverted_at IS NULL AND finished_at IS NULL"
  Check ($killedAt -ne '' -and $k -eq '1' -and $s2 -match '^(\d+)/(\d+)/true$' -and [int]$Matches[1] -ge 6 -and [int]$Matches[1] -lt [math]::Ceiling($total / $Chunk)) "the backend was killed mid-run: the run is still open after $s2 (chunks/scanned)"
  $orph = Q "SELECT count(*) FROM public.inlet_owner_archive a JOIN public.inlet_owner_rescan_runs r ON r.batch = a.batch WHERE r.finished_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.inlet_owner_rescan_chunks c WHERE c.batch = a.batch AND a.ref BETWEEN c.first_slug AND c.last_slug)"
  Check ($orph -eq '0') "the killed chunk left nothing behind: no archive row outside a committed chunk ($orph)"
  $r = PsqlFile (Join-Path $labDir 'rescan-withheld-text.sql') @('-v', "chunk=$Chunk")
  Save 'scan-3-continue.log' $r.out
  Check ($r.rc -eq 0 -and $r.out -match 'continuing run' -and $r.out -match 'finished \(continued\)') 'the next run continued the open run to its end'
  NoText 'the continued scan' $r.out
  $runs = Q "SELECT count(*) || '/' || count(*) FILTER (WHERE finished_at IS NOT NULL) FROM public.inlet_owner_rescan_runs WHERE reverted_at IS NULL"
  $sum = Q "SELECT r.n_scanned || '/' || (SELECT sum(n_scanned) FROM public.inlet_owner_rescan_chunks c WHERE c.batch = r.batch) || '/' || r.n_withheld FROM public.inlet_owner_rescan_runs r ORDER BY started_at DESC LIMIT 1"
  Check ($runs -eq '2/2' -and $sum -eq "$total/$total/6") "one run over the three sessions: $total rows scanned once each, 6 withheld (scanned/chunk sum/withheld $sum; runs $runs incl. the empty-store run)"
  $overlap = Q "SELECT count(*) FROM (SELECT c.last_slug, lead(c.first_slug) OVER (ORDER BY c.chunk_no) AS nxt FROM public.inlet_owner_rescan_chunks c WHERE c.batch = (SELECT batch FROM public.inlet_owner_rescan_runs ORDER BY started_at DESC LIMIT 1)) x WHERE x.nxt IS NOT NULL AND x.nxt <= x.last_slug"
  Check ($overlap -eq '0') "no double work: every chunk's range starts after the previous one ends ($overlap overlaps)"
  $arch = Q "SELECT count(*) || '/' || count(DISTINCT a.ref) || '/' || bool_and(a.ref IN $flagSlugs) FROM public.inlet_owner_archive a WHERE a.batch = (SELECT batch FROM public.inlet_owner_rescan_runs ORDER BY started_at DESC LIMIT 1)"
  Check ($arch -eq '6/6/true') "archived first, once each: 6 archive rows, 6 distinct slugs, all planted-flagged ($arch)"
  $kinds = Q "SELECT string_agg(k, ',' ORDER BY k) FROM (SELECT DISTINCT a.row_data ->> 'page_class' AS k FROM public.inlet_owner_archive a WHERE a.batch = (SELECT batch FROM public.inlet_owner_rescan_runs ORDER BY started_at DESC LIMIT 1)) x"
  Check ($kinds -eq 'entity,note,source') "each kind withheld: $kinds"
  $img = Q "SELECT count(*) FROM public.inlet_owner_archive a JOIN public.lab_rescan_plant p ON p.slug = a.ref WHERE a.batch = (SELECT batch FROM public.inlet_owner_rescan_runs ORDER BY started_at DESC LIMIT 1) AND a.action = 'w' AND a.ref_hash = md5(a.row_data ->> 'body')"
  Check ($img -eq '6') "each archive row is 440's shape (action w, ref = slug, ref_hash = md5(body), the whole row image) ($img)"
  Check ($r.out -match 'entity\s*\|\s*2\s*\|' -and $r.out -match 'note\s*\|\s*2\s*\|' -and $r.out -match 'source\s*\|\s*2\s*\|') 'the summary prints counts per class with md5 prefixes'

  Write-Host '[7] after: nothing flagged is presented; no false withhold; the guard keeps it out'
  foreach ($who in @(@('service_role', $A, 'A (viewer role)'), @('service_role', $B, 'B (viewer role)'), @('ob_app_memory', $A, 'A (workbench role)'), @('ob_app_memory', $B, 'B (workbench role)'))) {
    $p = Presented $who[0] $who[1]
    Check ($p -eq '0/0|6') "as $($who[2]) no flagged row is presented and every control is (row read / search | controls: $p)"
  }
  $left = Q "SELECT count(*) FROM public.wiki_pages w WHERE public.inlet_owner_text_withheld(w.body)"
  Check ($left -eq '0') "no wiki_pages row the rule answers true for is left ($left)"
  $now = [int](Q 'SELECT count(*) FROM public.wiki_pages')
  Check ($now -eq $total - 6) "no false withhold: $now rows remain ($total - 6), every control and filler row present"
  $ctlSame = Q "SELECT count(*) FROM public.lab_rescan_plant p JOIN public.wiki_pages w USING (slug) WHERE NOT p.flagged"
  Check ($ctlSame -eq '6') "the 6 controls (incl. the two near misses) are untouched ($ctlSame)"
  # the writer's copy of the withheld rows (a compile or a reconcile holds the text, not the archive, which no app role
  # reads): a lab table the writer's role may read
  $null = Q "CREATE TABLE public.lab_rescan_rewrite AS SELECT a.ref AS slug, a.row_data ->> 'page_class' AS page_class, a.row_data ->> 'title' AS title, a.row_data ->> 'body' AS body, p.kind, p.owner FROM public.inlet_owner_archive a JOIN public.lab_rescan_plant p ON p.slug = a.ref WHERE a.restored_at IS NULL AND a.batch = (SELECT batch FROM public.inlet_owner_rescan_runs ORDER BY started_at DESC LIMIT 1); GRANT SELECT ON public.lab_rescan_rewrite, public.lab_rescan_plant TO service_role"
  $ins = Q "SET ROLE service_role; INSERT INTO public.wiki_pages (slug, page_class, title, body) SELECT slug, page_class, title, body FROM public.lab_rescan_rewrite WHERE kind <> 'note'; SELECT (SELECT count(*) FROM public.lab_rescan_rewrite WHERE kind <> 'note') || '/' || count(*) FROM public.wiki_pages WHERE slug IN $flagSlugs"
  $ins = ($ins -split "`n")[-1].Trim()
  Check ($ins -eq '4/0') "a re-write of the 4 withheld sources/entities (a compile, a reconcile) is skipped by the unchanged guard: written/back $ins"
  $insN = Dk exec $db psql -U postgres -d openbrain -X -A -t -c "SET ROLE service_role; INSERT INTO public.wiki_pages (slug, page_class, title, body) SELECT slug, 'note', title, body FROM public.lab_rescan_rewrite WHERE kind = 'note' AND owner = 'B'"
  Check ($insN -match 'this page cannot be saved') 'a withheld note written back is refused out loud by the unchanged guard'
  $c = PsqlFile (Join-Path $labDir 'count-withheld-text.sql') @()
  Save 'count-after.log' $c.out
  Check ($c.rc -eq 0 -and $c.out -match '\(all\)\s*\|\s*' + $now + '\s*\|\s*0\s*\|') "the read-only count after: $now rows, 0 flagged"
  $fpAfter = Q $fp
  $r = PsqlFile (Join-Path $labDir 'rescan-withheld-text.sql') @('-v', "chunk=$Chunk")
  Save 'scan-4-clean-rerun.log' $r.out
  $re = Q "SELECT n_scanned || '/' || n_withheld || '/' || (finished_at IS NOT NULL) FROM public.inlet_owner_rescan_runs ORDER BY started_at DESC LIMIT 1"
  Check ($r.rc -eq 0 -and $re -eq "$now/0/true" -and (Q $fp) -eq $fpAfter) "a re-run on the clean database: a new run, $now scanned, nothing withheld, the table unchanged ($re)"
  NoText 'the clean re-run' $r.out

  Write-Host '[8] the revert: byte-identical'
  $r = PsqlFile (Join-Path $labDir 'revert-withheld-text-rescan.sql') @()
  Save 'revert-1.log' $r.out
  Check ($r.rc -eq 0 -and $r.out -match '3 run\(s\) reverted, 6 row\(s\) restored byte-identical, 0 kept') 'the revert: 3 runs reverted, 6 rows restored, 0 kept'
  NoText 'the revert' $r.out
  Check ((Q $fp) -eq $fpBefore) 'the whole wiki_pages table is byte-identical to before the scan (md5 over every row image, and the count)'
  $flags = Q "SELECT count(*) FROM public.inlet_owner_archive a JOIN public.inlet_owner_rescan_runs r ON r.batch = a.batch WHERE a.restored_at IS NULL"
  Check ($flags -eq '0') 'every rescan archive row is marked restored; 440''s own archive rows are untouched'
  $own = Q "SELECT count(*) FROM public.inlet_owner_archive a WHERE a.restored_at IS NULL AND a.action = 'w' AND a.batch NOT IN (SELECT batch FROM public.inlet_owner_rescan_runs)"
  Check ($own -eq '3') "440's three withheld leaves stay withheld ($own)"
  $r = PsqlFile (Join-Path $labDir 'revert-withheld-text-rescan.sql') @()
  Save 'revert-2.log' $r.out
  Check ($r.rc -eq 0 -and $r.out -match 'no run to revert' -and (Q $fp) -eq $fpBefore) 'a second revert has nothing to do and changes nothing'
  $r = PsqlFile (Join-Path $labDir 'rescan-withheld-text.sql') @('-v', "chunk=$Chunk")
  Save 'scan-5-after-revert.log' $r.out
  $re = Q "SELECT n_scanned || '/' || n_withheld FROM public.inlet_owner_rescan_runs ORDER BY started_at DESC LIMIT 1"
  Check ($r.rc -eq 0 -and $re -eq "$total/6") "after the revert a new scan withholds the same 6 again ($re)"
  Check ((Get-FileHash (Join-Path $dockerDir 'init-inlet-owner.sql') -Algorithm SHA256).Hash -eq $guardBefore) 'init-inlet-owner.sql (the text rule and the guard) is unchanged by the run'
} catch {
  Fail "aborted: $_"
} finally {
  Write-Host '[9] teardown'
  $null = Dk rm -f $db
  $null = Dk network rm $net
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}') + (Dk network ls --filter "label=$label" --format '{{.Name}}')
  Check ("$left".Trim() -eq '') "nothing labelled $label is left"
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
Write-Host "== done: $($script:fail) failure(s); evidence $Evidence"
if ($script:fail -eq 0) { exit 0 } else { exit 1 }
