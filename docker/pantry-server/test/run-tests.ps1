# run-tests.ps1 - self-contained test run for openbrain-pantry (item pantry-core).
#
#   powershell -NoProfile -File OB1\docker\pantry-server\test\run-tests.ps1 [-Id <owner id>]
#
# What it does, and ONLY this:
#   1. static checks on init-pantry.sql and the OB1 diff (no upstream file edited)
#   2. creates ONE internal docker network + TWO containers (a throwaway pgvector/pgvector:pg16
#      and the test runner), every one labelled ai-stack.harness.owner=<Id>
#   3. applies OB1 init.sql + init-extensions.sql, then init-pantry.sql three times
#   4. builds the image as openbrain-pantry:wt-<Id> (NEVER a :local tag)
#   5. runs the Deno suite in a container on that private network
#   6. compose render checks (docker compose config only - nothing is started)
#   7. tears down exactly what it created, then verifies nothing labelled <Id> is left and no
#      :local image changed.
# It never touches the live stack: no compose up/down, no prune, no ai-stack_* / open-brain_*
# network, no host port, no docker rm/rmi of anything it did not create.
# Exit code 0 = every check passed.
param(
  [string]$Id = 'wt-pantry-core',                 # owner id (a tester passes their own worktree id)
  [string]$BaseSha = '6631001',                   # OB1 pin the item branched from (upstream diff base)
  [string]$DenoImage = '',                        # base image for the build; default: a LOCAL deno image
  [string]$PgImage = 'pgvector/pgvector:pg16'     # must already be on the host; never pulled here
)
$ErrorActionPreference = 'Continue'
$label = "ai-stack.harness.owner=$Id"
$server = Split-Path -Parent $PSScriptRoot                  # .../OB1/docker/pantry-server
$dockerDir = Split-Path -Parent $server                     # .../OB1/docker
$ob1 = Split-Path -Parent $dockerDir                        # .../OB1
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "pantry-test-net-$Id-$rand"
$dbName = "pantry-test-db-$Id-$rand"
$runName = "pantry-test-run-$Id-$rand"
$tag = "openbrain-pantry:wt-" + ($Id -replace "^wt-", "")
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$pantryPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })

$script:fail = 0
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }

if ($tag -match ':local$') { throw 'refusing to build a :local tag' }
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }

Write-Host "== pantry-core test run  owner=$Id  net=$net"
$null = Dk version --format '{{.Server.Version}}'
if ($script:rc -ne 0) { Write-Host 'docker is not reachable'; exit 2 }

