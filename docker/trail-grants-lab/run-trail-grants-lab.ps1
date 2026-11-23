# run-trail-grants-lab.ps1 - disposable lab for rwr-trail-grants-exact (slot 510: the removal trail is append-only for the app).
#   powershell -NoProfile -File OB1\docker\trail-grants-lab\run-trail-grants-lab.ps1 [-Id wt-rwr-trail-grants-exact] [-Evidence <dir>] [-OldSha 68d24a7]
# One postgres container (--network none, no published port, labelled ai-stack.harness.owner=<Id>) running the REAL initdb chain
# from docker-compose.yml, then: the live starting point (the previous 510 from -OldSha), the new 510 re-run on it, the ACL, the
# trigger, idempotence, the grants-only revert compared against the starting point, the whole revert, init again.
# Never touches the live stack. Exit 0 = every check passed.
param(
  [string]$Id = 'wt-rwr-trail-grants-exact',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$OldSha = '68d24a7',
  [string]$Evidence = ''
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$label = "ai-stack.harness.owner=$Id"
$dockerDir = Split-Path -Parent $PSScriptRoot
$ob1 = Split-Path -Parent $dockerDir
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$db = "rwtg-db-$rand"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "rwtg-evidence-$rand" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$work = Join-Path $env:TEMP "rwtg-work-$rand"
$script:fail = 0
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }
function Save([string]$n, [string]$t) { [IO.File]::WriteAllText((Join-Path $Evidence $n), $t, (New-Object Text.UTF8Encoding $false)) }
function Q([string]$sql) { $r = Dk exec $db psql -U postgres -d openbrain -X -A -t -c $sql; return "$r".Trim() }
function PsqlFile([string]$local) {
  $name = '/tmp/' + [IO.Path]::GetFileName($local)
  $null = Dk cp $local "${db}:$name"
  $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -f $name
  return @{ rc = $script:rc; out = $o }
}
# the catalog of the table: ACL, policies, triggers, the trigger function, the sequence ACL, RLS flags, columns, indexes
$catSql = @"
SELECT 'acl|' || coalesce((SELECT string_agg(a, ',' ORDER BY a) FROM (SELECT unnest(relacl)::text a FROM pg_class WHERE oid='public.user_document_trail'::regclass) x), 'NULL')
UNION ALL SELECT 'rls|' || relrowsecurity || relforcerowsecurity FROM pg_class WHERE oid='public.user_document_trail'::regclass
UNION ALL SELECT 'policy|' || polname || '|' || polcmd || '|' || pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polrelid='public.user_document_trail'::regclass
UNION ALL SELECT 'trigger|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.user_document_trail'::regclass AND NOT tgisinternal
UNION ALL SELECT 'func|' || p.proname || '|' || coalesce(p.proacl::text,'NULL') FROM pg_proc p WHERE p.proname='user_document_trail_no_edit'
UNION ALL SELECT 'seqacl|' || coalesce(relacl::text,'NULL') FROM pg_class WHERE oid='public.user_document_trail_id_seq'::regclass
UNION ALL SELECT 'col|' || attname || '|' || format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid='public.user_document_trail'::regclass AND attnum>0 AND NOT attisdropped
UNION ALL SELECT 'check|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.user_document_trail'::regclass AND contype='c'
UNION ALL SELECT 'idx|' || indexdef FROM pg_indexes WHERE tablename='user_document_trail'
ORDER BY 1
"@
function Catalog { (Q $catSql) }
$privList = "ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']"

