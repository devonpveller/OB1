# run-idea-schedule-tests.ps1 - the disposable lab run for research-workbench rw-idea-schedule.
#
#   powershell -NoProfile -File OB1\docker\idea-schedule-test\run-idea-schedule-tests.ps1 -Subnet <x.y.z.0/24> [-Evidence <dir>] [-Red]
#
# One pgvector database on one --internal bridge network (pinned /25 outside the LAN and Docker's
# default pools, harness-subnet.ps1), no published port, no bind to the live stack, label
# ai-stack.harness.owner=<Id>; the REAL initdb chain from docker-compose.yml is staged and each
# case file (c*.sql) runs as one psql transaction that raises on a failed check and rolls back.
# -Red stages the chain WITHOUT slot 300 (the development pin's schema): every clause must FAIL
# there (c1's first block is the regression guard and passes on both). Everything created is
# removed at the end (container with -v, the network); nothing is built, no image is tagged.
param(
  [string]$Id = 'wt-rw-idea-schedule',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [switch]$Red
)
$ErrorActionPreference = 'Continue'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'workbench\contract-test\harness-subnet.ps1')
$w = Test-HarnessSubnet $Subnet
if ($w) { Write-Host "REFUSED: $w"; exit 2 }
$subnets = Split-HarnessSubnet $Subnet
if ($Evidence -and (Test-Path $Evidence) -and @(Get-ChildItem -Force $Evidence).Count) { Write-Host "REFUSED: -Evidence $Evidence is not empty"; exit 2 }
if ($Evidence) { New-Item -ItemType Directory -Force $Evidence | Out-Null }
$dockerDir = Split-Path -Parent $PSScriptRoot
$label = "ai-stack.harness.owner=$Id"
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rwis-$rand-net"; $db = "rwis-$rand-db"
$stage = Join-Path $env:TEMP "rwis-$rand-initdb"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$pass = 0; $fail = 0
function Say([string]$t) { Write-Host $t; if ($Evidence) { Add-Content -Path (Join-Path $Evidence 'run.log') -Value $t } }

try {
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $n = 0
  foreach ($m in $rx.Matches($compose)) {
    if ($Red -and $m.Groups[2].Value -eq '300-init-idea-schedule.sql') { continue }
    Copy-Item (Join-Path $dockerDir $m.Groups[1].Value) (Join-Path $stage $m.Groups[2].Value); $n++
  }
  Say "chain: $n migrations staged$(if ($Red) { ' (RED: without slot 300)' })"
  $null = docker network create --driver bridge --internal --subnet $subnets.run --label $label $net
  $null = docker run -d --name $db --label $label --network $net -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=openbrain -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
  for ($i = 0; $i -lt 150; $i++) { if ((docker logs $db 2>&1 | Out-String) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = docker exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds 2 }
  $errs = @((docker logs $db 2>&1 | Out-String) -split "`n" | Where-Object { $_ -match 'ERROR:' })
  Say "initdb ERROR lines: $($errs.Count)"
  if ($Evidence -and $errs.Count) { $errs | Set-Content (Join-Path $Evidence 'initdb-errors.log') }
  $null = docker cp $PSScriptRoot "${db}:/t"
  foreach ($f in (Get-ChildItem $PSScriptRoot -Filter 'c*.sql' | Sort-Object Name)) {
    $out = docker exec -w /t $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f $f.Name 2>&1 | Out-String
    $ok = ($LASTEXITCODE -eq 0)
    if ($ok) { $pass++ } else { $fail++ }
    Say ("{0}  {1}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $f.Name)
    $first = (($out -split "`n") | Where-Object { $_ -match 'ERROR:|CHECK FAILED' } | Select-Object -First 1)
    if ($first) { Say "      $($first.Trim())" }
    if ($Evidence) { Set-Content -Path (Join-Path $Evidence ($f.BaseName + '.out')) -Value $out }
  }
  Say "RESULT: $pass passed, $fail failed$(if ($Red) { ' (RED: failures expected)' })"
} finally {
  $null = docker rm -f -v $db 2>&1
  $null = docker network rm $net 2>&1
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  $left = @(docker ps -a --filter "label=$label" -q) + @(docker network ls --filter "label=$label" -q) + @(docker volume ls --filter "label=$label" -q)
  Say "leftovers labelled ${Id}: $($left.Count)"
}
if ($Red) { exit 0 }
if ($fail) { exit 1 } else { exit 0 }
