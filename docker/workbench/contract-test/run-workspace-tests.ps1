# run-workspace-tests.ps1 - the disposable lab run for research-workbench P2b (rw-p2b-workspace):
# the workspace, the documents API and the viewer that serves /workspace.
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-workspace-tests.ps1 -Subnet <x.y.z.0/24> [-Id <owner>] [-Evidence <dir>] [-Red] [-Cases C1,C7]
#
# -Subnet is REQUIRED (harness-subnet.ps1: exactly a /24 outside Docker's default pools and
# 192.168.0.0/16); -Evidence must be absent or empty. -Red runs the SAME tests against images built
# from -BaseSha (the development pin before P2b): every clause must FAIL there.
#
# LAB DOCKER SHIM: every docker call goes through Lab-Docker, which REFUSES (exit 2, nothing run) a
# published port (-p/-P/--publish*), a network other than this run's (and `none`), a network create
# that is not --internal on the pinned subnet, a macvlan / ipvlan driver, any 192.168.x address, any
# ai-stack_* / open-brain_* name, any :local image, docker compose, and a build tag that is not
# :wt-<id>[-suffix]. Every call has a timeout; every container, the network and every image is
# labelled ai-stack.harness.owner=<Id> and removed at the end (containers with -v), and the run
# checks nothing labelled <Id> is left and no :local image changed.
#
# What it does:
#   1. stages the REAL initdb chain from docker-compose.yml (P2b's 270 slot included)
#   2. one internal network on the pinned /25
#   3. builds openbrain-workbench:wt-<id> (+ its test stage), openbrain-wiki-viewer:wt-<id> (its
#      `workspace` stage runs the workspace's type check, unit tests (vitest) and D9 notices check)
#      and the e2e runner image; with -Red the workbench and viewer come from -BaseSha instead
#   4. the lab: database (chain + fixtures.sql, ob_app_memory non-superuser), stub embedder, stub
#      research service (origin by key), stub egress proxy, PostgREST + the OB1 rest Caddy, the
#      viewer (WIKI_BUILDER=0), the workbench (vault = a temp dir), the portal's real (wiki_app)
#      Caddy snippet as the front door, a headless Chromium
#   5. the documents API integration test (src/documents/documents_integration_test.ts) as
#      ob_app_memory against the :wt workbench; the workspace e2e (workspace.e2e.mjs) through the
#      front door in the headless Chromium; the grammar copy byte-identity check
#   6. the evidence gate (evidence-gate.ps1), then teardown and the leftover checks
# It never touches the live stack. Exit 0 = every check passed (with -Red: every case FAILED).
param(
  [string]$Id = 'wt-rw-p2b-workspace',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
  [string]$CaddyImage = 'caddy:2-alpine',
  [string]$ChromeImage = 'chromedp/headless-shell@sha256:53cc0f33c0598ff244f6e45458f6dfaf0ae4206d388ae7364903afd1d9d14f0a',
  [string]$BaseSha = '767c461',
  [switch]$Red,
  [string]$Cases = '',
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
$repo = Split-Path -Parent $ob1
$viewerDir = Join-Path $dockerDir 'wiki-viewer'
$wsDir = Join-Path $viewerDir 'workspace'
$short = ($Id -replace '^wt-', '')
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$P = "rwp2b-$rand"
$net = "$P-net"
$wbTag = "openbrain-workbench:wt-$short"; $wbTestTag = "openbrain-workbench:wt-$short-test"
$viewerTag = "openbrain-wiki-viewer:wt-$short"; $e2eTag = "openbrain-workspace-e2e:wt-$short"
if ($Red) { $wbTag = "openbrain-workbench:wt-$short-base"; $wbTestTag = "openbrain-workbench:wt-$short-test"; $viewerTag = "openbrain-wiki-viewer:wt-$short-base" }
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$key = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$wsKey = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
$evStage = Join-Path $env:TEMP "$P-evstage"; New-Item -ItemType Directory -Force $evStage | Out-Null
$shots = Join-Path $env:TEMP "$P-shots"; New-Item -ItemType Directory -Force $shots | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$vault = Join-Path $env:TEMP "$P-vault"; New-Item -ItemType Directory -Force $vault | Out-Null
# the vault files of fixtures.sql's wiki_pages rows, written BEFORE the rows (older than them): a row
# with no file is an orphan, which the viewer presents as pending and its health counts as drift
foreach ($fx in @(@('content/tool/tool-fixture', 'Tool Fixture', 'An entity page about contract retrieval fixtures.'),
    @('content/source/11111111-1111-4111-8111-111111111111', 'Active fixture source', 'Leaf.'),
    @('content/source/22222222-2222-4222-8222-222222222222', 'Suppressed fixture source', 'Leaf.'))) {
  $fxPath = Join-Path $vault ($fx[0] + '.md')
  New-Item -ItemType Directory -Force (Split-Path -Parent $fxPath) | Out-Null
  [System.IO.File]::WriteAllText($fxPath, "---`ntitle: $($fx[1])`n---`n$($fx[2])`n", (New-Object System.Text.UTF8Encoding $false))
}
$frontCfg = Join-Path $env:TEMP "$P-front"; New-Item -ItemType Directory -Force $frontCfg | Out-Null
. (Join-Path $PSScriptRoot 'evidence-gate.ps1')

$script:fail = 0
$script:made = @{ net = $false; containers = @(); images = @(); dirs = @($evStage, $stage, $vault, $frontCfg, $shots) }
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $evStage $name), $text, (New-Object System.Text.UTF8Encoding $false)) }

