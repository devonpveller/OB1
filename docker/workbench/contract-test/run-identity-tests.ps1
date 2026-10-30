# run-identity-tests.ps1 - the disposable lab run for rw-identity: sign-in by Authentik forward-auth
# (rw-identity2). A LAB SIGNER stands in for Authentik's outpost: the tests mint the outpost's token
# (X-authentik-jwt, HS256 with a run-made lab proxy-provider client secret; users alice, bob, carol, dave,
# an admin and more) and send it through the viewer's /workbench forwarder as Traefik would, or direct;
# admin impersonation with its audit log, the Open WebUI on-behalf-of hand-off on the REAL research
# service image, and P2b's route-wide isolation sweep re-run signed in. There is no OpenID provider,
# no TLS and no CA in the lab any more: forward-auth verification makes no call (HS256 with the secret).
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-identity-tests.ps1 -Subnet <x.y.z.0/24> [-Id <owner>] [-Evidence <dir>] [-Red]
#
# -Subnet is REQUIRED (harness-subnet.ps1); -Evidence must be absent or empty. -Red runs the SAME tests
# against the workbench, viewer and research images built from -BaseSha (rw-identity2: 3215724, the
# in-app OIDC head; it does not know WORKSPACE_FORWARD_AUTH_* and so runs single-user): the cases must
# FAIL there.
#
# LAB DOCKER SHIM (as run-workspace-tests.ps1): every docker call goes through Lab-Docker, which
# REFUSES (exit 2, nothing run) a published port, a network other than this run's (and `none`), a
# network create that is not --internal on the pinned subnet, a macvlan / ipvlan driver, any 192.168.x
# address, any ai-stack_* / open-brain_* name, any :local image, docker compose, and a build tag that
# is not :wt-<id>[-suffix]. Every container, the network and every image is labelled
# ai-stack.harness.owner=<Id> and removed at the end (containers with -v); the run checks nothing
# labelled <Id> is left and no :local image changed.
#
# What it does:
#   1. stages the REAL initdb chain from docker-compose.yml (rw-identity's 290 slot included)
#   2. one internal network on the pinned /25
#   3. builds openbrain-workbench:wt-<id> (+ its test stage: the identity unit tests are in its gate),
#      openbrain-wiki-viewer:wt-<id>, openbrain-research:wt-<id>; with -Red the three from -BaseSha
#   4. (rw-identity2: no lab CA any more - nothing is fetched over TLS)
#   5. the lab: database (chain + fixtures.sql, ob_app_memory non-superuser), stub embedder, stub egress
#      proxy, PostgREST + the OB1 rest Caddy, the research service (three caller keys: owui, agent-org,
#      workspace), the viewer (door key, identity header stripped), the workbench WITH forward-auth
#      (the lab secret, issuer, client id, admin group), and a second workbench with NO sign-in (clause 5)
#   6. the forwarder guard (CSRF 403 / rebind 421 / own origin reaches); the identity integration test
#      (src/identity/identity_integration_test.ts); the isolation sweep signed in (tokens): carol vs
#      dave (walk on), the admin (not impersonating) vs dave (walk on), carol vs dave (walk off)
#   7. the evidence gate, then teardown and the leftover checks
# It never touches the live stack. Exit 0 = every check passed (with -Red: every case FAILED).
param(
  [string]$Id = 'wt-rw-identity',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
  [string]$CaddyImage = 'caddy:2-alpine',
  [string]$BaseSha = '3215724',
  [switch]$Red,
  [switch]$KeepImages,
  [switch]$SkipSweeps,  # the integration test only (a targeted RED of one case)
  # round 4: a tester's probe test (deno, mounted into the test image as src/identity/t_probe_test.ts,
  # never part of the tree) run with the PROBE_* environment its author wrote it for
  [string]$ExtraTest = '',
  # round 4: with -Red against a RECENT base (one that already passes the older cases), the case-name
  # prefixes that must FAIL there (comma list, e.g. 'C2d,C2e'); the base's own test stage runs this
  # tree's integration test file, mounted over it (this tree's unit tests would stop that build)
  [string]$RedCases = ''
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
$P = "rwid-$rand"
$net = "$P-net"
$sfx = if ($Red) { '-base' } else { '' }
$wbTag = "openbrain-workbench:wt-$short$sfx"; $wbTestTag = "openbrain-workbench:wt-$short-test"
$viewerTag = "openbrain-wiki-viewer:wt-$short$sfx"; $rsTag = "openbrain-research:wt-$short$sfx"
$pw = Rand 24 'alnum'; $appPw = Rand 24 'alnum'
$key = Rand 32; $door = Rand 32; $wsKey = Rand 32; $kOwui = Rand 32; $kAo = Rand 32; $faSecret = Rand 64 'alnum'
$secrets = @($pw, $appPw, $key, $door, $wsKey, $kOwui, $kAo, $faSecret)
$users = @(
  @{ login = 'alice'; sub = (Rand 64); name = 'Alice Lab'; groups = @('lab-users') },
  @{ login = 'bob'; sub = (Rand 64); name = 'Bob Lab'; groups = @('lab-users') },
  @{ login = 'carol'; sub = (Rand 64); name = 'Carol Lab'; groups = @('lab-users') },
  @{ login = 'dave'; sub = (Rand 64); name = 'Dave Lab'; groups = @('lab-users') },
  @{ login = 'admin'; sub = (Rand 64); name = 'Admin Lab'; groups = @('lab-users', 'research-admins') },
  # the lab's WORKSPACE_DEFAULT_SUB (the ProfNovice analogue: owner of everything that predates sign-in)
  @{ login = 'prof'; sub = (Rand 64); name = 'Prof Lab'; groups = @('lab-users') },
  # round 4 (tester attempt 1): a subject with characters a directory name cannot hold, and a second pair + admin
  @{ login = 'tess'; sub = ('auth0|tess.lab@' + (Rand 16)); name = 'Tess Probe'; groups = @('lab-users') },
  @{ login = 'uma'; sub = (Rand 64); name = 'Uma Probe'; groups = @('lab-users') },
  @{ login = 'boss'; sub = (Rand 64); name = 'Boss Probe'; groups = @('lab-users', 'research-admins') })
$usersJson = (ConvertTo-Json -Compress -Depth 4 @($users | ForEach-Object { [pscustomobject]$_ }))
$daveSub = ($users | Where-Object { $_.login -eq 'dave' }).sub
$profSub = ($users | Where-Object { $_.login -eq 'prof' }).sub
$umaSub = ($users | Where-Object { $_.login -eq 'uma' }).sub
# the lab proxy provider (Authentik's stand-in): the token's iss and aud, the sign-out the workspace links to
$issuer = 'https://authentik.lab.invalid/application/o/research-lab/'
$faClient = 'research-proxy-lab'
$signOut = "http://$P-viewer:8080/outpost.goauthentik.io/sign_out"
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
$evStage = Join-Path $env:TEMP "$P-evstage"; New-Item -ItemType Directory -Force $evStage | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$vault = Join-Path $env:TEMP "$P-vault"; New-Item -ItemType Directory -Force $vault | Out-Null
$vault2 = Join-Path $env:TEMP "$P-vault-plain"; New-Item -ItemType Directory -Force $vault2 | Out-Null
$vault3 = Join-Path $env:TEMP "$P-vault-nodef"; New-Item -ItemType Directory -Force $vault3 | Out-Null
foreach ($fx in @(@('content/tool/tool-fixture', 'Tool Fixture', 'An entity page about contract retrieval fixtures.'),
    @('content/source/11111111-1111-4111-8111-111111111111', 'Active fixture source', 'Leaf.'),
    @('content/source/22222222-2222-4222-8222-222222222222', 'Suppressed fixture source', 'Leaf.'))) {
  $fxPath = Join-Path $vault ($fx[0] + '.md')
  New-Item -ItemType Directory -Force (Split-Path -Parent $fxPath) | Out-Null
  [System.IO.File]::WriteAllText($fxPath, "---`ntitle: $($fx[1])`n---`n$($fx[2])`n", (New-Object System.Text.UTF8Encoding $false))
}
. (Join-Path $PSScriptRoot 'evidence-gate.ps1')

$script:fail = 0
$script:made = @{ net = $false; containers = @(); images = @(); dirs = @($evStage, $stage, $vault, $vault2, $vault3) }
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Redact([string]$t) { foreach ($s in $secrets) { if ($s) { $t = $t -replace [regex]::Escape($s), '<redacted>' } }; return ($t -replace 'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*', '<jwt>') }
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $evStage $name), (Redact $text), (New-Object System.Text.UTF8Encoding $false)) }

