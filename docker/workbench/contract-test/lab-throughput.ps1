# lab-throughput.ps1 - the shared throughput rules of the disposable contract-test runners (rw-lab-throughput).
# Dot-sourced by a runner AFTER it defined Dk / DkLong (its lab docker shim), Pass / Fail / Check and $label.
# Five parts, each usable on its own:
#
#   1. Skip-gate images and -WbMount. A red-base or mutant image may be built with WORKBENCH_TEST_GATE=skipped (the
#      Dockerfile then skips its in-build unit gate and labels the image ai-stack.lab.gate=skipped). Resolve-LabRun
#      refuses that for a green or landing run, and Assert-LabGreenImage refuses any image labelled skipped right
#      before a green or landing run uses it. -WbMount 'src/<path>=<host file>' bind-mounts ONE mutated source file over
#      the lab workbench's copy, read-only, so a mutant needs no image build at all (Get-LabWbMountArgs).
#   2. Image reuse by tree. Invoke-LabImage tags what it builds <repo>:wt-tree-<tree12>-<args12> and labels it with the
#      full OB1 tree hash and the build-args digest; a later run on the SAME tree with the SAME args reuses the tag
#      after checking both labels (and the gate label). A tag whose labels do not match is never used: it is rebuilt.
#      A dirty build context is never tagged for reuse.
#   3. DB template per pin. Initialize-LabDbTemplate replays a staged initdb chain ONCE into a docker volume labelled
#      with the OB1 pin and the chain digest (file names + contents + the postgres image); New-LabDbVolume clones it
#      (a volume copy, so the roles the chain creates come along) and the lab's own slot, revert and round-trip
#      steps still run on top. A label mismatch forces a rebuild. lab-dbtemplate.test.ps1 proves a cloned database's
#      schema dump byte-identical to a replayed one.
#   4. The isolation sweep runs once per landing: developer, mutant and red runs skip it by default and say so;
#      -Landing always sweeps and refuses -NoSweep; -Sweep opts a developer run in.
#   5. The build lease: Invoke-LabBuildLease takes one slot of the ai-stack harness 'build' class around an image build
#      only (lease.ps1 -Class build), first come, polling once a minute. OB1_LAB_BUILD_LEASE=off skips it (said aloud).
#
# lab-throughput.test.ps1 is the hermetic proof of the rules (no docker); lab-dbtemplate.test.ps1 and
# lab-image-reuse.test.ps1 need docker and touch nothing but their own labelled containers, images and volumes.

$script:LabGateLabel = 'ai-stack.lab.gate'
$script:LabTreeLabel = 'ai-stack.lab.tree'
$script:LabArgsLabel = 'ai-stack.lab.args'
$script:LabTplLabel = 'ai-stack.lab.dbtpl'

