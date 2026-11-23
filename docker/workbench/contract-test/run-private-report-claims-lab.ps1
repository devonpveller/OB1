# run-private-report-claims-lab.ps1 - rw-private-report-claims (slot 570) in a DISPOSABLE lab.
#
#   powershell -NoProfile -File OB1/docker/workbench/contract-test/run-private-report-claims-lab.ps1 -Id wt-rw-private-report-claims -Subnet 10.247.57.0/24 [-Evidence <empty dir>]
#
# What it does, and ONLY this (every docker call through the shim below: the run's --internal network on the pinned
# /25, :wt-<id> tags, the ai-stack.harness.owner label, no published port, no :local image, no compose):
#   [1] stages the REAL initdb chain from OB1/docker/docker-compose.yml (570 included) and starts it
#   [2] builds the workbench (its build test gate) and its test stage as :wt-<id> tags
#   [3] starts PostgREST + the openbrain-rest Caddy, a stub embedder and TWO workbenches: identity header (users A and
#       B, the lane, a service key) and Authentik forward-auth (A, B and the admin C, signed in by a lab signer)
#   [4] reverts the chain's 570 (back to the 390 model: the link's foreign key, no guards) and plants
#       (src/inlet/private_report_claims_integration_test.ts, phase plant), then hashes every table 570 touches
#   [5] RED: before 570 the [leak] and [db] cases FAIL and the check script says FAIL
#   [6] 570 twice (the second has nothing to move), revert twice (the second has nothing to restore): byte-identical
#       to [4]'s hashes; 570 again; the check script says OK
#   [7] GREEN: every case passes (a new filing the curator's way included)
#   [8] the last revert puts the post-570 filing back in the shared table (the 390 model) and the key back on
# Round 2 (tester attempt 1): no 570 re-run after ob_app_memory is created - the chain's own 570 must already reach the
# role (a real login executes the owner read); a live apply without the role is refused; the plant must LAND before
# any red gate counts (a missing plant is a FAIL, never a vacuous red); the gap work (P1), the wiki variants (P3) and the
# P2 count (count-private-report-claim-reuse.sql, before and after 570 - an operator decision, not a pass/fail gate).
# Exit 0 = every check passed. Counts, route names and pass/fail only - never a claim's text. Never the live stack.
# Round 3 (slots 450 + 480 landed; the base of this layer is OB1 58bbc30): the REST door is the one the stack runs -
# rest-door-lab.ps1's Start-LabRestDoor (lab secret, the real mint script, never the live .env). The workbenches reach the
# database directly and send NO REST token, as compose has them (DB_USER=ob_workbench, slot 480's login - attempt 5: the lab
# ran them as ob_app_memory before); the only HTTP reach is [guard] PostgREST's rpc,
# now called through the door with no token (401) and with EACH minted caller's own token (every door role: refused, no
# claim text). 480 is in the chain, so ob_workbench is the chain's own role (ob-workbench-role.ps1, as the sibling labs) and
# [9] re-runs the tree's init-owner-private-view.sql, not a branch of another item. No superuser / service_role shortcut.
# Fix item rw-private-report-claims-fix (2026-11-22): the plant adds the P2 shapes (a shared synthesis restating B's claim,
# one restating B's and A's, B's and A's shared questions whose reports restated B's claim, a separate control synthesis),
# a human steer typing one of B's claims (F2); the cases tagged [fix] are A1 / F2 / P2. -OldSql <an earlier
# init-private-report-claims.sql> is the fix's RED: after [4] it applies THAT file instead of the tree's, runs the
# migrated phase and requires every [fix] case to FAIL, then stops (no revert / green: the lab is thrown away).
# Round 2 (tester attempt 1): the note A1 rule, the tied thread, the duplicate shared claim and the copy's question are
# [fix2] cases; -OldSql <999107d's init file> -OldTag fix2 requires every [fix2] case to fail on the round-1 fix.
# Round 3 (tester attempt 2): the thread's slug / hub page / notebook labels / curator answers, the entity bump and a
# claim left by a superseded synthesis are [fix3] cases (-OldSql <63c92c2's init file> -OldTag fix3).
param(
  [string]$Id = 'wt-rw-private-report-claims',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
  [string]$CaddyImage = 'caddy:2-alpine',
  [switch]$KeepImages,
  [string]$OldSql = '',
  [string]$OldTag = 'fix',
  # -Prebuilt: use openbrain-workbench:wt-<id> and its -test tag already built under this run's tags (plain docker build,
  # no timeout, when Docker Desktop stalls the lab's 40-minute build); removed at the end unless -KeepImages
  [switch]$Prebuilt
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
. (Join-Path $PSScriptRoot 'harness-subnet.ps1')
$w = Test-HarnessSubnet $Subnet
if ($w) { Write-Host "REFUSED: $w"; exit 2 }
$subnets = Split-HarnessSubnet $Subnet
if ($Evidence -and (Test-Path $Evidence) -and @(Get-ChildItem -Force $Evidence).Count) { Write-Host "REFUSED: -Evidence $Evidence is not empty"; exit 2 }

$label = "ai-stack.harness.owner=$Id"
$ct = $PSScriptRoot
$wb = Split-Path -Parent $ct
$dockerDir = Split-Path -Parent $wb
$ob1 = Split-Path -Parent $dockerDir
$short = ($Id -replace '^wt-', '')
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$P = "rwprc-$rand"
$net = "$P-net"
$db = "$P-db"
$wbTag = "openbrain-workbench:wt-$short"; $wbTestTag = "openbrain-workbench:wt-$short-test"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$wbPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$key = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$door = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$svcKey = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$faSecret = -join ((48..57 + 97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
$rr = -join ((97..122) | Get-Random -Count 10 | ForEach-Object { [char]$_ })
$subA = "prc-ay-$rr"; $subB = "prc-bee-$rr"; $subC = "prc-admin-$rr"
$faIssuer = 'https://authentik.lab.invalid/application/o/prc/'; $faClient = "prc-client-$rr"
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$script:fail = 0
$script:made = @{ net = $false; containers = @(); images = @(); dirs = @() }
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false)) }

