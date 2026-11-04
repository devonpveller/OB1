# run-privacy-hardening-lab.ps1 - the disposable lab for research-workbench rw-privacy-hardening (slot 430):
# the eight follow-ups of slots 380 / 390 / 400, each with a RED (the base) and a GREEN (this change).
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-privacy-hardening-lab.ps1 -Subnet <x.y.z.0/24> [-Evidence <dir>] [-Red] [-BaseSha 8241755]
#
# -Red runs the SAME checks against a pristine tree of -BaseSha (no slot 430, the old writer, the old revert, the old
# settingsAdmin): every one of the eight must FAIL there. Without -Red the checks run on this working tree: every one must pass.
#
# Same lab rules as run-workspace-tests.ps1: one --internal network on the pinned subnet, :wt-<id> tags only (this lab builds
# nothing; it runs pinned third-party images), no published port, no :local image, no ai-stack_* / open-brain_* name,
# synthetic seed data only, every container labelled ai-stack.harness.owner=<Id> and removed at the end, and a leftover check.
# It never touches the live stack.
#
# What it does (database: the REAL initdb chain of the tree, ob_app_memory is not needed - the writer goes through the real
# PostgREST and Caddy as service_role, which is the path the compile and the note save take):
#   1. plants three ideas with their old shared-corpus thoughts and wiki pages (slot 380 moves them), and a 390 scenario: a
#      report, a minted thread, a real notebook outside it, web sources and thoughts carrying labels in several cases
#   2. runs 380 and 390 (the live state), snapshots, applies 430 twice, and checks 390-F1, 390-F2 (sources and thoughts), 380 case
#      and %2F, the withheld marker (a real PostgREST answer's X-Wiki-Withheld and the real writer), R3 (the refusal message),
#      R4 (a purge, and the sweep of an idea already purged)
#   3. 430's revert twice (md5 of the touched tables and the function bodies equals the pre-430 snapshot), 430 again (equals
#      the post-430 snapshot)
#   4. 390-F3: a planted shortfall makes the 390 revert refuse and change nothing; without it the revert restores the report
#   5. 400-A4: the settingsAdmin unit test (deno), against this tree's / the base's system.ts
param(
  [string]$Id = 'wt-rw-privacy-hardening',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
  [string]$CaddyImage = 'caddy:2-alpine',
  [string]$NodeImage = 'node:22-slim',
  [string]$BaseSha = '8241755',
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
$P = "rwph-$rand"
$net = "$P-net"
$K = -join ((97..122) | Get-Random -Count 8 | ForEach-Object { [char]$_ })
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$vault = Join-Path $env:TEMP "$P-vault"
$script:fail = 0
$script:made = @{ net = $false; containers = @(); dirs = @($stage, $vault) }
$script:res = [ordered]@{}

function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
# the eight fixes: with -Red a check that FAILS is the expected result (counted as RED-ok), without it a pass is
function Fix([string]$id, [bool]$ok, [string]$m) {
  $script:res[$id] = $ok
  if ($Red) { if (-not $ok) { Write-Host "  RED-OK  [$id] $m" } else { Write-Host "  RED-UNEXPECTED-PASS  [$id] $m"; $script:fail++ } }
  else { Check $ok "[$id] $m" }
}
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false)) }

# -- the lab docker shim (as run-workspace-tests.ps1) -------------------------------------------
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
    if ($x -match '(^|[/=])[^ ]*:local$' -and $a[0] -notin @('images', 'image')) { return "a :local image ($x)" }
  }
  if ($all -match 'macvlan|ipvlan') { return 'a macvlan / ipvlan driver' }
  if ($a.Count -ge 2 -and $a[0] -eq 'network' -and $a[1] -eq 'create') {
    if ($a -notcontains '--internal') { return 'a network that is not --internal' }
    if (($a -join ' ') -notmatch [regex]::Escape("--subnet $($subnets.run)")) { return 'a network not on the pinned subnet' }
  }
  if ($a.Count -and $a[0] -eq 'build') { return 'this lab builds nothing' }
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
$shimCases = @(@('run', '-p', '8080:8080', 'x'), @('run', '--network', 'ai-stack_app-net', 'x'), @('network', 'create', 'n'), @('run', 'x:local'), @('compose', 'up'), @('build', '-t', 'x:wt-a', '.'))
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
  & git -C $ob1 archive --format=tar -o $tar $sha docker recipes integrations/intake
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $tar -C $tree
  Remove-Item -Force $tar
  return $tree
}

