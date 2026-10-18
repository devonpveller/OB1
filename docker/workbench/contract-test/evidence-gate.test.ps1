# evidence-gate.test.ps1 - the evidence gate without Docker (rw-p0b-purge-door, tester finding T2-6).
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\evidence-gate.test.ps1 [-Gate <evidence-gate.ps1>]
#
# Plants a LIVE-SHAPED response excerpt (a uuid that is no fixture's, a notebook name and a host
# path) in a staged smoke log, as a FAIL compare prints it, and checks: (1) a capture that fails
# the guard publishes NOTHING (no directory, no log); (2) when every capture passes, the logs are
# published with the excerpt redacted to its fixture ids, no non-fixture uuid, no host path, and
# the captures copied. -Gate points at another copy of the gate (a RED mutates a scratch copy).
# Exit 0 = every check passed.
param([string]$Gate = (Join-Path $PSScriptRoot 'evidence-gate.ps1'))
$ErrorActionPreference = 'Stop'
. $Gate
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
} finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
if ($fail) { Write-Host "$fail check(s) FAILED"; exit 1 }
Write-Host 'all checks passed'
exit 0
