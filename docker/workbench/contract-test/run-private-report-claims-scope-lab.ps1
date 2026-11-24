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
#       job's reuse list; a new hub / index / AI note carrying a private claim is withheld; person notes keep the
#       author-only rule; a NULL-kind row is stored as typed; every check says OK; 575 again: nothing to move; a 570
#       re-run is a check FAIL until 575 runs again
#   [6] revert 575: byte-identical to [4]'s post-570 hashes, 570's guard functions back byte for byte; again: nothing
#   [7] 575, revert 575, revert 570: byte-identical to the planted hashes
#   [8] 570, 575, then 570's revert ALONE: byte-identical to the planted hashes; then 575's revert leaves no function
# Exit 0 = every check passed. Counts and states only - never a claim's text. Never the live stack.
param(
  [string]$Id = 'wt-rw-570-hub-note-scope',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  # the base whose 570 / check / count scripts are the RED (OB1 912b3f1: slot 570 as merged)
  [string]$OldRef = '912b3f18'
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
# the two guard functions 575 replaces, as installed (source + config + ACL): 570's must come back byte for byte
$fnQ = "SELECT coalesce(string_agg(p.proname || ':' || md5(p.prosrc || '|' || coalesce(p.proconfig::text, '') || '|' || coalesce(p.proacl::text, '') || '|' || p.prosecdef::text), ' ' ORDER BY p.proname), 'none') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('trg_private_report_claims_wiki_guard', 'trg_private_report_claims_gap_guard')"
$RED = @{
  page_hub = 'present'; page_index = 'present'; page_clean_hub = 'present'; page_person_note = 'present'; page_frag = 'present'
  claim_b1 = 'owner'; claim_m = 'withheld'; claim_f1 = 'shared'; claim_f2 = 'shared'; claim_fd = 'shared'; claim_fc = 'shared'
  job_names_f1 = '1'; job_names_fc = '1'; job_claims_reused = '2'; fc_edge_onto_f1 = '1'
  write_hub = 'saved'; write_index = 'saved'; write_ai_note = 'saved'; write_note_a_with_b = 'saved'; write_note_b_own = 'refused'
  write_note_no_author = 'saved'; write_clean_hub = 'saved'; write_entity_b1 = 'withheld'; write_entity_f1 = 'saved'; gap_branch_for_b1 = 'dropped'
  r4_job = 'rewritten'; r4_steer = 'rewritten'; r4_event = 'rewritten'
}
$GREEN = @{
  page_hub = 'absent'; page_index = 'absent'; page_clean_hub = 'present'; page_person_note = 'present'; page_frag = 'absent'
  claim_b1 = 'owner'; claim_m = 'withheld'; claim_f1 = 'owner'; claim_f2 = 'withheld'; claim_fd = 'owner'; claim_fc = 'shared'
  job_names_f1 = '0'; job_names_fc = '1'; job_claims_reused = '1'; fc_edge_onto_f1 = '0'
  write_hub = 'withheld'; write_index = 'withheld'; write_ai_note = 'withheld'; write_note_a_with_b = 'saved'; write_note_b_own = 'refused'
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
  $null = (& git -C $ob1 diff --quiet $OldRef -- docker/init-private-report-claims.sql docker/revert-private-report-claims.sql); $sameRc = $LASTEXITCODE
  Check ($sameRc -eq 0) "the tree's slot 570 files are $OldRef's, unchanged (575 is a separate slot)"
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
  Check-Probe $red $RED 'RED (570 alone)'
  $oc = Psql-Lines (Join-Path $oldDir 'check-private-report-claims.sql') 'check-old-570.log'
  Check ($oc -match 'check: OK' -and $oc -match "wiki pages carrying one's text=0") "RED: $OldRef's check script says OK - it misses the hub, the index and the fragments"
  $ou = Psql-Lines (Join-Path $oldDir 'count-private-report-claim-reuse.sql') 'count-old-570.log'
  Check ($ou -notmatch 'notebook hub' -and $ou -notmatch 'fragment' -and $ou -match "shared syntheses carrying a private-report claim's sentence=0" -and $ou -match 'other shared claims carrying one \(another thread, or a superseded synthesis\)=0') "RED: $OldRef's count script counts none of them (no hub line, no fragment line, the other lines 0)"
  $nc = Psql-Lines $checkSql 'check-new-570.log'
  Check ($nc -match 'check: FAIL' -and $nc -match "wiki pages carrying one's text=2" -and $nc -match 'not under notes/\)=2' -and $nc -match 'or its sentence=3' -and $nc -match 'slot 575 applied=false') 'RED: the new check script counts the 2 notebook pages and the 3 fragment claims and FAILS'
  $nu = Psql-Lines $countSql 'count-new-570.log'
  Check ($nu -match 'not under notes/\) carrying one=2' -and $nu -match 'or its sentence=3') 'RED: the new count script counts the 2 notebook pages and the 3 fragment claims'
  $ns = Psql-Lines $scopeSql 'scope-570.log'
  Check ($ns -match 'scope: FAIL' -and $ns -match "carrying a private-report claim's text=2" -and $ns -match 'or its sentence=3') 'RED: the scope check counts them and FAILS'
  # ---------------------------------------------------------------- [5] GREEN: 575
  Write-Host '[5] GREEN: slot 575'
  $r = Psql-File $init575 '575'
  Check ($r.rc -eq 0 -and $r.msg -match '2 fragment claim\(s\) and 1 claim\(s\) carrying a fragment''s sentence - 2 moved to their owner''s store \(2 edge\(s\) kept for the owner, 2 link\(s\) added\), 1 withheld' -and $r.msg -match '4 edge\(s\) archived and deleted, 1 shared claim\(s\) that lost an edge archived whole, 1 job result\(s\) stripped; 2 notebook hub / index / AI-note page\(s\) withheld, 1 other page\(s\) carrying a fragment withheld') '575 moves f1 and fd to B, withholds f2, strips the job, withholds the hub, the index and the fragment page (counts only)'
  $green = Probe 'probe-green.txt'
  Check-Probe $green $GREEN 'GREEN (575)'
  $gc = Psql-Lines $checkSql 'check-575.log'
  Check ($gc -match 'check: OK' -and $gc -match "wiki pages carrying one's text=0" -and $gc -match 'or its sentence=0' -and $gc -match 'slot 575 applied=true \(its guard functions in place=true\)') 'GREEN: the check script says OK'
  $gu = Psql-Lines $countSql 'count-575.log'
  Check ($gu -match 'not under notes/\) carrying one=0' -and $gu -match 'or its sentence=0' -and $gu -match 'other shared claims carrying one \(another thread, or a superseded synthesis\)=0') 'GREEN: the count script counts 0 of them'
  $gs = Psql-Lines $scopeSql 'scope-575.log'
  Check ($gs -match 'scope: OK' -and $gs -match 'person notes \(notes/\.\.\., judged by their author only\)=1') 'GREEN: the scope check says OK; the person''s note is still there'
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
  Check-Probe $back $RED 'after the 575 revert (the RED state again)'
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
} catch {
  Fail "aborted: $($_.Exception.Message)"
} finally {
  Save 'psql.log' ($script:log -join "`n")
  foreach ($c in $script:made.containers) { $null = Dk rm -f $c }
  if ($script:made.net) { $null = Dk network rm $net }
  foreach ($d in @($stage, $oldDir)) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}' | Out-String).Trim()
  Check (-not $left) "nothing labelled $label is left running ($left)"
}
Write-Host ''
if ($script:fail -eq 0) { Write-Host "ALL PASSED  (evidence: $Evidence)"; exit 0 } else { Write-Host "$($script:fail) FAILED  (evidence: $Evidence)"; exit 1 }
