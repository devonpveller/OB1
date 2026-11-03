# run-filed-e2e.ps1 - rw-curator-filed's disposable test run (clauses 3 and 4 against real Postgres).
#
#   powershell -NoProfile -File OB1/integrations/kubernetes-deployment/run-filed-e2e.ps1 [-Id <owner id>] [-Evidence <dir>]
#
# What it does, and ONLY this:
#   1. stages the REAL initdb chain from OB1/docker/docker-compose.yml (280-init-research-filed.sql included)
#   2. creates ONE internal bridge network (--internal, subnet pinned outside 192.168.0.0/16); every
#      container and the network are labelled ai-stack.harness.owner=<Id>
#   3. builds the kubernetes-deployment image as openbrain-mcp-test:wt-<id> (NEVER :local; the build
#      runs deno check) and runs research-filed.e2e.test.ts in it: the REAL index.ts persist route
#      against the database and a stub embeddings endpoint, all inside the test container
#   4. migration drill by psql: pre-check, apply twice (idempotent), revert, re-apply
#   rw-report-isolation adds [4c] report-isolation.e2e.test.ts (the real curator + the real persist: an idea job's
#   report is private, every other one shared) and [4d] the slot-390 drill (seed the base's shapes, move, move again,
#   revert twice, move again; counts and hashes only). -Red runs ONLY [4c] and [4d] against -ServiceRoot /
#   -CuratorRoot / -ChainRoot (copies of the pre-change base): both must FAIL there.
#   5. tears down exactly what it created and verifies nothing labelled <Id> is left, no volume of ours
#      is left and no :local image changed
# It never touches the live stack: no compose up/down, no ai-stack_* / open-brain_* network, no host
# port, no live database. Exit code 0 = every check passed.
param(
  [string]$Id = 'wt-rw-curator-filed',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Evidence = '',
  [string]$Subnet = '',
  [string]$SubnetBase = '10.244',
  # RED evidence only: build the server from another kubernetes-deployment directory (a copy of the
  # pre-change base); the test file and the initdb chain still come from this tree.
  [string]$ServiceRoot = '',
  # rw-report-isolation RED: the curator directory and the OB1 tree whose docker/ chain is staged (the base's);
  # the new test file still comes from this tree
  [string]$CuratorRoot = '',
  [string]$ChainRoot = '',
  # round 2: the research service directory whose viewer.ts RI6 imports (RED: the base's)
  [string]$ResearchRoot = '',
  # -Red: how many [4c] cases must fail on the base (round 3's base 30408c6 already passes every case: 0)
  [int]$RedE2EFailures = 2,
  [switch]$Red
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$label = "ai-stack.harness.owner=$Id"
$rs = if ($ServiceRoot) { (Resolve-Path $ServiceRoot).Path } else { $PSScriptRoot }
$ob1 = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dockerDir = Join-Path $ob1 'docker'
$chainDocker = if ($ChainRoot) { Join-Path (Resolve-Path $ChainRoot).Path 'docker' } else { $dockerDir }
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rwcf-net-$rand"
$db = "rwcf-db-$rand"
$short = ($Id -replace '^wt-', '')
$testTag = "openbrain-mcp-test:wt-$short"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "rwcf-evidence-$rand" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "rwcf-initdb-$rand"

$script:fail = 0
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }
function Save([string]$name, [string]$text) {
  [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false))
}
function Summary([string]$text) {
  return ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed(?: \| (\d+) ignored)?').Match(($text -replace '\x1b\[[0-9;]*m', ''))
}
function Test-SubnetAllowed([string]$s) {
  if ($s -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/(\d{1,2})$') { return $false }
  $o = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4]); $len = [int]$Matches[5]
  if (@($o | Where-Object { $_ -gt 255 }).Count -gt 0) { return $false }
  if ($len -ne 24) { return $false }
  if ($o[0] -eq 192 -and $o[1] -eq 168) { return $false }
  if ($o[0] -eq 10 -and $o[1] -eq 234 -and $o[2] -eq 77) { return $false }
  return $true
}
function New-PinnedNetwork([string]$name) {
  if ($SubnetBase -notmatch '^(\d{1,3})\.(\d{1,3})$' -or $SubnetBase -match '^192\.168$') { Fail "refusing -SubnetBase '$SubnetBase'"; return '' }
  $cands = if ($Subnet) { @($Subnet) } else { @(1..8 | ForEach-Object { "$SubnetBase.$(Get-Random -Minimum 1 -Maximum 255).0/24" }) }
  foreach ($s in $cands) {
    if (-not (Test-SubnetAllowed $s)) { Fail "refusing subnet '$s'"; return '' }
    $null = Dk network create --driver bridge --internal --subnet $s --label $label $name
    if ($script:rc -eq 0) { return $s }
  }
  return ''
}
function Get-Chain {
  $cf = Join-Path $chainDocker 'docker-compose.yml'
  $compose = (@(Get-Content $cf) | ForEach-Object { $_ -replace '(^|\s)#.*$', '' }) -join "`n"
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  return , @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
}
if ($testTag -match ':local$') { throw 'refusing a :local tag' }

