# run-export-gate-tests.ps1 - the disposable lab run for research-workbench P6b (rw-p6b-gate): the
# export verification gate, the export runs and the reference panel's parity with the exported file.
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-export-gate-tests.ps1 -Subnet <x.y.z.0/24>
#       [-Id <owner>] [-Evidence <dir>] [-Red] [-BaseSha bc6d3a6] [-KeepImages]
#
# -Subnet is REQUIRED (harness-subnet.ps1: exactly a /24 outside Docker's default pools and
# 192.168.0.0/16; the run's network takes its lower /25). -Red runs the SAME cases against a workbench
# built from -BaseSha (the development pin P6b was cut from): every clause must FAIL there.
#
# LAB DOCKER SHIM: every docker call goes through Lab-Docker, which REFUSES (nothing run) a published
# port, a network other than this run's (and `none`), a network create that is not --internal on the
# pinned subnet, a macvlan / ipvlan driver, any 192.168.x address, any ai-stack_* / open-brain_* name,
# any :local image, docker compose, and a build tag that is not :wt-<id>[-suffix].
#
# What it does:
#   1. stages the REAL initdb chain from docker-compose.yml (P6b's 310 slot included; -Red: the base's)
#   2. one internal network on the pinned /25
#   3. builds openbrain-workbench:wt-<id> (its build runs the test gate: src/export/gate_test.ts among
#      them) and its test stage (the lab client: pdftotext); -Red: the workbench from -BaseSha
#   4. the lab: database (chain + export-fixtures.sql + gate-fixtures.sql, ob_app_memory non-superuser),
#      stub embedder, the VISION STAND-IN (stub-vision.ts) holding the network aliases `llama-cpp` (the
#      LiteLLM alias) and `llama-cpp-upstream` (a model server nothing may call directly), and the
#      workbench with the lab's identity header and a lab export key (EXPORT_VISION_KEY, a random
#      string - no LiteLLM key is created or used)
#   5. the cases (T1..T6 of the test plan), then the runtime image's process-separation checks
#   6. teardown and the leftover checks
# It never touches the live stack. Exit 0 = every check passed (with -Red: every clause FAILED).
param(
  [string]$Id = 'wt-rw-p6b-gate',
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
$P = "rwp6b-$rand"
$net = "$P-net"
$wbTag = "openbrain-workbench:wt-$short"; $testTag = "openbrain-workbench:wt-$short-test"
if ($Red) { $wbTag = "openbrain-workbench:wt-$short-base" }
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$key = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$visionKey = "sk-lab-export-$rand"   # a lab string standing in for the export's virtual key (no LiteLLM key)
$embedKey = "sk-lab-embed-$rand"
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$Evidence = (Resolve-Path $Evidence).Path
$out = Join-Path $Evidence 'files'; New-Item -ItemType Directory -Force $out | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$vault = Join-Path $env:TEMP "$P-vault"; New-Item -ItemType Directory -Force $vault | Out-Null

$script:fail = 0
$script:made = @{ net = $false; containers = @(); images = @(); dirs = @($stage, $vault) }
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
# -Red: a clause check that must FAIL on the base is recorded as RED-confirmed when it fails
$script:redHits = @{}
function Clause([string]$t, [bool]$ok, [string]$m) {
  if ($Red) {
    if (-not $ok) { $script:redHits[$t] = $true; Write-Host "  RED   $t $m (fails on the base, as it must)" }
    else { Write-Host "  base  $t $m (holds on the base)" }
  } else { Check $ok "$t $m" }
}
function Save([string]$name, [string]$text) {
  $t = $text -replace [regex]::Escape($key), '<key>' -replace [regex]::Escape($pw), '<pw>' -replace [regex]::Escape($appPw), '<pw>'
  [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $t, (New-Object System.Text.UTF8Encoding $false))
}

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
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) {
    try { $p.Kill() } catch { }
    $script:rc = 124
    return "TIMEOUT after ${TimeoutSec}s: docker $($a[0..([Math]::Min(3, $a.Count - 1))] -join ' ')"
  }
  $p.WaitForExit()
  $script:rc = $p.ExitCode
  return (($o.Result + $e.Result) -replace "`r", '').TrimEnd()
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
function Psql([string]$sql) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sql))
  return Dk exec "$P-db" sh -c "echo $b64 | base64 -d | psql -U postgres -d openbrain -X -q -At -v ON_ERROR_STOP=1"
}
# gate-client.ts in a throwaway TEST-image container on the run network; the evidence dir at /ev
function Client([string[]]$argv) {
  return Dk run --rm --label $label --network $net -e "WB_KEY=$key" -v "${ct}:/ct:ro" -v "${Evidence}:/ev" --entrypoint deno $testTag `
    run --allow-net --allow-env --allow-read --allow-write --allow-run /ct/gate-client.ts @argv
}
# one request; returns the client's JSON line as an object; the body lands in files/<file>
function Req([string]$method, [string]$wbHost, [string]$path, [string]$file, [string]$sub = 'lab-user-a', [string]$body = '') {
  $argv = @('req', $method, "http://${wbHost}:8000$path", "/ev/files/$file", $sub)
  # the JSON body travels as a file (a JSON string through docker's Windows argument quoting loses its escapes)
  if ($body) { [System.IO.File]::WriteAllText((Join-Path $out "$file.req.json"), $body, (New-Object System.Text.UTF8Encoding $false)); $argv += "@/ev/files/$file.req.json" }
  $o = Client $argv
  $line = @(($o -split "`n") | Where-Object { $_ -match '^\{"status"' })[-1]
  if (-not $line) { Write-Host "    client: $o"; return [pscustomobject]@{ status = 0; bytes = 0; export_id = $null; gate = $null; type = '' } }
  return ($line | ConvertFrom-Json)
}
function BodyJson([string]$file) { try { return (Get-Content -Raw (Join-Path $out $file) | ConvertFrom-Json) } catch { return $null } }
function Wait-Health([string]$name) {
  for ($i = 0; $i -lt 90; $i++) {
    $null = Dk exec $name deno eval "const r=await fetch('http://localhost:8000/health');Deno.exit(r.ok?0:1)"
    if ($script:rc -eq 0) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}
function Vision([string]$path, [string]$method = 'GET') {
  return Dk run --rm --label $label --network $net --entrypoint deno $testTag eval "const r=await fetch('http://$P-vision:8080$path',{method:'$method'});console.log(await r.text())"
}
function Build-At([string]$sha, [string]$tag) {
  $tree = Join-Path $env:TEMP "$P-tree-$sha"
  if (-not (Test-Path $tree)) {
    New-Item -ItemType Directory -Force $tree | Out-Null
    $script:made.dirs += $tree
    $tar = Join-Path $env:TEMP "$P-$sha.tar"
    & git -C $ob1 archive --format=tar -o $tar $sha
    & tar -xf $tar -C $tree
    Remove-Item -Force $tar
  }
  return @{ log = (DkLong build --label $label --build-arg "OB1_SHA=$sha" -t $tag (Join-Path $tree 'docker/workbench')); tree = $tree }
}

$wbName = "$P-wb"
$wbBase = @('-e', 'PORT=8000', '-e', "WORKBENCH_KEY=$key", '-e', "DB_HOST=$P-db", '-e', 'DB_USER=ob_app_memory', '-e', "DB_PASSWORD=$appPw",
  '-e', 'OPEN_BRAIN_URL=http://unreachable.invalid', '-e', 'EMBEDDING_API_BASE=http://stub-embed:8080/v1', '-e', "EMBEDDING_API_KEY=$embedKey",
  '-e', 'EXTRACT_URL=http://unreachable.invalid', '-e', 'WIKI_GIT_DIR=/wiki', '-e', 'WIKI_ASSETS_DIR=/wiki/assets', '-e', 'CONTRACT_MOUNTS_ROOT=/mounts',
  '-e', 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub', '-e', 'EXPORT_VISION_MODEL=lab-vision-model',
  '-v', "${vault}:/wiki", '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro")
function Start-Wb([string[]]$visionEnv) {
  $null = Dk rm -f -v $wbName
  $script:made.containers = @($script:made.containers | Where-Object { $_ -ne $wbName })
  $e = @(); foreach ($x in $visionEnv) { $e += @('-e', $x) }
  if (-not (Run-Detached $wbName ($wbBase + $e + @($wbTag)))) { return $false }
  return (Wait-Health $wbName)
}

try {
  Write-Host "== rw-p6b-gate lab run  owner=$Id  net=$net  red=$([bool]$Red)  evidence=$Evidence"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  $dirty = (& git -C $ob1 status --porcelain -- docker | Out-String).Trim()
  if ($dirty) { Write-Host "  NOTE  the OB1 tree has uncommitted changes under test:`n$dirty" }
  # ---------------------------------------------------------------- 1. the initdb chain
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $composeDir = $dockerDir
  if ($Red) {
    $bt = Join-Path $env:TEMP "$P-tree-$BaseSha"
    New-Item -ItemType Directory -Force $bt | Out-Null; $script:made.dirs += $bt
    $tar = Join-Path $env:TEMP "$P-$BaseSha.tar"; & git -C $ob1 archive --format=tar -o $tar $BaseSha; & tar -xf $tar -C $bt; Remove-Item -Force $tar
    $composeDir = Join-Path $bt 'docker'
  }
  $compose = Get-Content -Raw (Join-Path $composeDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $composeDir $m[0]) (Join-Path $stage $m[1]) }
  $has310 = @($chain | Where-Object { $_[1] -eq '310-init-export-gate.sql' }).Count -eq 1
  if ($Red) { Write-Host "  base chain: $($chain.Count) migrations (310 present: $has310)" } else { Check $has310 "the chain mounts 310-init-export-gate.sql ($($chain.Count) migrations)" }

  # ---------------------------------------------------------------- 2. network
  Write-Host '[2] the internal network'
  $null = Dk network create --driver bridge --internal --subnet $subnets.run --label $label $net
  Check ($script:rc -eq 0) "network $net (internal, $($subnets.run))"
  if ($script:rc -ne 0) { throw 'network' }
  $script:made.net = $true

  # ---------------------------------------------------------------- 3. images
  Write-Host '[3] images'
  if ($Red) {
    $b = Build-At $BaseSha $wbTag
    Save 'build-workbench-base.log' ($b.log -split "`n" | Select-Object -Last 40 | Out-String)
    Check ($script:rc -eq 0) "RED: $wbTag built from OB1 $BaseSha"
  } else {
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" -t $wbTag $wb
    $clean = ($o -replace '\x1b\[[0-9;]*m', '')
    Save 'build-workbench.log' (($clean -split "`n" | Where-Object { $_ -match 'export gate:|clipped:|clean:|(ok|FAILED) \| \d+ passed|\.\.\. FAILED|error:' }) -join "`n")
    Check ($script:rc -eq 0) "$wbTag built at OB1 $($sha.Substring(0, 7)) (the build test gate passed)"
    if ($script:rc -ne 0) { throw 'build workbench' }
    $gate = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
    if ($gate.Success) { Check ($gate.Groups[1].Value -eq 'ok') "build test gate: $($gate.Value)" } else { Write-Host '  NOTE  the build test gate layer was cached (its log is the earlier build''s)' }
  }
  $script:made.images += $wbTag
  $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --target test -t $testTag $wb
  Check ($script:rc -eq 0) "$testTag (the lab client's image: pdftotext) built from this tree"
  if ($script:rc -ne 0) { throw 'build test' }
  $script:made.images += $testTag

  # ---------------------------------------------------------------- 4. the lab
  Write-Host '[4] the lab'
  if (-not (Run-Detached "$P-db" @('-e', "POSTGRES_PASSWORD=$pw", '-e', 'POSTGRES_DB=openbrain', '-v', "${stage}:/docker-entrypoint-initdb.d:ro", $PgImage))) { throw 'db' }
  for ($i = 0; $i -lt 150; $i++) { if ((Dk logs "$P-db") -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec "$P-db" pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $logs = Dk logs "$P-db"
  Check ($logs -match 'PostgreSQL init process complete') 'the database ran the initdb chain'
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "initdb logged no ERROR ($($errs.Count))"
  $null = Dk exec "$P-db" psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role member) - the production shape'
  foreach ($f in @('export-fixtures.sql', 'gate-fixtures.sql')) {
    $null = Dk cp (Join-Path $ct $f) "$P-db:/tmp/$f"
    $o = Dk exec "$P-db" psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f "/tmp/$f"
    Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) "$f applied"
  }
  if (-not $Red) {
    $o = Psql "SELECT (SELECT definition->>'gate' FROM contract_registry_entries WHERE registry='export_formats' AND key='pdf') || ' ' || (SELECT count(*) FROM contract_registry_entries WHERE registry='export_required_sections')"
    Check ($o.Trim() -eq 'true 1') "the P6b registry rows: pdf gate flag + the roll-up section ($($o.Trim()))"
  }
  # the vault: the authored notes, LF
  $src = Join-Path $ct 'export-gate-vault'
  Get-ChildItem -Recurse -File -Force $src | ForEach-Object {
    $dest = Join-Path $vault $_.FullName.Substring($src.Length).TrimStart('\', '/')
    New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
    [System.IO.File]::WriteAllText($dest, ([System.IO.File]::ReadAllText($_.FullName) -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
  }
  $ctMount = "${ct}:/ct:ro"
  $null = Run-Detached "$P-embed" @('--network-alias', 'stub-embed', '-v', $ctMount, '--entrypoint', 'deno', $testTag, 'run', '--allow-net', '/ct/stub-embed.ts')
  # the vision stand-in: the gateway alias AND an upstream name, so a direct call is SEEN
  $null = Run-Detached "$P-vision" @('--network-alias', 'llama-cpp', '--network-alias', 'llama-cpp-upstream', '-v', $ctMount, '--entrypoint', 'deno', $testTag, 'run', '--allow-net', '/ct/stub-vision.ts')
  Check (Start-Wb @("EXPORT_VISION_KEY=$visionKey")) "workbench $wbName (vision ON: the lab export key, the default URL = the gateway alias) answers /health"

  # ---------------------------------------------------------------- 5. the cases
  Write-Host '[T1] acceptance 1: the clipped-table fixture is blocked, the clean fixture passes'
  $null = Vision '/_mode?m=clean' 'POST'
  $c = Req GET $wbName '/workbench/export?path=notes/p6b/clipped.md&format=pdf' 't1-clipped.out'
  $cb = BodyJson 't1-clipped.out'
  $clipBlocked = ($c.status -eq 422) -and ($cb.code -eq 'layout-gate') -and (@($cb.blocking_findings | Where-Object { $_.code -in @('overflow', 'clipped', 'overlapping-text') }).Count -ge 1)
  Clause 'T1' $clipBlocked "the clipped-table PDF is BLOCKED: $($c.status) $($cb.code) [$(@($cb.blocking_findings | ForEach-Object { "$($_.code)@p$($_.page)" }) -join ', ')]"
  $k = Req GET $wbName '/workbench/export?path=notes/p6b/clean.md&format=pdf' 't1-clean.pdf'
  $cleanHead = ''
  try { $cleanHead = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes((Join-Path $out 't1-clean.pdf'))[0..4]) } catch { }
  Clause 'T1' (($k.status -eq 200) -and ($k.gate -eq 'passed') -and ($cleanHead -eq '%PDF-')) "the clean PDF PASSES the gate and is served: $($k.status) gate=$($k.gate) $cleanHead"
  # the vision verdict decides too: the stand-in reports a blocking fault on the clean PDF
  $null = Vision '/_mode?m=block' 'POST'
  $vb = Req GET $wbName '/workbench/export?path=notes/p6b/clean.md&format=pdf' 't1-clean-vision-block.out'
  $vbb = BodyJson 't1-clean-vision-block.out'
  Clause 'T1' (($vb.status -eq 422) -and (@($vbb.blocking_findings | Where-Object { $_.code -eq 'vision' }).Count -eq 1)) "a vision blocking finding blocks the export ($($vb.status) $(@($vbb.blocking_findings | ForEach-Object code) -join ','))"
  foreach ($m in @('garbage', 'error')) {
    $null = Vision "/_mode?m=$m" 'POST'
    $g = Req GET $wbName '/workbench/export?path=notes/p6b/clean.md&format=pdf' "t1-clean-vision-$m.out"
    $gb = BodyJson "t1-clean-vision-$m.out"
    Clause 'T1' (($g.status -eq 422) -and (@($gb.blocking_findings | Where-Object { $_.code -in @('vision-unreadable', 'vision-unavailable') }).Count -eq 1)) "the vision pass fails closed on a '$m' answer ($($g.status) $(@($gb.blocking_findings | ForEach-Object code) -join ','))"
  }
  $null = Vision '/_mode?m=clean' 'POST'

  Write-Host '[T5] acceptance 5: a research report without the roll-up section is blocked'
  $r1 = Req GET $wbName '/workbench/export?path=notes/p6b/report-rollup.md&format=pdf' 't5-rollup.pdf'
  Clause 'T5' (($r1.status -eq 200) -and ($r1.gate -eq 'passed')) "the report WITH the roll-up section passes ($($r1.status) gate=$($r1.gate))"
  $r0 = Req GET $wbName '/workbench/export?path=notes/p6b/report-no-rollup.md&format=pdf' 't5-no-rollup.out'
  $r0b = BodyJson 't5-no-rollup.out'
  Clause 'T5' (($r0.status -eq 422) -and (@($r0b.blocking_findings | Where-Object { $_.code -eq 'required-section-missing' }).Count -eq 1)) "the report WITHOUT it is BLOCKED ($($r0.status) $(@($r0b.blocking_findings | ForEach-Object code) -join ','))"

  Write-Host '[T2] acceptance 2: the reference panel and the exported PDF, one to one'
  $mk = Req POST $wbName '/workbench/documents' 't2-doc.json' 'lab-user-a' '{"title":"Gate parity document"}'
  $doc = BodyJson 't2-doc.json'
  $dpath = [string]$doc.path
  Check (($mk.status -eq 201) -and $dpath) "user A's document $dpath"
  $f = Req GET $wbName "/workbench/documents/file?path=$([uri]::EscapeDataString($dpath))" 't2-file.json'
  $fj = BodyJson 't2-file.json'
  $content = "$($fj.content)`nThe layout checks [[source:f6b00000-0000-4000-8000-000000000001|page one]] and the reference lists [[source:f6b00000-0000-4000-8000-000000000002|page two]], and again [[source:f6b00000-0000-4000-8000-000000000004|page four]].`n"
  $put = Req PUT $wbName "/workbench/documents/file?path=$([uri]::EscapeDataString($dpath))&commit=1" 't2-put.json' 'lab-user-a' (@{ content = $content; if_match = $fj.hash } | ConvertTo-Json -Compress)
  Check ($put.status -in @(200, 207)) "the document cites G1, G2, G4 ($($put.status))"
  $add = Req POST $wbName '/workbench/documents/references' 't2-add.json' 'lab-user-a' (@{ path = $dpath; source_id = 'f6b00000-0000-4000-8000-000000000003'; form = 'added' } | ConvertTo-Json -Compress)
  Check ($add.status -lt 300) "G3 added deliberately ($($add.status))"
  # G4 is re-titled AFTER the pin (a re-fetch): revision 2, the source's current title changes
  $null = Psql "INSERT INTO source_revisions (source_id, revision, content, title) VALUES ('f6b00000-0000-4000-8000-000000000004', 1, 'x', 'Gate fixture page four as first pinned'), ('f6b00000-0000-4000-8000-000000000004', 2, 'x', 'Gate fixture page four retitled later') ON CONFLICT DO NOTHING; UPDATE sources SET title = 'Gate fixture page four retitled later' WHERE id = 'f6b00000-0000-4000-8000-000000000004'"
  $e = Req GET $wbName "/workbench/export?path=$([uri]::EscapeDataString($dpath))&format=pdf" 't2-doc.pdf'
  Check ($e.status -eq 200) "the document exports to PDF ($($e.status) gate=$($e.gate))"
  $pn = Req GET $wbName "/workbench/documents/references?path=$([uri]::EscapeDataString($dpath))" 't2-panel.json'
  Check ($pn.status -eq 200) "the reference panel's list ($($pn.status))"
  $par = Client @('parity', '/ev/files/t2-panel.json', '/ev/files/t2-doc.pdf')
  Save 't2-parity.log' $par
  foreach ($l in ($par -split "`n")) { Write-Host "    $l" }
  Clause 'T2' (($script:rc -eq 0) -and ($par -match 'PARITY PASS')) 'the panel and the PDF list the same references one to one'
  # the comparator's own RED: the panel against the PDF of another document (fewer entries) FAILS
  $neg = Client @('parity', '/ev/files/t2-panel.json', '/ev/files/t1-clean.pdf')
  Save 't2-parity-negative.log' $neg
  if (-not $Red) { Check (($script:rc -ne 0) -and ($neg -match 'PARITY FAIL')) 'the parity check FAILS a mismatched pair (the panel against another PDF)' }

  Write-Host '[T3] acceptance 3: the vision calls go through the LiteLLM alias under the export key; a direct route is refused'
  $log = (Vision '/_log') | ConvertFrom-Json
  Save 't3-vision-log.json' (($log | ConvertTo-Json -Depth 4) -replace [regex]::Escape($visionKey), '<lab export key>')
  $calls = @($log | Where-Object { $_.path -eq '/v1/chat/completions' })
  $viaAlias = @($calls | Where-Object { $_.host -match '^llama-cpp(:8080)?$' -and $_.auth -eq "Bearer $visionKey" -and $_.model -eq 'lab-vision-model' -and $_.images -ge 1 -and $_.schema -eq 'export_layout_verdict' })
  Clause 'T3' (($calls.Count -ge 1) -and ($viaAlias.Count -eq $calls.Count)) "every vision call ($($calls.Count)) went to host llama-cpp with the export key's bearer, the model, the page images and the verdict schema"
  Clause 'T3' (@($calls | Where-Object { $_.host -match 'upstream' }).Count -eq 0) 'no call addressed an *-upstream host'
  if (-not $Red) {
    $null = Vision '/_reset' 'POST'
    Check (Start-Wb @("EXPORT_VISION_KEY=$visionKey", 'EXPORT_VISION_URL=http://llama-cpp-upstream:8080/v1')) 'workbench restarted with EXPORT_VISION_URL = an upstream (a direct call)'
    $d = Req GET $wbName '/workbench/export?path=notes/p6b/clean.md&format=pdf' 't3-direct.out'
    $db2 = BodyJson 't3-direct.out'
    $after = @(((Vision '/_log') | ConvertFrom-Json) | Where-Object { $_.path -eq '/v1/chat/completions' })
    Check (($d.status -eq 422) -and (@($db2.blocking_findings | Where-Object { $_.code -eq 'vision-misrouted' }).Count -eq 1) -and ($after.Count -eq 0)) "a direct route is refused before any request: $($d.status) $(@($db2.blocking_findings | ForEach-Object code) -join ','); the stand-in saw $($after.Count) request(s)"
    Check (Start-Wb @("EXPORT_VISION_KEY=$embedKey")) 'workbench restarted with the export key = the embedding key'
    $s = Req GET $wbName '/workbench/export?path=notes/p6b/clean.md&format=pdf' 't3-shared.out'
    $sb = BodyJson 't3-shared.out'
    $after = @(((Vision '/_log') | ConvertFrom-Json) | Where-Object { $_.path -eq '/v1/chat/completions' })
    Check (($s.status -eq 422) -and (@($sb.blocking_findings | Where-Object { $_.code -eq 'vision-key-shared' }).Count -eq 1) -and ($after.Count -eq 0)) "another consumer's key is refused: $($s.status) $(@($sb.blocking_findings | ForEach-Object code) -join ','); $($after.Count) request(s)"
    Check (Start-Wb @()) 'workbench restarted INERT (no export key)'
    $n = Req GET $wbName '/workbench/export?path=notes/p6b/clean.md&format=pdf' 't3-inert.pdf'
    $after = @(((Vision '/_log') | ConvertFrom-Json) | Where-Object { $_.path -eq '/v1/chat/completions' })
    $runs = Req GET $wbName '/workbench/exports?limit=1' 't3-inert-run.json'
    $rj = BodyJson 't3-inert-run.json'
    Check (($n.status -eq 200) -and ($after.Count -eq 0) -and (@($rj.exports[0].warnings | Where-Object { $_.code -eq 'vision-not-configured' }).Count -eq 1)) "shipped inert: the PDF is gated by the structure checks alone, 0 vision requests, the run says vision-not-configured ($($n.status))"
    $null = Start-Wb @("EXPORT_VISION_KEY=$visionKey")
  }

  Write-Host '[T6] acceptance 6: the export routes and runs are per user'
  $aList = Req GET $wbName '/workbench/exports?limit=200' 't6-a-list.json' 'lab-user-a'
  $al = BodyJson 't6-a-list.json'
  $aIds = @($al.exports | ForEach-Object id)
  Clause 'T6' (($aList.status -eq 200) -and ($aIds.Count -ge 3)) "user A lists A's own runs ($($aList.status), $($aIds.Count))"
  $aPassed = @($al.exports | Where-Object { $_.status -eq 'passed' } | Select-Object -First 1)
  $aBlocked = @($al.exports | Where-Object { $_.status -eq 'blocked' } | Select-Object -First 1)
  if (-not $Red) {
    $fa = Req GET $wbName "/workbench/exports/$($aPassed[0].id)/file" 't6-a-file.pdf' 'lab-user-a'
    Check (($fa.status -eq 200) -and ($fa.type -eq 'application/pdf')) "A downloads A's passed export again ($($fa.status))"
    $fbA = Req GET $wbName "/workbench/exports/$($aBlocked[0].id)/file" 't6-a-blocked-file.out' 'lab-user-a'
    Check ($fbA.status -eq 404) "a BLOCKED run has no file, even for its owner ($($fbA.status))"
    $bList = Req GET $wbName '/workbench/exports?limit=200' 't6-b-list.json' 'lab-user-b'
    $bl = BodyJson 't6-b-list.json'
    $leak = @($bl.exports | Where-Object { $aIds -contains $_.id })
    Check (($bList.status -eq 200) -and ($leak.Count -eq 0)) "user B's list holds none of A's runs ($(@($bl.exports).Count) listed, $($leak.Count) of A's)"
    $hits = 0
    # (loop variables: PowerShell names are case-insensitive - $id would be $Id, $p would be $P)
    foreach ($runId in @($aPassed[0].id, $aBlocked[0].id)) {
      foreach ($route in @("/workbench/exports/$runId", "/workbench/exports/$runId/file")) {
        $x = Req GET $wbName $route "t6-b-$($runId.Substring(0, 8))-$(($route -split '/')[-1]).out" 'lab-user-b'
        if ($x.status -ne 404) { $hits++; Write-Host "    B got $($x.status) for $route" }
      }
    }
    Check ($hits -eq 0) "B asking for A's runs by id (record and file) gets 404 every time ($hits leaks)"
    $bp = Req GET $wbName "/workbench/exports?path=$([uri]::EscapeDataString($dpath))" 't6-b-path.out' 'lab-user-b'
    Check ($bp.status -eq 404) "B naming A's document path in ?path= is refused 404 (owner scope) ($($bp.status))"
    $be = Req GET $wbName "/workbench/export?path=$([uri]::EscapeDataString($dpath))&format=pdf" 't6-b-export.out' 'lab-user-b'
    Check ($be.status -eq 404) "B exporting A's document is 404 ($($be.status))"
    $owners = (Psql "SELECT string_agg(DISTINCT owner_sub, ',' ORDER BY owner_sub) FROM export_runs").Trim()
    Check ($owners -eq 'lab-user-a') "every run recorded is A's own (owner_sub: $owners)"
  }

  # ---------------------------------------------------------------- the runtime image
  Write-Host '[T4] acceptance 4: pdftoppm is a separate, unmodified program; nothing links or imports poppler; the notices list it'
  $o = Dk run --rm --label $label --network none --entrypoint sh $wbTag -c @'
pdftoppm -v 2>&1 | head -1
dpkg -s poppler-utils 2>/dev/null | grep '^Version'
echo "deno-links: $(ldd "$(command -v deno)" 2>/dev/null | grep -ci poppler)"
echo "python-links: $(find /opt/export-gate -name '*.so*' -exec ldd {} \; 2>/dev/null | grep -ci poppler)"
echo "gate-env-poppler-files: $(find /opt/export-gate -iname '*poppler*' 2>/dev/null | wc -l)"
echo "imports: $(/opt/export-gate/bin/python -I -c 'import sys, pikepdf, pdfplumber; print(sorted(m for m in sys.modules if "poppler" in m.lower() or "pdf2image" in m.lower()))' 2>&1)"
echo "src-bindings: $(grep -rlE 'pdf2image|python-poppler|libpoppler|Deno\.dlopen|import +poppler|from +poppler' /app/src /app/gate 2>/dev/null | wc -l)"
grep '^| poppler-utils' /app/THIRD-PARTY-NOTICES.md | cut -d'|' -f2-5 | cut -c1-260
'@
  Save 't4-runtime.txt' $o
  foreach ($l in ($o -split "`n")) { Write-Host "    $l" }
  $ver = ([regex]'pdftoppm version ([0-9.]+)').Match($o).Groups[1].Value
  Clause 'T4' (($ver -ne '') -and ($o -match "\| $([regex]::Escape($ver))") -and ($o -match 'SEPARATE PROCESS only')) "the runtime image runs pdftoppm $ver and the notices row carries that version as a separate process"
  Clause 'T4' (($o -match 'deno-links: 0') -and ($o -match 'python-links: 0') -and ($o -match 'gate-env-poppler-files: 0') -and ($o -match 'imports: \[\]') -and ($o -match 'src-bindings: 0')) 'no poppler library linked into deno or the gate''s Python, none installed in the gate''s environment, none imported, no binding in the source'
  if (-not $Red) {
    # pdftoppm is a CHILD PROCESS of the workbench during an export, over files (sampled while the gate
    # runs). The sampler is a file in the lab vault (mounted at /wiki), so no shell text crosses the
    # Windows argument quoting.
    $null = Vision '/_reset' 'POST'
    $sampler = @'
touch /wiki/p6b-sampler.ready
for i in $(seq 1 3000); do
  for p in /proc/[0-9]*; do
    c=$( (tr '\0' ' ' < "$p/cmdline") 2>/dev/null)
    case "$c" in pdftoppm*|*/pdftoppm\ *) echo "PS $(cut -d' ' -f4 "$p/stat") :: $c"; exit 0;; esac
  done
  sleep 0.005
done
echo "PS none"
'@
    $mainpid = @'
for p in /proc/[0-9]*; do
  c=$( (tr '\0' ' ' < "$p/cmdline") 2>/dev/null)
  case "$c" in deno\ run*src/main.ts*) echo "${p#/proc/}";; esac
done
'@
    [System.IO.File]::WriteAllText((Join-Path $vault 'p6b-sampler.sh'), ($sampler -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
    [System.IO.File]::WriteAllText((Join-Path $vault 'p6b-mainpid.sh'), ($mainpid -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
    $job = Start-Job -ScriptBlock { param($c) & docker exec $c sh /wiki/p6b-sampler.sh } -ArgumentList $wbName
    $ready = Join-Path $vault 'p6b-sampler.ready'
    for ($i = 0; $i -lt 100 -and -not (Test-Path $ready); $i++) { Start-Sleep -Milliseconds 200 }
    $null = Req GET $wbName '/workbench/export?path=notes/p6b/clean.md&format=pdf' 't4-sample.pdf'
    $ps = (Receive-Job -Wait $job | Out-String).Trim(); Remove-Job $job
    $wbPid = (Dk exec $wbName sh /wiki/p6b-mainpid.sh).Trim()
    Save 't4-process.txt' "$ps`nworkbench pid: $wbPid"
    $m = [regex]::Match($ps, '^PS (\d+) :: ((?:\S*/)?pdftoppm .*)$')
    Check ($m.Success -and ($m.Groups[1].Value -eq $wbPid) -and ($m.Groups[2].Value -match '-png .*/export\.pdf')) "pdftoppm ran as a separate process, a child of the workbench (ppid $($m.Groups[1].Value) = $wbPid), over a file: $($m.Groups[2].Value)"
  }

  Save 'workbench.log' ((Dk logs --tail 120 $wbName) -replace [regex]::Escape($visionKey), '<lab export key>')
  $runsDump = Psql "SELECT owner_sub || ' ' || path || ' ' || status || ' ' || coalesce((SELECT string_agg(f->>'code', ',') FROM jsonb_array_elements(blocking_findings) f), '-') FROM export_runs ORDER BY created_at"
  Save 'export-runs.txt' $runsDump
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
  foreach ($d in $script:made.dirs) { if (Test-Path $d) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } }
}
if ($Red) {
  $want = @('T1', 'T2', 'T3', 'T4', 'T5', 'T6')
  $missing = @($want | Where-Object { -not $script:redHits[$_] })
  Write-Host "== RED: clauses failing on the base: $(@($want | Where-Object { $script:redHits[$_] }) -join ', ')$(if ($missing.Count) { "; NOT failing: $($missing -join ', ')" })"
  exit $(if ($missing.Count -or $script:fail) { 1 } else { 0 })
}
Write-Host "== $(if ($script:fail) { "FAILED ($($script:fail))" } else { 'ALL PASSED' })"
exit $(if ($script:fail) { 1 } else { 0 })
