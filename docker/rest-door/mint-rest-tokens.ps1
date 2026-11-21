# mint-rest-tokens.ps1 - the REST door's secrets and per-caller tokens (rw-rest-door-auth, slot 450).
#
# Writes into ONE env file (OB1/docker/.env, the plane whose services read them) and prints NAMES and roles only,
# never a value:
#   -Generate                  fill OB_REST_JWT_SECRET and OB_REST_AUTHENTICATOR_PASSWORD when blank (never
#                              overwrites a set value - rotation is the key-rotation map's job), then mint
#   (default)                  mint OB_REST_TOKEN_<CALLER> from the secret already in the file
#   -Import                    also mint OB_REST_TOKEN_IMPORT (role ob_rest_import: the host import CLIs; slot 470).
#                              Its sub is the import's owner (-ImportOwner <subject>, default WORKSPACE_DEFAULT_SUB):
#                              slot 470's guard lets a door caller write only rows owned by its verified sub
#   -SetAuthenticatorPassword  set ob_rest_authenticator's password in the database from the file's value, piped
#                              to psql on stdin inside -Container (never on a command line, never echoed)
# Tokens are HS256 JWTs: {role: ob_rest_<caller>, aud: openbrain-rest, caller: <caller>} - the digest's and the
# podcast's also carry sub = WORKSPACE_DEFAULT_SUB (read from the same file): the owner whose settings they read (it
# must be the subject slot 470 recorded for the gmail connection - the deploy's step 2 checks); the import's carries
# the import's owner.
# No exp: a token lives until the secret is rotated. Deterministic: minting twice gives the same tokens.
#
#   powershell -NoProfile -File mint-rest-tokens.ps1 -EnvFile ..\.env -Generate
#   powershell -NoProfile -File mint-rest-tokens.ps1 -EnvFile ..\.env -SetAuthenticatorPassword -Container openbrain-db
[CmdletBinding()]
param(
  [string]$EnvFile = (Join-Path (Split-Path -Parent $PSScriptRoot) '.env'),
  [switch]$Generate,
  [switch]$SetAuthenticatorPassword,
  [string]$Container = 'openbrain-db',
  [switch]$NoMint,
  [switch]$Import,
  # the subject an import token writes for (rw-rest-door-auth round 6, rw-inlet-stamp F6); blank = WORKSPACE_DEFAULT_SUB
  [string]$ImportOwner = ''
)
$ErrorActionPreference = 'Stop'

# caller -> role; WithSub = the token names the run owner
$Callers = @(
  @{ Key = 'OB_REST_TOKEN_WIKI';        Role = 'ob_rest_wiki';        Caller = 'wiki';        WithSub = $false },
  @{ Key = 'OB_REST_TOKEN_VIEWER';      Role = 'ob_rest_viewer';      Caller = 'viewer';      WithSub = $false },
  @{ Key = 'OB_REST_TOKEN_ENTITY';      Role = 'ob_rest_entity';      Caller = 'entity';      WithSub = $false },
  @{ Key = 'OB_REST_TOKEN_DIGEST';      Role = 'ob_rest_digest';      Caller = 'digest';      WithSub = $true },
  @{ Key = 'OB_REST_TOKEN_PODCAST';     Role = 'ob_rest_podcast';     Caller = 'podcast';     WithSub = $true },
  @{ Key = 'OB_REST_TOKEN_GMAIL_PULL';  Role = 'ob_rest_gmail_pull';  Caller = 'gmail_pull';  WithSub = $false },
  @{ Key = 'OB_REST_TOKEN_GMAIL_PRUNE'; Role = 'ob_rest_gmail_prune'; Caller = 'gmail_prune'; WithSub = $false },
  # the host import CLIs (rw-inlet-stamp, slot 470): minted only with -Import, when an import is to be run
  @{ Key = 'OB_REST_TOKEN_IMPORT';      Role = 'ob_rest_import';      Caller = 'import';      WithSub = $true; OnlyWith = 'Import'; SubFrom = 'ImportOwner' }
)

if (-not (Test-Path -LiteralPath $EnvFile)) { throw "no env file at $EnvFile (copy .env.example first)" }
$raw = [System.IO.File]::ReadAllText($EnvFile)
$nl = if ($raw -match "`r`n") { "`r`n" } else { "`n" }
$lines = New-Object System.Collections.Generic.List[string]
foreach ($l in ($raw -split "`r?`n")) { $lines.Add($l) }
if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }

function Get-Val([string]$k) {
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i] -match ('^\s*' + [regex]::Escape($k) + '=(.*)$')) { return $Matches[1].Trim().Trim('"').Trim("'") }
  }
  return ''
}
function Set-Val([string]$k, [string]$v) {
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match ('^\s*' + [regex]::Escape($k) + '=')) { $lines[$i] = "$k=$v"; return }
  }
  $lines.Add("$k=$v")
}
function New-Hex([int]$bytes) {
  $b = New-Object byte[] $bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($b) } finally { $rng.Dispose() }
  return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}
