# run-boundary-ideas-lab.ps1 - rw-boundary-ideas' disposable lab (plan 09 PD0b: an idea is researched only from a
# de-personalised question).
#
#   powershell -NoProfile -File OB1\integrations\research-service\run-boundary-ideas-lab.ps1 [-Id <owner id>] [-Evidence <dir>] [-Red <ob1 sha>]
#
# What it does, and ONLY this:
#   1. stages the REAL initdb chain from OB1/docker/docker-compose.yml, WITHOUT 580 (applied in [4], after the pre-580
#      hashes are taken: the drill's reference). -Red <sha>: the chain of that OB1 commit instead (git archive), and 580
#      is not applied - the RED run.
#   2. creates ONE internal bridge network on a documentation range (203.0.113.0/24, else 198.51.100.0/24; --internal):
#      the lab's pages resolve to an address the boundary judges public; every container and the network are labelled
#      ai-stack.harness.owner=<Id>
#   3. builds the research service's test stage as openbrain-research-test:wt-<id> (NEVER :local) - the build RUNS the
#      offline suite (boundary-ideas.test.ts and boundary-ideas-gate.test.ts among it)
#   4. one database (ob_app_memory created as production has it), 420 / 460 re-run for their grants, 580 applied (green),
#      the pages container, then boundary-ideas.e2e.test.ts in the test image (R1-db, coalescing, R-F4, the REAL index.ts
#      draining with a HOSTILE proposer, the owner's review, run privately, the delivery and THE SWEEP)
#   5. green only: the slot-580 drill by psql - revert, revert again, init, init again, revert, init - compared with the
#      pre-580 hashes (the six replaced functions byte-identical, the index, no job changed)
#   6. tears down exactly what it created; nothing labelled <Id> is left; no :local image changed
# Synthetic data only. It never touches the live stack: no compose up/down, no ai-stack_* / open-brain_* network, no host
# port, no live database, no LiteLLM (the gateway is a stub inside the test container). Exit code 0 = every check passed.
param(
  [string]$Id = 'wt-rw-boundary-ideas',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Evidence = '',
  [string]$Red = '',
  [switch]$KeepImage
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
if ($Red -and $Red -notmatch '^[0-9a-f]{7,40}$') { throw "bad -Red '$Red'" }
$label = "ai-stack.harness.owner=$Id"
$rs = $PSScriptRoot
$ob1 = Split-Path -Parent (Split-Path -Parent $rs)
$dockerDir = Join-Path $ob1 'docker'
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rwbi-net-$rand"
$db = "rwbi-db-$rand"
$short = ($Id -replace '^wt-', '')
$testTag = "openbrain-research-test:wt-$short"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "rwbi-evidence-$rand" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "rwbi-initdb-$rand"
$redDir = Join-Path $env:TEMP "rwbi-red-$rand"

$script:fail = 0
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false)) }
function Summary([string]$text) { return ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed(?: \| (\d+) ignored)?').Match(($text -replace '\x1b\[[0-9;]*m', '')) }
function Get-Chain([string]$dir) {
  $compose = (@(Get-Content (Join-Path $dir 'docker-compose.yml')) | ForEach-Object { $_ -replace '(^|\s)#.*$', '' }) -join "`n"
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  return , @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
}
if ($testTag -match ':local$') { throw 'refusing a :local tag' }

Write-Host "== rw-boundary-ideas disposable run  owner=$Id  net=$net  red=$(if ($Red) { $Red } else { 'no' })  evidence=$Evidence"
$null = Dk version --format '{{.Server.Version}}'
if ($script:rc -ne 0) { Write-Host 'docker is not reachable'; exit 2 }
function LocalSnapshot { (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim() -split "`r?`n" | Sort-Object }
$localBefore = LocalSnapshot
$made = @{ net = $false; containers = @(); images = @() }
function Psql([string]$file) { $o = Dk exec $db psql -v ON_ERROR_STOP=1 -U postgres -d openbrain -X -q -f $file; return $o }
function DState { $s = Dk exec $db psql -U postgres -d openbrain -X -q -f /tmp/bi-check.sql; return (($s -split "`n") | ForEach-Object { ($_ -replace '^.*NOTICE:\s+DRILL\s+', '').Trim() } | Where-Object { $_ -match '^[a-z_]+=' }) -join ' ' }
function DGet([string]$st, [string]$k) { $m = [regex]::Match($st, "(^| )$([regex]::Escape($k))=(\S+)"); if ($m.Success) { $m.Groups[2].Value } else { '' } }

try {
  Write-Host '[1] the initdb chain'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chainDir = $dockerDir
  if ($Red) {
    New-Item -ItemType Directory -Force $redDir | Out-Null
    $tar = Join-Path $redDir 'docker.tar'
    & git -C $ob1 archive --format=tar -o $tar $Red docker
    Check ($LASTEXITCODE -eq 0) "git archive $Red docker"
    & tar -xf $tar -C $redDir
    $chainDir = Join-Path $redDir 'docker'
  }
  $chain = @(Get-Chain $chainDir | Where-Object { $_[1] -ne '580-init-boundary-ideas.sql' })
  foreach ($m in $chain) { Copy-Item (Join-Path $chainDir $m[0]) (Join-Path $stage $m[1]) }
  Check ($chain.Count -ge 50) "staged $($chain.Count) migrations (580 held back)"
  if (-not $Red) { Check (@(Get-Chain $dockerDir | Where-Object { $_[1] -eq '580-init-boundary-ideas.sql' }).Count -eq 1) 'the compose chain mounts 580-init-boundary-ideas.sql' }

  Write-Host '[2] disposable internal network (a documentation range)'
  $sub = ''
  foreach ($s in @('203.0.113.0/24', '198.51.100.0/24')) {
    $null = Dk network create --driver bridge --internal --subnet $s --label $label $net
    if ($script:rc -eq 0) { $sub = $s; break }
  }
  Check ($sub -ne '') "network $net created (internal, --subnet $sub)"
  if ($sub -eq '') { throw 'network' }
  $made.net = $true

  Write-Host "[3] build $testTag (the build runs the offline suite)"
  $o = Dk build --no-cache --progress=plain --target test --label $label -t $testTag $rs
  Save 'research-test-build.log' $o
  Check ($script:rc -eq 0) "image $testTag built"
  if ($script:rc -eq 0) { $made.images += $testTag } else { throw 'build' }
  $sum = Summary $o
  Check ($sum.Success -and $sum.Groups[1].Value -eq 'ok' -and [int]$sum.Groups[3].Value -eq 0) "the build ran the offline suite: $($sum.Value)"
  $clean = $o -replace '\x1b\[[0-9;]*m', ''
  foreach ($t in @('R-F1: an unreachable link', 'ownerGate (D7)', 'drain, HOSTILE proposer, a public link', 'approve (D7)')) {
    Check ($clean -match ([regex]::Escape($t) + '[^\n]*\.\.\. ok')) "the build ran: $t"
  }

  Write-Host '[4] the database, 580, and boundary-ideas.e2e.test.ts'
  $o = Dk run -d --name $db --label $label --network $net -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=openbrain -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
  if ($script:rc -ne 0) { Fail "postgres did not start: $o"; throw 'db' }
  $made.containers += $db
  for ($i = 0; $i -lt 150; $i++) { $logs = Dk logs $db; if ($logs -match 'PostgreSQL init process complete') { break }; if ((Dk inspect -f '{{.State.Running}}' $db) -ne 'true') { break }; Start-Sleep -Seconds 2 }
  $logs = Dk logs $db
  Save 'initdb.log' $logs
  Check ($logs -match 'PostgreSQL init process complete') 'the initdb chain ran to completion'
  Check (@(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' }).Count -eq 0) 'initdb logged no ERROR'
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN CREATE ROLE ob_app_memory LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE service_role; END IF; END `$`$; ALTER ROLE ob_app_memory LOGIN PASSWORD '$appPw'"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role) - the production shape'
  $null = Dk cp (Join-Path $rs 'fixtures\boundary-ideas-drill-check.sql') "${db}:/tmp/bi-check.sql"
  foreach ($f in @('init-request-boundary.sql', 'init-boundary-digest.sql')) {
    $null = Dk cp (Join-Path $chainDir $f) "${db}:/tmp/$f"
    $o = Psql "/tmp/$f"
    Check ($script:rc -eq 0) "$f re-run after ob_app_memory exists (its grants)$(if ($script:rc) { ': ' + $o })"
  }
  $pre = ''
  if (-not $Red) {
    $pre = DState
    Save 'drill-pre580.txt' $pre
    $null = Dk cp (Join-Path $dockerDir 'init-boundary-ideas.sql') "${db}:/tmp/bi-init.sql"
    $null = Dk cp (Join-Path $dockerDir 'revert-boundary-ideas.sql') "${db}:/tmp/bi-revert.sql"
    $o = Psql '/tmp/bi-init.sql'
    Check ($script:rc -eq 0) "580 applied$(if ($script:rc) { ': ' + $o })"
    $s580 = DState
    Check ((DGet $s580 'own') -eq '8' -and (DGet $s580 'trg') -eq '1' -and (DGet $s580 'idx_idea') -eq '1' -and (DGet $s580 'fns') -ne (DGet $pre 'fns') -and (DGet $s580 'saved') -eq '7') "580 in place: 8 functions, the binding trigger, the keyed index, the six replaced (saved: $(DGet $s580 'saved'))"
  }
  $pages = "rwbi-pages-$rand"
  $o = Dk run -d --name $pages --label $label --network $net --network-alias news.example.org --network-alias blog.example.org -e PORT=8080 `
    $testTag deno run --allow-net --allow-env --allow-read fixtures/boundary-lab-pages.ts
  if ($script:rc -eq 0) { $made.containers += $pages } else { Fail "the pages container did not start: $o" }
  $redEnv = if ($Red) { '1' } else { '0' }
  $o = Dk run --rm --label $label --network $net `
    -e "BND_E2E_DB_HOST=$db" -e BND_E2E_PAGES_PORT=8080 -e "BND_E2E_DB_PASSWORD=$pw" -e "BND_E2E_APP_PASSWORD=$appPw" -e "BND_IDEAS_RED=$redEnv" -e NO_COLOR=1 `
    $testTag deno test --unstable-net --allow-net --allow-env --allow-read --allow-run boundary-ideas.e2e.test.ts
  $o = $o -replace [regex]::Escape($pw), '***' -replace [regex]::Escape($appPw), '***'
  Save 'boundary-ideas-e2e.log' $o
  foreach ($l in ($o -split "`n") | Where-Object { $_ -match '\.\.\. (ok|FAILED|ignored)|^(R1-db|coalescing|R-F4|drain|A:|P:|L:|derived|sweep|idea ids|egress)' }) { Write-Host "    $l" }
  $sum = Summary $o
  if ($Red) {
    Check (($script:rc -eq 0) -and $sum.Success -and [int]$sum.Groups[2].Value -ge 1 -and $o -match 'R1-db sweep: .*shared hits: (?!none)') "RED: R1-db reproduced the leak on $Red (shared hits on the pre-580 chain): $($sum.Value)"
  } else {
    Check (($script:rc -eq 0) -and $sum.Success -and $sum.Groups[3].Value -eq '0' -and [int]$sum.Groups[2].Value -ge 5) "boundary-ideas e2e: $($sum.Value)"
  }

  if (-not $Red) {
    Write-Host '[5] slot-580 drill: revert, revert again, init, init again, revert, init'
    $s0 = DState
    $states = @{}; $notes = @{}
    foreach ($step in @(@('revert', '/tmp/bi-revert.sql'), @('revert again', '/tmp/bi-revert.sql'), @('init', '/tmp/bi-init.sql'), @('init again', '/tmp/bi-init.sql'), @('revert 2', '/tmp/bi-revert.sql'), @('init 2', '/tmp/bi-init.sql'))) {
      $o = Psql $step[1]
      $rc = $script:rc
      $notes[$step[0]] = (($o -split "`n") | Where-Object { $_ -match 'rw-boundary-ideas|ERROR' } | ForEach-Object { ($_ -replace '^.*NOTICE:\s+', '').Trim() }) -join ' ; '
      $states[$step[0]] = DState
      Check ($rc -eq 0) "drill: $($step[0]) runs cleanly"
    }
    Save 'migration-drill.txt' ((@("[pre-580] $pre", "[after the e2e] $s0") + ($states.Keys | Sort-Object | ForEach-Object { "[$_] $($notes[$_])`n    $($states[$_])" })) -join "`n")
    $r1 = $states['revert']; $r1b = $states['revert again']; $i1 = $states['init']; $i2 = $states['init again']; $r2 = $states['revert 2']; $i3 = $states['init 2']
    Check ([int](DGet $s0 'idea_handbacks') -ge 4 -and [int](DGet $s0 'open') -ge 1) "drill: the e2e left idea hand-backs ($(DGet $s0 'idea_handbacks'), open $(DGet $s0 'open'))"
    Check ($notes['revert'] -match 'archived (\d+) idea hand-back row\(s\), closed (\d+) open' -and [int]$Matches[1] -eq [int](DGet $s0 'idea_handbacks')) "drill: revert ARCHIVES FIRST every idea hand-back ($($notes['revert']))"
    Check ((DGet $r1 'fns') -eq (DGet $pre 'fns') -and (DGet $r1 'idx') -eq (DGet $pre 'idx')) 'drill: revert restores the six functions and the index BYTE-IDENTICAL to before 580'
    Check ((DGet $r1 'own') -eq '0' -and (DGet $r1 'trg') -eq '0' -and (DGet $r1 'idx_idea') -eq '0' -and (DGet $r1 'saved') -eq '-1' -and (DGet $r1 'open') -eq '0') 'drill: revert drops 580''s functions, the trigger, the keyed index and the saved copy; no idea hand-back stays open'
    Check ((DGet $r1 'jobs') -eq (DGet $s0 'jobs') -and (DGet $r1 'revisions') -eq (DGet $s0 'revisions')) 'drill: revert changes no job and no revision'
    Check ((DGet $r1b 'fns') -eq (DGet $r1 'fns') -and (DGet $r1b 'archive') -eq (DGet $r1 'archive') -and $notes['revert again'] -match 'archived 0 idea hand-back row\(s\), closed 0') 'drill: a second revert archives nothing and changes nothing'
    Check ((DGet $i1 'fns') -eq (DGet $s0 'fns') -and (DGet $i1 'own') -eq '8' -and (DGet $i1 'idx') -eq (DGet $s0 'idx') -and (DGet $i1 'saved') -eq '7') 'drill: init puts 580 back exactly (functions, trigger, index; the copies saved again)'
    Check ((DGet $i2 'fns') -eq (DGet $i1 'fns') -and (DGet $i2 'idx') -eq (DGet $i1 'idx') -and (DGet $i2 'jobs') -eq (DGet $i1 'jobs')) 'drill: a second init changes nothing'
    Check ((DGet $r2 'fns') -eq (DGet $pre 'fns') -and (DGet $r2 'idx') -eq (DGet $pre 'idx') -and (DGet $i3 'fns') -eq (DGet $s0 'fns')) 'drill: the second round restores and re-applies identically'
  }

  Write-Host '[6] static: who names research_handbacks (420''s allow-list, extended by this item)'
  $names = @(Get-ChildItem -Path $ob1 -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|archive)\\' -and $_.Length -lt 5MB } |
    Where-Object { Select-String -Path $_.FullName -Pattern 'research_handbacks|handback_(open|pending|claim|deliverables|delivered|owned|deliver)' -Quiet } |
    ForEach-Object { $_.FullName.Substring($ob1.Length + 1).Replace('\', '/') })
  $listed = [System.IO.File]::ReadAllText((Join-Path $rs 'run-boundary-e2e.ps1'))
  $stray = @($names | Where-Object { $listed -notmatch [regex]::Escape("'$_'") -and $_ -notmatch '^docker/(init|revert)-inlet-stamp\.sql$' })
  Save 'handback-readers.txt' (($names | Sort-Object) -join "`n")
  Check ($stray.Count -eq 0) "every file naming the hand-back is on 420's allow-list ($($names.Count) files; outside: $($stray -join ', '))"
}
finally {
  Write-Host '[7] teardown'
  foreach ($c in $made.containers) { $null = Dk rm -f -v $c }
  if ($made.net) { $null = Dk network rm $net }
  if (-not $KeepImage) { foreach ($i in $made.images) { $null = Dk rmi -f $i } }
  Remove-Item -Recurse -Force $stage, $redDir -ErrorAction SilentlyContinue
  $left = @((Dk ps -a --filter "label=$label" --format '{{.Names}}') -split "`n" | Where-Object { $_ })
  Check ($left.Count -eq 0) "no container labelled $label is left ($($left.Count))"
  $leftNet = @((Dk network ls --filter "label=$label" --format '{{.Name}}') -split "`n" | Where-Object { $_ })
  Check ($leftNet.Count -eq 0) "no network labelled $label is left ($($leftNet.Count))"
  if (-not $KeepImage) {
    $leftImg = @((Dk images --filter "label=$label" --format '{{.Repository}}:{{.Tag}}') -split "`n" | Where-Object { $_ -and $_ -notmatch '<none>' })
    Check ($leftImg.Count -eq 0) "no image labelled $label is left ($($leftImg -join ', '))"
  }
  Check (-not (Compare-Object $localBefore (LocalSnapshot))) 'no :local image changed'
  Write-Host "== $(if ($script:fail) { "FAILED ($script:fail)" } else { 'ALL PASSED' })  evidence: $Evidence"
}
exit $script:fail
