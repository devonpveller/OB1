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
  # pantry-hardening: ONE deliberate addition - pantry_exposures.seq (the insertion-order identity column).
  # pantry-cook-confirm: TWO more - pantry_items.pack_size / pack_unit (nullable, no default: existing rows stay NULL).
  $badAlter = @($alters | Where-Object {
      $_.Groups[2].Value -notmatch '(?i)ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS' -or
      -not ($_.Groups[1].Value -in @('recipes', 'meal_plans') -or
            ($_.Groups[1].Value -eq 'pantry_exposures' -and $_.Groups[2].Value -match '(?i)ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+seq\s+bigint\s+GENERATED\s+ALWAYS\s+AS\s+IDENTITY\s*$') -or
            # pantry-cook-confirm: exactly the two optional package-size columns, nothing else on pantry_items.
            ($_.Groups[1].Value -eq 'pantry_items' -and $_.Groups[2].Value -match '(?i)^\s*ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(pack_size\s+NUMERIC|pack_unit\s+TEXT)\s*$'))
    })
  Check ($alters.Count -ge 5 -and $badAlter.Count -eq 0) "ALTER TABLE appears only as ADD COLUMN IF NOT EXISTS on recipes/meal_plans, plus pantry_exposures.seq and pantry_items.pack_size/pack_unit ($($alters.Count) statements)"
  Check ((@($alters | Where-Object { $_.Groups[1].Value -eq 'pantry_exposures' }).Count) -eq 1) 'exactly one ALTER on pantry_exposures'
  Check ((@($alters | Where-Object { $_.Groups[1].Value -eq 'pantry_items' }).Count) -eq 2) 'exactly two ALTERs on pantry_items (pack_size, pack_unit)'
  Check (($sql -match '(?im)^\s*CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+ux_pantry_evaluations_cook_who') -and ($sql -match '(?im)^\s*CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+ux_pantry_hypotheses_user_stmt')) 'both hardening unique indexes are idempotent CREATE UNIQUE INDEX IF NOT EXISTS'
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

  # ---------------------------------------------------------------- 2b. upgrade path (pantry-hardening)
  # A DB built at 0c9976a's init-pantry.sql WITH data, then the new init-pantry.sql applied twice.
  Write-Host '[2b] upgrade from the 0c9976a schema with data; seeded duplicates fail loudly'
  $null = Dk cp (Join-Path $server 'test/fixtures/init-pantry.0c9976a.sql') "${dbName}:/tmp/init-pantry.old.sql"
  $null = Dk cp (Join-Path $server 'test/fixtures/init-pantry.fc23cb3.sql') "${dbName}:/tmp/init-pantry.fc23.sql"
  function PsqlDb([string]$db, [string[]]$more) { Dk exec $dbName psql -U postgres -d $db -X -q -v ON_ERROR_STOP=1 @more }
  function Counts([string]$db) {
    (PsqlDb $db @('-tA', '-c', "SELECT (SELECT count(*) FROM pantry_items)||'/'||(SELECT count(*) FROM recipes)||'/'||(SELECT count(*) FROM pantry_cook_events)||'/'||(SELECT count(*) FROM pantry_evaluations)||'/'||(SELECT count(*) FROM pantry_taste_hypotheses)||'/'||(SELECT count(*) FROM pantry_exposures)")).Trim()
  }
  function OldDb([string]$db, [string]$fixture = '/tmp/init-pantry.old.sql') {
    $o = PsqlDb 'postgres' @('-c', "CREATE DATABASE $db")
    $ok = ($script:rc -eq 0)
    foreach ($f in 'init.sql', 'init-extensions.sql') { $o = PsqlDb $db @('-f', "/tmp/$f"); if ($script:rc -ne 0) { $ok = $false } }
    $o = PsqlDb $db @('-v', "pantry_db_password=$pantryPw", '-f', $fixture); if ($script:rc -ne 0) { $ok = $false }
    $u = "'11111111-1111-1111-1111-111111111111'"
    $cook = "'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'"
    $rec = "'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'"
    $seed = @(
      "INSERT INTO pantry_items (user_id, name, quantity, unit) VALUES ($u,'Rice',500,'g'),($u,'Beans',300,'g'),($u,'Salt',0,NULL)",
      "INSERT INTO recipes (id, user_id, name) VALUES ($rec,$u,'Rice')",
      "INSERT INTO pantry_cook_events (id, user_id, recipe_id, servings) VALUES ($cook,$u,$rec,4)",
      "INSERT INTO pantry_evaluations (user_id, cook_event_id, who) VALUES ($u,$cook,'adult'),($u,$cook,'child')",
      "INSERT INTO pantry_taste_hypotheses (user_id, statement) VALUES ($u,'likes wok'),($u,'likes soup')",
      "INSERT INTO pantry_exposures (user_id, subject, reaction) VALUES ($u,'a','liked'),($u,'b','refused'),($u,'c','tolerated')"
    ) -join '; '
    $o = PsqlDb $db @('-c', $seed); if ($script:rc -ne 0) { $ok = $false; Write-Host $o }
    return $ok
  }
  $okOld = OldDb 'hard_old'
  Check $okOld 'database hard_old built at the 0c9976a schema and seeded (3 items, 1 recipe, 2 evals, 2 hypotheses, 3 exposures)'
  if ($okOld) {
    $c0 = Counts 'hard_old'
    Check ($c0 -eq '3/1/1/2/2/3') "seeded counts as expected ($c0)"
    for ($n = 1; $n -le 2; $n++) {
      $args2 = @('-f', '/tmp/init-pantry.sql')
      if ($n -eq 1) { $args2 = @('-v', "pantry_db_password=$pantryPw") + $args2 }
      $o = PsqlDb 'hard_old' $args2
      Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) "new init-pantry.sql applied to the data-bearing 0c9976a DB, run $n of 2, clean"
      if ($script:rc -ne 0) { Write-Host ($o -replace $pantryPw, '***') }
      Check ((Counts 'hard_old') -eq $c0) "row counts unchanged after upgrade run $n ($c0)"
    }
    $idx = (PsqlDb 'hard_old' @('-tA', '-c', "SELECT count(*) FROM pg_indexes WHERE indexname IN ('ux_pantry_evaluations_cook_who','ux_pantry_hypotheses_user_stmt')")).Trim()
    Check ($idx -eq '2') 'both unique indexes exist after the upgrade'
    $sq = (PsqlDb 'hard_old' @('-tA', '-c', "SELECT count(*)||'/'||count(DISTINCT seq)||'/'||count(seq) FROM pantry_exposures")).Trim()
    Check ($sq -eq '3/3/3') "existing exposures were numbered by the new seq column (rows/distinct/non-null $sq)"
    $gr = (PsqlDb 'hard_old' @('-tA', '-c', "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='ob_pantry' AND table_name !~ '^pantry_' AND table_name NOT IN ('recipes','meal_plans','shopping_lists')")).Trim()
    Check ($gr -eq '0') 'ob_pantry still holds nothing beyond pantry_* + recipes/meal_plans/shopping_lists after the upgrade'
  }
  # pantry-cook-confirm: the same upgrade from the fc23cb3 schema (the pin the item branched from), with data.
  Write-Host '[2b-pack] upgrade from the fc23cb3 schema with data: pack columns added, every row unchanged, twice'
  function ItemHash([string]$db) { (PsqlDb $db @('-tA', '-c', "SELECT md5(string_agg(name||'|'||kind||'|'||quantity::text||'|'||coalesce(unit,'')||'|'||coalesce(level,''), ';' ORDER BY name)) FROM pantry_items")).Trim() }
  $okFc = OldDb 'pack_old' '/tmp/init-pantry.fc23.sql'
  Check $okFc 'database pack_old built at the fc23cb3 schema and seeded'
  if ($okFc) {
    $pre = (PsqlDb 'pack_old' @('-tA', '-c', "SELECT count(*) FROM information_schema.columns WHERE table_name='pantry_items' AND column_name IN ('pack_size','pack_unit')")).Trim()
    Check ($pre -eq '0') 'the fc23cb3 schema has no pack columns (so the fixture really is the old one)'
    $cF = Counts 'pack_old'; $hF = ItemHash 'pack_old'
    Check ($cF -eq '3/1/1/2/2/3') "seeded counts as expected ($cF)"
    for ($n = 1; $n -le 2; $n++) {
      $a3 = @('-f', '/tmp/init-pantry.sql'); if ($n -eq 1) { $a3 = @('-v', "pantry_db_password=$pantryPw") + $a3 }
      $o = PsqlDb 'pack_old' $a3
      Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) "new init-pantry.sql applied to the data-bearing fc23cb3 DB, run $n of 2, clean"
      if ($script:rc -ne 0) { Write-Host ($o -replace $pantryPw, '***') }
      Check ((Counts 'pack_old') -eq $cF) "row counts unchanged after fc23cb3 upgrade run $n ($cF)"
      Check ((ItemHash 'pack_old') -eq $hF) "pantry_items rows byte-identical after fc23cb3 upgrade run $n"
    }
    $pc = (PsqlDb 'pack_old' @('-tA', '-c', "SELECT string_agg(column_name||':'||data_type, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_name='pantry_items' AND column_name IN ('pack_size','pack_unit')")).Trim()
    Check ($pc -eq 'pack_size:numeric,pack_unit:text') "pack_size numeric + pack_unit text exist after the upgrade ($pc)"
    $nn = (PsqlDb 'pack_old' @('-tA', '-c', "SELECT count(*) FROM pantry_items WHERE pack_size IS NOT NULL OR pack_unit IS NOT NULL")).Trim()
    Check ($nn -eq '0') 'every existing row has NULL pack columns (old behaviour)'
    $vw = (PsqlDb 'pack_old' @('-tA', '-c', "SELECT count(*) FROM pantry_available")).Trim()
    Check ($vw -eq '3') 'pantry_available (re-created view) still reads all 3 items'
    # the apply-ONLY-the-new-block recipe used by the LANDING: the marked block alone, as ONE transaction, on a second fc23cb3 DB
    $okB = OldDb 'pack_blk' '/tmp/init-pantry.fc23.sql'
    $lines = (Get-Content (Join-Path $dockerDir 'init-pantry.sql'))
    $bs = ($lines | Select-String -SimpleMatch '-- ---- pantry-cook-confirm' | Select-Object -First 1).LineNumber - 1
    $be = ($lines | Select-String -SimpleMatch 'WHERE i.removed_at IS NULL;' | Select-Object -Last 1).LineNumber - 1
    $blk = Join-Path ([IO.Path]::GetTempPath()) "pack-block-$rand.sql"
    [IO.File]::WriteAllText($blk, (($lines[$bs..$be]) -join "`n") + "`n")
    $null = Dk cp $blk "${dbName}:/tmp/pack-block.sql"
    Remove-Item $blk -ErrorAction SilentlyContinue
    $cB = Counts 'pack_blk'
    foreach ($n in 1, 2) {
      $o = PsqlDb 'pack_blk' @('-1', '-f', '/tmp/pack-block.sql')
      Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) "the marked pantry-cook-confirm block alone applies to an fc23cb3 DB in one transaction, run $n of 2"
    }
    $pc2 = (PsqlDb 'pack_blk' @('-tA', '-c', "SELECT count(*) FROM information_schema.columns WHERE table_name='pantry_items' AND column_name IN ('pack_size','pack_unit')")).Trim()
    Check ($okB -and $pc2 -eq '2' -and (Counts 'pack_blk') -eq $cB) 'block-only apply: both columns present, row counts unchanged'
  }
  $u0 = "'11111111-1111-1111-1111-111111111111'"
  foreach ($case in @(
      @{ db = 'hard_dupe'; table = 'pantry_evaluations'; sql = "INSERT INTO pantry_evaluations (user_id, cook_event_id, who) VALUES ($u0,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','adult')"; idx = 'ux_pantry_evaluations_cook_who' },
      @{ db = 'hard_duph'; table = 'pantry_taste_hypotheses'; sql = "INSERT INTO pantry_taste_hypotheses (user_id, statement) VALUES ($u0,'LIKES WOK')"; idx = 'ux_pantry_hypotheses_user_stmt' })) {
    $okD = OldDb $case.db
    $o = PsqlDb $case.db @('-c', $case.sql)
    Check ($okD -and ($script:rc -eq 0)) "database $($case.db): 0c9976a schema with a seeded duplicate in $($case.table)"
    $cb = Counts $case.db
    $o = PsqlDb $case.db @('-v', "pantry_db_password=$pantryPw", '-f', '/tmp/init-pantry.sql')
    Check (($script:rc -ne 0) -and ($o -match $case.table) -and ($o -match 'duplicate')) "init-pantry.sql FAILS LOUDLY on the seeded duplicate, naming $($case.table)"
    if (($script:rc -eq 0) -or ($o -notmatch $case.table)) { Write-Host ($o -replace $pantryPw, '***') }
    Check ((Counts $case.db) -eq $cb) "no row was deleted or changed in $($case.db) ($cb)"
    $ix = (PsqlDb $case.db @('-tA', '-c', "SELECT count(*) FROM pg_indexes WHERE indexname = '$($case.idx)'")).Trim()
    Check ($ix -eq '0') "the blocked unique index was not created ($($case.idx))"
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
