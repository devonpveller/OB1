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
$script:images = @{}       # tag -> @{ labels }
$script:builds = @()       # every build's arg list
$script:gateAware = $true  # a Dockerfile that knows WORKBENCH_TEST_GATE (false = an older tree)
$script:rc = 0
function Lab-Docker([int]$TimeoutSec, [string[]]$a) {
  $script:rc = 0
  if ($a[0] -eq 'image' -and $a[1] -eq 'inspect') {
    $t = $a[-1]
    if (-not $script:images.ContainsKey($t)) { $script:rc = 1; return "Error: No such image: $t" }
    return ($script:images[$t].labels | ConvertTo-Json -Compress)
  }
  if ($a[0] -eq 'build') {
    $script:builds += , $a
    $labels = [ordered]@{}; $tag = ''; $gate = ''
    for ($i = 0; $i -lt $a.Count; $i++) {
      if ($a[$i] -eq '--label') { $kv = $a[$i + 1]; $j = $kv.IndexOf('='); $labels[$kv.Substring(0, $j)] = $kv.Substring($j + 1) }
      if ($a[$i] -eq '--build-arg' -and $a[$i + 1] -like 'WORKBENCH_TEST_GATE=*') { $gate = $a[$i + 1].Substring(20) }
      if ($a[$i] -eq '-t') { $tag = $a[$i + 1] }
    }
    if ($script:gateAware) { $labels['ai-stack.lab.gate'] = $(if ($gate) { $gate } else { 'full' }) }
    $script:images[$tag] = @{ labels = $labels }
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
  Ok ([bool]$r.refused) '-Sweep on a red run is refused (it ends on the known base red)'
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

  # ---- T3: the green-image guard --------------------------------------------------------------------------------------
  Write-Host '[T3] Assert-LabGreenImage'
  $script:images['openbrain-workbench:wt-unit'] = @{ labels = @{ 'ai-stack.lab.gate' = 'skipped' } }
  $script:images['openbrain-workbench:wt-unit-full'] = @{ labels = @{ 'ai-stack.lab.gate' = 'full' } }
  $script:images['openbrain-workbench:wt-unit-old'] = @{ labels = @{ 'org.opencontainers.image.revision' = 'x' } }
  $f0 = $script:fail; $threw = $false
  try { Assert-LabGreenImage 'openbrain-workbench:wt-unit' 'green' } catch { $threw = $true }
  Ok ($threw -and $script:fail -eq $f0 + 1 -and $script:lines[-1] -match 'REFUSED: .*skip-gate image') 'a skip-gate image FAILS the green guard and stops the run'
  $f0 = $script:fail; $threw = $false
  try { Assert-LabGreenImage 'openbrain-workbench:wt-unit' 'landing' } catch { $threw = $true }
  Ok ($threw -and $script:fail -eq $f0 + 1) 'and the landing guard'
  $f0 = $script:fail; $threw = $false
  try { Assert-LabGreenImage 'openbrain-workbench:wt-unit-full' 'green'; Assert-LabGreenImage 'openbrain-workbench:wt-unit-old' 'green' } catch { $threw = $true }
  Ok (-not $threw -and $script:fail -eq $f0) 'a full-gate image and an image from before the label pass'
  $f0 = $script:fail; $threw = $false
  try { Assert-LabGreenImage 'openbrain-workbench:absent' 'green' } catch { $threw = $true }
  Ok ($threw -and $script:fail -eq $f0 + 1) 'an image that cannot be inspected fails closed'

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
  Ok ($i12.rc -ne 0 -and $script:fail -eq $f0 + 1) 'a skip-gate build whose image is not labelled skipped fails (an older Dockerfile)'
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
} finally {
  Remove-Item Env:AI_STACK_LEASE_DIR, Env:OB1_LAB_BUILD_LEASE, Env:OB1_LAB_BUILD_WAIT_MIN -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
if ($script:bad) { Write-Host "$($script:bad) of $($script:n) check(s) FAILED"; exit 1 }
Write-Host "all $($script:n) lab-throughput checks passed"
exit 0
