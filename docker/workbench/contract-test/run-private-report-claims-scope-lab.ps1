# run-private-report-claims-scope-lab.ps1 - slot 575 (init-private-report-claims-scope.sql, research-workbench
# rw-570-hub-note-scope) in a DISPOSABLE lab: the database only (pgvector image, no app image, nothing built).
#
#   powershell -NoProfile -File OB1/docker/workbench/contract-test/run-private-report-claims-scope-lab.ps1 -Id wt-rw-570-hub-note-scope -Subnet 10.x.y.0/24 [-Evidence <empty dir>] [-OldRef 912b3f18]
#
# What it does, and ONLY this (every docker call through the shim: the run's --internal network on the pinned /25,
# the ai-stack.harness.owner label, no published port, no :local image, no compose, no build):
#   [1] stages the REAL initdb chain from OB1/docker/docker-compose.yml (570 and 575 included) and starts it; both slots
#       have nothing to move on a fresh volume; the check scripts say OK
#   [2] reverts the chain's 575 (nothing to restore; 570's guard functions back), then 570 (the 390 model); 575 without
#       570 is refused
#   [3] plants (prc-scope-plant.sql): B's and A's private reports, B's claims b1 / b2 and a two-owner claim m (390's
#       shape), a SHARED synthesis restating b1 and m that filed two FRAGMENTS (f1 inside b1, f2 inside m) and a control,
#       a shared claim carrying f1's sentence (fd), a shared job reusing f1, the notebook hub content/notebooks/<s>/<s>
#       (class 'note') carrying b1, the notebooks index (class 'note') carrying b2, a clean hub, a person's note
#       (notes/...) carrying b1, a compiled page carrying only f1; hashes every table 570 / 575 touch
#   [4] RED: slot 570 alone (the tree's file, which must equal -OldRef's) saves the hub and the index, leaves the
#       fragments shared; -OldRef's check script says OK and its count script has no line for them (they MISS them);
#       the new check / count / scope scripts count them and FAIL; 570's gap guard rewrites a NULL-kind row (R4)
#   [5] GREEN: 575 withholds the hub, the index and the fragment page, moves f1 and fd to B and withholds f2, strips the
#       job's reuse list; a new hub / index carrying a private claim is withheld; person and structured notes keep the
#       author-only rule; a NULL-kind row is stored as typed; every check says OK; 575 again: nothing to move; a 570
#       re-run is a check FAIL until 575 runs again
#   [6] revert 575: byte-identical to [4]'s post-570 hashes, 570's guard functions back byte for byte; again: nothing
#   [7] 575, revert 575, revert 570: byte-identical to the planted hashes
#   [8] 570, 575, then 570's revert ALONE: byte-identical to the planted hashes; then 575's revert leaves no function
#   [5e] (with -EquivDir) R6's equivalence: the earlier 575 on the same state gives the same fingerprint and counts
#   [9] R5: 570 + 575 again, then POST /workbench/notes on the tip image (RED: a note quoting a private-report sentence
#       is saved) and on the fix (GREEN: refused 422, no vault file, no row; a clean note saves on both)
# Exit 0 = every check passed. Counts and states only - never a claim's text. Never the live stack.
param(
  [string]$Id = 'wt-rw-570-hub-note-scope',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  # the base whose 570 / check / count scripts are the RED (OB1 912b3f1: slot 570 as merged)
  [string]$OldRef = '912b3f18',
  # the 570 the tree carries (development's, rw-570-perf: the one applied live); 575 must leave its files unchanged
  [string]$Base570Ref = '1ee773f6',
  # R5 (the structured-note refusal, an HTTP door): the workbench images, built beforehand with plain docker build under
  # this run's tags - the fix (-WorkbenchTag) and the tip before it (-BaseWorkbenchTag, the RED). Without them [5w] is
  # skipped and the lab says so (a FAIL unless -NoWorkbench).
  [string]$WorkbenchTag = '',
  [string]$BaseWorkbenchTag = '',
  [switch]$NoWorkbench,
  # R6 equivalence: a directory with an EARLIER 575's init + revert (3a01e11's: git show 3a01e112:docker/<file>). Before the
  # tree's 575 runs in [5], the earlier one runs on the same post-570 state, is fingerprinted and reverted; the tree's
  # must give the same fingerprint (data, owner stores, the archive rows in insert order) and the same NOTICE counts.
  [string]$EquivDir = ''
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
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$P = "rwprcs-$rand"
$net = "$P-net"
$db = "$P-db"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$rr = -join ((97..122) | Get-Random -Count 10 | ForEach-Object { [char]$_ })
$subA = "prcs-ay-$rr"; $subB = "prcs-bee-$rr"
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$oldDir = Join-Path $env:TEMP "$P-old"
$script:fail = 0
$script:made = @{ net = $false; containers = @() }
$key = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$vault = Join-Path $env:TEMP "$P-vault"
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false)) }

