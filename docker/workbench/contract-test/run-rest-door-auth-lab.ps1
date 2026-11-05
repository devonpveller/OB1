# run-rest-door-auth-lab.ps1 - the lab for rw-rest-door-auth (slot 450, init-rest-door-auth.sql).
#
# Stands up, on ONE --internal bridge (-Subnet, a fresh /24) and nothing else: the REAL initdb chain of the tree
# (from docker-compose.yml), a real PostgREST v12.2.3 configured as compose configures openbrain-postgrest, the
# real Caddyfile as openbrain-rest, and a node probe (rest-door-probe.mjs). Synthetic data only. Never a live
# container, never the live database, no published port, nothing on ai-stack_* / open-brain_*, no :local image,
# zero leftovers (everything is labelled ai-stack.harness.owner=<Id> and removed; the run checks).
#
# GREEN (default): the chain WITHOUT slot 450 first (the live database's state), a snapshot of what every
# non-door role can execute, then slot 450 by psql as the live deploy runs it (twice), the snapshot again, the door
# switched on (the REAL mint script makes the lab's secret, password and tokens), the probe's cases, then the
# revert round-trip. -Red: the same against -BaseSha (the base's chain, the base's compose PostgREST settings and
# Caddyfile, no slot 450): every case must FAIL (RED-OK), proving the checks see the defect.
#
#   powershell -NoProfile -File run-rest-door-auth-lab.ps1 -Subnet 10.231.7.0/24 -Evidence <empty dir>
#   powershell -NoProfile -File run-rest-door-auth-lab.ps1 -Subnet 10.231.8.0/24 -Evidence <empty dir> -Red
#
# Cases (the test plan's numbering): 1 unauthenticated (generated list, both doors) | 2 each caller with its own
# token + least privilege (generated per role) | 3 forged / borrowed claims | 4 owners | 5 PUBLIC + direct-Postgres
# continuity (catalog) | 6 health paths | 7 revert round-trip (GREEN only).
# Exit 0 = every check passed (with -Red: every case FAILED as it should).
param(
  [string]$Id = 'wt-rw-rest-door-auth',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$PgrstImage = 'postgrest/postgrest:v12.2.3',
  [string]$CaddyImage = 'caddy:2-alpine',
  [string]$NodeImage = 'node:22-slim',
  [string]$BaseSha = '116b80e',
  [switch]$Red,
  [switch]$Keep
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
$P = "rda-$rand"
$net = "$P-net"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
$evStage = Join-Path $env:TEMP "$P-evstage"; New-Item -ItemType Directory -Force $evStage | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$work = Join-Path $env:TEMP "$P-work"; New-Item -ItemType Directory -Force $work | Out-Null
$script:fail = 0
$script:made = @{ net = $false; containers = @(); dirs = @($evStage, $stage, $work) }
$summary = [ordered]@{}
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function RedCheck([bool]$defectShown, [string]$id, [string]$m) {
  if ($defectShown) { Write-Host "  RED-OK [$id] $m"; $summary[$id] = 'RED' } else { Write-Host "  RED-UNEXPECTED-PASS [$id] $m"; $script:fail++; $summary[$id] = 'UNEXPECTED-PASS' }
}
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $evStage $name), $text, (New-Object System.Text.UTF8Encoding $false)) }

# -- the lab docker shim (as run-workspace-tests.ps1) -------------------------------------------------------
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
  if ($a.Count -and $a[0] -eq 'build') { return 'this lab builds no image' }
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
function DkLong { Lab-Docker 1800 ([string[]]$args) }
$shimCases = @(@('run', '-p', '8080:8080', 'x'), @('run', '--network', 'ai-stack_app-net', 'x'), @('network', 'create', 'n'),
  @('run', 'openbrain-workbench:local'), @('compose', 'up'), @('build', '-t', 'x:wt-a', '.'), @('run', '--publish=1:1', 'x'))
