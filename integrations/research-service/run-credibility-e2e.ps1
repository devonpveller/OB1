# run-credibility-e2e.ps1 - research-workbench P3a's disposable test run (rw-p3a-entail).
#
#   powershell -NoProfile -File OB1\integrations\research-service\run-credibility-e2e.ps1 [-Id <owner id>] [-Evidence <dir>]
#
# What it does, and ONLY this:
#   1. stages the REAL initdb chain from OB1/docker/docker-compose.yml (every mounted init*.sql,
#      the contract's 230 slot and the credibility 245 slot, after P2a's 240), in compose order
#   2. creates ONE internal docker network; every container and the network are labelled
#      ai-stack.harness.owner=<Id>
#   3. builds openbrain-research:wt-<id> (NEVER :local) - the build RUNS the offline test suite -
#      and its test stage as openbrain-research-test:wt-<id>
#   4. proves the image gate is real: the same context plus one failing test must NOT build
#   5. database A (chain only): runs credibility.e2e.test.ts, (attempt 3) credibility-twins.e2e.test.ts and
#      (attempt 4) credibility-attempt4.e2e.test.ts - the last files claims through the research curator's
#      own writeClaims, so the curator directory is bind-mounted read-only at /curator; (attempt 5)
#      credibility-attempt5.e2e.test.ts - the REAL runResearch / harden() order -> writeClaims (Cases 41-44)
#      - the SQL twin vs the TS model on the same rows - in the test image (the SQL twin of
#      the model, the before/after view, the re-score gate, the fold's move)
#   6. builds openbrain-workbench:wt-<id>; database B (chain + the P0 contract fixtures, the
#      production non-superuser role): runs the workbench integration_test.ts (P0's cases plus
#      P3a's quality(id))
#   7. tears down exactly what it created (containers with -v, so no anonymous volume is left);
#      verifies nothing labelled <Id> is left, no volume of ours is left and no :local image
#      changed
# The network's subnet is pinned outside 192.168.0.0/16 (-Subnet, or a /24 from -SubnetBase).
# It never touches the live stack: no compose up/down, no ai-stack_* / open-brain_* network, no
# host port, no live database, no model, no OpenAlex/Crossref call.
# Exit code 0 = every check passed.
param(
  [string]$Id = 'wt-rw-p3a-entail',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Evidence = '',
  # attempt 2: the disposable network's subnet (empty = a /24 drawn from -SubnetBase)
  [string]$Subnet = '',
  [string]$SubnetBase = '10.241',
  # attempt 5: the compose file the chain is derived from (empty = OB1/docker/docker-compose.yml), and
  # -ChainOnly = run step [1]'s chain checks alone (no docker), exit 0 when they pass
  [string]$ComposeFile = '',
  [switch]$ChainOnly
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
# The network's subnet is PINNED (attempt 2, tester t-rw-p3a near-miss): the daemon's default pool
# runs into 192.168.0.0/20, and a Docker network there once cut the host off its home LAN
# (192.168.1.x). -Subnet names one; otherwise a /24 is drawn from -SubnetBase (default below)
# and retried on an overlap. Anything inside 192.168.0.0/16, any prefix shorter than /16 and the
# tester's lab range 10.234.77.0/24 are refused before docker is asked.
function Test-SubnetAllowed([string]$s) {
  if ($s -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/(\d{1,2})$') { return $false }
  $o = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4]); $len = [int]$Matches[5]
  if (@($o | Where-Object { $_ -gt 255 }).Count -gt 0) { return $false }
  if ($len -lt 16 -or $len -gt 28) { return $false }
  if ($o[0] -eq 192 -and $o[1] -eq 168) { return $false }
  if ($o[0] -eq 10 -and $o[1] -eq 234 -and $o[2] -eq 77) { return $false }
  return $true
}
function New-PinnedNetwork([string]$name) {
  if ($SubnetBase -notmatch '^(\d{1,3})\.(\d{1,3})$' -or $SubnetBase -match '^192\.168$') { Fail "refusing -SubnetBase '$SubnetBase'"; return '' }
  $cands = if ($Subnet) { @($Subnet) } else { @(1..8 | ForEach-Object { "$SubnetBase.$(Get-Random -Minimum 1 -Maximum 255).0/24" }) }
  foreach ($s in $cands) {
    if (-not (Test-SubnetAllowed $s)) { Fail "refusing subnet '$s' (inside 192.168.0.0/16, the lab range, or malformed)"; return '' }
    $null = Dk network create --internal --subnet $s --label $label $name
    if ($script:rc -eq 0) { return $s }
  }
  return ''
}
# Step [1]'s chain: every `<file>.sql:/docker-entrypoint-initdb.d/<NNN-name>.sql` mount of the compose file.
function Get-Chain {
  $cf = if ($ComposeFile) { $ComposeFile } else { Join-Path $dockerDir 'docker-compose.yml' }
  $compose = Get-Content -Raw $cf
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  return , @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
}
# attempt 5 (tester observation): initdb runs the mounted files in the order of their NAMES (the slot
# number first), not in the order the compose file lists them - so the order check compares SLOTS: the
# file initdb runs as 240-init-references.sql must sort before 245-init-research-credibility.sql
# (ordinal, as initdb's sort), whichever compose line comes first. A compose that mounts the
# credibility migration in another slot (235) fails the 'mounts 245' check, loudly.
function Test-Chain($chain) {
  Check ($chain.Count -ge 30) "staged $($chain.Count) migrations"
  Check (@($chain | Where-Object { $_[1] -eq '245-init-research-credibility.sql' }).Count -eq 1) 'the chain mounts 245-init-research-credibility.sql'
  $names = @($chain | ForEach-Object { $_[1] })
  [Array]::Sort($names, [StringComparer]::Ordinal)
  $iRef = [array]::IndexOf($names, '240-init-references.sql')
  $iCred = [array]::IndexOf($names, '245-init-research-credibility.sql')
  Check (($iRef -ge 0) -and ($iCred -gt $iRef)) "initdb runs 240-init-references.sql before 245-init-research-credibility.sql (by slot: run order $iRef < $iCred)"
}
if ($ChainOnly) {
  Write-Host '[1] the initdb chain only (-ChainOnly)'
  Test-Chain (Get-Chain)
  Write-Host "== $(if ($script:fail) { "FAILED ($script:fail)" } else { 'ALL PASSED' })"
  exit $script:fail
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
  Check ($logs -match '245-init-research-credibility\.sql') "$name ran 245-init-research-credibility.sql"
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
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = Get-Chain
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Test-Chain $chain
  $null = Dk image inspect $PgImage
  if ($script:rc -ne 0) { Fail "$PgImage is not on the host"; throw 'pg image' }

  Write-Host '[2] disposable internal network'
  $sub = New-PinnedNetwork $net
  Check ($sub -ne '') "network $net created (internal, labelled, --subnet $sub)"
  if ($sub -eq '') { throw 'network' }
  $made.net = $true
  $got = (Dk network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' $net).Trim()
  Check (($got -eq $sub) -and (Test-SubnetAllowed $got)) "the network's subnet is the pinned one, outside 192.168.0.0/16 ($got)"

  Write-Host "[3] build $rsTag (the build runs the test suite) and its test stage"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  # --no-cache: a cached test layer is a suite that passed on SOME earlier build of the same
  # inputs, and prints no summary - this run must show the suite running.
  $o = Dk build --no-cache --progress=plain --build-arg "OB1_SHA=$sha" --label $label -t $rsTag $rs
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
  $o = Dk build --no-cache --progress=plain --label $label -t $negTag $negCtx
  Save 'gate-negative-build.log' $o
  $negRc = $script:rc
  Check ($negRc -ne 0 -and $o -match 'gate negative control') "a failing test fails the image build (rc=$negRc)"
  if ($negRc -eq 0) { $made.images += $negTag }

  Write-Host '[5] database A + credibility.e2e.test.ts + credibility-twins.e2e.test.ts + credibility-attempt4.e2e.test.ts + credibility-attempt5.e2e.test.ts (SQL twin, twins on one table, the filed-line sweep, before/after, gate, fold)'
  # attempt 4: the line-tag -> edge rule has one source (research-curator/claim-edges.ts); this service's copy must be identical
  $curatorDir = Join-Path (Split-Path -Parent $rs) 'research-curator'
  $edgesA = ([System.IO.File]::ReadAllText((Join-Path $curatorDir 'claim-edges.ts'))) -replace "`r`n", "`n"
  $edgesB = ([System.IO.File]::ReadAllText((Join-Path $rs 'claim-edges.ts'))) -replace "`r`n", "`n"
  Check ($edgesA -ceq $edgesB) 'claim-edges.ts is identical in research-curator and research-service (one tag -> edge rule)'
  if (-not (Start-Db $dbA $false)) { throw 'db A' }
  $o = Dk run --rm --label $label --network $net -e "CRED_E2E_DB_HOST=$dbA" -e "CRED_E2E_DB_PASSWORD=$pw" `
    --mount "type=bind,src=$curatorDir,dst=/curator,readonly" -e CURATOR_DIR=/curator `
    $rsTestTag deno test --allow-net --allow-env --allow-read credibility.e2e.test.ts credibility-twins.e2e.test.ts credibility-attempt4.e2e.test.ts credibility-attempt5.e2e.test.ts
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
  # -v (attempt 2, tester near-miss): a container's ANONYMOUS volumes go with it - attempt 1 left
  # both Postgres data volumes behind. Each container's volumes are recorded first, so the check
  # below is about OURS (other sessions' runs on this host create and orphan volumes concurrently).
  $ourVolumes = @()
  foreach ($c in $made.containers) {
    # no double quotes in the template (Windows PowerShell 5.1 strips them from a native argument)
    $mounts = Dk inspect -f '{{range .Mounts}}{{.Type}}={{.Name}} {{end}}' $c
    if ($script:rc -eq 0) {
      $ourVolumes += @(($mounts -split '\s+') | Where-Object { $_ -match '^volume=[A-Za-z0-9][A-Za-z0-9_.-]+$' } | ForEach-Object { $_.Substring(7) })
    }
    $null = Dk rm -f -v $c
  }
  if ($made.net) { $null = Dk network rm $net }
  foreach ($i in $made.images) { $null = Dk rmi -f $i }
  Remove-Item -Recurse -Force $stage, $negCtx -ErrorAction SilentlyContinue
  $left = @((Dk ps -a --filter "label=$label" --format '{{.Names}}') -split "`n" | Where-Object { $_ })
  Check ($left.Count -eq 0) "no container labelled $label is left ($($left.Count))"
  $leftNet = @((Dk network ls --filter "label=$label" --format '{{.Name}}') -split "`n" | Where-Object { $_ })
  Check ($leftNet.Count -eq 0) "no network labelled $label is left ($($leftNet.Count))"
  $volLeft = @($ourVolumes | Where-Object { $null = Dk volume inspect $_; $script:rc -eq 0 })
  Check (($made.containers.Count -eq 0 -or $ourVolumes.Count -gt 0) -and ($volLeft.Count -eq 0)) "no volume of ours is left ($($ourVolumes.Count) recorded, $($volLeft.Count) left: '$($volLeft -join ' ')')"
  $localAfter = LocalSnapshot
  Check ((Compare-Object $localBefore $localAfter) -eq $null) 'no :local image changed'
  Write-Host "== $(if ($script:fail) { "FAILED ($script:fail)" } else { 'ALL PASSED' })  evidence: $Evidence"
}
exit $script:fail
