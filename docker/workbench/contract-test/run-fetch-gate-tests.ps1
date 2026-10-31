# run-fetch-gate-tests.ps1 - the disposable lab run for rw-workbench-fetch-posture: the workbench's three
# fetchers of a user-supplied URL (the URL import, the source re-fetch, the P2b held-link replace) are
# callers of the search gate's POST /v1/fetch, against a STUB gate and a lab target site.
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-fetch-gate-tests.ps1 -Subnet <x.y.z.0/24> [-Id <owner>] [-Evidence <dir>] [-Red]
#
# -Subnet is REQUIRED (harness-subnet.ps1: exactly a /24 outside Docker's default pools and
# 192.168.0.0/16); -Evidence must be absent or empty. -Red runs the SAME tests (this tree's test stage)
# against a workbench built from -BaseSha (the development pin before this item): every case must FAIL,
# and the static search (client_test.ts A6/A8) is run against the base tree and must FAIL.
#
# LAB DOCKER SHIM (as run-workspace-tests.ps1): every docker call goes through Lab-Docker, which
# REFUSES (exit 2, nothing run) a published port, a network other than this run's (and `none`), a
# network create that is not --internal on the pinned subnet, a macvlan / ipvlan driver, any 192.168.x
# address, any ai-stack_* / open-brain_* name, any :local image, docker compose, and a build tag that is
# not :wt-<id>[-suffix]. Everything is labelled ai-stack.harness.owner=<Id> and removed at the end.
#
# What it does:
#   1. stages the REAL initdb chain from docker-compose.yml
#   2. one internal network on the pinned /25
#   3. builds openbrain-workbench:wt-<id> (its test gate runs src/fetch-gate/ and src/export/ - the
#      resolver's suites) and its test stage; with -Red the workbench comes from -BaseSha
#   4. the lab: database (chain + fixtures.sql, ob_app_memory non-superuser), stub embedder, the lab
#      target (stub-target.ts: logs every caller's address), the stub gate (stub-gate.ts: the route's
#      request/answer shape), and THREE workbenches on one vault: configured (gate URL + key), no key
#      (WORKBENCH_GATE_KEY blank), no gate (the gate's name resolves nowhere)
#   5. the integration test (src/fetch-gate/fetch_gate_integration_test.ts) from the test stage; the
#      static search; the resolver unchanged since -BaseSha
#   6. teardown and the leftover checks
# It never touches the live stack: no search-gateway, no search/secrets. Exit 0 = every check passed
# (with -Red: every case FAILED).
param(
  [string]$Id = 'wt-rw-fetch-posture',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$BaseSha = 'bc6d3a6',
  [switch]$Red,
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
$P = "rwfg-$rand"
$net = "$P-net"
$wbTag = "openbrain-workbench:wt-$short"; $wbTestTag = "openbrain-workbench:wt-$short-test"
if ($Red) { $wbTag = "openbrain-workbench:wt-$short-base" }
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$key = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$gateKey = -join ((48..57 + 97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
$evStage = Join-Path $env:TEMP "$P-evstage"; New-Item -ItemType Directory -Force $evStage | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$vault = Join-Path $env:TEMP "$P-vault"; New-Item -ItemType Directory -Force $vault | Out-Null
. (Join-Path $PSScriptRoot 'evidence-gate.ps1')

$script:fail = 0
$script:made = @{ net = $false; containers = @(); images = @(); dirs = @($evStage, $stage, $vault) }
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Redact([string]$s) { ($s -replace [regex]::Escape($key), '<key>') -replace [regex]::Escape($gateKey), '<gate-key>' }
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $evStage $name), (Redact $text), (New-Object System.Text.UTF8Encoding $false)) }

