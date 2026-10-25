# run-export-tests.ps1 - the disposable test run for research-workbench P6a (rw-p6a-resolve):
# the resolver, pandoc citeproc with a CSL style chosen from the registry, Typst PDFs.
#
#   powershell -NoProfile -File OB1\docker\workbench\contract-test\run-export-tests.ps1 [-Id <owner id>] [-Evidence <dir>]
#       [-Subnet <a.b.c.d/nn> | -SubnetBase <a.b>]
#
# What it does, and ONLY this:
#   1. stages the REAL initdb chain from docker-compose.yml (every mounted init*.sql, P6a's 250 slot)
#   2. creates ONE internal docker network on a PINNED subnet (-Subnet, or a /24 from -SubnetBase;
#      anything in 192.168.0.0/16 refused before docker is asked, the result inspected); every
#      container and the network are labelled ai-stack.harness.owner=<Id>
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
#           it, and the stub sees no request from it; "Copy page" (mode=copy) answers 200 with the
#           unresolved references marked UNRESOLVED (attempt 2, decision C)
#        g. attempt 2 (the tester's adversarial shapes): redirects (Crossref->OpenAlex, OpenAlex->
#           Crossref, a third host, the key echoed in Location) and a 200 echoing the key - each
#           reference fails, 0 follow-ups, nothing cached; malformed identifiers refused before any
#           request; raw HTML absent from MD/DOCX/PDF/TXT; a title with @/#set/$x$/\ exports and
#           prints literally; emoji render, an uncovered character is refused (422 glyphs); the
#           refused export's retry asks only for the dead DOI (decision B); a one-byte-modified style
#           and a row-only style refused at use (503); a non-proxy egress names a code, no address.
#           A DIRECT CATCHER holding the service names as aliases must see 0 requests.
#        h. attempt 3: link shapes, glyphs in code and math, a key split by an empty tag, image paths,
#           limits
#        i. attempt 4 (bounded round; tester ADV-4 / bar c, near-misses N3, N4, N7): the key or the
#           mailto between `<` and `>` and transformed (fresh: 422 named in every format, nothing
#           cached, the Copy page clean; a row cached by attempt 3: 422 'unsafe cached record', no
#           request); an image behind `..` / a hidden segment (a real PNG there) never embedded;
#           relative links and anchors rendered as text (200); a control character 422 glyphs
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
  [string]$BaseSha = '0741b36',
  # rw-p6a-resolve attempt 2 (tester near-miss 8; the parameter names of P3a's runners): the
  # disposable network's subnet. Empty = a /24 drawn from -SubnetBase.
  [string]$Subnet = '',
  [string]$SubnetBase = '10.231'
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
$label = "ai-stack.harness.owner=$Id"
$ct = $PSScriptRoot
$wb = Split-Path -Parent $ct
$dockerDir = Split-Path -Parent $wb
$ob1 = Split-Path -Parent $dockerDir
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$net = "rwp6a-net-$rand"
$dbName = "rwp6a-db-$rand"; $stubName = "rwp6a-stub-$rand"; $wbName = "rwp6a-wb-$rand"; $baseName = "rwp6a-wbbase-$rand"
$catchName = "rwp6a-catch-$rand"
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
# The network's subnet is PINNED: the daemon's default pool runs into 192.168.0.0/20, and a Docker
# network there once cut the host off its home LAN (192.168.1.x). -Subnet names one; otherwise a /24
# is drawn from -SubnetBase and retried on an overlap. Anything inside 192.168.0.0/16, a prefix
# shorter than /16 or longer than /28, or a malformed value is refused before docker is asked.
function Test-SubnetAllowed([string]$s) {
  if ($s -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/(\d{1,2})$') { return $false }
  $o = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4]); $len = [int]$Matches[5]
  if (@($o | Where-Object { $_ -gt 255 }).Count -gt 0) { return $false }
  if ($len -lt 16 -or $len -gt 28) { return $false }
  if ($o[0] -eq 192 -and $o[1] -eq 168) { return $false }
  return $true
}
function New-PinnedNetwork([string]$name) {
  if ($SubnetBase -notmatch '^(\d{1,3})\.(\d{1,3})$' -or $SubnetBase -match '^192\.168$') { Fail "refusing -SubnetBase '$SubnetBase'"; return '' }
  $cands = if ($Subnet) { @($Subnet) } else { @(1..8 | ForEach-Object { "$SubnetBase.$(Get-Random -Minimum 16 -Maximum 250).0/24" }) }
  foreach ($s in $cands) {
    if (-not (Test-SubnetAllowed $s)) { Fail "refusing subnet '$s' (inside 192.168.0.0/16, or malformed)"; return '' }
    $null = Dk network create --internal --subnet $s --label $label $name
    if ($script:rc -eq 0) { return $s }
  }
  return ''
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

Write-Host "== rw-p6a-resolve test run  owner=$Id  net=$net  evidence=$Evidence"
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
  $subnet = New-PinnedNetwork $net
  Check ($subnet -ne '') "network $net created (internal, labelled, --subnet $subnet)"
  if ($subnet -eq '') { throw 'network' }
  $made.net = $true
  $got = (Dk network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' $net).Trim()
  Check (($got -eq $subnet) -and (Test-SubnetAllowed $got)) "the network's subnet is the pinned one, outside 192.168.0.0/16 ($got)"

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
  # the real-program renders (numbering, styles, CJK glyphs with the tofu RED, the process tree) and,
  # attempt 2, the resolver through a real loopback proxy (resolver_test), the renderer's safety
  # cases (render_safety_test) and the route with fakes (exporter_test)
  $o = Dk run --rm --label $label --network none --entrypoint deno $testTag test --allow-net --allow-env --allow-read --allow-write --allow-run `
    src/export/
  Save 'export-suites.log' ($o -replace '\x1b\[[0-9;]*m', '')
  $es = TestSummary $o
  Check ($es.Success -and $es.Groups[3].Value -eq '0') "export suites (every src/export/*_test.ts) in the test image: $($es.Value)"
  $cjk = ([regex]'cjk: fonts [^\r\n]+').Match(($o -replace '\x1b\[[0-9;]*m', ''))
  if ($cjk.Success) { Write-Host "        $($cjk.Value)" }
  $o = Dk run --rm --label $label --network none --entrypoint deno $testTag task contract:check
  Save 'contract-check.log' $o
  Check (($script:rc -eq 0) -and ($o -match 'contract artifacts are current')) 'deno task contract:check: contract artifacts are current'
  # what left the runtime image (take what we need, remove what is no longer needed)
  $o = Dk run --rm --label $label --network none --entrypoint sh $tag -c 'dpkg -s weasyprint >/dev/null 2>&1 && echo weasyprint-present; command -v weasyprint pdftoppm pdftotext || true; dpkg -s poppler-utils >/dev/null 2>&1 && echo poppler-present; pandoc --version | head -1; typst --version; ls /usr/local/share/doc/typst; test -f /app/.test-gate-passed && echo gate-marker'
  Save 'runtime-image.txt' $o
  Check (($o -notmatch 'weasyprint') -and ($o -notmatch 'pdftoppm|pdftotext|poppler-present')) "the runtime image carries no WeasyPrint and no poppler"
  # rw-p6a-followups: no test file and no test oracle in the runtime image - nowhere in it, the dependency
  # cache included (round 2: DENO_DIR held gen/.../*_test.ts.js); the test stage keeps them
  $find = "find / \( -path /proc -o -path /sys -o -path /dev \) -prune -o \( -name '*_test.ts*' -o -name '*_test.js*' -o -name '*credentials_oracle*' \) -print"
  $rt = (Dk run --rm --label $label --network none --entrypoint sh $tag -c $find).Trim()
  $ts = (Dk run --rm --label $label --network none --entrypoint sh $testTag -c $find).Trim()
  Save 'runtime-tests.txt' "runtime:`n$rt`ntest:`n$ts"
  Check ($rt -eq '') "the runtime image carries no *_test.ts / *_test.ts.js and no credentials_oracle anywhere (/, DENO_DIR included) ($(@($rt -split "`n" | Where-Object { $_ }).Count) found)"
  Check (($ts -match 'credentials_oracle\.ts') -and ($ts -match 'resolve2_cost_test\.ts')) "the test stage keeps them ($(@($ts -split "`n" | Where-Object { $_ }).Count) files)"
  # attempt 2: the glyph-coverage verdicts the build gate reaches in the TEST stage hold for the
  # RUNTIME image only if both carry the same font files (poppler once pulled DejaVu into test only)
  $fontsCmd = 'find /usr/share/fonts /usr/local/share/fonts -type f 2>/dev/null | sort | xargs md5sum | md5sum; find /usr/share/fonts -type f | wc -l'
  $fr = (Dk run --rm --label $label --network none --entrypoint sh $tag -c $fontsCmd).Trim()
  $ft = (Dk run --rm --label $label --network none --entrypoint sh $testTag -c $fontsCmd).Trim()
  Save 'font-sets.txt' "runtime:`n$fr`ntest:`n$ft"
  Check (($fr -ne '') -and ($fr -eq $ft)) "the runtime and test images carry the same font files ($(($fr -split "`n")[-1]) files)"
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
  # (attempt 4: -Force, so a dot-directory is copied too; an image is copied byte for byte)
  Get-ChildItem -Recurse -File -Force $src | ForEach-Object {
    $dest = Join-Path $vault $_.FullName.Substring($src.Length).TrimStart('\', '/')
    New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
    if ($_.Extension -eq '.md') {
      [System.IO.File]::WriteAllText($dest, ([System.IO.File]::ReadAllText($_.FullName) -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
    } else { Copy-Item -LiteralPath $_.FullName -Destination $dest -Force }
  }
  $o = Dk run -d --name $stubName --label $label --network $net -v "${ct}:/ct:ro" --entrypoint deno $testTag run --allow-net /ct/stub-scholarly.ts
  if ($script:rc -eq 0) { $made.containers += $stubName }
  Check ($script:rc -eq 0) "stub $stubName started"
  # the DIRECT CATCHER (attempt 2): the same stub holding the service names (and a third host's) as
  # network aliases, so a request that skipped the proxy - or followed a redirect around it - lands
  # here and is logged. The run expects it to see nothing.
  $o = Dk run -d --name $catchName --label $label --network $net --network-alias api.openalex.stub --network-alias api.crossref.stub `
    --network-alias evil.stub -v "${ct}:/ct:ro" --entrypoint deno $testTag run --allow-net /ct/stub-scholarly.ts
  if ($script:rc -eq 0) { $made.containers += $catchName }
  Check ($script:rc -eq 0) "direct catcher $catchName started (aliases api.openalex.stub, api.crossref.stub, evil.stub)"
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
  # RED: the same export with the CJK faces hidden from the workbench must FAIL, never render tofu.
  # Attempt 2: the CJK text is refused BEFORE Typst runs (422 glyphs, the characters named); a note
  # whose text the remaining faces cover still fails, on the missing registered main face (503 font).
  $nf = "$wbName-nofonts"
  New-Item -ItemType Directory -Force $noFonts | Out-Null
  if (Start-Workbench $nf $tag $onEnv @('-v', "${noFonts}:/usr/share/fonts/opentype/noto:ro")) {
    $o = Export $nf 'notes/p6a/cjk.md' 'pdf' 'cjk-nofonts.json'
    $j = [System.IO.File]::ReadAllText((Join-Path $out 'cjk-nofonts.json'))
    $o2 = Export $nf 'notes/p6a/web-only.md' 'pdf' 'web-only-nofonts.json'
    $j2 = [System.IO.File]::ReadAllText((Join-Path $out 'web-only-nofonts.json'))
    Save 'cjk-red.log' "$o`n$j`n$o2`n$j2"
    Check (($o -match '^status 422 ') -and ($j -match '"code":"glyphs"') -and ($j -match 'no installed font covers U\+')) "RED: with the CJK faces missing the CJK export is refused before typesetting, the characters named (no tofu PDF): $o"
    Check (($o2 -match '^status 503 ') -and ($j2 -match '"code":"font"') -and ($j2 -notmatch 'warning|typ:|/tmp/')) "RED: with the registered main face missing a Latin note fails 503 'font', no program report: $o2"
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
      # decision C (tester near-miss 9): "Copy page" (mode=copy) is never refused for an unresolved
      # reference: 200 inline plain text, each one marked UNRESOLVED, nothing requested
      $o = Export $name 'notes/p6a/mixed.md' 'txt' "mixed-copy-$($cs.n).txt" '&mode=copy'
      $t = [System.IO.File]::ReadAllText((Join-Path $out "mixed-copy-$($cs.n).txt"))
      Save "mixed-copy-$($cs.n).log" "$o`n$t"
      Check (($o -match '^status 200 .*mode copy unresolved 2$') -and ($t -match 'UNRESOLVED \(not resolved yet\): Fixture arXiv record') -and ($t -match 'A fixture web page')) "$($cs.n): Copy page answers 200 with the 2 unresolved references marked UNRESOLVED: $o"
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

  # g. attempt 2: the tester's adversarial shapes, each a case (rw-p6a-resolve test-attempt1)
  Write-Host '  [5g] attempt 2: redirects, hostile answers and identifiers, raw HTML, titles, glyphs, styles, egress'
  # ADV-2b + ADV-3: Crossref->OpenAlex 302, OpenAlex->Crossref 302, 302 to a third host, Location echoing
  # the key, a 200 echoing the key. Each reference fails; no follow-up request; nothing cached.
  $null = StubPost '/_reset'
  $o = Export $wbName 'notes/p6a/hostile-answers.md' 'pdf' 'hostile-answers.json'
  $r = Client @('refused', '/ev/exports/hostile-answers.json', '5', 'Crossref answered a redirect (3xx), not followed',
    'OpenAlex answered a redirect (3xx), not followed', 'OpenAlex returned a record carrying credential-shaped text (refused)')
  $log5 = StubLog 'stub-log-hostile-answers.json'
  $h = Client @('headers', '/ev/stub-log-hostile-answers.json', $oaKey, $mailto)
  Save 'hostile-answers.log' "$o`n$r`n$h"
  Write-Host ($r -split "`n" | ForEach-Object { "        $_" } | Out-String).TrimEnd()
  Check (($o -match '^status 422 ') -and ($r -match '^PASS')) 'ADV-2b/ADV-3: the five hostile answers each fail their reference, named (redirect x4 not followed, the echoing record refused)'
  Check (($script:rc -eq 0) -and ($log5.Count -eq 7) -and (@($log5 | Where-Object { $_.host -eq 'evil.stub' }).Count -eq 0)) "ADV-2b: the proxy saw only the resolver's own 7 requests, every one keyed / mailto'd, 0 follow-ups, 0 to the third host ($($log5.Count) logged)"
  $j = [System.IO.File]::ReadAllText((Join-Path $out 'hostile-answers.json'))
  Check (($j -notmatch [regex]::Escape($oaKey)) -and ($j -notmatch [regex]::Escape($mailto))) 'ADV-3: the 422 body carries neither the key nor the mailto'
  $o = Psql "SELECT count(*) FROM public.reference_resolutions rr JOIN public.reference_records r ON r.id = rr.reference_id WHERE r.source_id::text LIKE 'f6a00000-0000-4000-8000-00000000010_' AND r.source_id::text > 'f6a00000-0000-4000-8000-000000000104'"
  Check ($o.Trim() -eq '0') "ADV-2b/ADV-3: nothing from a redirect or an echoing record is cached ($($o.Trim()) rows)"
  # ADV-2c: identifiers outside the grammar, refused before any request
  $null = StubPost '/_reset'
  $o = Export $wbName 'notes/p6a/hostile-ids.md' 'pdf' 'hostile-ids.json'
  $r = Client @('refused', '/ev/exports/hostile-ids.json', '6', 'the source declares a malformed identifier', 'is not a valid doi identifier')
  $log6 = StubLog 'stub-log-hostile-ids.json'
  Save 'hostile-ids.log' "$o`n$r"
  $len = (Get-Item (Join-Path $out 'hostile-ids.json')).Length
  Check (($o -match '^status 422 ') -and ($r -match '^PASS') -and ($log6.Count -eq 0) -and ($len -lt 6000)) "ADV-2c: six malformed identifiers (@, .., a second DOI, a query, 300 chars, non-ASCII) refused, named, 0 requests, body $len bytes"
  # ADV-1c (amended fact A5): raw HTML dropped from MD, DOCX and PDF
  $ok = $true
  foreach ($f in @('md', 'docx', 'pdf', 'txt')) {
    $o = Export $wbName 'notes/p6a/raw-html.md' $f "raw-html.$f"
    if ($o -notmatch '^status 200 ') { $ok = $false; Fail "raw-html $f export: $o" }
  }
  $o = Client @('forbidden', '/ev/exports/raw-html.md', '/ev/exports/raw-html.docx', '/ev/exports/raw-html.pdf', '/ev/exports/raw-html.txt')
  Save 'raw-html-check.log' $o
  Write-Host ($o -split "`n" | ForEach-Object { "        $_" } | Out-String).TrimEnd()
  Check ($ok -and ($script:rc -eq 0)) 'ADV-1c / A5: no <script, <iframe, on*=, javascript:, data:text/html, {=html} or comment in the MD, the DOCX XML, the PDF (text + objects) or the TXT; the MD re-read by pandoc has no raw node'
  # ADV-5a: a title with citation, Typst and markdown syntax
  $ok = $true
  foreach ($f in @('pdf', 'docx', 'md', 'txt')) {
    $o = Export $wbName 'notes/p6a/title-at.md' $f "title-at.$f"
    if ($o -notmatch '^status 200 ') { $ok = $false; Fail "title-at $f export: $o" }
  }
  $o = Client @('title', '/ev/exports/title-at.pdf', '/ct/export-vault/notes/p6a/title-at.md')
  $o2 = Client @('title', '/ev/exports/title-at.docx', '/ct/export-vault/notes/p6a/title-at.md')
  Save 'title-at.log' "$o`n$o2"
  Check ($ok -and ($o -match '^PASS') -and ($o2 -match '^PASS')) "ADV-5a: the @me / [@you] / #set / `$x`$ / backslash title exports in every format (200) and prints literally in the PDF and the DOCX"
  # ADV-5: emoji render with the emoji face; a character no face covers is refused, named
  $o = Export $wbName 'notes/p6a/emoji.md' 'pdf' 'emoji.pdf'
  $f2 = Client @('fonts', '/ev/exports/emoji.pdf', 'Emoji')
  Save 'emoji.log' "$o`n$f2"
  Check (($o -match '^status 200 ') -and ($f2 -match '^PASS')) "ADV-5: emoji + CJK + Hebrew export to PDF with an emoji face embedded: $f2"
  $o = Export $wbName 'notes/p6a/lost-glyph.md' 'pdf' 'lost-glyph.json'
  $j = [System.IO.File]::ReadAllText((Join-Path $out 'lost-glyph.json'))
  $o2 = Export $wbName 'notes/p6a/lost-glyph.md' 'md' 'lost-glyph.md'
  Save 'lost-glyph.log' "$o`n$j`n$o2"
  Check (($o -match '^status 422 ') -and ($j -match '"code":"glyphs"') -and ($j -match 'U\+10600') -and ($j -match 'U\+E000') -and ($o2 -match '^status 200 ')) "ADV-5: a character no installed face covers is refused before typesetting (422 glyphs, U+10600 named); the MD export still answers 200"
  # near-miss 2 (decision B): the dead-DOI note's retry asks only for the dead reference
  $null = StubPost '/_reset'
  $o = Export $wbName 'notes/p6a/dead-doi.md' 'pdf' 'dead-doi-retry.json'
  $log7 = StubLog 'stub-log-dead-retry.json'
  $paths = (@($log7 | ForEach-Object { "$($_.host)$($_.path)" }) -join ' ')
  Save 'dead-doi-retry.log' "$o`n$paths"
  Check (($o -match '^status 422 ') -and ($log7.Count -eq 2) -and ($paths -match 'api.openalex.stub/works/doi:10.5555/p6a.dead') -and ($paths -match 'api.crossref.stub/works/10.5555/p6a.dead')) "decision B: the good resolutions stayed cached on the refused export; the retry requested only the dead DOI ($($log7.Count) requests: $paths)"
  # ADV-4b: a one-byte-modified style and a row-only style refused at USE time
  $cslTmp = Join-Path $env:TEMP "rwp6a-csl-$rand"
  New-Item -ItemType Directory -Force $cslTmp | Out-Null
  $ieee = [System.IO.File]::ReadAllText((Join-Path $wb 'csl\ieee.csl'))
  [System.IO.File]::WriteAllText((Join-Path $cslTmp 'ieee.csl'), $ieee.Replace('<title>IEEE', '<title>JEEE'), (New-Object System.Text.UTF8Encoding $false))
  $null = Psql "INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES ('citation_styles', 'row-only', 'A row without a file', '{""file"":""row-only.csl"",""sha256"":""$('0' * 64)"",""citation_format"":""numeric"",""authors"":[],""contributors"":[]}')"
  $cs = "$wbName-csl"
  if (Start-Workbench $cs $tag $onEnv @('-v', "$(Join-Path $cslTmp 'ieee.csl'):/app/csl/ieee.csl:ro")) {
    $o = Export $cs 'notes/p6a/web-only.md' 'pdf' 'csl-modified.json'
    $j = [System.IO.File]::ReadAllText((Join-Path $out 'csl-modified.json'))
    $o2 = Export $cs 'notes/p6a/web-only.md' 'pdf' 'csl-apa.pdf' '&style=apa'
    $o3 = Export $cs 'notes/p6a/web-only.md' 'pdf' 'csl-row-only.json' '&style=row-only'
    $j3 = [System.IO.File]::ReadAllText((Join-Path $out 'csl-row-only.json'))
    Save 'csl-integrity.log' "$o`n$j`n$o2`n$o3`n$j3"
    Check (($o -match '^status 503 ') -and ($j -match '"code":"style-integrity"') -and ($j -match "citation style 'ieee' failed its integrity check")) "ADV-4b: the one-byte-modified ieee.csl is refused at use: $o"
    Check ($o2 -match '^status 200 .*style apa') "ADV-4b: an unmodified style on the same workbench still renders: $o2"
    Check (($o3 -match '^status 503 ') -and ($j3 -match "citation style 'row-only' failed its integrity check") -and ($j3 -match 'missing')) "ADV-4b: a registry row whose file is missing is refused: $o3"
    $null = Dk rm -f -v $cs
  } else { Fail 'the modified-style workbench did not start' }
  $null = Psql "DELETE FROM public.contract_registry_entries WHERE registry = 'citation_styles' AND key = 'row-only'"
  Remove-Item $cslTmp -Recurse -Force -ErrorAction SilentlyContinue
  # ADV-2a / near-miss 4: a FETCH_PROXY_URL that is not a proxy (the database's port): the 422 names a
  # reason code + egress, no address; the detail is in the server log, masked
  $eg = "$wbName-egress"
  if (Start-Workbench $eg $tag @("OPENALEX_API_KEY=$oaKey", "CROSSREF_MAILTO=$mailto", "FETCH_PROXY_URL=http://${dbName}:5432", 'RESOLVER_OPENALEX_BASE=http://api.openalex.stub', 'RESOLVER_CROSSREF_BASE=http://api.crossref.stub', 'RESOLVER_TIMEOUT_MS=5000')) {
    $o = Export $eg 'notes/p6a/egress.md' 'pdf' 'egress-nonproxy.json'
    $j = [System.IO.File]::ReadAllText((Join-Path $out 'egress-nonproxy.json'))
    $logs = Dk logs $eg
    Save 'egress-nonproxy.log' "$o`n$j"
    Check (($o -match '^status 422 ') -and ($j -match 'request failed \(egress: (network error|timeout)\)') -and ($j -notmatch '\d+\.\d+\.\d+\.\d+') -and ($j -notmatch [regex]::Escape($dbName)) -and ($j -notmatch '5432')) "near-miss 4: a non-proxy egress fails 422 with a reason code + egress, no address or host in the body: $o"
    Check (($logs -match '\[export resolver\]') -and ($logs -notmatch [regex]::Escape($oaKey)) -and ($logs -notmatch [regex]::Escape($mailto))) 'near-miss 4: the detail is in the workbench log, the key and the mailto masked'
    $null = Dk rm -f -v $eg
  } else { Fail 'the egress workbench did not start' }
  # h. attempt 3: the tester's attempt-2 bypasses through HTTP (test-attempt2 ADV-3, ADV-4, ADV-5, near-miss 1)
  Write-Host '  [5h] attempt 3: link shapes, glyphs in code and math, a key split by an empty tag, limits'
  # ADV-4: the five link shapes + attribute blocks: every format 200, nothing a reader could follow
  $ok = $true
  foreach ($f in @('md', 'docx', 'pdf', 'txt')) {
    $o = Export $wbName 'notes/p6a/links.md' $f "links.$f"
    if ($o -notmatch '^status 200 ') { $ok = $false; Fail "links $f export: $o" }
  }
  $o = Client @('structure', '/ev/exports/links.md', '/ev/exports/links.docx', '/ev/exports/links.pdf', '/ev/exports/links.txt')
  Save 'links-structure.log' $o
  Write-Host ($o -split "`n" | ForEach-Object { "        $_" } | Out-String).TrimEnd()
  Check ($ok -and ($script:rc -eq 0)) 'A3 / ADV-4: the link shapes export 200 in MD, DOCX, PDF and TXT; the MD rendered by pandoc to HTML, the DOCX relationships and the PDF actions carry no javascript: target and no on* attribute'
  # ADV-5: a character no face covers inside a code span, math and a fence: 422 glyphs, not a 200 with boxes
  $o = Export $wbName 'notes/p6a/glyph-code.md' 'pdf' 'glyph-code.json'
  $j = [System.IO.File]::ReadAllText((Join-Path $out 'glyph-code.json'))
  $o2 = Export $wbName 'notes/p6a/glyph-code.md' 'md' 'glyph-code.md'
  Save 'glyph-code.log' "$o`n$j`n$o2"
  Check (($o -match '^status 422 ') -and ($j -match '"code":"glyphs"') -and ($j -match 'U\+10600') -and ($o2 -match '^status 200 ')) "A3 / ADV-5: U+10600 in a code span, math and a fence is refused 422 glyphs before typesetting (the MD still answers 200): $o"
  # ADV-3: a 200 record whose title holds the key / mailto split by <i></i>, <b></b>, <sc></sc>, <span class="nocase"></span>
  $null = StubPost '/_reset'
  $o = Export $wbName 'notes/p6a/split-key.md' 'pdf' 'split-key.json'
  $r = Client @('refused', '/ev/exports/split-key.json', '2', 'OpenAlex returned a record carrying credential-shaped text (refused)')
  $j = [System.IO.File]::ReadAllText((Join-Path $out 'split-key.json'))
  $o2 = Psql "SELECT count(*) FROM public.reference_resolutions rr JOIN public.reference_records r ON r.id = rr.reference_id WHERE r.source_id::text IN ('f6a00000-0000-4000-8000-000000000117', 'f6a00000-0000-4000-8000-000000000118')"
  $o3 = Export $wbName 'notes/p6a/split-key.md' 'txt' 'split-key.copy.txt' '&mode=copy'
  $s3 = Client @('secret', '/ev/exports/split-key.copy.txt', $oaKey, $mailto)
  Save 'split-key.log' "$o`n$r`ncached rows: $($o2.Trim())`n$o3`n$s3"
  Write-Host ($r -split "`n" | ForEach-Object { "        $_" } | Out-String).TrimEnd()
  Check (($o -match '^status 422 ') -and ($r -match '^PASS') -and ($j -notmatch [regex]::Escape($oaKey)) -and ($j -notmatch [regex]::Escape($mailto))) 'A3 / ADV-3: both split-key records are refused as credential-shaped (422, named), the body carries neither secret'
  Check ($o2.Trim() -eq '0') "A3 / ADV-3: neither split-key record is cached ($($o2.Trim()) rows)"
  Check (($o3 -match '^status 200 ') -and ($s3 -match '^PASS')) "A3 / ADV-3: the Copy page of the note answers 200 and carries neither secret: $o3 | $s3"
  # found in attempt 3: an image path made pandoc embed a local file (/proc/self/environ held the key) or
  # fetch a URL from the workbench itself (evil.stub is the direct catcher: a fetch would be logged there)
  $ok = $true
  foreach ($f in @('docx', 'pdf')) {
    $o = Export $wbName 'notes/p6a/image-paths.md' $f "image-paths.$f"
    if ($o -notmatch '^status 200 ') { $ok = $false; Fail "image-paths $f export: $o" }
  }
  $s1 = Client @('secret', '/ev/exports/image-paths.docx', $oaKey, $mailto)
  $s2 = Client @('secret', '/ev/exports/image-paths.pdf', $oaKey, $mailto)
  $media = -1
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $out 'image-paths.docx'))
    $media = @($zip.Entries | Where-Object { $_.FullName -like 'word/media/*' }).Count
    $zip.Dispose()
  } catch { $media = -1 }
  Save 'image-paths.log' "$s1`n$s2`nmedia parts in the DOCX: $media"
  Check ($ok -and ($s1 -match '^PASS') -and ($s2 -match '^PASS') -and ($media -eq 0)) "A3-13: /proc/self/environ, ../etc/passwd, .git/config and http://evil.stub as images export 200 (DOCX, PDF), embed nothing ($media media parts) and carry neither secret"
  # i. attempt 4 (bounded round): the key or the mailto between < and >, and transformed (tester ADV-4,
  # bar c, N2) - fresh, then a row cached by attempt 3; an image behind '..' / a hidden segment (N3);
  # relative links (N4); a control character (N7)
  Write-Host '  [5i] attempt 4: a key between < and >, transformed, fresh and cached; image traversal; relative links; a control character'
  $null = StubPost '/_reset'
  $ok = $true
  foreach ($f in @('md', 'txt', 'docx', 'pdf')) {
    $o = Export $wbName 'notes/p6a/wrapped-key.md' $f "wrapped-key.$f.json"
    $j = [System.IO.File]::ReadAllText((Join-Path $out "wrapped-key.$f.json"))
    if (($o -notmatch '^status 422 ') -or ($j -match [regex]::Escape($oaKey)) -or ($j -match [regex]::Escape($mailto))) { $ok = $false; Fail "wrapped-key $f export: $o" }
  }
  $r = Client @('refused', '/ev/exports/wrapped-key.pdf.json', '8', 'OpenAlex returned a record carrying credential-shaped text (refused)')
  $o2 = Psql "SELECT count(*) FROM public.reference_resolutions rr JOIN public.reference_records r ON r.id = rr.reference_id WHERE r.source_id::text BETWEEN 'f6a00000-0000-4000-8000-000000000119' AND 'f6a00000-0000-4000-8000-000000000126'"
  $o3 = Export $wbName 'notes/p6a/wrapped-key.md' 'txt' 'wrapped-key.copy.txt' '&mode=copy'
  $s3 = Client @('secret', '/ev/exports/wrapped-key.copy.txt', $oaKey, $mailto)
  Save 'wrapped-key.log' "$r`ncached rows: $($o2.Trim())`n$o3`n$s3"
  Write-Host ($r -split "`n" | ForEach-Object { "        $_" } | Out-String).TrimEnd()
  Check ($ok -and ($r -match '^PASS')) 'A4 / A3-4: the eight wrapped or transformed records (< K >, <K>, <1 K>, < K and later >, <<K>>, author < M >, %-encoded K, M with (at)) are refused fresh in MD, TXT, DOCX and PDF: 422, each named credential-shaped, no body carries either secret'
  Check ($o2.Trim() -eq '0') "A4 / A3-4: none of the eight is cached ($($o2.Trim()) rows)"
  Check (($o3 -match '^status 200 ') -and ($s3 -match '^PASS')) "A4 / A3-4: the Copy page of the note answers 200 and carries neither secret: $o3 | $s3"
  # cached: resolved clean, then the row rewritten as attempt 3 stored `Angle < KEY > title` / `< MAILTO >`
  $o = Export $wbName 'notes/p6a/wrapped-cached.md' 'txt' 'wrapped-cached.first.txt'
  $u = Psql "UPDATE public.reference_resolutions rr SET csl = jsonb_set(jsonb_set(rr.csl, '{title}', to_jsonb(('Angle < ' || '$oaKey' || ' > title')::text)), '{author}', jsonb_build_array(jsonb_build_object('literal', ('< ' || '$mailto' || ' >')::text))) FROM public.reference_records r WHERE r.id = rr.reference_id AND r.source_id = 'f6a00000-0000-4000-8000-000000000127' RETURNING rr.via"
  $null = StubPost '/_reset'
  $ok = ($o -match '^status 200 ') -and ($u.Trim() -eq 'openalex')
  if (-not $ok) { Fail "wrapped-cached: the clean first export or the rewrite: $o | rewritten: $u" }
  foreach ($f in @('md', 'txt', 'docx', 'pdf')) {
    $o = Export $wbName 'notes/p6a/wrapped-cached.md' $f "wrapped-cached.$f.json"
    $j = [System.IO.File]::ReadAllText((Join-Path $out "wrapped-cached.$f.json"))
    if (($o -notmatch '^status 422 ') -or ($j -notmatch 'cached record carries credential-shaped text') -or ($j -match [regex]::Escape($oaKey)) -or ($j -match [regex]::Escape($mailto))) { $ok = $false; Fail "wrapped-cached $f export: $o $j" }
  }
  $o3 = Export $wbName 'notes/p6a/wrapped-cached.md' 'txt' 'wrapped-cached.copy.txt' '&mode=copy'
  $s3 = Client @('secret', '/ev/exports/wrapped-cached.copy.txt', $oaKey, $mailto)
  $logW = @(StubLog 'stub-log-wrapped-cached.json' | ForEach-Object { $_ })
  Save 'wrapped-cached.log' "rewritten: $($u.Trim())`n$o3`n$s3`nrequests after the rewrite: $($logW.Count)"
  Check $ok 'A4 / A3-4: a row cached by attempt 3 holding the title `Angle < KEY > title` and the author `< MAILTO >` is refused in MD, TXT, DOCX and PDF: 422 naming the cached record, no body carries either secret'
  Check (($o3 -match '^status 200 ') -and ($s3 -match '^PASS') -and ($logW.Count -eq 0)) "A4 / A3-4: its Copy page answers 200 and carries neither secret; no request was made ($($logW.Count)): $o3 | $s3"
  # j. attempt 5 (structural; tester t-rw-p6a-4, A3-4 / bar c): ONE combining mark in the key or the
  # mailto - U+0301, which NFKC composes into a letter (attempt 4 kept it), after every character, in the
  # mailto, and U+0332 (no merged form) - fresh, then a row rewritten with one; and a dead reference
  # whose SOURCE RECORD title holds the mailto (the 422 body withholds it)
  Write-Host '  [5j] attempt 5: a combining mark in the key or the mailto, fresh and cached; the 422 body of a dead reference'
  $null = StubPost '/_reset'
  $ok = $true
  foreach ($f in @('md', 'txt', 'docx', 'pdf')) {
    $o = Export $wbName 'notes/p6a/combining-key.md' $f "combining-key.$f.json"
    $sj = Client @('secret', "/ev/exports/combining-key.$f.json", $oaKey, $mailto)
    if (($o -notmatch '^status 422 ') -or ($sj -notmatch '^PASS')) { $ok = $false; Fail "combining-key $f export: $o | $sj" }
  }
  $r = Client @('refused', '/ev/exports/combining-key.pdf.json', '4', 'OpenAlex returned a record carrying credential-shaped text (refused)')
  $o2 = Psql "SELECT count(*) FROM public.reference_resolutions rr JOIN public.reference_records r ON r.id = rr.reference_id WHERE r.source_id::text BETWEEN 'f6a00000-0000-4000-8000-000000000128' AND 'f6a00000-0000-4000-8000-000000000131'"
  $o3 = Export $wbName 'notes/p6a/combining-key.md' 'txt' 'combining-key.copy.txt' '&mode=copy'
  $s3 = Client @('secret', '/ev/exports/combining-key.copy.txt', $oaKey, $mailto)
  Save 'combining-key.log' "$r`ncached rows: $($o2.Trim())`n$o3`n$s3"
  Write-Host ($r -split "`n" | ForEach-Object { "        $_" } | Out-String).TrimEnd()
  Check ($ok -and ($r -match '^PASS')) 'A5 / A3-4: the four combining-mark records (K with U+0301 once, after every character, M with U+0301, K with U+0332) are refused fresh in MD, TXT, DOCX and PDF: 422, each named credential-shaped, no body carries either secret (as written or to a reader)'
  Check ($o2.Trim() -eq '0') "A5 / A3-4: none of the four is cached ($($o2.Trim()) rows)"
  Check (($o3 -match '^status 200 ') -and ($s3 -match '^PASS')) "A5 / A3-4: the Copy page of the note answers 200 and carries neither secret: $o3 | $s3"
  # cached: resolved clean, then the row rewritten as attempt 4 would have stored it (U+0301 inside)
  $o = Export $wbName 'notes/p6a/combining-cached.md' 'txt' 'combining-cached.first.txt'
  $u = Psql "UPDATE public.reference_resolutions rr SET csl = jsonb_set(jsonb_set(rr.csl, '{title}', to_jsonb(('Cached ' || left('$oaKey', 6) || chr(769) || substr('$oaKey', 7) || ' title')::text)), '{author}', jsonb_build_array(jsonb_build_object('literal', replace('$mailto', '@e', '@e' || chr(769))))) FROM public.reference_records r WHERE r.id = rr.reference_id AND r.source_id = 'f6a00000-0000-4000-8000-000000000132' RETURNING rr.via"
  $null = StubPost '/_reset'
  $ok = ($o -match '^status 200 ') -and ($u.Trim() -eq 'openalex')
  if (-not $ok) { Fail "combining-cached: the clean first export or the rewrite: $o | rewritten: $u" }
  foreach ($f in @('md', 'txt', 'docx', 'pdf')) {
    $o = Export $wbName 'notes/p6a/combining-cached.md' $f "combining-cached.$f.json"
    $j = [System.IO.File]::ReadAllText((Join-Path $out "combining-cached.$f.json"))
    $sj = Client @('secret', "/ev/exports/combining-cached.$f.json", $oaKey, $mailto)
    if (($o -notmatch '^status 422 ') -or ($j -notmatch 'cached record carries credential-shaped text') -or ($sj -notmatch '^PASS')) { $ok = $false; Fail "combining-cached $f export: $o $j" }
  }
  $o3 = Export $wbName 'notes/p6a/combining-cached.md' 'txt' 'combining-cached.copy.txt' '&mode=copy'
  $s3 = Client @('secret', '/ev/exports/combining-cached.copy.txt', $oaKey, $mailto)
  $logC = @(StubLog 'stub-log-combining-cached.json' | ForEach-Object { $_ })
  Save 'combining-cached.log' "rewritten: $($u.Trim())`n$o3`n$s3`nrequests after the rewrite: $($logC.Count)"
  Check $ok 'A5 / A3-4: a cached row holding the key with U+0301 inside it and the mailto with U+0301 is refused in MD, TXT, DOCX and PDF: 422 naming the cached record, no body carries either secret'
  Check (($o3 -match '^status 200 ') -and ($s3 -match '^PASS') -and ($logC.Count -eq 0)) "A5 / A3-4: its Copy page answers 200 and carries neither secret; no request was made ($($logC.Count)): $o3 | $s3"
  # the 422 body: two dead references whose source records hold the mailto (as written; with U+0301)
  $u = Psql "UPDATE public.sources SET title = CASE id::text WHEN 'f6a00000-0000-4000-8000-000000000133' THEN 'Contact ' || '$mailto' || ' for the data' ELSE 'Contact ' || replace('$mailto', '@e', '@e' || chr(769)) || ' for the data' END WHERE id::text IN ('f6a00000-0000-4000-8000-000000000133', 'f6a00000-0000-4000-8000-000000000134') RETURNING id"
  $ok = (@($u -split "`n" | Where-Object { $_.Trim() }).Count -eq 2)
  if (-not $ok) { Fail "dead-secret: the source titles were not set: $u" }
  foreach ($f in @('md', 'txt', 'docx', 'pdf')) {
    $o = Export $wbName 'notes/p6a/dead-secret.md' $f "dead-secret.$f.json"
    $j = [System.IO.File]::ReadAllText((Join-Path $out "dead-secret.$f.json"))
    $sj = Client @('secret', "/ev/exports/dead-secret.$f.json", $oaKey, $mailto)
    if (($o -notmatch '^status 422 ') -or ($j -notmatch 'withheld') -or ($sj -notmatch '^PASS')) { $ok = $false; Fail "dead-secret $f export: $o | $sj" }
  }
  Save 'dead-secret.log' "sources: $($u -replace "`n", ' ')`n$([System.IO.File]::ReadAllText((Join-Path $out 'dead-secret.txt.json')))"
  Check $ok 'A5 (near-miss 1): a dead reference whose source record title holds the mailto (as written, or with U+0301) is refused 422 in MD, TXT, DOCX and PDF with that title withheld; no body carries either secret'
  # N3: a real PNG at ../x.png (the vault's notes/x.png) and at .hidden/x.png: only the guard keeps them out
  $o = Export $wbName 'notes/p6a/image-traversal.md' 'docx' 'image-traversal.docx'
  $o2 = Export $wbName 'notes/p6a/image-traversal.md' 'pdf' 'image-traversal.pdf'
  $media = -1
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $out 'image-traversal.docx'))
    $media = @($zip.Entries | Where-Object { $_.FullName -like 'word/media/*' }).Count
    $zip.Dispose()
  } catch { $media = -1 }
  Save 'image-traversal.log' "$o`n$o2`nmedia parts in the DOCX: $media"
  Check (($o -match '^status 200 ') -and ($o2 -match '^status 200 ') -and ($media -eq 1)) "A4-N3: ![up](../x.png) and ![hid](.hidden/x.png), real PNGs, are not embedded; img/ok.png is (DOCX: $media media part(s); PDF: $o2)"
  # N4: relative links and anchors are rendered as their text, 200 in every format
  $ok = $true
  foreach ($f in @('md', 'txt', 'docx', 'pdf')) {
    $o = Export $wbName 'notes/p6a/relative-links.md' $f "relative-links.$f"
    if ($o -notmatch '^status 200 ') { $ok = $false; Fail "relative-links $f export: $o" }
  }
  $md = [System.IO.File]::ReadAllText((Join-Path $out 'relative-links.md'))
  $o = Client @('structure', '/ev/exports/relative-links.md', '/ev/exports/relative-links.docx', '/ev/exports/relative-links.pdf', '/ev/exports/relative-links.txt')
  $structRc = $script:rc
  Save 'relative-links.log' $o
  Check ($ok -and ($structRc -eq 0) -and ($md -notmatch '\]\((notes/other\.md|#part|\.\./up\.md)\)') -and ($md -match 'the other note') -and ($md -match '\]\(https://example\.org/s\)')) 'A4-N4: a relative link and an anchor are rendered as their text in MD, TXT, DOCX and PDF (200; the http link stays a link)'
  # N7: a control character is refused before typesetting, 422 glyphs, named
  $o = Export $wbName 'notes/p6a/control-char.md' 'pdf' 'control-char.json'
  $j = [System.IO.File]::ReadAllText((Join-Path $out 'control-char.json'))
  Save 'control-char.log' "$o`n$j"
  Check (($o -match '^status 422 ') -and ($j -match '"code":"glyphs"') -and ($j -match 'U\+0007')) "A4-N7: a control character (U+0007) is refused 422 glyphs before typesetting, named: $o"
  # near-miss 1: pathological nesting refused before pandoc, fast
  foreach ($c in @(@('brackets', 'bracket nesting depth'), @('deep-list', 'list nesting depth'), @('stars', 'delimiter|parser'))) {
    $t0 = Get-Date
    $o = Export $wbName "notes/p6a/$($c[0]).md" 'pdf' "$($c[0]).json"
    $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
    $j = [System.IO.File]::ReadAllText((Join-Path $out "$($c[0]).json"))
    Save "$($c[0]).log" "$o`n$j`n$secs s"
    Check (($o -match '^status 422 ') -and ($j -match '"code":"too-complex"') -and ($j -match $c[1]) -and ($secs -lt 30)) "A3 / near-miss 1: $($c[0]).md is refused 422 too-complex ($($c[1])) in $secs s (attempt 2 held pandoc 180 s)"
  }
  # nothing went direct, and no workbench log carries a secret
  $null = Client @('get', "http://${catchName}:8080/_log", '/ev/catcher-log.json')
  # (PS 5.1: ConvertFrom-Json emits a JSON array as ONE object; unroll it, or '[]' counts as 1)
  $caught = @((Get-Content -Raw (Join-Path $Evidence 'catcher-log.json') | ConvertFrom-Json) | ForEach-Object { $_ })
  Check ($caught.Count -eq 0) "the direct catcher received $($caught.Count) requests over the whole run (nothing skipped the proxy, nothing followed a redirect)"
  $logs = Dk logs $wbName
  Check (($logs -notmatch [regex]::Escape($oaKey)) -and ($logs -notmatch [regex]::Escape($mailto))) 'the main workbench log carries neither the key nor the mailto'
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
  Check (-not (Compare-Object $localBefore $localAfter)) 'no :local image changed'
}
Write-Host "evidence: $Evidence"
if ($script:fail) { Write-Host "$($script:fail) check(s) FAILED"; exit 1 }
Write-Host 'all checks passed'
exit 0
