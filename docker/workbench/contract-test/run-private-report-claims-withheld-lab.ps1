# run-private-report-claims-withheld-lab.ps1 - slot 660 (init-private-report-claims-withheld.sql, research-workbench
# rw-withheld-owner-view) in a DISPOSABLE lab: the real initdb chain on the pgvector image, and (with -WorkbenchTag) the
# tree's workbench image for the HTTP door. Needs the open-brain lease (the tester holds it).
#
#   powershell -NoProfile -File OB1/docker/workbench/contract-test/run-private-report-claims-withheld-lab.ps1 -Id wt-rw-withheld-owner-view -Subnet 10.x.y.0/24 [-Evidence <empty dir>] [-WorkbenchTag openbrain-workbench:wt-rw-withheld-owner-view | -NoWorkbench]
#
# What it does, and ONLY this (every docker call through the shim: the run's --internal network on the pinned /25, the
# ai-stack.harness.owner label, no published port, no :local image, no compose, no build; the rehearsal container runs on
# --network none):
#   [1] stages the REAL initdb chain from OB1/docker/docker-compose.yml (570, 575 and 660 included, 660 once, after 575 and
#       600) and starts it; the 570 / 575 / 660 check scripts say OK on the fresh chain
#   [2] reverts the chain in the documented order (660, 575, 570: the 390 model); 660 without 570 is refused
#   [3] plants (prc-withheld-plant.sql): A's and B's private reports both linking s, an ownerless and an 'operator' report
#       linking n, A's report alone linking k, a shared control q; hashes every table 570 / 575 touch
#   [4] RED: 570 + 575 (s and n withheld, k to A's store): A's and B's notes quoting s SAVE on both doors; the 660 check FAILS
#   [5] GREEN: 660 (relation locks recorded): A and B refused on both doors, C saves as a sentence nobody holds, n refused for
#       nobody, k as before; the 570, 575 and 660 checks say OK; no data hash moved; 660 again: the same function
#   [6] mutations (scratch copies of the init, each followed by the real init): M1 own_text_shows back to 570's store-only
#       read -> A / B FAIL; M2 the helper reads every withheld claim -> C FAILS
#   [7] revert 660: 570's own_text_shows byte for byte, the helper gone, [4]'s answers, no data hash moved; then 575, 570:
#       byte-identical to the planted hashes; 660, 575, 570 again, then 570's revert ALONE, then 660's revert: exit 0
#   [8] (with -WorkbenchTag) the HTTP door on 570 + 575: POST /workbench/notes as A / B / C quoting s, RED (660 reverted)
#       then GREEN (660 applied) on the same image; a shared note (PUT /workbench/notes/<path>.md) as A quoting s: its wiki_pages row
#   [9] REHEARSAL at live size in a separate --network none container: the chain, synthetic post-570 data (-RehearsePages
#       pages, -RehearseWithheld two-owner withheld claims, -RehearseStore store claims), 660's duration and relation locks
#       (no AccessExclusiveLock on a public table), the 570 / 575 / 660 checks on that copy, the check's latency; then
#       -StressWithheld withheld claims for the own-sentence check's per-call latency
# Exit 0 = every check passed. Counts and states only - never a claim's text. Never the live stack.
param(
  [string]$Id = 'wt-rw-withheld-owner-view',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$WorkbenchTag = '',
  [switch]$NoWorkbench,
  [int]$RehearsePages = 68558,
  [int]$RehearseWithheld = 200,
  [int]$RehearseStore = 200,
  [int]$StressWithheld = 10000,
  [switch]$NoRehearsal
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
$P = "rwprcw-$rand"
$net = "$P-net"
$db = "$P-db"
$rdb = "$P-rehearse"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$rr = -join ((97..122) | Get-Random -Count 10 | ForEach-Object { [char]$_ })
$subA = "prcw-ay-$rr"; $subB = "prcw-bee-$rr"; $subC = "prcw-cee-$rr"
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$scratch = Join-Path $env:TEMP "$P-scratch"
New-Item -ItemType Directory -Force $scratch | Out-Null
$vault = Join-Path $env:TEMP "$P-vault"
$key = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$utf8 = New-Object System.Text.UTF8Encoding $false
$script:fail = 0
$script:made = @{ net = $false; containers = @() }
$script:log = @()
function Pass([string]$m) { Write-Host "  PASS  $m"; $script:log += "PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:log += "FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, $utf8) }
function ReadLf([string]$p) { return ([System.IO.File]::ReadAllText($p, $utf8)) -replace "`r`n", "`n" }

