# run-boundary-e2e.ps1 - rw-boundary-core's disposable lab (plan 09 PD0a: the request boundary).
#
#   powershell -NoProfile -File OB1\integrations\research-service\run-boundary-e2e.ps1 [-Id <owner id>] [-Evidence <dir>] [-Subnet <x.y.z.0/24>]
#
# What it does, and ONLY this:
#   1. stages the REAL initdb chain from OB1/docker/docker-compose.yml (420-init-request-boundary.sql included)
#   2. creates ONE internal bridge network (--internal, a /24 outside 192.168.0.0/16); every container and the
#      network are labelled ai-stack.harness.owner=<Id>
#   3. builds the research service's test stage as openbrain-research-test:wt-<id> (NEVER :local) - the build RUNS
#      the offline suite: the gate's unit tests (boundary-gate.test.ts), formDerivedRequest with the honest / hostile /
#      empty proposers (boundary.test.ts) and R7 (boundary-r7.test.ts) among them
#   4. one database (the chain only; ob_app_memory created as production has it: non-superuser, in service_role),
#      then boundary.e2e.test.ts in the test image: the guard, the report-owner rule, the hand-back, and THE DOOR over
#      HTTP - the REAL index.ts against the database, a stub gateway on the LiteLLM alias with a HOSTILE proposer,
#      a stub search gate, stub public pages in their own container (network aliases news.example.org /
#      blog.example.org; round 2, TF6: the lab network is a DOCUMENTATION range - 203.0.113.0/24, else 198.51.100.0/24 -
#      so those names resolve to an address the boundary's resolver judges public, while the network stays --internal)
#      and a stub curator; then the second user's reads and THE SWEEP
#   4b. round 2: the tester's COPY probes (as ob_app_memory and as the superuser) and TF2 through a REAL PostgREST
#      configured as compose (anon = service_role, no token): every slot-420 function and table refused
#   5. the slot-420 drill by psql: revert, revert again, init, init again, revert, revert again, init - md5 of every
#      row of the touched tables (research_jobs, research_prompts) and the rule's definition compared to slot 390's
#      text; plus the lock_timeout probe (a held research_jobs lock stops init after ~10s, nothing applied)
#   6. a static check: no file outside the boundary's own names research_handbacks (no shared reader can join it)
#   7. tears down exactly what it created and verifies nothing labelled <Id> is left, no volume of ours is left and
#      no :local image changed
# Synthetic data only. It never touches the live stack: no compose up/down, no ai-stack_* / open-brain_* network, no
# host port, no live database, no LiteLLM (the gateway is a stub on 127.0.0.1 inside the test container).
# Exit code 0 = every check passed.
param(
  [string]$Id = 'wt-rw-boundary-core',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Evidence = '',
  [string]$Subnet = '',
  [string]$SubnetBase = '10.246',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
  [switch]$KeepImage
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$label = "ai-stack.harness.owner=$Id"
$rs = $PSScriptRoot
$ob1 = Split-Path -Parent (Split-Path -Parent $rs)
$dockerDir = Join-Path $ob1 'docker'
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rwbnd-net-$rand"
$db = "rwbnd-db-$rand"
$short = ($Id -replace '^wt-', '')
$testTag = "openbrain-research-test:wt-$short"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "rwbnd-evidence-$rand" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "rwbnd-initdb-$rand"

$script:fail = 0
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }
function Save([string]$name, [string]$text) {
  [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false))
}
function Summary([string]$text) {
  return ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed(?: \| (\d+) ignored)?').Match(($text -replace '\x1b\[[0-9;]*m', ''))
}
function Test-SubnetAllowed([string]$s) {
  if ($s -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/(\d{1,2})$') { return $false }
  $o = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4]); $len = [int]$Matches[5]
  if (@($o | Where-Object { $_ -gt 255 }).Count -gt 0) { return $false }
  if ($len -ne 24) { return $false }
  if ($o[0] -eq 192 -and $o[1] -eq 168) { return $false }
  if ($o[0] -eq 172 -and $o[1] -ge 16 -and $o[1] -le 31) { return $false }
  if ($o[0] -eq 10 -and $o[1] -eq 234 -and $o[2] -eq 77) { return $false }
  return $true
}
function New-PinnedNetwork([string]$name) {
  if ($SubnetBase -notmatch '^(\d{1,3})\.(\d{1,3})$' -or $SubnetBase -match '^192\.168$') { Fail "refusing -SubnetBase '$SubnetBase'"; return '' }
  # round 2 (TF6): a documentation range first (the pages must resolve to an address judged public); the -SubnetBase draw
  # only as a last resort (then the door refuses every lab link as private, and [4] fails loudly - never silently)
  $cands = if ($Subnet) { @($Subnet) } else { @('203.0.113.0/24', '198.51.100.0/24') }
  foreach ($s in $cands) {
    if (-not (Test-SubnetAllowed $s)) { Fail "refusing subnet '$s'"; return '' }
    $null = Dk network create --driver bridge --internal --subnet $s --label $label $name
    if ($script:rc -eq 0) { return $s }
  }
  return ''
}
function Get-Chain {
  $cf = Join-Path $dockerDir 'docker-compose.yml'
  $compose = (@(Get-Content $cf) | ForEach-Object { $_ -replace '(^|\s)#.*$', '' }) -join "`n"
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  return , @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
}
if ($testTag -match ':local$') { throw 'refusing a :local tag' }

