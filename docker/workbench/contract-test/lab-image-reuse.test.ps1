# lab-image-reuse.test.ps1 - the docker proof of image reuse by tree (rw-lab-throughput part 2, lab-throughput.ps1), on a
# REAL daemon but a tiny image: a scratch git repository whose Dockerfile is two lines over the lab postgres image (already
# local - nothing is pulled, no unit gate runs). Tags are :wt-tree-<tree>-<args> under the repository name
# lab-reuse-probe; everything is labelled ai-stack.harness.owner=<Id> and removed at the end. No container, no network.
#   R1 two runs on the same tree build once (the second says IMAGE REUSED)
#   R2 a run on another tree builds its own tag
#   R3 a tag planted with another tree's labels (docker tag of the first tree's image) is never used: rebuilt
#   R4 the skip-gate label is what the deploy door (scripts/stack/ob1-deploy.ps1) reads, and the lab shim refuses :local
#
#   powershell -NoProfile -File lab-image-reuse.test.ps1 [-Id wt-lab-reuse-test]
param(
  [string]$Id = 'wt-lab-reuse-test',
  [string]$BaseImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b'
)
$ErrorActionPreference = 'Continue'
$ct = $PSScriptRoot
$label = "ai-stack.harness.owner=$Id"
$script:fail = 0; $script:n = 0
function Pass([string]$m) { $script:n++; Write-Host "  PASS  $m" }
function Fail([string]$m) { $script:n++; Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Lab-Docker([int]$TimeoutSec, [string[]]$a) {
  $all = $a -join ' '
  # run: only the gate-marker probe shape (--rm, --network none)
  if (($a[0] -eq 'run' -and -not ($a -contains '--rm' -and $a -contains 'none')) -or $a[0] -in @('network', 'compose', 'push') -or $all -match '(^|[\s/=])[^\s]*:local(\s|$)') { Write-Host "  SHIM REFUSED: docker $all"; $script:rc = 2; return 'REFUSED' }
  if ($a[0] -eq 'build') { for ($i = 0; $i -lt $a.Count; $i++) { if ($a[$i] -eq '-t' -and $a[$i + 1] -notmatch '^lab-reuse-probe:wt-') { $script:rc = 2; return 'REFUSED tag' } } }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'docker'
  $psi.Arguments = ($a | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { try { $p.Kill() } catch { }; $script:rc = 124; return 'TIMEOUT' }
  $p.WaitForExit(); $script:rc = $p.ExitCode
  return (($out.Result + $err.Result) -replace "`r", '').TrimEnd()
}
function Dk { Lab-Docker 300 ([string[]]$args) }
. (Join-Path $ct 'lab-throughput.ps1')
$env:OB1_LAB_BUILD_LEASE = 'off'   # a two-line image; the build lease is proved by lab-throughput.test.ps1 T8

$root = Join-Path $env:TEMP ('labreuse-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$repo = Join-Path $root 'ob1'; $ctx = Join-Path $repo 'docker\workbench'   # laid out like the workbench: the guard binds docker/workbench/src
New-Item -ItemType Directory -Force $ctx | Out-Null
$tags = @()
function G([string[]]$x) { $p = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { & git -C $repo @x 2>&1 | Out-Null } finally { $ErrorActionPreference = $p } }
try {
  Write-Host "== lab-image-reuse.test  owner=$Id"
  $null = Dk image inspect $BaseImage
  if ($script:rc -ne 0) { Fail "the base image $BaseImage is not local (this test pulls nothing)"; throw 'no base' }
  G @('init', '-q'); G @('config', 'user.email', 't@example.invalid'); G @('config', 'user.name', 't'); G @('config', 'commit.gpgsign', 'false')
  New-Item -ItemType Directory -Force (Join-Path $ctx 'src') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $ctx 'Dockerfile'), "FROM $BaseImage`nARG WORKBENCH_TEST_GATE=full`nLABEL ai-stack.lab.gate=`"`${WORKBENCH_TEST_GATE}`"`nCOPY src /app/src`nRUN if [ `"`$WORKBENCH_TEST_GATE`" = skipped ]; then touch /app/.test-gate-skipped; else touch /app/.test-gate-passed; fi && find /app/src -name '*_test.ts' -delete`n")
  [System.IO.File]::WriteAllText((Join-Path $ctx 'src\a.ts'), "export const v = 'one';`n")
  [System.IO.File]::WriteAllText((Join-Path $ctx 'src\a_test.ts'), "test`n")
  G @('add', '-A'); G @('commit', '-q', '-m', 'one')
  $sha1 = "$(& git -C $repo rev-parse HEAD)".Trim()
  $c = @{ Repo = 'lab-reuse-probe'; Context = $ctx; Ob1 = $repo; BuildArgs = @{ OB1_SHA = $sha1 }; DirtyPaths = @('docker/workbench'); OwnerTag = 'lab-reuse-probe:wt-x'; Owner = $Id; GateImage = $true }

  Write-Host '[R1] the same tree twice'
  $r1 = Invoke-LabImage @c; $tags += $r1.tag
  Check ($r1.rc -eq 0 -and -not $r1.reused) "run 1 builds $($r1.tag)"
  $id1 = "$(Dk image inspect --format '{{.Id}}' $r1.tag)".Trim()
  $r2 = Invoke-LabImage @c
  Check ($r2.rc -eq 0 -and $r2.reused -and $r2.tag -eq $r1.tag) 'run 2 on the same tree builds nothing: IMAGE REUSED'
  $l = Get-LabImageLabels $r1.tag
  Check ($l['ai-stack.lab.tree'] -eq $r1.key.tree -and $l['ai-stack.lab.args'] -eq $r1.key.args -and $l['ai-stack.lab.gate'] -eq 'full') 'the image carries the full tree hash, the args digest and gate=full'

  Write-Host '[R2] another tree'
  [System.IO.File]::WriteAllText((Join-Path $ctx 'src\a.ts'), "export const v = 'two';`n"); G @('commit', '-q', '-am', 'two')
  $sha2 = "$(& git -C $repo rev-parse HEAD)".Trim()
  $c2 = $c.Clone(); $c2.BuildArgs = @{ OB1_SHA = $sha2 }
  $r3 = Invoke-LabImage @c2; $tags += $r3.tag
  $id3 = "$(Dk image inspect --format '{{.Id}}' $r3.tag)".Trim()
  Check ($r3.rc -eq 0 -and -not $r3.reused -and $r3.tag -ne $r1.tag -and $id3 -ne $id1) "another tree builds its own tag ($($r3.tag))"

  Write-Host '[R3] a planted tag: the first tree''s image under the second tree''s tag'
  $null = Dk tag $r1.tag $r3.tag
  Check ("$(Dk image inspect --format '{{.Id}}' $r3.tag)".Trim() -eq $id1) 'planted: the second tree''s tag now points at the first tree''s image'
  $ro = Invoke-LabImage @c2 -ReuseOnly
  Check (-not $ro.reused -and -not $ro.tag) 'a reuse-only lookup refuses it'
  $r4 = Invoke-LabImage @c2
  $id4 = "$(Dk image inspect --format '{{.Id}}' $r3.tag)".Trim()
  Check ($r4.rc -eq 0 -and -not $r4.reused -and $id4 -ne $id1 -and (Get-LabImageLabels $r3.tag)['ai-stack.lab.tree'] -eq $r3.key.tree) 'the planted tag is never used: it is rebuilt from the second tree'

  Write-Host '[R4] the skip-gate label, the deploy door and :local'
  $c3 = $c2.Clone(); $c3.SkipGate = $true
  $r5 = Invoke-LabImage @c3; $tags += $r5.tag
  Check ($r5.rc -eq 0 -and $r5.tag -ne $r3.tag -and (Get-LabImageLabels $r5.tag)['ai-stack.lab.gate'] -eq 'skipped') 'a skip-gate build is its own tag, labelled ai-stack.lab.gate=skipped'
  # the deploy door's own read (ob1-deploy.ps1 after its build), on this image
  $gateLabel = ''
  try { $lj = ("$(& docker image inspect --format '{{json .Config.Labels}}' $r5.tag 2>$null)".Trim()) | ConvertFrom-Json; if ($lj) { $gateLabel = [string]$lj.'ai-stack.lab.gate' } } catch { }
  Check ($gateLabel -eq 'skipped') "the deploy door's label read sees 'skipped' (it then refuses before anything starts)"
  $doorText = [System.IO.File]::ReadAllText((Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $ct)))) 'scripts\stack\ob1-deploy.ps1'))
  Check ($doorText -match [regex]::Escape("--format '{{json .Config.Labels}}' ([string]`$svcCfg.image)") -and $doorText -match "if \(\`$gateLabel -eq 'skipped'\)") 'ob1-deploy.ps1 carries that read and the refusal'
  $o = Dk tag $r5.tag 'lab-reuse-probe:local'
  Check ($script:rc -ne 0 -and $o -match 'REFUSED') 'the lab shim refuses to tag it :local'
  try { $null = Assert-LabGreenImage $r5.tag 'green' $repo 'runtime'; Fail 'the green guard let a skip-gate image through' } catch { Pass 'the green guard refuses it for a green run (the FAIL line above is the guard speaking)'; $script:fail-- ; $script:n-- }

  Write-Host '[R5] attempt 1 D1: a forged or stripped label over a skip image, on a real daemon'
  $forgeDir = Join-Path $root 'forge'; New-Item -ItemType Directory -Force $forgeDir | Out-Null
  foreach ($c in @(@('forged', 'LABEL ai-stack.lab.gate=full'), @('empty', 'LABEL ai-stack.lab.gate='))) {
    [System.IO.File]::WriteAllText((Join-Path $forgeDir 'Dockerfile'), "FROM $($r5.tag)`n$($c[1])`n")
    $ft = "lab-reuse-probe:wt-$($c[0])"
    $null = Dk build --label $label -t $ft $forgeDir; $tags += $ft
    $fl = Get-LabImageLabels $ft
    Check ($script:rc -eq 0 -and $fl['ai-stack.lab.gate'] -ne 'skipped') "the $($c[0]) image's label no longer says skipped ('$($fl['ai-stack.lab.gate'])')"
    Check ((Get-LabGateMarkers $ft) -eq 'skipped') "but its gate markers still say skipped (/app/.test-gate-skipped inside)"
    try { $null = Assert-LabGreenImage $ft 'green' $repo 'runtime'; Fail "the green guard ACCEPTED the $($c[0]) image" } catch { Pass "the green guard refuses the $($c[0]) image by its markers (the FAIL line above is the guard speaking)"; $script:fail--; $script:n-- }
  }
  $goodId = ''
  try { $goodId = Assert-LabGreenImage $r3.tag 'green' $repo 'runtime' } catch { Fail "the green guard refused a real full-gate image ($($r3.tag))" }
  Check ((Get-LabGateMarkers $r3.tag) -eq 'full' -and $goodId -match '^sha256:[0-9a-f]{64}$') "control: this tree's real full-gate image passes, and the guard returns its ID ($goodId)"

  Write-Host '[R6] attempt 2 D1-bis on a real daemon: code on a full image (A5), another tree (A6), a tag swapped after the check (A7)'
  $a5Dir = Join-Path $root 'a5'; New-Item -ItemType Directory -Force $a5Dir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $a5Dir 'a.ts'), "export const v = 'MUTANT';`n")
  [System.IO.File]::WriteAllText((Join-Path $a5Dir 'Dockerfile'), "FROM $($r3.tag)`nCOPY a.ts /app/src/a.ts`n")
  $a5 = 'lab-reuse-probe:wt-a5'; $null = Dk build --label $label -t $a5 $a5Dir; $tags += $a5
  Check ((Get-LabGateMarkers $a5) -eq 'full' -and (Get-LabImageLabels $a5)['ai-stack.lab.tree'] -eq $r3.key.tree) 'A5 planted: every label and marker of this tree''s full image, with mutant code copied on top'
  try { $null = Assert-LabGreenImage $a5 'green' $repo 'runtime'; Fail 'the green guard ACCEPTED code copied onto a full image (A5)' } catch { Pass 'A5: refused by /app/src (the FAIL line above is the guard speaking)'; $script:fail--; $script:n-- }
  Write-Host '[R7] attempt 3 D1-ter on a real daemon: a trailing-space twin name (X1), a file outside /app/src (X2)'
  $x1Dir = Join-Path $root 'x1'; New-Item -ItemType Directory -Force $x1Dir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $x1Dir 'a.ts'), "export const v = 'MUTANT';`n")
  [System.IO.File]::WriteAllText((Join-Path $x1Dir 'Dockerfile'), "FROM $($r3.tag)`nRUN cp /app/src/a.ts '/app/src/a.ts '`nCOPY a.ts /app/src/a.ts`n")
  $x1 = 'lab-reuse-probe:wt-x1'; $null = Dk build --label $label -t $x1 $x1Dir; $tags += $x1
  $x1app = Get-LabImageApp (Resolve-LabImageId $x1)
  Check ($null -ne $x1app -and $x1app.ContainsKey('./src/a.ts ') -and $x1app.ContainsKey('./src/a.ts') -and $x1app['./src/a.ts '] -cne $x1app['./src/a.ts']) 'X1 planted: the probe reads ./src/a.ts and ./src/a.ts<space> as two files (exact paths)'
  try { $null = Assert-LabGreenImage $x1 'green' $repo 'runtime'; Fail 'the green guard ACCEPTED a trailing-space twin (X1)' } catch { Pass 'X1: refused (the FAIL line above is the guard speaking)'; $script:fail--; $script:n-- }
  $x2Dir = Join-Path $root 'x2'; New-Item -ItemType Directory -Force $x2Dir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $x2Dir 'm.ts'), "export const m = 1;`n")
  [System.IO.File]::WriteAllText((Join-Path $x2Dir 'Dockerfile'), "FROM $($r3.tag)`nCOPY m.ts /app/mut/m.ts`n")
  $x2 = 'lab-reuse-probe:wt-x2'; $null = Dk build --label $label -t $x2 $x2Dir; $tags += $x2
  try { $null = Assert-LabGreenImage $x2 'green' $repo 'runtime'; Fail 'the green guard ACCEPTED a module outside /app/src (X2)' } catch { Pass 'X2: a file outside /app/src is refused (the FAIL line above is the guard speaking)'; $script:fail--; $script:n-- }
  try { $null = Assert-LabGreenImage $r1.tag 'green' $repo 'runtime'; Fail 'the green guard ACCEPTED the first tree''s image for the second tree (A6)' } catch { Pass 'A6: the first tree''s full-gate image is refused for the second tree (the FAIL line above is the guard speaking)'; $script:fail--; $script:n-- }
  $null = Dk tag $r5.tag $r3.tag
  $now = Resolve-LabImageId $r3.tag
  Check ($now -ne $goodId -and (Resolve-LabImageId $goodId) -eq $goodId -and (Get-LabGateMarkers $goodId) -eq 'full') "A7: after the tag is re-pointed ($($r3.tag) -> the skip image), the checked ID still names the checked full-gate image - the runner runs that ID"
} catch {
  Fail "the run stopped: $_"
} finally {
  Remove-Item Env:OB1_LAB_BUILD_LEASE -ErrorAction SilentlyContinue
  foreach ($t in ($tags | Sort-Object -Unique)) { if ($t) { $null = Dk rmi -f $t } }
  $left = (Dk images --filter "label=$label" --format '{{.Repository}}:{{.Tag}}' | Out-String).Trim()
  Check (-not $left) "no image labelled $Id is left ($left)"
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
Write-Host "== $(if ($script:fail) { "FAILED ($($script:fail) of $($script:n))" } else { "ALL PASSED ($($script:n))" })"
exit $(if ($script:fail) { 1 } else { 0 })
