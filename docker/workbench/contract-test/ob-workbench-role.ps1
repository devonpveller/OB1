# ob-workbench-role.ps1 - rw-owner-private-view (slot 480): the lab workbench logs in as ob_workbench, its own role, as
# compose does. Dot-sourced by the lab runners right after they create ob_app_memory; uses the runner's Dk, Check, $db and
# $dockerDir. initdb ran 480 before ob_app_memory existed (no membership yet - the fresh-volume shape), so 480 runs again
# (the deploy notes' rule), and the lab sets a generated password (out of band on live). A chain without slot 480 keeps
# ob_app_memory. Returns @{ role; pw }.
function Use-ObWorkbenchRole([string]$appPw) {
  $has = ((Dk exec $db psql -U postgres -d openbrain -X -A -t -c "SELECT to_regrole('ob_workbench') IS NOT NULL") | Out-String).Trim()
  if ($has -ne 't') { return @{ role = 'ob_app_memory'; pw = $appPw } }
  $wbPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
  $null = Dk cp (Join-Path $dockerDir 'init-owner-private-view.sql') "${db}:/tmp/i480.sql"
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/i480.sql
  $rc1 = $script:rc
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "ALTER ROLE ob_workbench PASSWORD '$wbPw'"
  $mem = ((Dk exec $db psql -U postgres -d openbrain -X -A -t -c "SELECT pg_has_role('ob_workbench', 'ob_app_memory', 'MEMBER')") | Out-String).Trim()
  Check ($rc1 -eq 0 -and $mem -eq 't') "[480] run again after ob_app_memory exists: the workbench logs in as ob_workbench, a member of ob_app_memory ($mem)"
  return @{ role = 'ob_workbench'; pw = $wbPw }
}