# -- the lab docker shim ------------------------------------------------------------------
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
    # a :local image is never run, built, tagged or removed (listing and inspecting them is read-only)
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
# Positional only: a docker flag such as -t or -a must never bind to a parameter of this function.
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

# the shim's own RED: each refused shape is refused before docker runs
$shimCases = @(
  @('run', '-p', '8080:8080', 'x'), @('run', '--network', 'ai-stack_app-net', 'x'), @('network', 'create', '--driver', 'macvlan', 'n'),
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
    $null = Dk run --rm --label $label --network $net --entrypoint node $viewerTag -e "fetch('$url').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
    if ($script:rc -eq 0) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}
function Build-At([string]$sha, [string]$tag, [string]$target, [string]$what) {
  # a pristine tree of OB1 at $sha (git archive): the RED images, never the working tree
  $tree = Join-Path $env:TEMP "$P-tree-$sha"
  if (-not (Test-Path $tree)) {
    New-Item -ItemType Directory -Force $tree | Out-Null
    $script:made.dirs += $tree
    $tar = Join-Path $env:TEMP "$P-$sha.tar"
    & git -C $ob1 archive --format=tar -o $tar $sha
    & tar -xf $tar -C $tree
    Remove-Item -Force $tar
  }
  $ctx = if ($what -eq 'workbench') { Join-Path $tree 'docker/workbench' } else { Join-Path $tree 'docker/wiki-viewer' }
  $args2 = @('build', '--label', $label, '--build-arg', "OB1_SHA=$sha", '-t', $tag)
  if ($target) { $args2 += @('--target', $target) }
  if ($what -eq 'viewer') { $args2 += @('--build-context', "recipes=$(Join-Path $tree 'recipes')") }
  return DkLong @args2 $ctx
}

