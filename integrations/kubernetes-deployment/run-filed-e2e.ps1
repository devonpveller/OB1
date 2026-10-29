# run-filed-e2e.ps1 - rw-curator-filed's disposable test run (clauses 3 and 4 against real Postgres).
#
#   powershell -NoProfile -File OB1/integrations/kubernetes-deployment/run-filed-e2e.ps1 [-Id <owner id>] [-Evidence <dir>]
#
# What it does, and ONLY this:
#   1. stages the REAL initdb chain from OB1/docker/docker-compose.yml (280-init-research-filed.sql included)
#   2. creates ONE internal bridge network (--internal, subnet pinned outside 192.168.0.0/16); every
#      container and the network are labelled ai-stack.harness.owner=<Id>
#   3. builds the kubernetes-deployment image as openbrain-mcp-test:wt-<id> (NEVER :local; the build
#      runs deno check) and runs research-filed.e2e.test.ts in it: the REAL index.ts persist route
#      against the database and a stub embeddings endpoint, all inside the test container
#   4. migration drill by psql: pre-check, apply twice (idempotent), revert, re-apply
#   5. tears down exactly what it created and verifies nothing labelled <Id> is left, no volume of ours
#      is left and no :local image changed
# It never touches the live stack: no compose up/down, no ai-stack_* / open-brain_* network, no host
# port, no live database. Exit code 0 = every check passed.
param(
  [string]$Id = 'wt-rw-curator-filed',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Evidence = '',
  [string]$Subnet = '',
  [string]$SubnetBase = '10.244',
  # RED evidence only: build the server from another kubernetes-deployment directory (a copy of the
  # pre-change base); the test file and the initdb chain still come from this tree.
  [string]$ServiceRoot = ''
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$label = "ai-stack.harness.owner=$Id"
$rs = if ($ServiceRoot) { (Resolve-Path $ServiceRoot).Path } else { $PSScriptRoot }
$ob1 = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dockerDir = Join-Path $ob1 'docker'
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rwcf-net-$rand"
$db = "rwcf-db-$rand"
$short = ($Id -replace '^wt-', '')
$testTag = "openbrain-mcp-test:wt-$short"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "rwcf-evidence-$rand" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "rwcf-initdb-$rand"

$script:fail = 0
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }
function Save([string]$name, [string]$text) {
  [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false))
}
function Summary([string]$text) {
  return ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed(?: \| (\d+) ignored)?').Match(($text -replace '\x1b\[[0-9;]*m', ''))
}
function Test-SubnetAllowed([string]$s) {
  if ($s -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/(\d{1,2})$') { return $false }
  $o = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4]); $len = [int]$Matches[5]
  if (@($o | Where-Object { $_ -gt 255 }).Count -gt 0) { return $false }
  if ($len -ne 24) { return $false }
  if ($o[0] -eq 192 -and $o[1] -eq 168) { return $false }
  if ($o[0] -eq 10 -and $o[1] -eq 234 -and $o[2] -eq 77) { return $false }
  return $true
}
function New-PinnedNetwork([string]$name) {
  if ($SubnetBase -notmatch '^(\d{1,3})\.(\d{1,3})$' -or $SubnetBase -match '^192\.168$') { Fail "refusing -SubnetBase '$SubnetBase'"; return '' }
  $cands = if ($Subnet) { @($Subnet) } else { @(1..8 | ForEach-Object { "$SubnetBase.$(Get-Random -Minimum 1 -Maximum 255).0/24" }) }
  foreach ($s in $cands) {
    if (-not (Test-SubnetAllowed $s)) { Fail "refusing subnet '$s'"; return '' }
    $null = Dk network create --driver bridge --internal --subnet $s --label $label $name
    if ($script:rc -eq 0) { return $s }
  }
  return ''
}
function Get-Chain {
  $cf = Join-Path $dockerDir 'docker-compose.yml'
  $compose = (@(Get-Content $cf) | ForEach-Object { $_ -replace '(^|\s)#.*$', '' }) -join "`n"
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  return , @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
}
if ($testTag -match ':local$') { throw 'refusing a :local tag' }

