# run-rest-door-deploy-lab.ps1 - the rw-rest-door-auth DEPLOY PATH on a lab copy of the live compose (test plan case 8).
#
# The live switch-over is a sequence of `docker compose` commands against OB1/docker. This lab runs those commands,
# as the test plan's "Live deploy" section writes them, against a LAB copy of the same compose files:
#   * a lab "live" directory holds OB1/docker (+ integrations/intake/sql) of -BaseSha and a lab .env;
#   * `docker compose config` renders it, rest-door-deploy-compose.py keeps the door services' REAL configuration and
#     the seven callers' REAL environment and depends_on (callers are node stand-ins), with no container_name, no port,
#     one --internal network on -Subnet, the project rda-deploy-<rand> (never open-brain: its volumes are lab-owned);
#   * phase A brings the pre-change stack up; then the files in the lab directory are replaced by -NewSha's, as the
#     merge does to the live checkout (the containers keep their old configuration, Caddy its old Caddyfile in memory);
#   * then each deploy step, literally, and after EACH step: which containers were recreated (container ids and compose
#     config hashes, before / after), whether openbrain-rest serves the new or the old Caddyfile, and that every one of
#     the seven callers works - one request it really makes, from inside its own container, with the token from its own
#     environment (the token is never printed).
# -Red runs the ROUND-1 deploy commands instead (`up -d <svc>` without --no-deps / --force-recreate) and must show the
# defects: openbrain-db recreated by step 4, openbrain-rest not recreated by step 5 and every caller refused, the
# revert's 500s.
#
#   powershell -NoProfile -File run-rest-door-deploy-lab.ps1 -Subnet 203.0.113.0/24 -Evidence <empty dir>
#   powershell -NoProfile -File run-rest-door-deploy-lab.ps1 -Subnet 198.51.100.0/24 -Evidence <empty dir> -Red
# Never a live container, the live database, a published port, an ai-stack_* / open-brain_* network, or a :local image;
# zero leftovers (the project is brought down with its volumes; the run checks the label). Exit 0 = every check held
# (with -Red: every defect shown).
param(
  [string]$Id = 'wt-rw-rest-door-auth',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$BaseSha = '116b80e',
  [string]$NewSha = 'HEAD',
  [string]$NodeImage = 'node:22-slim',
  [switch]$Red,
  [switch]$Keep
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
. (Join-Path $PSScriptRoot 'harness-subnet.ps1')
$w = Test-HarnessSubnet $Subnet
if ($w) { Write-Host "REFUSED: $w"; exit 2 }
if ($Evidence -and (Test-Path $Evidence) -and @(Get-ChildItem -Force $Evidence).Count) { Write-Host "REFUSED: -Evidence $Evidence is not empty"; exit 2 }
$ct = $PSScriptRoot
$dockerDir = Split-Path -Parent (Split-Path -Parent $ct)
$ob1 = Split-Path -Parent $dockerDir
$label = "ai-stack.harness.owner=$Id"
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$proj = "rda-deploy-$rand"
$root = Join-Path $env:TEMP "$proj-root"
$live = Join-Path $root 'OB1'
$liveDocker = Join-Path $live 'docker'
$work = Join-Path $env:TEMP "$proj-work"
$evStage = Join-Path $env:TEMP "$proj-evstage"
foreach ($d in @($root, $work, $evStage)) { New-Item -ItemType Directory -Force $d | Out-Null }
$labFile = Join-Path $work 'lab-compose.json'
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$script:fail = 0
$summary = [ordered]@{}
$stepLog = New-Object System.Collections.Generic.List[string]
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
$outcome = [ordered]@{}
function Check([bool]$ok, [string]$id, [string]$m) {
  # GREEN: every check must hold. RED: every check is recorded (INFO); the end asserts the round-1 defects showed.
  $outcome[$id] = $ok
  if ($Red) { Write-Host "  INFO  [$id] $(if ($ok) { 'holds' } else { 'BROKEN' }): $m"; return }
  if ($ok) { Pass "[$id] $m"; if (-not $summary.Contains($id)) { $summary[$id] = 'GREEN' } } else { Fail "[$id] $m"; $summary[$id] = 'FAIL' }
}
function Note([string]$m) { Write-Host "    $m"; $stepLog.Add($m) }
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $evStage $name), $text, (New-Object System.Text.UTF8Encoding $false)) }