# -- the lab docker shim (run-workspace-tests.ps1's) ----------------------------------------
function Test-LabDockerArgs([string[]]$a) {
  $all = ($a -join ' ')
  if ($a.Count -and $a[0] -eq 'compose') { return 'docker compose is never used by the lab' }
  if ($all -match '192\.168\.') { return 'a 192.168.x address' }
  if ($all -match '(^|[\s=:/])(ai-stack_|open-brain_)') { return 'an ai-stack_* / open-brain_* name' }
  if ($all -match 'search-gateway') { return 'the live search-gateway' }
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
  @('run', '-p', '8080:8080', 'x'), @('run', '--network', 'ai-stack_default', 'x'), @('network', 'create', '--driver', 'macvlan', 'n'),
  @('network', 'create', 'n'), @('run', 'openbrain-workbench:local'), @('run', '-e', 'X=192.168.1.20', 'x'), @('compose', 'up'),
  @('build', '-t', 'openbrain-workbench:local', '.'), @('run', '--publish=1:1', 'x'), @('exec', 'search-gateway', 'true'))
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
    $null = Dk run --rm --label $label --network $net --entrypoint deno $wbTag eval "const r=await fetch('$url').catch(()=>null);Deno.exit(r&&r.status<500?0:1)"
    if ($script:rc -eq 0) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}
