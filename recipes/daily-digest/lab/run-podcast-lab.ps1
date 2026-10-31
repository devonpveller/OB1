# run-podcast-lab.ps1 - the disposable lab run for research-workbench P7a (rw-p7a-tts): Kokoro behind
# a lab LiteLLM, the renderer and archive writer, and the Open Notebook capture over a COPY of ON's
# datastore (a surreal export and the notebook_data audio files - never the live ON).
#
#   powershell -NoProfile -File OB1\recipes\daily-digest\lab\run-podcast-lab.ps1 -Subnet <a.b.c.0/24>
#       -OnExport <surreal-*.surql or .surql.gz> -OnData <dir holding podcasts/episodes/*/audio/*.mp3>
#       [-Id wt-<you>] [-Evidence <empty dir>] [-Gpu] [-GpuMarginMiB 512] [-Red -BaseSha bc6d3a6]
#
# LAB DOCKER SHIM (the same rules as the workbench runners): every docker call goes through Lab-Docker,
# which REFUSES a published port, a network other than this run's, a network create that is not
# --internal on the pinned subnet, macvlan/ipvlan, any 192.168.x address, any ai-stack_* / open-brain_*
# name, any :local image, docker compose, and a build/tag that is not :wt-<id>. Every container, the
# network and every image is labelled ai-stack.harness.owner=<Id> and removed at the end.
#
# What it does:
#   1. stages the REAL initdb chain from OB1/docker/docker-compose.yml (330-init-podcasts.sql included)
#   2. one internal network
#   3. builds openbrain-workbench:wt-<id> and openbrain-podcast:wt-<id> (+ its test stage: the unit
#      tests, the notices check and the chain e2e run in the build); tags the gateway's pinned LiteLLM
#      digest as litellm:wt-<id>
#   4. the lab: database, PostgREST + the OB1 rest Caddy, the workbench (archive mount at
#      /mounts/podcast-archive, read-only as in compose), Kokoro (the pinned image, alias
#      kokoro-tts-upstream), LiteLLM (alias llama-cpp; the SHIPPED route fragment local.tts.yaml merged
#      by the SHIPPED assemble-config.py onto the shipped base config minus its ledger-DB settings),
#      SurrealDB (the pinned image) with the export imported, an Open Notebook SINKHOLE (alias
#      open_notebook:5055), and the podcast service (archive mount read-write, ON_BASE at the sinkhole)
#   5. the cases: the speech route; the capture on the copy (presenter model, archive, ledger,
#      migration); the archive check and a sample play; quiesce detection; the migrated re-render; the
#      front end never offers an archived episode; C3 cache counts; C5 two distinct presenters; C13 the
#      destination setting; C14 transcodes; C15 a render request through the workbench, two users;
#      C2 a podcast-service render with ON_BASE at the sinkhole (the chain e2e itself runs in the
#      build); with -Gpu, C4 GPU memory with llama.cpp loaded during synthesis (inference lease held)
#   6. teardown, leftovers, no :local image changed
param(
  [string]$Id = 'wt-rw-p7a-tts',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$OnExport = '',
  [string]$OnData = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
  [string]$CaddyImage = 'caddy:2-alpine',
  [string]$SurrealImage = 'surrealdb/surrealdb@sha256:d653f6c8a89e81f865ee31cd2f587c50f50ace922175e04150b1e385d2f86011',
  [switch]$Gpu,
  [int]$GpuMarginMiB = 512,
  [switch]$Red,
  [string]$BaseSha = 'bc6d3a6',
  [switch]$KeepImages
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$here = $PSScriptRoot
$recipe = Split-Path -Parent $here
$ob1 = Split-Path -Parent (Split-Path -Parent $recipe)
$repo = Split-Path -Parent $ob1
$dockerDir = Join-Path $ob1 'docker'
$wb = Join-Path $dockerDir 'workbench'
. (Join-Path $wb 'contract-test/harness-subnet.ps1')
$w = Test-HarnessSubnet $Subnet
if ($w) { Write-Host "REFUSED: $w"; exit 2 }
$subnets = Split-HarnessSubnet $Subnet
if ($Evidence -and (Test-Path $Evidence) -and @(Get-ChildItem -Force $Evidence).Count) { Write-Host "REFUSED: -Evidence $Evidence is not empty"; exit 2 }
if (-not $OnExport -or -not (Test-Path $OnExport)) { Write-Host "REFUSED: -OnExport <a surreal export of ON> is required"; exit 2 }
if (-not $OnData -or -not (Test-Path (Join-Path $OnData 'podcasts'))) { Write-Host "REFUSED: -OnData <dir with podcasts/episodes/...> is required"; exit 2 }

$label = "ai-stack.harness.owner=$Id"
$short = ($Id -replace '^wt-', '')
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$P = "p7a-$rand"
$net = "$P-net"
$wbTag = "openbrain-workbench:wt-$short"; $podTag = "openbrain-podcast:wt-$short"; $podTestTag = "openbrain-podcast:wt-$short-test"
$llmTag = "litellm:wt-$short"
$llmDigest = 'ghcr.io/berriai/litellm@sha256:c98c9395c56a35b7abacff8269d43ff99aabacb62bbf42a04cc1514fcb9bde4a'
$kokoroImage = (([regex]'(?m)^\s+image:\s*(\S+)').Match((Get-Content -Raw (Join-Path $repo 'inference/compose/tts.yml')))).Groups[1].Value
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$key = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$master = 'sk-lab-' + (-join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ }))
$surrealPw = -join ((48..57 + 97..122) | Get-Random -Count 20 | ForEach-Object { [char]$_ })
$labSub = "lab-operator-$rand"
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$archive = Join-Path $env:TEMP "$P-archive"; New-Item -ItemType Directory -Force $archive | Out-Null
$cfgDir = Join-Path $env:TEMP "$P-litellm"; New-Item -ItemType Directory -Force (Join-Path $cfgDir 'conf.d') | Out-Null
$audioEv = Join-Path $Evidence 'audio'; New-Item -ItemType Directory -Force $audioEv | Out-Null