function B64Url([byte[]]$b) { return [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
function JsonStr([string]$s) {
  $o = New-Object System.Text.StringBuilder
  foreach ($c in $s.ToCharArray()) {
    $n = [int]$c
    if ($c -eq '"') { [void]$o.Append('\"') } elseif ($c -eq '\') { [void]$o.Append('\\') }
    elseif ($n -lt 0x20 -or $n -gt 0x7e) { [void]$o.Append(('\u{0:x4}' -f $n)) } else { [void]$o.Append($c) }
  }
  return '"' + $o.ToString() + '"'
}
function New-Jwt([string]$secret, [System.Collections.Specialized.OrderedDictionary]$claims) {
  $enc = New-Object System.Text.UTF8Encoding $false
  $h = B64Url ($enc.GetBytes('{"alg":"HS256","typ":"JWT"}'))
  $parts = @(); foreach ($k in $claims.Keys) { $parts += ((JsonStr $k) + ':' + (JsonStr ([string]$claims[$k]))) }
  $p = B64Url ($enc.GetBytes('{' + ($parts -join ',') + '}'))
  $hmac = New-Object System.Security.Cryptography.HMACSHA256 (, $enc.GetBytes($secret))
  try { $sig = B64Url ($hmac.ComputeHash($enc.GetBytes("$h.$p"))) } finally { $hmac.Dispose() }
  return "$h.$p.$sig"
}

$changed = @()
if ($Generate) {
  if (-not (Get-Val 'OB_REST_JWT_SECRET')) { Set-Val 'OB_REST_JWT_SECRET' (New-Hex 32); $changed += 'OB_REST_JWT_SECRET (generated)' }
  if (-not (Get-Val 'OB_REST_AUTHENTICATOR_PASSWORD')) { Set-Val 'OB_REST_AUTHENTICATOR_PASSWORD' (New-Hex 24); $changed += 'OB_REST_AUTHENTICATOR_PASSWORD (generated)' }
}

if (-not $NoMint) {
  $secret = Get-Val 'OB_REST_JWT_SECRET'
  if ($secret.Length -lt 32) { throw 'OB_REST_JWT_SECRET is blank or shorter than 32 characters (run with -Generate)' }
  # PostgREST reads `sub` as a JWT StringOrURI: a value with ':' must be a valid absolute URI, or EVERY request with
  # the token is refused (401), not only the settings read. A service-shaped sub ('service:...', any case) names no
  # owner. Refuse both here, before any token is written.
  function Test-Sub([string]$v, [string]$name) {
    if (-not $v) { return }
    if ($v -match '^(?i)service:') { throw "$name names a service ('service:...'), not a person: set it to the operator's Authentik subject" }
    $u = $null
    if ($v.Contains(':') -and -not [System.Uri]::TryCreate($v, [System.UriKind]::Absolute, [ref]$u)) {
      throw "$name contains ':' but is not a valid URI; PostgREST would refuse every request made with the tokens that carry it. Use the plain Authentik subject (hex)."
    }
    if ($v -match '[\s"\\]' -or $v -match '[^\x20-\x7e]') { throw "$name has whitespace, a quote, a backslash or a non-ASCII character: use the plain Authentik subject" }
    # slot 470's inlet_subject_ok: never the literal operator
    if ($v.ToLowerInvariant() -eq 'operator') { throw "$name is the literal 'operator', which no owner may be (slot 470): use the operator's Authentik subject" }
  }
  $sub = Get-Val 'WORKSPACE_DEFAULT_SUB'
  Test-Sub $sub 'WORKSPACE_DEFAULT_SUB'
  $importSub = if ($ImportOwner) { $ImportOwner.Trim() } else { $sub }
  if ($ImportOwner) { Test-Sub $importSub '-ImportOwner' }
  foreach ($c in $Callers) {
    if ($c.OnlyWith -eq 'Import' -and -not $Import) { continue }
    $claims = New-Object System.Collections.Specialized.OrderedDictionary
    $claims['role'] = $c.Role; $claims['aud'] = 'openbrain-rest'; $claims['caller'] = $c.Caller
    if ($c.WithSub) {
      $cs = if ($c.SubFrom -eq 'ImportOwner') { $importSub } else { $sub }
      $from = if ($c.SubFrom -eq 'ImportOwner' -and $ImportOwner) { '-ImportOwner' } else { 'WORKSPACE_DEFAULT_SUB' }
      if (-not $cs) { Write-Host "  SKIP  $($c.Key): WORKSPACE_DEFAULT_SUB is blank in the env file (this caller's token names its owner)"; continue }
      $claims['sub'] = $cs
    }
    Set-Val $c.Key (New-Jwt $secret $claims)
    $changed += "$($c.Key) -> role $($c.Role)$(if ($c.WithSub) { ", sub = $from" })"
  }
}

if ($changed.Count) {
  $enc = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($EnvFile, (($lines -join $nl) + $nl), $enc)
  foreach ($x in $changed) { Write-Host "  wrote $x" }
  Write-Host "  ($EnvFile; values not shown)"
}

if ($SetAuthenticatorPassword) {
  $pw = Get-Val 'OB_REST_AUTHENTICATOR_PASSWORD'
  if ($pw -notmatch '^[0-9a-f]{32,}$') { throw 'OB_REST_AUTHENTICATOR_PASSWORD is blank or not the generated hex form (run with -Generate)' }
  $sql = "\set ON_ERROR_STOP on`nALTER ROLE ob_rest_authenticator PASSWORD '$pw';`n"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'docker'
  $psi.Arguments = "exec -i $Container psql -X -q -U postgres -d openbrain"
  $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $proc.StandardInput.Write($sql); $proc.StandardInput.Close()
  $out = $proc.StandardOutput.ReadToEnd(); $err = $proc.StandardError.ReadToEnd(); $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) { throw "setting the authenticator password failed in $Container (exit $($proc.ExitCode)): $(($err -replace [regex]::Escape($pw), '***').Trim())" }
  Write-Host "  set ob_rest_authenticator's password in $Container (value not shown)"
}
