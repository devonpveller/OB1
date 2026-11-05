# rest-door-lab.ps1 - the REST door as the contract-test labs stand it up (rw-rest-door-auth, slot 450).
# Dot-sourced by a lab AFTER its Run-Detached / Dk helpers and $P, $net, $label, $dockerDir, $PgrstImage, $CaddyImage
# exist. Start-LabRestDoor starts PostgREST (alias openbrain-postgrest) and the Caddy door (alias openbrain-rest)
# configured the way the tree's compose configures them:
#   * the lab database has slot 450 (ob_rest_authenticator exists): a lab env file gets a fresh lab secret, the
#     authenticator password and the per-caller tokens from the REAL mint script (rest-door/mint-rest-tokens.ps1,
#     values never printed), the password is set in the lab database, and PostgREST logs in as the authenticator
#     with the JWT secret and audience and NO anonymous role;
#   * it has not (a -Red run on a base chain): the base posture - PostgREST as postgres, anon = service_role.
# Returns @{ Door = 'auth'|'legacy'; Tokens = @{ WIKI=..; VIEWER=..; ... }; Secret = <lab secret> }.
# Start-LabLegacyPostgrest starts a second, lab-only PostgREST in the old posture (anon = service_role) under its
# own name - for checks about PostgREST itself (e.g. [5n]'s schema-cache reload), never as the door.