# -- the lab docker shim (run-workspace-tests.ps1's rules; this lab builds nothing) --------------------------------
function Test-LabDockerArgs([string[]]$a) {
  $all = ($a -join ' ')
  if ($a.Count -and $a[0] -eq 'compose') { return 'docker compose is never used by the lab' }
  if ($a.Count -and $a[0] -eq 'build') { return 'this lab builds no image' }
  if ($all -match '192\.168\.') { return 'a 192.168.x address' }
  if ($all -match '(^|[\s=:/])(ai-stack_|open-brain_)') { return 'an ai-stack_* / open-brain_* name' }
  for ($i = 0; $i -lt $a.Count; $i++) {
    $x = $a[$i]
    if ($x -match '^(-p|-P|--publish|--publish-all)$' -or $x -match '^--publish(-all)?=' -or $x -match '^-p\d') { return "a published port ($x)" }
    if ($x -match '^--net(work)?$') { $v = $a[$i + 1]; if ($v -ne $net -and $v -ne 'none') { return "network '$v' is not this run's" } }
    if ($x -match '^--net(work)?=(.+)$') { if ($Matches[2] -ne $net -and $Matches[2] -ne 'none') { return "network '$($Matches[2])' is not this run's" } }
    if ($x -match '(^|[/=])[^ ]*:local$') { return "a :local image ($x)" }
  }
  if ($all -match 'macvlan|ipvlan') { return 'a macvlan / ipvlan driver' }
  if ($a.Count -ge 2 -and $a[0] -eq 'network' -and $a[1] -eq 'create') {
    if ($a -notcontains '--internal') { return 'a network that is not --internal' }
    if (($a -join ' ') -notmatch [regex]::Escape("--subnet $($subnets.run)")) { return 'a network not on the pinned subnet' }
  }
  return ''
}
function Lab-Docker([int]$TimeoutSec, [string[]]$a) {
  $why = Test-LabDockerArgs $a
  if ($why) { Write-Host "  SHIM REFUSED: $why"; $script:rc = 2; $script:fail++; return "REFUSED: $why" }
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
function Dk { Lab-Docker 600 ([string[]]$args) }
function Q([string]$q) { return ((Dk exec $db psql -U postgres -d openbrain -X -A -t -q -c $q) | Out-String).Trim() }
# a migration / revert file: exit code and its NOTICE / ERROR lines (counts only)
function Psql-File([string]$path, [string]$tag) {
  $null = Dk cp $path "${db}:/tmp/prcs.sql"
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/prcs.sql
  $rc = $script:rc
  $msg = (($o -split "`n") | Where-Object { $_ -match 'NOTICE|WARNING|ERROR' } | ForEach-Object { $_ -replace '^.*?(NOTICE|WARNING|ERROR):\s*', '$1 ' }) -join ' | '
  Write-Host "    [$tag] exit ${rc}: $msg"
  $script:log += "[$tag] exit ${rc}: $msg"
  return @{ rc = $rc; msg = $msg }
}
# a read-only script (a check, a count, the probe): its lines
function Psql-Lines([string]$path, [string]$save) {
  $null = Dk cp $path "${db}:/tmp/prcsq.sql"
  $o = ((Dk exec $db psql -U postgres -d openbrain -X -A -t -q -v ON_ERROR_STOP=1 -v "a=$subA" -v "b=$subB" -v "r=$rr" -f /tmp/prcsq.sql) | Out-String).Trim()
  if ($save) { Save $save $o }
  return $o
}
function Probe([string]$save) {
  $o = Psql-Lines (Join-Path $ct 'prc-scope-probe.sql') $save
  $h = @{}
  foreach ($l in ($o -split "`n")) { if ($l -match '^([a-z0-9_]+)=(.*)$') { $h[$Matches[1]] = $Matches[2].Trim() } }
  return $h
}
function Check-Probe([hashtable]$got, [hashtable]$want, [string]$phase) {
  $bad = @()
  foreach ($k in ($want.Keys | Sort-Object)) { if ("$($got[$k])" -ne "$($want[$k])") { $bad += "$k=$($got[$k]) (want $($want[$k]))" } }
  Check ($bad.Count -eq 0) "${phase}: every probe as expected ($($want.Count) probes)$(if ($bad.Count) { ': ' + ($bad -join '; ') })"
  foreach ($k in ($want.Keys | Sort-Object)) { Write-Host "      $k=$($got[$k])" }
}
$checkSql = Join-Path $dockerDir 'check-private-report-claims.sql'
$countSql = Join-Path $dockerDir 'count-private-report-claim-reuse.sql'
$scopeSql = Join-Path $dockerDir 'check-private-report-claims-scope.sql'
$init570 = Join-Path $dockerDir 'init-private-report-claims.sql'
$rev570 = Join-Path $dockerDir 'revert-private-report-claims.sql'
$init575 = Join-Path $dockerDir 'init-private-report-claims-scope.sql'
$rev575 = Join-Path $dockerDir 'revert-private-report-claims-scope.sql'
# every table slot 570 / 575 touch, hashed (the 570 lab's set): the revert's byte-identical bar
$hashQ = @"
SELECT string_agg(t || '=' || h, ' ' ORDER BY t) FROM (
  SELECT 'claims' AS t, md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) AS h FROM public.claims x
  UNION ALL SELECT 'claim_sources', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.claim_sources x
  UNION ALL SELECT 'links', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.report_id, x.claim_id), '')) FROM public.research_private_report_claims x
  UNION ALL SELECT 'jobs', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.research_jobs x
  UNION ALL SELECT 'wiki_pages', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.slug), '')) FROM public.wiki_pages x
  UNION ALL SELECT 'private_claims', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.inlet_private_claims x
  UNION ALL SELECT 'steers', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.research_steers x
  UNION ALL SELECT 'events', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.research_job_events x
  UNION ALL SELECT 'private_edges', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.claim_id, x.edge_ref, x.batch), '')) FROM public.inlet_private_claim_sources x
  UNION ALL SELECT 'sources', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.sources x
  UNION ALL SELECT 'private_reports', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.research_private_reports x
  UNION ALL SELECT 'threads', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.threads x
  UNION ALL SELECT 'link_fk', md5(coalesce((SELECT string_agg(conname || ' ' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint
                                           WHERE conrelid = 'public.research_private_report_claims'::regclass AND contype = 'f'), ''))
) s
"@
$hashQ = ($hashQ -split "`r?`n") -join ' '
# R6: the equivalence fingerprint - every table 575 touches (masked: claims.updated_at, which the edge delete's confidence
# trigger sets to now(); the owner stores' batch uuids) and 575's own unrestored batch in the archive, in insert order
$fpQ = @"
SELECT string_agg(x, ' ' ORDER BY o) FROM (
  SELECT 1 AS o, 'claims=' || md5(coalesce(string_agg((to_jsonb(c) - 'updated_at')::text, '|' ORDER BY c.id), '')) AS x FROM public.claims c
  UNION ALL SELECT 2, 'claim_sources=' || md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.claim_sources x
  UNION ALL SELECT 3, 'links=' || md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.report_id, x.claim_id), '')) FROM public.research_private_report_claims x
  UNION ALL SELECT 4, 'jobs=' || md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.research_jobs x
  UNION ALL SELECT 5, 'wiki_pages=' || md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.slug), '')) FROM public.wiki_pages x
  UNION ALL SELECT 6, 'private_claims=' || md5(coalesce(string_agg((to_jsonb(x) - 'inlet_batch' - 'updated_at')::text, '|' ORDER BY x.id), '')) FROM public.inlet_private_claims x
  UNION ALL SELECT 7, 'private_edges=' || md5(coalesce(string_agg((to_jsonb(x) - 'batch')::text, '|' ORDER BY x.claim_id, x.edge_ref), '')) FROM public.inlet_private_claim_sources x
  UNION ALL SELECT 8, 'archive_rows=' || count(*) || ' archive=' || md5(coalesce(string_agg(a.tbl || '|' || a.action || '|' || coalesce(a.ref, '') || '|' || (a.row_data - 'updated_at')::text, E'
' ORDER BY a.id), ''))
    FROM public.private_report_claims_archive a
   WHERE a.restored_at IS NULL AND a.action <> 'z'
     AND a.batch IN (SELECT z.batch FROM public.private_report_claims_archive z WHERE z.action = 'z' AND z.tbl = 'slot 575' AND z.restored_at IS NULL)
) s
"@
$fpQ = ($fpQ -split "`r?`n") -join ' '
# the two guard functions 575 replaces, as installed (source + config + ACL): 570's must come back byte for byte. The
# source is compared without CRs: a Windows checkout (core.autocrlf) feeds psql CRLF files, git holds LF
$fnQ = "SELECT coalesce(string_agg(p.proname || ':' || md5(replace(p.prosrc, chr(13), '') || '|' || coalesce(p.proconfig::text, '') || '|' || coalesce(p.proacl::text, '') || '|' || p.prosecdef::text), ' ' ORDER BY p.proname), 'none') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('trg_private_report_claims_wiki_guard', 'trg_private_report_claims_gap_guard')"
$wantRed = @{
  page_hub = 'present'; page_index = 'present'; page_clean_hub = 'present'; page_person_note = 'present'; page_frag = 'present'
  claim_b1 = 'owner'; claim_m = 'withheld'; claim_f1 = 'shared'; claim_f2 = 'shared'; claim_fd = 'shared'; claim_fc = 'shared'
  job_names_f1 = '1'; job_names_fc = '1'; job_claims_reused = '2'; fc_edge_onto_f1 = '1'
  write_hub = 'saved'; write_index = 'saved'; write_ai_note = 'saved'; write_ai_note_b_own = 'refused'; write_ai_note_a_with_b = 'saved'; write_note_a_with_b = 'saved'; write_note_b_own = 'refused'
  write_note_no_author = 'saved'; write_clean_hub = 'saved'; write_entity_b1 = 'withheld'; write_entity_f1 = 'saved'; gap_branch_for_b1 = 'dropped'
  r4_job = 'rewritten'; r4_steer = 'rewritten'; r4_event = 'rewritten'
}
$wantGreen = @{
  page_hub = 'absent'; page_index = 'absent'; page_clean_hub = 'present'; page_person_note = 'present'; page_frag = 'absent'
  claim_b1 = 'owner'; claim_m = 'withheld'; claim_f1 = 'owner'; claim_f2 = 'withheld'; claim_fd = 'owner'; claim_fc = 'shared'
  job_names_f1 = '0'; job_names_fc = '1'; job_claims_reused = '1'; fc_edge_onto_f1 = '0'
  write_hub = 'withheld'; write_index = 'withheld'; write_ai_note = 'saved'; write_ai_note_b_own = 'refused'; write_ai_note_a_with_b = 'saved'; write_note_a_with_b = 'saved'; write_note_b_own = 'refused'
  write_note_no_author = 'saved'; write_clean_hub = 'saved'; write_entity_b1 = 'withheld'; write_entity_f1 = 'withheld'; gap_branch_for_b1 = 'dropped'
  r4_job = 'as-typed'; r4_steer = 'as-typed'; r4_event = 'as-typed'
}

$script:log = @()
try {
  Write-Host "== rw-570-hub-note-scope lab  owner=$Id  net=$net  evidence=$Evidence"
  # ---------------------------------------------------------------- [1] the chain
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  $names = @($chain | ForEach-Object { $_[1] })
  $i570 = [array]::IndexOf($names, '570-init-private-report-claims.sql'); $i575 = [array]::IndexOf($names, '575-init-private-report-claims-scope.sql')
  Check ($i570 -ge 0 -and $i575 -gt $i570 -and @($names | Where-Object { $_ -like '575-*' }).Count -eq 1) "the chain mounts 575-init-private-report-claims-scope.sql once, after 570 ($($chain.Count) migrations)"
  $null = Dk network create --driver bridge --internal --subnet $subnets.run --label $label $net
  Check ($script:rc -eq 0) "network $net (internal, $($subnets.run))"
  if ($script:rc -ne 0) { throw 'network' }
  $script:made.net = $true
  $o = Dk run -d --name $db --label $label --network $net -e "POSTGRES_PASSWORD=$pw" -e 'POSTGRES_DB=openbrain' -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
  if ($script:rc -ne 0) { Fail "the database did not start: $o"; throw 'db' }
  $script:made.containers += $db
  for ($i = 0; $i -lt 150; $i++) { if ((Dk logs $db) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $logs = Dk logs $db
  Check ($logs -match 'PostgreSQL init process complete') 'the database ran the initdb chain'
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "initdb logged no ERROR ($($errs.Count))"
  if ($errs.Count) { Save 'initdb-errors.log' ($errs -join "`n") }
  Check ($logs -match 'private report claims: nothing to move' -and $logs -match 'private report claims scope: nothing to move') 'on a fresh volume slots 570 and 575 have nothing to move'
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role) - the production shape'
  $c0 = Psql-Lines $checkSql 'check-fresh.log'; $s0 = Psql-Lines $scopeSql 'scope-fresh.log'
  Check ($c0 -match 'check: OK' -and $c0 -match 'slot 575 applied=true \(its guard functions in place=true\)') 'fresh chain: the check script says OK, 575 in place'
  Check ($s0 -match 'scope: OK') 'fresh chain: the scope check says OK'
  # ---------------------------------------------------------------- [2] back to the 390 model
  Write-Host '[2] revert the chain''s 575, then 570; 575 without 570 is refused'
  $f575 = Q $fnQ
  $r = Psql-File $rev575 'revert the chain''s 575'
  Check ($r.rc -eq 0 -and $r.msg -match 'scope revert: nothing to restore') 'the chain''s 575 reverts (nothing it moved)'
  $f570 = Q $fnQ; Save 'functions-570.txt' $f570
  Check ($f570 -ne $f575 -and $f570 -match 'trg_private_report_claims_gap_guard:' -and $f570 -match 'trg_private_report_claims_wiki_guard:') 'the revert put 570''s two guard functions back (they differ from 575''s)'
  Check ((Q "SELECT count(*) FROM pg_proc WHERE proname = 'private_report_claims_person_note'") -eq '0') 'the revert dropped 575''s helper'
  $s1 = Psql-Lines $scopeSql 'scope-after-575-revert.log'
  Check ($s1 -match 'scope: slot 575 applied=false' -and $s1 -match 'scope: FAIL') 'without 575 the scope check FAILS (not applied)'
  $r = Psql-File $rev570 'revert the chain''s 570'
  Check ($r.rc -eq 0 -and $r.msg -match 'foreign key restored') 'the chain''s 570 reverts (the link''s foreign key back: the 390 model)'
  $r = Psql-File $init575 '575 without 570'
  Check ($r.rc -ne 0 -and $r.msg -match 'slot 570 \(init-private-report-claims.sql\) must be applied first') "575 without 570 is refused, nothing changed (exit $($r.rc))"
  # ---------------------------------------------------------------- [3] plant
  Write-Host '[3] plant (390 model)'
  $pl = Psql-Lines (Join-Path $ct 'prc-scope-plant.sql') 'plant.log'
  Check ($pl -match 'planted=25 links=4 pages=5 claims=7') "the plant landed ($(($pl -split "`n")[-1]))"
  if ($pl -notmatch 'planted=25 links=4 pages=5 claims=7') { throw 'the plant did not land' }
  $h0 = Q $hashQ; Save 'hash-planted.txt' $h0
  # ---------------------------------------------------------------- [4] RED: 570 alone
  Write-Host "[4] RED: slot 570 alone (= $OldRef's)"
  $null = (& git -C $ob1 diff --quiet $Base570Ref -- docker/init-private-report-claims.sql docker/revert-private-report-claims.sql); $sameRc = $LASTEXITCODE
  Check ($sameRc -eq 0) "the tree's slot 570 files are $Base570Ref's (development, live), unchanged (575 is a separate slot)"
  New-Item -ItemType Directory -Force $oldDir | Out-Null
  # (the scripts carry non-ASCII letters in their normaliser: read git's output as UTF-8, not the console code page)
  $enc0 = [Console]::OutputEncoding
  try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    foreach ($f in @('check-private-report-claims.sql', 'count-private-report-claim-reuse.sql')) {
      $txt = (& git -C $ob1 show "${OldRef}:docker/$f") -join "`n"
      Check ($LASTEXITCODE -eq 0 -and $txt -match 'prc_norm') "$OldRef's $f read"
      [System.IO.File]::WriteAllText((Join-Path $oldDir $f), $txt + "`n", (New-Object System.Text.UTF8Encoding $false))
    }
  } finally { [Console]::OutputEncoding = $enc0 }
  $r = Psql-File $init570 '570'
  Check ($r.rc -eq 0 -and $r.msg -match '2 claim\(s\) moved to their owner''s store' -and $r.msg -match '1 withheld \(no single owner\)' -and $r.msg -match '0 wiki page\(s\) withheld' -and $r.msg -match '0 shared synthesis\(es\) moved private to their claim''s owner, 1 withheld') '570 moves b1 / b2 to B, withholds m and the synthesis; it withholds no page (the hub and the index are class note)'
  $h570 = Q $hashQ; Save 'hash-570.txt' $h570
  Check ((Q $fnQ) -eq $f570) '570''s guard functions are the ones the chain''s 575 revert restored'
  $red = Probe 'probe-red.txt'
  Check-Probe $red $wantRed 'RED (570 alone)'
  $oc = Psql-Lines (Join-Path $oldDir 'check-private-report-claims.sql') 'check-old-570.log'
  Check ($oc -match 'check: OK' -and $oc -match "wiki pages carrying one's text=0") "RED: $OldRef's check script says OK - it misses the hub, the index and the fragments"
  $ou = Psql-Lines (Join-Path $oldDir 'count-private-report-claim-reuse.sql') 'count-old-570.log'
  Check ($ou -notmatch 'notebook hub' -and $ou -notmatch 'fragment' -and $ou -match "shared syntheses carrying a private-report claim's sentence=0" -and $ou -match 'other shared claims carrying one \(another thread, or a superseded synthesis\)=0') "RED: $OldRef's count script counts none of them (no hub line, no fragment line, the other lines 0)"
  $nc = Psql-Lines $checkSql 'check-new-570.log'
  Check ($nc -match 'check: FAIL' -and $nc -match "wiki pages carrying one's text=2" -and $nc -match 'or structured note\)=2' -and $nc -match 'or its sentence=3' -and $nc -match 'slot 575 applied=false') 'RED: the new check script counts the 2 notebook pages and the 3 fragment claims and FAILS'
  $nu = Psql-Lines $countSql 'count-new-570.log'
  Check ($nu -match 'or structured note\) carrying one=2' -and $nu -match 'or its sentence=3') 'RED: the new count script counts the 2 notebook pages and the 3 fragment claims'
  $ns = Psql-Lines $scopeSql 'scope-570.log'
  Check ($ns -match 'scope: FAIL' -and $ns -match "carrying a private-report claim's text=2" -and $ns -match 'or its sentence=3') 'RED: the scope check counts them and FAILS'
  # ---------------------------------------------------------------- [5] GREEN: 575
  $eq = $null
  if ($EquivDir) {
    Write-Host "[5e] R6 equivalence: the earlier 575 ($EquivDir) on the same post-570 state"
    $eq = Psql-File (Join-Path $EquivDir 'init-private-report-claims-scope.sql') 'the earlier 575'
    Check ($eq.rc -eq 0) "the earlier 575 applies (exit $($eq.rc))"
    $fpOld = Q $fpQ; Save 'fingerprint-earlier-575.txt' ($fpOld -replace ' ', "`n")
    $pOld = Probe 'probe-earlier-575.txt'
    $r = Psql-File (Join-Path $EquivDir 'revert-private-report-claims-scope.sql') 'the earlier 575 revert'
    Check ($r.rc -eq 0 -and (Q $hashQ) -eq $h570) 'the earlier 575''s revert: byte-identical to 570 alone again'
  }
  Write-Host '[5] GREEN: slot 575'
  $r = Psql-File $init575 '575'
  if ($EquivDir) {
    $fpNew = Q $fpQ; Save 'fingerprint-575.txt' ($fpNew -replace ' ', "`n")
    $pNew = Probe 'probe-575-equiv.txt'
    Check ($fpNew -eq $fpOld) "[equiv] the fingerprint equals the earlier 575's (data, owner stores, archive rows in insert order)$(if ($fpNew -ne $fpOld) { ': ' + (Compare-Object ($fpOld -split ' ') ($fpNew -split ' ') | ForEach-Object { $_.InputObject + $_.SideIndicator }) -join '; ' })"
    # (the counts; the earlier 575's NOTICE said 'hub / index / AI-note page(s)', the wording RV1 corrected)
    $counts = { param($m) ((($m -split ' \| ') | Where-Object { $_ -match 'private report claims scope: [0-9]+ (fragment|edge)' }) -join ' | ') -replace ' / AI-note page', ' page' }
    Check ((& $counts $r.msg) -eq (& $counts $eq.msg) -and (& $counts $r.msg)) "[equiv] the NOTICE counts equal the earlier 575's"
    $pd = @($pNew.Keys | Where-Object { $_ -notlike 'write_*' -and "$($pNew[$_])" -ne "$($pOld[$_])" })
    Check ($pd.Count -eq 0) "[equiv] every state probe equals the earlier 575's$(if ($pd.Count) { ': ' + ($pd -join ', ') })"
  }
  Check ($r.rc -eq 0 -and $r.msg -match '2 fragment claim\(s\) and 1 claim\(s\) carrying a fragment''s sentence - 2 moved to their owner''s store \(2 edge\(s\) kept for the owner, 2 link\(s\) added\), 1 withheld' -and $r.msg -match '4 edge\(s\) archived and deleted, 1 shared claim\(s\) that lost an edge archived whole, 1 job result\(s\) stripped; 2 notebook hub / index page\(s\) withheld, 1 other page\(s\) carrying a fragment withheld') '575 moves f1 and fd to B, withholds f2, strips the job, withholds the hub, the index and the fragment page (counts only)'
  $green = Probe 'probe-green.txt'
  Check-Probe $green $wantGreen 'GREEN (575)'
  $gc = Psql-Lines $checkSql 'check-575.log'
  Check ($gc -match 'check: OK' -and $gc -match "wiki pages carrying one's text=0" -and $gc -match 'or its sentence=0' -and $gc -match 'slot 575 applied=true \(its guard functions in place=true\)') 'GREEN: the check script says OK'
  $gu = Psql-Lines $countSql 'count-575.log'
  Check ($gu -match 'or structured note\) carrying one=0' -and $gu -match 'or its sentence=0' -and $gu -match 'other shared claims carrying one \(another thread, or a superseded synthesis\)=0') 'GREEN: the count script counts 0 of them'
  $gs = Psql-Lines $scopeSql 'scope-575.log'
  Check ($gs -match 'scope: OK' -and $gs -match 'person and structured notes \(notes/\.\.\., content/notebooks/<nb>/<note>: judged by their author only\)=1') 'GREEN: the scope check says OK; the person''s note is still there'
  $r = Psql-File $init575 '575 again'
  Check ($r.rc -eq 0 -and $r.msg -match 'scope: nothing to move') '575 a second time: nothing to move'
  $h575 = Q $hashQ; Save 'hash-575.txt' $h575
  $f575b = Q $fnQ
  $r = Psql-File $init570 '570 re-run after 575'
  Check ($r.rc -eq 0 -and $r.msg -match 'private report claims: nothing to move') '570 re-run after 575: nothing to move'
  $rc1 = Psql-Lines $checkSql 'check-570-rerun.log'; $rs1 = Psql-Lines $scopeSql 'scope-570-rerun.log'
  Check ($rc1 -match 'check: FAIL' -and $rc1 -match 're-run 575' -and $rs1 -match 'scope: FAIL') 'a 570 re-run after 575 is a FAIL in both checks (570 put its own guard functions back)'
  $r = Psql-File $init575 '575 after the 570 re-run'
  Check ($r.rc -eq 0 -and $r.msg -match 'scope: nothing to move') '575 again after the 570 re-run: nothing to move'
  $rc2 = Psql-Lines $checkSql 'check-575-rerun.log'; $rs2 = Psql-Lines $scopeSql 'scope-575-rerun.log'
  Check ($rc2 -match 'check: OK' -and $rs2 -match 'scope: OK' -and (Q $fnQ) -eq $f575b -and (Q $hashQ) -eq $h575) 'after 575 again both checks say OK; data and guard functions as after the first 575'
  # ---------------------------------------------------------------- [6] revert 575
  Write-Host '[6] revert 575 (byte-identical to 570 alone), twice'
  $r = Psql-File $rev575 'revert 575'
  Check ($r.rc -eq 0 -and $r.msg -match '1 batch\(es\): 3 claim\(s\) restored \(4 edge\(s\), 1 shared claim image\(s\)\), 1 job result\(s\), 3 wiki page\(s\), 2 added link\(s\) removed') 'the revert restores f1 / f2 / fd, the 4 edges, the control''s image, the job, the 3 pages, and removes the 2 links'
  $h1 = Q $hashQ; Save 'hash-575-reverted.txt' $h1
  Check ($h1 -eq $h570) 'after the 575 revert every touched table is byte-identical to 570 alone'
  if ($h1 -ne $h570) { Save 'hash-diff-575.txt' ("570:      $h570`nreverted: $h1") }
  Check ((Q $fnQ) -eq $f570) '570''s two guard functions are back byte for byte (source, config, ACL)'
  $r = Psql-File $rev575 'revert 575 again'
  Check ($r.rc -eq 0 -and $r.msg -match 'scope revert: nothing to restore') 'a second 575 revert has nothing to restore'
  $back = Probe 'probe-reverted.txt'
  Check-Probe $back $wantRed 'after the 575 revert (the RED state again)'
  # ---------------------------------------------------------------- [7] 575, revert 575, revert 570
  Write-Host '[7] 575, revert 575, revert 570 (byte-identical to the plant)'
  $r = Psql-File $init575 '575 once more'
  Check ($r.rc -eq 0 -and $r.msg -match '2 moved to their owner''s store' -and $r.msg -match '1 other page\(s\) carrying a fragment withheld') '575 after its revert moves the same again'
  $r = Psql-File $rev575 'revert 575'
  Check ($r.rc -eq 0 -and $r.msg -match '1 batch\(es\)') 'revert 575'
  $r = Psql-File $rev570 'revert 570'
  Check ($r.rc -eq 0 -and $r.msg -match 'foreign key restored') "570's own revert works after 575's"
  $h2 = Q $hashQ; Save 'hash-reverted-both.txt' $h2
  Check ($h2 -eq $h0) 'after both reverts (575 first) every touched table is byte-identical to the plant'
  if ($h2 -ne $h0) { Save 'hash-diff-both.txt' ("planted:  $h0`nreverted: $h2") }
  # ---------------------------------------------------------------- [8] 570's revert alone
  Write-Host '[8] 570, 575, then 570''s revert ALONE'
  $r = Psql-File $init570 '570'; Check ($r.rc -eq 0) '570'
  $r = Psql-File $init575 '575'; Check ($r.rc -eq 0 -and $r.msg -match '2 moved') '575'
  $r = Psql-File $rev570 'revert 570 alone'
  Check ($r.rc -eq 0 -and $r.msg -match 'foreign key restored') "570's revert alone restores 575's batch too"
  $h3 = Q $hashQ; Save 'hash-570-revert-alone.txt' $h3
  Check ($h3 -eq $h0) '570''s revert alone: every touched table byte-identical to the plant'
  $r = Psql-File $rev575 'revert 575 after 570''s'
  Check ($r.rc -eq 0 -and $r.msg -match 'scope revert: nothing to restore') '575''s revert after 570''s: nothing to restore'
  $left = Q "SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('private_report_claims_person_note', 'trg_private_report_claims_wiki_guard', 'trg_private_report_claims_gap_guard')"
  Check ($left -eq '0') "no slot 570 / 575 guard function or helper is left behind ($left)"
  # ---------------------------------------------------------------- [9] R5: the structured-note door
  # (575 applied, B's b1 in B's store) POST /workbench/notes as A quoting B's claim, as B quoting B's own, and a clean note
  # by A: on the tip image the quoting notes are SAVED (201, the vault file written; 575's guard then withholds the row
  # silently); on the fix they are REFUSED (422, the one message, no vault file, no row); the clean note saves on both.
  Write-Host '[9] R5: the structured-note door (workbench images), on 570 + 575 applied again'
  if (-not $WorkbenchTag -or -not $BaseWorkbenchTag) {
    if ($NoWorkbench) { Write-Host '    (skipped: -NoWorkbench)' } else { Fail 'R5 needs -WorkbenchTag and -BaseWorkbenchTag (or -NoWorkbench to skip it)' }
  } else {
    $r = Psql-File $init570 '570 for R5'; Check ($r.rc -eq 0 -and $r.msg -match '2 claim\(s\) moved') '570 again (R5 runs on the migrated state)'
    $r = Psql-File $init575 '575 for R5'; Check ($r.rc -eq 0 -and $r.msg -match '2 moved') '575 again'
    . (Join-Path $PSScriptRoot 'ob-workbench-role.ps1'); $wbDb = Use-ObWorkbenchRole $appPw
    Check ($wbDb.role -eq 'ob_workbench') 'the lab workbench logs in as ob_workbench (slot 480), as compose runs it'
    $t_b1 = Q "SELECT v FROM public.lab_prc_scope WHERE k = 't_b1'"
    $r5 = @{}
    foreach ($phase in @(@('red', $BaseWorkbenchTag), @('green', $WorkbenchTag))) {
      $ph = $phase[0]; $tag = $phase[1]
      $null = Dk image inspect $tag
      Check ($script:rc -eq 0) "${ph}: the image $tag is present"
      if ($script:rc -ne 0) { continue }
      if (Test-Path $vault) { Remove-Item -Recurse -Force $vault }
      New-Item -ItemType Directory -Force $vault | Out-Null
      $wbName = "$P-wb-$ph"
      $o = Dk run -d --name $wbName --label $label --network $net --network-alias $wbName -e 'PORT=8000' -e "WORKBENCH_KEY=$key" -e "DB_HOST=$db" `
        -e "DB_USER=$($wbDb.role)" -e "DB_PASSWORD=$($wbDb.pw)" -e 'OPEN_BRAIN_URL=http://unreachable.invalid' -e 'EMBEDDING_API_BASE=http://unreachable.invalid/v1' `
        -e 'EXTRACT_URL=http://unreachable.invalid' -e 'WIKI_GIT_DIR=/wiki' -e 'WIKI_ASSETS_DIR=/wiki/assets' -e 'CONTRACT_MOUNTS_ROOT=/mounts' `
        -e 'RESEARCH_URL=http://unreachable.invalid' -e 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub' -v "${vault}:/wiki" -v "$(Join-Path $ob1 'recipes'):/recipes:ro" $tag
      if ($script:rc -ne 0) { Fail "${ph}: the workbench did not start: $o"; continue }
      $script:made.containers += $wbName
      $up = $false
      for ($i = 0; $i -lt 60; $i++) {
        $null = Dk run --rm --label $label --network $net --entrypoint deno $tag eval "const r = await fetch('http://${wbName}:8000/health').catch(() => null); Deno.exit(r && r.status < 500 ? 0 : 1)"
        if ($script:rc -eq 0) { $up = $true; break }
        Start-Sleep -Seconds 2
      }
      Check $up "${ph}: the workbench is up"
      if (-not $up) { Save "wb-$ph.log" ((Dk logs $wbName) | Out-String); continue }
      # (name, writer, content, title, agent, chat) - title '@NB' = the notebook's own name (its hub path on the tip),
      # '@NBVAR' = a spelling that slugifies to it (case, punctuation); attempt 2: the tester's hub-path oracle and F1
      $none = 'Notes. The prcznobody zeta finding is in no private report anywhere at all.'
      # attempt 3 (tester Case 6): B's sentence split - its first words in the title, the rest in the content
      $wB = Q "SELECT v FROM public.lab_prc_scope WHERE k = 'w'"
      $splitTitle = "The $wB alpha result"; $splitRest = 'reproduced in twelve trials across two labs.'
      $cases = @(
        @('a_quotes_b', $subA, "Notes from a call. $t_b1 More notes.", '', '', ''),
        @('b_quotes_own', $subB, "My summary. $t_b1", '', '', ''),
        @('a_clean', $subA, 'A clean note about zebra crossings and nothing private.', '', '', ''),
        @('a_hub_quotes_b', $subA, "Notes from a call. $t_b1 More notes.", '@NB', '', ''),
        @('a_hub_quotes_none', $subA, $none, '@NB', '', ''),
        @('a_hubvar_quotes_b', $subA, "Notes from a call. $t_b1 More notes.", '@NBVAR', '', ''),
        @('a_hubvar_quotes_none', $subA, $none, '@NBVAR', '', ''),
        @('b_own_in_agent', $subB, 'A clean note body.', '', $t_b1, ''),
        @('b_own_in_chat', $subB, 'A clean note body.', '', '', $t_b1),
        @('b_split_own', $subB, $splitRest, $splitTitle, '', ''),
        @('a_split_b', $subA, $splitRest, $splitTitle, '', ''),
        # rw-note-slug-owner: two writers, ONE notebook and title (the 7th field names the shared notebook): both notes survive
        @('so_a', $subA, 'Owner note text X from A.', '', '', '', 'owner'),
        @('so_b', $subB, 'Owner note text Y from B.', '', '', '', 'owner'),
        @('so_a2', $subA, 'Owner note text X2 from A, saved again.', '', '', '', 'owner'),
        @('so_hub_a', $subA, 'Hub-titled text X from A.', '@NB', '', '', 'owner'),
        @('so_hub_b', $subB, 'Hub-titled text Y from B.', '@NB', '', '', 'owner'),
        @('so_note_a', $subA, 'Note-titled text X from A.', '@NBNOTE', '', '', 'owner'),
        @('so_note_b', $subB, 'Note-titled text Y from B.', '@NBNOTE', '', '', 'owner'),
        # B's sentence in A's note saves, B's own is refused, with both writers on the shared name
        @('so_a_quotes_b', $subA, "Notes from a call. $t_b1 More notes.", 'quote', '', '', 'owner'),
        @('so_b_quotes_own', $subB, "My summary. $t_b1", 'quote', '', '', 'owner'))
      foreach ($case in $cases) {
        $nb = "prcr5$ph$(if ($case.Count -gt 6) { $case[6] } else { $case[0] -replace '_', '' })"
        $title = switch ($case[3]) { '@NB' { $nb } '@NBVAR' { $nb.ToUpper() + '!' } '@NBNOTE' { "$nb-note" } '' { 'r5 note' } default { $case[3] } }
        $js = "const o = { notebook: Deno.env.get('R5_NB'), title: Deno.env.get('R5_TITLE'), content: Deno.env.get('R5_CONTENT'), source: 'user_note' }; if (Deno.env.get('R5_AGENT')) o.agent = Deno.env.get('R5_AGENT'); if (Deno.env.get('R5_CHAT')) o.chat = Deno.env.get('R5_CHAT'); const r = await fetch('http://${wbName}:8000/workbench/notes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-brain-key': Deno.env.get('R5_KEY'), 'X-Test-Sub': Deno.env.get('R5_SUB') }, body: JSON.stringify(o) }); const t = await r.text(); console.log('R5STATUS=' + r.status); console.log('R5BODY=' + t.slice(0, 300));"
        $envs = @('-e', "R5_KEY=$key", '-e', "R5_SUB=$($case[1])", '-e', "R5_NB=$nb", '-e', "R5_TITLE=$title", '-e', "R5_CONTENT=$($case[2])")
        if ($case[4]) { $envs += @('-e', "R5_AGENT=$($case[4])") }
        if ($case[5]) { $envs += @('-e', "R5_CHAT=$($case[5])") }
        $out = Lab-Docker 600 (@('run', '--rm', '--label', $label, '--network', $net) + $envs + @('--entrypoint', 'deno', $tag, 'eval', $js))
        $st = ([regex]'R5STATUS=(\d+)').Match($out).Groups[1].Value
        $bd = ([regex]'R5BODY=(.*)').Match($out).Groups[1].Value
        $files = @(Get-ChildItem -Recurse -File -Path (Join-Path $vault 'content\notebooks') -Filter '*.md' -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match [regex]::Escape($nb) }).Count
        $rows = Q "SELECT count(*) FROM public.wiki_pages WHERE slug LIKE 'content/notebooks/$nb/%'"
        $r5["${ph}_$($case[0])"] = "status=$st file=$files row=$rows"
        $r5["${ph}_$($case[0])_body"] = $bd
        # the body's shape: its keys, and the stored path with this case's notebook slug masked
        $shape = (([regex]'"([a-z_]+)":').Matches($bd) | ForEach-Object { $_.Groups[1].Value }) -join ','
        $pm = ([regex]'"path":"([^"]*)"').Match($bd)
        if ($pm.Success) { $shape += ' path=' + ($pm.Groups[1].Value -replace [regex]::Escape($nb), 'NB') }
        $r5["${ph}_$($case[0])_shape"] = $shape
        if ($case[0] -eq 'a_quotes_b') {
          # served: an author-less re-sync of the same row (the viewer's reconcile) keeps it (UPDATE ... RETURNING)
          $r5["${ph}_$($case[0])_served"] = Q "WITH u AS (UPDATE public.wiki_pages SET body = body WHERE slug LIKE 'content/notebooks/$nb/%' RETURNING 1) SELECT count(*) FROM u"
        }
        Write-Host "    [$ph] $($case[0]): status=$st file=$files row=$rows $(if ($st -ne '201') { $bd })"
      }
      Save "wb-$ph.log" ((Dk logs $wbName) | Out-String)
      $null = Dk rm -f $wbName
    }
    Save 'r5.txt' (($r5.Keys | Sort-Object | ForEach-Object { "$_ $($r5[$_])" }) -join "`n")
    $msg = 'this note quotes a private report; remove that sentence, or share the report first'
    Check ($r5['red_b_quotes_own'] -eq 'status=201 file=1 row=1') "R5 RED (the tip): B's structured note quoting B's OWN private-report sentence is SAVED and served (201, file, row): $($r5['red_b_quotes_own'])"
    Check ($r5['green_b_quotes_own'] -eq 'status=422 file=0 row=0' -and $r5['green_b_quotes_own_body'] -match [regex]::Escape($msg)) "R5 GREEN: B's note quoting B's OWN sentence is REFUSED, 422 with the one message, no vault file, no row: $($r5['green_b_quotes_own'])"
    Check ($r5['green_a_quotes_b'] -eq 'status=201 file=1 row=1' -and $r5['green_a_quotes_b_served'] -eq '1') "R5 GREEN: A's note quoting only B's sentence is SAVED and SERVED like any note (201, file, row; still there after an author-less re-sync): $($r5['green_a_quotes_b']) served=$($r5['green_a_quotes_b_served'])"
    Check ($r5['red_a_quotes_b'] -eq 'status=201 file=1 row=1') "R5: on the tip too, A's note quoting B's sentence is saved (the fix changes nothing there): $($r5['red_a_quotes_b'])"
    Check ($r5['red_a_clean'] -eq 'status=201 file=1 row=1' -and $r5['green_a_clean'] -eq 'status=201 file=1 row=1') "R5: a note with no such sentence saves as before on both (red $($r5['red_a_clean']); green $($r5['green_a_clean']))"
    # attempt 2 (the tester's hub-path oracle): title = the notebook's name, A quoting B's sentence vs a sentence nobody holds
    foreach ($v in @('hub', 'hubvar')) {
      $qb = "a_${v}_quotes_b"; $qn = "a_${v}_quotes_none"
      Check ($r5["red_$qb"] -ne $r5["red_$qn"]) "R5 RED (the tip, title = notebook$(if ($v -eq 'hubvar') { ', another spelling' })): A quoting B's sentence and A quoting nobody's are DISTINGUISHABLE (the oracle) - B's: $($r5["red_$qb"]); nobody's: $($r5["red_$qn"])"
      Check ($r5["green_$qb"] -eq 'status=201 file=1 row=1' -and $r5["green_$qn"] -eq 'status=201 file=1 row=1' -and $r5["green_${qb}_shape"] -eq $r5["green_${qn}_shape"] -and $r5["green_${qb}_shape"] -match 'path=content/notebooks/NB/NB-note-[0-9a-f]{8}\.md') "R5 GREEN (title = notebook$(if ($v -eq 'hubvar') { ', another spelling' })): both SAVED and served beside the hub, the same status and body shape - B's: $($r5["green_$qb"]) [$($r5["green_${qb}_shape"])]; nobody's: $($r5["green_$qn"]) [$($r5["green_${qn}_shape"])]"
    }
    # rw-note-slug-owner: two writers, one notebook and title. RED (the tip): B's save replaced A's note (still ONE file and ONE
    # row after both saves); GREEN: two files and two rows, each reading its own text; A saving again replaces only A's.
    # (per-writer files in the owner notebook, green: 'r5 note' A+B, <nb>-note A+B (the hub-titled and note-titled saves of one
    # writer are the one file: the hub rule), 'quote' A = 5; B's own-sentence save is refused and writes nothing)
    $oa = $r5['green_so_b_shape'] -replace '-[0-9a-f]{8}\.md', '-TAG.md'
    $ob = $r5['green_a_clean_shape'] -replace '-[0-9a-f]{8}\.md', '-TAG.md'
    $nbOwn = { param($ph) "prcr5${ph}owner" }
    Check ($r5['red_so_a'] -eq 'status=201 file=1 row=1' -and $r5['red_so_b'] -eq 'status=201 file=1 row=1') "R5 RED (the tip): B's save over A's name REPLACED A's note (one file, one row after both): A $($r5['red_so_a']); B $($r5['red_so_b'])"
    Check ($r5['green_so_a'] -eq 'status=201 file=1 row=1' -and $r5['green_so_b'] -eq 'status=201 file=2 row=2') "R5 GREEN: B's save over A's name left both notes (two files, two rows): A $($r5['green_so_a']); B $($r5['green_so_b'])"
    Check ($r5['green_so_a2'] -eq 'status=201 file=2 row=2') "R5 GREEN: A saving again replaced only A's note (still two files, two rows): $($r5['green_so_a2'])"
    Check ($r5['green_so_hub_b'] -eq 'status=201 file=3 row=3' -and $r5['green_so_note_b'] -eq 'status=201 file=4 row=4') "R5 GREEN: titles <nb> and <nb>-note: A and B each keep their own <nb>-note (4 files after both writers): hub B $($r5['green_so_hub_b']); note B $($r5['green_so_note_b'])"
    $dg = Join-Path $vault 'content\notebooks\prcr5greenowner'
    $tx = @(Get-ChildItem -File -Path $dg -Filter '*.md' -ErrorAction SilentlyContinue | ForEach-Object { [System.IO.File]::ReadAllText($_.FullName) })
    $has = { param($t) @($tx | Where-Object { $_.Contains($t) }).Count }
    Save 'owner-green.txt' ("files=$($tx.Count)`n" + ($tx -join "`n----`n"))
    Check ((& $has 'text X2 from A') -eq 1 -and (& $has 'text X from A') -eq 0 -and (& $has 'text Y from B') -eq 1) "R5 GREEN: the files read A's second text X2 and B's Y (A's X was replaced by A's own re-save; B's untouched)"
    Check ((& $has 'Note-titled text X from A') -eq 1 -and (& $has 'Note-titled text Y from B') -eq 1) "R5 GREEN: the <nb>-note files read A's and B's own texts"
    Check ($r5['green_so_b_quotes_own'] -match '^status=422' -and $r5['green_so_b_quotes_own_body'] -match [regex]::Escape($msg)) "R5 GREEN: B's own sentence is refused (422) on the shared name too: $($r5['green_so_b_quotes_own'])"
    Check ($r5['green_so_a_quotes_b'] -match '^status=201') "R5 GREEN: B's sentence in A's note saves on the shared name: $($r5['green_so_a_quotes_b'])"
    Check ($r5['green_so_b'] -match '^status=201' -and $oa -eq $ob -and $oa -match 'path=content/notebooks/NB/') "R5 GREEN (no oracle): B over A's name answers 201 with the same body keys and path shape as a name nobody holds: [$($r5['green_so_b_shape'])] vs [$($r5['green_a_clean_shape'])]"
    # attempt 2 (F1): the writer's own sentence in a field that lands in the vault file's frontmatter
    foreach ($f in @('agent', 'chat')) {
      $k = "b_own_in_$f"
      Check ($r5["red_$k"] -eq 'status=201 file=1 row=1') "R5 RED (the tip): B's own sentence in the $f field is SAVED into the shared vault file: $($r5["red_$k"])"
      Check ($r5["green_$k"] -eq 'status=422 file=0 row=0' -and $r5["green_${k}_body"] -match [regex]::Escape($msg)) "R5 GREEN: B's own sentence in the $f field is REFUSED (422, the one message, no file, no row): $($r5["green_$k"])"
    }
    # attempt 3 (tester Case 6): the writer's own sentence split across the title and the content
    Check ($r5['red_b_split_own'] -eq 'status=201 file=1 row=1') "R5 RED (the tip): B's own sentence split across title and content is SAVED: $($r5['red_b_split_own'])"
    Check ($r5['green_b_split_own'] -eq 'status=422 file=0 row=0' -and $r5['green_b_split_own_body'] -match [regex]::Escape($msg)) "R5 GREEN: B's own sentence split across title and content is REFUSED (422, no vault file, no row): $($r5['green_b_split_own'])"
    Check ($r5['red_a_split_b'] -eq 'status=201 file=1 row=1' -and $r5['green_a_split_b'] -eq 'status=201 file=1 row=1') "R5: A writing B's sentence split the same way is SAVED and served on both (red $($r5['red_a_split_b']); green $($r5['green_a_split_b']))"
    # (a refusal body only: a saved note's body echoes its own path, which the split cases build from the writer's own title)
    $leak = @($r5.Keys | Where-Object { $_ -like '*_body' } | Where-Object { $r5[$_] -match '"error"' -and $r5[$_] -match 'prcb' })
    Check ($leak.Count -eq 0) 'R5: no refusal body carries the claim''s text'
  }
} catch {
  Fail "aborted: $($_.Exception.Message)"
} finally {
  Save 'psql.log' ($script:log -join "`n")
  foreach ($c in $script:made.containers) { $null = Dk rm -f $c }
  if ($script:made.net) { $null = Dk network rm $net }
  foreach ($d in @($stage, $oldDir, $vault)) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}' | Out-String).Trim()
  Check (-not $left) "nothing labelled $label is left running ($left)"
}
Write-Host ''
if ($script:fail -eq 0) { Write-Host "ALL PASSED  (evidence: $Evidence)"; exit 0 } else { Write-Host "$($script:fail) FAILED  (evidence: $Evidence)"; exit 1 }
