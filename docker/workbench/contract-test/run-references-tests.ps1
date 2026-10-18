# run-references-tests.ps1 - the disposable test run for research-workbench P2a (rw-p2a-refs):
# references as first-class records.
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-references-tests.ps1 [-Id <owner id>] [-Evidence <dir>]
#
# What it does, and ONLY this:
#   1. stages the REAL initdb chain from docker-compose.yml (every mounted init*.sql, P0's 230
#      slot and P2a's 240 slot), in compose order
#   2. creates ONE internal docker network; every container and the network are labelled
#      ai-stack.harness.owner=<Id>
#   3. builds the workbench as openbrain-workbench:wt-<id> (NEVER :local) with
#      --build-arg OB1_SHA=<OB1 HEAD>; the build runs the image test gate (offline tests)
#   4. database A: chain + fixtures.sql; runs P0's integration_test.ts and P2a's
#      references_integration_test.ts inside the :wt image as a NON-superuser member of
#      service_role (the production shape)
#   5. database B: chain + fixtures; the :wt workbench + a stub embedder; Dredd over every
#      example in generated/openapi.json (P2a's new operations included)
#   6. database C: chain + fixtures + 200 generated sources; a fixture vault of legacy notes
#      (references-vault/, plus a generated note citing the 200 sources):
#        a. the PRE-CHANGE workbench (built from -BaseSha, the P0 tip) answers note-refs and
#           export (txt) for every note: the pre-change capture
#        b. migrate-references.ts runs in the :wt image (the deploy step): exit 0, every note
#           migrated, before == after for every note
#        c. SQL: every legacy-note reference has provenance user and its pinned revision equal to
#           its source's current revision; none lacks a quote selector
#        d. the :wt workbench answers the same requests: the post-change capture; compared with
#           the pre-change one byte for byte (note-refs bodies, the References sections, the whole
#           export) - a difference FAILS
#        e. every one of the 200 sources gets a new revision; diffCheck over the 200-reference
#           note, over HTTP, 5 runs: each under 200 ms, all out of date, and the recorded network
#           log carries no chunk text
#        f. a vault whose one note the legacy reader listed differently (a duplicated frontmatter
#           id) is refused by the migration: exit 1, the note named, nothing written for it
#   7. the eleven-router smoke (scripts/checks/smoke-workbench-routers.ps1) against the
#      pre-change and the :wt workbench on database C: identical
#   8. tears down exactly what it created; verifies nothing labelled <Id> is left and no :local
#      image changed
# It never touches the live stack: no compose up/down, no ai-stack_* / open-brain_* network, no
# host port, no live database, no rm/rmi of anything it did not create.
# Exit code 0 = every check passed.
param(
  [string]$Id = 'wt-rw-p2a-refs',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Evidence = '',
  [switch]$KeepImages,
  # The OB1 commit P2a branched from (the P0 tip): the pre-change workbench is built from it.
  [string]$BaseSha = '29834e3',
  [switch]$SkipDredd
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$label = "ai-stack.harness.owner=$Id"
$ct = $PSScriptRoot                                  # .../workbench/contract-test
$wb = Split-Path -Parent $ct                         # .../OB1/docker/workbench
$dockerDir = Split-Path -Parent $wb                  # .../OB1/docker
$ob1 = Split-Path -Parent $dockerDir                 # .../OB1
$repo = Split-Path -Parent $ob1                      # the ai-stack checkout (for the smoke script)
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rwp2a-net-$rand"
$dbA = "rwp2a-dba-$rand"; $dbB = "rwp2a-dbb-$rand"; $dbC = "rwp2a-dbc-$rand"
$wbName = "rwp2a-wb-$rand"; $embName = "rwp2a-embed-$rand"; $baseName = "rwp2a-wbbase-$rand"; $postName = "rwp2a-wbpost-$rand"
$short = ($Id -replace '^wt-', '')
$tag = "openbrain-workbench:wt-$short"
$baseTag = "openbrain-workbench:wt-$short-base"
$dreddTag = "rw-dredd:wt-$short"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$key = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "rwp2a-evidence-$rand" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$Evidence = (Resolve-Path $Evidence).Path
$stage = Join-Path $env:TEMP "rwp2a-initdb-$rand"
$vaultPre = Join-Path $env:TEMP "rwp2a-vault-pre-$rand"
$vaultPost = Join-Path $env:TEMP "rwp2a-vault-post-$rand"
$vaultBad = Join-Path $env:TEMP "rwp2a-vault-bad-$rand"
$sentinel = 'zq-p2a-chunk-text-sentinel'
$twoHundred = 'notes/p2a-vault/two-hundred.md'

$script:fail = 0
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }
function Save([string]$name, [string]$text) {
  [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false))
}
function Psql([string]$db, [string]$sql) {
  # base64 through the shell: PowerShell 5.1 strips embedded double quotes from native arguments
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sql))
  return Dk exec $db sh -c "echo $b64 | base64 -d | psql -U postgres -d openbrain -X -q -At -v ON_ERROR_STOP=1"
}
# Copy a fixture vault, LF line endings (as the workbench writes notes), into a temp dir.
function Stage-Vault([string]$from, [string]$to) {
  New-Item -ItemType Directory -Force $to | Out-Null
  Get-ChildItem -Recurse -File $from | ForEach-Object {
    $rel = $_.FullName.Substring($from.Length).TrimStart('\', '/')
    $dest = Join-Path $to $rel
    New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
    $text = [System.IO.File]::ReadAllText($_.FullName) -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText($dest, $text, (New-Object System.Text.UTF8Encoding $false))
  }
}
function Wait-Health([string]$name) {
  for ($i = 0; $i -lt 60; $i++) {
    $null = Dk exec $name deno eval "const r=await fetch('http://localhost:8000/health');Deno.exit(r.ok?0:1)"
    if ($script:rc -eq 0) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}
function Start-Workbench([string]$name, [string]$image, [string]$db, [string]$vault) {
  $o = Dk run -d --name $name --label $label --network $net -e PORT=8000 -e "WORKBENCH_KEY=$key" `
    -e "DB_HOST=$db" -e DB_USER=ob_app_memory -e "DB_PASSWORD=$appPw" -e OPEN_BRAIN_URL=http://unreachable.invalid `
    -e "EMBEDDING_API_BASE=http://${embName}:8080/v1" -e WIKI_GIT_DIR=/wiki -e WIKI_ASSETS_DIR=/wiki/assets `
    -e CONTRACT_MOUNTS_ROOT=/mounts -v "${vault}:/wiki" -v "$(Join-Path $ob1 'recipes'):/recipes:ro" $image
  if ($script:rc -ne 0) { Fail "workbench $name did not start: $o"; return $false }
  $script:made.containers += $name
  return (Wait-Health $name)
}
# Run references-client.ts in a throwaway container on the run network (contract-test and the
# evidence dir mounted).
function Client([string[]]$argv, [string[]]$envs = @()) {
  $e = @(); foreach ($x in $envs) { $e += @('-e', $x) }
  return Dk run --rm --label $label --network $net -e "WB_KEY=$key" @e -v "${ct}:/ct:ro" -v "${Evidence}:/ev" $tag `
    deno run --allow-net --allow-env --allow-read --allow-write=/ev /ct/references-client.ts @argv
}

if ($tag -match ':local$' -or $dreddTag -match ':local$' -or $baseTag -match ':local$') { throw 'refusing to build a :local tag' }

Write-Host "== rw-p2a-refs test run  owner=$Id  net=$net  evidence=$Evidence"
$null = Dk version --format '{{.Server.Version}}'
if ($script:rc -ne 0) { Write-Host 'docker is not reachable'; exit 2 }
function LocalSnapshot { (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim() -split "`r?`n" | Sort-Object }
$localBefore = LocalSnapshot
$made = @{ net = $false; containers = @(); images = @() }

function Start-Db([string]$name) {
  $o = Dk run -d --name $name --label $label --network $net -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=openbrain `
    -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
  if ($script:rc -ne 0) { Fail "postgres $name did not start: $o"; return $false }
  $script:made.containers += $name
  for ($i = 0; $i -lt 150; $i++) {
    $logs = Dk logs $name
    if ($logs -match 'PostgreSQL init process complete') { break }
    if ((Dk inspect -f '{{.State.Running}}' $name) -ne 'true') { break }
    Start-Sleep -Seconds 2
  }
  $logs = Dk logs $name
  Save "$name-initdb.log" $logs
  Check ($logs -match 'PostgreSQL init process complete') "$name ran the initdb chain to completion"
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "$name initdb logged no ERROR ($($errs.Count))"
  for ($i = 0; $i -lt 60; $i++) {
    $null = Dk exec $name pg_isready -h 127.0.0.1 -U postgres -d openbrain
    if ($script:rc -eq 0) { break }
    Start-Sleep -Seconds 2
  }
  $o = Dk exec $name psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) "$name has ob_app_memory (non-superuser, service_role member)"
  $null = Dk cp (Join-Path $ct 'fixtures.sql') "${name}:/tmp/fixtures.sql"
  $o = Dk exec $name psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/fixtures.sql
  Save "$name-fixtures.log" $o
  Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) "$name fixtures applied"
  return $true
}
function TestSummary([string]$o) {
  return ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match(($o -replace '\x1b\[[0-9;]*m', ''))
}

try {
  # ---------------------------------------------------------------- 1. the initdb chain
  Write-Host '[1] the initdb chain, derived from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check ($chain.Count -ge 31) "staged $($chain.Count) migrations"
  Check (@($chain | Where-Object { $_[1] -eq '230-init-research-contract.sql' }).Count -eq 1) 'the chain mounts 230-init-research-contract.sql'
  Check (@($chain | Where-Object { $_[1] -eq '240-init-references.sql' }).Count -eq 1) 'the chain mounts 240-init-references.sql'
  $null = Dk image inspect $PgImage
  if ($script:rc -ne 0) { Fail "$PgImage is not on the host (pull it, or pass -PgImage)"; throw 'pg image' }

  # ---------------------------------------------------------------- 2. network
  Write-Host '[2] disposable internal network'
  $null = Dk network create --internal --label $label $net
  Check ($script:rc -eq 0) "network $net created (internal, labelled)"
  if ($script:rc -ne 0) { throw 'network' }
  $made.net = $true

  # ---------------------------------------------------------------- 3. the :wt image
  Write-Host "[3] build $tag (the build runs the image test gate)"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  $dirty = (& git -C $ob1 status --porcelain -- docker/workbench docker/init-references.sql docker/docker-compose.yml | Out-String).Trim()
  if ($dirty) { Write-Host "  NOTE  the OB1 tree has uncommitted changes under test:`n$dirty" }
  $o = Dk build --build-arg "OB1_SHA=$sha" --label $label -t $tag $wb
  Save 'build.log' $o
  Check ($script:rc -eq 0) "image $tag built at OB1 $($sha.Substring(0, 7)) (test gate passed)"
  if ($script:rc -ne 0) { throw 'build' }
  $made.images += $tag
  $gate = TestSummary $o
  if ($gate.Success) { Pass "image test gate: $($gate.Value)" }

  # ---------------------------------------------------------------- 4. integration tests
  Write-Host '[4] database A + integration_test.ts (P0) + references_integration_test.ts (P2a), as ob_app_memory'
  if (-not (Start-Db $dbA)) { throw 'db A' }
  foreach ($f in @('integration_test.ts', 'references_integration_test.ts')) {
    $o = Dk run --rm --label $label --network $net -e "CONTRACT_TEST_DB_HOST=$dbA" -e CONTRACT_TEST_DB_USER=ob_app_memory `
      -e "CONTRACT_TEST_DB_PASSWORD=$appPw" $tag deno test --allow-net --allow-env --allow-read "src/contracts/$f"
    Save "$f.log" $o
    $sum = TestSummary $o
    Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[3].Value -eq '0') "${f}: $($sum.Value)"
    $timing = ([regex]'diffCheck\(200\) ms: [0-9., ]+').Match($o)
    if ($timing.Success) { Write-Host "        $($timing.Value)" }
  }

  # ---------------------------------------------------------------- 5. Dredd
  $o = Dk run -d --name $embName --label $label --network $net -v "${ct}:/ct:ro" $tag deno run --allow-net /ct/stub-embed.ts
  if ($script:rc -eq 0) { $made.containers += $embName }
  if (-not $SkipDredd) {
    Write-Host '[5] database B + the :wt workbench + Dredd over every example'
    if (-not (Start-Db $dbB)) { throw 'db B' }
    $vB = Join-Path $env:TEMP "rwp2a-vault-b-$rand"; New-Item -ItemType Directory -Force $vB | Out-Null
    Check (Start-Workbench $wbName $tag $dbB $vB) "workbench $wbName answers /health"
    $null = Dk image inspect $dreddTag
    if ($script:rc -ne 0) {
      $o = Dk build --label $label -t $dreddTag -f (Join-Path $ct 'dredd.Dockerfile') $ct
      Save 'dredd-build.log' $o
      Check ($script:rc -eq 0) "built $dreddTag"
      $made.images += $dreddTag
    }
    $gen = Join-Path $wb 'src\contracts\generated'
    $o = Dk run --rm --label $label --network $net -v "${gen}:/spec:ro" -v "${ct}:/ct:ro" $dreddTag `
      /spec/openapi.json "http://${wbName}:8000" --header "X-Brain-Key: $key" --hookfiles=/ct/dredd-hooks.js
    Save 'dredd.log' ($o -replace $key, '***')
    $clean = $o -replace '\x1b\[[0-9;]*m', ''
    $dm = ([regex]'complete: (\d+) passing, (\d+) failing, (\d+) errors, (\d+) skipped, (\d+) total').Match($clean)
    $ops = 0
    $docJson = Get-Content -Raw (Join-Path $gen 'openapi.json') | ConvertFrom-Json
    foreach ($p in $docJson.paths.PSObject.Properties) { $ops += @($p.Value.PSObject.Properties).Count }
    Check ($dm.Success -and $dm.Groups[2].Value -eq '0' -and $dm.Groups[3].Value -eq '0' -and [int]$dm.Groups[1].Value -eq $ops) "Dredd: $($dm.Value) (operations in the document: $ops)"
    $null = Dk rm -f $wbName
    Remove-Item $vB -Recurse -Force -ErrorAction SilentlyContinue
  }

  # ---------------------------------------------------------------- 6. legacy notes: before, migrate, after
  Write-Host '[6] database C + the fixture vault: pre-change capture, migration, post-change capture, diffCheck'
  if (-not (Start-Db $dbC)) { throw 'db C' }
  # 200 sources at revision 2, three chunks each (chunk 1 carries the sentinel text)
  $gen200 = @"
INSERT INTO public.sources (id, url, title, content)
SELECT ('f3000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'https://example.org/p2a-200/' || n, 'Two hundred ' || n,
       'Opening ' || n || '. Quoted span ' || n || ' $sentinel. Tail.'
  FROM generate_series(1, 200) n;
INSERT INTO public.source_revisions (source_id, revision, content, title, edited_by)
SELECT ('f3000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, v, 'Opening ' || n || '. Quoted span ' || n || ' $sentinel. Tail.', 'Two hundred ' || n, 'fixture'
  FROM generate_series(1, 200) n CROSS JOIN generate_series(1, 2) v;
INSERT INTO public.source_chunks (source_id, idx, content)
SELECT ('f3000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, k,
       CASE k WHEN 0 THEN 'Opening ' || n || '.' WHEN 1 THEN 'Quoted span ' || n || ' $sentinel.' ELSE 'Tail.' END
  FROM generate_series(1, 200) n CROSS JOIN generate_series(0, 2) k;
SELECT count(*) FROM public.sources WHERE id::text LIKE 'f3000000-%';
"@
  $o = Psql $dbC $gen200
  Check (($script:rc -eq 0) -and ($o.Trim() -eq '200')) "200 generated sources at revision 2 ($($o.Trim()))"
  Stage-Vault (Join-Path $ct 'references-vault') $vaultPre
  $lines = @('---', 'title: Two hundred references', '---', '# Two hundred', '')
  for ($n = 1; $n -le 200; $n++) { $lines += ('Point {0} [[content/source/f3000000-0000-4000-8000-{1}|R{0}]].' -f $n, $n.ToString('000000000000')) }
  [System.IO.File]::WriteAllText((Join-Path $vaultPre ($twoHundred -replace '/', '\')), (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
  Copy-Item $vaultPre $vaultPost -Recurse
  $notes = @(Get-ChildItem -Recurse -File (Join-Path $vaultPre 'notes') | ForEach-Object {
      'notes/' + ($_.FullName.Substring((Join-Path $vaultPre 'notes').Length).TrimStart('\') -replace '\\', '/') }) | Sort-Object
  Save 'vault-notes.txt' ($notes -join "`n")
  Check ($notes.Count -ge 6) "fixture vault: $($notes.Count) legacy notes"
  $notesEnv = "NOTES=$($notes -join ',')"

  # a. the pre-change workbench, built from $BaseSha
  $baseSrc = Join-Path $env:TEMP "rwp2a-base-$rand"
  $baseZip = Join-Path $env:TEMP "rwp2a-base-$rand.zip"
  New-Item -ItemType Directory -Force $baseSrc | Out-Null
  & git -C $ob1 archive --format=zip -o $baseZip $BaseSha docker/workbench
  Expand-Archive -Path $baseZip -DestinationPath $baseSrc -Force
  $o = Dk build --label $label -t $baseTag (Join-Path $baseSrc 'docker\workbench')
  Save 'base-build.log' $o
  Check ($script:rc -eq 0) "pre-change workbench $baseTag built from OB1 $BaseSha"
  if ($script:rc -eq 0) { $made.images += $baseTag }
  Check (Start-Workbench $baseName $baseTag $dbC $vaultPre) "pre-change workbench $baseName answers /health"
  $o = Client @('capture', "http://${baseName}:8000", '/ev/capture-pre-change.json') @($notesEnv)
  Check ($script:rc -eq 0) "pre-change capture: $o"
  $preRows = Psql $dbC "SELECT count(*) FROM public.reference_holders WHERE holder_kind = 'legacy_note' AND holder_ref LIKE 'notes/p2a-vault/%'"
  Check ($preRows.Trim() -eq '0') "the pre-change workbench wrote no reference rows ($($preRows.Trim()))"

  # b. the migration, in the :wt image, against the post-change copy of the vault
  $o = Dk run --rm --label $label --network $net -e "DB_HOST=$dbC" -e DB_USER=ob_app_memory -e "DB_PASSWORD=$appPw" `
    -e WIKI_GIT_DIR=/wiki -v "${vaultPost}:/wiki" $tag deno run --allow-net --allow-env --allow-read src/contracts/migrate-references.ts
  $migRc = $script:rc
  Save 'migration-report.json' $o
  $rep = $null
  try { $rep = ($o.Substring($o.IndexOf('{'))) | ConvertFrom-Json } catch { }
  Check (($migRc -eq 0) -and $rep -ne $null) "migrate-references.ts exited $migRc with a report"
  if ($rep) {
    $t = $rep.totals
    Check (($t.refused -eq 0) -and ($t.migrated -eq $notes.Count)) "migration: $($t.migrated)/$($t.notes) notes migrated, $($t.refused) refused"
    Check ($t.references_before -eq $t.references_after) "migration: references before $($t.references_before) = after $($t.references_after) (created $($t.references_created), unresolved citations kept for numbering $($t.unresolved_citations))"
    $uneq = @($rep.notes | Where-Object { $_.before -and ($_.before.added -ne $_.after.added -or $_.before.cited -ne $_.after.cited) })
    Check ($uneq.Count -eq 0) "migration: per note, before == after ($($uneq.Count) differ)"
  }

  # c. what the migration stored
  $q = @"
SELECT count(*),
       count(*) FILTER (WHERE r.provenance <> 'user'),
       count(*) FILTER (WHERE r.pinned_revision <> COALESCE((SELECT max(sr.revision) FROM public.source_revisions sr WHERE sr.source_id = r.source_id), 1)),
       count(*) FILTER (WHERE NOT (r.selectors ? 'quote') OR length(r.selectors #>> '{quote,exact}') = 0
                          OR NOT (r.selectors -> 'quote' ? 'prefix') OR NOT (r.selectors -> 'quote' ? 'suffix')
                          OR NOT (r.selectors ? 'position')),
       count(*) FILTER (WHERE s.content_type = 'pdf' AND NOT (r.selectors ? 'pdf'))
  FROM public.reference_holders h JOIN public.reference_records r ON r.id = h.reference_id
  LEFT JOIN public.sources s ON s.id = r.source_id
 WHERE h.holder_kind = 'legacy_note' AND h.holder_ref LIKE 'notes/p2a-vault/%';
"@
  $o = (Psql $dbC $q).Trim()
  Save 'migration-rows.txt' "total|not user|pin <> current revision|without quote/prefix/suffix/position|pdf without page+quad`n$o"
  $c = $o -split '\|'
  Check (($c.Count -eq 5) -and ([int]$c[0] -gt 200) -and ($c[1] -eq '0') -and ($c[2] -eq '0') -and ($c[3] -eq '0') -and ($c[4] -eq '0')) `
    "stored references: $($c[0]); provenance not user: $($c[1]); pin <> current revision: $($c[2]); without a full quote/position: $($c[3]); pdf without page+quad: $($c[4])"

  # d. the post-change workbench answers the same requests
  Check (Start-Workbench $postName $tag $dbC $vaultPost) "post-change workbench $postName answers /health"
  $o = Client @('capture', "http://${postName}:8000", '/ev/capture-post-change.json') @($notesEnv)
  Check ($script:rc -eq 0) "post-change capture: $o"
  $o = Client @('compare', '/ev/capture-pre-change.json', '/ev/capture-post-change.json')
  Save 'compare-pre-post.log' $o
  Write-Host ($o -split "`n" | ForEach-Object { "        $_" } | Out-String).TrimEnd()
  Check ($script:rc -eq 0) 'note-refs, References sections and whole exports: pre-change == post-change for every note'

  # e. diffCheck over the 200-reference note, after every one of its sources moved to revision 3
  $o = Psql $dbC "INSERT INTO public.source_revisions (source_id, revision, content, title, edited_by) SELECT id, 3, content, title, 'fixture' FROM public.sources WHERE id::text LIKE 'f3000000-%'; SELECT count(*) FROM public.source_revisions WHERE revision = 3 AND source_id::text LIKE 'f3000000-%';"
  Check ($o.Trim() -eq '200') "every one of the 200 sources has a revision 3 ($($o.Trim()))"
  $o = Client @('diffcheck', "http://${postName}:8000", $twoHundred, '/ev/diffcheck-network-log.json') @('RUNS=5', 'EXPECT=200', "SENTINEL=$sentinel")
  Save 'diffcheck.log' $o
  Write-Host ($o -split "`n" | ForEach-Object { "        $_" } | Out-String).TrimEnd()
  Check ($script:rc -eq 0) 'diffCheck over 200 references: 5 runs, each < 200 ms, all out of date, no chunk text in the network log'
  $logText = [System.IO.File]::ReadAllText((Join-Path $Evidence 'diffcheck-network-log.json'))
  Check (-not $logText.Contains($sentinel) -and -not $logText.Contains('Quoted span')) 'the recorded network log carries no chunk text'

  # f. a note the legacy reader listed differently is refused
  Stage-Vault (Join-Path $ct 'references-vault-refused') $vaultBad
  $o = Dk run --rm --label $label --network $net -e "DB_HOST=$dbC" -e DB_USER=ob_app_memory -e "DB_PASSWORD=$appPw" `
    -e WIKI_GIT_DIR=/wiki -v "${vaultBad}:/wiki" $tag deno run --allow-net --allow-env --allow-read src/contracts/migrate-references.ts
  $badRc = $script:rc
  Save 'migration-refused-report.json' $o
  Check (($badRc -eq 1) -and ($o -match 'notes/bad/duplicate.md') -and ($o -match 'differ before and after')) "a note whose references would differ FAILS the migration (exit $badRc, named)"
  $o = (Psql $dbC "SELECT count(*) FROM public.reference_holders WHERE holder_ref = 'notes/bad/duplicate.md'").Trim()
  Check ($o -eq '0') "nothing was written for the refused note ($o rows)"

  # ---------------------------------------------------------------- 7. eleven-router smoke
  Write-Host '[7] the eleven-router smoke: pre-change vs :wt workbench on database C'
  $smoke = Join-Path $repo 'scripts\checks\smoke-workbench-routers.ps1'
  if (Test-Path $smoke) {
    $sa = Join-Path $Evidence 'smoke-pre-change'; $sb = Join-Path $Evidence 'smoke-post-change'
    $o1 = (& powershell -NoProfile -File $smoke -Capture $sa -ExecContainer $baseName -BaseUrl http://localhost:8000 -KeyEnv WORKBENCH_KEY 2>&1 | Out-String); $r1 = $LASTEXITCODE
    $o2 = (& powershell -NoProfile -File $smoke -Capture $sb -ExecContainer $postName -BaseUrl http://localhost:8000 -KeyEnv WORKBENCH_KEY 2>&1 | Out-String); $r2 = $LASTEXITCODE
    $o3 = (& powershell -NoProfile -File $smoke -Compare $sa $sb 2>&1 | Out-String); $r3 = $LASTEXITCODE
    Save 'smoke.log' ($o1 + $o2 + $o3)
    Check (($r1 -eq 0) -and ($r2 -eq 0) -and ($r3 -eq 0)) "eleven-router smoke: pre-change ($BaseSha) and post-change captures are identical"
  } else {
    Write-Host "  SKIP  $smoke not found (OB1 checked out alone)"
  }
  Remove-Item $baseSrc, $baseZip -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  Fail "aborted: $_"
} finally {
  Write-Host '[8] teardown'
  foreach ($c in $made.containers) { $null = Dk rm -f $c }
  if ($made.net) { $null = Dk network rm $net }
  if (-not $KeepImages) { foreach ($i in $made.images) { $null = Dk rmi $i } }
  Remove-Item $stage, $vaultPre, $vaultPost, $vaultBad -Recurse -Force -ErrorAction SilentlyContinue
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}' | Out-String).Trim()
  $leftNet = (Dk network ls --filter "label=$label" --format '{{.Name}}' | Out-String).Trim()
  Check (($left -eq '') -and ($leftNet -eq '')) "nothing labelled $Id is left (containers: '$left', networks: '$leftNet')"
  $localAfter = LocalSnapshot
  Check ((Compare-Object $localBefore $localAfter) -eq $null) 'no :local image changed'
}
Write-Host "evidence: $Evidence"
if ($script:fail) { Write-Host "$($script:fail) check(s) FAILED"; exit 1 }
Write-Host 'all checks passed'
exit 0