# -- the lab docker shim (the 575 lab's rules; this lab builds nothing) ----------------------------------------------
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
function Dk { Lab-Docker 3600 ([string[]]$args) }
$script:on = $db
function Q([string]$q) { return ((Dk exec $script:on psql -U postgres -d openbrain -X -A -t -q -c $q) | Out-String).Trim() }
# a migration / revert file (or its text): exit code and its NOTICE / ERROR lines (counts only)
function Psql-File([string]$path, [string]$tag, [string]$text = '') {
  if ($text) { $path = Join-Path $scratch (($tag -replace '[^A-Za-z0-9]+', '-') + '.sql'); [System.IO.File]::WriteAllText($path, $text, $utf8) }
  $null = Dk cp $path "$($script:on):/tmp/prcw.sql"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $o = Dk exec $script:on psql -U postgres -d openbrain -X -A -t -q -v ON_ERROR_STOP=1 -f /tmp/prcw.sql
  $sw.Stop()
  $rc = $script:rc
  $msg = (($o -split "`n") | Where-Object { $_ -match 'NOTICE|WARNING|ERROR' } | ForEach-Object { $_ -replace '^.*?(NOTICE|WARNING|ERROR):\s*', '$1 ' }) -join ' | '
  Write-Host "    [$tag] exit ${rc} ($($sw.ElapsedMilliseconds) ms): $msg"
  $script:log += "[$tag] exit ${rc} ($($sw.ElapsedMilliseconds) ms): $msg"
  return @{ rc = $rc; msg = $msg; out = $o; ms = $sw.ElapsedMilliseconds }
}
function Psql-Lines([string]$path, [string]$save) {
  $null = Dk cp $path "$($script:on):/tmp/prcwq.sql"
  $o = ((Dk exec $script:on psql -U postgres -d openbrain -X -A -t -q -v ON_ERROR_STOP=1 -v "a=$subA" -v "b=$subB" -v "c=$subC" -v "r=$rr" -f /tmp/prcwq.sql) | Out-String).Trim()
  if ($save) { Save $save $o }
  return $o
}
function Probe([string]$save) {
  $o = Psql-Lines (Join-Path $ct 'prc-withheld-probe.sql') $save
  $h = @{}
  foreach ($l in ($o -split "`n")) { if ($l -match '^([a-z0-9_]+)=(.*)$') { $h[$Matches[1]] = $Matches[2].Trim() } }
  return $h
}
function Check-Probe([hashtable]$got, [hashtable]$want, [string]$phase) {
  $bad = @()
  foreach ($k in ($want.Keys | Sort-Object)) { if ("$($got[$k])" -ne "$($want[$k])") { $bad += "$k=$($got[$k]) (want $($want[$k]))" } }
  Check ($bad.Count -eq 0) "${phase}: $($want.Count) probes as expected$(if ($bad.Count) { ': ' + ($bad -join '; ') })"
}
function Get-Fn([string]$text, [string]$name) {
  $s = $text.IndexOf("CREATE OR REPLACE FUNCTION public.$name(")
  if ($s -lt 0) { throw "no function $name" }
  $e = $text.IndexOf("`n`$`$;", $s)
  return $text.Substring($s, $e + 4 - $s)
}
function With-Locks([string]$text) {
  return $text -replace "`nCOMMIT;\s*$", "`nSELECT 'lock ' || c.relname || ' ' || l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE l.pid = pg_backend_pid() AND ns.nspname = 'public' ORDER BY 1;`nCOMMIT;`n"
}
function Locks-Of($r) { return @(($r.out -split "`n") | Where-Object { $_ -like 'lock *' } | ForEach-Object { $_ -replace '^lock ', '' }) }
function Start-Chain([string]$name, [string[]]$netArgs) {
  $o = Dk (@('run', '-d', '--name', $name, '--label', $label) + $netArgs + @('--shm-size=1g', '-e', "POSTGRES_PASSWORD=$pw", '-e', 'POSTGRES_DB=openbrain', '-v', "${stage}:/docker-entrypoint-initdb.d:ro", $PgImage))
  if ($script:rc -ne 0) { Fail "the database $name did not start: $o"; throw 'db' }
  $script:made.containers += $name
  for ($i = 0; $i -lt 300; $i++) { if ((Dk logs $name) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $name pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  return (Dk logs $name)
}

$init570 = Join-Path $dockerDir 'init-private-report-claims.sql'
$rev570 = Join-Path $dockerDir 'revert-private-report-claims.sql'
$init575 = Join-Path $dockerDir 'init-private-report-claims-scope.sql'
$rev575 = Join-Path $dockerDir 'revert-private-report-claims-scope.sql'
$init660 = Join-Path $dockerDir 'init-private-report-claims-withheld.sql'
$rev660 = Join-Path $dockerDir 'revert-private-report-claims-withheld.sql'
$check570 = Join-Path $dockerDir 'check-private-report-claims.sql'
$check575 = Join-Path $dockerDir 'check-private-report-claims-scope.sql'
$check660 = Join-Path $dockerDir 'check-private-report-claims-withheld.sql'
$t570 = ReadLf $init570; $t660 = ReadLf $init660
$own570 = Get-Fn $t570 'private_report_claims_own_text_shows'
# every table slot 570 / 575 touch (the 575 lab's set), hashed: 660 must move none of them
$hashQ = (@"
SELECT string_agg(t || '=' || h, ' ' ORDER BY t) FROM (
  SELECT 'claims' AS t, md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) AS h FROM public.claims x
  UNION ALL SELECT 'claim_sources', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.claim_sources x
  UNION ALL SELECT 'links', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.report_id, x.claim_id), '')) FROM public.research_private_report_claims x
  UNION ALL SELECT 'jobs', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.research_jobs x
  UNION ALL SELECT 'wiki_pages', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.slug), '')) FROM public.wiki_pages x
  UNION ALL SELECT 'private_claims', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.inlet_private_claims x
  UNION ALL SELECT 'private_edges', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.claim_id, x.edge_ref, x.batch), '')) FROM public.inlet_private_claim_sources x
  UNION ALL SELECT 'sources', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.sources x
  UNION ALL SELECT 'private_reports', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.research_private_reports x
  UNION ALL SELECT 'threads', md5(coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY x.id), '')) FROM public.threads x
  UNION ALL SELECT 'archive', md5(coalesce((SELECT string_agg(to_jsonb(a)::text, '|' ORDER BY a.id) FROM public.private_report_claims_archive a WHERE to_regclass('public.private_report_claims_archive') IS NOT NULL), ''))
  UNION ALL SELECT 'link_fk', md5(coalesce((SELECT string_agg(conname || ' ' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint
                                           WHERE conrelid = 'public.research_private_report_claims'::regclass AND contype = 'f'), ''))
) s
"@ -split "`r?`n") -join ' '
$ownQ = "SELECT coalesce((SELECT md5(replace(prosrc, chr(13), '')) || '|' || coalesce(proacl::text, '') || '|' || prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.private_report_claims_own_text_shows(text,text,text)')), 'none')"

