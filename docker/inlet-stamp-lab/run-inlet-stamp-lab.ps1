# run-inlet-stamp-lab.ps1 - rw-inlet-stamp's disposable lab (plan 08 PD2, slot 470: every personal row is written with
# its owner, and the database refuses one without).
#
#   powershell -NoProfile -File OB1\docker\inlet-stamp-lab\run-inlet-stamp-lab.ps1 [-Id <owner id>] [-Evidence <dir>]
#       [-Red [-BaseSha 0f4c680]] [-KeepImage]
#   -Red: the writers and the chain of OB1 <BaseSha> (rw-inlet-owner 440 + rw-boundary-digest 460, no 470), plus ONE lab
#   seam copied in: pull-gmail.ts's GMAIL_API_BASE line (the Gmail stub instead of Google). RED passes when the defects
#   are reproduced: unowned rows from every writer, every unowned shape accepted, 440's re-run stamping B's mail as A.
#
# What it does, and ONLY this:
#   1. stages the code under test (GREEN = this checkout; RED = a git archive of <BaseSha> + the seam) and its initdb
#      chain from docker-compose.yml
#   2. ONE --internal bridge network on a documentation range, every container, image and network labelled
#      ai-stack.harness.owner=<Id>; images tagged :wt-<id> only (never :local)
#   3. the database (the chain; ob_app_memory as production has it), the state before PD1's deploy (unowned personal
#      thoughts of every inlet), slot 440 with owner A, then (GREEN) slot 470 - the live order - and a second inlet
#      connection owned by B (the PD4 stand-in)
#   4. PostgREST (anon = service_role, as compose) behind the real Caddyfile (openbrain-rest), and stub.ts as the Gmail
#      API and the gateway aliases (llama-cpp / llama-cpp-embed)
#   5. the writers, for real: the gmail pull (A's mailbox, B's mailbox, none), the prune (each connection, none), the
#      Google-activity import (B; no owner; the literal operator), the ChatGPT import (A; no owner)
#   6. the database's refusal per writer shape: PostgREST (probe.ts), direct PG as ob_app_memory (the MCP lanes'
#      capture_thought and agent-memory inserts), the import scripts (above)
#   7. who owns what, the readers' view as A and as B (match_thoughts, the MCP clause, the wiki compile's read), 440's
#      re-run, and (GREEN) the 470 drill: init again, the refusals, revert x2, init before 440, re-seed
#   8. tears down exactly what it created; verifies nothing labelled <Id> is left and no :local image changed
# Seeded mail only (no real Gmail, no email sent, no Google API); no real model (the stub answers under the gateway's
# alias names). It never touches the live stack: no compose, no ai-stack_* / open-brain_* network, no host port.
# Exit code 0 = every check passed (RED: the defects were reproduced).
param(
  [string]$Id = 'wt-rw-inlet-stamp',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
  [string]$CaddyImage = 'caddy:2-alpine',
  [string]$DenoImage = 'denoland/deno:alpine',
  [string]$NodeImage = 'node:22-slim',
  [string]$Evidence = '',
  [switch]$Red,
  [string]$BaseSha = '0f4c680',
  [switch]$KeepImage
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$label = "ai-stack.harness.owner=$Id"
$labDir = $PSScriptRoot
$ob1 = Split-Path -Parent (Split-Path -Parent $labDir)
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rwis-net-$rand"; $db = "rwis-db-$rand"; $pgrst = "rwis-pgrst-$rand"; $caddy = "rwis-rest-$rand"; $stub = "rwis-stub-$rand"
$short = ($Id -replace '^wt-', '')
$pyTag = "openbrain-inlet-stamp-py:wt-$short"
if ($pyTag -match ':local$') { throw 'refusing a :local tag' }
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$mode = if ($Red) { 'red' } else { 'green' }
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "rwis-evidence-$mode-$rand" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$work = Join-Path $env:TEMP "rwis-work-$rand"
$A = "lab-owner-a-$rand"; $B = "lab-owner-b-$rand"
$MA = "stampmarka$rand"; $MB = "stampmarkb$rand"; $ML = "stampmarklegacy$rand"

$script:fail = 0
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }
function Save([string]$name, [string]$text) {
  [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false))
}
function Get-Chain([string]$dockerDir) {
  $cf = Join-Path $dockerDir 'docker-compose.yml'
  $compose = (@(Get-Content $cf) | ForEach-Object { $_ -replace '(^|\s)#.*$', '' }) -join "`n"
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  return , @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
}
function LocalSnapshot { (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim() -split "`r?`n" | Sort-Object }
function Q([string]$sql) { $r = Dk exec $db psql -U postgres -d openbrain -X -A -t -c $sql; return "$r".Trim() }
function QApp([string]$sql) { $r = Dk exec $db psql -U ob_app_memory -d openbrain -X -A -t -c $sql; return "$r".Trim() }
function PsqlFile([string]$local, [string[]]$vars) {
  $name = '/tmp/' + [IO.Path]::GetFileName($local)
  $null = Dk cp $local "${db}:$name"
  $a = @('exec', $db, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'openbrain', '-X', '-q') + $vars + @('-f', $name)
  $o = Dk @a
  return @{ rc = $script:rc; out = $o }
}
function Copy-Dir([string]$from, [string]$to) {
  New-Item -ItemType Directory -Force $to | Out-Null
  Copy-Item (Join-Path $from '*') $to -Recurse -Force
}
function Run([int]$timeout, [string[]]$a) {
  # a one-shot container on the lab network; the output, with the passwords masked
  $o = Dk @(@('run', '--rm', '--label', $label, '--network', $net) + $a)
  return @{ rc = $script:rc; out = ($o -replace [regex]::Escape($pw), '***') }
}

Write-Host "== rw-inlet-stamp disposable run  mode=$mode  owner=$Id  net=$net  evidence=$Evidence"
$null = Dk version --format '{{.Server.Version}}'
if ($script:rc -ne 0) { Write-Host 'docker is not reachable'; exit 2 }
$localBefore = LocalSnapshot
$made = @{ net = $false; containers = @(); images = @() }

try {
  Write-Host "[1] the code under test ($mode)"
  New-Item -ItemType Directory -Force $work | Out-Null
  if ($Red) {
    $tar = Join-Path $work 'base.tar'
    & git -C $ob1 archive --format=tar -o $tar $BaseSha docker recipes/email-history-import recipes/google-activity-import recipes/chatgpt-conversation-import integrations/intake/sql
    Check ($LASTEXITCODE -eq 0) "git archive of OB1 $BaseSha"
    $code = Join-Path $work 'base'
    New-Item -ItemType Directory -Force $code | Out-Null
    & tar -x -f $tar -C $code
    Remove-Item $tar -Force
    # the one lab seam: the Gmail API base (a stub instead of Google), one line
    $pg = Join-Path $code 'recipes\email-history-import\pull-gmail.ts'
    $t = [IO.File]::ReadAllText($pg)
    $seamLine = 'const GMAIL_API = (Deno.env.get("GMAIL_API_BASE") || "https://gmail.googleapis.com").replace(/\/+$/, "") + "/gmail/v1/users/me";'
    $t2 = $t.Replace('const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";', $seamLine)
    Check ($t2 -ne $t) 'RED seam: the base pull reads GMAIL_API_BASE (one line, nothing else changed)'
    [IO.File]::WriteAllText($pg, $t2, (New-Object System.Text.UTF8Encoding $false))
    Save 'red-seam.txt' "base $BaseSha; seam: recipes/email-history-import/pull-gmail.ts GMAIL_API line -> $seamLine"
  } else {
    $code = $ob1
  }
  $dockerDir = Join-Path $code 'docker'
  $stage = Join-Path $work 'initdb'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = Get-Chain $dockerDir
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  $staged = @(Get-ChildItem $stage -Filter *.sql).Count
  Check ($chain.Count -ge 50 -and $staged -eq $chain.Count) "staged $staged of $($chain.Count) migrations"
  $has440 = @($chain | Where-Object { $_[1] -eq '440-init-inlet-owner.sql' }).Count -eq 1
  $has470 = @($chain | Where-Object { $_[1] -eq '470-init-inlet-stamp.sql' }).Count -eq 1
  Check $has440 'the chain mounts 440 (rw-inlet-owner)'
  if ($Red) { Check (-not $has470) 'RED: the base chain has no 470' } else { Check $has470 'the chain mounts 470-init-inlet-stamp.sql' }

  Write-Host '[2] disposable internal network (a documentation range)'
  $sub = ''
  foreach ($s in @('203.0.113.0/24', '198.51.100.0/24')) {
    $null = Dk network create --driver bridge --internal --subnet $s --label $label $net
    if ($script:rc -eq 0) { $sub = $s; break }
  }
  Check ($sub -ne '') "network $net created (bridge, internal, labelled, --subnet $sub)"
  if ($sub -eq '') { throw 'network' }
  $made.net = $true
  $o = Dk build --label $label -t $pyTag -f (Join-Path $labDir 'Dockerfile.py') $labDir
  Save 'py-image-build.log' $o
  Check ($script:rc -eq 0) "image $pyTag built (python + requests, for the ChatGPT import)"
  if ($script:rc -eq 0) { $made.images += $pyTag } else { throw 'py image' }

  Write-Host '[3] the database: the chain, the state before PD1, 440 (owner A), then 470 (the live order)'
  $o = Dk run -d --name $db --label $label --network $net -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=openbrain -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
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
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN CREATE ROLE ob_app_memory LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE service_role; END IF; END `$`$"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role) - the production shape'
  if (-not $Red) {
    $fresh = Q "SELECT (SELECT count(*) FROM public.inlet_connections) || '|' || (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_inlet_stamp_thoughts', 'trg_inlet_stamp_sources'))"
    Check ($fresh -eq '0|2') "fresh volume: 470 applied with nothing to seed it from - no connection recorded, both guards in place ($fresh)"
    $r = PsqlFile (Join-Path $dockerDir 'revert-inlet-stamp.sql') @()
    Check ($r.rc -eq 0) 'the fresh chain''s 470 is taken off (the live database has no 470 before PD1''s window)'
  }
  $r = PsqlFile (Join-Path $labDir 'plant-legacy.sql') @('-v', "mark=$ML")
  Check ($r.rc -eq 0) 'planted the state before PD1: unowned personal thoughts of every inlet (gmail ops + personal, google_activity, chatgpt, mcp, agent-memory, a vault note)'
  $r = PsqlFile (Join-Path $dockerDir 'init-inlet-owner.sql') @('-v', "owner_sub=$A")
  Save '440-init.log' $r.out
  Check ($r.rc -eq 0 -and $r.out -match 'now the owner') "slot 440 with owner A: the existing personal data is A's"
  if (-not $Red) {
    $r = PsqlFile (Join-Path $dockerDir 'init-inlet-stamp.sql') @('-v', "owner_sub=$B")
    Check ($r.rc -ne 0 -and $r.out -match 'belongs to the subject slot 440 recorded' -and (Q "SELECT to_regclass('public.inlet_connections') IS NULL") -eq 't') '470 naming a subject other than 440''s record is refused, nothing changed'
    $r = PsqlFile (Join-Path $dockerDir 'init-inlet-stamp.sql') @()
    Save '470-init.log' $r.out
    $conns = Q "SELECT string_agg(id || '=' || CASE owner_sub WHEN '$A' THEN 'A' WHEN '$B' THEN 'B' ELSE 'other' END, ',' ORDER BY id) FROM public.inlet_connections"
    Check ($r.rc -eq 0 -and $conns -eq 'gmail=A,vault=A') "470 right after 440: the owner record seeded from 440's record (gmail, vault -> A) ($conns)"
    $null = Q "INSERT INTO public.inlet_connections (id, kind, owner_sub) VALUES ('gmail-b', 'gmail', '$B')"
    Check ((Q "SELECT owner_sub = '$B' FROM public.inlet_connections WHERE id = 'gmail-b'") -eq 't') 'a second inlet connection, gmail-b, owned by B (the PD4 stand-in: two seeded inlet owners)'
  }
  $t0 = Q "SELECT max(id) FROM public.thoughts"

  Write-Host '[4] PostgREST behind the real Caddyfile, and the stubs (Gmail API, the gateway aliases)'
  $o = Dk run -d --name $pgrst --label $label --network $net --network-alias openbrain-postgrest -e "PGRST_DB_URI=postgres://postgres:$pw@${db}:5432/openbrain" -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=service_role -e PGRST_SERVER_PORT=3000 $PgrstImage
  if ($script:rc -eq 0) { $made.containers += $pgrst } else { Fail "PostgREST did not start" }
  $o = Dk run -d --name $caddy --label $label --network $net --network-alias openbrain-rest -v "$(Join-Path $dockerDir 'Caddyfile'):/etc/caddy/Caddyfile:ro" $CaddyImage
  if ($script:rc -eq 0) { $made.containers += $caddy } else { Fail "Caddy did not start: $o" }
  $o = Dk run -d --name $stub --label $label --network $net --network-alias gmail-stub --network-alias llama-cpp --network-alias llama-cpp-embed `
    -e "STAMP_MARK_A=$MA" -e "STAMP_MARK_B=$MB" -v "${labDir}:/lab:ro" $DenoImage run --allow-net --allow-env /lab/stub.ts
  if ($script:rc -eq 0) { $made.containers += $stub } else { Fail "the stub did not start: $o" }
  Start-Sleep -Seconds 6
  $restEnv = @('-e', 'SUPABASE_URL=http://openbrain-rest', '-e', 'SUPABASE_SERVICE_ROLE_KEY=local-trust', '-e', 'OPENROUTER_API_KEY=lab-placeholder',
    '-e', 'LOCAL_LLM_BASE=http://llama-cpp:8080/v1', '-e', 'LOCAL_EMBED_BASE=http://llama-cpp-embed:8080/v1', '-e', 'NO_COLOR=1')
  $gmailCount = { [int](("" + (Run 60 @('--entrypoint', 'wget', $DenoImage, '-qO-', 'http://gmail-stub:8080/_gmailcount')).out).Trim()) }

  Write-Host '[5a] the gmail pull: A''s mailbox (connection gmail), B''s (gmail-b), and one with no connection'
  $pulls = @{}
  foreach ($p in @(@('a', 'gmail', 'lab-token-a'), @('b', 'gmail-b', 'lab-token-b'), @('none', '', 'lab-token-a'))) {
    $dir = Join-Path $work "pull-$($p[0])"
    Copy-Dir (Join-Path $code 'recipes\email-history-import') $dir
    Remove-Item (Join-Path $dir 'sync-log.json'), (Join-Path $dir '.env') -Force -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText((Join-Path $dir 'credentials.json'), '{"installed":{"client_id":"lab","client_secret":"lab","redirect_uris":["http://localhost"]}}')
    [IO.File]::WriteAllText((Join-Path $dir 'token.json'), "{`"access_token`":`"$($p[2])`",`"refresh_token`":`"lab`",`"token_type`":`"Bearer`",`"expiry_date`":4102444800000}")
    $gBefore = & $gmailCount
    $envC = if ($p[1]) { @('-e', "INLET_CONNECTION=$($p[1])") } else { @() }
    $r = Run 300 (@('-v', "${dir}:/app", '-w', '/app', '-e', 'GMAIL_API_BASE=http://gmail-stub:8080') + $restEnv + $envC + @('--entrypoint', 'deno', $DenoImage,
      'run', '--allow-net', '--allow-read', '--allow-write', '--allow-env', 'pull-gmail.ts', '--labels=INBOX', '--window=all', '--limit=10',
      '--short-term-label=brain/keep-short-term', '--short-term-retention-days=3650', '--no-chain'))
    $gAfter = & $gmailCount
    Save "pull-$($p[0]).log" $r.out
    $pulls[$p[0]] = @{ rc = $r.rc; gmail = ($gAfter - $gBefore); out = $r.out }
  }
  $own = { param($mark, $src) Q "SELECT coalesce((SELECT string_agg(k, ',' ORDER BY k) FROM (SELECT DISTINCT CASE WHEN user_id IS NULL THEN 'none' WHEN user_id = '$A' THEN 'A' WHEN user_id = '$B' THEN 'B' ELSE 'other' END || '/' || coalesce(metadata->>'inlet_connection', '-') AS k FROM public.thoughts WHERE id > $t0 AND content LIKE '%$mark%' AND metadata->>'source' = '$src') d), '') || ' n=' || (SELECT count(*) FROM public.thoughts WHERE id > $t0 AND content LIKE '%$mark%' AND metadata->>'source' = '$src')" }
  $pa = & $own $MA 'gmail'; $pb = & $own $MB 'gmail'
  Write-Host "    pull A rows: $pa | pull B rows: $pb | no-connection run exit $($pulls['none'].rc), gmail requests $($pulls['none'].gmail)"
  if ($Red) {
    Check ($pulls['a'].rc -eq 0 -and $pa -match '^none/- n=[1-9]' -and $pb -match '^none/- n=[1-9]') "RED: the base pull writes every mail UNOWNED, whichever mailbox ($pa | $pb)"
  } else {
    Check ($pulls['a'].rc -eq 0 -and $pa -match '^A/gmail n=[1-9]') "the pull of A's mailbox writes only rows owned by A, naming connection gmail ($pa)"
    Check ($pulls['b'].rc -eq 0 -and $pb -match '^B/gmail-b n=[1-9]') "the pull of B's mailbox writes only rows owned by B, naming gmail-b ($pb)"
    Check ($pulls['none'].rc -ne 0 -and $pulls['none'].gmail -eq 0 -and $pulls['none'].out -match 'INLET_CONNECTION is not set') "a pull with no inlet connection refuses before Gmail is asked for anything (exit $($pulls['none'].rc), $($pulls['none'].gmail) Gmail request(s)) and writes nothing"
  }

  Write-Host '[5b] the prune: per connection (gmail, then gmail-b), and with no connection'
  $expired = { param($mark) Q "SELECT count(*) FROM public.thoughts WHERE id > $t0 AND content LIKE '%$mark%' AND metadata->'gmail_labels' ? 'brain/keep-short-term'" }
  $e0 = "$(& $expired $MA)/$(& $expired $MB)"
  $prune = { param($conn) $envC = if ($conn) { @('-e', "INLET_CONNECTION=$conn") } else { @() }
    Run 300 (@('-v', "$(Join-Path $work 'pull-a'):/app:ro", '-w', '/app') + $restEnv + $envC + @('--entrypoint', 'deno', $DenoImage,
      'run', '--allow-net', '--allow-read', '--allow-env', 'prune-short-term.ts', '--retention-days=5', '--no-wiki-recompile', '--no-chain')) }
  $rN = & $prune ''
  $eN = "$(& $expired $MA)/$(& $expired $MB)"
  $rA = & $prune 'gmail'
  $eA = "$(& $expired $MA)/$(& $expired $MB)"
  $rB = & $prune 'gmail-b'
  $eB = "$(& $expired $MA)/$(& $expired $MB)"
  Save 'prune.log' ("[none] exit $($rN.rc)`n$($rN.out)`n[gmail] exit $($rA.rc)`n$($rA.out)`n[gmail-b] exit $($rB.rc)`n$($rB.out)")
  Write-Host "    expired short-term mail A/B: before $e0, no connection $eN, gmail $eA, gmail-b $eB"
  if ($Red) {
    Check ($e0 -match '^[1-9]+/[1-9]+$' -and $eB -eq $e0) "RED: the base prune deletes none of the new mail - it is nobody's (A/B $e0 -> $eB)"
  } else {
    Check ($rN.rc -ne 0 -and $eN -eq $e0) "a prune with no inlet connection refuses and deletes nothing (exit $($rN.rc), $e0 -> $eN)"
    $bExp = ($e0 -split '/')[1]
    Check ($rA.rc -eq 0 -and $bExp -ne '0' -and $eA -eq "0/$bExp") "the prune of connection gmail deletes A's expired mail only; B's stays ($e0 -> $eA)"
    Check ($rB.rc -eq 0 -and $eB -eq '0/0') "the prune of connection gmail-b deletes B's ($eA -> $eB)"
  }

  Write-Host '[5c] the Google-activity import (owner B; no owner; the literal operator)'
  $ta = Join-Path $work 'takeout-b'
  Copy-Dir (Join-Path $labDir 'fixtures\takeout') $ta
  $f = Join-Path $ta 'My Activity\Search\MyActivity.json'
  [IO.File]::WriteAllText($f, ([IO.File]::ReadAllText($f).Replace('__MARK__', $MB)), (New-Object System.Text.UTF8Encoding $false))
  $ga = { param([string[]]$extra) Run 300 (@('-v', "$(Join-Path $code 'recipes\google-activity-import'):/r:ro", '-v', "${ta}:/t:ro", '--tmpfs', '/work', '-w', '/work') + $restEnv +
      @('--entrypoint', 'node', $NodeImage, '/r/import-google-activity.mjs', '/t/My Activity', '--raw') + $extra) }
  $cnt = { param($src) Q "SELECT count(*) FROM public.thoughts WHERE id > $t0 AND metadata->>'source' = '$src'" }
  if ($Red) {
    $r = & $ga @()
    Save 'ga-red.log' $r.out
    $g = & $own $MB 'google_activity'
    Check ($r.rc -eq 0 -and $g -match '^none/- n=[1-9]') "RED: the base import runs with no owner and writes every row UNOWNED (exit $($r.rc); $g)"
  } else {
    $c0 = & $cnt 'google_activity'
    $r1 = & $ga @(); $c1 = & $cnt 'google_activity'
    $r2 = & $ga @('--owner', 'operator'); $c2 = & $cnt 'google_activity'
    $r3 = & $ga @('--owner', 'service:import'); $c3 = & $cnt 'google_activity'
    $r4 = & $ga @('--owner', $B)
    Save 'ga.log' ("[no owner] exit $($r1.rc)`n$($r1.out)`n[operator] exit $($r2.rc)`n$($r2.out)`n[service] exit $($r3.rc)`n$($r3.out)`n[B] exit $($r4.rc)`n$($r4.out)")
    Check ($r1.rc -eq 2 -and $c1 -eq $c0 -and $r1.out -match '--owner <subject> is required') "the import with no --owner refuses (exit $($r1.rc)) and writes nothing ($c0 -> $c1)"
    Check ($r2.rc -eq 2 -and $r3.rc -eq 2 -and $c3 -eq $c0) "the import refuses the literal operator and a service principal as owner (exit $($r2.rc), $($r3.rc)), nothing written"
    $g = & $own $MB 'google_activity'
    Check ($r4.rc -eq 0 -and $g -match '^B/- n=[1-9]') "the import with --owner B writes only rows owned by B ($g)"
  }

  Write-Host '[5d] the ChatGPT import (owner A; no owner)'
  $cg = Join-Path $work 'chatgpt-a'
  Copy-Dir (Join-Path $labDir 'fixtures\chatgpt') $cg
  $f = Join-Path $cg 'conversations.json'
  [IO.File]::WriteAllText($f, ([IO.File]::ReadAllText($f).Replace('__MARK__', $MA)), (New-Object System.Text.UTF8Encoding $false))
  $cgr = Join-Path $work 'chatgpt-recipe'
  $cgImp = { param([string[]]$extra)
    Remove-Item $cgr -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Dir (Join-Path $code 'recipes\chatgpt-conversation-import') $cgr
    Remove-Item (Join-Path $cgr 'chatgpt-sync-log.json'), (Join-Path $cgr '.env') -Force -ErrorAction SilentlyContinue
    Run 300 (@('-v', "${cgr}:/r", '-v', "${cg}:/t:ro", '-w', '/r') + $restEnv + @('--entrypoint', 'python', $pyTag, '/r/import-chatgpt.py', '/t', '--raw') + $extra) }
  if ($Red) {
    $r = & $cgImp @()
    Save 'chatgpt-red.log' $r.out
    $g = & $own $MA 'chatgpt'
    Check ($r.rc -eq 0 -and $g -match '^none/- n=[1-9]') "RED: the base ChatGPT import runs with no owner and writes every row UNOWNED (exit $($r.rc); $g)"
  } else {
    $c0 = & $cnt 'chatgpt'
    $r1 = & $cgImp @(); $c1 = & $cnt 'chatgpt'
    $r2 = & $cgImp @('--owner', $A)
    Save 'chatgpt.log' ("[no owner] exit $($r1.rc)`n$($r1.out)`n[A] exit $($r2.rc)`n$($r2.out)")
    Check ($r1.rc -eq 2 -and $c1 -eq $c0 -and $r1.out -match '--owner SUBJECT is required') "the ChatGPT import with no --owner refuses (exit $($r1.rc)) and writes nothing ($c0 -> $c1)"
    $g = & $own $MA 'chatgpt'
    Check ($r2.rc -eq 0 -and $g -match '^A/- n=[1-9]') "the ChatGPT import with --owner A writes only rows owned by A ($g)"
  }

  Write-Host '[6] the database''s refusal per writer shape: PostgREST (probe.ts) and direct PG as ob_app_memory (the MCP lanes)'
  $r = Run 120 (@('-v', "${labDir}:/lab:ro", '-e', 'REST=http://openbrain-rest', '-e', "OWNER_A=$A", '-e', "OWNER_B=$B", '-e', "MARK_A=$MA", '-e', "MARK_B=$MB", '-e', "LABTAG=$mode$rand",
    '--entrypoint', 'deno', $DenoImage, 'run', '--allow-net', '--allow-env', '/lab/probe.ts'))
  Save 'probe.log' $r.out
  $pm = ([regex]'(?m)^PROBE (.+)$').Match($r.out)
  $pj = if ($pm.Success) { $pm.Groups[1].Value | ConvertFrom-Json } else { $null }
  Check ($null -ne $pj) 'probe.ts answered'
  # direct PG, as the MCP lanes write (integrations/kubernetes-deployment: capture_thought, agent-memory)
  $mcpIns = { param($src) $o = Dk exec $db psql -U ob_app_memory -d openbrain -X -A -t -v ON_ERROR_STOP=1 -c "INSERT INTO thoughts (content, embedding, metadata, exposure) VALUES ('mcp probe $mode$rand', NULL, jsonb_build_object('source', '$src', 'exposure', 'ops'), 'ops') RETURNING id"; @{ rc = $script:rc; refused = ($o -match 'inlet stamp'); out = $o } }
  $m1 = & $mcpIns 'mcp'; $m2 = & $mcpIns 'agent-memory'
  $clr = Dk exec $db psql -U ob_app_memory -d openbrain -X -A -t -c "UPDATE thoughts SET user_id = NULL WHERE content LIKE '%$MA%' AND metadata->>'source' = 'gmail'"
  $clrRefused = $clr -match 'inlet stamp'
  $chg = Dk exec $db psql -U ob_app_memory -d openbrain -X -A -t -c "UPDATE thoughts SET user_id = '$B' WHERE content LIKE '%$MA%' AND metadata->>'source' = 'gmail'"
  $chgRefused = $chg -match 'inlet stamp'
  # the maintenance setting (superuser sessions only): postgres without it is refused; with it, allowed; an app role
  # or PostgREST's role (SET ROLE service_role) with it is still refused
  $mx = { param($pre) $o = Dk exec $db psql -U postgres -d openbrain -X -A -t -c "$pre INSERT INTO thoughts (content, metadata, exposure) VALUES ('maint probe $mode$rand', jsonb_build_object('source', 'mcp', 'exposure', 'ops'), 'ops') RETURNING 'landed'"; @{ rc = $script:rc; refused = ($o -match 'inlet stamp'); out = $o } }
  $su0 = & $mx ''
  $su1 = & $mx "SET inlet_stamp.allow_unowned = 'on';"
  $su2 = & $mx "SET inlet_stamp.allow_unowned = 'on'; SET ROLE service_role;"
  $o = Dk exec $db psql -U ob_app_memory -d openbrain -X -A -t -c "SET inlet_stamp.allow_unowned = 'on'; INSERT INTO thoughts (content, metadata, exposure) VALUES ('maint probe app $mode$rand', jsonb_build_object('source', 'mcp', 'exposure', 'ops'), 'ops')"
  $su3 = @{ refused = ($o -match 'inlet stamp'); out = $o }
  $null = Q "DELETE FROM public.thoughts WHERE content LIKE 'maint probe%'"
  Save 'direct-pg.log' ("[mcp] $($m1.out)`n[agent-memory] $($m2.out)`n[clear] $clr`n[change] $chg`n[superuser] $($su0.out)`n[superuser + maintenance] $($su1.out)`n[maintenance + SET ROLE service_role] $($su2.out)`n[ob_app_memory + maintenance] $($su3.out)")
  if ($pj) {
    $wr = $pj.writes
    $lines = @($wr.PSObject.Properties | ForEach-Object { "$($_.Name): $($_.Value.status)$(if ($_.Value.refused) { ' refused' })$(if ($_.Value.why -and -not $_.Value.refused) { ' - ' + $_.Value.why })" })
    foreach ($l in $lines) { Write-Host "    $l" }
    $refusedCases = @('pull shape, no owner', 'pull shape, owner but no connection', "pull shape, A's row naming B's connection", 'pull shape, unknown connection',
      'pull shape, the literal operator', 'pull shape, a service principal', 'pull shape, blank owner', 'import shape, no owner', 'note shape, no owner',
      'note shape, B on the vault', 'dossier look-alike, unowned', 'source, an email body', 'source, a podcast transcript', 'source, a Gmail id',
      'episode, the literal operator', 'episode, a service principal')
    $okCases = @('pull shape, owned right (control)', 'import shape, owned (control)', 'note shape, the vault''s owner (control)', 'dossier, unowned (control)',
      'source, a public article (control)', 'episode, A (control)')
    $refusedOk = @($refusedCases | Where-Object { $wr.$_.status -ge 400 -and $wr.$_.refused }).Count
    $acceptedBad = @($refusedCases | Where-Object { $wr.$_.status -lt 300 }).Count
    $controlsOk = @($okCases | Where-Object { $wr.$_.status -ge 200 -and $wr.$_.status -lt 300 }).Count
    if ($Red) {
      $redUnowned = @('pull shape, no owner', 'import shape, no owner', 'note shape, no owner', 'dossier look-alike, unowned', 'source, an email body', 'source, a podcast transcript', 'source, a Gmail id', 'episode, the literal operator') | Where-Object { $wr.$_.status -lt 300 }
      Check (@($redUnowned).Count -eq 8) "RED: through PostgREST the base accepts every unowned or personal shape - the pull's, the imports', the note's, a dossier look-alike, an email-body / transcript / Gmail-id source, an episode owned by the literal operator ($(@($redUnowned).Count) of 8)"
      Check (-not $m1.refused -and $m1.rc -eq 0 -and -not $m2.refused -and $m2.rc -eq 0) 'RED: direct PG as ob_app_memory, the MCP lanes'' unstamped capture_thought and agent-memory inserts are accepted'
      Check (-not $clrRefused) 'RED: an owner can be cleared again by an app role'
    } else {
      Check ($refusedOk -eq $refusedCases.Count -and $acceptedBad -eq 0) "PostgREST: every unowned or wrongly owned shape is refused by the database, naming the guard ($refusedOk of $($refusedCases.Count); accepted $acceptedBad)"
      Check ($controlsOk -eq $okCases.Count) "PostgREST: the correctly owned controls land, and the compile's dossier stays shared ($controlsOk of $($okCases.Count))"
      Check ($m1.refused -and $m1.rc -ne 0 -and $m2.refused -and $m2.rc -ne 0) 'direct PG as ob_app_memory: an unstamped MCP-shaped capture_thought and agent-memory insert is refused (rw-mcp-identity must stamp them before 470 goes live)'
      Check ($clrRefused -and $chgRefused) 'an app role can neither clear nor change an owner'
      Check ($su0.refused -and -not $su1.refused -and $su1.out -match 'landed' -and $su2.refused -and $su3.refused) "a superuser is refused too; only a superuser session that sets inlet_stamp.allow_unowned (maintenance) may write an unowned row - not PostgREST's role, not an app role, with the setting"
      $rec = $pj.record
      Check ($rec.table_read_status -ge 400 -and -not $rec.table_read_gave_rows) "the owner record is not readable through PostgREST ($($rec.table_read_status))"
      Check ($rec.gmail.same.A -and $rec.'gmail-b'.same.B -and $rec.vault.same.A -and $rec.nobody.status -ge 400) 'inlet_connection_owner answers each connection''s owner, and refuses an unknown one'
    }
  }

  Write-Host '[7] who owns what, the readers as A and as B, 440''s re-run'
  $newUnowned = Q "SELECT count(*) FROM public.thoughts WHERE id > $t0 AND user_id IS NULL AND NOT (metadata->>'type' = 'dossier' AND metadata->>'generated_by' = 'recipes/entity-wiki/generate-wiki.mjs')"
  $crossed = Q "SELECT (SELECT count(*) FROM public.thoughts WHERE content LIKE '%$MB%' AND user_id IS DISTINCT FROM '$B') || '|' || (SELECT count(*) FROM public.thoughts WHERE content LIKE '%$MA%' AND user_id IS DISTINCT FROM '$A')"
  $mcpB = Q "SELECT count(*) FROM thoughts WHERE (user_id IS NULL OR user_id = '$B') AND (content LIKE '%$MA%' OR content LIKE '%$ML%')"
  $mcpA = Q "SELECT count(*) FROM thoughts WHERE (user_id IS NULL OR user_id = '$A') AND content LIKE '%$MB%'"
  Write-Host "    new unowned rows: $newUnowned | B-marked not B's / A-marked not A's: $crossed | MCP clause: A-or-legacy rows B reads $mcpB, B rows A reads $mcpA"
  if ($Red) {
    Check ([int]$mcpB -ge 1 -and [int]$mcpA -ge 1) "RED: the readers' owner clause cannot hide what has no owner - B reads A's new rows and A reads B's mail ($mcpB, $mcpA)"
  }
  if (-not $Red) {
    Check ($newUnowned -eq '0') "every row the writers wrote has an owner ($newUnowned unowned)"
    Check ($crossed -eq '0|0') "with two inlet owners, each one's rows are owned by that owner only - no B row stamped as the operator A ($crossed)"
    if ($pj) {
      $rd = $pj.reads
      Check ($rd.'match_thoughts as B'.a -eq 0 -and $rd.'match_thoughts as B'.b -ge 1) "match_thoughts as B: B's own rows, none of A's (A-marks $($rd.'match_thoughts as B'.a), B-marks $($rd.'match_thoughts as B'.b))"
      Check ($rd.'match_thoughts as A'.b -eq 0 -and $rd.'match_thoughts as A'.a -ge 1) "match_thoughts as A: A's own rows, none of B's (A-marks $($rd.'match_thoughts as A'.a), B-marks $($rd.'match_thoughts as A'.b))"
      Check ($rd.'match_thoughts shared only (the wiki compile)'.a -eq 0 -and $rd.'match_thoughts shared only (the wiki compile)'.b -eq 0 -and $rd.'the wiki compile''s thoughts read (user_id=is.null)'.a -eq 0 -and $rd.'the wiki compile''s thoughts read (user_id=is.null)'.b -eq 0) 'the wiki compile''s reads (shared only) carry neither owner''s rows'
    }
    Check ($mcpB -eq '0' -and $mcpA -eq '0') "openbrain-mcp's owner clause (slot 440's thoughtOwnerSql): B reads none of A's, A none of B's ($mcpB, $mcpA)"
  }
  $r = PsqlFile (Join-Path $dockerDir 'init-inlet-owner.sql') @()
  Save '440-rerun.log' $r.out
  $crossedAfter = Q "SELECT count(*) FROM public.thoughts WHERE content LIKE '%$MB%' AND user_id = '$A'"
  if ($Red) {
    Check ($r.rc -eq 0 -and $r.out -notmatch 'nothing to do' -and [int]$crossedAfter -ge 1) "RED: 440's re-run finds the writers' unowned rows - and stamps B's mail and B's import as the operator A ($crossedAfter row(s))"
  } else {
    Check ($r.rc -eq 0 -and $r.out -match 'nothing to do' -and $crossedAfter -eq '0') "after the stamped runs, 440's re-run has nothing to stamp ('nothing to do'; B rows stamped as A: $crossedAfter)"
  }

  if (-not $Red) {
    Write-Host '[8] the 470 drill: init again, a subject check, revert x2, init before 440 (refused), 440, init (re-seeded)'
    $r = PsqlFile (Join-Path $dockerDir 'init-inlet-stamp.sql') @()
    Check ($r.rc -eq 0 -and (Q "SELECT count(*) FROM public.inlet_connections") -eq '3') '470 again: nothing changes (the record kept, the guards replaced in place)'
    $subj = Q "SELECT string_agg(public.inlet_subject_ok(s)::text, ',' ORDER BY o) FROM (VALUES (1, '$A'), (2, 'operator'), (3, 'Operator'), (4, 'service:x'), (5, 'SYSTEM:y'), (6, ''), (7, 'a b'), (8, 'https://idp.example/u/1')) v(o, s)"
    Check ($subj -eq 'true,false,false,false,false,false,false,true') "inlet_subject_ok: a subject yes; the literal operator, service/system principals, blank, a space no ($subj)"
    $r1 = PsqlFile (Join-Path $dockerDir 'revert-inlet-stamp.sql') @()
    $r2 = PsqlFile (Join-Path $dockerDir 'revert-inlet-stamp.sql') @()
    $gone = Q "SELECT (to_regclass('public.inlet_connections') IS NULL)::text || '|' || (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg_inlet_stamp%') || '|' || (SELECT count(*) FROM pg_constraint WHERE conname LIKE '%inlet_stamp_owner_ok') || '|' || (to_regprocedure('public.inlet_subject_ok(text)') IS NULL)::text"
    Check ($r1.rc -eq 0 -and $r2.rc -eq 0 -and $gone -eq 'true|0|0|true') "revert, revert again: every slot-470 object is gone ($gone)"
    $null = Q "INSERT INTO public.thoughts (content, metadata, exposure) VALUES ('drill unowned $rand', jsonb_build_object('source', 'mcp', 'exposure', 'ops'), 'ops')"
    $r = PsqlFile (Join-Path $dockerDir 'init-inlet-stamp.sql') @()
    Check ($r.rc -ne 0 -and $r.out -match 'run slot 440' -and (Q "SELECT to_regclass('public.inlet_connections') IS NULL") -eq 't') '470 with an unowned thought still there is refused ("run slot 440 first"), nothing changed'
    $r = PsqlFile (Join-Path $dockerDir 'init-inlet-owner.sql') @()
    $r2 = PsqlFile (Join-Path $dockerDir 'init-inlet-stamp.sql') @()
    $conns = Q "SELECT string_agg(id, ',' ORDER BY id) FROM public.inlet_connections"
    Check ($r.rc -eq 0 -and $r2.rc -eq 0 -and $conns -eq 'gmail,vault' -and (Q "SELECT count(*) FROM public.thoughts WHERE user_id IS NULL AND content LIKE 'drill unowned%'") -eq '0') "440 stamps it, then 470 applies and re-seeds the record from 440's ($conns; a PD4 connection is recorded again by its flow)"
  }
} catch {
  Fail "the lab stopped: $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)"
} finally {
  Write-Host '[9] teardown'
  foreach ($c in $made.containers) { $null = Dk rm -f -v $c }
  if ($made.net) { $null = Dk network rm $net }
  if (-not $KeepImage) { foreach ($im in $made.images) { $null = Dk rmi -f $im } }
  if (Test-Path $work) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}').Trim()
  $leftNet = (Dk network ls --filter "label=$label" --format '{{.Name}}').Trim()
  $leftVol = (Dk volume ls --filter "label=$label" --format '{{.Name}}').Trim()
  $leftImg = if ($KeepImage) { '' } else { (Dk images --filter "label=$label" --format '{{.Repository}}:{{.Tag}}').Trim() }
  Check ($left -eq '' -and $leftNet -eq '' -and $leftVol -eq '' -and $leftImg -eq '') "nothing labelled $Id is left (containers '$left', networks '$leftNet', volumes '$leftVol', images '$leftImg')"
  $localAfter = LocalSnapshot
  Check ((Compare-Object $localBefore $localAfter | Measure-Object).Count -eq 0) 'no :local image changed'
}
if ($script:fail -eq 0) { Write-Host "== ALL PASSED ($mode)  evidence: $Evidence"; exit 0 }
Write-Host "== FAILED ($($script:fail))  evidence: $Evidence"; exit 1