try {
  Write-Host "== rw-privacy-hardening lab  owner=$Id  net=$net  red=$([bool]$Red)  evidence=$Evidence"
  # the tree the lab runs: the base for -Red, this working tree otherwise
  if ($Red) { $tree = Tree-At $BaseSha; $dk = Join-Path $tree 'docker'; $recDir = Join-Path $tree 'recipes' } else { $dk = $dockerDir; $recDir = Join-Path $ob1 'recipes' }
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  Write-Host "[1] the initdb chain, from $dk"
  $compose = Get-Content -Raw (Join-Path $dk 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dk $m[0]) (Join-Path $stage $m[1]) }
  $has430 = @($chain | Where-Object { $_[1] -eq '430-init-privacy-hardening.sql' }).Count -eq 1
  Check ($has430 -eq (-not $Red)) "the chain $(if ($Red) { 'does not mount' } else { 'mounts' }) 430-init-privacy-hardening.sql ($($chain.Count) migrations)"
  Check (@($chain | Where-Object { $_[1] -in @('380-init-idea-privacy.sql', '390-init-report-isolation.sql', '400-init-settings.sql') }).Count -eq 3) 'the chain mounts 380, 390 and 400'

  Write-Host '[2] the internal network and the lab'
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

  function Sql([string]$text, [string]$name = 'q.sql') {
    $f = Join-Path $env:TEMP "$P-$name"
    [System.IO.File]::WriteAllText($f, $text, (New-Object System.Text.UTF8Encoding $false))
    $script:made.dirs += $f
    $null = Dk cp $f "${db}:/tmp/$name"
    return Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f "/tmp/$name"
  }
  function File([string]$path, [string]$name) { $null = Dk cp $path "${db}:/tmp/$name"; return Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f "/tmp/$name" }
  function Q1([string]$q) { $r = Dk exec $db psql -U postgres -d openbrain -X -tA -v ON_ERROR_STOP=1 -c $q; return (($r -replace "`r", '') -split "`n" | Where-Object { $_ -ne '' -and $_ -notmatch '^(INSERT|UPDATE|DELETE|DO)\b' }) -join "`n" }
  function Notices([string]$o) { return (($o -split "`n") | Where-Object { $_ -match 'NOTICE|ERROR' } | ForEach-Object { ($_ -replace '^.*(NOTICE|ERROR):\s+', '').Trim() }) -join ' ; ' }

  if (-not $Red) {
    # the initdb chain ran 430 on the empty volume; the live database has not had it. Take it off, so the plant and the 380 / 390
    # runs below are the live order and "before 430" is a real state
    $o = File (Join-Path $dk 'revert-privacy-hardening.sql') 'rv430-empty.sql'; Save '430-revert-on-empty.log' $o
    Check ($script:rc -eq 0) 'the chain''s own slot 430 (empty volume) is taken off again: the lab starts from the live state, 380 + 390 + 400 without 430'
  }
  # ---------------------------------------------------------------- 3. the plant (synthetic)
  Write-Host '[3] the plant: three ideas with old shared-corpus thoughts, a 390 scenario (synthetic text only)'
  $seed = @"
\set ON_ERROR_STOP on
-- 380: ideas A, B, C each with a pre-370 thought carrying the idea text, the thought's leaf page and a page linking it
SELECT public.idea_capture('lab-owner-a', 'service:lab', 'ph idea a $K', 'ph idea statement alpha $K one two three four five six seven', NULL, NULL)::text AS ideaa \gset
SELECT public.idea_capture('lab-owner-a', 'service:lab', 'ph idea b $K', 'ph idea statement bravo $K one two three four five six seven', NULL, NULL)::text AS ideab \gset
SELECT public.idea_capture('lab-owner-b', 'service:lab', 'ph idea c $K', 'ph idea statement charlie $K one two three four five six seven', NULL, NULL)::text AS ideac \gset
INSERT INTO public.thoughts (content, metadata, exposure) VALUES ('ph idea statement alpha $K one two three four five six seven', jsonb_build_object('type', 'idea', 'idea_id', :'ideaa'), 'ops') RETURNING id AS tha \gset
INSERT INTO public.thoughts (content, metadata, exposure) VALUES ('ph idea statement bravo $K one two three four five six seven', jsonb_build_object('type', 'idea', 'idea_id', :'ideab'), 'ops') RETURNING id AS thb \gset
INSERT INTO public.thoughts (content, metadata, exposure) VALUES ('ph idea statement charlie $K one two three four five six seven', jsonb_build_object('type', 'idea', 'idea_id', :'ideac'), 'ops') RETURNING id AS thc \gset
INSERT INTO public.wiki_pages (slug, page_class, title, body, links) VALUES
  ('content/thought/' || :'tha', 'thought', 'leaf a', 'the idea a text', '[]'::jsonb),
  ('content/thought/' || :'thb', 'thought', 'leaf b', 'the idea b text', '[]'::jsonb),
  ('content/thought/' || :'thc', 'thought', 'leaf c', 'the idea c text', '[]'::jsonb),
  ('content/topic/ph-linker-b-$K', 'entity', 'linker b', 'cites [[content/thought/' || :'thb' || ']] and more', jsonb_build_array('content/thought/' || :'thb')),
  ('content/topic/ph-linker-c-$K', 'entity', 'linker c', 'cites [[content/thought/' || :'thc' || ']] and more', jsonb_build_array('content/thought/' || :'thc'));