Write-Host "== rw-curator-filed disposable run  owner=$Id  net=$net  evidence=$Evidence"
$null = Dk version --format '{{.Server.Version}}'
if ($script:rc -ne 0) { Write-Host 'docker is not reachable'; exit 2 }
function LocalSnapshot { (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim() -split "`r?`n" | Sort-Object }
$localBefore = LocalSnapshot
$made = @{ net = $false; containers = @(); images = @() }

try {
  Write-Host '[1] the initdb chain, derived from docker-compose.yml'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = Get-Chain
  foreach ($m in $chain) { Copy-Item (Join-Path $chainDocker $m[0]) (Join-Path $stage $m[1]) }
  if (-not $Red) { Check (@($chain | Where-Object { $_[1] -eq '390-init-report-isolation.sql' }).Count -eq 1) 'the chain mounts 390-init-report-isolation.sql (rw-report-isolation)' }
  Check ($chain.Count -ge 30) "staged $($chain.Count) migrations"
  Check (@($chain | Where-Object { $_[1] -eq '280-init-research-filed.sql' }).Count -eq 1) 'the chain mounts 280-init-research-filed.sql'
  $null = Dk image inspect $PgImage
  if ($script:rc -ne 0) { Fail "$PgImage is not on the host"; throw 'pg image' }

  Write-Host '[2] disposable internal network'
  $sub = New-PinnedNetwork $net
  Check ($sub -ne '') "network $net created (bridge, internal, labelled, --subnet $sub)"
  if ($sub -eq '') { throw 'network' }
  $made.net = $true

  Write-Host "[3] build $testTag (the build runs deno check)"
  $o = Dk build --no-cache --progress=plain --label $label -t $testTag $rs
  Save 'research-test-build.log' $o
  Check ($script:rc -eq 0) "image $testTag built"
  if ($script:rc -eq 0) { $made.images += $testTag } else { throw 'build' }

  Write-Host '[4] the database + research-filed.e2e.test.ts'
  $o = Dk run -d --name $db --label $label --network $net -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=openbrain `
    -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
  if ($script:rc -ne 0) { Fail "postgres did not start: $o"; throw 'db' }
  $made.containers += $db
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
  Check ($logs -match '280-init-research-filed\.sql') 'initdb ran 280-init-research-filed.sql'
  for ($i = 0; $i -lt 60; $i++) {
    $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain
    if ($script:rc -eq 0) { break }
    Start-Sleep -Seconds 2
  }
  if (-not $Red) {
  $testFile = Join-Path $PSScriptRoot 'research-filed.e2e.test.ts'
  $o = Dk run --rm --label $label --network $net -e "RF_E2E_DB_HOST=$db" -e "RF_E2E_DB_PASSWORD=$pw" -e NO_COLOR=1 `
    -v "${testFile}:/app/research-filed.e2e.test.ts:ro" -w /app `
    $testTag deno test --unstable-net --allow-net --allow-env --allow-read --allow-run research-filed.e2e.test.ts
  Save 'filed-e2e.log' $o
  $sum = Summary $o
  Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[3].Value -eq '0' -and [int]$sum.Groups[2].Value -ge 4) "filed e2e: $($sum.Value)"
  $curDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'research-curator'
  $o = Dk run --rm --label $label --network $net -e "RESEND_E2E_DB_HOST=$db" -e "RESEND_E2E_DB_PASSWORD=$pw" -e NO_COLOR=1 `
    -v "${curDir}:/curator:ro" -w /curator `
    $testTag deno test --no-lock --unstable-net --allow-net --allow-env --allow-read --allow-run resend.e2e.test.ts
  Save 'resend-e2e.log' $o
  $sum = Summary $o
  Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[3].Value -eq '0' -and [int]$sum.Groups[2].Value -ge 5) "resend e2e (real curator + real persist, always-new resolver): $($sum.Value)"
  $o = Dk exec $db psql -U postgres -d openbrain -X -A -F '|' -c "SELECT j.status, e.type, e.payload->>'research_key', (SELECT count(*) FROM sources s WHERE s.content_type='research_synthesis' AND s.research_key = e.payload->>'research_key') AS syntheses FROM research_job_events e JOIN research_jobs j ON j.id=e.job_id WHERE e.type='filed' ORDER BY e.id"
  Save 'events-after.txt' $o
  }

  # ---------------------------------------------------------------- rw-report-isolation
  Write-Host '[4c] report-isolation.e2e.test.ts (the real curator + the real persist; an idea job''s report is private)'
  $curRoot = if ($CuratorRoot) { (Resolve-Path $CuratorRoot).Path } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'research-curator' }
  $riTest = Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'research-curator') 'report-isolation.e2e.test.ts'
  # RED: the base's curator copy has no test file - copy this tree's into it (a file mount inside a read-only dir mount fails)
  if ($CuratorRoot) { Copy-Item -Force $riTest (Join-Path $curRoot 'report-isolation.e2e.test.ts') }
  $resRoot = if ($ResearchRoot) { (Resolve-Path $ResearchRoot).Path } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'research-service' }
  $o = Dk run --rm --label $label --network $net -e "RI_E2E_DB_HOST=$db" -e "RI_E2E_DB_PASSWORD=$pw" -e NO_COLOR=1 `
    -v "${curRoot}:/curator:ro" -v "${resRoot}:/research:ro" -w /curator `
    $testTag deno test --no-lock --unstable-net --allow-net --allow-env --allow-read --allow-run report-isolation.e2e.test.ts
  Save 'report-isolation-e2e.log' (($o -split "`n" | ForEach-Object { if ($_.Length -gt 400) { $_.Substring(0, 400) } else { $_ } } | Select-Object -Last 200) -join "`n")
  foreach ($l in ($o -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)' }) { Write-Host "    $l" }
  $sum = Summary $o
  if ($Red) { Check ($sum.Success -and [int]$sum.Groups[3].Value -ge $RedE2EFailures) "RED: report isolation e2e on the base - at least $RedE2EFailures failing ($($sum.Value))" }
  else { Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[3].Value -eq '0' -and [int]$sum.Groups[2].Value -ge 6) "report isolation e2e: $($sum.Value)" }

  Write-Host '[4d] slot-390 drill: seed the base''s shapes, move, move again, revert, revert again, move again'
  $seed = Join-Path $PSScriptRoot 'report-isolation-drill-seed.sql'; $chk = Join-Path $PSScriptRoot 'report-isolation-drill-check.sql'
  $null = Dk cp $seed "${db}:/tmp/ri-seed.sql"; $null = Dk cp $chk "${db}:/tmp/ri-check.sql"
  function RiState { $s = Dk exec $db psql -U postgres -d openbrain -X -q -f /tmp/ri-check.sql; return (($s -split "`n") | ForEach-Object { ($_ -replace '^.*NOTICE:\s+DRILL\s+', '').Trim() } | Where-Object { $_ -match '=' }) -join ' ' }
  function RiGet([string]$st, [string]$k) { $m = [regex]::Match($st, "(^| )$([regex]::Escape($k))=(\S+)"); if ($m.Success) { $m.Groups[2].Value } else { '' } }
  $drill = @()
  $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -f /tmp/ri-seed.sql
  Check ($script:rc -eq 0) "drill: the base's shapes seeded$(if ($script:rc) { ': ' + $o })"
  $before = RiState; $drill += "seeded: $before"
  if ($Red) {
    Check ((RiGet $before 'shared_idea') -eq '2') "RED: on the base the idea-job syntheses are still shared sources (shared_idea=$(RiGet $before 'shared_idea'))"
    # a base that HAS a slot 390 (round 3's base 30408c6): run it - it must leave the reports' text in the threads
    $b390 = Join-Path $chainDocker 'init-report-isolation.sql'
    if (Test-Path $b390) {
      $null = Dk cp $b390 "${db}:/tmp/ri-base-init.sql"
      $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -f /tmp/ri-base-init.sql
      $bst = RiState; $drill += "[the base's 390] exit $($script:rc)`n    state: $bst"
      Check ((RiGet $bst 'shared_idea') -eq '0' -and (RiGet $bst 'thread_report_text') -ne '0') "RED: the base's 390 moves the syntheses but leaves their text in the threads (thread_report_text=$(RiGet $bst 'thread_report_text'), notebook_report_text=$(RiGet $bst 'notebook_report_text'))"
    }
  } else {
    $f390 = Join-Path $dockerDir 'init-report-isolation.sql'; $r390 = Join-Path $dockerDir 'revert-report-isolation.sql'
    $null = Dk cp $f390 "${db}:/tmp/ri-init.sql"; $null = Dk cp $r390 "${db}:/tmp/ri-revert.sql"
    $snap0 = RiGet $before 'snapshot'
    $steps = @(@('init', '/tmp/ri-init.sql'), @('probe', ''), @('init again', '/tmp/ri-init.sql'), @('revert', '/tmp/ri-revert.sql'), @('revert again', '/tmp/ri-revert.sql'), @('mutant', ''), @('init after revert', '/tmp/ri-init.sql'))
    $states = @{}
    function Sql1([string]$q) { $r = Dk exec $db psql -U postgres -d openbrain -X -tA -c $q; return @{ rc = $script:rc; out = ($r -replace "`r", '').Trim() } }
    $s1 = (Sql1 "SELECT id FROM public._ri_drill WHERE name = 's1'").out
    foreach ($s in $steps) {
      if ($s[0] -eq 'probe') {
        # round 2 (tester F2): the guard on the write path the viewer's reconcile and the compile use - the leaf and
        # a page citing it are skipped, a NOTE citing it is refused out loud, a clean page goes in
        $p1 = Sql1 "INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ('content/source/$s1', 'source', 'Drill idea report one', 'DrillReportOne leaf') ON CONFLICT (slug) DO UPDATE SET body = EXCLUDED.body"
        $p2 = Sql1 "INSERT INTO public.wiki_pages (slug, page_class, title, body, links) VALUES ('content/tool/drill-recompiled', 'entity', 'Drill Tool', 'cites [[content/source/$s1|x]]', '[]'::jsonb)"
        $p3 = Sql1 "INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ('notes/drill-note', 'note', 'a note', 'my note cites [[content/source/$s1]]')"
        $p4 = Sql1 "INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ('content/tool/drill-clean', 'entity', 'Drill Tool', 'a clean regenerated page')"
        $n = (Sql1 "SELECT count(*) FROM public.wiki_pages WHERE slug IN ('content/source/$s1', 'content/tool/drill-recompiled', 'notes/drill-note')").out
        $clean = (Sql1 "SELECT count(*) FROM public.wiki_pages WHERE slug = 'content/tool/drill-clean'").out
        $null = Sql1 "DELETE FROM public.wiki_pages WHERE slug = 'content/tool/drill-clean'"
        $drill += "[probe] leaf rc=$($p1.rc) citing rc=$($p2.rc) note rc=$($p3.rc) ($($p3.out -replace "`n", ' ')) clean rc=$($p4.rc); written back: $n; clean page in: $clean"
        Check ($p1.rc -eq 0 -and $p2.rc -eq 0 -and $n -eq '0') "drill: after init the guard skips the moved report's leaf and a page citing it on the reconcile / compile write path (written back: $n)"
        Check ($p3.rc -ne 0 -and $p3.out -match 'private research report') 'drill: a note citing a moved report is refused out loud (42501)'
        Check ($p4.rc -eq 0 -and $clean -eq '1') 'drill: a clean regenerated page is let back in'
        continue
      }
      if ($s[0] -eq 'mutant') {
        # round 2 (the tester's composite CASCADE grandchild): a row hanging off a chunk the move would cascade, through
        # a TWO-column foreign key - the move must refuse with nothing moved
        $m1 = Sql1 "CREATE TABLE public._ri_mutant (source_id uuid, idx int, FOREIGN KEY (source_id, idx) REFERENCES public.source_chunks (source_id, idx) ON DELETE CASCADE); INSERT INTO public._ri_mutant VALUES ('$s1', 0)"
        $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -f /tmp/ri-init.sql
        $mrc = $script:rc
        $mst = RiState
        $left = (Sql1 "SELECT count(*) FROM public._ri_mutant").out
        $null = Sql1 "DROP TABLE public._ri_mutant"
        $drill += "[mutant] create rc=$($m1.rc); init exit $mrc :: $((($o -split "`n") | Where-Object { $_ -match 'ERROR' }) -join ' ')`n    state: $mst; mutant rows left: $left"
        Check ($m1.rc -eq 0 -and $mrc -ne 0 -and $o -match 'hang off' -and (RiGet $mst 'shared_idea') -eq '2' -and (RiGet $mst 'snapshot') -eq $snap0 -and $left -eq '1') 'drill: a composite-key row hanging off a cascaded chunk stops the move - nothing moved, nothing lost'
        continue
      }
      $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -f $s[1]
      $rc = $script:rc
      $note = (($o -split "`n") | Where-Object { $_ -match 'rw-report-isolation|ERROR' } | ForEach-Object { ($_ -replace '^.*NOTICE:\s+', '').Trim() }) -join ' ; '
      $st = RiState
      $states[$s[0]] = $st
      $drill += "[$($s[0])] exit $rc :: $note`n    state: $st"
      Check ($rc -eq 0) "drill: $($s[0]) runs cleanly"
      if ($s[0] -like 'init*') { $states["$($s[0])-note"] = $note } else { $states["$($s[0])-note"] = $note }
    }
    $mv = $states['init']
    Check ($states['init-note'] -match 'moved 6 idea-job syntheses' -and $states['init-note'] -match 'non-idea job: 1\)') "drill: init moves the 6 idea-job syntheses and leaves the 1 a non-idea job also filed shared ($($states['init-note']))"
    Check ((RiGet $mv 'shared_idea') -eq '0' -and (RiGet $mv 'deps_idea') -eq '0' -and (RiGet $mv 'claims_on_idea_reports') -eq '0') "drill: after init no idea-job synthesis, dependent or claim pointer is left in the shared tables ($mv)"
    Check ((RiGet $mv 'shared_other') -eq '3' -and (RiGet $mv 'deps_other') -eq (RiGet $before 'deps_other')) 'drill: the non-idea and the conflicted synthesis (and their dependents) are untouched'
    Check ((RiGet $mv 'claims_present') -eq '3' -and (RiGet $mv 'claim_edge_c1') -eq '1') 'drill: the claims stay (shared), with their source edges'
    Check ((RiGet $mv 'private') -eq '2' -and (RiGet $mv 'private_owned') -eq '2' -and (RiGet $mv 'private_s1_job') -eq 'j1' -and (RiGet $mv 'private_s2_job') -eq 'j2' -and (RiGet $mv 'private_text') -eq '2' -and (RiGet $mv 'private_links') -eq '2') 'drill: two private copies, owned by the idea''s owner, on their jobs, with their text and their claims linked'
    Check ((RiGet $mv 'dossier_i1') -eq 'null') 'drill: the idea''s dossier pointer no longer names a shared row'
    Check ((RiGet $before 'wiki_report_pages') -eq '2' -and (RiGet $mv 'wiki_report_pages') -eq '0' -and (RiGet $mv 'guard') -eq '1') 'drill: the moved report''s leaf and the entity page citing it are withheld, the guard is on'
    Check ((RiGet $mv 'entity_ts') -ne (RiGet $before 'entity_ts')) 'drill: the cited entity is bumped (its page recompiles from what is still shared)'
    # round 3 (tester attempt 2 finding A): the threads the reports named or described
    Check ((RiGet $before 'thread_report_text') -eq '7' -and (RiGet $before 'notebook_report_text') -eq '3' -and [int](RiGet $before 'wiki_report_text') -ge 2) "drill: seeded - a thread named and described from s1, an existing thread re-described from s2, a source labelled with the minted name, their wiki pages ($(RiGet $before 'thread_report_text') / $(RiGet $before 'notebook_report_text') / $(RiGet $before 'wiki_report_text'))"
    Check ((RiGet $mv 'thread_report_text') -eq '0' -and (RiGet $mv 'notebook_report_text') -eq '0' -and (RiGet $mv 'wiki_report_text') -eq '0' -and (RiGet $mv 'thread_embeddings') -eq '0') "drill: after init no thread name, description, slug or embedding, no notebook label and no wiki page carries a moved report's text"
    Check ((RiGet $mv 'tnew_desc') -eq 'Shared_sources:_drill_web' -and (RiGet $mv 'te_name') -eq 'Drill_thread' -and $states['init-note'] -match '7 thread\(s\) re-described \(5 minted from a report\)') "drill: the minted thread is re-described from its remaining shared source only ($(RiGet $mv 'tnew_desc')); 7 threads (one reached only through a thread link), 5 minted (a 'new', an 'explicit' resend, a recovered answer, a re-run job's 'explicit' resend tC, and tC mid-requeue tD); the old thread keeps its name ($(RiGet $mv 'te_name'))"

    Check ([int](RiGet $mv 'archive_open') -ge 7 -and (RiGet $mv 'archive_app_read') -eq 'no') "drill: every moved row archived first ($(RiGet $mv 'archive_open') rows), the archive unreadable by service_role"
    Check ($states['init again-note'] -match 'moved 0 idea-job syntheses' -and (RiGet $states['init again'] 'private') -eq '2' -and (RiGet $states['init again'] 'archive_open') -eq (RiGet $mv 'archive_open')) 'drill: a second init moves nothing and changes nothing'
    $rv = $states['revert']
    Check ($states['revert-note'] -match '1 batch\(es\) restored') "drill: revert restores the batch ($($states['revert-note']))"
    Check ((RiGet $rv 'snapshot') -eq $snap0 -and (RiGet $rv 'shared_idea') -eq '2' -and (RiGet $rv 'deps_idea') -eq (RiGet $before 'deps_idea')) "drill: after revert the rows, their dependents and the claim pointers are byte-identical to before (snapshot $(RiGet $rv 'snapshot') vs $snap0)"
    Check ((RiGet $rv 'dossier_i1') -eq 's1' -and (RiGet $rv 'private') -eq '0' -and (RiGet $rv 'fn') -eq '0' -and (RiGet $rv 'guard') -eq '0' -and (RiGet $rv 'archive_open') -eq '0') 'drill: the dossier pointer is back, the private copies, the rule and the guard are gone, the archive is marked restored'
    Check ((RiGet $rv 'wiki_report_pages') -eq '2' -and (RiGet $rv 'entity_ts') -eq (RiGet $before 'entity_ts')) 'drill: the withheld pages are back, the entity''s updated_at too (the snapshot covers the whole claim, idea, entity and page rows)'
    Check ((RiGet $rv 'thread_report_text') -eq '7' -and (RiGet $rv 'notebook_report_text') -eq '3') 'drill: the revert gives the threads (whole rows, in the snapshot) and the notebook label back'
    Check ($states['revert again-note'] -match '0 batch\(es\) restored' -and (RiGet $states['revert again'] 'snapshot') -eq $snap0) 'drill: a second revert restores nothing and changes nothing'
    $ag = $states['init after revert']
    Check ($states['init after revert-note'] -match 'moved 6 idea-job syntheses' -and (RiGet $ag 'shared_idea') -eq '0' -and (RiGet $ag 'private') -eq '2' -and (RiGet $ag 'fn') -eq '1') 'drill: init after the revert moves them again'
  }
  Save 'report-isolation-drill.txt' ($drill -join "`n")
  foreach ($l in $drill) { Write-Host "    $l" }

  if (-not $Red) {
  Write-Host '[4b] migration drill: pre-check, apply twice, revert, re-apply'
  $f = Join-Path $dockerDir 'init-research-filed.sql'; $r = Join-Path $dockerDir 'revert-research-filed.sql'
  $null = Dk cp $f "${db}:/tmp/apply.sql"; $null = Dk cp $r "${db}:/tmp/revert.sql"
  $pre = Dk exec $db psql -U postgres -d openbrain -X -A -t -c "SELECT count(*) FROM pg_constraint WHERE conname IN ('research_job_events_filed','research_job_events_type_check')"
  Check ($pre.Trim() -eq '2') "pre-check: both constraints present after the chain ($($pre.Trim()))"
  $o1 = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -f /tmp/apply.sql
  Check ($script:rc -eq 0) 'apply is idempotent (second run)'
  $o2 = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -f /tmp/revert.sql
  Check ($script:rc -eq 0) 'revert runs'
  $o3 = Dk exec $db psql -U postgres -d openbrain -X -A -t -c "INSERT INTO research_job_events (job_id, root_job_id, type, kind, payload) SELECT id, id, 'filed', 'due_process', '{}'::jsonb FROM research_jobs LIMIT 1"
  Check ($o3 -match 'violates check constraint') "after revert a 'filed' event is refused"
  $o4 = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -f /tmp/apply.sql
  Check ($script:rc -eq 0) 're-apply after revert runs'
  Save 'migration-drill.txt' ("== apply#2`n$o1`n== revert`n$o2`n== insert after revert`n$o3`n== re-apply`n$o4")
  }
}
finally {
  Write-Host '[5] teardown'
  $ourVolumes = @()
  foreach ($c in $made.containers) {
    $mounts = Dk inspect -f '{{range .Mounts}}{{.Type}}={{.Name}} {{end}}' $c
    if ($script:rc -eq 0) {
      $ourVolumes += @(($mounts -split '\s+') | Where-Object { $_ -match '^volume=[A-Za-z0-9][A-Za-z0-9_.-]+$' } | ForEach-Object { $_.Substring(7) })
    }
    $null = Dk rm -f -v $c
  }
  if ($made.net) { $null = Dk network rm $net }
  foreach ($i in $made.images) { $null = Dk rmi -f $i }
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  $left = @((Dk ps -a --filter "label=$label" --format '{{.Names}}') -split "`n" | Where-Object { $_ })
  Check ($left.Count -eq 0) "no container labelled $label is left ($($left.Count))"
  $leftNet = @((Dk network ls --filter "label=$label" --format '{{.Name}}') -split "`n" | Where-Object { $_ })
  Check ($leftNet.Count -eq 0) "no network labelled $label is left ($($leftNet.Count))"
  $volLeft = @($ourVolumes | Where-Object { $null = Dk volume inspect $_; $script:rc -eq 0 })
  Check ($volLeft.Count -eq 0) "no volume of ours is left ($($ourVolumes.Count) recorded, $($volLeft.Count) left)"
  $localAfter = LocalSnapshot
  Check (-not (Compare-Object $localBefore $localAfter)) 'no :local image changed'
  Write-Host "== $(if ($script:fail) { "FAILED ($script:fail)" } else { 'ALL PASSED' })  evidence: $Evidence"
}
exit $script:fail
