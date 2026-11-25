# run-private-report-claims-withheld-unit.ps1 - slot 660 (init-private-report-claims-withheld.sql, research-workbench
# rw-withheld-owner-view) at UNIT level: the function, its revert and its check script on a STUB schema - the tables 570's
# own-sentence check reads, and 570's / 575's functions copied VERBATIM from their files (the normaliser, the subject
# rule, the gates, 570's own_text_shows, 575's person-note rule, wiki guard and note_refused) - in ONE throw-away
# postgres container on --network none (no network at all, no port, no volume, no build, no compose, labelled with the
# owner). No plane, no lease: it never touches the stack. The chain-level lab (the real initdb chain, the HTTP door, the
# live-size rehearsal) is run-private-report-claims-withheld-lab.ps1.
#
#   powershell -NoProfile -File OB1/docker/workbench/contract-test/run-private-report-claims-withheld-unit.ps1 [-Id wt-rw-withheld-owner-view] [-Evidence <empty dir>]
#
#   [0] the stub; 660 without 570 is refused, nothing changed
#   [1] RED: 570's own_text_shows (the stub as 570 left it): A's and B's notes quoting the withheld two-owner sentence SAVE
#   [2] GREEN: 660 (relation locks recorded: no AccessExclusiveLock on a public table): A and B refused on both doors,
#       C saves exactly as a sentence nobody holds, the no-owner / unlinked / restored claims refuse nobody, the one-owner
#       claim as before; the check script says OK; 660 again: the same function, the same answers
#   [3] MUTATIONS (scratch copies of the init file, each applied then the real init put back): M1 own_text_shows back to
#       570's store-only read -> the A / B rows FAIL; M2 the helper reads every withheld claim -> the C row FAILS; M3 the
#       restored filter dropped -> the restored row FAILS; M4 the subject rule dropped -> the 'operator' row FAILS
#   [4] revert: 570's own_text_shows back byte for byte (prosrc), the helper gone, the probe is [1]'s again, the check
#       FAILS (not applied); the revert again: the same
#   [5] 570 reverted first (its revert drops own_text_shows and the normaliser): 660's revert still exits 0 and leaves no
#       own_text_shows behind
# Exit 0 = every check passed. States only - never a claim's text.
param(
  [string]$Id = 'wt-rw-withheld-owner-view',
  [string]$Evidence = '',
  [string]$PgImage = 'postgres:16'
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$ct = $PSScriptRoot
$dockerDir = Split-Path -Parent (Split-Path -Parent $ct)
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$db = "prcw-unit-$rand"
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$db-evidence" }
if ((Test-Path $Evidence) -and @(Get-ChildItem -Force $Evidence).Count) { Write-Host "REFUSED: -Evidence $Evidence is not empty"; exit 2 }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$scratch = Join-Path $env:TEMP "$db-scratch"
New-Item -ItemType Directory -Force $scratch | Out-Null
$script:fail = 0
$script:log = @()
$utf8 = New-Object System.Text.UTF8Encoding $false
function Pass([string]$m) { Write-Host "  PASS  $m"; $script:log += "PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:log += "FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, $utf8) }
function ReadLf([string]$p) { return ([System.IO.File]::ReadAllText($p, $utf8)) -replace "`r`n", "`n" }