$wantRed = @{
  claim_s = 'withheld'; claim_n = 'withheld'; claim_k = 'store-a'; claim_q = 'shared'; links_s = '2'
  sn_a_s = 'saves'; sn_b_s = 'saves'; sn_c_s = 'saves'; sn_c_nobody = 'saves'
  wn_a_s = 'saved'; wn_b_s = 'saved'; wn_c_s = 'saved'; wn_c_nobody = 'saved'; ws_a_s = 'saved'; ws_c_s = 'saved'; wn_none_s = 'saved'
  sn_a_n = 'saves'; sn_c_n = 'saves'; sn_operator_n = 'saves'
  sn_a_k = 'refused'; sn_b_k = 'saves'; sn_c_k = 'saves'; wn_a_k = 'refused'; sn_a_q = 'saves'
}
$wantGreen = $wantRed.Clone()
foreach ($k in 'sn_a_s', 'sn_b_s') { $wantGreen[$k] = 'refused' }
foreach ($k in 'wn_a_s', 'wn_b_s', 'ws_a_s') { $wantGreen[$k] = 'refused' }

try {
  Write-Host "== rw-withheld-owner-view lab  owner=$Id  net=$net  evidence=$Evidence"
  # ---------------------------------------------------------------- [1] the chain
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  $names = @($chain | ForEach-Object { $_[1] } | Sort-Object)
  $i575 = [array]::IndexOf($names, '575-init-private-report-claims-scope.sql'); $i600 = [array]::IndexOf($names, '600-init-inlet-connections-read.sql')
  $i660 = [array]::IndexOf($names, '660-init-private-report-claims-withheld.sql')
  Check ($i575 -ge 0 -and $i600 -gt $i575 -and $i660 -gt $i600 -and @($names | Where-Object { $_ -like '660-*' }).Count -eq 1) "the chain runs 660-init-private-report-claims-withheld.sql once, after 575 and 600 ($($chain.Count) migrations)"
  $null = Dk network create --driver bridge --internal --subnet $subnets.run --label $label $net
  Check ($script:rc -eq 0) "network $net (internal, $($subnets.run))"
  if ($script:rc -ne 0) { throw 'network' }
  $script:made.net = $true
  $logs = Start-Chain $db @('--network', $net, '--network-alias', 'openbrain-db')
  Check ($logs -match 'PostgreSQL init process complete') 'the database ran the initdb chain'
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "initdb logged no ERROR ($($errs.Count))"
  if ($errs.Count) { Save 'initdb-errors.log' ($errs -join "`n") }
  Check ($logs -match 'private report claims withheld: 0 withheld claim\(s\) with an owner party to them \(0 owner-claim pair\(s\)\); 0 with nobody party') 'on a fresh volume 660 finds no withheld claim (counts only)'
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role) - the production shape'
  $c0 = Psql-Lines $check570 'check570-fresh.log'; $s0 = Psql-Lines $check575 'check575-fresh.log'; $w0 = Psql-Lines $check660 'check660-fresh.log'
  Check ($c0 -match 'check: OK') 'fresh chain: the 570 check says OK'
  Check ($s0 -match 'scope: OK') 'fresh chain: the 575 scope check says OK'
  Check ($w0 -match 'withheld: OK') 'fresh chain: the 660 check says OK'

  # ---------------------------------------------------------------- [2] back to the 390 model
  Write-Host '[2] revert the chain: 660, 575, 570 (the documented order); 660 without 570 is refused'
  $r = Psql-File $rev660 'revert 660'; Check ($r.rc -eq 0) "the chain's 660 reverts (exit $($r.rc))"
  $own570Live = Q $ownQ; Save 'own-text-shows-570.txt' $own570Live
  $r = Psql-File $rev575 'revert 575'; Check ($r.rc -eq 0) "the chain's 575 reverts (exit $($r.rc))"
  $r = Psql-File $rev570 'revert 570'; Check ($r.rc -eq 0 -and $r.msg -match 'foreign key restored') 'the chain''s 570 reverts (the 390 model)'
  $r = Psql-File $init660 '660 without 570'
  Check ($r.rc -ne 0 -and $r.msg -match 'slot 570 \(init-private-report-claims.sql\) must be applied first') "660 without 570 is refused, nothing changed (exit $($r.rc))"
  Check ((Q "SELECT count(*) FROM pg_proc WHERE proname IN ('private_report_claims_withheld_of', 'private_report_claims_own_text_shows')") -eq '0') '... no function left behind'

  # ---------------------------------------------------------------- [3] plant
  Write-Host '[3] plant (390 model)'
  $pl = Psql-Lines (Join-Path $ct 'prc-withheld-plant.sql') 'plant.log'
  Check ($pl -match 'planted=14 links=5 claims=4') "the plant landed ($(($pl -split "`n")[-1]))"
  if ($pl -notmatch 'planted=14 links=5 claims=4') { throw 'the plant did not land' }
  $h0 = Q $hashQ; Save 'hash-planted.txt' $h0

  # ---------------------------------------------------------------- [4] RED
  Write-Host '[4] RED: 570 + 575'
  $r = Psql-File $init570 '570'
  Check ($r.rc -eq 0 -and $r.msg -match '1 claim\(s\) moved to their owner''s store' -and $r.msg -match '2 withheld \(no single owner\)') '570 moves k to A and withholds s (two owners) and n (no valid owner)'
  $r = Psql-File $init575 '575'; Check ($r.rc -eq 0) "575 applies (exit $($r.rc))"
  Check ((Q $ownQ) -eq $own570Live) 'the own-sentence check is 570''s'
  $hRed = Q $hashQ; Save 'hash-red.txt' $hRed
  Check-Probe (Probe 'probe-red.txt') $wantRed 'RED (570 + 575: A''s and B''s notes quoting the withheld two-owner sentence SAVE)'
  $w1 = Psql-Lines $check660 'check660-red.log'
  Check ($w1 -match 'withheld: slot 660 applied=false' -and $w1 -match 'withheld: FAIL') 'RED: the 660 check FAILS (not applied)'

  # ---------------------------------------------------------------- [5] GREEN
  Write-Host '[5] GREEN: 660'
  $r = Psql-File '' '660' (With-Locks $t660)
  $locks = Locks-Of $r; Save 'locks-660.txt' ($locks -join "`n")
  Check ($r.rc -eq 0 -and $r.msg -match '1 withheld claim\(s\) with an owner party to them \(2 owner-claim pair\(s\)\); 1 with nobody party') "660 applies: s has two owners party, n nobody (counts only; $($r.ms) ms)"
  Check (@($locks | Where-Object { $_ -match 'ExclusiveLock' }).Count -eq 0) "660 holds no exclusive lock on a public table ($($locks.Count) relation lock(s): $($locks -join ', '))"
  Check ((Q $hashQ) -eq $hRed) '660 moved no row (every table 570 / 575 touch, the archive included, byte-identical)'
  $g1 = Q $ownQ
  Check-Probe (Probe 'probe-green.txt') $wantGreen 'GREEN (660)'
  $c1 = Psql-Lines $check570 'check570-green.log'; $s1 = Psql-Lines $check575 'check575-green.log'; $w2 = Psql-Lines $check660 'check660-green.log'
  Check ($c1 -match 'check: OK') 'GREEN: the 570 check says OK (no drift)'
  Check ($s1 -match 'scope: OK') 'GREEN: the 575 scope check says OK (no drift)'
  Check ($w2 -match 'withheld: OK' -and $w2 -match 'owner-claim pairs=2, owners=2' -and $w2 -match 'does not refuse=0' -and $w2 -match 'party to nothing=0') 'GREEN: the 660 check says OK (2 pairs, all refused, none for a stranger)'
  $r = Psql-File $init660 '660 again'
  Check ($r.rc -eq 0 -and (Q $ownQ) -eq $g1 -and (Q $hashQ) -eq $hRed) '660 again: the same function, no row moved'

  # ---------------------------------------------------------------- [6] mutations
  Write-Host '[6] mutations (scratch copies of the init)'
  $ofFn = Get-Fn $t660 'private_report_claims_withheld_of'
  $muts = [ordered]@{
    M1 = @{ text = $t660.Replace((Get-Fn $t660 'private_report_claims_own_text_shows'), $own570); fails = @('sn_a_s', 'sn_b_s', 'wn_a_s', 'wn_b_s', 'ws_a_s'); what = 'own_text_shows back to 570''s store-only read' }
    M2 = @{ text = $t660.Replace($ofFn, $ofFn.Replace("     WHERE p.owner_sub = p_sub`n       AND public.private_report_claim_subject_ok(p_sub)", "     WHERE true")); fails = @('sn_c_s', 'wn_c_s', 'ws_c_s', 'sn_a_n', 'sn_c_n', 'sn_operator_n'); what = 'the helper reads every withheld claim a report links' }
  }
  foreach ($m in $muts.Keys) {
    if ($muts[$m].text -eq $t660) { Fail "${m}: the mutation did not change the file text"; continue }
    $r = Psql-File '' "660 $m" $muts[$m].text
    if ($r.rc -ne 0) { Fail "${m}: the mutated init did not apply"; continue }
    $got = Probe "probe-$m.txt"
    $flipped = @($muts[$m].fails | Where-Object { "$($got[$_])" -ne "$($wantGreen[$_])" })
    $others = @($wantGreen.Keys | Where-Object { $_ -notin $muts[$m].fails -and "$($got[$_])" -ne "$($wantGreen[$_])" })
    Check ($flipped.Count -eq $muts[$m].fails.Count) "${m} ($($muts[$m].what)): the GREEN assertion(s) FAIL - $(($muts[$m].fails | ForEach-Object { "$_=$($got[$_])" }) -join ', ')"
    Check ($others.Count -eq 0) "${m}: no other probe moved$(if ($others.Count) { ': ' + ($others -join ', ') })"
    $r = Psql-File $init660 "660 after $m"
    Check ($r.rc -eq 0 -and (Q $ownQ) -eq $g1) "${m}: the real init put back"
  }

  # ---------------------------------------------------------------- [7] revert
  Write-Host '[7] revert'
  $r = Psql-File $rev660 'revert 660'
  Check ($r.rc -eq 0 -and (Q $ownQ) -eq $own570Live) "660's revert: 570's own_text_shows back byte for byte (exit $($r.rc))"
  Check ((Q "SELECT count(*) FROM pg_proc WHERE proname = 'private_report_claims_withheld_of'") -eq '0') 'the helper is gone'
  Check ((Q $hashQ) -eq $hRed) 'the revert moved no row'
  Check-Probe (Probe 'probe-reverted.txt') $wantRed 'after the revert: [4]''s answers'
  $r = Psql-File $rev575 'revert 575'; $r2 = Psql-File $rev570 'revert 570'
  $h1 = Q $hashQ; Save 'hash-reverted.txt' $h1
  Check ($r.rc -eq 0 -and $r2.rc -eq 0 -and $h1 -eq $h0) '660, 575, 570 reverted in order: byte-identical to the planted hashes'
  $null = Psql-File $init570 '570 again'; $null = Psql-File $init575 '575 again'; $null = Psql-File $init660 '660 again'
  $r = Psql-File $rev570 '570''s revert ALONE'
  Check ($r.rc -eq 0 -and (Q $hashQ) -eq $h0) "570's revert alone (660 and 575 applied): byte-identical to the planted hashes (exit $($r.rc))"
  $r = Psql-File $rev660 '660''s revert after 570''s'
  Check ($r.rc -eq 0 -and (Q $ownQ) -eq 'none') "660's revert after 570's: exit 0, no own_text_shows left behind (exit $($r.rc))"
  $null = Psql-File $rev575 '575''s revert after 570''s'
  $r = Psql-File $init570 '570 for [8]'; $r = Psql-File $init575 '575 for [8]'

  # ---------------------------------------------------------------- [8] the HTTP door
  Write-Host '[8] the HTTP door (POST /workbench/notes, PUT /notes)'
  if (-not $WorkbenchTag) {
    if ($NoWorkbench) { Write-Host '    (skipped: -NoWorkbench)' } else { Fail '[8] needs -WorkbenchTag (or -NoWorkbench to skip it)' }
  } else {
    . (Join-Path $PSScriptRoot 'ob-workbench-role.ps1'); $wbDb = Use-ObWorkbenchRole $appPw
    Check ($wbDb.role -eq 'ob_workbench') 'the lab workbench logs in as ob_workbench (slot 480), as compose runs it'
    $null = Dk image inspect $WorkbenchTag
    Check ($script:rc -eq 0) "the image $WorkbenchTag is present"
    $t_s = Q "SELECT v FROM public.lab_prcw WHERE k = 't_s'"
    $http = @{}
    foreach ($ph in @('red', 'green')) {
      if ($ph -eq 'red') { $r = Psql-File $rev660 'revert 660 for RED' } else { $r = Psql-File $init660 '660 for GREEN' }
      if (Test-Path $vault) { Remove-Item -Recurse -Force $vault }
      New-Item -ItemType Directory -Force $vault | Out-Null
      $wbName = "$P-wb-$ph"
      $o = Dk run -d --name $wbName --label $label --network $net --network-alias $wbName -e 'PORT=8000' -e "WORKBENCH_KEY=$key" -e "DB_HOST=$db" `
        -e "DB_USER=$($wbDb.role)" -e "DB_PASSWORD=$($wbDb.pw)" -e 'OPEN_BRAIN_URL=http://unreachable.invalid' -e 'EMBEDDING_API_BASE=http://unreachable.invalid/v1' `
        -e 'EXTRACT_URL=http://unreachable.invalid' -e 'WIKI_GIT_DIR=/wiki' -e 'WIKI_ASSETS_DIR=/wiki/assets' -e 'CONTRACT_MOUNTS_ROOT=/mounts' `
        -e 'RESEARCH_URL=http://unreachable.invalid' -e 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub' -v "${vault}:/wiki" -v "$(Join-Path $ob1 'recipes'):/recipes:ro" $WorkbenchTag
      if ($script:rc -ne 0) { Fail "${ph}: the workbench did not start: $o"; continue }
      $script:made.containers += $wbName
      $up = $false
      for ($i = 0; $i -lt 60; $i++) {
        $null = Dk run --rm --label $label --network $net --entrypoint deno $WorkbenchTag eval "const r = await fetch('http://${wbName}:8000/health').catch(() => null); Deno.exit(r && r.status < 500 ? 0 : 1)"
        if ($script:rc -eq 0) { $up = $true; break }
        Start-Sleep -Seconds 2
      }
      Check $up "${ph}: the workbench is up"
      if (-not $up) { Save "wb-$ph.log" ((Dk logs $wbName) | Out-String); continue }
      $none = 'Notes. The prcwnobody zeta finding is in no private report anywhere at all.'
      $cases = @(@('a_s', $subA, "Notes from a call. $t_s More notes."), @('b_s', $subB, "My summary. $t_s"), @('c_s', $subC, "Notes from a call. $t_s More notes."), @('c_none', $subC, $none))
      foreach ($case in $cases) {
        $nb = "prcw$ph$($case[0] -replace '_', '')"
        $js = "const r = await fetch('http://${wbName}:8000/workbench/notes', { method: 'POST', headers: { 'content-type': 'application/json', 'x-brain-key': Deno.env.get('K'), 'X-Test-Sub': Deno.env.get('S') }, body: JSON.stringify({ notebook: Deno.env.get('NB'), title: 'withheld note', content: Deno.env.get('C'), source: 'user_note' }) }); const t = await r.text(); console.log('STATUS=' + r.status); console.log('BODY=' + t.slice(0, 300));"
        $out = Lab-Docker 600 @('run', '--rm', '--label', $label, '--network', $net, '-e', "K=$key", '-e', "S=$($case[1])", '-e', "NB=$nb", '-e', "C=$($case[2])", '--entrypoint', 'deno', $WorkbenchTag, 'eval', $js)
        $st = ([regex]'STATUS=(\d+)').Match($out).Groups[1].Value
        $bd = ([regex]'BODY=(.*)').Match($out).Groups[1].Value
        $files = @(Get-ChildItem -Recurse -File -Path (Join-Path $vault 'content\notebooks') -Filter '*.md' -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match [regex]::Escape($nb) }).Count
        $rows = Q "SELECT count(*) FROM public.wiki_pages WHERE slug LIKE 'content/notebooks/$nb/%'"
        $shape = (([regex]'"([a-z_]+)":').Matches($bd) | ForEach-Object { $_.Groups[1].Value }) -join ','
        $http["${ph}_$($case[0])"] = "status=$st file=$files row=$rows"
        $http["${ph}_$($case[0])_shape"] = $shape
        $http["${ph}_$($case[0])_body"] = $bd
        Write-Host "    [$ph] $($case[0]): status=$st file=$files row=$rows"
      }
      # the shared note (notes/...): PUT /workbench/notes/<path>.md as A quoting s - the row is what the wiki guard decides (the PUT itself is the note write path)
      $np = "prcw-$ph-shared-$rr"
      $js = "const r = await fetch('http://${wbName}:8000/workbench/notes/' + Deno.env.get('NP') + '.md', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-brain-key': Deno.env.get('K'), 'X-Test-Sub': Deno.env.get('S') }, body: JSON.stringify({ content: Deno.env.get('C') }) }); console.log('STATUS=' + r.status);"
      $out = Lab-Docker 600 @('run', '--rm', '--label', $label, '--network', $net, '-e', "K=$key", '-e', "S=$subA", '-e', "NP=$np", '-e', "C=# Shared`n`nNotes. $t_s", '--entrypoint', 'deno', $WorkbenchTag, 'eval', $js)
      $st = ([regex]'STATUS=(\d+)').Match($out).Groups[1].Value
      $http["${ph}_put_a_s"] = "status=$st row=$(Q "SELECT count(*) FROM public.wiki_pages WHERE slug LIKE '%$np'")"
      Write-Host "    [$ph] put_a_s: $($http["${ph}_put_a_s"])"
      Save "wb-$ph.log" ((Dk logs $wbName) | Out-String)
      $null = Dk rm -f $wbName
    }
    Save 'http.txt' (($http.Keys | Sort-Object | ForEach-Object { "$_ $($http[$_])" }) -join "`n")
    $msg = 'this note quotes a private report; remove that sentence, or share the report first'
    Check ($http['red_a_s'] -eq 'status=201 file=1 row=1' -and $http['red_b_s'] -eq 'status=201 file=1 row=1') "HTTP RED (660 reverted): A's and B's structured notes quoting the withheld sentence are SAVED (a $($http['red_a_s']); b $($http['red_b_s']))"
    Check ($http['green_a_s'] -eq 'status=422 file=0 row=0' -and $http['green_b_s'] -eq 'status=422 file=0 row=0' -and $http['green_a_s_body'] -match [regex]::Escape($msg) -and $http['green_b_s_body'] -match [regex]::Escape($msg)) "HTTP GREEN: A's and B's are REFUSED, 422 with the one message, no vault file, no row (a $($http['green_a_s']); b $($http['green_b_s']))"
    Check ($http['green_c_s'] -eq 'status=201 file=1 row=1' -and $http['green_c_none'] -eq 'status=201 file=1 row=1' -and $http['green_c_s_shape'] -eq $http['green_c_none_shape']) "HTTP GREEN: C quoting it SAVES, the same status, file, row and body shape as a sentence nobody holds (c $($http['green_c_s']) [$($http['green_c_s_shape'])]; nobody's $($http['green_c_none']) [$($http['green_c_none_shape'])])"
    Check ($http['red_put_a_s'] -match 'row=1$' -and $http['green_put_a_s'] -match 'row=0$') "the shared note (PUT /notes) as A quoting it: its wiki_pages row is written on RED, refused by the wiki guard on GREEN (red $($http['red_put_a_s']); green $($http['green_put_a_s']))"
    $leak = @($http.Keys | Where-Object { $_ -like '*_body' } | Where-Object { $http[$_] -match 'prcw[a-z]{10}' })
    Check ($leak.Count -eq 0) 'no response body carries the claim''s text'
  }

  # ---------------------------------------------------------------- [9] rehearsal at live size
  Write-Host "[9] rehearsal at live size (--network none, --shm-size=1g): $RehearsePages pages, $RehearseWithheld two-owner withheld, $RehearseStore store claims"
  if ($NoRehearsal) { Write-Host '    (skipped: -NoRehearsal)' } else {
    $logs = Start-Chain $rdb @('--network', 'none')
    $script:on = $rdb
    Check ($logs -match 'PostgreSQL init process complete' -and @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' }).Count -eq 0) 'the rehearsal copy ran the chain with no ERROR'
    $null = Dk exec $rdb psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
    $r = Psql-File $rev660 'rehearsal: 660 reverted (the live state before the window)'
    # synthetic post-570 data: pages (filler text), two-owner withheld claims (an x row + two owners' reports linking it),
    # one-owner store claims (A-shaped rows in the store, linked) - inserted with triggers off, as a superuser
    $bulk = @"
SET session_replication_role = replica;
INSERT INTO public.wiki_pages (slug, page_class, title, body)
SELECT 'content/topic/rh-' || g, 'entity', 'Rehearsal page ' || g, repeat('Filler text about topic ' || g || ' and its sources. ', 40) FROM generate_series(1, $RehearsePages) g;
WITH o AS (SELECT g, 'rh-own-' || (g % 997) AS a, 'rh-own-' || ((g + 1) % 997) AS b, gen_random_uuid() AS cid FROM generate_series(1, $RehearseWithheld) g),
ra AS (INSERT INTO public.research_private_reports (research_key, owner_sub, title, content) SELECT 'rk-rh-a-' || g, a, 't', 'c' FROM o RETURNING id, research_key),
rb AS (INSERT INTO public.research_private_reports (research_key, owner_sub, title, content) SELECT 'rk-rh-b-' || g, b, 't', 'c' FROM o RETURNING id, research_key),
l AS (INSERT INTO public.research_private_report_claims (report_id, claim_id)
      SELECT ra.id, o.cid FROM o JOIN ra ON ra.research_key = 'rk-rh-a-' || o.g UNION ALL SELECT rb.id, o.cid FROM o JOIN rb ON rb.research_key = 'rk-rh-b-' || o.g RETURNING 1)
INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data)
SELECT gen_random_uuid(), 'public.claims', 'x', o.cid::text, jsonb_build_object('id', o.cid, 'text', 'The rehearsal withheld finding number ' || o.g || ' appeared in two private reports alike.') FROM o, (SELECT count(*) FROM l) z;
WITH o AS (SELECT g, 'rh-own-' || (g % 997) AS a, gen_random_uuid() AS cid FROM generate_series(1, $RehearseStore) g),
r AS (INSERT INTO public.research_private_reports (research_key, owner_sub, title, content) SELECT 'rk-rh-s-' || g, a, 't', 'c' FROM o RETURNING id, research_key),
l AS (INSERT INTO public.research_private_report_claims (report_id, claim_id) SELECT r.id, o.cid FROM o JOIN r ON r.research_key = 'rk-rh-s-' || o.g RETURNING 1)
INSERT INTO public.inlet_private_claims (id, text, inlet_owner_sub, inlet_batch)
SELECT o.cid, 'The rehearsal store finding number ' || o.g || ' reproduced in one private report.', o.a, public.private_report_claims_filed_batch() FROM o, (SELECT count(*) FROM l) z;
SET session_replication_role = origin;
ANALYZE;
SELECT 'rehearsal pages=' || (SELECT count(*) FROM public.wiki_pages) || ' withheld=' || (SELECT count(*) FROM public.private_report_claims_archive WHERE action = 'x') || ' store=' || (SELECT count(*) FROM public.inlet_private_claims) || ' links=' || (SELECT count(*) FROM public.research_private_report_claims);
"@
    $r = Psql-File '' 'rehearsal: synthetic data' $bulk
    Save 'rehearsal-size.txt' $r.out
    Check ($r.rc -eq 0) "the rehearsal copy: $((($r.out -split "`n") | Where-Object { $_ -like 'rehearsal *' }) -join '')"
    $hR = Q $hashQ
    $r = Psql-File '' 'rehearsal: 660' (With-Locks $t660)
    $locks = Locks-Of $r; Save 'rehearsal-locks.txt' ($locks -join "`n")
    Save 'rehearsal-duration.txt' "660 init: $($r.ms) ms (psql -f wall time, docker exec included)"
    Check ($r.rc -eq 0) "REHEARSAL: 660 applies in $($r.ms) ms (wall time incl. docker exec): $($r.msg)"
    Check (@($locks | Where-Object { $_ -match 'AccessExclusiveLock' }).Count -eq 0 -and @($locks | Where-Object { $_ -match 'ExclusiveLock' }).Count -eq 0) "REHEARSAL: no ACCESS EXCLUSIVE (no exclusive lock at all) on a public table ($($locks -join ', '))"
    Check ((Q $hashQ) -eq $hR) 'REHEARSAL: 660 moved no row'
    $sw = [System.Diagnostics.Stopwatch]::StartNew(); $c = Psql-Lines $check570 'rehearsal-check570.log'; $sw.Stop(); $t1 = $sw.ElapsedMilliseconds
    $sw = [System.Diagnostics.Stopwatch]::StartNew(); $s = Psql-Lines $check575 'rehearsal-check575.log'; $sw.Stop(); $t2 = $sw.ElapsedMilliseconds
    $sw = [System.Diagnostics.Stopwatch]::StartNew(); $wq = Psql-Lines $check660 'rehearsal-check660.log'; $sw.Stop(); $t3 = $sw.ElapsedMilliseconds
    Check ($c -match 'check: OK') "REHEARSAL: the 570 check says OK on the copy ($t1 ms)"
    Check ($s -match 'scope: OK') "REHEARSAL: the 575 scope check says OK on the copy ($t2 ms)"
    Check ($wq -match 'withheld: OK' -and $wq -match "owner-claim pairs=$(2 * $RehearseWithheld)") "REHEARSAL: the 660 check says OK ($(2 * $RehearseWithheld) pairs, all refused, none for a stranger; $t3 ms)"
    $lat = Q "SELECT round(extract(epoch FROM clock_timestamp() - t0) * 1000 / 200, 2) FROM (SELECT clock_timestamp() AS t0) s, LATERAL (SELECT count(*) FILTER (WHERE public.private_report_claims_note_refused('rh-own-' || (g % 997), 'content/notebooks/rh/rh-note', 'v', repeat('A note body without any private sentence. ', 20))) FROM generate_series(1, 200) g) x"
    Save 'rehearsal-latency.txt' "note_refused per call (live size): $lat ms"
    Check ($lat -match '^[0-9.]+$') "REHEARSAL: note_refused per call at live size: $lat ms"
    $r = Psql-File '' 'stress: withheld claims' "SET session_replication_role = replica; WITH o AS (SELECT g, 'rh-own-' || (g % 997) AS a, gen_random_uuid() AS cid FROM generate_series(1, $StressWithheld) g), r AS (INSERT INTO public.research_private_reports (research_key, owner_sub, title, content) SELECT 'rk-st-' || g, a, 't', 'c' FROM o RETURNING id, research_key), l AS (INSERT INTO public.research_private_report_claims (report_id, claim_id) SELECT r.id, o.cid FROM o JOIN r ON r.research_key = 'rk-st-' || o.g RETURNING 1) INSERT INTO public.private_report_claims_archive (batch, tbl, action, ref, row_data) SELECT gen_random_uuid(), 'public.claims', 'x', o.cid::text, jsonb_build_object('id', o.cid, 'text', 'The stress withheld finding number ' || o.g || ' appeared in private reports.') FROM o, (SELECT count(*) FROM l) z; SET session_replication_role = origin; ANALYZE;"
    $lat2 = Q "SELECT round(extract(epoch FROM clock_timestamp() - t0) * 1000 / 50, 2) FROM (SELECT clock_timestamp() AS t0) s, LATERAL (SELECT count(*) FILTER (WHERE public.private_report_claims_note_refused('rh-own-' || (g % 997), 'content/notebooks/rh/rh-note', 'v', repeat('A note body without any private sentence. ', 20))) FROM generate_series(1, 50) g) x"
    Save 'stress-latency.txt' "note_refused per call with $StressWithheld more withheld claims: $lat2 ms"
    Check ($lat2 -match '^[0-9.]+$') "STRESS: note_refused per call with $StressWithheld more withheld claims: $lat2 ms"
    $script:on = $db
  }
} catch {
  Fail "aborted: $($_.Exception.Message)"
} finally {
  Save 'psql.log' ($script:log -join "`n")
  foreach ($c in $script:made.containers) { $null = Dk rm -f $c }
  if ($script:made.net) { $null = Dk network rm $net }
  foreach ($d in @($stage, $scratch, $vault)) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}' | Out-String).Trim()
  Check (-not $left) "nothing labelled $label is left running ($left)"
}
Write-Host ''
$pass = @($script:log | Where-Object { $_ -like 'PASS*' }).Count
if ($script:fail -eq 0) { Write-Host "ALL PASSED ($pass)  (evidence: $Evidence)"; exit 0 } else { Write-Host "$($script:fail) FAILED, $pass passed  (evidence: $Evidence)"; exit 1 }
