# run-withheld-text-rescan-lab.ps1 - rw-withheld-text-rescan's disposable lab: the stored wiki rows that already carry
# withheld text are withheld by rescan-withheld-text.sql, with 440's text rule unchanged; resumable; revert byte-identical.
#
#   powershell -NoProfile -File OB1\docker\withheld-text-rescan\run-withheld-text-rescan-lab.ps1 [-Id <owner id>]
#       [-Evidence <dir>] [-Filler 2400] [-Chunk 100] [-BigWords 8000,16000,32000] [-StorePages 23000] [-StoreChunks 100] [-ScanSql <a scan file>]
#   (-ScanSql: run the same checks against another scan file, e.g. round 1's, to see which checks it fails)
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
#   7. round 2 (R1): a stale open run is never continued - (a) an interrupted scan, then 440's revert ALONE, 440
#      re-applied, a scan; (b) an interrupted scan, then 440 run again adding withheld text that flags a row behind the
#      cursor, a scan; (c) the guard's state changes while a scan runs. Each FAILS if any rule-true row is presented
#      afterwards; the finish notice must count the run's archive rows still unrestored
#   8. round 2 (N3): long planted bodies (-BigWords): the rule's time per row, and the row-lock hold per chunk at the
#      default chunk, with a writer probing the long rows all through the scan (it must never wait)
#   after EVERY scan that finishes (N1): count-withheld-text.sql, which must read rows_flagged = 0
#   9. tears down exactly what it created and verifies nothing labelled <Id> is left
# Exit code 0 = every check passed.
param(
  [string]$Id = 'wt-rw-withheld-text-rescan',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Evidence = '',
  [int]$Filler = 2400,
  [int]$Chunk = 100,
  [string]$BigWords = '8000,16000,32000',
  [int]$StorePages = 23000,
  [int]$StoreChunks = 100,
  [string]$ScanSql = ''
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$label = "ai-stack.harness.owner=$Id"
$labDir = $PSScriptRoot
$dockerDir = Split-Path -Parent $labDir
if ($BigWords -notmatch '^[0-9]+(,[0-9]+)*$') { throw "bad -BigWords '$BigWords'" }
$scanFile = if ($ScanSql) { (Resolve-Path $ScanSql).Path } else { Join-Path $labDir 'rescan-withheld-text.sql' }
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
function Qq([string]$sql) { $r = Dk exec $db psql -U postgres -d openbrain -X -A -t -q -c $sql; return "$r".Trim() }
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
# N1: the procedure's last step after every scan that finished - the read-only count must read rows_flagged = 0
function CountAfter([string]$name, $scan) {
  if ($scan.out -notmatch 'run [0-9a-f]{8} finished') { return }
  $c = PsqlFile (Join-Path $labDir 'count-withheld-text.sql') @()
  Save "$name-count.log" $c.out
  Check ($c.rc -eq 0 -and $c.out -match '\(all\)\s*\|\s*\d+\s*\|\s*0\s*\|' -and $c.out -notmatch '\|\s*[1-9]\d*\s*\|\s*[0-9a-f]{12}') "N1 after the scan ($name): count-withheld-text.sql reads rows_flagged = 0 in every row"
  NoText "the count after $name" $c.out
}
function Scan([string]$name, [string[]]$vars) {
  $r = PsqlFile $scanFile $vars
  Save "$name.log" $r.out
  CountAfter $name $r
  return $r
}
# the finish notice's withheld count, and the run's archive rows still unrestored
function FinishWithheld([string]$out) { if ($out -match 'finished[^:]*: \d+ chunk\(s\), \d+ row\(s\) scanned, (\d+) withheld') { return $Matches[1] } return '' }
function RunUnrestored() { return Q "SELECT count(*) FROM public.inlet_owner_archive a WHERE a.action = 'w' AND a.restored_at IS NULL AND a.batch = (SELECT batch FROM public.inlet_owner_rescan_runs ORDER BY started_at DESC LIMIT 1)" }
function RuleTrue() { return Q "SELECT count(*) FROM public.wiki_pages w WHERE public.inlet_owner_text_withheld(w.body)" }
$people = @(@('service_role', $A, 'A (viewer role)'), @('service_role', $B, 'B (viewer role)'), @('ob_app_memory', $A, 'A (workbench role)'), @('ob_app_memory', $B, 'B (workbench role)'))
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
  $r = Scan 'scan-0-empty-store' @('-v', "chunk=$Chunk")
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
  $r = Scan 'scan-1-stop' @('-v', "chunk=$Chunk", '-v', 'max_chunks=3')
  $s1 = Q "SELECT n_chunks || '/' || n_scanned || '/' || (finished_at IS NULL) FROM public.inlet_owner_rescan_runs WHERE reverted_at IS NULL AND finished_at IS NULL"
  Check ($r.rc -eq 0 -and $s1 -eq "3/$(3 * $Chunk)/true") "stopped after 3 chunks: the run is open with 3 chunks, $(3 * $Chunk) rows scanned ($s1)"
  NoText 'the first scan session' $r.out
  $null = Dk cp $scanFile "${db}:/tmp/rescan-kill.sql"
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
  $r = Scan 'scan-3-continue' @('-v', "chunk=$Chunk")
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
  $r = Scan 'scan-4-clean-rerun' @('-v', "chunk=$Chunk")
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
  $r = Scan 'scan-5-after-revert' @('-v', "chunk=$Chunk")
  $re = Q "SELECT n_scanned || '/' || n_withheld FROM public.inlet_owner_rescan_runs ORDER BY started_at DESC LIMIT 1"
  Check ($r.rc -eq 0 -and $re -eq "$total/6") "after the revert a new scan withholds the same 6 again ($re)"
  # -- round 2 ---------------------------------------------------------------------------------------------------------
  $half = [int][math]::Floor([math]::Ceiling($total / $Chunk) / 2)
  $openRun = "FROM public.inlet_owner_rescan_runs r WHERE r.finished_at IS NULL AND r.reverted_at IS NULL ORDER BY r.started_at DESC LIMIT 1"
  $storeQ = "SELECT count(*) || '/' || coalesce(sum(n_chunks), 0) FROM public.inlet_owner_withheld_pages"

  Write-Host '[9] R1 case (a): an interrupted scan, then 440''s revert ALONE, 440 re-applied, a scan'
  $r = PsqlFile (Join-Path $labDir 'revert-withheld-text-rescan.sql') @()
  Save 'revert-a0.log' $r.out
  Check ($r.rc -eq 0 -and (Q $fp) -eq $fpBefore) 'set-up: the rescan reverted, the 6 flagged rows back (the table as before the first scan)'
  $r = Scan 'scan-a1-interrupted' @('-v', "chunk=$Chunk", '-v', "max_chunks=$half")
  $a1 = Q "SELECT r.n_chunks || '/' || (SELECT count(*) FROM public.inlet_owner_archive a WHERE a.batch = r.batch AND a.restored_at IS NULL) $openRun"
  Check ($r.rc -eq 0 -and $a1 -match "^$half/[1-5]$") "interrupted after $half chunks, some flagged rows behind its cursor already withheld (chunks/withheld $a1)"
  NoText 'the interrupted scan (a)' $r.out
  $r = PsqlFile (Join-Path $dockerDir 'revert-inlet-stamp.sql') @()
  Check ($r.rc -eq 0) '470 reverted first (the slot order above 440)'
  $r = PsqlFile (Join-Path $dockerDir 'revert-inlet-owner.sql') @()
  Save '440-revert-a.log' $r.out
  $back = Q "SELECT count(*) FROM public.wiki_pages WHERE slug IN $flagSlugs"
  $runA = Q "SELECT (SELECT count(*) FILTER (WHERE a.restored_at IS NOT NULL) || '/' || count(*) FROM public.inlet_owner_archive a WHERE a.batch = r.batch) $openRun"
  Check ($r.rc -eq 0 -and $back -eq '6' -and $runA -match '^([1-5])/\1$') "440's revert ALONE put the open run's withheld rows back and left the run open (flagged rows stored $back; the open run's archive rows restored/all $runA)"
  $r = PsqlFile (Join-Path $dockerDir 'init-inlet-owner.sql') @('-v', "owner_sub=$A")
  Save '440-reapply-a.log' $r.out
  $r2 = PsqlFile (Join-Path $dockerDir 'init-inlet-stamp.sql') @()
  $st = Q $storeQ
  Check ($r.rc -eq 0 -and $r2.rc -eq 0 -and $st -eq '3/56') "440 re-applied (owner A), then 470: the store rebuilt ($st)"
  $rt = RuleTrue
  $p = Presented 'service_role' $B
  Check ($rt -eq '6' -and $p -eq '6/6|6') "RED before the scan: the 6 rule-true rows are stored and presented to B again (rule-true $rt; presented $p)"
  $r = Scan 'scan-a2-after-440-revert' @('-v', "chunk=$Chunk")
  Check ($r.rc -eq 0 -and $r.out -notmatch 'continuing run' -and $r.out -match 'open run [0-9a-f]{8} closed, not continued' -and $r.out -match 'new run' -and $r.out -match 'finished') 'the scan did NOT continue the stale run: it closed it and ran a fresh full run to its end'
  Check ($r.out -match '[1-5] of its [1-5] archive row\(s\) restored since it began') 'the reason it printed: the run''s archive rows were restored (counts only)'
  NoText 'the scan after 440''s revert (a)' $r.out
  $rt = RuleTrue
  Check ($rt -eq '0') "(a) after the scan no wiki_pages row the rule answers true for is left ($rt)"
  foreach ($who in $people) {
    $p = Presented $who[0] $who[1]
    Check ($p -eq '0/0|6') "(a) as $($who[2]) no flagged row is presented and every control is ($p)"
  }
  $fw = FinishWithheld $r.out; $ur = RunUnrestored
  Check ($fw -eq '6' -and $ur -eq '6') "(a) the finish notice counts the run's archive rows still unrestored (notice $fw, archive $ur)"
  $ab = Q "SELECT count(*) || '/' || count(*) FILTER (WHERE abandoned_why LIKE '%restored since it began%') FROM public.inlet_owner_rescan_runs WHERE abandoned_at IS NOT NULL AND finished_at IS NULL AND reverted_at IS NULL"
  Check ($ab -eq '1/1') "(a) the stale run is closed (abandoned_at, its reason recorded), not finished ($ab)"

  Write-Host '[10] R1 case (b): an interrupted scan, then 440 run again adding withheld text, a scan'
  $r = PsqlFile (Join-Path $dockerDir 'revert-inlet-stamp.sql') @()
  Check ($r.rc -eq 0) '470 taken off (so an unowned thought can be written)'
  $r = PsqlFile (Join-Path $labDir 'lab-plant.sql') @('-v', "mark=$Mark", '-v', 'phase=late')
  Check ($r.rc -eq 0) 'planted a fourth unowned thought and its leaf, and a row stored before the text rule carrying its text at an early slug'
  $lateSel = "(SELECT slug FROM public.lab_rescan_plant WHERE slug LIKE 'content/concept/0-late-%')"
  Check ((Q "SELECT public.inlet_owner_text_withheld(body) FROM public.wiki_pages WHERE slug = $lateSel") -eq 'f') 'before 440 runs again the rule answers false for that row'
  $r = Scan 'scan-b1-interrupted' @('-v', "chunk=$Chunk", '-v', "max_chunks=$half")
  $b1 = Q "SELECT (r.cursor_slug > $lateSel) || '/' || r.n_chunks || '/' || r.n_withheld $openRun"
  Check ($r.rc -eq 0 -and $b1 -eq "true/$half/0") "interrupted after $half chunks with that row behind its cursor (behind/chunks/withheld $b1)"
  NoText 'the interrupted scan (b)' $r.out
  $st0 = Q $storeQ
  $r = PsqlFile (Join-Path $dockerDir 'init-inlet-owner.sql') @('-v', "owner_sub=$A")
  Save '440-rerun-b.log' $r.out
  $st1 = Q $storeQ
  $r2 = PsqlFile (Join-Path $dockerDir 'init-inlet-stamp.sql') @()
  Check ($r.rc -eq 0 -and $r2.rc -eq 0 -and $st0 -eq '3/56' -and $st1 -eq '4/97') "440 run again (owner A, a new batch): the new leaf withheld, the store grew ($st0 -> $st1); 470 back"
  $rt = RuleTrue
  $p = Presented 'service_role' $B
  Check ($rt -eq '1' -and $p -eq '1/0|6') "RED before the scan: the row behind the cursor now answers true and is presented to B (rule-true $rt; presented $p)"
  $r = Scan 'scan-b2-after-440-rerun' @('-v', "chunk=$Chunk")
  Check ($r.rc -eq 0 -and $r.out -notmatch 'continuing run' -and $r.out -match 'open run [0-9a-f]{8} closed, not continued' -and $r.out -match 'the guard''s state changed' -and $r.out -match 'finished') 'the scan did NOT continue the run whose guard state changed: closed it, ran a fresh full run to its end'
  NoText 'the scan after 440 ran again (b)' $r.out
  $rt = RuleTrue
  Check ($rt -eq '0' -and (Q "SELECT count(*) FROM public.wiki_pages WHERE slug = $lateSel") -eq '0') "(b) after the scan no row the rule answers true for is left, the late row included ($rt)"
  foreach ($who in $people) {
    $p = Presented $who[0] $who[1]
    Check ($p -eq '0/0|6') "(b) as $($who[2]) no flagged row is presented and every control is ($p)"
  }
  $fw = FinishWithheld $r.out; $ur = RunUnrestored
  Check ($fw -eq '1' -and $ur -eq '1') "(b) the finish notice counts the run's archive rows still unrestored (notice $fw, archive $ur)"

  Write-Host '[11] R1 case (c): the guard''s state changes while a scan runs'
  $null = Dk cp $scanFile "${db}:/tmp/rescan-c.sql"
  $null = Dk exec -d $db sh -c "psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -v chunk=$Chunk -v pause_ms=1500 -f /tmp/rescan-c.sql > /tmp/scan-c.log 2>&1; echo rc=`$? >> /tmp/scan-c.log"
  $seen = ''
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $seen = Q "SELECT r.n_chunks $openRun"
    if ($seen -match '^\d+$' -and [int]$seen -ge 2) { break }
  }
  # what 440 run again does to the store, by hand (a page no text matches): the count changes
  $null = Q "INSERT INTO public.inlet_owner_withheld_pages (page_ref, n_chunks, whole_hash) VALUES (-1, 0, md5('lab-no-such-text-$rand'))"
  $cl = ''
  for ($i = 0; $i -lt 120; $i++) { Start-Sleep -Milliseconds 500; $cl = Dk exec $db cat /tmp/scan-c.log; if ($cl -match 'rc=\d+') { break } }
  Save 'scan-c1-guard-changed-mid-run.log' $cl
  $c1 = Q "SELECT count(*) FROM public.inlet_owner_rescan_runs WHERE abandoned_at IS NOT NULL AND finished_at IS NULL AND abandoned_why LIKE '%state changed%' AND started_at = (SELECT max(started_at) FROM public.inlet_owner_rescan_runs)"
  Check ($cl -match 'refused - run [0-9a-f]{8} closed after \d+ chunk' -and $cl -match 'rc=3' -and $cl -notmatch 'finished' -and $c1 -eq '1') "a guard change under a running scan (after $seen chunks): the run is closed and the scan refuses, not finished"
  NoText 'the refused scan (c)' $cl
  $null = Q 'DELETE FROM public.inlet_owner_withheld_pages WHERE page_ref = -1'
  $r = Scan 'scan-c2-after-refusal' @('-v', "chunk=$Chunk")
  Check ($r.rc -eq 0 -and $r.out -notmatch 'continuing run' -and $r.out -match 'new run' -and $r.out -match 'finished' -and (RuleTrue) -eq '0') 'run again: a fresh full run (nothing left open to continue) to its end; nothing rule-true left'

  Write-Host "[12] N3: long bodies ($BigWords words) - the rule's time per row; the row-lock hold per chunk at the default chunk, with a writer probing the long rows all through"
  $r = PsqlFile (Join-Path $labDir 'lab-plant.sql') @('-v', "mark=$Mark", '-v', 'phase=big', '-v', "bigwords=$BigWords")
  Check ($r.rc -eq 0) 'planted the long bodies (one ordinary source per size, one flagged source as long as the longest)'
  $r = PsqlFile (Join-Path $labDir 'lab-plant.sql') @('-v', "mark=$Mark", '-v', 'phase=store', '-v', "storepages=$StorePages", '-v', "storechunks=$StoreChunks")
  $null = Q 'ANALYZE public.inlet_owner_withheld_pages; ANALYZE public.inlet_owner_withheld_chunks'
  $stN = Q $storeQ
  Check ($r.rc -eq 0) "the guard's store grown to the live scale with text no page carries (pages/chunks $stN)"
  $timing = Qq "CREATE FUNCTION pg_temp.rule_ms(b TEXT) RETURNS TEXT LANGUAGE plpgsql AS `$f`$ DECLARE t0 TIMESTAMPTZ := clock_timestamp(); v BOOLEAN; BEGIN v := public.inlet_owner_text_withheld(b); RETURN v || ' in ' || round(extract(epoch FROM clock_timestamp() - t0) * 1000) || ' ms'; END `$f`$; SELECT string_agg(length(w.body) || ' chars (' || array_length(string_to_array(w.body, ' '), 1) || ' words): rule ' || pg_temp.rule_ms(w.body), '; ' ORDER BY p.flagged, length(w.body)) FROM public.lab_rescan_plant p JOIN public.wiki_pages w USING (slug) WHERE p.kind = 'big'"
  Write-Host "  INFO  the rule per long row: $timing"
  $null = Dk cp $scanFile "${db}:/tmp/rescan-n3.sql"
  $null = Dk exec -d $db sh -c "psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -f /tmp/rescan-n3.sql > /tmp/scan-n3.log 2>&1; echo rc=`$? >> /tmp/scan-n3.log"
  # a writer' row lock on the long ordinary rows (what a compile UPDATE of them takes first), waiting at most 1 s
  $probeSql = "SET lock_timeout = '1s'; DO `$p`$ DECLARE t0 TIMESTAMPTZ := clock_timestamp(); n INT; BEGIN SELECT count(*) INTO n FROM (SELECT 1 FROM public.wiki_pages WHERE slug IN (SELECT slug FROM public.lab_rescan_plant WHERE kind = 'big' AND NOT flagged) FOR UPDATE) x; RAISE NOTICE 'probe_ms=%', round(extract(epoch FROM clock_timestamp() - t0) * 1000); EXCEPTION WHEN lock_not_available THEN RAISE NOTICE 'probe_timeout'; END `$p`$"
  $probes = New-Object System.Collections.Generic.List[int]; $timeouts = 0; $nl = ''
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalMinutes -lt 20) {
    $o = Dk exec $db psql -U postgres -d openbrain -X -A -t -q -c $probeSql
    if ($o -match 'probe_ms=(\d+)') { $probes.Add([int]$Matches[1]) } elseif ($o -match 'probe_timeout') { $timeouts++ }
    $nl = Dk exec $db cat /tmp/scan-n3.log
    if ($nl -match 'rc=\d+') { break }
    Start-Sleep -Milliseconds 100
  }
  Save 'scan-n3-default-chunk.log' $nl
  $scanSec = [math]::Round($sw.Elapsed.TotalSeconds)
  Check ($nl -match 'rc=0' -and $nl -match 'run [0-9a-f]{8} finished') "the scan at the default chunk finished ($scanSec s)"
  NoText 'the long-body scan' $nl
  CountAfter 'scan-n3-default-chunk' @{ out = $nl }
  $mx = Q "SELECT max(c.n_scanned) || '/' || max(c.rule_ms) || '/' || max(c.lock_ms) || '/' || count(*) FILTER (WHERE c.n_withheld > 0) FROM public.inlet_owner_rescan_chunks c WHERE c.batch = (SELECT batch FROM public.inlet_owner_rescan_runs ORDER BY started_at DESC LIMIT 1)"
  $bigChunk = Q "SELECT c.rule_ms || '/' || c.lock_ms || '/' || c.n_withheld FROM public.inlet_owner_rescan_chunks c WHERE c.batch = (SELECT batch FROM public.inlet_owner_rescan_runs ORDER BY started_at DESC LIMIT 1) AND (SELECT min(slug) FROM public.lab_rescan_plant WHERE kind = 'big') BETWEEN c.first_slug AND c.last_slug"
  $pmax = if ($probes.Count) { ($probes | Measure-Object -Maximum).Maximum } else { -1 }
  $meas = "default chunk rows/max rule ms/max lock ms/chunks that withheld: $mx; the long rows' chunk rule ms/lock ms/withheld: $bigChunk; writer probes $($probes.Count), longest $pmax ms, lock timeouts $timeouts; rule per long row: $timing"
  Save 'n3-measured.txt' $meas
  Write-Host "  INFO  $meas"
  $parts = $mx -split '/'
  Check ($parts.Count -eq 4 -and $parts[0] -eq '100') "the default chunk is 100 rows ($($parts[0]))"
  Check ($parts.Count -eq 4 -and $parts[2] -match '^\d+$' -and [int]$parts[2] -le 1000) "no chunk held row locks for more than 1 s (longest $($parts[2]) ms, while the long rows' chunk ran the rule for $(($bigChunk -split '/')[0]) ms)"
  Check ($probes.Count -ge 3 -and $timeouts -eq 0 -and $pmax -lt 1000) "a writer updating the long ordinary rows all through the scan never waited on it ($($probes.Count) probes, longest $pmax ms, $timeouts lock timeouts)"
  Check ((RuleTrue) -eq '0' -and (Q "SELECT count(*) FROM public.wiki_pages WHERE slug IN (SELECT slug FROM public.lab_rescan_plant WHERE kind = 'big' AND flagged)") -eq '0') 'the long flagged source is withheld; nothing rule-true left'

  Check ((Get-FileHash (Join-Path $dockerDir 'init-inlet-owner.sql') -Algorithm SHA256).Hash -eq $guardBefore) 'init-inlet-owner.sql (the text rule and the guard) is unchanged by the run'
} catch {
  Fail "aborted: $_"
} finally {
  Write-Host '[13] teardown'
  $null = Dk rm -f $db
  $null = Dk network rm $net
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}') + (Dk network ls --filter "label=$label" --format '{{.Name}}')
  Check ("$left".Trim() -eq '') "nothing labelled $label is left"
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
Write-Host "== done: $($script:fail) failure(s); evidence $Evidence"
if ($script:fail -eq 0) { exit 0 } else { exit 1 }