$shimRefused = @($shimCases | Where-Object { Test-LabDockerArgs $_ }).Count
Check ($shimRefused -eq $shimCases.Count) "the lab docker shim refuses every forbidden shape ($shimRefused / $($shimCases.Count))"
function LocalSnapshot { (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim() -split "`n" | Sort-Object }
$localBefore = LocalSnapshot
function Run-Detached([string]$name, [string[]]$extra) {
  $o = Dk run -d --name $name --label $label --network $net @extra
  if ($script:rc -ne 0) { Fail "$name did not start: $o"; return $false }
  $script:made.containers += $name
  return $true
}
. (Join-Path $ct 'rest-door-lab.ps1')
function Psql([string]$sql) {
  $f = Join-Path $work ("q-" + [guid]::NewGuid().ToString('n') + '.sql')
  [System.IO.File]::WriteAllText($f, $sql, (New-Object System.Text.UTF8Encoding $false))
  $null = Dk cp $f "${db}:/tmp/q.sql"
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -tA -v ON_ERROR_STOP=1 -f /tmp/q.sql
  Remove-Item -Force $f
  return $o
}
function PsqlFile([string]$path) {
  $null = Dk cp $path "${db}:/tmp/f.sql"
  return (Dk exec $db psql -U postgres -d openbrain -X -v ON_ERROR_STOP=1 -f /tmp/f.sql)
}
# the function ACLs as a set (NULL = its default), and what every non-door role can execute
$aclSql = @"
SELECT md5(COALESCE(string_agg(x, E'\n' ORDER BY x), '')) FROM (
  SELECT p.oid::regprocedure::text || ' ' || COALESCE((SELECT string_agg(a.grantee::regrole::text || '=' || a.privilege_type, ',' ORDER BY a.grantee::regrole::text, a.privilege_type)
           FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee <> 0), '') ||
         CASE WHEN EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) THEN ' PUBLIC' ELSE '' END AS x
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace) s;
"@
$execSql = @"
SELECT r.rolname || ' ' || p.oid::regprocedure::text FROM pg_proc p CROSS JOIN pg_roles r
 WHERE p.pronamespace = 'public'::regnamespace AND NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.rolname !~ '^ob_rest_'
   AND r.rolname NOT IN ('anon', 'authenticated') AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
 ORDER BY 1;
"@