# -- the lab docker shim (run-workspace-tests.ps1's rules) --------------------------------------------------------
function Test-LabDockerArgs([string[]]$a) {
  $all = ($a -join ' ')
  if ($a.Count -and $a[0] -eq 'compose') { return 'docker compose is never used by the lab' }
  if ($all -match '192\.168\.') { return 'a 192.168.x address' }
  if ($all -match '(^|[\s=:/])(ai-stack_|open-brain_)') { return 'an ai-stack_* / open-brain_* name' }
  for ($i = 0; $i -lt $a.Count; $i++) {
    $x = $a[$i]
    if ($x -match '^(-p|-P|--publish|--publish-all)$' -or $x -match '^--publish(-all)?=' -or $x -match '^-p\d') { return "a published port ($x)" }
    if ($x -match '^--net(work)?$') { $v = $a[$i + 1]; if ($v -ne $net -and $v -ne 'none') { return "network '$v' is not this run's" } }
    if ($x -match '^--net(work)?=(.+)$') { if ($Matches[2] -ne $net -and $Matches[2] -ne 'none') { return "network '$($Matches[2])' is not this run's" } }
    if ($x -match '(^|[/=])[^ ]*:local$' -and $a[0] -notin @('images', 'image')) { return "a :local image ($x)" }
  }
  if ($all -match 'macvlan|ipvlan') { return 'a macvlan / ipvlan driver' }
  if ($a.Count -ge 2 -and $a[0] -eq 'network' -and $a[1] -eq 'create') {
    if ($a -notcontains '--internal') { return 'a network that is not --internal' }
    if (($a -join ' ') -notmatch [regex]::Escape("--subnet $($subnets.run)")) { return 'a network not on the pinned subnet' }
  }
  if ($a.Count -and $a[0] -eq 'build') {
    for ($i = 0; $i -lt $a.Count; $i++) {
      if ($a[$i] -eq '-t' -and $a[$i + 1] -notmatch ":wt-$([regex]::Escape($short))(-[a-z0-9]+)?$") { return "a build tag that is not :wt-$short ($($a[$i + 1]))" }
    }
  }
  return ''
}
function Lab-Docker([int]$TimeoutSec, [string[]]$a) {
  $why = Test-LabDockerArgs $a
  if ($why) { Write-Host "  SHIM REFUSED: $why"; $script:rc = 2; $script:fail++; return "REFUSED: $why" }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'docker'
  $psi.Arguments = ($a | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { try { $p.Kill() } catch { }; $script:rc = 124; return "TIMEOUT after ${TimeoutSec}s" }
  $p.WaitForExit()
  $script:rc = $p.ExitCode
  return (($out.Result + $err.Result) -replace "`r", '').TrimEnd()
}
function Dk { Lab-Docker 300 ([string[]]$args) }
function DkLong { Lab-Docker 2400 ([string[]]$args) }
function Run-Detached([string]$name, [string[]]$extra) {
  $o = Dk run -d --name $name --label $label --network $net @extra
  if ($script:rc -ne 0) { Fail "$name did not start: $o"; return $false }
  $script:made.containers += $name
  return $true
}
function Q([string]$q) { return ((Dk exec $db psql -U postgres -d openbrain -X -A -t -q -c $q) | Out-String).Trim() }
function Psql-File([string]$path, [string]$tag) {
  $null = Dk cp $path "${db}:/tmp/prc.sql"
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/prc.sql
  $rc = $script:rc
  $msg = (($o -split "`n") | Where-Object { $_ -match 'NOTICE|WARNING|ERROR' } | ForEach-Object { $_ -replace '^.*?(NOTICE|WARNING|ERROR):\s*', '$1 ' }) -join ' | '
  Write-Host "    [$tag] exit ${rc}: $msg"
  $script:log += "[$tag] exit ${rc}: $msg"
  return @{ rc = $rc; msg = $msg }
}
function Check-Script {
  $null = Dk cp (Join-Path $dockerDir 'check-private-report-claims.sql') "${db}:/tmp/prccheck.sql"
  return ((Dk exec $db psql -U postgres -d openbrain -X -A -t -q -f /tmp/prccheck.sql) | Out-String).Trim()
}
# every table slot 570 touches, hashed (the revert's byte-identical bar); the link's foreign key's definition too
$hashQ = @"
SELECT string_agg(t || '=' || h, ' ' ORDER BY t) FROM (
  SELECT 'claims' AS t, md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) AS h FROM public.claims x
  UNION ALL SELECT 'claim_sources', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.claim_sources x
  UNION ALL SELECT 'links', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.report_id, x.claim_id), '')) FROM public.research_private_report_claims x
  UNION ALL SELECT 'jobs', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.research_jobs x
  UNION ALL SELECT 'wiki_pages', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.slug), '')) FROM public.wiki_pages x
  UNION ALL SELECT 'corroborations', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.source_corroborations x
  UNION ALL SELECT 'private_claims', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.inlet_private_claims x
  UNION ALL SELECT 'steers', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.research_steers x
  UNION ALL SELECT 'events', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.research_job_events x
  UNION ALL SELECT 'private_edges', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.claim_id, x.edge_ref, x.batch), '')) FROM public.inlet_private_claim_sources x
  UNION ALL SELECT 'sources', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.sources x
  UNION ALL SELECT 'private_reports', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.research_private_reports x
  UNION ALL SELECT 'threads', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.threads x
  UNION ALL SELECT 'entities', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.entities x
  UNION ALL SELECT 'thread_sources', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.thread_id, x.source_id), '')) FROM public.thread_sources x
  UNION ALL SELECT 'source_chunks', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.source_id, x.idx), '')) FROM public.source_chunks x
  UNION ALL SELECT 'link_fk', md5(coalesce((SELECT string_agg(conname || ' ' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint
                                           WHERE conrelid = 'public.research_private_report_claims'::regclass AND contype = 'f'), ''))
) s
"@
$hashQ = ($hashQ -split "`r?`n") -join ' '
function Invoke-Test([string]$phase) {
  $a = @('run', '--rm', '--label', $label, '--network', $net,
    '-e', "PRC_PHASE=$phase", '-e', "PRC_WB=http://$P-wb:8000", '-e', "PRC_WB_FA=http://$P-wbfa:8000",
    '-e', "PRC_KEY=$key", '-e', "PRC_DOOR=$door", '-e', "PRC_SVC_KEY=$svcKey",
    '-e', "PRC_FA_ISSUER=$faIssuer", '-e', "PRC_FA_CLIENT=$faClient", '-e', "PRC_FA_SECRET=$faSecret",
    '-e', "PRC_A=$subA", '-e', "PRC_B=$subB", '-e', "PRC_C=$subC",
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    '-e', "PRC_APP_PASSWORD=$appPw", '-e', "PRC_WB_PASSWORD=$wbPw", '-e', "PRC_PGRST=http://$P-rest/rest/v1", '-e', "PRC_REST_TOKENS=$restTokens",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', 'src/inlet/private_report_claims_integration_test.ts')
  $o = Lab-Docker 900 $a
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save "test-$phase.log" ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED|ignored)|^(ok|FAILED) \||error:|AssertionError|Values are not equal|carries a|=>' } | Select-Object -First 400) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)' }) { Write-Host "    $l" }
  return @{ out = $clean; m = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean) }
}
function Case-Results([string]$out) {
  $r = @{}
  foreach ($l in ($out -split "`n")) { $mm = [regex]::Match($l, '^(\[[^\]]+\] .+?) \.\.\. (ok|FAILED)'); if ($mm.Success) { $r[$mm.Groups[1].Value.Trim()] = $mm.Groups[2].Value } }
  return $r
}

