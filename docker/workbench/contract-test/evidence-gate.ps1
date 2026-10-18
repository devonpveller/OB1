# evidence-gate.ps1 - the disposable test runs' evidence gate (research-workbench P0 follow-up,
# rw-p0b-purge-door, tester finding T2-6; attempt 2: N7, N8). Dot-sourced by run-contract-tests.ps1
# and run-references-tests.ps1; tested without Docker by evidence-gate.test.ps1.
#
# The run writes every log into a STAGING directory it owns. Nothing reaches -Evidence until the
# live-data guard (Test-Capture) has passed for EVERY capture the run made; then each staged log
# is copied through Protect-EvidenceText and the guarded captures are copied as they are. A
# failing guard publishes nothing at all - no log, no capture, not even the directory.
#
# What is published (attempt 2):
#   - REGULAR FILES ONLY: a symbolic link / junction (a reparse point), a file with more than one
#     hard link (its content lives outside the run too), or a directory in the staging directory
#     or in a capture is not followed and not copied - it is DROPPED and named;
#   - at most $EvidenceMaxBytes (16 KB) per file, before and after redaction: a bigger file is
#     DROPPED and named (the run's console carries its PASS/FAIL line; the evidence never carries
#     a file a reviewer cannot read);
#   - the drop list is returned, printed by the runner and written as _dropped.txt.
#
# Protect-EvidenceText, over EVERY published log (not only the smoke logs):
#   - a smoke log (smoke*.log) is first reduced to its allow-listed line shapes (PASS/FAIL rows,
#     the target line, the per-request status rows, the totals, refusals); a compare's response
#     excerpt (a 'before:' / 'after:' line and every line after it up to the next allow-listed
#     one) becomes ONE line naming only the fixture ids it carried. Any other line is withheld.
#   - then, in every log:
#       host paths (a drive-letter path, a UNC path, a /c/Users/... path, anything under a
#         Windows profile)                                          -> <host-path>
#       a uuid in any spelling - dashed, compact (32 hex), %2D- or \u002d-encoded, braced, any
#         case - that is not a fixture's                           -> <non-fixture-uuid>
#       a 64- or 12-hex docker id                                   -> <hex-id>
#       an IPv4 address other than loopback / 0.0.0.0               -> <ip>
#       a double-quoted string (a JSON value, a printed JS value) that is not a fixture literal,
#         an ISO timestamp, a number or a boolean; a double-quoted KEY that is not a plain
#         identifier; a single-quoted string with a space in it that is not a fixture literal
#                                                                   -> "<non-fixture-text>"
#     Fixture literals are the quoted strings of the run's fixture files (fixtures.sql,
#     fixture-vault.ts, the registry seeds - Get-FixtureText). What this cannot see: a live value
#     printed as bare prose (no quotes, no id shape). No run prints one: response bodies reach a log
#     only as JSON or as printed values, and the smoke logs are allow-listed line by line.

$UuidRx = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
$EvidenceMaxBytes = 16384
# any spelling of a uuid: separators '-', '%2D', '\u002d' or none (the empty alternative keeps
# the backreference defined: .NET fails a backreference to a group that took no part); not inside
# a longer hex run
$UuidAnyRx = '(?i)(?<![0-9a-f])([0-9a-f]{8})(-|%2d|\\u002d|)([0-9a-f]{4})\2([0-9a-f]{4})\2([0-9a-f]{4})\2([0-9a-f]{12})(?![0-9a-f])'

function Get-FixtureUuids([string]$fixturesSql) {
  $ids = @{}
  foreach ($m in [regex]::Matches($fixturesSql, $UuidRx)) { $ids[$m.Value.ToLower()] = $true }
  $ids['00000000-0000-4000-8000-000000000000'] = $true   # the smoke's own unknown-job probe
  return $ids
}

