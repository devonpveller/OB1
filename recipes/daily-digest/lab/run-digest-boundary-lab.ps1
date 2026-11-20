# run-digest-boundary-lab.ps1 - rw-boundary-digest's disposable lab (plan 09 PD0c: the digest through the request
# boundary).
#
#   powershell -NoProfile -File OB1\recipes\daily-digest\lab\run-digest-boundary-lab.ps1 [-Id <owner id>] [-Evidence <dir>]
#       [-Red [-BaseSha 116b80e]] [-RedShare [-BaseSha 7a25233]] [-RedStamp [-BaseSha 0f4c680]] [-SkipPodcastGate] [-KeepImage]
#   -RedStamp (rw-inlet-stamp, plan 08 PD2): the pre-PD2 digest (OB1 0f4c680: 440 + 460, no 470) - the e2e passes only if
#   the second mailbox's email (connection gmail-b, user BEE) reaches the OWNER's run; GREEN must show it nowhere
#   -RedShare (round 2, tester F1): the item's round-1 code (OB1 7a25233) - the e2e passes only if the meeting / Drive
#   codes of the share links reach shared rows there (the leak attempt 1 found); GREEN must show none
#
# What it does, and ONLY this:
#   1. stages the code under test: GREEN = this checkout's research service + digest; RED (-Red) = a git archive of
#      OB1 <BaseSha> (the development pin), plus two LAB SEAMS copied in from this checkout and nothing else: the
#      digest's gmail-fetch.ts (GMAIL_API_BASE: the Gmail stub instead of Google; one line) and this item's test files
#      (boundary-digest.e2e.test.ts, fixtures/digest-lab-pages.ts) - so RED runs today's digest and research service
#   2. stages that code's initdb chain from its docker-compose.yml
#   3. ONE internal bridge network on a documentation range (203.0.113.0/24, else 198.51.100.0/24: the lab's pages must
#      resolve to an address the boundary's resolver judges public - rw-boundary-core TF6; a private range makes every
#      link non-public and is refused here), every container and the network labelled ai-stack.harness.owner=<Id>
#   4. builds the research service's test stage as openbrain-research-test:wt-<id> (NEVER :local; the build runs the
#      offline suite)
#   5. the lab: the database (the chain; ob_app_memory as production has it; 420 and 460 re-run for their grants), the
#      public pages (alias news.example.org), a real PostgREST (anon = service_role, as compose), and the test
#      container running boundary-digest.e2e.test.ts with the digest mounted read-only at /digest: the real research
#      service, the real link-enrich.ts (a dry run, then --commit --audio), the stubs, the sweep
#   6. GREEN only, unless -SkipPodcastGate: the podcast image's own gate (its Dockerfile `test` stage: the podcast unit
#      tests, the notices check and the chain e2e with the real ffmpeg) built as openbrain-podcast-test:wt-<id>
#   7. tears down exactly what it created and verifies nothing labelled <Id> is left and no :local image changed
# Seeded mail only (no real Gmail, no outbound email, no Google API); inference only through the lab's LiteLLM-shaped
# stub. It never touches the live stack: no compose, no ai-stack_* / open-brain_* network, no host port, no live DB.
# Exit code 0 = every check passed (RED: the leaks were reproduced).
param(
  [string]$Id = 'wt-rw-boundary-digest',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
  [string]$Evidence = '',
  [switch]$Red,
  [switch]$RedShare,
  [switch]$RedStamp,
  [string]$BaseSha = '',
  [switch]$SkipPodcastGate,
  [switch]$KeepImage
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$label = "ai-stack.harness.owner=$Id"
$recipe = Split-Path -Parent $PSScriptRoot
$ob1 = Split-Path -Parent (Split-Path -Parent $recipe)
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rwdg-net-$rand"; $db = "rwdg-db-$rand"; $pages = "rwdg-pages-$rand"; $rest = "rwdg-rest-$rand"
$short = ($Id -replace '^wt-', '')
$testTag = "openbrain-research-test:wt-$short"
$podTag = "openbrain-podcast-test:wt-$short"
if ($testTag -match ':local$' -or $podTag -match ':local$') { throw 'refusing a :local tag' }
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
if (@($Red, $RedShare, $RedStamp | Where-Object { $_ }).Count -gt 1) { throw '-Red, -RedShare or -RedStamp, one at most' }
$base = $Red -or $RedShare -or $RedStamp
if (-not $BaseSha) { $BaseSha = if ($RedShare) { '7a25233' } elseif ($RedStamp) { '0f4c680' } else { '116b80e' } }
$mode = if ($Red) { 'red' } elseif ($RedShare) { 'red-share' } elseif ($RedStamp) { 'red-stamp' } else { 'green' }
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "rwdg-evidence-$mode-$rand" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$work = Join-Path $env:TEMP "rwdg-work-$rand"

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
function Get-Chain([string]$dockerDir) {
  $cf = Join-Path $dockerDir 'docker-compose.yml'
  $compose = (@(Get-Content $cf) | ForEach-Object { $_ -replace '(^|\s)#.*$', '' }) -join "`n"
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  return , @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
}
function LocalSnapshot { (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim() -split "`r?`n" | Sort-Object }

Write-Host "== rw-boundary-digest disposable run  mode=$mode  owner=$Id  net=$net  evidence=$Evidence"
$null = Dk version --format '{{.Server.Version}}'
if ($script:rc -ne 0) { Write-Host 'docker is not reachable'; exit 2 }
$localBefore = LocalSnapshot
$made = @{ net = $false; containers = @(); images = @() }

try {
  Write-Host "[1] the code under test ($mode)"
  New-Item -ItemType Directory -Force $work | Out-Null
  if ($base) {
    $tar = Join-Path $work 'base.tar'
    & git -C $ob1 archive --format=tar -o $tar $BaseSha integrations/research-service integrations/intake recipes/daily-digest docker
    Check ($LASTEXITCODE -eq 0) "git archive of OB1 $BaseSha"
    & tar -x -f $tar -C $work
    Remove-Item $tar -Force
    $rsDir = Join-Path $work 'integrations\research-service'; $dgDir = Join-Path $work 'recipes\daily-digest'; $dockerDir = Join-Path $work 'docker'
    # the two lab seams (and nothing else): the Gmail stub's base URL, and this item's test files
    Copy-Item (Join-Path $recipe 'src\enrich\gmail-fetch.ts') (Join-Path $dgDir 'src\enrich\gmail-fetch.ts') -Force
    Copy-Item (Join-Path $ob1 'integrations\research-service\boundary-digest.e2e.test.ts') $rsDir -Force
    Copy-Item (Join-Path $ob1 'integrations\research-service\fixtures\digest-lab-pages.ts') (Join-Path $rsDir 'fixtures') -Force
    $seam = (& git -C $ob1 diff --no-index --stat -- (Join-Path $work 'recipes\daily-digest\src\enrich\gmail-fetch.ts') (Join-Path $recipe 'src\enrich\gmail-fetch.ts') 2>&1 | Out-String)
    Save 'red-seams.txt' "base $BaseSha; seams copied in: recipes/daily-digest/src/enrich/gmail-fetch.ts (GMAIL_API_BASE), integrations/research-service/boundary-digest.e2e.test.ts, fixtures/digest-lab-pages.ts`n$seam"
  } else {
    $rsDir = Join-Path $ob1 'integrations\research-service'; $dgDir = $recipe; $dockerDir = Join-Path $ob1 'docker'
  }
  Write-Host '[2] the initdb chain, derived from docker-compose.yml'
  $stage = Join-Path $work 'initdb'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = Get-Chain $dockerDir
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  $staged = @(Get-ChildItem $stage -Filter *.sql).Count
  Check ($chain.Count -ge 50 -and $staged -eq $chain.Count) "staged $staged of $($chain.Count) migrations"
  Check (@($chain | Where-Object { $_[1] -eq '420-init-request-boundary.sql' }).Count -eq 1) 'the chain mounts 420 (rw-boundary-core)'
  $has460 = @($chain | Where-Object { $_[1] -eq '460-init-boundary-digest.sql' }).Count -eq 1
  if ($Red) { Check (-not $has460) 'RED: the base chain has no 460' } else { Check $has460 'the chain mounts 460-init-boundary-digest.sql (rw-boundary-digest)' }

  Write-Host '[3] disposable internal network (a documentation range)'
  $sub = ''
  foreach ($s in @('203.0.113.0/24', '198.51.100.0/24')) {
    $null = Dk network create --driver bridge --internal --subnet $s --label $label $net
    if ($script:rc -eq 0) { $sub = $s; break }
  }
  Check ($sub -ne '') "network $net created (bridge, internal, labelled, --subnet $sub)"
  if ($sub -eq '') { throw 'network: neither documentation range is free (a private range would make every lab link non-public)' }
  $made.net = $true

  Write-Host "[4] build $testTag (the build runs the offline suite)"
  $o = Dk build --no-cache --progress=plain --target test --label $label -t $testTag $rsDir
  Save 'research-test-build.log' $o
  Check ($script:rc -eq 0) "image $testTag built"
  if ($script:rc -eq 0) { $made.images += $testTag } else { throw 'build' }
  $sum = Summary $o
  Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0) "the build ran the offline suite: $($sum.Value)"

  Write-Host '[5] the lab: database, pages, PostgREST, the digest run and the sweep'
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
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN CREATE ROLE ob_app_memory LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE service_role; END IF; END `$`$; ALTER ROLE ob_app_memory LOGIN PASSWORD '$appPw'"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role) - the production shape'
  # the grants of 420 (and 460) are ob_app_memory's: re-run after the role exists (420 first: its re-run replaces 460's
  # allow-list, so 460 goes again after it - the deploy order the test plan names)
  $reruns = @('init-request-boundary.sql'); if (-not $Red) { $reruns += 'init-boundary-digest.sql' }
  foreach ($f in $reruns) {
    $null = Dk cp (Join-Path $dockerDir $f) "${db}:/tmp/$f"
    $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -f "/tmp/$f"
    Check ($script:rc -eq 0) "$f re-run after ob_app_memory exists (the grants)$(if ($script:rc) { ': ' + $o })"
  }
  $o = Dk run -d --name $pages --label $label --network $net --network-alias news.example.org `
    --network-alias meet.google.com --network-alias drive.google.com --network-alias docs.google.com --network-alias sites.google.com `
    --network-alias calendar.google.com --network-alias zoom.us --network-alias teams.microsoft.com --network-alias www.dropbox.com `
    --network-alias files.example.org -e PORT=8080 $testTag deno run --allow-net --allow-env --allow-read fixtures/digest-lab-pages.ts
  if ($script:rc -eq 0) { $made.containers += $pages } else { Fail "the pages container did not start: $o" }
  $o = Dk run -d --name $rest --label $label --network $net -e "PGRST_DB_URI=postgres://postgres:$pw@${db}:5432/openbrain" -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=service_role -e PGRST_SERVER_PORT=3000 $PgrstImage
  if ($script:rc -eq 0) { $made.containers += $rest } else { Fail "PostgREST did not start: $(($o -replace [regex]::Escape($pw), '***'))" }
  Start-Sleep -Seconds 6
  $ev = Join-Path $Evidence 'run'
  New-Item -ItemType Directory -Force $ev | Out-Null
  $o = Dk run --rm --label $label --network $net -v "${dgDir}:/digest:ro" -v "${ev}:/evidence" `
    -e "BND_DG_DB_HOST=$db" -e "BND_DG_DB_PASSWORD=$pw" -e "BND_DG_APP_PASSWORD=$appPw" -e "BND_DG_PGRST=http://${rest}:3000" `
    -e BND_DG_DIGEST_DIR=/digest -e BND_DG_PAGES_PORT=8080 -e "BND_DG_MODE=$mode" -e NO_COLOR=1 `
    $testTag deno test --unstable-net --allow-all boundary-digest.e2e.test.ts
  $o = $o -replace [regex]::Escape($pw), '***' -replace [regex]::Escape($appPw), '***'
  Save "digest-e2e-$mode.log" $o
  foreach ($l in ($o -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(dry run|commit run|jobs|sweep|private|shared|brief|hand-backs|RED):|^(egress|second user|podcast_episodes)' }) { Write-Host "    $l" }
  $sum = Summary $o
  Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[3].Value -eq '0' -and [int]$sum.Groups[2].Value -ge 2) "digest e2e ($mode): $($sum.Value)"

  if (-not $base) {
    Write-Host '[5b] slot 460: the structural checks, then the drill (revert, revert again, init, init again, revert, init)'
    $null = Dk cp (Join-Path $PSScriptRoot 'boundary-digest-460-check.sql') "${db}:/tmp/460-check.sql"
    $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -f /tmp/460-check.sql
    Save '460-check.txt' $o
    $n = @(($o -split "`n") | Where-Object { $_ -match '460-check: .* ok$' }).Count
    Check ($script:rc -eq 0 -and $n -ge 6) "the 460 checks: $n ok$(if ($script:rc) { ' - ' + (($o -split "`n") | Select-String 'FAILED|ERROR' | Select-Object -First 2) })"
    function Q([string]$sql) { $r = Dk exec $db psql -U postgres -d openbrain -X -A -t -c $sql; return "$r".Trim() }
    $defSql = "SELECT md5(pg_get_functiondef('public.request_boundary_options_ok(jsonb,boolean)'::regprocedure))"
    $md5_460 = Q $defSql
    $md5_420 = Q "SELECT md5(def) FROM public.research_boundary_digest_saved WHERE fn = 'public.request_boundary_options_ok(jsonb,boolean)'"
    $tr = Q "SELECT count(*) FROM public.podcast_episodes WHERE transcript IS NOT NULL"
    $epMd5 = Q "SELECT md5(coalesce(string_agg(to_jsonb(e)::text, '|' ORDER BY id), '')) FROM (SELECT id, owner_sub, shared, origin, title, team_id, audio_format, seconds, archive_dir, request_id, created_at FROM public.podcast_episodes) e"
    Check ($md5_420 -match '^[0-9a-f]{32}$' -and $md5_420 -ne $md5_460) "460 saved 420's allow-list ($md5_420) and replaced it ($md5_460); transcripts on episode rows: $tr"
    $dr = Join-Path $dockerDir 'revert-boundary-digest.sql'; $di = Join-Path $dockerDir 'init-boundary-digest.sql'
    $null = Dk cp $dr "${db}:/tmp/r460.sql"; $null = Dk cp $di "${db}:/tmp/i460.sql"
    $drill = @()
    foreach ($step in @('revert', 'revert again', 'init', 'init again', 'revert 2', 'init 2')) {
      $f = if ($step -like 'revert*') { '/tmp/r460.sql' } else { '/tmp/i460.sql' }
      $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -f $f
      $rc = $script:rc
      $cur = Q $defSql
      $col = Q "SELECT count(*) FROM information_schema.columns WHERE table_name='podcast_episodes' AND column_name='transcript'"
      $fn = Q "SELECT to_regprocedure('public.handback_deliver(uuid,text,boolean,jsonb)') IS NOT NULL"
      $want = if ($step -like 'revert*') { $md5_420 } else { $md5_460 }
      $wantCol = if ($step -like 'revert*') { '0' } else { '1' }
      $okStep = ($rc -eq 0 -and $cur -eq $want -and $col -eq $wantCol -and $fn -eq $(if ($step -like 'revert*') { 'f' } else { 't' }))
      $drill += "[$step] exit $rc allow-list md5 $cur (want $want) transcript column $col handback_deliver $fn :: $((($o -split "`n") | Where-Object { $_ -match 'NOTICE' }) -join ' ; ')"
      Check $okStep "drill [$step]"
    }
    $arch = Q "SELECT count(*) FROM public.research_boundary_digest_archive WHERE tbl = 'public.podcast_episodes'"
    $epMd5After = Q "SELECT md5(coalesce(string_agg(to_jsonb(e)::text, '|' ORDER BY id), '')) FROM (SELECT id, owner_sub, shared, origin, title, team_id, audio_format, seconds, archive_dir, request_id, created_at FROM public.podcast_episodes) e"
    Check ($arch -eq $tr -and [int]$tr -ge 1) "the first revert archived the $tr transcript(s) before dropping the column (archive rows: $arch)"
    Check ($epMd5 -eq $epMd5After) "every other column of podcast_episodes is untouched by the drill (md5 $epMd5)"
    Save 'drill-460.txt' ($drill -join "`n")
  }

  if (-not $base -and -not $SkipPodcastGate) {
    Write-Host "[6] the podcast image's own gate: $podTag (--target test: podcast unit tests, notices, chain e2e with the real ffmpeg)"
    $o = Dk build --progress=plain --target test --label $label -t $podTag $dgDir
    Save 'podcast-gate-build.log' $o
    Check ($script:rc -eq 0 -and $o -match 'podcast image gate: OK') 'the podcast image gate passed'
    if ($script:rc -eq 0) { $made.images += $podTag }
  }
} finally {
  Write-Host '[7] teardown'
  foreach ($c in $made.containers) { $null = Dk rm -f -v $c }
  if ($made.net) { $null = Dk network rm $net }
  if (-not $KeepImage) { foreach ($im in $made.images) { $null = Dk rmi -f $im } }
  if (Test-Path $work) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}').Trim()
  $leftNet = (Dk network ls --filter "label=$label" --format '{{.Name}}').Trim()
  $leftVol = (Dk volume ls --filter "label=$label" --format '{{.Name}}').Trim()
  Check ($left -eq '' -and $leftNet -eq '' -and $leftVol -eq '') "nothing labelled $Id is left (containers '$left', networks '$leftNet', volumes '$leftVol')"
  $anon = @(Dk volume ls -q --filter dangling=true) | Where-Object { $_ }
  Save 'dangling-volumes-after.txt' (($anon -join "`n"))
  $localAfter = LocalSnapshot
  Check ((Compare-Object $localBefore $localAfter | Measure-Object).Count -eq 0) 'no :local image changed'
}
if ($script:fail -eq 0) { Write-Host "== ALL PASSED ($mode)  evidence: $Evidence"; exit 0 }
Write-Host "== FAILED ($($script:fail))  evidence: $Evidence"; exit 1