# -- docker: the lab project only ----------------------------------------------------------------------------
function Run-Proc([int]$TimeoutSec, [string]$exe, [string[]]$a, [string]$stdin = $null) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = ($a | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
  if ($null -ne $stdin) { $psi.RedirectStandardInput = $true }
  $p = [System.Diagnostics.Process]::Start($psi)
  if ($null -ne $stdin) { $p.StandardInput.Write($stdin); $p.StandardInput.Close() }
  $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { try { $p.Kill() } catch { }; $script:rc = 124; return "TIMEOUT after ${TimeoutSec}s" }
  $p.WaitForExit(); $script:rc = $p.ExitCode
  return (($out.Result + $err.Result) -replace "`r", '').TrimEnd()
}
function Dk { $a = [string[]]$args
  $all = $a -join ' '
  if ($a[0] -eq 'compose') { Write-Host "  SHIM REFUSED: docker compose goes through LabCompose only"; $script:fail++; return '' }
  if ($all -match '(^|[\s=:/])(ai-stack_|open-brain)' -or $all -match ':local(\s|$)' -or $all -match '(^|\s)(-p|--publish)') { Write-Host "  SHIM REFUSED: docker $all"; $script:fail++; return '' }
  return Run-Proc 300 'docker' $a }
function LabCompose { $a = [string[]]$args
  if (-not (Test-Path $labFile)) { Write-Host '  SHIM REFUSED: no validated lab compose file'; $script:fail++; return '' }
  return Run-Proc 600 'docker' (@('compose', '-p', $proj, '-f', $labFile) + $a) }
function Render([string]$what) {
  # the live files of the lab directory, rendered as compose renders the live checkout, then made a lab project
  $raw = Join-Path $work "rendered-$what.json"
  $o = Run-Proc 300 'docker' @('compose', '--project-directory', $liveDocker, '-f', (Join-Path $liveDocker 'docker-compose.yml'), '--profile', 'wiki', 'config', '--format', 'json')
  if ($script:rc -ne 0) { Fail "render ($what) failed: $(($o -split "`n" | Select-Object -Last 3) -join ' ')"; return $false }
  $json = ($o -split "`n" | Where-Object { $_ -notmatch '^(time=|WARN|level=)' }) -join "`n"
  [System.IO.File]::WriteAllText($raw, $json, (New-Object System.Text.UTF8Encoding $false))
  $t = Run-Proc 120 'python' @('-I', (Join-Path $ct 'rest-door-deploy-compose.py'), $raw, $labFile, (Split-HarnessSubnet $Subnet).run, $Id, $NodeImage, $proj)
  Note "render ($what): $t"
  Remove-Item -Force $raw
  return ($script:rc -eq 0)
}
function Place([string]$sha, [string]$what) {
  # the files of $sha into the lab live directory, as a checkout writes them (the .env stays)
  $tar = Join-Path $work "$what.tar"
  & git -C $ob1 archive --format=tar -o $tar $sha docker integrations/intake/sql
  $tmp = Join-Path $work "tree-$what"
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  New-Item -ItemType Directory -Force $tmp | Out-Null
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $tar -C $tmp
  Remove-Item -Force $tar
  $envKeep = if (Test-Path (Join-Path $liveDocker '.env')) { [System.IO.File]::ReadAllText((Join-Path $liveDocker '.env')) } else { $null }
  New-Item -ItemType Directory -Force $live | Out-Null
  # /MIR: files the other commit does not have are gone, as after a checkout (the .env is put back below)
  & robocopy (Join-Path $tmp 'docker') $liveDocker /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  & robocopy (Join-Path $tmp 'integrations') (Join-Path $live 'integrations') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($null -ne $envKeep) { [System.IO.File]::WriteAllText((Join-Path $liveDocker '.env'), $envKeep, (New-Object System.Text.UTF8Encoding $false)) }
  Remove-Item -Recurse -Force $tmp
  $script:files = $what
}
function Snap {
  $h = @{}
  foreach ($l in ((Dk ps -a --filter "label=com.docker.compose.project=$proj" --format '{{.Label "com.docker.compose.service"}}|{{.ID}}|{{.Label "com.docker.compose.config-hash"}}|{{.State}}') -split "`n")) {
    $f = $l -split '\|'; if ($f.Count -ge 3 -and $f[0]) { $h[$f[0]] = @{ id = $f[1]; hash = $f[2]; state = $f[3] } }
  }
  return $h
}
function Recreated($before, $after) { @($after.Keys | Where-Object { -not $before.ContainsKey($_) -or $before[$_].id -ne $after[$_].id } | Sort-Object) }
function Ctr([string]$svc) { "$proj-$svc-1" }