# The quoted literals of the run's fixture files: what a published log may quote as it is.
function Get-FixtureText([string[]]$files) {
  $t = @{}
  foreach ($f in $files) {
    if (-not (Test-Path $f)) { continue }
    $txt = [System.IO.File]::ReadAllText($f)
    foreach ($m in [regex]::Matches($txt, "'((?:[^']|'')*)'")) { $t[$m.Groups[1].Value.Replace("''", "'")] = $true }
    foreach ($m in [regex]::Matches($txt, '"((?:[^"\\\r\n]|\\.)*)"')) { $t[$m.Groups[1].Value] = $true }
  }
  return $t
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

function Test-SafeQuoted([string]$v, [hashtable]$fixtureText, [hashtable]$fixtureUuids) {
  if ($v -eq '' -or $fixtureText.ContainsKey($v)) { return $true }
  if ($v -match '^<[a-z-]+>$') { return $true }                                  # an earlier placeholder
  if ($v -match '^-?\d+(\.\d+)?$' -or $v -in @('true', 'false', 'null')) { return $true }
  if ($v -match '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$') { return $true }
  if ($v -match "^$UuidRx$" -and $fixtureUuids.ContainsKey($v.ToLower())) { return $true }
  return $false
}

function Protect-EvidenceText([string]$name, [string]$text, [hashtable]$fixtureUuids, [hashtable]$fixtureText = @{}) {
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
  $t = $lines -join "`n"
  # host paths: a drive-letter path runs to the end of its line (paths here carry spaces:
  # D:\Open WebUI\...); a UNC path; a git-bash /c/... path; anything under a Windows profile
  $t = [regex]::Replace($t, '(?i)(?<![a-z0-9])[a-z]:[\\/][^''"|<>\r\n]*', '<host-path>')
  $t = [regex]::Replace($t, '\\\\[A-Za-z0-9._$-]+\\[^\s''"|<>]*', '<host-path>')
  $t = [regex]::Replace($t, '(?i)(?<![\w.-])/[a-z]/(Users|Windows|ProgramData|Program Files|Open WebUI)[^''"|<>\r\n]*', '<host-path>')
  $t = [regex]::Replace($t, '(?i)[^\s''"|<>]*[\\/](Users|AppData)[\\/][^\s''"|<>]*', '<host-path>')
  # every spelling of a uuid, checked against the fixtures in its canonical form
  $t = [regex]::Replace($t, $UuidAnyRx, {
      param($m)
      $g = $m.Groups
      $canon = ('{0}-{1}-{2}-{3}-{4}' -f $g[1].Value, $g[3].Value, $g[4].Value, $g[5].Value, $g[6].Value).ToLower()
      if ($fixtureUuids.ContainsKey($canon)) { $m.Value } else { '<non-fixture-uuid>' }
    })
  # docker ids (image / container / network: 64 hex, or the 12-hex short form)
  $t = [regex]::Replace($t, '(?i)(?<![0-9a-z])([0-9a-f]{64}|[0-9a-f]{12})(?![0-9a-z])', {
      param($m) if ($m.Value -match '[a-f]' -and $m.Value -match '[0-9]') { '<hex-id>' } else { $m.Value } })
  # IPv4 addresses other than loopback and the unspecified address
  $t = [regex]::Replace($t, '(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])', {
      param($m) if ($m.Groups[1].Value -eq '127' -or $m.Value -eq '0.0.0.0') { $m.Value } else { '<ip>' } })
  # double-quoted strings: a key stays when it is a plain identifier; a value when it is a fixture
  # literal (or a number, boolean, timestamp, placeholder); anything else is non-fixture text
  $t = [regex]::Replace($t, '"((?:[^"\\\r\n]|\\.)*)"(\s*:)?', {
      param($m)
      $v = $m.Groups[1].Value; $isKey = $m.Groups[2].Success
      if ($isKey) { if ($v -match '^[A-Za-z_$][A-Za-z0-9_$.-]{0,63}$') { $m.Value } else { '"<non-fixture-text>"' + $m.Groups[2].Value } }
      elseif (Test-SafeQuoted $v $fixtureText $fixtureUuids) { $m.Value } else { '"<non-fixture-text>"' }
    })
  # single-quoted strings with a space in them (a name, a title, a sentence); a quote mark inside
  # a word (an apostrophe: claims' ... 's) neither opens nor closes one
  $t = [regex]::Replace($t, "(?<!\w)'([^'\r\n]*\s[^'\r\n]*)'(?!\w)", {
      param($m) if (Test-SafeQuoted $m.Groups[1].Value $fixtureText $fixtureUuids) { $m.Value } else { "'<non-fixture-text>'" } })
  return $t
}

# The link count of a file (1 = a regular file with no other name). -1 when it cannot be read:
# the caller treats that as a link (not published).
if (-not ('EvidenceGateFileInfo' -as [type])) {
  try {
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class EvidenceGateFileInfo {
  [StructLayout(LayoutKind.Sequential)]
  struct BY_HANDLE_FILE_INFORMATION {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
    public uint VolumeSerial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle h, out BY_HANDLE_FILE_INFORMATION info);
  public static long Links(string path) {
    try {
      using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
        BY_HANDLE_FILE_INFORMATION i;
        if (!GetFileInformationByHandle(fs.SafeFileHandle, out i)) return -1;
        return i.Links;
      }
    } catch { return -1; }
  }
}
'@
  } catch { }
}
function Get-LinkCount([string]$path) {
  if (-not ('EvidenceGateFileInfo' -as [type])) { return -1 }
  return [EvidenceGateFileInfo]::Links($path)
}
# Why an item may not be published, or '' (a regular file, one link, within the cap).
function Get-PublishRefusal($item) {
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return 'a symbolic link / reparse point (not followed)' }
  if ($item.PSIsContainer) { return 'a directory (only regular files are published)' }
  $n = Get-LinkCount $item.FullName
  if ($n -ne 1) { return "a file with $n hard link(s) (its content lives elsewhere too; not followed)" }
  if ($item.Length -gt $EvidenceMaxBytes) { return "$($item.Length) bytes, over the $EvidenceMaxBytes-byte cap" }
  return ''
}

