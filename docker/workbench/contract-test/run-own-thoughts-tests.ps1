# run-own-thoughts-tests.ps1 - rwr-own-thoughts-search-api: the own-thoughts search over a REAL Postgres, on a disposable
# INTERNAL network. Planted two-identity data (src/contracts/own_thoughts_integration_test.ts).
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-own-thoughts-tests.ps1 -Subnet <x.y.z.0/24> [-Id <owner id>]
#
# What it does, and ONLY this: one internal network (labelled ai-stack.harness.owner=<Id>), one throwaway pgvector
# container with a thoughts table (the columns this search reads) and a NON-superuser SELECT-only login role (the
# production shape of the workbench's role), the workbench built from the `app` stage as openbrain-workbench:wt-<id>-app
# (never :local), and the integration test run inside it. Teardown removes exactly what it created and checks nothing
# labelled <Id> is left. Never the live stack: no compose, no ai-stack_* / open-brain_* network, no host port, no :local.
param(
  [string]$Id = 'wt-rwr-own-thoughts',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Subnet = '',
  [switch]$KeepImages
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
. (Join-Path $PSScriptRoot 'harness-subnet.ps1')
$w = Test-HarnessSubnet $Subnet
if ($w) { Write-Host "REFUSED: $w"; exit 2 }
$sn = Split-HarnessSubnet $Subnet
$label = "ai-stack.harness.owner=$Id"
$wb = Split-Path -Parent $PSScriptRoot
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rwown-net-$rand"; $db = "rwown-db-$rand"; $runner = "rwown-run-$rand"
$short = ($Id -replace '^wt-', '')
$tag = "openbrain-workbench:wt-$short-app"
if ($tag -match ':local$') { throw 'refusing a :local tag' }
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$script:fail = 0
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }
function Check([bool]$ok, [string]$m) { if ($ok) { Write-Host "  PASS  $m" } else { Write-Host "  FAIL  $m"; $script:fail++ } }
$localBefore = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim()
try {
  $null = Dk network create --internal --subnet $sn.run --label $label $net
  Check ($script:rc -eq 0) "internal network $net ($($sn.run))"
  $o = Dk build --target app --build-arg "OB1_SHA=$((git -C $wb rev-parse HEAD) 2>$null)" -t $tag $wb
  Check ($script:rc -eq 0) "built $tag (app stage)"
  $null = Dk run -d --name $db --network $net --label $label -e "POSTGRES_PASSWORD=$pw" $PgImage
  Check ($script:rc -eq 0) 'throwaway database started'
  $ready = $false
  for ($i = 0; $i -lt 40 -and -not $ready; $i++) {
    Start-Sleep -Seconds 2
    $null = Dk exec $db pg_isready -U postgres
    if ($script:rc -eq 0) { $null = Dk exec $db psql -U postgres -tAc 'select 1'; $ready = ($script:rc -eq 0) }
  }
  Check $ready 'database ready (bounded wait)'
  $sql = @"
CREATE DATABASE openbrain;
"@
  $null = Dk exec $db psql -U postgres -v ON_ERROR_STOP=1 -c $sql
  $sql2 = @"
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE public.thoughts (id BIGSERIAL PRIMARY KEY, content TEXT NOT NULL, embedding vector(1024), metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ, user_id TEXT);
CREATE ROLE ob_probe_app LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS;
GRANT SELECT ON public.thoughts TO ob_probe_app;
"@
  $null = Dk exec $db psql -U postgres -d openbrain -v ON_ERROR_STOP=1 -c $sql2
  Check ($script:rc -eq 0) 'thoughts table and the SELECT-only login role created'
  $out = Dk run --rm --name $runner --network $net --label $label -e "OWN_THOUGHTS_DB_HOST=$db" -e "OWN_THOUGHTS_SU_PW=$pw" -e "OWN_THOUGHTS_APP_PW=$appPw" `
    $tag deno test --allow-all src/contracts/own_thoughts_integration_test.ts
  $clean = ($out -replace '\x1b\[[0-9;]*m', '')
  Write-Host ($clean -split "`n" | Where-Object { $_ -match '\.\.\. |passed|failed|error' } | Out-String)
  Check ($script:rc -eq 0 -and $clean -match '1 passed \| 0 failed') 'integration test: 1 passed, 0 failed (not skipped)'
  Check ($clean -notmatch 'ignored') 'the test was not skipped'
  foreach ($m in @('PLANTED-A-', 'PLANTED-B-')) { Check ($clean -notmatch [regex]::Escape($m)) "a planted marker ($m...) is not in the run's output" }
} finally {
  $null = Dk rm -f $runner; $null = Dk rm -f -v $db; $null = Dk network rm $net
  if (-not $KeepImages) { $null = Dk rmi $tag }
  $left = (Dk ps -a -q --filter "label=$label" | Out-String).Trim()
  $nets = (Dk network ls -q --filter "label=$label" | Out-String).Trim()
  Check (-not $left -and -not $nets) 'nothing labelled for this run is left (containers, networks)'
  Check (((Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim()) -eq $localBefore) 'no :local image changed'
}
if ($script:fail) { Write-Host "FAILED: $script:fail"; exit 1 }
Write-Host 'ALL PASS'
exit 0