# one request each caller really makes, from inside its container, with the token from its own environment
$callerReq = [ordered]@{
  'openbrain-wiki' = '/rest/v1/entities?select=id&limit=1'
  'openbrain-wiki-viewer' = '/rest/v1/wiki_pages?select=slug&limit=1'
  'openbrain-entity-worker' = '/rest/v1/entity_extraction_queue?select=thought_id&status=eq.pending&limit=1'
  'openbrain-digest' = '/rest/v1/thoughts?select=id&limit=1'
  'openbrain-podcast' = '/rest/v1/podcast_teams?select=id&limit=1'
  'openbrain-gmail-pull' = '/rest/v1/thoughts?select=id&limit=1'
  'openbrain-gmail-prune' = '/rest/v1/thoughts?select=id,metadata&metadata->>source=eq.gmail&limit=1'
}
$probeJs = @'
const t = (process.env.OPEN_BRAIN_REST_TOKEN || process.env.OPEN_BRAIN_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const base = (process.env.OPEN_BRAIN_URL || process.env.BRAIN_REST_URL || process.env.SUPABASE_URL || "http://openbrain-rest").replace(/\/+$/, "");
const h = { apikey: "local-trust" };
if (t) h.authorization = "Bearer " + t;
fetch(base + process.argv[1], { headers: h }).then(async (r) => { const b = await r.text(); console.log("CALLER " + r.status + " " + (r.ok ? "ok" : b.slice(0, 120).replace(/\s+/g, " "))); })
  .catch((e) => console.log("CALLER 0 " + e.message));
'@
[System.IO.File]::WriteAllText((Join-Path $work 'caller.js'), $probeJs, (New-Object System.Text.UTF8Encoding $false))
function Callers([string]$step) {
  $res = [ordered]@{}
  foreach ($svc in $callerReq.Keys) {
    $c = Ctr $svc
    $null = Dk cp (Join-Path $work 'caller.js') "${c}:/tmp/caller.js"
    $o = Dk exec $c node /tmp/caller.js $callerReq[$svc]
    $line = (($o -split "`n") | Where-Object { $_ -match '^CALLER ' } | Select-Object -Last 1)
    $res[$svc] = if ($line) { $line.Substring(7) } else { "no answer: $o" }
  }
  $bad = @($res.Keys | Where-Object { $res[$_] -notmatch '^2\d\d ok' })
  Note "$step callers: $((@($res.Keys | ForEach-Object { "$($_ -replace 'openbrain-','')=$(($res[$_] -split ' ')[0])" })) -join ' ')"
  foreach ($b in $bad) { Note "    $b -> $($res[$b])" }
  return $bad.Count -eq 0
}
function DoorCaddy {
  # which Caddyfile openbrain-rest SERVES (in memory): the new one answers a credential-less /rest/v1 request with
  # 401 'credentials required' itself; the old one proxies it (PostgREST then answers 200 as anon, or 401 without one)
  $c = Ctr 'openbrain-wiki-viewer'
  $o = Dk exec $c node -e "fetch('http://openbrain-rest/rest/v1/thoughts?limit=0').then(async r=>console.log('DOOR '+r.status+' '+(await r.text()).slice(0,40).replace(/\s+/g,' ')))"
  $line = (($o -split "`n") | Where-Object { $_ -match '^DOOR ' } | Select-Object -Last 1)
  if ($line -match '^DOOR 401 credentials required') { return 'new' } elseif ($line) { return "old ($($line.Substring(5)))" } else { return "unknown ($o)" }
}
function Psql-File([string]$path) {
  $db = Ctr 'openbrain-db'
  $null = Dk cp $path "${db}:/tmp/step.sql"
  return (Dk exec $db psql -X -v ON_ERROR_STOP=1 -U postgres -d openbrain -f /tmp/step.sql)
}
function Step([string]$name, [scriptblock]$do, [string[]]$expectRecreated, [string]$expectCaddy) {
  Write-Host "[$name]"
  $before = Snap
  & $do
  Start-Sleep -Seconds 3
  $after = Snap
  $rec = Recreated $before $after
  Note "$name recreated: [$($rec -join ', ')]$(if ($rec.Count) { ' hashes ' + (($rec | ForEach-Object { "$_ $($before[$_].hash.Substring(0, [Math]::Min(8, "$($before[$_].hash)".Length)))->$($after[$_].hash.Substring(0, 8))" }) -join ' ') })"
  $id = ($name -split ' ')[0]
  Check ((($rec -join ',') -eq (($expectRecreated | Sort-Object) -join ','))) "$id-recreated" "$name recreates exactly [$($expectRecreated -join ', ')] (got [$($rec -join ', ')])"
  Check (-not ($rec -contains 'openbrain-db')) "$id-db" "$name does not recreate openbrain-db"
  if ($expectCaddy) { $cad = DoorCaddy; Check ($cad -like "$expectCaddy*") "$id-caddy" "${name}: openbrain-rest serves the $expectCaddy Caddyfile ($cad)" }
  $ok = Callers $name
  Check $ok "$id-callers" "${name}: every caller works (7 callers, one real request each, its own token)"
}

$dbIdStart = $null
try {
  Write-Host "== rw-rest-door-auth deploy-path lab  project=$proj  red=$([bool]$Red)  base=$BaseSha  new=$NewSha"
  $newResolved = (& git -C $ob1 rev-parse $NewSha).Trim()
  # ------------------------------------------------------------ A. the pre-change stack
  Place $BaseSha 'base'
  [System.IO.File]::WriteAllText((Join-Path $liveDocker '.env'), "POSTGRES_PASSWORD=$pw`nWORKSPACE_DEFAULT_SUB=lab-operator`nMCP_ACCESS_KEY=lab-mcp-key-not-a-secret`n", (New-Object System.Text.UTF8Encoding $false))
  if (-not (Render 'base')) { throw 'render base' }
  Save 'lab-compose-base.json' ([System.IO.File]::ReadAllText($labFile))
  Write-Host '[A] the pre-change stack: up -d (everything, from the base files)'
  $o = LabCompose up -d
  Save 'A-up.log' $o
  if ($script:rc -ne 0) { throw "phase A up failed: $(($o -split "`n" | Select-Object -Last 5) -join ' | ')" }
  for ($i = 0; $i -lt 90; $i++) { if ((Dk logs (Ctr 'openbrain-db')) -match 'database system is ready to accept connections' -and (Dk logs (Ctr 'openbrain-db')) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  Start-Sleep -Seconds 5
  $null = Psql-File (Join-Path $ct 'rest-door-fixtures.sql')
  $s0 = Snap
  $dbIdStart = $s0['openbrain-db'].id
  Note "A containers: $(($s0.Keys | Sort-Object | ForEach-Object { "$_=$($s0[$_].id.Substring(0,12))" }) -join ' ')"
  $okA = Callers 'A'
  if ($okA) { Pass 'A: the pre-change stack serves every caller' } else { Fail 'A: the pre-change stack does not serve every caller' }
  # ------------------------------------------------------------ the merge: the checkout now holds the new files
  Place $newResolved 'new'
  Note "merge: the lab live directory now holds OB1 $($newResolved.Substring(0,7))'s files (containers unchanged)"
  $cad0 = DoorCaddy
  Note "after the merge, before any step: openbrain-rest serves the $cad0 Caddyfile"

  $callers = @($callerReq.Keys)
  # ------------------------------------------------------------ step 2: the secrets (the operator's command)
  Step 'S2 mint' { $script:mint = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $liveDocker 'rest-door/mint-rest-tokens.ps1') -EnvFile (Join-Path $liveDocker '.env') -Generate 2>&1 | Out-String; Note ("S2 mint: " + (($script:mint -split "`n" | Where-Object { $_ -match 'wrote|SKIP' } | ForEach-Object { $_.Trim() -replace ' -> .*', '' }) -join ', ')) } @() ''
  # ------------------------------------------------------------ step 3: slot 450 by psql + the authenticator password
  Step 'S3 slot450' {
    $o = Psql-File (Join-Path $liveDocker 'init-rest-door-auth.sql'); Save 'S3-450.log' $o; Note "S3 450 exit $($script:rc): $((($o -split "`n") | Where-Object { $_ -match 'NOTICE:  rest door' } | ForEach-Object { ($_ -split 'NOTICE:  ')[1] }) -join ' | ')"
    $m = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $liveDocker 'rest-door/mint-rest-tokens.ps1') -EnvFile (Join-Path $liveDocker '.env') -NoMint -SetAuthenticatorPassword -Container (Ctr 'openbrain-db') 2>&1 | Out-String
    Note "S3 password: $(($m -split "`n" | Where-Object { $_ -match 'set ob_rest' }) -join '')"
  } @() 'old'
  if (-not (Render 'new')) { throw 'render new' }
  Save 'lab-compose-new.json' ([System.IO.File]::ReadAllText($labFile))
  if ($Red) {
    # ROUND 1 as written: step 4 recreated the callers with a plain `up -d <svc>` (ob1-deploy), step 5 `up -d` the door
    Step 'S4 callers' { $o = LabCompose up -d @callers; Save 'S4-up.log' $o } $callers 'old'
    Step 'S5 door' { $o = LabCompose up -d openbrain-postgrest openbrain-rest; Save 'S5-up.log' $o } @('openbrain-postgrest', 'openbrain-rest') 'new'
  } else {
    # ------------------------------------------------------------ step 4: the callers (code + env), nothing else
    Step 'S4 callers' { $o = LabCompose up -d --no-deps --force-recreate @callers; Save 'S4-up.log' $o } $callers 'old'
    # ------------------------------------------------------------ step 5: the door, with the continuous callers stopped
    Step 'S5 door' {
      $o = LabCompose stop openbrain-wiki openbrain-wiki-viewer openbrain-entity-worker; Save 'S5-stop.log' $o
      $o = LabCompose up -d --no-deps --force-recreate openbrain-postgrest openbrain-rest; Save 'S5-up.log' $o
      Start-Sleep -Seconds 4
      $o = LabCompose start openbrain-wiki openbrain-wiki-viewer openbrain-entity-worker; Save 'S5-start.log' $o
    } @('openbrain-postgrest', 'openbrain-rest') 'new'
  }
  # ------------------------------------------------------------ step 7: the revert, door first, then SQL, then the callers
  # the revert file is in the NEW commit only: taken out before the checkout goes back (the plan's step 7, first line)
  Copy-Item (Join-Path $liveDocker 'revert-rest-door-auth.sql') (Join-Path $work 'revert-rest-door-auth.sql')
  Place $BaseSha 'base'
  if (-not (Render 'revert')) { throw 'render revert' }
  if ($Red) {
    Step 'S7a door-back' { $o = LabCompose up -d openbrain-postgrest openbrain-rest; Save 'S7a-up.log' $o } @('openbrain-postgrest', 'openbrain-rest') 'old'
  } else {
    Step 'S7a door-back' { $o = LabCompose up -d --no-deps --force-recreate openbrain-postgrest openbrain-rest; Save 'S7a-up.log' $o } @('openbrain-postgrest', 'openbrain-rest') 'old'
    Step 'S7b sql-back' { $o = Psql-File (Join-Path $work 'revert-rest-door-auth.sql'); Save 'S7b-revert.log' $o; Note "S7b revert exit $($script:rc): $((($o -split "`n") | Where-Object { $_ -match 'NOTICE:  rest door' } | ForEach-Object { ($_ -split 'NOTICE:  ')[1] }) -join ' | ')" } @() 'old'
    Step 'S7c callers-back' { $o = LabCompose up -d --no-deps --force-recreate @callers; Save 'S7c-up.log' $o } $callers 'old'
  }
  $sEnd = Snap
  Check ($sEnd['openbrain-db'].id -eq $dbIdStart) 'db-never' "openbrain-db is the same container from the pre-change stack to the end ($($dbIdStart.Substring(0,12)) -> $("$($sEnd['openbrain-db'].id)".Substring(0,12)))"
  if ($Red) {
    # the round-1 commands: step 4 converges dependencies (openbrain-db recreated, PostgREST switched early), step 5
    # leaves Caddy on its old in-memory Caddyfile, so the callers are refused from step 4 / step 5 on
    foreach ($req in @(@('S4-db', 'step 4 recreates openbrain-db (an unplanned database restart)'),
                       @('S4-callers', 'step 4 takes the callers down (PostgREST switched early behind the old Caddy)'),
                       @('S5-caddy', 'step 5 leaves openbrain-rest on the old Caddyfile'),
                       @('S5-callers', 'every caller is refused after step 5'))) {
      if ($outcome.Contains($req[0]) -and -not $outcome[$req[0]]) { Write-Host "  RED-OK  [$($req[0])] $($req[1])"; $summary[$req[0]] = 'RED' }
      else { Write-Host "  RED-UNEXPECTED-PASS  [$($req[0])] $($req[1]) - not shown"; $script:fail++; $summary[$req[0]] = 'UNEXPECTED-PASS' }
    }
  }
}
catch { Fail "lab aborted: $($_.Exception.Message)" }
finally {
  Write-Host '[teardown]'
  if (-not $Keep) {
    if (Test-Path $labFile) { $null = LabCompose down -v --remove-orphans }
    foreach ($c in @((Dk ps -aq --filter "label=$label" --filter "label=com.docker.compose.project=$proj") -split "`n" | Where-Object { $_ })) { $null = Dk rm -f -v $c }
  }
  $leftC = (Dk ps -a --filter "label=com.docker.compose.project=$proj" --format '{{.Names}}' | Out-String).Trim()
  $leftN = (Dk network ls --filter "label=com.docker.compose.project=$proj" --format '{{.Name}}' | Out-String).Trim()
  $leftV = (Dk volume ls --filter "label=com.docker.compose.project=$proj" --format '{{.Name}}' | Out-String).Trim()
  if (-not $Keep) { if (-not $leftC -and -not $leftN -and -not $leftV) { Pass "nothing of $proj is left" } else { Fail "left: containers '$leftC' networks '$leftN' volumes '$leftV'" } }
  Save 'steps.txt' ($stepLog -join "`n")
  $sumLine = (($summary.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ')
  Save 'summary.txt' "mode=$(if ($Red) { 'RED' } else { 'GREEN' }) base=$BaseSha new=$NewSha fail=$($script:fail)`n$sumLine"
  New-Item -ItemType Directory -Force $Evidence | Out-Null
  if ($Evidence) { Copy-Item -Recurse -Force (Join-Path $evStage '*') $Evidence }
  if (-not $Keep) { foreach ($d in @($root, $work, $evStage)) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } } }
  Write-Host "SUMMARY $sumLine"
  if ($script:fail) { Write-Host "LAB FAILED ($($script:fail))"; exit 1 } else { Write-Host 'LAB OK'; exit 0 }
}
