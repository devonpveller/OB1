# run-mcp-identity-deploy-lab.ps1 - rw-mcp-identity round 2 (tester attempt 1, F4 / F6): the live deploy's image, network,
# key and Open WebUI-connection steps, and their ROLLBACK, rehearsed in a disposable lab.
#
#   powershell -NoProfile -File OB1\integrations\kubernetes-deployment\mcp-identity-lab\run-mcp-identity-deploy-lab.ps1 -Subnet <x.y.z.0/24> [-Evidence <dir>] [-PreSha 5ca84f5]
#
# Stand-ins (lab only): ":<id>-local" plays the live ":local" tag (the shim refuses a real :local), "<net>" plays
# open-brain_obnet and "<net>-llm" plays ai-stack_llm-net (both --internal, on the pinned /24's two halves). -PreSha is the
# tree the live images were built from (development's gitlink before this item).
#
#   1  pre images built from -PreSha, tagged :<id>-local (what live runs today)
#   2  F4: BEFORE any rebuild, :<id>-local is tagged :<id>-pre-rw-mcp-identity (the image ids must match)
#   3  the new images are built from this tree and tagged :<id>-local; :<id>-pre-rw-mcp-identity still points at the old ids
#   4  deploy: openbrain-mcp on both networks, openbrain-ext on both (the new compose); the OWUI lane answers, the full lane is
#      the operator; Open WebUI's tool-server config is BACKED UP (GET), then switched to the native MCP connections (POST)
#   5  F6: openbrain-mcpo-ext's config gets MCP_PERSONAL_ACCESS_KEY instead of MCP_ACCESS_KEY (a script that reads key NAMES and
#      never prints a value); mcpo-ext still serves its tools, with no identity, and its config holds no full key
#   6  ROLLBACK: :<id>-pre-rw-mcp-identity is tagged back to :<id>-local; both servers are recreated from it with the OLD network
#      set (openbrain-ext on obnet only); the backed-up Open WebUI config is POSTed back and read back equal
#   7  after the rollback: the running images are the pre ids, openbrain-ext is not on the llm-net stand-in, the old behaviour
#      is back (no OWUI lane: its key is 401; the personal lane reads as before), and Open WebUI's config is the backup
param(
  [string]$Id = 'wt-rw-mcp-identity',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$OwuiImage = 'ghcr.io/open-webui/open-webui:v0.11.0',
  [string]$PreSha = '5ca84f5'
)
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$kd = Split-Path -Parent $here
$ob1 = Split-Path -Parent (Split-Path -Parent $kd)
$dockerDir = Join-Path $ob1 'docker'
. (Join-Path $dockerDir 'workbench\contract-test\harness-subnet.ps1')
$w = Test-HarnessSubnet $Subnet
if ($w) { Write-Host "REFUSED: $w"; exit 2 }
$subnets = Split-HarnessSubnet $Subnet
if ($Evidence -and (Test-Path $Evidence) -and @(Get-ChildItem -Force $Evidence).Count) { Write-Host "REFUSED: -Evidence $Evidence is not empty"; exit 2 }
$label = "ai-stack.harness.owner=$Id"
$tag = $Id
function Rnd([int]$n) { -join (1..$n | ForEach-Object { '0123456789abcdef'[(Get-Random -Maximum 16)] }) }
$P = "rwmd-$(Rnd 6)"
$net = "$P-net"; $net2 = "$P-net-llm"
$pw = Rnd 16; $appPw = Rnd 16
$K = @{ full = "full-$(Rnd 40)"; personal = "pers-$(Rnd 40)"; owui = "owui-$(Rnd 40)"; mcpo = "mcpo-$(Rnd 24)" }
$subA = "ak-op-$(Rnd 12)"
$iss = 'https://auth.lab.invalid/application/o/open-webui/'; $clientId = 'owui-lab-client'; $clientSecret = Rnd 20
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"; $state = Join-Path $env:TEMP "$P-state"
New-Item -ItemType Directory -Force $stage, $state | Out-Null
$script:fail = 0
$script:made = @{ nets = @(); containers = @(); dirs = @($stage, $state); images = @() }
function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false)) }
function Redact([string]$t) { $o = $t; foreach ($v in @($K.full, $K.personal, $K.owui, $K.mcpo, $pw, $appPw, $clientSecret)) { $o = $o.Replace($v, '<redacted>') }; return ($o -replace 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*', '<jwt>') }

function Test-LabDockerArgs([string[]]$a) {
  $all = ($a -join ' ')
  if ($a.Count -and $a[0] -eq 'compose') { return 'docker compose is never used by the lab' }
  if ($all -match '192\.168\.') { return 'a 192.168.x address' }
  if ($all -match '(^|[\s=:/])(ai-stack_|open-brain_)') { return 'an ai-stack_* / open-brain_* name' }
  for ($i = 0; $i -lt $a.Count; $i++) {
    $x = $a[$i]
    if ($x -match '^(-p|-P|--publish|--publish-all)$' -or $x -match '^--publish(-all)?=' -or $x -match '^-p\d') { return "a published port ($x)" }
    if ($x -match '^--net(work)?$' -and $a[0] -ne 'build') { $v = $a[$i + 1]; if ($v -notin @($net, $net2, 'none')) { return "network '$v' is not this run's" } }
    if ($x -match '(^|[/=])[^ ]*:local$' -and $a[0] -notin @('images', 'image')) { return "a :local image ($x)" }
  }
  if ($all -match 'macvlan|ipvlan') { return 'a macvlan / ipvlan driver' }
  if ($a.Count -ge 2 -and $a[0] -eq 'network' -and $a[1] -eq 'create') {
    if ($a -notcontains '--internal') { return 'a network that is not --internal' }
    if (($a -join ' ') -notmatch ("--subnet (" + [regex]::Escape($subnets.run) + "|" + [regex]::Escape($subnets.smoke) + ")")) { return 'a network not on the pinned subnet' }
  }
  if ($a.Count -and $a[0] -eq 'network' -and $a[1] -in @('connect', 'disconnect') -and $a[2] -notin @($net, $net2)) { return 'a network that is not this run''s' }
  if ($a.Count -and $a[0] -eq 'build') {
    $ti = [array]::IndexOf($a, '-t')
    if ($ti -lt 0 -or $a[$ti + 1] -notmatch "^[a-z0-9._/-]+:$([regex]::Escape($tag))(-[a-z0-9-]+)?$") { return "a build tag that is not :$tag[-suffix]" }
    if ($a -notcontains '--label') { return 'an unlabelled build' }
  }
  if ($a.Count -ge 3 -and $a[0] -eq 'tag' -and ($a[1] + ' ' + $a[2]) -notmatch "^\S+:$([regex]::Escape($tag))(-[a-z0-9-]+)? \S+:$([regex]::Escape($tag))(-[a-z0-9-]+)?$") { return 'a tag outside this run''s :<id>-* names' }
  return ''
}
function Lab-Docker([int]$TimeoutSec, [string[]]$a) {
  $why = Test-LabDockerArgs $a
  if ($why) { Write-Host "  SHIM REFUSED: $why :: docker $($a[0]) ..."; $script:rc = 2; $script:fail++; return "REFUSED: $why" }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'docker'
  $psi.Arguments = ($a | ForEach-Object { if ($_ -match '[\s"]' -or $_ -eq '') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { try { $p.Kill() } catch { }; $script:rc = 124; return "TIMEOUT after ${TimeoutSec}s" }
  $p.WaitForExit(); $script:rc = $p.ExitCode
  return (($out.Result + $err.Result) -replace "`r", '').TrimEnd()
}
function Dk { Lab-Docker 300 ([string[]]$args) }
$shimCases = @(@('run', '-p', '8080:8080', 'x'), @('run', '--network', 'ai-stack_llm-net', 'x'), @('run', 'x:local'), @('compose', 'up'), @('tag', 'openbrain-mcp-server:local', 'openbrain-mcp-server:pre-rw-mcp-identity'))
Check (@($shimCases | Where-Object { Test-LabDockerArgs $_ }).Count -eq $shimCases.Count) 'the lab docker shim refuses every forbidden shape (incl. tagging a real :local)'
$localBefore = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim()
function Run-Detached([string]$name, [string[]]$extra) {
  $o = Dk run -d --name $name --label $label --network $net @extra
  if ($script:rc -ne 0) { Fail "$name did not start: $(Redact $o)"; return $false }
  $script:made.containers += $name; return $true
}
function ImgId([string]$img) { (Dk image inspect -f '{{.Id}}' $img).Trim() }
function Nets([string]$c) { (Dk inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' $c).Trim() }
function KeyStatus([string]$c, [string]$key) {
  $probe = "const r = await fetch('http://127.0.0.1:8000/', {method: 'POST', headers: {'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'x-brain-key': '$key'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'lab', version: '1'}}})}); console.log('status', r.status); Deno.exit(0)"
  for ($i = 0; $i -lt 45; $i++) { $o = Dk exec $c deno eval $probe; if ($o -match 'status (\d+)') { return [int]$Matches[1] }; Start-Sleep -Seconds 2 }
  return 0
}
$mcpImg = "openbrain-mcp-server:$tag-local"; $extImg = "openbrain-ext-server:$tag-local"
$mcpPre = "openbrain-mcp-server:$tag-pre-rw-mcp-identity"; $extPre = "openbrain-ext-server:$tag-pre-rw-mcp-identity"
$mcpoImg = "openbrain-mcpo:$tag-mcpo"

try {
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  Write-Host "== rw-mcp-identity DEPLOY lab  owner=$Id  pre=$PreSha  tree=$sha  evidence=$Evidence"
  Write-Host '[1] the pre images (what live runs), tagged as the :local stand-in'
  $pre = Join-Path $env:TEMP "$P-pre"; New-Item -ItemType Directory -Force $pre | Out-Null; $script:made.dirs += $pre
  $tar = Join-Path $env:TEMP "$P-pre.tar"
  & git -C $ob1 archive --format=tar -o $tar $PreSha docker/extensions-server integrations/kubernetes-deployment
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $tar -C $pre; Remove-Item -Force $tar
  foreach ($b in @(@($mcpImg, (Join-Path $pre 'integrations\kubernetes-deployment')), @($extImg, (Join-Path $pre 'docker\extensions-server')), @($mcpoImg, (Join-Path $dockerDir 'mcpo')))) {
    $o = Lab-Docker 1200 @('build', '-t', $b[0], '--label', $label, $b[1]); Check ($script:rc -eq 0) "built $($b[0])"; $script:made.images += $b[0]
  }
  $preMcpId = ImgId $mcpImg; $preExtId = ImgId $extImg

  Write-Host '[2] F4: tag the running images as :pre-rw-mcp-identity BEFORE any rebuild'
  $null = Dk tag $mcpImg $mcpPre; $null = Dk tag $extImg $extPre
  $script:made.images += @($mcpPre, $extPre)
  Check ((ImgId $mcpPre) -eq $preMcpId -and (ImgId $extPre) -eq $preExtId) 'the pre tags name exactly the running images'

  Write-Host '[3] the new images from this tree, tagged :local (the deliberate rebuild)'
  $o = Lab-Docker 1200 @('build', '-t', $mcpImg, '--label', $label, $kd); Check ($script:rc -eq 0) "rebuilt $mcpImg from $sha"
  $o = Lab-Docker 1200 @('build', '-t', $extImg, '--label', $label, (Join-Path $dockerDir 'extensions-server')); Check ($script:rc -eq 0) "rebuilt $extImg"
  $newMcpId = ImgId $mcpImg; $newExtId = ImgId $extImg
  Check ($newMcpId -ne $preMcpId -and (ImgId $mcpPre) -eq $preMcpId -and (ImgId $extPre) -eq $preExtId) 'the rebuild moved :local; the pre tags still hold the old images'

  Write-Host '[4] deploy: the new servers on the new network set; Open WebUI switched to the native connections'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  foreach ($m in $rx.Matches($compose)) { Copy-Item (Join-Path $dockerDir $m.Groups[1].Value) (Join-Path $stage $m.Groups[2].Value) }
  foreach ($n in @(@($net, $subnets.run), @($net2, $subnets.smoke))) {
    $null = Dk network create --driver bridge --internal --subnet $n[1] --label $label $n[0]; Check ($script:rc -eq 0) "network $($n[0]) (internal, $($n[1]))"; if ($script:rc -eq 0) { $script:made.nets += $n[0] }
  }
  $db = "$P-db"
  if (-not (Run-Detached $db @('--network-alias', 'openbrain-db', '-e', "POSTGRES_PASSWORD=$pw", '-e', 'POSTGRES_DB=openbrain', '-v', "${stage}:/docker-entrypoint-initdb.d", $PgImage))) { throw 'db' }
  for ($i = 0; $i -lt 150; $i++) { if ((Dk logs $db) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $null = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -c "CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role"
  Check ($script:rc -eq 0) 'the database and the app role'
  # the stub provider (its JWKS for the new servers) and Open WebUI (its tool-server config is what the rollback restores)
  $users = @{ a = @{ sub = $subA; email = 'a@lab.invalid'; name = 'Lab A' } } | ConvertTo-Json -Compress
  $stub = "$P-stubs"
  $null = Run-Detached $stub @('--network-alias', 'stub-oidc', '--network-alias', 'stub-llm', '-e', "LAB_ISS=$iss", '-e', "LAB_CLIENT_ID=$clientId", '-e', "LAB_CLIENT_SECRET=$clientSecret", '-e', "LAB_USERS=$users",
      '-v', "${here}:/lab:ro", '-v', "${state}:/state", '--entrypoint', 'python', $OwuiImage, '/lab/stubs.py')
  $jwks = ''; for ($i = 0; $i -lt 60; $i++) { $jwks = Dk exec $stub cat /tmp/jwks.json; if ($jwks -match '"keys"') { break }; Start-Sleep -Seconds 2 }
  $common = @('-e', 'DB_HOST=openbrain-db', '-e', 'DB_USER=ob_app_memory', '-e', "DB_PASSWORD=$appPw", '-e', "MCP_ACCESS_KEY=$($K.full)", '-e', "MCP_PERSONAL_ACCESS_KEY=$($K.personal)",
    '-e', "WORKSPACE_DEFAULT_SUB=$subA", '-e', 'PORT=8000', '-e', "DEFAULT_USER_ID=$([guid]::NewGuid())")
  $lane = @('-e', "MCP_OWUI_ACCESS_KEY=$($K.owui)", '-e', "MCP_OWUI_OIDC_ISSUER=$iss", '-e', "MCP_OWUI_OIDC_AUDIENCE=$clientId", '-e', "MCP_OWUI_OIDC_JWKS=$jwks")
  $mcp = "$P-mcp"; $ext = "$P-ext"
  function Start-Servers([bool]$new) {
    $null = Run-Detached $mcp (@('--network-alias', 'openbrain-mcp') + $common + $(if ($new) { $lane } else { @() }) + @($mcpImg))
    $null = Dk network connect $net2 $mcp   # openbrain-mcp is on llm-net before and after
    $null = Run-Detached $ext (@('--network-alias', 'openbrain-ext') + $common + $(if ($new) { $lane } else { @() }) + @($extImg))
    if ($new) { $null = Dk network connect $net2 $ext }   # the new compose: openbrain-ext also on llm-net
  }
  Start-Servers $true
  Check ((KeyStatus $mcp $K.owui) -eq 200 -and (KeyStatus $ext $K.owui) -eq 200) 'new: the OWUI lane answers on both servers'
  Check ((KeyStatus $mcp $K.full) -eq 200) 'new: the full lane answers'
  Check ((Nets $ext) -match [regex]::Escape($net2)) "new: openbrain-ext is on the llm-net stand-in ($(Nets $ext))"
  $owui = "$P-owui"
  $oldConns = @(@{ type = 'openapi'; url = 'http://openbrain-mcpo:8000/open-brain'; path = 'openapi.json'; auth_type = 'bearer'; key = $K.mcpo; config = @{ enable = $true }; info = @{ id = 'open-brain-mcpo'; name = 'Open Brain (mcpo)' } }) | ConvertTo-Json -Depth 6 -Compress
  if ($oldConns -notmatch '^\[') { $oldConns = "[$oldConns]" }
  $null = Run-Detached $owui @('--network-alias', 'owui', '-e', "WEBUI_SECRET_KEY=$(Rnd 24)", '-e', 'OFFLINE_MODE=true', '-e', 'HF_HUB_OFFLINE=1', '-e', 'ENABLE_OLLAMA_API=false', '-e', 'ENABLE_OPENAI_API=false',
      '-e', 'RAG_EMBEDDING_ENGINE=openai', '-e', 'ENABLE_WEB_SEARCH=false', '-e', "OAUTH_CLIENT_ID=$clientId", '-e', "OAUTH_CLIENT_SECRET=$clientSecret",
      '-e', 'OPENID_PROVIDER_URL=http://stub-oidc:8080/application/o/open-webui/.well-known/openid-configuration', '-e', 'ENABLE_OAUTH_SIGNUP=true', '-e', 'ENABLE_LOGIN_FORM=false',
      '-e', 'AUTHLIB_INSECURE_TRANSPORT=1', '-e', 'WEBUI_URL=http://owui:8080', '-e', "TOOL_SERVER_CONNECTIONS=$oldConns", $OwuiImage)
  $hs = ''; for ($i = 0; $i -lt 90; $i++) { $hs = Dk inspect -f '{{.State.Health.Status}}' $owui; if ($hs -eq 'healthy') { break }; Start-Sleep -Seconds 4 }
  Check ($hs -eq 'healthy') "Open WebUI is healthy ($hs)"
  $newConns = @(@{ type = 'mcp'; url = 'http://openbrain-mcp:8000/'; path = ''; auth_type = 'system_oauth'; key = ''; headers = @{ 'x-brain-key' = '<lane key>' }; config = @{ enable = $true }; info = @{ id = 'open-brain'; name = 'Open Brain' } }) | ConvertTo-Json -Depth 6 -Compress
  if ($newConns -notmatch '^\[') { $newConns = "[$newConns]" }
  [System.IO.File]::WriteAllText((Join-Path $state 'new-conns.json'), $newConns, (New-Object System.Text.UTF8Encoding $false))
  $owuiPy = @'
import json, sys, requests, urllib.parse
O = "http://owui:8080"
s = requests.Session()
r = s.get(f"{O}/oauth/oidc/login", allow_redirects=False, timeout=30); loc = r.headers["location"]
r = s.get(loc + "&lab_user=a", allow_redirects=False, timeout=30)
r = s.get(r.headers["location"], allow_redirects=False, timeout=60)
s.headers["authorization"] = "Bearer " + s.cookies.get("token")
step = sys.argv[1]
if step == "backup":
    c = s.get(f"{O}/api/v1/configs/tool_servers", timeout=30).json()
    json.dump(c, open("/state/owui-tool-servers.backup.json", "w")); print("backed up", len(c["TOOL_SERVER_CONNECTIONS"]), [x.get("type") for x in c["TOOL_SERVER_CONNECTIONS"]])
elif step == "switch":
    new = json.load(open("/state/new-conns.json"))
    r = s.post(f"{O}/api/v1/configs/tool_servers", json={"TOOL_SERVER_CONNECTIONS": new}, timeout=60); print("switch", r.status_code)
    c = s.get(f"{O}/api/v1/configs/tool_servers", timeout=30).json(); print("now", [x.get("type") for x in c["TOOL_SERVER_CONNECTIONS"]])
elif step == "restore":
    b = json.load(open("/state/owui-tool-servers.backup.json"))
    r = s.post(f"{O}/api/v1/configs/tool_servers", json=b, timeout=60); print("restore", r.status_code)
    c = s.get(f"{O}/api/v1/configs/tool_servers", timeout=30).json()
    same = [ (x.get("type"), x.get("url"), (x.get("info") or {}).get("id")) for x in c["TOOL_SERVER_CONNECTIONS"] ] == [ (x.get("type"), x.get("url"), (x.get("info") or {}).get("id")) for x in b["TOOL_SERVER_CONNECTIONS"] ]
    print("restored-equal", same)
'@
  [System.IO.File]::WriteAllText((Join-Path $state 'owui_conf.py'), $owuiPy, (New-Object System.Text.UTF8Encoding $false))
  $py = @('run', '--rm', '--label', $label, '--network', $net, '-v', "${state}:/state", '--entrypoint', 'python', $OwuiImage, '/state/owui_conf.py')
  $o = Lab-Docker 300 ($py + 'backup'); Save 'owui-backup.log' (Redact $o); Check ($o -match "backed up 1 \['openapi'\]") "the Open WebUI tool-server config is backed up before the switch ($((Redact $o) -replace "`n", ' '))"
  $o = Lab-Docker 300 ($py + 'switch'); Save 'owui-switch.log' (Redact $o); Check ($o -match "switch 200" -and $o -match "now \['mcp'\]") 'switched to the native MCP connection'

  Write-Host '[5] F6: openbrain-mcpo-ext loses MCP_ACCESS_KEY (the personal key instead; names read, values never printed)'
  $envFile = Join-Path $state 'ob1.env'
  [System.IO.File]::WriteAllText($envFile, "MCP_ACCESS_KEY=$($K.full)`nMCP_PERSONAL_ACCESS_KEY=$($K.personal)`n", (New-Object System.Text.UTF8Encoding $false))
  $cfgFile = Join-Path $state 'mcpo-ext.config.json'
  $cfgOld = @{ mcpServers = @{ 'open-brain-extensions' = @{ type = 'streamable-http'; url = 'http://openbrain-ext:8000/'; headers = @{ 'x-brain-key' = $K.full } } } } | ConvertTo-Json -Depth 5 -Compress
  [System.IO.File]::WriteAllText($cfgFile, $cfgOld, (New-Object System.Text.UTF8Encoding $false))
  # the runbook's swap, verbatim (scripts its own: reads the key from the .env by NAME, writes the config, prints only names)
  $swap = Join-Path $dockerDir 'mcpo\swap-ext-key.py'
  $o = & python -I $swap --env $envFile --config $cfgFile 2>&1 | Out-String
  Save 'swap.log' (Redact $o)
  $after = Get-Content -Raw $cfgFile
  Check ($o -notmatch [regex]::Escape($K.full) -and $o -notmatch [regex]::Escape($K.personal)) 'the swap printed no key value'
  Check ($after -notmatch [regex]::Escape($K.full) -and $after -match [regex]::Escape($K.personal)) 'mcpo-ext''s config holds the personal key and no full key'
  $mcpoExt = "$P-mcpo-ext"
  $null = Run-Detached $mcpoExt @('--network-alias', 'openbrain-mcpo-ext', '-v', "${state}:/state", $mcpoImg, '--config', '/state/mcpo-ext.config.json', '--host', '0.0.0.0', '--port', '8000', '--api-key', $K.mcpo)
  $paths = 0
  for ($i = 0; $i -lt 60; $i++) { $o = Dk exec $mcpoExt python -c "import json,urllib.request; r=urllib.request.Request('http://127.0.0.1:8000/open-brain-extensions/openapi.json', headers={'authorization':'Bearer $($K.mcpo)'}); print('paths', len(json.load(urllib.request.urlopen(r, timeout=8)).get('paths',{})))"; if ($o -match 'paths (\d+)' -and [int]$Matches[1] -gt 0) { $paths = [int]$Matches[1]; break }; Start-Sleep -Seconds 3 }
  Check ($paths -gt 0) "mcpo-ext still serves its tools on the personal key ($paths paths)"
  $o = Dk exec $mcpoExt python -c "import json,urllib.request; r=urllib.request.Request('http://127.0.0.1:8000/open-brain-extensions/get_upcoming_dates', data=b'{}', headers={'authorization':'Bearer $($K.mcpo)','content-type':'application/json'});
try:
    print(urllib.request.urlopen(r, timeout=30).read().decode()[:300])
except Exception as e:
    print('error', getattr(e, 'code', ''), e.read().decode()[:300] if hasattr(e, 'read') else e)"
  Save 'mcpo-ext-call.log' (Redact $o)
  Check ($o -match 'no verified user identity|has no rows') 'through mcpo-ext a personal tool has no identity (refused)'

  Write-Host '[6] ROLLBACK'
  foreach ($c in @($mcp, $ext)) { $null = Dk rm -f -v $c; $script:made.containers = @($script:made.containers | Where-Object { $_ -ne $c }) }
  $null = Dk tag $mcpPre $mcpImg; $null = Dk tag $extPre $extImg
  Check ((ImgId $mcpImg) -eq $preMcpId -and (ImgId $extImg) -eq $preExtId) 'the pre tags are back on :local'
  Start-Servers $false
  $o = Lab-Docker 300 ($py + 'restore'); Save 'owui-restore.log' (Redact $o); Check ($o -match 'restore 200' -and $o -match 'restored-equal True') 'Open WebUI''s old tool-server config is restored and reads back equal'
  # mcpo-ext: the pre openbrain-ext accepts only MCP_ACCESS_KEY, so the rollback puts it back (the swap script's --restore)
  $o = & python -I $swap --env $envFile --config $cfgFile --restore 2>&1 | Out-String
  Save 'swap-restore.log' (Redact $o)
  Check ($o -notmatch [regex]::Escape($K.full) -and (Get-Content -Raw $cfgFile) -match [regex]::Escape($K.full)) 'the rollback puts MCP_ACCESS_KEY back in mcpo-ext''s config (nothing printed)'
  $null = Dk rm -f -v $mcpoExt
  $null = Run-Detached $mcpoExt @('--network-alias', 'openbrain-mcpo-ext', '-v', "${state}:/state", $mcpoImg, '--config', '/state/mcpo-ext.config.json', '--host', '0.0.0.0', '--port', '8000', '--api-key', $K.mcpo)

  Write-Host '[7] after the rollback'
  $runMcp = (Dk inspect -f '{{.Image}}' $mcp).Trim(); $runExt = (Dk inspect -f '{{.Image}}' $ext).Trim()
  Check ($runMcp -eq $preMcpId -and $runExt -eq $preExtId) 'both servers run the pre images'
  Check ((Nets $ext) -notmatch [regex]::Escape($net2)) "openbrain-ext is off the llm-net stand-in ($(Nets $ext))"
  Check ((KeyStatus $mcp $K.owui) -eq 401) 'the old behaviour: no OWUI lane (its key is 401)'
  Check ((KeyStatus $mcp $K.personal) -eq 200 -and (KeyStatus $mcp $K.full) -eq 200) 'the old behaviour: the personal and the full lanes answer'
  $paths = 0
  for ($i = 0; $i -lt 60; $i++) { $o = Dk exec $mcpoExt python -c "import json,urllib.request; r=urllib.request.Request('http://127.0.0.1:8000/open-brain-extensions/openapi.json', headers={'authorization':'Bearer $($K.mcpo)'}); print('paths', len(json.load(urllib.request.urlopen(r, timeout=8)).get('paths',{})))"; if ($o -match 'paths (\d+)' -and [int]$Matches[1] -gt 0) { $paths = [int]$Matches[1]; break }; Start-Sleep -Seconds 3 }
  Check ($paths -gt 0) "the old behaviour: mcpo-ext serves the pre openbrain-ext again ($paths paths)"
  foreach ($c in @($mcp, $ext, $owui, $mcpoExt)) { Save "$c.log" (Redact (Dk logs $c)) }
}
catch { Fail "the run stopped: $($_.Exception.Message)" }
finally {
  Write-Host '== teardown'
  foreach ($c in $script:made.containers) { $null = Dk rm -f -v $c }
  foreach ($n in $script:made.nets) { $null = Dk network rm $n }
  foreach ($img in ($script:made.images | Select-Object -Unique)) { $null = Dk image rm -f $img }
  $left = Dk ps -a --filter "label=$label" --format '{{.Names}}'
  $leftNet = Dk network ls --filter "label=$label" --format '{{.Name}}'
  $leftImg = Dk images --filter "label=$label" --format '{{.Repository}}:{{.Tag}}'
  Check ([string]::IsNullOrWhiteSpace("$left$leftNet$leftImg")) "nothing labelled $Id is left (containers '$left', networks '$leftNet', images '$leftImg')"
  $localAfter = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim()
  $norm = { param($t) (($t -split "`n") | Sort-Object) -join "`n" }
  if ((& $norm $localBefore) -eq (& $norm $localAfter)) { Pass 'no :local image changed' } else { Write-Host '  WARN  a :local listing differs (this lab never touches one)' }
  foreach ($d in $script:made.dirs) { try { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } catch { } }
  Save 'summary.txt' "pre=$PreSha tree=$sha fail=$($script:fail)"
  if ($script:fail) { Write-Host "== FAIL ($($script:fail))"; exit 1 } else { Write-Host '== OK'; exit 0 }
}
