# run-inlet-catalog-lab.ps1 - rw-inlet-owner round 5 (plan 08 PD1, slot 440): the CATALOG-DRIVEN case and the round-5
# delta cases, on a database that runs the REAL initdb chain of this tree. Nothing is built; one pinned postgres image.
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-inlet-catalog-lab.ps1 -Subnet <x.y.z.0/24> [-Evidence <dir>] [-Red] [-RedSha 51f00ea]
#
# -Red runs the same cases with slot 440 (init + revert, and the chain's own 440) taken from -RedSha (round 4, the tested
# pin): the catalog case must FAIL there and name research_steers among its leaks; F2 and F6 must refuse the run.
# Without -Red they run with this tree's 440: every case must pass.
#
# Cases (each on a fresh database cloned from the pristine chain):
#   A catalog   inlet-owner-catalog.sql: the tables from the catalog + the code scan below, a marker in every text-like
#               column of every row of a seeded tree and a control tree, 440, then every column of every table
#               service_role can read: no seed marker outside the declared residuals; the owner's store holds it; the
#               control keeps its text; the thread's question cut; the private claim's own edges kept for the owner
#   B f2        + a filed event naming the email body this run moves (tester attempt 4 F2): 440 runs; the catalog holds
#   C f6        + a second gap branch with a gap_ref in the seeded tree: 440 runs (round 4 broke uq_research_jobs_tree_gap)
#   D revert    A+B+C planted: md5 of EVERY public table (but the lab's and 440's own stores) before; 440, 440 again
#               (nothing to do), revert, revert again (nothing to restore): every table byte-identical
#   E late      440, then late rows in the private tree (a branch, its steer, events, a cancel, a filed session): the second
#               run rebuilds exactly them (no late marker in a shared row), the third has nothing to do
#   F mutant    440 without its [archive-steers] step: refused, nothing changed
#   H bounds    (round 9) a 0-based and a two-dimensional text[] on a swept column: refused with the count, nothing changed
# The code scan: every table named by an INSERT / UPDATE / DELETE (or a PostgREST rest/v1/<table>) in the research service,
# the research curator, the persist route of openbrain-mcp (/research/persist), the workbench sessions and the daily digest /
# podcast code - intersected with the catalog by the SQL. A table one of them starts writing is in the case the next run.
#
# Lab rules (as run-privacy-hardening-lab.ps1): one --internal network on the pinned subnet, no published port, no :local
# image, no ai-stack_* / open-brain_* name, synthetic rows only, everything labelled ai-stack.harness.owner=<Id> and removed.
param(
  [string]$Id = 'wt-rw-inlet-owner',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$RedSha = '51f00ea',
  # the cases that must FAIL on -RedSha (the others are judged as GREEN there too): round 4's pin (51f00ea) fails them
  # all; round 5's (96c20aa) fails the catalog case only (its F2 / F6 / late / mutant fixes stand)
  [string]$RedCases = 'catalog,f2,f6,late,mutant',
  # with -Red: a table the catalog case must name among its leaks on -RedSha
  [string]$RedLeakTable = 'research_steers',
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
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$P = "rwio-$rand"
$net = "$P-net"
$db = "$P-db"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$work = Join-Path $env:TEMP "$P-work"
New-Item -ItemType Directory -Force $work | Out-Null
$script:fail = 0
$script:made = @{ net = $false; containers = @(); dirs = @($stage, $work) }
$script:res = [ordered]@{}

function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
# a case: with -Red a case that FAILS is the expected result (RED-OK), without it a pass is
function Case([string]$id, [bool]$ok, [string]$m) {
  $script:res[$id] = $ok
  if ($Red -and (($RedCases -split ',') -contains $id)) { if (-not $ok) { Write-Host "  RED-OK  [$id] $m" } else { Write-Host "  RED-UNEXPECTED-PASS  [$id] $m"; $script:fail++ } }
  else { Check $ok "[$id] $m" }
}
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false)) }
function Write-Utf8([string]$path, [string]$text) { [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false)) }

