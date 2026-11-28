# run-research-sources-perf.ps1 - rwr-research-sources: time the claim formulas on a DISPOSABLE database, per OB1 tree.
#
# For each -Ref (an OB1 commit; "WORKTREE" = this checkout's files as they are) it exports that tree's docker/ dir,
# stages its compose initdb chain (every `<file>.sql:/docker-entrypoint-initdb.d/<NNN-name>.sql` mount, as
# run-credibility-e2e.ps1 does), starts ONE postgres on an internal labelled network with a pinned subnet outside
# 192.168.0.0/16, runs perf/research-sources-probe.sql with -N claims, prints the PERF lines and removes what it made
# (its own label only). No live database, no host port, no model.
#   .\run-research-sources-perf.ps1 -Ref d8c8c8b6,39de093b,WORKTREE -N 300 -Evidence <dir>
param(
  [string[]]$Ref = @('WORKTREE'),
  [int]$N = 300,
  [string]$Id = 'wt-rwr-research-sources',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Subnet = '10.241.77.0/24',
  [string]$Evidence = ''
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$label = "ai-stack.harness.owner=$Id"
$rs = $PSScriptRoot
$ob1 = Split-Path -Parent (Split-Path -Parent $rs)
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rsperf-net-$rand"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "rsperf-evidence-$rand" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }

$o = Dk network create --internal --subnet $Subnet --label $label $net
if ($script:rc -ne 0) { throw "network: $o" }
$results = @()
try {
  foreach ($r in $Ref) {
    $tree = Join-Path $env:TEMP "rsperf-tree-$rand-$r"
    $stage = Join-Path $env:TEMP "rsperf-stage-$rand-$r"
    New-Item -ItemType Directory -Force $tree, $stage | Out-Null
    if ($r -eq 'WORKTREE') {
      New-Item -ItemType Directory -Force (Join-Path $tree 'docker'), (Join-Path $tree 'integrations\intake\sql') | Out-Null
      Copy-Item (Join-Path $ob1 'docker\*.sql') (Join-Path $tree 'docker')
      Copy-Item (Join-Path $ob1 'docker\docker-compose.yml') (Join-Path $tree 'docker')
      Copy-Item (Join-Path $ob1 'integrations\intake\sql\*.sql') (Join-Path $tree 'integrations\intake\sql')
      $tree = Join-Path $tree 'docker'
    } else {
      $tar = Join-Path $env:TEMP "rsperf-$rand-$r.tar"
      & git -C $ob1 archive --format=tar -o $tar $r docker integrations/intake/sql
      if ($LASTEXITCODE -ne 0) { throw "git archive $r failed" }
      & tar -xf $tar -C $tree
      Remove-Item $tar -Force
      $tree = Join-Path $tree 'docker'
    }
    $compose = (@(Get-Content (Join-Path $tree 'docker-compose.yml')) | ForEach-Object { $_ -replace '(^|\s)#.*$', '' }) -join "`n"
    $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
    $mig = 0
    foreach ($m in $rx.Matches($compose)) {
      $src = Join-Path $tree $m.Groups[1].Value
      if (Test-Path $src) { Copy-Item $src (Join-Path $stage $m.Groups[2].Value); $mig++ }
    }
    $db = "rsperf-db-$rand-" + ($r.ToLower() -replace '[^a-z0-9]', '')
    $o = Dk run -d --name $db --label $label --network $net -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=openbrain -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
    if ($script:rc -ne 0) { throw "postgres $r did not start: $o" }
    for ($i = 0; $i -lt 200; $i++) {
      $logs = Dk logs $db
      if ($logs -match 'PostgreSQL init process complete') { break }
      Start-Sleep -Seconds 2
    }
    for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
    $logs = Dk logs $db
    $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' }).Count
    Set-Content -Path (Join-Path $Evidence "$r-initdb.log") -Value $logs -Encoding utf8
    $null = Dk cp (Join-Path $rs 'perf\research-sources-probe.sql') "${db}:/tmp/probe.sql"
    $out = Dk exec $db psql -U postgres -d openbrain -X -q -v "n=$N" -f /tmp/probe.sql
    Set-Content -Path (Join-Path $Evidence "$r-probe.log") -Value $out -Encoding utf8
    $perf = @(($out -split "`n") | Where-Object { $_ -match 'PERF ' } | ForEach-Object { ($_ -replace '^.*NOTICE:\s*', '').Trim() })
    Write-Host "== $r  (migrations staged: $mig, initdb ERROR lines: $errs)"
    foreach ($p in $perf) { Write-Host "   $p" }
    if (-not $perf.Count) { Write-Host "   probe output:"; Write-Host $out }
    $results += [pscustomobject]@{ ref = $r; staged = $mig; initdb_errors = $errs; perf = $perf }
    $null = Dk rm -f $db
    Remove-Item -Recurse -Force $stage, (Join-Path $env:TEMP "rsperf-tree-$rand-$r") -ErrorAction SilentlyContinue
  }
} finally {
  $ids = Dk ps -aq --filter "label=$label" --filter "name=rsperf-db-$rand"
  if ($ids) { $null = Dk rm -f ($ids -split "`n") }
  $null = Dk network rm $net
}
$results | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $Evidence 'perf.json') -Encoding utf8
Write-Host "evidence: $Evidence"