# $captures: @(@(<capture dir>, <container it must name>), ...) - every capture the run made.
# $guard: the live-data guard, called as & $guard <dir> <container>; returns its violations.
# Returns @{ published = <bool>; violations = <string[]>; files = <int>; dropped = <string[]> }.
function Publish-Evidence([string]$staging, [string]$evidence, [object[]]$captures, [scriptblock]$guard, [hashtable]$fixtureUuids, [hashtable]$fixtureText = @{}) {
  $bad = @()
  foreach ($c in $captures) {
    foreach ($x in @(& $guard $c[0] $c[1])) { if ($x) { $bad += "$(Split-Path -Leaf $c[0]): $x" } }
  }
  if ($bad.Count) { return @{ published = $false; violations = $bad; files = 0; dropped = @() } }
  New-Item -ItemType Directory -Force $evidence | Out-Null
  $n = 0; $dropped = @()
  $utf8 = New-Object System.Text.UTF8Encoding $false
  foreach ($f in @(Get-ChildItem -Force $staging -ErrorAction SilentlyContinue)) {
    $why = Get-PublishRefusal $f
    if ($why) { $dropped += "$($f.Name): $why"; continue }
    $safe = Protect-EvidenceText $f.Name ([System.IO.File]::ReadAllText($f.FullName)) $fixtureUuids $fixtureText
    $bytes = $utf8.GetByteCount($safe)
    if ($bytes -gt $EvidenceMaxBytes) { $dropped += "$($f.Name): $bytes bytes after redaction, over the $EvidenceMaxBytes-byte cap"; continue }
    [System.IO.File]::WriteAllText((Join-Path $evidence $f.Name), $safe, $utf8)
    $n++
  }
  foreach ($c in $captures) {
    $leaf = Split-Path -Leaf $c[0]
    $src = Get-Item -Force $c[0] -ErrorAction SilentlyContinue
    if (-not $src) { $dropped += "${leaf}: the capture directory is gone"; continue }
    if ($src.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $dropped += "${leaf}: the capture directory is a link (not followed)"; continue }
    $dest = Join-Path $evidence $leaf
    New-Item -ItemType Directory -Force $dest | Out-Null
    foreach ($f in @(Get-ChildItem -Force $c[0])) {
      $why = Get-PublishRefusal $f
      if ($why) { $dropped += "$leaf\$($f.Name): $why"; continue }
      [System.IO.File]::WriteAllBytes((Join-Path $dest $f.Name), [System.IO.File]::ReadAllBytes($f.FullName))
    }
    $n++
  }
  if ($dropped.Count) {
    [System.IO.File]::WriteAllText((Join-Path $evidence '_dropped.txt'), (("files NOT published by the evidence gate (regular files of at most $EvidenceMaxBytes bytes only):", $dropped) | ForEach-Object { $_ }) -join "`n", $utf8)
  }
  return @{ published = $true; violations = @(); files = $n; dropped = $dropped }
}