# every docker call: only this run's container, never a network, a port, a volume, compose or a build
function Dk {
  $a = [string[]]$args
  $all = $a -join ' '
  if ($a[0] -in @('compose', 'build', 'network', 'volume', 'pull')) { throw "unit shim refused: docker $($a[0])" }
  if ($a[0] -eq 'run' -and $all -match '(^|\s)(-p|-P|--publish|--publish-all|-v|--volume|--mount)(\s|=|$)') { throw 'unit shim refused: a port or a mount' }
  if ($a[0] -eq 'run' -and $all -notmatch '--network none') { throw 'unit shim refused: a container not on --network none' }
  if ($a[0] -in @('exec', 'cp', 'rm', 'logs') -and $all -notmatch [regex]::Escape($db)) { throw 'unit shim refused: not this run''s container' }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'docker'
  $psi.Arguments = ($a | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit(300000)) { try { $p.Kill() } catch { }; $script:rc = 124; return 'TIMEOUT' }
  $p.WaitForExit(); $script:rc = $p.ExitCode
  return (($out.Result + $err.Result) -replace "`r", '').TrimEnd()
}
function Q([string]$q) { return ((Dk exec $db psql -U postgres -d unit -X -A -t -q -c $q) | Out-String).Trim() }
function Psql-Text([string]$sql, [string]$tag) {
  $f = Join-Path $scratch "$tag.sql"
  [System.IO.File]::WriteAllText($f, $sql, $utf8)
  $null = Dk cp $f "${db}:/tmp/u.sql"
  $o = Dk exec $db psql -U postgres -d unit -X -A -t -q -v ON_ERROR_STOP=1 -f /tmp/u.sql
  $rc = $script:rc
  Save "$tag.out" $o
  return @{ rc = $rc; out = $o }
}
function Probe([string]$tag) {
  $r = Psql-Text (ReadLf (Join-Path $ct 'prc-withheld-unit.sql')) "probe-$tag"
  $h = @{}
  foreach ($l in ($r.out -split "`n")) { if ($l -match '^([a-z0-9_]+)=(.*)$') { $h[$Matches[1]] = $Matches[2].Trim() } }
  return $h
}
function Check-Probe([hashtable]$got, [hashtable]$want, [string]$phase) {
  $bad = @()
  foreach ($k in ($want.Keys | Sort-Object)) { if ("$($got[$k])" -ne "$($want[$k])") { $bad += "$k=$($got[$k]) (want $($want[$k]))" } }
  Check ($bad.Count -eq 0) "${phase}: $($want.Count) probes as expected$(if ($bad.Count) { ': ' + ($bad -join '; ') })"
  return $bad
}
# a CREATE OR REPLACE FUNCTION statement of a file, through the "$$;" that closes it
function Get-Fn([string]$text, [string]$name) {
  $s = $text.IndexOf("CREATE OR REPLACE FUNCTION public.$name(")
  if ($s -lt 0) { throw "no function $name" }
  $e = $text.IndexOf("`n`$`$;", $s)
  return $text.Substring($s, $e + 4 - $s)
}

$s570 = ReadLf (Join-Path $dockerDir 'init-private-report-claims.sql')
$s575 = ReadLf (Join-Path $dockerDir 'init-private-report-claims-scope.sql')
$init = ReadLf (Join-Path $dockerDir 'init-private-report-claims-withheld.sql')
$rev = ReadLf (Join-Path $dockerDir 'revert-private-report-claims-withheld.sql')
$chk = ReadLf (Join-Path $dockerDir 'check-private-report-claims-withheld.sql')
$own570 = Get-Fn $s570 'private_report_claims_own_text_shows'

# the stub: the tables the check reads (only the columns it reads), an app role holding the schema's default EXECUTE grant
$stub = @"
CREATE ROLE prcw_app NOLOGIN;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO prcw_app;
CREATE TABLE public.research_private_reports (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_sub TEXT);
CREATE TABLE public.research_private_report_claims (report_id UUID NOT NULL, claim_id UUID NOT NULL, PRIMARY KEY (report_id, claim_id));
CREATE TABLE public.inlet_private_claims (id UUID PRIMARY KEY, text TEXT, inlet_owner_sub TEXT);
CREATE TABLE public.private_report_claims_archive (id BIGSERIAL PRIMARY KEY, batch UUID NOT NULL, tbl TEXT NOT NULL, action TEXT NOT NULL, ref TEXT,
    row_data JSONB NOT NULL, archived_at TIMESTAMPTZ NOT NULL DEFAULT now(), restored_at TIMESTAMPTZ);
