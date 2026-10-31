# run-sessions-tests.ps1 - the disposable lab run for rw-p4b-sessions (research-workbench P4b: running
# sessions, steer / cancel / narrow / add-source from the card, the research flow), over the REAL research
# service and the REAL workbench, signed in by Authentik forward-auth tokens a lab signer mints (the
# run-identity-tests.ps1 shape; users alice, bob, carol, dave, an admin and prof = WORKSPACE_DEFAULT_SUB).
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-sessions-tests.ps1 -Subnet <x.y.z.0/24> [-Id <owner>] [-Evidence <dir>] [-Red]
#
# -Subnet is REQUIRED (harness-subnet.ps1); -Evidence must be absent or empty. -Red runs THIS tree's
# integration test (mounted) against the workbench, viewer and research images built from -BaseSha
# (bc6d3a6, the pre-P4b head): every case must FAIL there. Without -Red: the integration test, then the
# route-wide isolation sweep signed in (carol vs dave and the admin vs dave with the response walk on;
# carol vs dave with it off) - B also steers B's own session from its card, so the steer text, its
# branch and its step ids are planted where every route can reach them.
#
# LAB DOCKER SHIM (as run-identity-tests.ps1): every docker call goes through Lab-Docker, which REFUSES
# (exit 2, nothing run) a published port, a network other than this run's (and `none`), a network
# create that is not --internal on the pinned subnet, a macvlan / ipvlan driver, any 192.168.x
# address, any ai-stack_* / open-brain_* name, any :local image, docker compose, and a build tag that
# is not :wt-<id>[-suffix]. Everything is labelled ai-stack.harness.owner=<Id> and removed at the end
# (containers with -v); the run checks nothing labelled <Id> is left and no :local image changed.
#
# What it does:
#   1. stages the REAL initdb chain from docker-compose.yml (this item's 320 slot included)
#   2. one internal network on the pinned /25
#   3. builds openbrain-workbench:wt-<id> (+ its test stage: src/sessions/ unit tests in its gate),
#      openbrain-wiki-viewer:wt-<id> (the workspace's vitest, sessions.test.tsx included),
#      openbrain-research:wt-<id> (its offline suite, sessions-authority.test.ts included); -Red: the
#      three from -BaseSha and the base's test stage
#   4. the lab: database (chain + fixtures.sql, ob_app_memory non-superuser), stub embedder, stub gateway
#      (holds every model call open, so a claimed job stays running), PostgREST + the OB1 rest Caddy, the
#      research service (caller keys: owui, agent-org = mattermost, digest = notebook, workspace; the
#      shared key = manual), the viewer, the workbench WITH forward-auth and WORKSPACE_OWUI_BASE_URL set,
#      and a second workbench with NO sign-in and the setting blank (single-user mode)
#   5. src/sessions/sessions_integration_test.ts; then (not -Red) the isolation sweeps; the 320 slot
#      re-applied (idempotent) and its revert checked
#   6. the evidence gate, teardown and the leftover checks
# It never touches the live stack. Exit 0 = every check passed (with -Red: every case FAILED).
param(
  [string]$Id = 'wt-rw-p4b-sessions',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
  [string]$CaddyImage = 'caddy:2-alpine',
  [string]$BaseSha = 'bc6d3a6',
  [switch]$Red,
  [switch]$KeepImages,
  [switch]$SkipSweeps
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
$rsDir = Join-Path $ob1 'integrations\research-service'
$short = ($Id -replace '^wt-', '')
function Rand([int]$n, [string]$set = 'hex') {
  $chars = if ($set -eq 'hex') { 48..57 + 97..102 } else { 48..57 + 97..122 }
  -join (1..$n | ForEach-Object { [char]($chars | Get-Random) })
}
$rand = Rand 6
$P = "rwss-$rand"
$net = "$P-net"
$sfx = if ($Red) { '-base' } else { '' }
$wbTag = "openbrain-workbench:wt-$short$sfx"; $wbTestTag = "openbrain-workbench:wt-$short-test$sfx"
$viewerTag = "openbrain-wiki-viewer:wt-$short$sfx"; $rsTag = "openbrain-research:wt-$short$sfx"
$pw = Rand 24 'alnum'; $appPw = Rand 24 'alnum'
$key = Rand 32; $door = Rand 32; $wsKey = Rand 32; $kOwui = Rand 32; $kAo = Rand 32; $kNb = Rand 32; $faSecret = Rand 64 'alnum'
$secrets = @($pw, $appPw, $key, $door, $wsKey, $kOwui, $kAo, $kNb, $faSecret)
$users = @(
  @{ login = 'alice'; sub = (Rand 64); name = 'Alice Lab'; groups = @('lab-users') },
  @{ login = 'bob'; sub = (Rand 64); name = 'Bob Lab'; groups = @('lab-users') },
  @{ login = 'carol'; sub = (Rand 64); name = 'Carol Lab'; groups = @('lab-users') },
  @{ login = 'dave'; sub = (Rand 64); name = 'Dave Lab'; groups = @('lab-users') },
  @{ login = 'admin'; sub = (Rand 64); name = 'Admin Lab'; groups = @('lab-users', 'research-admins') },
  @{ login = 'prof'; sub = (Rand 64); name = 'Prof Lab'; groups = @('lab-users') })
$usersJson = (ConvertTo-Json -Compress -Depth 4 @($users | ForEach-Object { [pscustomobject]$_ }))
$daveSub = ($users | Where-Object { $_.login -eq 'dave' }).sub
$profSub = ($users | Where-Object { $_.login -eq 'prof' }).sub
$issuer = 'https://authentik.lab.invalid/application/o/research-lab/'
$faClient = 'research-proxy-lab'
$owuiBase = 'https://owui.lab.invalid'
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
$evStage = Join-Path $env:TEMP "$P-evstage"; New-Item -ItemType Directory -Force $evStage | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$vault = Join-Path $env:TEMP "$P-vault"; New-Item -ItemType Directory -Force $vault | Out-Null
$vault2 = Join-Path $env:TEMP "$P-vault-plain"; New-Item -ItemType Directory -Force $vault2 | Out-Null
foreach ($fx in @(@('content/tool/tool-fixture', 'Tool Fixture', 'An entity page about contract retrieval fixtures.'),
    @('content/source/11111111-1111-4111-8111-111111111111', 'Active fixture source', 'Leaf.'))) {
  $fxPath = Join-Path $vault ($fx[0] + '.md')
  New-Item -ItemType Directory -Force (Split-Path -Parent $fxPath) | Out-Null
  [System.IO.File]::WriteAllText($fxPath, "---`ntitle: $($fx[1])`n---`n$($fx[2])`n", (New-Object System.Text.UTF8Encoding $false))
}
. (Join-Path $PSScriptRoot 'evidence-gate.ps1')

$script:fail = 0
$script:made = @{ net = $false; containers = @(); images = @(); dirs = @($evStage, $stage, $vault, $vault2) }
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Redact([string]$t) { foreach ($s in $secrets) { if ($s) { $t = $t -replace [regex]::Escape($s), '<redacted>' } }; return ($t -replace 'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*', '<jwt>') }
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $evStage $name), (Redact $text), (New-Object System.Text.UTF8Encoding $false)) }

