# run-wiki-guarded-lab.ps1 - the disposable lab for research-workbench rw-wiki-guarded-pages: a page a privacy guard
# REFUSES (slots 380 / 390 / 430 / 440 raise 42501 for a note) is withheld cleanly - by the real writer, the next cycle's
# retry and the viewer's reconcile repair - and the viewer stays green; no guard is loosened.
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-wiki-guarded-lab.ps1 -Subnet <x.y.z.0/24> [-Evidence <dir>] [-Red] [-BaseSha 310b865]
#
# -Red runs the SAME checks with the base's writer, reconcile and viewer (-BaseSha): the writer / viewer / cleanup checks must
# FAIL there. The guard checks are the database's and must pass in BOTH runs; their own red is the loosened-guard mutants
# (each guard trigger disabled in turn: the check must catch it).
#
# Lab rules (as run-workspace-tests.ps1): one --internal network on the pinned subnet, :wt-<id> image tags only (the viewer,
# built from this tree or the base), no published port, no :local image, no ai-stack_* / open-brain_* name, synthetic seed
# data only, every container labelled ai-stack.harness.owner=<Id> and removed at the end, a leftover check. Never touches
# the live stack.
#   1. the REAL initdb chain of this tree (its *.sql are byte-identical to -BaseSha: this change touches no guard)
#   2. db + PostgREST + openbrain-rest (Caddy) + the viewer (:wt, the vault read-only, a 5 s reconcile)
#   3. plant (superuser, triggers off for the plant only): a private thought of lab-owner-a (440), an archived idea thought
#      (380), a withheld page's text (440), a moved report source (390) - each carrying the marker
#   4. [guards] the same planted text: as a note refused, as a compiled page withheld, by every guard; then each guard
#      trigger disabled in turn - the check must go red for that guard (a loosened guard is caught)
#   5. [writer] the real writer: compile flush, retry, viewer-style repair (and 390 through the writer)
#   6. [viewer] /__health green with a withheld page's file present; two identities: no route shows the marker
#   7. [regression] a genuinely missing page turns the viewer red; removed, green again
#   8. [cleanup] an old refused file (left by the old writer) moved to a backup folder, the viewer green; the revert puts it back
#   9. the owner's private rows are byte-identical (md5) from the plant to the end
param(
  [string]$Id = 'wt-rw-wiki-guarded-pages',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
  [string]$CaddyImage = 'caddy:2-alpine',
  [string]$NodeImage = 'node:22-slim',
  [string]$BaseSha = '310b865',
  [switch]$Red
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
$short = ($Id -replace '^wt-', '')
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$P = "rwgp-$rand"
$net = "$P-net"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$MARK = 'labmark' + (-join ((97..122) | Get-Random -Count 10 | ForEach-Object { [char]$_ }))
$viewerTag = if ($Red) { "openbrain-wiki-viewer:wt-$short-base" } else { "openbrain-wiki-viewer:wt-$short" }
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$vault = Join-Path $env:TEMP "$P-vault"
$script:fail = 0
$script:made = @{ net = $false; containers = @(); dirs = @($stage, $vault); images = @() }
$script:res = [ordered]@{}

function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
# a check of THIS change: with -Red a FAIL is the expected result (RED-OK)
function Fix([string]$id, [bool]$ok, [string]$m) {
  $script:res[$id] = $ok
  if ($Red) { if (-not $ok) { Write-Host "  RED-OK  [$id] $m" } else { Write-Host "  RED-UNEXPECTED-PASS  [$id] $m"; $script:fail++ } }
  else { Check $ok "[$id] $m" }
}
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false)) }

