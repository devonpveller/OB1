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
#      Dredd (rw-dredd:wt-<id>) against every example in generated/openapi.json
#   6. runs the eleven-router smoke (scripts/checks/smoke-workbench-routers.ps1) against the
#      :wt workbench twice and compares (the script works; the routers answer), then against a
#      workbench built from -BaseSha on the same database: the pre-change capture, which must
#      be identical to the post-change one
#   7. tears down exactly what it created; verifies nothing labelled <Id> is left and no :local
#      image changed
# It never touches the live stack: no compose up/down, no ai-stack_* / open-brain_* network, no
# host port, no live database, no rm/rmi of anything it did not create.
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
$made = @{ net = $false; containers = @(); images = @() }

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
  $null = Dk rm -f $rsName

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
    $a = Join-Path $Evidence 'smoke-a'; $b = Join-Path $Evidence 'smoke-b'
    $o1 = (& powershell -NoProfile -File $smoke -Capture $a -ExecContainer $wbName -BaseUrl http://localhost:8000 -KeyEnv WORKBENCH_KEY 2>&1 | Out-String); $r1 = $LASTEXITCODE
    $o2 = (& powershell -NoProfile -File $smoke -Capture $b -ExecContainer $wbName -BaseUrl http://localhost:8000 -KeyEnv WORKBENCH_KEY 2>&1 | Out-String); $r2 = $LASTEXITCODE
    $o3 = (& powershell -NoProfile -File $smoke -Compare $a $b 2>&1 | Out-String); $r3 = $LASTEXITCODE
    Save 'smoke.log' ($o1 + $o2 + $o3)
    Check (($r1 -eq 0) -and ($r2 -eq 0) -and ($r3 -eq 0)) 'eleven-router smoke: captured twice, identical'
    # The pre-change capture: the same requests against a workbench built from $BaseSha,
    # on the same database. A changed response FAILS.
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
    $pre = Join-Path $Evidence 'smoke-pre-change'
    $o4 = (& powershell -NoProfile -File $smoke -Capture $pre -ExecContainer $baseName -BaseUrl http://localhost:8000 -KeyEnv WORKBENCH_KEY 2>&1 | Out-String); $r4 = $LASTEXITCODE
    $o5 = (& powershell -NoProfile -File $smoke -Compare $pre $a 2>&1 | Out-String); $r5 = $LASTEXITCODE
    Save 'smoke-pre-vs-post.log' ($o4 + $o5)
    Check (($r4 -eq 0) -and ($r5 -eq 0)) "eleven-router smoke: pre-change ($BaseSha) and post-change captures are identical"
    Remove-Item $baseSrc, $baseTar -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "  SKIP  $smoke not found (OB1 checked out alone)"
  }
} catch {
  if ("$_" -ne 'recorded') { Fail "aborted: $_" }
} finally {
  Write-Host '[7] teardown'
  foreach ($c in $made.containers) { $null = Dk rm -f $c }
  if ($made.net) { $null = Dk network rm $net }
  if (-not $KeepImages) { foreach ($i in $made.images) { $null = Dk rmi $i } }
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}' | Out-String).Trim()
  $leftNet = (Dk network ls --filter "label=$label" --format '{{.Name}}' | Out-String).Trim()
  Check (($left -eq '') -and ($leftNet -eq '')) "nothing labelled $Id is left (containers: '$left', networks: '$leftNet')"
  $localAfter = LocalSnapshot
  Check ((Compare-Object $localBefore $localAfter) -eq $null) 'no :local image changed'
}
Write-Host "evidence: $Evidence"
if ($script:fail) { Write-Host "$($script:fail) check(s) FAILED"; exit 1 }
Write-Host 'all checks passed'
exit 0
