# evidence-gate.test.ps1 - the evidence gate without Docker (rw-p0b-purge-door, tester finding T2-6;
# attempt 2: N7, N8).
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\evidence-gate.test.ps1 [-Gate <evidence-gate.ps1>]
#
# Plants a LIVE-SHAPED response excerpt (a uuid that is no fixture's, a notebook name and a host
# path) in a staged smoke log, as a FAIL compare prints it, and checks: (1) a capture that fails
# the guard publishes NOTHING (no directory, no log); (2) when every capture passes, the logs are
# published with the excerpt redacted to its fixture ids, no non-fixture uuid, no host path, and
# the captures copied. Attempt 2: (3) a NON-smoke log carrying a planted live-shaped excerpt - a
# notebook name (JSON, printed-value and single-quoted forms), uuids dash-less, %2D- and
# \u002d-encoded, braced and upper-case, docker ids, IPs, host paths in five spellings - is
# published with none of it, fixture ids and fixture literals kept; (4) a file over 16 KB is not
# published and is named in the drop list (_dropped.txt); (5) a hard link, a symbolic link and a
# directory in the staging directory, and a hard link inside a capture, are not followed: dropped
# and named, their content (a file OUTSIDE the run) reaches no evidence file.
# -Gate points at another copy of the gate (a RED mutates a scratch copy). Exit 0 = every check passed.
param([string]$Gate = (Join-Path $PSScriptRoot 'evidence-gate.ps1'))
$ErrorActionPreference = 'Stop'
. $Gate
# a gate older than attempt 2 has no Get-FixtureText: stand in with an empty set, so a RED over it runs to the end
if (-not (Get-Command Get-FixtureText -ErrorAction SilentlyContinue)) { function Get-FixtureText { return @{} } }
$fail = 0
function Check([bool]$ok, [string]$m) { if ($ok) { Write-Host "  PASS  $m" } else { Write-Host "  FAIL  $m"; $script:fail++ } }

