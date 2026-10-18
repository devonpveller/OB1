# run-contract-tests.ps1 - the retrieval contract's disposable test run (research-workbench P0,
# rw-p0-contract).
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-contract-tests.ps1 -Subnet <x.y.z.0/24> [-Id <owner id>] [-Evidence <dir>]
#
# -Subnet is REQUIRED (rw-p0b-purge-door): the disposable network gets this subnet, never one from
# Docker's default pools (a pool handed out 192.168.0.0/20 and cut the host off its LAN). Refused
# inside 192.168.0.0/16. -Evidence must be absent or empty; it is written only at the end.
#
# What it does, and ONLY this:
#   1. stages the REAL initdb chain from docker-compose.yml (every mounted init*.sql, intake's
#      220 slot and the contract's 230 slot), in compose order
#   2. creates ONE internal docker network; every container and the network are labelled
#      ai-stack.harness.owner=<Id>
#   3. builds the workbench as openbrain-workbench:wt-<id> (NEVER :local) with
#      --build-arg OB1_SHA=<OB1 HEAD>; the build itself runs the image's test gate
#   4. database A: chain + contract-test/fixtures.sql; runs src/contracts/integration_test.ts
#      inside the :wt image as a NON-superuser member of service_role (the production shape)
#   4b. builds openbrain-research:wt-<id>, runs it on database A with two caller keys, and runs
#      integrations/research-service/origin.e2e.test.ts against it (D17 origin binding)
#   5. database B: a fresh chain + fixtures; starts the :wt workbench and a stub embedder; runs
#      (5a) integrations/kubernetes-deployment/contract-scope.e2e.test.ts - the openbrain-mcp
#      adapter calling the workbench under the cloud door's forced {"share":"cloud"} filter
#      (rw-p0-contract2): every cloud tool, with the arguments the REAL gateway policy forwards
#      (contract-scope-calls.py runs openbrain-gateway/app.py _apply_policy on the host, with
#      -Python), checked for every out-of-scope string - then Dredd (rw-dredd:wt-<id>) against every example in
#      generated/openapi.json
#   6. runs the eleven-router smoke (scripts/checks/smoke-workbench-routers.ps1) against the
#      :wt workbench twice and compares (the script works; the routers answer), then against a
#      workbench built from -BaseSha on the same database: the pre-change capture, which must
#      be identical to the post-change one. Both workbenches answer from the same seeded
#      fixture vault (fixture-vault.ts), so notes-list / notes-folders are populated. Every
#      capture names its disposable container (the smoke script refuses its live target
#      without -Live), every compare runs IN-PROCESS with one array argument and must print
#      its 13 PASS rows, and a deliberately altered pair must FAIL (the compare can fail).
#      Captures land in a directory the run owns; the LIVE-DATA GUARD (size cap, fixture-only
#      uuids, fixture-marked notes and notebooks, the recorded target) must pass before any
#      capture is copied into -Evidence - a capture that fails it is deleted, never kept.
#      THE EVIDENCE GATE (rw-p0b-purge-door, tester finding T2-6; evidence-gate.ps1): every log
#      is written to a staging directory the run owns, and NOTHING - no log, no capture, not the
#      directory - is written under -Evidence until the guard has passed for EVERY capture the
#      run made; then the logs are published through Protect-EvidenceText (a FAIL compare's
#      response excerpts redacted to their fixture ids, non-fixture uuids and host paths
#      replaced). A planted live-shaped excerpt proves it in every run (smoke-planted-red.log).
#      Attempt 2 (the tester's network-namespace bypass and near-misses): the smoke script's
#      disposable-target check is unit-tested here (scripts/checks/smoke-workbench-routers.test.ps1:
#      every refusal shape on synthetic docker JSON, a silent docker endpoint, and a revert check
#      that FAILS when either half of the check is reduced to "return ''"), and refused against
#      REAL docker for a never-started container sharing the workbench's network namespace and
#      one on the host network. Every log, not only the smoke logs, is redacted (names in quotes,
#      uuids in any spelling, docker ids, IPs, host paths; planted-nonsmoke.log proves it); a
#      file over 16 KB, a link or a directory is not published and is named (_dropped.txt;
#      planted-oversized.log proves the cap).
#   7. tears down exactly what it created (containers with -v, so no anonymous volume is
#      left); verifies nothing labelled <Id> is left, no NEW dangling volume exists, and no
#      :local image changed
# It never touches the live stack: no compose up/down, no ai-stack_* / open-brain_* network, no
# host port, no live database, no live container, no rm/rmi of anything it did not create.
# Exit code 0 = every check passed.
param(
  [string]$Id = 'wt-rw-p0-contract',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Evidence = '',
  # The disposable network's subnet (required; see the header).
  [string]$Subnet = '',
  [switch]$KeepImages,
  # The OB1 commit the item branched from: the eleven-router smoke runs against a workbench
  # built from it too, and the two captures must be identical (the pre-change capture).
  # rw-p0b-purge-door branched from 0741b36 (P0 + P2a landed).
  [string]$BaseSha = '0741b36',
  # Re-record src/contracts/schemas/examples.ts from the fixture (then: deno task contract:gen,
  # and run again without the switch). Skips Dredd and the smoke.
  [switch]$RecordExamples,
  # The interpreter that loads openbrain-gateway/app.py (needs httpx and starlette) for step 5a.
  # Default: <checkout>\.venv, then the main checkout's .venv (a worktree has none), then python.
  [string]$Python = ''
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
if ($Subnet -notmatch '^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}/(\d{1,2})$') { Write-Host "REFUSED: -Subnet <a.b.c.d/nn> is required (got '$Subnet')"; exit 2 }
if (([int]$Matches[1] -eq 192 -and [int]$Matches[2] -eq 168) -or [int]$Matches[3] -lt 16) { Write-Host "REFUSED: -Subnet $Subnet overlaps 192.168.0.0/16 or is wider than /16"; exit 2 }
if ($Evidence -and (Test-Path $Evidence) -and @(Get-ChildItem -Force $Evidence).Count) { Write-Host "REFUSED: -Evidence $Evidence is not empty (the run publishes into an empty or absent directory)"; exit 2 }
$label = "ai-stack.harness.owner=$Id"
$ct = $PSScriptRoot                                  # .../workbench/contract-test
$wb = Split-Path -Parent $ct                         # .../OB1/docker/workbench
$dockerDir = Split-Path -Parent $wb                  # .../OB1/docker
$ob1 = Split-Path -Parent $dockerDir                 # .../OB1
$repo = Split-Path -Parent $ob1                      # the ai-stack checkout (for the smoke script)
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rwp0-net-$rand"
$dbA = "rwp0-dba-$rand"; $dbB = "rwp0-dbb-$rand"; $wbName = "rwp0-wb-$rand"; $embName = "rwp0-embed-$rand"
$short = ($Id -replace '^wt-', '')
$tag = "openbrain-workbench:wt-$short"
$dreddTag = "rw-dredd:wt-$short"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$key = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "rwp0-evidence-$rand" }
# The evidence gate (T2-6): logs are staged HERE; -Evidence is not touched until the end.
$evStage = Join-Path $env:TEMP "rwp0-evstage-$rand"
New-Item -ItemType Directory -Force $evStage | Out-Null
. (Join-Path $PSScriptRoot 'evidence-gate.ps1')
$stage = Join-Path $env:TEMP "rwp0-initdb-$rand"
$callsDir = Join-Path $env:TEMP "rwp0-calls-$rand"

