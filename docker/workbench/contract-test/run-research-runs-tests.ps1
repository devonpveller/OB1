# run-research-runs-tests.ps1 - the disposable lab run for the research workbench redesign item rwr-research-runs: a person's own
# research runs (slot 640: research_run_views and its four functions; GET /workbench/contract/research/runs[/{id}], POST
# .../archive, .../unarchive, .../document) as THREE users and a service key with planted markers, the catalog, the slot-640 round
# trip and Dredd, against a real workbench (logging in as ob_workbench) and database.
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-research-runs-tests.ps1 -Subnet <x.y.z.0/24> [-Id <owner>] [-Evidence <dir>] [-Red] [-BaseSha <sha>]
#
# -Subnet is REQUIRED (harness-subnet.ps1: exactly a /24 outside Docker's default pools and 192.168.0.0/16); -Evidence must be
# absent or empty. -Red runs THIS tree's integration test against a workbench built from -BaseSha (the development pin before
# rwr-research-runs): every case must FAIL there (the chain is this tree's, so the table exists; the base workbench has no routes
# over it). -Prebuilt uses images already built under this run's :wt-<id> tags. Removed at the end unless -KeepImages.
#
# LAB DOCKER SHIM (as run-inlets-tests.ps1): every docker call goes through Lab-Docker, which REFUSES a published port, a network
# other than this run's, a network create that is not --internal on the pinned subnet, a macvlan / ipvlan driver, any 192.168.x
# address, any ai-stack_* / open-brain_* name, any :local image, docker compose, and a build tag that is not :wt-<id>[-suffix].
# Everything is labelled ai-stack.harness.owner=<Id> and removed at the end. It never touches the live stack.
# Exit 0 = every check passed (with -Red: every case FAILED).
param(
  [string]$Id = 'wt-rwr-research-runs',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
  [string]$CaddyImage = 'caddy:2-alpine',
  [string]$BaseSha = '66ddb63',
  [switch]$Red,
  [switch]$Prebuilt,
  [switch]$KeepImages
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
$viewerDir = Join-Path $dockerDir 'wiki-viewer'
$short = ($Id -replace '^wt-', '')
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$P = "rwrun-$rand"
$net = "$P-net"
$wbTag = "openbrain-workbench:wt-$short"; $wbTestTag = "openbrain-workbench:wt-$short-test"
if ($Red) { $wbTag = "openbrain-workbench:wt-$short-base" }
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$key = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$svcKey = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$wsKey = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
$evStage = Join-Path $env:TEMP "$P-evstage"; New-Item -ItemType Directory -Force $evStage | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$vault = Join-Path $env:TEMP "$P-vault"; New-Item -ItemType Directory -Force $vault | Out-Null
foreach ($fx in @(@('content/tool/tool-fixture', 'Tool Fixture', 'An entity page about contract retrieval fixtures.'),
    @('content/source/11111111-1111-4111-8111-111111111111', 'Active fixture source', 'Leaf.'),
    @('content/source/22222222-2222-4222-8222-222222222222', 'Suppressed fixture source', 'Leaf.'))) {
  $fxPath = Join-Path $vault ($fx[0] + '.md')
  New-Item -ItemType Directory -Force (Split-Path -Parent $fxPath) | Out-Null
  [System.IO.File]::WriteAllText($fxPath, "---`ntitle: $($fx[1])`n---`n$($fx[2])`n", (New-Object System.Text.UTF8Encoding $false))
}
. (Join-Path $PSScriptRoot 'evidence-gate.ps1')

$script:fail = 0
$script:made = @{ net = $false; containers = @(); images = @(); dirs = @($evStage, $stage, $vault) }
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Save([string]$name, [string]$text) {
  $t = $text -replace [regex]::Escape($key), '<key>' -replace [regex]::Escape($wsKey), '<ws-key>'
  [System.IO.File]::WriteAllText((Join-Path $evStage $name), $t, (New-Object System.Text.UTF8Encoding $false))
}

# -- the lab docker shim (as run-workspace-tests.ps1) ---------------------------------------
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
    if ($x -match '^(-d|--driver)$' -and $a[0] -eq 'network' -and $a[$i + 1] -match 'macvlan|ipvlan') { return 'a macvlan / ipvlan driver' }
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
  if ($why) { Write-Host "  SHIM REFUSED: $why :: docker $($a -join ' ')"; $script:rc = 2; $script:fail++; return "REFUSED: $why" }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'docker'
  $psi.Arguments = ($a | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) {
    try { $p.Kill() } catch { }
    $script:rc = 124
    return "TIMEOUT after ${TimeoutSec}s: docker $($a[0..([Math]::Min(3, $a.Count - 1))] -join ' ')"
  }
  $p.WaitForExit()
  $script:rc = $p.ExitCode
  return (($out.Result + $err.Result) -replace "`r", '').TrimEnd()
}
function Dk { Lab-Docker 300 ([string[]]$args) }
function DkLong { Lab-Docker 6000 ([string[]]$args) }