# -- the lab docker shim (the run-workspace-tests.ps1 rules) --------------------------------
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
function Build-At([string]$sha, [string]$tag, [string]$ctxRel, [string]$what, [string]$target = '') {
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
  $args2 = @('build', '--label', $label, '--build-arg', "OB1_SHA=$sha", '-t', $tag)
  if ($what -eq 'viewer') { $args2 += @('--build-context', "recipes=$(Join-Path $tree 'recipes')") }
  if ($target) { $args2 += @('--target', $target) }
  return DkLong @args2 (Join-Path $tree $ctxRel)
}

try {
  Write-Host "== rw-identity lab run  owner=$Id  net=$net  red=$([bool]$Red)  evidence=$Evidence"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  # ---------------------------------------------------------------- 1. the initdb chain
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check (@($chain | Where-Object { $_[1] -eq '290-init-identity.sql' }).Count -eq 1) "the chain mounts 290-init-identity.sql ($($chain.Count) migrations)"

  # ---------------------------------------------------------------- 2. network
  Write-Host '[2] the internal network'
  $null = Dk network create --driver bridge --internal --subnet $subnets.run --label $label $net
  Check ($script:rc -eq 0) "network $net (internal, $($subnets.run))"
  if ($script:rc -ne 0) { throw 'network' }
  $script:made.net = $true

  # ---------------------------------------------------------------- 3. images
  Write-Host '[3] images'
  if ($Red) {
    foreach ($b in @(@($wbTag, 'docker/workbench', 'workbench'), @($viewerTag, 'docker/wiki-viewer', 'viewer'), @($rsTag, 'integrations/research-service', 'research'))) {
      $o = Build-At $BaseSha $b[0] $b[1] $b[2]; Save "build-$($b[2])-base.log" (($o -split "`n" | Select-Object -Last 40) -join "`n")
      Check ($script:rc -eq 0) "RED: $($b[0]) built from OB1 $BaseSha"
      $script:made.images += $b[0]
    }
  } else {
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" -t $wbTag $wb; Save 'build-workbench.log' (($o -split "`n" | Select-Object -Last 80) -join "`n")
    Check ($script:rc -eq 0) "$wbTag built at OB1 $($sha.Substring(0, 7)) (its test gate passed, src/identity/ included)"
    if ($script:rc -ne 0) { throw 'build workbench' }
    $script:made.images += $wbTag
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --build-context "recipes=$(Join-Path $ob1 'recipes')" -t $viewerTag $viewerDir
    Save 'build-viewer.log' (($o -split "`n" | Select-Object -Last 120) -join "`n")
    Check ($script:rc -eq 0) "$viewerTag built (its node tests incl. the forwarder's identity cases; the workspace's vitest)"
    if ($script:rc -ne 0) { throw 'build viewer' }
    $script:made.images += $viewerTag
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" -t $rsTag $rsDir; Save 'build-research.log' (($o -split "`n" | Select-Object -Last 40) -join "`n")
    Check ($script:rc -eq 0) "$rsTag built"
    if ($script:rc -ne 0) { throw 'build research' }
    $script:made.images += $rsTag
  }
  if ($Red -and $RedCases) {
    $o = Build-At $BaseSha $wbTestTag 'docker/workbench' 'workbench' 'test'; Save 'build-workbench-test.log' (($o -split "`n" | Select-Object -Last 40) -join "`n")
    Check ($script:rc -eq 0) "$wbTestTag (the BASE's test stage; this tree's integration test is mounted over it) built"
  } else {
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --target test -t $wbTestTag $wb; Save 'build-workbench-test.log' (($o -split "`n" | Select-Object -Last 40) -join "`n")
    Check ($script:rc -eq 0) "$wbTestTag (this tree's test stage) built"
  }
  $itMount = if ($Red -and $RedCases) { @('-v', "$(Join-Path $wb 'src/identity/identity_integration_test.ts'):/app/src/identity/identity_integration_test.ts:ro") } else { @() }
  $script:made.images += $wbTestTag

  # ---------------------------------------------------------------- 5. the lab
  Write-Host '[5] the lab'
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
  # the migration's idempotency: 290 applied a second time changes nothing and raises nothing
  $null = Dk cp (Join-Path $dockerDir 'init-identity.sql') "${db}:/tmp/init-identity.sql"
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/init-identity.sql
  if (-not $Red) { Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) 'init-identity.sql re-applied cleanly (idempotent)' }

  $ctMount = "${ct}:/ct:ro"
  $null = Run-Detached "$P-embed" @('--network-alias', 'stub-embed', '-v', $ctMount, '--entrypoint', 'deno', $wbTag, 'run', '--allow-net', '/ct/stub-embed.ts')
  $null = Run-Detached "$P-proxy" @('--network-alias', 'stub-proxy', '-v', $ctMount, '--entrypoint', 'deno', $wbTag, 'run', '--allow-net', '/ct/stub-proxy.ts')
  $null = Run-Detached "$P-postgrest" @('--network-alias', 'openbrain-postgrest', '-e', "PGRST_DB_URI=postgres://postgres:$pw@openbrain-db:5432/openbrain",
      '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=service_role', '-e', 'PGRST_DB_POOL=4', '-e', 'PGRST_SERVER_PORT=3000', $PgrstImage)
  $null = Run-Detached "$P-rest" @('--network-alias', 'openbrain-rest', '-v', "$(Join-Path $dockerDir 'Caddyfile'):/etc/caddy/Caddyfile:ro", $CaddyImage)
  $null = Run-Detached "$P-rs" @('-e', "DB_HOST=$db", '-e', 'DB_USER=ob_app_memory', '-e', "DB_PASSWORD=$appPw", '-e', "MCP_ACCESS_KEY=$key",
      '-e', "RESEARCH_CALLERS=owui-tool=owui:$kOwui;agent-org=mattermost:$kAo;workspace=workspace:$wsKey", '-e', "WORKSPACE_DEFAULT_SUB=$profSub",
      '-e', 'CHAT_API_BASE=http://unreachable.invalid/v1', '-e', 'EMBEDDING_API_BASE=http://unreachable.invalid/v1',
      '-e', 'CURATOR_URL=http://unreachable.invalid', '-e', 'SEARCH_API_BASE=http://unreachable.invalid', $rsTag)
  $null = Run-Detached "$P-viewer" @('--network-alias', 'openbrain-wiki-viewer', '-e', 'OPEN_BRAIN_URL=http://openbrain-rest', '-e', 'WIKI_NAV_MIN_ROWS=0',
      '-e', 'WIKI_BUILDER=0', '-e', 'WIKI_DB_TCP=openbrain-db:5432', '-e', 'WIKI_DB_PROBE_MS=1000', '-e', 'WIKI_RECONCILE_INTERVAL_MS=5000',
      '-e', 'NODE_OPTIONS=--max-old-space-size=2048', '-e', 'WORKBENCH_URL=http://openbrain-workbench:8000', '-e', "WORKBENCH_KEY=$key",
      '-e', "WORKSPACE_DOOR_KEY=$door", '-e', 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub',
      '-e', "WIKI_VIEWER_ALLOWED_HOSTS=$P-viewer", '-v', "${vault}:/wiki:ro", $viewerTag)
  $common = @('-e', 'PORT=8000', '-e', "WORKBENCH_KEY=$key", '-e', "DB_HOST=$db", '-e', 'DB_USER=ob_app_memory', '-e', "DB_PASSWORD=$appPw",
      '-e', 'OPEN_BRAIN_URL=http://openbrain-rest', '-e', 'EMBEDDING_API_BASE=http://stub-embed:8080/v1', '-e', 'EXTRACT_URL=http://unreachable.invalid',
      '-e', 'WIKI_GIT_DIR=/wiki', '-e', 'WIKI_ASSETS_DIR=/wiki/assets', '-e', 'CONTRACT_MOUNTS_ROOT=/mounts', '-e', "RESEARCH_URL=http://$P-rs:8000",
      '-e', "RESEARCH_WORKSPACE_KEY=$wsKey", '-e', 'FETCH_PROXY_URL=http://stub-proxy:3128', '-e', "VIEWER_NAV_URL=http://$P-viewer:8082",
      '-e', "WORKSPACE_DEFAULT_SUB=$profSub", '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro")
  # the signed-in workbench ALSO has the identity header configured: it must be ignored there
  $wbArgs = @('--network-alias', 'openbrain-workbench') + $common + @('-e', 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub', '-v', "${vault}:/wiki",
      '-e', "WORKSPACE_DOOR_KEY=$door", '-e', "WORKSPACE_FORWARD_AUTH_ISSUER=$issuer", '-e', "WORKSPACE_FORWARD_AUTH_CLIENT_ID=$faClient",
      '-e', "WORKSPACE_FORWARD_AUTH_CLIENT_SECRET=$faSecret", '-e', 'WORKSPACE_FORWARD_AUTH_ADMIN_GROUP=research-admins',
      '-e', "WORKSPACE_FORWARD_AUTH_SIGN_OUT_URL=$signOut")
  $null = Run-Detached "$P-wb" ($wbArgs + @($wbTag))
  # clause 5: the same image, NO sign-in configured, nothing rw-identity adds set (as shipped; its own vault; the same database)
  $null = Run-Detached "$P-wbplain" ($common + @('-v', "${vault2}:/wiki", $wbTag))
  # round 4 (tester F4 / P6): sign-in on, WORKSPACE_DEFAULT_SUB blank (ownerless = nobody's but an admin's), its own vault
  $nd = @($wbArgs | Select-Object -Skip 2 | ForEach-Object { if ($_ -eq "WORKSPACE_DEFAULT_SUB=$profSub") { 'WORKSPACE_DEFAULT_SUB=' } elseif ($_ -eq "${vault}:/wiki") { "${vault3}:/wiki" } else { $_ } })
  $null = Run-Detached "$P-wbnodef" ($nd + @($wbTag))
  Check (Wait-Http "http://$P-wb:8000/health" 90) 'the workbench (sign-in configured) is up'
  Check (Wait-Http "http://$P-wbnodef:8000/health" 90) 'the workbench (sign-in, WORKSPACE_DEFAULT_SUB blank) is up'
  # round 4 (tester Case 5 probe): a half-configured or unsafe sign-in refuses to start (rw-identity2:
  # the forward-auth variables; and any retired WORKSPACE_OIDC_* / WORKSPACE_SESSION_HOURS value)
  $faAll = @('-e', "WORKSPACE_FORWARD_AUTH_ISSUER=$issuer", '-e', "WORKSPACE_FORWARD_AUTH_CLIENT_ID=$faClient", '-e', "WORKSPACE_FORWARD_AUTH_CLIENT_SECRET=$faSecret")
  $half = @(
    @('only-issuer', @('-e', "WORKSPACE_FORWARD_AUTH_ISSUER=$issuer", '-e', "WORKSPACE_DOOR_KEY=$door")),
    @('only-secret', @('-e', "WORKSPACE_FORWARD_AUTH_CLIENT_SECRET=$faSecret", '-e', "WORKSPACE_DOOR_KEY=$door")),
    @('only-admin-group', @('-e', 'WORKSPACE_FORWARD_AUTH_ADMIN_GROUP=research-admins')),
    @('short-secret', @('-e', "WORKSPACE_FORWARD_AUTH_ISSUER=$issuer", '-e', "WORKSPACE_FORWARD_AUTH_CLIENT_ID=$faClient", '-e', 'WORKSPACE_FORWARD_AUTH_CLIENT_SECRET=only-twenty-chars-xx', '-e', "WORKSPACE_DOOR_KEY=$door")),
    @('retired-oidc-variable', ($faAll + @('-e', "WORKSPACE_DOOR_KEY=$door", '-e', "WORKSPACE_OIDC_ISSUER=$issuer"))),
    @('no-door-key', $faAll),
    @('door-equals-internal', ($faAll + @('-e', "WORKSPACE_DOOR_KEY=$key"))),
    @('short-door-key', @('-e', 'WORKSPACE_DOOR_KEY=short')))
  if (-not $Red) {
    foreach ($h in $half) {
      $hn = "$P-half-$($h[0])"
      $o = Lab-Docker 60 (@('run', '--name', $hn, '--label', $label, '--network', 'none') + $common + $h[1] + @($wbTag))
      $rcH = $script:rc
      $null = Dk rm -f $hn
      $msg = (($o -split "`n") | Where-Object { $_ -match 'error|half|must|needs|refus' } | Select-Object -First 1) -join ''
      Check (($rcH -ne 0) -and ($o -notmatch 'listening on')) "a half-configured or unsafe sign-in refuses to start: $($h[0]) (exit $rcH)"
    }
  }
  Check (Wait-Http "http://$P-wbplain:8000/health" 90) 'the workbench (no sign-in) is up'
  Check (Wait-Http "http://$P-rs:8000/health" 60) 'the research service is up'
  Check (Wait-Http "http://$P-viewer:8080/workspace/" 90) 'the viewer is up'
  Save 'workbench-start.log' (Dk logs "$P-wb")

  # ---------------------------------------------------------------- 6. the tests
  Write-Host '[6a] the forwarder guard (unchanged by rw-identity)'
  $edge = Dk run --rm --label $label --network $net --entrypoint node $viewerTag --input-type=module -e "
    const v = 'http://$P-viewer:8080';
    const csrf = await fetch(v + '/workbench/auth/impersonate/end', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: '{}' });
    const noOrigin = await fetch(v + '/workbench/auth/impersonate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const http = await import('node:http');
    const rebind = await new Promise((ok) => { const q = http.request({ host: '$P-viewer', port: 8080, path: '/workbench/auth/me', headers: { host: 'rebound.example:8080' } }, (r) => { r.resume(); ok(r.statusCode); }); q.on('error', () => ok(0)); q.end(); });
    const own = await fetch(v + '/workbench/auth/impersonate/end', { method: 'POST', headers: { origin: v, 'content-type': 'application/json' }, body: '{}' });
    const forged = await fetch('http://$P-wb:8000/workbench/auth/me', { headers: { 'x-brain-key': 'forged-by-the-client' } });
    console.log('guard csrf', csrf.status, 'no-origin', noOrigin.status, 'rebind', rebind, 'own-origin', own.status, 'direct-forged-key', forged.status);"
  Save 'edge-guard.log' $edge
  # own-origin: forwarded (the workbench answers 401 for want of a token; the guard would have said 403)
  if (-not $Red) { Check ($edge -match 'guard csrf 403 no-origin 403 rebind 421 own-origin 401 direct-forged-key 401') "the forwarder's CSRF / rebinding guard holds for the auth routes ($edge)" }

  Write-Host '[6b] the identity integration test (forward-auth tokens from the lab signer; the real research service)'
  $o = Lab-Docker 900 (@('run', '--rm', '--label', $label, '--network', $net) + $itMount + @(
    '-e', "IDENTITY_TEST_FA_ISSUER=$issuer", '-e', "IDENTITY_TEST_FA_CLIENT_ID=$faClient", '-e', "IDENTITY_TEST_FA_SECRET=$faSecret", '-e', "IDENTITY_TEST_FA_SIGN_OUT=$signOut",
    '-e', "IDENTITY_TEST_VIEWER=http://$P-viewer:8080", '-e', "IDENTITY_TEST_WB=http://$P-wb:8000", '-e', "IDENTITY_TEST_WB_PLAIN=http://$P-wbplain:8000",
    '-e', "IDENTITY_TEST_WB_NODEF=http://$P-wbnodef:8000",
    '-e', "IDENTITY_TEST_RESEARCH=http://$P-rs:8000",
    '-e', "IDENTITY_TEST_DOOR_KEY=$door", '-e', "IDENTITY_TEST_INTERNAL_KEY=$key", '-e', "IDENTITY_TEST_OWUI_KEY=$kOwui", '-e', "IDENTITY_TEST_AO_KEY=$kAo",
    '-e', "IDENTITY_TEST_WS_KEY=$wsKey", '-e', "IDENTITY_TEST_USERS=$usersJson", '-e', "IDENTITY_TEST_DEFAULT_SUB=$profSub", '-e', 'IDENTITY_TEST_SUB_HEADER=X-Test-Sub',
    '-e', "IDENTITY_TEST_APP_PASSWORD=$appPw", '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', 'src/identity/identity_integration_test.ts'))
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save 'identity-integration.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||passed|failed|error:|AssertionError|=>|^\s*[-+]\s' }) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)' }) { Write-Host "    $l" }
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
  if ($Red -and $RedCases) {
    foreach ($rc0 in ($RedCases -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
      Check ($clean -match "(?m)^\s*$([regex]::Escape($rc0))\b.*\.\.\. FAILED") "RED: $rc0 fails on the base $BaseSha"
    }
  }
  elseif ($Red) { Check ($sum.Success -and [int]$sum.Groups[2].Value -eq 0) "RED: every identity case fails on the base ($($sum.Value))" }
  else { Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0 -and [int]$sum.Groups[2].Value -ge 18) "the identity integration test ($($sum.Value))" }

  if ($ExtraTest) {
    Write-Host "[6b'] the extra (tester's) probe test: $ExtraTest"
    $o = Lab-Docker 1200 @('run', '--rm', '--label', $label, '--network', $net,
      '-e', "PROBE_FA_ISSUER=$issuer", '-e', "PROBE_FA_CLIENT_ID=$faClient", '-e', "PROBE_FA_SECRET=$faSecret", '-e', "PROBE_FA_SIGN_OUT=$signOut",
      '-v', "${ExtraTest}:/app/src/identity/t_probe_test.ts:ro",
      '-e', "PROBE_VIEWER=http://$P-viewer:8080", '-e', "PROBE_WB=http://$P-wb:8000", '-e', "PROBE_WB_NODEF=http://$P-wbnodef:8000",
      '-e', "PROBE_RESEARCH=http://$P-rs:8000",
      '-e', "PROBE_DOOR_KEY=$door", '-e', "PROBE_INTERNAL_KEY=$key", '-e', "PROBE_OWUI_KEY=$kOwui", '-e', "PROBE_AO_KEY=$kAo",
      '-e', "PROBE_WS_KEY=$wsKey", '-e', "PROBE_USERS=$usersJson", '-e', "PROBE_APP_PASSWORD=$appPw", '-e', "PROBE_DB_HOST=$db", '-e', "PROBE_DB_PASSWORD=$pw",
      $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', 'src/identity/t_probe_test.ts')
    $clean = ($o -replace '\x1b\[[0-9;]*m', '')
    Save 'extra-probe.log' ((($clean -split "`n") | Where-Object { $_ -match '^PROBE|P\d |\.\.\. (ok|FAILED)|^(ok|FAILED) \||error:|AssertionError|=>' }) -join "`n")
    foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|(ok|FAILED) \||LEAKS|leaks:' }) { Write-Host "    $l" }
    $x = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
    Check ($x.Success -and $x.Groups[1].Value -eq 'ok' -and $clean -notmatch 'LEAKS to') "the extra probe test ($($x.Value); no 'LEAKS to' line)"
  }

  # init-identity.sql's back-fill (C2c): re-applied with workspace.default_sub set, an ownerless job
  # becomes the default subject's, an ownerless AGENT job its service's; a job with an owner is untouched
  if (-not $Red) {
    $q = "insert into research_jobs (status, origin, query, caller) values ('error', 'manual', 'backfill probe user', 'shared-key'), ('error', 'mattermost', 'backfill probe agent', 'agent-org') returning id"
    $ids = @(((Dk exec $db psql -U postgres -d openbrain -tAqc $q) -split "`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $o = Dk exec -e "PGOPTIONS=-c workspace.default_sub=$profSub" $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/init-identity.sql
    $owners = ((Dk exec $db psql -U postgres -d openbrain -tAqc "select coalesce((select owner_sub from research_prompts where job_id = '$($ids[0])'), '-') || ' ' || coalesce((select owner_sub from research_prompts where job_id = '$($ids[1])'), '-')") -replace [regex]::Escape($profSub), '<default-sub>').Trim()
    Save 'backfill.log' "owners after the back-fill: $owners"
    Check (($script:rc -eq 0) -and $owners -eq '<default-sub> service:agent-org') "init-identity.sql back-fills ownerless jobs: the default subject's, an agent's its service's ($owners)"
  }
  $sweeps = @(@('carol', 'dave', 'on'), @('admin', 'dave', 'on'), @('tess', 'uma', 'on'), @('boss', 'uma', 'on'), @('carol', 'dave', 'off'))
  if ($Red) { $sweeps = @(, @('carol', 'dave', 'on')) }
  if ($SkipSweeps) { $sweeps = @() }
  foreach ($sw in $sweeps) {
    if ($sw[2] -eq 'off') {
      $null = Dk rm -f "$P-wb"
      $restart = $wbArgs + @('-e', 'WORKSPACE_RESPONSE_WALK=off', $wbTag)
      $null = Dk run -d --name "$P-wb" --label $label --network $net @restart
      Check (($script:rc -eq 0) -and (Wait-Http "http://$P-wb:8000/health" 90)) 'the workbench restarted with the response walk off'
    }
    Write-Host "[6c] the isolation sweep signed in (forward-auth tokens): A=$($sw[0]) B=$($sw[1]), response walk $($sw[2])"
    $o = Lab-Docker 1800 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${vault}:/vault", '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro",
      '-e', "SWEEP_FA_ISSUER=$issuer", '-e', "SWEEP_FA_CLIENT_ID=$faClient", '-e', "SWEEP_FA_SECRET=$faSecret", '-e', "SWEEP_USERS=$usersJson",
      '-e', "SWEEP_BASE=http://$P-wb:8000", '-e', "SWEEP_VIEWER=http://$P-viewer:8080", '-e', "DOCS_TEST_KEY=$door", '-e', 'DOCS_TEST_VAULT=/vault',
      '-e', "SWEEP_USER_A=$($sw[0])", '-e', "SWEEP_USER_B=$($sw[1])", '-e', "SWEEP_USER_B_SUB=$(if ($sw[1] -eq 'uma') { $umaSub } else { $daveSub })", '-e', 'DOCS_TEST_SUB_HEADER=X-Test-Sub',
      '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
      '-e', "DB_HOST=$db", '-e', 'DB_USER=postgres', '-e', "DB_PASSWORD=$pw", '-e', 'WIKI_GIT_DIR=/vault', '-e', 'OPEN_BRAIN_URL=http://openbrain-rest',
      $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', '--allow-write', '--allow-run', 'src/documents/isolation_sweep_test.ts')
    $clean = ($o -replace '\x1b\[[0-9;]*m', '')
    Save "isolation-sweep-$($sw[0])-walk-$($sw[2]).log" ((($clean -split "`n") | Where-Object { $_ -match '^sweep:|HIT |\.\.\. (ok|FAILED)|^(ok|FAILED) \||error:|AssertionError' }) -join "`n")
    foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '^sweep:|HIT ' } | Select-Object -First 40) { Write-Host "    $l" }
    $r = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
    if ($Red) { Check ($r.Success -and $r.Groups[1].Value -eq 'FAILED') "RED: the signed-in sweep fails on the base (it does not read the forward-auth token) ($($r.Value))" }
    else { Check ($r.Success -and $r.Groups[1].Value -eq 'ok' -and [int]$r.Groups[3].Value -eq 0 -and $clean -match 'sweep: \d+ routes' -and $clean -match 'sweep: real sessions') "the isolation sweep, real sessions, A=$($sw[0]), walk $($sw[2]) ($($r.Value))" }
  }

  # what the run left in the audit log: no impersonation outside the test that asked for one
  $aud = (Dk exec $db psql -U postgres -d openbrain -tAc "select action || ' ' || count(*) from admin_audit group by action order by 1") -join '; '
  Save 'admin-audit-summary.log' $aud
  Write-Host "    admin_audit: $aud"
  Save 'workbench.log' (Dk logs --tail 120 "$P-wb")
  Save 'workbench-plain.log' (Dk logs --tail 40 "$P-wbplain")
  Save 'research-service.log' (Dk logs --tail 60 "$P-rs")
  Save 'viewer.log' (Dk logs --tail 40 "$P-viewer")
  # round 4 (tester F5): the revert takes the rows rw-identity wrote into research_prompts with it -
  # the back-fill's (actor system:backfill) and the service owners (service:<caller>) - and the tables
  if ((-not $Red) -or $RedCases) {
    $revSrc = if ($Red) { Join-Path $env:TEMP "$P-tree-$BaseSha/docker/revert-identity.sql" } else { Join-Path $dockerDir 'revert-identity.sql' }
    $null = Dk cp $revSrc "${db}:/tmp/revert-identity.sql"
    $bf = (Dk exec $db psql -U postgres -d openbrain -tAqc "select count(*) from research_prompts where actor_sub = 'system:backfill' or owner_sub like 'service:%'").Trim()
    $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/revert-identity.sql
    $rv = $script:rc
    $after = (Dk exec $db psql -U postgres -d openbrain -tAqc "select count(*) from research_prompts where actor_sub = 'system:backfill' or owner_sub like 'service:%'").Trim()
    $tbl = (Dk exec $db psql -U postgres -d openbrain -tAqc "select coalesce(to_regclass('public.admin_audit')::text, '-') || ' ' || coalesce(to_regclass('public.workspace_impersonation')::text, '-') || ' ' || coalesce(to_regclass('public.workspace_users')::text, '-')").Trim()
    Save 'revert.log' "rw-identity rows before the revert: $bf; after: $after; tables after: $tbl; exit $rv"
    $revOk = ($rv -eq 0) -and [int]$bf -gt 0 -and $after -eq '0' -and $tbl -eq '- - -'
    if ($Red) { Check (-not $revOk) "RED: the base's revert-identity.sql leaves rw-identity's research_prompts rows ($bf -> $after)" }
    else { Check $revOk "revert-identity.sql removes rw-identity's research_prompts rows ($bf -> $after) and its tables ($tbl)" }
  }
} catch {
  Fail "the run stopped: $_"
} finally {
  Write-Host '[7] teardown'
  foreach ($c in $script:made.containers + @("$P-wb", "$P-wbnodef")) { $null = Dk rm -f -v $c }
  if ($script:made.net) { $null = Dk network rm $net }
  if (-not $KeepImages) { foreach ($i in $script:made.images) { $null = Dk rmi -f $i } }
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}' | Out-String).Trim()
  Check (-not $left) "no container labelled $Id is left ($left)"
  $leftNet = (Dk network ls --filter "label=$label" --format '{{.Name}}' | Out-String).Trim()
  Check (-not $leftNet) "no network labelled $Id is left ($leftNet)"
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
