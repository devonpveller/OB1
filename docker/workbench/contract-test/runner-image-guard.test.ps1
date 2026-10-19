# ob1-runner-image-guard: the 'no :local image changed' guard of every OB1 contract runner can FAIL.
# No Docker: the REAL Check/Pass/Fail lines, the REAL guard line and the REAL exit line are cut out of
# each runner's text and executed in a child Windows PowerShell with two fabricated snapshot arrays.
# Run: powershell -NoProfile -File runner-image-guard.test.ps1   (exit 0 = all cases held)
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$runners = @(
  (Join-Path $here 'run-contract-tests.ps1'),
  (Join-Path $here 'run-references-tests.ps1'),
  (Join-Path $here 'run-export-tests.ps1'),
  (Join-Path $here '..\..\..\integrations\research-service\run-credibility-e2e.ps1')
)
$bad = 0
function Ok([bool]$c, [string]$m) { if ($c) { Write-Host "  PASS  $m" } else { Write-Host "  FAIL  $m"; $script:bad++ } }
function Run-Guard([string]$runner, [string[]]$before, [string[]]$after) {
  $lines = [System.IO.File]::ReadAllLines($runner)
  $pick = { param($rx) @($lines | Where-Object { $_ -match $rx }) }
  $guard = @(& $pick "^\s*Check .*'no :local image changed'")
  $exit = @(& $pick '^(exit \$script:fail|if \(\$script:fail\) \{.*exit 1 \})\s*$')
  if ($guard.Count -ne 1 -or $exit.Count -lt 1) { return @{ rc = -1; out = "no single guard line ($($guard.Count)) / exit line ($($exit.Count))" } }
  $body = @(
    "`$ErrorActionPreference = 'Continue'", '$script:fail = 0',
    (& $pick '^function (Pass|Fail|Check)\b'),
    ('$localBefore = @(' + (($before | ForEach-Object { "'$_'" }) -join ',') + ')'),
    ('$localAfter = @(' + (($after | ForEach-Object { "'$_'" }) -join ',') + ')'),
    $guard[0].Trim(), $exit[-1].Trim()
  )
  $tmp = Join-Path $env:TEMP ("imgguard-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.ps1')
  try {
    [System.IO.File]::WriteAllLines($tmp, [string[]]($body | ForEach-Object { $_ }))
    $o = (& powershell -NoProfile -ExecutionPolicy Bypass -File $tmp 2>&1 | ForEach-Object { "$_" }) -join "`n"
    return @{ rc = $LASTEXITCODE; out = $o }
  } finally { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
}
foreach ($r in $runners) {
  $n = Split-Path -Leaf $r
  Write-Host "== $n"
  $d = Run-Guard $r @('a:local=sha256:1', 'b:local=sha256:2') @('a:local=sha256:1', 'b:local=sha256:CHANGED')
  Ok ($d.out -match 'FAIL  no :local image changed') "differing snapshots print a FAIL line"
  Ok ($d.out -notmatch 'Exception|Cannot convert|ParameterBinding') "differing snapshots raise no binding exception"
  Ok ($d.rc -ne 0) "differing snapshots end non-zero (rc $($d.rc))"
  $s = Run-Guard $r @('a:local=sha256:1', 'b:local=sha256:2') @('a:local=sha256:1', 'b:local=sha256:2')
  Ok ($s.out -match 'PASS  no :local image changed') "identical snapshots print PASS"
  Ok ($s.out -notmatch 'FAIL') "identical snapshots print no FAIL"
  Ok ($s.rc -eq 0) "identical snapshots leave the exit code 0 (rc $($s.rc))"
}
if ($bad) { Write-Host "$bad check(s) FAILED"; exit 1 }
Write-Host 'all runner-image-guard checks passed'
exit 0