$shimCases = @(
  @('run', '-p', '8080:8080', 'x'), @('run', '--network', 'ai-stack_llm-net', 'x'), @('network', 'create', '--driver', 'macvlan', 'n'),
  @('network', 'create', 'n'), @('run', 'openbrain-workbench:local'), @('run', '-e', 'X=192.168.1.20', 'x'), @('compose', 'up'),
  @('build', '-t', 'openbrain-workbench:local', '.'), @('run', '--publish=1:1', 'x'))
$shimRefused = @($shimCases | Where-Object { Test-LabDockerArgs $_ }).Count
Check ($shimRefused -eq $shimCases.Count) "the lab docker shim refuses every forbidden shape ($shimRefused / $($shimCases.Count))"

function LocalSnapshot { (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim() -split "`n" | Sort-Object }
$localBefore = LocalSnapshot

function Run-Detached([string]$name, [string[]]$extra) {
  $o = Dk run -d --name $name --label $label --network $net @extra
  if ($script:rc -ne 0) { Fail "$name did not start: $o"; return $false }
  $script:made.containers += $name
  return $true
}
function Wait-Http([string]$url, [int]$tries = 60) {
  for ($i = 0; $i -lt $tries; $i++) {
    $null = Dk run --rm --label $label --network $net --entrypoint deno $wbTestTag eval "try { const r = await fetch('$url'); Deno.exit(r.status < 500 ? 0 : 1) } catch { Deno.exit(1) }"
    if ($script:rc -eq 0) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

try {
  Write-Host "== rwr-research-runs lab run  owner=$Id  net=$net  red=$([bool]$Red)  evidence=$Evidence"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check (@($chain | Where-Object { $_[1] -eq '640-init-research-run-views.sql' }).Count -eq 1) "the chain mounts 640-init-research-run-views.sql ($($chain.Count) migrations)"

  Write-Host '[2] the internal network'
  $null = Dk network create --driver bridge --internal --subnet $subnets.run --label $label $net
  Check ($script:rc -eq 0) "network $net (internal, $($subnets.run))"
  if ($script:rc -ne 0) { throw 'network' }
  $script:made.net = $true

  Write-Host '[3] images'
  if ($Prebuilt) {
    foreach ($t in @($wbTag, $wbTestTag)) {
      $null = Dk image inspect $t
      Check ($script:rc -eq 0) "prebuilt image $t is present"
      if ($script:rc -ne 0) { throw "prebuilt $t" }
      $script:made.images += $t
    }
  } elseif ($Red) {
    $tree = Join-Path $env:TEMP "$P-tree-$BaseSha"
    New-Item -ItemType Directory -Force $tree | Out-Null
    $script:made.dirs += $tree
    $tar = Join-Path $env:TEMP "$P-$BaseSha.tar"
    & git -C $ob1 archive --format=tar -o $tar $BaseSha
    & tar -xf $tar -C $tree
    Remove-Item -Force $tar
    $o = DkLong build --label $label --build-arg "OB1_SHA=$BaseSha" -t $wbTag (Join-Path $tree 'docker/workbench'); Save 'build-workbench-base.log' ($o -split "`n" | Select-Object -Last 40 | Out-String)
    Check ($script:rc -eq 0) "RED: $wbTag built from OB1 $BaseSha"
    $script:made.images += $wbTag
  } else {
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" -t $wbTag $wb
    $clean = ($o -replace '\x1b\[[0-9;]*m', '')
    Save 'build-workbench.log' ((($clean -split "`n") | Where-Object { $_ -match 'research_runs|ok \||FAILED|passed|error' } | Select-Object -Last 120) -join "`n")
    Check ($script:rc -eq 0) "$wbTag built at OB1 $($sha.Substring(0, 7)) (its build test gate passed, src/contracts/research_runs_test.ts included)"
    if ($script:rc -ne 0) { throw 'build workbench' }
    $script:made.images += $wbTag
    $gate = ([regex]'ok \| (\d+) passed \| (\d+) failed').Matches($clean)
    if ($gate.Count) { Pass "the workbench build test gate: $($gate[$gate.Count - 1].Value)" }
  }
  if (-not $Prebuilt) {
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --target test -t $wbTestTag $wb; Save 'build-workbench-test.log' ($o -split "`n" | Select-Object -Last 20 | Out-String)
    Check ($script:rc -eq 0) "$wbTestTag (this tree's test stage) built"
    $script:made.images += $wbTestTag
  }

  Write-Host '[4] the lab'
  $db = "$P-db"
  if (-not (Run-Detached $db @('--network-alias', 'openbrain-db', '-e', "POSTGRES_PASSWORD=$pw", '-e', 'POSTGRES_DB=openbrain', '-v', "${stage}:/docker-entrypoint-initdb.d:ro", $PgImage))) { throw 'db' }
  for ($i = 0; $i -lt 150; $i++) { if ((Dk logs $db) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $logs = Dk logs $db
  Check ($logs -match 'PostgreSQL init process complete') 'the database ran the initdb chain'
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "initdb logged no ERROR ($($errs.Count))"
  if ($errs.Count) { Save 'initdb-errors.log' ($errs -join "`n") }
  $fnx = (Dk exec $db psql -U postgres -d openbrain -tAc "select to_regprocedure('public.run_view_archive(text,uuid)') is not null and to_regprocedure('public.run_views_of(text)') is not null and to_regprocedure('public.run_handbacks_of(text)') is not null and to_regclass('public.research_run_views') is not null").Trim()
  Check ($fnx -eq 't') 'slot 640 ran: research_run_views and its functions exist'
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role) - the production shape'
  . (Join-Path $ct 'ob-workbench-role.ps1')
  $wbr = Use-ObWorkbenchRole $appPw
  Check ($wbr.role -eq 'ob_workbench') 'the workbench logs in as ob_workbench, as compose does (slot 480)'
  $null = Dk cp (Join-Path $ct 'fixtures.sql') "${db}:/tmp/fixtures.sql"
  # rw-inlet-stamp (slot 470): fixtures.sql is legacy-shaped; the LAB switches 470's guards off around this load only
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "DO `$`$ BEGIN IF to_regclass('public.inlet_connections') IS NOT NULL THEN ALTER TABLE public.thoughts DISABLE TRIGGER trg_inlet_stamp_thoughts; ALTER TABLE public.sources DISABLE TRIGGER trg_inlet_stamp_sources; END IF; END `$`$"
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/fixtures.sql
  Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) 'fixtures applied'
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "DO `$`$ BEGIN IF to_regclass('public.inlet_connections') IS NOT NULL THEN ALTER TABLE public.thoughts ENABLE ALWAYS TRIGGER trg_inlet_stamp_thoughts; ALTER TABLE public.sources ENABLE ALWAYS TRIGGER trg_inlet_stamp_sources; END IF; END `$`$"

  $ctMount = "${ct}:/ct:ro"
  $null = Run-Detached "$P-embed" @('--network-alias', 'stub-embed', '-v', $ctMount, '--entrypoint', 'deno', $wbTestTag, 'run', '--allow-net', '/ct/stub-embed.ts')
  $null = Run-Detached "$P-research" @('--network-alias', 'stub-research', '-v', $ctMount, '-e', "DB_HOST=$db", '-e', "DB_PASSWORD=$pw",
      '-e', "STUB_CALLERS=workspace=workspace:$wsKey", '--entrypoint', 'deno', $wbTestTag, 'run', '--allow-net', '--allow-env', '--allow-read', '--config', '/app/deno.json', '/ct/stub-research.ts')
  $null = Run-Detached "$P-postgrest" @('--network-alias', 'openbrain-postgrest', '-e', "PGRST_DB_URI=postgres://postgres:$pw@openbrain-db:5432/openbrain",
      '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=service_role', '-e', 'PGRST_DB_POOL=4', '-e', 'PGRST_SERVER_PORT=3000', $PgrstImage)
  $null = Run-Detached "$P-rest" @('--network-alias', 'openbrain-rest', '-v', "$(Join-Path $dockerDir 'Caddyfile'):/etc/caddy/Caddyfile:ro", $CaddyImage)
  $wbArgs = @('-e', 'PORT=8000', '-e', "WORKBENCH_KEY=$key",
      '-e', "DB_HOST=$db", '-e', "DB_USER=$($wbr.role)", '-e', "DB_PASSWORD=$($wbr.pw)", '-e', 'OPEN_BRAIN_URL=http://openbrain-rest',
      '-e', 'EMBEDDING_API_BASE=http://stub-embed:8080/v1', '-e', 'EXTRACT_URL=http://unreachable.invalid', '-e', 'WIKI_GIT_DIR=/wiki',
      '-e', 'WIKI_ASSETS_DIR=/wiki/assets', '-e', 'CONTRACT_MOUNTS_ROOT=/mounts', '-e', 'RESEARCH_URL=http://stub-research:8000',
      '-e', "RESEARCH_WORKSPACE_KEY=$wsKey", '-e', 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub', '-e', "WORKSPACE_SERVICE_KEYS=svc=$svcKey",
      '-v', "${vault}:/wiki", '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro")
  $null = Run-Detached "$P-wb" (@('--network-alias', 'openbrain-workbench') + $wbArgs + @($wbTag))
  Check (Wait-Http "http://$P-wb:8000/health" 90) "$P-wb is up"

  Write-Host '[5a] the runs integration test (R0-R8)'
  $o = Lab-Docker 900 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${vault}:/vault:ro",
    '-e', "RUNS_TEST_BASE=http://$P-wb:8000", '-e', "RUNS_TEST_KEY=$key", '-e', "RUNS_TEST_SERVICE_KEY=$svcKey", '-e', 'RUNS_TEST_VAULT=/vault',
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', 'src/contracts/research_runs_integration_test.ts')
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save 'runs-integration.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||^R\d:|error:|Assertion|=> ' }) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)' }) { Write-Host "    $l" }
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
  if ($Red) { Check ($sum.Success -and [int]$sum.Groups[3].Value -ge 6) "RED: the route cases fail on the base $BaseSha ($($sum.Value))" }
  else { Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0 -and [int]$sum.Groups[2].Value -ge 9) "the runs integration test ($($sum.Value))" }

  if (-not $Red) {
    Write-Host '[5b] slot 640 round trip (forward x2, revert x2, forward; the schema dump and the grants compare)'
    $dump = 'pg_dump -U postgres -d openbrain --schema-only --no-owner --no-privileges -n public'
    $null = Dk cp (Join-Path $dockerDir 'init-research-run-views.sql') "${db}:/tmp/i640.sql"
    $null = Dk cp (Join-Path $dockerDir 'revert-research-run-views.sql') "${db}:/tmp/r640.sql"
    $dumpF = { param($x) (($x -split "`n") | Where-Object { $_ -notmatch '^\\(un)?restrict ' }) -join "`n" }
    $fnAcl = "select string_agg(p.proname || '=' || coalesce(p.proacl::text, 'null'), ';' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('run_view_archive','run_view_unarchive','run_views_of','run_handbacks_of')"
    $d1 = & $dumpF (Dk exec $db sh -c "$dump")
    $facl1 = (Dk exec $db psql -U postgres -d openbrain -tAc $fnAcl | Out-String).Trim()
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/i640.sql
    Check ($script:rc -eq 0) 'init-research-run-views.sql re-run on a migrated database: no error'
    $d1b = & $dumpF (Dk exec $db sh -c "$dump")
    Check ($d1 -eq $d1b) 'forward twice changes nothing (schema dump identical)'
    Check (((Dk exec $db psql -U postgres -d openbrain -tAc $fnAcl | Out-String).Trim()) -eq $facl1) 'forward twice leaves the function grants as they were'
    Check ($facl1 -match 'ob_workbench=X' -and $facl1 -notmatch 'ob_app_memory|service_role|anon' -and $facl1 -notmatch '(^|[{,])=X') "the functions' grants are the owner's and ob_workbench's only"
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/r640.sql
    Check ($script:rc -eq 0) 'revert-research-run-views.sql applied'
    $gone = (Dk exec $db psql -U postgres -d openbrain -tAc "select to_regclass('public.research_run_views') is null and to_regprocedure('public.run_views_of(text)') is null and to_regprocedure('public.run_handbacks_of(text)') is null" | Out-String).Trim()
    Check ($gone -eq 't') 'the revert removes the table and the functions'
    $d0 = & $dumpF (Dk exec $db sh -c "$dump")
    Check ($d0 -notmatch 'research_run_views|run_view_archive' -and $d1 -match 'research_run_views') 'the reverted schema has none of slot 640; the forward one does'
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/r640.sql
    Check ($script:rc -eq 0) 'revert twice: no error'
    $d0b = & $dumpF (Dk exec $db sh -c "$dump")
    Check ($d0b -eq $d0) 'revert x2 leaves the schema byte-identical to revert x1'
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/i640.sql
    $d2 = & $dumpF (Dk exec $db sh -c "$dump")
    if ($d2 -ne $d1) { Save 'schema-diff.log' ((Compare-Object ($d1 -split "`n") ($d2 -split "`n") | Out-String)) }
    Check ($d2 -eq $d1) 'forward after the revert restores the schema exactly (dump identical to the first)'
    Check (((Dk exec $db psql -U postgres -d openbrain -tAc $fnAcl | Out-String).Trim()) -eq $facl1) 'and the function grants'
    $revObjs = (Get-Content -Raw (Join-Path $dockerDir 'revert-research-run-views.sql'))
    Check (([regex]::Matches($revObjs, '(?im)^DROP ')).Count -eq 5 -and $revObjs -notmatch '(?i)DROP ROLE|ALTER |REVOKE ') 'the revert is four DROP FUNCTION and one DROP TABLE, nothing else'
    Save 'schema-roundtrip.log' "forward-twice identical: $($d1 -eq $d1b); revert-x2 identical: $($d0b -eq $d0); forward-after-revert identical: $($d2 -eq $d1)"
  }
  if (-not $Red) {
    Write-Host '[5c] Dredd over the runs routes (generated/openapi.json against the lab workbench; hooks as the contract run)'
    $dreddTag = "rw-dredd:wt-$short"
    $null = Dk image inspect $dreddTag
    if ($script:rc -ne 0) {
      $o = Dk build --label $label -t $dreddTag -f (Join-Path $ct 'dredd.Dockerfile') $ct
      Check ($script:rc -eq 0) "built $dreddTag"
      $script:made.images += $dreddTag
    } else { $script:made.images += $dreddTag }
    $gen = Join-Path $wb 'src\contracts\generated'
    $names = Lab-Docker 300 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${gen}:/spec:ro", $dreddTag, '/spec/openapi.json', "http://$P-wb:8000", '--names')
    $inNames = @(($names -replace '\[[0-9;]*m', '' -split "`n") | Where-Object { $_ -match '^info: (/workbench/contract/research/runs.*)$' } | ForEach-Object { $Matches[1].Trim() })
    Save 'dredd-runs-names.log' ($inNames -join "`n")
    foreach ($l in ($names -split "`n") | Where-Object { $_ -match 'research/runs' } | Select-Object -First 8) { Write-Host "    names: $l" }
    $onlyArgs = @(); foreach ($n in $inNames) { $onlyArgs += @('--only', $n) }
    $o = Lab-Docker 600 (@('run', '--rm', '--label', $label, '--network', $net, '-v', "${gen}:/spec:ro", '-v', "${ct}:/ct:ro", $dreddTag,
        '/spec/openapi.json', "http://$P-wb:8000", '--header', "X-Brain-Key: $key", '--hookfiles=/ct/dredd-hooks.js') + $onlyArgs)
    $clean = ($o -replace $key, '***') -replace '\x1b\[[0-9;]*m', ''
    Save 'dredd-runs.log' $clean
    foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '^(fail|error):|Transaction:.*runs|^\s+(expected|real|body)' } | Select-Object -First 40) { Write-Host "    $l" }
    $dm = ([regex]'complete: (\d+) passing, (\d+) failing, (\d+) errors, (\d+) skipped, (\d+) total').Match($clean)
    Check ($dm.Success -and $dm.Groups[2].Value -eq '0' -and $dm.Groups[3].Value -eq '0' -and $inNames.Count -ge 5 -and [int]$dm.Groups[1].Value -eq ($inNames.Count - 1) -and [int]$dm.Groups[4].Value -eq 1) "Dredd over the runs routes: $($dm.Value) (transactions: $($inNames.Count); the report-as-document write is skipped by the hooks and exercised by R6)"
  }
  Save 'workbench.log' (Dk logs --tail 120 "$P-wb")
} catch {
  Fail "the run stopped: $_"
} finally {
  Write-Host '[6] teardown'
  foreach ($c in $script:made.containers) { $null = Dk rm -f -v $c }
  if ($script:made.net) { $null = Dk network rm $net }
  if (-not $KeepImages) { foreach ($i in $script:made.images) { $null = Dk rmi -f $i } }
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}' | Out-String).Trim()
  Check (-not $left) "no container labelled $Id is left ($left)"
  $leftNet = (Dk network ls --filter "label=$label" --format '{{.Name}}' | Out-String).Trim()
  Check (-not $leftNet) "no network labelled $Id is left ($leftNet)"
  $leftVol = (Dk volume ls --filter "label=$label" --format '{{.Name}}' | Out-String).Trim()
  Check (-not $leftVol) "no volume labelled $Id is left ($leftVol)"
  if (-not $KeepImages) {
    $leftImg = @($script:made.images | Where-Object { $null = Dk image inspect $_; $script:rc -eq 0 })
    Check ($leftImg.Count -eq 0) "no image of this run is left ($($leftImg -join ', '))"
  }
  $localAfter = LocalSnapshot
  Check ((($localBefore -join "`n") -eq ($localAfter -join "`n"))) 'no :local image changed'
  $uuids = Get-FixtureUuids (Get-Content -Raw (Join-Path $ct 'fixtures.sql'))
  $ftext = Get-FixtureText @((Join-Path $ct 'fixtures.sql'))
  $pub = Publish-Evidence $evStage $Evidence @() { param($d, $c) @() } $uuids $ftext
  Write-Host "  evidence: published=$($pub.published) files=$($pub.files) dropped=$(@($pub.dropped).Count) -> $Evidence"
  foreach ($d in $script:made.dirs) { if (Test-Path $d) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } }
}
Write-Host "== $(if ($script:fail) { "FAILED ($($script:fail))" } else { 'ALL PASSED' })"
exit $(if ($script:fail) { 1 } else { 0 })
