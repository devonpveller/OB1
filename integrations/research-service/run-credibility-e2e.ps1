# run-credibility-e2e.ps1 - research-workbench P3a's disposable test run (rw-p3a-entail).
#
#   powershell -NoProfile -File OB1\integrations\research-service\run-credibility-e2e.ps1 [-Id <owner id>] [-Evidence <dir>]
#
# What it does, and ONLY this:
#   1. stages the REAL initdb chain from OB1/docker/docker-compose.yml (every mounted init*.sql,
#      the contract's 230 slot and the credibility 240 slot), in compose order
#   2. creates ONE internal docker network; every container and the network are labelled
#      ai-stack.harness.owner=<Id>
#   3. builds openbrain-research:wt-<id> (NEVER :local) - the build RUNS the offline test suite -
#      and its test stage as openbrain-research-test:wt-<id>
#   4. proves the image gate is real: the same context plus one failing test must NOT build
#   5. database A (chain only): runs credibility.e2e.test.ts in the test image (the SQL twin of
#      the model, the before/after view, the re-score gate, the fold's move)
#   6. builds openbrain-workbench:wt-<id>; database B (chain + the P0 contract fixtures, the
#      production non-superuser role): runs the workbench integration_test.ts (P0's cases plus
#      P3a's quality(id))
#   7. tears down exactly what it created; verifies nothing labelled <Id> is left and no :local
#      image changed
# It never touches the live stack: no compose up/down, no ai-stack_* / open-brain_* network, no
# host port, no live database, no model, no OpenAlex/Crossref call.
# Exit code 0 = every check passed.
param(
  [string]$Id = 'wt-rw-p3a-entail',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Evidence = ''
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$label = "ai-stack.harness.owner=$Id"
$rs = $PSScriptRoot                                   # .../OB1/integrations/research-service
$ob1 = Split-Path -Parent (Split-Path -Parent $rs)    # .../OB1
$dockerDir = Join-Path $ob1 'docker'
$wb = Join-Path $dockerDir 'workbench'
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rwp3a-net-$rand"
$dbA = "rwp3a-dba-$rand"; $dbB = "rwp3a-dbb-$rand"
$short = ($Id -replace '^wt-', '')
$rsTag = "openbrain-research:wt-$short"
$rsTestTag = "openbrain-research-test:wt-$short"
$wbTag = "openbrain-workbench:wt-$short"
$negTag = "openbrain-research:wt-$short-gate-neg"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "rwp3a-evidence-$rand" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "rwp3a-initdb-$rand"
$negCtx = Join-Path $env:TEMP "rwp3a-negctx-$rand"

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
foreach ($t in @($rsTag, $rsTestTag, $wbTag, $negTag)) { if ($t -match ':local$') { throw 'refusing to build a :local tag' } }

Write-Host "== rw-p3a-entail disposable run  owner=$Id  net=$net  evidence=$Evidence"
$null = Dk version --format '{{.Server.Version}}'
if ($script:rc -ne 0) { Write-Host 'docker is not reachable'; exit 2 }
function LocalSnapshot { (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim() -split "`r?`n" | Sort-Object }
$localBefore = LocalSnapshot
$made = @{ net = $false; containers = @(); images = @() }

function Start-Db([string]$name, [bool]$fixtures) {
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
  Check ($logs -match '240-init-research-credibility\.sql') "$name ran 240-init-research-credibility.sql"
  for ($i = 0; $i -lt 60; $i++) {
    $null = Dk exec $name pg_isready -h 127.0.0.1 -U postgres -d openbrain
    if ($script:rc -eq 0) { break }
    Start-Sleep -Seconds 2
  }
  if ($fixtures) {
    $o = Dk exec $name psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
    Check ($script:rc -eq 0) "$name has ob_app_memory (non-superuser, service_role member)"
    $null = Dk cp (Join-Path $wb 'contract-test\fixtures.sql') "${name}:/tmp/fixtures.sql"
    $o = Dk exec $name psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/fixtures.sql
    Save "$name-fixtures.log" $o
    Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) "$name P0 contract fixtures applied"
  }
  return $true
}

try {
  Write-Host '[1] the initdb chain, derived from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check ($chain.Count -ge 30) "staged $($chain.Count) migrations"
  Check (@($chain | Where-Object { $_[1] -eq '240-init-research-credibility.sql' }).Count -eq 1) 'the chain mounts 240-init-research-credibility.sql'
  $null = Dk image inspect $PgImage
  if ($script:rc -ne 0) { Fail "$PgImage is not on the host"; throw 'pg image' }

  Write-Host '[2] disposable internal network'
  $null = Dk network create --internal --label $label $net
  Check ($script:rc -eq 0) "network $net created (internal, labelled)"
  if ($script:rc -ne 0) { throw 'network' }
  $made.net = $true

  Write-Host "[3] build $rsTag (the build runs the test suite) and its test stage"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  $o = Dk build --progress=plain --build-arg "OB1_SHA=$sha" --label $label -t $rsTag $rs
  Save 'research-build.log' $o
  Check ($script:rc -eq 0) "image $rsTag built"
  if ($script:rc -eq 0) { $made.images += $rsTag }
  $sum = Summary $o
  Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[2].Value -gt 300) "the build ran deno test: $($sum.Value)"
  $o = Dk build --target test --label $label -t $rsTestTag $rs
  Check ($script:rc -eq 0) "test-stage image $rsTestTag built"
  if ($script:rc -eq 0) { $made.images += $rsTestTag }
  $o = Dk run --rm --network none --entrypoint sh $rsTag -c 'ls /app; ls /app/*.test.ts 2>/dev/null | wc -l'
  Save 'runtime-image-files.txt' $o
  Check ($o -notmatch 'fixtures' -and ($o -split "`n")[-1].Trim() -eq '0') 'the runtime image ships no tests and no fixtures'
  $flag = 'SKEPTIC' + '_ENABLED'   # spelled in two halves so this script is not itself a hit
  $o = Dk run --rm --network none --entrypoint sh $rsTag -c "grep -l $flag /app/*.ts | wc -l; ls /app/skeptic.ts 2>&1"
  Save 'runtime-skeptic.txt' $o
  Check ((($o -split "`n")[0].Trim() -eq '0') -and ($o -match 'No such file')) 'the runtime image has no Skeptic flag and no skeptic.ts'

  Write-Host '[4] the gate is real: one failing test must stop the build'
  New-Item -ItemType Directory -Force $negCtx | Out-Null
  Copy-Item -Recurse (Join-Path $rs '*') $negCtx
  [System.IO.File]::WriteAllText((Join-Path $negCtx 'zz-gate-negative.test.ts'),
    "Deno.test('gate negative control: this test fails on purpose', () => { throw new Error('the image build must stop here'); });`n",
    (New-Object System.Text.UTF8Encoding $false))
  $o = Dk build --progress=plain --label $label -t $negTag $negCtx
  Save 'gate-negative-build.log' $o
  $negRc = $script:rc
  Check ($negRc -ne 0 -and $o -match 'gate negative control') "a failing test fails the image build (rc=$negRc)"
  if ($negRc -eq 0) { $made.images += $negTag }

  Write-Host '[5] database A + credibility.e2e.test.ts (SQL twin, before/after, gate, fold)'
  if (-not (Start-Db $dbA $false)) { throw 'db A' }
  $o = Dk run --rm --label $label --network $net -e "CRED_E2E_DB_HOST=$dbA" -e "CRED_E2E_DB_PASSWORD=$pw" `
    $rsTestTag deno test --allow-net --allow-env --allow-read credibility.e2e.test.ts
  Save 'credibility-e2e.log' $o
  $sum = Summary $o
  Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[3].Value -eq '0' -and [int]$sum.Groups[2].Value -ge 6) "credibility e2e: $($sum.Value)"
  $o = Dk exec $dbA psql -U postgres -d openbrain -X -A -F '|' -c "SELECT kind, kind_basis, round(before_confidence::numeric,3), round(after_confidence::numeric,3), sources, paper_sources, single_source_non_paper, below_floor_before, below_floor_after, model_version, left(text,40) FROM public.credibility_before_after ORDER BY text"
  Save 'before-after-fixture-view.txt' $o

  Write-Host "[6] $wbTag + database B + the workbench integration tests (P0 + P3a quality)"
  $o = Dk build --build-arg "OB1_SHA=$sha" --label $label -t $wbTag $wb
  Save 'workbench-build.log' $o
  Check ($script:rc -eq 0) "image $wbTag built"
  if ($script:rc -eq 0) { $made.images += $wbTag }
  if (-not (Start-Db $dbB $true)) { throw 'db B' }
  $o = Dk run --rm --label $label --network $net -e "CONTRACT_TEST_DB_HOST=$dbB" -e CONTRACT_TEST_DB_USER=ob_app_memory `
    -e "CONTRACT_TEST_DB_PASSWORD=$appPw" $wbTag deno test --allow-net --allow-env --allow-read src/contracts/integration_test.ts
  Save 'workbench-integration-test.log' $o
  $sum = Summary $o
  Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[3].Value -eq '0') "workbench integration tests: $($sum.Value)"
  Check ($o -match 'P3a: quality\(id\) names the corroborating and contradicting sources[^\n]*ok') 'the P3a quality(id) case ran and passed'
}
finally {
  Write-Host '[7] teardown'
  foreach ($c in $made.containers) { $null = Dk rm -f $c }
  if ($made.net) { $null = Dk network rm $net }
  foreach ($i in $made.images) { $null = Dk rmi -f $i }
  Remove-Item -Recurse -Force $stage, $negCtx -ErrorAction SilentlyContinue
  $left = @((Dk ps -a --filter "label=$label" --format '{{.Names}}') -split "`n" | Where-Object { $_ })
  Check ($left.Count -eq 0) "no container labelled $label is left ($($left.Count))"
  $leftNet = @((Dk network ls --filter "label=$label" --format '{{.Name}}') -split "`n" | Where-Object { $_ })
  Check ($leftNet.Count -eq 0) "no network labelled $label is left ($($leftNet.Count))"
  $localAfter = LocalSnapshot
  Check ((Compare-Object $localBefore $localAfter) -eq $null) 'no :local image changed'
  Write-Host "== $(if ($script:fail) { "FAILED ($script:fail)" } else { 'ALL PASSED' })  evidence: $Evidence"
}
exit $script:fail
