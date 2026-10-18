# run-contract-tests.ps1 - the retrieval contract's disposable test run (research-workbench P0,
# rw-p0-contract).
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-contract-tests.ps1 [-Id <owner id>] [-Evidence <dir>]
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
#      (rw-p0-contract2) - then Dredd (rw-dredd:wt-<id>) against every example in
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
  [switch]$KeepImages,
  # The OB1 commit the item branched from: the eleven-router smoke runs against a workbench
  # built from it too, and the two captures must be identical (the pre-change capture).
  [string]$BaseSha = 'ce731ff',
  # Re-record src/contracts/schemas/examples.ts from the fixture (then: deno task contract:gen,
  # and run again without the switch). Skips Dredd and the smoke.
  [switch]$RecordExamples
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
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
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "rwp0-initdb-$rand"

$script:fail = 0
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }
function Save([string]$name, [string]$text) {
  [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false))
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
$FixtureUuids = @{}
foreach ($m in [regex]::Matches((Get-Content -Raw (Join-Path $ct 'fixtures.sql')), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')) { $FixtureUuids[$m.Value] = $true }
$FixtureUuids['00000000-0000-4000-8000-000000000000'] = $true   # the smoke's own unknown-job probe
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
  $null = Dk network create --internal --label $label $net
  Check ($script:rc -eq 0) "network $net created (internal, labelled)"
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
  # 5a. the cloud door's forced filter through the adapter (rw-p0-contract2): the openbrain-mcp
  # adapter (integrations/kubernetes-deployment/contract-tools.ts, mounted read-only) calls this
  # :wt workbench with {"share":"cloud"}; contract_dependence and contract_tombstone must return
  # nothing outside the scope. Runs in the :wt image with ITS import map (cached deps, offline);
  # the test seeds its own run-unique rows on database B and removes them before Dredd.
  Write-Host '[5a] contract_dependence / contract_tombstone through the adapter under the forced cloud filter'
  $k8s = Join-Path $ob1 'integrations\kubernetes-deployment'
  $o = Dk run --rm --label $label --network $net -v "${k8s}:/k8s:ro" `
    -e "CONTRACT_SCOPE_E2E_URL=http://${wbName}:8000" -e "CONTRACT_SCOPE_E2E_KEY=$key" `
    -e "CONTRACT_SCOPE_E2E_DB_HOST=$dbB" -e "CONTRACT_SCOPE_E2E_DB_PASSWORD=$pw" `
    $tag deno test --config /app/deno.json --no-lock --cached-only --allow-net --allow-env --allow-read /k8s/contract-scope.e2e.test.ts
  Save 'contract-scope-e2e.log' ($o -replace $key, '***')
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed( \(\d+ steps?\))? \| (\d+) failed').Match(($o -replace '\x1b\[[0-9;]*m', ''))
  Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[2].Value -eq '1' -and $sum.Groups[4].Value -eq '0') "cloud scoping e2e: $($sum.Value)"

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
    Check (($r0c -eq 2) -and ($o0c -match 'needs -Live') -and -not (Test-Path $probe)) "the live target named without -Live is refused (rc $r0c)"
    Save 'smoke-refusals.log' ($o0 + $o0b + $o0c)
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
    if ($guardBad.Count -eq 0) {
      foreach ($d in @($a, $b, $pre)) { Copy-Item -Recurse $d (Join-Path $Evidence (Split-Path -Leaf $d)) }
      $diff = @(Get-ChildItem -File $pre | Where-Object { $_.Name -ne '_target.txt' } | Where-Object {
          [System.IO.File]::ReadAllText($_.FullName) -cne [System.IO.File]::ReadAllText((Join-Path $a $_.Name)) })
      Save 'smoke-diff.txt' ($(if ($diff.Count) { ($diff | ForEach-Object { $_.Name }) -join "`n" } else { '(empty: no response file differs between smoke-pre-change and smoke-a)' }))
    } else {
      foreach ($x in $guardBad) { Write-Host "    guard: $x" }
    }
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
