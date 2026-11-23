# check-ui-state-deploy.ps1 - the deploy check of rwr-ui-state-keys (slot 490). READ-ONLY.
#
#   powershell -NoProfile -File OB1\docker\workbench\check-ui-state-deploy.ps1 [-DbContainer openbrain-db]
#
# Runs check-ui-state.sql (function results and catalog only; it reads no user_settings row and prints no setting
# value) in the database container and prints OK, or DRIFT with one line per finding, then exits non-zero on DRIFT:
#   * setting_problem('x','library.recent','[]') is NULL (slot 490's ref_list rule is in force);
#   * user_setting_set's definition contains pg_advisory_xact_lock;
#   * user_setting_tombstones and user_setting_clear exist.
# A re-run of slot 400 after 490 (or revert-ui-state.sql) shows as DRIFT: re-run init-ui-state.sql.
param(
  [string]$DbContainer = 'openbrain-db'
)
$ErrorActionPreference = 'Stop'
$sqlFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'check-ui-state.sql'
$sqlText = [System.IO.File]::ReadAllText($sqlFile)
$out = $sqlText | & docker exec -i $DbContainer psql -X -A -t -q -v ON_ERROR_STOP=1 -U postgres -d openbrain 2>&1
$rc = $LASTEXITCODE
$lines = @(($out | Out-String) -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^(check|drift):' })
foreach ($l in $lines) { Write-Host $l }
if ($rc -eq 0 -and ($out | Out-String) -match '(?m)^OK\s*$' -and -not ($lines | Where-Object { $_ -like 'drift:*' })) {
  Write-Host 'OK'
  exit 0
}
if ($rc -ne 0) { Write-Host "the catalog check did not run (exit $rc)" }
Write-Host 'DRIFT'
exit 1