# snapshot of every :local image (id) - must be identical at the end
function LocalSnapshot { (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim() -split "`r?`n" | Sort-Object }
$localBefore = LocalSnapshot

$made = @{ net = $false; db = $false; run = $false; image = $false }
try {
  # ---------------------------------------------------------------- 1. static checks
  Write-Host '[1] static checks'
  $sql = Get-Content -Raw (Join-Path $dockerDir 'init-pantry.sql')
  $alters = [regex]::Matches($sql, '(?im)^\s*ALTER\s+TABLE\s+(\S+)([^;]*);')
  $badAlter = @($alters | Where-Object {
      $_.Groups[1].Value -notin @('recipes', 'meal_plans') -or $_.Groups[2].Value -notmatch '(?i)ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS'
    })
  Check ($alters.Count -ge 5 -and $badAlter.Count -eq 0) "ALTER TABLE appears only as ADD COLUMN IF NOT EXISTS on recipes/meal_plans ($($alters.Count) statements)"
  $badCreate = [regex]::Matches($sql, '(?im)^\s*CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)\s+(?!IF\s+NOT\s+EXISTS)')
  Check ($badCreate.Count -eq 0) 'every CREATE TABLE/INDEX is IF NOT EXISTS'
  Check ($sql -notmatch '(?im)^\s*(DROP|TRUNCATE|DELETE)\s') 'init-pantry.sql has no DROP/TRUNCATE/DELETE'
  $protected = @('docker/init-extensions.sql', 'extensions/meal-planning', 'docker/extensions-server')
  $d1 = (& git -C $ob1 diff --name-only $BaseSha HEAD -- @protected 2>&1 | Out-String).Trim()
  $d2 = (& git -C $ob1 status --porcelain -- @protected 2>&1 | Out-String).Trim()
  Check (($d1 -eq '') -and ($d2 -eq '')) "no upstream-owned path changed since $BaseSha (init-extensions.sql, extensions/meal-planning, extensions-server)"
  $ns = (& git -C $ob1 diff --name-status $BaseSha HEAD 2>&1 | Out-String).Trim() -split "`r?`n" | Where-Object { $_ }
  $modified = @($ns | Where-Object { $_ -match '^[MDRT]' } | ForEach-Object { ($_ -split "\s+")[1] })
  $okMod = @($modified | Where-Object { $_ -notin @('docker/docker-compose.yml', 'docker/.env.example') })
  Check ($okMod.Count -eq 0) "the only pre-existing files touched are docker-compose.yml and .env.example (others: $($okMod -join ','))"

  # ---------------------------------------------------------------- 2. network + postgres
  Write-Host '[2] disposable network + postgres'
  $null = Dk network create --internal --label $label $net
  Check ($script:rc -eq 0) "network $net created (internal, labelled)"
  if ($script:rc -ne 0) { throw 'network' }
  $made.net = $true
  $null = Dk image inspect $PgImage
  if ($script:rc -ne 0) { Fail "$PgImage is not on the host (not pulling)"; throw 'pg image' }
  $null = Dk run -d --name $dbName --label $label --network $net -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=openbrain $PgImage
  Check ($script:rc -eq 0) "postgres container $dbName started"
  if ($script:rc -ne 0) { throw 'pg' }
  $made.db = $true
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    $null = Dk exec $dbName pg_isready -h 127.0.0.1 -U postgres -d openbrain
    if ($script:rc -eq 0) { Start-Sleep -Seconds 2; $null = Dk exec $dbName pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { $ready = $true; break } }
    Start-Sleep -Seconds 2
  }
  Check $ready 'postgres is accepting TCP connections'
  if (-not $ready) { throw 'pg not ready' }

  function Psql([string[]]$more) { Dk exec $dbName psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 @more }
  foreach ($f in 'init.sql', 'init-extensions.sql', 'init-pantry.sql') {
    $null = Dk cp (Join-Path $dockerDir $f) "${dbName}:/tmp/$f"
  }
  foreach ($f in 'init.sql', 'init-extensions.sql') {
    $o = Psql @('-f', "/tmp/$f")
    Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) "upstream $f applied"
    if (($script:rc -ne 0) -or ($o -cmatch 'ERROR:')) { Write-Host ($o -replace $pantryPw, '***') }
  }
  $polBefore = $null
  $runs = @(@('-v', "pantry_db_password=$pantryPw"), @(), @('-v', "pantry_db_password=$pantryPw"))
  for ($n = 0; $n -lt $runs.Count; $n++) {
    $o = Psql ($runs[$n] + @('-f', '/tmp/init-pantry.sql'))
    Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) "init-pantry.sql run $($n + 1) of 3 clean"
    if (($script:rc -ne 0) -or ($o -cmatch 'ERROR:')) { Write-Host ($o -replace $pantryPw, '***') }
    $snap = (Psql @('-tA', '-c', "SELECT (SELECT count(*) FROM pg_policies) || '/' || (SELECT count(*) FROM information_schema.columns WHERE table_schema='public') || '/' || (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace)")).Trim()
    if ($n -eq 0) { $polBefore = $snap } else { Check ($snap -eq $polBefore) "catalogue unchanged after run $($n + 1) (policies/columns/relations $snap)" }
  }

  # ---------------------------------------------------------------- 3. image
  Write-Host "[3] build $tag"
  if (-not $DenoImage) {
    $null = Dk image inspect denoland/deno:2.3.3
    if ($script:rc -eq 0) { $DenoImage = 'denoland/deno:2.3.3' }
    else {
      $null = Dk image inspect denoland/deno:alpine
      if ($script:rc -eq 0) { $DenoImage = 'denoland/deno:alpine' }
    }
  }
  if (-not $DenoImage) { Fail 'no local deno base image (pass -DenoImage)'; throw 'no deno' }
  Write-Host "      base image: $DenoImage"
  $o = Dk build --progress=plain -t $tag --label $label --build-arg "DENO_IMAGE=$DenoImage" $server
  Check ($script:rc -eq 0) "image $tag built"
  if ($script:rc -ne 0) { Write-Host (($o -split "`r?`n" | Select-Object -Last 25) -join "`n"); throw 'build' }
  $made.image = $true

  # ---------------------------------------------------------------- 4. the Deno suite
  Write-Host '[4] deno test (in a container on the private network)'
  $null = Dk create --name $runName --label $label --network $net `
    -e "DB_HOST=$dbName" -e DB_PORT=5432 -e DB_NAME=openbrain -e DB_USER=ob_pantry -e "DB_PASSWORD=$pantryPw" `
    -e ADMIN_DB_USER=postgres -e "ADMIN_DB_PASSWORD=$pw" -e TZ=UTC `
    $tag deno test --allow-net --allow-env --allow-read --no-prompt /app/test
  Check ($script:rc -eq 0) "test container $runName created"
  if ($script:rc -ne 0) { throw 'create' }
  $made.run = $true
  $null = Dk cp (Join-Path $server 'test') "${runName}:/app/test"
  $out = Dk start -a $runName
  $code = (Dk inspect -f '{{.State.ExitCode}}' $runName).Trim()
  $out = $out -replace [regex]::Escape($pw), '***' -replace [regex]::Escape($pantryPw), '***'
  Write-Host ((($out -split "`r?`n") | Where-Object { $_ -match '^(running|test |ok |FAILED|ERRORS|FAILURES|\s+at |error:)|\.\.\. (ok|FAILED)|passed|failed' }) -join "`n")
  Check ($code -eq '0') "deno test exit code $code"
  if ($code -ne '0') { Write-Host $out }

  # ---------------------------------------------------------------- 5. compose render
  Write-Host '[5] docker compose config (render only, nothing started)'
  $compose = Join-Path $dockerDir 'docker-compose.yml'
  $env:PANTRY_API_KEY = 'render-only'; $env:PANTRY_DB_PASSWORD = 'render-only'
  $svcDefault = (Dk compose -f $compose config --services)
  Check (($script:rc -eq 0) -and ($svcDefault -notmatch '(?m)^openbrain-pantry\s*$')) 'default profile set: openbrain-pantry is NOT in the service list'
  $svcPantry = (Dk compose -f $compose --profile pantry config --services)
  Check (($script:rc -eq 0) -and ($svcPantry -match '(?m)^openbrain-pantry\s*$')) '--profile pantry: openbrain-pantry IS in the service list'
  $json = (& docker compose -f $compose --profile pantry config --format json 2>$null | Out-String)
  $svc = $null
  try { $svc = ($json | ConvertFrom-Json).services.'openbrain-pantry' } catch { }
  $json = $null
  Check ($null -ne $svc) 'rendered service parsed (secrets not printed)'
  if ($svc) {
    $nets = @($svc.networks.PSObject.Properties.Name | Sort-Object)
    Check (($nets -join ',') -eq 'llm-net,obnet') "networks are exactly obnet + llm-net ($($nets -join ','))"
    Check ($null -eq $svc.ports -or @($svc.ports).Count -eq 0) 'no published host port'
    Check ($svc.image -eq 'openbrain-pantry:local') "image is openbrain-pantry:local (declared, not built here)"
    Check (@($svc.profiles) -contains 'pantry' -and @($svc.profiles).Count -eq 1) 'profiles == [pantry]'
    Check ($svc.depends_on.'openbrain-db'.condition -eq 'service_healthy') 'depends_on openbrain-db service_healthy'
    Check ($svc.restart -eq 'unless-stopped') 'restart unless-stopped'
    Check ($null -ne $svc.healthcheck) 'healthcheck present'
    Check ($svc.environment.DB_USER -eq 'ob_pantry') 'DB_USER is ob_pantry (not postgres)'
    Check ($svc.build.context -like '*pantry-server') 'build context is ./pantry-server'
  }
  Remove-Item Env:PANTRY_API_KEY, Env:PANTRY_DB_PASSWORD -ErrorAction SilentlyContinue
  $mounts = Select-String -Path $compose -Pattern 'init-pantry\.sql:/docker-entrypoint-initdb\.d/(\d+)-init-pantry\.sql' | ForEach-Object { $_.Matches[0].Groups[1].Value }
  $slots = Select-String -Path $compose -Pattern 'docker-entrypoint-initdb\.d/(\d+)-' | ForEach-Object { $_.Matches[0].Groups[1].Value }
  Check (@($mounts).Count -eq 1 -and @($slots | Where-Object { $_ -eq $mounts }).Count -eq 1) "init-pantry.sql is mounted once, at a unique initdb slot ($mounts)"
}
catch {
  if ("$_" -notin @('network', 'pg', 'pg image', 'pg not ready', 'build', 'no deno', 'create')) { Fail "unexpected error: $_" }
}
finally {
  Write-Host '[6] teardown (only what this run created)'
  if ($made.run) { $null = Dk rm -f $runName }
  if ($made.db) { $null = Dk rm -f $dbName }
  if ($made.net) { $null = Dk network rm $net }
  if ($made.image) { $null = Dk rmi $tag }
  $left = (Dk ps -a -q --filter "label=$label").Trim()
  Check ($left -eq '') "no container labelled $label is left"
  $leftNet = (Dk network ls -q --filter "label=$label").Trim()
  Check ($leftNet -eq '') "no network labelled $label is left"
  $localAfter = LocalSnapshot
  Check ((($localBefore -join '|') -eq ($localAfter -join '|'))) 'no :local image was created or changed'
}
Write-Host ''
if ($script:fail -eq 0) { Write-Host 'RESULT: PASS (all checks green)'; exit 0 }
Write-Host "RESULT: FAIL ($($script:fail) check(s) failed)"
exit 1