function IpOf([string]$name) { (Dk inspect -f "{{(index .NetworkSettings.Networks `"$net`").IPAddress}}" $name).Trim() }

$baseTree = ''
try {
  Write-Host "== rw-workbench-fetch-posture lab run  owner=$Id  net=$net  red=$([bool]$Red)  evidence=$Evidence"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check ($chain.Count -gt 10) "the chain staged ($($chain.Count) migrations)"

  Write-Host '[2] the internal network'
  $null = Dk network create --driver bridge --internal --subnet $subnets.run --label $label $net
  Check ($script:rc -eq 0) "network $net (internal, $($subnets.run))"
  if ($script:rc -ne 0) { throw 'network' }
  $script:made.net = $true

  Write-Host '[3] images'
  if ($Red) {
    $baseTree = Join-Path $env:TEMP "$P-tree-$BaseSha"
    New-Item -ItemType Directory -Force $baseTree | Out-Null
    $script:made.dirs += $baseTree
    $tar = Join-Path $env:TEMP "$P-$BaseSha.tar"
    & git -C $ob1 archive --format=tar -o $tar $BaseSha
    & tar -xf $tar -C $baseTree
    Remove-Item -Force $tar
    $o = DkLong build --label $label --build-arg "OB1_SHA=$BaseSha" -t $wbTag (Join-Path $baseTree 'docker/workbench'); Save 'build-workbench-base.log' ($o -split "`n" | Select-Object -Last 40 | Out-String)
    Check ($script:rc -eq 0) "RED: $wbTag built from OB1 $BaseSha"
  } else {
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" -t $wbTag $wb; Save 'build-workbench.log' ($o -split "`n" | Select-Object -Last 80 | Out-String)
    Check ($script:rc -eq 0) "$wbTag built at OB1 $($sha.Substring(0, 7)) (its test gate passed: src/fetch-gate/, src/export/ incl. the resolver, src/documents/, ...)"
  }
  if ($script:rc -ne 0) { throw 'build workbench' }
  $script:made.images += $wbTag
  $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --target test -t $wbTestTag $wb; Save 'build-workbench-test.log' ($o -split "`n" | Select-Object -Last 60 | Out-String)
  Check ($script:rc -eq 0) "$wbTestTag (this tree's test stage) built"
  if ($script:rc -ne 0) { throw 'build test stage' }
  $script:made.images += $wbTestTag

  Write-Host '[4] the lab'
  $db = "$P-db"
  if (-not (Run-Detached $db @('--network-alias', 'openbrain-db', '-e', "POSTGRES_PASSWORD=$pw", '-e', 'POSTGRES_DB=openbrain', '-v', "${stage}:/docker-entrypoint-initdb.d:ro", $PgImage))) { throw 'db' }
  for ($i = 0; $i -lt 150; $i++) { if ((Dk logs $db) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $logs = Dk logs $db
  Check ($logs -match 'PostgreSQL init process complete') 'the database ran the initdb chain'
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "initdb logged no ERROR ($($errs.Count))"
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role) - the production shape'
  $null = Dk cp (Join-Path $ct 'fixtures.sql') "${db}:/tmp/fixtures.sql"
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/fixtures.sql
  Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) 'fixtures applied'

  $ctMount = "${ct}:/ct:ro"
  $null = Run-Detached "$P-embed" @('--network-alias', 'stub-embed', '-v', $ctMount, '--entrypoint', 'deno', $wbTestTag, 'run', '--allow-net', '/ct/stub-embed.ts')
  $null = Run-Detached "$P-target" @('--network-alias', 'stub-target', '-v', $ctMount, '--entrypoint', 'deno', $wbTestTag, 'run', '--allow-net', '/ct/stub-target.ts')
  $null = Run-Detached "$P-gate" @('--network-alias', 'stub-gate', '-v', $ctMount, '-e', "STUB_GATE_KEY=$gateKey", '-e', 'STUB_GATE_ALLOW=stub-target:8080',
      '--entrypoint', 'deno', $wbTestTag, 'run', '--allow-net', '--allow-env', '/ct/stub-gate.ts')
  $common = @('-e', 'PORT=8000', '-e', "WORKBENCH_KEY=$key", '-e', "DB_HOST=$db", '-e', 'DB_USER=ob_app_memory', '-e', "DB_PASSWORD=$appPw",
      '-e', 'OPEN_BRAIN_URL=http://openbrain-rest.invalid', '-e', 'EMBEDDING_API_BASE=http://stub-embed:8080/v1', '-e', 'EXTRACT_URL=http://unreachable.invalid',
      '-e', 'WIKI_GIT_DIR=/wiki', '-e', 'WIKI_ASSETS_DIR=/wiki/assets', '-e', 'CONTRACT_MOUNTS_ROOT=/mounts',
      # the export resolver's proxy (unchanged by this item); a name that resolves nowhere in the lab
      '-e', 'FETCH_PROXY_URL=http://no-proxy.invalid:3128',
      '-v', "${vault}:/wiki", '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro")
  $null = Run-Detached "$P-wb" ($common + @('-e', 'WORKBENCH_GATE_URL=http://stub-gate:8080', '-e', "WORKBENCH_GATE_KEY=$gateKey", $wbTag))
  $null = Run-Detached "$P-wbnokey" ($common + @('-e', 'WORKBENCH_GATE_URL=http://stub-gate:8080', '-e', 'WORKBENCH_GATE_KEY=', $wbTag))
  $null = Run-Detached "$P-wbnogate" ($common + @('-e', 'WORKBENCH_GATE_URL=http://no-gate.invalid:8080', '-e', "WORKBENCH_GATE_KEY=$gateKey", $wbTag))
  foreach ($n in @("$P-wb", "$P-wbnokey", "$P-wbnogate")) { Check (Wait-Http "http://${n}:8000/health" 90) "$n is up" }
  Check (Wait-Http 'http://stub-target:8080/__log' 30) 'the lab target is up'
  Check (Wait-Http 'http://stub-gate:8080/__log' 30) 'the stub gate is up'
  $gateIp = IpOf "$P-gate"
  $wbIps = @("$P-wb", "$P-wbnokey", "$P-wbnogate" | ForEach-Object { IpOf $_ })
  Check ($gateIp -match '^\d+\.\d+\.\d+\.\d+$' -and @($wbIps | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' }).Count -eq 3) "addresses: gate $gateIp, workbenches $($wbIps -join ', ')"

  Write-Host '[5a] the integration test (src/fetch-gate/fetch_gate_integration_test.ts)'
  $o = Lab-Docker 900 @('run', '--rm', '--label', $label, '--network', $net,
    '-e', "FETCH_GATE_TEST_BASE=http://${P}-wb:8000", '-e', "FETCH_GATE_TEST_NOKEY_BASE=http://${P}-wbnokey:8000", '-e', "FETCH_GATE_TEST_NOGATE_BASE=http://${P}-wbnogate:8000",
    '-e', "FETCH_GATE_TEST_KEY=$key", '-e', 'FETCH_GATE_TEST_TARGET=http://stub-target:8080', '-e', 'FETCH_GATE_TEST_GATE=http://stub-gate:8080',
    '-e', "FETCH_GATE_TEST_GATE_IP=$gateIp", '-e', "FETCH_GATE_TEST_WB_IPS=$($wbIps -join ',')",
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', 'src/fetch-gate/fetch_gate_integration_test.ts')
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  # the case lines and each failure's first line (the whole output is over the evidence gate's 16 KB cap)
  Save 'fetch-gate-integration.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED|ignored)|^error: |^(ok|FAILED) \|' } | ForEach-Object { if ($_.Length -gt 400) { $_.Substring(0, 400) } else { $_ } }) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)' }) { Write-Host "    $l" }
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
  if ($Red) { Check ($sum.Success -and [int]$sum.Groups[2].Value -eq 0) "RED: every integration case fails on the base ($($sum.Value))" }
  else { Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0 -and [int]$sum.Groups[2].Value -ge 16) "the integration test ($($sum.Value))" }

  Write-Host '[5b] the static search (client_test.ts A6/A8) and the offline gate-client tests'
  if ($Red) {
    $o = Lab-Docker 300 @('run', '--rm', '--label', $label, '--network', 'none', '-v', "$(Join-Path $baseTree 'docker/workbench/src'):/base-src:ro",
      '-e', 'FETCH_POSTURE_SRC=/base-src', $wbTestTag, 'deno', 'test', '--allow-env', '--allow-read', '--allow-net', 'src/fetch-gate/client_test.ts', '--filter', 'A6/A8')
    $clean = ($o -replace '\x1b\[[0-9;]*m', ''); Save 'static-search-base.log' $clean
    Check ($clean -match 'FAILED \| 0 passed \| 1 failed' -and $clean -match 'bare fetch\(url' -and $clean -match 'FETCH_PROXY_URL') 'RED: the static search finds the base tree''s direct fetchers'
  } else {
    $o = Lab-Docker 300 @('run', '--rm', '--label', $label, '--network', 'none', $wbTestTag, 'deno', 'test', '--allow-env', '--allow-read', '--allow-net', 'src/fetch-gate/client_test.ts')
    $clean = ($o -replace '\x1b\[[0-9;]*m', ''); Save 'gate-client-unit.log' $clean
    $u = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
    Check ($u.Success -and $u.Groups[1].Value -eq 'ok' -and [int]$u.Groups[3].Value -eq 0) "the gate client + the static search ($($u.Value))"
    # acceptance 7: the export resolver is the base's, byte for byte
    $rd = (& git -C $ob1 diff --stat $BaseSha HEAD -- docker/workbench/src/export/ | Out-String).Trim()
    $wd = (& git -C $ob1 diff --stat -- docker/workbench/src/export/ | Out-String).Trim()
    Check ((-not $rd) -and (-not $wd)) "src/export/ (the resolver and its tests) is unchanged since $BaseSha ('$rd$wd')"
  }
  Save 'workbench.log' (Dk logs --tail 120 "$P-wb")
  Save 'stub-gate-log.json' ((Dk run --rm --label $label --network $net --entrypoint deno $wbTag eval "console.log(await (await fetch('http://stub-gate:8080/__log')).text())") | Out-String)
  Save 'stub-target-log.json' ((Dk run --rm --label $label --network $net --entrypoint deno $wbTag eval "console.log(await (await fetch('http://stub-target:8080/__log')).text())") | Out-String)
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