try {
  Write-Host "== rw-rest-door-auth lab  owner=$Id  net=$net  red=$([bool]$Red)  evidence=$Evidence"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  # ------------------------------------------------------------ 1. the chain
  Write-Host '[1] the initdb chain, from docker-compose.yml'
  $chainDir = $dockerDir
  if ($Red) {
    $baseTree = Join-Path $env:TEMP "$P-base"
    New-Item -ItemType Directory -Force $baseTree | Out-Null
    $script:made.dirs += $baseTree
    $tar = Join-Path $env:TEMP "$P-base.tar"
    & git -C $ob1 archive --format=tar -o $tar $BaseSha docker integrations/intake
    & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $tar -C $baseTree
    Remove-Item -Force $tar
    $chainDir = Join-Path $baseTree 'docker'
  }
  $compose = Get-Content -Raw (Join-Path $chainDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  $slot450 = @($chain | Where-Object { $_[1] -eq '450-init-rest-door-auth.sql' })
  if (-not $Red) { Check ($slot450.Count -eq 1) "the compose chain mounts 450-init-rest-door-auth.sql ($($chain.Count) migrations)" }
  # the live database is at the chain WITHOUT slot 450; 450 is applied by psql below, as the deploy does
  foreach ($m in $chain) { if ($m[1] -ne '450-init-rest-door-auth.sql') { Copy-Item (Join-Path $chainDir $m[0]) (Join-Path $stage $m[1]) } }

  # ------------------------------------------------------------ 2. network + database
  Write-Host '[2] the internal network and the database'
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
  if ($errs.Count) { Save 'initdb-errors.log' ($errs -join "`n") }
  # the production shape of the direct-Postgres roles: ob_app_memory LOGIN in service_role; ob_plane_personal / intake /
  # ob_pantry come from the chain where it has them
  $null = Psql "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role; END IF; END `$`$;"
  Check ($script:rc -eq 0) 'ob_app_memory (LOGIN, member of service_role) - the production shape'

  # ------------------------------------------------------------ 3. seed (synthetic)
  Write-Host '[3] synthetic rows'
  $seedSql = Get-Content -Raw (Join-Path $ct 'rest-door-fixtures.sql')
  $o = Psql $seedSql
  Check ($script:rc -eq 0 -and $o -notmatch 'ERROR') "fixtures applied$(if ($script:rc -ne 0) { ": $o" })"
  $seed = @{}
  foreach ($l in ((Psql "SELECT k || '=' || v FROM lab.seed ORDER BY k") -split "`n")) { if ($l -match '^([A-Za-z0-9_]+)=(.*)$') { $seed[$Matches[1]] = $Matches[2] } }
  Save 'seed.txt' (($seed.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join "`n")

  # ------------------------------------------------------------ 4. slot 450 by psql (GREEN), the continuity snapshot
  $aclBefore = (Psql $aclSql).Trim()
  $execBefore = @((Psql $execSql) -split "`n" | Where-Object { $_ })
  Save 'exec-before.txt' ($execBefore -join "`n")
  Write-Host "[4] slot 450 $(if ($Red) { '(not in the base)' } else { 'by psql, twice' })"
  if (-not $Red) {
    $o1 = PsqlFile (Join-Path $dockerDir 'init-rest-door-auth.sql'); $rc1 = $script:rc; Save '450-run1.log' $o1
    Check ($rc1 -eq 0) "init-rest-door-auth.sql ran (exit $rc1): $((($o1 -split "`n") | Where-Object { $_ -match 'NOTICE' }) -join ' | ')"
    $aclAfter = (Psql $aclSql).Trim()
    $o2 = PsqlFile (Join-Path $dockerDir 'init-rest-door-auth.sql'); $rc2 = $script:rc; Save '450-run2.log' $o2
    Check ($rc2 -eq 0 -and $o2 -match '0 function grant\(s\) made in place of PUBLIC') "a second run changes nothing it has not already (exit $rc2): $((($o2 -split "`n") | Where-Object { $_ -match 'NOTICE' }) -join ' | ')"
    Check ((Psql $aclSql).Trim() -eq $aclAfter) 'the function ACLs after run 2 equal those after run 1'
  }
  $execAfter = @((Psql $execSql) -split "`n" | Where-Object { $_ })
  Save 'exec-after.txt' ($execAfter -join "`n")

  # ------------------------------------------------------------ 5. case 5: PUBLIC and the direct-Postgres roles (catalog)
  Write-Host '[5] case 5 - PUBLIC runs nothing; every direct-Postgres role keeps every function it could run'
  $pubCount = [int]((Psql "SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE')").Trim())
  $lost = @($execBefore | Where-Object { $execAfter -notcontains $_ })
  Save 'exec-lost.txt' ($lost -join "`n")
  $newFn = (Psql @"
CREATE OR REPLACE FUNCTION public.lab_after_450() RETURNS int LANGUAGE sql AS 'SELECT 1';
SELECT has_function_privilege('public', 'public.lab_after_450()', 'EXECUTE')::text || ' ' || has_function_privilege('service_role', 'public.lab_after_450()', 'EXECUTE')::text
  || ' ' || has_function_privilege('ob_app_memory', 'public.lab_after_450()', 'EXECUTE')::text;
DROP FUNCTION public.lab_after_450();
"@).Trim()
  $roles = (@($execBefore | ForEach-Object { ($_ -split ' ')[0] }) | Sort-Object -Unique) -join ','
  if ($Red) {
    RedCheck ($pubCount -gt 0 -and $newFn -match '^true') '5-public' "the base: PUBLIC can run $pubCount public function(s); a new function is PUBLIC-executable ($newFn)"
  } else {
    $ok5 = ($pubCount -eq 0) -and ($lost.Count -eq 0) -and ($newFn -eq 'false true true')
    Check ($pubCount -eq 0) "[5-public] PUBLIC can run 0 public functions ($pubCount)"
    Check ($lost.Count -eq 0) "[5-public] every (role, function) a non-door role could execute before 450 it still can ($($execBefore.Count) pairs over roles $roles; lost $($lost.Count))"
    Check ($newFn -eq 'false true true') "[5-public] a function created after 450 is not PUBLIC-executable; service_role and ob_app_memory can run it ($newFn)"
    $summary['5-public'] = if ($ok5) { 'GREEN' } else { 'FAIL' }
  }

  # ------------------------------------------------------------ 6. the door
  Write-Host '[6] the door: PostgREST as compose configures it, the Caddyfile'
  if ($Red) {
    # the base's posture, read from the base compose: login postgres, anon = service_role; the base Caddyfile
    $pgr = [regex]::Match($compose, '(?s)  openbrain-postgrest:.*?environment:\s*\n(.*?)\n    networks:').Groups[1].Value
    Check ($pgr -match 'PGRST_DB_ANON_ROLE: service_role') 'RED: the base compose runs PostgREST with anon = service_role'
    $door = Start-LabRestDoor -Db $db -Pw $pw -CaddyFile (Join-Path $chainDir 'Caddyfile')
    # the base has no secret: the probe still needs one to forge tokens with
    $door.Secret = -join ((48..57 + 97..102) | Get-Random -Count 64 | ForEach-Object { [char]$_ })
    foreach ($k in @('WIKI', 'VIEWER', 'ENTITY', 'DIGEST', 'PODCAST', 'GMAIL_PULL', 'GMAIL_PRUNE')) { $door.Tokens[$k] = 'lab-no-token-at-the-base' }
  } else {
    $pgr = [regex]::Match($compose, '(?s)  openbrain-postgrest:.*?environment:\s*\n(.*?)\n    networks:').Groups[1].Value
    Check ($pgr -notmatch 'PGRST_DB_ANON_ROLE' -and $pgr -match 'ob_rest_authenticator' -and $pgr -match 'PGRST_JWT_SECRET' -and $pgr -match 'PGRST_JWT_AUD: openbrain-rest') 'compose: openbrain-postgrest logs in as ob_rest_authenticator, has the JWT secret and audience, and no anonymous role'
    $door = Start-LabRestDoor -Db $db -Pw $pw
    Check ($door.Door -eq 'auth' -and $door.Tokens.Count -eq 7) "the REAL mint script made the lab secret, the authenticator password and $($door.Tokens.Count) caller tokens (values not shown)"
  }
  $null = Psql "NOTIFY pgrst, 'reload schema';"
  Start-Sleep -Seconds 4

  # ------------------------------------------------------------ 7. the catalog the probe works from (generated)
  $catJson = (Psql @"
WITH rels AS (
  SELECT c.relname FROM pg_class c LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p', 'f') AND d.objid IS NULL),
fns AS (
  SELECT DISTINCT ON (p.proname) p.proname,
         CASE WHEN p.proargnames IS NULL THEN '[]'::json ELSE
         COALESCE((SELECT json_agg(n ORDER BY i) FROM unnest(p.proargnames, COALESCE(p.proargmodes, array_fill('i'::"char", ARRAY[cardinality(p.proargnames)]))) WITH ORDINALITY AS u(n, m, i)
                    WHERE m IN ('i', 'b', 'v') AND n <> ''), '[]'::json) END AS args,
         pg_get_function_identity_arguments(p.oid) AS ident, p.pronargs AS nargs
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
     AND p.prorettype <> 'trigger'::regtype
   ORDER BY p.proname, p.pronargs DESC),
door AS (SELECT rolname FROM pg_roles WHERE rolname ~ '^ob_rest_(wiki|viewer|entity|digest|podcast|gmail_pull|gmail_prune)$')
SELECT json_build_object(
  'relations', (SELECT json_agg(relname ORDER BY relname) FROM rels),
  'functions', (SELECT json_agg(json_build_object('name', proname, 'args', args, 'nargs', nargs) ORDER BY proname) FROM fns),
  'ownerFns', (SELECT json_agg(json_build_object('name', proname, 'args', args) ORDER BY proname) FROM fns
                WHERE ident ~* '\m(p_owner|p_owner_sub|p_sub|p_user_id|p_requester)\M' OR proname IN ('research_job_report_owner', 'setting_get', 'setting_problem', 'user_setting_set')),
  'privateRels', (SELECT json_agg(relname ORDER BY relname) FROM rels WHERE relname IN ('ideas', 'idea_revisions', 'idea_schedule', 'user_settings', 'research_handbacks',
                  'research_private_reports', 'research_private_report_claims', 'user_document_listings', 'workspace_rooms', 'workspace_room_entries',
                  'workspace_users', 'workspace_impersonation', 'refinery_user_sources', 'idea_thought_archive', 'idea_wiki_archive', 'admin_audit', 'held_sources')),
  'allowed', (SELECT COALESCE(json_object_agg(d.rolname, json_build_object(
                'relations', (SELECT COALESCE(json_agg(relname ORDER BY relname), '[]') FROM rels WHERE has_table_privilege(d.rolname, ('public.' || quote_ident(relname))::regclass, 'SELECT')),
                'functions', (SELECT COALESCE(json_agg(DISTINCT p.proname), '[]') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege(d.rolname, p.oid, 'EXECUTE')))), '{}') FROM door d)
);
"@).Trim()
  Save 'catalog-raw.txt' $catJson
  $catJson = (($catJson -split "`n") | Where-Object { $_ -match '^\{' }) -join ''
  Save 'catalog.json' $catJson
  [System.IO.File]::WriteAllText((Join-Path $work 'catalog.json'), $catJson, (New-Object System.Text.UTF8Encoding $false))
  $cat = $catJson | ConvertFrom-Json
  Check ($cat.relations.Count -gt 100 -and $cat.functions.Count -gt 50) "the generated list: $($cat.relations.Count) relations, $($cat.functions.Count) functions, $($cat.ownerFns.Count) owner-argument functions, $($cat.privateRels.Count) private relations"

  # ------------------------------------------------------------ 8. the probe: cases 1, 2, 3, 4, 6
  Write-Host '[8] the probe'
  $expected = [ordered]@{
    ob_rest_wiki = @('contract_registry_view', 'edges', 'entities', 'research_notifications', 'source_entities', 'sources', 'thought_entities', 'thoughts', 'thread_sources', 'threads', 'wiki_pages')
    ob_rest_viewer = @('wiki_pages')
    ob_rest_entity = @('edges', 'entities', 'entity_extraction_queue', 'source_entities', 'source_extraction_queue', 'sources', 'thought_entities', 'thoughts')
    ob_rest_digest = @('thoughts')
    ob_rest_podcast = @('podcast_episodes', 'podcast_presenters', 'podcast_render_requests', 'podcast_team_members', 'podcast_teams', 'podcast_voice_links', 'source_tombstones', 'sources', 'thoughts', 'thread_sources')
    ob_rest_gmail_pull = @('thoughts')
    ob_rest_gmail_prune = @('entities', 'thought_entities', 'thoughts')
  }
  $cfg = [ordered]@{
    rest = 'http://openbrain-rest'; pgrst = 'http://openbrain-postgrest:3000'; red = [bool]$Red; secret = $door.Secret
    tokens = $door.Tokens; catalogFile = '/work/catalog.json'; expectedMap = $expected; out = '/work/probe-result.json'
    roles = [ordered]@{ WIKI = 'ob_rest_wiki'; VIEWER = 'ob_rest_viewer'; ENTITY = 'ob_rest_entity'; DIGEST = 'ob_rest_digest'; PODCAST = 'ob_rest_podcast'; GMAIL_PULL = 'ob_rest_gmail_pull'; GMAIL_PRUNE = 'ob_rest_gmail_prune' }
    seed = [ordered]@{
      owner = 'lab-operator'; other = 'lab-other'; operatorWindow = 48; otherWindow = 6
      entityId = [int64]$seed.entity_id; entity2Id = [int64]$seed.entity2_id; thoughtId = [int64]$seed.thought_id; pruneThoughtId = [int64]$seed.prune_thought_id
      sourceId = $seed.source_id; threadId = $seed.thread_id; teamId = $seed.team_id; renderId = $seed.render_id; wikiSlug = $seed.wiki_slug
      notifyClass = $seed.notify_class; transcriptType = $seed.transcript_type
    }
  }
  [System.IO.File]::WriteAllText((Join-Path $work 'probe.json'), ($cfg | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding $false))
  $o = Lab-Docker 1200 @('run', '--rm', '--label', $label, '--network', $net, '-v', "${ct}:/ct:ro", '-v', "${work}:/work", '--entrypoint', 'node', $NodeImage, '/ct/rest-door-probe.mjs', '/work/probe.json')
  $probeRc = $script:rc
  # never keep the lab secret or tokens in evidence: the probe prints neither; the config file stays in $work (removed)
  Save 'probe.log' $o
  Write-Host (($o -split "`n" | Where-Object { $_ -match '^(PASS|FAIL|RED-OK|RED-UNEXPECTED-PASS|PROBE|  \[)' }) -join "`n")
  foreach ($l in ($o -split "`n")) {
    if ($l -match '^(PASS|FAIL|RED-OK|RED-UNEXPECTED-PASS) \[([0-9a-zA-Z_-]+)\]') {
      $k = $Matches[2]; $v = @{ PASS = 'GREEN'; FAIL = 'FAIL'; 'RED-OK' = 'RED'; 'RED-UNEXPECTED-PASS' = 'UNEXPECTED-PASS' }[$Matches[1]]
      if (-not $summary.Contains($k) -or $v -ne 'GREEN') { $summary[$k] = $v }
    }
  }
  Check ($probeRc -eq 0) "the probe exited 0 ($probeRc)"
  if (Test-Path (Join-Path $work 'probe-result.json')) { Copy-Item (Join-Path $work 'probe-result.json') (Join-Path $evStage 'probe-result.json') }

  # ------------------------------------------------------------ 9. case 7: the revert round-trip (GREEN)
  if (-not $Red) {
    Write-Host '[9] case 7 - the revert round-trip'
    $aclMid = (Psql $aclSql).Trim()
    $r1 = PsqlFile (Join-Path $dockerDir 'revert-rest-door-auth.sql'); $rr1 = $script:rc; Save 'revert-run1.log' $r1
    $aclRev = (Psql $aclSql).Trim()
    $left = (Psql "SELECT count(*) FROM pg_roles WHERE rolname ~ '^ob_rest_'").Trim() + '/' + (Psql "SELECT count(*) FROM pg_namespace WHERE nspname = 'rest_door'").Trim() + '/' +
      (Psql "SELECT count(*) FROM pg_policy WHERE polname LIKE 'rest\_door\_%'").Trim() + '/' + (Psql "SELECT count(*) FROM pg_proc WHERE proname = 'rest_setting_get'").Trim()
    $r2 = PsqlFile (Join-Path $dockerDir 'revert-rest-door-auth.sql'); $rr2 = $script:rc; Save 'revert-run2.log' $r2
    $o3 = PsqlFile (Join-Path $dockerDir 'init-rest-door-auth.sql'); $rr3 = $script:rc; Save '450-run3.log' $o3
    $aclAgain = (Psql $aclSql).Trim()
    $ok7 = ($rr1 -eq 0) -and ($aclRev -eq $aclBefore) -and ($left -eq '0/0/0/0') -and ($rr2 -eq 0 -and $r2 -match 'no archive') -and ($rr3 -eq 0) -and ($aclAgain -eq $aclMid)
    Check ($rr1 -eq 0 -and $aclRev -eq $aclBefore) "[7-revert] after the revert every function's ACL equals the pre-450 one (md5 $aclRev vs $aclBefore)"
    Check ($left -eq '0/0/0/0') "[7-revert] no door role, no rest_door schema, no copied policy, no rest_setting_get left ($left)"
    Check ($rr2 -eq 0 -and $r2 -match 'no archive') '[7-revert] a second revert says no archive and changes nothing'
    Check ($rr3 -eq 0 -and $aclAgain -eq $aclMid) "[7-revert] slot 450 again gives the same ACLs as the first time ($aclAgain)"
    $summary['7-revert'] = if ($ok7) { 'GREEN' } else { 'FAIL' }
  }
}
catch { Fail "lab aborted: $($_.Exception.Message)" }
finally {
  Write-Host '[10] teardown'
  if (-not $Keep) {
    foreach ($c in $script:made.containers) { $null = Dk rm -f -v $c }
    if ($script:made.net) { $null = Dk network rm $net }
  }
  $leftC = (Dk ps -a --filter "label=$label" --format '{{.Names}}' | Out-String).Trim()
  $leftN = (Dk network ls --filter "label=$label" --format '{{.Name}}' | Out-String).Trim()
  $leftV = (Dk volume ls --filter "label=$label" --format '{{.Name}}' | Out-String).Trim()
  if (-not $Keep) { Check (-not $leftC -and -not $leftN -and -not $leftV) "nothing labelled $Id is left (containers '$leftC', networks '$leftN', volumes '$leftV')" }
  $localAfter = LocalSnapshot
  if ((($localBefore -join "`n") -ne ($localAfter -join "`n"))) { Write-Host '  WARN  the :local image listing changed during the run (another session''s build?) - this lab never touches one' ; Save 'local-images-before.txt' ($localBefore -join "`n"); Save 'local-images-after.txt' ($localAfter -join "`n") }
  $sumLine = (($summary.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ')
  Save 'summary.txt' "mode=$(if ($Red) { 'RED' } else { 'GREEN' }) ob1=$sha fail=$($script:fail)`n$sumLine"
  New-Item -ItemType Directory -Force $Evidence | Out-Null
  Copy-Item -Recurse -Force (Join-Path $evStage '*') $Evidence
  if (-not $Keep) { foreach ($d in $script:made.dirs) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } } }
  Write-Host "SUMMARY $sumLine"
  if ($script:fail) { Write-Host "LAB FAILED ($($script:fail) failed)"; exit 1 } else { Write-Host 'LAB OK'; exit 0 }
}