Write-Host "== rw-boundary-core disposable run  owner=$Id  net=$net  evidence=$Evidence"
$null = Dk version --format '{{.Server.Version}}'
if ($script:rc -ne 0) { Write-Host 'docker is not reachable'; exit 2 }
function LocalSnapshot { (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim() -split "`r?`n" | Sort-Object }
$localBefore = LocalSnapshot
$made = @{ net = $false; containers = @(); images = @() }

try {
  Write-Host '[1] the initdb chain, derived from docker-compose.yml'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = Get-Chain
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check ($chain.Count -ge 50) "staged $($chain.Count) migrations"
  Check (@($chain | Where-Object { $_[1] -eq '420-init-request-boundary.sql' }).Count -eq 1) 'the chain mounts 420-init-request-boundary.sql (rw-boundary-core)'
  $null = Dk image inspect $PgImage
  if ($script:rc -ne 0) { Fail "$PgImage is not on the host"; throw 'pg image' }

  Write-Host '[2] disposable internal network'
  $sub = New-PinnedNetwork $net
  Check ($sub -ne '') "network $net created (bridge, internal, labelled, --subnet $sub)"
  if ($sub -eq '') { throw 'network' }
  $made.net = $true

  Write-Host "[3] build $testTag (the build runs the offline suite)"
  $o = Dk build --no-cache --progress=plain --target test --label $label -t $testTag $rs
  Save 'research-test-build.log' $o
  Check ($script:rc -eq 0) "image $testTag built"
  if ($script:rc -eq 0) { $made.images += $testTag } else { throw 'build' }
  $sum = Summary $o
  Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0) "the build ran the offline suite: $($sum.Value)"
  $clean = $o -replace '\x1b\[[0-9;]*m', ''
  foreach ($t in @('gate is pure: no I/O', 'a hostile proposer that returns every personal field never yields a marker', 'R7: a direct job''s filed synthesis and claim carry no 5-word span', 'R7: a derived job''s synthesis is filed as written', 'the lexicon is the checked-in one')) {
    Check ($clean -match ([regex]::Escape($t) + '[^\n]*\.\.\. ok')) "the build ran: $t"
  }
  $gateCases = @(($clean -split "`n") | Where-Object { $_ -match '^#\d+ [0-9.]+ gate: .*\.\.\. ok' -or $_ -match '^gate: .*\.\.\. ok' })
  Check ($gateCases.Count -ge 16) "the gate's table of cases ran ($($gateCases.Count) ok)"
  Save 'offline-boundary-tests.txt' ((($clean -split "`n") | Where-Object { $_ -match 'boundary|gate:|R7|lexicon|hostile|deny|links:|template|request kinds|door|span filter' }) -join "`n")

  Write-Host '[4] the database + boundary.e2e.test.ts'
  $o = Dk run -d --name $db --label $label --network $net -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=openbrain `
    -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
  if ($script:rc -ne 0) { Fail "postgres did not start: $o"; throw 'db' }
  $made.containers += $db
  for ($i = 0; $i -lt 150; $i++) {
    $logs = Dk logs $db
    if ($logs -match 'PostgreSQL init process complete') { break }
    if ((Dk inspect -f '{{.State.Running}}' $db) -ne 'true') { break }
    Start-Sleep -Seconds 2
  }
  $logs = Dk logs $db
  Save 'initdb.log' $logs
  Check ($logs -match 'PostgreSQL init process complete') 'the initdb chain ran to completion'
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "initdb logged no ERROR ($($errs.Count))"
  Check ($logs -match '420-init-request-boundary\.sql') 'initdb ran 420-init-request-boundary.sql'
  for ($i = 0; $i -lt 60; $i++) {
    $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain
    if ($script:rc -eq 0) { break }
    Start-Sleep -Seconds 2
  }
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN CREATE ROLE ob_app_memory LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE service_role; END IF; END `$`$; ALTER ROLE ob_app_memory LOGIN PASSWORD '$appPw'"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role) - the production shape'
  # round 2 (TF2): the hand-back functions are ob_app_memory's alone - granted when 420 runs with the role present, so
  # run it again now that the lab has created the role (idempotent: the documented step for a fresh volume)
  $null = Dk cp (Join-Path $dockerDir 'init-request-boundary.sql') "${db}:/tmp/b-init0.sql"
  $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -f /tmp/b-init0.sql
  Check ($script:rc -eq 0) "420 re-run after ob_app_memory exists (the grants)$(if ($script:rc) { ': ' + $o })"
  $pages = "rwbnd-pages-$rand"
  $o = Dk run -d --name $pages --label $label --network $net --network-alias news.example.org --network-alias blog.example.org -e PORT=8080 `
    $testTag deno run --allow-net --allow-env --allow-read fixtures/boundary-lab-pages.ts
  if ($script:rc -eq 0) { $made.containers += $pages } else { Fail "the pages container did not start: $o" }
  $o = Dk run --rm --label $label --network $net `
    -e "BND_E2E_DB_HOST=$db" -e BND_E2E_PAGES_PORT=8080 -e "BND_E2E_DB_PASSWORD=$pw" -e "BND_E2E_APP_PASSWORD=$appPw" -e NO_COLOR=1 `
    $testTag deno test --unstable-net --allow-net --allow-env --allow-read --allow-run boundary.e2e.test.ts
  $o = $o -replace [regex]::Escape($pw), '***' -replace [regex]::Escape($appPw), '***'
  Save 'boundary-e2e.log' $o
  foreach ($l in ($o -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(guard|report owner|hand-back|door|hand-backs|the derived|readers|sweep|egress):' }) { Write-Host "    $l" }
  $sum = Summary $o
  Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[3].Value -eq '0' -and [int]$sum.Groups[2].Value -ge 6) "boundary e2e: $($sum.Value)"

  Write-Host '[4b] round 2: the tester''s COPY probes; TF2 through a real PostgREST (anon = service_role, no token)'
  $copy = "COPY public.research_jobs (status, origin, caller, query, anchor, options, request_kind, boundary, refinery_id) FROM STDIN WITH (FORMAT csv);`nqueued,manual,boundary,q one two,q one two,{},derived,`"{`"`"version`"`":`"`"pd0a-2`"`",`"`"lexicon`"`":`"`"$('a' * 64)`"`",`"`"verdict_id`"`":`"`"$('b' * 64)`"`"}`",22222222-2222-4222-8222-222222222222`n\.`n"
  $copyFile = Join-Path $Evidence 'copy-probe.sql'
  [System.IO.File]::WriteAllText($copyFile, $copy, (New-Object System.Text.UTF8Encoding $false))
  $null = Dk cp $copyFile "${db}:/tmp/copy-probe.sql"
  $o1 = Dk exec $db psql -U postgres -d openbrain -X -q -c 'SET ROLE ob_app_memory' -f /tmp/copy-probe.sql
  $o2 = Dk exec $db psql -U postgres -d openbrain -X -q -f /tmp/copy-probe.sql
  # as ob_app_memory COPY is refused before the trigger (research_jobs has row security: COPY FROM is not supported) - a refusal
  # either way; as the superuser the row trigger fires
  Check ($o1 -match 'request boundary|COPY FROM not supported with row-level security' -and $o2 -match 'request boundary') 'X6 G2/G2b: COPY of a derived row with refinery_id refused as ob_app_memory and as the superuser'
  $rst = "rwbnd-rest-$rand"
  $o = Dk run -d --name $rst --label $label --network $net -e "PGRST_DB_URI=postgres://postgres:$pw@${db}:5432/openbrain" `
    -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=service_role -e PGRST_SERVER_PORT=3000 $PgrstImage
  if ($script:rc -eq 0) { $made.containers += $rst } else { Fail "PostgREST did not start: $(($o -replace [regex]::Escape($pw), '***'))" }
  Start-Sleep -Seconds 6
  $o = Dk run --rm --label $label --network $net -e "PGRST_PROBE_URL=http://${rst}:3000" -e PGRST_PROBE_MARKER=zq `
    $testTag deno run --allow-net --allow-env --allow-read fixtures/boundary-pgrst-probe.ts
  $prc = $script:rc
  Save 'pgrst-probe.txt' $o
  foreach ($l in ($o -split "`n") | Where-Object { $_ -match '^PGRST' }) { Write-Host "    $l" }
  Check ($prc -eq 0 -and $o -match 'PGRST summary: 0 slot-420 object') 'TF2: through PostgREST (anon = service_role) every slot-420 function and table is refused'

  Write-Host '[5] slot-420 drill: revert, revert again, init, init again, revert, revert again, init'
  $f420 = Join-Path $dockerDir 'init-request-boundary.sql'; $r420 = Join-Path $dockerDir 'revert-request-boundary.sql'
  $chk = Join-Path $rs 'fixtures\boundary-drill-check.sql'
  $null = Dk cp $f420 "${db}:/tmp/b-init.sql"; $null = Dk cp $r420 "${db}:/tmp/b-revert.sql"; $null = Dk cp $chk "${db}:/tmp/b-check.sql"
  # slot 390's rule under another name: the reference the restored rule's body is compared with
  $ri = [System.IO.File]::ReadAllText((Join-Path $dockerDir 'init-report-isolation.sql'))
  $mfn = [regex]::Match($ri, '(?s)CREATE OR REPLACE FUNCTION public\.research_job_report_owner\(p_job UUID\).*?\n\$\$;')
  Check $mfn.Success "slot 390's rule found in init-report-isolation.sql"
  $refSql = $mfn.Value -replace 'public\.research_job_report_owner\(', 'public._bnd_ref_owner('
  Save 'ref-390.sql' $refSql
  $null = Dk cp (Join-Path $Evidence 'ref-390.sql') "${db}:/tmp/b-ref.sql"
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/b-ref.sql
  Check ($script:rc -eq 0) "the slot-390 reference created$(if ($script:rc) { ': ' + $o })"
  function BState { $s = Dk exec $db psql -U postgres -d openbrain -X -q -f /tmp/b-check.sql; return (($s -split "`n") | ForEach-Object { ($_ -replace '^.*NOTICE:\s+DRILL\s+', '').Trim() } | Where-Object { $_ -match '^[a-z0-9_]+=' }) -join ' ' }
  function BGet([string]$st, [string]$k) { $m = [regex]::Match($st, "(^| )$([regex]::Escape($k))=(\S+)"); if ($m.Success) { $m.Groups[2].Value } else { '' } }
  $drill = @()
  $s0 = BState; $drill += "[after the e2e, 420 applied by the chain] $s0"
  $states = @{}; $notes = @{}
  foreach ($step in @(@('revert', '/tmp/b-revert.sql'), @('revert again', '/tmp/b-revert.sql'), @('init', '/tmp/b-init.sql'), @('init again', '/tmp/b-init.sql'), @('revert 2', '/tmp/b-revert.sql'), @('revert 2 again', '/tmp/b-revert.sql'), @('init 2', '/tmp/b-init.sql'))) {
    $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -f $step[1]
    $rc = $script:rc
    $note = (($o -split "`n") | Where-Object { $_ -match 'rw-boundary-core|ERROR' } | ForEach-Object { ($_ -replace '^.*NOTICE:\s+', '').Trim() }) -join ' ; '
    $st = BState
    $states[$step[0]] = $st; $notes[$step[0]] = $note
    $drill += "[$($step[0])] exit $rc :: $note`n    state: $st"
    Check ($rc -eq 0) "drill: $($step[0]) runs cleanly"
  }
  Save 'migration-drill.txt' ($drill -join "`n")
  foreach ($l in $drill) { Write-Host "    $l" }
  $r1 = $states['revert']; $r1b = $states['revert again']; $i1 = $states['init']; $i2 = $states['init again']; $r2 = $states['revert 2']; $r2b = $states['revert 2 again']; $i3 = $states['init 2']
  Check ([int](BGet $s0 'handbacks') -ge 3 -and (BGet $s0 'kind_cols') -eq '2' -and (BGet $s0 'guards') -eq '2' -and (BGet $s0 'fn390') -eq 'differs') "drill: the chain's 420 is in place with the e2e's hand-backs ($(BGet $s0 'handbacks')) and its rule differs from 390's"
  Check ($notes['revert'] -match 'archived (\d+) hand-back row\(s\) and (\d+) job kind\(s\)' -and [int]$Matches[1] -eq [int](BGet $s0 'handbacks') -and [int]$Matches[2] -ge 4) "drill: revert ARCHIVES FIRST - every hand-back row and every non-default job kind ($($notes['revert']))"
  Check ((BGet $r1 'archive_handbacks') -eq (BGet $s0 'handbacks') -and [int](BGet $r1 'archive_derived') -ge 4) "drill: the archive holds them ($(BGet $r1 'archive_handbacks') hand-backs, $(BGet $r1 'archive_derived') derived jobs)"
  Check ((BGet $r1 'kind_cols') -eq '0' -and (BGet $r1 'guards') -eq '0' -and (BGet $r1 'kind_check') -eq '0' -and (BGet $r1 'handbacks') -eq 'none' -and (BGet $r1 'handback_fns') -eq '0') 'drill: revert drops the columns, the guards, the constraint, the table and the functions'
  Check ((BGet $r1 'fn390') -eq 'same') "drill: revert puts slot 390's rule back exactly (body, settings, signature)"
  Check ((BGet $r1b 'jobs') -eq (BGet $r1 'jobs') -and (BGet $r1b 'prompts') -eq (BGet $r1 'prompts') -and (BGet $r1b 'fn') -eq (BGet $r1 'fn') -and (BGet $r1b 'cols') -eq (BGet $r1 'cols') -and $notes['revert again'] -match 'archived 0 hand-back row\(s\) and 0 job kind\(s\)') 'drill: a second revert archives nothing and changes nothing'
  Check ((BGet $i1 'kind_cols') -eq '2' -and (BGet $i1 'guards') -eq '2' -and (BGet $i1 'handbacks') -eq '0' -and (BGet $i1 'handback_fns') -eq '6' -and (BGet $i1 'fn390') -eq 'differs' -and (BGet $i1 'fn') -eq (BGet $s0 'fn')) 'drill: init puts the columns, guards, table, functions and the rule back (the rule byte-identical to the chain''s)'
  Check ((BGet $s0 'saved') -eq '2' -and (BGet $r1 'saved') -eq '-1' -and (BGet $i1 'saved') -eq '2' -and (BGet $i2 'saved') -eq '2') "drill: init saves the two definitions it replaces first (once), revert restores them and drops the copy (saved: $(BGet $s0 'saved') / $(BGet $r1 'saved') / $(BGet $i1 'saved'))"
  Check ((BGet $i1 'fn_inlet') -ne (BGet $r1 'fn_inlet') -and (BGet $i1 'fn_inlet') -eq (BGet $s0 'fn_inlet')) 'drill: the inlet trigger skips a derived job under 420, and is slot 230''s again after the revert'
  Check ((BGet $i2 'jobs') -eq (BGet $i1 'jobs') -and (BGet $i2 'prompts') -eq (BGet $i1 'prompts') -and (BGet $i2 'cols') -eq (BGet $i1 'cols') -and (BGet $i2 'trg') -eq (BGet $i1 'trg') -and (BGet $i2 'fn') -eq (BGet $i1 'fn')) 'drill: a second init changes nothing'
  Check ((BGet $r2 'jobs') -eq (BGet $r1 'jobs') -and (BGet $r2 'prompts') -eq (BGet $r1 'prompts') -and (BGet $r2 'cols') -eq (BGet $r1 'cols') -and (BGet $r2 'trg') -eq (BGet $r1 'trg') -and (BGet $r2 'fn') -eq (BGet $r1 'fn') -and (BGet $r2 'fn_inlet') -eq (BGet $r1 'fn_inlet') -and (BGet $r2 'fn_comment') -eq (BGet $r1 'fn_comment') -and (BGet $r2 'fn390') -eq 'same') "drill: init then revert restores the touched tables BYTE-IDENTICAL (research_jobs md5 $(BGet $r2 'jobs') = $(BGet $r1 'jobs'), research_prompts md5 $(BGet $r2 'prompts') = $(BGet $r1 'prompts'), columns, triggers, the rule and its comment)"
  Check ((BGet $r2b 'jobs') -eq (BGet $r1 'jobs') -and (BGet $r2b 'prompts') -eq (BGet $r1 'prompts')) 'drill: the second revert of the second round changes nothing'
  Check ((BGet $i3 'kind_cols') -eq '2' -and (BGet $i3 'guards') -eq '2' -and (BGet $i3 'fn') -eq (BGet $s0 'fn')) 'drill: init after the revert applies again'
  # the lock_timeout probe: a session holding research_jobs makes init stop after ~10s with nothing applied
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -f /tmp/b-revert.sql
  $null = Dk exec -d $db psql -U postgres -d openbrain -X -q -c 'BEGIN; LOCK TABLE public.research_jobs IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(25); COMMIT;'
  Start-Sleep -Seconds 2
  $t0 = Get-Date
  $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -f /tmp/b-init.sql
  $lrc = $script:rc; $secs = [int]((Get-Date) - $t0).TotalSeconds
  $lst = BState
  Check ($lrc -ne 0 -and $o -match 'lock timeout' -and $secs -ge 8 -and $secs -le 20 -and (BGet $lst 'kind_cols') -eq '0' -and (BGet $lst 'handbacks') -eq 'none') "drill: a held research_jobs lock stops init after ${secs}s (lock_timeout 10s), nothing applied"
  for ($i = 0; $i -lt 30; $i++) {
    $busy = (Dk exec $db psql -U postgres -d openbrain -X -tA -c "SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(25)%' AND pid <> pg_backend_pid()").Trim()
    if ($busy -eq '0') { break }
    Start-Sleep -Seconds 1
  }
  $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -f /tmp/b-init.sql
  Check ($script:rc -eq 0) 'drill: init runs once the lock is gone'
  Save 'lock-probe.txt' "lock held; init exit $lrc after ${secs}s :: $((($o -split "`n") | Where-Object { $_ -match 'ERROR' }) -join ' ')`nstate: $lst"

  Write-Host '[6] static: who names research_handbacks'
  $allowed = @('docker/init-request-boundary.sql', 'docker/revert-request-boundary.sql', 'integrations/research-service/boundary.ts',
    'integrations/research-service/boundary.e2e.test.ts', 'integrations/research-service/fixtures/boundary-sweep.ts',
    'integrations/research-service/fixtures/boundary-drill-check.sql', 'integrations/research-service/run-boundary-e2e.ps1', 'integrations/research-service/README.md', 'docker/docker-compose.yml',
    'docker/workbench/src/documents/isolation_sweep_test.ts', 'integrations/research-service/fixtures/boundary-pgrst-probe.ts',
    # rw-boundary-digest (slot 460): the migration that adds handback_deliver, and the digest lab's tests
    'docker/init-boundary-digest.sql', 'docker/revert-boundary-digest.sql', 'integrations/research-service/boundary-digest.e2e.test.ts',
    'recipes/daily-digest/lab/boundary-digest-460-check.sql', 'recipes/daily-digest/lab/run-digest-boundary-lab.ps1')
  $names = @(Get-ChildItem -Path $ob1 -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|archive)\\' -and $_.Length -lt 5MB } |
    Where-Object { Select-String -Path $_.FullName -Pattern 'research_handbacks|handback_(open|pending|claim|deliverables|delivered|owned|deliver)' -Quiet } |
    ForEach-Object { $_.FullName.Substring($ob1.Length + 1).Replace('\', '/') })
  # rw-inlet-stamp (slot 470): its migration and revert name the table ONLY in their list of owner columns that get the
  # inlet_subject_ok CHECK (ARRAY['research_handbacks', 'owner_sub'] / the revert's table list) - no read, no write, no
  # hand-back function. They pass only while every line naming the hand-back there is such a list line.
  # round 3 (tester attempt 2, low): the WHOLE line, exactly - anything appended to an admitted line fails the check
  $ownerCheckOnly = @{ 'docker/init-inlet-stamp.sql' = "^\s*ARRAY\['podcast_episodes', 'owner_sub'\], ARRAY\['research_handbacks', 'owner_sub'\],\s*$"; 'docker/revert-inlet-stamp.sql' = "^\s*FOREACH c IN ARRAY ARRAY\['podcast_episodes', 'research_handbacks', 'podcast_teams', 'podcast_presenters',\s*$" }
  foreach ($f in @($ownerCheckOnly.Keys)) {
    if ($names -notcontains $f) { continue }
    $hits = @(Select-String -Path (Join-Path $ob1 $f) -Pattern 'research_handbacks|handback_(open|pending|claim|deliverables|delivered|owned|deliver)' | ForEach-Object { $_.Line })
    if ($hits.Count -ge 1 -and @($hits | Where-Object { $_ -notmatch $ownerCheckOnly[$f] }).Count -eq 0) { $allowed += $f }
  }
  $stray = @($names | Where-Object { $allowed -notcontains $_ })
  $selfTest = @("SELECT owner_sub FROM public.research_handbacks", "PERFORM public.handback_deliver(x)", "UPDATE public.research_handbacks SET state = 'x'",
    "        ARRAY['podcast_episodes', 'owner_sub'], ARRAY['research_handbacks', 'owner_sub'], (SELECT 1 FROM public.research_handbacks)") | Where-Object { $_ -notmatch $ownerCheckOnly['docker/init-inlet-stamp.sql'] -and $_ -notmatch $ownerCheckOnly['docker/revert-inlet-stamp.sql'] }
  Check ($selfTest.Count -eq 4) "the slot-470 exception admits its owner-CHECK list lines only: a read, a write or a hand-back function there would fail this check (4 of 4 not admitted, an appended admitted line included: $($selfTest.Count))"
  Save 'handback-readers.txt' (($names | Sort-Object) -join "`n")
  Check ($names.Count -ge 4 -and $stray.Count -eq 0) "only the boundary's own files name the hand-back ($($names.Count) files; outside the set: $($stray -join ', '))"
}
finally {
  Write-Host '[7] teardown'
  $ourVolumes = @()
  foreach ($c in $made.containers) {
    $mounts = Dk inspect -f '{{range .Mounts}}{{.Type}}={{.Name}} {{end}}' $c
    if ($script:rc -eq 0) {
      $ourVolumes += @(($mounts -split '\s+') | Where-Object { $_ -match '^volume=[A-Za-z0-9][A-Za-z0-9_.-]+$' } | ForEach-Object { $_.Substring(7) })
    }
    $null = Dk rm -f -v $c
  }
  if ($made.net) { $null = Dk network rm $net }
  if (-not $KeepImage) { foreach ($i in $made.images) { $null = Dk rmi -f $i } }
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  $left = @((Dk ps -a --filter "label=$label" --format '{{.Names}}') -split "`n" | Where-Object { $_ })
  Check ($left.Count -eq 0) "no container labelled $label is left ($($left.Count))"
  $leftNet = @((Dk network ls --filter "label=$label" --format '{{.Name}}') -split "`n" | Where-Object { $_ })
  Check ($leftNet.Count -eq 0) "no network labelled $label is left ($($leftNet.Count))"
  $volLeft = @($ourVolumes | Where-Object { $null = Dk volume inspect $_; $script:rc -eq 0 })
  Check ($volLeft.Count -eq 0) "no volume of ours is left ($($ourVolumes.Count) recorded, $($volLeft.Count) left)"
  if (-not $KeepImage) {
    $leftImg = @((Dk images --filter "label=$label" --format '{{.Repository}}:{{.Tag}}') -split "`n" | Where-Object { $_ -and $_ -notmatch '<none>' })
    Check ($leftImg.Count -eq 0) "no image labelled $label is left ($($leftImg -join ', '))"
  }
  $localAfter = LocalSnapshot
  Check (-not (Compare-Object $localBefore $localAfter)) 'no :local image changed'
  Write-Host "== $(if ($script:fail) { "FAILED ($script:fail)" } else { 'ALL PASSED' })  evidence: $Evidence"
}
exit $script:fail
