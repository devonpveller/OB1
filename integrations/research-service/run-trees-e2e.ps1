# run-trees-e2e.ps1 - research-workbench P4a's disposable test run (rw-p4a-trees).
#
#   powershell -NoProfile -File OB1\integrations\research-service\run-trees-e2e.ps1 [-Id <owner id>] [-Evidence <dir>]
#
# What it does, and ONLY this:
#   1. stages the REAL initdb chain from OB1/docker/docker-compose.yml (every mounted init*.sql, the
#      P4a 260 slot included), in compose order
#   2. creates ONE internal bridge network (--internal, subnet pinned outside 192.168.0.0/16); every
#      container and the network are labelled ai-stack.harness.owner=<Id>
#   3. builds the research service's test stage as openbrain-research-test:wt-<id> (NEVER :local) -
#      the build RUNS the offline suite (tree.test.ts included)
#   4. one database (the chain only), then trees.e2e.test.ts in the test image: the REAL index.ts
#      against the database, a stub LLM gateway (which also answers llm-queue's /observe/queue/estimate)
#      and a stub curator - all inside the test container (127.0.0.1); no model, no search, no egress
#   5. tears down exactly what it created (containers with -v) and verifies nothing labelled <Id> is
#      left, no volume of ours is left and no :local image changed
# It never touches the live stack: no compose up/down, no ai-stack_* / open-brain_* network, no host
# port, no live database, no llm-queue, no LiteLLM. Exit code 0 = every check passed.
param(
  [string]$Id = 'wt-rw-p4a-trees',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Evidence = '',
  [string]$Subnet = '',
  [string]$SubnetBase = '10.243',
  # RED evidence only: run against another research-service directory (e.g. a copy of the pre-P4a
  # base with the new test files dropped in). Its OB1 root (two levels up) supplies the chain.
  [string]$ServiceRoot = ''
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$label = "ai-stack.harness.owner=$Id"
$rs = if ($ServiceRoot) { (Resolve-Path $ServiceRoot).Path } else { $PSScriptRoot }
$ob1 = Split-Path -Parent (Split-Path -Parent $rs)
$dockerDir = Join-Path $ob1 'docker'
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rwp4a-net-$rand"
$db = "rwp4a-db-$rand"
$short = ($Id -replace '^wt-', '')
$testTag = "openbrain-research-test:wt-$short"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "rwp4a-evidence-$rand" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "rwp4a-initdb-$rand"

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

Write-Host "== rw-p4a-trees disposable run  owner=$Id  net=$net  evidence=$Evidence"
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
  Check (@($chain | Where-Object { $_[1] -eq '260-init-research-trees.sql' }).Count -eq 1) 'the chain mounts 260-init-research-trees.sql'
  $null = Dk image inspect $PgImage
  if ($script:rc -ne 0) { Fail "$PgImage is not on the host"; throw 'pg image' }

  Write-Host '[2] disposable internal network'
  $sub = New-PinnedNetwork $net
  Check ($sub -ne '') "network $net created (bridge, internal, labelled, --subnet $sub)"
  if ($sub -eq '') { throw 'network' }
  $made.net = $true

  Write-Host "[3] build $testTag (the build runs the offline suite)"
  $o = Dk build --no-cache --progress=plain --target test --label $label -t $testTag $rs
  Save 'research-test-build.log' $o
  Check ($script:rc -eq 0) "image $testTag built"
  if ($script:rc -eq 0) { $made.images += $testTag } else { throw 'build' }
  $sum = Summary $o
  Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0) "the build ran the offline suite: $($sum.Value)"
  Check ($o -match 'P4a lane: RESEARCH_MAX_CONCURRENCY is no longer a hand-set cap[^\n]*ok') 'tree.test.ts ran in the build'

  Write-Host '[4] the database + trees.e2e.test.ts'
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
  Check ($logs -match '260-init-research-trees\.sql') 'initdb ran 260-init-research-trees.sql'
  for ($i = 0; $i -lt 60; $i++) {
    $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain
    if ($script:rc -eq 0) { break }
    Start-Sleep -Seconds 2
  }
  $o = Dk run --rm --label $label --network $net -e "TREES_E2E_DB_HOST=$db" -e "TREES_E2E_DB_PASSWORD=$pw" -e NO_COLOR=1 `
    $testTag deno test --allow-net --allow-env --allow-read --allow-run trees.e2e.test.ts
  Save 'trees-e2e.log' $o
  $sum = Summary $o
  Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[3].Value -eq '0' -and [int]$sum.Groups[2].Value -ge 7) "trees e2e: $($sum.Value)"
  $o = Dk exec $db psql -U postgres -d openbrain -X -A -F '|' -c "SELECT branch_kind, status, rooted_step_id, left(query,50), left(coalesce(topic_estimate,''),40) FROM research_jobs ORDER BY created_at"
  Save 'jobs-after.txt' $o
  $o = Dk exec $db psql -U postgres -d openbrain -X -A -F '|' -c "SELECT steer_kind, step_id, left(text,40), left(topic_estimate,40), left(anchor,40) FROM research_steers ORDER BY created_at"
  Save 'steers-after.txt' $o
  $o = Dk exec $db psql -U postgres -d openbrain -X -A -F '|' -c "SELECT type, kind, count(*), count(trail) FROM research_job_events GROUP BY 1,2 ORDER BY 1,2"
  Save 'events-after.txt' $o
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
