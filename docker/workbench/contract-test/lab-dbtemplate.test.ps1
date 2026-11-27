# lab-dbtemplate.test.ps1 - the docker proof of the DB template (rw-lab-throughput part 3, lab-throughput.ps1).
# Every container runs with --network none and the label ai-stack.harness.owner=<Id>; nothing is published, no network is
# created, no :local image is touched. What it proves:
#   D1 the comparator can fail: a database replayed WITHOUT the last slot dumps differently from the full chain (red first)
#   D2 a lab cloned from the template has a schema dump byte-identical to one built by replaying the chain at initdb
#      (pg_dump --schema-only, owners and privileges included; pg_dump 16's \restrict / \unrestrict lines dropped first),
#      and the same roles (pg_dumpall --globals-only --no-role-passwords)
#   D3 a template volume whose labels name another pin is never used (it is rebuilt), and a volume that is not a lab
#      template at all is never used and never removed
#   D4 the template is reused, not replayed, by the next run of the same pin and chain
#
#   powershell -NoProfile -File lab-dbtemplate.test.ps1 [-Id wt-lab-dbtpl-test] [-KeepTemplate]
param(
  [string]$Id = 'wt-lab-dbtpl-test',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [switch]$KeepTemplate
)
$ErrorActionPreference = 'Continue'
$ct = $PSScriptRoot; $wb = Split-Path -Parent $ct; $dockerDir = Split-Path -Parent $wb; $ob1 = Split-Path -Parent $dockerDir
$label = "ai-stack.harness.owner=$Id"
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$P = "dbtpl-$rand"
$script:fail = 0; $script:n = 0
function Pass([string]$m) { $script:n++; Write-Host "  PASS  $m" }
function Fail([string]$m) { $script:n++; Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
# a minimal shim: --network none only, no published port, no :local, no compose
function Lab-Docker([int]$TimeoutSec, [string[]]$a) {
  $all = $a -join ' '
  $why = ''
  if ($a[0] -eq 'compose') { $why = 'compose' }
  elseif ($all -match '(^|\s)(-p|--publish|-P)(\s|=|$)') { $why = 'a published port' }
  elseif ($a[0] -eq 'run' -and ($a -notcontains 'none')) { $why = 'a run without --network none' }
  elseif ($a[0] -eq 'network') { $why = 'a network' }
  elseif ($all -match ':local(\s|$)') { $why = 'a :local image' }
  if ($why) { Write-Host "  SHIM REFUSED: $why :: docker $all"; $script:rc = 2; $script:fail++; return "REFUSED: $why" }
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
$script:made = @{ containers = @(); vols = @(); dirs = @() }
function Run-Detached([string]$name, [string[]]$extra) {
  # the runners' helper, on --network none
  $o = Dk run -d --name $name --label $label --network none @extra
  if ($script:rc -ne 0) { Fail "$name did not start: $o"; return $false }
  $script:made.containers += $name
  return $true
}
. (Join-Path $ct 'lab-throughput.ps1')

function Stage-Chain([string]$dir, [int]$dropLast = 0) {
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $dir | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  $chain = @($chain | Sort-Object { $_[1] })
  $use = if ($dropLast) { $chain[0..($chain.Count - 1 - $dropLast)] } else { $chain }
  foreach ($m in $use) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $dir $m[1]) }
  $script:made.dirs += $dir
  return $use.Count
}
function Start-Replay([string]$name, [string]$stage) {
  $pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
  $null = Run-Detached $name @('-e', "POSTGRES_PASSWORD=$pw", '-e', 'POSTGRES_DB=openbrain', '-v', "${stage}:/docker-entrypoint-initdb.d:ro", $PgImage)
  for ($i = 0; $i -lt 300; $i++) { if ((Dk logs $name) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $name pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  return (Dk logs $name)
}
function Get-Dump([string]$name, [string]$what) {
  $cmd = if ($what -eq 'globals') { 'pg_dumpall -U postgres --globals-only --no-role-passwords' } else { 'pg_dump -U postgres -d openbrain --schema-only' }
  $o = Dk exec $name sh -c $cmd
  $ok = ($script:rc -eq 0)
  $lines = @(($o -split "`n") | Where-Object { $_ -notmatch '^\\(un)?restrict ' })
  return @{ ok = $ok; text = ($lines -join "`n"); dropped = @(($o -split "`n") | Where-Object { $_ -match '^\\(un)?restrict ' }).Count }
}
function Save-Diff([string]$a, [string]$b, [string]$name) {
  $f = Join-Path $env:TEMP "$P-$name.diff"
  (Compare-Object ($a -split "`n") ($b -split "`n") | Select-Object -First 40 | Out-String) | Set-Content -Encoding ASCII $f
  Write-Host "    (first differences: $f)"
}

# rw-lab-throughput test attempt 1 (D3): the proof never touches the LIVE template of this pin. Every template it builds,
# plants or removes is under a SCRATCH pin (a random 40-hex 'd3...' that is no commit), so its volume name is its own; the
# live one (ob1-dbtpl-<HEAD12>-<digest12>) is inspected before and after and must be unchanged (or still absent).
$livePin = "$(& git -C $ob1 rev-parse HEAD)".Trim()
$pin = 'd3' + (-join ((48..57 + 97..102) | Get-Random -Count 38 | ForEach-Object { [char]$_ }))
while ($pin.Length -lt 40) { $pin += '0' }
try {
  Write-Host "== lab-dbtemplate.test  owner=$Id  scratch pin=$($pin.Substring(0, 12)) (the live pin $($livePin.Substring(0, 12)) is only inspected)"
  $stage = Join-Path $env:TEMP "$P-stage"; $nFull = Stage-Chain $stage
  $stageShort = Join-Path $env:TEMP "$P-stage-short"; $nShort = Stage-Chain $stageShort 1
  Check ($nFull -gt 60 -and $nShort -eq $nFull - 1) "the chain from docker-compose.yml: $nFull migrations (and $nShort without the last)"
  $liveVol = "ob1-dbtpl-$($livePin.Substring(0, 12))-$((Get-LabChainDigest $stage $PgImage).Substring(0, 12))"
  $liveBefore = "$(Dk volume inspect --format '{{.CreatedAt}} {{json .Labels}}' $liveVol)".Trim()
  $liveExisted = ($script:rc -eq 0)
  Write-Host "  the live template $liveVol $(if ($liveExisted) { 'exists' } else { 'is absent' }) before the proof"
  Check ($liveVol -ne "ob1-dbtpl-$($pin.Substring(0, 12))-$((Get-LabChainDigest $stage $PgImage).Substring(0, 12))") 'the scratch template has its own volume name, never the live one'

  Write-Host '[D1] the comparator can fail (red first): the chain without its last slot dumps differently'
  $logR = Start-Replay "$P-replay" $stage
  Check ($logR -match 'PostgreSQL init process complete' -and @(($logR -split "`n") | Where-Object { $_ -match 'ERROR:' }).Count -eq 0) 'the replayed database ran the whole chain with no ERROR'
  $null = Start-Replay "$P-short" $stageShort
  $dR = Get-Dump "$P-replay" 'schema'; $dS = Get-Dump "$P-short" 'schema'
  Check ($dR.ok -and $dS.ok -and $dR.text.Length -gt 10000 -and $dR.text -ne $dS.text) "a chain missing one slot gives a different schema dump ($($dR.text.Length) vs $($dS.text.Length) bytes)"
  Check ($dR.dropped -ge 1) "pg_dump 16 wrote \restrict lines, dropped before comparing ($($dR.dropped) in the replayed dump)"
  $null = Dk rm -f -v "$P-short"

  Write-Host '[D2] the template clone is byte-identical to the replay'
  $tpl = Initialize-LabDbTemplate $PgImage $stage $pin
  Check (-not $tpl.refused) "the template for pin $($pin.Substring(0, 12)) is ready: $($tpl.vol) ($(if ($tpl.built) { 'built' } else { 'reused' }))"
  $tplLog = $tpl.log
  Check ($tplLog -match 'PostgreSQL init process complete' -and @(($tplLog -split "`n") | Where-Object { $_ -match 'ERROR:' }).Count -eq 0) 'the template carries its init log: the chain completed with no ERROR'
  $vol = New-LabDbVolume $PgImage $tpl.vol "$P-clonevol"
  $script:made.vols += "$P-clonevol"
  Check ($null -ne $vol) 'the lab volume is a copy of the template'
  $cpw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
  $null = Run-Detached "$P-clone" (@('-e', "POSTGRES_PASSWORD=$cpw", '-e', 'POSTGRES_DB=openbrain') + $vol + @($PgImage))
  $up = $false
  for ($i = 0; $i -lt 90; $i++) { $null = Dk exec "$P-clone" pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { $up = $true; break }; Start-Sleep -Seconds 2 }
  Check ($up -and (Set-LabDbPassword "$P-clone" $cpw)) 'the clone starts without initdb and takes the run''s own password'
  Check ((Dk logs "$P-clone") -match 'Skipping initialization') 'the clone did not replay the chain (postgres: Skipping initialization)'
  $dC = Get-Dump "$P-clone" 'schema'
  if ($dC.text -ne $dR.text) { Save-Diff $dR.text $dC.text 'schema' }
  Check ($dC.ok -and $dC.text -eq $dR.text) "the cloned schema dump is byte-identical to the replayed one ($($dC.text.Length) bytes, sha256 $((Get-LabSha256 $dC.text).Substring(0, 12)) vs $((Get-LabSha256 $dR.text).Substring(0, 12)))"
  $gR = Get-Dump "$P-replay" 'globals'; $gC = Get-Dump "$P-clone" 'globals'
  if ($gC.text -ne $gR.text) { Save-Diff $gR.text $gC.text 'globals' }
  Check ($gR.ok -and $gC.ok -and $gC.text -eq $gR.text -and $gR.text -match 'CREATE ROLE') "the roles (pg_dumpall --globals-only --no-role-passwords) are identical ($(@(($gR.text -split "`n") | Where-Object { $_ -match '^CREATE ROLE' }).Count) roles)"
  $tc = Dk exec "$P-clone" psql -U postgres -d openbrain -X -tAc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'"
  $tr = Dk exec "$P-replay" psql -U postgres -d openbrain -X -tAc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'"
  Check ("$tc".Trim() -eq "$tr".Trim() -and [int]"$tc".Trim() -gt 50) "the same number of public relations ($("$tc".Trim()))"
  # an ordinary lab step on top: a forward slot re-run is idempotent on the clone as on the replay
  $last = @(Get-ChildItem $stage -Filter '*.sql' | Sort-Object Name)[-1]
  foreach ($c in @("$P-clone", "$P-replay")) { $null = Dk cp $last.FullName "${c}:/tmp/last.sql"; $null = Dk exec $c psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/last.sql }
  $dC2 = Get-Dump "$P-clone" 'schema'; $dR2 = Get-Dump "$P-replay" 'schema'
  Check ($dC2.text -eq $dR2.text) "a slot step on top ($($last.Name) again) leaves the two dumps identical"
  $null = Dk rm -f -v "$P-clone" "$P-replay"

  Write-Host '[D4] the next run reuses the template (no replay)'
  $t0 = Get-Date
  $tpl2 = Initialize-LabDbTemplate $PgImage $stage $pin
  Check (-not $tpl2.refused -and -not $tpl2.built -and $tpl2.vol -eq $tpl.vol) "the same pin and chain reuse $($tpl2.vol) ($([int]((Get-Date) - $t0).TotalSeconds) s)"
  $otherStage = Join-Path $env:TEMP "$P-stage-other"; $null = Stage-Chain $otherStage 1
  Check ((Get-LabChainDigest $otherStage $PgImage) -ne $tpl.digest) 'another chain has another digest, so another template name'

  Write-Host '[D3] a template labelled for another pin is never used'
  if ($tpl.vol -eq $liveVol -or $tpl.vol -notmatch "^ob1-dbtpl-$($pin.Substring(0, 12))-") { throw "refusing to plant over $($tpl.vol): not the scratch template" }
  $null = Dk volume rm -f $tpl.vol
  $null = Dk volume create --label 'ai-stack.lab.dbtpl=1' --label "ai-stack.lab.dbtpl.pin=$('0' * 40)" --label "ai-stack.lab.dbtpl.digest=$($tpl.digest)" $tpl.vol
  $tpl3 = Initialize-LabDbTemplate $PgImage $stage $pin
  $l3 = Get-LabVolumeLabels $tpl.vol
  Check (-not $tpl3.refused -and $tpl3.built -and $l3['ai-stack.lab.dbtpl.pin'] -eq $pin) 'a planted template volume with another pin label is refused and rebuilt for this (scratch) pin'
  $null = Dk volume rm -f $tpl.vol
  $null = Dk volume create --label 'ai-stack.lab.dbtpl=1' --label "ai-stack.lab.dbtpl.pin=$pin" --label "ai-stack.lab.dbtpl.digest=$($tpl.digest)" $tpl.vol
  $tpl4 = Initialize-LabDbTemplate $PgImage $stage $pin
  Check (-not $tpl4.refused -and $tpl4.built) 'a volume with the right labels but no READY marker (an interrupted build) is rebuilt, not used'
  $null = Dk volume rm -f $tpl.vol
  $null = Dk volume create --label $label $tpl.vol
  $tpl5 = Initialize-LabDbTemplate $PgImage $stage $pin
  $l5 = Get-LabVolumeLabels $tpl.vol
  Check ($tpl5.refused -match 'not a lab DB template' -and $null -ne $l5 -and -not $l5.ContainsKey('ai-stack.lab.dbtpl')) 'a volume that is not a lab template is refused - not used and not removed'
  $null = Dk volume rm -f $tpl.vol
  if ($KeepTemplate) { $tpl6 = Initialize-LabDbTemplate $PgImage $stage $pin; Check (-not $tpl6.refused) "kept: $($tpl6.vol)" }
  $liveAfter = "$(Dk volume inspect --format '{{.CreatedAt}} {{json .Labels}}' $liveVol)".Trim()
  $liveNow = ($script:rc -eq 0)
  Check ($liveNow -eq $liveExisted -and (-not $liveExisted -or $liveAfter -eq $liveBefore)) "the live template $liveVol is untouched ($(if ($liveExisted) { 'same CreatedAt and labels' } else { 'still absent' }))"
} catch {
  Fail "the run stopped: $_"
} finally {
  foreach ($c in $script:made.containers) { $null = Dk rm -f -v $c }
  foreach ($v in $script:made.vols) { $null = Dk volume rm -f $v }
  if ($tpl -and $tpl.vol -and $tpl.vol -match "^ob1-dbtpl-$($pin.Substring(0, 12))-" -and -not $KeepTemplate) { $null = Dk volume rm -f $tpl.vol }
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}' | Out-String).Trim()
  Check (-not $left) "no container labelled $Id is left ($left)"
  $leftVol = (Dk volume ls --filter "label=$label" --format '{{.Name}}' | Out-String).Trim()
  Check (-not $leftVol) "no volume labelled $Id is left ($leftVol)"
  foreach ($d in $script:made.dirs) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue }
}
Write-Host "== $(if ($script:fail) { "FAILED ($($script:fail) of $($script:n))" } else { "ALL PASSED ($($script:n))" })"
exit $(if ($script:fail) { 1 } else { 0 })
