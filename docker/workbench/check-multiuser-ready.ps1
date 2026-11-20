# check-multiuser-ready.ps1 - is the workbench ready for a SECOND user? (rw-owner-private-view, decision D4). READ-ONLY.
#
#   powershell -NoProfile -File OB1\docker\workbench\check-multiuser-ready.ps1 [-EnvFile OB1\docker\.env] [-Container openbrain-workbench] [-SkipLive]
#
# While sign-in (Authentik forward-auth) is off, every request through the door is the workbench's ONE default identity,
# and the private views (the owner's email bodies, transcripts, private claims and job text) are served to it. That is
# right for one user and wrong for two. Run this BEFORE anyone else is given access. It reports SET or BLANK only (never
# a value) and FAILS (exit 1) while any of these is blank:
#   WORKSPACE_FORWARD_AUTH_ISSUER, WORKSPACE_FORWARD_AUTH_CLIENT_ID, WORKSPACE_FORWARD_AUTH_CLIENT_SECRET, WORKSPACE_DOOR_KEY
# and, unless -SkipLive, while the running workbench's GET /workbench/auth/me says private_views is not "signed-in"
# (asked from inside the container with its own WORKBENCH_KEY; nothing but that one field is printed).
# It never blocks a deploy, and the deploy pre-check (check-owner-private-view-deploy.ps1) does not run it.
param(
  [string]$EnvFile = (Join-Path (Split-Path -Parent $PSScriptRoot) '.env'),
  [string]$Container = 'openbrain-workbench',
  [switch]$SkipLive
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
foreach ($n in @('WORKSPACE_FORWARD_AUTH_ISSUER', 'WORKSPACE_FORWARD_AUTH_CLIENT_ID', 'WORKSPACE_FORWARD_AUTH_CLIENT_SECRET', 'WORKSPACE_DOOR_KEY')) {
  $set = Test-EnvSet $EnvFile $n
  Write-Host ("env: {0} {1}" -f $n, $(if ($set) { 'SET' } else { 'BLANK' }))
  if (-not $set) { $bad++ }
}
if (-not $SkipLive) {
  $js = "const r = await fetch('http://127.0.0.1:8000/workbench/auth/me', { headers: { 'x-brain-key': Deno.env.get('WORKBENCH_KEY') ?? '' } }); const j = await r.json().catch(() => ({})); console.log('private_views=' + (j.private_views ?? 'unknown'));"
  $out = (& docker exec $Container deno eval $js 2>&1 | Out-String)
  $pv = ([regex]'private_views=([a-z-]+)').Match($out)
  $val = if ($pv.Success) { $pv.Groups[1].Value } else { 'unknown' }
  Write-Host "live: private_views=$val"
  if ($val -ne 'signed-in') { $bad++ }
}
if ($bad) { Write-Host "NOT READY for a second user ($bad)"; exit 1 }
Write-Host 'READY for a second user (sign-in is on; the private views are signed-in only)'
exit 0
