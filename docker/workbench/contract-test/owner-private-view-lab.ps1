# owner-private-view-lab.ps1 - step [5s] of run-workspace-tests.ps1 (rw-owner-private-view, plan 08 PD-PV, slot 480).
# Dot-sourced by the runner, which calls Invoke-OwnerPrivateViewLab right after [5r] (slot 440 has moved user A's planted
# personal data into the owner stores, and 470 is back on) and Invoke-OwnerPrivateViewRevert near the end (after the last
# workbench step). Every docker call goes through the runner's shim (Dk / Lab-Docker): the run's --internal network,
# :wt- tags, labels, timeouts. Uses the runner's $db, $net, $label, $P, $key, $pw, $wbTag, $wbTestTag, $viewerTag, $ct,
# $dockerDir, $ob1, $inA (A, 440's owner), $inMark (A's 440 marker), $wbRole / $wbRolePw (ob_workbench and its lab password).
#
# What [5s] proves (test plan test-plans/rw-owner-private-view.md):
#   3.6 / 3.6b  the drift [5r]'s 440 re-runs left (PD1's two reads executable by ob_app_memory) is reported by the
#               deploy pre-check's catalog half and by 480's NOTICE, and a 480 re-run fixes it; a second run has nothing to do
#   3.1-3.4, 3.7 the catalog: every 480 function and PD1's two reads execute for ob_workbench alone; ob_app_memory,
#               service_role and anon are refused (42501); PostgREST's rpc is refused; as ob_workbench, a blank, service,
#               system, anonymous or 'operator' subject, or B's, gets nothing of A's; ob_workbench's shape
#   7.1         480 on a database without 440: refused, nothing created there
#   1.x 2.x 4.x 9.x  src/inlet/owner_private_view_integration_test.ts over three workbenches (sign-in on / off) - GREEN
#   RED         the same test against the base workbench (no private routes), and against two database mutants
#               (M-no-owner-filter on the text search, M-grant): each must FAIL
#   6b / 9.3    the deploy pre-check and the multi-user readiness check, RED and GREEN on lab env files (names only)
# Invoke-OwnerPrivateViewRevert: 7.3 revert x2 (functions gone, PD1's grants back on ob_app_memory, ob_workbench kept
# NOLOGIN while a session uses it), then init again (7.2: nothing to do on the next run).

function Invoke-PvPsql([string]$path, [string]$tag, [string[]]$vars = @(), [string]$dbName = 'openbrain') {
  $null = Dk cp $path "${db}:/tmp/pv480.sql"
  $a = @('exec', $db, 'psql', '-U', 'postgres', '-d', $dbName, '-X', '-q', '-v', 'ON_ERROR_STOP=1') + $vars + @('-f', '/tmp/pv480.sql')
  $o = Lab-Docker 300 $a
  $rc = $script:rc
  $msg = (($o -split "`n") | Where-Object { $_ -match 'NOTICE|WARNING|ERROR' } | ForEach-Object { $_ -replace '^.*?(NOTICE|WARNING|ERROR):\s*', '$1 ' }) -join ' | '
  $script:pvLog += "[$tag] exit ${rc}: $msg"
  Write-Host "    [$tag] exit ${rc}: $msg"
  return @{ rc = $rc; msg = $msg; out = $o }
}
function Invoke-PvQ([string]$q) { return ((Dk exec $db psql -U postgres -d openbrain -X -A -t -c $q) | Out-String).Trim() }
function Invoke-PvCheckSql {
  $null = Dk cp (Join-Path $dockerDir 'check-owner-private-view.sql') "${db}:/tmp/pvcheck.sql"
  return ((Dk exec $db psql -U postgres -d openbrain -X -A -t -q -f /tmp/pvcheck.sql) | Out-String).Trim()
}
# the catalog probe: every non-superuser role that can run each function (case 3.1)
$script:pvCatalogQ = @"
SELECT p.proname || '=' || coalesce((SELECT string_agg(r.rolname, ',' ORDER BY r.rolname) FROM pg_roles r
        WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND has_function_privilege(r.oid, p.oid, 'EXECUTE')), '-')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND (p.proname LIKE 'owner\_private\_%' OR p.proname IN ('inlet_private_source', 'inlet_private_job'))
 ORDER BY 1