CREATE TABLE public.wiki_pages (slug TEXT PRIMARY KEY, page_class TEXT, title TEXT, body TEXT);
CREATE FUNCTION public.wiki_guard_mark_withheld() RETURNS VOID LANGUAGE sql AS 'SELECT NULL::void';
"@
foreach ($n in 'private_report_claim_norm', 'private_report_claim_subject_ok', 'private_report_claims_caller_ok', 'private_report_claims_reader_ok', 'private_report_claims_page_shows', 'private_report_claims_own_text_shows') {
  $stub += "`n" + (Get-Fn $s570 $n) + "`n"
}
foreach ($n in 'private_report_claims_person_note', 'trg_private_report_claims_wiki_guard', 'private_report_claims_note_refused') {
  $stub += "`n" + (Get-Fn $s575 $n) + "`n"
}
# 570's own grant rule on what it created: nothing for PUBLIC or the app roles
$stub += "`nDO `$d`$ DECLARE f regprocedure; BEGIN FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, prcw_app', f); END LOOP; END `$d`$;`n"
$stub += "`nCREATE TRIGGER trg_private_report_claims_wiki_guard BEFORE INSERT OR UPDATE ON public.wiki_pages FOR EACH ROW EXECUTE FUNCTION public.trg_private_report_claims_wiki_guard();`n"
$ownQ = "SELECT md5(replace(prosrc, chr(13), '')) || '|' || coalesce(proacl::text, '') || '|' || prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.private_report_claims_own_text_shows(text,text,text)')"

# the expectations: RED (570's read) and GREEN (660's)
$green = [ordered]@{
  sn_a_s = 'refused'; sn_b_s = 'refused'; wn_a_s = 'refused'; wn_b_s = 'refused'; sn_a_s_formatted = 'refused'; sn_b_s_split = 'refused'
  sn_c_s = 'saves'; wn_c_s = 'saved'; sn_c_nobody = 'saves'; wn_c_nobody = 'saved'; sn_blank_s = 'saves'; wn_none_s = 'saved'
  sn_a_n = 'saves'; sn_c_n = 'saves'; sn_operator_n = 'saves'; sn_a_d = 'saves'; sn_b_d = 'saves'; sn_a_r = 'saves'
  sn_a_k = 'refused'; sn_b_k = 'saves'; sn_c_k = 'saves'; wn_a_k = 'refused'; sn_a_s_short = 'saves'
  of_a = '1'; of_b = '1'; of_c = '0'; of_operator = '0'; of_blank = '0'; grants = '0'; app_role_can_read_helper = 'false'
}
$red = @{}; foreach ($k in $green.Keys) { if ($k -notlike 'of_*' -and $k -notin @('grants', 'app_role_can_read_helper')) { $red[$k] = $green[$k] } }
foreach ($k in 'sn_a_s', 'sn_b_s', 'sn_a_s_formatted', 'sn_b_s_split') { $red[$k] = 'saves' }
foreach ($k in 'wn_a_s', 'wn_b_s') { $red[$k] = 'saved' }

