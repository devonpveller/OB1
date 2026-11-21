# run-own-thoughts-tests.ps1 - rwr-own-thoughts-search-api round 2: the own-thoughts search over a REAL database built from the real initdb chain,
# on a disposable INTERNAL network.
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-own-thoughts-tests.ps1 -Subnet <x.y.z.0/24> [-Id <owner id>] [-Image <test image>]
#
# What it does, and ONLY this:
#   1. stages the REAL initdb chain from docker-compose.yml (every mounted init*.sql, 530 included) and, when the chain has no 480,
#      slot 480 (rw-owner-private-view round 2: ob_workbench and owner_private_subject_ok, which 530 needs) from -PrivateViewRef
#      (default origin/work/rw-owner-private-view) - plus its check script
#   2. one internal network (labelled ai-stack.harness.owner=<Id>), one throwaway pgvector database on that chain, then the production
#      shape: ob_app_memory (non-superuser, service_role member), 480 run again (the fresh-volume membership step), ob_workbench's lab password
#   3. check-own-thoughts-search.sql must say OK; a grant to PUBLIC and a grant to ob_app_memory must each be CAUGHT (and undone)
#   4. src/contracts/own_thoughts_integration_test.ts (mounted over the image's copy) in the prebuilt TEST image: planted personal and ops
#      thoughts of two users, the real route over the real seam, the workbench connecting as ob_workbench - must PASS
#   5. the mutant (the subject not enforced: the function body without its owner filter) must make the same test FAIL; the function is restored
#   6. the revert: the function is gone and the catalog (every public function's definition and ACL, but this one) is byte-identical to before
#      the revert; init again restores it exactly; a second init changes nothing
# It builds NO image (-Image must exist: build it once, `docker build --target test -t <tag> OB1\docker\workbench`) and runs no :local image. Teardown removes exactly
# what it created and checks nothing labelled <Id> is left. Never the live stack: no compose, no ai-stack_* / open-brain_* network, no host port.
param(
  [string]$Id = 'wt-rwr-own-thoughts',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Image = 'openbrain-workbench:wt-rwr-own-thoughts-test',
  [string]$PrivateViewRef = 'origin/work/rw-owner-private-view',
  [string]$Subnet = ''
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
if ($Image -match ':local$') { throw 'refusing a :local image' }
. (Join-Path $PSScriptRoot 'harness-subnet.ps1')
$w = Test-HarnessSubnet $Subnet
if ($w) { Write-Host "REFUSED: $w"; exit 2 }
$sn = Split-HarnessSubnet $Subnet
$label = "ai-stack.harness.owner=$Id"
$ct = $PSScriptRoot
$wb = Split-Path -Parent $ct
$dockerDir = Split-Path -Parent $wb
$ob1 = Split-Path -Parent $dockerDir
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rwown-net-$rand"; $db = "rwown-db-$rand"
$stage = Join-Path $env:TEMP "rwown-initdb-$rand"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$wbPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$script:fail = 0
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }
function Check([bool]$ok, [string]$m) { if ($ok) { Write-Host "  PASS  $m" } else { Write-Host "  FAIL  $m"; $script:fail++ } }
function Psql([string]$sql) { return (Dk exec $db psql -U postgres -d openbrain -X -q -A -t -v ON_ERROR_STOP=1 -c $sql) }
function PsqlFile([string]$local) {
  $null = Dk cp $local "${db}:/tmp/x.sql"
  return (Dk exec $db psql -U postgres -d openbrain -X -q -A -t -v ON_ERROR_STOP=1 -f /tmp/x.sql)
}
function Snapshot { # every public function's definition + ACL except 530's own, one hash; and the count of functions
  return (Psql "SELECT md5(coalesce(string_agg(p.oid::regprocedure::text || pg_get_functiondef(p.oid) || coalesce(p.proacl::text,''), ',' ORDER BY p.oid::regprocedure::text),'')) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.proname <> 'owner_private_thoughts_search'").Trim()
}
function FnState { return (Psql "SELECT coalesce(md5(pg_get_functiondef(to_regprocedure('public.owner_private_thoughts_search(text,text,integer)')) || coalesce((SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure('public.owner_private_thoughts_search(text,text,integer)')),'') || coalesce(obj_description(to_regprocedure('public.owner_private_thoughts_search(text,text,integer)'), 'pg_proc'),'')), 'absent')").Trim() }
function RunTest {
  return (Dk run --rm --label $label --network $net -e "OWN_DB_HOST=$db" -e "OWN_SU_PW=$pw" -e "OWN_WB_PW=$wbPw" -e "OWN_APP_PW=$appPw" `
    -v "$(Join-Path $wb 'src\contracts\own_thoughts_integration_test.ts'):/app/src/contracts/own_thoughts_integration_test.ts:ro" `
    $Image deno test --allow-all src/contracts/own_thoughts_integration_test.ts)
}
$localBefore = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim()
try {
  Write-Host '[1] the initdb chain, derived from docker-compose.yml (+ slot 480 when the chain lacks it)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check ($chain.Count -ge 30) "staged $($chain.Count) migrations"
  Check (@($chain | Where-Object { $_[1] -eq '530-init-own-thoughts-search.sql' }).Count -eq 1) 'the chain mounts 530-init-own-thoughts-search.sql'
  $has480 = @($chain | Where-Object { $_[1] -eq '480-init-owner-private-view.sql' }).Count -eq 1
  $f480 = Join-Path $stage '480-init-owner-private-view.sql'
  if (-not $has480) {
    $t = (& git -C $ob1 show "${PrivateViewRef}:docker/init-owner-private-view.sql" 2>$null) -join "`n"
    if (-not $t) { Write-Host "REFUSED: slot 480 is not in the compose chain and not in $PrivateViewRef"; exit 2 }
    [System.IO.File]::WriteAllText($f480, $t, (New-Object System.Text.UTF8Encoding $false))
  }
  $chk480 = Join-Path $env:TEMP "rwown-check480-$rand.sql"
  $t = (& git -C $ob1 show "${PrivateViewRef}:docker/check-owner-private-view.sql" 2>$null) -join "`n"
  if ($t) { [System.IO.File]::WriteAllText($chk480, $t, (New-Object System.Text.UTF8Encoding $false)) }
  Check (Test-Path $f480) '480 is in the staged chain (the live order: 440, 470, 480, then 530)'
  $null = Dk image inspect $Image
  Check ($script:rc -eq 0) "the prebuilt test image $Image exists"
  $null = Dk image inspect $PgImage
  if ($script:rc -ne 0 -or $script:fail) { throw 'preconditions' }

  Write-Host '[2] disposable internal network, the database on the real chain, the production role shape'
  $null = Dk network create --internal --subnet $sn.run --label $label $net
  Check ($script:rc -eq 0) "internal network $net ($($sn.run))"
  $null = Dk run -d --name $db --label $label --network $net -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=openbrain -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
  Check ($script:rc -eq 0) 'throwaway database started'
  $done = $false
  for ($i = 0; $i -lt 150 -and -not $done; $i++) {
    Start-Sleep -Seconds 2
    $logs = Dk logs $db
    if ($logs -match 'PostgreSQL init process complete') { $done = $true }
    if ((Dk inspect -f '{{.State.Running}}' $db) -ne 'true') { break }
  }
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check $done 'the initdb chain ran to completion (bounded wait)'
  Check ($errs.Count -eq 0) "the initdb chain logged no ERROR ($($errs.Count))"
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $null = Psql "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role member) - the production shape'
  $null = PsqlFile $f480
  $null = Psql "ALTER ROLE ob_workbench PASSWORD '$wbPw'"
  $mem = (Psql "SELECT pg_has_role('ob_workbench', 'ob_app_memory', 'MEMBER')").Trim()
  Check ($mem -eq 't') '480 run again after ob_app_memory exists: ob_workbench is its member (the live order)'
  Check ((FnState) -ne 'absent') 'owner_private_thoughts_search exists after the chain (530 ran after 480)'
  $fnGood = FnState

  Write-Host '[3] the grant check'
  $feat = Join-Path $dockerDir 'check-own-thoughts-search.sql'
  $o = PsqlFile $feat
  Check (($o -split "`n" | Where-Object { $_ -match '^check: OK' }).Count -eq 1) "check-own-thoughts-search.sql: OK ($(($o -split "`n" | Where-Object { $_ -match '^check:' }) -join ' | '))"
  $null = Psql 'GRANT EXECUTE ON FUNCTION public.owner_private_thoughts_search(text,text,integer) TO PUBLIC'
  $o = PsqlFile $feat
  Check (($o -match 'stray grant: owner_private_thoughts_search executable by PUBLIC') -and ($o -match 'check: FAIL')) 'a grant to PUBLIC is CAUGHT'
  $null = Psql 'REVOKE EXECUTE ON FUNCTION public.owner_private_thoughts_search(text,text,integer) FROM PUBLIC'
  $null = Psql 'GRANT EXECUTE ON FUNCTION public.owner_private_thoughts_search(text,text,integer) TO ob_app_memory'
  $o = PsqlFile $feat
  Check (($o -match 'stray grant: owner_private_thoughts_search executable by ob_app_memory') -and ($o -match 'check: FAIL')) 'a grant to ob_app_memory is CAUGHT'
  $null = Psql 'REVOKE EXECUTE ON FUNCTION public.owner_private_thoughts_search(text,text,integer) FROM ob_app_memory'
  $null = Psql 'GRANT EXECUTE ON FUNCTION public.owner_private_thoughts_search(text,text,integer) TO service_role'
  $o = PsqlFile $feat
  Check (($o -match 'stray grant: owner_private_thoughts_search executable by service_role') -and ($o -match 'check: FAIL')) 'a grant to service_role is CAUGHT'
  $null = Psql 'REVOKE EXECUTE ON FUNCTION public.owner_private_thoughts_search(text,text,integer) FROM service_role'
  Check ((FnState) -eq $fnGood) 'the function and its grants are back exactly as slot 530 made them'
  $null = Psql 'REVOKE EXECUTE ON FUNCTION public.owner_private_thoughts_search(text,text,integer) FROM ob_workbench'
  $o = PsqlFile $feat
  Check (($o -match 'ob_workbench cannot EXECUTE') -and ($o -match 'check: FAIL')) 'a missing grant to ob_workbench is CAUGHT'
  $null = Psql 'GRANT EXECUTE ON FUNCTION public.owner_private_thoughts_search(text,text,integer) TO ob_workbench'
  Check ((FnState) -eq $fnGood) 'restored'
  if (Test-Path $chk480) {
    $o = PsqlFile $chk480
    Check ($o -match 'check: OK') "480's own check (its nine functions, plus any owner_private_ grant stray) is OK with 530 in place"
  }

  Write-Host '[4] the behavioural test over the planted data'
  $out = RunTest
  $clean = ($out -replace '\x1b\[[0-9;]*m', '')
  Write-Host ($clean -split "`n" | Where-Object { $_ -match '\.\.\. |passed|failed|error' } | Out-String)
  Check ($script:rc -eq 0 -and $clean -match '1 passed \| 0 failed') 'integration test: 1 passed, 0 failed (not skipped)'
  Check ($clean -notmatch 'ignored') 'the test was not skipped'
  Check ($clean -notmatch 'PLANTED-') "no planted marker is in the run's output"

  Write-Host '[5] the mutant: the subject not enforced'
  $null = Psql "CREATE OR REPLACE FUNCTION public.owner_private_thoughts_search(p_sub TEXT, p_q TEXT, p_limit INT DEFAULT 25) RETURNS TABLE (thought_id BIGINT, title TEXT, snippet_src TEXT, created_at TIMESTAMPTZ) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS `$`$ SELECT th.id, left(th.content, 120), substr(th.content, 1, 600), th.created_at FROM public.thoughts th WHERE strpos(lower(th.content), lower(btrim(p_q))) > 0 LIMIT 50 `$`$"
  $out = RunTest
  $clean = ($out -replace '\x1b\[[0-9;]*m', '')
  Check ($script:rc -ne 0 -and $clean -match '1 failed' -and $clean -match 'not theirs|B saw|Values are not equal') 'the mutant (no user_id = subject) makes the integration test FAIL on the isolation assertion (not on something else)'
  Check ($clean -notmatch 'PLANTED-A-[A-Z]+-[0-9a-f]{6}.*PLANTED-B') 'still no marker pair in the output'
  $null = PsqlFile (Join-Path $dockerDir 'init-own-thoughts-search.sql')
  Check ((FnState) -eq $fnGood) 'init-own-thoughts-search.sql restores the function exactly (the mutant is gone)'
  $out = RunTest
  Check ($script:rc -eq 0 -and (($out -replace '\x1b\[[0-9;]*m', '') -match '1 passed \| 0 failed')) 'the test passes again after the restore'

  Write-Host '[6] revert and re-init'
  $before = Snapshot
  $null = PsqlFile (Join-Path $dockerDir 'revert-own-thoughts-search.sql')
  Check ((FnState) -eq 'absent') 'the revert drops the function'
  Check ((Snapshot) -eq $before) 'after the revert every other public function (definition and ACL) is byte-identical to before'
  $null = PsqlFile (Join-Path $dockerDir 'revert-own-thoughts-search.sql')
  Check ($script:rc -eq 0) 'the revert is re-runnable'
  $null = PsqlFile (Join-Path $dockerDir 'init-own-thoughts-search.sql')
  Check ((FnState) -eq $fnGood) 'init again restores the function exactly'
  $null = PsqlFile (Join-Path $dockerDir 'init-own-thoughts-search.sql')
  Check (((FnState) -eq $fnGood) -and ((Snapshot) -eq $before)) 'a second init changes nothing'
  $o = PsqlFile $feat
  Check ($o -match 'check: OK') 'the check is OK again'
  # 530 refuses without 480: drop the role dependency check by running it where owner_private_subject_ok is absent
  $null = Psql 'DROP FUNCTION public.owner_private_thoughts_search(text,text,integer)'
  $null = Psql 'ALTER FUNCTION public.owner_private_subject_ok(text) RENAME TO owner_private_subject_ok_hidden'
  $o = PsqlFile (Join-Path $dockerDir 'init-own-thoughts-search.sql')
  Check (($script:rc -ne 0) -and ($o -match 'slot 480') -and ((FnState) -eq 'absent')) '530 is refused (nothing changed) without 480'
  $null = Psql 'ALTER FUNCTION public.owner_private_subject_ok_hidden(text) RENAME TO owner_private_subject_ok'
  $null = PsqlFile (Join-Path $dockerDir 'init-own-thoughts-search.sql')
  Check ((FnState) -eq $fnGood) 'restored after the refusal test'
} finally {
  $null = Dk rm -f -v $db; $null = Dk network rm $net
  Remove-Item -Recurse -Force $stage, $chk480 -ErrorAction SilentlyContinue
  $left = (Dk ps -a -q --filter "label=$label" | Out-String).Trim()
  $nets = (Dk network ls -q --filter "label=$label" | Out-String).Trim()
  Check (-not $left -and -not $nets) 'nothing labelled for this run is left (containers, networks)'
  $lb = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim()
  if ($lb -ne $localBefore) { Write-Host '  NOTE  a :local image tag moved during the run (another agent; this runner builds nothing)' }
}
if ($script:fail) { Write-Host "FAILED: $script:fail"; exit 1 }
Write-Host 'ALL PASS'
exit 0
