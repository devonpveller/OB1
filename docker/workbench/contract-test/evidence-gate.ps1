# evidence-gate.ps1 - the contract test run's evidence gate (research-workbench P0 follow-up,
# rw-p0b-purge-door, tester finding T2-6). Dot-sourced by run-contract-tests.ps1; tested without
# Docker by evidence-gate.test.ps1.
#
# The run writes every log into a STAGING directory it owns. Nothing reaches -Evidence until the
# live-data guard (Test-Capture) has passed for EVERY capture the run made; then each staged log
# is copied through Protect-EvidenceText and the guarded captures are copied as they are. A
# failing guard publishes nothing at all - no log, no capture, not even the directory.
#
# Protect-EvidenceText:
#   - a smoke log (smoke*.log) is reduced to its allow-listed line shapes (PASS/FAIL rows, the
#     target line, the per-request status rows, the totals, refusals); a compare's response
#     excerpt (a 'before:' / 'after:' line and every line after it up to the next allow-listed
#     one) becomes ONE line naming only the fixture ids it carried. Any other line is withheld.
#   - in every log, a uuid that is not a fixture's becomes <non-fixture-uuid>, and a host path
#     (a drive-letter path) becomes <host-path>.

$UuidRx = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

function Get-FixtureUuids([string]$fixturesSql) {
  $ids = @{}
  foreach ($m in [regex]::Matches($fixturesSql, $UuidRx)) { $ids[$m.Value.ToLower()] = $true }
  $ids['00000000-0000-4000-8000-000000000000'] = $true   # the smoke's own unknown-job probe
  return $ids
}

function Get-FixtureIdsIn([string]$text, [hashtable]$fixtureUuids) {
  return @([regex]::Matches($text, $UuidRx) | ForEach-Object { $_.Value.ToLower() } |
      Where-Object { $fixtureUuids.ContainsKey($_) } | Select-Object -Unique)
}

# The line shapes the smoke script prints that carry no response content.
$SmokeLineAllow = @(
  '^\s*$',
  '^\s*PASS\s+[a-z0-9-]+\s*$',
  '^\s*FAIL\s+[a-z0-9-]+: (the response changed|missing capture)\s*$',
  '^target: container=\S+ base=\S+ live=(True|False)\s*$',
  '^\s+[a-z0-9-]+\s+\d{3}\s*$',
  '^captured \d+ responses from \S+ \(\S+\) into .+$',
  '^all \d+ router responses identical\s*$',
  '^\d+ of \d+ router responses changed\s*$',
  '^REFUSED: .+$'
)
function Test-SmokeLine([string]$line) {
  foreach ($rx in $SmokeLineAllow) { if ($line -match $rx) { return $true } }
  return $false
}

function Protect-EvidenceText([string]$name, [string]$text, [hashtable]$fixtureUuids) {
  $lines = $text -split "`r?`n"
  if ($name -like 'smoke*.log') {
    $out = New-Object System.Collections.Generic.List[string]
    $i = 0
    while ($i -lt $lines.Count) {
      $l = $lines[$i]
      if ($l -match '^(\s*)(before|after):') {
        $indent = $Matches[1]; $side = $Matches[2]
        $block = New-Object System.Collections.Generic.List[string]
        $block.Add($l); $i++
        # an excerpt carries blank lines (status, type, blank, body): only a NON-blank result line
        # or the next excerpt ends it
        while ($i -lt $lines.Count -and ($lines[$i] -match '^\s*$' -or -not (Test-SmokeLine $lines[$i])) -and $lines[$i] -notmatch '^\s*(before|after):') { $block.Add($lines[$i]); $i++ }
        $ids = Get-FixtureIdsIn ($block -join "`n") $fixtureUuids
        $out.Add("$indent${side}: [response excerpt redacted to its fixture ids: $(if ($ids.Count) { $ids -join ', ' } else { 'none' })]")
        continue
      }
      if (Test-SmokeLine $l) { $out.Add($l) } else { $out.Add('[line withheld by the evidence gate: not a smoke result line]') }
      $i++
    }
    $lines = $out.ToArray()
  }
  # a drive-letter path runs to the end of its line (paths here carry spaces: D:\Open WebUI\...)
  $joined = [regex]::Replace(($lines -join "`n"), '(?i)\b[a-z]:[\\/][^''"|<>\r\n]*', '<host-path>')
  return [regex]::Replace($joined, $UuidRx, {
      param($m)
      if ($fixtureUuids.ContainsKey($m.Value.ToLower())) { $m.Value } else { '<non-fixture-uuid>' }
    })
}

# $captures: @(@(<capture dir>, <container it must name>), ...) - every capture the run made.
# $guard: the live-data guard, called as & $guard <dir> <container>; returns its violations.
# Returns @{ published = <bool>; violations = <string[]>; files = <int> }.
function Publish-Evidence([string]$staging, [string]$evidence, [object[]]$captures, [scriptblock]$guard, [hashtable]$fixtureUuids) {
  $bad = @()
  foreach ($c in $captures) {
    foreach ($x in @(& $guard $c[0] $c[1])) { if ($x) { $bad += "$(Split-Path -Leaf $c[0]): $x" } }
  }
  if ($bad.Count) { return @{ published = $false; violations = $bad; files = 0 } }
  New-Item -ItemType Directory -Force $evidence | Out-Null
  $n = 0
  foreach ($f in @(Get-ChildItem -File $staging -ErrorAction SilentlyContinue)) {
    $safe = Protect-EvidenceText $f.Name ([System.IO.File]::ReadAllText($f.FullName)) $fixtureUuids
    [System.IO.File]::WriteAllText((Join-Path $evidence $f.Name), $safe, (New-Object System.Text.UTF8Encoding $false))
    $n++
  }
  foreach ($c in $captures) {
    Copy-Item -Recurse $c[0] (Join-Path $evidence (Split-Path -Leaf $c[0]))
    $n++
  }
  return @{ published = $true; violations = @(); files = $n }
}