$script:fail = 0
$script:made = @{ net = $false; containers = @(); images = @(); tags = @(); dirs = @($stage, $archive, $cfgDir) }
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Redact([string]$t) { return ($t -replace [regex]::Escape($key), '<key>' -replace [regex]::Escape($master), '<master>' -replace [regex]::Escape($pw), '<pw>' -replace [regex]::Escape($appPw), '<pw>' -replace [regex]::Escape($surrealPw), '<pw>') }
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $Evidence $name), (Redact $text), (New-Object System.Text.UTF8Encoding $false)) }

# -- the lab docker shim (the workbench runners' rules) -----------------------------------------
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
  if ($a.Count -ge 3 -and $a[0] -eq 'tag' -and $a[2] -notmatch ":wt-$([regex]::Escape($short))(-[a-z0-9]+)?$") { return "a tag that is not :wt-$short ($($a[2]))" }
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
function DkLong { Lab-Docker 3600 ([string[]]$args) }

$shimCases = @(
  @('run', '-p', '8080:8080', 'x'), @('run', '--network', 'ai-stack_llm-net', 'x'), @('network', 'create', '--driver', 'macvlan', 'n'),
  @('network', 'create', 'n'), @('run', 'openbrain-podcast:local'), @('run', '-e', 'X=192.168.1.20', 'x'), @('compose', 'up'),
  @('build', '-t', 'openbrain-podcast:local', '.'), @('run', '--publish=1:1', 'x'), @('tag', 'x', 'litellm:local'))
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
# a one-shot in the podcast image on the lab network (the podcast service's own env + extra)
$podEnv = @('-e', 'CHAT_API_BASE=http://llama-cpp:8080/v1', '-e', "PODCAST_TTS_KEY=$master", '-e', "PODCAST_OWNER_SUB=$labSub",
  '-e', 'BRAIN_REST_URL=http://openbrain-rest', '-e', 'WORKBENCH_URL=http://openbrain-workbench:8000', '-e', "MCP_ACCESS_KEY=$key",
  '-e', 'ON_BASE=http://open_notebook:5055')
