# run-workspace-tests.ps1 - the disposable lab run for research-workbench P2b (rw-p2b-workspace):
# the workspace, the documents API and the viewer that serves /workspace.
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-workspace-tests.ps1 -Subnet <x.y.z.0/24> [-Id <owner>] [-Evidence <dir>] [-Red] [-Cases C1,C7]
#
# -Subnet is REQUIRED (harness-subnet.ps1: exactly a /24 outside Docker's default pools and
# 192.168.0.0/16); -Evidence must be absent or empty. -Red runs the SAME tests against images built
# from -BaseSha (the development pin before P2b): every clause must FAIL there.
# -WalkOff (round 3) starts the workbench with WORKSPACE_RESPONSE_WALK=off - the owner-scope response
# walk (a backstop) off, so the sweep sees what the routes themselves return; with -Red the base tree
# is patched (one line) to honour the same switch. Without -WalkOff the sweep runs TWICE: walk on
# (as deployed), then the workbench restarted with the walk off.
#
# LAB DOCKER SHIM: every docker call goes through Lab-Docker, which REFUSES (exit 2, nothing run) a
# published port (-p/-P/--publish*), a network other than this run's (and `none`), a network create
# that is not --internal on the pinned subnet, a macvlan / ipvlan driver, any 192.168.x address, any
# ai-stack_* / open-brain_* name, any :local image, docker compose, and a build tag that is not
# :wt-<id>[-suffix]. Every call has a timeout; every container, the network and every image is
# labelled ai-stack.harness.owner=<Id> and removed at the end (containers with -v), and the run
# checks nothing labelled <Id> is left and no :local image changed.
#
# What it does:
#   1. stages the REAL initdb chain from docker-compose.yml (P2b's 270 slot included)
#   2. one internal network on the pinned /25
#   3. builds openbrain-workbench:wt-<id> (+ its test stage), openbrain-wiki-viewer:wt-<id> (its
#      `workspace` stage runs the workspace's type check, unit tests (vitest) and D9 notices check)
#      and the e2e runner image; with -Red the workbench and viewer come from -BaseSha instead
#   4. the lab: database (chain + fixtures.sql, ob_app_memory non-superuser), stub embedder, stub
#      research service (origin by key), the lab target + stub search gate (a held link's replace), PostgREST + the OB1 rest Caddy, the
#      viewer (WIKI_BUILDER=0) as the front door (rw-identity-harden: the portal Caddy's /workbench
#      route is gone, so the viewer's own forwarder is the only door), the workbench (vault = a temp
#      dir), a headless Chromium
#   5. the documents API integration test (src/documents/documents_integration_test.ts) as
#      ob_app_memory against the :wt workbench; the workspace e2e (workspace.e2e.mjs) through the
#      front door in the headless Chromium; the grammar copy byte-identity check
#   6. the evidence gate (evidence-gate.ps1), then teardown and the leftover checks
# rw-p5a-intake adds [5e]: the intake and queue panel's integration test (src/intake/intake_integration_test.ts)
# with a stub extractor (stub-extract.ts), the stub research service's POST /intake/fetch and Open WebUI's
# service key (WORKSPACE_SERVICE_KEYS owui=<key>); the isolation sweep plants B's intake jobs. -IntakeOnly runs
# [5e] and the sweep alone (skips [5a]/[5b]: their RED expectations are P2b's, against a pre-P2b -BaseSha).
# rw-p8a4-ideas adds [5h]: the ideas panel's and the refinery view's integration test (src/ideas/ideas_integration_test.ts):
# the owner-checked idea functions (slot 370) as two users and as the app role, the refinery's dossier into the room,
# archive, the user source list. -IdeasOnly runs [5h] and the sweep alone; with -Red -IdeasOnly the initdb chain is
# staged from -BaseSha too (the base has no slot 370), the sweep is skipped, and [5h] must fail.
# rw-settings-store adds [5j] the settings store's integration test (src/settings/settings_integration_test.ts: two users,
# the tiers, validation, setting_get, the database's guard), [5k] the REAL idea refinery image's next pass reading each
# idea owner's refinery.dormancy_days, [5l] the digest's window and the podcast's team read per run for the run owner
# (recipes/daily-digest/lab/settings-probe.ts over the real PostgREST), [5m] slot 400 init twice more + revert twice +
# init again, [5n] slot 400 applied to an already-running PostgREST (round 2, G2), and B's settings in the isolation sweep. -SettingsOnly runs those and the sweep alone; with -Red
# -SettingsOnly the chain is staged from -BaseSha (no slot 400), the sweep is skipped, and [5j] must fail.
# rw-idea-privacy adds [5p] (not with -Red or -SettingsOnly; it was [5j] before the integration with rw-settings-store): slot 380 over planted pre-370 idea thoughts and the wiki pages / vault files that show
# them (src/ideas/idea_privacy_integration_test.ts in phases around psql runs): RED before 380 runs and with round 1's 380
# (-PrivacyPrevSha), init x2, the viewer's reconcile repair, the deploy step (files out), revert x2 byte-identical, two mutants
# without an archive step refused, init again - so the sweep that follows runs on the migrated database.
# rw-inlet-owner adds [5r] (plan 08 PD1, slot 440; with -Red only together with -IdeasOnly): a marker in every personal field
# (inlet-owner-plant.sql), src/inlet/inlet_owner_integration_test.ts in phases around init-inlet-owner.sql / revert-inlet-owner.sql:
# RED (the base, before 440 runs, and round 1's 410), the refusals, init x2, the reconcile repair, the deploy step, revert x2 byte-identical,
# three mutants refused, init again, late unowned rows and the second run - the sweep then runs on that state.
# It never touches the live stack. Exit 0 = every check passed (with -Red: every case FAILED).
param(
  [string]$Id = 'wt-rw-p2b-workspace',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
  [string]$CaddyImage = 'caddy:2-alpine',
  [string]$ChromeImage = 'chromedp/headless-shell@sha256:53cc0f33c0598ff244f6e45458f6dfaf0ae4206d388ae7364903afd1d9d14f0a',
  [string]$BaseSha = '767c461',
  [switch]$Red,
  [switch]$WalkOff,
  [string]$Cases = '',
  [switch]$KeepImages,
  [switch]$IntakeOnly,
  [switch]$IdeasOnly,
  [switch]$SettingsOnly,
  # rw-idea-privacy: the previous round's slot 380 the [5p] RED step runs (round 4: 0b5b646 - its 8-word rule withholds
  # a general page that shares wording with an idea), and the wiki writer the R1 probe's RED runs
  [string]$PrivacyPrevSha = '0b5b646',
  [string]$PrivacyR1BaseSha = '0b5b646',
  # rw-report-isolation round 2: the round-1 slot 390 the [5q] RED step runs (it deletes the leaf row, not the copies)
  [string]$ReportRoundOneSha = '364eba0',
  # rw-report-isolation round 3: the round-2 slot 390 the [5q] thread RED runs (it leaves the reports' text in the threads)
  [string]$ReportRoundTwoSha = '30408c6',
  # round 4: the round-3 slot 390 (it reads "minted" from the stored label only)
  [string]$ReportRoundThreeSha = 'b125959',
  # round 5: the round-4 slot 390 (it reads "existing" from started_at, which a re-run resets)
  [string]$ReportRoundFourSha = '1d33b53',
  # round 6: the round-5 slot 390 (its tie set misses an errored minting job's filed event; it classifies by time)
  [string]$ReportRoundFiveSha = '65a8203',
  # round 7: the round-6 slot 390 (it relabels sources by the thread's CURRENT name)
  [string]$ReportRoundSixSha = 'ccaf4c9',
  # rw-inlet-owner [5r]: the base whose prune-short-term.ts is the prune's RED (the development pin before slot 410)
  [string]$InletBaseSha = '8241755',
  # rw-inlet-owner round 2: round 1's migration and recipes (the RED of the round-2 cases)
  [string]$InletPrevSha = '2e0768e',
  # rw-inlet-owner round 3: round 2's migration (the RED of the seed-body case)
  [string]$InletPrev2Sha = '6d79704'
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
. (Join-Path $PSScriptRoot 'harness-subnet.ps1')
$w = Test-HarnessSubnet $Subnet
if ($w) { Write-Host "REFUSED: $w"; exit 2 }
$subnets = Split-HarnessSubnet $Subnet
if ($Evidence -and (Test-Path $Evidence) -and @(Get-ChildItem -Force $Evidence).Count) { Write-Host "REFUSED: -Evidence $Evidence is not empty"; exit 2 }

$label = "ai-stack.harness.owner=$Id"
$ct = $PSScriptRoot
$wb = Split-Path -Parent $ct
$dockerDir = Split-Path -Parent $wb
$ob1 = Split-Path -Parent $dockerDir
$repo = Split-Path -Parent $ob1
$viewerDir = Join-Path $dockerDir 'wiki-viewer'
$wsDir = Join-Path $viewerDir 'workspace'
$short = ($Id -replace '^wt-', '')
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$P = "rwp2b-$rand"
$net = "$P-net"
$wbTag = "openbrain-workbench:wt-$short"; $wbTestTag = "openbrain-workbench:wt-$short-test"
$viewerTag = "openbrain-wiki-viewer:wt-$short"; $e2eTag = "openbrain-workspace-e2e:wt-$short"
if ($Red) { $wbTag = "openbrain-workbench:wt-$short-base"; $wbTestTag = "openbrain-workbench:wt-$short-test"; $viewerTag = "openbrain-wiki-viewer:wt-$short-base" }
$refTag = "openbrain-idea-refinery:wt-$short-refinery" # rw-settings-store [5k]
$baseChain = $IdeasOnly -or $SettingsOnly # the -Red run's chain comes from -BaseSha (the base has neither slot 370 nor 400)
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$key = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$wsKey = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$gateKey = -join ((48..57 + 97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
# rw-p8a2-cleanup2 (review M1): one service key, so the cleanup integration test can declare an automation eraser as a
# service (a signed-in user may not)
$svcKey = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$owuiKey = -join ((48..57 + 97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
$evStage = Join-Path $env:TEMP "$P-evstage"; New-Item -ItemType Directory -Force $evStage | Out-Null
$shots = Join-Path $env:TEMP "$P-shots"; New-Item -ItemType Directory -Force $shots | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$vault = Join-Path $env:TEMP "$P-vault"; New-Item -ItemType Directory -Force $vault | Out-Null
# the vault files of fixtures.sql's wiki_pages rows, written BEFORE the rows (older than them): a row
# with no file is an orphan, which the viewer presents as pending and its health counts as drift
foreach ($fx in @(@('content/tool/tool-fixture', 'Tool Fixture', 'An entity page about contract retrieval fixtures.'),
    @('content/source/11111111-1111-4111-8111-111111111111', 'Active fixture source', 'Leaf.'),
    @('content/source/22222222-2222-4222-8222-222222222222', 'Suppressed fixture source', 'Leaf.'))) {
  $fxPath = Join-Path $vault ($fx[0] + '.md')
  New-Item -ItemType Directory -Force (Split-Path -Parent $fxPath) | Out-Null
  [System.IO.File]::WriteAllText($fxPath, "---`ntitle: $($fx[1])`n---`n$($fx[2])`n", (New-Object System.Text.UTF8Encoding $false))
}
. (Join-Path $PSScriptRoot 'evidence-gate.ps1')

$script:fail = 0
$script:made = @{ net = $false; containers = @(); images = @(); dirs = @($evStage, $stage, $vault, $shots) }
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $evStage $name), $text, (New-Object System.Text.UTF8Encoding $false)) }

# -- the lab docker shim ------------------------------------------------------------------
function Test-LabDockerArgs([string[]]$a) {
  $all = ($a -join ' ')
  if ($a.Count -and $a[0] -eq 'compose') { return 'docker compose is never used by the lab' }
  if ($all -match '192\.168\.') { return 'a 192.168.x address' }
  if ($all -match '(^|[\s=:/])(ai-stack_|open-brain_)') { return 'an ai-stack_* / open-brain_* name' }
  for ($i = 0; $i -lt $a.Count; $i++) {
    $x = $a[$i]
    if ($x -match '^(-p|-P|--publish|--publish-all)$' -or $x -match '^--publish(-all)?=' -or $x -match '^-p\d') { return "a published port ($x)" }
    if ($x -match '^--net(work)?$') { $v = $a[$i + 1]; if ($v -ne $net -and $v -ne 'none') { return "network '$v' is not this run's" } }
    if ($x -match '^--net(work)?=(.+)$') { if ($Matches[2] -ne $net -and $Matches[2] -ne 'none') { return "network '$($Matches[2])' is not this run's" } }
    if ($x -match '^(-d|--driver)$' -and $a[0] -eq 'network' -and $a[$i + 1] -match 'macvlan|ipvlan') { return 'a macvlan / ipvlan driver' }
    # a :local image is never run, built, tagged or removed (listing and inspecting them is read-only)
    if ($x -match '(^|[/=])[^ ]*:local$' -and $a[0] -notin @('images', 'image')) { return "a :local image ($x)" }
  }
  if ($all -match 'macvlan|ipvlan') { return 'a macvlan / ipvlan driver' }
  if ($a.Count -ge 2 -and $a[0] -eq 'network' -and $a[1] -eq 'create') {
    if ($a -notcontains '--internal') { return 'a network that is not --internal' }
    if (($a -join ' ') -notmatch [regex]::Escape("--subnet $($subnets.run)")) { return 'a network not on the pinned subnet' }
  }
  if ($a.Count -and $a[0] -eq 'build') {
    for ($i = 0; $i -lt $a.Count; $i++) {
      if ($a[$i] -eq '-t' -and $a[$i + 1] -notmatch ":wt-$([regex]::Escape($short))(-[a-z0-9]+)?$") { return "a build tag that is not :wt-$short ($($a[$i + 1]))" }
    }
  }
  return ''
}
# Positional only: a docker flag such as -t or -a must never bind to a parameter of this function.
function Lab-Docker([int]$TimeoutSec, [string[]]$a) {
  $why = Test-LabDockerArgs $a
  if ($why) { Write-Host "  SHIM REFUSED: $why :: docker $($a -join ' ')"; $script:rc = 2; $script:fail++; return "REFUSED: $why" }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'docker'
  $psi.Arguments = ($a | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) {
    try { $p.Kill() } catch { }
    $script:rc = 124
    return "TIMEOUT after ${TimeoutSec}s: docker $($a[0..([Math]::Min(3, $a.Count - 1))] -join ' ')"
  }
  $p.WaitForExit()
  $script:rc = $p.ExitCode
  return (($out.Result + $err.Result) -replace "`r", '').TrimEnd()
}
function Dk { Lab-Docker 300 ([string[]]$args) }
function DkLong { Lab-Docker 2400 ([string[]]$args) }

# the shim's own RED: each refused shape is refused before docker runs
$shimCases = @(
  @('run', '-p', '8080:8080', 'x'), @('run', '--network', 'ai-stack_app-net', 'x'), @('network', 'create', '--driver', 'macvlan', 'n'),
  @('network', 'create', 'n'), @('run', 'openbrain-workbench:local'), @('run', '-e', 'X=192.168.1.20', 'x'), @('compose', 'up'),
  @('build', '-t', 'openbrain-workbench:local', '.'), @('run', '--publish=1:1', 'x'))
$shimRefused = @($shimCases | Where-Object { Test-LabDockerArgs $_ }).Count
Check ($shimRefused -eq $shimCases.Count) "the lab docker shim refuses every forbidden shape ($shimRefused / $($shimCases.Count))"

function LocalSnapshot { (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim() -split "`n" | Sort-Object }
$localBefore = LocalSnapshot

function Run-Detached([string]$name, [string[]]$extra) {
  $o = Dk run -d --name $name --label $label --network $net @extra
  if ($script:rc -ne 0) { Fail "$name did not start: $o"; return $false }
  $script:made.containers += $name
  return $true
}
function Wait-Http([string]$url, [int]$tries = 60) {
  for ($i = 0; $i -lt $tries; $i++) {
    $null = Dk run --rm --label $label --network $net --entrypoint node $viewerTag -e "fetch('$url').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
    if ($script:rc -eq 0) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}
function Build-At([string]$sha, [string]$tag, [string]$target, [string]$what) {
  # a pristine tree of OB1 at $sha (git archive): the RED images, never the working tree
  $tree = Join-Path $env:TEMP "$P-tree-$sha"
  if (-not (Test-Path $tree)) {
    New-Item -ItemType Directory -Force $tree | Out-Null
    $script:made.dirs += $tree
    $tar = Join-Path $env:TEMP "$P-$sha.tar"
    & git -C $ob1 archive --format=tar -o $tar $sha
    & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $tar -C $tree  # the Windows tar (rw-p8a4-ideas: a GNU tar on PATH reads C: as a host)
    Remove-Item -Force $tar
    if ($WalkOff) {
      # the base predates the switch: one line after the route runs, so the walk can be turned off
      $os = Join-Path $tree 'docker/workbench/src/middleware/owner-scope.ts'
      if ((Test-Path $os) -and -not ((Get-Content -Raw $os) -match 'WORKSPACE_RESPONSE_WALK')) {
        $t = (Get-Content -Raw $os) -replace '(?m)^([ \t]*)await next\(\);', '$1await next();$1if ((Deno.env.get("WORKSPACE_RESPONSE_WALK") ?? "") === "off") return;'
        [System.IO.File]::WriteAllText($os, $t, (New-Object System.Text.UTF8Encoding $false))
      }
    }
  }
  $ctx = if ($what -eq 'workbench') { Join-Path $tree 'docker/workbench' } else { Join-Path $tree 'docker/wiki-viewer' }
  $args2 = @('build', '--label', $label, '--build-arg', "OB1_SHA=$sha", '-t', $tag)
  if ($target) { $args2 += @('--target', $target) }
  if ($what -eq 'viewer') { $args2 += @('--build-context', "recipes=$(Join-Path $tree 'recipes')") }
  return DkLong @args2 $ctx
}

try {
  Write-Host "== rw-p2b-workspace lab run  owner=$Id  net=$net  red=$([bool]$Red)  evidence=$Evidence"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  # ---------------------------------------------------------------- 1. the initdb chain
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $chainDir = $dockerDir
  if ($Red -and $baseChain) {
    # rw-p8a4-ideas: the base's own chain (no slot 370), from a pristine tree of -BaseSha
    $baseTree = Join-Path $env:TEMP "$P-chain-$BaseSha"
    New-Item -ItemType Directory -Force $baseTree | Out-Null
    $script:made.dirs += $baseTree
    $tarC = Join-Path $env:TEMP "$P-chain.tar"
    & git -C $ob1 archive --format=tar -o $tarC $BaseSha docker integrations/intake
    & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $tarC -C $baseTree  # the Windows tar: a GNU tar on PATH reads C: as a host
    Remove-Item -Force $tarC
    $chainDir = Join-Path $baseTree 'docker'
  }
  $compose = Get-Content -Raw (Join-Path $chainDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $chainDir $m[0]) (Join-Path $stage $m[1]) }
  Check (@($chain | Where-Object { $_[1] -eq '270-init-documents.sql' }).Count -eq 1) "the chain mounts 270-init-documents.sql ($($chain.Count) migrations)"
  if (-not $Red) { Check (@($chain | Where-Object { $_[1] -eq '370-init-idea-functions.sql' }).Count -eq 1) 'the chain mounts 370-init-idea-functions.sql (rw-p8a4-ideas)' }
  if (-not $Red) { Check (@($chain | Where-Object { $_[1] -eq '380-init-idea-privacy.sql' }).Count -eq 1) 'the chain mounts 380-init-idea-privacy.sql (rw-idea-privacy)' }
  if (-not $Red) { Check (@($chain | Where-Object { $_[1] -eq '400-init-settings.sql' }).Count -eq 1) 'the chain mounts 400-init-settings.sql (rw-settings-store)' }
  if (-not $Red) { Check (@($chain | Where-Object { $_[1] -eq '440-init-inlet-owner.sql' }).Count -eq 1) 'the chain mounts 440-init-inlet-owner.sql (rw-inlet-owner, after 430)' }

  # ---------------------------------------------------------------- 2. network
  Write-Host '[2] the internal network'
  $null = Dk network create --driver bridge --internal --subnet $subnets.run --label $label $net
  Check ($script:rc -eq 0) "network $net (internal, $($subnets.run))"
  if ($script:rc -ne 0) { throw 'network' }
  $script:made.net = $true

  # ---------------------------------------------------------------- 3. images
  Write-Host '[3] images'
  if ($Red) {
    $o = Build-At $BaseSha $wbTag '' 'workbench'; Save 'build-workbench-base.log' $o
    Check ($script:rc -eq 0) "RED: $wbTag built from OB1 $BaseSha"
    $script:made.images += $wbTag
    $o = Build-At $BaseSha $viewerTag '' 'viewer'; Save 'build-viewer-base.log' ($o -split "`n" | Select-Object -Last 60 | Out-String)
    Check ($script:rc -eq 0) "RED: $viewerTag built from OB1 $BaseSha"
    $script:made.images += $viewerTag
  } else {
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" -t $wbTag $wb; Save 'build-workbench.log' ($o -split "`n" | Select-Object -Last 80 | Out-String)
    Check ($script:rc -eq 0) "$wbTag built at OB1 $($sha.Substring(0, 7)) (its test gate passed: grammar, hub clustering, contracts, export)"
    if ($script:rc -ne 0) { throw 'build workbench' }
    $script:made.images += $wbTag
    $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --build-context "recipes=$(Join-Path $ob1 'recipes')" -t $viewerTag $viewerDir
    Save 'build-viewer.log' ($o -split "`n" | Select-Object -Last 120 | Out-String)
    Check ($script:rc -eq 0) "$viewerTag built (its workspace stage: vitest, the D9 notices check, tsc + vite build)"
    if ($script:rc -ne 0) { throw 'build viewer' }
    $script:made.images += $viewerTag
    $vt = ([regex]'Tests\s+(\d+) passed').Match(($o -replace '\x1b\[[0-9;]*m', ''))
    if ($vt.Success) { Pass "workspace unit tests in the image build: $($vt.Groups[1].Value) passed" }
  }
  # the integration test runs from THIS tree's test stage in both modes (RED: against the base workbench)
  $o = DkLong build --label $label --build-arg "OB1_SHA=$sha" --target test -t $wbTestTag $wb; Save 'build-workbench-test.log' ($o -split "`n" | Select-Object -Last 40 | Out-String)
  Check ($script:rc -eq 0) "$wbTestTag (the test stage) built"
  $script:made.images += $wbTestTag
  $o = DkLong build --label $label -t $e2eTag (Join-Path $wsDir 'e2e'); Save 'build-e2e.log' ($o -split "`n" | Select-Object -Last 20 | Out-String)
  Check ($script:rc -eq 0) "$e2eTag (playwright-core + pg, lab only) built"
  $script:made.images += $e2eTag
  if (-not $Red) {
    # rw-settings-store [5k]: the idea refinery's own image (its Dockerfile: dependencies cached, deno check)
    $o = DkLong build --label $label -t $refTag (Join-Path $ob1 'integrations/openbrain-idea-refinery'); Save 'build-refinery.log' ($o -split "`n" | Select-Object -Last 20 | Out-String)
    Check ($script:rc -eq 0) "$refTag (the idea refinery, lab only) built"
    $script:made.images += $refTag
  }

  # ---------------------------------------------------------------- 4. the lab
  Write-Host '[4] the lab'
  $db = "$P-db"
  if (-not (Run-Detached $db @('--network-alias', 'openbrain-db', '-e', "POSTGRES_PASSWORD=$pw", '-e', 'POSTGRES_DB=openbrain', '-v', "${stage}:/docker-entrypoint-initdb.d:ro", $PgImage))) { throw 'db' }
  for ($i = 0; $i -lt 150; $i++) { if ((Dk logs $db) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $logs = Dk logs $db
  Check ($logs -match 'PostgreSQL init process complete') 'the database ran the initdb chain'
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "initdb logged no ERROR ($($errs.Count))"
  if ($errs.Count) { Save 'initdb-errors.log' ($errs -join "`n") }
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role) - the production shape'
  $null = Dk cp (Join-Path $ct 'fixtures.sql') "${db}:/tmp/fixtures.sql"
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/fixtures.sql
  Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) 'fixtures applied'

  $ctMount = "${ct}:/ct:ro"
  $null = Run-Detached "$P-embed" @('--network-alias', 'stub-embed', '-v', $ctMount, '--entrypoint', 'deno', $wbTag, 'run', '--allow-net', '/ct/stub-embed.ts')
  $null = Run-Detached "$P-research" @('--network-alias', 'stub-research', '-v', $ctMount, '-e', "DB_HOST=$db", '-e', "DB_PASSWORD=$pw",
      '-e', "STUB_CALLERS=workspace=workspace:$wsKey", '--entrypoint', 'deno', $wbTag, 'run', '--allow-net', '--allow-env', '--allow-read', '--config', '/app/deno.json', '/ct/stub-research.ts')
  # rw-workbench-fetch-posture: a held link's replace goes through the search gate's /v1/fetch (a stub
  # here, stub-gate.ts) to the lab target site (stub-target.ts) - never the egress proxy, never direct
  # rw-p5a-intake: the extractor a PDF / saved page goes through (stub-extract.ts)
  $null = Run-Detached "$P-extract" @('--network-alias', 'stub-extract', '-v', $ctMount, '--entrypoint', 'deno', $wbTag, 'run', '--allow-net', '/ct/stub-extract.ts')
  $null = Run-Detached "$P-target" @('--network-alias', 'stub-target', '-v', $ctMount, '--entrypoint', 'deno', $wbTag, 'run', '--allow-net', '/ct/stub-target.ts')
  $null = Run-Detached "$P-gate" @('--network-alias', 'stub-gate', '-v', $ctMount, '-e', "STUB_GATE_KEY=$gateKey", '-e', 'STUB_GATE_ALLOW=stub-target:8080',
      '--entrypoint', 'deno', $wbTag, 'run', '--allow-net', '--allow-env', '/ct/stub-gate.ts')
  $null = Run-Detached "$P-postgrest" @('--network-alias', 'openbrain-postgrest', '-e', "PGRST_DB_URI=postgres://postgres:$pw@openbrain-db:5432/openbrain",
      '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=service_role', '-e', 'PGRST_DB_POOL=4', '-e', 'PGRST_SERVER_PORT=3000', $PgrstImage)
  $null = Run-Detached "$P-rest" @('--network-alias', 'openbrain-rest', '-v', "$(Join-Path $dockerDir 'Caddyfile'):/etc/caddy/Caddyfile:ro", $CaddyImage)
  $null = Run-Detached "$P-viewer" @('--network-alias', 'openbrain-wiki-viewer', '-e', 'OPEN_BRAIN_URL=http://openbrain-rest', '-e', 'WIKI_NAV_MIN_ROWS=0',
      '-e', 'WIKI_BUILDER=0', '-e', 'WIKI_DB_TCP=openbrain-db:5432', '-e', 'WIKI_DB_PROBE_MS=1000', '-e', 'WIKI_RECONCILE_INTERVAL_MS=5000',
      '-e', 'NODE_OPTIONS=--max-old-space-size=2048', '-e', 'WORKBENCH_URL=http://openbrain-workbench:8000', '-e', "WORKBENCH_KEY=$key",
      '-e', "WIKI_VIEWER_ALLOWED_HOSTS=$P-viewer", '-v', "${vault}:/wiki:ro", $viewerTag)
  $wbArgs = @('--network-alias', 'openbrain-workbench', '-e', 'PORT=8000', '-e', "WORKBENCH_KEY=$key",
      '-e', "DB_HOST=$db", '-e', 'DB_USER=ob_app_memory', '-e', "DB_PASSWORD=$appPw", '-e', 'OPEN_BRAIN_URL=http://openbrain-rest',
      '-e', 'EMBEDDING_API_BASE=http://stub-embed:8080/v1', '-e', 'EXTRACT_URL=http://stub-extract:8000', '-e', 'WIKI_GIT_DIR=/wiki',
      '-e', 'WIKI_ASSETS_DIR=/wiki/assets', '-e', 'CONTRACT_MOUNTS_ROOT=/mounts', '-e', 'RESEARCH_URL=http://stub-research:8000',
      '-e', "RESEARCH_WORKSPACE_KEY=$wsKey", '-e', 'RESEARCH_SCORER_URL=http://stub-research:8000', '-e', "RESEARCH_SCORER_KEY=$wsKey", '-e', 'WORKBENCH_GATE_URL=http://stub-gate:8080', '-e', "WORKBENCH_GATE_KEY=$gateKey", '-e', "VIEWER_NAV_URL=http://$P-viewer:8082",
      '-e', 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub', '-e', "WORKSPACE_SERVICE_KEYS=cleanup-test=$svcKey;owui=$owuiKey",
      '-v', "${vault}:/wiki", '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro")
  $walkEnv = if ($WalkOff) { @('-e', 'WORKSPACE_RESPONSE_WALK=off') } else { @() }
  $null = Run-Detached "$P-wb" ($wbArgs + $walkEnv + @($wbTag))
  # the front door is the viewer itself (rw-identity-harden): the portal Caddy's (wiki_app) snippet no
  # longer has a /workbench/* route, and the edge (Traefik) targets the viewer alone
  $front = "http://${P}-viewer:8080"
  $null = Run-Detached "$P-chrome" @('--shm-size=1g', $ChromeImage)
  Check (Wait-Http "http://$P-wb:8000/health" 90) 'the workbench is up'
  # /workspace/, not /__health: the viewer's health reports the lab wiki's reconcile state, not the door
  Check (Wait-Http "$front/workspace/" 90) 'the front door (the viewer) answers'
  # the new edge (operator 2026-10-28): Traefik targets the VIEWER alone - it serves /workspace and
  # forwards /workbench/* with the key server-side, dropping any key a client sends
  $edge = Dk run --rm --label $label --network $net --entrypoint node $viewerTag --input-type=module -e "
    const v = 'http://$P-viewer:8080';
    const ws = await fetch(v + '/workspace/'); const wsBody = await ws.text();
    const docs = await fetch(v + '/workbench/contract/documents', { headers: { 'x-brain-key': 'forged-by-the-client' } });
    const bare = await fetch('http://$P-wb:8000/workbench/contract/documents', { headers: { 'x-brain-key': 'forged-by-the-client' } });
    console.log('workspace', ws.status, ws.headers.get('x-wiki-render'), wsBody.includes('id=\x22root\x22'));
    console.log('forwarded', docs.status, 'direct-with-forged-key', bare.status);
    const csrf = await fetch(v + '/workbench/documents', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: '{}' });
    const noOrigin = await fetch(v + '/workbench/documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const http = await import('node:http');
    const rebind = await new Promise((ok) => { const q = http.request({ host: '$P-viewer', port: 8080, path: '/workbench/contract/documents', headers: { host: 'rebound.example:8080' } }, (r) => { r.resume(); ok(r.statusCode); }); q.on('error', () => ok(0)); q.end(); });
    const own = await fetch(v + '/workbench/contract/diff-check', { method: 'POST', headers: { origin: v, 'content-type': 'application/json' }, body: '{}' });
    const ownBody = await own.text();
    console.log('guard csrf', csrf.status, 'no-origin', noOrigin.status, 'rebind', rebind, 'own-origin', /viewer's own origin|answers for/.test(ownBody) ? 'GUARDED' : 'reached-workbench');"
  Save 'edge-viewer.log' $edge
  if ($Red -and -not $baseChain) { Check ($edge -match 'workspace \d+ ' -and $edge -notmatch 'workspace 200 workspace true') 'RED: the base viewer does not serve /workspace' }
  else { Check ($edge -match 'workspace 200 workspace true') 'the viewer serves /workspace (x-wiki-render: workspace)' }
  Check ($edge -match 'forwarded 200 direct-with-forged-key 401') 'the viewer forwards /workbench/* with the key injected server-side; a client key is never trusted'
  if (-not $Red) { Check ($edge -match 'guard csrf 403 no-origin 403 rebind 421 own-origin reached-workbench') 'the forwarder refuses a cross-origin or Origin-less write (403) and a rebound Host (421); a write from the viewer''s own origin reaches the workbench' }
  $chromeIp = (Dk inspect -f "{{(index .NetworkSettings.Networks `"$net`").IPAddress}}" "$P-chrome").Trim()
  Check ($chromeIp -match '^\d+\.\d+\.\d+\.\d+$') 'the headless Chromium is on the network'

  # ---------------------------------------------------------------- 5. the tests
  if (-not $IntakeOnly -and -not $IdeasOnly -and -not $SettingsOnly) {
  Write-Host '[5a] the documents API integration test (as ob_app_memory? no: the fault trigger needs the superuser; the workbench itself runs as ob_app_memory)'
  $o = Lab-Docker 900 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${vault}:/vault",
    '-e', "DOCS_TEST_BASE=http://$P-wb:8000", '-e', "DOCS_TEST_KEY=$key", '-e', 'DOCS_TEST_VAULT=/vault', '-e', 'DOCS_TEST_PROXY_HOST=stub-target:8080',
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', 'src/documents/documents_integration_test.ts')
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save 'documents-integration.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||passed|failed' }) -join "`n")
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)' }) { Write-Host "    $l" }
  if ($Red) { Check ($sum.Success -and [int]$sum.Groups[2].Value -eq 0) "RED: the integration test fails on the base ($($sum.Value))" }
  else { Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0) "the documents API integration test ($($sum.Value))" }

  # rw-p8a2-cleanup: the cleanup view's routes as two users (D5 items 4-7; 07-MULTI-USER), on sources of its own
  Write-Host '[5a2] the cleanup view integration test (two users through the identity header)'
  $o = Lab-Docker 900 @('run', '--rm', '--label', $label, '--network', $net,
    '-e', "DOCS_TEST_BASE=http://$P-wb:8000", '-e', "DOCS_TEST_KEY=$key", '-e', "CLEANUP_TEST_SERVICE_KEY=$svcKey",
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', 'src/contracts/cleanup_integration_test.ts')
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save 'cleanup-integration.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||passed|failed|AssertionError|error:' }) -join "`n")
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)' }) { Write-Host "    $l" }
  if ($Red) { Check (-not ($sum.Success -and $sum.Groups[1].Value -eq 'ok')) "RED: the cleanup integration test does not pass on the base ($($sum.Value))" }
  else { Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0) "the cleanup view integration test ($($sum.Value))" }
  if ($sum.Success -and [int]$sum.Groups[3].Value -gt 0) { Save 'cleanup-integration-tail.log' (($clean -split "`n" | Select-Object -Last 60) -join "`n") }

  Write-Host '[5b] the workspace e2e in a headless Chromium, through the front door'
  $o = Lab-Docker 1200 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${shots}:/ev", '-e', "FRONT=$front",
    '-e', "CDP=http://${chromeIp}:9222", '-e', "PGHOST=$db", '-e', "PGPASSWORD=$pw", '-e', "CASES=$Cases", $e2eTag)
  Save 'workspace-e2e.log' ((($o -replace '\x1b\[[0-9;]*m', '') -split "`n" | Where-Object { $_ -match '^\s+(PASS|FAIL)|^E2E:' }) -join "`n")
  foreach ($l in ($o -split "`n") | Where-Object { $_ -match '^\s+(PASS|FAIL)|^E2E:' }) { Write-Host "    $l" }
  $e2e = ([regex]'E2E: (\d+) passed, (\d+) failed').Match($o)
  if ($Red) { Check ($e2e.Success -and [int]$e2e.Groups[1].Value -eq 0) "RED: every e2e case fails on the base ($($e2e.Value))" }
  else { Check ($e2e.Success -and [int]$e2e.Groups[2].Value -eq 0) "the workspace e2e ($($e2e.Value))" }
  if (-not $e2e.Success) { Save 'workspace-e2e-tail.log' (($o -split "`n" | Select-Object -Last 40) -join "`n") }
  }

  # rw-p8a4-ideas: the ideas panel and the refinery view over the real workbench and database (two users + the app role)
  if (-not $SettingsOnly) {
  Write-Host '[5h] the ideas and refinery view integration test (owner-checked idea functions, the dossier into the room, archive, user sources)'
  $o = Lab-Docker 900 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${vault}:/vault", '-e', 'DOCS_TEST_VAULT=/vault',
    '-e', "DOCS_TEST_BASE=http://$P-wb:8000", '-e', "DOCS_TEST_KEY=$key",
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', 'src/ideas/ideas_integration_test.ts')
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save 'ideas-integration.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||passed|failed|error:|AssertionError|Values are not equal|\[Diff\]|^\s+[-+]' }) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)' }) { Write-Host "    $l" }
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
  if ($Red) { Check ($sum.Success -and $sum.Groups[1].Value -eq 'FAILED' -and [int]$sum.Groups[3].Value -gt 0) "RED: the ideas integration test fails on the base ($($sum.Value))" }
  else { Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0) "the ideas integration test ($($sum.Value))" }
  }

  # rw-settings-store [5j]: the settings store over the real workbench and database
  Write-Host '[5j] the settings store integration test (two users, the tiers, validation, setting_get, the database guard)'
  $o = Lab-Docker 900 @('run', '--rm', '--label', $label, '--network', $net,
    '-e', "DOCS_TEST_BASE=http://$P-wb:8000", '-e', "DOCS_TEST_KEY=$key",
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', 'src/settings/settings_integration_test.ts')
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save 'settings-integration.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||passed|failed|error:|AssertionError|Values are not equal|\[Diff\]|^\s+[-+]' }) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)' }) { Write-Host "    $l" }
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
  if ($Red) { Check ($sum.Success -and $sum.Groups[1].Value -eq 'FAILED' -and [int]$sum.Groups[3].Value -gt 0) "RED: the settings integration test fails on the base ($($sum.Value))" }
  else { Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0) "the settings integration test ($($sum.Value))" }

  if (-not $Red) {
    # rw-settings-store [5k]: "a stored refinery value is what the service reads on its next run" - the REAL refinery
    # (its image, as ob_app_memory, the production role) ages two users' quiet ideas on POST /run
    Write-Host '[5k] the refinery''s next pass reads each idea owner''s refinery.dormancy_days (the real refinery image)'
    $ra = "settings-ref-a-$rand"; $rb = "settings-ref-b-$rand"
    $ia = [guid]::NewGuid().ToString(); $ib = [guid]::NewGuid().ToString()
    $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "INSERT INTO public.ideas (id, title, summary, status, current_revision, owner_sub, updated_at) VALUES ('$ia', 'settings dormancy A', 'a', 'researched', 1, '$ra', now() - interval '5 days'), ('$ib', 'settings dormancy B', 'b', 'researched', 1, '$rb', now() - interval '5 days')"
    Check ($script:rc -eq 0) "[5k] two users' researched ideas, five days without engagement $o"
    $null = Run-Detached "$P-refinery" @('-e', 'PORT=8080', '-e', "DB_HOST=$db", '-e', 'DB_USER=ob_app_memory', '-e', "DB_PASSWORD=$appPw",
      '-e', 'RESEARCH_URL=http://stub-research:8000', '-e', 'IDEA_DELIVERY_POLL_MS=3600000', $refTag)
    Check (Wait-Http "http://$P-refinery:8080/health" 60) '[5k] the refinery is up (no Mattermost token: brainstorm off, delivery to the room only)'
    $refRun = { Dk run --rm --label $label --network $net --entrypoint node $viewerTag -e "fetch('http://$P-refinery:8080/run?wait=1',{method:'POST'}).then(async r=>console.log('run', r.status, await r.text())).catch(e=>console.log('run ERR', e.message))" }
    $states = { ((Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT owner_sub || '=' || status FROM public.ideas WHERE id IN ('$ia', '$ib') ORDER BY owner_sub") -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) -join ' ' }
    $putAs = { param($who, $days) Dk run --rm --label $label --network $net --entrypoint node $viewerTag -e "fetch('http://$P-wb:8000/workbench/settings/refinery.dormancy_days',{method:'PUT',headers:{'x-brain-key':'$key','content-type':'application/json','X-Test-Sub':'$who'},body:JSON.stringify({value:$days})}).then(r=>console.log('put', r.status))" }
    $r1 = & $refRun; $s1 = & $states
    $p1 = & $putAs $ra 3
    $r2 = & $refRun; $s2 = & $states
    $p2 = & $putAs $rb 2
    $r3 = & $refRun; $s3 = & $states
    $refLog = (Dk logs "$P-refinery") -split "`n" | Select-Object -Last 30
    Save 'refinery-next-run.log' ("pass 1 (nothing stored): $r1`n  -> $s1`nA stores 3 days: $p1`npass 2: $r2`n  -> $s2`nB stores 2 days: $p2`npass 3: $r3`n  -> $s3`n--- refinery log (tail) ---`n" + ($refLog -join "`n"))
    Write-Host "    pass 1: $s1 | pass 2: $s2 | pass 3: $s3"
    Check ($s1 -eq "$ra=researched $rb=researched") "[5k] nothing stored: neither idea is dormant on the pass (the 14-day default, as today) ($s1)"
    Check ($p1 -match 'put 200' -and $s2 -eq "$ra=dormant $rb=researched") "[5k] A stores 3 days: A's idea goes dormant on the NEXT pass, B's does not ($s2)"
    Check ($p2 -match 'put 200' -and $s3 -eq "$ra=dormant $rb=dormant") "[5k] B stores 2 days: B's goes dormant on the pass after ($s3)"
    $null = Dk rm -f "$P-refinery"

    # rw-settings-store [5l]: the digest's AI-news window and the podcast's team, per run for the run owner
    Write-Host '[5l] the digest''s window and the podcast''s team are read per run for the run owner (the services'' own functions, real PostgREST)'
    $pa = "settings-pod-a-$rand"; $pb = "settings-pod-b-$rand"; $team = "settings-team-$rand"
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "INSERT INTO public.podcast_teams (id, owner_sub, name) VALUES ('$team', '$pa', 'probe team $rand')"
    $o = Lab-Docker 300 @('run', '--rm', '--label', $label, '--network', $net, '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro",
      '-e', 'PROBE_REST=http://openbrain-rest', '-e', "PROBE_WB=http://$P-wb:8000", '-e', "PROBE_KEY=$key",
      '-e', "PROBE_OWNER=$pa", '-e', "PROBE_OTHER=$pb", '-e', "PROBE_TEAM=$team",
      '--entrypoint', 'deno', $wbTag, 'run', '--no-config', '--allow-net', '--allow-env', '/recipes/daily-digest/lab/settings-probe.ts')
    Save 'settings-probe.log' $o
    foreach ($l in ($o -split "`n") | Where-Object { $_ -match '^PROBE' }) { Write-Host "    $l" }
    Check ($o -match 'PROBE OK \(0 failed\)') '[5l] the digest and the podcast read the owner''s stored value on their next run, the env value otherwise'
  }

  # rw-settings-store round 2 (review G2) [5n]: slot 400 applied to an ALREADY-RUNNING PostgREST (the live deploy's
  # `psql -f`): rpc/setting_get must answer without a PostgREST restart. The staged chain's own files are used, so
  # with -Red they are the base's (ee127cc: no NOTIFY -> the 404 stays). The revert first takes the function away;
  # if the revert itself does not make PostgREST drop it from its cache (PGRST202), the lab sends the reload, so the
# start state is the live one: a running PostgREST that has never seen setting_get.
  Write-Host '[5n] slot 400 applied to a running PostgREST: rpc/setting_get answers without a restart (NOTIFY pgrst)'
  $rpc = { (Dk run --rm --label $label --network $net --entrypoint node $viewerTag -e "fetch('http://openbrain-rest/rest/v1/rpc/setting_get',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_owner:'g2-probe',p_key:'refinery.dormancy_days'})}).then(async r=>{const j=await r.json().catch(()=>({}));console.log('rpc',r.status,j&&j.code?j.code:'')}).catch(e=>console.log('rpc ERR',e.message))") -replace '[^0-9A-Za-z ]', '' }
  $waitRpc = { param($want) $last = ''; for ($i = 0; $i -lt 15; $i++) { $last = & $rpc; if ($last -match "rpc $want") { break }; Start-Sleep -Seconds 1 }; $last }
  $g2 = @("before: $(& $rpc)")
  $null = Dk cp (Join-Path $chainDir 'revert-settings.sql') "${db}:/tmp/g2-revert.sql"
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/g2-revert.sql
  # PGRST202 = PostgREST's own cache no longer lists the function; a plain 404 with 42883 is the DATABASE refusing a
  # function the cache still lists (no reload happened) - only the first is the live start state
  $afterRevert = & $waitRpc '404 PGRST202'
  $revertReloads = $afterRevert -match 'rpc 404 PGRST202'
  $g2 += "revert (exit $($script:rc)): $afterRevert (the revert's own reload: $revertReloads)"
  if (-not $revertReloads) {
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "NOTIFY pgrst, 'reload schema'"
    $g2 += "lab NOTIFY: $(& $waitRpc '404 PGRST202')"
  }
  $null = Dk cp (Join-Path $chainDir 'init-settings.sql') "${db}:/tmp/g2-init.sql"
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/g2-init.sql
  $initExit = $script:rc
  $afterInit = & $waitRpc 200
  $g2 += "init (exit $initExit), PostgREST NOT restarted: $afterInit"
  Save 'postgrest-reload.log' ($g2 -join "`n")
  foreach ($l in $g2) { Write-Host "    $l" }
  if ($Red) { Check ($initExit -eq 0 -and $afterInit -match 'rpc 404 PGRST202') "RED: without the NOTIFY the running PostgREST still answers 404 after slot 400 is applied ($afterInit)" }
  else {
    Check ($revertReloads) "[5n] the revert makes the running PostgREST drop rpc/setting_get at once ($afterRevert)"
    Check ($initExit -eq 0 -and $afterInit -match 'rpc 200') "[5n] init-settings.sql makes the running PostgREST serve rpc/setting_get at once, no restart ($afterInit)"
  }

  # rw-idea-privacy [5p] (renumbered from [5j] at the integration with rw-settings-store, whose cases are [5j]-[5n]): slot 380 moves the pre-370 idea thoughts out of the shared corpus, and (round 2, tester F1) withholds
  # the wiki pages that show their text. Phases of src/ideas/idea_privacy_integration_test.ts around psql runs:
  #   plant (thoughts + wiki rows + their vault files); RED before 380 (= the base b43ecb5); RED with round 1's 380
  #   (-PrivacyPrevSha: round 2's misses the round-3 shapes) and its revert; init twice; the viewer's REAL reconcile repair with
  #   the files still in the vault (the guard must hold); the deploy step (the withheld pages' files moved out); the
  #   checks; files back, revert twice; byte-identity; two MUTANTS (no thought archive step / no wiki archive step) must
  #   refuse and change nothing; init again + files out (the sweep then runs on that state).
  if (-not $Red -and -not $SettingsOnly) {
    Write-Host '[5p] slot 380: the idea thoughts leave the shared corpus and the wiki stops showing them (plant, RED x2, init x2, reconcile, deploy step, revert x2, mutants, init)'
    $phase = {
      param($ph, $logName)
      $o = Lab-Docker 600 @('run', '--rm', '--label', $label, '--network', $net, '-e', "PRIVACY_PHASE=$ph", '-v', "${vault}:/vault",
        '-e', 'PRIVACY_VAULT=/vault', '-e', "PRIVACY_VIEWER=http://${P}-viewer:8080", '-e', 'OPEN_BRAIN_URL=http://openbrain-rest',
        '-e', "DOCS_TEST_BASE=http://$P-wb:8000", '-e', "DOCS_TEST_KEY=$key",
        '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
        $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', '--allow-write', 'src/ideas/idea_privacy_integration_test.ts')
      $clean = ($o -replace '\x1b\[[0-9;]*m', '')
      $script:lastPhaseText = $clean
      Save $logName ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||^privacy |error:|AssertionError|Values are not equal' }) -join "`n")
      foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^privacy ' }) { Write-Host "    $l" }
      return ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
    }
    $script:p380 = @{}
    $psqlFile = {
      param($path, $tag)
      $null = Dk cp $path "${db}:/tmp/p380.sql"
      $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/p380.sql
      $rc = $script:rc
      $msg = (($o -split "`n") | Where-Object { $_ -match 'NOTICE|ERROR' } | ForEach-Object { $_ -replace '^.*?(NOTICE|ERROR):\s*', '$1 ' }) -join ' | '
      $script:p380[$tag] = "exit ${rc}: $msg"
      Write-Host "    [$tag] exit ${rc}: $msg"
      return $rc
    }
    # the deploy step, as the operator runs it on live: every withheld page's vault file out of the vault (and back)
    $withheldDir = "$vault-withheld"
    $script:made.dirs += $withheldDir
    $filesOut = {
      $slugs = @((Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT slug FROM public.idea_wiki_archive ORDER BY slug") -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      $n = 0
      foreach ($sl in $slugs) {
        $from = Join-Path $vault "$sl.md"
        if (Test-Path -LiteralPath $from) {
          $to = Join-Path $withheldDir "$sl.md"
          New-Item -ItemType Directory -Force (Split-Path -Parent $to) | Out-Null
          Move-Item -LiteralPath $from -Destination $to -Force; $n++
        }
      }
      Write-Host "    [deploy step] $n vault file(s) of $($slugs.Count) withheld page(s) moved out of the vault"
      return $n
    }
    $filesBack = {
      $n = 0
      if (Test-Path $withheldDir) {
        foreach ($f in @(Get-ChildItem -Recurse -File $withheldDir)) {
          $to = Join-Path $vault ($f.FullName.Substring($withheldDir.Length).TrimStart([char[]]@([char]92, [char]47)))
          New-Item -ItemType Directory -Force (Split-Path -Parent $to) | Out-Null
          Move-Item -LiteralPath $f.FullName -Destination $to -Force; $n++
        }
      }
      Write-Host "    [revert step] $n vault file(s) moved back"
      return $n
    }
    $init = Join-Path $dockerDir 'init-idea-privacy.sql'
    $revert = Join-Path $dockerDir 'revert-idea-privacy.sql'
    $s = & $phase 'plant' 'privacy-plant.log'
    Check ($s.Success -and $s.Groups[1].Value -eq 'ok' -and [int]$s.Groups[2].Value -eq 1) "[5p] planted user A's ideas in every pre-370 shape, and the wiki pages and vault files that show them ($($s.Value))"
    $s = & $phase 'migrated' 'privacy-red-before-380.log'
    Check ($s.Success -and $s.Groups[1].Value -eq 'FAILED' -and [int]$s.Groups[2].Value -eq 0) "[5p] RED: before slot 380 runs (= the base) every privacy check fails ($($s.Value))"
    # RED for round 3: the PREVIOUS round's slot 380 (-PrivacyPrevSha, round 2) misses the shapes the tester listed: the
    # round-3 test fails, while the archive and the owner's-revisions tests pass. Then its revert brings the planted state back.
    $pvi = Join-Path $env:TEMP "$P-380-prev-init.sql"; $pvr = Join-Path $env:TEMP "$P-380-prev-revert.sql"
    $script:made.dirs += @($pvi, $pvr)
    [System.IO.File]::WriteAllText($pvi, ((& git -C $ob1 show "${PrivacyPrevSha}:docker/init-idea-privacy.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
    [System.IO.File]::WriteAllText($pvr, ((& git -C $ob1 show "${PrivacyPrevSha}:docker/revert-idea-privacy.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
    $pvRc = & $psqlFile $pvi "previous round init ($PrivacyPrevSha)"
    $s = & $phase 'migrated' 'privacy-red-prev-380.log'
    $redPv = [string]$script:lastPhaseText
    Check ($pvRc -eq 0 -and $s.Success -and $s.Groups[1].Value -eq 'FAILED' -and $redPv -match '\[migrated\] round 4: [^\n]*\.\.\. FAILED' -and $redPv -match 'a general page was withheld: ' -and $redPv -match '\[migrated\] the archive holds exactly[^\n]*\.\.\. ok' -and $redPv -match '\[migrated\] A still reads every revision[^\n]*\.\.\. ok') "[5p] RED: the previous round's 380 ($PrivacyPrevSha) withholds a general page that only shares 8+ words with an idea (the operator's round-4 bar) - the round-4 test fails on exactly that, the archive and revisions pass ($($s.Value))"
    $pvRevRc = & $psqlFile $pvr "previous round revert ($PrivacyPrevSha)"
    Check ($pvRevRc -eq 0) "[5p] the previous round's revert brings the planted state back"
    $rcs = @((& $psqlFile $init 'init'), (& $psqlFile $init 'init again'))
    Check (@($rcs | Where-Object { $_ -ne 0 }).Count -eq 0 -and $script:p380['init'] -match 'NOTICE idea privacy: \d+ idea thought' -and $script:p380['init'] -match 'NOTICE idea privacy: \d+ wiki page' -and $script:p380['init again'] -match 'nothing to move' -and $script:p380['init again'] -match 'nothing to withhold') '[5p] init-idea-privacy.sql moves the idea thoughts and withholds the wiki pages; a second run has nothing to do'
    # the viewer's own reconcile repair (the code that writes a missing row back from its vault file), files still present
    $rec = Dk exec "$P-viewer" node /viewer/lib/shared/reconcile-wiki-pages.mjs --repair --vault /wiki
    Save 'privacy-reconcile-repair.log' ((($rec -split "`n") | Select-Object -Last 30) -join "`n")
    Write-Host "    [reconcile --repair, files present] exit $($script:rc)"
    $moved = & $filesOut
    $s = & $phase 'migrated' 'privacy-migrated.log'
    Check ($moved -ge 2 -and $s.Success -and $s.Groups[1].Value -eq 'ok' -and [int]$s.Groups[2].Value -eq 5 -and [int]$s.Groups[3].Value -eq 0) "[5p] after 380 (+ the reconcile repair, + the deploy step): no shared search or page surface shows idea text, the archives are exactly the rows removed, the guard holds, A reads every revision ($($s.Value))"
    $null = & $filesBack
    $rcs = @((& $psqlFile $revert 'revert'), (& $psqlFile $revert 'revert again'))
    Check (@($rcs | Where-Object { $_ -ne 0 }).Count -eq 0 -and $script:p380['revert'] -match 'thought\(s\) restored' -and $script:p380['revert'] -match 'wiki page\(s\) restored' -and $script:p380['revert again'] -match 'nothing to restore' -and $script:p380['revert again'] -match 'no page to restore') '[5p] revert-idea-privacy.sql restores the thoughts and the pages, and a second run has nothing to restore'
    $s = & $phase 'reverted' 'privacy-reverted.log'
    Check ($s.Success -and $s.Groups[1].Value -eq 'ok' -and [int]$s.Groups[2].Value -eq 1) "[5p] after the revert every thought, link, edge, queue row, revision and wiki page is byte-identical ($($s.Value))"
    # the mutants: the same file without one of its archive steps must refuse - it would delete what it did not archive
    $src = Get-Content -Raw $init
    foreach ($m in @(@('archive-step', 'a thought'), @('wiki-archive-step', 'a wiki page'))) {
      $mutant = Join-Path $env:TEMP "$P-380-mutant-$($m[0]).sql"
      $cut = [regex]::Replace($src, "(?s)-- \[$($m[0])\].*?-- \[/$($m[0])\]", '-- (mutant: no archive step)')
      [System.IO.File]::WriteAllText($mutant, $cut, (New-Object System.Text.UTF8Encoding $false))
      $script:made.dirs += $mutant
      $mrc = & $psqlFile $mutant "mutant without the $($m[0])"
      Check ($cut -ne $src -and $mrc -ne 0 -and $script:p380["mutant without the $($m[0])"] -match 'refused, nothing changed') "[5p] a 380 that deletes $($m[1]) it did not first archive FAILS (refused, nothing changed)"
      $s = & $phase 'reverted' "privacy-after-mutant-$($m[0]).log"
      Check ($s.Success -and $s.Groups[1].Value -eq 'ok') "[5p] the refused mutant ($($m[0])) changed nothing ($($s.Value))"
    }
    $finalRc = & $psqlFile $init 'init (the state the sweep runs on)'
    $null = & $filesOut
    Check ($finalRc -eq 0) '[5p] init-idea-privacy.sql again + the deploy step (the sweep runs on the migrated database)'
    # round 4 (review R1): the REAL wiki writer meets the guard. The probe (wiki-withheld-probe.mjs) writes a page that
    # links an idea (the guard withholds it) and a clean page into the lab vault through PostgREST, as a compile does, then a reconcile
    # check and the lab viewer's /__health drift. RED with the base's recipes/_shared ($PrivacyR1BaseSha): the guarded
    # page's FILE is written with no row (reconcile drift, the viewer's drift up). GREEN with this tree's: no file, the
    # clean page lands, exit 0, no drift.
    $ideaLink = ((Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT 'content/thought/' || (v->'thoughts'->>0) FROM public.lab_idea_privacy_plant WHERE k = 'plant'") | Out-String).Trim()
    $oldShared = Join-Path $env:TEMP "$P-shared-$PrivacyR1BaseSha"
    New-Item -ItemType Directory -Force $oldShared | Out-Null
    $script:made.dirs += $oldShared
    $tarS = Join-Path $env:TEMP "$P-shared.tar"
    & git -C $ob1 archive --format=tar -o $tarS $PrivacyR1BaseSha recipes/_shared
    & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $tarS -C $oldShared
    Remove-Item -Force $tarS
    $probe = @{}
    $viewerMissing = @{}
    foreach ($run in @(@('red', (Join-Path $oldShared 'recipes\_shared')), @('green', (Join-Path $ob1 'recipes\_shared')))) {
      $o = Lab-Docker 300 @('run', '--rm', '--label', $label, '--network', $net, '-v', "$($run[1]):/shared:ro", '-v', "${vault}:/vault", '-v', "${ct}:/ct:ro",
        '-e', 'SHARED=/shared', '-e', 'WIKI_GIT_DIR=/vault', '-e', 'OPEN_BRAIN_URL=http://openbrain-rest', '-e', "PROBE_VIEWER=http://${P}-viewer:8080",
        '-e', "PROBE_TAG=$($run[0])", '-e', "IDEA_LINK=$ideaLink", '--entrypoint', 'node', $viewerTag, '/ct/wiki-withheld-probe.mjs')
      $line = (($o -split "`n") | Where-Object { $_ -match '^PROBE ' } | Select-Object -Last 1)
      $probe[$run[0]] = if ($line) { $line.Substring(6) | ConvertFrom-Json } else { $null }
      Save "privacy-r1-probe-$($run[0]).log" ((($o -split "`n") | Where-Object { $_ -match '^PROBE |\[wiki-pages\]|\[reconcile\]' }) -join "`n")
      Write-Host "    [R1 probe $($run[0])] $line"
      # the viewer's OWN reconcile (its code, its vault mount), as its health check runs it: is the guarded page drift?
      $vr = Dk exec "$P-viewer" node /viewer/lib/shared/reconcile-wiki-pages.mjs --json --vault /wiki
      $vj = $null; try { $vj = (($vr -split "`n") | Where-Object { $_ -match '^\{' } | Select-Object -Last 1) | ConvertFrom-Json } catch { }
      $viewerMissing[$run[0]] = if ($vj) { @($vj.missing) -contains "content/topic/r1-guarded-$($run[0])" } else { $null }
      Write-Host "    [R1 viewer reconcile $($run[0])] the guarded page is drift (missing): $($viewerMissing[$run[0]])"
      # the red run leaves its guarded file and the clean page: removed, so the green run measures from the same state
      foreach ($sl in @("content/topic/r1-guarded-$($run[0])", "content/topic/r1-clean-$($run[0])")) {
        $f = Join-Path $vault "$sl.md"; if (Test-Path -LiteralPath $f) { Remove-Item -Force -LiteralPath $f }
        $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "DELETE FROM public.wiki_pages WHERE slug = '$sl'"
      }
    }
    $r = $probe['red']; $g = $probe['green']
    Check ($r -and $r.guardedFile -and -not $r.guardedRow -and $r.reconcileMissingGuarded -and $viewerMissing['red'] -eq $true) "[5p] R1 RED: the base's writer ($PrivacyR1BaseSha) writes the guarded page's file with no row - drift in its own reconcile and in the viewer's (the viewer's /__health: $(if ($r) { "$($r.healthAfter.status), drift $($r.healthAfter.drift)" }))"
    Check ($g -and $g.exitCode -eq 0 -and -not $g.guardedFile -and -not $g.guardedRow -and $g.cleanFile -and $g.cleanRow -and $g.unsynced -eq 0 -and -not $g.reconcileMissingGuarded -and $viewerMissing['green'] -eq $false) "[5p] R1 GREEN: no file for the withheld page, the clean page lands, the run ends 0 with nothing unsynced, and it is drift in neither reconcile (the lab viewer's /__health is $(if ($g) { "$($g.healthAfter.status) from the lab's other planted rows, drift $($g.healthBefore.drift) -> $($g.healthAfter.drift)" }))"
    $null = Dk exec $db psql -U postgres -d openbrain -X -q -c 'DROP TABLE IF EXISTS public.lab_idea_privacy_plant'
    Save 'privacy-psql.log' (($script:p380.GetEnumerator() | Sort-Object Name | ForEach-Object { "[$($_.Name)] $($_.Value)" }) -join "`n")
  }


  # rw-report-isolation round 2 (tester F2): a moved report's wiki copies. Slot 390 over a planted idea-job report filed the
  # way the base filed it (a shared research_synthesis source, its leaf page and an entity page citing it, BOTH with vault
  # files). RED: round 1's 390 (-ReportRoundOneSha) deletes the leaf row but the viewer's REAL reconcile repair writes it
  # back from the file and B's page search finds it. GREEN: this 390 withholds the leaf and the citing page and its guard
  # keeps the reconcile repair (files still present) from writing either back; a clean page goes in; the revert brings
  # them back; init again withholds them.
  if (-not $Red -and -not $SettingsOnly) {
    Write-Host '[5q] slot 390 and the wiki: plant, RED with round 1, init, the viewer''s reconcile repair with the files present, search as B, revert, init'
    $wk = -join ((97..122) | Get-Random -Count 10 | ForEach-Object { [char]$_ })
    $mark = "wikireportsecret$wk"
    function Q1([string]$q) { $r = Dk exec $db psql -U postgres -d openbrain -X -tA -v ON_ERROR_STOP=1 -c $q; return (($r -replace "`r", '') -split "`n" | Where-Object { $_ -ne '' -and $_ -notmatch '^(INSERT|UPDATE|DELETE|DO)\b' }) -join "`n" }
    $idea = Q1 "SELECT public.idea_capture('wiki-owner-$wk', 'service:lab', 'wiki idea $wk', 'wiki idea statement $wk', NULL, NULL)::text"
    $job = Q1 "INSERT INTO public.research_jobs (status, origin, query) VALUES ('done', 'manual', 'wiki research $wk') RETURNING id::text"
    $null = Q1 "UPDATE public.idea_revisions SET research_job_id = '$job' WHERE idea_id = '$idea' AND revision = 1; UPDATE public.research_jobs SET refinery_id = NULL, inlet_ref = NULL WHERE id = '$job'"
    $src = Q1 "INSERT INTO public.sources (title, content, content_type, research_key) VALUES ('Report $mark', 'the report $mark body', 'research_synthesis', 'rk-wiki-$wk') RETURNING id::text"
    $null = Q1 "UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('persist', jsonb_build_object('synthesis_id', '$src'))) WHERE id = '$job'"
    $leaf = "content/source/$src"; $ent = "content/tool/wiki-tool-$wk"
    $files = @(@($leaf, "Report $mark", "the report $mark body"), @($ent, "Wiki Tool $wk", "the tool page cites [[$leaf|Report $mark]] and says $mark"))
    foreach ($f in $files) {
      $fp = Join-Path $vault ($f[0] + '.md'); New-Item -ItemType Directory -Force (Split-Path -Parent $fp) | Out-Null
      [System.IO.File]::WriteAllText($fp, "---`ntitle: $($f[1])`n---`n$($f[2])`n", (New-Object System.Text.UTF8Encoding $false))
    }
    Start-Sleep -Seconds 2
    $null = Q1 "INSERT INTO public.wiki_pages (slug, page_class, title, body, links) VALUES ('$leaf', 'source', 'Report $mark', 'the report $mark body', '[]'::jsonb), ('$ent', 'entity', 'Wiki Tool $wk', 'the tool page cites [[$leaf|Report $mark]] and says $mark', jsonb_build_array('$leaf'))"
    # round 3: the thread the base's curator minted from the report (named and described from it, decision 'new'), and an
    # existing thread whose description refreshThread rewrote from it (the report linked into it)
    $tNew = Q1 "INSERT INTO public.threads (name, description, status) VALUES ('Notebook $mark', '$mark - the report''s first paragraph', 'active') RETURNING id::text"
    $tOld = Q1 "INSERT INTO public.threads (name, description, status) VALUES ('Shared notebook $wk', 'refreshed from $mark', 'active') RETURNING id::text"
    $null = Q1 "SELECT public.link_source_to_thread('$tNew', '$src', 'automatic', NULL, 'confirmed'); SELECT public.link_source_to_thread('$tOld', '$src', 'automatic', NULL, 'confirmed'); SELECT public.link_source_to_thread('$tOld', '11111111-1111-4111-8111-111111111111', 'automatic', NULL, 'confirmed')"
    # round 4 (tester attempt 3): the stored answers of a job whose FIRST attempt minted the thread - a resend that reused
    # it ('explicit') here, and on a second idea job the filed-event recovery (no thread_decision)
    $null = Q1 "UPDATE public.research_jobs SET result = result || jsonb_build_object('curator', (result -> 'curator') || jsonb_build_object('thread_id', '$tNew', 'thread_decision', 'explicit')) WHERE id = '$job'"
    $idea2 = Q1 "SELECT public.idea_capture('wiki-owner-$wk', 'service:lab', 'wiki idea two $wk', 'wiki idea two statement $wk', NULL, NULL)::text"
    $job2 = Q1 "INSERT INTO public.research_jobs (status, origin, query) VALUES ('done', 'manual', 'wiki research two $wk') RETURNING id::text"
    $null = Q1 "UPDATE public.idea_revisions SET research_job_id = '$job2' WHERE idea_id = '$idea2' AND revision = 1; UPDATE public.research_jobs SET refinery_id = NULL, inlet_ref = NULL WHERE id = '$job2'"
    $src2 = Q1 "INSERT INTO public.sources (title, content, content_type, research_key) VALUES ('Report two $mark', 'the second report $mark body', 'research_synthesis', 'rk-wiki2-$wk') RETURNING id::text"
    $tRec = Q1 "INSERT INTO public.threads (name, status) VALUES ('Recovered notebook $mark', 'active') RETURNING id::text"
    $null = Q1 "SELECT public.link_source_to_thread('$tRec', '$src2', 'automatic', NULL, 'confirmed')"
    $null = Q1 "UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('thread_id', '$tRec', 'persist', jsonb_build_object('synthesis_id', '$src2'), 'recovered', jsonb_build_object('via', 'filed_event', 'attempt', 2, 'why', 'timeout'))) WHERE id = '$job2'"
    # the times the move reads (round 5, the tester's tC): each job was created 3h ago, its FIRST run minted the thread 2h
    # ago, and a re-run (boot recovery / model-down requeue) reset started_at to 1h ago - its 'explicit' resend and the
    # recovered answer name the thread the first run minted; the existing thread (tE) is a day old and keeps its name
    # round 6 (tester attempt 5, tF): the job that minted the thread ERRORED after filing (only its filed event names the
    # thread); a later job of the same idea filed into it as 'existing'. And an old thread no moved job touches (tU).
    $idea3 = Q1 "SELECT public.idea_capture('wiki-owner-$wk', 'service:lab', 'wiki idea three $wk', 'wiki idea three statement $wk', NULL, NULL)::text"
    $job3 = Q1 "INSERT INTO public.research_jobs (status, origin, query, refinery_id, error) VALUES ('error', 'manual', 'wiki research three $wk', '$idea3', 'failed after filing') RETURNING id::text"
    $job4 = Q1 "INSERT INTO public.research_jobs (status, origin, query, refinery_id) VALUES ('done', 'manual', 'wiki research four $wk', '$idea3') RETURNING id::text"
    $src3 = Q1 "INSERT INTO public.sources (title, content, content_type, research_key) VALUES ('Report three $mark', 'the third report $mark body', 'research_synthesis', 'rk-wiki3-$wk') RETURNING id::text"
    $src4 = Q1 "INSERT INTO public.sources (title, content, content_type, research_key) VALUES ('Report four $mark', 'the fourth report $mark body', 'research_synthesis', 'rk-wiki4-$wk') RETURNING id::text"
    $tErr = Q1 "INSERT INTO public.threads (name, status, created_at) VALUES ('Errored notebook $mark', 'active', now() - interval '2 hours') RETURNING id::text"
    $null = Q1 "INSERT INTO public.research_job_events (job_id, root_job_id, type, kind, payload) VALUES ('$job3', '$job3', 'filed', 'due_process', jsonb_build_object('synthesis_id', '$src3', 'research_key', 'rk-wiki3-$wk', 'thread_id', '$tErr'))"
    $null = Q1 "UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('thread_id', '$tErr', 'thread_decision', 'existing', 'persist', jsonb_build_object('synthesis_id', '$src4'))) WHERE id = '$job4'"
    $null = Q1 "UPDATE public.research_jobs SET created_at = now() - interval '3 hours' WHERE id = '$job3'"
    # round 7 (tester attempt 6, tR): the curator minted a thread (its answer records the name), its web source was labelled
    # with that name, then the USER renamed the notebook - the label is no longer the thread's name
    $idea5 = Q1 "SELECT public.idea_capture('wiki-owner-$wk', 'service:lab', 'wiki idea five $wk', 'wiki idea five statement $wk', NULL, NULL)::text"
    $job5 = Q1 "INSERT INTO public.research_jobs (status, origin, query, refinery_id) VALUES ('done', 'manual', 'wiki research five $wk', '$idea5') RETURNING id::text"
    $src5 = Q1 "INSERT INTO public.sources (title, content, content_type, research_key) VALUES ('Report five $wk', 'the fifth report body $wk', 'research_synthesis', 'rk-wiki5-$wk') RETURNING id::text"
    $web5 = Q1 "INSERT INTO public.sources (url, title, content, notebook) VALUES ('https://example.org/web5-$wk', 'web five $wk', 'web five text', 'Filed name $mark') RETURNING id::text"
    $tRen = Q1 "INSERT INTO public.threads (name, status) VALUES ('User renamed $wk', 'active') RETURNING id::text"
    $null = Q1 "SELECT public.link_source_to_thread('$tRen', '$src5', 'automatic', NULL, 'confirmed'); SELECT public.link_source_to_thread('$tRen', '$web5', 'automatic', NULL, 'confirmed')"
    $null = Q1 "UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('thread_id', '$tRen', 'thread_decision', 'new', 'thread_name', 'Filed name $mark', 'persist', jsonb_build_object('synthesis_id', '$src5'))) WHERE id = '$job5'"
    $labels = { Q1 "SELECT count(*) FROM public.sources WHERE notebook LIKE '%$mark%'" }
    $tUntied = Q1 "INSERT INTO public.threads (name, status, created_at) VALUES ('Untied notebook $wk', 'active', now() - interval '1 day') RETURNING id::text"
    $null = Q1 "SELECT public.link_source_to_thread('$tUntied', '11111111-1111-4111-8111-111111111111', 'automatic', NULL, 'confirmed')"
    $null = Q1 "UPDATE public.research_jobs SET created_at = now() - interval '3 hours', started_at = now() - interval '1 hour' WHERE id IN ('$job', '$job2'); UPDATE public.threads SET created_at = now() - interval '2 hours' WHERE id IN ('$tNew', '$tRec'); UPDATE public.threads SET created_at = now() - interval '1 day' WHERE id = '$tOld'"
    $notebooks = {
      $r = Dk run --rm --label $label --network $net --entrypoint node $viewerTag --input-type=module -e "
        const n = async (h) => { const r = await fetch('http://$P-wb:8000/workbench/notebooks', { headers: { 'x-brain-key': '$key', ...h } }); const t = await r.text(); return r.status + ':' + (t.split('$mark').length - 1); };
        console.log('B', await n({ 'X-Test-Sub': 'wiki-b-$wk' }), 'lane', await n({}));"
      return ($r -replace "`r", '').Trim()
    }
    $rows = { Q1 "SELECT count(*) FROM public.wiki_pages WHERE slug IN ('$leaf', '$ent')" }
    $reconcile = { $r = Dk exec "$P-viewer" node /viewer/lib/shared/reconcile-wiki-pages.mjs --repair --vault /wiki; return "exit $($script:rc): $((($r -split "`n") | Select-Object -Last 6) -join ' | ')" }
    $searchB = {
      $r = Dk run --rm --label $label --network $net --entrypoint node $viewerTag -e "fetch('http://$P-wb:8000/workbench/contract/search?q=$mark&kinds=page,claim,source', { headers: { 'x-brain-key': '$key', 'X-Test-Sub': 'wiki-b-$wk' } }).then(async (r) => { const j = await r.json(); console.log('status', r.status, 'hits', JSON.stringify(j.results ?? []).split('$mark').length - 1); }).catch((e) => console.log('error', String(e)))"
      return ($r -replace "`r", '').Trim()
    }
    $wlog = @("planted: idea, job, source, 2 wiki rows + 2 vault files, 2 threads; rows=$(& $rows); search as B: $(& $searchB); notebooks: $(& $notebooks)")
    # RED: round 1's 390 (the current rule and guard off first: the chain ran this tree's 390)
    $r1i = Join-Path $env:TEMP "$P-r1-init-390.sql"; $r1r = Join-Path $env:TEMP "$P-r1-revert-390.sql"
    [System.IO.File]::WriteAllText($r1i, ((& git -C $ob1 show "${ReportRoundOneSha}:docker/init-report-isolation.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
    [System.IO.File]::WriteAllText($r1r, ((& git -C $ob1 show "${ReportRoundOneSha}:docker/revert-report-isolation.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
    $script:made.dirs += @($r1i, $r1r)
    $run = { param([string]$file, [string]$name) $null = Dk cp $file "${db}:/tmp/$name"; $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f "/tmp/$name"; return "exit $($script:rc) :: $((($o -split "`n") | Where-Object { $_ -match 'rw-report-isolation|ERROR' } | ForEach-Object { ($_ -replace '^.*(NOTICE|ERROR):\s+', '').Trim() }) -join ' ; ')" }
    $wlog += "[current revert, so round 1 runs alone] $(& $run (Join-Path $dockerDir 'revert-report-isolation.sql') 'ri-rv.sql')"
    $wlog += "[round 1 init] $(& $run $r1i 'ri-r1-init.sql')"
    $afterR1 = & $rows
    $wlog += "[reconcile --repair, files present] $(& $reconcile)"
    $afterR1Rec = & $rows; $searchR1 = & $searchB
    $wlog += "round 1: rows after init $afterR1, after the reconcile $afterR1Rec; search as B: $searchR1"
    Check ($afterR1Rec -ne '0' -and $searchR1 -match 'hits [1-9]') "[5q] RED: round 1's 390 - the viewer's reconcile writes the moved report's page back from its vault file and B's search finds it (rows $afterR1 -> $afterR1Rec; $searchR1)"
    $wlog += "[round 1 revert] $(& $run $r1r 'ri-r1-revert.sql')"
    # round 3 RED: round 2's 390 - the wiki is withheld, but the threads keep the report's name and description
    $r2i = Join-Path $env:TEMP "$P-r2-init-390.sql"; $r2r = Join-Path $env:TEMP "$P-r2-revert-390.sql"
    [System.IO.File]::WriteAllText($r2i, ((& git -C $ob1 show "${ReportRoundTwoSha}:docker/init-report-isolation.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
    [System.IO.File]::WriteAllText($r2r, ((& git -C $ob1 show "${ReportRoundTwoSha}:docker/revert-report-isolation.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
    $script:made.dirs += @($r2i, $r2r)
    $wlog += "[round 2 init] $(& $run $r2i 'ri-r2-init.sql')"
    $nbR2 = & $notebooks
    $wlog += "round 2: notebooks $nbR2"
    Check ($nbR2 -match 'B 200:[1-9]' -and $nbR2 -match 'lane 200:[1-9]') "[5q] RED: round 2's 390 - GET /workbench/notebooks still gives B and the lane the threads the report named and described ($nbR2)"
    $wlog += "[round 2 revert] $(& $run $r2r 'ri-r2-revert.sql')"
    # round 4 RED: round 3's 390 - it re-describes, but a thread minted by an 'explicit' resend or a recovered answer
    # keeps its report-derived NAME
    $r3i = Join-Path $env:TEMP "$P-r3-init-390.sql"; $r3r = Join-Path $env:TEMP "$P-r3-revert-390.sql"
    [System.IO.File]::WriteAllText($r3i, ((& git -C $ob1 show "${ReportRoundThreeSha}:docker/init-report-isolation.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
    [System.IO.File]::WriteAllText($r3r, ((& git -C $ob1 show "${ReportRoundThreeSha}:docker/revert-report-isolation.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
    $script:made.dirs += @($r3i, $r3r)
    $wlog += "[round 3 init] $(& $run $r3i 'ri-r3-init.sql')"
    $nbR3 = & $notebooks
    $wlog += "round 3: notebooks $nbR3"
    Check ($nbR3 -match 'B 200:[1-9]' -and $nbR3 -match 'lane 200:[1-9]') "[5q] RED: round 3's 390 - the threads minted by an 'explicit' resend and a recovered answer keep their report-derived names for B and the lane ($nbR3)"
    $wlog += "[round 3 revert] $(& $run $r3r 'ri-r3-revert.sql')"
    # round 5 RED: round 4's 390 - "existing" read from started_at: the re-run job's threads (minted 2h ago, the re-run
    # started 1h ago) are classed existing and keep their report-derived names
    $r4i = Join-Path $env:TEMP "$P-r4-init-390.sql"; $r4r = Join-Path $env:TEMP "$P-r4-revert-390.sql"
    [System.IO.File]::WriteAllText($r4i, ((& git -C $ob1 show "${ReportRoundFourSha}:docker/init-report-isolation.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
    [System.IO.File]::WriteAllText($r4r, ((& git -C $ob1 show "${ReportRoundFourSha}:docker/revert-report-isolation.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
    $script:made.dirs += @($r4i, $r4r)
    $wlog += "[round 4 init] $(& $run $r4i 'ri-r4-init.sql')"
    $nbR4 = & $notebooks
    $wlog += "round 4: notebooks $nbR4"
    Check ($nbR4 -match 'B 200:[1-9]' -and $nbR4 -match 'lane 200:[1-9]') "[5q] RED: round 4's 390 - a re-run job's threads (created before the re-run's start) keep their report-derived names for B and the lane ($nbR4)"
    $wlog += "[round 4 revert] $(& $run $r4r 'ri-r4-revert.sql')"
    # round 6 RED: round 5's 390 - the thread an errored job minted (named only by its filed event) and a later job filed
    # into as 'existing' is classed existing by time and keeps its report-derived name
    $r5i = Join-Path $env:TEMP "$P-r5-init-390.sql"; $r5r = Join-Path $env:TEMP "$P-r5-revert-390.sql"
    [System.IO.File]::WriteAllText($r5i, ((& git -C $ob1 show "${ReportRoundFiveSha}:docker/init-report-isolation.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
    [System.IO.File]::WriteAllText($r5r, ((& git -C $ob1 show "${ReportRoundFiveSha}:docker/revert-report-isolation.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
    $script:made.dirs += @($r5i, $r5r)
    $wlog += "[round 5 init] $(& $run $r5i 'ri-r5-init.sql')"
    $nbR5 = & $notebooks
    $wlog += "round 5: notebooks $nbR5"
    Check ($nbR5 -match 'B 200:[1-9]' -and $nbR5 -match 'lane 200:[1-9]') "[5q] RED: round 5's 390 - the thread an errored job minted keeps its report-derived name for B and the lane ($nbR5)"
    $wlog += "[round 5 revert] $(& $run $r5r 'ri-r5-revert.sql')"
    # round 7 RED: round 6's 390 - it relabels by the thread's current name, so the renamed notebook's source keeps the
    # filing-time (report-derived) label
    $r6i = Join-Path $env:TEMP "$P-r6-init-390.sql"; $r6r = Join-Path $env:TEMP "$P-r6-revert-390.sql"
    [System.IO.File]::WriteAllText($r6i, ((& git -C $ob1 show "${ReportRoundSixSha}:docker/init-report-isolation.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
    [System.IO.File]::WriteAllText($r6r, ((& git -C $ob1 show "${ReportRoundSixSha}:docker/revert-report-isolation.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
    $script:made.dirs += @($r6i, $r6r)
    $wlog += "[round 6 init] $(& $run $r6i 'ri-r6-init.sql')"
    $lbR6 = & $labels
    $wlog += "round 6: sources still labelled with the report-derived name: $lbR6"
    Check ($lbR6 -ne '0') "[5q] RED: round 6's 390 - the renamed notebook's source keeps its report-derived label ($lbR6)"
    $wlog += "[round 6 revert] $(& $run $r6r 'ri-r6-revert.sql')"
    # GREEN: this 390
    $wlog += "[init] $(& $run (Join-Path $dockerDir 'init-report-isolation.sql') 'ri-init.sql')"
    $afterInit = & $rows
    $wlog += "[reconcile --repair, files present] $(& $reconcile)"
    $afterRec = & $rows; $searchG = & $searchB
    $null = Q1 "INSERT INTO public.wiki_pages (slug, page_class, title, body) VALUES ('content/tool/wiki-clean-$wk', 'entity', 'Wiki Tool $wk', 'a clean regenerated page')"
    $clean = Q1 "SELECT count(*) FROM public.wiki_pages WHERE slug = 'content/tool/wiki-clean-$wk'"
    $null = Q1 "DELETE FROM public.wiki_pages WHERE slug = 'content/tool/wiki-clean-$wk'"
    $shared = Q1 "SELECT count(*) FROM public.sources WHERE id = '$src'"
    $nbG = & $notebooks
    $wlog += "this 390: rows after init $afterInit, after the reconcile $afterRec; source rows $shared; search as B: $searchG; clean page in: $clean; notebooks: $nbG"
    Check ($nbG -match 'B 200:0' -and $nbG -match 'lane 200:0') "[5q] this 390: GET /workbench/notebooks gives B and the lane no thread text of the report ($nbG)"
    # round 6: every thread tied to a moved idea job is renamed - the old tied thread (tE) included; an untied old one is not
    $teName = Q1 "SELECT name FROM public.threads WHERE id = '$tOld'"
    $tuName = Q1 "SELECT name FROM public.threads WHERE id = '$tUntied'"
    $lbG = & $labels
    Check ($lbG -eq '0') "[5q] this 390: no shared source keeps a report-derived notebook label - the renamed notebook's relabelled by linkage ($lbG)"
    Check ($teName -match '^Research thread ' -and $tuName -eq "Untied notebook $wk") "[5q] this 390: the old thread tied to a moved job (tE) is renamed ($teName); the untied old thread keeps its name ($tuName)"
    Check ($afterInit -eq '0' -and $afterRec -eq '0' -and $shared -eq '0' -and $searchG -match 'status 200 hits 0' -and $clean -eq '1') "[5q] this 390: the leaf and the citing page are withheld, the reconcile repair (files present) writes neither back, B's search finds nothing, a clean page goes in ($afterInit / $afterRec; $searchG)"
    $wlog += "[revert] $(& $run (Join-Path $dockerDir 'revert-report-isolation.sql') 'ri-rv2.sql')"
    $afterRv = & $rows; $nbRv = & $notebooks
    $wlog += "[init again] $(& $run (Join-Path $dockerDir 'init-report-isolation.sql') 'ri-init2.sql')"
    $afterAgain = & $rows; $nbAgain = & $notebooks
    $wlog += "rows after the revert $afterRv, after init again $afterAgain; notebooks after the revert $nbRv, after init again $nbAgain"
    Check ($nbRv -match 'B 200:[1-9]' -and $nbAgain -match 'B 200:0' -and $nbAgain -match 'lane 200:0') "[5q] the revert gives the threads back ($nbRv), init again re-describes them ($nbAgain)"
    Check ($afterRv -eq '2' -and $afterAgain -eq '0') "[5q] the revert brings both pages back ($afterRv), init again withholds them ($afterAgain)"
    foreach ($f in $files) { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $vault ($f[0] + '.md')) }
    Save 'report-isolation-wiki.log' (($wlog -join "`n") -replace [regex]::Escape($key), '<key>')
    foreach ($l in $wlog) { Write-Host "    $l" }
  }

  # rw-inlet-owner (plan 08 PD1, slot 410): every existing personal row becomes the owner's and private. A marker in every
  # personal field (inlet-owner-plant.sql) with vault files for the planted pages; src/inlet/inlet_owner_integration_test.ts
  # in phases around psql runs. -Red -IdeasOnly (the base's chain and images, -BaseSha): plant + the 'migrated' reads,
  # which must all FAIL (B reads the markers). GREEN: snapshot; RED before 410 runs; a run with no owner subject refused;
  # init x2; a run naming another owner refused; the viewer's reconcile repair with the files present; the deploy step
  # (files out); migrated; files back; revert x2; byte-identical; three mutants without an archive step refused, nothing
  # changed; init again; the late rows; the second run (exactly the new unowned rows). The sweep then runs on that state.
  if (-not $SettingsOnly -and (-not $Red -or $IdeasOnly)) {
    Write-Host '[5r] slot 440: personal data becomes its owner''s and private (plant, RED, refusals, init x2, reconcile, deploy step, revert x2, mutants, init, late rows, second run)'
    $ir = -join ((97..122) | Get-Random -Count 10 | ForEach-Object { [char]$_ })
    $inMark = "inletmark$ir"; $inA = "inlet-owner-$ir"; $inB = "inlet-second-$ir"
    $script:p410 = @{}
    $inPhase = {
      param($ph, $logName)
      $o = Lab-Docker 600 @('run', '--rm', '--label', $label, '--network', $net, '-e', "INLET_PHASE=$ph",
        '-e', "INLET_OWNER=$inA", '-e', "INLET_SECOND=$inB", '-e', "INLET_VIEWER=http://${P}-viewer:8080", '-e', 'OPEN_BRAIN_URL=http://openbrain-rest',
        '-e', "DOCS_TEST_BASE=http://$P-wb:8000", '-e', "DOCS_TEST_KEY=$key",
        '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
        $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', 'src/inlet/inlet_owner_integration_test.ts')
      $clean = ($o -replace '\x1b\[[0-9;]*m', '')
      $script:lastInlet = $clean
      Save $logName ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||^inlet privacy|error:|AssertionError|Values are not equal|\[Diff\]' } | Select-Object -First 200) -join "`n")
      foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^inlet privacy' }) { Write-Host "    $l" }
      return ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
    }
    $inPsql = {
      param($path, $tag, $vars)
      $null = Dk cp $path "${db}:/tmp/p410.sql"
      $a = @('exec', $db, 'psql', '-U', 'postgres', '-d', 'openbrain', '-X', '-q', '-v', 'ON_ERROR_STOP=1') + @($vars) + @('-f', '/tmp/p410.sql')
      $o = Lab-Docker 600 $a
      $rc = $script:rc
      $msg = (($o -split "`n") | Where-Object { $_ -match 'NOTICE|ERROR' } | ForEach-Object { $_ -replace '^.*?(NOTICE|ERROR):\s*', '$1 ' }) -join ' | '
      $script:p410[$tag] = "exit ${rc}: $msg"
      Write-Host "    [$tag] exit ${rc}: $msg"
      return $rc
    }
    $inWithheld = "$vault-inlet-withheld"; $script:made.dirs += $inWithheld
    $inOut = {
      $sl2 = @((Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT DISTINCT ref FROM public.inlet_owner_archive WHERE action = 'w' AND restored_at IS NULL ORDER BY 1") -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      $n = 0
      foreach ($x in $sl2) {
        $from = Join-Path $vault "$x.md"
        if (Test-Path -LiteralPath $from) {
          $to = Join-Path $inWithheld "$x.md"; New-Item -ItemType Directory -Force (Split-Path -Parent $to) | Out-Null
          Move-Item -LiteralPath $from -Destination $to -Force; $n++
        }
      }
      # the deploy step's viewer restart: its site index (/__nav, /static/graphIndex.json) is stale-while-revalidate and
      # would serve the withheld pages' titles and links from its cached copy until the next rebuild
      $null = Dk restart "$P-viewer"
      $null = Wait-Http "http://${P}-viewer:8080/workspace/" 90
      $null = Wait-Http "http://${P}-viewer:8080/__nav" 90
      Write-Host "    [deploy step] $n vault file(s) of $($sl2.Count) withheld page(s) moved out of the vault; the viewer restarted"; return $n
    }
    $inBack = {
      $n = 0
      if (Test-Path $inWithheld) {
        foreach ($f in @(Get-ChildItem -Recurse -File $inWithheld)) {
          $to = Join-Path $vault ($f.FullName.Substring($inWithheld.Length).TrimStart([char[]]@([char]92, [char]47)))
          New-Item -ItemType Directory -Force (Split-Path -Parent $to) | Out-Null
          Move-Item -LiteralPath $f.FullName -Destination $to -Force; $n++
        }
      }
      Write-Host "    [revert step] $n vault file(s) moved back"; return $n
    }
    $plantFile = Join-Path $ct 'inlet-owner-plant.sql'
    $inInit = Join-Path $dockerDir 'init-inlet-owner.sql'
    $inRevert = Join-Path $dockerDir 'revert-inlet-owner.sql'
    $prc = & $inPsql $plantFile 'plant' @('-v', "mark=$inMark", '-v', 'phase=plant')
    Check ($prc -eq 0) '[5r] planted a marker in every personal field (a thought of every inlet, an email body, a podcast transcript, chunks, claims, seeds, results, Gmail ids, the wiki pages)'
    # the planted pages' vault files (what a compile wrote; the viewer's reconcile repairs a missing row from them)
    $inPages = @((Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT p.value FROM public.lab_inlet_owner_plant l, jsonb_each_text(l.v -> 'pages') p WHERE l.k = 'plant'") -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    foreach ($sl in $inPages) {
      $body = (Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT body FROM public.wiki_pages WHERE slug = '$sl'")
      $fp = Join-Path $vault "$sl.md"
      New-Item -ItemType Directory -Force (Split-Path -Parent $fp) | Out-Null
      [System.IO.File]::WriteAllText($fp, "---`ntitle: planted`n---`n$body`n", (New-Object System.Text.UTF8Encoding $false))
    }
    if ($Red) {
      $s = & $inPhase 'migrated' 'inlet-red-base.log'
      Check ($s.Success -and $s.Groups[1].Value -eq 'FAILED' -and [int]$s.Groups[2].Value -eq 0 -and $script:lastInlet -match "B's reads with a personal marker: [1-9]") "[5r] RED on the base ($BaseSha): user B reads the planted markers, and every privacy check fails ($($s.Value))"
    } else {
      $s = & $inPhase 'snapshot' 'inlet-snapshot.log'
      Check ($s.Success -and $s.Groups[1].Value -eq 'ok') "[5r] the 14 touched tables hashed before the first run ($($s.Value))"
      $s = & $inPhase 'migrated' 'inlet-red-before-440.log'
      Check ($s.Success -and $s.Groups[1].Value -eq 'FAILED' -and [int]$s.Groups[2].Value -eq 0 -and $script:lastInlet -match "B's reads with a personal marker: [1-9]") "[5r] RED: before slot 440 runs, user B reads the markers and every privacy check fails ($($s.Value))"
      $nrc = & $inPsql $inInit 'init without an owner' @()
      $s = & $inPhase 'reverted' 'inlet-after-no-owner.log'
      Check ($nrc -ne 0 -and $script:p410['init without an owner'] -match 'no owner subject' -and $s.Success -and $s.Groups[1].Value -eq 'ok') "[5r] a run with personal data and no owner subject is refused, and changed nothing ($($s.Value))"
      # round 2: RED with round 1's migration ($InletPrevSha): the round-2 cases fail on it (the service-owned job's reads, the
      # functions PostgREST's anon role may call, the link and text variants, the manifest), then its revert brings the
      # planted state back byte-identical
      $pvI = Join-Path $env:TEMP "$P-440-prev-init.sql"; $pvR = Join-Path $env:TEMP "$P-440-prev-revert.sql"
      $script:made.dirs += @($pvI, $pvR)
      [System.IO.File]::WriteAllText($pvI, ((& git -C $ob1 show "${InletPrevSha}:docker/init-inlet-owner.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
      [System.IO.File]::WriteAllText($pvR, ((& git -C $ob1 show "${InletPrevSha}:docker/revert-inlet-owner.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
      $pvRc = & $inPsql $pvI "round 1 init ($InletPrevSha)" @('-v', "owner_sub=$inA")
      $null = & $inOut
      $s = & $inPhase 'migrated' 'inlet-red-round1.log'
      $redR1 = [string]$script:lastInlet
      # (the manifest case reads the query the new wiki-service issues, so it holds on round 1's data too: its RED is the
      # compile step's, below)
      # (since rw-boundary-core (slot 420) the workbench's session reads redact an unclassified / service-key job for a
      # non-owner, so on this integrated base B's WORKBENCH reads no longer show round 1's leftovers; the shared rows - what
      # the research service reads - still carry them: the round-3 case fails on them)
      $r1Fails = @('round 2 \(tester 2, 5\)', 'round 2 \(tester 4, 6\)', 'round 3 \(tester attempt 2, P1b\)') | Where-Object { $redR1 -match ($_ + '[^\n]*\.\.\. FAILED') }
      Check ($pvRc -eq 0 -and $s.Success -and $s.Groups[1].Value -eq 'FAILED' -and $r1Fails.Count -eq 3 -and $redR1 -match 'seeded-tree shared rows carrying the seed body.s text: [1-9]') "[5r] RED: round 1's migration ($InletPrevSha) - the functions answer PostgREST's anon role, the link and text variants pass, the seeded trees' shared rows keep the seed body's text ($($s.Value))"
      $null = & $inBack
      $pvRevRc = & $inPsql $pvR "round 1 revert ($InletPrevSha)" @()
      $s = & $inPhase 'reverted' 'inlet-after-round1-revert.log'
      Check ($pvRevRc -eq 0 -and $s.Success -and $s.Groups[1].Value -eq 'ok') "[5r] round 1's revert brings the planted state back byte-identical ($($s.Value))"
      # round 3: RED with round 2's migration ($InletPrev2Sha): the seed-body case fails on it (the derived text of a tree
      # seeded with an email body or a podcast transcript survives in the shared rows), the round-2 cases pass; its revert
      # brings the planted state back byte-identical
      $p2I = Join-Path $env:TEMP "$P-440-prev2-init.sql"; $p2R = Join-Path $env:TEMP "$P-440-prev2-revert.sql"
      $script:made.dirs += @($p2I, $p2R)
      [System.IO.File]::WriteAllText($p2I, ((& git -C $ob1 show "${InletPrev2Sha}:docker/init-inlet-owner.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
      [System.IO.File]::WriteAllText($p2R, ((& git -C $ob1 show "${InletPrev2Sha}:docker/revert-inlet-owner.sql") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
      $p2Rc = & $inPsql $p2I "round 2 init ($InletPrev2Sha)" @('-v', "owner_sub=$inA")
      $null = & $inOut
      $s = & $inPhase 'migrated' 'inlet-red-round2.log'
      $redR2 = [string]$script:lastInlet
      Check ($p2Rc -eq 0 -and $s.Success -and $s.Groups[1].Value -eq 'FAILED' -and $redR2 -match 'round 3 \(tester attempt 2, P1b\)[^\n]*\.\.\. FAILED' -and $redR2 -match 'round 2 \(tester 2, 5\)[^\n]*\.\.\. ok' -and $redR2 -match 'round 2 \(tester 4, 6\)[^\n]*\.\.\. ok' -and $redR2 -match 'seeded-tree shared rows carrying the seed body.s text: [1-9]') "[5r] RED: round 2's migration ($InletPrev2Sha) - the derived text of a tree seeded with an email body or a podcast transcript survives in the shared rows every reader reads (the seed-body case fails; the round-2 cases pass) ($($s.Value))"
      $null = & $inBack
      $p2RevRc = & $inPsql $p2R "round 2 revert ($InletPrev2Sha)" @()
      $s = & $inPhase 'reverted' 'inlet-after-round2-revert.log'
      Check ($p2RevRc -eq 0 -and $s.Success -and $s.Groups[1].Value -eq 'ok') "[5r] round 2's revert brings the planted state back byte-identical ($($s.Value))"
      $rcs = @((& $inPsql $inInit 'init' @('-v', "owner_sub=$inA")), (& $inPsql $inInit 'init again' @()))
      Check (@($rcs | Where-Object { $_ -ne 0 }).Count -eq 0 -and $script:p410['init'] -match 'thought\(s\) now the owner' -and $script:p410['init again'] -match 'nothing to do') '[5r] init-inlet-owner.sql makes the personal data private; a second run (the recorded owner) has nothing to do'
      $orc = & $inPsql $inInit 'init naming another owner' @('-v', "owner_sub=$inB")
      Check ($orc -ne 0 -and $script:p410['init naming another owner'] -match 'another subject') '[5r] a run naming a different owner subject is refused'
      $rec = Dk exec "$P-viewer" node /viewer/lib/shared/reconcile-wiki-pages.mjs --repair --vault /wiki
      Save 'inlet-reconcile-repair.log' ((($rec -split "`n") | Select-Object -Last 30) -join "`n")
      Write-Host "    [reconcile --repair, files present] exit $($script:rc)"
      $moved = & $inOut
      $s = & $inPhase 'migrated' 'inlet-migrated.log'
      Check ($moved -ge 4 -and $s.Success -and $s.Groups[1].Value -eq 'ok' -and [int]$s.Groups[2].Value -eq 9 -and [int]$s.Groups[3].Value -eq 0) "[5r] after 440 (+ the reconcile repair, + the deploy step): B reads nothing personal anywhere (the service-owned job included), the mixed claim keeps only its shared source, A reads as before, the guard holds (every link form, the text come back, the marker, the note), no function answers the anon role, the manifest counts shared links only, the stores are closed ($($s.Value))"
      # the REAL entity-wiki compile over the two withheld entity pages: the one with shared evidence (the article) is
      # rebuilt from shared material only, through the gateway alias (a stand-in that keeps every prompt); the private-only
      # one (round 2, tester 3: its only material left is a TYPED EDGE) gets no model call and no page. RED: round 1's
      # recipes ($InletPrevSha) - the edge made the private-only entity a page.
      $null = Run-Detached "$P-wllm" @('--network-alias', 'llama-cpp', '-v', $ctMount, '--entrypoint', 'deno', $wbTestTag, 'run', '--allow-net', '/ct/stub-wiki-llm.ts')
      $ents = ((Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT (v -> 'entities' ->> 'mixed') || ',' || (v -> 'entities' ->> 'priv') FROM public.lab_inlet_owner_plant WHERE k = 'plant'") | Out-String).Trim()
      $prevRecipes = Join-Path $env:TEMP "$P-recipes-$InletPrevSha"
      New-Item -ItemType Directory -Force $prevRecipes | Out-Null
      $script:made.dirs += $prevRecipes
      $tarR = Join-Path $env:TEMP "$P-recipes.tar"
      & git -C $ob1 archive --format=tar -o $tarR $InletPrevSha recipes
      & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $tarR -C $prevRecipes
      Remove-Item -Force $tarR
      $inCompile = {
        param($recipesDir, $runTag)
        $null = Dk run --rm --label $label --network $net --entrypoint node $viewerTag -e "fetch('http://llama-cpp:8080/_reset',{method:'POST'}).then(r=>r.text())"
        $cmpAt = ((Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT now()::text") | Out-String).Trim()
        # lab hygiene (the compile writes the entities it rebuilds - a later write the revert must not undo): their rows
        # as the migration left them, put back after the compile
        $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "DROP TABLE IF EXISTS public.lab_inlet_owner_ents; CREATE TABLE public.lab_inlet_owner_ents AS SELECT * FROM public.entities WHERE id IN ($ents)"
        $cmp = Lab-Docker 600 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${recipesDir}:/recipes:ro", '-v', "${vault}:/vault",
          '-e', 'OPEN_BRAIN_URL=http://openbrain-rest', '-e', 'OPEN_BRAIN_SERVICE_KEY=lab-placeholder', '-e', 'LLM_API_KEY=lab-placeholder',
          '-e', 'LLM_BASE_URL=http://llama-cpp:8080/v1', '-e', 'LLM_MODEL=lab-stub', '-e', 'WIKI_GIT_DIR=/vault',
          '--entrypoint', 'node', $viewerTag, '/recipes/entity-wiki/generate-wiki.mjs', '--ids', $ents, '--include-sources', '--no-graph', '--out-dir', '/vault/content')
        $cmpRc = $script:rc
        Save "inlet-compile-$runTag.log" ((($cmp -split "`n") | Select-Object -Last 40) -join "`n")
        $llog = Dk run --rm --label $label --network $net --entrypoint node $viewerTag -e "fetch('http://llama-cpp:8080/_log').then(r=>r.text()).then(t=>console.log(t))"
        $lj = @(); try { $lj = @(((($llog -split "`n") | Where-Object { $_ -match '^\[' } | Select-Object -Last 1)) | ConvertFrom-Json) } catch { }
        $res = @{
          chats = @($lj | Where-Object { $_.path -eq '/v1/chat/completions' }).Count
          marks = @($lj | Where-Object { $_.prompt -match "(?<!ctl)$inMark" -or $_.prompt -match 'mail\.google\.com' }).Count
          hosts = (@($lj | ForEach-Object { ($_.host -split ':')[0] } | Sort-Object -Unique) -join ',')
          pages = ((Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT count(*) FILTER (WHERE w.frontmatter ->> 'entity_id' = l.v -> 'entities' ->> 'mixed') || '|' || count(*) FILTER (WHERE w.frontmatter ->> 'entity_id' = l.v -> 'entities' ->> 'priv') || '|' || count(*) FILTER (WHERE w.body ~ ('(?<!ctl)' || (l.v ->> 'mark'))) FROM public.wiki_pages w, public.lab_inlet_owner_plant l WHERE l.k = 'plant'") | Out-String).Trim()
          rc = $cmpRc
        }
        Write-Host "    [compile $runTag] exit $($res.rc); $($res.chats) chat call(s) to $($res.hosts); prompts with a personal marker: $($res.marks); pages (mixed | priv | with a marker): $($res.pages)"
        # lab hygiene: the pages this compile wrote leave the lab again, row and file
        $newSlugs = @((Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT slug FROM public.wiki_pages WHERE updated_at >= '$cmpAt'::timestamptz") -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        foreach ($ns in $newSlugs) { $nf = Join-Path $vault "$ns.md"; if (Test-Path -LiteralPath $nf) { Remove-Item -Force -LiteralPath $nf } }
        $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "DELETE FROM public.wiki_pages WHERE updated_at >= '$cmpAt'::timestamptz"
        $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "BEGIN; SET LOCAL session_replication_role = replica; UPDATE public.entities e SET entity_type = x.entity_type, canonical_name = x.canonical_name, normalized_name = x.normalized_name, aliases = x.aliases, metadata = x.metadata, first_seen_at = x.first_seen_at, last_seen_at = x.last_seen_at, created_at = x.created_at, updated_at = x.updated_at FROM public.lab_inlet_owner_ents x WHERE x.id = e.id; COMMIT; DROP TABLE public.lab_inlet_owner_ents"
        Write-Host "    [compile $runTag] $($newSlugs.Count) page(s) the compile wrote removed again (row and file)"
        return $res
      }
      $cr = & $inCompile (Join-Path $prevRecipes 'recipes') 'red'
      Check ($cr.pages -match '^1\|1\|') "[5r] RED: round 1's compile ($InletPrevSha) builds the private-only entity a page from its typed edge (calls $($cr.chats), pages $($cr.pages))"
      $cg = & $inCompile (Join-Path $ob1 'recipes') 'green'
      Check ($cg.chats -eq 1 -and $cg.marks -eq 0 -and $cg.hosts -eq 'llama-cpp' -and $cg.pages -eq '1|0|0') "[5r] the real compile rebuilds the entity with shared evidence from shared material only, through the gateway alias; the private-only one (a typed edge left) gets no model call and no page; no page carries a marker (calls $($cg.chats), marker prompts $($cg.marks), pages $($cg.pages))"
      $null = Dk rm -f "$P-wllm"
      # round 2 (tester 2, 6): the real writer with a MIXED batch (a 380-withheld row + a 440-withheld row + a clean one), and
      # every slot-440 function through PostgREST with no credentials, directly and through openbrain-rest
      $ideaT = ((Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT id FROM public.idea_thought_archive ORDER BY id LIMIT 1") | Out-String).Trim()
      $privT = ((Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT v -> 'thoughts' ->> 2 FROM public.lab_inlet_owner_plant WHERE k = 'plant'") | Out-String).Trim()
      $privS = ((Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT v -> 'sources' ->> 'mail' FROM public.lab_inlet_owner_plant WHERE k = 'plant'") | Out-String).Trim()
      $po = Lab-Docker 300 @('run', '--rm', '--label', $label, '--network', $net, '-v', "$(Join-Path $ob1 'recipes\_shared'):/shared:ro", '-v', "${vault}:/vault", '-v', "${ct}:/ct:ro",
        '-e', 'SHARED=/shared', '-e', 'WIKI_GIT_DIR=/vault', '-e', 'OPEN_BRAIN_URL=http://openbrain-rest', '-e', 'PGRST_URL=http://openbrain-postgrest:3000',
        '-e', "IDEA_THOUGHT=$ideaT", '-e', "PRIV_THOUGHT=$privT", '-e', "PRIV_SOURCE=$privS", '-e', "TAG=$($ir.Substring(0, 6))", '--entrypoint', 'node', $viewerTag, '/ct/inlet-owner-probe.mjs')
      $pl = (($po -split "`n") | Where-Object { $_ -match '^PROBE ' } | Select-Object -Last 1)
      Save 'inlet-probe.log' ((($po -split "`n") | Where-Object { $_ -match '^PROBE |\[wiki-pages\]' }) -join "`n")
      $pj = $null; if ($pl) { try { $pj = $pl.Substring(6) | ConvertFrom-Json } catch { } }
      Write-Host "    [probe] $pl"
      Check ($pj -and $pj.exit -eq 0 -and -not $pj.rows.idea -and -not $pj.rows.priv -and $pj.rows.clean -and -not $pj.files.idea -and -not $pj.files.priv -and $pj.files.clean -and $pj.unsynced -eq 0 -and $pj.withheldMemo.idea -and $pj.withheldMemo.priv -and $pj.marker.header -eq '2' -and $pj.marker.back -eq 0) "[5r] a mixed batch (a 380-withheld row + a 440-withheld row) through the real writer: both WITHHELD (no row, no file), the clean page lands, nothing unsynced, exit 0; the marker counts 2"
      $rpcOk = $pj -and @($pj.rpc.PSObject.Properties | Where-Object { $_.Name -notmatch ':view' -and $_.Name -notmatch ':table:' -and [int]$_.Value -lt 300 }).Count -eq 0
      $tblOk = $pj -and @($pj.rpc.PSObject.Properties | Where-Object { $_.Name -match ':table:' -and [int]$_.Value -eq 299 }).Count -eq 0
      $viewOk = $pj -and $pj.rpc.'postgrest:view' -eq 200 -and $pj.rpc.'rest:view' -eq 200 -and -not $pj.rpc.'postgrest:view-has-owner-column' -and -not $pj.rpc.'rest:view-has-owner-column'
      Check ($rpcOk -and $tblOk -and $viewOk) "[5r] every slot-440 function is refused through PostgREST with no credentials, directly and through openbrain-rest (round 1's inlet_owner_default is gone); no private table returns a row; the prune's view names no owner"
      # lab hygiene: the probe's clean page leaves again (row and file), so the revert is measured against the migration's state
      $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "DELETE FROM public.wiki_pages WHERE slug LIKE 'content/topic/io-%'"
      foreach ($pf in @(Get-ChildItem -File (Join-Path $vault 'content\topic') -Filter 'io-*.md' -ErrorAction SilentlyContinue)) { Remove-Item -Force -LiteralPath $pf.FullName }
      $null = & $inBack
      $rcs = @((& $inPsql $inRevert 'revert' @()), (& $inPsql $inRevert 'revert again' @()))
      Check (@($rcs | Where-Object { $_ -ne 0 }).Count -eq 0 -and $script:p410['revert'] -match 'batch\(es\) restored' -and $script:p410['revert again'] -match 'nothing to restore') '[5r] revert-inlet-owner.sql restores the batch; a second run has nothing to restore'
      $s = & $inPhase 'reverted' 'inlet-reverted.log'
      Check ($s.Success -and $s.Groups[1].Value -eq 'ok') "[5r] after the revert the 14 tables are byte-identical (md5) to before the first run ($($s.Value))"
      $srcText = Get-Content -Raw $inInit
      foreach ($m in @(@('archive-thoughts', 'a thought'), @('archive-sources', 'a source'), @('archive-pages', 'a wiki page'), @('archive-jobs', 'a research job'), @('archive-events', 'a job event'))) {
        $mutant = Join-Path $env:TEMP "$P-440-mutant-$($m[0]).sql"
        $cut = [regex]::Replace($srcText, "(?s)-- \[$($m[0])\].*?-- \[/$($m[0])\]", '-- (mutant: no archive step)')
        [System.IO.File]::WriteAllText($mutant, $cut, (New-Object System.Text.UTF8Encoding $false))
        $script:made.dirs += $mutant
        $mrc = & $inPsql $mutant "mutant without the $($m[0])" @()
        Check ($cut -ne $srcText -and $mrc -ne 0 -and $script:p410["mutant without the $($m[0])"] -match 'refused, nothing changed') "[5r] a 440 that changes $($m[1]) it did not first archive FAILS (refused, nothing changed)"
        $s = & $inPhase 'reverted' "inlet-after-mutant-$($m[0]).log"
        Check ($s.Success -and $s.Groups[1].Value -eq 'ok') "[5r] the refused mutant ($($m[0])) changed nothing ($($s.Value))"
      }
      $r3 = & $inPsql $inInit 'init (after the revert)' @()
      $null = & $inOut
      $lrc = & $inPsql $plantFile 'late plant' @('-v', "mark=$inMark", '-v', 'phase=late')
      $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "INSERT INTO public.lab_inlet_owner_plant SELECT 'late-unowned', jsonb_build_object('ids', coalesce(jsonb_agg(id ORDER BY id), '[]')) FROM public.thoughts WHERE user_id IS NULL ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v"
      $r4 = & $inPsql $inInit 'init (the second run, after new unowned rows)' @()
      $s = & $inPhase 'rerun' 'inlet-rerun.log'
      Check ($r3 -eq 0 -and $lrc -eq 0 -and $r4 -eq 0 -and $s.Success -and $s.Groups[1].Value -eq 'ok' -and [int]$s.Groups[2].Value -eq 1) "[5r] the second run stamps and isolates exactly the rows that arrived unowned; B still reads nothing personal ($($s.Value))"
      # the gmail prune deletes BY OWNER: three expired short-term mails (the owner's, B's, an unowned one that arrived
      # since the last run). RED: the base's prune ($InletBaseSha) deletes all three. GREEN: this prune deletes the owner's only.
      $pruneBase = Join-Path $env:TEMP "$P-prune-base"
      New-Item -ItemType Directory -Force $pruneBase | Out-Null
      $script:made.dirs += $pruneBase
      [System.IO.File]::WriteAllText((Join-Path $pruneBase 'prune-short-term.ts'), ((& git -C $ob1 show "${InletBaseSha}:recipes/email-history-import/prune-short-term.ts") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
      $pruneRes = @{}
      foreach ($run in @(@('red', $pruneBase), @('green', (Join-Path $ob1 'recipes\email-history-import')))) {
        $ids = ((Dk exec $db psql -U postgres -d openbrain -X -tAc "WITH x AS (INSERT INTO public.thoughts (content, metadata, exposure, user_id) SELECT 'Subject: lab prune | ' || o, jsonb_build_object('source', 'gmail', 'email_date', '2020-01-01T00:00:00Z', 'gmail_labels', jsonb_build_array('brain/keep-short-term')), 'ops', NULLIF(o, 'none') FROM unnest(ARRAY['$inA', '$inB', 'none']) o RETURNING id) SELECT string_agg(id::text, ',') FROM x") | Out-String).Trim()
        $po = Lab-Docker 300 @('run', '--rm', '--label', $label, '--network', $net, '-v', "$($run[1]):/p:ro", '-e', 'SUPABASE_URL=http://openbrain-rest',
          '--entrypoint', 'deno', $wbTestTag, 'run', '--allow-net', '--allow-env', '--allow-read', '--allow-write', '/p/prune-short-term.ts', '--retention-days=30', '--no-wiki-recompile')
        Save "inlet-prune-$($run[0]).log" ((($po -split "`n") | Where-Object { $_ -match 'Found|Deleted|nothing|owner' }) -join "`n")
        $left = ((Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT coalesce(user_id, 'none') FROM public.thoughts WHERE id IN ($ids) ORDER BY 1") -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) -join ','
        $pruneRes[$run[0]] = $left
        Write-Host "    [prune $($run[0])] left: $left"
        $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "DELETE FROM public.thoughts WHERE id IN ($ids)"
      }
      Check ($pruneRes['red'] -eq '') "[5r] RED: the base's prune ($InletBaseSha) deletes every expired short-term mail, whoever's (left: '$($pruneRes['red'])')"
      $pruneWant = (@($inB, 'none') | Sort-Object) -join ','
      Check ($pruneRes['green'] -eq $pruneWant) "[5r] the prune deletes by owner: the owner's expired mail only; B's and the unowned one stay (left: $($pruneRes['green']))"
      $null = & $inOut
    }
    Save 'inlet-psql.log' (($script:p410.GetEnumerator() | Sort-Object Name | ForEach-Object { "[$($_.Name)] $($_.Value)" }) -join "`n")
  }

  if (-not $IdeasOnly -and -not $SettingsOnly) {
  # rw-p5a-intake: the intake and queue panel over the real workbench and database, two users and OWUI's key
  Write-Host '[5e] the intake and queue panel integration test (two users, the OWUI inlet, every queue)'
  $o = Lab-Docker 900 @('run', '--rm', '--label', $label, '--network', $net,
    '-e', "INTAKE_TEST_BASE=http://$P-wb:8000", '-e', "INTAKE_TEST_KEY=$key", '-e', "INTAKE_TEST_OWUI_KEY=$owuiKey",
    '-e', 'INTAKE_TEST_RESEARCH=http://stub-research:8000', '-e', 'INTAKE_TEST_GATE=http://stub-gate:8080',
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', 'src/intake/intake_integration_test.ts')
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save 'intake-integration.log' ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||passed|failed|error:|AssertionError|Values are not equal|\[Diff\]|^\s+[-+]' }) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)' }) { Write-Host "    $l" }
  $sum = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
  if ($Red) { Check ($sum.Success -and [int]$sum.Groups[2].Value -eq 0) "RED: the intake integration test fails on the base ($($sum.Value))" }
  else { Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0) "the intake integration test ($($sum.Value))" }
  }

  # round 2 (tester attempt 1 F1-F6): the route-wide isolation sweep, LAST (it calls mutating routes
  # with user B's ids as user A). Its route table is the router's own (src/app.ts, imported in the test
  # stage image with the workbench's DB_* / recipes so the import resolves; never served there).
  $walks = if ($Red -and $baseChain) { @() } elseif ($WalkOff -or $Red) { @($(if ($WalkOff) { 'off' } else { 'on' })) } else { @('on', 'off') }
  foreach ($walk in $walks) {
  if ($walk -eq 'off' -and -not $WalkOff) {
    # the same lab, the workbench restarted with the response walk OFF: the routes alone must hold
    # rw-p5a-intake round 3 (reviewer R2): jobs left in flight by the stopped process (a holding add, an embedding
    # import) are marked failed by the start-up sweep of the new one, with the fixed reason, and are retryable
    $stale = Dk exec $db psql -U postgres -d openbrain -X -tAc "INSERT INTO public.import_jobs (status, mode, owner_sub, refinery_id) VALUES ('holding', 'add', 'stale-owner', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'), ('embedding', 'import', 'stale-owner', NULL) RETURNING id"
    $staleIds = @(($stale -split "`n") | Where-Object { $_ -match '^[0-9a-f-]{36}$' })
    $null = Dk rm -f "$P-wb"
    $restart = $wbArgs + @('-e', 'WORKSPACE_RESPONSE_WALK=off', $wbTag)
    $null = Dk run -d --name "$P-wb" --label $label --network $net @restart
    Check (($script:rc -eq 0) -and (Wait-Http "http://$P-wb:8000/health" 90)) 'the workbench restarted with the response walk off'
    $after = ''
    for ($i = 0; $i -lt 20; $i++) {
      $after = (Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT status || '|' || coalesce(error, '') FROM public.import_jobs WHERE id::text IN ('$($staleIds -join "','")') ORDER BY status").Trim()
      if ($after -and $after -notmatch 'holding|embedding') { break }
      Start-Sleep -Seconds 1
    }
    Save 'stale-sweep.log' "planted: $($staleIds -join ', ') (holding add, embedding import)`nafter the restart: $after"
    Write-Host "    [5g] after the restart: $($after -replace "`n", ' ; ')"
    Check ($staleIds.Count -eq 2 -and @(($after -split "`n") | Where-Object { $_ -match '^failed\|interrupted: the workbench restarted' }).Count -eq 2) '[5g] the start-up sweep marks the stale holding / embedding jobs failed (retryable)'
  }
  Write-Host "[5d] the route-wide isolation sweep (as user A, every registered route, both doors; response walk $walk)"
  $o = Lab-Docker 1800 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${vault}:/vault",
    '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro",
    '-e', "SWEEP_BASE=http://$P-wb:8000", '-e', "SWEEP_VIEWER=http://$P-viewer:8080", '-e', "DOCS_TEST_KEY=$key", '-e', 'DOCS_TEST_VAULT=/vault',
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    '-e', "DB_HOST=$db", '-e', 'DB_USER=postgres', '-e', "DB_PASSWORD=$pw", '-e', 'WIKI_GIT_DIR=/vault', '-e', 'OPEN_BRAIN_URL=http://openbrain-rest',
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read', '--allow-write', '--allow-run', 'src/documents/isolation_sweep_test.ts')
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save "isolation-sweep-walk-$walk.log" ((($clean -split "`n") | Where-Object { $_ -match '^sweep:|HIT |\.\.\. (ok|FAILED)|^(ok|FAILED) \||error:' }) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '^sweep:|HIT ' } | Select-Object -First 60) { Write-Host "    $l" }
  $sw = ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
  if ($Red) { Check ($sw.Success -and $clean -match 'HIT ') "RED: the isolation sweep finds user B's context on the base, response walk $walk ($($sw.Value))" }
  else { Check ($sw.Success -and $sw.Groups[1].Value -eq 'ok' -and [int]$sw.Groups[3].Value -eq 0 -and $clean -match 'sweep: \d+ routes') "the route-wide isolation sweep, response walk $walk ($($sw.Value))" }

  }

  # rw-p5a-intake round 2 (tester T-F1): on this database (the whole chain ran), the slot-360 revert removes only
  # what init-intake-queue.sql added (revert-intake-queue-check.sql), and init + revert re-run cleanly. LAST: it
  # drops the intake queue's columns, so nothing may run against the workbench after it.
  if (-not $Red) {
    # rw-settings-store [5m]: slot 400 runs cleanly 3 times, its revert twice, and init again; the revert removes only
    # what it added (the admin tier contract_settings and idea_schedule are as they were)
    Write-Host '[5m] init-settings.sql twice more (3 runs with the chain''s), revert-settings.sql twice, then init again'
    $q = { param($x) (Dk exec $db psql -U postgres -d openbrain -X -tAc $x).Trim() }
    # the key count only when the table exists (a CASE branch still resolves its relation, so ask in two steps)
    $objs0 = "SELECT (SELECT count(*) FROM pg_proc WHERE proname IN ('setting_get','setting_problem','user_setting_set','trg_user_settings_guard'))::text || ' fns, ' || (to_regclass('public.settings_keys') IS NOT NULL)::text || ' ' || (to_regclass('public.user_settings') IS NOT NULL)::text"
    $objsFn = { $r = & $q $objs0; $p = $r -split ' '; if ($p[2] -eq 'true') { $k = (& $q "SELECT count(*) FROM public.settings_keys") + ' keys' } else { $k = 'no keys' }; "$($p[0]) $($p[1]) $k, $(if ($p[3] -eq 'true') { 'user_settings' } else { 'no user_settings' })" }
    $kept = "SELECT (SELECT coalesce(md5(string_agg(key || value::text || version, ',' ORDER BY key)), '-') FROM public.contract_settings) || ' / ' || (SELECT count(*)::text || ':' || coalesce(md5(string_agg(owner_sub || mode || coalesce(at_time::text, '') || tz, ',' ORDER BY owner_sub)), '-') FROM public.idea_schedule)"
    $null = & $q "INSERT INTO public.user_settings (owner_sub, key, value) VALUES ('settings-revert-$rand', 'refinery.dormancy_days', '9') ON CONFLICT DO NOTHING"
    $keptBefore = & $q $kept
    $objsBefore = & $objsFn
    $rv4 = @("before: $objsBefore | kept: $keptBefore")
    foreach ($f in @('init-settings.sql', 'init-settings.sql', 'revert-settings.sql', 'revert-settings.sql', 'init-settings.sql')) {
      $null = Dk cp (Join-Path $dockerDir $f) "${db}:/tmp/rv400.sql"
      $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/rv400.sql
      $rv4 += "[$f] exit $($script:rc)$(if ($o -match 'ERROR') { ': ' + (($o -split "`n" | Where-Object { $_ -match 'ERROR' }) -join ' ') }) -> $(& $objsFn) | kept: $(& $q $kept)"
    }
    Save 'revert-settings.log' ($rv4 -join "`n")
    foreach ($l in $rv4) { Write-Host "    $l" }
    $afterRevert = @($rv4 | Where-Object { $_ -match '^\[revert-settings\.sql\] exit 0 -> 0 fns, no keys, no user_settings' }).Count
    Check (@($rv4 | Where-Object { $_ -match 'exit 0 ' }).Count -eq 5 -and $afterRevert -eq 2 -and $rv4[-1] -match "-> $([regex]::Escape(($objsBefore -split ' keys')[0])) keys, user_settings" -and @($rv4 | Where-Object { $_ -match '^\[' -and $_ -notmatch ([regex]::Escape("kept: $keptBefore") + '$') }).Count -eq 0) 'slot 400: init runs 3 times, revert twice (removing exactly its own objects), init again restores them; contract_settings and idea_schedule untouched'
    Check ((& $q "SELECT count(*) FROM public.user_settings") -eq '0') 'slot 400: the revert discarded the user tier (documented), init again starts it empty'
  }
  if (-not $Red) {
    # rw-p8a4-ideas: the slot-370 revert runs cleanly twice and leaves the slot-230 notification trigger as it was
    Write-Host '[5i] init-idea-functions.sql twice more (3 runs with the chain''s), revert-idea-functions.sql twice, then init again'
    $rv3 = @()
    foreach ($f in @('init-idea-functions.sql', 'init-idea-functions.sql', 'revert-idea-functions.sql', 'revert-idea-functions.sql', 'init-idea-functions.sql')) {
      $null = Dk cp (Join-Path $dockerDir $f) "${db}:/tmp/rv370.sql"
      $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/rv370.sql
      $rv3 += "[$f] exit $($script:rc)$(if ($o -match 'ERROR') { ': ' + (($o -split "`n" | Where-Object { $_ -match 'ERROR' }) -join ' ') })"
    }
    $fns = (Dk exec $db psql -U postgres -d openbrain -X -tAc "SELECT count(*) FROM pg_proc WHERE proname IN ('idea_edit','idea_research','idea_promote','idea_deliver_dossier','idea_resurface','refinery_engage')").Trim()
    $rv3 += "functions after init again: $fns"
    Save 'revert-idea-functions.log' ($rv3 -join "`n")
    foreach ($l in $rv3) { Write-Host "    $l" }
    Check (@($rv3 | Where-Object { $_ -match 'exit 0$' }).Count -eq 5 -and $fns -eq '6') 'slot 370: init runs 3 times, revert twice, and init again restores the six functions'
  }
  if (-not $Red -and -not $IdeasOnly) {
    Write-Host '[5f] revert-intake-queue.sql removes only what init-intake-queue.sql added (twice: revert, init, revert)'
    $rv = @()
    foreach ($f in @(@('revert-intake-queue.sql', 'revert'), @('workbench/contract-test/revert-intake-queue-check.sql', 'check'), @('init-intake-queue.sql', 'init'),
        @('revert-intake-queue.sql', 'revert again'), @('workbench/contract-test/revert-intake-queue-check.sql', 'check again'),
        @('revert-intake-queue.sql', 'revert a second time in a row'))) {  # round 4 (reviewer N3): a revert re-runs
      $null = Dk cp (Join-Path $dockerDir $f[0]) "${db}:/tmp/rv.sql"
      $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/rv.sql
      $rv += "[$($f[1])] exit $($script:rc): $(($o -split "`n" | Where-Object { $_ -match 'REVERT-CHECK|ERROR' }) -join ' ')"
      if ($script:rc -ne 0) { break }
    }
    Save 'revert-intake-queue.log' ($rv -join "`n")
    foreach ($l in $rv) { Write-Host "    $l" }
    Check ($rv.Count -eq 6 -and @($rv | Where-Object { $_ -match 'REVERT-CHECK OK' }).Count -eq 2 -and @($rv | Where-Object { $_ -notmatch 'exit 0' }).Count -eq 0) 'the intake revert removes only its own rows, and init + revert re-run cleanly'
  }

  Write-Host '[5c] the grammar copy'
  $a = [System.IO.File]::ReadAllBytes((Join-Path $wb 'src/documents/grammar.ts'))
  $b = [System.IO.File]::ReadAllBytes((Join-Path $wsDir 'src/lib/grammar.ts'))
  Check ([Convert]::ToBase64String($a) -eq [Convert]::ToBase64String($b)) 'the workspace grammar is byte-identical to the documents API grammar'

  # D12 at the end of everything: no user document became a page
  $rows = (Dk exec $db psql -U postgres -d openbrain -tAc "select count(*) from wiki_pages where slug like 'documents/%'").Trim()
  if (-not $Red) { Check ($rows -eq '0') "no wiki_pages row for any user document ($rows)" }
  Save 'viewer.log' ((Dk logs --tail 60 "$P-viewer") -replace [regex]::Escape($key), '<key>')
  Save 'workbench.log' (((((Dk logs --tail 120 "$P-wb") -replace [regex]::Escape($key), '<key>') -replace [regex]::Escape($gateKey), '<gate-key>') -replace [regex]::Escape($svcKey), '<svc-key>') -replace [regex]::Escape($owuiKey), '<owui-key>')
} catch {
  Fail "the run stopped: $_"
} finally {
  Write-Host '[6] teardown'
  foreach ($c in $script:made.containers) { $null = Dk rm -f -v $c }
  if ($script:made.net) { $null = Dk network rm $net }
  if (-not $KeepImages) { foreach ($i in $script:made.images) { $null = Dk rmi -f $i } }
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}' | Out-String).Trim()
  Check (-not $left) "no container labelled $Id is left ($left)"
  $leftNet = (Dk network ls --filter "label=$label" --format '{{.Name}}' | Out-String).Trim()
  Check (-not $leftNet) "no network labelled $Id is left ($leftNet)"
  if (-not $KeepImages) {
    $leftImg = @($script:made.images | Where-Object { (Dk image inspect $_ 2>$null) -and $script:rc -eq 0 })
    Check ($leftImg.Count -eq 0) "no image of this run is left ($($leftImg -join ', '))"
  }
  $localAfter = LocalSnapshot
  Check ((($localBefore -join "`n") -eq ($localAfter -join "`n"))) 'no :local image changed'
  # the evidence gate: redacted logs only (screenshots are never published)
  $uuids = Get-FixtureUuids (Get-Content -Raw (Join-Path $ct 'fixtures.sql'))
  $ftext = Get-FixtureText @((Join-Path $ct 'fixtures.sql'))
  $pub = Publish-Evidence $evStage $Evidence @() { param($d, $c) @() } $uuids $ftext
  Write-Host "  evidence: published=$($pub.published) files=$($pub.files) dropped=$(@($pub.dropped).Count) -> $Evidence"
  foreach ($d in $script:made.dirs) { if (Test-Path $d) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } }
}
Write-Host "== $(if ($script:fail) { "FAILED ($($script:fail))" } else { 'ALL PASSED' })"
exit $(if ($script:fail) { 1 } else { 0 })