$script:fail = 0
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }
function Save([string]$name, [string]$text) {
  # into the STAGING directory; Publish-Evidence copies it to -Evidence after the guard (T2-6)
  [System.IO.File]::WriteAllText((Join-Path $evStage $name), $text, (New-Object System.Text.UTF8Encoding $false))
}
if ($tag -match ':local$' -or $dreddTag -match ':local$') { throw 'refusing to build a :local tag' }

Write-Host "== rw-p0-contract test run  owner=$Id  net=$net  evidence=$Evidence"
$null = Dk version --format '{{.Server.Version}}'
if ($script:rc -ne 0) { Write-Host 'docker is not reachable'; exit 2 }
function LocalSnapshot { (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim() -split "`r?`n" | Sort-Object }
$localBefore = LocalSnapshot
function DanglingVolumes { @((Dk volume ls -q --filter dangling=true | Out-String).Trim() -split "`r?`n" | Where-Object { $_ }) }
$volBefore = DanglingVolumes
$made = @{ net = $false; containers = @(); images = @(); smokeDir = $null }

function Start-Db([string]$name) {
  $o = Dk run -d --name $name --label $label --network $net -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=openbrain `
    -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
  if ($script:rc -ne 0) { Fail "postgres $name did not start: $o"; return $false }
  $script:made.containers += $name
  for ($i = 0; $i -lt 150; $i++) {
    $logs = Dk logs $name
    if ($logs -match 'PostgreSQL init process complete') { break }
    if ((Dk inspect -f '{{.State.Running}}' $name) -ne 'true') { break }
    Start-Sleep -Seconds 2
  }
  $logs = Dk logs $name
  Save "$name-initdb.log" $logs
  Check ($logs -match 'PostgreSQL init process complete') "$name ran the initdb chain to completion"
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "$name initdb logged no ERROR ($($errs.Count))"
  for ($i = 0; $i -lt 60; $i++) {
    $null = Dk exec $name pg_isready -h 127.0.0.1 -U postgres -d openbrain
    if ($script:rc -eq 0) { break }
    Start-Sleep -Seconds 2
  }
  # The production DB user shape: not a superuser, no BYPASSRLS, a member of service_role.
  $o = Dk exec $name psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) "$name has ob_app_memory (non-superuser, service_role member)"
  $null = Dk cp (Join-Path $ct 'fixtures.sql') "${name}:/tmp/fixtures.sql"
  $o = Dk exec $name psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/fixtures.sql
  Save "$name-fixtures.log" $o
  Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) "$name fixtures applied"
  return $true
}

# The fixture notes vault (F7): the same files, the same fixed commit date, in each disposable
# workbench container's own /tmp vault. Never a live container (the names are this run's).
function Seed-Vault([string]$name) {
  if ($name -notmatch "^rwp0-wb(base)?-$rand$") { throw "refusing to seed a vault in '$name'" }
  $null = Dk cp (Join-Path $ct 'fixture-vault.ts') "${name}:/tmp/fixture-vault.ts"
  $o = Dk exec $name deno run --allow-read --allow-write --allow-run --allow-env /tmp/fixture-vault.ts /tmp/wiki
  Save "$name-vault.log" $o
  return (($script:rc -eq 0) -and ($o -match 'seeded \d+ files'))
}

# The LIVE-DATA GUARD (attempt 2): a capture is kept only if it provably came from this run's
# disposable database and fixture vault. Returns the violations (none = clean).
$FixtureUuids = Get-FixtureUuids (Get-Content -Raw (Join-Path $ct 'fixtures.sql'))   # + the smoke's unknown-job probe
# Every capture the run makes, @(dir, container): ALL must pass Test-Capture before anything is published.
$script:captures = @()
$MaxCaptureBytes = 16384                                          # the live notebooks-list was 156177
function Get-CaptureBody([string]$file) { return (([System.IO.File]::ReadAllText($file)) -split "`n`n", 2)[1] | ConvertFrom-Json }
function Test-Capture([string]$dir, [string]$container) {
  $bad = @()
  $tgt = Join-Path $dir '_target.txt'
  if (-not (Test-Path $tgt)) { return 'no _target.txt (not written by the guarded smoke script)' }
  $t = [System.IO.File]::ReadAllText($tgt)
  if ($t -notmatch "(?m)^container: $([regex]::Escape($container))\s*$") { $bad += "target is not $container`: $t" }
  if ($t -notmatch '(?m)^live: False\s*$') { $bad += 'the capture says live' }
  foreach ($f in Get-ChildItem -File $dir) {
    if ($f.Length -gt $MaxCaptureBytes) { $bad += "$($f.Name) is $($f.Length) bytes (cap $MaxCaptureBytes)" }
    $txt = [System.IO.File]::ReadAllText($f.FullName)
    foreach ($m in [regex]::Matches($txt, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')) {
      if (-not $FixtureUuids.ContainsKey($m.Value.ToLower())) { $bad += "$($f.Name) carries a non-fixture uuid $($m.Value)" }
    }
  }
  try {
    $nl = Get-CaptureBody (Join-Path $dir 'notes-list.txt')
    $notes = @(@($nl.user) + @($nl.ai) | Where-Object { $_ })
    if ($notes.Count -lt 1) { $bad += 'notes-list is empty (the fixture vault was not seeded)' }
    foreach ($n in $notes) { if ($n -notmatch 'rwp0-fixture') { $bad += "notes-list carries a non-fixture note '$n'" } }
    $allowed = @('', 'notebooks', 'notebooks/fixture-notebook', 'notebooks/fixture-notebook/rwp0-fixture-drafts', 'rwp0-fixture-empty', 'rwp0-fixture-ideas')
    $folders = @((Get-CaptureBody (Join-Path $dir 'notes-folders.txt')).folders)
    if ($folders.Count -lt 2) { $bad += 'notes-folders lists only the root (the fixture vault was not seeded)' }
    foreach ($d in $folders) { if ($allowed -cnotcontains $d) { $bad += "notes-folders carries a non-fixture folder '$d'" } }
    foreach ($nb in @((Get-CaptureBody (Join-Path $dir 'notebooks-list.txt')).notebooks)) {
      if ($nb.name -cne 'Fixture notebook') { $bad += "notebooks-list carries a non-fixture notebook '$($nb.name)'" }
    }
  } catch { $bad += "a listing capture is missing or unreadable: $_" }
  return $bad
}

try {
  # ---------------------------------------------------------------- 1. the initdb chain
  Write-Host '[1] the initdb chain, derived from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check ($chain.Count -ge 30) "staged $($chain.Count) migrations"
  Check (@($chain | Where-Object { $_[1] -eq '230-init-research-contract.sql' }).Count -eq 1) 'the chain mounts 230-init-research-contract.sql'
  Check ($compose -match [regex]::Escape('image: ' + $PgImage)) "compose pins openbrain-db to $PgImage"
  $null = Dk image inspect $PgImage
  if ($script:rc -ne 0) { Fail "$PgImage is not on the host (pull it, or pass -PgImage)"; throw 'pg image' }

  # ---------------------------------------------------------------- 2. network
  Write-Host '[2] disposable internal network'
  $null = Dk network create --internal --subnet $Subnet --label $label $net
  Check ($script:rc -eq 0) "network $net created (internal, labelled, subnet $Subnet)"
  if ($script:rc -ne 0) { throw 'network' }
  $made.net = $true

  # ---------------------------------------------------------------- 3. the :wt image
  Write-Host "[3] build $tag (the build runs the image test gate)"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  $o = Dk build --build-arg "OB1_SHA=$sha" --label $label -t $tag $wb
  Save 'build.log' $o
  Check ($script:rc -eq 0) "image $tag built at OB1 $($sha.Substring(0, 7)) (test gate passed)"
  if ($script:rc -ne 0) { throw 'build' }
  $made.images += $tag
  $labels = (Dk image inspect --format '{{json .Config.Labels}}' $tag) | ConvertFrom-Json
  $lbl = [string]$labels.'org.opencontainers.image.revision'
  Check ($lbl -eq $sha) "label org.opencontainers.image.revision = $lbl"

  # ---------------------------------------------------------------- 4. integration tests
  Write-Host '[4] database A + src/contracts/integration_test.ts (as ob_app_memory)'
  if (-not (Start-Db $dbA)) { throw 'db A' }
  $o = Dk run --rm --label $label --network $net -e "CONTRACT_TEST_DB_HOST=$dbA" -e CONTRACT_TEST_DB_USER=ob_app_memory `
    -e "CONTRACT_TEST_DB_PASSWORD=$appPw" $tag deno test --allow-net --allow-env --allow-read src/contracts/integration_test.ts
  Save 'integration-test.log' $o
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match(($o -replace '\x1b\[[0-9;]*m', ''))
  Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[3].Value -eq '0') "integration tests: $($sum.Value)"
  # The triage listing's SQL (openbrain-mcp suggestion-list.ts) over database A (rw-p0b-purge-door,
  # T2-3): one active and one suppressed source; the :wt image's cached deps, offline.
  $k8sDir = Join-Path $ob1 'integrations\kubernetes-deployment'
  $o = Dk run --rm --label $label --network $net -v "${k8sDir}:/k8s:ro" -e "D5_TEST_DB_HOST=$dbA" -e "D5_TEST_DB_PASSWORD=$pw" `
    $tag deno test --config /app/deno.json --no-lock --cached-only --allow-read --allow-env --allow-net /k8s/d5-consumers.test.ts
  Save 'd5-consumers.log' $o
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match(($o -replace '\x1b\[[0-9;]*m', ''))
  Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[2].Value -eq '2' -and $sum.Groups[3].Value -eq '0') "triage listing SQL over database A (d5-consumers.test.ts): $($sum.Value)"

  # ---------------------------------------------------------------- 4b. origin binding e2e
  Write-Host '[4b] research-service origin binding end to end (the :wt research image on database A)'
  $rsTag = "openbrain-research:wt-$short"
  $rsName = "rwp0-rs-$rand"
  $o = Dk build --build-arg "OB1_SHA=$sha" --label $label -t $rsTag (Join-Path $ob1 'integrations\research-service')
  Save 'research-build.log' $o
  Check ($script:rc -eq 0) "image $rsTag built"
  if ($script:rc -eq 0) { $made.images += $rsTag }
  $kOwui = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
  $kAo = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
  $o = Dk run -d --name $rsName --label $label --network $net -e "DB_HOST=$dbA" -e DB_USER=ob_app_memory `
    -e "DB_PASSWORD=$appPw" -e "MCP_ACCESS_KEY=$key" -e "RESEARCH_CALLERS=owui-tool=owui:$kOwui;agent-org=mattermost:$kAo" `
    -e CHAT_API_BASE=http://unreachable.invalid/v1 -e EMBEDDING_API_BASE=http://unreachable.invalid/v1 `
    -e CURATOR_URL=http://unreachable.invalid -e SEARCH_API_BASE=http://unreachable.invalid $rsTag
  Check ($script:rc -eq 0) "research service $rsName started"
  if ($script:rc -eq 0) { $made.containers += $rsName }
  $up = $false
  for ($i = 0; $i -lt 45; $i++) {
    $null = Dk exec $rsName deno eval "const r=await fetch('http://localhost:8000/health');Deno.exit(r.status<500?0:1)"
    if ($script:rc -eq 0) { $up = $true; break }
    Start-Sleep -Seconds 2
  }
  Check $up 'research service /health answers'
  $o = Dk run --rm --label $label --network $net -v "$(Join-Path $ob1 'integrations\research-service'):/rs:ro" `
    -e "RESEARCH_E2E_URL=http://${rsName}:8000" -e "RESEARCH_E2E_OWUI_KEY=$kOwui" -e "RESEARCH_E2E_AO_KEY=$kAo" `
    -e "RESEARCH_E2E_SHARED_KEY=$key" -e "RESEARCH_E2E_DB_HOST=$dbA" -e "RESEARCH_E2E_DB_PASSWORD=$pw" `
    $tag deno test --no-lock --allow-net --allow-env --allow-read /rs/origin.e2e.test.ts
  Save 'origin-e2e.log' $o
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match(($o -replace '\x1b\[[0-9;]*m', ''))
  Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[3].Value -eq '0') "origin binding e2e: $($sum.Value)"
  $rsLogs = (Dk logs $rsName) -replace $kOwui, '***' -replace $kAo, '***' -replace $key, '***'
  Save 'research-service.log' $rsLogs
  $mm = @(($rsLogs -split "`n") | Where-Object { $_ -match 'origin mismatch: caller=agent-org claimed=agent recorded=mattermost' })
  Check ($mm.Count -eq 1) "the agent-org mismatch is logged ONCE with the caller named, though sent 3 times ($($mm.Count))"
  $null = Dk rm -f -v $rsName

  # ---------------------------------------------------------------- 5. Dredd
  Write-Host '[5] database B + the :wt workbench + Dredd over every example'
  if (-not (Start-Db $dbB)) { throw 'db B' }
  $o = Dk run -d --name $embName --label $label --network $net -v "${ct}:/ct:ro" $tag deno run --allow-net /ct/stub-embed.ts
  if ($script:rc -eq 0) { $made.containers += $embName }
  $o = Dk run -d --name $wbName --label $label --network $net -e PORT=8000 -e "WORKBENCH_KEY=$key" `
    -e "DB_HOST=$dbB" -e DB_USER=ob_app_memory -e "DB_PASSWORD=$appPw" -e OPEN_BRAIN_URL=http://unreachable.invalid `
    -e "EMBEDDING_API_BASE=http://${embName}:8080/v1" -e WIKI_GIT_DIR=/tmp/wiki -e WIKI_ASSETS_DIR=/tmp/wiki/assets `
    -e CONTRACT_MOUNTS_ROOT=/mounts -v "$(Join-Path $ob1 'recipes'):/recipes:ro" $tag
  Check ($script:rc -eq 0) "workbench $wbName started"
  if ($script:rc -eq 0) { $made.containers += $wbName }
  $up = $false
  for ($i = 0; $i -lt 60; $i++) {
    $null = Dk exec $wbName deno eval "const r=await fetch('http://localhost:8000/health');Deno.exit(r.ok?0:1)"
    if ($script:rc -eq 0) { $up = $true; break }
    Start-Sleep -Seconds 2
  }
  Check $up 'workbench /health answers'
  Check (Seed-Vault $wbName) "fixture vault seeded in $wbName"
  $doc = Dk exec $wbName deno eval "const r=await fetch('http://localhost:8000/openapi.json');console.log(r.status)"
  Check ($doc.Trim() -eq '200') 'GET /openapi.json is served (bare path, internal)'
  if ($RecordExamples) {
    $o = Dk run --rm --label $label --network $net -v "${wb}:/w" $tag deno run --allow-net `
      --allow-write=/w/src/contracts/schemas/examples.ts /w/contract-test/record-examples.ts "http://${wbName}:8000" $key `
      /w/src/contracts/schemas/examples.ts
    Save 'record-examples.log' ($o -replace $key, '***')
    Check ($script:rc -eq 0) "examples recorded: $o"
    Write-Host '  next: deno task contract:gen, then run again without -RecordExamples'
    throw 'recorded'
  }
  # 5a. the cloud door's forced filter through the adapter (rw-p0-contract2). FIRST the REAL
  # gateway policy (openbrain-gateway/app.py, loaded by contract-scope-calls.py; no server, no
  # network) polices every cloud tool x its argument sets x eight metadata_filter shapes and
  # writes what it would forward; THEN the openbrain-mcp adapter
  # (integrations/kubernetes-deployment/contract-tools.ts, mounted read-only) sends each forwarded
  # call to this :wt workbench, and no answer may carry an out-of-scope string (the test also
  # keeps attempt 1's dependence/tombstone test). Runs in the :wt image with ITS import map
  # (cached deps, offline); the test seeds its own run-unique rows on database B and removes them
  # before Dredd.
  Write-Host '[5a] every cloud-door contract tool through the gateway policy and the adapter under the forced cloud filter'
  $k8s = Join-Path $ob1 'integrations\kubernetes-deployment'
  $py = $Python
  if (-not $py) {
    $common = (& git -C $repo rev-parse --path-format=absolute --git-common-dir 2>$null)
    $cands = @((Join-Path $repo '.venv\Scripts\python.exe'))
    if ($common) { $cands += (Join-Path (Split-Path -Parent ($common.Trim())) '.venv\Scripts\python.exe') }
    $py = @($cands | Where-Object { Test-Path $_ }) | Select-Object -First 1
    if (-not $py) { $py = 'python' }
  }
  New-Item -ItemType Directory -Force $callsDir | Out-Null
  $o = (& $py (Join-Path $k8s 'contract-scope-calls.py') (Join-Path $repo 'openbrain-gateway\app.py') `
      (Join-Path $k8s 'contract-tools.json') $callsDir 2>&1 | ForEach-Object { "$_" }) -join "`n"
  $pyRc = $LASTEXITCODE
  Save 'contract-scope-calls.log' $o
  Check (($pyRc -eq 0) -and (Test-Path (Join-Path $callsDir 'calls.json'))) "gateway policy over the cloud tools ($py): $(($o -split "`n")[0])"
  $o = Dk run --rm --label $label --network $net -v "${k8s}:/k8s:ro" -v "${callsDir}:/calls:ro" `
    -e "CONTRACT_SCOPE_E2E_URL=http://${wbName}:8000" -e "CONTRACT_SCOPE_E2E_KEY=$key" `
    -e "CONTRACT_SCOPE_E2E_DB_HOST=$dbB" -e "CONTRACT_SCOPE_E2E_DB_PASSWORD=$pw" -e CONTRACT_SCOPE_E2E_CALLS=/calls/calls.json `
    $tag deno test --config /app/deno.json --no-lock --cached-only --allow-net --allow-env --allow-read /k8s/contract-scope.e2e.test.ts
  Save 'contract-scope-e2e.log' ($o -replace $key, '***')
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed( \(\d+ steps?\))? \| (\d+) failed').Match(($o -replace '\x1b\[[0-9;]*m', ''))
  $line = @(($o -split "`n") | Where-Object { $_ -match 'SUMMARY calls=' }) | Select-Object -First 1
  Check ($line -match 'leaking_calls=0 ') "cloud scoping probe: $(([string]$line).Trim() -replace ' control_hits_by_tool=.*$', '')"
  Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[2].Value -eq '2' -and $sum.Groups[4].Value -eq '0') "cloud scoping e2e: $($sum.Value)"

  $null = Dk image inspect $dreddTag
  if ($script:rc -ne 0) {
    $o = Dk build --label $label -t $dreddTag -f (Join-Path $ct 'dredd.Dockerfile') $ct
    Save 'dredd-build.log' $o
    Check ($script:rc -eq 0) "built $dreddTag"
    $made.images += $dreddTag
  }
  $gen = Join-Path $wb 'src\contracts\generated'
  $o = Dk run --rm --label $label --network $net -v "${gen}:/spec:ro" -v "${ct}:/ct:ro" $dreddTag `
    /spec/openapi.json "http://${wbName}:8000" --header "X-Brain-Key: $key" --hookfiles=/ct/dredd-hooks.js
  Save 'dredd.log' ($o -replace $key, '***')
  $clean = $o -replace '\x1b\[[0-9;]*m', ''
  $dm = ([regex]'complete: (\d+) passing, (\d+) failing, (\d+) errors, (\d+) skipped, (\d+) total').Match($clean)
  # Every operation's success (or typed 501) example must pass; the documented error shapes are
  # skipped by dredd-hooks.js (an example request cannot produce them).
  $ops = 0
  $docJson = Get-Content -Raw (Join-Path $gen 'openapi.json') | ConvertFrom-Json
  foreach ($p in $docJson.paths.PSObject.Properties) { $ops += @($p.Value.PSObject.Properties).Count }
  Check ($dm.Success -and $dm.Groups[2].Value -eq '0' -and $dm.Groups[3].Value -eq '0' -and [int]$dm.Groups[1].Value -eq $ops) "Dredd: $($dm.Value) (operations in the document: $ops)"

  # ---------------------------------------------------------------- 6. eleven-router smoke
  Write-Host '[6] the eleven-router smoke against the :wt workbench (capture twice, compare)'
  $smoke = Join-Path $repo 'scripts\checks\smoke-workbench-routers.ps1'
  if (Test-Path $smoke) {
    # Captures land HERE (owned by this run, fresh) and reach -Evidence only through the guard.
    $own = Join-Path $env:TEMP "rwp0-smoke-$rand"
    if (Test-Path $own) { throw "smoke directory $own already exists" }
    New-Item -ItemType Directory -Force $own | Out-Null
    $made.smokeDir = $own
    function Smoke-Capture([string]$dir, [string]$container) {
      # In-process; every capture names its disposable target explicitly (never the defaults).
      # Recorded BEFORE it runs: a capture that fails half-way still has to pass the guard (T2-6).
      $script:captures += , @($dir, $container)
      $o = (& $smoke -Capture $dir -ExecContainer $container -BaseUrl http://localhost:8000 -KeyEnv WORKBENCH_KEY *>&1 | Out-String)
      return @{ out = $o; rc = $LASTEXITCODE }
    }
    function Smoke-Compare([string]$x, [string]$y) {
      # In-process with ONE array argument: attempt 1's '-File ... -Compare $a $b' bound $b to
      # -Capture and captured the LIVE workbench instead of comparing (tester finding F1).
      $o = (& $smoke -Compare @($x, $y) *>&1 | Out-String)
      return @{ out = $o; rc = $LASTEXITCODE; pass = ([regex]::Matches($o, '(?m)^\s*PASS\s')).Count; fail = ([regex]::Matches($o, '(?m)^\s*FAIL\s')).Count }
    }
    # The refusals first: attempt 1's call shape, and a capture with no target, must be refused
    # (exit 2) and capture nothing.
    $probe = Join-Path $own 'refusal-probe'
    $o0 = (& powershell -NoProfile -File $smoke -Compare (Join-Path $own 'x') $probe 2>&1 | Out-String); $r0 = $LASTEXITCODE
    Check (($r0 -eq 2) -and ($o0 -match 'REFUSED') -and -not (Test-Path $probe)) "attempt 1's call shape '-File ... -Compare a b' is refused, nothing captured (rc $r0)"
    $o0b = (& $smoke -Capture $probe *>&1 | Out-String); $r0b = $LASTEXITCODE
    Check (($r0b -eq 2) -and ($o0b -match 'REFUSED') -and -not (Test-Path $probe)) "a capture with no target and no -Live is refused (rc $r0b)"
    $o0c = (& $smoke -Capture $probe -ExecContainer openbrain-workbench -BaseUrl http://caddy:8446 *>&1 | Out-String); $r0c = $LASTEXITCODE
    Check (($r0c -eq 2) -and ($o0c -match 'not a disposable target without -Live') -and -not (Test-Path $probe)) "the live target named without -Live is refused (rc $r0c)"
    # rw-p0b-purge-door, T2-2: the tester's bypass (another exec container name, the live service URL)
    $o0d = (& $smoke -Capture $probe -ExecContainer zz-not-a-container -BaseUrl http://openbrain-workbench:8000 *>&1 | Out-String); $r0d = $LASTEXITCODE
    Check (($r0d -eq 2) -and ($o0d -match "base URL host 'openbrain-workbench'") -and -not (Test-Path $probe)) "the tester's bypass (-ExecContainer zz-not-a-container -BaseUrl http://openbrain-workbench:8000) is refused by host, nothing captured (rc $r0d)"
    # rw-p0b-purge-door attempt 2: the label / compose / network-namespace half of the check, by
    # test - the Docker-free unit test (synthetic docker inspect JSON for every refusal shape, the
    # accepted shapes, a real docker.exe against a silent endpoint, and its own revert check: each
    # half of the check reduced to "return ''" must make it FAIL).
    $unit = Join-Path $repo 'scripts\checks\smoke-workbench-routers.test.ps1'
    $ou = (& powershell -NoProfile -File $unit 2>&1 | Out-String -Width 4096); $ru = $LASTEXITCODE
    Save 'smoke-check-unit.log' $ou
    $uPass = ([regex]::Matches($ou, '(?m)^\s*PASS\s')).Count; $uFail = ([regex]::Matches($ou, '(?m)^\s*FAIL\s')).Count
    Check (($ru -eq 0) -and ($uFail -eq 0) -and ($ou -match 'all checks passed') -and ($ou -match "Test-DisposableContainer reduced to return '': this test FAILS") -and ($ou -match "Test-DisposableTarget reduced to return '': this test FAILS")) "smoke check unit test (synthetic docker, every refusal shape, revert check): $uPass PASS, $uFail FAIL, rc $ru"
    # ... and the same shapes against REAL docker, on this run's own containers: a never-started
    # owner-labelled container sharing the :wt workbench's network namespace, and one on the host
    # network. Both must be refused (exit 2, no directory) - the attempt-1 bypass.
    $nsSide = "rwp0-nsside-$rand"; $nsHost = "rwp0-nshost-$rand"
    $null = Dk create --name $nsSide --label $label --network "container:$wbName" --entrypoint true $tag
    if ($script:rc -eq 0) { $made.containers += $nsSide }
    $null = Dk create --name $nsHost --label $label --network host --entrypoint true $tag
    if ($script:rc -eq 0) { $made.containers += $nsHost }
    $o0e = (& $smoke -Capture $probe -ExecContainer $nsSide -BaseUrl http://localhost:8000 *>&1 | Out-String -Width 4096); $r0e = $LASTEXITCODE
    Check (($r0e -eq 2) -and ($o0e -match 'shares the network namespace of container') -and -not (Test-Path $probe)) "a container sharing the workbench's network namespace (--network container:$wbName) is refused, nothing captured (rc $r0e)"
    $o0f = (& $smoke -Capture $probe -ExecContainer $nsHost -BaseUrl http://localhost:8000 *>&1 | Out-String -Width 4096); $r0f = $LASTEXITCODE
    Check (($r0f -eq 2) -and ($o0f -match "NetworkMode 'host'") -and -not (Test-Path $probe)) "a container on the host network (--network host) is refused, nothing captured (rc $r0f)"
    Save 'smoke-refusals.log' ($o0 + $o0b + $o0c + $o0d + $o0e + $o0f)
    $a = Join-Path $own 'smoke-a'; $b = Join-Path $own 'smoke-b'
    $c1 = Smoke-Capture $a $wbName; $c2 = Smoke-Capture $b $wbName
    $cmp = Smoke-Compare $a $b
    Save 'smoke.log' ($c1.out + $c2.out + $cmp.out)
    Check (($c1.rc -eq 0) -and ($c2.rc -eq 0)) "eleven-router smoke: two captures from $wbName"
    Check (($cmp.rc -eq 0) -and ($cmp.pass -eq 13) -and ($cmp.fail -eq 0) -and ($cmp.out -match 'all 13 router responses identical')) "eleven-router smoke: compared in-process: $($cmp.pass) PASS, $($cmp.fail) FAIL, rc $($cmp.rc)"
    # RED: a deliberately altered pair must FAIL, so a green compare means something.
    $red = Join-Path $own 'smoke-a-altered'
    Copy-Item -Recurse $a $red
    [System.IO.File]::AppendAllText((Join-Path $red 'notes-list.txt'), 'altered by the run')
    $cr = Smoke-Compare $a $red
    Save 'smoke-red.log' $cr.out
    Check (($cr.rc -eq 1) -and ($cr.fail -eq 1) -and ($cr.pass -eq 12) -and ($cr.out -match 'notes-list: the response changed')) "eleven-router smoke RED: an altered capture FAILS ($($cr.pass) PASS, $($cr.fail) FAIL, rc $($cr.rc))"
    Remove-Item -Recurse -Force $red
    # The pre-change capture: the same requests against a workbench built from $BaseSha,
    # on the same database, with the same fixture vault. A changed response FAILS.
    $baseSrc = Join-Path $env:TEMP "rwp0-base-$rand"
    $baseTar = Join-Path $env:TEMP "rwp0-base-$rand.zip"
    New-Item -ItemType Directory -Force $baseSrc | Out-Null
    # zip + Expand-Archive: no dependence on which tar is first on PATH (Git's GNU tar reads
    # 'C:' as a remote host)
    & git -C $ob1 archive --format=zip -o $baseTar $BaseSha docker/workbench
    Expand-Archive -Path $baseTar -DestinationPath $baseSrc -Force
    $baseTag = "openbrain-workbench:wt-$short-base"
    $baseName = "rwp0-wbbase-$rand"
    $o = Dk build --label $label -t $baseTag (Join-Path $baseSrc 'docker\workbench')
    Save 'base-build.log' $o
    Check ($script:rc -eq 0) "pre-change workbench $baseTag built from OB1 $BaseSha"
    if ($script:rc -eq 0) { $made.images += $baseTag }
    $o = Dk run -d --name $baseName --label $label --network $net -e PORT=8000 -e "WORKBENCH_KEY=$key" `
      -e "DB_HOST=$dbB" -e DB_USER=ob_app_memory -e "DB_PASSWORD=$appPw" -e OPEN_BRAIN_URL=http://unreachable.invalid `
      -e "EMBEDDING_API_BASE=http://${embName}:8080/v1" -e WIKI_GIT_DIR=/tmp/wiki -e WIKI_ASSETS_DIR=/tmp/wiki/assets `
      -v "$(Join-Path $ob1 'recipes'):/recipes:ro" $baseTag
    if ($script:rc -eq 0) { $made.containers += $baseName }
    for ($i = 0; $i -lt 60; $i++) {
      $null = Dk exec $baseName deno eval "const r=await fetch('http://localhost:8000/health');Deno.exit(r.ok?0:1)"
      if ($script:rc -eq 0) { break }
      Start-Sleep -Seconds 2
    }
    Check (Seed-Vault $baseName) "fixture vault seeded in $baseName"
    $pre = Join-Path $own 'smoke-pre-change'
    $c4 = Smoke-Capture $pre $baseName
    $cmp2 = Smoke-Compare $pre $a
    Save 'smoke-pre-vs-post.log' ($c4.out + $cmp2.out)
    Check (($c4.rc -eq 0) -and ($cmp2.rc -eq 0) -and ($cmp2.pass -eq 13) -and ($cmp2.fail -eq 0) -and ($cmp2.out -match 'all 13 router responses identical')) "eleven-router smoke: pre-change ($BaseSha) vs post-change, compared in-process: $($cmp2.pass) PASS, $($cmp2.fail) FAIL, rc $($cmp2.rc)"
    # The LIVE-DATA GUARD, then - and only then - the copy into -Evidence.
    $guardBad = @()
    foreach ($pair in @(@($a, $wbName), @($b, $wbName), @($pre, $baseName))) {
      foreach ($x in @(Test-Capture $pair[0] $pair[1])) { $guardBad += "$(Split-Path -Leaf $pair[0]): $x" }
    }
    Save 'smoke-guard.log' ($(if ($guardBad.Count) { $guardBad -join "`n" } else { 'clean: smoke-a, smoke-b, smoke-pre-change' }))
    Check ($guardBad.Count -eq 0) "live-data guard: every capture came from this run's fixtures ($($guardBad.Count) violation(s))"
    # RED for the guard: a capture shaped like attempt 1's live one (a notebook that is not a
    # fixture, a random uuid, oversized, captured from the live target) must be caught.
    $fake = Join-Path $own 'smoke-guard-red'
    Copy-Item -Recurse $a $fake
    $big = 'x' * ($MaxCaptureBytes + 1)
    [System.IO.File]::WriteAllText((Join-Path $fake 'notebooks-list.txt'), "status: 200`ntype: application/json`n`n" +
      '{"notebooks":[{"id":"' + [guid]::NewGuid() + '","name":"Not a fixture","pad":"' + $big + '"}]}' + "`n")
    [System.IO.File]::WriteAllText((Join-Path $fake '_target.txt'), "container: openbrain-workbench`nbase: http://caddy:8446`nlive: True`n")
    $redBad = @(Test-Capture $fake $wbName)
    Save 'smoke-guard-red.log' ($redBad -join "`n")
    Check ($redBad.Count -ge 5) "live-data guard RED: a live-shaped capture is caught ($($redBad.Count) violation(s): target, live, size, uuid, notebook)"
    Remove-Item -Recurse -Force $fake
    if ($guardBad.Count) { foreach ($x in $guardBad) { Write-Host "    guard: $x" } }
    $diff = @(Get-ChildItem -File $pre | Where-Object { $_.Name -ne '_target.txt' } | Where-Object {
        [System.IO.File]::ReadAllText($_.FullName) -cne [System.IO.File]::ReadAllText((Join-Path $a $_.Name)) })
    Save 'smoke-diff.txt' ($(if ($diff.Count) { ($diff | ForEach-Object { $_.Name }) -join "`n" } else { '(empty: no response file differs between smoke-pre-change and smoke-a)' }))
    # RED for the evidence gate (T2-6): a FAIL compare against a capture carrying a LIVE-SHAPED
    # response (a uuid that is no fixture's, a notebook name that is not 'Fixture notebook')
    # prints that excerpt; the staged log keeps it, and the published one must not.
    $planted = Join-Path $own 'smoke-planted'
    Copy-Item -Recurse $a $planted
    $script:plantedUuid = [guid]::NewGuid().ToString()
    $script:plantedName = 'Live notebook ' + $rand
    [System.IO.File]::WriteAllText((Join-Path $planted 'notebooks-list.txt'), "status: 200`ntype: application/json`n`n" +
      '{"notebooks":[{"id":"' + $script:plantedUuid + '","name":"' + $script:plantedName + '"}]}' + "`n")
    $cp = Smoke-Compare $a $planted
    Save 'smoke-planted-red.log' $cp.out
    Check (($cp.rc -eq 1) -and ($cp.out -match [regex]::Escape($script:plantedName)) -and ($cp.out -match [regex]::Escape($script:plantedUuid))) "evidence gate RED: a FAIL compare prints the planted live-shaped excerpt into the STAGED log (rc $($cp.rc))"
    # attempt 2 (N7, N8): the same excerpt planted in a NON-smoke log, in every uuid spelling, with a
    # docker id, an IP and a host path; plus an oversized log - published redacted / dropped.
    $script:plantedForms = @($script:plantedName, $script:plantedUuid, $script:plantedUuid.Replace('-', ''), $script:plantedUuid.Replace('-', '%2D'), $script:plantedUuid.ToUpper())
    Save 'planted-nonsmoke.log' ((@(
          ('PROBE {"notebooks":[{"id":"' + $script:plantedUuid + '","name":"' + $script:plantedName + '"}]}'),
          ('error: AssertionError: Values are not equal: { name: "' + $script:plantedName + '" }'),
          ("the notebook '$($script:plantedName)' was listed"),
          ("compact $($script:plantedForms[2]) encoded $($script:plantedForms[3]) upper {$($script:plantedForms[4])}"),
          "at $own on 172.27.1.4") -join "`n"))
    Save 'planted-oversized.log' ('z' * ($EvidenceMaxBytes + 1))
    Remove-Item -Recurse -Force $planted
    Remove-Item $baseSrc, $baseTar -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "  SKIP  $smoke not found (OB1 checked out alone)"
  }
} catch {
  if ("$_" -ne 'recorded') { Fail "aborted: $_" }
} finally {
  Write-Host '[7] teardown'
  # -v: a container's ANONYMOUS volumes go with it (attempt 1 left the Postgres data volumes).
  # Each container's volumes are recorded first, so the check below is about OURS: other
  # sessions' disposable runs on the same host create and orphan volumes concurrently.
  $ourVolumes = @()
  foreach ($c in $made.containers) {
    # No double quotes in the template: Windows PowerShell 5.1 strips them from a native argument
    # (a '{{if eq .Type "volume"}}' template fails to parse). Type=Name pairs, filtered here.
    $mounts = Dk inspect -f '{{range .Mounts}}{{.Type}}={{.Name}} {{end}}' $c
    # an already-removed container (the research service) answers an error text, not names
    if ($script:rc -eq 0) {
      $ourVolumes += @(($mounts -split '\s+') | Where-Object { $_ -match '^volume=[A-Za-z0-9][A-Za-z0-9_.-]+$' } | ForEach-Object { $_.Substring(7) })
    }
    $null = Dk rm -f -v $c
  }
  if ($made.net) { $null = Dk network rm $net }
  if (-not $KeepImages) { foreach ($i in $made.images) { $null = Dk rmi $i } }
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $callsDir -Recurse -Force -ErrorAction SilentlyContinue
  # THE EVIDENCE GATE (T2-6): -Evidence has not been touched so far; now the guard runs over EVERY
  # capture the run made, and only if all pass are the staged logs (redacted) and the captures
  # published. A failing guard publishes nothing.
  Write-Host '[8] evidence gate'
  $untouched = -not (Test-Path $Evidence) -or @(Get-ChildItem -Force $Evidence).Count -eq 0
  Check $untouched "nothing was written under -Evidence before the guard passed for every capture ($($script:captures.Count) capture(s))"
  $FixtureText = Get-FixtureText @((Join-Path $ct 'fixtures.sql'), (Join-Path $ct 'fixture-vault.ts'))
  $pub = Publish-Evidence $evStage $Evidence $script:captures ${function:Test-Capture} $FixtureUuids $FixtureText
  if ($pub.published) {
    Pass "evidence published after the guard passed for all $($script:captures.Count) capture(s): $($pub.files) item(s), $(@($pub.dropped).Count) dropped (listed in _dropped.txt)"
    foreach ($x in @($pub.dropped)) { Write-Host "  DROPPED  $x" }
    if ($script:plantedUuid) {
      $evFiles = @(Get-ChildItem -Recurse -File $Evidence)
      $evAll = @($evFiles | ForEach-Object { [System.IO.File]::ReadAllText($_.FullName) }) -join "`n"
      $leak = @($script:plantedForms | Where-Object { $evAll.Contains($_) })
      $foreign = @([regex]::Matches($evAll, $UuidAnyRx) | Where-Object {
          $g = $_.Groups; -not $FixtureUuids.ContainsKey(('{0}-{1}-{2}-{3}-{4}' -f $g[1].Value, $g[3].Value, $g[4].Value, $g[5].Value, $g[6].Value).ToLower()) })
      Check (($leak.Count -eq 0) -and ($foreign.Count -eq 0)) "evidence gate: the planted live-shaped excerpt (smoke and non-smoke logs, every uuid spelling) reached no evidence file (planted strings found: $($leak.Count); non-fixture uuids in any spelling: $($foreign.Count))"
      $pl = Join-Path $Evidence 'smoke-planted-red.log'
      Check ((Test-Path $pl) -and ([System.IO.File]::ReadAllText($pl) -match 'after: \[response excerpt redacted to its fixture ids: none\]')) 'evidence gate: the planted excerpt is published redacted to its fixture ids (none)'
      $pn = Join-Path $Evidence 'planted-nonsmoke.log'
      Check ((Test-Path $pn) -and ([System.IO.File]::ReadAllText($pn) -match '"<non-fixture-text>"') -and ([System.IO.File]::ReadAllText($pn) -notmatch '172\.27\.1\.4')) 'evidence gate: the non-smoke log with the planted excerpt is published redacted (name, uuids, IP, host path)'
      $big = @($evFiles | Where-Object { $_.Length -gt $EvidenceMaxBytes })
      Check ((-not (Test-Path (Join-Path $Evidence 'planted-oversized.log'))) -and (@($pub.dropped) -match '^planted-oversized\.log: ').Count -eq 1 -and $big.Count -eq 0) "evidence gate: no published file is over $EvidenceMaxBytes bytes; the planted oversized log is dropped and named ($($big.Count) over the cap)"
    }
  } else {
    Fail "evidence WITHHELD: the guard failed for $($pub.violations.Count) capture item(s); nothing was written under -Evidence"
    foreach ($x in $pub.violations) { Write-Host "    guard: $x" }
  }
  Remove-Item $evStage -Recurse -Force -ErrorAction SilentlyContinue
  if ($made.smokeDir) { Remove-Item $made.smokeDir -Recurse -Force -ErrorAction SilentlyContinue }
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}' | Out-String).Trim()
  $leftNet = (Dk network ls --filter "label=$label" --format '{{.Name}}' | Out-String).Trim()
  Check (($left -eq '') -and ($leftNet -eq '')) "nothing labelled $Id is left (containers: '$left', networks: '$leftNet')"
  $volLeft = @($ourVolumes | Where-Object { $null = Dk volume inspect $_; $script:rc -eq 0 })
  Check (($ourVolumes.Count -gt 0) -and ($volLeft.Count -eq 0)) "no volume of ours is left ($($ourVolumes.Count) recorded, $($volLeft.Count) left: '$($volLeft -join ' ')')"
  # The host-wide view, for the record only (concurrent sessions make it noisy): a new dangling
  # volume that is not one of ours is named, not failed, and never removed by this run.
  $volNew = @(DanglingVolumes | Where-Object { $volBefore -notcontains $_ })
  Write-Host "  INFO  new dangling volumes on the host during the run: $($volNew.Count) (ours among them: $(@($volNew | Where-Object { $ourVolumes -contains $_ }).Count))"
  $localAfter = LocalSnapshot
  Check ((Compare-Object $localBefore $localAfter) -eq $null) 'no :local image changed'
}
Write-Host "evidence: $Evidence"
if ($script:fail) { Write-Host "$($script:fail) check(s) FAILED"; exit 1 }
Write-Host 'all checks passed'
exit 0