-- 390: an idea job whose report is filed, a minted thread (tA) the report named, a REAL notebook outside the move (tU), web sources
SELECT public.idea_capture('lab-owner-a', 'service:lab', 'ph report idea $K', 'ph report statement $K', NULL, NULL)::text AS idear \gset
INSERT INTO public.research_jobs (status, origin, query) VALUES ('done', 'manual', 'ph research $K') RETURNING id::text AS job \gset
UPDATE public.idea_revisions SET research_job_id = :'job' WHERE idea_id = :'idear' AND revision = 1;
UPDATE public.research_jobs SET refinery_id = NULL, inlet_ref = NULL WHERE id = :'job';
INSERT INTO public.sources (title, content, content_type, research_key) VALUES ('Report $K', 'the report body $K', 'research_synthesis', 'rk-ph-$K') RETURNING id::text AS src \gset
INSERT INTO public.threads (name, description, status) VALUES ('Alpha Notebook $K', 'desc $K', 'active') RETURNING id::text AS ta \gset
INSERT INTO public.threads (name, description, status) VALUES ('Shelf Notebook $K', 'a real notebook the move never touched', 'active') RETURNING id::text AS tu \gset
SELECT public.link_source_to_thread(:'ta', :'src', 'automatic', NULL, 'confirmed') \gset
UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('thread_id', :'ta', 'thread_decision', 'explicit', 'thread_name', 'Alpha Notebook $K', 'persist', jsonb_build_object('synthesis_id', :'src'))) WHERE id = :'job';
-- a second idea job's report with NO dependent rows (no thread link, no queue row): the 390-F3 case, a moved report the revert can skip silently
SELECT public.idea_capture('lab-owner-a', 'service:lab', 'ph second report idea $K', 'ph second report statement $K', NULL, NULL)::text AS idear2 \gset
INSERT INTO public.research_jobs (status, origin, query) VALUES ('done', 'manual', 'ph research two $K') RETURNING id::text AS job2 \gset
UPDATE public.idea_revisions SET research_job_id = :'job2' WHERE idea_id = :'idear2' AND revision = 1;
UPDATE public.research_jobs SET refinery_id = NULL, inlet_ref = NULL WHERE id = :'job2';
INSERT INTO public.sources (title, content, content_type, research_key) VALUES ('Report two $K', 'the second report body $K', 'research_synthesis', 'rk-ph2-$K') RETURNING id::text AS src2 \gset
DELETE FROM public.source_extraction_queue WHERE source_id = :'src2';
UPDATE public.research_jobs SET result = jsonb_build_object('curator', jsonb_build_object('persist', jsonb_build_object('synthesis_id', :'src2'))) WHERE id = :'job2';
-- w1: linked to the tied thread, labelled with the real notebook's name in another case (F1); w2: unlinked, a case variant of the
-- tied thread's old name (F2); w3: its exact old name (390 handles it); w0: a control that is not linked and not a tied name
INSERT INTO public.sources (url, title, content, notebook) VALUES ('https://example.org/w1-$K', 'w1 $K', 'web one', 'shelf notebook $K') RETURNING id::text AS w1 \gset
INSERT INTO public.sources (url, title, content, notebook) VALUES ('https://example.org/w2-$K', 'w2 $K', 'web two', 'ALPHA NOTEBOOK $K') RETURNING id::text AS w2 \gset
INSERT INTO public.sources (url, title, content, notebook) VALUES ('https://example.org/w3-$K', 'w3 $K', 'web three', 'Alpha Notebook $K') RETURNING id::text AS w3 \gset
INSERT INTO public.sources (url, title, content, notebook) VALUES ('https://example.org/w0-$K', 'w0 $K', 'web zero', 'Shelf Notebook $K') RETURNING id::text AS w0 \gset
SELECT public.link_source_to_thread(:'ta', :'w1', 'automatic', NULL, 'confirmed') \gset
INSERT INTO public.thoughts (content, metadata, exposure) VALUES ('ph thought one $K', jsonb_build_object('notebook', 'alpha notebook $K'), 'ops') RETURNING id AS th1 \gset
INSERT INTO public.thoughts (content, metadata, exposure) VALUES ('ph thought two $K', jsonb_build_object('notebook', 'Alpha Notebook $K'), 'ops') RETURNING id AS th2 \gset
INSERT INTO public.thoughts (content, metadata, exposure) VALUES ('ph thought zero $K', jsonb_build_object('notebook', 'Shelf Notebook $K'), 'ops') RETURNING id AS th0 \gset
-- a note whose slug the lab trigger below silently drops (the stand-in for a row nobody withheld)
CREATE OR REPLACE FUNCTION public.lab_silent_drop() RETURNS trigger LANGUAGE plpgsql AS `$`$ BEGIN IF NEW.slug LIKE '%ph-hidden%' THEN RETURN NULL; END IF; RETURN NEW; END; `$`$;
CREATE TRIGGER lab_silent_drop BEFORE INSERT OR UPDATE ON public.wiki_pages FOR EACH ROW EXECUTE FUNCTION public.lab_silent_drop();
\echo IDS ideaa=:ideaa ideab=:ideab ideac=:ideac tha=:tha thb=:thb thc=:thc job=:job src=:src src2=:src2 ta=:ta tu=:tu w1=:w1 w2=:w2 w3=:w3 w0=:w0 th1=:th1 th2=:th2 th0=:th0
"@
  $o = Sql $seed 'seed.sql'
  Save 'seed.log' $o
  $ids = @{}
  foreach ($m in [regex]::Matches($o, '(\w+)=([0-9a-f-]+)')) { $ids[$m.Groups[1].Value] = $m.Groups[2].Value }
  Check ($script:rc -eq 0 -and $ids.Count -ge 17) "planted ($($ids.Count) ids)"
  if ($script:rc -ne 0) { Write-Host $o; throw 'seed' }

  Write-Host '[4] slot 380 then slot 390 over the plant (the live order), then the snapshot'
  $o380 = File (Join-Path $dk 'init-idea-privacy.sql') '380.sql'; Save '380-init.log' $o380
  Check ($script:rc -eq 0 -and $o380 -match 'idea thought\(s\) archived') "slot 380 archived the planted idea thoughts ($(Notices $o380))"
  $o390 = File (Join-Path $dk 'init-report-isolation.sql') '390.sql'; Save '390-init.log' $o390
  Check ($script:rc -eq 0 -and $o390 -match 'moved 2 idea-job') "slot 390 moved the planted report ($(Notices $o390))"
  $snapSql = @"
SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
  SELECT 's:' || to_jsonb(s)::text AS x FROM public.sources s
  UNION ALL SELECT 'h:' || to_jsonb(t)::text FROM public.thoughts t
  UNION ALL SELECT 'th:' || to_jsonb(t)::text FROM public.threads t
  UNION ALL SELECT 'ia:' || to_jsonb(a)::text FROM public.idea_thought_archive a
  UNION ALL SELECT 'wa:' || to_jsonb(a)::text FROM public.idea_wiki_archive a
  UNION ALL SELECT 'ra:' || to_jsonb(a)::text FROM public.research_report_isolation_archive a
  UNION ALL SELECT 'pr:' || to_jsonb(a)::text FROM public.research_private_reports a
  UNION ALL SELECT 'f:' || p.proname || ':' || replace(pg_get_functiondef(p.oid), E'\r', '') FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('idea_privacy_page_links_idea', 'trg_idea_privacy_wiki_guard', 'trg_report_isolation_wiki_guard')
  UNION ALL SELECT 'fn:' || p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('idea_privacy_linked_thought_ids', 'wiki_guard_mark_withheld', 'trg_idea_privacy_forget_idea')
  UNION ALL SELECT 'tg:' || tgrelid::regclass::text || ':' || tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.ideas'::regclass, 'public.wiki_pages'::regclass)
  UNION ALL SELECT 'tb:' || relname FROM pg_class WHERE relname = 'privacy_hardening_archive'
) q
"@
  function Snap { $f = Join-Path $env:TEMP "$P-snap.sql"; [System.IO.File]::WriteAllText($f, $snapSql, (New-Object System.Text.UTF8Encoding $false)); $script:made.dirs += $f; $null = Dk cp $f "${db}:/tmp/snap.sql"; return ((Dk exec $db psql -U postgres -d openbrain -X -tA -v ON_ERROR_STOP=1 -f /tmp/snap.sql) -split "`n" | Where-Object { $_ -match '^[0-9a-f]{32}$' } | Select-Object -First 1) }
  # per-part md5s, for the evidence when two snapshots differ
  $partSql = $snapSql -replace '(?s)^SELECT md5\(string_agg\(x, ''\|'' ORDER BY x\)\) FROM \(', 'SELECT split_part(x, '':'', 1) AS part, md5(string_agg(x, ''|'' ORDER BY x)) FROM (' -replace '\) q\s*$', ') q GROUP BY 1 ORDER BY 1'
  function SnapParts { $f = Join-Path $env:TEMP "$P-snapp.sql"; [System.IO.File]::WriteAllText($f, $partSql, (New-Object System.Text.UTF8Encoding $false)); $script:made.dirs += $f; $null = Dk cp $f "${db}:/tmp/snapp.sql"; return (Dk exec $db psql -U postgres -d openbrain -X -tA -v ON_ERROR_STOP=1 -f /tmp/snapp.sql) -replace "`n", ' ; ' }
  $snap0 = Snap; $parts0 = SnapParts
  Save 'snapshot-before-430.txt' $snap0
  $notebookOf = { param($col, $key, $val) Q1 "SELECT $col FROM public.$key WHERE $val" }
  $lab = "x"
  $w1nb = { Q1 "SELECT notebook FROM public.sources WHERE id = '$($ids.w1)'" }
  $w2nb = { Q1 "SELECT notebook FROM public.sources WHERE id = '$($ids.w2)'" }
  $w3nb = { Q1 "SELECT notebook FROM public.sources WHERE id = '$($ids.w3)'" }
  $w0nb = { Q1 "SELECT notebook FROM public.sources WHERE id = '$($ids.w0)'" }
  $t1nb = { Q1 "SELECT metadata ->> 'notebook' FROM public.thoughts WHERE id = $($ids.th1)" }
  $t2nb = { Q1 "SELECT metadata ->> 'notebook' FROM public.thoughts WHERE id = $($ids.th2)" }
  $t0nb = { Q1 "SELECT metadata ->> 'notebook' FROM public.thoughts WHERE id = $($ids.th0)" }
  $neutral = "Research thread $($ids.ta.Substring(0, 8))"
  Save 'labels-after-390.txt' "w1=$(& $w1nb) | w2=$(& $w2nb) | w3=$(& $w3nb) | w0=$(& $w0nb) | th1=$(& $t1nb) | th2=$(& $t2nb) | th0=$(& $t0nb)"
  Check ((& $w3nb) -eq $neutral) "390 itself relabelled the exact old name (w3 = '$neutral')"
  $f1Was = & $w1nb
  Check ($f1Was -eq $neutral) "before 430 the real notebook's source (w1, label 'shelf notebook') is relabelled by linkage: '$f1Was' (the F1 defect, present in both modes)"

  # ---------------------------------------------------------------- 5. slot 430
  Write-Host '[5] slot 430 (twice) and the checks'
  $o430 = ''
  if (-not $Red) {
    $o430 = File (Join-Path $dk 'init-privacy-hardening.sql') '430.sql'; Save '430-init-1.log' $o430
    Check ($script:rc -eq 0 -and $o430 -match 'privacy hardening: 1 source label') "430 ran: $(Notices $o430)"
    $o430b = File (Join-Path $dk 'init-privacy-hardening.sql') '430.sql'; Save '430-init-2.log' $o430b
    Check ($script:rc -eq 0 -and $o430b -match 'privacy hardening: 0 source label\(s\) given back \(a thread outside the move\); 0 source\(s\) and 0 thought\(s\)') "430 again: nothing left to repair ($(Notices $o430b))"
  } else { Write-Host '  (RED: the base has no slot 430)' }
  $snap1 = Snap
  Save 'snapshot-after-430.txt' $snap1

  if (-not $Red) {
    Write-Host '[5b] 430 revert twice (md5 equals the pre-430 state), 430 again (equals the post-430 state)'
    $rv1 = File (Join-Path $dk 'revert-privacy-hardening.sql') 'rv430.sql'; Save '430-revert-1.log' $rv1
    Check ($script:rc -eq 0 -and $rv1 -match 'restored') "430 revert ran: $(Notices $rv1)"
    $snapRev = Snap; Save 'snapshot-parts.txt' "before430: $parts0`nafterRevert: $(SnapParts)"
    Check ($snapRev -eq $snap0) "after the revert every touched table, the three functions, the triggers and the archive are byte-identical to the pre-430 state (md5 $snap0)"
    Check ((& $w1nb) -eq $neutral -and (& $w2nb) -eq "ALPHA NOTEBOOK $K" -and (& $t1nb) -eq "alpha notebook $K") 'after the revert the labels are what 390 left (w1 relabelled again, w2 and the thought as planted)'
    $rv2 = File (Join-Path $dk 'revert-privacy-hardening.sql') 'rv430.sql'; Save '430-revert-2.log' $rv2
    Check ($script:rc -eq 0 -and $rv2 -match 'no archive' -and (Snap) -eq $snap0) "430 revert again: nothing to restore, nothing changed ($(Notices $rv2))"
    $ap = File (Join-Path $dk 'init-privacy-hardening.sql') '430.sql'; Save '430-init-3.log' $ap
    Check ($script:rc -eq 0 -and (Snap) -eq $snap1) "430 again after the revert gives the post-430 state byte-identical (md5 $snap1)"
    Check ($snap0 -ne $snap1) 'the migration changed something (the roundtrip is not vacuous)'
  }

  Fix '390-F1' ((& $w1nb) -eq "shelf notebook $K") "a source labelled with a real notebook's name (another case) outside the tie set keeps its label (is '$(& $w1nb)')"
  Fix '390-F2' ((& $w2nb) -eq $neutral -and (& $t1nb) -eq $neutral -and (& $t2nb) -eq $neutral -and (& $w0nb) -eq "Shelf Notebook $K" -and (& $t0nb) -eq "Shelf Notebook $K") "a case variant of a tied name is relabelled in sources AND thoughts.metadata.notebook, a real notebook's name is not (w2='$(& $w2nb)' th1='$(& $t1nb)' th2='$(& $t2nb)' controls '$(& $w0nb)' / '$(& $t0nb)')"

  # the probe: the REAL writer (this tree's / the base's recipes) and the note save, through PostgREST and Caddy
  New-Item -ItemType Directory -Force $vault | Out-Null
  for ($i = 0; $i -lt 40; $i++) { $r = Dk run --rm --label $label --network $net --entrypoint node $NodeImage -e "fetch('http://openbrain-rest/rest/v1/wiki_pages?select=slug&limit=1').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  Check ($script:rc -eq 0) 'the lab PostgREST answers through the Caddy proxy'
  $probeOut = Dk run --rm --label $label --network $net -v "${recDir}/_shared:/shared:ro" -v "${ct}:/ct:ro" -v "${vault}:/vault" -e SHARED=/shared -e WIKI_GIT_DIR=/vault `
      -e OPEN_BRAIN_URL=http://openbrain-rest -e "IDEA_THOUGHT=$($ids.tha)" -e "REPORT_SOURCE=$($ids.src)" -e "TAG=$K" $NodeImage node /ct/privacy-hardening-probe.mjs
  Save 'probe.log' $probeOut
  $pj = $null
  $pm = [regex]::Match($probeOut, 'PROBE (\{.*\})')
  if ($pm.Success) { $pj = $pm.Groups[1].Value | ConvertFrom-Json }
  Check ($null -ne $pj) 'the probe ran against the real wiki writer and PostgREST'
  if ($null -eq $pj) { Write-Host $probeOut; throw 'probe' }
  $withheldAll = (-not $pj.rows.'link-upper') -and (-not $pj.rows.'link-lower') -and (-not $pj.rows.'link-enc') -and (-not $pj.rows.'link-enc-upper')
  $controlsKept = $pj.rows.'ctl-after' -and $pj.rows.'ctl-longer' -and $pj.rows.'ctl-clean'
  Fix '380-case-2F' ($withheldAll -and $controlsKept) "the guard withholds [[Thought/<id>]], [[thought/<id>]], thought%2F<id> and THOUGHT%2f<id>, and keeps afterthought/<id>, thought/<id>0 and a clean page (rows: $($pj.rows | ConvertTo-Json -Compress))"
  Fix '380-marker' (($pj.marker.header -eq '1') -and $pj.hidden.file -and $pj.hidden.unsynced -and (-not $pj.hidden.withheldMemo) -and ($pj.exit2 -ne 0)) "PostgREST returns X-Wiki-Withheld=1 for one withheld row of two ('$($pj.marker.header)'), and a row nobody withheld is HIDDEN: file kept ($($pj.hidden.file)), unsynced ($($pj.hidden.unsynced)), run exit $($pj.exit2)"
  $mi = [string]$pj.noteIdea.message; $mr = [string]$pj.noteReport.message
  Fix '380-R3' (($pj.noteIdea.status -ge 400) -and ($pj.noteReport.status -ge 400) -and ($mi -eq $mr) -and ($mi -notmatch 'idea|report') -and ($pj.noteClean.status -lt 300)) "a note linking an idea and a note citing a moved report are refused with one message that names neither ('$mi' / '$mr'); a clean note saves ($($pj.noteClean.status))"

  # R4: purge idea B (the trigger), and the sweep of idea C purged with the trigger off
  $pre = Q1 "SELECT (SELECT count(*) FROM public.idea_thought_archive WHERE archive_idea_id = '$($ids.ideab)') || '/' || (SELECT count(*) FROM public.idea_wiki_archive WHERE slug IN ('content/thought/$($ids.thb)', 'content/topic/ph-linker-b-$K'))"
  $null = Q1 "DELETE FROM public.ideas WHERE id = '$($ids.ideab)'"
  $post = Q1 "SELECT (SELECT count(*) FROM public.idea_thought_archive WHERE archive_idea_id = '$($ids.ideab)') || '/' || (SELECT count(*) FROM public.idea_wiki_archive WHERE slug IN ('content/thought/$($ids.thb)', 'content/topic/ph-linker-b-$K'))"
  $stillA = Q1 "SELECT count(*) FROM public.idea_thought_archive WHERE archive_idea_id = '$($ids.ideaa)'"
  $null = Q1 "INSERT INTO public.wiki_pages (slug, page_class, title, body, links) VALUES ('content/topic/ph-rebuilt-b-$K', 'entity', 'rebuilt b', 'cites [[content/thought/$($ids.thb)]]', '[]'::jsonb) ON CONFLICT (slug) DO NOTHING"
  $landedB = Q1 "SELECT count(*) FROM public.wiki_pages WHERE slug = 'content/topic/ph-rebuilt-b-$K'"
  $null = Q1 "INSERT INTO public.wiki_pages (slug, page_class, title, body, links) VALUES ('content/topic/ph-still-a-$K', 'entity', 'still a', 'cites [[content/thought/$($ids.tha)]]', '[]'::jsonb) ON CONFLICT (slug) DO NOTHING"
  $heldA = Q1 "SELECT count(*) FROM public.wiki_pages WHERE slug = 'content/topic/ph-still-a-$K'"
  Fix '380-R4' ($pre -eq '1/2' -and $post -eq '0/0' -and $landedB -eq '1' -and $stillA -eq '1' -and $heldA -eq '0') "purging idea B removes its archived thought and the 2 archived pages (before $pre, after $post); the page that linked it is written again ($landedB); idea A, not purged, is still withheld on ($stillA archive row, link page rows $heldA)"
  Save 'r4.txt' "pre=$pre post=$post landedB=$landedB stillA=$stillA heldA=$heldA"

  if (-not $Red) {
    # the sweep: idea C purged while the trigger is off (a purge made before 430), then 430 again removes its rows
    $null = Q1 "ALTER TABLE public.ideas DISABLE TRIGGER trg_idea_privacy_forget_idea"
    $null = Q1 "DELETE FROM public.ideas WHERE id = '$($ids.ideac)'"
    $null = Q1 "ALTER TABLE public.ideas ENABLE TRIGGER trg_idea_privacy_forget_idea"
    $orphanBefore = Q1 "SELECT count(*) FROM public.idea_thought_archive WHERE archive_idea_id = '$($ids.ideac)'"
    $oSweep = File (Join-Path $dk 'init-privacy-hardening.sql') '430.sql'; Save '430-init-sweep.log' $oSweep
    $orphanAfter = Q1 "SELECT (SELECT count(*) FROM public.idea_thought_archive WHERE archive_idea_id = '$($ids.ideac)') || '/' || (SELECT count(*) FROM public.idea_wiki_archive WHERE slug IN ('content/thought/$($ids.thc)', 'content/topic/ph-linker-c-$K'))"
    Check ($orphanBefore -eq '1' -and $orphanAfter -eq '0/0' -and $oSweep -match '2 archived row\(s\) of purged ideas removed|1 archived row\(s\) of purged ideas removed') "430 removes the archive rows of an idea purged before it (before $orphanBefore, after $orphanAfter; $(Notices $oSweep))"
  }

  # ---------------------------------------------------------------- 7. 390-F3
  Write-Host '[7] 390-F3: a planted shortfall makes the 390 revert refuse'
  $revert390 = Join-Path $dk 'revert-report-isolation.sql'
  $own = Q1 "SELECT count(*) FROM public.research_private_reports WHERE migrated_source_id = '$($ids.src2)'"
  $null = Q1 "INSERT INTO public.sources (title, content, content_type, research_key) VALUES ('Re-filed $K', 'a later filing under the same key', 'research_synthesis', 'rk-ph2-$K')"
  $snapPre = Q1 "SELECT md5((SELECT string_agg(to_jsonb(s)::text, '|' ORDER BY s.id::text) FROM public.sources s) || (SELECT coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id::text), '') FROM public.research_private_reports p) || (SELECT string_agg(to_jsonb(a)::text, '|' ORDER BY a.id) FROM public.research_report_isolation_archive a) || (SELECT string_agg(to_jsonb(t)::text, '|' ORDER BY t.id::text) FROM public.threads t))"
  $rf = File $revert390 'rv390.sql'; $rfRc = $script:rc; Save '390-revert-shortfall.log' $rf
  $snapPost = Q1 "SELECT md5((SELECT string_agg(to_jsonb(s)::text, '|' ORDER BY s.id::text) FROM public.sources s) || (SELECT coalesce(string_agg(to_jsonb(p)::text, '|' ORDER BY p.id::text), '') FROM public.research_private_reports p) || (SELECT string_agg(to_jsonb(a)::text, '|' ORDER BY a.id) FROM public.research_report_isolation_archive a) || (SELECT string_agg(to_jsonb(t)::text, '|' ORDER BY t.id::text) FROM public.threads t))"
  $ownAfter = Q1 "SELECT count(*) FROM public.research_private_reports WHERE migrated_source_id = '$($ids.src2)'"
  Save '390-f3.txt' "own=$own rc=$rfRc ownAfter=$ownAfter pre=$snapPre post=$snapPost :: $(Notices $rf)"
  Fix '390-F3' ($rfRc -ne 0 -and $rf -match 'could not be put back' -and $snapPre -eq $snapPost -and $own -eq '1' -and $ownAfter -eq '1') "with a row already holding the report's research_key the 390 revert refuses (exit $rfRc), changes nothing (md5 equal: $($snapPre -eq $snapPost)) and the private copy is kept ($ownAfter) - $(Notices $rf)"
  if (-not $Red) {
    $null = Q1 "DELETE FROM public.sources WHERE title = 'Re-filed $K'"
    $rok = File $revert390 'rv390.sql'; Save '390-revert-clean.log' $rok
    Check ($script:rc -eq 0 -and $rok -match '1 batch\(es\) restored' -and (Q1 "SELECT count(*) FROM public.sources WHERE id IN ('$($ids.src)', '$($ids.src2)')") -eq '2') "without the planted row the 390 revert restores the report ($(Notices $rok))"
    $rok2 = File $revert390 'rv390.sql'
    Check ($script:rc -eq 0 -and $rok2 -match '0 batch') "and a second run has no batch to restore ($(Notices $rok2))"
  }

  # ---------------------------------------------------------------- 8. 400-A4 (a unit test of the shared rule)
  Write-Host '[8] 400-A4: settingsAdmin in header mode'
  $wbSrc = if ($Red) { Join-Path $tree 'docker/workbench' } else { $wb }
  $recipes = if ($Red) { Join-Path $tree 'recipes' } else { Join-Path $ob1 'recipes' }
  $cfgPath = Join-Path $env:TEMP "$P-deno.json"
  $dj = Get-Content -Raw (Join-Path $wbSrc 'deno.json') | ConvertFrom-Json
  $dj.imports.'@shared/slug' = ('file:///' + ((Join-Path $recipes '_shared/slug.mjs') -replace '\\', '/'))
  [System.IO.File]::WriteAllText($cfgPath, ($dj | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding $false))
  $script:made.dirs += $cfgPath
  if ($Red) { Copy-Item (Join-Path $wb 'src/settings/settings_test.ts') (Join-Path $wbSrc 'src/settings/settings_test.ts') -Force }   # this change's test over the base's code
  Push-Location $wbSrc
  $dt = & deno test --config $cfgPath --allow-env --allow-read --allow-net src/settings/settings_test.ts 2>&1 | Out-String
  Pop-Location
  Save 'settings-test.log' ($dt -replace '\x1b\[[0-9;]*m', '')
  $a4 = ($dt -replace '\x1b\[[0-9;]*m', '') -match '400-A4[^\n]*\.\.\. ok'
  Fix '400-A4' $a4 'a header equal to WORKSPACE_DEFAULT_SUB is a header user, not the admin; no header is still the default subject (the unit test)'
}
catch { Write-Host "  ERROR  $_"; $script:fail++ }
finally {
  Write-Host '== teardown'
  foreach ($c in $script:made.containers) { $null = Dk rm -f -v $c }
  if ($script:made.net) { $null = Dk network rm $net }
  $left = Dk ps -a --filter "label=$label" --format '{{.Names}}'
  $leftNet = Dk network ls --filter "label=$label" --format '{{.Name}}'
  $leftImg = Dk images --filter "label=$label" --format '{{.Repository}}:{{.Tag}}'
  Check ([string]::IsNullOrWhiteSpace("$left$leftNet$leftImg")) "nothing labelled $Id is left (containers '$left', networks '$leftNet', images '$leftImg')"
  $localAfter = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim()
  if ($localBefore -eq $localAfter) { Pass 'no :local image changed' } else { Write-Host '  WARN  a :local image listing differs from the start (this lab never touches one - the shim refuses it; another session on the host rebuilt one: see local-images-before/after.txt)' }
  Save 'local-images-before.txt' $localBefore; Save 'local-images-after.txt' $localAfter
  foreach ($d in $script:made.dirs) { try { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } catch { } }
  $summary = ($script:res.GetEnumerator() | ForEach-Object { "$($_.Key)=$(if ($_.Value) { 'GREEN' } else { 'RED' })" }) -join ' '
  Save 'summary.txt' "red=$([bool]$Red) base=$BaseSha tree=$sha fail=$($script:fail) :: $summary"
  Write-Host "== $summary"
  if ($script:fail) { Write-Host "== FAIL ($($script:fail))"; exit 1 } else { Write-Host '== OK'; exit 0 }
}