# -- the lab docker shim (as run-privacy-hardening-lab.ps1; a build is allowed only to a :wt-<short> tag) ------------
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
    if ($x -match '(^|[/=])[^ ]*:local$' -and $a[0] -notin @('images', 'image')) { return "a :local image ($x)" }
  }
  if ($all -match 'macvlan|ipvlan') { return 'a macvlan / ipvlan driver' }
  if ($a.Count -ge 2 -and $a[0] -eq 'network' -and $a[1] -eq 'create') {
    if ($a -notcontains '--internal') { return 'a network that is not --internal' }
    if (($a -join ' ') -notmatch [regex]::Escape("--subnet $($subnets.run)")) { return 'a network not on the pinned subnet' }
  }
  if ($a.Count -and $a[0] -eq 'build') {
    $ti = [array]::IndexOf($a, '-t')
    if ($ti -lt 0 -or $a[$ti + 1] -notmatch ":wt-$([regex]::Escape($short))(-base)?$") { return 'a build that is not tagged :wt-<id>' }
  }
  return ''
}
function Lab-Docker([int]$TimeoutSec, [string[]]$a) {
  $why = Test-LabDockerArgs $a
  if ($why) { Write-Host "  SHIM REFUSED: $why :: docker $($a -join ' ')"; $script:rc = 2; $script:fail++; return "REFUSED: $why" }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'docker'
  $psi.Arguments = ($a | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { try { $p.Kill() } catch { }; $script:rc = 124; return "TIMEOUT after ${TimeoutSec}s" }
  $p.WaitForExit()
  $script:rc = $p.ExitCode
  return (($out.Result + $err.Result) -replace "`r", '').TrimEnd()
}
function Dk { Lab-Docker 300 ([string[]]$args) }
$shimCases = @(@('run', '-p', '8080:8080', 'x'), @('run', '--network', 'ai-stack_app-net', 'x'), @('network', 'create', 'n'), @('run', 'x:local'), @('compose', 'up'), @('build', '-t', 'x:local', '.'))
Check (@($shimCases | Where-Object { Test-LabDockerArgs $_ }).Count -eq $shimCases.Count) 'the lab docker shim refuses every forbidden shape'
$localBefore = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim()

function Run-Detached([string]$name, [string[]]$extra) {
  $o = Dk run -d --name $name --label $label --network $net @extra
  if ($script:rc -ne 0) { Fail "$name did not start: $o"; return $false }
  $script:made.containers += $name
  return $true
}
function Tree-At([string]$sha) {
  $tree = Join-Path $env:TEMP "$P-tree-$sha"
  New-Item -ItemType Directory -Force $tree | Out-Null
  $script:made.dirs += $tree
  $tar = Join-Path $env:TEMP "$P-$sha.tar"
  & git -C $ob1 archive --format=tar -o $tar $sha docker/wiki-viewer recipes/_shared
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $tar -C $tree
  Remove-Item -Force $tar
  return $tree
}
function Node-Run([string]$what, [string[]]$envs, [string]$shared, [string]$script, [int]$t = 300) {
  $a = @('run', '--rm', '--label', $label, '--network', $net, '-v', "${shared}:/shared:ro", '-v', "${vault}:/vault", '-v', "${ct}:/ct:ro",
    '-e', 'SHARED=/shared', '-e', 'WIKI_GIT_DIR=/vault', '-e', 'OPEN_BRAIN_URL=http://openbrain-rest', '-e', "MARK=$MARK", '-e', "TAG=$rand")
  foreach ($e in $envs) { $a += @('-e', $e) }
  $a += @('--entrypoint', 'node', $NodeImage) + @($script -split ' ')
  $o = Lab-Docker $t $a
  Save "$what.log" ((($o -split "`n") | Where-Object { $_ -match '^PROBE |^\[withheld-cleanup\]' }) -join "`n")
  return $o
}
function Probe-Json([string]$o) {
  $l = (($o -split "`n") | Where-Object { $_ -match '^PROBE ' } | Select-Object -Last 1)
  Write-Host "    $l"
  if (-not $l) { return $null }
  try { return $l.Substring(6) | ConvertFrom-Json } catch { return $null }
}
function Health {
  $o = Lab-Docker 60 @('run', '--rm', '--label', $label, '--network', $net, '--entrypoint', 'node', $NodeImage, '-e',
    "fetch('http://$P-viewer:8080/__health').then(r=>r.json()).then(j=>console.log('H '+JSON.stringify({s:j.status,d:j.reconcile&&j.reconcile.drift,m:j.reconcile&&j.reconcile.missing?j.reconcile.missing.length:null,c:j.reconcile&&j.reconcile.checkedAt,reasons:(j.reasons||[]).map(x=>String(x).slice(0,80))}))).catch(e=>console.log('H '+JSON.stringify({error:String(e.message||e)})))")
  $l = (($o -split "`n") | Where-Object { $_ -match '^H ' } | Select-Object -Last 1)
  if (-not $l) { return $null }
  try { return $l.Substring(2) | ConvertFrom-Json } catch { return $null }
}

# the viewer's health from a reconcile pass that ran AFTER $since (the lab database's clock = the docker VM's, as the viewer's);
# a report from before the step it judges never counts (RED run 2 read the pass from before the writer ran)
function Now-Iso { $t = "(clock_timestamp() AT TIME ZONE 'UTC')"; return (Q1 "SELECT to_char($t, 'YYYY-MM-DD') || 'T' || to_char($t, 'HH24:MI:SS.MS') || 'Z'").Trim() }
function Fresh-Health([string]$since, [int]$tries = 40) {
  $h = $null
  for ($i = 0; $i -lt $tries; $i++) { Start-Sleep -Seconds 3; $h = Health; if ($h -and $h.c -and ([string]$h.c).CompareTo($since) -gt 0) { return $h } }
  return $null
}
try {
  Write-Host "== rw-wiki-guarded-pages lab  owner=$Id  net=$net  red=$([bool]$Red)  evidence=$Evidence"
  if ($Red) { $tree = Tree-At $BaseSha; $sharedDir = Join-Path $tree 'recipes\_shared'; $viewerDir = Join-Path $tree 'docker\wiki-viewer'; $recCtx = Join-Path $tree 'recipes' }
  else { $sharedDir = Join-Path $ob1 'recipes\_shared'; $viewerDir = Join-Path $dockerDir 'wiki-viewer'; $recCtx = Join-Path $ob1 'recipes' }
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()

  Write-Host '[1] the initdb chain (this tree; its guards are the base''s byte for byte)'
  & git -C $ob1 diff --quiet $BaseSha -- 'docker/*.sql'
  Check ($LASTEXITCODE -eq 0) "no *.sql of docker/ differs from $BaseSha (no guard is changed by this tree)"
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check (@($chain | Where-Object { $_[1] -in @('380-init-idea-privacy.sql', '390-init-report-isolation.sql', '430-init-privacy-hardening.sql', '440-init-inlet-owner.sql') }).Count -eq 4) "the chain mounts 380, 390, 430 and 440 ($($chain.Count) migrations)"

  Write-Host '[2] the network, the database, PostgREST, openbrain-rest, the viewer image'
  $null = Dk network create --driver bridge --internal --subnet $subnets.run --label $label $net
  Check ($script:rc -eq 0) "network $net (internal, $($subnets.run))"
  if ($script:rc -ne 0) { throw 'network' }
  $script:made.net = $true
  $db = "$P-db"
  if (-not (Run-Detached $db @('--network-alias', 'openbrain-db', '-e', "POSTGRES_PASSWORD=$pw", '-e', 'POSTGRES_DB=openbrain', '-v', "${stage}:/docker-entrypoint-initdb.d:ro", $PgImage))) { throw 'db' }
  for ($i = 0; $i -lt 150; $i++) { if ((Dk logs $db) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $logs = Dk logs $db
  Check ($logs -match 'PostgreSQL init process complete') 'the database ran the initdb chain'
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "initdb logged no ERROR ($($errs.Count))"
  $null = Run-Detached "$P-postgrest" @('--network-alias', 'openbrain-postgrest', '-e', "PGRST_DB_URI=postgres://postgres:$pw@openbrain-db:5432/openbrain",
      '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=service_role', '-e', 'PGRST_DB_POOL=4', '-e', 'PGRST_SERVER_PORT=3000', $PgrstImage)
  $null = Run-Detached "$P-rest" @('--network-alias', 'openbrain-rest', '-v', "$(Join-Path $dockerDir 'Caddyfile'):/etc/caddy/Caddyfile:ro", $CaddyImage)
  $bo = Lab-Docker 1500 @('build', '--label', $label, '--build-arg', "OB1_SHA=$(if ($Red) { $BaseSha } else { $sha })", '--build-context', "recipes=$recCtx", '-t', $viewerTag, $viewerDir)
  Save 'build-viewer.log' (($bo -split "`n") | Select-Object -Last 80 | Out-String)
  Check ($script:rc -eq 0) "$viewerTag built from $(if ($Red) { "OB1 $BaseSha" } else { 'this tree' }) (its build gate runs the renderer's node tests)"
  if ($script:rc -ne 0) { throw 'build viewer' }
  $script:made.images += $viewerTag
  function Q1([string]$q) { $r = Dk exec $db psql -U postgres -d openbrain -X -tA -v ON_ERROR_STOP=1 -c $q; return (($r -replace "`r", '') -split "`n" | Where-Object { $_ -ne '' -and $_ -notmatch '^(INSERT|UPDATE|DELETE|DO|SET|BEGIN|COMMIT)\b' }) -join "`n" }

  Write-Host '[3] the plant (synthetic; the marker in every private text)'
  $rep = [guid]::NewGuid().ToString()
  $text = "lab withheld page text $MARK that an owner keeps private and the shared wiki must never show"
  $plant = @"
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO public.thoughts (id, content, exposure, user_id) VALUES (990001, 'lab private thought $MARK', 'ops', 'lab-owner-a');
INSERT INTO public.idea_thought_archive (id, content, exposure, screen_verdict, archive_owner_sub) VALUES (990002, 'lab idea thought $MARK', 'ops', 'unscreened', 'lab-owner-a');
INSERT INTO public.inlet_owner_withheld_pages (page_ref, n_chunks, whole_hash) VALUES (990003, 0, md5(public.inlet_owner_norm('$text')));
INSERT INTO public.research_report_isolation_archive (batch, source_id, tbl, col, action, row_data) VALUES (gen_random_uuid(), '$rep', 'public.sources', 'id', 's', '{}');
COMMIT;
"@
  $pf = Join-Path $env:TEMP "$P-plant.sql"
  [System.IO.File]::WriteAllText($pf, $plant, (New-Object System.Text.UTF8Encoding $false))
  $script:made.dirs += $pf
  $null = Dk cp $pf "${db}:/tmp/plant.sql"
  $po = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/plant.sql
  Check ($script:rc -eq 0) "the plant landed ($(($po -split "`n" | Where-Object { $_ -match 'ERROR' }) -join ' '))"
  $ownerSql = "SELECT md5(coalesce((SELECT row_to_json(t)::text FROM public.thoughts t WHERE id = 990001), '') || coalesce((SELECT row_to_json(a)::text FROM public.idea_thought_archive a WHERE id = 990002), '') || coalesce((SELECT row_to_json(p)::text FROM public.inlet_owner_withheld_pages p WHERE page_ref = 990003), '') || coalesce((SELECT string_agg(row_to_json(r)::text, '') FROM public.research_report_isolation_archive r WHERE source_id = '$rep'), ''))"
  $ownerBefore = Q1 $ownerSql
  $fnSql = "SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.proname)) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('trg_idea_privacy_wiki_guard', 'trg_report_isolation_wiki_guard', 'trg_inlet_owner_wiki_guard', 'idea_privacy_page_links_idea', 'report_isolation_page_shows_report', 'inlet_owner_page_private', 'inlet_owner_text_withheld', 'wiki_guard_mark_withheld')"
  $fnBefore = Q1 $fnSql
  $trgSql = "SELECT string_agg(tgname || ':' || tgenabled::text, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.wiki_pages'::regclass AND NOT tgisinternal"
  $trgBefore = Q1 $trgSql
  Write-Host "    guard functions md5 $fnBefore; triggers $trgBefore"
  Check ($fnBefore -match '^[0-9a-f]{32}$' -and $trgBefore -match '^trg_idea_privacy_wiki_guard:O,trg_inlet_owner_wiki_guard:O,trg_report_isolation_wiki_guard:O') "the guard functions and the three guard triggers are read (all ON: $trgBefore)"
  $penv = @("IDEA_THOUGHT=990002", "PRIV_THOUGHT=990001", "REPORT_SOURCE=$rep", "WITHHELD_TEXT=$text")

  Write-Host '[4] [guards] the same planted text against every guard; each guard loosened in turn must be caught'
  $g = Probe-Json (Node-Run 'guards' ($penv + @('MODE=guards')) $sharedDir '/ct/wiki-guarded-probe.mjs')
  $allOn = $g -and $g.rowsLanded -eq 0 -and @('idea', 'report', 'priv', 'text' | Where-Object { -not $g.guards.$_.noteRefused -or -not $g.guards.$_.compiledWithheld }).Count -eq 0
  Check $allOn 'every guard still refuses the planted text as a note (42501, the one message) and withholds it as a compiled page (X-Wiki-Withheld 1, no row): no guard is loosened'
  foreach ($mut in @(@('trg_idea_privacy_wiki_guard', 'idea'), @('trg_report_isolation_wiki_guard', 'report'), @('trg_inlet_owner_wiki_guard', 'priv'))) {
    $null = Q1 "ALTER TABLE public.wiki_pages DISABLE TRIGGER $($mut[0])"
    $gm = Probe-Json (Node-Run "guards-mutant-$($mut[1])" ($penv + @('MODE=guards', "TAG=m$($mut[1])$rand")) $sharedDir '/ct/wiki-guarded-probe.mjs')
    $null = Q1 "ALTER TABLE public.wiki_pages ENABLE TRIGGER $($mut[0])"
    $caught = $gm -and (-not $gm.guards.($mut[1]).noteRefused -or -not $gm.guards.($mut[1]).compiledWithheld)
    Check $caught "MUTANT: with $($mut[0]) disabled the guard check goes RED for '$($mut[1])' (a loosened guard is caught)"
    $null = Q1 "DELETE FROM public.wiki_pages WHERE slug LIKE 'content/%/lab-m$($mut[1])$rand/%' OR slug LIKE 'content/topic/g-%-m$($mut[1])$rand'"
  }
  Check ((Q1 $trgSql) -eq $trgBefore) "every guard trigger is back ON as before ($(Q1 $trgSql))"

  Write-Host '[5] [writer] the real writer meets the refusal: compile flush, retry, viewer-style repair'
  New-Item -ItemType Directory -Force (Join-Path $vault 'content') | Out-Null
  $null = Run-Detached "$P-viewer" @('--network-alias', 'openbrain-wiki-viewer', '-e', 'OPEN_BRAIN_URL=http://openbrain-rest', '-e', 'WIKI_NAV_MIN_ROWS=0',
      '-e', 'WIKI_BUILDER=0', '-e', 'WIKI_DB_TCP=openbrain-db:5432', '-e', 'WIKI_DB_PROBE_MS=1000', '-e', 'WIKI_RECONCILE_INTERVAL_MS=5000',
      '-e', 'NODE_OPTIONS=--max-old-space-size=1024', '-e', "WIKI_VIEWER_ALLOWED_HOSTS=$P-viewer", '-v', "${vault}:/wiki:ro", $viewerTag)
  $wr = Probe-Json (Node-Run 'writer' ($penv + @('MODE=writer')) $sharedDir '/ct/wiki-guarded-probe.mjs')
  Fix 'flush' ($wr -and $wr.flush.exit -eq 0 -and $wr.flush.cleanRow -and -not $wr.flush.refusedRow -and -not $wr.flush.refusedFile -and $wr.flush.unsynced -eq 0 -and $wr.flush.recorded) 'compile flush: the refused note is withheld (no row, no file, not unsynced, recorded), the clean note of the same batch lands, exit 0'
  Fix 'retry' ($wr -and $wr.retry.firstLanded -eq 1 -and $wr.retry.cleanRow -and $wr.retry.recordLeft -eq 0 -and $wr.retry.secondRetried -eq 0 -and -not $wr.retry.refusedFile -and $wr.retry.recorded) 'retry: the clean row lands beside the refused one; the refused one leaves the retry record (never retried: the next cycle retries 0), its file out, recorded withheld'
  Fix 'repair' ($wr -and $wr.repair.cleanRow -and $wr.repair.drift -eq 0 -and $wr.repair.withheld -ge 1) 'viewer-style repair (fresh process): the clean missing row is written, the refused one counted withheld, drift 0'
  Fix 'flush390' ($wr -and $wr.flush390.exit -eq 0 -and -not $wr.flush390.refusedFile -and $wr.flush390.unsynced -eq 0) 'the report guard (390) refusal through the writer: withheld, exit 0'
  Check ($wr -and $wr.recordClean -and $wr.logsClean) 'the withheld record and the writer''s log carry no marker and no slug (hashes and counts only)'
  Fix 'log-no-slug' ($wr -and -not $wr.logsNameRefused) 'the writer''s log names no refused page'

  $afterWriter = Now-Iso
  Write-Host '[6] [viewer] health with the withheld page present; two identities on every route'
  $h = Fresh-Health $afterWriter
  Write-Host "    health: $($h | ConvertTo-Json -Compress)"
  Fix 'viewer-green' ($h -and $h.s -eq 'ok' -and $h.d -eq 0) 'the viewer is GREEN (status ok, drift 0) with a refused page''s file in the vault and its slug in the withheld record'
  $slugs = "content/notebooks/lab-$rand/w-refused,content/notebooks/lab-$rand/r-refused,content/notebooks/lab-$rand/v-refused,content/notebooks/lab-$rand/x-refused"
  $rt = Probe-Json (Node-Run 'routes' ($penv + @('MODE=routes', "PROBE_VIEWER=http://$P-viewer:8080", "ROUTE_SLUGS=$slugs")) $sharedDir '/ct/wiki-guarded-probe.mjs')
  Check ($rt -and $rt.routes.checked -ge 20 -and $rt.routes.showMark -eq 0 -and $rt.routes.renderedDb -eq 0) "two identities (owner A, user B), $($rt.routes.checked) route requests: no response shows the marker, no refused page is rendered from a row"
  Fix 'health-names-none' ($rt -and -not $rt.health.namesLab) '/__health names no refused page (the base lists them as missing drift)'

  Write-Host '[7] [regression] a genuinely missing page still turns the viewer red'
  $gm = Join-Path $vault 'content\source\lab-genuinely-missing.md'
  New-Item -ItemType Directory -Force (Split-Path $gm) | Out-Null
  [System.IO.File]::WriteAllText($gm, "---`ntitle: Genuinely missing`n---`nA clean page whose row never landed.`n", (New-Object System.Text.UTF8Encoding $false))
  (Get-Item $gm).LastWriteTime = (Get-Date).AddMinutes(-5)
  $h2 = Fresh-Health (Now-Iso)
  Check ($h2 -and $h2.s -ne 'ok' -and $h2.d -ge 1 -and $h2.m -ge 1) "a missing page that no guard withheld turns the viewer RED (status $($h2.s), drift $($h2.d), missing $($h2.m))"
  Remove-Item -Force $gm
  $h3 = Fresh-Health (Now-Iso)
  Fix 'viewer-green-again' ($h3 -and $h3.s -eq 'ok' -and $h3.d -eq 0) 'the missing page gone, the viewer is green again (the withheld page still present)'

  Write-Host '[8] [cleanup] an old refused file left by the old writer: moved to a backup folder, the revert puts it back'
  $old = Join-Path $vault "content\notebooks\lab-$rand\c-refused.md"
  [System.IO.File]::WriteAllText($old, "---`ntitle: C refused`n---`n$text`n", (New-Object System.Text.UTF8Encoding $false))
  $cl = Node-Run 'cleanup-apply' @() $sharedDir '/shared/withheld-pages-cleanup.mjs --apply --vault /vault --backup /vault/.withheld-backup-lab' 600
  $clLines = (($cl -split "`n") | Where-Object { $_ -match '^\[withheld-cleanup\]' }) -join ' | '
  Write-Host "    $clLines"
  $movedOk = -not (Test-Path $old) -and (Test-Path (Join-Path $vault ".withheld-backup-lab\files\content\notebooks\lab-$rand\c-refused.md"))
  Fix 'cleanup-apply' ($movedOk -and $clLines -match 'apply: (\d+) refused page file' -and [int]$Matches[1] -ge 1 -and $clLines -notmatch [regex]::Escape($MARK) -and $clLines -notmatch 'refused\.md|c-refused') 'the cleanup moved the old refused file(s) out of the served vault into the backup folder; its output is counts only'
  $h4 = Fresh-Health (Now-Iso)
  Fix 'viewer-green-after-cleanup' ($h4 -and $h4.s -eq 'ok' -and $h4.d -eq 0) "after the cleanup the viewer is green (drift $($h4.d))"
  $rv = Node-Run 'cleanup-revert' @() $sharedDir '/shared/withheld-pages-cleanup.mjs --revert --vault /vault --backup /vault/.withheld-backup-lab' 600
  $rvLines = (($rv -split "`n") | Where-Object { $_ -match '^\[withheld-cleanup\]' }) -join ' | '
  Write-Host "    $rvLines"
  Fix 'cleanup-revert' ((Test-Path $old) -and $rvLines -match 'revert: (\d+) file\(s\) put back' -and [int]$Matches[1] -ge 1) 'the revert put the moved file(s) back'

  Write-Host '[9] the owner''s private rows and the guards, from the plant to the end'
  Check ((Q1 $ownerSql) -eq $ownerBefore) "the owner's private rows (thought, idea thought, withheld text, report archive) are byte-identical (md5 $ownerBefore)"
  Check ((Q1 $fnSql) -eq $fnBefore -and (Q1 $trgSql) -eq $trgBefore) 'the guard functions (md5) and triggers are exactly as the chain installed them'
}
catch { Write-Host "  ERROR  $_"; $script:fail++ }
finally {
  Write-Host '== teardown'
  foreach ($c in $script:made.containers) { $null = Dk rm -f -v $c }
  if ($script:made.net) { $null = Dk network rm $net }
  foreach ($im in $script:made.images) { $null = Dk image rm -f $im }
  $left = Dk ps -a --filter "label=$label" --format '{{.Names}}'
  $leftNet = Dk network ls --filter "label=$label" --format '{{.Name}}'
  $leftImg = Dk images --filter "label=$label" --format '{{.Repository}}:{{.Tag}}'
  Check ([string]::IsNullOrWhiteSpace("$left$leftNet$leftImg")) "nothing labelled $Id is left (containers '$left', networks '$leftNet', images '$leftImg')"
  $localAfter = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim()
  if ($localBefore -eq $localAfter) { Pass 'no :local image changed' } else { Write-Host '  WARN  a :local image listing differs from the start (this lab never touches one - the shim refuses it)' }
  foreach ($d in $script:made.dirs) { try { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } catch { } }
  $summary = ($script:res.GetEnumerator() | ForEach-Object { "$($_.Key)=$(if ($_.Value) { 'GREEN' } else { 'RED' })" }) -join ' '
  Save 'summary.txt' "red=$([bool]$Red) base=$BaseSha tree=$sha fail=$($script:fail) :: $summary"
  Write-Host "== $summary"
  if ($script:fail) { Write-Host "== FAIL ($($script:fail))"; exit 1 } else { Write-Host '== OK'; exit 0 }
}