Write-Host "== rw-curator-filed disposable run  owner=$Id  net=$net  evidence=$Evidence"
$null = Dk version --format '{{.Server.Version}}'
if ($script:rc -ne 0) { Write-Host 'docker is not reachable'; exit 2 }
function LocalSnapshot { (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim() -split "`r?`n" | Sort-Object }
$localBefore = LocalSnapshot
$made = @{ net = $false; containers = @(); images = @() }

try {
  Write-Host '[1] the initdb chain, derived from docker-compose.yml'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = Get-Chain
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check ($chain.Count -ge 30) "staged $($chain.Count) migrations"
  Check (@($chain | Where-Object { $_[1] -eq '280-init-research-filed.sql' }).Count -eq 1) 'the chain mounts 280-init-research-filed.sql'
  $null = Dk image inspect $PgImage
  if ($script:rc -ne 0) { Fail "$PgImage is not on the host"; throw 'pg image' }

  Write-Host '[2] disposable internal network'
  $sub = New-PinnedNetwork $net
  Check ($sub -ne '') "network $net created (bridge, internal, labelled, --subnet $sub)"
  if ($sub -eq '') { throw 'network' }
  $made.net = $true

  Write-Host "[3] build $testTag (the build runs deno check)"
  $o = Dk build --no-cache --progress=plain --label $label -t $testTag $rs
  Save 'research-test-build.log' $o
  Check ($script:rc -eq 0) "image $testTag built"
  if ($script:rc -eq 0) { $made.images += $testTag } else { throw 'build' }

  Write-Host '[4] the database + research-filed.e2e.test.ts'
  $o = Dk run -d --name $db --label $label --network $net -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=openbrain `
    -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
  if ($script:rc -ne 0) { Fail "postgres did not start: $o"; throw 'db' }
  $made.containers += $db
  for ($i = 0; $i -lt 150; $i++) {
    $logs = Dk logs $db
    if ($logs -match 'PostgreSQL init process complete') { break }
    if ((Dk inspect -f '{{.State.Running}}' $db) -ne 'true') { break }
    Start-Sleep -Seconds 2
  }
  $logs = Dk logs $db
  Save 'initdb.log' $logs
  Check ($logs -match 'PostgreSQL init process complete') 'the initdb chain ran to completion'
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "initdb logged no ERROR ($($errs.Count))"
  Check ($logs -match '280-init-research-filed\.sql') 'initdb ran 280-init-research-filed.sql'
  for ($i = 0; $i -lt 60; $i++) {
    $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain
    if ($script:rc -eq 0) { break }
    Start-Sleep -Seconds 2
  }
  $testFile = Join-Path $PSScriptRoot 'research-filed.e2e.test.ts'
  $o = Dk run --rm --label $label --network $net -e "RF_E2E_DB_HOST=$db" -e "RF_E2E_DB_PASSWORD=$pw" -e NO_COLOR=1 `
    -v "${testFile}:/app/research-filed.e2e.test.ts:ro" -w /app `
    $testTag deno test --unstable-net --allow-net --allow-env --allow-read --allow-run research-filed.e2e.test.ts
  Save 'filed-e2e.log' $o
  $sum = Summary $o
  Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[3].Value -eq '0' -and [int]$sum.Groups[2].Value -ge 4) "filed e2e: $($sum.Value)"
  $curDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'research-curator'
  $o = Dk run --rm --label $label --network $net -e "RESEND_E2E_DB_HOST=$db" -e "RESEND_E2E_DB_PASSWORD=$pw" -e NO_COLOR=1 `
    -v "${curDir}:/curator:ro" -w /curator `
    $testTag deno test --no-lock --unstable-net --allow-net --allow-env --allow-read --allow-run resend.e2e.test.ts
  Save 'resend-e2e.log' $o
  $sum = Summary $o
  Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[3].Value -eq '0' -and [int]$sum.Groups[2].Value -ge 3) "resend e2e (real curator + real persist, always-new resolver): $($sum.Value)"
  $o = Dk exec $db psql -U postgres -d openbrain -X -A -F '|' -c "SELECT j.status, e.type, e.payload->>'research_key', (SELECT count(*) FROM sources s WHERE s.content_type='research_synthesis' AND s.research_key = e.payload->>'research_key') AS syntheses FROM research_job_events e JOIN research_jobs j ON j.id=e.job_id WHERE e.type='filed' ORDER BY e.id"
  Save 'events-after.txt' $o

  Write-Host '[4b] migration drill: pre-check, apply twice, revert, re-apply'
  $f = Join-Path $dockerDir 'init-research-filed.sql'; $r = Join-Path $dockerDir 'revert-research-filed.sql'
  $null = Dk cp $f "${db}:/tmp/apply.sql"; $null = Dk cp $r "${db}:/tmp/revert.sql"
  $pre = Dk exec $db psql -U postgres -d openbrain -X -A -t -c "SELECT count(*) FROM pg_constraint WHERE conname IN ('research_job_events_filed','research_job_events_type_check')"
  Check ($pre.Trim() -eq '2') "pre-check: both constraints present after the chain ($($pre.Trim()))"
  $o1 = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -f /tmp/apply.sql
  Check ($script:rc -eq 0) 'apply is idempotent (second run)'
  $o2 = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -f /tmp/revert.sql
  Check ($script:rc -eq 0) 'revert runs'
  $o3 = Dk exec $db psql -U postgres -d openbrain -X -A -t -c "INSERT INTO research_job_events (job_id, root_job_id, type, kind, payload) SELECT id, id, 'filed', 'due_process', '{}'::jsonb FROM research_jobs LIMIT 1"
  Check ($o3 -match 'violates check constraint') "after revert a 'filed' event is refused"
  $o4 = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -f /tmp/apply.sql
  Check ($script:rc -eq 0) 're-apply after revert runs'
  Save 'migration-drill.txt' ("== apply#2`n$o1`n== revert`n$o2`n== insert after revert`n$o3`n== re-apply`n$o4")
}
finally {
  Write-Host '[5] teardown'
  $ourVolumes = @()
  foreach ($c in $made.containers) {
    $mounts = Dk inspect -f '{{range .Mounts}}{{.Type}}={{.Name}} {{end}}' $c
    if ($script:rc -eq 0) {
      $ourVolumes += @(($mounts -split '\s+') | Where-Object { $_ -match '^volume=[A-Za-z0-9][A-Za-z0-9_.-]+$' } | ForEach-Object { $_.Substring(7) })
    }
    $null = Dk rm -f -v $c
  }
  if ($made.net) { $null = Dk network rm $net }
  foreach ($i in $made.images) { $null = Dk rmi -f $i }
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  $left = @((Dk ps -a --filter "label=$label" --format '{{.Names}}') -split "`n" | Where-Object { $_ })
  Check ($left.Count -eq 0) "no container labelled $label is left ($($left.Count))"
  $leftNet = @((Dk network ls --filter "label=$label" --format '{{.Name}}') -split "`n" | Where-Object { $_ })
  Check ($leftNet.Count -eq 0) "no network labelled $label is left ($($leftNet.Count))"
  $volLeft = @($ourVolumes | Where-Object { $null = Dk volume inspect $_; $script:rc -eq 0 })
  Check ($volLeft.Count -eq 0) "no volume of ours is left ($($ourVolumes.Count) recorded, $($volLeft.Count) left)"
  $localAfter = LocalSnapshot
  Check (-not (Compare-Object $localBefore $localAfter)) 'no :local image changed'
  Write-Host "== $(if ($script:fail) { "FAILED ($script:fail)" } else { 'ALL PASSED' })  evidence: $Evidence"
}
exit $script:fail