# -- the lab docker shim ----------------------------------------------------------------------------------------------
function Test-LabDockerArgs([string[]]$a) {
  $all = ($a -join ' ')
  if ($a.Count -and $a[0] -eq 'compose') { return 'docker compose is never used by the lab' }
  if ($all -match '192\.168\.') { return 'a 192.168.x address' }
  if ($all -match '(^|[\s=:/])(ai-stack_|open-brain_)') { return 'an ai-stack_* / open-brain_* name' }
  for ($i = 0; $i -lt $a.Count; $i++) {
    $x = $a[$i]
    if ($x -match '^(-p|-P|--publish|--publish-all)$' -or $x -match '^--publish(-all)?=' -or $x -match '^-p\d') { return "a published port ($x)" }
    if ($x -match '^--net(work)?$') { $v = $a[$i + 1]; if ($v -ne $net) { return "network '$v' is not this run's" } }
    if ($x -match '^--net(work)?=(.+)$') { if ($Matches[2] -ne $net) { return "network '$($Matches[2])' is not this run's" } }
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
function Dk { Lab-Docker 600 ([string[]]$args) }
$shimCases = @(@('run', '-p', '8080:8080', 'x'), @('run', '--network', 'ai-stack_app-net', 'x'), @('network', 'create', 'n'), @('run', 'x:local'), @('compose', 'up'), @('build', '-t', 'x:wt-a', '.'))
Check (@($shimCases | Where-Object { Test-LabDockerArgs $_ }).Count -eq $shimCases.Count) 'the lab docker shim refuses every forbidden shape'
$localBefore = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim()

# psql on a database of the lab, a file (copied in) with -v variables; returns the output, $script:rc the exit code
$script:fileN = 0
function Psql([string]$dbName, [string]$path, [string[]]$vars) {
  $script:fileN++
  $in = "/tmp/rwio-$($script:fileN).sql"
  $null = Dk cp $path "${db}:$in"
  $a = @('exec', $db, 'psql', '-U', 'postgres', '-d', $dbName, '-X', '-q', '-v', 'ON_ERROR_STOP=1') + @($vars) + @('-f', $in)
  $o = Lab-Docker 900 $a
  $rc = $script:rc
  $null = Dk exec $db rm -f $in
  $script:rc = $rc
  return $o
}
function Sql([string]$dbName, [string]$q) { $o = Dk exec $db psql -U postgres -d $dbName -X -tAc $q; return ($o | Out-String).Trim() }
function Notices([string]$o) { return ((($o -split "`n") | Where-Object { $_ -match 'NOTICE|ERROR' } | ForEach-Object { $_ -replace '^.*?(NOTICE|ERROR):\s*', '$1 ' }) -join "`n") }
function Fresh([string]$name) {
  $null = Dk exec $db psql -U postgres -d postgres -X -q -c "DROP DATABASE IF EXISTS $name" -c "CREATE DATABASE $name TEMPLATE openbrain"
  return ($script:rc -eq 0)
}
# md5 of every public table (but the lab's own and 440's owner-only stores, which a revert keeps by design)
$md5Sql = "SELECT string_agg(c.relname || '=' || public.lab_md5(c.oid), ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE 'lab\_%' AND c.relname NOT LIKE 'inlet\_%'"
$md5Fn = "CREATE OR REPLACE FUNCTION public.lab_md5(r regclass) RETURNS text LANGUAGE plpgsql AS `$`$ DECLARE h text; BEGIN EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text), '','' ORDER BY md5(to_jsonb(x)::text)), '''')) FROM %s x', r) INTO h; RETURN h; END `$`$"

try {
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  Write-Host "== rw-inlet-owner catalog lab  owner=$Id  net=$net  red=$([bool]$Red)  tree=$($sha.Substring(0, 7))  evidence=$Evidence"
  # slot 440 under test: this tree's, or -RedSha's
  $init = Join-Path $work 'init-440.sql'; $revert = Join-Path $work 'revert-440.sql'
  if ($Red) {
    Write-Utf8 $init (((& git -C $ob1 show "${RedSha}:docker/init-inlet-owner.sql") -join "`n") + "`n")
    Write-Utf8 $revert (((& git -C $ob1 show "${RedSha}:docker/revert-inlet-owner.sql") -join "`n") + "`n")
  } else {
    Copy-Item (Join-Path $dockerDir 'init-inlet-owner.sql') $init; Copy-Item (Join-Path $dockerDir 'revert-inlet-owner.sql') $revert
  }
  $catalog = Join-Path $ct 'inlet-owner-catalog.sql'; $extra = Join-Path $ct 'inlet-owner-r5-extra.sql'

  # ---------------------------------------------------------------- 1. the code scan
  Write-Host '[1] the code scan: the tables the research paths write'
  # round 6 (tester attempt 5, T19 3a): RECURSIVE, over every writer path - the research service with tools/, the curator,
  # the grounding backfiller, the suggestion / entity / chunk workers, the idea refinery, the digest / podcast, the wiki
  # compile and its service, the whole workbench - and the persist route of openbrain-mcp. A table any of them names in an
  # INSERT / UPDATE / DELETE / upsert or a PostgREST path is in the case.
  $writerDirs = @('integrations\research-service', 'integrations\research-curator', 'integrations\grounding-backfiller', 'integrations\suggestion-worker',
                  'integrations\openbrain-idea-refinery', 'integrations\entity-extraction-worker', 'integrations\chunk-embedding-worker',
                  'recipes\daily-digest', 'recipes\entity-wiki', 'docker\wiki-service', 'docker\workbench\src',
                  # round 8 (tester attempt 6, X4): openbrain-mcp writes outside the persist route too
                  'integrations\kubernetes-deployment')
  function Get-WriteSet([string[]]$roots) {
    $fs = @()
    foreach ($r in $roots) {
      if (Test-Path $r) {
        $fs += Get-ChildItem -File -Recurse $r -Include '*.ts', '*.mjs', '*.js', '*.py' -ErrorAction SilentlyContinue |
          Where-Object { $_.FullName -notmatch '\\(node_modules|lab|fixtures|contract-test)\\' -and $_.Name -notmatch '(\.|_)(test|e2e|integration)\.|\.test\.' }
      }
    }
    $tx = @($fs | ForEach-Object { Get-Content -Raw $_.FullName })
    $set = New-Object System.Collections.Generic.SortedSet[string]
    foreach ($t in $tx) {
      foreach ($m in [regex]::Matches($t, '(?i)\b(insert\s+into|update|delete\s+from|upsert\s+into)\s+(public\.)?([a-z_][a-z0-9_]*)')) { [void]$set.Add($m.Groups[3].Value.ToLower()) }
      foreach ($m in [regex]::Matches($t, 'rest/v1/([a-z_][a-z0-9_]*)')) { [void]$set.Add($m.Groups[1].Value.ToLower()) }
      foreach ($m in [regex]::Matches($t, '\.from\(\s*[''"]([a-z_][a-z0-9_]*)[''"]\s*\)\s*\.(insert|update|upsert|delete)')) { [void]$set.Add($m.Groups[1].Value.ToLower()) }
      # round 8 (tester attempt 6, X3): a request helper, this.#req("POST", "<table>", ...) (the podcast stores)
      foreach ($m in [regex]::Matches($t, '(?i)\breq(?:\s*<[^()]*?>)?\(\s*[''"](POST|PATCH|PUT|DELETE)[''"]\s*,\s*[''"`]/?(rest/v1/)?([a-z_][a-z0-9_]*)')) { [void]$set.Add($m.Groups[3].Value.ToLower()) }
    }
    return @{ files = $fs.Count; names = $set }
  }
  $ws = Get-WriteSet @($writerDirs | ForEach-Object { Join-Path $ob1 $_ })
  $names = $ws.names
  # the persist route of openbrain-mcp (the curator's filing: sessions, sources, thread links, the filed event)
  $mcp = Get-Content -Raw (Join-Path $ob1 'integrations\kubernetes-deployment\index.ts')
  $pi = $mcp.IndexOf('"/research/persist"')
  if ($pi -ge 0) {
    $pe = $mcp.IndexOf("`napp.", $pi + 20); if ($pe -lt 0) { $pe = $mcp.Length }
    foreach ($m in [regex]::Matches($mcp.Substring($pi, $pe - $pi), '(?i)\b(insert\s+into|update|delete\s+from)\s+(public\.)?([a-z_][a-z0-9_]*)')) { [void]$names.Add($m.Groups[3].Value.ToLower()) }
  }
  Check ($pi -ge 0) 'the code scan found the persist route (/research/persist) in openbrain-mcp'
  $files = @(1..$ws.files)
  $writeSet = ($names -join ',')
  Save 'write-set.txt' ("files: $($files.Count) + the persist route`n" + ($names -join "`n"))
  Write-Host "    $($names.Count) name(s) (the SQL keeps the ones that are tables)"

  # ---------------------------------------------------------------- 2. the database
  Write-Host '[2] the database: the initdb chain of this tree'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  # the chain's own 440 is the one under test (on an empty volume it has nothing to do; it creates its stores)
  Copy-Item -Force $init (Join-Path $stage '440-init-inlet-owner.sql')
  Check (@($chain | Where-Object { $_[1] -eq '440-init-inlet-owner.sql' }).Count -eq 1) "the chain mounts 440-init-inlet-owner.sql ($($chain.Count) migrations)"
  $null = Dk network create --driver bridge --internal --subnet $subnets.run --label $label $net
  if ($script:rc -ne 0) { throw 'network' }
  $script:made.net = $true
  $o = Dk run -d --name $db --label $label --network $net -e "POSTGRES_PASSWORD=$pw" -e 'POSTGRES_DB=openbrain' -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
  if ($script:rc -ne 0) { throw "db: $o" }
  $script:made.containers += $db
  for ($i = 0; $i -lt 150; $i++) { if ((Dk logs $db) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $logs = Dk logs $db
  $errs = @(($logs -split "`n") | Where-Object { $_ -match '\bERROR\b' })
  Check ($logs -match 'PostgreSQL init process complete' -and $errs.Count -eq 0) "the database ran the initdb chain, no ERROR ($($errs.Count))"
  $mk = 'zqseed' + (-join ((97..122) | Get-Random -Count 8 | ForEach-Object { [char]$_ }))
  $cm = 'zqctl' + (-join ((97..122) | Get-Random -Count 8 | ForEach-Object { [char]$_ }))
  $lm = 'zqlate' + (-join ((97..122) | Get-Random -Count 8 | ForEach-Object { [char]$_ }))
  $owner = 'lab-owner-' + $rand
  $plantVars = @('-v', 'phase=plant', '-v', "mark=$mk", '-v', "ctl=$cm", '-v', "write_set=$writeSet")
  $checkVars = @('-v', 'phase=check', '-v', "mark=$mk", '-v', "ctl=$cm")
  $verdict = { param($o) $r = ([regex]'CATALOG RESULT (ok|FAILED) (\d+)').Match($o); if ($r.Success) { $r.Groups[1].Value } else { 'none' } }

  # ---------------------------------------------------------------- A. the catalog case
  Write-Host '[A] the catalog case'
  $null = Fresh 'cat_a'
  $po = Psql 'cat_a' $catalog $plantVars; Save 'A-plant.log' $po
  $prc = $script:rc
  $io = Psql 'cat_a' $init @('-v', "owner_sub=$owner"); $irc = $script:rc; Save 'A-440.log' (Notices $io)
  $co = Psql 'cat_a' $catalog $checkVars; Save 'A-check.log' (Notices $co)
  foreach ($l in (Notices $co) -split "`n" | Where-Object { $_ -match 'LEAK|UNPLANTED|PRIVATE|CONTROL|THREAD|CLAIM-EDGES|EMPTY-TAGS|SHORT-TOPIC|GREEK|ACCENT-SLUG|CODE-VALUE|SUMMARY|RESULT' }) { Write-Host "    $l" }
  $tables = @(($po -split "`n") | Where-Object { $_ -match 'CATALOG TABLE' } | ForEach-Object { $_.Trim() })
  Save 'A-tables.txt' ($tables -join "`n")
  $leakTables = @(([regex]::Matches((Notices $co), 'CATALOG HIT LEAK public\.([a-z_]+)\.') | ForEach-Object { $_.Groups[1].Value }) | Sort-Object -Unique)
  Save 'A-leak-tables.txt' ($leakTables -join "`n")
  Check ($prc -eq 0) "the catalog plant ran ($(@($tables).Count) table(s) from the catalog and the code scan)"
  Case 'catalog' ($irc -eq 0 -and (& $verdict $co) -eq 'ok') "the catalog case: no seed marker in any shared-readable column outside the declared residuals; the owner's store holds it; the control keeps its text (440 exit $irc, $((Notices $co) -split "`n" | Where-Object { $_ -match 'CATALOG SUMMARY' }))"
  if ($Red) { Check ($leakTables -contains $RedLeakTable) "RED: the catalog case catches $RedLeakTable on $RedSha (leaking tables: $($leakTables -join ', '))" }

  # ---------------------------------------------------------------- B. F2
  Write-Host '[B] F2: a filed event naming the email body this run moves'
  $null = Fresh 'cat_b'
  $null = Psql 'cat_b' $catalog $plantVars
  $xo = Psql 'cat_b' $extra @('-v', 'case=f2', '-v', "mark=$mk"); Check ($script:rc -eq 0) "the f2 delta plant ran $(if ($script:rc) { $xo })"
  $io = Psql 'cat_b' $init @('-v', "owner_sub=$owner"); $irc = $script:rc; Save 'B-440.log' (Notices $io)
  $co = Psql 'cat_b' $catalog $checkVars; Save 'B-check.log' (Notices $co)
  Write-Host "    440 exit ${irc}: $(((Notices $io) -split "`n" | Where-Object { $_ -match 'ERROR' }) -join ' ')"
  Case 'f2' ($irc -eq 0 -and (& $verdict $co) -eq 'ok' -and (Sql 'cat_b' "SELECT count(*) FROM public.research_job_events WHERE type = 'filed' AND payload ->> 'synthesis_id' = (SELECT v FROM public.lab_catalog_ids WHERE k = 'moved_source')") -eq '0') "F2: 440 runs; the filed event no longer names the moved source; the catalog holds"
  if ($Red -and (($RedCases -split ',') -contains 'f2') -and $RedSha -like '51f00ea*') { Check ($irc -ne 0 -and (Notices $io) -match 'still names private data') "RED: on $RedSha the run is refused ('still names private data')" }
  elseif ($Red -and (($RedCases -split ',') -contains 'f2')) { Write-Host "  SKIP: RED f2/f6 apply only to 51f00ea (fixed in round 5); this base is $RedSha" }

  # ---------------------------------------------------------------- C. F6
  Write-Host '[C] F6: two gap branches with a gap_ref in one seeded tree'
  $null = Fresh 'cat_c'
  $null = Psql 'cat_c' $catalog $plantVars
  $xo = Psql 'cat_c' $extra @('-v', 'case=f6', '-v', "mark=$mk"); Check ($script:rc -eq 0) "the f6 delta plant ran $(if ($script:rc) { $xo })"
  $io = Psql 'cat_c' $init @('-v', "owner_sub=$owner"); $irc = $script:rc; Save 'C-440.log' (Notices $io)
  Write-Host "    440 exit ${irc}: $(((Notices $io) -split "`n" | Where-Object { $_ -match 'ERROR' }) -join ' ')"
  $gr = Sql 'cat_c' "SELECT count(*) || '|' || count(DISTINCT gap_ref) || '|' || count(*) FILTER (WHERE gap_ref = 'private:' || id::text) FROM public.research_jobs WHERE root_job_id = (SELECT v::uuid FROM public.lab_catalog_ids WHERE k = 'seeded_root') AND gap_ref IS NOT NULL"
  Case 'f6' ($irc -eq 0 -and $gr -eq '2|2|2') "F6: 440 runs; each gap branch keeps a gap_ref of its own (branches | distinct | private:<id>: $gr)"
  if ($Red -and (($RedCases -split ',') -contains 'f6') -and $RedSha -like '51f00ea*') { Check ($irc -ne 0 -and (Notices $io) -match 'uq_research_jobs_tree_gap') "RED: on $RedSha the run aborts on uq_research_jobs_tree_gap" }
  elseif ($Red -and (($RedCases -split ',') -contains 'f6')) { Write-Host "  SKIP: RED f2/f6 apply only to 51f00ea (fixed in round 5); this base is $RedSha" }

  # ---------------------------------------------------------------- D. revert
  Write-Host '[D] revert: every table byte-identical'
  $null = Fresh 'cat_d'
  $null = Psql 'cat_d' $catalog $plantVars
  if (-not $Red) { $null = Psql 'cat_d' $extra @('-v', 'case=f2', '-v', "mark=$mk"); $null = Psql 'cat_d' $extra @('-v', 'case=f6', '-v', "mark=$mk") }
  $null = Dk exec $db psql -U postgres -d cat_d -X -q -c $md5Fn
  $before = Sql 'cat_d' $md5Sql
  $o1 = Psql 'cat_d' $init @('-v', "owner_sub=$owner"); $r1 = $script:rc
  $o2 = Psql 'cat_d' $init @(); $r2 = $script:rc
  $o3 = Psql 'cat_d' $revert @(); $r3 = $script:rc
  $o4 = Psql 'cat_d' $revert @(); $r4 = $script:rc
  $after = Sql 'cat_d' $md5Sql
  Save 'D-runs.log' ("init: $(Notices $o1)`ninit again: $(Notices $o2)`nrevert: $(Notices $o3)`nrevert again: $(Notices $o4)")
  $bm = @{}; foreach ($kv in $before -split ',') { $p2 = $kv -split '=', 2; $bm[$p2[0]] = $p2[1] }
  $diff = @(foreach ($kv in $after -split ',') { $p2 = $kv -split '=', 2; if ($bm[$p2[0]] -ne $p2[1]) { $p2[0] } })
  Save 'D-md5.txt' ("before:`n$($before -replace ',', "`n")`n`nafter:`n$($after -replace ',', "`n")`n`ndiffer: $($diff -join ', ')")
  $nTables = @($before -split ',').Count
  # (with -Red the round-4 revert is not judged here: its DROP ROLE fails on a cluster where a cloned database still uses the
  # role - this lab clones the chain's database; round 5's revert keeps the role then. The workspace lab judges it.)
  $caseOrCheck = if ($Red) { { param($i, $ok, $m) Write-Host "  INFO  RED run, $($RedSha)'s own revert (not judged): $ok - $m" } } else { { param($i, $ok, $m) Case $i $ok $m } }
  & $caseOrCheck 'revert' ($r1 -eq 0 -and (Notices $o2) -match 'nothing to do' -and $r3 -eq 0 -and (Notices $o3) -match 'batch\(es\) restored' -and (Notices $o4) -match 'nothing to restore' -and $diff.Count -eq 0) "440, 440 again (nothing to do), revert, revert again (nothing to restore): all $nTables public tables byte-identical (md5; differ: $($diff -join ', '))"

  # ---------------------------------------------------------------- E. late rows
  Write-Host '[E] rows that arrive after a run, in a tree it made private'
  $null = Fresh 'cat_e'
  $null = Psql 'cat_e' $catalog $plantVars
  $o1 = Psql 'cat_e' $init @('-v', "owner_sub=$owner"); $r1 = $script:rc
  $null = Psql 'cat_e' $extra @('-v', 'case=late', '-v', "mark=$lm")
  $o2 = Psql 'cat_e' $init @(); $r2 = $script:rc
  $o3 = Psql 'cat_e' $init @(); $r3 = $script:rc
  Save 'E-runs.log' ("init: $(Notices $o1)`nsecond run: $(Notices $o2)`nthird run: $(Notices $o3)")
  $late = Sql 'cat_e' "SET ROLE service_role; SELECT (SELECT count(*) FROM public.research_steers s WHERE to_jsonb(s)::text LIKE '%$lm%') || '|' || (SELECT count(*) FROM public.research_jobs j WHERE to_jsonb(j)::text LIKE '%$lm%') || '|' || (SELECT count(*) FROM public.research_job_events e WHERE to_jsonb(e)::text LIKE '%$lm%') || '|' || (SELECT count(*) FROM public.sessions s WHERE to_jsonb(s)::text LIKE '%$lm%') || '|' || (SELECT count(*) FROM public.research_cancels c WHERE to_jsonb(c)::text LIKE '%$lm%')"
  $lateLine = ($late -split "`n" | Select-Object -Last 1)
  $priv = Sql 'cat_e' "SELECT count(*) FROM public.inlet_private_rows WHERE row_data::text LIKE '%$lm%'"
  Case 'late' ($r1 -eq 0 -and $r2 -eq 0 -and (Notices $o2) -match 'round 5 - [1-9]' -and $lateLine -eq '0|0|0|0|0' -and [int]("0$priv") -ge 3 -and (Notices $o3) -match 'nothing to do') "the second run rebuilds the late branch, steer, events, cancel and session (late marker in steers|jobs|events|sessions|cancels: $lateLine; in the owner's store: $priv); the third has nothing to do"

  # ---------------------------------------------------------------- F. a mutant without the steers' archive step
  Write-Host '[F] a 440 without [archive-steers]'
  $null = Fresh 'cat_f'
  $null = Psql 'cat_f' $catalog $plantVars
  $src = Get-Content -Raw $init
  $cut = [regex]::Replace($src, '(?s)-- \[archive-steers\].*?-- \[/archive-steers\]', '-- (mutant: no archive step)')
  $mut = Join-Path $work 'mutant-archive-steers.sql'; Write-Utf8 $mut $cut
  $null = Dk exec $db psql -U postgres -d cat_f -X -q -c $md5Fn
  $before = Sql 'cat_f' $md5Sql
  $mo = Psql 'cat_f' $mut @('-v', "owner_sub=$owner"); $mrc = $script:rc
  $after = Sql 'cat_f' $md5Sql
  Save 'F-mutant.log' (Notices $mo)
  Case 'mutant' ($cut -ne $src -and $mrc -ne 0 -and (Notices $mo) -match 'refused, nothing changed' -and $before -eq $after) "a 440 that rebuilds the steers without archiving them first is refused and changes nothing"
  # round 6: the content sweep without its archive step (only where the file under test has the step)
  if ($src -match '-- \[archive-sweep\]') {
    $null = Fresh 'cat_f2'
    $null = Psql 'cat_f2' $catalog $plantVars
    $cut2 = [regex]::Replace($src, '(?s)-- \[archive-sweep\].*?-- \[/archive-sweep\]', '-- (mutant: no archive step)')
    $mut2 = Join-Path $work 'mutant-archive-sweep.sql'; Write-Utf8 $mut2 $cut2
    $null = Dk exec $db psql -U postgres -d cat_f2 -X -q -c $md5Fn
    $before2 = Sql 'cat_f2' $md5Sql
    $mo2 = Psql 'cat_f2' $mut2 @('-v', "owner_sub=$owner"); $mrc2 = $script:rc
    $after2 = Sql 'cat_f2' $md5Sql
    Save 'F-mutant-sweep.log' (Notices $mo2)
    Case 'mutant-sweep' ($cut2 -ne $src -and $mrc2 -ne 0 -and (Notices $mo2) -match 'refused, nothing changed' -and $before2 -eq $after2) "a 440 whose content sweep cuts rows it did not archive first is refused and changes nothing"
  }

  # ---------------------------------------------------------------- H. arrays the archive cannot restore (round 9)
  # A shared article's tags 0-based ('[0:1]={...}') and another's two-dimensional: JSON keeps no array bounds, so the
  # revert could not restore them byte-identical (and a 2-D text[] cannot be cut by element). 440 must refuse with the
  # count, before anything changes (md5 of every table, and the rows' own text form, which keeps the bounds).
  Write-Host '[H] a 0-based and a two-dimensional text[] on a swept column'
  $null = Fresh 'cat_h'
  $null = Psql 'cat_h' $catalog $plantVars
  $null = Sql 'cat_h' "INSERT INTO public.sources (url, title, content, content_type, tags) VALUES ('https://shared.example/b0/$mk', 'Zero based', 'a page', 'web_article', '[0:1]={misc,news}'::text[]), ('https://shared.example/b2/$mk', 'Two dimensional', 'a page', 'web_article', '{{misc,news},{a,b}}'::text[])"
  $null = Dk exec $db psql -U postgres -d cat_h -X -q -c $md5Fn
  $rowSql = "SELECT md5(string_agg(s::text, ',' ORDER BY s.id)) FROM public.sources s"
  $before = Sql 'cat_h' $md5Sql; $rb = Sql 'cat_h' $rowSql
  $ho = Psql 'cat_h' $init @('-v', "owner_sub=$owner"); $hrc = $script:rc
  $after = Sql 'cat_h' $md5Sql; $ra = Sql 'cat_h' $rowSql
  $bounds = Sql 'cat_h' "SELECT string_agg(tags::text, ' ' ORDER BY title) FROM public.sources WHERE url LIKE 'https://shared.example/b_/$mk'"
  Save 'H-bounds.log' ("$(Notices $ho)`ntags after: $bounds")
  Case 'bounds' ($hrc -ne 0 -and (Notices $ho) -match 'refused, nothing changed - 2 row\(s\) of public\.sources column tags hold an array that is multi-dimensional or not 1-based' -and $before -eq $after -and $rb -eq $ra -and $bounds -eq '{{misc,news},{a,b}} [0:1]={misc,news}') "a 0-based and a 2-D text[] on a swept column: 440 refused with the count, nothing changed (tags after: $bounds)"

  # ---------------------------------------------------------------- G. the case's own discovery (round 6, T19 3a)
  # A table a writer under integrations/research-service/tools/ writes, one the grounding backfiller writes, and tables keyed
  # by a job, a source or a session under other names and types (job_ref uuid, a TEXT job_id, a session foreign key), none
  # planted or declared: the case must report every one UNPLANTED. Judged in both modes (it tests the case, not 440).
  Write-Host '[G] the case finds tables nobody planted (a tools/ writer, a grounding-backfiller writer, job / session keys by name)'
  $st = Join-Path $work 'selftest'
  New-Item -ItemType Directory -Force (Join-Path $st 'integrations\research-service\tools'), (Join-Path $st 'integrations\grounding-backfiller'),
    (Join-Path $st 'integrations\research-service\extras'), (Join-Path $st 'recipes\daily-digest\src\podcast'), (Join-Path $st 'integrations\kubernetes-deployment') | Out-Null
  # round 8: the tester's attack tables - X1 a foreign key onto research_steers, written from research-service/extras/;
  # X2 a digest .from().insert(); X3 a podcast store's this.#req("POST", ...); X4 openbrain-mcp outside the persist route;
  # round 9: X5 a typed call, this.#req<Row[]>("POST", "<table>") (presenter-store.ts)
  Write-Utf8 (Join-Path $st 'integrations\research-service\extras\steer-notes.ts') "await c.queryObject(``INSERT INTO public.research_steer_notes (steer_id, note) VALUES (`$1, `$2)``, [s, n]);`n"
  Write-Utf8 (Join-Path $st 'recipes\daily-digest\src\podcast\x.ts') "await sb.from(""digest_extra_notes"").insert({ note });`nawait this.#req(""POST"", ""podcast_extra_notes"", rows, ""return=minimal"");`nawait this.#req<Row[]>(""POST"", ""digest_typed_notes"", rows);`n"
  Write-Utf8 (Join-Path $st 'integrations\kubernetes-deployment\mcp-notes.ts') "await client.queryObject(``INSERT INTO mcp_extra_notes (note) VALUES (`$1)``, [n]);`n"
  Write-Utf8 (Join-Path $st 'integrations\research-service\tools\notes.ts') "await c.queryObject(``INSERT INTO public.research_tools_notes (note) VALUES (`$1)``, [n]);`n"
  Write-Utf8 (Join-Path $st 'integrations\grounding-backfiller\notes.ts') "await c.queryObject(``INSERT INTO grounding_notes (note) VALUES (`$1)``, [n]);`n"
  $ws2 = Get-WriteSet (@($writerDirs | ForEach-Object { Join-Path $ob1 $_ }) + @((Join-Path $st 'integrations\research-service'), (Join-Path $st 'integrations\grounding-backfiller'),
    (Join-Path $st 'recipes\daily-digest'), (Join-Path $st 'integrations\kubernetes-deployment')))
  $null = Fresh 'cat_g'
  $ddl = Join-Path $work 'selftest-tables.sql'
  Write-Utf8 $ddl ("CREATE TABLE public.research_tools_notes (id serial PRIMARY KEY, note text);`n" +
    "CREATE TABLE public.grounding_notes (id serial PRIMARY KEY, note text);`n" +
    "CREATE TABLE public.research_job_notes (id serial PRIMARY KEY, job_ref uuid, note text);`n" +
    "CREATE TABLE public.digest_job_text (id serial PRIMARY KEY, job_id text, note text);`n" +
    "CREATE TABLE public.research_session_notes (id serial PRIMARY KEY, session_id uuid REFERENCES public.sessions(id), note text);`n" +
    "CREATE TABLE public.research_steer_notes (id serial PRIMARY KEY, steer_id uuid REFERENCES public.research_steers(id), note text);`n" +
    "CREATE TABLE public.digest_extra_notes (id serial PRIMARY KEY, note text);`n" +
    "CREATE TABLE public.podcast_extra_notes (id serial PRIMARY KEY, note text);`n" +
    "CREATE TABLE public.mcp_extra_notes (id serial PRIMARY KEY, note text);`n" +
    "CREATE TABLE public.digest_typed_notes (id serial PRIMARY KEY, note text);`n" +
    "GRANT SELECT ON public.research_tools_notes, public.grounding_notes, public.research_job_notes, public.digest_job_text, public.research_session_notes,
       public.research_steer_notes, public.digest_extra_notes, public.podcast_extra_notes, public.mcp_extra_notes, public.digest_typed_notes TO service_role;`n")
  $null = Psql 'cat_g' $ddl @()
  $go = Psql 'cat_g' $catalog @('-v', 'phase=plant', '-v', "mark=$mk", '-v', "ctl=$cm", '-v', "write_set=$($ws2.names -join ',')")
  Save 'G-plant.log' $go
  $want = @('research_tools_notes', 'grounding_notes', 'research_job_notes', 'digest_job_text', 'research_session_notes',
            'research_steer_notes', 'digest_extra_notes', 'podcast_extra_notes', 'mcp_extra_notes', 'digest_typed_notes')
  $found = @($want | Where-Object { $go -match "CATALOG TABLE public\.$_ UNPLANTED" })
  Check ($found.Count -eq $want.Count) "[selftest] the case reports every unplanted new table UNPLANTED ($($found -join ', '); missing: $(@($want | Where-Object { $found -notcontains $_ }) -join ', '))"
}
catch { Fail "the lab stopped: $($_.Exception.Message)" }
finally {
  Write-Host '== teardown'
  foreach ($c in $script:made.containers) { $null = Dk rm -f -v $c }
  if ($script:made.net) { $null = Dk network rm $net }
  $left = Dk ps -a --filter "label=$label" --format '{{.Names}}'
  $leftNet = Dk network ls --filter "label=$label" --format '{{.Name}}'
  $leftVol = Dk volume ls --filter "label=$label" --format '{{.Name}}'
  Check ([string]::IsNullOrWhiteSpace("$left$leftNet$leftVol")) "nothing labelled $Id is left (containers '$left', networks '$leftNet', volumes '$leftVol')"
  $localAfter = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim()
  if ($localBefore -eq $localAfter) { Pass 'no :local image changed' } else { Write-Host '  WARN  a :local image listing differs from the start (this lab never builds; another session rebuilt one)' }
  foreach ($d in $script:made.dirs) { try { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } catch { } }
  $summary = ($script:res.GetEnumerator() | ForEach-Object { "$($_.Key)=$(if ($_.Value) { 'GREEN' } else { 'RED' })" }) -join ' '
  Save 'summary.txt' "red=$([bool]$Red) redSha=$RedSha tree=$sha fail=$($script:fail) :: $summary"
  Write-Host "== $summary"
  if ($script:fail) { Write-Host "== FAILED ($($script:fail))"; exit 1 } else { Write-Host '== ALL PASSED'; exit 0 }
}
