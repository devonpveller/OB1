# run-doc-versions-tests.ps1 - the disposable lab run for rwr-doc-versions-api (research workbench redesign): numbered
# versions, named snapshots, restore, compare (slot 620, document_snapshots).
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-doc-versions-tests.ps1 -Subnet <x.y.z.0/24> [-Id <owner>] [-Evidence <dir>] [-Red] [-NoSweep]
#
# -Subnet is REQUIRED (harness-subnet.ps1: exactly a /24 outside Docker's default pools and 192.168.0.0/16);
# -Evidence must be absent or empty. -Red runs THIS tree's integration test against a workbench built from
# -BaseSha (the OB1 pin before this item): the HTTP cases must FAIL there. -NoSweep skips the viewer build and the
# route-wide isolation sweep (which calls every registered route, the new ones included, as user A with B's ids).
#
# LAB DOCKER SHIM (as run-docs-lifecycle-tests.ps1): every docker call goes through Lab-Docker, which REFUSES a published
# port, a network other than this run's, a network create that is not --internal on the pinned subnet, a macvlan /
# ipvlan driver, any 192.168.x address, any ai-stack_* / open-brain_* name, any :local image, docker compose, and a
# build tag that is not :wt-<id>[-suffix]. Everything is labelled ai-stack.harness.owner=<Id> and removed at the end;
# the run checks nothing labelled <Id> is left and no :local image changed.
#
# What it does:
#   1. stages the REAL initdb chain from docker-compose.yml (slot 620, the snapshots table, included)
#   2. one internal network on the pinned /25
#   3. builds openbrain-workbench:wt-<id> (its build test gate runs src/documents/ with the rest: the unit tests of
#      this item, versions_test.ts, run there) and its test stage (and the viewer, for the sweep)
#   4. the lab: database (chain + fixtures.sql; the workbench as ob_app_memory, non-superuser), stub embedder, stub
#      research service, PostgREST + the OB1 rest Caddy, the workbench (vault = a temp dir, a real git repo)
#   5. src/documents/versions_integration_test.ts (V1-V18) against the workbench; the migration case (check-document-
#      versions.sql; revert, init, revert: a schema-only pg_dump byte-compared before and after; init again); the
#      planted markers searched in the workbench log; then the isolation sweep, response walk on and off
#   6. the evidence gate, then teardown and the leftover checks
# It never touches the live stack. Exit 0 = every check passed (with -Red: every HTTP case FAILED).
param(
  [string]$Id = 'wt-rwr-doc-versions-api',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
  [string]$CaddyImage = 'caddy:2-alpine',
  [string]$BaseSha = '66ddb638',
  [switch]$Red,
  [switch]$Prebuilt,
  [switch]$NoSweep,
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
$P = "rwdv-$rand"
$net = "$P-net"
$wbTag = "openbrain-workbench:wt-$short"; $wbTestTag = "openbrain-workbench:wt-$short-test"; $viewerTag = "openbrain-wiki-viewer:wt-$short"
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
  Write-Host "== rwr-doc-versions-api lab run  owner=$Id  net=$net  red=$([bool]$Red)  evidence=$Evidence"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check (@($chain | Where-Object { $_[1] -eq '620-init-document-versions.sql' }).Count -eq 1) "the chain mounts 620-init-document-versions.sql ($($chain.Count) migrations)"

  Write-Host '[2] the internal network'
  $null = Dk network create --driver bridge --internal --subnet $subnets.run --label $label $net
  Check ($script:rc -eq 0) "network $net (internal, $($subnets.run))"
  if ($script:rc -ne 0) { throw 'network' }
  $script:made.net = $true

  Write-Host '[3] images'
  if ($Prebuilt) {
    foreach ($t in @($wbTag, $wbTestTag) + $(if ($Red -or $NoSweep) { @() } else { @($viewerTag) })) {
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
    Save 'build-workbench.log' ((($clean -split "`n") | Where-Object { $_ -match 'rooms/|ok \||FAILED|passed|error' } | Select-Object -Last 120) -join "`n")
    Check ($script:rc -eq 0) "$wbTag built at OB1 $($sha.Substring(0, 7)) (its build test gate passed, src/rooms/ included)"
    if ($script:rc -ne 0) { throw 'build workbench' }
    $script:made.images += $wbTag
    $gate = ([regex]'ok \| (\d+) passed \| (\d+) failed').Matches($clean)
    if ($gate.Count) { Pass "the workbench build test gate: $($gate[$gate.Count - 1].Value)" }
  if (-not $NoSweep) {
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --build-context "recipes=$(Join-Path $ob1 'recipes')" -t $viewerTag $viewerDir
    $vclean = ($o -replace '\x1b\[[0-9;]*m', '')
    Save 'build-viewer.log' ((($vclean -split "`n") | Where-Object { $_ -match 'room|Test Files|Tests |FAIL|notices' } | Select-Object -Last 80) -join "`n")
    Check ($script:rc -eq 0) "$viewerTag built (its workspace stage: vitest incl. test/room.test.tsx, the D9 notices check, tsc + vite build)"
    if ($script:rc -ne 0) { throw 'build viewer' }
    $script:made.images += $viewerTag
    $vt = ([regex]'Tests\s+(\d+) passed').Match($vclean)
    if ($vt.Success) { Pass "workspace unit tests in the image build: $($vt.Groups[1].Value) passed" }
  }
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
  $tables = (Dk exec $db psql -U postgres -d openbrain -tAc "select string_agg(c.relname || ':' || c.relrowsecurity::text, ',') from pg_class c where c.relname = 'document_snapshots'").Trim()
  Check ($tables -eq 'document_snapshots:true') "slot 620: the snapshots table exists with row-level security on ($tables)"
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role) - the production shape'
  $null = Dk cp (Join-Path $ct 'fixtures.sql') "${db}:/tmp/fixtures.sql"
  # rw-inlet-stamp (slot 470): fixtures.sql is legacy-shaped (an unowned idea thought); the LAB switches 470's guards off
  # around this load only and on again right after (the migration has no escape hatch)
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "DO `$`$ BEGIN IF to_regclass('public.inlet_connections') IS NOT NULL THEN ALTER TABLE public.thoughts DISABLE TRIGGER trg_inlet_stamp_thoughts; ALTER TABLE public.sources DISABLE TRIGGER trg_inlet_stamp_sources; END IF; END `$`$"
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/fixtures.sql
  Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) 'fixtures applied'
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "DO `$`$ BEGIN IF to_regclass('public.inlet_connections') IS NOT NULL THEN ALTER TABLE public.thoughts ENABLE ALWAYS TRIGGER trg_inlet_stamp_thoughts; ALTER TABLE public.sources ENABLE ALWAYS TRIGGER trg_inlet_stamp_sources; END IF; END `$`$"
  $stampState = "$(Dk exec $db psql -U postgres -d openbrain -X -A -t -c "SELECT CASE WHEN to_regclass('public.inlet_connections') IS NULL THEN 'absent' WHEN (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_inlet_stamp_thoughts', 'trg_inlet_stamp_sources') AND tgenabled = 'A') = 2 THEN 'on' ELSE 'off' END")".Trim()
  Check ($stampState -eq 'on' -or ($stampState -eq 'absent' -and @($chain | Where-Object { $_[1] -eq '470-init-inlet-stamp.sql' }).Count -eq 0)) "rw-inlet-stamp: slot 470's guards are PRESENT and ALWAYS-enabled again after the fixture load ($stampState; absent passes only on a chain without slot 470)"

  $ctMount = "${ct}:/ct:ro"
  $null = Run-Detached "$P-embed" @('--network-alias', 'stub-embed', '-v', $ctMount, '--entrypoint', 'deno', $wbTestTag, 'run', '--allow-net', '/ct/stub-embed.ts')
  $null = Run-Detached "$P-research" @('--network-alias', 'stub-research', '-v', $ctMount, '-e', "DB_HOST=$db", '-e', "DB_PASSWORD=$pw",
      '-e', "STUB_CALLERS=workspace=workspace:$wsKey", '--entrypoint', 'deno', $wbTestTag, 'run', '--allow-net', '--allow-env', '--allow-read', '--config', '/app/deno.json', '/ct/stub-research.ts')
  $null = Run-Detached "$P-postgrest" @('--network-alias', 'openbrain-postgrest', '-e', "PGRST_DB_URI=postgres://postgres:$pw@openbrain-db:5432/openbrain",
      '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=service_role', '-e', 'PGRST_DB_POOL=4', '-e', 'PGRST_SERVER_PORT=3000', $PgrstImage)
  $null = Run-Detached "$P-rest" @('--network-alias', 'openbrain-rest', '-v', "$(Join-Path $dockerDir 'Caddyfile'):/etc/caddy/Caddyfile:ro", $CaddyImage)
  if (-not $Red -and -not $NoSweep) {
    $null = Run-Detached "$P-viewer" @('--network-alias', 'openbrain-wiki-viewer', '-e', 'OPEN_BRAIN_URL=http://openbrain-rest', '-e', 'WIKI_NAV_MIN_ROWS=0',
        '-e', 'WIKI_BUILDER=0', '-e', 'WIKI_DB_TCP=openbrain-db:5432', '-e', 'WIKI_DB_PROBE_MS=1000', '-e', 'WIKI_RECONCILE_INTERVAL_MS=5000',
        '-e', 'NODE_OPTIONS=--max-old-space-size=2048', '-e', 'WORKBENCH_URL=http://openbrain-workbench:8000', '-e', "WORKBENCH_KEY=$key",
        '-e', "WIKI_VIEWER_ALLOWED_HOSTS=$P-viewer", '-v', "${vault}:/wiki:ro", $viewerTag)
  }
  $wbArgs = @('-e', 'PORT=8000', '-e', "WORKBENCH_KEY=$key",
      '-e', "DB_HOST=$db", '-e', 'DB_USER=ob_app_memory', '-e', "DB_PASSWORD=$appPw", '-e', 'OPEN_BRAIN_URL=http://openbrain-rest',
      '-e', 'EMBEDDING_API_BASE=http://stub-embed:8080/v1', '-e', 'EXTRACT_URL=http://unreachable.invalid', '-e', 'WIKI_GIT_DIR=/wiki',
      '-e', 'WIKI_ASSETS_DIR=/wiki/assets', '-e', 'CONTRACT_MOUNTS_ROOT=/mounts', '-e', 'RESEARCH_URL=http://stub-research:8000',
      '-e', "RESEARCH_WORKSPACE_KEY=$wsKey", '-e', 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub',
      '-v', "${vault}:/wiki", '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro")
  $null = Run-Detached "$P-wb" (@('--network-alias', 'openbrain-workbench') + $wbArgs + @($wbTag))
  Check (Wait-Http "http://$P-wb:8000/health" 90) 'the workbench is up'
  if (-not $Red -and -not $NoSweep) { Check (Wait-Http "http://$P-viewer:8080/workspace/" 90) 'the front door (the viewer) answers' }

  Write-Host '[5a] the versions integration test (V1-V18): restore v11 at v14, stable numbers across moves, compare = git diff, two users, planted markers, edge cases, concurrency, the table'
  $o = Lab-Docker 3600 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${vault}:/vault",
    '-e', "DOCS_TEST_BASE=http://$P-wb:8000", '-e', "DOCS_TEST_KEY=$key", '-e', 'DOCS_TEST_VAULT=/vault', '-e', 'WIKI_GIT_DIR=/vault',
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', '--allow-write', '--allow-run', 'src/documents/versions_integration_test.ts')
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save 'versions-integration.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||error:|Assertion|=> ' }) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)' }) { Write-Host "    $l" }
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
  if ($Red) {
    # the base has no routes: every HTTP case fails; V10 reads this tree's table (the chain is this tree's) and may pass
    Check ($sum.Success -and [int]$sum.Groups[3].Value -ge 11) "RED: the versions cases fail on the base $BaseSha ($($sum.Value))"
  } else { Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0 -and [int]$sum.Groups[2].Value -ge 25) "the versions integration test ($($sum.Value))" }
  if (-not $sum.Success -or $sum.Groups[1].Value -ne 'ok') { Save 'versions-integration-tail.log' (($clean -split "`n" | Select-Object -Last 60) -join "`n") }

  if (-not $Red) {
    # the planted markers are fixed prefixes in the test: none may reach the workbench's log
    $wlog = Dk logs "$P-wb"
    $hits = @($wlog -split "`n" | Where-Object { $_ -match 'VBODY-|VSNAPNAME-|VTitle|SNAPNAME-|SECRETBODY|APLANT-|BPLANT-|UNSAVED-' })
    Check ($hits.Count -eq 0) "no planted body, snapshot-name or title marker in the workbench log ($($hits.Count) hits)"

    # slot 620: pg_dump 16.x prints a random restrict key on every run (two lines, dropped before the compare); the check script; revert, revert, init, init, revert, init - a schema-only pg_dump after each step
    Write-Host '[5b] check-document-versions.sql, then revert / init / revert in turn with a schema-only pg_dump byte-compared, init again (slot 620)'
    $q = { param($x) (Dk exec $db psql -U postgres -d openbrain -X -tAc $x).Trim() }
    $run620 = { param($f) $null = Dk cp (Join-Path $dockerDir $f) "${db}:/tmp/rv620.sql"; $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/rv620.sql; [pscustomobject]@{ rc = $script:rc; out = $o } }
    $dump = { $null = Dk exec $db sh -c 'pg_dump -U postgres -d openbrain --schema-only --no-owner | grep -v -E "^.(un)?restrict " > /tmp/schema.sql'; ((Dk exec $db sh -c 'md5sum < /tmp/schema.sql; wc -c < /tmp/schema.sql') -split "`n" | ForEach-Object { ($_ -split '\s+')[0] }) -join '/' }
    $mineSql = "SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' ORDER BY ordinal_position) || ' / ' || (SELECT count(*)::text FROM pg_indexes WHERE tablename = 'document_snapshots') || ' idx / ' || (SELECT count(*)::text FROM pg_policies WHERE tablename = 'document_snapshots') || ' pol / ' || (SELECT string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) FROM pg_class cl, aclexplode(cl.relacl) a WHERE cl.oid = 'public.document_snapshots'::regclass) || ' grants' FROM information_schema.columns WHERE table_name = 'document_snapshots'"
    $null = Dk cp (Join-Path $dockerDir 'check-document-versions.sql') "${db}:/tmp/check620.sql"
    $chk = Dk exec $db psql -X -A -t -q -U postgres -d openbrain -f /tmp/check620.sql
    Save 'check-document-versions.log' $chk
    Check (($chk -match 'check: OK') -and ($chk -notmatch 'FAIL')) 'check-document-versions.sql: OK on the chain-built table'
    $dChain = & $dump
    $mine0 = & $q $mineSql
    $steps = @()
    foreach ($f in @('revert-document-versions.sql', 'revert-document-versions.sql', 'init-document-versions.sql', 'init-document-versions.sql', 'revert-document-versions.sql', 'init-document-versions.sql')) {
      $r = & $run620 $f
      $steps += [pscustomobject]@{ f = $f; rc = $r.rc; err = [bool]($r.out -match 'ERROR'); table = (& $q "SELECT (to_regclass('public.document_snapshots') IS NOT NULL)::text"); dump = (& $dump) }
    }
    $mine2 = & $q $mineSql
    $rv = @("chain-built: dump $dChain | $mine0")
    foreach ($s in $steps) { $rv += "[$($s.f)] exit $($s.rc) error=$($s.err) table=$($s.table) dump=$($s.dump)" }
    $rv += "after the last init: $mine2"
    Save 'migration-620.log' ($rv -join "`n")
    foreach ($l in $rv) { Write-Host "    $l" }
    Check (@($steps | Where-Object { $_.rc -eq 0 -and -not $_.err }).Count -eq 6) 'slot 620: revert, revert, init, init, revert, init all exit 0 with no ERROR (each idempotent)'
    # the dump with the table absent: after the first revert, after the second, and after init-then-revert - byte-identical
    Check (($steps[0].table -eq 'false') -and ($steps[0].dump -eq $steps[1].dump) -and ($steps[0].dump -eq $steps[4].dump) -and ($steps[0].dump -match '^[0-9a-f]{32}/\d+$')) "slot 620: the schema-only dump with the table reverted is byte-identical after revert, revert again and init-then-revert ($($steps[0].dump))"
    Check (($steps[2].dump -eq $steps[3].dump) -and ($steps[2].dump -eq $steps[5].dump) -and ($steps[2].dump -eq $dChain) -and ($steps[2].dump -ne $steps[0].dump)) "slot 620: init is idempotent and rebuilds exactly the chain-built schema, byte for byte ($($steps[2].dump))"
    Check (($mine0 -eq $mine2) -and $mine2) 'slot 620: the table (columns, indexes, policy, exact grants) is the same after the last init as the chain built it'
    $chk2 = Dk exec $db psql -X -A -t -q -U postgres -d openbrain -f /tmp/check620.sql
    Check ($chk2 -match 'check: OK') 'check-document-versions.sql: OK after the last init'
  }

  if (-not $Red -and -not $NoSweep) {
    foreach ($walk in @('on', 'off')) {
      if ($walk -eq 'off') {
        $null = Dk rm -f "$P-wb"
        $restart = @('--network-alias', 'openbrain-workbench') + $wbArgs + @('-e', 'WORKSPACE_RESPONSE_WALK=off', $wbTag)
        $null = Dk run -d --name "$P-wb" --label $label --network $net @restart
        Check (($script:rc -eq 0) -and (Wait-Http "http://$P-wb:8000/health" 90)) 'the workbench restarted with the response walk off'
      }
      Write-Host "[5c] the route-wide isolation sweep (as user A, every registered route - the new ones included - both doors; B's data planted; response walk $walk)"
      $o = Lab-Docker 1800 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${vault}:/vault",
        '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro",
        '-e', "SWEEP_BASE=http://$P-wb:8000", '-e', "SWEEP_VIEWER=http://$P-viewer:8080", '-e', "DOCS_TEST_KEY=$key", '-e', 'DOCS_TEST_VAULT=/vault',
        '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
        '-e', "DB_HOST=$db", '-e', 'DB_USER=postgres', '-e', "DB_PASSWORD=$pw", '-e', 'WIKI_GIT_DIR=/vault', '-e', 'OPEN_BRAIN_URL=http://openbrain-rest',
        $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', '--allow-write', '--allow-run', 'src/documents/isolation_sweep_test.ts')
      $clean = ($o -replace '\x1b\[[0-9;]*m', '')
      Save "isolation-sweep-walk-$walk.log" ((($clean -split "`n") | Where-Object { $_ -match '^sweep:|HIT |\.\.\. (ok|FAILED)|^(ok|FAILED) \||error:' }) -join "`n")
      foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '^sweep:|HIT ' } | Select-Object -First 60) { Write-Host "    $l" }
      $sw = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
      Check ($sw.Success -and $sw.Groups[1].Value -eq 'ok' -and [int]$sw.Groups[3].Value -eq 0 -and $clean -match 'sweep: \d+ routes') "the two-user isolation sweep, response walk $walk ($($sw.Value))"
      if (-not $sw.Success -or $sw.Groups[1].Value -ne 'ok') { Save "isolation-sweep-walk-$walk-tail.log" (($clean -split "`n" | Select-Object -Last 40) -join "`n") }
    }
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