function Pod([int]$timeout, [string[]]$extra, [string[]]$cmd) {
  return Lab-Docker $timeout (@('run', '--rm', '--label', $label, '--network', $net) + $podEnv + $extra + @('-v', "${archive}:/mounts/podcast-archive", '-v', "${recipe}:/app:ro", '-w', '/app', '--entrypoint', 'deno', $podTag) + $cmd)
}
function Probe([string]$o) {
  $m = ([regex]'(?m)^PROBE (.+)$').Match($o)
  if (-not $m.Success) { return $null }
  try { return ($m.Groups[1].Value | ConvertFrom-Json) } catch { return $null }
}
function Wait-Http([string]$url, [int]$tries = 60) {
  for ($i = 0; $i -lt $tries; $i++) {
    $null = Dk run --rm --label $label --network $net --entrypoint deno $podTag eval "const r = await fetch('$url').catch(() => null); Deno.exit(r && r.status < 500 ? 0 : 1)"
    if ($script:rc -eq 0) { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}
function Sql([string]$q) { return (Dk exec $script:db psql -U postgres -d openbrain -X -tAc $q).Trim() }
function Wb([string]$method, [string]$path, [string]$body = '', [string]$sub = '') {
  $hdr = if ($sub) { ", 'x-test-sub': '$sub'" } else { '' }
  $js = "const r = await fetch('http://openbrain-workbench:8000$path', { method: '$method', headers: { 'content-type': 'application/json', 'x-brain-key': '$key'$hdr }" + $(if ($body) { ", body: JSON.stringify($body)" } else { '' }) + " }); console.log('STATUS ' + r.status); console.log('BODY ' + await r.text());"
  return Dk run --rm --label $label --network $net --entrypoint deno $podTag eval $js
}

try {
  Write-Host "== rw-p7a-tts podcast lab  owner=$Id  net=$net  red=$([bool]$Red)  evidence=$Evidence"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  # ------------------------------------------------------------------ 1. the initdb chain
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check (@($chain | Where-Object { $_[1] -eq '330-init-podcasts.sql' }).Count -eq 1) "the chain mounts 330-init-podcasts.sql ($($chain.Count) migrations)"

  # ------------------------------------------------------------------ 2. network
  Write-Host '[2] the internal network'
  $null = Dk network create --driver bridge --internal --subnet $subnets.run --label $label $net
  Check ($script:rc -eq 0) "network $net (internal, $($subnets.run))"
  if ($script:rc -ne 0) { throw 'network' }
  $script:made.net = $true

  # ------------------------------------------------------------------ 3. images
  Write-Host '[3] images'
  $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" -t $wbTag $wb; Save 'build-workbench.log' ($o -split "`n" | Select-Object -Last 40 | Out-String)
  Check ($script:rc -eq 0) "$wbTag built (its test gate passed)"
  if ($script:rc -ne 0) { throw 'build workbench' }
  $script:made.images += $wbTag
  $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --target test -t $podTestTag $recipe
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save 'build-podcast-test-stage.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED|ignored)|(ok|FAILED) \||gate: OK|error' }) -join "`n")
  Check (($script:rc -eq 0) -and $clean -match 'podcast image gate: OK') "${podTestTag}: the image gate (unit tests, notices, the chain e2e C2) passed"
  $script:made.images += $podTestTag
  $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" -t $podTag $recipe
  Check ($script:rc -eq 0) "$podTag built"
  if ($script:rc -ne 0) { throw 'build podcast' }
  $script:made.images += $podTag
  $null = Dk tag $llmDigest $llmTag
  Check ($script:rc -eq 0) "$llmTag = the gateway's pinned LiteLLM digest"
  $script:made.tags += $llmTag

  # ------------------------------------------------------------------ 4. the lab
  Write-Host '[4] the lab'
  $script:db = "$P-db"
  if (-not (Run-Detached $script:db @('--network-alias', 'openbrain-db', '-e', "POSTGRES_PASSWORD=$pw", '-e', 'POSTGRES_DB=openbrain', '-v', "${stage}:/docker-entrypoint-initdb.d:ro", $PgImage))) { throw 'db' }
  for ($i = 0; $i -lt 150; $i++) { if ((Dk logs $script:db) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $script:db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $logs = Dk logs $script:db
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check (($logs -match 'PostgreSQL init process complete') -and $errs.Count -eq 0) "the database ran the initdb chain, no ERROR ($($errs.Count))"
  $null = Dk exec $script:db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  $null = Dk cp (Join-Path $dockerDir 'init-podcasts.sql') "$($script:db):/tmp/init-podcasts.sql"
  $o = Dk exec $script:db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/init-podcasts.sql
  Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) 'init-podcasts.sql re-applied cleanly (idempotent)'

  $null = Run-Detached "$P-postgrest" @('--network-alias', 'openbrain-postgrest', '-e', "PGRST_DB_URI=postgres://postgres:$pw@openbrain-db:5432/openbrain",
      '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=service_role', '-e', 'PGRST_DB_POOL=4', '-e', 'PGRST_SERVER_PORT=3000', $PgrstImage)
  $null = Run-Detached "$P-rest" @('--network-alias', 'openbrain-rest', '-v', "$(Join-Path $dockerDir 'Caddyfile'):/etc/caddy/Caddyfile:ro", $CaddyImage)
  $null = Run-Detached "$P-wb" @('--network-alias', 'openbrain-workbench', '-e', 'PORT=8000', '-e', "WORKBENCH_KEY=$key",
      '-e', "DB_HOST=$($script:db)", '-e', 'DB_USER=ob_app_memory', '-e', "DB_PASSWORD=$appPw", '-e', 'OPEN_BRAIN_URL=http://openbrain-rest',
      '-e', 'EMBEDDING_API_BASE=http://unreachable.invalid/v1', '-e', 'EXTRACT_URL=http://unreachable.invalid', '-e', 'WIKI_GIT_DIR=/wiki',
      '-e', 'WIKI_ASSETS_DIR=/wiki/assets', '-e', 'CONTRACT_MOUNTS_ROOT=/mounts', '-e', "WORKSPACE_DEFAULT_SUB=$labSub",
      '-e', 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub', '-e', 'PODCAST_RENDER_URL=http://openbrain-podcast:8080/render',
      '-v', "${archive}:/mounts/podcast-archive:ro", '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro", $wbTag)
  $null = Run-Detached "$P-kokoro" @('--network-alias', 'kokoro-tts-upstream', '-e', 'DOWNLOAD_MODEL=false', '-e', 'USE_GPU=false', '-e', 'DEVICE=cpu', $kokoroImage)
  # LiteLLM: the shipped fragment, merged by the shipped assembler, onto the shipped base minus the ledger-DB keys
  $null = & python -c @"
import sys, yaml
base = yaml.safe_load(open(sys.argv[1], encoding='utf-8'))
gs = base.get('general_settings', {})
for k in ('store_model_in_db', 'success_callback', 'failure_callback', 'pass_through_endpoints'): gs.pop(k, None)
yaml.safe_dump(base, open(sys.argv[2], 'w', encoding='utf-8'), sort_keys=False)
"@ (Join-Path $repo 'inference/config/litellm.config.yaml') (Join-Path $cfgDir 'config.base.yaml')
  Copy-Item (Join-Path $repo 'inference/config/litellm/model_list/local.tts.yaml') (Join-Path $cfgDir 'conf.d/local.tts.yaml')
  Copy-Item (Join-Path $repo 'inference/config/litellm/assemble-config.py') (Join-Path $cfgDir 'assemble-config.py')
  Copy-Item (Join-Path $repo 'inference/config/litellm/custom_callbacks.py') (Join-Path $cfgDir 'custom_callbacks.py')
  $null = Run-Detached "$P-llm" @('--network-alias', 'llama-cpp', '-e', "LITELLM_MASTER_KEY=$master", '-e', 'LITELLM_LOCAL_MODEL_COST_MAP=True',
      '-e', 'COMPOSE_PROFILES=local', '-v', "$(Join-Path $cfgDir 'config.base.yaml'):/app/config.base.yaml:ro", '-v', "$(Join-Path $cfgDir 'conf.d'):/app/conf.d:ro",
      '-v', "$(Join-Path $cfgDir 'assemble-config.py'):/app/assemble-config.py:ro", '-v', "$(Join-Path $cfgDir 'custom_callbacks.py'):/app/custom_callbacks.py:ro",
      '--entrypoint', '/bin/sh', $llmTag, '-c', 'python /app/assemble-config.py && exec docker/prod_entrypoint.sh --config /app/config.yaml --port 8080')
  $null = Run-Detached "$P-surreal" @('--network-alias', 'lab-surreal', $SurrealImage, 'start', '--log', 'warn', '--user', 'root', '--pass', $surrealPw, 'memory')
  $null = Run-Detached "$P-sink" @('--network-alias', 'open_notebook', '-v', "${here}:/lab:ro", '--entrypoint', 'deno', $podTag, 'run', '--allow-net', '--allow-env', '/lab/sinkhole.ts')
  $null = Run-Detached "$P-pod" (@('--network-alias', 'openbrain-podcast', '-e', 'PORT=8080') + $podEnv + @('-e', 'NEXT_TRIGGER_URL=', '-e', 'REPORTS_DIR=/tmp/reports',
      '-v', "${archive}:/mounts/podcast-archive", '-v', "${recipe}:/app:ro", '-w', '/app', $podTag, 'deno', 'run', '--unstable-net', '-A', 'podcast-server.ts'))
  Check (Wait-Http 'http://openbrain-workbench:8000/health' 90) 'the workbench is up'
  Check (Wait-Http 'http://kokoro-tts-upstream:8880/health' 90) 'Kokoro is up (the pinned image, no download)'
  Check (Wait-Http 'http://llama-cpp:8080/health/liveliness' 90) 'the lab LiteLLM is up (liveliness; never /health)'
  Check (Wait-Http 'http://openbrain-podcast:8080/health' 60) 'the podcast service is up'
  $asm = (Dk logs "$P-llm") -split "`n" | Where-Object { $_ -match 'assemble-config' }
  Save 'litellm-assemble.log' ($asm -join "`n")

  # ------------------------------------------------------------------ 5a. the speech route
  Write-Host '[5a] C7/route: /v1/audio/speech through LiteLLM (route local-tts) to Kokoro'
  $o = Pod 300 @() @('run', '-A', 'lab/lab-probe.ts', 'speech'); $pr = Probe $o; Save 'c7-speech-route.log' $o
  Check ($pr -and $pr.with_key.status -eq 200 -and $pr.with_key.bytes -gt 1000) "with the service key: 200, $($pr.with_key.bytes) bytes of PCM"
  Check ($pr -and $pr.no_key.status -eq 401) "with no key: $($pr.no_key.status) (the master key is enforced)"
  Check ($pr -and $pr.wrong_route.status -ge 400) "a route the fragment does not register: $($pr.wrong_route.status)"

  # ------------------------------------------------------------------ 5b. the capture on the copy
  Write-Host '[5b] C8/C9/C12: the capture over a COPY of ON (lab SurrealDB import + the notebook_data audio)'
  $surql = $OnExport
  if ($OnExport -match '\.gz$') {
    $surql = Join-Path $env:TEMP "$P-on.surql"
    $in = [System.IO.File]::OpenRead($OnExport); $gz = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
    $outF = [System.IO.File]::Create($surql); $gz.CopyTo($outF); $outF.Close(); $gz.Close(); $in.Close()
    $script:made.dirs += $surql
  }
  # The pinned SurrealDB 2.6 does not re-import its own nightly export as is (measured 2026-10-30):
  # lab/fix-surreal-export.py writes a LAB copy with DEFINE FIELD -> DEFINE FIELD OVERWRITE and one NUL
  # dropped from a source row's text (see its header). Rows are otherwise unchanged.
  $fixed = Join-Path $env:TEMP "$P-on.fixed.surql"
  $fx = (& python (Join-Path $here 'fix-surreal-export.py') $surql $fixed 2>&1 | Out-String).Trim()
  $script:made.dirs += $fixed
  Check ($LASTEXITCODE -eq 0) "the lab copy of the export: $fx"
  $null = Dk cp $fixed "$P-surreal:/tmp/on.surql"
  $o = DkLong exec "$P-surreal" /surreal import --endpoint http://localhost:8000 --username root --password $surrealPw --namespace open_notebook --database open_notebook /tmp/on.surql
  Save 'surreal-import.log' $o
  Check (($script:rc -eq 0) -and $o -match 'imported successfully') 'the ON export imported into the lab SurrealDB'
  $capEnv = @('-e', 'SURREAL_URL=http://lab-surreal:8000', '-e', 'SURREAL_USER=root', '-e', "SURREAL_PASSWORD=$surrealPw", '-e', "WORKSPACE_DEFAULT_SUB=$labSub",
    '-e', 'ON_DATA_DIR=/on-data', '-v', "${OnData}:/on-data:ro")
  $o = Pod 3600 $capEnv @('run', '-A', 'on-capture.ts', 'capture'); Save 'c8-c9-capture.log' $o
  Check ($script:rc -eq 0) 'on-capture.ts capture exited 0'
  $man = Get-ChildItem (Join-Path $archive 'on-archive') -Filter 'CAPTURE-*.json' -ErrorAction SilentlyContinue | Select-Object -First 1
  Check ([bool]$man) "the capture manifest was written ($($man.Name))"
  if ($man) {
    Copy-Item $man.FullName (Join-Path $Evidence 'capture-manifest.json')
    $m = Get-Content -Raw $man.FullName | ConvertFrom-Json
    Check ($m.counts.archived -eq $m.counts.on_episodes -and $m.counts.on_episodes -gt 0) "C9: archived $($m.counts.archived) = ON episodes $($m.counts.on_episodes)"
    Check ($m.counts.equal -and $m.counts.on.speaker_profile -eq $m.counts.model.teams -and $m.counts.on.episode_profile -eq $m.counts.model.formats) "C8: presenter model $($m.counts.model.teams) teams + $($m.counts.model.formats) formats = ON $($m.counts.on.speaker_profile) speaker + $($m.counts.on.episode_profile) episode profiles (+ $($m.counts.on.podcast_config) podcast_config)"
    Check (@($m.ledger).Count -gt 20) "C8: the field ledger lists $(@($m.ledger).Count) fields (mapped + unmapped, each with where/why)"
    Check ($m.unchanged_during_capture) 'C12: ON''s datastore fingerprint is unchanged across the capture (it wrote nothing)'
    Check (@($m.migration.classes).Count -ge 1 -and @($m.migration.classes | Where-Object { -not $_.reason }).Count -eq 0) "C10: $(@($m.migration.classes).Count) episode class(es), each with an outcome and a reason"
    $dbCounts = Sql "select (select count(*) from podcast_teams where origin='on-capture' and owner_sub='$labSub') || ' ' || (select count(*) from podcast_formats where origin='on-capture' and owner_sub='$labSub') || ' ' || (select count(*) from podcast_presenters where origin='on-capture' and owner_sub='$labSub') || ' ' || (select count(*) from podcast_voice_links where origin='on-capture' and owner_sub='$labSub')"
    Check ($dbCounts -eq "$($m.counts.model.teams) $($m.counts.model.formats) $($m.counts.model.presenters) $($m.counts.model.voice_links)") "C8/C15: the presenter model rows are in openbrain-db, owned by WORKSPACE_DEFAULT_SUB ($dbCounts)"
  }
  $o = Pod 900 @() @('run', '-A', 'lab/lab-probe.ts', 'archive-check'); $pr = Probe $o; Save 'c9-archive-check.log' $o
  Check ($pr -and @($pr.missing).Count -eq 0) "C9: every archived episode has row, outline, transcript, sources, profile and an on-archive sidecar ($($pr.dirs) dirs; missing $(@($pr.missing).Count))"
  Check ($pr -and ($pr.with_audio + $pr.absent_audio_with_reason) -eq $pr.dirs) "C9: $($pr.with_audio) carry ON's audio in its native format ($($pr.formats -join ',')); $($pr.absent_audio_with_reason) had none in ON (reason recorded)"
  Check ($pr -and $pr.sample_plays -and $pr.sample_duration) "C9: a sampled episode plays from the archive folder ($($pr.sample_duration))"

  # ------------------------------------------------------------------ 5c. quiesce detection
  Write-Host '[5c] C12: verify-quiesced detects a write to ON'
  $manIn = "/mounts/podcast-archive/on-archive/$($man.Name)"
  $o = Pod 900 $capEnv @('run', '-A', 'on-capture.ts', 'verify-quiesced', "--manifest=$manIn"); Save 'c12-quiesced-clean.log' ($o -split "`n" | Select-Object -First 4 | Out-String)
  Check ($script:rc -eq 0) 'verify-quiesced on the untouched copy: quiesced (exit 0)'
  # the lab write ON is never allowed live: one CREATE over SurrealDB's HTTP /sql, on the COPY
  $wjs = "const r = await fetch('http://lab-surreal:8000/sql', { method: 'POST', headers: { accept: 'application/json', 'surreal-ns': 'open_notebook', 'surreal-db': 'open_notebook', authorization: 'Basic ' + btoa('root:$surrealPw') }, body: `"CREATE episode SET name = 'a write after the capture', episode_profile = {}, speaker_profile = {};`" }); console.log('WRITE ' + r.status + ' ' + (await r.text()).slice(0, 200));"
  $wo = Dk run --rm --label $label --network $net --entrypoint deno $podTag eval $wjs
  Check ($wo -match 'WRITE 200 .*"status":"OK"') "a lab write to the ON copy ($((Redact $wo).Substring(0, [Math]::Min(80, $wo.Length))))"  $o = Pod 900 $capEnv @('run', '-A', 'on-capture.ts', 'verify-quiesced', "--manifest=$manIn"); Save 'c12-quiesced-after-write.log' ($o -split "`n" | Select-Object -First 6 | Out-String)
  Check ($script:rc -eq 1 -and $o -match '"changed_tables":\s*\[\s*"episode"') 'verify-quiesced after a lab write to ON: NOT quiesced, names the episode table (exit 1)'

  # ------------------------------------------------------------------ 5e. the front end never offers an archived episode
  Write-Host '[5e] C9: no archived episode in the library, the presenters panel or search (checked BEFORE any re-render, which is a new episode)'
  $names = @($m.migration.per_episode | Select-Object -First 5 | ForEach-Object { $_.name })
  $lib = Wb 'GET' '/workbench/contract/podcasts?limit=200'; $pr = Wb 'GET' '/workbench/contract/presenters'; $tm = Wb 'GET' '/workbench/contract/teams'
  $hits = @($names | Where-Object { $lib -match [regex]::Escape($_) -or $pr -match [regex]::Escape($_) -or $tm -match [regex]::Escape($_) })
  Check ($hits.Count -eq 0 -and $lib -match 'STATUS 200') "no archived episode name in podcasts(), presenters() or teams() ($($hits.Count) hits)"
  Check ((Sql "select count(*) from podcast_episodes where archive_dir like '%/on-archive/%'") -eq '0') 'no podcast_episodes row points into on-archive/'
  $srch = Wb 'GET' "/workbench/contract/search?q=$([uri]::EscapeDataString($names[0]))&kinds=page,claim,source"
  Check (($srch -match '"count":0') -or ($srch -match 'STATUS 4')) "search for an archived episode's name finds nothing of it"
  Save 'c9-frontend.log' ("$lib`n$pr`n$tm`n$srch")

  # ------------------------------------------------------------------ 5d. migration re-render
  Write-Host '[5d] C10: a migrated episode re-renders from a synthetic room transcript; the archived audio is untouched'
  $mig = @($m.migration.per_episode | Where-Object { $_.outcome -eq 'migrates' }) | Select-Object -First 1
  if ($mig) {
    $o = Pod 1800 $capEnv @('run', '-A', 'on-capture.ts', 'rerender', "--manifest=$manIn", "--episode=$($mig.onId)", '--turns=8'); Save 'c10-rerender.log' $o
    Check ($o -match '"archived_audio_unchanged":\s*true' -and $o -match '"new_render":\s*"/mounts/podcast-archive/renders/') "C10: $($mig.onId) re-rendered into renders/ (8 turns), the archived original byte-identical"
  } else { Fail 'C10: no episode class migrates - nothing to re-render' }

  # ------------------------------------------------------------------ 5f. C3 / C5
  $tech = Sql "select id from podcast_teams where origin='on-capture' and owner_sub='$labSub' and name='tech_experts'"
  Write-Host "[5f] C3: relink one presenter's voice; only that presenter's turns are synthesised again (team $tech)"
  $o = Pod 1800 @() @('run', '-A', 'lab/lab-probe.ts', 'c3', $tech); $pr = Probe $o; Save 'c3-cache.log' $o
  Check ($pr -and $pr.first.misses -eq $pr.turns -and $pr.second.misses -eq $pr.relinked_turns -and $pr.second.hits -eq ($pr.turns - $pr.relinked_turns) -and $pr.second_misses_are_relinked_presenter) "C3: first render $($pr.first.misses) synthesised; after relinking $($pr.relinked.presenter) ($($pr.relinked.from) -> $($pr.relinked.to)): $($pr.second.misses) synthesised = that presenter's $($pr.relinked_turns) turns, $($pr.second.hits) cache hits"
  Write-Host '[5f] C5: two presenters, different voices and personalities'
  $o = Pod 1800 @('-v', "${audioEv}:/ev") @('run', '-A', 'lab/lab-probe.ts', 'c5', $tech, '/ev'); $pr = Probe $o; Save 'c5-distinct.log' $o
  Check ($pr -and $pr.same_sentence.a.sha256 -ne $pr.same_sentence.b.sha256 -and $pr.presenters[0].voice -ne $pr.presenters[1].voice) "C5: the same sentence by $($pr.presenters[0].name) ($($pr.presenters[0].voice)) and $($pr.presenters[1].name) ($($pr.presenters[1].voice)): different audio (zero crossings/s $($pr.same_sentence.a.zero_crossings_per_s) vs $($pr.same_sentence.b.zero_crossings_per_s))"
  Check ($pr -and $pr.presenters[0].personality -ne $pr.presenters[1].personality -and $pr.fixture.texts_distinct) 'C5: distinct personalities; the fixture episode''s turns are distinct text (audio in evidence/audio/ for listening)'

  # ------------------------------------------------------------------ 5g. C13 the destination setting
  Write-Host '[5g] C13: the destination is read on every render; a change redirects the next render, moves nothing'
  $o = Pod 900 @() @('run', '-A', 'lab/lab-probe.ts', 'render', $tech, 'c13-default'); $p1 = Probe $o
  New-Item -ItemType Directory -Force (Join-Path $archive 'alt') | Out-Null
  $w1 = Wb 'PUT' '/workbench/contract/settings/podcast.archive_destination' "{ value: { path: '/mounts/podcast-archive/alt' }, by: 'lab' }"
  $o = Pod 900 @() @('run', '-A', 'lab/lab-probe.ts', 'render', $tech, 'c13-alt'); $p2 = Probe $o
  Save 'c13-destination.log' (($p1 | ConvertTo-Json -Depth 6) + "`n$w1`n" + ($p2 | ConvertTo-Json -Depth 6))
  Check ($p1 -and $p1.dir -like '/mounts/podcast-archive/renders/*' -and $p1.destination.via -eq 'mount:podcast-archive') "C13: by default a render lands in the mounted folder ($($p1.dir))"
  Check ($p2 -and $p2.dir -like '/mounts/podcast-archive/alt/renders/*' -and $p2.destination.version -ge 1) "C13: after the setting changed, the NEXT render lands at the new destination ($($p2.dir), version $($p2.destination.version))"
  Check ((Test-Path (Join-Path $archive ("renders/" + ($p1.dir -split '/')[-1] + '/audio.mp3')))) 'C13: the earlier render did not move'
  $null = Wb 'PUT' '/workbench/contract/settings/podcast.archive_destination' "{ value: { mount: 'podcast-archive' }, by: 'lab' }"
  $grep = (& git -C $ob1 grep -n -E 'backups.?/podcasts' -- '*.ts' '*.yml' '*.json' | Out-String).Trim()
  Save 'c13-no-hardcoded-path.log' $grep
  Check ((@($grep -split "`n" | Where-Object { $_ }).Count -eq 2) -and $grep -match 'docker-compose.yml' -and $grep -match 'docker-compose.scheduled.yml') 'C13: the archive path appears only in the two compose mounts (no code, no .env)'

  # ------------------------------------------------------------------ 5h. C14 transcodes
  Write-Host '[5h] C14: transcode an archived ON episode to every menu format; the original never changes'
  $onDir = Get-ChildItem (Join-Path $archive 'on-archive') -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'audio.mp3') } | Select-Object -First 1
  $before = (Get-FileHash (Join-Path $onDir.FullName 'audio.mp3') -Algorithm SHA256).Hash
  $tc = @()
  foreach ($fmt in @('mp3', 'opus', 'm4a', 'flac', 'wav', 'aac')) {
    $js = "const r = await fetch('http://openbrain-podcast:8080/transcode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archive_path: 'on-archive/$($onDir.Name)', format: '$fmt' }) }); console.log('TC $fmt ' + r.status + ' ' + (await r.text()).slice(0, 300));"
    $tc += (Dk run --rm --label $label --network $net --entrypoint deno $podTag eval $js)
  }
  Save 'c14-transcode.log' ($tc -join "`n")
  Check (@($tc | Where-Object { $_ -match '^TC (mp3|opus|m4a|flac|wav) 201 ' }).Count -eq 5) 'C14: each of the five menu formats -> 201, a new file'
  Check (@($tc | Where-Object { $_ -match '^TC aac 400 ' }).Count -eq 1) 'C14: a format outside the menu (aac) -> 400, nothing run'
  $after = (Get-FileHash (Join-Path $onDir.FullName 'audio.mp3') -Algorithm SHA256).Hash
  $sc = Get-Content -Raw (Join-Path $onDir.FullName 'sidecar.json') | ConvertFrom-Json
  Check ($before -eq $after -and $sc.audio.sha256 -eq $before.ToLower()) 'C14: the archived original is byte-identical after five transcodes'
  Check (@($sc.transcodes).Count -eq 5 -and @($sc.transcodes | Where-Object { $_.source_format -ne 'mp3' }).Count -eq 0) "C14: the sidecar records source (mp3) and target for each ($(@($sc.transcodes | ForEach-Object { $_.target_format }) -join ','))"

  # ------------------------------------------------------------------ 5i. C15 requests through the workbench, two users; C2 with the sinkhole
  Write-Host '[5i] C15: a render request through the workbench is the requester''s; another user sees none of it'
  $turnText = "PrivateLabTurn$rand"
  $body = "{ team_id: '$tech', title: 'Lab request $rand', transcript: { title: 'Lab request $rand', turns: [{ presenterId: 'on-presenter-' + '$tech'.replace('on-team-', '') + '-0', text: '$turnText' }] } }"
  $r1 = Wb 'POST' '/workbench/contract/podcasts/requests' $body
  Save 'c15-request.log' $r1
  Check ($r1 -match 'STATUS 202') 'C15: the default user''s render request is recorded (202)'
  $reqId = ([regex]'"id":"([0-9a-f-]{36})"').Match($r1).Groups[1].Value
  for ($i = 0; $i -lt 60; $i++) { $st = Sql "select state from podcast_render_requests where id='$reqId'"; if ($st -in @('done', 'failed')) { break }; Start-Sleep -Seconds 5 }
  $row = Sql "select requester_sub || ' ' || state || ' ' || coalesce(episode_id::text,'-') from podcast_render_requests where id='$reqId'"
  Check ($row -match "^$([regex]::Escape($labSub)) done [0-9a-f-]{36}$") "C15: requester = the seam's subject, rendered by openbrain-podcast /render ($row)"
  $other = Wb 'GET' '/workbench/contract/podcasts/requests' '' "lab-bee-$rand"
  $otherPods = Wb 'GET' '/workbench/contract/podcasts' '' "lab-bee-$rand"
  $otherPres = Wb 'GET' '/workbench/contract/presenters' '' "lab-bee-$rand"
  Check ($other -match 'STATUS 200' -and $other -notmatch [regex]::Escape($reqId) -and $other -notmatch $turnText) 'C15: another user lists none of it (requests)'
  Check ($otherPods -notmatch [regex]::Escape($reqId) -and $otherPres -notmatch 'Dr\. Alex Chen') 'C15: another user sees neither the render (not shared) nor the captured presenters'
  $mine = Wb 'GET' '/workbench/contract/podcasts/requests'
  Check ($mine -match [regex]::Escape($reqId)) 'C15: the requester lists it'
  $sink = Dk run --rm --label $label --network $net --entrypoint deno $podTag eval "console.log(await (await fetch('http://open_notebook:5055/__sinkhole/count')).text())"
  Save 'c2-sinkhole.log' ($sink + "`n" + ((Dk logs "$P-sink") -join "`n"))
  Check ($sink -match '"count":0') "C2: the Open Notebook sinkhole saw no request during every render of this run ($sink)"

  # ------------------------------------------------------------------ 5j. C4 GPU (opt-in)
  if ($Gpu) {
    Write-Host '[5j] C4: GPU memory with llama.cpp loaded, during synthesis (the inference lease is held for the window)'
    $leaseScript = Join-Path $repo 'scripts/agent-harness/lease.ps1'
    $before = (& nvidia-smi --query-gpu=index,memory.used,memory.free --format=csv,noheader,nounits) -join ';'
    $free0 = [int]((($before -split ';')[0] -split ',')[2].Trim())
    $ceiling = 0
    if ($free0 -lt ($ceiling + $GpuMarginMiB)) { Write-Host "  [note] GPU 0 free $free0 MiB < ceiling $ceiling + margin ${GpuMarginMiB}: Kokoro is CPU-only, so it needs none; measuring without any GPU allocation" }
    $lo = & powershell -NoProfile -File $leaseScript -Acquire -Name inference -Owner $Id 2>&1 | Out-String
    $held = $LASTEXITCODE -eq 0
    Check $held "C4: the inference lease acquired for the measurement window"
    if ($held) {
      try {
        $running0 = (& docker exec llama-cpp-upstream curl -s --max-time 5 http://localhost:8080/running) -join ''
        $job = Start-Job -ScriptBlock { param($a) & docker @a } -ArgumentList (, (@('run', '--rm', '--label', $label, '--network', $net) + $podEnv + @('-v', "${recipe}:/app:ro", '-w', '/app', '--entrypoint', 'deno', $podTag, 'run', '-A', 'lab/lab-probe.ts', 'load', '90')))
        $samples = @()
        for ($i = 0; $i -lt 16; $i++) { Start-Sleep -Seconds 5; $samples += ((& nvidia-smi --query-gpu=index,memory.used --format=csv,noheader,nounits) -join ';') }
        $loadOut = Receive-Job -Wait $job; Remove-Job $job
        $running1 = (& docker exec llama-cpp-upstream curl -s --max-time 5 http://localhost:8080/running) -join ''
        $after = (& nvidia-smi --query-gpu=index,memory.used,memory.free --format=csv,noheader,nounits) -join ';'
        $base0 = [int]((($before -split ';')[0] -split ',')[1].Trim())
        $peak0 = ($samples | ForEach-Object { [int]((($_ -split ';')[0] -split ',')[1].Trim()) } | Measure-Object -Maximum).Maximum
        $base1 = [int]((($before -split ';')[1] -split ',')[1].Trim())
        $peak1 = ($samples | ForEach-Object { [int]((($_ -split ';')[1] -split ',')[1].Trim()) } | Measure-Object -Maximum).Maximum
        Save 'c4-gpu.log' ("before $before`nsamples`n$($samples -join "`n")`nafter $after`nllama-swap /running before: $running0`nafter: $running1`nload: $loadOut`nceiling: Kokoro adds 0 MiB (CPU only); tolerance $GpuMarginMiB MiB for the resident processes' own drift")
        $kokoroGpu = (Dk inspect -f '{{json .HostConfig.DeviceRequests}}' "$P-kokoro").Trim()
        Check ($kokoroGpu -eq 'null' -or $kokoroGpu -eq '[]') "C4: the Kokoro container has no GPU device ($kokoroGpu)"
        Check (($peak0 - $base0) -le $GpuMarginMiB -and ($peak1 - $base1) -le $GpuMarginMiB) "C4: GPU memory during synthesis: GPU0 $base0 -> peak $peak0 MiB, GPU1 $base1 -> peak $peak1 MiB (ceiling: +0 for Kokoro, tolerance $GpuMarginMiB)"
        Check ($running1 -eq $running0 -and $running0 -match 'qwen') "C4: the resident llama.cpp model is unchanged (not evicted): $running1"
        Check ($loadOut -match 'PROBE .*"syntheses":\s*[1-9]') 'C4: Kokoro synthesised throughout the window'
      } finally {
        & powershell -NoProfile -File $leaseScript -Release -Name inference -Owner $Id | Out-Null
        Pass 'C4: the inference lease released'
      }
    }
  } else { Write-Host '[5j] C4 skipped (-Gpu not given)' }

  Save 'podcast-service.log' ((Dk logs --tail 200 "$P-pod") -join "`n")
  Save 'workbench.log' ((Dk logs --tail 80 "$P-wb") -join "`n")
} catch {
  Fail "the run stopped: $_"
} finally {
  Write-Host '[6] teardown'
  foreach ($c in $script:made.containers) { $null = Dk rm -f -v $c }
  if ($script:made.net) { $null = Dk network rm $net }
  foreach ($t in $script:made.tags) { $null = Dk rmi $t }
  if (-not $KeepImages) { foreach ($i in $script:made.images) { $null = Dk rmi -f $i } }
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}' | Out-String).Trim()
  Check (-not $left) "no container labelled $Id is left ($left)"
  $leftNet = (Dk network ls --filter "label=$label" --format '{{.Name}}' | Out-String).Trim()
  Check (-not $leftNet) "no network labelled $Id is left ($leftNet)"
  $localAfter = LocalSnapshot
  Check ((($localBefore -join "`n") -eq ($localAfter -join "`n"))) 'no :local image changed'
  foreach ($d in $script:made.dirs) { if (Test-Path $d) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } }
}
Write-Host "== $(if ($script:fail) { "FAILED ($($script:fail))" } else { 'ALL PASSED' })"
exit $(if ($script:fail) { 1 } else { 0 })