function Get-LabSha256([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return (($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $sha.Dispose() }
}
function Get-LabFileSha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $fs = [System.IO.File]::OpenRead($Path)
  try { return (($sha.ComputeHash($fs) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $fs.Dispose(); $sha.Dispose() }
}

# ---- part 4 (+ the part-1 guards): what kind of run this is ---------------------------------------------------------
# Returns @{ refused = '' | reason; mode = landing|green|red|mutant; sweep = bool; note = the line to print }.
function Resolve-LabRun {
  param([bool]$Red = $false, [bool]$Landing = $false, [bool]$NoSweep = $false, [bool]$Sweep = $false,
        [bool]$Mutant = $false, [string[]]$WbMount = @(), [bool]$SkipGate = $false, [bool]$Prebuilt = $false)
  $r = @{ refused = ''; mode = 'green'; sweep = $false; note = '' }
  $mounts = @($WbMount | Where-Object { $_ })
  if ($Red) { $r.mode = 'red' } elseif ($Mutant -or $mounts.Count) { $r.mode = 'mutant' }
  if ($Landing) {
    if ($Red) { $r.refused = 'a landing run is never -Red'; return $r }
    if ($Mutant -or $mounts.Count) { $r.refused = 'a landing run takes no -Mutant / -WbMount (it tests the tree as it is)'; return $r }
    if ($SkipGate) { $r.refused = 'a landing run never uses a skip-gate image (-SkipGate): the full unit gate runs for every landing image'; return $r }
    if ($NoSweep) { $r.refused = 'a landing run always runs the isolation sweep: -NoSweep is refused'; return $r }
    # test attempt 2, A8: a landing tests the tree as it is, so it builds (or reuses, labels and content checked) its own
    # images; it never takes whatever happens to sit under the run's tags
    if ($Prebuilt) { $r.refused = 'a landing run builds or reuses its own images of the tree under test: -Prebuilt is refused'; return $r }
    $r.mode = 'landing'; $r.sweep = $true
    $r.note = 'RUN MODE landing: the isolation sweep runs (always, for a landing)'
    return $r
  }
  if ($SkipGate -and $r.mode -eq 'green') {
    $r.refused = 'a skip-gate image (-SkipGate) is for red-base and mutant runs only, never a green run (pass -Red, -Mutant or -WbMount)'
    return $r
  }
  if ($Sweep -and $NoSweep) { $r.refused = '-Sweep and -NoSweep together'; return $r }
  # -Sweep on a red run keeps the runners' RED sweep assertions reachable (run-identity-tests.ps1 "RED: the signed-in sweep
  # fails on the base", run-workspace-tests.ps1 "RED: the isolation sweep finds user B's context on the base"). A mutant
  # run has no sweep assertion of its own.
  if ($Sweep -and $r.mode -eq 'mutant') { $r.refused = '-Sweep is for a green or red run; a mutant run proves its own case'; return $r }
  if ($Sweep) {
    $r.sweep = $true
    $r.note = "RUN MODE $($r.mode): the isolation sweep runs (-Sweep)"
  } else {
    $why = if ($NoSweep) { '-NoSweep' } else { 'the default for developer, mutant and red runs' }
    $r.note = "RUN MODE $($r.mode): SWEEP SKIPPED ($why; the sweep runs once per landing: -Landing always sweeps, -Sweep opts a developer or red run in)"
  }
  return $r
}

# ---- part 1: -WbMount 'src/<path>=<host file>' --------------------------------------------------------------------------
# Returns @{ refused = '' | reason; args = docker run args; lines = what to print }.
function Get-LabWbMountArgs([string[]]$WbMount, [string]$WbDir, [string]$AppDir = '/app') {
  $out = @{ refused = ''; args = @(); lines = @() }
  $seen = @{}
  foreach ($m in @($WbMount | Where-Object { $_ })) {
    $i = $m.IndexOf('=')
    if ($i -lt 1) { $out.refused = "-WbMount '$m' is not 'src/<path>=<host file>'"; return $out }
    $rel = $m.Substring(0, $i).Trim() -replace '\\', '/'
    $host_ = $m.Substring($i + 1).Trim()
    if ($rel -notmatch '^src/[A-Za-z0-9_][A-Za-z0-9_./-]*\.(ts|tsx|js|mjs|json)$' -or $rel -match '(^|/)\.\.?(/|$)') {
      $out.refused = "-WbMount target '$rel' must be a source file under src/ (no '..')"; return $out
    }
    if ($rel -match '_test\.ts$') { $out.refused = "-WbMount target '$rel' is a test file: a mutant mutates the code under test, not the test"; return $out }
    if ($seen.ContainsKey($rel)) { $out.refused = "-WbMount names '$rel' twice"; return $out }
    $seen[$rel] = $true
    $orig = Join-Path $WbDir ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $orig -PathType Leaf)) { $out.refused = "-WbMount target '$rel' does not exist in this tree (a mutant replaces a file, it never adds one)"; return $out }
    if (-not $host_ -or -not (Test-Path -LiteralPath $host_ -PathType Leaf)) { $out.refused = "-WbMount host file '$host_' does not exist"; return $out }
    $hostFull = (Resolve-Path -LiteralPath $host_).Path
    if ((Get-LabFileSha256 $hostFull) -eq (Get-LabFileSha256 $orig)) { $out.refused = "-WbMount '$rel': the host file is identical to the tree's copy (that mutant would test nothing)"; return $out }
    $out.args += @('-v', "${hostFull}:$AppDir/${rel}:ro")
    $out.lines += "MUTANT MOUNT: $rel <- $hostFull (read-only, over the lab workbench's copy; no image build)"
  }
  return $out
}

# ---- part 1: the green guard ----------------------------------------------------------------------------------------------
function Get-LabImageLabels([string]$Tag) {
  $o = Dk image inspect --format '{{json .Config.Labels}}' $Tag
  if ($script:rc -ne 0) { return $null }
  try { $j = ($o | Out-String).Trim() | ConvertFrom-Json } catch { return @{} }
  $h = @{}
  if ($j) { foreach ($p in $j.PSObject.Properties) { $h[$p.Name] = [string]$p.Value } }
  return $h
}
# THREAT MODEL of the green guard - FROZEN by the coordinator after test attempt 3 (rw-lab-throughput attempt 4).
# The rule it holds: a lab never reports green on code that did not pass the full unit gate, or on a tree other than the
# one under test. Its job is to stop ACCIDENTAL wrong-code green:
#   IN SCOPE (refused): a stale, foreign or other-tree image under the run's tag (an earlier tip's :wt-<id>, another
#   tester's images, an older tree's reuse tag, an unlabelled image from before rw-lab-throughput); a tag re-pointed
#   between the check and the run (the tag is resolved to an image ID ONCE and the run uses that ID); a skip-gate image;
#   an unguarded companion image (the viewer on -Prebuilt: tree-bound and ID-pinned too); and drift in ANY file the
#   Dockerfile copies into /app (deno.json, deno.lock, THIRD-PARTY-NOTICES.md, gate/, csl/, src/ - compared file by file
#   against the tree's tracked files, paths exact and case-sensitive, no extra file in the runtime image).
#   OUT OF SCOPE (documented residuals): deliberate crafting by someone who can build images on this daemon - a forged
#   passed marker on this tree's own skip image, or a hand-made FROM layer designed to fool the checker (for example code
#   placed outside /app, in the dependency cache or the system image). Labels and in-image checks cannot stop whoever
#   controls the build; whoever can run `docker build` here can run anything on this host. The guard keeps honest runs
#   honest; it is not a sandbox.
#   ALSO OUT OF SCOPE (review 1, stated so a tester judges against them, not around them):
#   - the viewer's FILES are not compared: it is bound by its tree label (docker/wiki-viewer and recipes/ clean,
#     ai-stack.lab.tree = the tree under test, not dirty) and pinned by ID; a layer built by hand FROM a tree-labelled
#     viewer inherits those labels - deliberate crafting, a residual;
#   - the recipes/ bind mount: the workbench and the sweep container mount the WORKING TREE's OB1/recipes at /recipes at
#     run time (deno.json maps @shared/slug to /recipes/_shared/slug.mjs); that is not image content, and a green run
#     without the viewer does not dirty-check it, so uncommitted changes under recipes/_shared can reach a green run, as
#     before this item (FOLLOW-UP, not built: add recipes/_shared to the green-run dirty check);
#   - companion images by tag: the research image (identity, sessions) and the refinery image (workspace) are built
#     fresh in every run under the run's own :wt-<id> tag from the working tree, never reused or taken -Prebuilt (those
#     runners refuse -Prebuilt); they run by tag, are not ID-pinned and not dirty-checked - uncommitted changes in
#     integrations/research-service or integrations/openbrain-idea-refinery, or a concurrent writer of the run's own
#     owner tag, are outside the guard, as before this item;
#   - build args: the guard does not read ai-stack.lab.args. The only gate-relevant arg, WORKBENCH_TEST_GATE, is checked
#     by the in-image markers; OB1_SHA is a stamp; PANDOC_* / TYPST_* are SHA-pinned and land outside /app; an image
#     built by hand with other args under this tree's labels is crafted - a residual.
#   NOT WIRED: run-cast-tests.ps1, run-flags-tests.ps1, run-inlets-tests.ps1 and run-private-report-claims-lab.ps1 still
#   build and run their own images without this guard (their -Prebuilt takes the tag as it is). They are out of scope
#   of this item until they adopt lab-throughput.ps1.
$script:LabDirtyLabel = 'ai-stack.lab.dirty'
# The inputs of the workbench image (the Dockerfile's COPY sources): a change anywhere else in OB1 never makes it dirty.
$script:LabWbInputs = @('docker/workbench/Dockerfile', 'docker/workbench/deno.json', 'docker/workbench/deno.lock', 'docker/workbench/THIRD-PARTY-NOTICES.md',
  'docker/workbench/gate', 'docker/workbench/csl', 'docker/workbench/src')
# What the Dockerfile copies into /app (relative to docker/workbench): the files the image must hold exactly.
$script:LabAppInputs = @('deno.json', 'deno.lock', 'THIRD-PARTY-NOTICES.md', 'gate', 'csl', 'src')
# The viewer image's inputs (docker/wiki-viewer and its recipes build context).
$script:LabViewerInputs = @('docker/wiki-viewer', 'recipes')

# The image ID ('sha256:<64 hex>') a tag or ID resolves to now, or ''.
function Resolve-LabImageId([string]$Ref) {
  $o = "$(Dk image inspect --format '{{.Id}}' $Ref)".Trim()
  if ($script:rc -ne 0 -or $o -notmatch '^sha256:[0-9a-f]{64}$') { return '' }
  return $o
}
# git's raw stdout as UTF-8 (paths exactly as git has them: no console code page, no line splitting).
function Invoke-LabGitRaw([string]$Ob1, [string[]]$GitArgs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'git'
  $psi.Arguments = (@('-C', $Ob1, '-c', 'core.quotepath=off') + $GitArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
  $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEnd(); $null = $p.StandardError.ReadToEnd(); $p.WaitForExit()
  return $o
}
# The tree under test: OB1 HEAD's tree, and whether $Inputs differ from it (tracked or untracked).
function Get-LabTreeUnderTest([string]$Ob1, [string[]]$Inputs = @()) {
  if (-not $Inputs.Count) { $Inputs = @($script:LabWbInputs) }
  $tree = "$(& git -C $Ob1 rev-parse 'HEAD^{tree}' 2>$null)".Trim()
  $st = (@(& git -C $Ob1 status --porcelain --untracked-files=all -- @Inputs 2>$null) -join "`n").Trim()
  return @{ tree = $tree; dirty = [bool]$st; status = $st }
}
function New-LabOrdinalMap { return (New-Object 'System.Collections.Generic.Dictionary[string,string]' ([System.StringComparer]::Ordinal)) }
# What the tree says /app must hold: './<path under docker/workbench>' -> sha256 of the file with CR removed, from the
# tracked files of $script:LabAppInputs (git ls-files -z: exact paths). Kind 'runtime' drops what the app-src stage
# deletes (every src/**/*_test.ts and src/export/credentials_oracle.ts); 'test' is all of it.
function Get-LabAppExpected([string]$Ob1, [string]$Kind) {
  $h = New-LabOrdinalMap
  $latin1 = [System.Text.Encoding]::GetEncoding(28591)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $paths = @($script:LabAppInputs | ForEach-Object { "docker/workbench/$_" })
  try {
    foreach ($r in ((Invoke-LabGitRaw $Ob1 (@('ls-files', '-z', '--') + $paths)) -split [char]0)) {
      if (-not $r) { continue }
      $rel = $r.Substring('docker/workbench/'.Length)
      if ($Kind -eq 'runtime' -and ($rel -cmatch '^src/.*_test\.ts$' -or $rel -ceq 'src/export/credentials_oracle.ts')) { continue }
      # Latin-1 maps every byte to one char and back, so this drops exactly the CR bytes
      $raw = $latin1.GetString([System.IO.File]::ReadAllBytes((Join-Path $Ob1 ($r -replace '/', '\'))))
      $h["./$rel"] = [System.BitConverter]::ToString($sha.ComputeHash($latin1.GetBytes($raw.Replace("`r", '')))).Replace('-', '').ToLower()
    }
  } finally { $sha.Dispose() }
  return $h
}
# What the image holds in /app: './<path>' -> sha256 with CR removed, from one `docker run --rm --network none`. Each path
# is printed hex-encoded (od), so a space, a newline or any byte in a name survives exactly (test attempt 3, X1); the
# gate markers are left out (Get-LabGateMarkers reads them).
function Get-LabImageApp([string]$Id) {
  $probe = 'cd /app && find . -type f -exec sh -c ''for f do printf "F %s %s\n" "$(tr -d "\r" < "$f" | sha256sum | cut -d" " -f1)" "$(printf "%s" "$f" | od -An -tx1 | tr -d " \n")"; done'' sh {} + ; echo END'
  $o = (Dk run --rm --network none --entrypoint sh $Id -c $probe | Out-String)
  if ($script:rc -ne 0 -or $o -notmatch '(?m)^END\s*$') { return $null }
  $h = New-LabOrdinalMap
  $utf8 = New-Object System.Text.UTF8Encoding $false
  foreach ($l in ($o -split "`n")) {
    if ($l -cnotmatch '^F ([0-9a-f]{64}) ([0-9a-f]+)\s*$') { continue }
    $hash = $Matches[1]; $hex = $Matches[2]
    if ($hex.Length % 2) { continue }
    $bytes = New-Object byte[] ($hex.Length / 2)
    for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring(2 * $i, 2), 16) }
    $path = $utf8.GetString($bytes)
    if ($path -ceq './.test-gate-passed' -or $path -ceq './.test-gate-skipped') { continue }
    $h[$path] = $hash
  }
  return ,$h
}
# '' when the image's /app holds exactly the tree's copied files (every expected file present with the same content, and
# no other file), else the first differences. Ordinal (case-sensitive) on both sides.
function Test-LabImageApp([string]$Id, [string]$Ob1, [string]$Kind) {
  $want = Get-LabAppExpected $Ob1 $Kind
  if (-not $want.Count) { return "no tracked file of $($script:LabAppInputs -join ', ') under docker/workbench in $Ob1" }
  $have = Get-LabImageApp $Id
  if ($null -eq $have) { return 'its /app could not be read' }
  $bad = @()
  foreach ($k in ($want.Keys | Sort-Object -CaseSensitive)) {
    if (-not $have.ContainsKey($k)) { $bad += "missing $k" } elseif ($have[$k] -cne $want[$k]) { $bad += "differs $k" }
  }
  foreach ($k in ($have.Keys | Sort-Object -CaseSensitive)) { if (-not $want.ContainsKey($k)) { $bad += "extra '$k'" } }
  if ($bad.Count) { return "its /app is not the tree's ($($bad.Count) difference(s): $(($bad | Select-Object -First 4) -join ', '))" }
  return ''
}
# What the image itself says about its unit gate: 'full' (/app/.test-gate-passed and no .test-gate-skipped), 'skipped',
# 'none', 'both', or 'error' (not runnable). A self-attestation: see the threat model above.
function Get-LabGateMarkers([string]$Ref) {
  $o = Dk run --rm --network none --entrypoint sh $Ref -c 'p=0; s=0; [ -f /app/.test-gate-passed ] && p=1; [ -e /app/.test-gate-skipped ] && s=1; echo "gate-markers p=$p s=$s"'
  if ($script:rc -ne 0) { return 'error' }
  $m = ([regex]'gate-markers p=([01]) s=([01])').Match(($o | Out-String))
  if (-not $m.Success) { return 'error' }
  $pm = $m.Groups[1].Value -eq '1'; $sm = $m.Groups[2].Value -eq '1'
  if ($pm -and -not $sm) { return 'full' }
  if ($sm -and -not $pm) { return 'skipped' }
  if ($pm -and $sm) { return 'both' }
  return 'none'
}
# The tree binding every guarded image shares: resolves $Tag to an image ID ONCE and returns it; refuses (FAIL, throw)
# unless $Inputs are clean in the tree under test, the image's ai-stack.lab.tree is that tree, and it is not labelled
# dirty. $What names the image in the messages.
function Assert-LabTreeImage([string]$Tag, [string]$Mode, [string]$Ob1, [string[]]$Inputs, [string]$What) {
  $refuse = { param($why) Fail "REFUSED: $Tag is not this tree's $What ($why) and this is a $Mode run - a green or landing run only ever runs images of the tree under test"; throw "guard: $Tag refused in a $Mode run: $why" }
  if (-not $Ob1) { & $refuse 'the guard was given no OB1 tree to bind the image to' }
  $id = Resolve-LabImageId $Tag
  if (-not $id) { Fail "the image guard could not inspect $Tag"; throw "guard: $Tag not inspectable" }
  $tut = Get-LabTreeUnderTest $Ob1 $Inputs
  if (-not $tut.tree) { & $refuse "the tree under test in $Ob1 cannot be read" }
  if ($tut.dirty) { & $refuse "the tree under test has uncommitted changes in its inputs ($(($tut.status -split "`n" | Select-Object -First 3) -join '; ')): a green or landing run tests a committed tree" }
  $l = Get-LabImageLabels $id
  if ($null -eq $l) { & $refuse "image $id cannot be inspected" }
  $t = $l[$script:LabTreeLabel]
  if ($t -cne $tut.tree) { & $refuse "it was built from tree '$(if ($t) { $t } else { '<no ai-stack.lab.tree label>' })', the tree under test is $($tut.tree)" }
  if ($l[$script:LabDirtyLabel] -eq '1') { & $refuse 'it was built from a dirty working tree (ai-stack.lab.dirty=1)' }
  return @{ id = $id; tree = $tut.tree; labels = $l; refuse = $refuse }
}
# The green / landing guard of a WORKBENCH image (runtime or test stage). Returns the checked image ID; the caller runs
# that ID, never the tag again (test attempt 2, A7). Refuses unless the tree binding holds (above), its gate markers say
# full and its label does not say skipped (D1), and its /app holds exactly the tree's copied files (A5, X1, X2).
function Assert-LabGreenImage([string]$Tag, [string]$Mode, [string]$Ob1, [string]$Kind = 'runtime') {
  $b = Assert-LabTreeImage $Tag $Mode $Ob1 $script:LabWbInputs "full-gate $Kind image"
  $refuse = { param($why) Fail "REFUSED: $Tag is not this tree's full-gate $Kind image ($why) and this is a $Mode run - a green or landing run only ever runs an image of the tree under test whose unit gate ran"; throw "guard: $Tag refused in a $Mode run: $why" }
  $g = $b.labels[$script:LabGateLabel]
  $mk = Get-LabGateMarkers $b.id
  if ($g -eq 'skipped' -or $mk -ne 'full') { & $refuse "its gate markers say '$mk' (want /app/.test-gate-passed and no /app/.test-gate-skipped); label $($script:LabGateLabel)='$g'" }
  $app = Test-LabImageApp $b.id $Ob1 $Kind
  if ($app) { & $refuse $app }
  Pass "the green-image guard: $Tag = $($b.id) (tree $($b.tree.Substring(0, 12)), gate markers full, /app = the tree's deno.json, deno.lock, notices, gate, csl and src, $Kind) - the run uses this ID"
  return $b.id
}
# The green / landing guard of the VIEWER (a companion image, test attempt 3 X3): bound to the tree of its own inputs
# (docker/wiki-viewer, recipes) and ID-pinned. Returns the checked ID.
function Assert-LabViewerImage([string]$Tag, [string]$Mode, [string]$Ob1) {
  $b = Assert-LabTreeImage $Tag $Mode $Ob1 $script:LabViewerInputs 'viewer image'
  Pass "the viewer guard: $Tag = $($b.id) (tree $($b.tree.Substring(0, 12)), docker/wiki-viewer and recipes clean) - the run uses this ID"
  return $b.id
}

# ---- part 1: a skip-gate Dockerfile for a tree that predates WORKBENCH_TEST_GATE (a red base) ---------------------------
# Rewrites the gate RUN and the runtime's marker COPY of $Dockerfile IN PLACE. Refuses a file inside $Ob1 (the working
# tree): only a scratch copy (git archive) is ever rewritten. Returns '' or the refusal.
function Convert-LabDockerfileSkipGate([string]$Dockerfile, [string]$Ob1) {
  $full = (Resolve-Path -LiteralPath $Dockerfile).Path
  $root = (Resolve-Path -LiteralPath $Ob1).Path.TrimEnd('\') + '\'
  if ($full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { return "refusing to rewrite $full - it is inside the OB1 working tree (only a scratch copy is rewritten)" }
  $t = [System.IO.File]::ReadAllText($full)
  if ($t -match 'ARG WORKBENCH_TEST_GATE') { return '' }   # knows the arg already: the build arg does it
  # (?=\r?$): a git archive copy has CRLF under core.autocrlf, and .NET's multiline $ matches only before \n
  $rxRun = [regex]'(?m)^RUN deno test [^\r\n]*(\\\r?\n[^\r\n]*)*?&& touch /app/\.test-gate-passed[^\r\n]*?(?=\r?$)'
  $rxCopy = [regex]'(?m)^COPY --from=test /app/\.test-gate-passed /app/\.test-gate-passed[^\r\n]*?(?=\r?$)'
  if ($rxRun.Matches($t).Count -ne 1 -or $rxCopy.Matches($t).Count -ne 1) { return "the Dockerfile at $full has no single gate RUN / marker COPY to rewrite" }
  $t = $rxRun.Replace($t, "LABEL $($script:LabGateLabel)=`"skipped`"`nRUN echo 'TEST GATE SKIPPED (lab red-base / mutant copy)' && echo skipped > /app/.test-gate-skipped")
  $t = $rxCopy.Replace($t, "LABEL $($script:LabGateLabel)=`"skipped`"`nCOPY --from=test /app/.test-gate-* /app/")
  [System.IO.File]::WriteAllText($full, $t, (New-Object System.Text.UTF8Encoding $false))
  return ''
}

# The bound on one image build. 2400 s (the runners' old DkLong) is not enough on a loaded host: measured 2026-11-26, a
# cold workbench build at 100% host CPU was killed at 2409 s before its gate finished. OB1_LAB_BUILD_TIMEOUT_SEC overrides.
function Get-LabBuildTimeoutSec {
  $n = 0
  if ($env:OB1_LAB_BUILD_TIMEOUT_SEC -and [int]::TryParse($env:OB1_LAB_BUILD_TIMEOUT_SEC, [ref]$n) -and $n -gt 0) { return $n }
  return 5400
}
# Windows' own tar (bsdtar). Under Git Bash the first 'tar' on PATH is MSYS tar, which reads 'C:\...' as a remote host.
function Get-LabTar {
  $w = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path -LiteralPath $w) { return $w }
  return 'tar'
}

# ---- part 2: the reuse key ------------------------------------------------------------------------------------------------
# @{ tree; args; tag; dirty; why } for a build of $Context at OB1 revision $Rev ('HEAD' = the working tree).
function Get-LabBuildKey {
  param([string]$Ob1, [string]$Rev = 'HEAD', [string]$Repo, [hashtable]$BuildArgs = @{}, [string]$Target = '',
        [string[]]$KeyParts = @(), [string[]]$DirtyPaths = @())
  $tree = "$(& git -C $Ob1 rev-parse "$Rev^{tree}" 2>$null)".Trim()
  if ($LASTEXITCODE -ne 0 -or $tree -notmatch '^[0-9a-f]{40}$') { return @{ tree = ''; args = ''; tag = ''; dirty = $true; why = "no tree for $Rev" } }
  $dirty = $false; $why = ''
  if ($Rev -eq 'HEAD') {
    $st = "$(& git -C $Ob1 status --porcelain --untracked-files=all -- @DirtyPaths 2>$null)".Trim()
    if ($st) { $dirty = $true; $why = "uncommitted changes under $($DirtyPaths -join ', ')" }
  }
  $lines = @("target=$Target") + @($BuildArgs.Keys | Sort-Object | ForEach-Object { "arg:$_=$($BuildArgs[$_])" }) + @($KeyParts | ForEach-Object { "part:$_" })
  $digest = Get-LabSha256 ($lines -join "`n")
  return @{ tree = $tree; args = $digest; tag = "${Repo}:wt-tree-$($tree.Substring(0, 12))-$($digest.Substring(0, 12))"; dirty = $dirty; why = $why }
}

# ---- part 5: the build lease ---------------------------------------------------------------------------------------------
function Invoke-LabBuildLease([string]$Owner, [string]$Ob1, [scriptblock]$Build) {
  $stack = Split-Path -Parent $Ob1
  $lease = Join-Path $stack 'scripts\agent-harness\lease.ps1'
  if ("$env:OB1_LAB_BUILD_LEASE" -eq 'off') { Write-Host '  BUILD LEASE: off (OB1_LAB_BUILD_LEASE=off) - building unthrottled'; return (& $Build) }
  if (-not (Test-Path -LiteralPath $lease)) { Write-Host "  BUILD LEASE: no harness lease script at $lease - building unthrottled"; return (& $Build) }
  $waitMin = 240; $n = 0; if ($env:OB1_LAB_BUILD_WAIT_MIN -and [int]::TryParse($env:OB1_LAB_BUILD_WAIT_MIN, [ref]$n) -and $n -gt 0) { $waitMin = $n }
  $deadline = [DateTime]::UtcNow.AddMinutes($waitMin)
  $held = $false
  Push-Location $stack   # lease.ps1 finds the shared lock dir from the ai-stack checkout, never from the OB1 submodule
  try {
    while ($true) {
      $o = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $lease -Acquire -Class build -Owner $Owner -TtlMin ([int][Math]::Ceiling((Get-LabBuildTimeoutSec) / 60) + 30) 2>&1 | ForEach-Object { "$_" }) -join ' | '
      $lrc = $LASTEXITCODE
      if ($lrc -eq 0) { $held = $true; Write-Host "  BUILD LEASE: $(($o -split ' \| ')[0])"; break }
      if ($lrc -ne 3) { Write-Host "  BUILD LEASE: lease.ps1 answered rc $lrc ($o) - building without it"; break }
      if ([DateTime]::UtcNow -ge $deadline) { throw "no build slot within $waitMin min (lease.ps1 -Status -Class build)" }
      # say WHY (attempt 6): a deploy holding a plane -Exclusive, or both slots taken
      $why = @($o -split ' \| ' | Where-Object { $_ -match '^WAIT' } | Select-Object -First 1)
      if ($o -match 'EXCLUSIVELY') { Write-Host "  BUILD LEASE: a plane is held EXCLUSIVELY by a deploy - waiting until it is released (polls once a minute): $($why -join '')" }
      elseif ($o -match 'is full') { Write-Host '  BUILD LEASE: both build slots are taken - waiting (polls once a minute)' }
      else { Write-Host "  BUILD LEASE: waiting (polls once a minute): $($why -join '')" }
      Start-Sleep -Seconds 60
    }
  } finally { Pop-Location }
  try { return (& $Build) }
  finally {
    if ($held) {
      Push-Location $stack
      try { $null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $lease -Release -Class build -Owner $Owner 2>&1 } finally { Pop-Location }
      Write-Host '  BUILD LEASE: released'
    }
  }
}

# ---- parts 1, 2, 5: one image, reused when its tree and args match ---------------------------------------------------------
# Returns @{ tag; reused; rc; log; key }. -GateImage: the image carries the workbench Dockerfile's gate label, which must be
# 'skipped' with -SkipGate and 'full' (or, for a tree that predates it, unset) without. -OwnerTag is used when the
# context cannot be keyed (dirty working tree, or -NoReuse). The build runs under the build lease.
function Invoke-LabImage {
  param([string]$Repo, [string]$Context, [string]$Ob1, [string]$Rev = 'HEAD', [hashtable]$BuildArgs = @{}, [string]$Target = '',
        [string[]]$Extra = @(), [string[]]$KeyParts = @(), [string[]]$DirtyPaths = @(), [string]$OwnerTag, [string]$Owner,
        [switch]$GateImage, [switch]$SkipGate, [switch]$NoReuse, [switch]$ReuseOnly)
  $ba = @{}; foreach ($k in $BuildArgs.Keys) { $ba[$k] = $BuildArgs[$k] }
  if ($GateImage) { $ba['WORKBENCH_TEST_GATE'] = $(if ($SkipGate) { 'skipped' } else { 'full' }) }
  $key = Get-LabBuildKey -Ob1 $Ob1 -Rev $Rev -Repo $Repo -BuildArgs $ba -Target $Target -KeyParts $KeyParts -DirtyPaths $DirtyPaths
  $wantGate = if ($SkipGate) { 'skipped' } else { 'full' }
  $tag = $OwnerTag; $reuse = -not $NoReuse -and -not $key.dirty -and $key.tree
  if (-not $reuse) {
    $why = if ($NoReuse) { '-NoReuse' } else { $key.why }
    Write-Host "  IMAGE REUSE: off for $OwnerTag ($why)"
  } else {
    $tag = $key.tag
    $l = Get-LabImageLabels $tag
    if ($null -ne $l) {
      $bad = @()
      if ($l[$script:LabTreeLabel] -ne $key.tree) { $bad += "$($script:LabTreeLabel)=$($l[$script:LabTreeLabel]) (want $($key.tree))" }
      if ($l[$script:LabArgsLabel] -ne $key.args) { $bad += "$($script:LabArgsLabel)=$($l[$script:LabArgsLabel]) (want $($key.args))" }
      if ($GateImage -and $l[$script:LabGateLabel] -ne $wantGate) { $bad += "$($script:LabGateLabel)=$($l[$script:LabGateLabel]) (want $wantGate)" }
      if ($GateImage -and -not $bad.Count) { $mk = Get-LabGateMarkers $tag; if ($mk -ne $wantGate) { $bad += "gate markers '$mk' inside the image (want $wantGate)" } }
      if (-not $bad.Count) {
        Write-Host "  IMAGE REUSED: $tag (tree $($key.tree.Substring(0, 12)), args $($key.args.Substring(0, 12)) - labels checked; no build)"
        return @{ tag = $tag; reused = $true; rc = 0; log = ''; key = $key }
      }
      Write-Host "  IMAGE REUSE REFUSED: $tag carries $($bad -join '; ') - it is NOT used$(if ($ReuseOnly) { '' } else { '; rebuilding it' })"
    }
  }
  if ($ReuseOnly) { return @{ tag = ''; reused = $false; rc = 1; log = ''; key = $key } }
  $a = @('build', '--label', $label, '--label', "$($script:LabTreeLabel)=$($key.tree)", '--label', "$($script:LabArgsLabel)=$($key.args)")
  # a build of a dirty working tree is stamped so; the green guard never accepts it (test attempt 2: HEAD's tree was
  # stamped on a dirty build)
  if ($key.dirty) { $a += @('--label', "$($script:LabDirtyLabel)=1") }
  foreach ($k in ($ba.Keys | Sort-Object)) { $a += @('--build-arg', "$k=$($ba[$k])") }
  if ($Target) { $a += @('--target', $Target) }
  $a += $Extra
  $a += @('-t', $tag, $Context)
  $o = Invoke-LabBuildLease $Owner $Ob1 { Lab-Docker (Get-LabBuildTimeoutSec) $a }
  $brc = $script:rc
  if ($brc -eq 0 -and $GateImage) {
    $l = Get-LabImageLabels $tag
    $g = if ($l) { $l[$script:LabGateLabel] } else { '' }
    if ($SkipGate -and $g -ne 'skipped') { Fail "the skip-gate build of $tag carries $($script:LabGateLabel)='$g', not 'skipped'"; $brc = 1 }
    $mk = Get-LabGateMarkers $tag
    if ($mk -ne $wantGate) { Fail "the build of $tag has gate markers '$mk' inside, not '$wantGate'"; $brc = 1 }
    if (-not $SkipGate -and $g -eq 'skipped') { Fail "the full-gate build of $tag carries $($script:LabGateLabel)=skipped"; $brc = 1 }
  }
  $script:rc = $brc
  return @{ tag = $tag; reused = $false; rc = $brc; log = $o; key = $key }
}

# The lab docker shim's build-tag rule: this run's :wt-<short>[-suffix], or a reuse tag :wt-tree-<tree12>-<args12>.
function Test-LabBuildTag([string]$Tag, [string]$Short) {
  return ($Tag -match ":wt-$([regex]::Escape($Short))(-[a-z0-9]+)?$" -or $Tag -match ':wt-tree-[0-9a-f]{12}-[0-9a-f]{12}$')
}
# A cloned lab database still carries the template's postgres password: set the run's own (local socket, trust).
function Set-LabDbPassword([string]$Db, [string]$Pw) {
  $null = Dk exec $Db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "ALTER USER postgres PASSWORD '$Pw'"
  return ($script:rc -eq 0)
}

# ---- part 3: the DB template ---------------------------------------------------------------------------------------------
# The chain digest: every staged file name and its sha256, sorted, and the postgres image reference.
function Get-LabChainDigest([string]$StageDir, [string]$PgImage) {
  # the image ID when it is local (a re-pushed tag under the same reference is another image); the reference otherwise
  $pgId = "$(Dk image inspect --format '{{.Id}}' $PgImage)".Trim()
  if ($script:rc -eq 0 -and $pgId -match '^sha256:[0-9a-f]{64}$') { $PgImage = $pgId }
  $lines = @(Get-ChildItem -LiteralPath $StageDir -File | Sort-Object Name | ForEach-Object { "$($_.Name) $(Get-LabFileSha256 $_.FullName)" })
  return (Get-LabSha256 ((@("pg=$PgImage") + $lines) -join "`n"))
}
function Get-LabVolumeLabels([string]$Vol) {
  $o = Dk volume inspect --format '{{json .Labels}}' $Vol
  if ($script:rc -ne 0) { return $null }
  try { $j = ($o | Out-String).Trim() | ConvertFrom-Json } catch { return @{} }
  $h = @{}
  if ($j) { foreach ($p in $j.PSObject.Properties) { $h[$p.Name] = [string]$p.Value } }
  return $h
}
# One read of a volume, three answers (review 1, D-R1): 'present' (with its labels), 'absent' ONLY when docker says
# "no such volume", and 'error' for anything else (a timeout, a daemon error) - an error is never read as absent.
function Get-LabVolumeState([string]$Vol) {
  $o = (Dk volume inspect --format '{{json .Labels}}' $Vol | Out-String)
  if ($script:rc -eq 0) {
    $h = @{}
    try { $j = $o.Trim() | ConvertFrom-Json; if ($j) { foreach ($p in $j.PSObject.Properties) { $h[$p.Name] = [string]$p.Value } } } catch { }
    return @{ state = 'present'; labels = $h; why = '' }
  }
  if ($o -match '(?i)no such volume') { return @{ state = 'absent'; labels = $null; why = '' } }
  return @{ state = 'error'; labels = $null; why = "docker volume inspect rc $($script:rc): $(($o.Trim() -split "`n")[0])" }
}
# Builds (once) or verifies the template for ($Pin, the staged chain). Returns @{ vol; built; log; refused }. The init log
# is kept inside the volume (initdb.log) so a cloned lab checks the same log a replayed one would.
function Initialize-LabDbTemplate([string]$PgImage, [string]$StageDir, [string]$Pin) {
  $digest = Get-LabChainDigest $StageDir $PgImage
  $vol = "ob1-dbtpl-$($Pin.Substring(0, 12))-$($digest.Substring(0, 12))"
  $res = @{ vol = $vol; built = $false; log = ''; refused = ''; digest = $digest }
  $lockPath = Join-Path $env:TEMP "$vol.lock"
  $fs = $null
  for ($i = 0; $i -lt 900; $i++) {
    try { $fs = New-Object System.IO.FileStream($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); break }
    catch { Start-Sleep -Seconds 1 }
  }
  if (-not $fs) { $res.refused = "the template lock $lockPath stayed held for 15 min"; return $res }
  try {
    # review 1 (D-R1): only a volume THIS call created is ever removed on a failure below; a read that fails is refused,
    # never taken as "absent" (docker volume create on an existing name silently reuses it)
    $created = $false
    $vs = Get-LabVolumeState $vol
    if ($vs.state -eq 'error') { $res.refused = "the template volume $vol could not be read ($($vs.why)) - not used, not created, NOT removed"; return $res }
    $l = $vs.labels
    if ($vs.state -eq 'present') {
      $bad = @()
      if ($l[$script:LabTplLabel] -ne '1') { $res.refused = "volume $vol exists but is not a lab DB template (no $($script:LabTplLabel)=1) - not used, not removed"; return $res }
      if ($l["$($script:LabTplLabel).pin"] -ne $Pin) { $bad += "pin $($l["$($script:LabTplLabel).pin"]) (want $Pin)" }
      if ($l["$($script:LabTplLabel).digest"] -ne $digest) { $bad += "digest $($l["$($script:LabTplLabel).digest"]) (want $digest)" }
      if (-not $bad.Count) {
        # only a READY that is really absent or names another pin/digest rebuilds the shared template; a docker failure
        # (a timeout on a loaded host, a daemon hiccup) is retried, and if it persists the run replays its chain instead -
        # it never deletes a template it could not read
        $readyState = 'unknown'
        for ($try = 1; $try -le 3 -and $readyState -eq 'unknown'; $try++) {
          $ready = Dk run --rm --network none -v "${vol}:/t:ro" --entrypoint sh $PgImage -c 'if [ -f /t/READY ]; then echo "ready-file $(cat /t/READY)"; else echo ready-absent; fi'
          $rt = ($ready | Out-String)
          if ($script:rc -eq 0 -and $rt -match 'ready-absent') { $readyState = 'absent' }
          elseif ($script:rc -eq 0 -and $rt -match 'ready-file (.+)') { $readyState = $(if ($Matches[1].Trim() -eq "$Pin $digest") { 'ok' } else { 'other' }) }
          elseif ($try -lt 3) { Write-Host "  DB TEMPLATE: reading $vol's READY marker failed (rc $($script:rc)) - retrying"; Start-Sleep -Seconds (5 * $try) }
        }
        if ($readyState -eq 'unknown') { $res.refused = "the READY marker of $vol could not be read (docker rc $($script:rc), 3 tries) - not used and NOT removed"; return $res }
        if ($readyState -ne 'ok') { $bad += "no READY marker naming this pin and digest ($readyState; an interrupted build)" }
      }
      if (-not $bad.Count) {
        $res.log = (Dk run --rm --network none -v "${vol}:/t:ro" --entrypoint cat $PgImage /t/initdb.log | Out-String)
        Write-Host "  DB TEMPLATE: $vol (pin $($Pin.Substring(0, 12)), chain digest $($digest.Substring(0, 12)) - labels checked; no replay)"
        return $res
      }
      Write-Host "  DB TEMPLATE REFUSED: $vol carries $($bad -join '; ') - it is NOT used; rebuilding it"
      # a template READ and found wrong (another pin or digest, no READY) is replaced; its removal is checked before the
      # create, so a create can never land on (and later delete) a volume that is still there
      $null = Dk volume rm -f $vol
      $vs2 = Get-LabVolumeState $vol
      if ($vs2.state -ne 'absent') { $res.refused = "the wrong template $vol could not be removed ($(if ($vs2.why) { $vs2.why } else { 'it is still there' })) - not rebuilt"; return $res }
    }
    $null = Dk volume create --label "$($script:LabTplLabel)=1" --label "$($script:LabTplLabel).pin=$Pin" --label "$($script:LabTplLabel).digest=$digest" $vol
    if ($script:rc -ne 0) { $res.refused = "could not create $vol"; return $res }
    $created = $true
    $init = "$vol-init"
    $tplPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
    $null = Dk rm -f $init
    $null = Dk run -d --name $init --label $label --network none -e "POSTGRES_PASSWORD=$tplPw" -e 'POSTGRES_DB=openbrain' -e 'PGDATA=/var/lib/postgresql/data/pgdata' `
      -v "${vol}:/var/lib/postgresql/data" -v "${StageDir}:/docker-entrypoint-initdb.d:ro" $PgImage
    if ($script:rc -ne 0) { if ($created) { $null = Dk volume rm -f $vol }; $res.refused = "the template's init container did not start"; return $res }
    $ok = $false
    for ($i = 0; $i -lt 300; $i++) { if ((Dk logs $init) -match 'PostgreSQL init process complete') { $ok = $true; break }; Start-Sleep -Seconds 2 }
    for ($i = 0; $ok -and $i -lt 60; $i++) { $null = Dk exec $init pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
    $log = Dk logs $init
    $null = Dk stop -t 60 $init
    if (-not $ok) { $null = Dk rm -f $init; if ($created) { $null = Dk volume rm -f $vol }; $res.refused = 'the template chain did not finish initdb'; $res.log = $log; return $res }
    $tmp = Join-Path $env:TEMP "$vol-initdb.log"
    [System.IO.File]::WriteAllText($tmp, (($log | Out-String) -replace "`r", ''), (New-Object System.Text.UTF8Encoding $false))
    $null = Dk cp $tmp "${init}:/var/lib/postgresql/data/initdb.log"
    [System.IO.File]::WriteAllText($tmp, "$Pin $digest", (New-Object System.Text.UTF8Encoding $false))
    $null = Dk cp $tmp "${init}:/var/lib/postgresql/data/READY"
    $cpRc = $script:rc
    Remove-Item -Force $tmp -ErrorAction SilentlyContinue
    $null = Dk rm -f $init
    if ($cpRc -ne 0) { if ($created) { $null = Dk volume rm -f $vol }; $res.refused = 'could not write the template READY marker'; return $res }
    $res.built = $true; $res.log = ($log | Out-String)
    Write-Host "  DB TEMPLATE BUILT: $vol (pin $($Pin.Substring(0, 12)), chain digest $($digest.Substring(0, 12)); replayed once)"
    return $res
  } finally { $fs.Dispose() }
}
# A lab's own copy of the template: a fresh volume labelled with the run's owner label (removed at teardown).
# Returns the docker run args for the lab database (in place of the initdb mount), or $null on failure.
function New-LabDbVolume([string]$PgImage, [string]$TplVol, [string]$LabVol) {
  $null = Dk volume create --label $label $LabVol
  if ($script:rc -ne 0) { Fail "could not create the lab database volume $LabVol"; return $null }
  $null = Dk run --rm --label $label --network none -v "${TplVol}:/from:ro" -v "${LabVol}:/to" --entrypoint sh $PgImage -c 'cp -a /from/. /to/ && rm -f /to/READY /to/initdb.log'
  if ($script:rc -ne 0) { Fail "could not copy the DB template $TplVol into $LabVol"; return $null }
  return @('-e', 'PGDATA=/var/lib/postgresql/data/pgdata', '-v', "${LabVol}:/var/lib/postgresql/data")
}

# ---- the runner-level wrappers: what a runner calls in its [3] images and [4] database steps ----------------------------
# The workbench image, its test stage and (for a sweep) the viewer, by the run's mode:
#   green / landing  this tree, the full gate; a skip-gate image is never built or used (Assert-LabGreenImage)
#   red              -BaseSha from a git archive copy (with -SkipGate the COPY's Dockerfile is rewritten when it predates
#                    the arg); the test stage is this tree's
#   mutant           this tree: the green image is reused when it exists (a -WbMount mutant then builds nothing);
#                    otherwise built, with the gate skipped when -SkipGate
# In red and mutant runs with -SkipGate the test stage is likewise reused from the green build first, else built skipped.
# Returns @{ ok; wb; test; viewer; built }. Owner-tagged images go into $script:made.images (removed at teardown); reuse
# tags (:wt-tree-) stay for the next run (lab-cache.ps1 lists and prunes them).
function Invoke-LabWorkbenchImages {
  param($Run, [string]$Ob1, [string]$Wb, [string]$Sha, [string]$BaseSha, [string]$Short, [string]$Owner, [string]$P,
        [bool]$SkipGate = $false, [bool]$NoReuse = $false, [bool]$Viewer = $false, [string]$ViewerDir = '', [string]$GateNote = '')
  $res = @{ ok = $false; wb = ''; test = ''; viewer = ''; built = @() }
  $wbRel = 'docker/workbench'
  $skipOk = ($Run.mode -eq 'red' -or $Run.mode -eq 'mutant') -and $SkipGate
  if ($Run.mode -eq 'red') {
    $tree = Join-Path $env:TEMP "$P-tree-$BaseSha"
    New-Item -ItemType Directory -Force $tree | Out-Null
    $script:made.dirs += $tree
    $tar = Join-Path $env:TEMP "$P-$BaseSha.tar"
    & git -C $Ob1 archive --format=tar -o $tar $BaseSha
    & (Get-LabTar) -xf $tar -C $tree
    Remove-Item -Force $tar -ErrorAction SilentlyContinue
    if ($SkipGate) {
      $w = Convert-LabDockerfileSkipGate (Join-Path $tree 'docker\workbench\Dockerfile') $Ob1
      if ($w) { Fail "RED: $w"; return $res }
    }
    $r = Invoke-LabImage -Repo 'openbrain-workbench' -Context (Join-Path $tree 'docker\workbench') -Ob1 $Ob1 -Rev $BaseSha -BuildArgs @{ OB1_SHA = $BaseSha } `
      -KeyParts @("ctx=$wbRel") -OwnerTag "openbrain-workbench:wt-$Short-base" -Owner $Owner -GateImage -SkipGate:$SkipGate -NoReuse:$NoReuse
    if (-not $r.reused) { Save 'build-workbench-base.log' (($r.log -split "`n") | Select-Object -Last 40 | Out-String) }
    $how = if ($r.rc -ne 0) { "FAILED to build (rc $($r.rc)$(if ($r.rc -eq 124) { ': TIMEOUT at the build bound' }))" } elseif ($r.reused) { 'reused' } else { 'built' }
    Check ($r.rc -eq 0) "RED: $($r.tag) $how from OB1 $BaseSha$(if ($SkipGate) { ' (its unit gate SKIPPED: a red-base image)' })"
    if ($r.rc -ne 0) { return $res }
    $res.wb = $r.tag; if (-not $r.reused) { $res.built += 'workbench' }
    if ($r.tag -notmatch ':wt-tree-') { $script:made.images += $r.tag }
  } else {
    $r = $null
    if ($Run.mode -eq 'mutant') {
      $r = Invoke-LabImage -Repo 'openbrain-workbench' -Context $Wb -Ob1 $Ob1 -BuildArgs @{ OB1_SHA = $Sha } -KeyParts @("ctx=$wbRel") -DirtyPaths @($wbRel) `
        -OwnerTag "openbrain-workbench:wt-$Short" -Owner $Owner -GateImage -NoReuse:$NoReuse -ReuseOnly
      if (-not $r.reused) { $r = $null }
    }
    if (-not $r) {
      $r = Invoke-LabImage -Repo 'openbrain-workbench' -Context $Wb -Ob1 $Ob1 -BuildArgs @{ OB1_SHA = $Sha } -KeyParts @("ctx=$wbRel") -DirtyPaths @($wbRel) `
        -OwnerTag "openbrain-workbench:wt-$Short" -Owner $Owner -GateImage -SkipGate:$skipOk -NoReuse:$NoReuse
      $clean = ($r.log -replace '\x1b\[[0-9;]*m', '')
      if (-not $r.reused) { Save 'build-workbench.log' ((($clean -split "`n") | Where-Object { $_ -match 'ok \||FAILED|passed|error|SKIPPED' } | Select-Object -Last 120) -join "`n") }
    }
    $how = if ($r.rc -ne 0) { "FAILED to build (rc $($r.rc)$(if ($r.rc -eq 124) { ': TIMEOUT at the build bound' }))" } elseif ($r.reused) { 'reused (labels checked: the same tree, the same args)' } elseif ($skipOk) { 'built (its unit gate SKIPPED: a mutant image)' } else { "built (its build test gate passed$GateNote)" }
    Check ($r.rc -eq 0) "$($r.tag) at OB1 $($Sha.Substring(0, 7)): $how"
    if ($r.rc -ne 0) { return $res }
    if (-not $r.reused -and -not $skipOk) {
      $gate = ([regex]'ok \| (\d+) passed \| (\d+) failed').Matches(($r.log -replace '\x1b\[[0-9;]*m', ''))
      if ($gate.Count) { Pass "the workbench build test gate: $($gate[$gate.Count - 1].Value)" }
    }
    $res.wb = $r.tag; if (-not $r.reused) { $res.built += 'workbench' }
    if ($r.tag -notmatch ':wt-tree-') { $script:made.images += $r.tag }
  }
  # the test stage: always this tree's
  $t = $null
  if ($skipOk) {
    $t = Invoke-LabImage -Repo 'openbrain-workbench' -Context $Wb -Ob1 $Ob1 -BuildArgs @{ OB1_SHA = $Sha } -Target 'test' -KeyParts @("ctx=$wbRel") -DirtyPaths @($wbRel) `
      -OwnerTag "openbrain-workbench:wt-$Short-test" -Owner $Owner -GateImage -NoReuse:$NoReuse -ReuseOnly
    if (-not $t.reused) { $t = $null }
  }
  if (-not $t) {
    $t = Invoke-LabImage -Repo 'openbrain-workbench' -Context $Wb -Ob1 $Ob1 -BuildArgs @{ OB1_SHA = $Sha } -Target 'test' -KeyParts @("ctx=$wbRel") -DirtyPaths @($wbRel) `
      -OwnerTag "openbrain-workbench:wt-$Short-test" -Owner $Owner -GateImage -SkipGate:$skipOk -NoReuse:$NoReuse
    if (-not $t.reused) { Save 'build-workbench-test.log' (($t.log -split "`n") | Select-Object -Last 20 | Out-String) }
  }
  Check ($t.rc -eq 0) "$($t.tag) (this tree's test stage): $(if ($t.reused) { 'reused' } else { 'built' })"
  if ($t.rc -ne 0) { return $res }
  $res.test = $t.tag; if (-not $t.reused) { $res.built += 'test stage' }
  if ($t.tag -notmatch ':wt-tree-') { $script:made.images += $t.tag }
  if ($Viewer) {
    $ob1Recipes = Join-Path $Ob1 'recipes'
    $v = Invoke-LabImage -Repo 'openbrain-wiki-viewer' -Context $ViewerDir -Ob1 $Ob1 -BuildArgs @{ OB1_SHA = $Sha } -Extra @('--build-context', "recipes=$ob1Recipes") `
      -KeyParts @('ctx=docker/wiki-viewer', 'recipes=recipes') -DirtyPaths @('docker/wiki-viewer', 'recipes') -OwnerTag "openbrain-wiki-viewer:wt-$Short" -Owner $Owner -NoReuse:$NoReuse
    $vclean = ($v.log -replace '\x1b\[[0-9;]*m', '')
    if (-not $v.reused) { Save 'build-viewer.log' ((($vclean -split "`n") | Where-Object { $_ -match 'Test Files|Tests |FAIL|notices' } | Select-Object -Last 80) -join "`n") }
    Check ($v.rc -eq 0) "$($v.tag) (the viewer, for the sweep): $(if ($v.reused) { 'reused' } else { 'built - its workspace stage: vitest, the notices check, tsc + vite build' })"
    if ($v.rc -ne 0) { return $res }
    $vt = ([regex]'Tests\s+(\d+) passed').Match($vclean)
    if ($vt.Success) { Pass "workspace unit tests in the image build: $($vt.Groups[1].Value) passed" }
    $res.viewer = $v.tag; if (-not $v.reused) { $res.built += 'viewer' }
    $vid = Resolve-LabImageId $v.tag
    if (-not $vid) { Fail "could not resolve $($v.tag) to an image ID"; return $res }
    if ($v.tag -notmatch ':wt-tree-') { $script:made.images += $v.tag }
    $res.viewer = $vid
  }
  if ($Run.mode -eq 'green' -or $Run.mode -eq 'landing') {
    try {
      $res.wb = Assert-LabGreenImage $res.wb $Run.mode $Ob1 'runtime'; $res.test = Assert-LabGreenImage $res.test $Run.mode $Ob1 'test'
      if ($res.viewer) { $res.viewer = Assert-LabViewerImage $res.viewer $Run.mode $Ob1 }
    } catch { return $res }
  } else {
    # red / mutant: no gate guard, but the run still uses the image IDs resolved here, never a tag that can move
    foreach ($k in @('wb', 'test')) {
      $rid = Resolve-LabImageId $res[$k]
      if (-not $rid) { Fail "could not resolve $($res[$k]) to an image ID"; return $res }
      $res[$k] = $rid
    }
  }
  Write-Host "  IMAGES: built $(if ($res.built.Count) { $res.built -join ', ' } else { 'nothing (all reused)' })"
  $res.ok = $true
  return $res
}

# The lab database: cloned from the template for ($Pin, the staged chain) unless -NoTemplate or the template is refused, in
# which case the chain is replayed at initdb exactly as before. Returns @{ ok; logs; template }: logs is the init log the
# runner's own checks read (the template's, which replayed this same chain, then this container's).
function Start-LabDb {
  param([string]$Name, [string]$PgImage, [string]$Stage, [string]$Pin, [string]$Pw, [string[]]$Extra = @(), [bool]$NoTemplate = $false, [string]$LabVol)
  $res = @{ ok = $false; logs = ''; template = '' }
  $base = $Extra + @('-e', "POSTGRES_PASSWORD=$Pw", '-e', 'POSTGRES_DB=openbrain')
  if (-not $NoTemplate) {
    $tpl = Initialize-LabDbTemplate $PgImage $Stage $Pin
    if ($tpl.refused) { Write-Host "  DB TEMPLATE: not used ($($tpl.refused)) - replaying the chain" }
    else {
      if (-not $script:made.ContainsKey('vols')) { $script:made.vols = @() }
      $volArgs = New-LabDbVolume $PgImage $tpl.vol $LabVol
      if ($null -eq $volArgs) { return $res }
      $script:made.vols += $LabVol
      if (-not (Run-Detached $Name ($base + $volArgs + @($PgImage)))) { return $res }
      $up = $false
      for ($i = 0; $i -lt 90; $i++) { $null = Dk exec $Name pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { $up = $true; break }; Start-Sleep -Seconds 2 }
      if (-not $up -or -not (Set-LabDbPassword $Name $Pw)) { Fail "the cloned database $Name did not come up"; return $res }
      Pass "the lab database is a clone of $($tpl.vol) (OB1 pin $($Pin.Substring(0, 12)), chain digest $($tpl.digest.Substring(0, 12))$(if ($tpl.built) { '; built by this run' } else { '; no replay' }))"
      $res.ok = $true; $res.template = $tpl.vol
      $res.logs = ($tpl.log | Out-String) + "`n" + (Dk logs $Name | Out-String)
      return $res
    }
  }
  if (-not (Run-Detached $Name ($base + @('-v', "${Stage}:/docker-entrypoint-initdb.d:ro", $PgImage)))) { return $res }
  for ($i = 0; $i -lt 150; $i++) { if ((Dk logs $Name) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $Name pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $res.ok = $true; $res.logs = (Dk logs $Name | Out-String)
  return $res
}
