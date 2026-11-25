# run-toplace-tests.ps1 - the disposable lab run for rwr-doc-toplace-api (research workbench redesign): the document's
# "to place" queue (document_pending_refs, slot 630) as TWO users with planted data, against a real workbench and database.
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-toplace-tests.ps1 -Subnet <x.y.z.0/24> [-Id <owner>] [-Evidence <dir>] [-Red] [-BaseSha <sha>] [-NoSweep] [-Mutate]
#
# -Subnet is REQUIRED (harness-subnet.ps1: exactly a /24 outside Docker's default pools and 192.168.0.0/16);
# -Evidence must be absent or empty. -Red runs THIS tree's integration test against a workbench built from -BaseSha (the
# development pin before this item; the table exists from this tree's chain, the base workbench has no routes over it):
# every route case must FAIL there. -NoSweep skips the viewer build and the route-wide isolation sweep (which calls every
# registered route, the new ones included, as user A with B's ids). -Mutate re-runs the integration test against
# deliberately broken copies of the item (the test plan's mutation proofs): each must FAIL a named case, the real tree passes.
# -Prebuilt uses images already built under this run's :wt-<id> tags: openbrain-workbench:wt-<id> (or -base with -Red),
# its -test tag (and the viewer unless -NoSweep). Removed at the end unless -KeepImages.
#
# LAB DOCKER SHIM (as run-docs-lifecycle-tests.ps1): every docker call goes through Lab-Docker, which REFUSES a published
# port, a network other than this run's, a network create that is not --internal on the pinned subnet, a macvlan / ipvlan
# driver, any 192.168.x address, any ai-stack_* / open-brain_* name, any :local image, docker compose, and a build tag that is
# not :wt-<id>[-suffix]. Everything is labelled ai-stack.harness.owner=<Id> and removed at the end; the run checks nothing
# labelled <Id> is left and no :local image changed.
#
# What it does:
#   1. stages the REAL initdb chain from docker-compose.yml WITHOUT slot 630 (the chain mounts it exactly once: checked), so
#      the database starts in its pre-630 state; the pre-630 schema dump is the baseline of the round trip
#   2. one internal network on the pinned /25; 3. builds openbrain-workbench:wt-<id> (its build test gate runs src/contracts/
#      incl. toplace_test.ts) and its test stage (and the viewer, for the sweep)
#   4. the lab: database (chain; then 630 applied by psql -f, as live; fixtures.sql), stub embedder, stub research service,
#      PostgREST + the OB1 rest Caddy, ONE workbench (vault = a temp dir, WORKSPACE_IDENTITY_HEADER=X-Test-Sub)
#   5a. src/contracts/toplace_integration_test.ts (P1-P8) against the workbench; the planted markers searched in its log
#   5b. the migration: forward x2 (identical dump), revert (the dump is BYTE-IDENTICAL to the pre-630 baseline), revert twice,
#       forward again (identical to the first forward); a second database from the full chain (630 mounted) has the same
#       schema; check-document-toplace.sql OK, and FAIL on a planted cross-owner row; the app role's rights are exact
#   5c. Dredd over the routes this item adds (generated/openapi.json against the lab workbench; the by-id operations are
#       skipped by the hooks and exercised by the integration test)
#   5d. the route-wide isolation sweep (both response-walk settings)
# It never touches the live stack. Exit 0 = every check passed (with -Red: every case FAILED).
param(
  [string]$Id = 'wt-rwr-doc-toplace-api',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
  [string]$CaddyImage = 'caddy:2-alpine',
  [string]$BaseSha = '66ddb638',
  [switch]$Red,
  [switch]$Prebuilt,
  [switch]$NoSweep,
  [switch]$Mutate,
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
$P = "rwtp-$rand"
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
function DkLong { Lab-Docker 9000 ([string[]]$args) }

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
  Write-Host "== rwr-doc-toplace-api lab run  owner=$Id  net=$net  red=$([bool]$Red)  evidence=$Evidence"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  # slot 630 is NOT staged: the database starts pre-630 (the round trip's baseline) and 630 is applied by psql -f, as live;
  # a second database from the full chain proves the fresh-volume path gives the same schema (step 5b)
  foreach ($m in $chain) { if ($m[1] -ne '630-init-document-toplace.sql') { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) } }
  Check (@($chain | Where-Object { $_[1] -eq '630-init-document-toplace.sql' }).Count -eq 1) "the chain mounts 630-init-document-toplace.sql exactly once ($($chain.Count) migrations)"

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
  # the pre-630 baseline, then 630 by psql -f (the live path: AFTER 480, BEFORE the new workbench image)
  $dumpCmd = 'pg_dump -U postgres -d openbrain --schema-only --no-owner -n public'
  $dumpF = { param($x) (($x -split "`n") | Where-Object { $_ -notmatch '^\\(un)?restrict ' }) -join "`n" }
  $none = (Dk exec $db psql -U postgres -d openbrain -tAc "select to_regclass('public.document_pending_refs') is null").Trim()
  Check ($none -eq 't') 'the staged chain (no slot 630) has no document_pending_refs: the baseline is pre-630'
  $dPre = & $dumpF (Dk exec $db sh -c "$dumpCmd")
  $null = Dk cp (Join-Path $dockerDir 'init-document-toplace.sql') "${db}:/tmp/init-document-toplace.sql"
  $null = Dk cp (Join-Path $dockerDir 'revert-document-toplace.sql') "${db}:/tmp/revert-document-toplace.sql"
  $null = Dk cp (Join-Path $dockerDir 'check-document-toplace.sql') "${db}:/tmp/check-document-toplace.sql"
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/init-document-toplace.sql
  Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) 'slot 630 applied by psql -f (no error)'
  $dFwd = & $dumpF (Dk exec $db sh -c "$dumpCmd")
  $tables = (Dk exec $db psql -U postgres -d openbrain -tAc "select string_agg(c.relname || ':' || c.relrowsecurity::text, ',') from pg_class c where c.relname = 'document_pending_refs'").Trim()
  Check ($tables -eq 'document_pending_refs:true') "slot 630: the queue exists with row-level security on ($tables)"
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

  Write-Host '[5a] the to-place integration test (P1-P8): add, list, place, trash / restore / move / delete forever, two users with planted data, shared surfaces, bounds, one-step placement'
  $itArgs = @('run', '--rm', '--label', $label, '--network', $net, '-v', "${vault}:/vault",
    '-e', "TOPLACE_TEST_KEY=$key", '-e', 'TOPLACE_TEST_VAULT=/vault', '-e', 'WIKI_GIT_DIR=/vault',
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw")
  $itTest = @($wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', '--allow-write', '--allow-run', 'src/contracts/toplace_integration_test.ts')
  function Run-It([string]$target) {
    $o = Lab-Docker 900 ($itArgs + @('-e', "TOPLACE_TEST_BASE=http://${target}:8000") + $itTest)
    $c = ($o -replace '\x1b\[[0-9;]*m', '')
    $s = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($c)
    $failedCases = @(([regex]'(?m)^(P\d): .*\.\.\. FAILED').Matches($c) | ForEach-Object { $_.Groups[1].Value })
    return @{ clean = $c; sum = $s; failed = $failedCases }
  }
  $r5 = Run-It "$P-wb"
  $clean = $r5.clean; $sum = $r5.sum
  Save 'toplace-integration.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||error:|Assertion|=> ' }) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)' }) { Write-Host "    $l" }
  if ($Red) {
    # the base has no routes: P1-P5, P7 and P8 fail (P6 reads the database, this tree's chain, and the pool close pass)
    Check ($sum.Success -and [int]$sum.Groups[3].Value -ge 7) "RED: the route cases fail on the base $BaseSha ($($sum.Value); failed: $($r5.failed -join ','))"
  } else { Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0 -and [int]$sum.Groups[2].Value -ge 9) "the to-place integration test ($($sum.Value))" }
  if (-not $sum.Success -or $sum.Groups[1].Value -ne 'ok') { Save 'toplace-integration-tail.log' (($clean -split "`n" | Select-Object -Last 60) -join "`n") }

  if (-not $Red) {
    # the planted markers (the test's PLANT- / MARKA- / MARKB-, the bulk quotes, the document titles) are fixed prefixes: none may reach the workbench's log
    $wlog = Dk logs "$P-wb"
    $hits = @($wlog -split "`n" | Where-Object { $_ -match 'PLANT-|MARKA-|MARKB-|bulk-[0-9]|toplace-p[0-9]' })
    Check ($hits.Count -eq 0) "no planted marker, quote or document title in the workbench log ($($hits.Count) hits)"
    Save 'workbench-marker-hits.log' ($hits -join "`n")

    Write-Host '[5b] the migration: forward x2, revert (byte-identical to the pre-630 baseline), revert x2, forward; the fresh-volume chain; the check; the rights'
    $psql = { param($f) Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f $f }
    $null = & $psql /tmp/init-document-toplace.sql
    Check ($script:rc -eq 0) 'init-document-toplace.sql re-run on a migrated database (rows present): no error'
    $dFwd2 = & $dumpF (Dk exec $db sh -c "$dumpCmd")
    Check ($dFwd -ceq $dFwd2) 'forward twice changes nothing (schema dump identical)'
    $rowsBefore = (Dk exec $db psql -U postgres -d openbrain -tAc "select count(*) from public.document_pending_refs").Trim()
    $null = & $psql /tmp/revert-document-toplace.sql
    Check ($script:rc -eq 0) 'revert-document-toplace.sql applied'
    $dRev = & $dumpF (Dk exec $db sh -c "$dumpCmd")
    if ($dRev -cne $dPre) { Save 'schema-diff-revert.log' ((Compare-Object ($dPre -split "`n") ($dRev -split "`n") | Out-String)) }
    Check ($dRev -ceq $dPre) "the reverted schema is BYTE-IDENTICAL to the pre-630 baseline (forward then revert; $($dPre.Length) chars; $rowsBefore queue rows were discarded)"
    Check (($dFwd -cne $dPre) -and ($dFwd -match 'document_pending_refs')) 'and the forward really changed it (the baseline differs from the migrated schema)'
    $null = & $psql /tmp/revert-document-toplace.sql
    Check ($script:rc -eq 0) 'revert twice: no error'
    $null = & $psql /tmp/init-document-toplace.sql
    $dFwd3 = & $dumpF (Dk exec $db sh -c "$dumpCmd")
    if ($dFwd3 -cne $dFwd) { Save 'schema-diff-forward-again.log' ((Compare-Object ($dFwd -split "`n") ($dFwd3 -split "`n") | Out-String)) }
    Check ($dFwd3 -ceq $dFwd) 'forward after the revert restores the schema exactly (dump identical to the first forward)'
    Save 'schema-roundtrip.log' "baseline chars: $($dPre.Length); forward chars: $($dFwd.Length); forward-twice identical: $($dFwd -ceq $dFwd2); revert == baseline: $($dRev -ceq $dPre); forward-after-revert identical: $($dFwd3 -ceq $dFwd)"

    # the fresh-volume path: a second database from the FULL chain (630 mounted at its slot) has the same schema
    $stage2 = Join-Path $env:TEMP "$P-initdb-full"; $script:made.dirs += $stage2
    New-Item -ItemType Directory -Force $stage2 | Out-Null
    foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage2 $m[1]) }
    $db2 = "$P-db2"
    if (Run-Detached $db2 @('--network-alias', 'openbrain-db2', '-e', "POSTGRES_PASSWORD=$pw", '-e', 'POSTGRES_DB=openbrain', '-v', "${stage2}:/docker-entrypoint-initdb.d:ro", $PgImage)) {
      for ($i = 0; $i -lt 150; $i++) { if ((Dk logs $db2) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
      for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db2 pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
      $l2 = Dk logs $db2
      Check (($l2 -match 'PostgreSQL init process complete') -and (@(($l2 -split "`n") | Where-Object { $_ -match 'ERROR:' }).Count -eq 0)) 'a second database ran the FULL chain (630 at its slot) with no ERROR'
      Check ($l2 -match 'document to-place queue: document_pending_refs is in place') 'initdb ran 630 (its notice is in the log)'
      $dChain = & $dumpF (Dk exec $db2 sh -c "$dumpCmd")
      if ($dChain -cne $dFwd) { Save 'schema-diff-chain.log' ((Compare-Object ($dFwd -split "`n") ($dChain -split "`n") | Out-String)) }
      Check ($dChain -ceq $dFwd) 'fresh volume (initdb at slot 630) and live (psql -f on the pre-630 schema) give the same schema'
      $null = Dk cp (Join-Path $dockerDir 'check-document-toplace.sql') "${db2}:/tmp/check.sql"
      $c2 = Dk exec $db2 psql -U postgres -d openbrain -X -A -t -q -f /tmp/check.sql
      Check ($c2 -match 'check: OK') 'check-document-toplace.sql on the fresh-chain database: OK'
      $null = Dk rm -f -v $db2
    }

    # the check script on the lab database (queue rows present from the tests), then a planted cross-owner row must FAIL it
    $chk = Dk exec $db psql -U postgres -d openbrain -X -A -t -q -f /tmp/check-document-toplace.sql
    Save 'check-document-toplace.log' $chk
    Check (($chk -match 'check: OK') -and ($chk -notmatch 'check: FAIL')) 'check-document-toplace.sql on the lab database after the tests: OK'
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "INSERT INTO public.document_pending_refs (owner_sub, actor_sub, path, claim_id, added_from) SELECT l.owner_sub, l.owner_sub, l.path, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'plant' FROM public.user_document_listings l LIMIT 1"
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "UPDATE public.document_pending_refs SET owner_sub = 'planted-other' WHERE added_from = 'plant'"
    $chkBad = Dk exec $db psql -U postgres -d openbrain -X -A -t -q -f /tmp/check-document-toplace.sql
    Check ($chkBad -match 'check: FAIL \(.*cross_owner_rows') 'the check FAILS on a planted cross-owner row (and names it)'
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "DELETE FROM public.document_pending_refs WHERE added_from = 'plant'"
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "GRANT UPDATE ON public.document_pending_refs TO service_role"
    $chkAcl = Dk exec $db psql -U postgres -d openbrain -X -A -t -q -f /tmp/check-document-toplace.sql
    Check ($chkAcl -match 'check: FAIL \(.*grants_exact') 'the check FAILS when a right is widened (grants_exact)'
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "REVOKE UPDATE ON public.document_pending_refs FROM service_role"
    $chk2 = Dk exec $db psql -U postgres -d openbrain -X -A -t -q -f /tmp/check-document-toplace.sql
    Check ($chk2 -match 'check: OK') 'and OK again once both are put back'

    # the app role's rights: read, add and remove; never edit, truncate or drop
    $app = { param($sql) $o = Dk exec -e "PGPASSWORD=$appPw" $db psql -h 127.0.0.1 -U ob_app_memory -d openbrain -X -A -t -q -c $sql; return ($o -replace "`r", '') }
    $one = (Dk exec $db psql -U postgres -d openbrain -X -A -t -q -c "SELECT path FROM public.user_document_listings LIMIT 1").Trim()
    $ins = & $app "INSERT INTO public.document_pending_refs (owner_sub, actor_sub, path, claim_id, added_from) VALUES ('rights', 'rights', '$one', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'rights') RETURNING 1"
    Check ($ins -match '^1') 'ob_app_memory (the workbench role) may INSERT'
    Check ((& $app "SELECT count(*) FROM public.document_pending_refs WHERE owner_sub = 'rights'") -match '^1') 'ob_app_memory may SELECT'
    Check ((& $app "UPDATE public.document_pending_refs SET section = 'x' WHERE owner_sub = 'rights'") -match 'permission denied') 'ob_app_memory may NOT UPDATE'
    Check ((& $app "TRUNCATE public.document_pending_refs") -match 'permission denied') 'ob_app_memory may NOT TRUNCATE'
    Check ((& $app "DELETE FROM public.document_pending_refs WHERE owner_sub = 'rights' RETURNING 1") -match '^1') 'ob_app_memory may DELETE'
    Check ((& $app "DROP TABLE public.document_pending_refs") -match 'must be owner') 'ob_app_memory may NOT DROP'
    # the FK cascade works under the app role's own listing renames and deletes (the cascade needs no grant on the child)
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "INSERT INTO public.user_document_listings (path, title, owner_sub) VALUES ('documents/rights-doc/x.md', 't', 'rights')"
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "INSERT INTO public.document_pending_refs (owner_sub, actor_sub, path, claim_id, added_from) VALUES ('rights', 'rights', 'documents/rights-doc/x.md', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'rights')"
    $null = & $app "UPDATE public.user_document_listings SET path = 'documents/rights-doc/y.md' WHERE path = 'documents/rights-doc/x.md'"
    Check ((Dk exec $db psql -U postgres -d openbrain -X -A -t -q -c "SELECT path FROM public.document_pending_refs WHERE owner_sub = 'rights'").Trim() -eq 'documents/rights-doc/y.md') 'the app role renaming the listing carries the queue (FK ON UPDATE CASCADE)'
    $null = & $app "DELETE FROM public.user_document_listings WHERE path = 'documents/rights-doc/y.md'"
    Check ((Dk exec $db psql -U postgres -d openbrain -X -A -t -q -c "SELECT count(*) FROM public.document_pending_refs WHERE owner_sub = 'rights'").Trim() -eq '0') 'the app role deleting the listing removes the queue (FK ON DELETE CASCADE)'
  }

  if (-not $Red) {
    Write-Host '[5c] Dredd over the routes this item adds (generated/openapi.json against the lab workbench; hooks as the contract run)'
    $dreddTag = "rw-dredd:wt-$short"
    $null = Dk image inspect $dreddTag
    if ($script:rc -ne 0) {
      $o = Dk build --label $label -t $dreddTag -f (Join-Path $ct 'dredd.Dockerfile') $ct
      Check ($script:rc -eq 0) "built $dreddTag"
    }
    $script:made.images += $dreddTag
    # the fixture document the Dredd examples name: its file in the vault and its listing, owned by the default identity
    New-Item -ItemType Directory -Force (Join-Path $vault 'documents') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $vault 'documents\fixture-refinery.md'), "---`ntitle: Fixture refinery document`n---`n`nThe fixture refinery document.`n", (New-Object System.Text.UTF8Encoding $false))
    $null = Dk cp (Join-Path $ct 'fixtures-documents.sql') "${db}:/tmp/fixtures-documents.sql"
    $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/fixtures-documents.sql
    Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) 'the fixture document listings are in place for Dredd'
    $gen = Join-Path $wb 'src\contracts\generated'
    $names = Lab-Docker 300 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${gen}:/spec:ro", $dreddTag, '/spec/openapi.json', "http://$P-wb:8000", '--names')
    $prNames = @(($names -replace '\[[0-9;]*m', '' -split "`n") | Where-Object { $_ -match '^info: .*pending-refs' } | ForEach-Object { ($_ -replace '^info: ', '').Trim() })
    Save 'dredd-toplace-names.log' ((($names -replace '\[[0-9;]*m', '' -split "`n") | Where-Object { $_ -match 'pending' }) -join "`n")
    foreach ($l in $prNames | Select-Object -First 12) { Write-Host "    names: $l" }
    $onlyArgs = @(); foreach ($n in $prNames) { $onlyArgs += @('--only', $n) }
    $o = Lab-Docker 600 (@('run', '--rm', '--label', $label, '--network', $net, '-v', "${gen}:/spec:ro", '-v', "${ct}:/ct:ro", $dreddTag,
        '/spec/openapi.json', "http://$P-wb:8000", '--header', "X-Brain-Key: $key", '--hookfiles=/ct/dredd-hooks.js') + $onlyArgs)
    $clean = ($o -replace $key, '***') -replace '\x1b\[[0-9;]*m', ''
    Save 'dredd-toplace.log' ($clean.Substring(0, [Math]::Min($clean.Length, 15000)))
    Save 'dredd-toplace-pending.log' ((($clean -split "`n") | Where-Object { $_ -match 'pending-refs|complete:' }) -join "`n")
    foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '^(fail|error):|Transaction:.*pending|^\s+(expected|real|body)' } | Select-Object -First 40) { Write-Host "    $l" }
    $dm = ([regex]'complete: (\d+) passing, (\d+) failing, (\d+) errors, (\d+) skipped, (\d+) total').Match($clean)
    # list and add are checked; delete and place act on a row by id (a per-user row the fixture does not seed) and are skipped by the hooks
    Check ($dm.Success -and $dm.Groups[2].Value -eq '0' -and $dm.Groups[3].Value -eq '0' -and $prNames.Count -ge 4 -and [int]$dm.Groups[1].Value -eq 2) "Dredd over the to-place routes: $($dm.Value) (transactions: $($prNames.Count); list and add must PASS; delete and place by id are skipped by the hooks and exercised by the integration test)"
  }

  if ($Mutate -and -not $Red) {
    Write-Host '[5m] mutation proofs: the integration test against deliberately broken copies of the item (each must FAIL a named case)'
    $mut = @(
      @{ id = 'M1'; file = 'src/contracts/repo/pending_refs.ts'; find = 'DELETE FROM public.document_pending_refs WHERE id = $1 AND owner_sub = $2 RETURNING id::text AS id'; repl = 'DELETE FROM public.document_pending_refs WHERE id = $1 RETURNING id::text AS id'; want = 'P4'; what = 'the delete route drops the owner filter' },
      @{ id = 'M2'; file = 'src/contracts/repo/pending_refs.ts'; find = 'WHERE path = $1 AND owner_sub = $2) AS ok'; repl = 'WHERE path = $1) AS ok'; want = 'P4'; what = 'the document check drops the owner (list and add on another user document)' },
      @{ id = 'M3'; file = 'src/contracts/repo/pending_refs.ts'; find = 'WHERE owner_sub = $1 AND path = $2 ORDER BY created_at, id LIMIT $3'; repl = 'WHERE path = $2 AND $1 = $1 ORDER BY created_at, id LIMIT $3'; want = 'P4'; what = 'the list reads every owner row of the path' },
      @{ id = 'M4'; file = 'src/contracts/repo/pending_refs.ts'; find = 'DELETE FROM public.document_pending_refs WHERE id = $1 AND owner_sub = $2 RETURNING ${COLS}'; repl = 'SELECT ${COLS} FROM public.document_pending_refs WHERE id = $1 AND owner_sub = $2'; want = 'P2'; what = 'place no longer removes the row from the queue' },
      @{ id = 'M5'; file = 'src/contracts/repo/pending_refs.ts'; find = 'if (!row) throw new NotFound(NO_REF);'; repl = 'if (!row) throw new NotFound("no pending reference " + id);'; want = 'P4'; what = 'a refusal names the id it was given (not byte-identical to a missing one)' },
      @{ id = 'M6'; file = 'src/contracts/repo/pending_refs.ts'; find = 'if (n >= MAX_PER_DOCUMENT)'; repl = 'if (false)'; want = 'P7'; what = 'the per-document bound is gone' }
    )
    $mutRoot = Join-Path $env:TEMP "$P-mut"; $script:made.dirs += $mutRoot
    foreach ($m in $mut) {
      $dir = Join-Path $mutRoot $m.id
      New-Item -ItemType Directory -Force $dir | Out-Null
      Copy-Item -Recurse -Force (Join-Path $wb 'src') (Join-Path $dir 'src')
      $f = Join-Path $dir ($m.file -replace '/', '\')
      $txt = [System.IO.File]::ReadAllText($f)
      if (-not $txt.Contains($m.find)) { Fail "$($m.id): the text to mutate is not in $($m.file)"; continue }
      [System.IO.File]::WriteAllText($f, $txt.Replace($m.find, $m.repl), (New-Object System.Text.UTF8Encoding $false))
      $mn = "$P-mut-$($m.id.ToLower())"
      $ro = Dk run -d --name $mn --label $label --network $net @wbArgs -v "${dir}\src:/app/src:ro" $wbTag
      $script:made.containers += $mn
      if (-not (Wait-Http "http://${mn}:8000/health" 90)) { Fail "$($m.id): the mutated workbench did not start: $ro"; Save "mutation-$($m.id)-start.log" ((Dk logs --tail 30 $mn) -join "`n"); $null = Dk rm -f -v $mn; continue }
      $rm = Run-It $mn
      Save "mutation-$($m.id).log" ((($rm.clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||error:|Assertion|=> ' }) -join "`n")
      Check ($rm.failed -contains $m.want) "$($m.id) ($($m.what)): $($m.want) FAILS (failed: $($rm.failed -join ',')) - $($rm.sum.Value)"
      $null = Dk rm -f -v $mn
    }
    # the DB-level mutations: break the schema in the lab database, run the integration test, put it back
    $fkOn = "ALTER TABLE public.document_pending_refs DROP CONSTRAINT document_pending_refs_path_fkey; ALTER TABLE public.document_pending_refs ADD CONSTRAINT document_pending_refs_path_fkey FOREIGN KEY (path) REFERENCES public.user_document_listings (path)"
    $dbm = @(
      @{ id = 'M7'; brk = "$fkOn ON DELETE CASCADE"; want = 'P3'; what = 'the FK loses ON UPDATE CASCADE (a move, trash or restore no longer carries the queue)' },
      @{ id = 'M8'; brk = "$fkOn ON UPDATE CASCADE ON DELETE NO ACTION"; want = 'P3'; what = 'the FK loses ON DELETE CASCADE (delete forever leaves or blocks on the queue)' },
      @{ id = 'M9'; brk = 'GRANT UPDATE, TRUNCATE ON public.document_pending_refs TO service_role'; want = 'P6'; what = 'the app role is granted more than SELECT, INSERT, DELETE' },
      @{ id = 'M10'; brk = 'ALTER TABLE public.document_pending_refs DROP CONSTRAINT document_pending_refs_path_fkey'; want = 'P6'; what = 'no FK at all (an orphan row can be inserted)' }
    )
    $fixSql = "DELETE FROM public.document_pending_refs p WHERE NOT EXISTS (SELECT 1 FROM public.user_document_listings l WHERE l.path = p.path); ALTER TABLE public.document_pending_refs DROP CONSTRAINT IF EXISTS document_pending_refs_path_fkey; ALTER TABLE public.document_pending_refs ADD CONSTRAINT document_pending_refs_path_fkey FOREIGN KEY (path) REFERENCES public.user_document_listings (path) ON UPDATE CASCADE ON DELETE CASCADE; REVOKE ALL ON public.document_pending_refs FROM service_role; GRANT SELECT, INSERT, DELETE ON public.document_pending_refs TO service_role"
    foreach ($m in $dbm) {
      $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c $m.brk
      Check ($script:rc -eq 0) "$($m.id): the schema is broken ($($m.what))"
      $rm = Run-It "$P-wb"
      Save "mutation-$($m.id).log" ((($rm.clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||error:|Assertion|=> ' }) -join "`n")
      Check ($rm.failed -contains $m.want) "$($m.id): $($m.want) FAILS (failed: $($rm.failed -join ',')) - $($rm.sum.Value)"
      $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c $fixSql
      Check ($script:rc -eq 0) "$($m.id): the schema is put back"
    }
    $rg = Run-It "$P-wb"
    Check ($rg.sum.Success -and $rg.sum.Groups[1].Value -eq 'ok' -and [int]$rg.sum.Groups[3].Value -eq 0) "the real tree passes again after every mutation ($($rg.sum.Value))"
  }

  if (-not $Red -and -not $NoSweep) {
    foreach ($walk in @('on', 'off')) {
      if ($walk -eq 'off') {
        $null = Dk rm -f "$P-wb"
        $restart = @('--network-alias', 'openbrain-workbench') + $wbArgs + @('-e', 'WORKSPACE_RESPONSE_WALK=off', $wbTag)
        $null = Dk run -d --name "$P-wb" --label $label --network $net @restart
        Check (($script:rc -eq 0) -and (Wait-Http "http://$P-wb:8000/health" 90)) 'the workbench restarted with the response walk off'
      }
      Write-Host "[5d] the route-wide isolation sweep (as user A, every registered route - the new ones included - both doors; B's data planted; response walk $walk)"
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
