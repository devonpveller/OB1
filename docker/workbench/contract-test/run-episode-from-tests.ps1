# run-episode-from-tests.ps1 - the disposable lab run for the research workbench redesign item rwr-episode-from: a podcast
# episode made from a run, a report, a document, an idea or a topic (and not only a room transcript), as TWO users, against
# a real workbench, database and PostgREST, and the render service voicing each kind with real ffmpeg.
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-episode-from-tests.ps1 -Subnet <x.y.z.0/24> [-Id <owner>] [-Evidence <dir>] [-Prebuilt] [-KeepImages]
#
# -Subnet is REQUIRED (harness-subnet.ps1: exactly a /24 outside Docker's default pools and 192.168.0.0/16);
# -Evidence must be absent or empty. -Prebuilt uses images already built under this run's :wt-<id> tags
# (openbrain-workbench:wt-<id> + -test, openbrain-podcast:wt-<id>-test). Removed at the end unless -KeepImages.
#
# LAB DOCKER SHIM (as run-cast-tests.ps1): every docker call goes through Lab-Docker, which REFUSES a published port, a
# network other than this run's, a network create that is not --internal on the pinned subnet, a macvlan / ipvlan driver,
# any 192.168.x address, any ai-stack_* / open-brain_* name, any :local image, docker compose, and a build tag that is not
# :wt-<id>[-suffix]. Everything is labelled ai-stack.harness.owner=<Id> and removed at the end; the run checks nothing
# labelled <Id> is left and no :local image changed.
#
# What it does (NO migration: this item adds none - the kinds registry is code on both sides):
#   1. stages the REAL initdb chain from docker-compose.yml
#   2. one internal network on the pinned /25; 3. builds openbrain-workbench:wt-<id> (its build test gate runs src/contracts/
#      incl. episode_inputs_test.ts) and its test stage, and the podcast image's TEST stage (ffmpeg; its gate runs
#      input-kinds.test.ts)
#   4. the lab: database (chain + fixtures.sql; the workbench as ob_workbench, non-superuser), stub embedder, stub research
#      service, PostgREST, ONE workbench with WORKSPACE_IDENTITY_HEADER=X-Test-Sub
#   5a. the integration test (src/contracts/episode_from_integration_test.ts: E1-E12) as users A and B
#   5b. the render step (recipes/daily-digest/src/podcast/episode-from.e2e.test.ts in the podcast test image: each kind
#       voiced from its fixture, real ffmpeg, a stub gateway on loopback, the share step end to end)
#   5c. the planted markers are in no container log of the lab (workbench, PostgREST, database, research, embedder)
#   6. the evidence gate, then teardown and the leftover checks
# It never touches the live stack. Exit 0 = every check passed.
param(
  [string]$Id = 'wt-rwr-episode-from',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
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
$short = ($Id -replace '^wt-', '')
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$P = "rwepf-$rand"
$net = "$P-net"
$wbTag = "openbrain-workbench:wt-$short"; $wbTestTag = "openbrain-workbench:wt-$short-test"; $podTestTag = "openbrain-podcast:wt-$short-test"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$key = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$wsKey = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
$evStage = Join-Path $env:TEMP "$P-evstage"; New-Item -ItemType Directory -Force $evStage | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$outDir = Join-Path $env:TEMP "$P-out"; New-Item -ItemType Directory -Force $outDir | Out-Null
$vault = Join-Path $env:TEMP "$P-vault"; New-Item -ItemType Directory -Force $vault | Out-Null
foreach ($fx in @(@('content/tool/tool-fixture', 'Tool Fixture', 'An entity page about contract retrieval fixtures.'),
    @('content/source/11111111-1111-4111-8111-111111111111', 'Active fixture source', 'Leaf.'))) {
  $fxPath = Join-Path $vault ($fx[0] + '.md')
  New-Item -ItemType Directory -Force (Split-Path -Parent $fxPath) | Out-Null
  [System.IO.File]::WriteAllText($fxPath, "---`ntitle: $($fx[1])`n---`n$($fx[2])`n", (New-Object System.Text.UTF8Encoding $false))
}
. (Join-Path $PSScriptRoot 'evidence-gate.ps1')

$script:fail = 0
$script:made = @{ net = $false; containers = @(); images = @(); dirs = @($evStage, $stage, $outDir, $vault) }
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Save([string]$name, [string]$text) {
  $t = $text -replace [regex]::Escape($key), '<key>' -replace [regex]::Escape($wsKey), '<ws-key>'
  [System.IO.File]::WriteAllText((Join-Path $evStage $name), $t, (New-Object System.Text.UTF8Encoding $false))
}

# -- the lab docker shim (as run-flags-tests.ps1) ---------------------------------------
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
function DkLong { Lab-Docker 2400 ([string[]]$args) }

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
function Start-Db([string]$name, [string]$initdir, [string[]]$alias) {
  if (-not (Run-Detached $name (@($alias) + @('-e', "POSTGRES_PASSWORD=$pw", '-e', 'POSTGRES_DB=openbrain', '-v', "${initdir}:/docker-entrypoint-initdb.d:ro", $PgImage)))) { return $false }
  for ($i = 0; $i -lt 150; $i++) { if ((Dk logs $name) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $name pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $logs = Dk logs $name
  Check ($logs -match 'PostgreSQL init process complete') "$name ran its initdb chain"
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "$name initdb logged no ERROR ($($errs.Count))"
  if ($errs.Count) { Save "initdb-errors-$name.log" ($errs -join "`n") }
  return $true
}
function Psql([string]$dbc, [string]$sqlText) { (Dk exec $dbc psql -U postgres -d openbrain -X -A -t -q -v ON_ERROR_STOP=1 -c $sqlText | Out-String).Trim() }

try {
  Write-Host "== rwr-episode-from lab run  owner=$Id  net=$net  evidence=$Evidence"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) {
    Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1])
  }
  $order = @($chain | ForEach-Object { $_[1] })

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
  } else {
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" -t $wbTag $wb
    $clean = ($o -replace '\x1b\[[0-9;]*m', '')
    Save 'build-workbench.log' ((($clean -split "`n") | Where-Object { $_ -match 'episode|ok \||FAILED|passed|error' } | Select-Object -Last 120) -join "`n")
    Check ($script:rc -eq 0) "$wbTag built at OB1 $($sha.Substring(0, 7)) (its build test gate passed, src/contracts/episode_inputs_test.ts included)"
    if ($script:rc -ne 0) { throw 'build workbench' }
    $script:made.images += $wbTag
    $gate = ([regex]'ok \| (\d+) passed \| (\d+) failed').Matches($clean)
    if ($gate.Count) { Pass "the workbench build test gate: $($gate[$gate.Count - 1].Value)" }
    Check ($clean -match 'episode_inputs_test\.ts' -or $clean -match 'the kinds: run, report') 'the build gate ran episode_inputs_test.ts'
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --target test -t $wbTestTag $wb; Save 'build-workbench-test.log' ($o -split "`n" | Select-Object -Last 20 | Out-String)
    Check ($script:rc -eq 0) "$wbTestTag (this tree's test stage) built"
    $script:made.images += $wbTestTag
  }

  Write-Host '[4] the lab'
  $db = "$P-db"
  if (-not (Start-Db $db $stage @('--network-alias', 'openbrain-db'))) { throw 'db' }
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role)'
  . (Join-Path $PSScriptRoot 'ob-workbench-role.ps1'); $wbDb = Use-ObWorkbenchRole $appPw # rw-owner-private-view: the workbench's own role
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
  $wbArgs = @('-e', 'PORT=8000', '-e', "WORKBENCH_KEY=$key",
      '-e', "DB_HOST=$db", '-e', "DB_USER=$($wbDb.role)", '-e', "DB_PASSWORD=$($wbDb.pw)", '-e', 'OPEN_BRAIN_URL=http://unreachable.invalid',
      '-e', 'EMBEDDING_API_BASE=http://stub-embed:8080/v1', '-e', 'EXTRACT_URL=http://unreachable.invalid', '-e', 'WIKI_GIT_DIR=/wiki',
      '-e', 'WIKI_ASSETS_DIR=/wiki/assets', '-e', 'CONTRACT_MOUNTS_ROOT=/mounts', '-e', 'RESEARCH_URL=http://stub-research:8000',
      '-e', "RESEARCH_WORKSPACE_KEY=$wsKey", '-e', 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub',
      '-v', "${vault}:/wiki", '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro")
  $null = Run-Detached "$P-wb" (@('--network-alias', 'openbrain-workbench') + $wbArgs + @($wbTag))
  Check (Wait-Http "http://$P-wb:8000/health" 90) "$P-wb is up (DB role $($wbDb.role))"
  Check (Wait-Http "http://openbrain-postgrest:3000/" 60) 'PostgREST is up'

  Write-Host '[3b] the podcast image (its test stage: ffmpeg + the gate that runs input-kinds.test.ts)'
  if ($Prebuilt) {
    $null = Dk image inspect $podTestTag
    Check ($script:rc -eq 0) "prebuilt image $podTestTag is present"
    if ($script:rc -ne 0) { throw "prebuilt $podTestTag" }
  } else {
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --target test -t $podTestTag (Join-Path $ob1 'recipes/daily-digest')
    $clean = ($o -replace '\x1b\[[0-9;]*m', '')
    Save 'build-podcast-test.log' ((($clean -split "`n") | Where-Object { $_ -match 'input-kinds|ok \||FAILED|passed|error|gate' } | Select-Object -Last 80) -join "`n")
    Check ($script:rc -eq 0) "$podTestTag built (its gate ran input-kinds.test.ts)"
    if ($script:rc -ne 0) { throw 'build podcast test' }
  }
  $script:made.images += $podTestTag

  Write-Host '[5a] the integration test (E1-E12) as users A and B'
  $o = Lab-Docker 900 @('run', '--rm', '--label', $label, '--network', $net,
    '-e', "EPF_TEST_BASE=http://$P-wb:8000", '-e', "EPF_TEST_KEY=$key", '-e', 'EPF_TEST_MARKER_OUT=/out/markers.txt', '-e', 'EPF_WORLD_OUT=/out/world.json',
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    '-v', "${outDir}:/out",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', '--allow-write=/out', 'src/contracts/episode_from_integration_test.ts')
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save 'episode-from-integration.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED|ignored)|^(ok|FAILED) \||^E\d+:|error:|Assertion|=> |^\s+at ' } | Select-Object -First 200) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED|ignored)' }) { Write-Host "    $l" }
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed(?: \| (\d+) ignored)?').Match($clean)
  Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0 -and [int]$sum.Groups[2].Value -ge 12 -and (-not $sum.Groups[4].Success -or $sum.Groups[4].Value -eq '0')) "the integration test: E1-E12, none ignored ($($sum.Value))"

  Write-Host '[5b] the render step: each kind voiced from its fixture (the podcast test image, real ffmpeg, a stub gateway)'
  Check (Test-Path (Join-Path $outDir 'world.json')) 'the integration test wrote the planted world'
  $o = Lab-Docker 900 @('run', '--rm', '--label', $label, '--network', $net,
    '-e', 'EPF_WORLD=/out/world.json', '-e', "EPF_WB_BASE=http://$P-wb:8000", '-e', "EPF_WB_KEY=$key", '-e', 'EPF_REST=http://openbrain-postgrest:3000', '-e', 'EPF_OUT=/out/render',
    '-v', "${outDir}:/out", '-w', '/app', $podTestTag,
    'deno', 'test', '--allow-all', 'src/podcast/episode-from.e2e.test.ts')
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save 'episode-from-render.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED|ignored)|^(ok|FAILED) \||error:|Assertion|=> |^\s+at ' } | Select-Object -First 100) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED|ignored)' }) { Write-Host "    $l" }
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed(?: \| (\d+) ignored)?').Match($clean)
  Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0 -and [int]$sum.Groups[2].Value -ge 1 -and (-not $sum.Groups[4].Success -or $sum.Groups[4].Value -eq '0')) "the render test: five kinds voiced, private, share step end to end, none ignored ($($sum.Value))"

  Write-Host '[5c] the planted markers are in no log of the lab'
  $markerFile = Join-Path $outDir 'markers.txt'
  $markers = @()
  if (Test-Path $markerFile) { $markers = @((Get-Content $markerFile) | Where-Object { $_.Trim() }) }
  Check ($markers.Count -ge 7) "the integration test planted $($markers.Count) markers"
  $logHits = @()
  foreach ($c in @("$P-wb", "$P-postgrest", $db, "$P-research", "$P-embed")) {
    $lg = Dk logs $c
    foreach ($mk in $markers) { if ($lg.Contains($mk)) { $logHits += "${c}:$mk" } }
  }
  Check ($logHits.Count -eq 0) "no planted marker in the workbench, PostgREST, database, research or embedder log ($($logHits.Count) hits)"
  if ($logHits.Count) { Save 'log-marker-hits.log' ($logHits -join "`n") }
  $renderTree = (Get-ChildItem -Recurse -File (Join-Path $outDir 'render') -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '\.(mp3|pcm|wav)$' })
  $fileHits = @(); foreach ($f in $renderTree) { $c = [System.IO.File]::ReadAllText($f.FullName); foreach ($mk in $markers) { if ($c.Contains($mk)) { $fileHits += "$($f.Name):$mk" } } }
  Check ($fileHits.Count -eq 0) "no planted marker in the archive's sidecar or transcript files ($($fileHits.Count) hits)"
  Save 'workbench.log' (Dk logs --tail 120 "$P-wb")
} catch {
  Fail "the run stopped: $_"
} finally {
  Write-Host '[6] teardown'
  foreach ($c in $script:made.containers) { $null = Dk rm -f -v $c }
  if ($script:made.net) { $null = Dk network rm $net }
  if (-not $KeepImages) { foreach ($i in ($script:made.images | Select-Object -Unique)) { $null = Dk rmi -f $i } }
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}' | Out-String).Trim()
  Check (-not $left) "no container labelled $Id is left ($left)"
  $leftNet = (Dk network ls --filter "label=$label" --format '{{.Name}}' | Out-String).Trim()
  Check (-not $leftNet) "no network labelled $Id is left ($leftNet)"
  $leftVol = (Dk volume ls --filter "label=$label" --format '{{.Name}}' | Out-String).Trim()
  Check (-not $leftVol) "no volume labelled $Id is left ($leftVol)"
  if (-not $KeepImages) {
    $leftImg = @($script:made.images | Select-Object -Unique | Where-Object { $null = Dk image inspect $_; $script:rc -eq 0 })
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
