# run-gaps-tests.ps1 - the disposable lab run for the research workbench redesign item rwr-doc-gaps-api: document gaps
# (document_gaps, slot 650) and "research these", as TWO users, against a real workbench and database.
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-gaps-tests.ps1 -Subnet <x.y.z.0/24> [-Id <owner>] [-Evidence <dir>] [-Red] [-BaseSha <sha>]
#
# -Subnet is REQUIRED (harness-subnet.ps1: exactly a /24 outside Docker's default pools and 192.168.0.0/16);
# -Evidence must be absent or empty. -Red runs THIS tree's gaps integration test against a workbench built from -BaseSha (the
# development pin before rwr-doc-gaps-api): every route case must FAIL there (the chain is this tree's, so the table exists;
# the base workbench has no routes over it). -Prebuilt uses images already built under this run's :wt-<id> tags.
#
# LAB DOCKER SHIM (as run-flags-tests.ps1): every docker call goes through Lab-Docker, which REFUSES a published port, a network
# other than this run's, a network create that is not --internal on the pinned subnet, a macvlan / ipvlan driver, any 192.168.x
# address, any ai-stack_* / open-brain_* name, any :local image, docker compose, and a build tag that is not :wt-<id>[-suffix].
# Everything is labelled ai-stack.harness.owner=<Id> and removed at the end.
#
# What it does:
#   1. stages the REAL initdb chain from docker-compose.yml (the 650 gaps slot included) and, for 5b, the same chain WITHOUT 650
#   2. one internal network on the pinned /25; 3. builds openbrain-workbench:wt-<id> (its build test gate runs src/contracts/
#      incl. gaps_test.ts) and its test stage
#   4. the lab: database (chain + fixtures.sql; the workbench as ob_app_memory, non-superuser), stub embedder, stub research
#      service (stores each job in research_jobs), PostgREST + the OB1 rest Caddy, ONE workbench with WORKSPACE_IDENTITY_HEADER=X-Test-Sub
#   5a. the gaps integration test (src/contracts/gaps_integration_test.ts: G1-G10); afterwards the workbench log is searched
#       for the planted marker prefixes (a gap's text is never logged)
#   5b. the migration round trip: revert, the schema is the pre-650 schema (compared with a second database built WITHOUT 650),
#       forward x2 (idempotent), revert again (same), forward again; the schema dump equals the original forward's
#   5c. Dredd over the gap routes (the list; the others are skipped by the hooks and exercised by 5a)
#   6. the evidence gate, then teardown and the leftover checks
# It never touches the live stack. Exit 0 = every check passed (with -Red: every case FAILED).
param(
  [string]$Id = 'wt-rwr-doc-gaps-api',
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
$P = "rwgap-$rand"
$net = "$P-net"
$wbTag = "openbrain-workbench:wt-$short"; $wbTestTag = "openbrain-workbench:wt-$short-test"
if ($Red) { $wbTag = "openbrain-workbench:wt-$short-base" }
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$key = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
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

try {
  Write-Host "== rwr-doc-gaps-api lab run  owner=$Id  net=$net  red=$([bool]$Red)  evidence=$Evidence"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check (@($chain | Where-Object { $_[1] -eq '650-init-document-gaps.sql' }).Count -eq 1) "the chain mounts 650-init-document-gaps.sql ($($chain.Count) migrations)"
  $stage0 = Join-Path $env:TEMP "$P-initdb0"; New-Item -ItemType Directory -Force $stage0 | Out-Null; $script:made.dirs += $stage0
  foreach ($m in $chain) { if ($m[1] -ne '650-init-document-gaps.sql') { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage0 $m[1]) } }

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
    Save 'build-workbench.log' ((($clean -split "`n") | Where-Object { $_ -match 'gaps|ok \||FAILED|passed|error' } | Select-Object -Last 120) -join "`n")
    Check ($script:rc -eq 0) "$wbTag built at OB1 $($sha.Substring(0, 7)) (its build test gate passed, src/contracts/gaps_test.ts included)"
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
  $tables = (Dk exec $db psql -U postgres -d openbrain -tAc "select string_agg(c.relname || ':' || c.relrowsecurity::text, ',' order by c.relname) from pg_class c where c.relname = 'document_gaps'").Trim()
  Check ($tables -eq 'document_gaps:true') "the gaps store exists with row-level security on ($tables)"
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role) - the production shape'
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
      '-e', "DB_HOST=$db", '-e', 'DB_USER=ob_app_memory', '-e', "DB_PASSWORD=$appPw", '-e', 'OPEN_BRAIN_URL=http://openbrain-rest',
      '-e', 'EMBEDDING_API_BASE=http://stub-embed:8080/v1', '-e', 'EXTRACT_URL=http://unreachable.invalid', '-e', 'WIKI_GIT_DIR=/wiki',
      '-e', 'WIKI_ASSETS_DIR=/wiki/assets', '-e', 'CONTRACT_MOUNTS_ROOT=/mounts', '-e', 'RESEARCH_URL=http://stub-research:8000',
      '-e', "RESEARCH_WORKSPACE_KEY=$wsKey", '-e', 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub',
      '-v', "${vault}:/wiki", '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro")
  $null = Run-Detached "$P-wb" (@('--network-alias', 'openbrain-workbench') + $wbArgs + @($wbTag))
  Check (Wait-Http "http://$P-wb:8000/health" 90) "$P-wb is up"

  Write-Host '[5a] the gaps integration test (G1-G10)'
  $o = Lab-Docker 1200 @('run', '--rm', '--label', $label, '--network', $net,
    '-e', "GAPS_TEST_BASE=http://$P-wb:8000", '-e', "GAPS_TEST_KEY=$key",
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', 'src/contracts/gaps_integration_test.ts')
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save 'gaps-integration.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||^G\d+:|error:|Assertion|=> ' }) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)' }) { Write-Host "    $l" }
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
  if ($Red) { Check ($sum.Success -and [int]$sum.Groups[3].Value -ge 9) "RED: the route cases G1-G10 fail on the base $BaseSha ($($sum.Value))" }
  else { Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0 -and [int]$sum.Groups[2].Value -ge 11) "the gaps integration test ($($sum.Value))" }
  if (-not $Red) {
    $dblog = Dk logs $db
    $wblog = Dk logs "$P-wb"
    $leak = @(($wblog -split "`n") | Where-Object { $_ -match 'G\dsecret|G\dmarker|G\dneeds|G\drot|G\ddup|G\ddis|G\dlocal' })
    Check ($leak.Count -eq 0) "the workbench log carries no gap text (planted markers G1..G7: $($leak.Count) lines)"
    $dbleak = @(($dblog -split "`n") | Where-Object { $_ -match 'G\dsecret|G\dmarker' })
    Check ($dbleak.Count -eq 0) "the database log carries no marker ($($dbleak.Count) lines)"
  }

  if (-not $Red) {
    Write-Host '[5b] the migration round trip (revert = the pre-650 schema; forward x2; revert; forward; the dump compares)'
    $dump = 'pg_dump -U postgres -d openbrain --schema-only --no-owner --no-privileges -n public'
    $dumpF = { param($x) (($x -split "`n") | Where-Object { $_ -notmatch '^\\(un)?restrict ' }) -join "`n" }
    $regSql = "select count(*) from public.contract_registry_entries where registry like 'gap\_%'"
    $reg = { (Dk exec $db psql -U postgres -d openbrain -tAc $regSql).Trim() }
    # the truth: a second database built from the same chain WITHOUT 650
    $db0 = "$P-db0"
    if (-not (Run-Detached $db0 @('-e', "POSTGRES_PASSWORD=$pw", '-e', 'POSTGRES_DB=openbrain', '-v', "${stage0}:/docker-entrypoint-initdb.d:ro", $PgImage))) { throw 'db0' }
    for ($i = 0; $i -lt 150; $i++) { if ((Dk logs $db0) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
    for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db0 pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
    $dPre = & $dumpF (Dk exec $db0 sh -c "$dump")
    Check ($dPre.Length -gt 1000 -and $dPre -notmatch 'document_gaps') 'the chain built without 650: its schema has no gaps object'
    $null = Dk cp (Join-Path $dockerDir 'init-document-gaps.sql') "${db}:/tmp/init-document-gaps.sql"
    $null = Dk cp (Join-Path $dockerDir 'revert-document-gaps.sql') "${db}:/tmp/revert-document-gaps.sql"
    $dOrig = & $dumpF (Dk exec $db sh -c "$dump")
    Check ($dOrig -match 'document_gaps' -and $dOrig -ne $dPre) 'the migrated chain has the gaps objects (its schema differs from the pre-650 one)'
    $regOrig = & $reg
    Check ($regOrig -eq '9') "nine gap registry entries after the chain ($regOrig)"
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/init-document-gaps.sql
    Check ($script:rc -eq 0) 'init-document-gaps.sql re-run on a migrated database: no error'
    $d1b = & $dumpF (Dk exec $db sh -c "$dump")
    Check ($dOrig -eq $d1b) 'forward twice changes nothing (schema dump identical)'
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/revert-document-gaps.sql
    Check ($script:rc -eq 0) 'revert-document-gaps.sql applied'
    $d0 = & $dumpF (Dk exec $db sh -c "$dump")
    if ($d0 -ne $dPre) { Save 'schema-diff-revert.log' ((Compare-Object ($dPre -split "`n") ($d0 -split "`n") | Out-String)) }
    Check ($d0 -eq $dPre) 'forward then revert: the schema dump is byte-identical to the chain built without 650'
    Check ((& $reg) -eq '0') 'the revert removes every gap registry entry'
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/revert-document-gaps.sql
    Check ($script:rc -eq 0) 'revert twice: no error'
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/init-document-gaps.sql
    $d2 = & $dumpF (Dk exec $db sh -c "$dump")
    if ($d2 -ne $dOrig) { Save 'schema-diff.log' ((Compare-Object ($dOrig -split "`n") ($d2 -split "`n") | Out-String)) }
    Check ($d2 -eq $dOrig) 'forward after the revert restores the schema exactly (dump identical to the original)'
    Check ((& $reg) -eq '9') 'and the nine registry entries'
    $revObjs = (Get-Content -Raw (Join-Path $dockerDir 'revert-document-gaps.sql'))
    Check (($revObjs -notmatch '(?i)DROP (TABLE|FUNCTION|TRIGGER)[^;]*(sources|claims|reference|wiki)')) 'the revert drops nothing of the shared knowledge'
    Save 'schema-roundtrip.log' "forward-twice identical: $($dOrig -eq $d1b); revert equals the chain without 650: $($d0 -eq $dPre); forward-after-revert identical: $($d2 -eq $dOrig)"
  }
  if (-not $Red) {
    Write-Host '[5c] Dredd over the gap routes (generated/openapi.json against the lab workbench; hooks as the contract run)'
    $dreddTag = "rw-dredd:wt-$short"
    $null = Dk image inspect $dreddTag
    if ($script:rc -ne 0) {
      $o = Dk build --label $label -t $dreddTag -f (Join-Path $ct 'dredd.Dockerfile') $ct
      Check ($script:rc -eq 0) "built $dreddTag"
      $script:made.images += $dreddTag
    } else { $script:made.images += $dreddTag }
    $gen = Join-Path $wb 'src\contracts\generated'
    $names = Lab-Docker 300 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${gen}:/spec:ro", $dreddTag, '/spec/openapi.json', "http://$P-wb:8000", '--names')
    $flagNames = @(($names -replace '\[[0-9;]*m', '' -split "`n") | Where-Object { $_ -match '^info: (/workbench/contract/gaps.*)$' } | ForEach-Object { $Matches[1].Trim() })
    Save 'dredd-gap-names.log' ($flagNames -join "`n")
    foreach ($l in ($names -split "`n") | Where-Object { $_ -match 'gap' } | Select-Object -First 8) { Write-Host "    names: $l" }
    $onlyArgs = @(); foreach ($n in $flagNames) { $onlyArgs += @('--only', $n) }
    $o = Lab-Docker 600 (@('run', '--rm', '--label', $label, '--network', $net, '-v', "${gen}:/spec:ro", '-v', "${ct}:/ct:ro", $dreddTag,
        '/spec/openapi.json', "http://$P-wb:8000", '--header', "X-Brain-Key: $key", '--hookfiles=/ct/dredd-hooks.js') + $onlyArgs)
    $clean = ($o -replace $key, '***') -replace '\x1b\[[0-9;]*m', ''
    Save 'dredd-gaps.log' $clean
    foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '^(fail|error):|Transaction:.*gap|^\s+(expected|real|body)' } | Select-Object -First 40) { Write-Host "    $l" }
    $dm = ([regex]'complete: (\d+) passing, (\d+) failing, (\d+) errors, (\d+) skipped, (\d+) total').Match($clean)
    # 6 operations; only the list GET is run (the hooks skip create, research and the by-id three): 1 passing
    Check ($dm.Success -and $dm.Groups[2].Value -eq '0' -and $dm.Groups[3].Value -eq '0' -and $flagNames.Count -ge 6 -and [int]$dm.Groups[1].Value -eq 1) "Dredd over the gap routes: $($dm.Value) (gap transactions: $($flagNames.Count); the list is run, the five others are skipped by the hooks and covered by 5a)"
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