Write-Host "== rwr-trail-grants-exact disposable run  owner=$Id  evidence=$Evidence"
$null = Dk version --format '{{.Server.Version}}'
if ($script:rc -ne 0) { Write-Host 'docker is not reachable'; exit 2 }
$localBefore = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}') -split "`n" | Sort-Object
try {
  Write-Host '[1] stage the real initdb chain'
  $stage = Join-Path $work 'initdb'; New-Item -ItemType Directory -Force $stage | Out-Null
  $compose = (@(Get-Content (Join-Path $dockerDir 'docker-compose.yml')) | ForEach-Object { $_ -replace '(^|\s)#.*$', '' }) -join "`n"
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check ($chain.Count -ge 50 -and @(Get-ChildItem $stage -Filter *.sql).Count -eq $chain.Count) "staged $($chain.Count) migrations"
  Check (@($chain | Where-Object { $_[1] -eq '510-init-document-trail.sql' }).Count -eq 1) 'the chain mounts 510-init-document-trail.sql'
  $oldFile = Join-Path $work 'old-510.sql'
  $old = (& git -C $ob1 show "${OldSha}:docker/init-document-trail.sql") -join "`n"
  [IO.File]::WriteAllText($oldFile, $old + "`n", (New-Object Text.UTF8Encoding $false))
  Check ($old -match 'GRANT SELECT, INSERT, DELETE' -and $old -notmatch 'no_edit') "the previous 510 is OB1 $OldSha"

  Write-Host '[2] database: the chain (new 510), roles as production'
  $o = Dk run -d --name $db --label $label --network none -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=openbrain -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
  if ($script:rc -ne 0) { Fail "postgres did not start: $o"; throw 'db' }
  for ($i = 0; $i -lt 150; $i++) {
    $logs = Dk logs $db
    if ($logs -match 'PostgreSQL init process complete') { break }
    if ((Dk inspect -f '{{.State.Running}}' $db) -ne 'true') { break }
    Start-Sleep -Seconds 2
  }
  $logs = Dk logs $db; Save 'initdb.log' $logs
  Check ($logs -match 'PostgreSQL init process complete') 'the initdb chain ran to completion'
  Check (@(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' }).Count -eq 0) 'initdb logged no ERROR'
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $null = Q "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ob_app_memory') THEN CREATE ROLE ob_app_memory LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE service_role; END IF; END `$`$"
  $r = PsqlFile (Join-Path $dockerDir 'init-owner-private-view.sql')   # 480 again: ob_workbench joins ob_app_memory
  Check ($r.rc -eq 0) '480 re-run (ob_workbench, a member of ob_app_memory)'
  Check ((Q "SELECT pg_has_role('ob_workbench','service_role','USAGE')") -eq 't') 'ob_workbench is a member of service_role (via ob_app_memory)'
  Check ((Q "SELECT pg_has_role('ob_app_memory','service_role','USAGE')") -eq 't') 'ob_app_memory is a member of service_role'

  Write-Host '[3] the live starting point: the previous 510 on this database'
  $null = Q "DROP TABLE public.user_document_trail"
  $r = PsqlFile $oldFile
  Check ($r.rc -eq 0) 'previous 510 applied'
  $null = Q "INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, path) VALUES ('lab-a','lab-a','delete_forever','documents/x/.trash/a.md')"
  $before = Catalog; Save 'catalog-live-before.txt' $before
  Check ((Q "SELECT has_table_privilege('service_role','public.user_document_trail','UPDATE') AND has_table_privilege('service_role','public.user_document_trail','TRUNCATE')") -eq 't') 'starting point shows the defect: service_role can UPDATE and TRUNCATE'
  $rowsBefore = Q "SELECT count(*) FROM public.user_document_trail"

  Write-Host '[4] the new 510 re-run on the live-like database'
  $new = Join-Path $dockerDir 'init-document-trail.sql'
  # F3: 510 is ONE transaction. A copy whose last statement before COMMIT fails must change nothing (REVOKE, GRANT, triggers all rolled back)
  $newText = [IO.File]::ReadAllText($new)
  Check ($newText -match '(?m)^BEGIN;' -and $newText -match '(?m)^COMMIT;') '510 opens with BEGIN and ends with COMMIT'
  $bad = Join-Path $work 'bad-510.sql'
  [IO.File]::WriteAllText($bad, ($newText -replace '(?m)^COMMIT;', "SELECT 1/0;`nCOMMIT;"), (New-Object Text.UTF8Encoding $false))
  $r = PsqlFile $bad
  Save '510-failing-copy.log' $r.out
  Check ($r.rc -ne 0 -and $r.out -match 'division by zero') "510 with a failing last statement exits non-zero (rc $($r.rc): $((($r.out -split "`n") | Select-Object -First 2) -join ' / '))"
  Check ((Catalog) -eq $before) 'and it changed nothing: the catalog is still the starting point (one transaction)'
  $r = PsqlFile $new; Save '510-rerun-1.log' $r.out
  Check ($r.rc -eq 0) 'new 510 runs cleanly on a database that already ran the previous one'
  $after1 = Catalog; Save 'catalog-after-1.txt' $after1
  Check ((Q "SELECT count(*) FROM public.user_document_trail") -eq $rowsBefore) 'the existing trail rows are untouched'
  $r = PsqlFile $new
  Check ($r.rc -eq 0) 'second re-run exits 0'
  $after2 = Catalog; Save 'catalog-after-2.txt' $after2
  Check ($after1 -eq $after2) 'idempotent: the catalog after the second run is identical to after the first'

  Write-Host '[5] privileges: every non-superuser role, then service_role and its members'
  $matrix = Q "SELECT r.rolname || '|' || coalesce((SELECT string_agg(p, ',' ORDER BY p) FROM unnest($privList) p WHERE has_table_privilege(r.oid,'public.user_document_trail',p)),'') FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' ORDER BY 1"
  Save 'privileges-after.txt' $matrix
  foreach ($role in 'service_role', 'ob_app_memory', 'ob_workbench') {
    $line = (($matrix -split "`n") | Where-Object { $_ -like "$role|*" }) -join ''
    Check ($line -eq "$role|INSERT,SELECT") "$role holds exactly INSERT, SELECT ($line)"
    foreach ($p in 'UPDATE', 'DELETE', 'TRUNCATE') { Check ((Q "SELECT has_table_privilege('$role','public.user_document_trail','$p')") -eq 'f') "has_table_privilege($role, $p) = false" }
    foreach ($p in 'SELECT', 'INSERT') { Check ((Q "SELECT has_table_privilege('$role','public.user_document_trail','$p')") -eq 't') "has_table_privilege($role, $p) = true" }
  }
  Save 'service_role-members.txt' (Q "SELECT string_agg(rolname, ',') FROM pg_roles WHERE NOT rolsuper AND pg_has_role(oid,'service_role','USAGE') AND rolname <> 'service_role'")
  $nonMemberHolding = Q "SELECT string_agg(rolname, ',') FROM pg_roles r WHERE NOT rolsuper AND rolname !~ '^pg_' AND NOT pg_has_role(oid,'service_role','USAGE') AND EXISTS (SELECT 1 FROM unnest($privList) p WHERE has_table_privilege(r.oid,'public.user_document_trail',p))"
  Check ($nonMemberHolding -eq '') "no role outside service_role's members holds anything: anon, authenticated, the ob_rest_* door roles, PUBLIC ($nonMemberHolding)"
  Check ([int](Q "SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated')") -ge 1) 'anon / authenticated exist in this chain (so the check above covered them)'
  Check ([int](Q "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'ob_rest_%'") -ge 1) 'the ob_rest_* door roles exist in this chain (so the check above covered them)'
  Check ((Q "SELECT relacl::text FROM pg_class WHERE oid='public.user_document_trail'::regclass") -notmatch '(^|[{,])=') 'PUBLIC has no entry in the ACL'
  Check ((($before -split "`n") | Where-Object { $_ -like 'seqacl|*' }) -eq (($after1 -split "`n") | Where-Object { $_ -like 'seqacl|*' })) 'the sequence ACL did not change'
  # who is a member of service_role, and what each holds, is the same as before apart from the two rights taken back
  $svcMembers = (Q "SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE NOT rolsuper AND pg_has_role(oid,'service_role','USAGE') AND rolname <> 'service_role'")
  Check ($svcMembers -match 'ob_app_memory' -and $svcMembers -match 'ob_workbench') "service_role's members: $svcMembers"

  Write-Host '[6] the refusal: a role that would otherwise hold UPDATE / TRUNCATE'
  $null = Q "CREATE ROLE lab_holder NOLOGIN NOSUPERUSER; GRANT USAGE ON SCHEMA public TO lab_holder; GRANT ALL ON public.user_document_trail TO lab_holder"
  Check ((Q "SELECT has_table_privilege('lab_holder','public.user_document_trail','UPDATE') AND has_table_privilege('lab_holder','public.user_document_trail','TRUNCATE')") -eq 't') 'lab_holder (not a superuser) holds ALL on the table'
  $cases = @(
    @('UPDATE as lab_holder', "SET ROLE lab_holder; UPDATE public.user_document_trail SET kind='empty_trash'"),
    @('TRUNCATE as lab_holder', "SET ROLE lab_holder; TRUNCATE public.user_document_trail"),
    @('UPDATE as the superuser', "UPDATE public.user_document_trail SET path='x'"),
    @('TRUNCATE as the superuser', "TRUNCATE public.user_document_trail"),
    @('UPDATE as service_role', "SET ROLE service_role; UPDATE public.user_document_trail SET path='x'"),
    @('TRUNCATE as ob_workbench', "SET ROLE ob_workbench; TRUNCATE public.user_document_trail"),
    @('DELETE (no WHERE) as lab_holder', "SET ROLE lab_holder; DELETE FROM public.user_document_trail"),
    @('DELETE (no WHERE) as the superuser', "DELETE FROM public.user_document_trail"),
    @('DELETE with WHERE as the superuser', "DELETE FROM public.user_document_trail WHERE owner_sub = 'lab-a'"),
    @('DELETE (no WHERE) as ob_workbench', "SET ROLE ob_workbench; DELETE FROM public.user_document_trail"),
    @('DELETE (no WHERE) as service_role', "SET ROLE service_role; DELETE FROM public.user_document_trail"))
  foreach ($c in $cases) {
    $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c $c[1]
    Check ($script:rc -ne 0 -and $o -match 'append-only|permission denied') "refused: $($c[0]) ($((($o -split "`n") | Where-Object { $_ -match 'ERROR' } | Select-Object -First 1)))"
    if ($c[0] -match 'lab_holder|superuser') { Check ($o -match 'append-only') "  by the trigger, not by a missing grant: $($c[0])" }
  }
  Check ((Q "SELECT count(*) FROM public.user_document_trail") -eq $rowsBefore) 'no row lost or changed by the refused statements'
  $null = Q "DROP OWNED BY lab_holder; DROP ROLE lab_holder"
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "SET ROLE ob_workbench; INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, path) VALUES ('lab-a','lab-a','restored','documents/x/b.md'); SELECT count(*) FROM public.user_document_trail"
  Check ($script:rc -eq 0) 'ob_workbench can INSERT and SELECT a line (the app still appends and reads)'
  Check ((Q "SELECT count(*) FROM public.user_document_trail") -eq ([int]$rowsBefore + 1)) 'the appended line is there and nothing was deleted'
  $null = Q "ALTER TABLE public.user_document_trail DISABLE TRIGGER trg_user_document_trail_no_delete; DELETE FROM public.user_document_trail WHERE kind = 'restored'; ALTER TABLE public.user_document_trail ENABLE TRIGGER trg_user_document_trail_no_delete"   # lab cleanup by the superuser, on purpose
  Check ((Q "SELECT count(*) FROM public.user_document_trail") -eq $rowsBefore) 'lab cleanup (superuser disabled the trigger on purpose) restored the starting rows'
  Check ((Q "SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_user_document_trail_no_delete'") -eq 'O') 'the no-delete trigger is enabled again'

Write-Host '[7] the grants-only revert restores the starting point'
  $r = PsqlFile (Join-Path $dockerDir 'revert-document-trail-grants.sql'); Save 'revert-grants.log' $r.out
  Check ($r.rc -eq 0) 'revert-document-trail-grants.sql exits 0'
  $rev = Catalog; Save 'catalog-after-grants-revert.txt' $rev
  Check ($rev -eq $before) 'catalog after the grants revert is byte-identical to the starting point (ACL, RLS, policy, triggers, functions, sequence, columns, indexes)'
  Check ((Q "SELECT count(*) FROM public.user_document_trail") -eq $rowsBefore) 'the rows are kept'
  $r = PsqlFile (Join-Path $dockerDir 'revert-document-trail-grants.sql')
  Check ($r.rc -eq 0 -and (Catalog) -eq $before) 'the grants revert twice: still identical'
  $r = PsqlFile $new
  Check ($r.rc -eq 0 -and (Catalog) -eq $after1) 'the new 510 applied again after the revert: identical to the first run'

  Write-Host '[8] the whole revert and init again'
  $r = PsqlFile (Join-Path $dockerDir 'revert-document-trail.sql')
  Check ($r.rc -eq 0 -and (Q "SELECT to_regclass('public.user_document_trail') IS NULL") -eq 't' -and (Q "SELECT count(*) FROM pg_proc WHERE proname='user_document_trail_no_edit'") -eq '0') 'revert-document-trail.sql removes the table and the trigger function'
  $r = PsqlFile (Join-Path $dockerDir 'revert-document-trail.sql')
  Check ($r.rc -eq 0) 'the revert twice exits 0'
  $r = PsqlFile $new
  Check ($r.rc -eq 0 -and (Catalog) -eq $after1) 'init on the empty database gives the same catalog as the live re-run'
} catch { Fail "lab error: $_" }
finally {
  Write-Host '[9] teardown'
  $null = Dk rm -f $db
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  $left = Dk ps -a --filter "label=$label" --format '{{.Names}}'
  Check ($left.Trim() -eq '') 'nothing labelled for this run is left'
  $localAfter = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}') -split "`n" | Sort-Object
  Check (($localBefore -join '|') -eq ($localAfter -join '|')) 'no :local image changed'
}
Write-Host "== done: $script:fail failure(s); evidence $Evidence"
exit ([int]($script:fail -ne 0))
