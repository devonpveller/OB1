# check-owner-private-view-deploy.ps1 - the deploy pre-check of rw-owner-private-view (slot 480). READ-ONLY.
#
#   powershell -NoProfile -File OB1\docker\workbench\check-owner-private-view-deploy.ps1 [-EnvFile OB1\docker\.env] [-DbContainer openbrain-db] [-SkipDb]
#
# It reports SET or BLANK for each variable (never a value), then runs check-owner-private-view.sql (catalog only: it
# reads no table row and prints function signatures and role names only) in the database container, and exits
# non-zero when anything is missing:
#   * OB_WORKBENCH_EMBED_LLM_KEY is set (the private semantic search's own key; the workbench-embed key must exist in
#     the LiteLLM UI - not checkable from here);
#   * OB_WORKBENCH_DB_PASSWORD is set (ob_workbench's password; set on the database out of band);
#   * slot 440 is applied; the ob_workbench role exists (slot 480 ran) and is a member of ob_app_memory;
#   * the five owner_private_* reads exist and ob_workbench can EXECUTE them; no OTHER role (PUBLIC included) can run them or
#     PD1's two reads (a "stray grant" line);
#   * no drift: no public.inlet_private_* / owner_private_* function is executable by ob_app_memory (a 440 re-run after
#     480 grants PD1's two reads back to it: re-run 480).
# The multi-user readiness check (check-multiuser-ready.ps1) is a SEPARATE script and is not run here.
param(
  [string]$EnvFile = (Join-Path (Split-Path -Parent $PSScriptRoot) '.env'),
  [string]$DbContainer = 'openbrain-db',
  [switch]$SkipDb
)
$ErrorActionPreference = 'Stop'
$bad = 0
function Test-EnvSet([string]$file, [string]$name) {
  if (-not (Test-Path -LiteralPath $file)) { return $false }
  foreach ($line in [System.IO.File]::ReadAllLines($file)) {
    if ($line -match ('^\s*' + [regex]::Escape($name) + '\s*=\s*(.*)$')) {
      $v = $Matches[1].Trim()
      if ($v -match '^"(.*)"$' -or $v -match "^'(.*)'$") { $v = $Matches[1] }
      return ($v.Length -gt 0)
    }
  }
  return $false
}
Write-Host "env file: $(if (Test-Path -LiteralPath $EnvFile) { 'present' } else { 'MISSING' })"
foreach ($n in @('OB_WORKBENCH_EMBED_LLM_KEY', 'OB_WORKBENCH_DB_PASSWORD')) {
  $set = Test-EnvSet $EnvFile $n
  Write-Host ("env: {0} {1}" -f $n, $(if ($set) { 'SET' } else { 'BLANK' }))
  if (-not $set) { $bad++ }
}
if (-not $SkipDb) {
  $sqlFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'check-owner-private-view.sql'
  $sqlText = [System.IO.File]::ReadAllText($sqlFile)
  $out = $sqlText | & docker exec -i $DbContainer psql -X -A -t -q -v ON_ERROR_STOP=1 -U postgres -d openbrain 2>&1
  $rc = $LASTEXITCODE
  $lines = @(($out | Out-String) -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^(check|drift):' })
  foreach ($l in $lines) { Write-Host "db: $l" }
  if ($rc -ne 0 -or -not ($lines | Where-Object { $_ -eq 'check: OK' })) { $bad++ }
  if ($rc -ne 0) { Write-Host "db: the catalog check did not run (exit $rc)" }
}
if ($bad) { Write-Host "PRE-CHECK FAILED ($bad)"; exit 1 }
Write-Host 'PRE-CHECK OK'
exit 0