$script:log = @()
try {
  Write-Host "== rw-private-report-claims lab  owner=$Id  net=$net  evidence=$Evidence"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  # ---------------------------------------------------------------- [1] the chain
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check (@($chain | Where-Object { $_[1] -eq '570-init-private-report-claims.sql' }).Count -eq 1) "the chain mounts 570-init-private-report-claims.sql ($($chain.Count) migrations)"
  $null = Dk network create --driver bridge --internal --subnet $subnets.run --label $label $net
  Check ($script:rc -eq 0) "network $net (internal, $($subnets.run))"
  if ($script:rc -ne 0) { throw 'network' }
  $script:made.net = $true
  # ---------------------------------------------------------------- [2] images
  Write-Host '[2] images'
  if ($Prebuilt) {
    foreach ($t in @($wbTag, $wbTestTag)) {
      $null = Dk image inspect $t
      Check ($script:rc -eq 0) "prebuilt image $t is present"
      if ($script:rc -ne 0) { throw "prebuilt $t" }
      $script:made.images += $t
    }
  } else {
  $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" -t $wbTag $wb; Save 'build-workbench.log' ($o -split "`n" | Select-Object -Last 60 | Out-String)
  Check ($script:rc -eq 0) "$wbTag built (its test gate passed)"
  if ($script:rc -ne 0) { throw 'build workbench' }
  $script:made.images += $wbTag
  $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --target test -t $wbTestTag $wb; Save 'build-workbench-test.log' ($o -split "`n" | Select-Object -Last 40 | Out-String)
  Check ($script:rc -eq 0) "$wbTestTag (the test stage) built"
  if ($script:rc -ne 0) { throw 'build test' }
  $script:made.images += $wbTestTag
  }
  # ---------------------------------------------------------------- [3] the lab
  Write-Host '[3] the lab'
  if (-not (Run-Detached $db @('--network-alias', 'openbrain-db', '-e', "POSTGRES_PASSWORD=$pw", '-e', 'POSTGRES_DB=openbrain', '-v', "${stage}:/docker-entrypoint-initdb.d:ro", $PgImage))) { throw 'db' }
  for ($i = 0; $i -lt 150; $i++) { if ((Dk logs $db) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $logs = Dk logs $db
  Check ($logs -match 'PostgreSQL init process complete') 'the database ran the initdb chain'
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "initdb logged no ERROR ($($errs.Count))"
  if ($errs.Count) { Save 'initdb-errors.log' ($errs -join "`n") }
  Check ($logs -match 'private report claims: nothing to move') 'on a fresh volume slot 570 has nothing to move'
  # round 2 (tester F2): a LIVE apply (the server listens) without the services' role is refused loudly, nothing changed
  $r0 = Psql-File (Join-Path $dockerDir 'init-private-report-claims.sql') '570 live, before ob_app_memory exists'
  Check ($r0.rc -ne 0 -and $r0.msg -match 'ob_app_memory does not exist') "a live 570 without ob_app_memory is refused (exit $($r0.rc))"
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role) - the production shape'
  # slot 480 is in the chain (it landed with 58bbc30): ob_workbench exists already, without the membership (ob_app_memory did not
  # exist at initdb). Use-ObWorkbenchRole (as the sibling labs) runs 480 again now, sets the lab password and checks the membership.
  . (Join-Path $PSScriptRoot 'ob-workbench-role.ps1'); $wbDb = Use-ObWorkbenchRole $appPw
  if ($wbDb.role -eq 'ob_workbench') { $wbPw = $wbDb.pw }
  Check ($wbDb.role -eq 'ob_workbench') 'ob_workbench is the chain''s slot 480 role (a member of ob_app_memory)'
  if ($wbDb.role -ne 'ob_workbench') { throw 'ob_workbench' } # the workbenches log in as it below, as compose runs them
  # round 2 (tester F2): the role is created AFTER the chain's 570 (the house labs and a fresh volume), and 570 is NOT
  # re-run: its grant must reach the role anyway (the workbench's owner read, as the real login)
  $o = Dk exec -e "PGPASSWORD=$appPw" $db psql -h 127.0.0.1 -U ob_app_memory -d openbrain -X -A -t -q -c "SELECT count(*) FROM public.private_report_claims_of_idea(gen_random_uuid(), 'prc-nobody')"
  Check ($script:rc -eq 0 -and "$o".Trim() -eq '0') "the ob_app_memory login executes the chain's private_report_claims_of_idea with no 570 re-run ($("$o".Trim()))"
  $c00 = Check-Script; Save 'check-fresh.log' $c00
  Check ($c00 -match "ob_app_memory may execute the slot's functions=3 of 3" -and $c00 -match 'check: OK') 'the check script on the fresh chain: the grant reaches ob_app_memory, OK'
  $ctMount = "${ct}:/ct:ro"
  $null = Run-Detached "$P-embed" @('--network-alias', 'stub-embed', '-v', $ctMount, '--entrypoint', 'deno', $wbTag, 'run', '--allow-net', '/ct/stub-embed.ts')
  # rw-rest-door-auth (slot 450): the door as compose stands it up - PostgREST as the authenticator with the JWT secret, no
  # anonymous role, behind the real Caddyfile - and a lab token per caller from the real mint script (lab secret)
  . (Join-Path $PSScriptRoot 'rest-door-lab.ps1')
  $restDoor = Start-LabRestDoor -Db $db -Pw $pw
  Check ($restDoor.Door -eq 'auth' -and $restDoor.Tokens.Count -ge 1) "the REST door is the authenticated one (slot 450); lab tokens minted for $($restDoor.Tokens.Count) caller(s): $((@($restDoor.Tokens.Keys) | Sort-Object) -join ',')"
  if ($restDoor.Door -ne 'auth') { throw 'rest door' }
  $restTokens = (@($restDoor.Tokens.Keys | Sort-Object | ForEach-Object { "$_=$($restDoor.Tokens[$_])" })) -join ','
  $common = @('-e', 'PORT=8000', '-e', "WORKBENCH_KEY=$key", '-e', "DB_HOST=$db", '-e', "DB_USER=$($wbDb.role)", '-e', "DB_PASSWORD=$($wbDb.pw)",
      '-e', 'OPEN_BRAIN_URL=http://openbrain-rest', '-e', 'EMBEDDING_API_BASE=http://stub-embed:8080/v1', '-e', 'EXTRACT_URL=http://unreachable.invalid',
      '-e', 'WIKI_GIT_DIR=/wiki', '-e', 'WIKI_ASSETS_DIR=/wiki/assets', '-e', 'CONTRACT_MOUNTS_ROOT=/mounts', '-e', 'RESEARCH_URL=http://unreachable.invalid',
      '-e', "WORKSPACE_SERVICE_KEYS=prc-test=$svcKey", '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro")
  $null = Run-Detached "$P-wb" (@('--network-alias', "$P-wb") + $common + @('-e', 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub', $wbTag))
  $null = Run-Detached "$P-wbfa" (@('--network-alias', "$P-wbfa") + $common + @('-e', "WORKSPACE_DOOR_KEY=$door",
      '-e', "WORKSPACE_FORWARD_AUTH_ISSUER=$faIssuer", '-e', "WORKSPACE_FORWARD_AUTH_CLIENT_ID=$faClient", '-e', "WORKSPACE_FORWARD_AUTH_CLIENT_SECRET=$faSecret",
      '-e', 'WORKSPACE_FORWARD_AUTH_ADMIN_GROUP=lab-admins', $wbTag))
  foreach ($h in @("$P-wb", "$P-wbfa")) {
    $up = $false
    for ($i = 0; $i -lt 60; $i++) {
      $null = Dk run --rm --label $label --network $net --entrypoint deno $wbTag eval "const r = await fetch('http://${h}:8000/health').catch(() => null); Deno.exit(r && r.status < 500 ? 0 : 1)"
      if ($script:rc -eq 0) { $up = $true; break }
      Start-Sleep -Seconds 2
    }
    Check $up "the workbench $h is up"
    if (-not $up) { Save "$h.log" ((Dk logs $h) | Out-String) }
  }
  # ---------------------------------------------------------------- [4] back to the 390 model, plant, hash
  Write-Host '[4] revert the chain''s 570 (the 390 model), plant, hash'
  $rv0 = Psql-File (Join-Path $dockerDir 'revert-private-report-claims.sql') 'revert the chain''s 570'
  Check ($rv0.rc -eq 0 -and $rv0.msg -match 'foreign key restored') 'the revert puts the link''s foreign key back (the 390 model)'
  $c0 = Check-Script; Save 'check-before-plant.log' $c0
  Check ($c0 -match 'check: FAIL' -and $c0 -match "may execute the slot's functions=0 of 3") 'after the revert the check script reports the missing grant (0 of 3) and FAILS'
  $pt = Invoke-Test 'plant'
  Check ($pt.m.Success -and $pt.m.Groups[1].Value -eq 'ok' -and [int]$pt.m.Groups[2].Value -eq 1) "planted the 390-shaped private-report claims and everything naming them ($($pt.m.Value))"
  # round 2 (tester F1): the plant LANDED - the phase above asserts it (landed()); the lab counts it once more itself
  $pl = Q "SELECT (SELECT count(*) FROM public.lab_prc_plant) || '/' || (SELECT count(*) FROM public.research_private_report_claims) || '/' || (SELECT count(*) FROM public.research_steers) || '/' || (SELECT count(*) FROM public.wiki_pages WHERE slug LIKE 'content/topic/prc-%')"
  Check ($pl -eq '1/9/2/8') "the plant is in the database (plant record / links / steers / pages = $pl, want 1/9/2/8)"
  if ($pl -ne '1/9/2/8') { throw 'the plant did not land' }
  $h0 = Q $hashQ; Save 'hash-planted.txt' $h0
  # P2 (operator decision): how many shared outputs restate a private-report claim - before 570
  $null = Dk cp (Join-Path $dockerDir 'count-private-report-claim-reuse.sql') "${db}:/tmp/prcreuse.sql"
  $p2a = ((Dk exec $db psql -U postgres -d openbrain -X -A -t -q -f /tmp/prcreuse.sql) | Out-String).Trim(); Save 'p2-count-before-570.log' $p2a
  Write-Host ($p2a -replace "`n", ' | ')
  Check ($p2a -match 'mixed claims \(a shared synthesis also filed them, still in the shared table\)=1' -and $p2a -match "shared syntheses carrying a private-report claim's sentence=3" -and $p2a -match 'shared job reports carrying one=2' -and $p2a -match 'threads whose name, description or slug carries one=1' -and $p2a -match 'other shared claims carrying one \(another thread, or a superseded synthesis\)=2' -and $p2a -match 'shared sources whose notebook label carries one=1' -and $p2a -match 'job curator answers naming a thread by one=1') 'P2 count before 570: 1 mixed claim, 3 shared syntheses, 2 shared job reports, 1 thread, 2 other shared claims, 1 notebook label, 1 curator answer (the plant)'
  if ($OldSql) {
    # ---------------------------------------------------------------- the fix's RED: the earlier 570 on the same plant
    Write-Host "[fix RED] the earlier slot 570 ($OldSql) on the plant; every [fix] case must fail"
    $io = Psql-File $OldSql 'the earlier 570'
    Check ($io.rc -eq 0) "the earlier 570 applies on the plant (exit $($io.rc))"
    $old = Invoke-Test 'migrated'
    $oldCases = Case-Results $old.out
    Save 'fix-red-cases.txt' (($oldCases.Keys | Sort-Object | ForEach-Object { "$($oldCases[$_])  $_" }) -join "`n")
    $fixAll = @($oldCases.Keys | Where-Object { $_ -match ('\[' + $OldTag + '\]') })
    $fixRed = @($fixAll | Where-Object { $oldCases[$_] -eq 'FAILED' })
    foreach ($k in ($fixAll | Sort-Object)) { Write-Host "    $($oldCases[$k])  $k" }
    Check ($fixAll.Count -ge 2 -and $fixRed.Count -eq $fixAll.Count) "fix RED: every [$OldTag] case fails on the earlier 570 ($($fixRed.Count) of $($fixAll.Count))"
    $cOld = Check-Script; Save 'check-earlier-570.log' $cOld
    $p2o = ((Dk exec $db psql -U postgres -d openbrain -X -A -t -q -f /tmp/prcreuse.sql) | Out-String).Trim(); Save 'p2-count-earlier-570.log' $p2o
    Write-Host ($p2o -replace "`n", ' | ')
    throw 'STOP-OLDSQL'
  }
  # ---------------------------------------------------------------- [5] RED
  Write-Host '[5] RED: before 570'
  $red = Invoke-Test 'red'
  $redCases = Case-Results $red.out
  Check ($red.out -notmatch 'plant did not land') 'RED: every case ran against the landed plant (no "plant did not land")'
  $leakRed = @($redCases.Keys | Where-Object { $_ -match '\[leak\]' -and $redCases[$_] -eq 'FAILED' })
  $dbRed = @($redCases.Keys | Where-Object { $_ -match '\[db\]' -and $redCases[$_] -eq 'FAILED' })
  $ctlRed = @($redCases.Keys | Where-Object { $_ -match '\[(control|owner)\]' -and $redCases[$_] -eq 'FAILED' })
  Save 'red-cases.txt' (($redCases.Keys | Sort-Object | ForEach-Object { "$($redCases[$_])  $_" }) -join "`n")
  Check ($leakRed.Count -ge 6) "RED: $($leakRed.Count) [leak] read path(s) fail before 570 (B's claims reach A, the lane, a service, A signed in or the admin)"
  Check ($dbRed.Count -eq @($redCases.Keys | Where-Object { $_ -match '\[db\]' }).Count -and $dbRed.Count -ge 9) "RED: every [db] case fails before 570 ($($dbRed.Count))"
  Check ($ctlRed.Count -eq 0) "RED: the controls and the owner's read pass before 570 ($($ctlRed.Count) failed)"
  $cr = Check-Script; Save 'check-red.log' $cr
  Check ($cr -match 'check: FAIL' -and $cr -match 'in the shared table=[1-9]') 'RED: the check script reports private-report claims on a shared surface and FAILS'
  Check ($cr -match "wiki pages carrying one's text=7" -and $cr -match 'job results naming one for someone else=1' -and $cr -match "gap-work rows of a shared tree carrying one's text=[1-9]") 'RED (tester F4): before 570 the check script sees the 3 pages (variants included), the job result and the gap work'
  # ---------------------------------------------------------------- [6] init x2, revert x2, init
  Write-Host '[6] 570 x2, revert x2 (byte-identical), 570'
  $i1 = Psql-File (Join-Path $dockerDir 'init-private-report-claims.sql') '570'
  Check ($i1.rc -eq 0 -and $i1.msg -match '8 claim\(s\) moved to their owner''s store' -and $i1.msg -match '2 withheld \(no single owner\)' -and $i1.msg -match '1 of them a shared synthesis also filed' -and $i1.msg -match '0 job result\(s\) stripped' -and $i1.msg -match '7 wiki page\(s\) withheld' -and $i1.msg -match '4 gap-work row\(s\) of a shared tree made neutral' -and $i1.msg -match '1 corroboration line') "570 moves B's 5 (the mixed one and the human-typed one included) + A's 1 claims, withholds the two-owner and the ownerless claim, withholds the 6 pages, neutralises the 4 machine gap-work rows (not the human steer) and the line (counts only)"
  Check ($i1.msg -match '3 shared synthesis\(es\) moved private to their claim''s owner, 1 withheld' -and $i1.msg -match '1 shared job report\(s\) moved private to their claim''s owner, 2 withheld' -and $i1.msg -match '2 other shared claim\(s\) carrying a moved claim''s sentence' -and $i1.msg -match '\(2 link\(s\) added\), 1 thread\(s\) re-described' -and $i1.msg -match '1 notebook label\(s\) relabelled, 1 curator answer\(s\) renamed, 1 entit\(ies\) bumped') "P2: the restating and the mixed-filing syntheses move to B, the two-owner one is withheld; B's own question's report moves to B, A's question's and the ownerless job's are withheld"
  $i2 = Psql-File (Join-Path $dockerDir 'init-private-report-claims.sql') '570 again'
  Check ($i2.rc -eq 0 -and $i2.msg -match 'nothing to move' -and $i2.msg -notmatch 'corroboration line') '570 a second time: nothing to move'
  $c1 = Check-Script; Save 'check-after-570.log' $c1
  Check ($c1 -match 'check: OK') 'after 570 the check script says OK'
  $v1 = Psql-File (Join-Path $dockerDir 'revert-private-report-claims.sql') 'revert'
  Check ($v1.rc -eq 0 -and $v1.msg -match '10 claim\(s\) restored' -and $v1.msg -match '4 gap-work row\(s\)' -and $v1.msg -match 'foreign key restored') 'the revert restores the 8 claims, the edges, the pages, the gap work, the line and the key'
  Check ($v1.msg -match '4 shared synthesis\(es\) restored' -and $v1.msg -match '3 shared job report\(s\) restored' -and $v1.msg -match '4 private copy\(ies\) removed' -and $v1.msg -match '2 added link\(s\) removed, 1 thread\(s\) restored' -and $v1.msg -match '1 curator answer\(s\), 1 notebook label\(s\), 1 entit\(ies\) restored') 'the revert restores the 4 P2 syntheses, the 3 P2 job reports and the thread, removes the 4 private copies and the added link'
  $v2 = Psql-File (Join-Path $dockerDir 'revert-private-report-claims.sql') 'revert again'
  Check ($v2.rc -eq 0 -and $v2.msg -match 'nothing to restore') 'a second revert has nothing to restore'
  $h1 = Q $hashQ; Save 'hash-reverted.txt' $h1
  Check ($h1 -eq $h0) "after the revert every touched table is byte-identical to the planted state"
  if ($h1 -ne $h0) { Save 'hash-diff.txt' ("planted:  $h0`nreverted: $h1") }
  $i3 = Psql-File (Join-Path $dockerDir 'init-private-report-claims.sql') '570 once more'
  Check ($i3.rc -eq 0 -and $i3.msg -match '8 claim\(s\) moved' -and $i3.msg -match '3 shared synthesis\(es\) moved private') '570 after the revert moves the same claims and summaries again'
  $p2b = ((Dk exec $db psql -U postgres -d openbrain -X -A -t -q -f /tmp/prcreuse.sql) | Out-String).Trim(); Save 'p2-count-after-570.log' $p2b
  Write-Host ($p2b -replace "`n", ' | ')
  Check ($p2b -match 'mixed claims \(a shared synthesis also filed them, still in the shared table\)=0' -and $p2b -match "shared syntheses carrying a private-report claim's sentence=0" -and $p2b -match 'shared job reports carrying one=0' -and $p2b -match 'threads whose name, description or slug carries one=0' -and $p2b -match 'other shared claims carrying one \(another thread, or a superseded synthesis\)=0' -and $p2b -match 'shared sources whose notebook label carries one=0' -and $p2b -match 'job curator answers naming a thread by one=0') 'P2 count after 570: 0 mixed claims, 0 shared syntheses, 0 shared job reports (operator decision P2)'
  $c2 = Check-Script; Save 'check-green.log' $c2
  Check ($c2 -match 'check: OK') 'the check script says OK'
  # ---------------------------------------------------------------- [7] GREEN
  Write-Host '[7] GREEN: after 570'
  $green = Invoke-Test 'migrated'
  Check ($green.m.Success -and $green.m.Groups[1].Value -eq 'ok' -and [int]$green.m.Groups[3].Value -eq 0) "GREEN: every case passes after 570 ($($green.m.Value))"
  $greenCases = Case-Results $green.out
  Save 'green-cases.txt' (($greenCases.Keys | Sort-Object | ForEach-Object { "$($greenCases[$_])  $_" }) -join "`n")
  $c3 = Check-Script; Save 'check-after-green.log' $c3
  Check ($c3 -match 'check: OK') 'after the green run (a new filing, guard probes) the check script still says OK'
  # ---------------------------------------------------------------- [8] the last revert
  # ---------------------------------------------------------------- [9] slot 480 staged
  # final round (tester attempt 2 F3): 480's own migration (from OB1 work/rw-owner-private-view-int, not on this tree),
  # run on the migrated database as its lab runners do (ob-workbench-role.ps1: after ob_app_memory exists); then the
  # ob_workbench login reads the owner's private-report claims, owner-scoped
  Write-Host '[9] slot 480 re-run (init-owner-private-view.sql of this tree; 480 is in the chain)'
  $i480 = Join-Path $dockerDir 'init-owner-private-view.sql'
  if (Test-Path $i480) {
    $r480 = Psql-File $i480 '480'
    Check ($r480.rc -eq 0) "slot 480 applied again on the migrated database (exit $($r480.rc))"
    $mem = Q "SELECT pg_has_role('ob_workbench', 'ob_app_memory', 'MEMBER')"
    Check ($mem -eq 't') "after 480 ob_workbench is a member of ob_app_memory ($mem)"
    $t480 = Invoke-Test 'p480'
    Check ($t480.m.Success -and $t480.m.Groups[1].Value -eq 'ok' -and [int]$t480.m.Groups[2].Value -ge 1) "with 480 the ob_workbench login reads B's private-report claims, owner-scoped, and files none ($($t480.m.Value))"
    $c480 = Check-Script; Save 'check-after-480.log' $c480
    Check ($c480 -match 'check: OK') 'with 480 the check script still says OK'
  } else {
    Fail 'this tree has no docker/init-owner-private-view.sql (slot 480 is expected at the 58bbc30 base)'
  }
  Write-Host '[8] the revert with a post-570 filing'
  $v3 = Psql-File (Join-Path $dockerDir 'revert-private-report-claims.sql') 'revert with a curator filing'
  Check ($v3.rc -eq 0 -and $v3.msg -match '1 curator filing\(s\) made shared again' -and $v3.msg -match 'foreign key restored') 'the revert puts the post-570 filing back in the shared table (the 390 model) and the key back on'
  $fk = Q "SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.research_private_report_claims'::regclass AND contype = 'f' AND confrelid = 'public.claims'::regclass"
  Check ($fk -eq '1') "the link's foreign key onto claims is back ($fk)"
} catch {
  if ($_.Exception.Message -ne 'STOP-OLDSQL') { Fail "aborted: $($_.Exception.Message)" }
} finally {
  Save 'psql.log' ($script:log -join "`n")
  foreach ($c in $script:made.containers) { $null = Dk rm -f $c }
  if ($script:made.net) { $null = Dk network rm $net }
  if (-not $KeepImages) { foreach ($i in $script:made.images) { $null = Dk rmi $i } }
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  foreach ($d in @($script:made.dirs)) { if ($d) { try { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } catch { } } }
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}' | Out-String).Trim()
  Check (-not $left) "nothing labelled $label is left running ($left)"
}
Write-Host ''
if ($script:fail -eq 0) { Write-Host "ALL PASSED  (evidence: $Evidence)"; exit 0 } else { Write-Host "$($script:fail) FAILED  (evidence: $Evidence)"; exit 1 }