"@
function Invoke-PvTest([string]$wbS, [string]$tag, [string]$filter = '') {
  $a = @('run', '--rm', '--label', $label, '--network', $net,
    '-e', "PV_WB_S=http://${wbS}:8000", '-e', "PV_WB_U=http://$P-pvu:8000", '-e', "PV_WB_OFF=http://$P-wb:8000", '-e', "PV_VIEWER=http://$P-viewer:8080",
    '-e', "PV_KEY=$key", '-e', "PV_DOOR=$($script:pvDoor)", '-e', "PV_FA_ISSUER=$($script:pvIssuer)", '-e', "PV_FA_CLIENT=$($script:pvClient)",
    '-e', "PV_FA_SECRET=$($script:pvSecret)", '-e', "PV_A=$inA", '-e', "PV_B=$($script:pvB)", '-e', "PV_C=$($script:pvC)",
    '-e', "PV_MARK=$inMark", '-e', "PV_MA=$($script:pvMa)", '-e', "PV_MB=$($script:pvMb)", '-e', "PV_STUB=http://$P-pvembed:8080",
    '-e', "CONTRACT_TEST_DB_HOST=$db", '-e', 'CONTRACT_TEST_DB_USER=postgres', '-e', "CONTRACT_TEST_DB_PASSWORD=$pw",
    $wbTestTag, 'deno', 'test', '--allow-net', '--allow-env', '--allow-read')
  if ($filter) { $a += @('--filter', $filter) }
  $a += 'src/inlet/owner_private_view_integration_test.ts'
  $o = Lab-Docker 900 $a
  $clean = ($o -replace '\x1b\[[0-9;]*m', '')
  Save "owner-private-view-$tag.log" ((($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^(ok|FAILED) \||^pv:|error:|AssertionError|Values are not equal|\[Diff\]' } | Select-Object -First 200) -join "`n")
  foreach ($l in ($clean -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED)|^pv:' }) { Write-Host "    $l" }
  return ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match($clean)
}
function New-PvWorkbench([string]$name, [string]$image, [string[]]$extra) {
  $a = @('--network-alias', $name, '-e', 'PORT=8000', '-e', "WORKBENCH_KEY=$key",
    '-e', "DB_HOST=$db", '-e', "DB_USER=$wbRole", '-e', "DB_PASSWORD=$wbRolePw", '-e', 'OPEN_BRAIN_URL=http://openbrain-rest',
    '-e', "EMBEDDING_API_BASE=http://$P-pvembed:8080/v1", '-e', "EMBEDDING_API_KEY=$($script:pvMcpKey)", '-e', 'EXTRACT_URL=http://unreachable.invalid',
    '-e', 'WIKI_GIT_DIR=/wiki', '-e', 'WIKI_ASSETS_DIR=/wiki/assets', '-e', 'CONTRACT_MOUNTS_ROOT=/mounts', '-e', 'RESEARCH_URL=http://unreachable.invalid',
    '-e', "VIEWER_NAV_URL=http://$P-viewer:8082", '-v', "$(Join-Path $ob1 'recipes'):/recipes:ro") + $extra + @($image)
  return (Run-Detached $name $a)
}

function Invoke-OwnerPrivateViewLab {
  $script:pvRan = $true
  $script:pvLog = @()
  $rr = -join ((97..122) | Get-Random -Count 10 | ForEach-Object { [char]$_ })
  $script:pvB = "pv-bee-$rr"; $script:pvC = "pv-admin-$rr"; $script:pvMa = "pvmarka$rr"; $script:pvMb = "pvmarkb$rr"
  $script:pvDoor = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
  $script:pvSecret = -join ((48..57 + 97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
  $script:pvPrivKey = 'pvpriv' + (-join ((48..57 + 97..102) | Get-Random -Count 24 | ForEach-Object { [char]$_ }))
  $script:pvMcpKey = 'pvmcp' + (-join ((48..57 + 97..102) | Get-Random -Count 24 | ForEach-Object { [char]$_ }))
  $script:pvIssuer = 'https://authentik.lab.invalid/application/o/pv/'; $script:pvClient = "pv-client-$rr"
  Write-Host '[5s] slot 480: the owner''s private view (drift + re-run, the catalog, plant, three workbenches, the integration test, RED on the base and two mutants, the two checks)'

  # 3.6 / 3.6b: [5r] ran 440 again after the chain's 480 - PD1's two reads are executable by ob_app_memory (drift)
  $c0 = Invoke-PvCheckSql
  Save 'pv-check-before-480.log' $c0
  Check ($c0 -match 'drift: inlet_private_source\(uuid,text\) executable by ob_app_memory' -and $c0 -match 'drift: inlet_private_job\(uuid,text\) executable by ob_app_memory' -and $c0 -match 'check: FAIL') "[5s] 3.6b(a) RED: after [5r]'s 440 re-runs the catalog check names PD1's two reads as drifted and FAILS"
  $r1 = Invoke-PvPsql (Join-Path $dockerDir 'init-owner-private-view.sql') '480 after the 440 re-runs (the live order)'
  Check ($r1.rc -eq 0 -and $r1.msg -match 'drift - inlet_private_source\(uuid,text\)' -and $r1.msg -match 'drift - inlet_private_job\(uuid,text\)') '[5s] 3.6b(b) 480 names each drifted function in a NOTICE, then fixes it'
  $c1 = Invoke-PvCheckSql
  Save 'pv-check-after-480.log' $c1
  Check ($c1 -match 'check: OK' -and $c1 -notmatch 'drift:') '[5s] 3.6b(a) GREEN: after 480 the catalog check is OK (no drift)'
  $r2 = Invoke-PvPsql (Join-Path $dockerDir 'init-owner-private-view.sql') '480 again'
  Check ($r2.rc -eq 0 -and $r2.msg -notmatch 'drift') '[5s] 7.2 480 again: nothing to do (no drift)'

  # 3.1: who can run what
  $cat = Invoke-PvQ $script:pvCatalogQ
  Save 'pv-catalog.log' $cat
  $catLines = @($cat -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $want = @('inlet_private_job=ob_workbench', 'inlet_private_source=ob_workbench', 'owner_private_claims=ob_workbench', 'owner_private_has_sources=ob_workbench',
    'owner_private_jobs=ob_workbench', 'owner_private_source_kind=-', 'owner_private_source_knn=ob_workbench', 'owner_private_source_text=ob_workbench', 'owner_private_subject_ok=-')
  Check ((($catLines | Sort-Object) -join ';') -eq (($want | Sort-Object) -join ';')) "[5s] 3.1 every 480 function and PD1's two reads execute for ob_workbench alone (the helpers for nobody) across pg_roles ($($catLines -join '; '))"
  # 3.7: the role's shape
  $shape = Invoke-PvQ "SELECT rolcanlogin::text || rolsuper::text || rolbypassrls::text || rolinherit::text || '|' || (SELECT string_agg(g.rolname, ',' ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) FROM pg_roles r WHERE rolname = 'ob_workbench'"
  Check ($shape -eq 'truefalsefalsetrue|ob_app_memory') "[5s] 3.7 ob_workbench: LOGIN, NOSUPERUSER, NOBYPASSRLS, INHERIT, a member of ob_app_memory only ($shape)"
  # 3.2: the other roles are refused outright
  $refusals = @()
  foreach ($role in @('ob_app_memory', 'service_role', 'anon')) {
    $o = Dk exec $db psql -U postgres -d openbrain -X -A -t -c "SET ROLE $role; SELECT count(*) FROM public.owner_private_claims('$inA')"
    $refusals += "$role=$(if ($o -match 'permission denied') { 'refused' } elseif ($o -match 'role .* does not exist') { 'absent' } else { 'ANSWERED' })"
    $o = Dk exec $db psql -U postgres -d openbrain -X -A -t -c "SET ROLE $role; SELECT count(*) FROM public.inlet_private_source(gen_random_uuid(), '$inA')"
    $refusals += "$role/pd1=$(if ($o -match 'permission denied') { 'refused' } elseif ($o -match 'role .* does not exist') { 'absent' } else { 'ANSWERED' })"
  }
  Check (@($refusals | Where-Object { $_ -notmatch '=(refused|absent)$' }).Count -eq 0 -and @($refusals | Where-Object { $_ -match '^ob_app_memory.*=refused$' }).Count -eq 2) "[5s] 3.2 ob_app_memory, service_role and anon are refused (42501) on the 480 reads and PD1's ($($refusals -join ', '))"
  # 3.3: PostgREST's rpc (its anon role is service_role in this lab), directly and through openbrain-rest
  $rpc = Dk run --rm --label $label --network $net --entrypoint node $viewerTag --input-type=module -e "
    for (const base of ['http://openbrain-postgrest:3000', 'http://openbrain-rest/rest/v1']) {
      for (const fn of ['owner_private_claims', 'owner_private_source_text', 'owner_private_jobs', 'inlet_private_job']) {
        const r = await fetch(base + '/rpc/' + fn, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_sub: '$inA', p_q: '$inMark' }) });
        const t = await r.text();
        console.log('rpc', fn, r.status, t.includes('$inMark') ? 'MARKER' : 'clean');
      }
    }"
  Save 'pv-rpc.log' $rpc
  $rpcLines = @($rpc -split "`n" | Where-Object { $_ -match '^rpc ' })
  Check ($rpcLines.Count -eq 8 -and @($rpcLines | Where-Object { $_ -notmatch ' (401|403|404) clean$' }).Count -eq 0) "[5s] 3.3 PostgREST refuses every 480 function and PD1's job read, with no row ($(($rpcLines | ForEach-Object { ($_ -split ' ')[2] }) -join ','))"
  # 3.4: as ob_workbench, an unusable subject or another owner's gets nothing of A's
  $subs = @('', 'service:x', 'SERVICE:x', 'anonymous:', 'system:x', 'operator', 'Operator', $script:pvB)
  $n34 = @()
  foreach ($s in $subs) {
    $n = Invoke-PvQ "SET ROLE ob_workbench; SELECT (SELECT count(*) FROM public.owner_private_claims('$s')) + (SELECT count(*) FROM public.owner_private_source_text('$s', '$inMark')) + (SELECT count(*) FROM public.owner_private_jobs('$s')) + (SELECT count(*) FROM public.owner_private_source_knn('$s', ('[1' || repeat(',0', 1023) || ']')::vector))"
    $n34 += "'$s'=$(($n -split "`n")[-1])"
  }
  $nA = Invoke-PvQ "SET ROLE ob_workbench; SELECT count(*) FROM public.owner_private_claims('$inA')"
  Check (@($n34 | Where-Object { $_ -notmatch '=0$' }).Count -eq 0 -and [int](($nA -split "`n")[-1]) -ge 2) "[5s] 3.4 as ob_workbench: blank / service / system / anonymous / operator / B's subject get 0 rows of A's ($($n34 -join ' ')); A gets A's ($(($nA -split "`n")[-1]))"
  # 7.1: 480 on a database without 440 is refused, nothing created there
  $null = Dk exec $db psql -U postgres -d postgres -X -q -c 'CREATE DATABASE pv_no440'
  $r71 = Invoke-PvPsql (Join-Path $dockerDir 'init-owner-private-view.sql') '480 without 440' @() 'pv_no440'
  $fns71 = ((Dk exec $db psql -U postgres -d pv_no440 -X -A -t -c "SELECT count(*) FROM pg_proc WHERE proname LIKE 'owner_private%'") | Out-String).Trim()
  $null = Dk exec $db psql -U postgres -d postgres -X -q -c 'DROP DATABASE pv_no440'
  Check ($r71.rc -ne 0 -and $r71.msg -match 'slot 440' -and $fns71 -eq '0') "[5s] 7.1 480 without 440: refused, nothing created ($fns71 functions)"

  # the plant: B's own rows (marker mb) and A's probe chunk (marker ma)
  $pl = Invoke-PvPsql (Join-Path $ct 'owner-private-view-plant.sql') 'plant' @('-v', "a=$inA", '-v', "b=$($script:pvB)", '-v', "ma=$($script:pvMa)", '-v', "mb=$($script:pvMb)")
  Check ($pl.rc -eq 0) "[5s] planted B's private rows (a moved source + chunk, a private claim + edge, a private link on a shared claim, a seeded job) and A's probe chunk"

  # the stub embedder (counts calls by key) and the workbenches: S = sign-in on (+ the private key); U = sign-in off, default A,
  # header on, NO private key
  $null = Run-Detached "$P-pvembed" @('--network-alias', "$P-pvembed", '-v', "${ct}:/ct:ro", '-e', "STUB_PRIVATE_KEY=$($script:pvPrivKey)", '-e', "STUB_MCP_KEY=$($script:pvMcpKey)",
    '--entrypoint', 'deno', $wbTag, 'run', '--allow-net', '--allow-env', '/ct/stub-embed-private.ts')
  $fa = @('-e', "WORKSPACE_DOOR_KEY=$($script:pvDoor)", '-e', "WORKSPACE_FORWARD_AUTH_ISSUER=$($script:pvIssuer)", '-e', "WORKSPACE_FORWARD_AUTH_CLIENT_ID=$($script:pvClient)",
    '-e', "WORKSPACE_FORWARD_AUTH_CLIENT_SECRET=$($script:pvSecret)", '-e', 'WORKSPACE_FORWARD_AUTH_ADMIN_GROUP=research-admins', '-e', "WORKSPACE_DEFAULT_SUB=$inA",
    '-e', 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub')
  $okS = New-PvWorkbench "$P-pvs" $wbTag ($fa + @('-e', "PRIVATE_EMBEDDING_API_KEY=$($script:pvPrivKey)"))
  $okU = New-PvWorkbench "$P-pvu" $wbTag @('-e', "WORKSPACE_DEFAULT_SUB=$inA", '-e', 'WORKSPACE_IDENTITY_HEADER=X-Test-Sub', '-e', 'PRIVATE_EMBEDDING_API_KEY=')
  Check ($okS -and $okU -and (Wait-Http "http://$P-pvs:8000/health" 90) -and (Wait-Http "http://$P-pvu:8000/health" 90) -and (Wait-Http "http://$P-pvembed:8080/calls" 30)) '[5s] the sign-in workbench, the sign-in-off workbench (both as ob_workbench) and the counting embedder are up'
  $cu = Invoke-PvQ "SELECT string_agg(DISTINCT usename, ',') FROM pg_stat_activity WHERE datname = 'openbrain' AND usename IN ('ob_workbench', 'ob_app_memory')"
  Check ($cu -match 'ob_workbench') "[5s] 1.8 the workbenches' sessions log in as ob_workbench ($cu)"
  # 9.1f: the start-up disclosure, on the sign-in-off workbench only, naming no subject
  $logU = (Dk logs "$P-pvu") | Out-String; $logS = (Dk logs "$P-pvs") | Out-String
  Check ($logU -match 'private views are served to the default identity \(WORKSPACE_DEFAULT_SUB\) because sign-in \(forward-auth\) is off' -and $logU -notmatch [regex]::Escape($inA) -and $logS -notmatch 'private views are served to the default identity') '[5s] 9.1f the start-up line on the sign-in-off workbench only, naming no subject'

  # GREEN
  $g = Invoke-PvTest "$P-pvs" 'green'
  Check ($g.Success -and $g.Groups[1].Value -eq 'ok' -and [int]$g.Groups[3].Value -eq 0 -and [int]$g.Groups[2].Value -ge 15) "[5s] the owner's private view integration test (1.x, 2.x, 4.x, 9.x) ($($g.Value))"

  # the deploy pre-check (6b) and the readiness check (9.3), on lab env files (names; the values are lab placeholders)
  $envU = Join-Path $env:TEMP "$P-pv-envU"; $envS = Join-Path $env:TEMP "$P-pv-envS"; $envBlank = Join-Path $env:TEMP "$P-pv-envBlank"
  $script:made.dirs += @($envU, $envS, $envBlank)
  [System.IO.File]::WriteAllText($envU, "OB_WORKBENCH_EMBED_LLM_KEY=lab`nOB_WORKBENCH_DB_PASSWORD=lab`nWORKSPACE_FORWARD_AUTH_ISSUER=`nWORKSPACE_DOOR_KEY=`n")
  [System.IO.File]::WriteAllText($envS, "WORKSPACE_FORWARD_AUTH_ISSUER=lab`nWORKSPACE_FORWARD_AUTH_CLIENT_ID=lab`nWORKSPACE_FORWARD_AUTH_CLIENT_SECRET=lab`nWORKSPACE_DOOR_KEY=lab`n")
  [System.IO.File]::WriteAllText($envBlank, "OB_WORKBENCH_EMBED_LLM_KEY=`nOB_WORKBENCH_DB_PASSWORD=lab`n")
  $pre = Join-Path $wb 'check-owner-private-view-deploy.ps1'; $ready = Join-Path $wb 'check-multiuser-ready.ps1'
  $o1 = & powershell -NoProfile -File $pre -EnvFile $envU -DbContainer $db 2>&1 | Out-String; $e1 = $LASTEXITCODE
  $o2 = & powershell -NoProfile -File $pre -EnvFile $envBlank -DbContainer $db 2>&1 | Out-String; $e2 = $LASTEXITCODE
  $o3 = & powershell -NoProfile -File $ready -EnvFile $envU -Container "$P-pvu" 2>&1 | Out-String; $e3 = $LASTEXITCODE
  $o4 = & powershell -NoProfile -File $ready -EnvFile $envS -Container "$P-pvs" 2>&1 | Out-String; $e4 = $LASTEXITCODE
  Save 'pv-checks.log' ("[pre-check, both set]`n$o1`n[pre-check, embed key blank]`n$o2`n[ready, mode U]`n$o3`n[ready, mode S]`n$o4")
  $secretsOut = @($key, $pw, $script:pvDoor, $script:pvSecret, $script:pvPrivKey) | Where-Object { ($o1 + $o2 + $o3 + $o4).Contains($_) }
  Check ($e1 -eq 0 -and $o1 -match 'PRE-CHECK OK' -and $e2 -ne 0 -and $o2 -match 'OB_WORKBENCH_EMBED_LLM_KEY BLANK') '[5s] 6b the deploy pre-check: OK with both set and no drift; FAILS with the embedding key blank'
  Check ($e3 -ne 0 -and $o3 -match 'WORKSPACE_FORWARD_AUTH_ISSUER BLANK' -and $o3 -match 'private_views=default-identity' -and $e4 -eq 0 -and $o4 -match 'private_views=signed-in') '[5s] 9.3a/b the readiness check FAILS in mode U (names only, private_views=default-identity) and passes in mode S'
  Check (@($secretsOut).Count -eq 0) '[5s] neither check prints a value'

  # RED 1: the base workbench (development's pin before this item: no private routes)
  $baseTag = "openbrain-workbench:wt-$short-pvbase"
  $ob = Build-At $PvBaseSha $baseTag '' 'workbench'; Save 'build-workbench-pvbase.log' ($ob -split "`n" | Select-Object -Last 30 | Out-String)
  if ($script:rc -eq 0) {
    $script:made.images += $baseTag
    $okB = New-PvWorkbench "$P-pvbase" $baseTag ($fa + @('-e', "PRIVATE_EMBEDDING_API_KEY=$($script:pvPrivKey)"))
    if ($okB -and (Wait-Http "http://$P-pvbase:8000/health" 90)) {
      $rb = Invoke-PvTest "$P-pvbase" 'red-base' '/^(setup|1\.[1-5])/'
      Check ($rb.Success -and $rb.Groups[1].Value -eq 'FAILED' -and [int]$rb.Groups[2].Value -eq 0) "[5s] RED on the base ($PvBaseSha): every owner case fails (no private route; 1.6 is PD1's own route and is not in the RED set) ($($rb.Value))"
    } else { Fail "[5s] RED: the base workbench did not start" }
    $null = Dk rm -f -v "$P-pvbase"
  } else { Fail "[5s] RED: the base workbench ($PvBaseSha) did not build" }

  # RED 2: M-no-owner-filter - the text search without its owner filter: B reads A's moved sources
  $mut = (Get-Content -Raw (Join-Path $dockerDir 'init-owner-private-view.sql'))
  $m1 = $mut.Replace("WHERE s.inlet_owner_sub = p_sub AND public.owner_private_subject_ok(p_sub)", "WHERE public.owner_private_subject_ok(p_sub)").Replace("ch.source_id = src.id AND ch.inlet_owner_sub = p_sub", "ch.source_id = src.id")
  $m1Path = Join-Path $env:TEMP "$P-pv-m-owner.sql"; [System.IO.File]::WriteAllText($m1Path, $m1); $script:made.dirs += $m1Path
  Check ($m1 -ne $mut) '[5s] mutant M-no-owner-filter built'
  $null = Invoke-PvPsql $m1Path 'mutant M-no-owner-filter'
  $rm = Invoke-PvTest "$P-pvs" 'red-mutant-owner' '/^(setup|2\.1)/'
  Check ($rm.Success -and $rm.Groups[1].Value -eq 'FAILED') "[5s] RED: M-no-owner-filter (the text search drops owner = p_sub) - B reads A's, and the test fails ($($rm.Value))"
  # RED 3: M-grant - 480 grants ob_app_memory too: the catalog probe and the pre-check catch it
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -c "GRANT EXECUTE ON FUNCTION public.owner_private_claims(TEXT, UUID, TEXT, TEXT, UUID, TIMESTAMPTZ, UUID, INT) TO ob_app_memory"
  $catM = Invoke-PvQ $script:pvCatalogQ; $chkM = Invoke-PvCheckSql
  Check ($catM -match 'owner_private_claims=ob_app_memory,ob_workbench' -and $chkM -match 'drift: owner_private_claims' -and $chkM -match 'check: FAIL') '[5s] RED: M-grant (ob_app_memory may run owner_private_claims) - the catalog probe and the pre-check both catch it'
  # back to GREEN: 480 again fixes both mutants
  $rf = Invoke-PvPsql (Join-Path $dockerDir 'init-owner-private-view.sql') '480 after the mutants'
  $catF = Invoke-PvQ $script:pvCatalogQ
  Check ($rf.rc -eq 0 -and $rf.msg -match 'drift - owner_private_claims' -and ((@($catF -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) | Sort-Object) -join ';') -eq (($want | Sort-Object) -join ';')) '[5s] 480 again restores the functions and the grants (its NOTICE names the drift)'
  $g2 = Invoke-PvTest "$P-pvs" 'green-after-mutants' '/^(setup|2\.1)/'
  Check ($g2.Success -and $g2.Groups[1].Value -eq 'ok') "[5s] GREEN again after the mutants ($($g2.Value))"
  Save 'pv-psql.log' ($script:pvLog -join "`n")
}

function Invoke-OwnerPrivateViewRevert {
  Write-Host '[5s-revert] revert-owner-private-view.sql twice, then init again'
  foreach ($n in @("$P-pvs", "$P-pvu", "$P-pvembed")) { $null = Dk rm -f -v $n }
  $before = Invoke-PvQ "SELECT string_agg(p.proname || ':' || coalesce(array_to_string(p.proacl, ' '), '-'), ';' ORDER BY p.proname) FROM pg_proc p WHERE p.proname IN ('inlet_private_source', 'inlet_private_job')"
  $v1 = Invoke-PvPsql (Join-Path $dockerDir 'revert-owner-private-view.sql') 'revert'
  $fns = Invoke-PvQ "SELECT count(*) FROM pg_proc WHERE proname LIKE 'owner\_private\_%'"
  $pd1 = Invoke-PvQ "SELECT has_function_privilege('ob_app_memory', 'public.inlet_private_source(uuid,text)', 'EXECUTE')::text || has_function_privilege('ob_app_memory', 'public.inlet_private_job(uuid,text)', 'EXECUTE')::text"
  $role = Invoke-PvQ "SELECT coalesce((SELECT CASE WHEN rolcanlogin THEN 'login' ELSE 'nologin' END FROM pg_roles WHERE rolname = 'ob_workbench'), 'gone')"
  $v2 = Invoke-PvPsql (Join-Path $dockerDir 'revert-owner-private-view.sql') 'revert again'
  Check ($v1.rc -eq 0 -and $v2.rc -eq 0 -and $fns -eq '0' -and $pd1 -eq 'truetrue' -and ($role -eq 'gone' -or ($role -eq 'nologin' -and $v1.msg -match 'session'))) "[5s] 7.3 the revert (twice): the 480 functions gone ($fns), PD1's reads back on ob_app_memory ($pd1), ob_workbench $role (kept NOLOGIN only while a session uses it)"
  $i = Invoke-PvPsql (Join-Path $dockerDir 'init-owner-private-view.sql') 'init again after the revert'
  $cat = Invoke-PvQ $script:pvCatalogQ
  $role2 = Invoke-PvQ "SELECT rolcanlogin::text FROM pg_roles WHERE rolname = 'ob_workbench'"
  Check ($i.rc -eq 0 -and $role2 -eq 'true' -and $cat -match 'owner_private_claims=ob_workbench' -and $cat -match 'inlet_private_job=ob_workbench') "[5s] init again: the role (LOGIN), the functions and the grants are back (before the revert: $before)"
  Save 'pv-revert.log' ($script:pvLog -join "`n")
}
