# lab-throughput.test.ps1 - the hermetic proof of lab-throughput.ps1 (rw-lab-throughput). No Docker: the helper is
# dot-sourced next to a FAKE lab docker shim (an in-memory image store that applies --label and the workbench
# Dockerfile's WORKBENCH_TEST_GATE label the way a real build does), a scratch git repository stands in for OB1, and
# the build-lease cases drive a copy of the REAL ai-stack lease.ps1 against a scratch lock dir.
#
#   powershell -NoProfile -File lab-throughput.test.ps1                     # this tree's helper
#   powershell -NoProfile -File lab-throughput.test.ps1 -Helper <copy>      # a mutated copy: must go red
#   powershell -NoProfile -File lab-throughput.test.ps1 -SkipLease          # without the ~70 s build-lease wait case
#
# Exit 0 = every check held.
param([string]$Helper = '', [switch]$SkipLease)
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Helper) { $Helper = Join-Path $here 'lab-throughput.ps1' }
$wbDir = Split-Path -Parent $here
$ob1Real = Split-Path -Parent (Split-Path -Parent $wbDir)

$script:bad = 0; $script:n = 0
function Ok([bool]$c, [string]$m) { $script:n++; if ($c) { Write-Host "  PASS  $m" } else { Write-Host "  FAIL  $m"; $script:bad++ } }

