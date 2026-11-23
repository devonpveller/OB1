# run-cast-tests.ps1 - the disposable lab run for the research workbench redesign item rwr-cast-edit-api: the cast
# model's writes and new fields (slot 560) as TWO users, against a real workbench, database and PostgREST.
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-cast-tests.ps1 -Subnet <x.y.z.0/24> [-Id <owner>] [-Evidence <dir>] [-Prebuilt] [-KeepImages]
#
# -Subnet is REQUIRED (harness-subnet.ps1: exactly a /24 outside Docker's default pools and 192.168.0.0/16);
# -Evidence must be absent or empty. -Prebuilt uses images already built under this run's :wt-<id> tags
# (openbrain-workbench:wt-<id> and its -test tag). Removed at the end unless -KeepImages.
#
# LAB DOCKER SHIM (as run-flags-tests.ps1): every docker call goes through Lab-Docker, which REFUSES a published
# port, a network other than this run's, a network create that is not --internal on the pinned subnet, a macvlan /
# ipvlan driver, any 192.168.x address, any ai-stack_* / open-brain_* name, any :local image, docker compose, and a
# build tag that is not :wt-<id>[-suffix]. Everything is labelled ai-stack.harness.owner=<Id> and removed at the
# end; the run checks nothing labelled <Id> is left and no :local image changed.
#
# What it does:
#   1. stages the REAL initdb chain from docker-compose.yml (the 560 cast slot included), and a second copy WITHOUT 560
#   2. one internal network on the pinned /25; 3. builds openbrain-workbench:wt-<id> (its build test gate runs
#      src/contracts/ incl. cast_test.ts) and its test stage
#   4. the lab: database (chain + fixtures.sql; the workbench as ob_workbench, non-superuser, the compose shape),
#      stub embedder, stub research service, PostgREST, ONE workbench with WORKSPACE_IDENTITY_HEADER=X-Test-Sub
#   5a. the cast integration test (src/contracts/cast_integration_test.ts: C1-C12, C5 through the real PostgREST with
#       the podcast renderer's own store from the recipes mount), then check-cast.sql on the lab database
#   5b. the planted markers (C9's) are in no container log of the lab (workbench, PostgREST, database)
#   5c. the migration round trip on a SECOND database (the chain without 560, with pre-560 podcast rows planted):
#       forward, forward again (dump identical), check-cast OK, the old rows read as "not set", revert: the schema dump
#       is byte-identical to the one before the forward and the old rows are unchanged; revert again; forward again
#       (dump identical to the first forward)
#   5d. Dredd over the cast routes (generated/openapi.json against the lab workbench; hooks as the contract run):
#       every cast transaction passes, none is skipped
#   6. the evidence gate, then teardown and the leftover checks
# It never touches the live stack. Exit 0 = every check passed.
param(
  [string]$Id = 'wt-rwr-cast-edit-api',
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
$P = "rwcast-$rand"
$net = "$P-net"
$wbTag = "openbrain-workbench:wt-$short"; $wbTestTag = "openbrain-workbench:wt-$short-test"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$key = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$wsKey = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
$evStage = Join-Path $env:TEMP "$P-evstage"; New-Item -ItemType Directory -Force $evStage | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$stage2 = Join-Path $env:TEMP "$P-initdb-no560"
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
$script:made = @{ net = $false; containers = @(); images = @(); dirs = @($evStage, $stage, $stage2, $outDir, $vault) }
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
  Write-Host "== rwr-cast-edit-api lab run  owner=$Id  net=$net  evidence=$Evidence"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  Write-Host '[1] the initdb chain, from docker-compose.yml (and a copy without 560)'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  New-Item -ItemType Directory -Force $stage2 | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) {
    Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1])
    if ($m[1] -ne '560-init-cast.sql') { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage2 $m[1]) }
  }
  Check (@($chain | Where-Object { $_[1] -eq '560-init-cast.sql' }).Count -eq 1) "the chain mounts 560-init-cast.sql ($($chain.Count) migrations)"
  $order = @($chain | ForEach-Object { $_[1] })
  $i560 = [array]::IndexOf($order, '560-init-cast.sql')
  Check (($i560 -gt [array]::IndexOf($order, '540-init-research-start.sql')) -and ($i560 -lt [array]::IndexOf($order, '570-init-private-report-claims.sql'))) 'slot 560 sits between 540 and 570'
  Check (@(Get-ChildItem $stage2 -Filter '560-*').Count -eq 0) 'the second chain has no 560'

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
    Save 'build-workbench.log' ((($clean -split "`n") | Where-Object { $_ -match 'cast|ok \||FAILED|passed|error' } | Select-Object -Last 120) -join "`n")
    Check ($script:rc -eq 0) "$wbTag built at OB1 $($sha.Substring(0, 7)) (its build test gate passed, src/contracts/cast_test.ts included)"
    if ($script:rc -ne 0) { throw 'build workbench' }
    $script:made.images += $wbTag
    $gate = ([regex]'ok \| (\d+) passed \| (\d+) failed').Matches($clean)
    if ($gate.Count) { Pass "the workbench build test gate: $($gate[$gate.Count - 1].Value)" }
    Check ($clean -match 'cast_test\.ts' -or $clean -match 'every cast route is in the document') 'the build gate ran cast_test.ts'
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --target test -t $wbTestTag $wb; Save 'build-workbench-test.log' ($o -split "`n" | Select-Object -Last 20 | Out-String)
    Check ($script:rc -eq 0) "$wbTestTag (this tree's test stage) built"
    $script:made.images += $wbTestTag
  }

  Write-Host '[4] the lab'
  $db = "$P-db"
  if (-not (Start-Db $db $stage @('--network-alias', 'openbrain-db'))) { throw 'db' }
  $shape = Psql $db "select (select count(*) from information_schema.columns where table_schema='public' and table_name in ('podcast_presenters','podcast_teams','podcast_formats') and column_name in ('role','focus','stance','tone','speaking_style','system_prompt','system_prompt_mode','notes','shared','copied_from','user_seat','kind','use_for','is_default')) || ':' || (select relrowsecurity::text from pg_class where oid = 'public.podcast_presenter_grounding'::regclass)"
  Check ($shape -eq '18:true') "slot 560 is applied by the chain: 18 new columns, the grounding table with row-level security ($shape)"
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role)'
  . (Join-Path $PSScriptRoot 'ob-workbench-role.ps1'); $wbDb = Use-ObWorkbenchRole $appPw # rw-owner-private-view: the workbench's own role
  $null = Dk cp (Join-Path $ct 'fixtures.sql') "${db}:/tmp/fixtures.sql"
  # rw-inlet-stamp (slot 470): fixtures.sql is legacy-shaped; the LAB switches 470's guards off around this load only
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "DO `$`$ BEGIN IF to_regclass('public.inlet_connections') IS NOT NULL THEN ALTER TABLE public.thoughts DISABLE TRIGGER trg_inlet_stamp_thoughts; ALTER TABLE public.sources DISABLE TRIGGER trg_inlet_stamp_sources; END IF; END `$`$"
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/fixtures.sql
  Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) 'fixtures applied (the cast fixtures included)'
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

  Write-Host '[5a] the cast integration test (C1-C16)'
  $o = Lab-Docker 900 @('run', '--rm', '--label', $label, '--network', $net,
    '-e', "CAST_TEST_BASE=http://$P-wb:8000", '-e', "CAST_TEST_KEY=$key", '-e', 'CAST_TEST_REST=http://openbrain-postgrest:3000',
    '-e', 'CAST_TEST_RECIPES=/recipes', '-e', 'CAST_TEST_MARKER_OUT=/out/markers.txt',
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro", '-v', "${outDir}:/out",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', '--allow-write=/out', 'src/contracts/cast_integration_test.ts')
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save 'cast-integration.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED|ignored)|^(ok|FAILED) \||^C\d+:|error:|Assertion|=> |^\s+at ' } | Select-Object -First 200) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED|ignored)' }) { Write-Host "    $l" }
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed(?: \| (\d+) ignored)?').Match($clean)
  Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0 -and [int]$sum.Groups[2].Value -ge 17 -and (-not $sum.Groups[4].Success -or $sum.Groups[4].Value -eq '0')) "the cast integration test: C1-C16 and the pool close, none ignored ($($sum.Value))"
  $null = Dk cp (Join-Path $dockerDir 'check-cast.sql') "${db}:/tmp/check-cast.sql"
  $chk = (Dk exec $db psql -U postgres -d openbrain -X -A -t -q -f /tmp/check-cast.sql | Out-String)
  Save 'check-cast-lab.log' $chk
  Check ($chk -match 'check: OK' -and $chk -notmatch 'check: FAIL') "check-cast.sql on the lab database after the run: OK"

  Write-Host '[5b] the planted markers are in no log of the lab'
  $markerFile = Join-Path $outDir 'markers.txt'
  $markers = @()
  if (Test-Path $markerFile) { $markers = @((Get-Content $markerFile) | Where-Object { $_.Trim() }) }
  Check ($markers.Count -ge 9) "the integration test planted $($markers.Count) markers"
  $logHits = @()
  foreach ($c in @("$P-wb", "$P-postgrest", $db, "$P-research", "$P-embed")) {
    $lg = Dk logs $c
    foreach ($mk in $markers) { if ($lg.Contains($mk)) { $logHits += "${c}:$mk" } }
  }
  Check ($logHits.Count -eq 0) "no planted marker in the workbench, PostgREST, database, research or embedder log ($($logHits.Count) hits)"
  if ($logHits.Count) { Save 'log-marker-hits.log' ($logHits -join "`n") }

  Write-Host '[5c] the migration round trip on a second database (the chain without 560)'
  $db2 = "$P-db2"
  if (-not (Start-Db $db2 $stage2 @('--network-alias', 'openbrain-db2'))) { throw 'db2' }
  $null = Dk cp (Join-Path $dockerDir 'init-cast.sql') "${db2}:/tmp/init-cast.sql"
  $null = Dk cp (Join-Path $dockerDir 'revert-cast.sql') "${db2}:/tmp/revert-cast.sql"
  $null = Dk cp (Join-Path $dockerDir 'check-cast.sql') "${db2}:/tmp/check-cast.sql"
  $chk0 = (Dk exec $db2 psql -U postgres -d openbrain -X -A -t -q -f /tmp/check-cast.sql | Out-String)
  Check ($chk0 -match 'check: FAIL' -and $chk0 -match 'not applied') 'check-cast.sql before the forward: FAIL (560 not applied) - the check can fail'
  # pre-560 podcast rows (the shape slot 330 writes and the Open Notebook capture made)
  $plant = "INSERT INTO public.podcast_voice_links (id, owner_sub, route, voice, origin) VALUES ('rt-v', 'lab-rt-owner', 'local-tts', 'bm_george', 'on-capture');" +
    "INSERT INTO public.podcast_presenters (id, owner_sub, name, personality, backstory, voice_link_id, origin) VALUES ('rt-p', 'lab-rt-owner', 'RT Kim', 'calm', 'a background', 'rt-v', 'on-capture');" +
    "INSERT INTO public.podcast_teams (id, owner_sub, name, origin) VALUES ('rt-t', 'lab-rt-owner', 'rt team', 'on-capture');" +
    "INSERT INTO public.podcast_team_members (team_id, position, presenter_id) VALUES ('rt-t', 0, 'rt-p');" +
    "INSERT INTO public.podcast_formats (id, owner_sub, name, team_id, origin) VALUES ('rt-f', 'lab-rt-owner', 'rt format', 'rt-t', 'on-capture');" +
    "INSERT INTO public.podcast_episodes (owner_sub, title, team_id, audio_format, archive_dir) VALUES ('lab-rt-owner', 'rt episode', 'rt-t', 'mp3', '/mounts/podcast-archive/rt');"
  $null = Dk exec $db2 psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c $plant
  Check ($script:rc -eq 0) 'pre-560 podcast rows planted (a voice, presenter, team, member, format, episode)'
  $rowsSql = "select md5(string_agg(x, '|' order by x)) from (select t::text x from public.podcast_voice_links t union all select t::text from public.podcast_presenters t union all select t::text from public.podcast_teams t union all select t::text from public.podcast_team_members t union all select t::text from public.podcast_formats t union all select t::text from public.podcast_episodes t) s"
  $rows0 = Psql $db2 $rowsSql
  $dump = 'pg_dump -U postgres -d openbrain --schema-only --no-owner --no-privileges -n public'
  $dumpF = { param($x) (($x -split "`n") | Where-Object { $_ -notmatch '^\\(un)?restrict ' }) -join "`n" }
  $regSql = "select count(*) from public.contract_registry_entries where registry in ('podcast_format_kinds','podcast_format_uses','podcast_prompt_modes','podcast_grounding_kinds')"
  $d0 = & $dumpF (Dk exec $db2 sh -c "$dump")
  $null = Dk exec $db2 psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/init-cast.sql
  Check ($script:rc -eq 0) 'init-cast.sql forward on a database with podcast rows: no error'
  $d1 = & $dumpF (Dk exec $db2 sh -c "$dump")
  $null = Dk exec $db2 psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/init-cast.sql
  Check ($script:rc -eq 0) 'init-cast.sql forward again: no error'
  $d1b = & $dumpF (Dk exec $db2 sh -c "$dump")
  Check ($d1 -eq $d1b) 'forward twice changes nothing (schema dump identical)'
  Check ((Psql $db2 $regSql) -eq '12') 'twelve cast registry entries after the forward'
  $chk1 = (Dk exec $db2 psql -U postgres -d openbrain -X -A -t -q -f /tmp/check-cast.sql | Out-String)
  Save 'check-cast-forward.log' $chk1
  Check ($chk1 -match 'check: OK' -and $chk1 -notmatch 'check: FAIL') 'check-cast.sql after the forward: OK'
  $old = Psql $db2 "select p.role || '|' || p.stance || '|' || p.system_prompt_mode || '|' || p.shared::text || '|' || coalesce(t.user_seat::text, 'null') || '|' || f.kind || '|' || (array_length(f.use_for, 1) is null)::text || '|' || f.is_default::text from public.podcast_presenters p, public.podcast_teams t, public.podcast_formats f where p.id = 'rt-p' and t.id = 'rt-t' and f.id = 'rt-f'"
  Check ($old -eq '||built|false|null|conversation|true|false') "the pre-560 rows read as not set after the forward ($old)"
  $null = Dk exec $db2 psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "UPDATE public.podcast_presenters SET stance = 'rt stance' WHERE id = 'rt-p'; INSERT INTO public.podcast_presenter_grounding (presenter_id, owner_sub, position, kind, ref) VALUES ('rt-p', 'lab-rt-owner', 0, 'topic', 'rt topic')"
  $null = Dk exec $db2 psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/revert-cast.sql
  Check ($script:rc -eq 0) 'revert-cast.sql applied (with a new field and a grounding row set)'
  $d0b = & $dumpF (Dk exec $db2 sh -c "$dump")
  if ($d0b -ne $d0) { Save 'schema-diff-revert.log' ((Compare-Object ($d0 -split "`n") ($d0b -split "`n") | Out-String)) }
  Check ($d0b -eq $d0) 'the revert restores the schema byte-identically (dump equal to the one before the forward)'
  Check ((Psql $db2 $regSql) -eq '0') 'and removes every cast registry entry'
  $rows1 = Psql $db2 $rowsSql
  Check ($rows1 -eq $rows0 -and $rows0) 'the pre-560 rows are unchanged after forward + revert (md5 of every podcast row)'
  $null = Dk exec $db2 psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/revert-cast.sql
  Check ($script:rc -eq 0) 'revert twice: no error'
  $null = Dk exec $db2 psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/init-cast.sql
  $d2 = & $dumpF (Dk exec $db2 sh -c "$dump")
  if ($d2 -ne $d1) { Save 'schema-diff-reforward.log' ((Compare-Object ($d1 -split "`n") ($d2 -split "`n") | Out-String)) }
  Check ($d2 -eq $d1) 'forward after the revert restores the forward schema exactly'
  $revObjs = (Get-Content -Raw (Join-Path $dockerDir 'revert-cast.sql'))
  Check (($revObjs -notmatch '(?i)DROP TABLE[^;]*(podcast_(presenters|teams|formats|voice_links|team_members|episodes|render_requests)\b|sources|claims|thoughts)')) 'the revert drops no table of slot 330 or of the shared knowledge'
  Save 'schema-roundtrip.log' "forward-twice identical: $($d1 -eq $d1b); revert byte-identical: $($d0b -eq $d0); rows unchanged: $($rows1 -eq $rows0); forward-after-revert identical: $($d2 -eq $d1)"

  Write-Host '[5e] check-cast.sql can FAIL on bad data: each data rule planted alone (one rolled-back transaction each) prints its own FAIL'
  $null = Dk cp (Join-Path $ct 'check-cast-plant.sql') "${db}:/tmp/check-cast-plant.sql"
  $plantOut = ''
  foreach ($rule in @('shared_presenter_private_links', 'shared_team_unshared_members', 'shared_format_unshared_team', 'grounding_cross_owner',
      'team_member_cross_owner', 'format_team_cross_owner', 'voice_cross_owner', 'owners_with_two_defaults', 'teams_over_26_seats',
      'columns_missing', 'grounding_table_without_rls', 'registry_entries')) {
    $po = (Dk exec $db psql -U postgres -d openbrain -X -A -t -q -v ON_ERROR_STOP=1 -v "rule=$rule" -v check=/tmp/check-cast.sql -f /tmp/check-cast-plant.sql | Out-String)
    $plantOut += "== $rule`n$po`n"
    Check (($po -match "check: FAIL \($rule\)") -and ($po -notmatch 'check: OK') -and ($po -notmatch 'malformed array')) "planted $rule -> check: FAIL ($rule)"
  }
  $po = (Dk exec $db psql -U postgres -d openbrain -X -A -t -q -v ON_ERROR_STOP=1 -v rule=none -v check=/tmp/check-cast.sql -f /tmp/check-cast-plant.sql | Out-String)
  $plantOut += "== none (control: the clean base)`n$po`n"
  Check ($po -match 'check: OK' -and $po -notmatch 'check: FAIL') 'control: the clean planted base alone prints check: OK'
  Save 'check-cast-plant.log' $plantOut
  $chk2 = (Dk exec $db psql -U postgres -d openbrain -X -A -t -q -f /tmp/check-cast.sql | Out-String)
  Check ($chk2 -match 'check: OK' -and $chk2 -notmatch 'check: FAIL' -and (Psql $db "select count(*) from public.podcast_presenters where id like 'cc-%'") -eq '0') 'the plants were rolled back: check-cast OK again, no cc- row left'

  Write-Host '[5d] Dredd over the cast routes (generated/openapi.json against the lab workbench; hooks as the contract run)'
  $dreddTag = "rw-dredd:wt-$short"
  $null = Dk image inspect $dreddTag
  if ($script:rc -ne 0) {
    $o = Dk build --label $label -t $dreddTag -f (Join-Path $ct 'dredd.Dockerfile') $ct
    Check ($script:rc -eq 0) "built $dreddTag"
  }
  $script:made.images += $dreddTag
  $gen = Join-Path $wb 'src\contracts\generated'
  $docJson = Get-Content -Raw (Join-Path $gen 'openapi.json') | ConvertFrom-Json
  $castOps = 0
  foreach ($pp in $docJson.paths.PSObject.Properties) { if ($pp.Name -like '/workbench/contract/cast/*') { $castOps += @($pp.Value.PSObject.Properties).Count } }
  $names = Lab-Docker 300 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${gen}:/spec:ro", $dreddTag, '/spec/openapi.json', "http://$P-wb:8000", '--names')
  $castNames = @(($names -replace '\x1b\[[0-9;]*m', '' -split "`n") | Where-Object { $_ -match '^info: (/workbench/contract/cast/.* > 2\d\d > .*)$' } | ForEach-Object { $Matches[1].Trim() })
  Save 'dredd-cast-names.log' ($castNames -join "`n")
  $onlyArgs = @(); foreach ($n in $castNames) { $onlyArgs += @('--only', $n) }
  $o = Lab-Docker 600 (@('run', '--rm', '--label', $label, '--network', $net, '-v', "${gen}:/spec:ro", '-v', "${ct}:/ct:ro", $dreddTag,
      '/spec/openapi.json', "http://$P-wb:8000", '--header', "X-Brain-Key: $key", '--hookfiles=/ct/dredd-hooks.js') + $onlyArgs)
  $clean = ($o -replace [regex]::Escape($key), '***') -replace '\x1b\[[0-9;]*m', ''
  Save 'dredd-cast.log' $clean
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '^(fail|error):|^\s+(expected|real|body)' } | Select-Object -First 40) { Write-Host "    $l" }
  $dm = ([regex]'complete: (\d+) passing, (\d+) failing, (\d+) errors, (\d+) skipped, (\d+) total').Match($clean)
  Check ($dm.Success -and $dm.Groups[2].Value -eq '0' -and $dm.Groups[3].Value -eq '0' -and ([int]$dm.Groups[5].Value - [int]$dm.Groups[4].Value) -eq $castOps -and $castOps -eq 26 -and $castNames.Count -eq $castOps -and [int]$dm.Groups[1].Value -eq $castOps) "Dredd over the cast routes: $($dm.Value) (cast operations in the document: $castOps; 2xx transactions named: $($castNames.Count); every cast one run, the rest left out by --only)"
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