try {
  Write-Host "== rw-p2b-workspace lab run  owner=$Id  net=$net  red=$([bool]$Red)  evidence=$Evidence"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  # ---------------------------------------------------------------- 1. the initdb chain
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check (@($chain | Where-Object { $_[1] -eq '270-init-documents.sql' }).Count -eq 1) "the chain mounts 270-init-documents.sql ($($chain.Count) migrations)"

  # ---------------------------------------------------------------- 2. network
  Write-Host '[2] the internal network'
  $null = Dk network create --driver bridge --internal --subnet $subnets.run --label $label $net
  Check ($script:rc -eq 0) "network $net (internal, $($subnets.run))"
  if ($script:rc -ne 0) { throw 'network' }
  $script:made.net = $true

  # ---------------------------------------------------------------- 3. images
  Write-Host '[3] images'
  if ($Red) {
    $o = Build-At $BaseSha $wbTag '' 'workbench'; Save 'build-workbench-base.log' $o
    Check ($script:rc -eq 0) "RED: $wbTag built from OB1 $BaseSha"
    $script:made.images += $wbTag
    $o = Build-At $BaseSha $viewerTag '' 'viewer'; Save 'build-viewer-base.log' ($o -split "`n" | Select-Object -Last 60 | Out-String)
    Check ($script:rc -eq 0) "RED: $viewerTag built from OB1 $BaseSha"
    $script:made.images += $viewerTag
  } else {
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" -t $wbTag $wb; Save 'build-workbench.log' ($o -split "`n" | Select-Object -Last 80 | Out-String)
    Check ($script:rc -eq 0) "$wbTag built at OB1 $($sha.Substring(0, 7)) (its test gate passed: grammar, hub clustering, contracts, export)"
    if ($script:rc -ne 0) { throw 'build workbench' }
    $script:made.images += $wbTag
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --build-context "recipes=$(Join-Path $ob1 'recipes')" -t $viewerTag $viewerDir
    Save 'build-viewer.log' ($o -split "`n" | Select-Object -Last 120 | Out-String)
    Check ($script:rc -eq 0) "$viewerTag built (its workspace stage: vitest, the D9 notices check, tsc + vite build)"
    if ($script:rc -ne 0) { throw 'build viewer' }
    $script:made.images += $viewerTag
    $vt = ([regex]'Tests\s+(\d+) passed').Match(($o -replace '\x1b\[[0-9;]*m', ''))
    if ($vt.Success) { Pass "workspace unit tests in the image build: $($vt.Groups[1].Value) passed" }
  }
  # the integration test runs from THIS tree's test stage in both modes (RED: against the base workbench)
  $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --target test -t $wbTestTag $wb; Save 'build-workbench-test.log' ($o -split "`n" | Select-Object -Last 40 | Out-String)
  Check ($script:rc -eq 0) "$wbTestTag (the test stage) built"
  $script:made.images += $wbTestTag
  $o = DkLong build --label $label -t $e2eTag (Join-Path $wsDir 'e2e'); Save 'build-e2e.log' ($o -split "`n" | Select-Object -Last 20 | Out-String)
  Check ($script:rc -eq 0) "$e2eTag (playwright-core + pg, lab only) built"
  $script:made.images += $e2eTag

  # ---------------------------------------------------------------- 4. the lab
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
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role) - the production shape'
  $null = Dk cp (Join-Path $ct 'fixtures.sql') "${db}:/tmp/fixtures.sql"
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/fixtures.sql
  Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) 'fixtures applied'

  $ctMount = "${ct}:/ct:ro"
  $null = Run-Detached "$P-embed" @('--network-alias', 'stub-embed', '-v', $ctMount, '--entrypoint', 'deno', $wbTag, 'run', '--allow-net', '/ct/stub-embed.ts')
  $null = Run-Detached "$P-research" @('--network-alias', 'stub-research', '-v', $ctMount, '-e', "DB_HOST=$db", '-e', "DB_PASSWORD=$pw",
      '-e', "STUB_CALLERS=workspace=workspace:$wsKey", '--entrypoint', 'deno', $wbTag, 'run', '--allow-net', '--allow-env', '--allow-read', '--config', '/app/deno.json', '/ct/stub-research.ts')
  $null = Run-Detached "$P-proxy" @('--network-alias', 'stub-proxy', '-v', $ctMount, '--entrypoint', 'deno', $wbTag, 'run', '--allow-net', '/ct/stub-proxy.ts')
  $null = Run-Detached "$P-postgrest" @('--network-alias', 'openbrain-postgrest', '-e', "PGRST_DB_URI=postgres://postgres:$pw@openbrain-db:5432/openbrain",
      '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=service_role', '-e', 'PGRST_DB_POOL=4', '-e', 'PGRST_SERVER_PORT=3000', $PgrstImage)
  $null = Run-Detached "$P-rest" @('--network-alias', 'openbrain-rest', '-v', "$(Join-Path $dockerDir 'Caddyfile'):/etc/caddy/Caddyfile:ro", $CaddyImage)
  $null = Run-Detached "$P-viewer" @('--network-alias', 'openbrain-wiki-viewer', '-e', 'OPEN_BRAIN_URL=http://openbrain-rest', '-e', 'WIKI_NAV_MIN_ROWS=0',
      '-e', 'WIKI_BUILDER=0', '-e', 'WIKI_DB_TCP=openbrain-db:5432', '-e', 'WIKI_DB_PROBE_MS=1000', '-e', 'WIKI_RECONCILE_INTERVAL_MS=5000',
      '-e', 'NODE_OPTIONS=--max-old-space-size=2048', '-e', 'WORKBENCH_URL=http://openbrain-workbench:8000', '-e', "WORKBENCH_KEY=$key",
      '-v', "${vault}:/wiki:ro", $viewerTag)
  $null = Run-Detached "$P-wb" @('--network-alias', 'openbrain-workbench', '-e', 'PORT=8000', '-e', "WORKBENCH_KEY=$key",
      '-e', "DB_HOST=$db", '-e', 'DB_USER=ob_app_memory', '-e', "DB_PASSWORD=$appPw", '-e', 'OPEN_BRAIN_URL=http://openbrain-rest',
      '-e', 'EMBEDDING_API_BASE=http://stub-embed:8080/v1', '-e', 'EXTRACT_URL=http://unreachable.invalid', '-e', 'WIKI_GIT_DIR=/wiki',
      '-e', 'WIKI_ASSETS_DIR=/wiki/assets', '-e', 'CONTRACT_MOUNTS_ROOT=/mounts', '-e', 'RESEARCH_URL=http://stub-research:8000',
      '-e', "RESEARCH_WORKSPACE_KEY=$wsKey", '-e', 'FETCH_PROXY_URL=http://stub-proxy:3128', '-e', "VIEWER_NAV_URL=http://$P-viewer:8082",
      '-e', 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub',
      '-v', "${vault}:/wiki", '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro", $wbTag)
  # the portal's REAL (wiki_app) snippet as the front door
  $cf = Get-Content -Raw (Join-Path $repo 'portal/config/caddy/Caddyfile')
  $snip = ([regex]'(?ms)^\(wiki_app\) \{.*?^\}').Match($cf).Value
  Check ([bool]$snip) 'the portal Caddyfile has its (wiki_app) snippet'
  [System.IO.File]::WriteAllText((Join-Path $frontCfg 'Caddyfile'), "{`n`tadmin off`n`tauto_https off`n}`n$snip`n:8080 {`n`timport wiki_app`n}`n", (New-Object System.Text.UTF8Encoding $false))
  $null = Run-Detached "$P-front" @('-e', "WORKBENCH_KEY=$key", '-v', "${frontCfg}:/etc/caddy:ro", '-v', "$(Join-Path $repo 'portal/config/caddy/site'):/srv/site:ro", $CaddyImage)
  $null = Run-Detached "$P-chrome" @('--shm-size=1g', $ChromeImage)
  Check (Wait-Http "http://$P-wb:8000/health" 90) 'the workbench is up'
  # /workspace/, not /__health: the viewer's health reports the lab wiki's reconcile state, not the door
  Check (Wait-Http "http://$P-front:8080/workspace/" 90) 'the front door answers'
  # the new edge (operator 2026-10-28): Traefik targets the VIEWER alone - it serves /workspace and
  # forwards /workbench/* with the key server-side, dropping any key a client sends
  $edge = Dk run --rm --label $label --network $net --entrypoint node $viewerTag --input-type=module -e "
    const v = 'http://$P-viewer:8080';
    const ws = await fetch(v + '/workspace/'); const wsBody = await ws.text();
    const docs = await fetch(v + '/workbench/contract/documents', { headers: { 'x-brain-key': 'forged-by-the-client' } });
    const bare = await fetch('http://$P-wb:8000/workbench/contract/documents', { headers: { 'x-brain-key': 'forged-by-the-client' } });
    console.log('workspace', ws.status, ws.headers.get('x-wiki-render'), wsBody.includes('id=\x22root\x22'));
    console.log('forwarded', docs.status, 'direct-with-forged-key', bare.status);"
  Save 'edge-viewer.log' $edge
  Check ($edge -match 'workspace 200 workspace true') 'the viewer serves /workspace (x-wiki-render: workspace)'
  Check ($edge -match 'forwarded 200 direct-with-forged-key 401') 'the viewer forwards /workbench/* with the key injected server-side; a client key is never trusted'
  $chromeIp = (Dk inspect -f "{{(index .NetworkSettings.Networks `"$net`").IPAddress}}" "$P-chrome").Trim()
  Check ($chromeIp -match '^\d+\.\d+\.\d+\.\d+$') 'the headless Chromium is on the network'

  # ---------------------------------------------------------------- 5. the tests
  Write-Host '[5a] the documents API integration test (as ob_app_memory? no: the fault trigger needs the superuser; the workbench itself runs as ob_app_memory)'
  $o = Lab-Docker 900 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${vault}:/vault",
    '-e', "DOCS_TEST_BASE=http://$P-wb:8000", '-e', "DOCS_TEST_KEY=$key", '-e', 'DOCS_TEST_VAULT=/vault', '-e', 'DOCS_TEST_PROXY_HOST=stub-proxy',
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', 'src/documents/documents_integration_test.ts')
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save 'documents-integration.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||passed|failed' }) -join "`n")
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)' }) { Write-Host "    $l" }
  if ($Red) { Check ($sum.Success -and [int]$sum.Groups[2].Value -eq 0) "RED: the integration test fails on the base ($($sum.Value))" }
  else { Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0) "the documents API integration test ($($sum.Value))" }

  Write-Host '[5b] the workspace e2e in a headless Chromium, through the front door'
  $o = Lab-Docker 1200 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${shots}:/ev", '-e', "FRONT=http://$P-front:8080",
    '-e', "CDP=http://${chromeIp}:9222", '-e', "PGHOST=$db", '-e', "PGPASSWORD=$pw", '-e', "CASES=$Cases", $e2eTag)
  Save 'workspace-e2e.log' ((($o -replace '\x1b\[[0-9;]*m', '') -split "`n" | Where-Object { $_ -match '^\s+(PASS|FAIL)|^E2E:' }) -join "`n")
  foreach ($l in ($o -split "`n") | Where-Object { $_ -match '^\s+(PASS|FAIL)|^E2E:' }) { Write-Host "    $l" }
  $e2e = ([regex]'E2E: (\d+) passed, (\d+) failed').Match($o)
  if ($Red) { Check ($e2e.Success -and [int]$e2e.Groups[1].Value -eq 0) "RED: every e2e case fails on the base ($($e2e.Value))" }
  else { Check ($e2e.Success -and [int]$e2e.Groups[2].Value -eq 0) "the workspace e2e ($($e2e.Value))" }
  if (-not $e2e.Success) { Save 'workspace-e2e-tail.log' (($o -split "`n" | Select-Object -Last 40) -join "`n") }

  Write-Host '[5c] the grammar copy'
  $a = [System.IO.File]::ReadAllBytes((Join-Path $wb 'src/documents/grammar.ts'))
  $b = [System.IO.File]::ReadAllBytes((Join-Path $wsDir 'src/lib/grammar.ts'))
  Check ([Convert]::ToBase64String($a) -eq [Convert]::ToBase64String($b)) 'the workspace grammar is byte-identical to the documents API grammar'

  # D12 at the end of everything: no user document became a page
  $rows = (Dk exec $db psql -U postgres -d openbrain -tAc "select count(*) from wiki_pages where slug like 'documents/%'").Trim()
  if (-not $Red) { Check ($rows -eq '0') "no wiki_pages row for any user document ($rows)" }
  Save 'viewer.log' ((Dk logs --tail 60 "$P-viewer") -replace [regex]::Escape($key), '<key>')
  Save 'workbench.log' ((Dk logs --tail 120 "$P-wb") -replace [regex]::Escape($key), '<key>')
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
  if (-not $KeepImages) {
    $leftImg = @($script:made.images | Where-Object { (Dk image inspect $_ 2>$null) -and $script:rc -eq 0 })
    Check ($leftImg.Count -eq 0) "no image of this run is left ($($leftImg -join ', '))"
  }
  $localAfter = LocalSnapshot
  Check ((($localBefore -join "`n") -eq ($localAfter -join "`n"))) 'no :local image changed'
  # the evidence gate: redacted logs only (screenshots are never published)
  $uuids = Get-FixtureUuids (Get-Content -Raw (Join-Path $ct 'fixtures.sql'))
  $ftext = Get-FixtureText @((Join-Path $ct 'fixtures.sql'))
  $pub = Publish-Evidence $evStage $Evidence @() { param($d, $c) @() } $uuids $ftext
  Write-Host "  evidence: published=$($pub.published) files=$($pub.files) dropped=$(@($pub.dropped).Count) -> $Evidence"
  foreach ($d in $script:made.dirs) { if (Test-Path $d) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } }
}
Write-Host "== $(if ($script:fail) { "FAILED ($($script:fail))" } else { 'ALL PASSED' })"
exit $(if ($script:fail) { 1 } else { 0 })
