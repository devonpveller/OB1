# run-export-tests.ps1 - the disposable test run for research-workbench P6a (rw-p6a-resolve):
# the resolver, pandoc citeproc with a CSL style chosen from the registry, Typst PDFs.
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-export-tests.ps1 [-Id <owner id>] [-Evidence <dir>]
#
# What it does, and ONLY this:
#   1. stages the REAL initdb chain from docker-compose.yml (every mounted init*.sql, P6a's 250 slot)
#   2. creates ONE internal docker network on a pinned subnet outside 192.168.0.0/16; every container
#      and the network are labelled ai-stack.harness.owner=<Id>
#   3. builds the workbench three ways, never :local: the runtime image (its build runs the test
#      gate), the test stage and the parity stage; checks the runtime image carries no WeasyPrint
#      and no poppler, and that it is built from the pinned pandoc and Typst
#   4. the parity fixture in the parity image, --network none (acceptance 6)
#   5. a disposable database (chain + export-fixtures.sql), the STUB OpenAlex/Crossref/proxy
#      (stub-scholarly.ts; the workbench reaches it only through FETCH_PROXY_URL, the .stub names
#      resolve nowhere), and the :wt workbench with a test key and mailto:
#        a. acceptance 1: the 100-reference note exported to PDF, DOCX and MD, numbered 1..100, every
#           title the resolved one; the resolutions cached on the reference records at their pins
#        b. acceptance 3: every request the stub saw carried the key (OpenAlex) / the mailto
#           (Crossref); RED: a request without them, sent through the same proxy, fails the checker
#        c. acceptance 2: the dead-DOI note is refused (422) naming the reference; RED: the
#           pre-change workbench (OB1 -BaseSha) exports the same note with the dead reference as text
#        d. determinism offline: the stub answers 503 to everything; the 100-reference note exports
#           again byte-identical (MD) without one request
#        e. styles from the registry (apa, an unknown style), the about text (acceptance 7), the
#           CJK note's PDF (acceptance 4) and, RED, the same export with the CJK fonts hidden FAILS
#        f. shipped inert / fail-closed / one service: a workbench with no key and no mailto, one with
#           no proxy, one with the key but no mailto - each refuses what it cannot resolve, naming
#           it, and the stub sees no request from it
#   6. tears down exactly what it created (containers with -v, their volumes recorded first);
#      verifies nothing labelled <Id> is left, no volume of ours is left, no :local image changed
# It never touches the live stack: no compose up/down, no ai-stack_* / open-brain_* network, no
# host port, no live database, the real APIs never, the live proxy never.
# Exit code 0 = every check passed.
param(
  [string]$Id = 'wt-rw-p6a-resolve',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$Evidence = '',
  [switch]$KeepImages,
  # The pre-change workbench (the RED of acceptance 2) is built from this OB1 commit: P2a's
  # integration merge, the base P6a was cut from.
  [string]$BaseSha = '0741b36'
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$label = "ai-stack.harness.owner=$Id"
$ct = $PSScriptRoot
$wb = Split-Path -Parent $ct
$dockerDir = Split-Path -Parent $wb
$ob1 = Split-Path -Parent $dockerDir
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$octet = Get-Random -Minimum 16 -Maximum 250
$subnet = "10.231.$octet.0/24"
$net = "rwp6a-net-$rand"
$dbName = "rwp6a-db-$rand"; $stubName = "rwp6a-stub-$rand"; $wbName = "rwp6a-wb-$rand"; $baseName = "rwp6a-wbbase-$rand"
$short = ($Id -replace '^wt-', '')
$tag = "openbrain-workbench:wt-$short"
$testTag = "openbrain-workbench:wt-$short-test"
$parityTag = "openbrain-workbench:wt-$short-parity"
$baseTag = "openbrain-workbench:wt-$short-base"
$pw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$appPw = -join ((48..57 + 97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
$key = -join ((48..57 + 97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$oaKey = "p6a-test-key-$rand"
$mailto = "p6a-$rand@example.invalid"
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "rwp6a-evidence-$rand" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$Evidence = (Resolve-Path $Evidence).Path
$out = Join-Path $Evidence 'exports'; New-Item -ItemType Directory -Force $out | Out-Null
$stage = Join-Path $env:TEMP "rwp6a-initdb-$rand"
$vault = Join-Path $env:TEMP "rwp6a-vault-$rand"
$noFonts = Join-Path $env:TEMP "rwp6a-nofonts-$rand"

$script:fail = 0
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Dk { $o = (& docker @args 2>&1 | ForEach-Object { "$_" }) -join "`n"; $script:rc = $LASTEXITCODE; return $o }
function Save([string]$name, [string]$text) {
  [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false))
}
function Psql([string]$sql) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sql))
  return Dk exec $dbName sh -c "echo $b64 | base64 -d | psql -U postgres -d openbrain -X -q -At -v ON_ERROR_STOP=1"
}
function TestSummary([string]$o) { return ([regex]'(ok|FAILED) \| (\d+) passed \| (\d+) failed').Match(($o -replace '\x1b\[[0-9;]*m', '')) }
function Wait-Health([string]$name) {
  for ($i = 0; $i -lt 60; $i++) {
    $null = Dk exec $name deno eval "const r=await fetch('http://localhost:8000/health');Deno.exit(r.ok?0:1)"
    if ($script:rc -eq 0) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}
# A workbench on the run network. $resolverEnv: the resolver's env (key, mailto, proxy, stub bases).
function Start-Workbench([string]$name, [string]$image, [string[]]$resolverEnv, [string[]]$extra = @()) {
  $e = @(); foreach ($x in $resolverEnv) { $e += @('-e', $x) }
  $o = Dk run -d --name $name --label $label --network $net -e PORT=8000 -e "WORKBENCH_KEY=$key" `
    -e "DB_HOST=$dbName" -e DB_USER=ob_app_memory -e "DB_PASSWORD=$appPw" -e OPEN_BRAIN_URL=http://unreachable.invalid `
    -e EMBEDDING_API_BASE=http://unreachable.invalid/v1 -e WIKI_GIT_DIR=/wiki -e WIKI_ASSETS_DIR=/wiki/assets `
    -e CONTRACT_MOUNTS_ROOT=/mounts @e @extra -v "${vault}:/wiki" -v "$(Join-Path $ob1 'recipes'):/recipes:ro" $image
  if ($script:rc -ne 0) { Fail "workbench $name did not start: $o"; return $false }
  $script:made.containers += $name
  return (Wait-Health $name)
}
# export-client.ts in a throwaway TEST-image container on the run network; $Evidence mounted at /ev.
function Client([string[]]$argv) {
  return Dk run --rm --label $label --network $net -e "WB_KEY=$key" -v "${ct}:/ct:ro" -v "${Evidence}:/ev" --entrypoint deno $testTag `
    run --allow-net --allow-env --allow-read --allow-write --allow-run /ct/export-client.ts @argv
}
function Export([string]$wbHost, [string]$notePath, [string]$format, [string]$file, [string]$extraQuery = '') {
  $q = [uri]::EscapeDataString($notePath)
  return Client @('get', "http://${wbHost}:8000/workbench/export?path=$q&format=$format$extraQuery", "/ev/exports/$file")
}
function StubLog([string]$file) {
  $null = Client @('get', "http://${stubName}:8080/_log", "/ev/$file")
  return @(Get-Content -Raw (Join-Path $Evidence $file) | ConvertFrom-Json)
}
function StubPost([string]$path) {
  return Dk run --rm --label $label --network $net --entrypoint deno $testTag eval "await fetch('http://${stubName}:8080$path',{method:'POST'}).then(r=>r.text()).then(console.log)"
}
$onEnv = @("OPENALEX_API_KEY=$oaKey", "CROSSREF_MAILTO=$mailto", "FETCH_PROXY_URL=http://${stubName}:8080",
  'RESOLVER_OPENALEX_BASE=http://api.openalex.stub', 'RESOLVER_CROSSREF_BASE=http://api.crossref.stub', 'RESOLVER_TIMEOUT_MS=5000')

foreach ($t in @($tag, $testTag, $parityTag, $baseTag)) { if ($t -match ':local$') { throw 'refusing to build a :local tag' } }

Write-Host "== rw-p6a-resolve test run  owner=$Id  net=$net ($subnet)  evidence=$Evidence"
$null = Dk version --format '{{.Server.Version}}'
if ($script:rc -ne 0) { Write-Host 'docker is not reachable'; exit 2 }
function LocalSnapshot { (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim() -split "`r?`n" | Sort-Object }
$localBefore = LocalSnapshot
function DanglingVolumes { @((Dk volume ls -q --filter dangling=true | Out-String).Trim() -split "`r?`n" | Where-Object { $_ }) }
$volBefore = DanglingVolumes
$made = @{ net = $false; containers = @(); images = @() }

try {
  # ---------------------------------------------------------------- 1. the initdb chain
  Write-Host '[1] the initdb chain, derived from docker-compose.yml'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  New-Item -ItemType Directory -Force $stage | Out-Null
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check ($chain.Count -ge 32) "staged $($chain.Count) migrations"
  Check (@($chain | Where-Object { $_[1] -eq '250-init-export.sql' }).Count -eq 1) 'the chain mounts 250-init-export.sql'
  $null = Dk image inspect $PgImage
  if ($script:rc -ne 0) { Fail "$PgImage is not on the host (pull it, or pass -PgImage)"; throw 'pg image' }

  # ---------------------------------------------------------------- 2. network
  Write-Host '[2] disposable internal network'
  $null = Dk network create --internal --subnet $subnet --label $label $net
  Check ($script:rc -eq 0) "network $net created (internal, $subnet, labelled)"
  if ($script:rc -ne 0) { throw 'network' }
  $made.net = $true

  # ---------------------------------------------------------------- 3. images
  Write-Host "[3] build $tag, $testTag, $parityTag"
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  $dirty = (& git -C $ob1 status --porcelain -- docker/workbench docker/init-export.sql docker/docker-compose.yml | Out-String).Trim()
  if ($dirty) { Write-Host "  NOTE  the OB1 tree has uncommitted changes under test:`n$dirty" }
  $o = Dk build --build-arg "OB1_SHA=$sha" --label $label -t $tag $wb
  Save 'build.log' $o
  Check ($script:rc -eq 0) "image $tag built at OB1 $($sha.Substring(0, 7)) (test gate passed)"
  if ($script:rc -ne 0) { throw 'build' }
  $made.images += $tag
  $gate = TestSummary $o
  $gateHow = 'from the build log'
  if (-not $gate.Success) { $gateHow = 'build layer cached; the test stage is re-run below' }
  foreach ($pair in @(@('test', $testTag), @('parity', $parityTag))) {
    $o = Dk build --build-arg "OB1_SHA=$sha" --label $label --target $pair[0] -t $pair[1] $wb
    Save "build-$($pair[0]).log" $o
    Check ($script:rc -eq 0) "image $($pair[1]) built (target $($pair[0]))"
    if ($script:rc -ne 0) { throw 'build' }
    $made.images += $pair[1]
  }
  if (-not $gate.Success) {
    $o = Dk run --rm --label $label --network none --entrypoint deno $testTag test --allow-net --allow-env --allow-read --allow-write --allow-run `
      src/routes/search_test.ts src/routes/graph_test.ts src/util/ src/contracts/ src/export/
    Save 'image-gate.log' $o
    $gate = TestSummary $o
  }
  Check ($gate.Success -and $gate.Groups[3].Value -eq '0') "image test gate: $($gate.Value) ($gateHow)"
  # the export's own suites, re-run with their output kept (the gate's log may be a cached layer):
  # the real-program renders (numbering, styles, CJK glyphs with the tofu RED, the process tree)
  $o = Dk run --rm --label $label --network none --entrypoint deno $testTag test --allow-net --allow-env --allow-read --allow-write --allow-run `
    src/export/export_test.ts src/export/render_test.ts
  Save 'export-suites.log' ($o -replace '\x1b\[[0-9;]*m', '')
  $es = TestSummary $o
  Check ($es.Success -and $es.Groups[3].Value -eq '0') "export suites (export_test.ts + render_test.ts) in the test image: $($es.Value)"
  $cjk = ([regex]'cjk: fonts [^\r\n]+').Match(($o -replace '\x1b\[[0-9;]*m', ''))
  if ($cjk.Success) { Write-Host "        $($cjk.Value)" }
  $o = Dk run --rm --label $label --network none --entrypoint deno $testTag task contract:check
  Save 'contract-check.log' $o
  Check (($script:rc -eq 0) -and ($o -match 'contract artifacts are current')) 'deno task contract:check: contract artifacts are current'
  # what left the runtime image (take what we need, remove what is no longer needed)
  $o = Dk run --rm --label $label --network none --entrypoint sh $tag -c 'dpkg -s weasyprint >/dev/null 2>&1 && echo weasyprint-present; command -v weasyprint pdftoppm pdftotext || true; dpkg -s poppler-utils >/dev/null 2>&1 && echo poppler-present; pandoc --version | head -1; typst --version; ls /usr/local/share/doc/typst; test -f /app/.test-gate-passed && echo gate-marker'
  Save 'runtime-image.txt' $o
  Check (($o -notmatch 'weasyprint') -and ($o -notmatch 'pdftoppm|pdftotext|poppler-present')) "the runtime image carries no WeasyPrint and no poppler"
  Check (($o -match '(?m)^pandoc 3\.11\s*$') -and ($o -match '(?m)^typst 0\.15\.1 ') -and ($o -match 'NOTICE') -and ($o -match 'gate-marker')) 'the runtime image runs pandoc 3.11 and Typst 0.15.1 (NOTICE carried), and holds the test-gate marker'

  # ---------------------------------------------------------------- 4. parity
  Write-Host '[4] the parity fixture (acceptance 6), --network none'
  $o = Dk run --rm --label $label --network none -e PARITY_OUT=/ev -v "${Evidence}:/ev" --entrypoint deno $parityTag test --allow-env --allow-read --allow-write --allow-run src/export/parity_fixture.ts
  Save 'parity.log' $o
  $ps = TestSummary $o
  Check (($script:rc -eq 0) -and $ps.Success -and $ps.Groups[3].Value -eq '0' -and ($o -match '"verdict": "PASS"')) "parity fixture: Typst == WeasyPrint on page count, text, numbering, headings ($($ps.Value))"
  Check ($o -match 'RED legacy WeasyPrint call: FAIL') 'parity RED: the pre-P6a WeasyPrint call is caught by the same checker'

  # ---------------------------------------------------------------- 5. database, stub, workbench
  Write-Host '[5] database + stub + workbench'
  $o = Dk run -d --name $dbName --label $label --network $net -e "POSTGRES_PASSWORD=$pw" -e POSTGRES_DB=openbrain `
    -v "${stage}:/docker-entrypoint-initdb.d:ro" $PgImage
  if ($script:rc -ne 0) { Fail "postgres did not start: $o"; throw 'db' }
  $made.containers += $dbName
  for ($i = 0; $i -lt 150; $i++) {
    $logs = Dk logs $dbName
    if ($logs -match 'PostgreSQL init process complete') { break }
    Start-Sleep -Seconds 2
  }
  Save 'initdb.log' $logs
  Check ($logs -match 'PostgreSQL init process complete') 'the database ran the initdb chain to completion'
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "initdb logged no ERROR ($($errs.Count))"
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $dbName pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $null = Dk exec $dbName psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) 'ob_app_memory (non-superuser, service_role member)'
  $null = Dk cp (Join-Path $ct 'export-fixtures.sql') "${dbName}:/tmp/export-fixtures.sql"
  $o = Dk exec $dbName psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -f /tmp/export-fixtures.sql
  Check (($script:rc -eq 0) -and ($o -cnotmatch 'ERROR:')) 'export fixtures applied'
  $o = Psql "SELECT registry || ':' || count(*) FROM public.contract_registry_entries WHERE registry IN ('export_formats','citation_styles','reference_identifier_kinds') GROUP BY registry ORDER BY registry"
  Check ($o.Trim() -eq "citation_styles:3`nexport_formats:4`nreference_identifier_kinds:5") "the P6a registries are seeded ($($o -replace "`n", ', '))"
  # the vault: the authored notes, LF
  New-Item -ItemType Directory -Force $vault | Out-Null
  $src = Join-Path $ct 'export-vault'
  Get-ChildItem -Recurse -File $src | ForEach-Object {
    $dest = Join-Path $vault $_.FullName.Substring($src.Length).TrimStart('\', '/')
    New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
    [System.IO.File]::WriteAllText($dest, ([System.IO.File]::ReadAllText($_.FullName) -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
  }
  $o = Dk run -d --name $stubName --label $label --network $net -v "${ct}:/ct:ro" --entrypoint deno $testTag run --allow-net /ct/stub-scholarly.ts
  if ($script:rc -eq 0) { $made.containers += $stubName }
  Check ($script:rc -eq 0) "stub $stubName started"
  Check (Start-Workbench $wbName $tag $onEnv) "workbench $wbName (resolver ON: test key + mailto, proxy = the stub) answers /health"

  # a. acceptance 1
  Write-Host '  [5a] acceptance 1: 100 references to PDF, DOCX, MD'
  $hundred = 'notes/p6a/hundred.md'
  foreach ($f in @('pdf', 'docx', 'md')) {
    $o = Export $wbName $hundred $f "hundred.$f"
    Check ($o -match '^status 200 ') "export $f of the 100-reference note: $o"
  }
  $o = Client @('hundred', '/ev/exports')
  Save 'hundred-check.log' $o
  Write-Host ($o -split "`n" | ForEach-Object { "        $_" } | Out-String).TrimEnd()
  Check ($script:rc -eq 0) 'acceptance 1: PDF, DOCX and MD numbered 1..100 inline and in the list, every reference the RESOLVED metadata'
  $o = Psql "SELECT count(*) || '|' || count(*) FILTER (WHERE rr.pinned_revision = r.pinned_revision) || '|' || count(*) FILTER (WHERE rr.via = 'openalex') || '|' || count(*) FILTER (WHERE rr.via = 'crossref') FROM public.reference_resolutions rr JOIN public.reference_records r ON r.id = rr.reference_id JOIN public.reference_holders h ON h.reference_id = r.id WHERE h.holder_ref = 'notes/p6a/hundred.md'"
  Save 'cache-rows.txt' "rows|at the pin|openalex|crossref`n$o"
  Check ($o.Trim() -eq '100|100|90|10') "the 100 resolutions are cached on their reference records at the pinned revision (rows|at pin|openalex|crossref = $($o.Trim()))"
  $log1 = StubLog 'stub-log-hundred.json'
  Check ($log1.Count -eq 110) "the stub saw 110 requests for 100 references (90 OpenAlex hits + 10 misses + 10 Crossref): $($log1.Count)"

  # b. acceptance 3
  Write-Host '  [5b] acceptance 3: the key and the mailto on every request'
  $o = Client @('headers', '/ev/stub-log-hundred.json', $oaKey, $mailto)
  Save 'headers-green.log' $o
  Write-Host "        $(($o -split "`n")[-1])"
  Check ($script:rc -eq 0) 'GREEN: every OpenAlex request carried the key, every Crossref request the mailto'
  $null = StubPost '/_reset'
  # RED: requests a non-compliant client would send, through the same proxy
  $o = Dk run --rm --label $label --network $net --entrypoint deno $testTag eval "const c=Deno.createHttpClient({proxy:{url:'http://${stubName}:8080'}}); for (const u of ['http://api.openalex.stub/works/doi%3A10.5555%2Fp6a.001','http://api.crossref.stub/works/10.5555%2Fp6a.095']) console.log((await fetch(u,{client:c})).status)"
  $null = StubLog 'stub-log-red.json'
  $o = Client @('headers', '/ev/stub-log-red.json', $oaKey, $mailto)
  Save 'headers-red.log' $o
  Check (($script:rc -eq 1) -and ($o -match 'OpenAlex request without the key') -and ($o -match 'Crossref request without the mailto')) 'RED: an unkeyed OpenAlex request and a Crossref request without the mailto FAIL the checker'
  $null = StubPost '/_reset'

  # c. acceptance 2
  Write-Host '  [5c] acceptance 2: one dead DOI'
  $o = Export $wbName 'notes/p6a/dead-doi.md' 'pdf' 'dead-doi.json'
  Check ($o -match '^status 422 ') "the dead-DOI note is refused: $o"
  $o = Client @('refused', '/ev/exports/dead-doi.json', '1', 'f6a00000-0000-4000-8000-000000000101', 'doi:10.5555/p6a.dead',
    'OpenAlex answered 404', 'Crossref answered 404', 'Fixture paper record dead')
  Save 'dead-doi-check.log' $o
  Write-Host ($o -split "`n" | ForEach-Object { "        $_" } | Out-String).TrimEnd()
  Check ($script:rc -eq 0) 'GREEN: the export fails with the dead reference named (number, source id, identifier, both services, title)'
  # RED: the pre-change workbench exports it, the dead reference rendered as text
  $baseSrc = Join-Path $env:TEMP "rwp6a-base-$rand"; $baseZip = "$baseSrc.tar"
  New-Item -ItemType Directory -Force $baseSrc | Out-Null
  & git -C $ob1 archive --format=tar -o $baseZip $BaseSha docker/workbench
  & tar -xf $baseZip -C $baseSrc
  $o = Dk build --label $label -t $baseTag (Join-Path $baseSrc 'docker\workbench')
  Save 'build-base.log' $o
  Check ($script:rc -eq 0) "pre-change image $baseTag built from OB1 $BaseSha"
  if ($script:rc -eq 0) {
    $made.images += $baseTag
    Check (Start-Workbench $baseName $baseTag @()) "pre-change workbench $baseName answers /health"
    $o = Export $baseName 'notes/p6a/dead-doi.md' 'txt' 'dead-doi-pre-change.txt' '&wrap=none'
    $txt = [System.IO.File]::ReadAllText((Join-Path $out 'dead-doi-pre-change.txt'))
    Save 'dead-doi-red.log' "$o`n$txt"
    Check (($o -match '^status 200 ') -and ($txt -match 'Fixture paper record dead')) 'RED: the pre-change export answers 200 and prints the dead reference as text (a silent pass)'
    $null = Dk rm -f -v $baseName
  }
  Remove-Item $baseSrc, $baseZip -Recurse -Force -ErrorAction SilentlyContinue

  # d. determinism offline
  Write-Host '  [5d] the cache: the same export with every service down'
  $null = StubPost '/_reset'
  $null = StubPost '/_mode?fail=1'
  $o = Export $wbName $hundred 'md' 'hundred-offline.md'
  $a = [System.IO.File]::ReadAllBytes((Join-Path $out 'hundred.md')); $b = [System.IO.File]::ReadAllBytes((Join-Path $out 'hundred-offline.md'))
  $same = ($a.Length -eq $b.Length) -and (-not (Compare-Object $a $b -SyncWindow 0))
  $log2 = StubLog 'stub-log-offline.json'
  Check (($o -match '^status 200 ') -and $same -and ($log2.Count -eq 0)) "offline: 200, byte-identical MD, $($log2.Count) requests (the metadata came from the reference records)"
  $null = StubPost '/_mode?fail=0'

  # e. styles, about, CJK
  Write-Host '  [5e] styles, about text, CJK'
  $o = Export $wbName $hundred 'txt' 'hundred-apa.txt' '&style=apa&wrap=none'
  $t = [System.IO.File]::ReadAllText((Join-Path $out 'hundred-apa.txt'))
  Check (($o -match 'style apa') -and ($t -match '\(Author1, 2020\)|\(Ann Author1, 2020\)') -and ($t -notmatch '\[1\]')) "style=apa renders author-date: $o"
  $o = Export $wbName $hundred 'pdf' 'bad-style.json' '&style=nope'
  Check ($o -match '^status 400 ') "an unregistered style is refused: $o"
  $o = Export $wbName $hundred 'html' 'bad-format.json'
  Check ($o -match '^status 400 ') "a retired format (html) is refused: $o"
  $o = Client @('get', "http://${wbName}:8000/workbench/export/about", '/ev/about.json')
  $about = Get-Content -Raw (Join-Path $Evidence 'about.json') | ConvertFrom-Json
  Check (($about.text -match 'Citation Style Language \(CSL\) project \(https://citationstyles.org/\)') -and (@($about.styles).Count -eq 3) -and
    ((@($about.programs) | Where-Object { $_.name -eq 'pandoc' }).source_offer -match 'refs/tags/3\.11\.tar\.gz')) 'the about text: the CSL project with its link, three styles with their authors, pandoc 3.11 with its source offer'
  $o = Export $wbName 'notes/p6a/cjk.md' 'pdf' 'cjk.pdf'
  Check ($o -match '^status 200 ') "export pdf of the CJK note: $o"
  $o = Client @('cjk', '/ev/exports/cjk.pdf', '/ct/export-vault/notes/p6a/cjk.md')
  Save 'cjk-check.log' $o
  Check ($script:rc -eq 0) "acceptance 4 (HTTP): $(($o -split "`n")[-1])"
  # RED: the same export with the CJK faces hidden from the workbench must FAIL, never render tofu
  $nf = "$wbName-nofonts"
  New-Item -ItemType Directory -Force $noFonts | Out-Null
  if (Start-Workbench $nf $tag $onEnv @('-v', "${noFonts}:/usr/share/fonts/opentype/noto:ro")) {
    $o = Export $nf 'notes/p6a/cjk.md' 'pdf' 'cjk-nofonts.json'
    $j = [System.IO.File]::ReadAllText((Join-Path $out 'cjk-nofonts.json'))
    Save 'cjk-red.log' "$o`n$j"
    Check (($o -match '^status 500 ') -and ($j -match 'unknown font family')) "RED: with the CJK faces missing the export FAILS (no tofu PDF): $o"
    $null = Dk rm -f -v $nf
  } else { Fail 'the no-fonts workbench did not start' }

  # f. inert, fail-closed, one service
  Write-Host '  [5f] shipped inert, fail-closed, one service'
  $null = StubPost '/_reset'
  $cases = @(
    @{ n = 'inert'; env = @('OPENALEX_API_KEY=', 'CROSSREF_MAILTO=', "FETCH_PROXY_URL=http://${stubName}:8080", 'RESOLVER_OPENALEX_BASE=http://api.openalex.stub', 'RESOLVER_CROSSREF_BASE=http://api.crossref.stub'); needle = 'shipped inert'; count = '2' },
    @{ n = 'noproxy'; env = @("OPENALEX_API_KEY=$oaKey", "CROSSREF_MAILTO=$mailto", 'FETCH_PROXY_URL=', 'RESOLVER_OPENALEX_BASE=http://api.openalex.stub', 'RESOLVER_CROSSREF_BASE=http://api.crossref.stub'); needle = 'never goes direct'; count = '2' }
  )
  foreach ($cs in $cases) {
    $name = "$wbName-$($cs.n)"
    if (Start-Workbench $name $tag $cs.env) {
      $o = Export $name 'notes/p6a/mixed.md' 'pdf' "mixed-$($cs.n).json"
      $r = Client @('refused', "/ev/exports/mixed-$($cs.n).json", $cs.count, $cs.needle, 'arxiv:2101.00001', 'doi:10.5555/p6a.095')
      Save "mixed-$($cs.n).log" "$o`n$r"
      Check (($o -match '^status 422 ') -and ($r -match '^PASS')) "$($cs.n): the arXiv and the declared-DOI references are refused, named ('$($cs.needle)')"
      $o = Export $name 'notes/p6a/web-only.md' 'pdf' "web-only-$($cs.n).pdf"
      Check ($o -match '^status 200 ') "$($cs.n): a note without persistent identifiers still exports: $o"
      $null = Dk rm -f -v $name
    } else { Fail "the $($cs.n) workbench did not start" }
  }
  $log3 = StubLog 'stub-log-inert.json'
  Check ($log3.Count -eq 0) "neither the inert nor the proxy-less workbench sent a request ($($log3.Count) logged)"
  $name = "$wbName-keyonly"
  if (Start-Workbench $name $tag @("OPENALEX_API_KEY=$oaKey", 'CROSSREF_MAILTO=', "FETCH_PROXY_URL=http://${stubName}:8080", 'RESOLVER_OPENALEX_BASE=http://api.openalex.stub', 'RESOLVER_CROSSREF_BASE=http://api.crossref.stub')) {
    $o = Export $name 'notes/p6a/mixed.md' 'pdf' 'mixed-keyonly.json'
    $r = Client @('refused', '/ev/exports/mixed-keyonly.json', '1', 'doi:10.5555/p6a.095', 'Crossref not tried: CROSSREF_MAILTO is not configured')
    $log4 = StubLog 'stub-log-keyonly.json'
    Save 'mixed-keyonly.log' "$o`n$r"
    Check (($o -match '^status 422 ') -and ($r -match '^PASS') -and (@($log4 | Where-Object { $_.host -eq 'api.crossref.stub' }).Count -eq 0)) 'key only: the arXiv work resolves (OpenAlex), the Crossref-only DOI is refused, named, and Crossref is never called'
    $null = Dk rm -f -v $name
  } else { Fail 'the key-only workbench did not start' }
} catch {
  Fail "aborted: $_"
} finally {
  Write-Host '[6] teardown'
  $ourVolumes = @()
  foreach ($c in $made.containers) {
    $mounts = Dk inspect -f '{{range .Mounts}}{{.Type}}={{.Name}} {{end}}' $c
    if ($script:rc -eq 0) {
      $ourVolumes += @(($mounts -split '\s+') | Where-Object { $_ -match '^volume=[A-Za-z0-9][A-Za-z0-9_.-]+$' } | ForEach-Object { $_.Substring(7) })
    }
    $null = Dk rm -f -v $c
  }
  if ($made.net) { $null = Dk network rm $net }
  if (-not $KeepImages) { foreach ($i in $made.images) { $null = Dk rmi $i } }
  Remove-Item $stage, $vault, $noFonts -Recurse -Force -ErrorAction SilentlyContinue
  $left = (Dk ps -a --filter "label=$label" --format '{{.Names}}' | Out-String).Trim()
  $leftNet = (Dk network ls --filter "label=$label" --format '{{.Name}}' | Out-String).Trim()
  Check (($left -eq '') -and ($leftNet -eq '')) "nothing labelled $Id is left (containers: '$left', networks: '$leftNet')"
  $volLeft = @($ourVolumes | Where-Object { $null = Dk volume inspect $_; $script:rc -eq 0 })
  Check ($volLeft.Count -eq 0) "no volume of ours is left ($($ourVolumes.Count) recorded, $($volLeft.Count) left: '$($volLeft -join ' ')')"
  $volNew = @(DanglingVolumes | Where-Object { $volBefore -notcontains $_ })
  Write-Host "  INFO  dangling volumes on the host: $($volBefore.Count) before, $(@(DanglingVolumes).Count) after; new during the run: $($volNew.Count) (ours among them: $(@($volNew | Where-Object { $ourVolumes -contains $_ }).Count))"
  $localAfter = LocalSnapshot
  Check ((Compare-Object $localBefore $localAfter) -eq $null) 'no :local image changed'
}
Write-Host "evidence: $Evidence"
if ($script:fail) { Write-Host "$($script:fail) check(s) FAILED"; exit 1 }
Write-Host 'all checks passed'
exit 0