# -- the lab docker shim (the run-identity-tests.ps1 rules) ---------------------------------
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
      if ($a[$i] -eq '-t' -and $a[$i + 1] -notmatch ":wt-$([regex]::Escape($short))(-[a-z0-9]+)*$") { return "a build tag that is not :wt-$short ($($a[$i + 1]))" }
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
  @('run', '-p', '8080:8080', 'x'), @('run', '--network', 'ai-stack_app-net', 'x'), @('network', 'create', '--driver', 'macvlan', 'n'),
  @('network', 'create', 'n'), @('run', 'openbrain-workbench:local'), @('run', '-e', 'X=192.168.1.20', 'x'), @('compose', 'up'),
  @('build', '-t', 'openbrain-workbench:local', '.'), @('run', '--publish=1:1', 'x'))
$shimRefused = @($shimCases | Where-Object { Test-LabDockerArgs $_ }).Count
Check ($shimRefused -eq $shimCases.Count) "the lab docker shim refuses every forbidden shape ($shimRefused / $($shimCases.Count))"

function LocalSnapshot { (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim() -split "`n" | Sort-Object }
$localBefore = LocalSnapshot

function Run-Detached([string]$name, [string[]]$extra) {
  $o = Dk run -d --name $name --label $label --network $net @extra
  if ($script:rc -ne 0) { Fail "$name did not start: $(Redact $o)"; return $false }
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
function Unpack-At([string]$sha) {
  $tree = Join-Path $env:TEMP "$P-tree-$sha"
  if (-not (Test-Path $tree)) {
    New-Item -ItemType Directory -Force $tree | Out-Null
    $script:made.dirs += $tree
    $tar = Join-Path $env:TEMP "$P-$sha.tar"
    & git -C $ob1 archive --format=tar -o $tar $sha
    # Windows' own tar: a GNU tar first on PATH (Git Bash) reads 'C:\...' as a remote host
    & (Join-Path $env:SystemRoot 'System32/tar.exe') -xf $tar -C $tree
    Remove-Item -Force $tar
  }
  return $tree
}
function Build-At([string]$sha, [string]$tag, [string]$ctxRel, [string]$what, [string]$target = '') {
  $tree = Unpack-At $sha
  $args2 = @('build', '--label', $label, '--build-arg', "OB1_SHA=$sha", '-t', $tag)
  if ($what -eq 'viewer') { $args2 += @('--build-context', "recipes=$(Join-Path $tree 'recipes')") }
  if ($target) { $args2 += @('--target', $target) }
  return DkLong @args2 (Join-Path $tree $ctxRel)
}
function Summary([string]$text) { return ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match(($text -replace '\x1b\[[0-9;]*m', '')) }

try {
  Write-Host "== rw-p4b-sessions lab run  owner=$Id  net=$net  red=$([bool]$Red)  evidence=$Evidence"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  # ---------------------------------------------------------------- 1. the initdb chain
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $composeDir = if ($Red) { Join-Path (Unpack-At $BaseSha) 'docker' } else { $dockerDir }
  $compose = Get-Content -Raw (Join-Path $composeDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $composeDir $m[0]) (Join-Path $stage $m[1]) }
  if ($Red) { Check (@($chain | Where-Object { $_[1] -eq '320-init-research-sessions.sql' }).Count -eq 0) "RED: the base chain has no 320 slot ($($chain.Count) migrations)" }
  else { Check (@($chain | Where-Object { $_[1] -eq '320-init-research-sessions.sql' }).Count -eq 1) "the chain mounts 320-init-research-sessions.sql ($($chain.Count) migrations)" }

  # ---------------------------------------------------------------- 2. network
  Write-Host '[2] the internal network'
  $null = Dk network create --driver bridge --internal --subnet $subnets.run --label $label $net
  Check ($script:rc -eq 0) "network $net (internal, $($subnets.run))"
  if ($script:rc -ne 0) { throw 'network' }
  $script:made.net = $true

  # ---------------------------------------------------------------- 3. images
  Write-Host '[3] images'
  if ($Red) {
    foreach ($b in @(@($wbTag, 'docker/workbench', 'workbench', ''), @($viewerTag, 'docker/wiki-viewer', 'viewer', ''), @($rsTag, 'integrations/research-service', 'research', ''), @($wbTestTag, 'docker/workbench', 'workbench', 'test'))) {
      $o = Build-At $BaseSha $b[0] $b[1] $b[2] $b[3]; Save "build-$($b[2])$($b[3])-base.log" (($o -split "`n" | Select-Object -Last 40) -join "`n")
      Check ($script:rc -eq 0) "RED: $($b[0]) built from OB1 $BaseSha"
      $script:made.images += $b[0]
    }
  } else {
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" -t $wbTag $wb; Save 'build-workbench.log' (($o -split "`n" | Select-Object -Last 80) -join "`n")
    Check ($script:rc -eq 0) "$wbTag built at OB1 $($sha.Substring(0, 7)) (its test gate passed, src/sessions/ included)"
    if ($script:rc -ne 0) { throw 'build workbench' }
    $script:made.images += $wbTag
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --build-context "recipes=$(Join-Path $ob1 'recipes')" -t $viewerTag $viewerDir
    Save 'build-viewer.log' (($o -split "`n" | Select-Object -Last 120) -join "`n")
    Check ($script:rc -eq 0) "$viewerTag built (the workspace's vitest, sessions.test.tsx included)"
    if ($script:rc -ne 0) { throw 'build viewer' }
    $script:made.images += $viewerTag
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" -t $rsTag $rsDir; Save 'build-research.log' (($o -split "`n" | Select-Object -Last 40) -join "`n")
    Check ($script:rc -eq 0) "$rsTag built (its offline suite, sessions-authority.test.ts included)"
    if ($script:rc -ne 0) { throw 'build research' }
    $script:made.images += $rsTag
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --target test -t $wbTestTag $wb; Save 'build-workbench-test.log' (($o -split "`n" | Select-Object -Last 40) -join "`n")
    Check ($script:rc -eq 0) "$wbTestTag (this tree's test stage) built"
    $script:made.images += $wbTestTag
  }
  # the integration test is this tree's in both runs (RED: mounted into the base's test stage)
  $itMount = @('-v', "$(Join-Path $wb 'src/sessions/sessions_integration_test.ts'):/app/src/sessions/sessions_integration_test.ts:ro")

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
  if (-not $Red) {
    $null = Dk cp (Join-Path $dockerDir 'init-research-sessions.sql') "${db}:/tmp/init-research-sessions.sql"
    $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/init-research-sessions.sql
    Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) 'init-research-sessions.sql re-applied cleanly (idempotent)'
  }

  $ctMount = "${ct}:/ct:ro"
  $null = Run-Detached "$P-embed" @('--network-alias', 'stub-embed', '-v', $ctMount, '--entrypoint', 'deno', $wbTag, 'run', '--allow-net', '/ct/stub-embed.ts')
  $null = Run-Detached "$P-gw" @('--network-alias', 'stub-gateway', '-v', $ctMount, '--entrypoint', 'deno', $wbTag, 'run', '--allow-net', '/ct/stub-gateway.ts')
  $null = Run-Detached "$P-postgrest" @('--network-alias', 'openbrain-postgrest', '-e', "PGRST_DB_URI=postgres://postgres:$pw@openbrain-db:5432/openbrain",
      '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=service_role', '-e', 'PGRST_DB_POOL=4', '-e', 'PGRST_SERVER_PORT=3000', $PgrstImage)
  $null = Run-Detached "$P-rest" @('--network-alias', 'openbrain-rest', '-v', "$(Join-Path $dockerDir 'Caddyfile'):/etc/caddy/Caddyfile:ro", $CaddyImage)
  $null = Run-Detached "$P-rs" @('-e', "DB_HOST=$db", '-e', 'DB_USER=ob_app_memory', '-e', "DB_PASSWORD=$appPw", '-e', "MCP_ACCESS_KEY=$key",
      '-e', "RESEARCH_CALLERS=owui-tool=owui:$kOwui;agent-org=mattermost:$kAo;digest=notebook:$kNb;workspace=workspace:$wsKey", '-e', "WORKSPACE_DEFAULT_SUB=$profSub",
      '-e', 'CHAT_API_BASE=http://stub-gateway:8080/v1', '-e', 'EMBEDDING_API_BASE=http://stub-gateway:8080/v1',
      '-e', 'CURATOR_URL=http://unreachable.invalid', '-e', 'SEARCH_API_BASE=http://unreachable.invalid', $rsTag)
  $null = Run-Detached "$P-viewer" @('--network-alias', 'openbrain-wiki-viewer', '-e', 'OPEN_BRAIN_URL=http://openbrain-rest', '-e', 'WIKI_NAV_MIN_ROWS=0',
      '-e', 'WIKI_BUILDER=0', '-e', 'WIKI_DB_TCP=openbrain-db:5432', '-e', 'WIKI_DB_PROBE_MS=1000', '-e', 'WIKI_RECONCILE_INTERVAL_MS=5000',
      '-e', 'NODE_OPTIONS=--max-old-space-size=2048', '-e', 'WORKBENCH_URL=http://openbrain-workbench:8000', '-e', "WORKBENCH_KEY=$key",
      '-e', "WORKSPACE_DOOR_KEY=$door", '-e', 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub',
      '-e', "WIKI_VIEWER_ALLOWED_HOSTS=$P-viewer", '-v', "${vault}:/wiki:ro", $viewerTag)
  $common = @('-e', 'PORT=8000', '-e', "WORKBENCH_KEY=$key", '-e', "DB_HOST=$db", '-e', 'DB_USER=ob_app_memory', '-e', "DB_PASSWORD=$appPw",
      '-e', 'OPEN_BRAIN_URL=http://openbrain-rest', '-e', 'EMBEDDING_API_BASE=http://stub-embed:8080/v1', '-e', 'EXTRACT_URL=http://unreachable.invalid',
      '-e', 'WIKI_GIT_DIR=/wiki', '-e', 'WIKI_ASSETS_DIR=/wiki/assets', '-e', 'CONTRACT_MOUNTS_ROOT=/mounts', '-e', "RESEARCH_URL=http://$P-rs:8000",
      '-e', "RESEARCH_WORKSPACE_KEY=$wsKey", '-e', "VIEWER_NAV_URL=http://$P-viewer:8082",
      '-e', "WORKSPACE_DEFAULT_SUB=$profSub", '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro")
  $wbArgs = @('--network-alias', 'openbrain-workbench') + $common + @('-v', "${vault}:/wiki",
      '-e', "WORKSPACE_DOOR_KEY=$door", '-e', "WORKSPACE_FORWARD_AUTH_ISSUER=$issuer", '-e', "WORKSPACE_FORWARD_AUTH_CLIENT_ID=$faClient",
      '-e', "WORKSPACE_FORWARD_AUTH_CLIENT_SECRET=$faSecret", '-e', 'WORKSPACE_FORWARD_AUTH_ADMIN_GROUP=research-admins',
      '-e', "WORKSPACE_OWUI_BASE_URL=$owuiBase/")
  $null = Run-Detached "$P-wb" ($wbArgs + @($wbTag))
  # single-user mode: no sign-in, WORKSPACE_OWUI_BASE_URL blank (as shipped); its own vault; the same database
  $null = Run-Detached "$P-wbplain" ($common + @('-v', "${vault2}:/wiki", $wbTag))
  Check (Wait-Http "http://$P-wb:8000/health" 90) 'the workbench (sign-in configured) is up'
  Check (Wait-Http "http://$P-wbplain:8000/health" 90) 'the workbench (no sign-in) is up'
  Check (Wait-Http "http://$P-rs:8000/health" 60) 'the research service is up'
  Check (Wait-Http "http://$P-viewer:8080/workspace/" 90) 'the viewer is up'

  # ---------------------------------------------------------------- 5. the tests
  Write-Host '[5a] the sessions integration test (forward-auth tokens; the real research service)'
  $o = Lab-Docker 900 (@('run', '--rm', '--label', $label, '--network', $net) + $itMount + @(
    '-e', "SESSIONS_TEST_FA_ISSUER=$issuer", '-e', "SESSIONS_TEST_FA_CLIENT_ID=$faClient", '-e', "SESSIONS_TEST_FA_SECRET=$faSecret",
    '-e', "SESSIONS_TEST_VIEWER=http://$P-viewer:8080", '-e', "SESSIONS_TEST_WB_PLAIN=http://$P-wbplain:8000", '-e', "SESSIONS_TEST_RESEARCH=http://$P-rs:8000",
    '-e', "SESSIONS_TEST_INTERNAL_KEY=$key", '-e', "SESSIONS_TEST_OWUI_KEY=$kOwui", '-e', "SESSIONS_TEST_AO_KEY=$kAo", '-e', "SESSIONS_TEST_NB_KEY=$kNb",
    '-e', "SESSIONS_TEST_WS_KEY=$wsKey", '-e', "SESSIONS_TEST_USERS=$usersJson", '-e', "SESSIONS_TEST_OWUI_BASE=$owuiBase",
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', 'src/sessions/sessions_integration_test.ts'))
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save 'sessions-integration.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||passed|failed|error:|AssertionError|=>|^\s*[-+]\s|Values|Expected|Actual' }) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)' }) { Write-Host "    $l" }
  $sum = Summary $clean
  if ($Red) { Check ($sum.Success -and [int]$sum.Groups[2].Value -eq 0 -and [int]$sum.Groups[3].Value -ge 9) "RED: every sessions case fails on the base ($($sum.Value))" }
  else { Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0 -and [int]$sum.Groups[2].Value -ge 9) "the sessions integration test ($($sum.Value))" }

  if (-not $Red) {
    # every steer the run recorded has its actor; what the actors were
    $act = (Dk exec $db psql -U postgres -d openbrain -tAc "select steer_kind || ':' || case when actor_sub like 'system:%' or actor_sub like 'service:%' then actor_sub else '<user>' end || ' ' || count(*) from research_steers group by 1 order by 1") -join '; '
    $nul = (Dk exec $db psql -U postgres -d openbrain -tAc "select count(*) from research_steers where actor_sub is null or btrim(actor_sub) = ''").Trim()
    Save 'steer-actors.log' "actors: $act`nunrecorded: $nul"
    Check ($nul -eq '0') "every steer records actor_sub ($act)"
  }

  $sweeps = @(@('carol', 'dave', 'on'), @('admin', 'dave', 'on'), @('carol', 'dave', 'off'))
  if ($Red -or $SkipSweeps) { $sweeps = @() }
  foreach ($sw in $sweeps) {
    if ($sw[2] -eq 'off') {
      $null = Dk rm -f "$P-wb"
      $null = Dk run -d --name "$P-wb" --label $label --network $net @($wbArgs + @('-e', 'WORKSPACE_RESPONSE_WALK=off', $wbTag))
      Check (($script:rc -eq 0) -and (Wait-Http "http://$P-wb:8000/health" 90)) 'the workbench restarted with the response walk off'
    }
    Write-Host "[5b] the isolation sweep signed in: A=$($sw[0]) B=$($sw[1]), response walk $($sw[2])"
    $o = Lab-Docker 1800 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${vault}:/vault", '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro",
      '-e', "SWEEP_FA_ISSUER=$issuer", '-e', "SWEEP_FA_CLIENT_ID=$faClient", '-e', "SWEEP_FA_SECRET=$faSecret", '-e', "SWEEP_USERS=$usersJson",
      '-e', "SWEEP_BASE=http://$P-wb:8000", '-e', "SWEEP_VIEWER=http://$P-viewer:8080", '-e', "DOCS_TEST_KEY=$door", '-e', 'DOCS_TEST_VAULT=/vault',
      '-e', "SWEEP_USER_A=$($sw[0])", '-e', "SWEEP_USER_B=$($sw[1])", '-e', "SWEEP_USER_B_SUB=$daveSub", '-e', 'DOCS_TEST_SUB_HEADER=X-Test-Sub',
      '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
      '-e', "DB_HOST=$db", '-e', 'DB_USER=postgres', '-e', "DB_PASSWORD=$pw", '-e', 'WIKI_GIT_DIR=/vault', '-e', 'OPEN_BRAIN_URL=http://openbrain-rest',
      $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', '--allow-write', '--allow-run', 'src/documents/isolation_sweep_test.ts')
    $clean = ($o -replace '\x1b\[[0-9;]*m', '')
    Save "isolation-sweep-$($sw[0])-walk-$($sw[2]).log" ((($clean -split "`n") | Where-Object { $_ -match '^sweep:|HIT |\.\.\. (ok|FAILED)|^(ok|FAILED) \||error:|AssertionError' }) -join "`n")
    foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '^sweep:|HIT ' } | Select-Object -First 40) { Write-Host "    $l" }
    $r = Summary $clean
    Check ($clean -match 'sweep: B steered B''s session from its card: 201') "the sweep planted B's steer (A=$($sw[0]), walk $($sw[2]))"
    Check ($r.Success -and $r.Groups[1].Value -eq 'ok' -and [int]$r.Groups[3].Value -eq 0 -and $clean -match 'sweep: \d+ routes' -and $clean -match 'sweep: real sessions') "the isolation sweep, real sessions, A=$($sw[0]), walk $($sw[2]) ($($r.Value))"
  }

  if (-not $Red) {
    # the revert: actor_sub and the idea-owner trigger go, the steers stay, the steer stub row is active again
    $null = Dk cp (Join-Path $dockerDir 'revert-research-sessions.sql') "${db}:/tmp/revert-research-sessions.sql"
    $steers = (Dk exec $db psql -U postgres -d openbrain -tAc "select count(*) from research_steers").Trim()
    $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/revert-research-sessions.sql
    $rv = $script:rc
    $after = (Dk exec $db psql -U postgres -d openbrain -tAc "select (select count(*) from research_steers) || ' ' || (select count(*) from information_schema.columns where table_name = 'research_steers' and column_name = 'actor_sub') || ' ' || (select count(*) from pg_trigger where tgname = 'trg_research_jobs_idea_owner') || ' ' || (select count(*) from research_prompts where actor_sub = 'system:idea-engagement') || ' ' || (select (retired_at is null)::text from contract_registry_entries where registry = 'implementation_states' and key = 'steer')").Trim()
    Save 'revert.log' "steers before: $steers; after (steers, actor_sub column, trigger, idea-owner rows, steer stub active): $after; exit $rv"
    Check (($rv -eq 0) -and $after -eq "$steers 0 0 0 true") "revert-research-sessions.sql: actor_sub, the trigger and its rows gone, the steers kept, the stub row active ($after)"
  }
  Save 'workbench.log' (Dk logs --tail 120 "$P-wb")
  Save 'workbench-plain.log' (Dk logs --tail 40 "$P-wbplain")
  Save 'research-service.log' (Dk logs --tail 80 "$P-rs")
} catch {
  Fail "the run stopped: $_"
} finally {
  Write-Host '[6] teardown'
  foreach ($c in $script:made.containers + @("$P-wb")) { $null = Dk rm -f -v $c }
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