$script:LegacyCaddyfile = @'
# the REST door before rw-rest-door-auth (lab only): credentials stripped, PostgREST's anon role serves everything
:80 {
	handle_path /rest/v1/* {
		reverse_proxy UPSTREAM {
			header_up -Authorization
			header_up -apikey
		}
	}
	respond /healthz 200
	respond "open-brain REST proxy" 200
}
'@
function Write-LabLegacyCaddyfile([string]$Upstream) {
  $cf = Join-Path $env:TEMP "$P-legacy-caddy-$(($Upstream -replace '[^a-z0-9]', ''))"
  New-Item -ItemType Directory -Force $cf | Out-Null
  $script:made.dirs += $cf
  [System.IO.File]::WriteAllText((Join-Path $cf 'Caddyfile'), ($script:LegacyCaddyfile -replace 'UPSTREAM', $Upstream) + "`n", (New-Object System.Text.UTF8Encoding $false))
  return (Join-Path $cf 'Caddyfile')
}

function Start-LabRestDoor([string]$Db, [string]$Pw, [string]$Sub = 'lab-operator', [string]$CaddyFile = '', [switch]$Legacy) {
  if (-not $CaddyFile) { $CaddyFile = if ($Legacy) { Write-LabLegacyCaddyfile 'openbrain-postgrest:3000' } else { Join-Path $dockerDir 'Caddyfile' } }
  $mint = Join-Path $dockerDir 'rest-door/mint-rest-tokens.ps1'
  $has = ((Dk exec $Db psql -U postgres -d openbrain -X -tA -c "SELECT count(*) FROM pg_roles WHERE rolname = 'ob_rest_authenticator'") -replace '\s', '')
  $res = @{ Door = 'legacy'; Tokens = @{}; Secret = '' }
  if ($has -eq '1' -and (Test-Path $mint) -and -not $Legacy) {
    $envDir = Join-Path $env:TEMP "$P-restdoor"
    New-Item -ItemType Directory -Force $envDir | Out-Null
    $script:made.dirs += $envDir
    $envFile = Join-Path $envDir 'lab.env'
    [System.IO.File]::WriteAllText($envFile, "WORKSPACE_DEFAULT_SUB=$Sub`nOB_REST_JWT_SECRET=`nOB_REST_AUTHENTICATOR_PASSWORD=`n", (New-Object System.Text.UTF8Encoding $false))
    $o = & powershell -NoProfile -ExecutionPolicy Bypass -File $mint -EnvFile $envFile -Generate -SetAuthenticatorPassword -Container $Db 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { Fail "rest door: the mint script failed: $o"; return $res }
    $vals = @{}
    foreach ($l in [System.IO.File]::ReadAllLines($envFile)) { if ($l -match '^([A-Z0-9_]+)=(.*)$') { $vals[$Matches[1]] = $Matches[2] } }
    foreach ($k in @($vals.Keys | Where-Object { $_ -like 'OB_REST_TOKEN_*' })) { $res.Tokens[$k.Substring(14)] = $vals[$k] }
    $res.Secret = $vals['OB_REST_JWT_SECRET']; $res.Door = 'auth'
    $null = Run-Detached "$P-postgrest" @('--network-alias', 'openbrain-postgrest',
      '-e', "PGRST_DB_URI=postgres://ob_rest_authenticator:$($vals['OB_REST_AUTHENTICATOR_PASSWORD'])@openbrain-db:5432/openbrain",
      '-e', 'PGRST_DB_SCHEMAS=public', '-e', "PGRST_JWT_SECRET=$($res.Secret)", '-e', 'PGRST_JWT_AUD=openbrain-rest',
      '-e', 'PGRST_DB_POOL=4', '-e', 'PGRST_SERVER_PORT=3000', $PgrstImage)
  } else {
    $null = Run-Detached "$P-postgrest" @('--network-alias', 'openbrain-postgrest', '-e', "PGRST_DB_URI=postgres://postgres:$Pw@openbrain-db:5432/openbrain",
      '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=service_role', '-e', 'PGRST_DB_POOL=4', '-e', 'PGRST_SERVER_PORT=3000', $PgrstImage)
  }
  $null = Run-Detached "$P-rest" @('--network-alias', 'openbrain-rest', '-v', "${CaddyFile}:/etc/caddy/Caddyfile:ro", $CaddyImage)
  return $res
}

function Start-LabLegacyPostgrest([string]$Pw) {
  $null = Run-Detached "$P-pgrst-legacy" @('-e', "PGRST_DB_URI=postgres://postgres:$Pw@openbrain-db:5432/openbrain",
    '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=service_role', '-e', 'PGRST_DB_POOL=2', '-e', 'PGRST_SERVER_PORT=3000', $PgrstImage)
  return "http://$P-pgrst-legacy:3000"
}

# A lab-only door in the OLD posture beside the real one: PostgREST as postgres with anon = service_role behind a
# Caddyfile that strips credentials (the old one, $script:LegacyCaddyfile). For checks that are about PostgREST itself or about a
# base writer that sends no token - never the door the stack's callers use. Returns its /rest/v1 base URL's host.
function Start-LabLegacyDoor([string]$Pw) {
  $null = Start-LabLegacyPostgrest $Pw
  $cf = Write-LabLegacyCaddyfile "$P-pgrst-legacy:3000"
  $null = Run-Detached "$P-rest-legacy" @('-v', "${cf}:/etc/caddy/Caddyfile:ro", $CaddyImage)
  return "http://$P-rest-legacy"
}

# An HS256 token for the lab (same shape as the mint script's): a role, the audience, an optional sub.
function New-LabRestToken([string]$Secret, [string]$Role, [string]$Sub = '') {
  $enc = New-Object System.Text.UTF8Encoding $false
  $b64 = { param([byte[]]$b) [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
  $claims = '{"role":"' + $Role + '","aud":"openbrain-rest"' + $(if ($Sub) { ',"sub":"' + $Sub + '"' } else { '' }) + '}'
  $h = & $b64 ($enc.GetBytes('{"alg":"HS256","typ":"JWT"}')); $p = & $b64 ($enc.GetBytes($claims))
  $hmac = New-Object System.Security.Cryptography.HMACSHA256 (, $enc.GetBytes($Secret))
  try { $sig = & $b64 ($hmac.ComputeHash($enc.GetBytes("$h.$p"))) } finally { $hmac.Dispose() }
  return "$h.$p.$sig"
}
