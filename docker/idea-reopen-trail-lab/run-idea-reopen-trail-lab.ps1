# run-idea-reopen-trail-lab.ps1 - disposable lab for rw-idea-reopen-trail (slot 690: a 'reopened' line in user_document_trail).
#   powershell -NoProfile -File OB1\docker\idea-reopen-trail-lab\run-idea-reopen-trail-lab.ps1 [-Id wt-rw-idea-reopen-trail] [-Evidence <dir>]
# One postgres container (--network none, no published port, labelled ai-stack.harness.owner=<Id>) running the REAL initdb chain
# from docker-compose.yml WITHOUT slot 690 (the live starting point), then: the pre-690 schema dump, 690 applied, the check
# script, the shape CHECK (valid and invalid rows), the append-only ACL and triggers, idempotence, MUTATIONS (the shape CHECK
# dropped lets an invalid row in; the kind CHECK left narrow refuses a reopened line), the revert (rows other than 'reopened'
# kept, 'reopened' rows gone, the schema dump byte-identical to the pre-690 dump once pg_dump's random \restrict line is
# dropped), revert twice, apply again, then the shipped chain (690 included) on a fresh volume.
# Never touches the live stack. Exit 0 = every check passed.
param(
  [string]$Id = 'wt-rw-idea-reopen-trail',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Evidence = ''
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$label = "ai-stack.harness.owner=$Id"
$dockerDir = Split-Path -Parent $PSScriptRoot
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$db = "rwirt-db-$rand"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "rwirt-evidence-$rand" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$work = Join-Path $env:TEMP "rwirt-work-$rand"
$script:fail = 0; $script:pass = 0
function Pass([string]$m) { Write-Host "  PASS  $m"; $script:pass++ }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }
function Save([string]$n, [string]$t) { [IO.File]::WriteAllText((Join-Path $Evidence $n), $t, (New-Object Text.UTF8Encoding $false)) }
function Q([string]$sql) {
  $r = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -A -t -c $sql
  if ($script:rc -ne 0 -or "$r" -match '(?m)^(psql: )?ERROR:') { Fail "query failed (rc $($script:rc)): $("$r".Substring(0, [Math]::Min(300, "$r".Length)))"; throw "query failed" }
  return "$r".Trim()
}
# a statement expected to be REFUSED: returns the error text ('' when it was accepted)
function Refused([string]$sql) {
  $r = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -A -t -c $sql
  if ($script:rc -eq 0) { return '' }
  return "$r"
}
function PsqlFile([string]$local) {
  $name = '/tmp/' + [IO.Path]::GetFileName($local)
  $null = Dk cp $local "${db}:$name"
  $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -f $name
  return @{ rc = $script:rc; out = $o }
}
function RunCheck {
  $null = Dk cp (Join-Path $dockerDir 'check-idea-reopen-trail.sql') "${db}:/tmp/check.sql"
  return (Dk exec $db psql -X -A -t -q -U postgres -d openbrain -f /tmp/check.sql)
}
# the table's schema, as pg_dump writes it; pg_dump 16 adds a random \restrict / \unrestrict token line: drop it before any compare
function Dump {
  $o = Dk exec $db pg_dump -U postgres -d openbrain -s -t public.user_document_trail --no-comments
  if ($script:rc -ne 0) { Fail "pg_dump failed: $o"; throw 'dump' }
  return (($o -split "`n") | Where-Object { $_ -notmatch '^\\(un)?restrict ' }) -join "`n"
}
$catSql = @"
SELECT 'relacl|' || coalesce(relacl::text, 'NULL') FROM pg_class WHERE oid='public.user_document_trail'::regclass
UNION ALL SELECT 'policy|' || polname || '|' || polcmd::text FROM pg_policy WHERE polrelid='public.user_document_trail'::regclass
UNION ALL SELECT 'trigger|' || tgname || '|' || tgenabled FROM pg_trigger WHERE tgrelid='public.user_document_trail'::regclass AND NOT tgisinternal
UNION ALL SELECT 'seqacl|' || coalesce(relacl::text,'NULL') FROM pg_class WHERE oid='public.user_document_trail_id_seq'::regclass
ORDER BY 1
"@
$IDEA = 'a1000000-0000-4000-8000-0000000000a1'
Write-Host "== rw-idea-reopen-trail disposable run  owner=$Id  evidence=$Evidence"
$null = Dk version --format '{{.Server.Version}}'
if ($script:rc -ne 0) { Write-Host 'docker is not reachable'; exit 2 }
$localBefore = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}') -split "`n" | Sort-Object
try {
  Write-Host '[1] stage the real initdb chain WITHOUT slot 690'
  $stage = Join-Path $work 'initdb'; New-Item -ItemType Directory -Force $stage | Out-Null
  $compose = (@(Get-Content (Join-Path $dockerDir 'docker-compose.yml')) | ForEach-Object { $_ -replace '(^|\s)#.*$', '' }) -join "`n"
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  Check (@($chain | Where-Object { $_[1] -eq '690-init-idea-reopen-trail.sql' -and $_[0] -eq './init-idea-reopen-trail.sql' }).Count -eq 1) 'the chain mounts ./init-idea-reopen-trail.sql as 690'
  foreach ($m in $chain) { if ($m[1] -ne '690-init-idea-reopen-trail.sql') { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) } }
  Check ($chain.Count -ge 50 -and @(Get-ChildItem $stage -Filter *.sql).Count -eq $chain.Count - 1) "staged $($chain.Count - 1) migrations (every one but 690)"
  Check (@($chain | Where-Object { $_[1] -eq '510-init-document-trail.sql' }).Count -eq 1) 'the chain mounts 510-init-document-trail.sql, unchanged by this item'

  Write-Host '[2] database: the chain without 690, roles as production'
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
  Check ((Q "SELECT count(*) FROM information_schema.columns WHERE table_name='user_document_trail' AND column_name='idea_id'") -eq '0') 'the starting point has no idea_id column'
  $null = Q "INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, path) VALUES ('lab-a','lab-a','delete_forever','documents/x/.trash/a.md'), ('lab-a','lab-a','restored','documents/x/b.md')"
  $pre = Dump; Save 'dump-pre-690.sql' $pre
  $preCat = Q $catSql; Save 'catalog-pre-690.txt' $preCat
  Check ($pre -match 'path text NOT NULL' -and $pre -notmatch 'idea_id') 'the pre-690 dump: path NOT NULL, no idea_id'
  Check ((Refused "INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, path) VALUES ('lab-a','lab-a','reopened','p.md')") -match 'violates check constraint') 'before 690 the kind CHECK refuses a reopened line'

  Write-Host '[3] slot 690 applied by psql -f (the live way)'
  $f690 = Join-Path $dockerDir 'init-idea-reopen-trail.sql'
  $r = PsqlFile $f690; Save '690-apply-1.log' $r.out
  Check ($r.rc -eq 0) '690 applies cleanly on a database that ran the chain without it'
  Check ((Q "SELECT count(*) FROM public.user_document_trail") -eq '2') 'the existing lines are untouched'
  $post1 = Dump; Save 'dump-post-690.sql' $post1
  $r = PsqlFile $f690
  Check ($r.rc -eq 0 -and (Dump) -eq $post1) '690 twice: exit 0, identical schema (idempotent)'
  $chk = RunCheck; Save 'check-690.txt' $chk
  Check ($chk -match 'check: OK' -and $chk -notmatch 'FAIL') "check-idea-reopen-trail.sql reports OK ($(($chk -split "`n" | Select-Object -Last 1)))"
  Check ((Q $catSql) -eq $preCat) 'ACL, policy, triggers and sequence ACL are exactly as slot 510 left them (690 changes none)'

  Write-Host '[4] the shape CHECK'
  $ok1 = Refused "INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, idea_id) VALUES ('lab-a','lab-a','reopened','$IDEA')"
  Check ($ok1 -eq '') 'a well-formed reopened line (idea id, no path, no document id) is accepted'
  $bad = @(
    @('reopened with a path', "INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, idea_id, path) VALUES ('lab-a','lab-a','reopened','$IDEA','documents/x/y.md')"),
    @('reopened with a document id', "INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, idea_id, document_id) VALUES ('lab-a','lab-a','reopened','$IDEA','$IDEA')"),
    @('reopened with trashed_at', "INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, idea_id, trashed_at) VALUES ('lab-a','lab-a','reopened','$IDEA', now())"),
    @('reopened with no idea id', "INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind) VALUES ('lab-a','lab-a','reopened')"),
    @('restored with an idea id', "INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, idea_id, path) VALUES ('lab-a','lab-a','restored','$IDEA','documents/x/y.md')"),
    @('restored with no path', "INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind) VALUES ('lab-a','lab-a','restored')"),
    @('an unknown kind', "INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, path) VALUES ('lab-a','lab-a','whatever','p.md')"))
  foreach ($b in $bad) { Check ((Refused $b[1]) -match 'violates check constraint') "refused: $($b[0])" }
  Check ((Q "SELECT count(*) FROM public.user_document_trail") -eq '3') 'only the one valid reopened line was added'
  $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -c "SET ROLE service_role; INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, idea_id) VALUES ('lab-b','lab-b','reopened','$IDEA'); SELECT count(*) FROM public.user_document_trail"
  Check ($script:rc -eq 0) 'service_role can still INSERT a reopened line and SELECT'
  foreach ($c in @("UPDATE public.user_document_trail SET kind='reopened'", "DELETE FROM public.user_document_trail", "TRUNCATE public.user_document_trail")) {
    $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -c "SET ROLE service_role; $c"
    Check ($script:rc -ne 0 -and $o -match 'append-only|permission denied') "refused for service_role: $c"
  }
  $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -c "DELETE FROM public.user_document_trail WHERE kind='reopened'"
  Check ($script:rc -ne 0 -and $o -match 'append-only') 'even the superuser cannot DELETE a line (the trigger)'
  $null = Q "INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, idea_id) VALUES ('lab-a','lab-a','reopened','$IDEA')"   # a further reopened line, to be discarded by the revert

  Write-Host '[5] MUTATIONS (each must make the matching check fail, then be put back)'
  $null = Q "ALTER TABLE public.user_document_trail DROP CONSTRAINT user_document_trail_subject_check"
  Check ((Refused "INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, idea_id, path) VALUES ('lab-m','lab-m','reopened','$IDEA','documents/x/leak.md')") -eq '') 'MUTANT shape CHECK dropped: a reopened line carrying a path gets in'
  $mchk = RunCheck
  Check ($mchk -match 'check: FAIL' -and $mchk -match 'shape_check_missing=1' -and $mchk -match 'reopened_lines_with_text_or_path=1') 'and check-idea-reopen-trail.sql reports FAIL for it (shape_check_missing, reopened_lines_with_text_or_path)'
  $null = Q "ALTER TABLE public.user_document_trail DISABLE TRIGGER trg_user_document_trail_no_delete; DELETE FROM public.user_document_trail WHERE owner_sub = 'lab-m'; ALTER TABLE public.user_document_trail ENABLE TRIGGER trg_user_document_trail_no_delete"
  $r = PsqlFile $f690
  Check ($r.rc -eq 0 -and (Dump) -eq $post1) 'applying 690 again puts the shape CHECK back (schema identical to after the first run)'
  $null = Q "ALTER TABLE public.user_document_trail DROP CONSTRAINT user_document_trail_kind_check; ALTER TABLE public.user_document_trail ADD CONSTRAINT user_document_trail_kind_check CHECK (kind IN ('delete_forever','empty_trash','nightly_expired','restored','unarchived'))"
  Check ((Refused "INSERT INTO public.user_document_trail (owner_sub, actor_sub, kind, idea_id) VALUES ('lab-m','lab-m','reopened','$IDEA')") -match 'violates check constraint') 'MUTANT kind CHECK left narrow: the reopened line is refused (the app write would fail)'
  $mchk = RunCheck
  Check ($mchk -match 'kind_check_without_reopened=1' -and $mchk -match 'check: FAIL') 'and the check script reports FAIL for it'
  $r = PsqlFile $f690
  Check ($r.rc -eq 0 -and (Dump) -eq $post1) 'applying 690 again restores the kind CHECK'
  Check ((Q "SELECT count(*) FROM public.user_document_trail WHERE owner_sub = 'lab-m'") -eq '0') 'no mutation row is left'

  Write-Host '[6] the revert'
  Check ((Q "SELECT count(*) FROM public.user_document_trail WHERE kind = 'reopened'") -eq '3') 'three reopened lines exist before the revert'
  $fRev = Join-Path $dockerDir 'revert-idea-reopen-trail.sql'
  $r = PsqlFile $fRev; Save 'revert-1.log' $r.out
  Check ($r.rc -eq 0) 'revert-idea-reopen-trail.sql exits 0'
  Check ((Q "SELECT count(*) FROM public.user_document_trail WHERE kind <> 'reopened'") -eq '2' -and (Q "SELECT count(*) FROM public.user_document_trail") -eq '2') 'every other line is kept and every reopened line is gone'
  Check ((Q "SELECT count(*) FROM information_schema.columns WHERE table_name='user_document_trail' AND column_name='idea_id'") -eq '0') 'idea_id is gone'
  $rev = Dump; Save 'dump-after-revert.sql' $rev
  Check ($rev -eq $pre) 'the schema dump after the revert is BYTE-IDENTICAL to the pre-690 dump (pg_dump 16 \restrict lines dropped)'
  Check ((Q $catSql) -eq $preCat) 'ACL, policy, triggers and sequence ACL after the revert are the pre-690 catalog'
  Check ((Q "SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_user_document_trail_no_delete'") -eq 'O') 'the no-delete trigger is enabled again after the revert'
  $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -c "DELETE FROM public.user_document_trail"
  Check ($script:rc -ne 0 -and $o -match 'append-only') 'and it still refuses a DELETE'
  $r = PsqlFile $fRev
  Check ($r.rc -eq 0 -and (Dump) -eq $pre) 'the revert twice: exit 0, still identical'
  $r = PsqlFile $f690
  Check ($r.rc -eq 0 -and (Dump) -eq $post1) '690 applied again after the revert: identical to the first run'

  Write-Host '[7] the shipped chain (690 included) on a fresh volume'
  $null = Dk rm -f $db
  Copy-Item $f690 (Join-Path $stage '690-init-idea-reopen-trail.sql')
  $o = Dk run -d --name $db --label $label --network none -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=openbrain -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
  for ($i = 0; $i -lt 150; $i++) { $logs = Dk logs $db; if ($logs -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  Check ($logs -match 'PostgreSQL init process complete' -and @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' }).Count -eq 0) 'the chain with 690 ran with no ERROR'
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  Check ((Dump) -eq $post1) 'the fresh-volume schema equals the live-way schema'
  Check ((RunCheck) -match 'check: OK') 'check-idea-reopen-trail.sql is OK on the fresh volume'
} catch { Fail "lab error: $_" }
finally {
  Write-Host '[8] teardown'
  $null = Dk rm -f $db
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  $left = Dk ps -a --filter "label=$label" --format '{{.Names}}'
  Check ($left.Trim() -eq '') 'nothing labelled for this run is left'
  $localAfter = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}') -split "`n" | Sort-Object
  Check (($localBefore -join '|') -eq ($localAfter -join '|')) 'no :local image changed'
}
Write-Host "== done: $script:pass passed, $script:fail failure(s); evidence $Evidence"
exit ([int]($script:fail -ne 0))