$root = Join-Path $env:TEMP ("rwp0b-gate-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$staging = Join-Path $root 'staging'; $capDir = Join-Path $root 'captures'
New-Item -ItemType Directory -Force $staging, $capDir | Out-Null
try {
  $fixture = '11111111-1111-4111-8111-111111111111'
  $fixtures = Get-FixtureUuids "INSERT INTO public.sources (id) VALUES ('$fixture');"
  $live = [guid]::NewGuid().ToString()
  $marker = 'Live notebook ' + [guid]::NewGuid().ToString('N').Substring(0, 6)
  $hostPath = 'C:\Users\someone\AppData\Local\Temp\rwp0-smoke-abc123\smoke-a'
  # what the smoke script prints for a FAIL compare: the excerpt spans lines (status, type, body)
  $smokeLog = @(
    'target: container=rwp0-wb-abc123 base=http://localhost:8000 live=False',
    '  notes-list               200',
    "captured 13 responses from rwp0-wb-abc123 (http://localhost:8000) into $hostPath",
    '  PASS  notes-list',
    '  FAIL  notebooks-list: the response changed',
    "    before: status: 200",
    'type: application/json',
    '',
    ('{"notebooks":[{"id":"' + $fixture + '","name":"Fixture notebook"}]}'),
    "    after:  status: 200",
    'type: application/json',
    '',
    ('{"notebooks":[{"id":"' + $live + '","name":"' + $marker + '"}]}'),
    '1 of 13 router responses changed'
  ) -join "`n"
  [System.IO.File]::WriteAllText((Join-Path $staging 'smoke-red.log'), $smokeLog)
  [System.IO.File]::WriteAllText((Join-Path $staging 'integration-test.log'), "ok $live $fixture at $hostPath`n")
  $good = Join-Path $capDir 'smoke-a'; $badCap = Join-Path $capDir 'smoke-b'
  New-Item -ItemType Directory -Force $good, $badCap | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $good 'notes-list.txt'), 'fixture capture')
  [System.IO.File]::WriteAllText((Join-Path $badCap 'notes-list.txt'), 'live capture')
  # the guard stub: smoke-b is a capture that fails it
  $guard = { param($dir, $container) if ((Split-Path -Leaf $dir) -eq 'smoke-b') { 'notes-list carries a non-fixture note' } else { @() } }

  Write-Host '[1] a capture fails the guard: nothing is published'
  $ev1 = Join-Path $root 'evidence-1'
  $r1 = Publish-Evidence $staging $ev1 @(@($good, 'rwp0-wb-abc123'), @($badCap, 'rwp0-wb-abc123')) $guard $fixtures
  Check (-not $r1.published) 'Publish-Evidence reports nothing published'
  Check (-not (Test-Path $ev1)) 'the evidence directory was not even created'
  Check ($r1.violations.Count -eq 1 -and $r1.violations[0] -match 'smoke-b') "the violation names the capture ($($r1.violations -join '; '))"

  Write-Host '[2] every capture passes: the logs are published, redacted'
  $ev2 = Join-Path $root 'evidence-2'
  $r2 = Publish-Evidence $staging $ev2 @(, @($good, 'rwp0-wb-abc123')) $guard $fixtures
  Check ($r2.published -and (Test-Path (Join-Path $ev2 'smoke-red.log')) -and (Test-Path (Join-Path $ev2 'smoke-a\notes-list.txt'))) "published: the staged logs and the capture ($($r2.files) item(s))"
  $all = (Get-ChildItem -Recurse -File $ev2 | ForEach-Object { [System.IO.File]::ReadAllText($_.FullName) }) -join "`n"
  Check ($all -notmatch [regex]::Escape($live)) 'the planted non-fixture uuid reached no evidence file'
  Check ($all -notmatch [regex]::Escape($marker)) 'the planted live-shaped excerpt (the notebook name) reached no evidence file'
  Check ($all -notmatch [regex]::Escape('C:\Users\someone')) 'no host path reached the evidence'
  $sl = [System.IO.File]::ReadAllText((Join-Path $ev2 'smoke-red.log'))
  Check ($sl -match "before: \[response excerpt redacted to its fixture ids: $fixture\]") 'the before excerpt is redacted to its fixture id'
  Check ($sl -match 'after: \[response excerpt redacted to its fixture ids: none\]') 'the after excerpt (no fixture id) is redacted to none'
  Check ($sl -match '(?m)^\s*FAIL\s+notebooks-list: the response changed$' -and $sl -match '(?m)^1 of 13 router responses changed$') 'the result lines are kept'
  Check (-not (Test-Path (Join-Path $ev2 'smoke-b'))) 'a capture not in the list is not copied'
  $il = [System.IO.File]::ReadAllText((Join-Path $ev2 'integration-test.log'))
  Check ($il -match '<non-fixture-uuid>' -and $il -match $fixture -and $il -match '<host-path>') 'other logs: non-fixture uuids and host paths redacted, fixture ids kept'

  Write-Host '[3] a NON-smoke log with a planted live-shaped excerpt (attempt 2, N7)'
  $staging3 = Join-Path $root 'staging-3'; New-Item -ItemType Directory -Force $staging3 | Out-Null
  $literals = Join-Path $root 'fixture-literals.sql'
  [System.IO.File]::WriteAllText($literals, "INSERT INTO public.notebooks (id, name) VALUES ('$fixture', 'Fixture notebook');")
  $fixtureText = Get-FixtureText @($literals)
  $liveCompact = $live.Replace('-', '')
  $liveEnc = $live.Replace('-', '%2D')
  $liveU = $live.Replace('-', '\u002d')
  $liveUpper = '{' + $live.ToUpper() + '}'
  $cid = '3f5edce33b4b'; $cidFull = '3f5edce33b4b13b735d38c8651154f1435780a6fc95cfb8105a0838f46ab0783'
  $nonSmoke = @(
    'running 3 tests from ./src/contracts/integration_test.ts',
    ('PROBE {"notebooks":[{"id":"' + $live + '","name":"' + $marker + '"},{"id":"' + $fixture + '","name":"Fixture notebook"}]}'),
    ('error: AssertionError: Values are not equal: { id: "' + $live + '", name: "' + $marker + '" }'),
    "the notebook '$marker' was listed",
    "compact $liveCompact | encoded $liveEnc | escaped $liveU | braced-upper $liveUpper | fixture-compact $($fixture.Replace('-', ''))",
    "container $cid image sha256:$cidFull at 172.27.1.4 and 10.222.72.5 (loopback 127.0.0.1 stays)",
    "paths: $hostPath | D:/Open WebUI/ai-stack/x.ts | \\fileserver\share\x | /c/Users/someone/AppData/x | file:///D:/Open%20WebUI/x",
    'ok | 3 passed | 0 failed (2s)'
  ) -join "`n"
  [System.IO.File]::WriteAllText((Join-Path $staging3 'integration-test.log'), $nonSmoke)
  $ev3 = Join-Path $root 'evidence-3'
  $r3 = Publish-Evidence $staging3 $ev3 @() $guard $fixtures $fixtureText
  $p3 = if (Test-Path (Join-Path $ev3 'integration-test.log')) { [System.IO.File]::ReadAllText((Join-Path $ev3 'integration-test.log')) } else { '' }
  Check ($r3.published -and $p3.Length -gt 0) 'the non-smoke log is published'
  foreach ($x in @(@('the notebook name', $marker), @('the dashed uuid', $live), @('the compact uuid', $liveCompact), @('the %2D uuid', $liveEnc),
      @('the \u002d uuid', $liveU), @('the braced upper-case uuid', $live.ToUpper()), @('the 12-hex container id', $cid), @('the 64-hex image id', $cidFull),
      @('the IP', '172.27.1.4'), @('the run-subnet IP', '10.222.72.5'), @('a profile path', 'C:\Users\someone'), @('a drive path', 'D:/Open WebUI'),
      @('a UNC path', '\\fileserver'), @('a git-bash path', '/c/Users/someone'), @('a file URL path', 'Open%20WebUI'))) {
    Check ($p3.Length -gt 0 -and -not $p3.Contains($x[1])) "non-smoke log: $($x[0]) is not published"
  }
  Check ($p3.Contains($fixture) -and $p3.Contains($fixture.Replace('-', '')) -and $p3.Contains('"Fixture notebook"')) 'non-smoke log: fixture ids (any spelling) and fixture literals are kept'
  Check ($p3 -match 'ok \| 3 passed \| 0 failed' -and $p3.Contains('127.0.0.1') -and $p3 -match '"<non-fixture-text>"') "non-smoke log: the result lines are kept, the excerpt's text is redacted"

  Write-Host '[4] the size cap: a file over 16 KB is not published, and is named (attempt 2, N8)'
  $staging4 = Join-Path $root 'staging-4'; New-Item -ItemType Directory -Force $staging4 | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $staging4 'big.log'), ('x' * 16385))
  [System.IO.File]::WriteAllText((Join-Path $staging4 'edge.log'), ('y' * 16384))
  $ev4 = Join-Path $root 'evidence-4'
  $r4 = Publish-Evidence $staging4 $ev4 @() $guard $fixtures
  Check (-not (Test-Path (Join-Path $ev4 'big.log'))) 'a 16385-byte log is not published'
  Check (Test-Path (Join-Path $ev4 'edge.log')) 'a 16384-byte log is published (the cap is inclusive)'
  $d4 = if (Test-Path (Join-Path $ev4 '_dropped.txt')) { [System.IO.File]::ReadAllText((Join-Path $ev4 '_dropped.txt')) } else { '' }
  Check (((@($r4.dropped) -join ' ') -match 'big\.log: 16385 bytes') -and ($d4 -match 'big\.log: 16385 bytes')) "the drop list names it (returned and in _dropped.txt): $(@($r4.dropped) -join '; ')"

  Write-Host '[5] links and directories are not followed (attempt 2, N8)'
  $outside = Join-Path $root 'outside-the-run.txt'
  $secret = 'OUTSIDE-' + [guid]::NewGuid().ToString('N').Substring(0, 10)
  [System.IO.File]::WriteAllText($outside, "content of a file outside the run: $secret")
  $staging5 = Join-Path $root 'staging-5'; New-Item -ItemType Directory -Force $staging5 | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $staging5 'plain.log'), 'a regular log')
  $null = New-Item -ItemType HardLink -Path (Join-Path $staging5 'hard.log') -Value $outside
  $symOk = $true
  try { $null = New-Item -ItemType SymbolicLink -Path (Join-Path $staging5 'sym.log') -Value $outside -ErrorAction Stop } catch { $symOk = $false }
  # a directory junction (a reparse point any user can make) to a directory outside the run
  $outsideDir = Join-Path $root 'outside-dir'; New-Item -ItemType Directory -Force $outsideDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $outsideDir 'x.log'), "junction target $secret")
  $null = New-Item -ItemType Junction -Path (Join-Path $staging5 'junction') -Value $outsideDir
  New-Item -ItemType Directory -Force (Join-Path $staging5 'subdir') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $staging5 'subdir\inner.log'), "inner $secret")
  $cap5 = Join-Path $root 'captures-5\smoke-a'; New-Item -ItemType Directory -Force $cap5 | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $cap5 'notes-list.txt'), 'fixture capture')
  $null = New-Item -ItemType HardLink -Path (Join-Path $cap5 'notes-folders.txt') -Value $outside
  $ev5 = Join-Path $root 'evidence-5'
  $r5 = Publish-Evidence $staging5 $ev5 @(, @($cap5, 'rwp0-wb-abc123')) $guard $fixtures
  $all5 = (Get-ChildItem -Recurse -File $ev5 | ForEach-Object { [System.IO.File]::ReadAllText($_.FullName) }) -join "`n"
  Check (-not $all5.Contains($secret)) 'the outside file reached no evidence file (through a hard link, a symbolic link, a directory or a capture)'
  Check ((Test-Path (Join-Path $ev5 'plain.log')) -and (Test-Path (Join-Path $ev5 'smoke-a\notes-list.txt'))) 'regular files are published'
  $d5 = @($r5.dropped) -join ' | '
  Check (($d5 -match 'hard\.log: a file with \d+ hard link') -and ($d5 -match 'subdir: a directory') -and ($d5 -match 'smoke-a\\notes-folders\.txt: a file with \d+ hard link')) "the hard links and the directory are dropped and named: $d5"
  Check ($d5 -match 'junction: a symbolic link / reparse point') 'the junction (a reparse point) is dropped and named, not followed'
  if ($symOk) { Check ($d5 -match 'sym\.log: a symbolic link') 'the symbolic link is dropped and named' }
  else { Write-Host '  INFO  a symbolic link could not be created here (needs the privilege or Developer Mode); the junction above takes the same reparse-point branch' }
} finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
if ($fail) { Write-Host "$fail check(s) FAILED"; exit 1 }
Write-Host 'all checks passed'
exit 0