$t0 = Get-Date
try {
  Write-Host "[0] the stub ($PgImage, --network none, container $db)"
  $null = Dk run -d --name $db --network none --label "ai-stack.harness.owner=$Id" -e POSTGRES_PASSWORD=unit -e POSTGRES_DB=unit $PgImage
  if ($script:rc -ne 0) { throw 'the container did not start' }
  $up = $false
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 1000; if ((Q 'SELECT 1') -eq '1') { $up = $true; break } }
  if (-not $up) { throw 'postgres did not come up' }
  Check ((Q 'SHOW server_encoding') -eq 'UTF8') 'the database is UTF8 (the normaliser needs it)'
  $r = Psql-Text "CREATE TABLE public.private_report_claims_archive (id INT);" 'pre-570'
  $r = Psql-Text $init 'init-without-570'
  Check ($r.rc -ne 0 -and $r.out -match 'slot 570 \(init-private-report-claims.sql\) must be applied first') "660 without 570 is refused (exit $($r.rc))"
  Check ((Q "SELECT count(*) FROM pg_proc WHERE proname IN ('private_report_claims_withheld_of', 'private_report_claims_own_text_shows')") -eq '0') '... nothing changed'
  $null = Q 'DROP TABLE public.private_report_claims_archive'
  $r = Psql-Text $stub 'stub'
  Check ($r.rc -eq 0) "the stub: 570's and 575's functions copied verbatim from their files (exit $($r.rc))"
  if ($r.rc -ne 0) { throw 'stub' }
  $own570Q = Q $ownQ

  Write-Host '[1] RED: 570''s own-sentence check'
  $null = Check-Probe (Probe 'red') $red 'RED (570: the withheld two-owner sentence saves for A and B)'
  $c = Psql-Text $chk 'check-red'
  Check ($c.out -match 'withheld: slot 660 applied=false' -and $c.out -match 'withheld: FAIL') 'RED: the check script says 660 is not applied and FAILS'

  Write-Host '[2] GREEN: slot 660'
  $initLocks = $init -replace "`nCOMMIT;\s*$", "`nSELECT 'lock ' || c.relname || ' ' || l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE l.pid = pg_backend_pid() AND ns.nspname = 'public' ORDER BY 1;`nCOMMIT;`n"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $r = Psql-Text $initLocks 'init-660'
  $sw.Stop()
  $locks = @(($r.out -split "`n") | Where-Object { $_ -like 'lock *' })
  Check ($r.rc -eq 0) "660 applies (exit $($r.rc), $($sw.ElapsedMilliseconds) ms)"
  Check (@($locks | Where-Object { $_ -match 'AccessExclusiveLock|ExclusiveLock|ShareRowExclusiveLock|RowExclusiveLock' }).Count -eq 0) "660 holds no write or exclusive lock on a public table ($(@($locks).Count) relation lock(s): $(($locks | ForEach-Object { $_ -replace '^lock ', '' }) -join ', '))"
  $null = Check-Probe (Probe 'green') $green 'GREEN (660)'
  $c = Psql-Text $chk 'check-green'
  Check ($c.out -match 'withheld: OK' -and $c.out -match 'owner-claim pairs=2, owners=2' -and $c.out -match 'does not refuse=0' -and $c.out -match 'party to nothing=0') 'GREEN: the check script says OK (2 owner-claim pairs, every one refused, none for a stranger)'
  $g1 = Q $ownQ
  $r = Psql-Text $init 'init-660-again'
  Check ($r.rc -eq 0 -and (Q $ownQ) -eq $g1) 'idempotent: 660 again gives the same function (source, ACL, definer)'
  $null = Check-Probe (Probe 'green-again') $green 'GREEN after the re-run'

  Write-Host '[3] mutations (scratch copies of the init; each followed by the real init)'
  $ofFn = Get-Fn $init 'private_report_claims_withheld_of'
  $muts = [ordered]@{
    M1 = @{ text = $init.Replace((Get-Fn $init 'private_report_claims_own_text_shows'), $own570); fails = @('sn_a_s', 'sn_b_s', 'wn_a_s', 'wn_b_s', 'sn_a_s_formatted', 'sn_b_s_split'); what = 'own_text_shows back to 570''s store-only read' }
    M2 = @{ text = $init.Replace($ofFn, $ofFn.Replace("     WHERE p.owner_sub = p_sub`n       AND public.private_report_claim_subject_ok(p_sub)", "     WHERE true")); fails = @('sn_c_s', 'wn_c_s', 'sn_a_n', 'sn_c_n', 'sn_operator_n'); what = 'the helper reads every withheld claim a report links (no party filter)' }
    M3 = @{ text = $init.Replace($ofFn, $ofFn.Replace(" AND a.restored_at IS NULL AND a.ref", " AND a.ref")); fails = @('sn_a_r'); what = 'the restored filter dropped' }
    M4 = @{ text = $init.Replace($ofFn, $ofFn.Replace("`n       AND public.private_report_claim_subject_ok(p_sub)", "")); fails = @('sn_operator_n'); what = 'the subject rule dropped' }
  }
  foreach ($m in $muts.Keys) {
    $t = $muts[$m].text
    if ($t -eq $init) { Fail "${m}: the mutation did not apply to the file text"; continue }
    $r = Psql-Text $t "init-$m"
    if ($r.rc -ne 0) { Fail "${m}: the mutated init did not apply (exit $($r.rc))"; continue }
    $got = Probe $m
    $flipped = @($muts[$m].fails | Where-Object { "$($got[$_])" -ne "$($green[$_])" })
    $others = @($green.Keys | Where-Object { $_ -notin $muts[$m].fails -and $_ -notlike 'of_*' -and "$($got[$_])" -ne "$($green[$_])" })
    Check ($flipped.Count -eq $muts[$m].fails.Count) "${m} ($($muts[$m].what)): the GREEN assertion(s) $($muts[$m].fails -join ', ') FAIL ($(($muts[$m].fails | ForEach-Object { "$_=$($got[$_])" }) -join ', '))"
    Check ($others.Count -eq 0) "${m}: no other probe moved$(if ($others.Count) { ': ' + ($others -join ', ') })"
    $r = Psql-Text $init "init-after-$m"
    Check ($r.rc -eq 0 -and (Q $ownQ) -eq $g1) "${m}: the real init put back"
  }
  $null = Check-Probe (Probe 'green-after-mutations') $green 'GREEN after the mutations'

  Write-Host '[4] revert'
  $r = Psql-Text $rev 'revert-660'
  Check ($r.rc -eq 0 -and $r.out -notmatch 'ERROR') "the revert applies (exit $($r.rc))"
  Check ((Q $ownQ) -eq $own570Q) '570''s own_text_shows is back byte for byte (source, ACL, definer)'
  Check ((Q "SELECT count(*) FROM pg_proc WHERE proname = 'private_report_claims_withheld_of'") -eq '0') 'the helper is gone'
  Check ((Q "SELECT coalesce(obj_description(to_regprocedure('public.private_report_claims_own_text_shows(text,text,text)'), 'pg_proc'), 'none')") -eq 'none') 'no slot-660 comment left on the function'
  $null = Check-Probe (Probe 'reverted') $red 'after the revert: [1]''s answers'
  $c = Psql-Text $chk 'check-reverted'
  Check ($c.out -match 'withheld: slot 660 applied=false' -and $c.out -match 'withheld: FAIL') 'after the revert the check FAILS (not applied)'
  $r = Psql-Text $rev 'revert-660-again'
  Check ($r.rc -eq 0 -and (Q $ownQ) -eq $own570Q) 'the revert again: the same'
  # a 570 re-run after 660: 570's own_text_shows back - the check says re-run 660
  $r = Psql-Text $init 'init-660-before-570-rerun'
  $r = Psql-Text ($own570 + "`n") '570-rerun-own-text-shows'
  $c = Psql-Text $chk 'check-570-rerun'
  Check ($c.out -match "a 570 re-run put 570's own_text_shows back - re-run 660" -and $c.out -match 'withheld: FAIL') 'after a 570 re-run the check FAILS and says re-run 660'
  $r = Psql-Text $init 'init-660-after-570-rerun'
  $c = Psql-Text $chk 'check-after-rerun'
  Check ($c.out -match 'withheld: OK') '660 again: the check says OK'

  Write-Host '[5] 570 reverted first, then 660''s revert'
  $r = Psql-Text "DROP TRIGGER trg_private_report_claims_wiki_guard ON public.wiki_pages; DROP FUNCTION public.trg_private_report_claims_wiki_guard(); DROP FUNCTION public.private_report_claims_note_refused(TEXT, TEXT, TEXT, TEXT); DROP FUNCTION public.private_report_claims_page_shows(TEXT, TEXT); DROP FUNCTION public.private_report_claims_own_text_shows(TEXT, TEXT, TEXT); DROP FUNCTION public.private_report_claim_norm(TEXT);" 'revert-570-sim'
  $r = Psql-Text $rev 'revert-660-after-570'
  Check ($r.rc -eq 0) "660's revert after 570's exits 0 (exit $($r.rc))"
  Check ((Q "SELECT count(*) FROM pg_proc WHERE proname IN ('private_report_claims_own_text_shows', 'private_report_claims_withheld_of')") -eq '0') '... and leaves neither function behind'
}
catch { Fail "the run stopped: $($_.Exception.Message)" }
finally {
  $null = Dk rm -f $db
  Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
}
$secs = [int]((Get-Date) - $t0).TotalSeconds
$pass = @($script:log | Where-Object { $_ -like 'PASS*' }).Count
Save 'unit-summary.txt' (($script:log -join "`n") + "`n$pass passed, $($script:fail) failed, ${secs} s")
Write-Host "$pass passed, $($script:fail) failed (${secs} s); evidence: $Evidence"
if ($script:fail) { exit 1 } else { exit 0 }