# ---- the runner surface the helper expects ------------------------------------------------------------------------
$script:fail = 0
$script:lines = @()
function Pass([string]$m) { $script:lines += "PASS  $m" }
function Fail([string]$m) { $script:lines += "FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
$label = 'ai-stack.harness.owner=wt-unit'
$script:images = @{}       # tag -> image record @{ id; labels; markers; src } (two tags may share one record)
$script:builds = @()       # every build's arg list
$script:gateAware = $true  # a Dockerfile that knows WORKBENCH_TEST_GATE (false = an older tree)
$script:fakeOb1 = ''       # the repo a fake build copies /app from (Get-LabAppExpected)
$script:rc = 0
$script:lastTimeout = 0
$script:idN = 0
function New-FakeId { $script:idN++; return ('sha256:' + ('{0:x64}' -f $script:idN)) }
function Find-FakeImage([string]$ref) {
  if ($script:images.ContainsKey($ref)) { return $script:images[$ref] }
  foreach ($r in $script:images.Values) { if ($r.id -eq $ref) { return $r } }
  return $null
}
$script:vols = @{}         # volume -> labels
$script:volRm = @()        # every volume rm
$script:readyMode = 'ok'   # the template READY read: ok | fail (a docker error / timeout)
$script:readyContent = ''
function Lab-Docker([int]$TimeoutSec, [string[]]$a) {
  $script:rc = 0
  if ($a[0] -eq 'volume' -and $a[1] -eq 'inspect') {
    if ($script:vols.ContainsKey($a[-1])) { return ($script:vols[$a[-1]] | ConvertTo-Json -Compress) }
    $script:rc = 1; return 'Error: no such volume'
  }
  if ($a[0] -eq 'volume' -and $a[1] -eq 'rm') { $script:volRm += $a[-1]; $script:vols.Remove($a[-1]); return '' }
  if ($a[0] -eq 'run' -and ($a -join ' ') -match '/t/READY') {
    if ($script:readyMode -eq 'fail') { $script:rc = 124; return 'TIMEOUT after 300s' }
    if (($a -join ' ') -match 'ready-file') { return "ready-file $($script:readyContent)" }
    return $script:readyContent
  }
  if ($a[0] -eq 'run' -and ($a -join ' ') -match '/t/initdb\.log') { return 'PostgreSQL init process complete' }
  if ($a[0] -eq 'logs') { return 'PostgreSQL init process complete' }   # a (re)built template's init container
  if ($a[0] -eq 'image' -and $a[1] -eq 'inspect') {
    $r = Find-FakeImage $a[-1]
    if (-not $r) { $script:rc = 1; return "Error: No such image: $($a[-1])" }
    if (($a -join ' ') -match '\{\{\.Id\}\}') { return [string]$r.id }
    return ($r.labels | ConvertTo-Json -Compress)
  }
  if ($a[0] -eq 'run' -and $a -contains '--rm' -and $a -contains 'sh') {
    $r = Find-FakeImage $a[[array]::IndexOf($a, 'sh') + 1]
    if (-not $r) { $script:rc = 125; return 'Unable to find image' }
    $cmd = $a[-1]
    if ($cmd -match 'od -An') {
      # the attempt-4 /app probe: every file, its path hex-encoded, then END
      $out = @(); foreach ($k in ($r.app.Keys | Sort-Object -CaseSensitive)) { $out += "F $($r.app[$k]) $(-join ([System.Text.Encoding]::UTF8.GetBytes($k) | ForEach-Object { $_.ToString('x2') }))" }
      return (($out + 'END') -join "`n")
    }
    if ($cmd -match 'src-file') {
      # an older helper's /app/src probe (attempt 3): src files only, the path printed as text
      $out = @(); foreach ($k in ($r.app.Keys | Sort-Object)) { if ($k.StartsWith('./src/')) { $out += "src-file $($r.app[$k]) ./$($k.Substring(6))" } }
      return (($out + 'src-end') -join "`n")
    }
    $mk = [string]$r.markers
    return ('gate-markers p={0} s={1}' -f $(if ($mk -match 'p') { 1 } else { 0 }), $(if ($mk -match 's') { 1 } else { 0 }))
  }
  if ($a[0] -eq 'build') {
    $script:lastTimeout = $TimeoutSec
    $script:builds += , $a
    $labels = [ordered]@{}; $tag = ''; $gate = ''; $target = ''
    for ($i = 0; $i -lt $a.Count; $i++) {
      if ($a[$i] -eq '--label') { $kv = $a[$i + 1]; $j = $kv.IndexOf('='); $labels[$kv.Substring(0, $j)] = $kv.Substring($j + 1) }
      if ($a[$i] -eq '--build-arg' -and $a[$i + 1] -like 'WORKBENCH_TEST_GATE=*') { $gate = $a[$i + 1].Substring(20) }
      if ($a[$i] -eq '--target') { $target = $a[$i + 1] }
      if ($a[$i] -eq '-t') { $tag = $a[$i + 1] }
    }
    if ($script:gateAware) { $labels['ai-stack.lab.gate'] = $(if ($gate) { $gate } else { 'full' }) }
    $app = @{}; if ($script:fakeOb1) { $app = Get-LabAppExpected $script:fakeOb1 $(if ($target -eq 'test') { 'test' } else { 'runtime' }) }
    # the markers a real build leaves: the skipped marker only when the Dockerfile knew the arg and was told to skip
    $script:images[$tag] = @{ id = (New-FakeId); labels = $labels; markers = $(if ($script:gateAware -and $gate -eq 'skipped') { 's' } else { 'p' }); app = $app }
    return 'built'
  }
  return ''
}
function Dk { Lab-Docker 300 ([string[]]$args) }
function DkLong { Lab-Docker 2400 ([string[]]$args) }

. $Helper

$root = Join-Path $env:TEMP ('labtp-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $root | Out-Null
try {
  # ---- T1: run modes and the sweep (part 4, part 1 guards) -----------------------------------------------------------
  Write-Host '[T1] Resolve-LabRun: modes, the sweep default, the landing and skip-gate refusals'
  $r = Resolve-LabRun
  Ok ($r.mode -eq 'green' -and -not $r.sweep -and $r.note -match 'SWEEP SKIPPED' -and -not $r.refused) "a developer run skips the sweep by default and says so ($($r.note))"
  $r = Resolve-LabRun -Red $true
  Ok ($r.mode -eq 'red' -and -not $r.sweep -and $r.note -match 'RUN MODE red: SWEEP SKIPPED') 'a red run skips the sweep and says so'
  $r = Resolve-LabRun -WbMount @('src/x.ts=y')
  Ok ($r.mode -eq 'mutant' -and -not $r.sweep -and $r.note -match 'RUN MODE mutant: SWEEP SKIPPED') 'a -WbMount run is a mutant run and skips the sweep'
  $r = Resolve-LabRun -Mutant $true
  Ok ($r.mode -eq 'mutant' -and -not $r.sweep) 'a -Mutant run skips the sweep'
  $r = Resolve-LabRun -Landing $true
  Ok ($r.mode -eq 'landing' -and $r.sweep -and -not $r.refused) 'a landing run sweeps'
  $r = Resolve-LabRun -Landing $true -NoSweep $true
  Ok ($r.refused -match '-NoSweep is refused') "a landing run refuses -NoSweep ($($r.refused))"
  $r = Resolve-LabRun -Landing $true -Red $true
  Ok ([bool]$r.refused) 'a landing run refuses -Red'
  $r = Resolve-LabRun -Landing $true -WbMount @('src/x.ts=y')
  Ok ([bool]$r.refused) 'a landing run refuses -WbMount'
  $r = Resolve-LabRun -Landing $true -SkipGate $true
  Ok ($r.refused -match 'skip-gate') 'a landing run refuses a skip-gate image'
  $r = Resolve-LabRun -SkipGate $true
  Ok ($r.refused -match 'never a green run') "a green run refuses -SkipGate ($($r.refused))"
  $r = Resolve-LabRun -SkipGate $true -Red $true
  Ok (-not $r.refused -and $r.mode -eq 'red') 'a red run may use -SkipGate'
  $r = Resolve-LabRun -SkipGate $true -Mutant $true
  Ok (-not $r.refused -and $r.mode -eq 'mutant') 'a mutant run may use -SkipGate'
  $r = Resolve-LabRun -Sweep $true
  Ok ($r.sweep -and $r.note -match 'sweep runs \(-Sweep\)') 'a developer run opts in with -Sweep'
  $r = Resolve-LabRun -Sweep $true -Red $true
  Ok (-not $r.refused -and $r.sweep -and $r.mode -eq 'red' -and $r.note -match 'RUN MODE red: the isolation sweep runs') 'a red run opts in with -Sweep (the RED sweep assertions of identity and workspace stay reachable; attempt 1 D2)'
  $r = Resolve-LabRun -Red $true
  Ok (-not $r.sweep) 'a red run still skips the sweep by default'
  $r = Resolve-LabRun -Sweep $true -Mutant $true
  Ok ([bool]$r.refused) '-Sweep on a mutant run is refused'
  $r = Resolve-LabRun -Sweep $true -NoSweep $true
  Ok ([bool]$r.refused) '-Sweep with -NoSweep is refused'

  # ---- T2: -WbMount ---------------------------------------------------------------------------------------------------
  Write-Host '[T2] Get-LabWbMountArgs'
  $fakeWb = Join-Path $root 'wb'; New-Item -ItemType Directory -Force (Join-Path $fakeWb 'src\repo') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $fakeWb 'src\repo\gaps.ts'), "export const a = 1;`n")
  [System.IO.File]::WriteAllText((Join-Path $fakeWb 'src\repo\gaps_test.ts'), "x`n")
  $mut = Join-Path $root 'gaps-m1.ts'; [System.IO.File]::WriteAllText($mut, "export const a = 2;`n")
  $same = Join-Path $root 'gaps-same.ts'; [System.IO.File]::WriteAllText($same, "export const a = 1;`n")
  $m = Get-LabWbMountArgs @("src/repo/gaps.ts=$mut") $fakeWb
  Ok (-not $m.refused -and $m.args.Count -eq 2 -and $m.args[0] -eq '-v' -and $m.args[1] -eq "${mut}:/app/src/repo/gaps.ts:ro") "a mutant file mounts read-only over /app/src/repo/gaps.ts ($($m.args -join ' '))"
  Ok ($m.lines[0] -match '^MUTANT MOUNT: src/repo/gaps.ts') 'the mount is printed'
  $m = Get-LabWbMountArgs @("src\repo\gaps.ts=$mut") $fakeWb
  Ok (-not $m.refused) 'a backslash target is accepted'
  foreach ($c in @(
      @("src/repo/nope.ts=$mut", 'does not exist'), @("src/repo/gaps_test.ts=$mut", 'test file'), @("src/../x.ts=$mut", "no '..'"),
      @("src/repo/gaps.ts=$same", 'identical'), @("src/repo/gaps.ts=$root\missing.ts", 'host file'), @('gaps.ts', "not 'src/"),
      @("Dockerfile=$mut", 'under src/'))) {
    $m = Get-LabWbMountArgs @($c[0]) $fakeWb
    Ok ($m.refused -match [regex]::Escape($c[1])) "refused: $($c[0] -replace [regex]::Escape($root), '<tmp>') ($($m.refused -replace [regex]::Escape($root), '<tmp>'))"
  }
  $m = Get-LabWbMountArgs @("src/repo/gaps.ts=$mut", "src/repo/gaps.ts=$mut") $fakeWb
  Ok ($m.refused -match 'twice') 'the same target twice is refused'

  # ---- T3: the green-image guard (attempt 3: the image ID, the tree, the gate markers, /app/src) -----------------------
  Write-Host '[T3] Assert-LabGreenImage'
  # run against an OLDER helper (-Helper <copy>) the attack cases must FAIL one by one, not crash: give the test what it
  # needs to set the cases up (the expected /app/src, an ID resolver) when the helper lacks them
  if (-not (Get-Command Get-LabAppExpected -ErrorAction SilentlyContinue)) {
    function Get-LabAppExpected([string]$Ob1, [string]$Kind) {
      $h = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([System.StringComparer]::Ordinal)
      $sha = [System.Security.Cryptography.SHA256]::Create(); $l1 = [System.Text.Encoding]::GetEncoding(28591)
      foreach ($r in @(& git -C $Ob1 ls-files -- 'docker/workbench/deno.json' 'docker/workbench/deno.lock' 'docker/workbench/THIRD-PARTY-NOTICES.md' 'docker/workbench/gate' 'docker/workbench/csl' 'docker/workbench/src')) {
        $rel = "$r".Substring('docker/workbench/'.Length)
        if ($Kind -eq 'runtime' -and ($rel -match '^src/.*_test\.ts$' -or $rel -eq 'src/export/credentials_oracle.ts')) { continue }
        $raw = $l1.GetString([System.IO.File]::ReadAllBytes((Join-Path $Ob1 $r)))
        $h["./$rel"] = [System.BitConverter]::ToString($sha.ComputeHash($l1.GetBytes($raw.Replace("`r", '')))).Replace('-', '').ToLower()
      }
      return ,$h
    }
  }
  if (-not (Get-Command Resolve-LabImageId -ErrorAction SilentlyContinue)) {
    function Resolve-LabImageId([string]$Ref) { $o = "$(Dk image inspect --format '{{.Id}}' $Ref)".Trim(); if ($script:rc -ne 0) { return '' }; return $o }
  }
  $guardTakesTree = (Get-Command Assert-LabGreenImage).Parameters.ContainsKey('Ob1')
  if (-not $guardTakesTree) { Write-Host '  NOTE  this helper''s guard takes no OB1 tree (an older helper): the cases below show what it lets through' }
  $hasViewerGuard = [bool](Get-Command Assert-LabViewerImage -ErrorAction SilentlyContinue)
  $r3 = Join-Path $root 'ob1-t3'; New-Item -ItemType Directory -Force (Join-Path $r3 'docker\workbench\src\export') | Out-Null
  $g3 = { param([string[]]$x) $p = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { & git -C $r3 @x 2>&1 | Out-Null } finally { $ErrorActionPreference = $p } }
  & $g3 @('init', '-q'); & $g3 @('config', 'user.email', 't@example.invalid'); & $g3 @('config', 'user.name', 't'); & $g3 @('config', 'commit.gpgsign', 'false')
  [System.IO.File]::WriteAllText((Join-Path $r3 'docker\workbench\Dockerfile'), "FROM x`n")
  [System.IO.File]::WriteAllText((Join-Path $r3 'docker\workbench\deno.json'), "{ `"imports`": {} }`n")
  New-Item -ItemType Directory -Force (Join-Path $r3 'docker\wiki-viewer') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $r3 'docker\wiki-viewer\Dockerfile'), "FROM y`n")
  [System.IO.File]::WriteAllText((Join-Path $r3 'docker\workbench\src\a.ts'), "export const a = 1;`r`n")
  [System.IO.File]::WriteAllText((Join-Path $r3 'docker\workbench\src\a_test.ts'), "test`n")
  [System.IO.File]::WriteAllText((Join-Path $r3 'docker\workbench\src\export\credentials_oracle.ts'), "oracle`n")
  & $g3 @('add', '-A'); & $g3 @('commit', '-q', '-m', 'one')
  $tree3 = "$(& git -C $r3 rev-parse 'HEAD^{tree}')".Trim()
  $wantRt = Get-LabAppExpected $r3 'runtime'; $wantTs = Get-LabAppExpected $r3 'test'
  Ok ($wantRt.Count -eq 2 -and $wantRt.ContainsKey('./src/a.ts') -and $wantRt.ContainsKey('./deno.json') -and $wantTs.Count -eq 4) "the expected /app: every copied input (deno.json and src here); runtime drops *_test.ts and the oracle ($($wantRt.Count) / $($wantTs.Count) files)"
  $crlfFree = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::ASCII.GetBytes("export const a = 1;`n"))).Replace('-', '').ToLower()
  Ok ($wantRt['./src/a.ts'] -eq $crlfFree) 'a file is hashed with its CR bytes removed (a CRLF checkout equals the LF image copy)'
  function New-Img([string]$tag, [hashtable]$o) {
    $lb = @{ 'ai-stack.lab.gate' = 'full'; 'ai-stack.lab.tree' = $tree3 }
    if ($o.ContainsKey('labels')) { $lb = $o.labels }
    $src = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([System.StringComparer]::Ordinal)
    foreach ($k in $(if ($o.kind -eq 'test') { $wantTs.Keys } else { $wantRt.Keys })) { $src[$k] = $(if ($o.kind -eq 'test') { $wantTs[$k] } else { $wantRt[$k] }) }
    if ($o.mutate) { $src['./src/a.ts'] = ('0' * 64) }
    if ($o.extra) { $src['./src/evil.ts'] = ('1' * 64) }
    # X1: the mutant under the real name, the original under a near-twin name (a trailing space / another letter case)
    if ($o.twin) { $orig = $src['./src/a.ts']; $src['./src/a.ts'] = ('0' * 64); $src[$o.twin] = $orig }
    # X2: a copied input other than src replaced (an import map), and a module outside src
    if ($o.denojson) { $src['./deno.json'] = ('2' * 64) }
    if ($o.outside) { $src['./mut/lifecycle.ts'] = ('3' * 64) }
    $script:images[$tag] = @{ id = (New-FakeId); labels = $lb; markers = $(if ($o.ContainsKey('markers')) { $o.markers } else { 'p' }); app = $src }
  }
  function Try-Guard([string]$tag, [string]$mode = 'green', [string]$kind = 'runtime') {
    $f0 = $script:fail; $id = ''; $threw = $false
    try { if ($guardTakesTree) { $id = Assert-LabGreenImage $tag $mode $r3 $kind } else { $id = Assert-LabGreenImage $tag $mode } } catch { $threw = $true }
    return @{ threw = $threw; id = [string]$id; fails = $script:fail - $f0; line = $script:lines[-1] }
  }
  New-Img 'wb:good' @{}; New-Img 'wb:good-test' @{ kind = 'test' }
  $x = Try-Guard 'wb:good'
  Ok (-not $x.threw -and $x.id -eq $script:images['wb:good'].id -and $x.id -match '^sha256:') "this tree's full-gate runtime image passes and the guard RETURNS ITS IMAGE ID ($(([string]$x.id + (" " * 19)).Substring(0, 19))...)"
  $x = Try-Guard 'wb:good-test' 'landing' 'test'
  Ok (-not $x.threw -and $x.id -eq $script:images['wb:good-test'].id) 'and the test stage (its *_test.ts and the oracle included), for a landing'
  $x = Try-Guard 'wb:good' 'green' 'test'
  Ok ($x.threw -and $x.line -match 'missing \./(src/)?a_test\.ts') 'a runtime image offered as the test stage is refused (its tests are missing)'
  foreach ($c in @(
      @('skip', @{ labels = @{ 'ai-stack.lab.gate' = 'skipped'; 'ai-stack.lab.tree' = $tree3 }; markers = 's' }, 'gate markers', 'a skip-gate image'),
      @('forged', @{ markers = 's' }, 'gate markers', 'D1: a forged label (gate=full) over the skipped marker'),
      @('empty', @{ labels = @{ 'ai-stack.lab.gate' = ''; 'ai-stack.lab.tree' = $tree3 }; markers = 's' }, 'gate markers', 'D1: an EMPTY label over the skipped marker'),
      @('nomarker', @{ markers = '' }, 'gate markers', 'no passed marker'),
      @('both', @{ markers = 'ps' }, 'gate markers', 'both markers'),
      @('a4', @{ labels = @{ 'ai-stack.lab.gate' = 'full'; 'ai-stack.lab.tree' = ('e' * 40) }; markers = 'p'; mutate = $true }, 'built from tree', 'A4: forged markers on another tree''s skip image'),
      @('a5', @{ mutate = $true }, 'differs \./(src/)?a\.ts', 'A5: a full-gate image of this tree with mutant code copied on top'),
      @('a5x', @{ extra = $true }, "extra '?\./(src/)?evil\.ts", 'A5: a full-gate image with an extra module added'),
      @('x1', @{ twin = './src/a.ts ' }, "differs \./src/a\.ts|extra '\./src/a\.ts '", 'X1: the original under a trailing-space twin name, the mutant under the real name'),
      @('x1c', @{ twin = './src/A.ts' }, "differs \./src/a\.ts|extra '\./src/A\.ts'", 'X1: the original under another letter case, the mutant under the real name (case-sensitive)'),
      @('x2', @{ denojson = $true; outside = $true }, 'differs \./deno\.json|extra ''\./mut/lifecycle\.ts''', 'X2: deno.json (the import map) replaced and a module outside src added'),
      @('x2o', @{ outside = $true }, "extra '\./mut/lifecycle\.ts'", 'X2: a module outside /app/src only'),
      @('a6', @{ labels = @{ 'ai-stack.lab.gate' = 'full'; 'ai-stack.lab.tree' = ('2' * 40) } }, 'built from tree', 'A6: a full-gate image of an older tree of this branch'),
      @('a6b', @{ labels = @{ 'org.opencontainers.image.revision' = 'a155c44b' } }, 'no ai-stack.lab.tree label', 'A6b: another tester''s image with no tree label (built before rw-lab-throughput)'),
      @('dirty', @{ labels = @{ 'ai-stack.lab.gate' = 'full'; 'ai-stack.lab.tree' = $tree3; 'ai-stack.lab.dirty' = '1' } }, 'dirty working tree', 'an image built from a dirty working tree'))) {
    New-Img "wb:$($c[0])" $c[1]
    $x = Try-Guard "wb:$($c[0])"
    Ok ($x.threw -and $x.fails -eq 1 -and $x.line -match $c[2]) "REFUSED: $($c[3])"
  }
  $x = Try-Guard 'wb:absent'
  Ok ($x.threw -and $x.fails -eq 1) 'an image that cannot be inspected fails closed'
  $f0 = $script:fail; $threw = $false
  try { if ($guardTakesTree) { $null = Assert-LabGreenImage 'wb:good' 'green' '' } else { $null = Assert-LabGreenImage 'wb:good' 'green' } } catch { $threw = $true }
  Ok ($threw -and $script:fail -eq $f0 + 1) 'the guard refuses when it is given no OB1 tree to bind to'
  # the tree under test is dirty: no green at all
  [System.IO.File]::WriteAllText((Join-Path $r3 'docker\workbench\src\a.ts'), "export const a = 2;`n")
  $x = Try-Guard 'wb:good'
  Ok ($x.threw -and $x.line -match 'uncommitted changes') 'with uncommitted changes in the workbench inputs, a green run is refused (it tests a committed tree)'
  & $g3 @('checkout', '--', 'docker/workbench/src/a.ts')
  [System.IO.File]::WriteAllText((Join-Path $r3 'NOTES.md'), "outside the inputs`n")
  $x = Try-Guard 'wb:good'
  Ok (-not $x.threw) 'an untracked file OUTSIDE the workbench inputs does not make the tree dirty'
  Remove-Item -Force (Join-Path $r3 'NOTES.md')
  # A7: the ID is what the run uses; re-pointing the tag afterwards does not change what was checked
  $x = Try-Guard 'wb:good'
  New-Img 'wb:swap' @{ labels = @{ 'ai-stack.lab.gate' = 'skipped'; 'ai-stack.lab.tree' = $tree3 }; markers = 's' }
  $script:images['wb:good-kept'] = $script:images['wb:good']   # a real daemon keeps the checked image by its ID
  $script:images['wb:good'] = $script:images['wb:swap']
  Ok ($x.id -ne (Resolve-LabImageId 'wb:good') -and (Resolve-LabImageId $x.id) -eq $x.id) 'A7: after the tag is re-pointed, the checked ID still names the checked image (the run uses the ID)'
  $helperT = [System.IO.File]::ReadAllText($Helper)
  Ok ($helperT -match [regex]::Escape("`$res.wb = Assert-LabGreenImage `$res.wb `$Run.mode `$Ob1 'runtime'") -and $helperT -match [regex]::Escape("`$res.test = Assert-LabGreenImage `$res.test `$Run.mode `$Ob1 'test'")) 'A7: Invoke-LabWorkbenchImages hands the runner the checked IDs'
  foreach ($rn in @('run-docs-lifecycle-tests.ps1', 'run-panels-tests.ps1', 'run-room-tests.ps1')) {
    $rt = [System.IO.File]::ReadAllText((Join-Path $here $rn))
    Ok ($rt -match [regex]::Escape("`$wbTag = Assert-LabGreenImage `$wbTag `$run.mode `$ob1 'runtime'") -and $rt -match [regex]::Escape("`$wbTestTag = Assert-LabGreenImage `$wbTestTag `$run.mode `$ob1 'test'") -and $rt -match '-Prebuilt \$Prebuilt') "A7/A8: $rn runs the checked IDs of its -Prebuilt images and passes -Prebuilt to Resolve-LabRun"
  }
  $allRunners = @(Get-ChildItem $here -Filter 'run-*.ps1' | Where-Object { [System.IO.File]::ReadAllText($_.FullName) -match 'Assert-LabGreenImage' })
  $bare = @($allRunners | Where-Object { [System.IO.File]::ReadAllText($_.FullName) -match '(?m)^\s*(if \(.*\) \{ )?Assert-LabGreenImage ' })
  Ok ($bare.Count -eq 0) "no runner calls the guard without running the ID it returns ($(($bare | ForEach-Object { $_.Name }) -join ', '))"
  # X3: the viewer, a companion image, is tree-bound and ID-pinned on -Prebuilt too
  $script:images['vw:good'] = @{ id = (New-FakeId); labels = @{ 'ai-stack.lab.tree' = $tree3 }; markers = ''; app = @{} }
  $script:images['vw:other'] = @{ id = (New-FakeId); labels = @{ 'ai-stack.lab.tree' = ('9' * 40) }; markers = ''; app = @{} }
  $script:images['vw:old'] = @{ id = (New-FakeId); labels = @{ 'x' = 'y' }; markers = ''; app = @{} }
  $vg = { param($t) $f0 = $script:fail; $id = ''; $th = $false; try { if ($hasViewerGuard) { $id = [string](Assert-LabViewerImage $t 'green' $r3) } else { $th = $false; $id = 'no-guard' } } catch { $th = $true }; @{ threw = $th; id = $id; fails = $script:fail - $f0; line = $script:lines[-1] } }
  $x = & $vg 'vw:good'
  Ok ($hasViewerGuard -and -not $x.threw -and $x.id -eq $script:images['vw:good'].id) 'X3: this tree''s viewer passes the viewer guard and the guard returns its ID'
  $x = & $vg 'vw:other'
  Ok ($hasViewerGuard -and $x.threw -and $x.line -match 'built from tree') 'X3: another tree''s viewer is REFUSED'
  $x = & $vg 'vw:old'
  Ok ($hasViewerGuard -and $x.threw -and $x.line -match 'no ai-stack.lab.tree label') 'X3: an unlabelled viewer is REFUSED'
  [System.IO.File]::WriteAllText((Join-Path $r3 'docker\wiki-viewer\x.js'), "drift`n")
  $x = & $vg 'vw:good'
  Ok ($hasViewerGuard -and $x.threw -and $x.line -match 'uncommitted changes') 'X3: uncommitted changes under docker/wiki-viewer refuse a green run''s viewer'
  Remove-Item -Force (Join-Path $r3 'docker\wiki-viewer\x.js')
  foreach ($rn in @('run-docs-lifecycle-tests.ps1', 'run-panels-tests.ps1', 'run-room-tests.ps1')) {
    $rt = [System.IO.File]::ReadAllText((Join-Path $here $rn))
    Ok ($rt -match [regex]::Escape("`$viewerTag = Assert-LabViewerImage `$viewerTag `$run.mode `$ob1") -and $rt -match [regex]::Escape("`$viewerTag = Resolve-LabImageId `$viewerTag")) "X3: $rn guards and ID-pins its -Prebuilt viewer"
  }
  Ok ($helperT -match [regex]::Escape("`$res.viewer = Assert-LabViewerImage `$res.viewer `$Run.mode `$Ob1")) 'X3: Invoke-LabWorkbenchImages guards the viewer of a green or landing run'
  foreach ($rn in @('run-identity-tests.ps1', 'run-sessions-tests.ps1', 'run-trust-tests.ps1', 'run-workspace-tests.ps1')) {
    $rt = [System.IO.File]::ReadAllText((Join-Path $here $rn))
    Ok ($rt -match '\[switch\]\$Prebuilt' -and $rt -match 'this runner has no -Prebuilt mode' -and $rt -match '-Prebuilt \$Prebuilt') "$rn declares -Prebuilt only to refuse it (and -Landing -Prebuilt)"
  }
  # A8: a landing never takes prebuilt images
  $r = $null; try { $r = Resolve-LabRun -Landing $true -Prebuilt $true } catch { }
  Ok ($r -and $r.refused -match '-Prebuilt is refused') "A8: -Landing -Prebuilt is refused ($(if ($r) { $r.refused } else { 'Resolve-LabRun takes no -Prebuilt' }))"
  $r = $null; try { $r = Resolve-LabRun -Prebuilt $true } catch { }
  Ok ($r -and -not $r.refused) 'a green -Prebuilt run is still allowed (its images then face the guard)'
  # the documented residual (threat model): a deliberate forger of THIS tree's own skip image with a fake passed marker
  New-Img 'wb:residual' @{ markers = 'p' }
  $x = Try-Guard 'wb:residual'
  Write-Host "  INFO  threat model residual: a same-tree skip image with a FORGED passed marker is indistinguishable here ($(if ($x.threw) { 'refused' } else { 'accepted' })): its code is the tree's; only its claim that the gate ran is false"

  # ---- T4: image reuse by tree ----------------------------------------------------------------------------------------
  Write-Host '[T4] Invoke-LabImage: reuse by tree hash + args digest'
  $repo = Join-Path $root 'ob1'; New-Item -ItemType Directory -Force (Join-Path $repo 'docker\workbench') | Out-Null
  $g = { param([string[]]$x) $p = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { & git -C $repo @x 2>&1 | Out-Null } finally { $ErrorActionPreference = $p } }
  & $g @('init', '-q'); & $g @('config', 'user.email', 't@example.invalid'); & $g @('config', 'user.name', 't'); & $g @('config', 'commit.gpgsign', 'false')
  [System.IO.File]::WriteAllText((Join-Path $repo 'docker\workbench\a.txt'), "one`n")
  & $g @('add', '-A'); & $g @('commit', '-q', '-m', 'one')
  $env:OB1_LAB_BUILD_LEASE = 'off'
  $sha1 = "$(& git -C $repo rev-parse HEAD)".Trim()
  $ctx = Join-Path $repo 'docker\workbench'
  $common = @{ Repo = 'openbrain-workbench'; Context = $ctx; Ob1 = $repo; BuildArgs = @{ OB1_SHA = $sha1 }; OwnerTag = 'openbrain-workbench:wt-unit'; Owner = 'wt-unit'; DirtyPaths = @('docker/workbench'); GateImage = $true }
  $script:builds = @()
  $i1 = Invoke-LabImage @common
  Ok ($i1.rc -eq 0 -and -not $i1.reused -and $i1.tag -match '^openbrain-workbench:wt-tree-[0-9a-f]{12}-[0-9a-f]{12}$' -and $script:builds.Count -eq 1) "the first run builds and tags by tree ($($i1.tag))"
  $b = $script:builds[0] -join ' '
  Ok ($b -match [regex]::Escape("ai-stack.lab.tree=$($i1.key.tree)") -and $b -match [regex]::Escape("ai-stack.lab.args=$($i1.key.args)") -and $b -match 'WORKBENCH_TEST_GATE=full') 'the build carries the full tree hash, the args digest and the full gate'
  $i2 = Invoke-LabImage @common
  Ok ($i2.reused -and $i2.tag -eq $i1.tag -and $script:builds.Count -eq 1) 'a second run on the same tree builds nothing: it reuses the tag'
  $tree1 = $i1.key.tree
  # a planted tag: the same name, a wrong tree label
  $script:images[$i1.tag].labels['ai-stack.lab.tree'] = ('0' * 40)
  $i3 = Invoke-LabImage @common
  Ok (-not $i3.reused -and $script:builds.Count -eq 2 -and $script:images[$i1.tag].labels['ai-stack.lab.tree'] -eq $tree1) 'a planted tag with a wrong tree label is NOT reused: it is rebuilt'
  $script:images[$i1.tag].labels['ai-stack.lab.args'] = ('f' * 64)
  $i3b = Invoke-LabImage @common
  Ok (-not $i3b.reused -and $script:builds.Count -eq 3) 'a planted tag with a wrong args label is NOT reused'
  # attempt 1 D1 / U8 case 4: every label right, but the image holds the skipped marker (a skip image relabelled full)
  $script:images[$i1.tag].markers = 's'
  $i3c = Invoke-LabImage @common
  Ok (-not $i3c.reused -and $script:builds.Count -eq 4 -and $script:images[$i1.tag].markers -eq 'p') 'a reuse tag with the right labels but the skipped marker inside is NOT reused: rebuilt'
  $script:builds = @($script:builds[0..2])
  # another tree
  [System.IO.File]::WriteAllText((Join-Path $repo 'docker\workbench\a.txt'), "two`n")
  & $g @('commit', '-q', '-am', 'two')
  $sha2 = "$(& git -C $repo rev-parse HEAD)".Trim()
  $c2 = $common.Clone(); $c2.BuildArgs = @{ OB1_SHA = $sha2 }
  $i4 = Invoke-LabImage @c2
  Ok (-not $i4.reused -and $i4.tag -ne $i1.tag -and $script:builds.Count -eq 4) 'a different tree gets its own tag and builds'
  # the other tree's planted image under THIS tree's tag name
  $script:images[$i4.tag].labels['ai-stack.lab.tree'] = $tree1
  $i5 = Invoke-LabImage @c2
  Ok (-not $i5.reused -and $script:builds.Count -eq 5) "another tree's labels under this tree's tag: never reused"
  # same args, different tree via -Rev (an archive build of the first commit) reuses the first tree's image only
  $c3 = $common.Clone(); $c3.Rev = $sha1
  $i6 = Invoke-LabImage @c3
  Ok ($i6.reused -and $i6.tag -eq $i1.tag) 'an archive build at the first commit reuses the first tree''s image'
  # dirty tree: no reuse tag at all
  [System.IO.File]::WriteAllText((Join-Path $repo 'docker\workbench\b.txt'), "untracked`n")
  $i7 = Invoke-LabImage @c2
  Ok (-not $i7.reused -and $i7.tag -eq 'openbrain-workbench:wt-unit' -and $script:builds.Count -eq 6) 'a dirty context builds under the owner tag and is never keyed for reuse'
  Remove-Item -Force (Join-Path $repo 'docker\workbench\b.txt')
  $c4 = $c2.Clone(); $c4.NoReuse = $true
  $i8 = Invoke-LabImage @c4
  Ok (-not $i8.reused -and $i8.tag -eq 'openbrain-workbench:wt-unit') '-NoReuse builds under the owner tag'
  # skip-gate: another digest, labelled skipped, and a full image is never reused as skipped (or back)
  $c5 = $c2.Clone(); $c5.SkipGate = $true
  $nb = $script:builds.Count
  $i9 = Invoke-LabImage @c5
  Ok (-not $i9.reused -and $i9.tag -ne $i4.tag -and $script:images[$i9.tag].labels['ai-stack.lab.gate'] -eq 'skipped' -and $script:builds.Count -eq $nb + 1) 'a skip-gate build has its own tag and is labelled skipped'
  Ok (($script:builds[-1] -join ' ') -match 'WORKBENCH_TEST_GATE=skipped') 'and passes WORKBENCH_TEST_GATE=skipped'
  $script:images[$i9.tag].labels['ai-stack.lab.gate'] = 'full'
  $i10 = Invoke-LabImage @c5
  Ok (-not $i10.reused) 'a skip-gate tag whose gate label says full is not reused'
  $script:images[$i4.tag].labels['ai-stack.lab.tree'] = $i4.key.tree
  $script:images[$i4.tag].labels['ai-stack.lab.gate'] = 'skipped'
  $i11 = Invoke-LabImage @c2
  Ok (-not $i11.reused -and $script:images[$i4.tag].labels['ai-stack.lab.gate'] -eq 'full') 'a full-gate tag whose gate label says skipped is not reused (rebuilt full)'
  # a Dockerfile that does not know the arg: the skip build is caught by the label check
  $script:gateAware = $false
  $c6 = $c2.Clone(); $c6.SkipGate = $true; $c6.NoReuse = $true
  $f0 = $script:fail
  $i12 = Invoke-LabImage @c6
  Ok ($i12.rc -ne 0 -and $script:fail -ge $f0 + 1) 'a skip-gate build whose image is not labelled skipped (and holds the passed marker) fails (an older Dockerfile)'
  $script:gateAware = $true
  # the shim's tag rule
  Ok ((Test-LabBuildTag 'openbrain-workbench:wt-unit' 'unit') -and (Test-LabBuildTag 'openbrain-workbench:wt-unit-test' 'unit') -and (Test-LabBuildTag $i1.tag 'unit')) 'the shim accepts the run''s :wt-<id> tags and a :wt-tree- reuse tag'
  Ok (-not (Test-LabBuildTag 'openbrain-workbench:local' 'unit') -and -not (Test-LabBuildTag 'openbrain-workbench:wt-tree-abc' 'unit') -and -not (Test-LabBuildTag 'openbrain-workbench:wt-other' 'unit')) 'and refuses :local, a malformed tree tag and another run''s tag'

  # ---- T5: the skip-gate Dockerfile for an older tree ----------------------------------------------------------------
  Write-Host '[T5] Convert-LabDockerfileSkipGate (a red base whose Dockerfile predates the arg)'
  $baseDf = Join-Path $root 'base-Dockerfile'
  $p = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $baseText = (& git -C $ob1Real show '57cc0eef:docker/workbench/Dockerfile' 2>$null) -join "`n"
  $ErrorActionPreference = $p
  [System.IO.File]::WriteAllText($baseDf, $baseText + "`n")
  $w = Convert-LabDockerfileSkipGate $baseDf $ob1Real
  $t = [System.IO.File]::ReadAllText($baseDf)
  $testStage = @($t -split '(?m)^FROM ' | Where-Object { $_ -match '^app AS test' })[0]
  Ok ($baseText.Length -gt 1000 -and -not $w) 'the base Dockerfile (57cc0eef) is rewritten'
  Ok ($testStage -notmatch 'deno test' -and $testStage -match 'ai-stack\.lab\.gate="skipped"' -and $testStage -match '\.test-gate-skipped') 'its test stage runs no deno test, is labelled skipped and writes the skipped marker'
  Ok ($t -match 'COPY --from=test /app/\.test-gate-\* /app/' -and $t -notmatch 'COPY --from=test /app/\.test-gate-passed') 'its runtime copies whichever marker exists'
  $crlfDf = Join-Path $root 'base-Dockerfile-crlf'
  [System.IO.File]::WriteAllText($crlfDf, (($baseText -replace "`r", '') -replace "`n", "`r`n") + "`r`n")
  $w = Convert-LabDockerfileSkipGate $crlfDf $ob1Real
  $tc = [System.IO.File]::ReadAllText($crlfDf)
  Ok (-not $w -and $tc -match '\.test-gate-skipped' -and $tc -notmatch 'touch /app/\.test-gate-passed') "a CRLF copy (git archive under core.autocrlf) is rewritten too ($w)"
  $w = Convert-LabDockerfileSkipGate (Join-Path $wbDir 'Dockerfile') $ob1Real
  Ok ($w -match 'inside the OB1 working tree') 'the working tree''s own Dockerfile is never rewritten'
  $cur = Join-Path $root 'cur-Dockerfile'; Copy-Item (Join-Path $wbDir 'Dockerfile') $cur
  $before = [System.IO.File]::ReadAllText($cur)
  $w = Convert-LabDockerfileSkipGate $cur $ob1Real
  Ok (-not $w -and [System.IO.File]::ReadAllText($cur) -eq $before) 'a Dockerfile that knows WORKBENCH_TEST_GATE is left as it is (the build arg does it)'

  # ---- T6: the full gate is the same gate ------------------------------------------------------------------------------
  Write-Host '[T6] the green image runs the unchanged gate'
  $curText = [System.IO.File]::ReadAllText((Join-Path $wbDir 'Dockerfile')) -replace "`r", ''
  $baseGate = ([regex]'(?m)^RUN deno test ([^\n]*?) \\\n  && touch /app/\.test-gate-passed').Match(($baseText -replace "`r", ''))
  $curGate = ([regex]'(?m)^      full\) deno test ([^\n]*?) \\\n        && touch /app/\.test-gate-passed ;;').Match($curText)
  Ok ($baseGate.Success -and $curGate.Success -and $baseGate.Groups[1].Value -eq $curGate.Groups[1].Value) 'the full branch runs byte-for-byte the deno test command of 57cc0eef (same files, same flags)'
  Ok ($curText -match '(?m)^ARG WORKBENCH_TEST_GATE=full$' -and @([regex]::Matches($curText, '(?m)^LABEL ai-stack\.lab\.gate="\$\{WORKBENCH_TEST_GATE\}"$')).Count -eq 2) 'the default is full and both the test and runtime stages carry the label'
  Ok ($curText -match '\*\) echo "WORKBENCH_TEST_GATE must be full or skipped') 'any other value fails the build'

  # ---- T7: the chain digest ----------------------------------------------------------------------------------------------
  Write-Host '[T7] Get-LabChainDigest'
  $st = Join-Path $root 'stage'; New-Item -ItemType Directory -Force $st | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $st '010-a.sql'), "create table a();`n"); [System.IO.File]::WriteAllText((Join-Path $st '020-b.sql'), "create table b();`n")
  $d1 = Get-LabChainDigest $st 'pg:16'
  Ok ($d1 -eq (Get-LabChainDigest $st 'pg:16')) 'the same chain digests the same'
  [System.IO.File]::WriteAllText((Join-Path $st '020-b.sql'), "create table b ();`n")
  $d2 = Get-LabChainDigest $st 'pg:16'
  Ok ($d2 -ne $d1) 'one changed byte changes the digest'
  Rename-Item (Join-Path $st '020-b.sql') '030-b.sql'
  Ok ((Get-LabChainDigest $st 'pg:16') -ne $d2) 'a moved slot changes the digest'
  Ok ((Get-LabChainDigest $st 'pg:17') -ne (Get-LabChainDigest $st 'pg:16')) 'another postgres image changes the digest'
  $script:images['pg:16'] = @{ labels = @{}; id = ('sha256:' + ('a' * 64)) }
  $dA = Get-LabChainDigest $st 'pg:16'
  $script:images['pg:16'].id = ('sha256:' + ('b' * 64))
  $dB = Get-LabChainDigest $st 'pg:16'
  $script:images['pg:other-name'] = @{ labels = @{}; id = ('sha256:' + ('b' * 64)) }
  Ok ($dA -ne $dB -and $dB -eq (Get-LabChainDigest $st 'pg:other-name')) 'the digest follows the postgres image ID, not its reference (a re-pushed tag is another template)'

  # ---- T9: the build bound and the build lease's TTL ---------------------------------------------------------------
  Write-Host '[T9] Get-LabBuildTimeoutSec'
  Remove-Item Env:OB1_LAB_BUILD_TIMEOUT_SEC -ErrorAction SilentlyContinue
  Ok ((Get-LabBuildTimeoutSec) -eq 5400) 'the default build bound is 5400 s (the old 2400 s killed a cold build at 100 % host CPU)'
  $env:OB1_LAB_BUILD_TIMEOUT_SEC = '7'
  Ok ((Get-LabBuildTimeoutSec) -eq 7) 'OB1_LAB_BUILD_TIMEOUT_SEC overrides it'
  foreach ($badv in @('0', '-5', 'abc', '')) { $env:OB1_LAB_BUILD_TIMEOUT_SEC = $badv; Ok ((Get-LabBuildTimeoutSec) -eq 5400) "a bad override '$badv' falls back to 5400" }
  $env:OB1_LAB_BUILD_TIMEOUT_SEC = '4321'
  $c9 = $common.Clone(); $c9.NoReuse = $true
  $null = Invoke-LabImage @c9
  Ok ($script:lastTimeout -eq 4321) "Invoke-LabImage builds under the bound (Lab-Docker saw $($script:lastTimeout) s)"
  Remove-Item Env:OB1_LAB_BUILD_TIMEOUT_SEC
  $helperText = [System.IO.File]::ReadAllText($Helper)
  Ok ($helperText -match [regex]::Escape('-TtlMin ([int][Math]::Ceiling((Get-LabBuildTimeoutSec) / 60) + 30)')) 'the build lease TTL is the build bound + 30 min (longer than any build)'
  foreach ($rn in @('run-docs-lifecycle-tests.ps1', 'run-identity-tests.ps1', 'run-panels-tests.ps1', 'run-room-tests.ps1', 'run-sessions-tests.ps1', 'run-trust-tests.ps1', 'run-workspace-tests.ps1')) {
    $rt = [System.IO.File]::ReadAllText((Join-Path $here $rn))
    Ok ($rt -match 'function DkLong \{ Lab-Docker \(Get-LabBuildTimeoutSec\)' -and $rt -notmatch 'function DkLong \{ Lab-Docker \d') "$rn builds under Get-LabBuildTimeoutSec"
  }

  # ---- T10: the Windows tar under a Git Bash PATH ------------------------------------------------------------------
  Write-Host '[T10] Get-LabTar'
  $gitUsr = 'C:\Program Files\Git\usr\bin'
  $oldPath = $env:PATH
  try {
    if (Test-Path (Join-Path $gitUsr 'tar.exe')) { $env:PATH = "$gitUsr;$env:PATH" }
    $tarExe = Get-LabTar
    Ok ($tarExe -match '(?i)System32\\tar\.exe$') "Get-LabTar picks Windows tar even with Git's usr\bin first on PATH ($tarExe)"
    $arcSrc = Join-Path $root 'tarsrc'; New-Item -ItemType Directory -Force $arcSrc | Out-Null; [System.IO.File]::WriteAllText((Join-Path $arcSrc 'f.txt'), "x`n")
    $arc = Join-Path $root 'a.tar'; $out = Join-Path $root 'tarout'; New-Item -ItemType Directory -Force $out | Out-Null
    & $tarExe -cf $arc -C $arcSrc f.txt 2>$null
    & (Get-LabTar) -xf $arc -C $out 2>$null
    Ok (Test-Path (Join-Path $out 'f.txt')) 'it unpacks an archive named by a C:\ path'
  } finally { $env:PATH = $oldPath }
  Ok ([System.IO.File]::ReadAllText((Join-Path $here 'run-docs-lifecycle-tests.ps1')) -notmatch '(?m)^\s*& tar ') 'no wired runner calls a bare tar for the red archive (docs-lifecycle)'

  # ---- T11: the DB template's READY read (attempt 3: a docker failure is retried, never a delete) ------------------
  Write-Host '[T11] Initialize-LabDbTemplate: a READY read that fails is retried and never deletes the shared template'
  $st11 = Join-Path $root 'stage11'; New-Item -ItemType Directory -Force $st11 | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $st11 '010-a.sql'), "select 1;`n")
  $pin11 = 'a' * 40; $dig11 = Get-LabChainDigest $st11 'pg:x'
  $vol11 = "ob1-dbtpl-$($pin11.Substring(0, 12))-$($dig11.Substring(0, 12))"
  $script:vols[$vol11] = @{ 'ai-stack.lab.dbtpl' = '1'; 'ai-stack.lab.dbtpl.pin' = $pin11; 'ai-stack.lab.dbtpl.digest' = $dig11 }
  $script:readyMode = 'fail'; $script:volRm = @()
  $t11 = Initialize-LabDbTemplate 'pg:x' $st11 $pin11
  Ok ($t11.refused -match 'could not be read' -and $script:volRm.Count -eq 0 -and $script:vols.ContainsKey($vol11)) "a READY read that keeps failing is refused (the run replays) and the template is NOT removed ($($t11.refused))"
  $script:readyMode = 'ok'; $script:readyContent = "$pin11 $dig11"
  $t11 = Initialize-LabDbTemplate 'pg:x' $st11 $pin11
  Ok (-not $t11.refused -and -not $t11.built -and $script:volRm.Count -eq 0) 'a READY that reads fine is used as before'

  # ---- T8: the build lease (the REAL lease.ps1, a scratch lock dir) -----------------------------------------------------
  Write-Host '[T8] Invoke-LabBuildLease'
  $stack = Join-Path $root 'stack'; $ah = Join-Path $stack 'scripts\agent-harness'
  New-Item -ItemType Directory -Force $ah, (Join-Path $stack 'OB1') | Out-Null
  $realAh = Join-Path (Split-Path -Parent $ob1Real) 'scripts\agent-harness'
  foreach ($f in @('lease.ps1', 'common.ps1', 'config.ps1', 'resolve.ps1', 'git-io.ps1', 'lock.ps1', 'harness.config.json', 'lease-names.conf')) { Copy-Item (Join-Path $realAh $f) $ah }
  $lockDir = Join-Path $root 'locks'; New-Item -ItemType Directory -Force $lockDir | Out-Null
  $env:AI_STACK_LEASE_DIR = $lockDir
  Remove-Item Env:OB1_LAB_BUILD_LEASE -ErrorAction SilentlyContinue
  $script:seen = ''
  $out = Invoke-LabBuildLease 'wt-unit' (Join-Path $stack 'OB1') { $script:seen = (@(Get-ChildItem $lockDir -Filter 'build.*.json') | ForEach-Object { (Get-Content -Raw $_.FullName | ConvertFrom-Json).owner }) -join ','; 'block-result' }
  Ok ($out -eq 'block-result' -and $script:seen -eq 'wt-unit') "the build runs holding one build slot ($($script:seen))"
  Ok (@(Get-ChildItem $lockDir -Filter 'build.*.json').Count -eq 0) 'and releases it afterwards'
  $threw = $false
  try { $null = Invoke-LabBuildLease 'wt-unit' (Join-Path $stack 'OB1') { throw 'build blew up' } } catch { $threw = $true }
  Ok ($threw -and @(Get-ChildItem $lockDir -Filter 'build.*.json').Count -eq 0) 'a failing build still releases its slot'
  if (-not $SkipLease) {
    $now = [int64][System.DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    foreach ($i in 1, 2) { ([ordered]@{ name = "build.$i"; owner = "wt-other$i"; worktree = ''; thread = ''; taken_at = $now; ttl_min = 60; pid = 1 } | ConvertTo-Json) | Set-Content -Encoding ASCII (Join-Path $lockDir "build.$i.json") }
    $env:OB1_LAB_BUILD_WAIT_MIN = '1'
    $script:ranBuild = $false; $threw = $false; $t0 = Get-Date
    try { $null = Invoke-LabBuildLease 'wt-unit' (Join-Path $stack 'OB1') { $script:ranBuild = $true } } catch { $threw = $true }
    Ok ($threw -and -not $script:ranBuild -and ((Get-Date) - $t0).TotalSeconds -ge 55) "with both build slots taken the build WAITS (never runs), then gives up at the bound ($([int]((Get-Date) - $t0).TotalSeconds) s)"
    Remove-Item Env:OB1_LAB_BUILD_WAIT_MIN
  }
  $env:OB1_LAB_BUILD_LEASE = 'off'
  $out = Invoke-LabBuildLease 'wt-unit' (Join-Path $stack 'OB1') { 'unthrottled' }
  Ok ($out -eq 'unthrottled') 'OB1_LAB_BUILD_LEASE=off builds without the lease'
} catch {
  Ok $false "the test stopped: $_"
} finally {
  Remove-Item Env:AI_STACK_LEASE_DIR, Env:OB1_LAB_BUILD_LEASE, Env:OB1_LAB_BUILD_WAIT_MIN -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
if ($script:bad) { Write-Host "$($script:bad) of $($script:n) check(s) FAILED"; exit 1 }
Write-Host "all $($script:n) lab-throughput checks passed"
exit 0
