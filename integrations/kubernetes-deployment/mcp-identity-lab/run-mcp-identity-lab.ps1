# run-mcp-identity-lab.ps1 - the disposable lab for research-workbench rw-mcp-identity: every Open Brain read or write an
# Open WebUI user triggers through the MCP tools runs as that user.
#
#   powershell -NoProfile -File OB1\integrations\kubernetes-deployment\mcp-identity-lab\run-mcp-identity-lab.ps1 -Subnet <x.y.z.0/24> [-Evidence <dir>] [-Red] [-BaseSha 69a04a5] [-Cases T1,T4]
#
# -Red builds openbrain-mcp and openbrain-ext from -BaseSha (PD1's tree before this item) and wires Open WebUI the way the
# base allows (its native MCP connection holds the personal key; the extensions connection the full key, as mcpo-ext
# does today): every check that states the item's bar must FAIL there. Without -Red the images come from this working tree
# and every check must pass.
#
# Lab rules (as run-workspace-tests.ps1): one --internal network on the pinned subnet; images built only as
# :wt-rw-mcp-identity[-suffix] and labelled; no published port; no :local image (the shim refuses one - mcpo is built from
# OB1/docker/mcpo as a :wt tag); no ai-stack_* / open-brain_* name; synthetic seed data only; every container and image
# labelled ai-stack.harness.owner=<Id> and removed at the end, then a leftover check. Never touches the live stack; it starts
# no Open WebUI but its own (no tailscale shares its namespace).
#
# What runs (the REAL code where it exists):
#   openbrain-db       pgvector + the REAL initdb chain of docker-compose.yml (PD1's 440 included), ob_app_memory non-superuser
#   stubs              stubs.py: an OpenID provider standing in for Authentik (RS256 access tokens), a tool-calling model for
#                      Open WebUI, the llama-cpp / llama-cpp-embed alias stand-in (no inference) and a workbench recorder
#   openbrain-mcp      :wt-rw-mcp-identity (this tree) or -base
#   openbrain-ext      the same
#   openbrain-mcpo     mcpo v0.0.20 + anyio (OB1/docker/mcpo, the stack's Dockerfile) in front of openbrain-mcp (personal lane)
#   owui               Open WebUI v0.11.0 (the stack's base image), SSO through the stub, native MCP connections
#                      (system_oauth + the lane key) to openbrain-mcp and openbrain-ext
#   driver.py          signs A (first = admin = the operator's subject), B and C in through Open WebUI, removes C's SSO
#                      session, then runs the cases T0-T7 through Open WebUI's chat API, mcpo, and raw forged MCP calls
param(
  [string]$Id = 'wt-rw-mcp-identity',
  [string]$Subnet = '',
  [string]$Evidence = '',
  [string]$PgImage = 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
  [string]$OwuiImage = 'ghcr.io/open-webui/open-webui:v0.11.0',
  [string]$BaseSha = '69a04a5',
  [string]$Cases = '',
  [switch]$Red,
  # development only: leave the lab up after the run (the leftover check then fails; clean up by the label)
  [switch]$Keep
)
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "bad -Id '$Id'" }
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
$tag = $Id   # images are :wt-rw-mcp-identity[-suffix]
$rand = -join ((48..57 + 97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$P = "rwmi-$rand"
$net = "$P-net"
function Rnd([int]$n) { -join (1..$n | ForEach-Object { '0123456789abcdef'[(Get-Random -Maximum 16)] }) }
$pw = Rnd 16; $appPw = Rnd 16
$K = @{ full = "full-$(Rnd 40)"; personal = "pers-$(Rnd 40)"; owui = "owui-$(Rnd 40)"; mcpo = "mcpo-$(Rnd 24)" }
$subs = @{ a = "ak-op-$(Rnd 12)"; b = "ak-b-$(Rnd 12)"; c = "ak-c-$(Rnd 12)" }
$defaultUser = [guid]::NewGuid().ToString()
$iss = 'https://auth.lab.invalid/application/o/open-webui/'
$clientId = 'owui-lab-client'
$clientSecret = Rnd 20
$markers = @{}
foreach ($m in 'shared', 'a_thought', 'a_idea', 'a_ext', 'b_thought', 'b_idea', 'b_ext', 'c_thought', 'op_thought', 'op_memory', 'mcpo_thought') { $markers[$m] = "MK$($m.ToUpper() -replace '_','')$(Rnd 6)" }
if (-not $Evidence) { $Evidence = Join-Path $env:TEMP "$P-evidence" }
New-Item -ItemType Directory -Force $Evidence | Out-Null
$stage = Join-Path $env:TEMP "$P-initdb"
$state = Join-Path $env:TEMP "$P-state"
New-Item -ItemType Directory -Force $stage, $state | Out-Null
$script:fail = 0
$script:made = @{ net = $false; containers = @(); dirs = @($stage, $state); images = @() }

function Pass([string]$m) { Write-Host "  PASS  $m" }
function Fail([string]$m) { Write-Host "  FAIL  $m"; $script:fail++ }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }
function Save([string]$name, [string]$text) { [System.IO.File]::WriteAllText((Join-Path $Evidence $name), $text, (New-Object System.Text.UTF8Encoding $false)) }
function Redact([string]$t) { $o = $t; foreach ($v in @($K.full, $K.personal, $K.owui, $K.mcpo, $pw, $appPw, $clientSecret)) { $o = $o.Replace($v, '<redacted>') }; return ($o -replace 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*', '<jwt>') }

# -- the lab docker shim -----------------------------------------------------------------------------------------------
function Test-LabDockerArgs([string[]]$a) {
  $all = ($a -join ' ')
  if ($a.Count -and $a[0] -eq 'compose') { return 'docker compose is never used by the lab' }
  if ($all -match '192\.168\.') { return 'a 192.168.x address' }
  if ($all -match '(^|[\s=:/])(ai-stack_|open-brain_)') { return 'an ai-stack_* / open-brain_* name' }
  for ($i = 0; $i -lt $a.Count; $i++) {
    $x = $a[$i]
    if ($x -match '^(-p|-P|--publish|--publish-all)$' -or $x -match '^--publish(-all)?=' -or $x -match '^-p\d') { return "a published port ($x)" }
    if ($x -match '^--net(work)?$' -and $a[0] -ne 'build') { $v = $a[$i + 1]; if ($v -ne $net -and $v -ne 'none') { return "network '$v' is not this run's" } }
    if ($x -match '^--net(work)?=(.+)$') { if ($Matches[2] -ne $net -and $Matches[2] -ne 'none') { return "network '$($Matches[2])' is not this run's" } }
    if ($x -match '^(-d|--driver)$' -and $a[0] -eq 'network' -and $a[$i + 1] -match 'macvlan|ipvlan') { return 'a macvlan / ipvlan driver' }
    if ($x -match '(^|[/=])[^ ]*:local$' -and $a[0] -notin @('images', 'image')) { return "a :local image ($x)" }
  }
  if ($all -match 'macvlan|ipvlan') { return 'a macvlan / ipvlan driver' }
  if ($a.Count -ge 2 -and $a[0] -eq 'network' -and $a[1] -eq 'create') {
    if ($a -notcontains '--internal') { return 'a network that is not --internal' }
    if (($a -join ' ') -notmatch [regex]::Escape("--subnet $($subnets.run)")) { return 'a network not on the pinned subnet' }
  }
  if ($a.Count -and $a[0] -eq 'build') {
    $ti = [array]::IndexOf($a, '-t')
    if ($ti -lt 0 -or $a[$ti + 1] -notmatch "^[a-z0-9._/-]+:$([regex]::Escape($tag))(-[a-z0-9]+)?$") { return "a build tag that is not :$tag[-suffix]" }
    if ($a -notcontains '--label') { return 'an unlabelled build' }
  }
  return ''
}
function Lab-Docker([int]$TimeoutSec, [string[]]$a) {
  $why = Test-LabDockerArgs $a
  if ($why) { Write-Host "  SHIM REFUSED: $why :: docker $($a[0]) ..."; $script:rc = 2; $script:fail++; return "REFUSED: $why" }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'docker'
  $psi.Arguments = ($a | ForEach-Object { if ($_ -match '[\s"]' -or $_ -eq '') { '"' + ($_ -replace '\\(?=\\*")', '\\' -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { try { $p.Kill() } catch { }; $script:rc = 124; return "TIMEOUT after ${TimeoutSec}s" }
  $p.WaitForExit()
  $script:rc = $p.ExitCode
  return (($out.Result + $err.Result) -replace "`r", '').TrimEnd()
}
function Dk { Lab-Docker 300 ([string[]]$args) }
$shimCases = @(@('run', '-p', '8080:8080', 'x'), @('run', '--network', 'ai-stack_app-net', 'x'), @('network', 'create', 'n'), @('run', 'x:local'), @('compose', 'up'), @('build', '-t', 'x:wt-other', '.'))
Check (@($shimCases | Where-Object { Test-LabDockerArgs $_ }).Count -eq $shimCases.Count) 'the lab docker shim refuses every forbidden shape'
$localBefore = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim()

function Run-Detached([string]$name, [string[]]$extra) {
  $o = Dk run -d --name $name --label $label --network $net @extra
  if ($script:rc -ne 0) { Fail "$name did not start: $(Redact $o)"; return $false }
  $script:made.containers += $name
  return $true
}
function Build([string]$image, [string]$ctx, [string]$file = '') {
  $a = @('build', '-t', $image, '--label', $label)
  if ($file) { $a += @('-f', $file) }
  $a += $ctx
  $o = Lab-Docker 1200 $a
  Save "build-$($image -replace '[:/]','_').log" (Redact $o)
  $script:made.images += $image
  Check ($script:rc -eq 0) "built $image"
  return ($script:rc -eq 0)
}
function Tree-At([string]$sha) {
  $tree = Join-Path $env:TEMP "$P-tree-$sha"
  New-Item -ItemType Directory -Force $tree | Out-Null
  $script:made.dirs += $tree
  $tar = Join-Path $env:TEMP "$P-$sha.tar"
  & git -C $ob1 archive --format=tar -o $tar $sha docker/extensions-server integrations/kubernetes-deployment
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $tar -C $tree
  Remove-Item -Force $tar
  return $tree
}
function Sql([string]$text, [string]$name) {
  $f = Join-Path $stage "lab-$name.sql"
  [System.IO.File]::WriteAllText($f, $text, (New-Object System.Text.UTF8Encoding $false))
  $o = Dk exec $db psql -U postgres -d openbrain -X -q -v ON_ERROR_STOP=1 -A -t -f "/docker-entrypoint-initdb.d/lab-$name.sql"
  Remove-Item -Force $f
  return $o
}

$db = "$P-db"
try {
  $sha = (& git -C $ob1 rev-parse HEAD).Trim()
  $dirty = (& git -C $ob1 status --porcelain -- integrations/kubernetes-deployment docker/extensions-server docker/docker-compose.yml | Out-String).Trim()
  Write-Host "== rw-mcp-identity lab  owner=$Id  net=$net  red=$([bool]$Red)  tree=$sha$(if ($dirty) { ' (+ working-tree changes)' })  evidence=$Evidence"
  Save 'run.txt' "red=$([bool]$Red) base=$BaseSha tree=$sha dirty=$([bool]$dirty) cases=$Cases started=$((Get-Date).ToString('s'))`n$dirty"

  Write-Host '[1] the initdb chain (this tree''s docker-compose.yml)'
  $compose = Get-Content -Raw (Join-Path $dockerDir 'docker-compose.yml')
  $rx = [regex]'(\.{1,2}/[A-Za-z0-9_./-]+\.sql):/docker-entrypoint-initdb\.d/([0-9]{3}-[a-z0-9.-]+\.sql)'
  $chain = @($rx.Matches($compose) | ForEach-Object { , @($_.Groups[1].Value, $_.Groups[2].Value) })
  foreach ($m in $chain) { Copy-Item (Join-Path $dockerDir $m[0]) (Join-Path $stage $m[1]) }
  Check (@($chain | Where-Object { $_[1] -eq '440-init-inlet-owner.sql' }).Count -eq 1) "the chain mounts PD1's 440 ($($chain.Count) migrations)"

  Write-Host '[2] images'
  if ($Red) { $tree = Tree-At $BaseSha; $mcpCtx = Join-Path $tree 'integrations\kubernetes-deployment'; $extCtx = Join-Path $tree 'docker\extensions-server'; $sfx = '-base' }
  else { $mcpCtx = $kd; $extCtx = Join-Path $dockerDir 'extensions-server'; $sfx = '' }
  $imgMcp = "openbrain-mcp-server:$tag$sfx"; $imgExt = "openbrain-ext-server:$tag$sfx"; $imgMcpo = "openbrain-mcpo:$tag-mcpo"
  if (-not (Build $imgMcp $mcpCtx)) { throw 'build mcp' }
  if (-not (Build $imgExt $extCtx)) { throw 'build ext' }
  if (-not (Build $imgMcpo (Join-Path $dockerDir 'mcpo'))) { throw 'build mcpo' }

  Write-Host '[3] the internal network, the database and the seed'
  $null = Dk network create --driver bridge --internal --subnet $subnets.run --label $label $net
  Check ($script:rc -eq 0) "network $net (internal, $($subnets.run))"
  if ($script:rc -ne 0) { throw 'network' }
  $script:made.net = $true
  if (-not (Run-Detached $db @('--network-alias', 'openbrain-db', '-e', "POSTGRES_PASSWORD=$pw", '-e', 'POSTGRES_DB=openbrain', '-v', "${stage}:/docker-entrypoint-initdb.d", $PgImage))) { throw 'db' }
  for ($i = 0; $i -lt 150; $i++) { if ((Dk logs $db) -match 'PostgreSQL init process complete') { break }; Start-Sleep -Seconds 2 }
  for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $db pg_isready -h 127.0.0.1 -U postgres -d openbrain; if ($script:rc -eq 0) { break }; Start-Sleep -Seconds 2 }
  $logs = Dk logs $db
  Check ($logs -match 'PostgreSQL init process complete') 'the database ran the initdb chain'
  $errs = @(($logs -split "`n") | Where-Object { $_ -match 'ERROR:' })
  Check ($errs.Count -eq 0) "initdb logged no ERROR ($($errs.Count))"
  $vec = "'[' || array_to_string(array_fill(0.03125::float8, ARRAY[1024]), ',') || ']'"
  $seed = @"
CREATE ROLE ob_app_memory LOGIN PASSWORD '$appPw' NOSUPERUSER NOBYPASSRLS IN ROLE service_role;
-- live parity (read on live 2026-11-04, grants only): service_role holds DML on the agent memory tables there; a fresh
-- chain grants them only to roles created before it ran
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_memories, agent_memory_artifacts, agent_memory_audit_events, agent_memory_recall_items,
  agent_memory_recall_traces, agent_memory_relations, agent_memory_review_actions, agent_memory_source_refs TO service_role;
INSERT INTO thoughts (content, embedding, metadata, exposure) VALUES ('lab marker shared row $($markers.shared)', ($vec)::vector, '{"source":"lab"}', 'ops');
INSERT INTO thoughts (content, embedding, metadata, exposure, user_id) VALUES ('lab marker A private $($markers.a_thought)', ($vec)::vector, '{"source":"lab"}', 'ops', '$($subs.a)');
SELECT public.idea_capture('$($subs.a)', 'service:lab', 'A lab marker idea', 'lab marker idea A $($markers.a_idea)', NULL, $vec);
INSERT INTO important_dates (user_id, title, date_value) VALUES ('$defaultUser', 'A date $($markers.a_ext)', current_date + 10);
SELECT 'seeded';
"@
  $o = Sql $seed 'seed'
  Save 'seed.log' (Redact $o)
  Check ($o -match 'seeded') 'seeded: a shared thought, A''s private thought, A''s idea, A''s household date'

  Write-Host '[4] the stubs (OpenID provider, model, gateway-alias stand-in, workbench recorder)'
  $users = @{ a = @{ sub = $subs.a; email = 'a@lab.invalid'; name = 'Lab A' }; b = @{ sub = $subs.b; email = 'b@lab.invalid'; name = 'Lab B' }; c = @{ sub = $subs.c; email = 'c@lab.invalid'; name = 'Lab C' } } | ConvertTo-Json -Compress
  $stub = "$P-stubs"
  if (-not (Run-Detached $stub @('--network-alias', 'stub-oidc', '--network-alias', 'stub-llm', '--network-alias', 'llama-cpp', '--network-alias', 'llama-cpp-embed', '--network-alias', 'openbrain-workbench',
      '-e', "LAB_ISS=$iss", '-e', "LAB_CLIENT_ID=$clientId", '-e', "LAB_CLIENT_SECRET=$clientSecret", '-e', "LAB_USERS=$users", '-e', "LAB_WORKBENCH_KEY=$($K.full)",
      '-v', "${here}:/lab:ro", '-v', "${state}:/state", '--entrypoint', 'python', $OwuiImage, '/lab/stubs.py'))) { throw 'stubs' }
  $jwks = ''
  for ($i = 0; $i -lt 60; $i++) { $jwks = Dk exec $stub cat /tmp/jwks.json; if ($script:rc -eq 0 -and $jwks -match '"keys"') { break }; Start-Sleep -Seconds 2 }
  Check ($jwks -match '"kty":"RSA"') 'the stub provider published its JWKS'
  $kid = ([regex]::Match($jwks, '"kid":"([^"]+)"')).Groups[1].Value

  Write-Host '[5] openbrain-mcp, openbrain-ext, openbrain-mcpo'
  $mcp = "$P-mcp"; $ext = "$P-ext"; $mcpo = "$P-mcpo"; $owui = "$P-owui"
  $common = @('-e', 'DB_HOST=openbrain-db', '-e', 'DB_PORT=5432', '-e', 'DB_NAME=openbrain', '-e', 'DB_USER=ob_app_memory', '-e', "DB_PASSWORD=$appPw",
    '-e', "MCP_ACCESS_KEY=$($K.full)", '-e', "WORKSPACE_DEFAULT_SUB=$($subs.a)", '-e', 'PORT=8000')
  $owuiLane = @('-e', "MCP_OWUI_ACCESS_KEY=$($K.owui)", '-e', "MCP_OWUI_OIDC_ISSUER=$iss", '-e', "MCP_OWUI_OIDC_AUDIENCE=$clientId", '-e', "MCP_OWUI_OIDC_JWKS=$jwks")
  $null = Run-Detached $mcp (@('--network-alias', 'openbrain-mcp') + $common + $owuiLane + @('-e', "MCP_PERSONAL_ACCESS_KEY=$($K.personal)",
      '-e', 'EMBEDDING_API_BASE=http://llama-cpp-embed:8080/v1', '-e', 'EMBEDDING_API_KEY=lab', '-e', 'EMBEDDING_MODEL=local-embed',
      '-e', 'CHAT_API_BASE=http://llama-cpp:8080/v1', '-e', 'CHAT_API_KEY=lab', '-e', 'CHAT_MODEL=local-small', '-e', 'FETCH_PROXY_URL=',
      '-e', 'CONTRACT_WORKBENCH_URL=http://openbrain-workbench:8080', $imgMcp))
  $null = Run-Detached $ext (@('--network-alias', 'openbrain-ext') + $common + $owuiLane + @('-e', "DEFAULT_USER_ID=$defaultUser", '-e', 'WIKI_DIR=/wiki/content', $imgExt))
  $probe = "const r = await fetch('http://127.0.0.1:8000/', {method: 'POST', headers: {'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'x-brain-key': Deno.env.get('MCP_ACCESS_KEY') ?? ''}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'lab', version: '1'}}})}); Deno.exit(r.ok ? 0 : 1)"
  foreach ($c in @($mcp, $ext)) {
    $ok = $false
    for ($i = 0; $i -lt 60; $i++) { $null = Dk exec $c deno eval $probe; if ($script:rc -eq 0) { $ok = $true; break }; Start-Sleep -Seconds 2 }
    Check $ok "$c answers MCP initialize on the full key"
    Save "$c-start.log" (Redact (Dk logs $c))
  }
  $mcpoCfg = @{ mcpServers = @{ 'open-brain' = @{ type = 'streamable-http'; url = 'http://openbrain-mcp:8000/'; headers = @{ 'x-brain-key' = $K.personal } } } } | ConvertTo-Json -Depth 5 -Compress
  [System.IO.File]::WriteAllText((Join-Path $state 'mcpo.config.json'), $mcpoCfg, (New-Object System.Text.UTF8Encoding $false))
  $null = Run-Detached $mcpo @('--network-alias', 'openbrain-mcpo', '-v', "${state}:/state", $imgMcpo, '--config', '/state/mcpo.config.json', '--host', '0.0.0.0', '--port', '8000', '--api-key', $K.mcpo)

  Write-Host '[6] Open WebUI (v0.11.0) with SSO through the stub and the native MCP connections'
  # GREEN: the item's wiring (system_oauth + the OWUI lane key on both). RED: the base has no OWUI lane, so the native
  # connection holds the personal key and the extensions one the full key (what openbrain-mcpo-ext holds today).
  $kMcp = if ($Red) { $K.personal } else { $K.owui }
  $kExt = if ($Red) { $K.full } else { $K.owui }
  $grants = @(@{ principal_type = 'user'; principal_id = '*'; permission = 'read' })
  $conns = @(
    @{ type = 'mcp'; url = 'http://openbrain-mcp:8000/'; path = ''; auth_type = 'system_oauth'; key = ''; headers = @{ 'x-brain-key' = $kMcp }; config = @{ enable = $true; access_grants = $grants }; info = @{ id = 'open-brain'; name = 'Open Brain'; description = 'lab' } },
    @{ type = 'mcp'; url = 'http://openbrain-ext:8000/'; path = ''; auth_type = 'system_oauth'; key = ''; headers = @{ 'x-brain-key' = $kExt }; config = @{ enable = $true; access_grants = $grants }; info = @{ id = 'open-brain-ext'; name = 'Open Brain Extensions'; description = 'lab' } }
  ) | ConvertTo-Json -Depth 6 -Compress
  $owuiEnv = @('-e', "WEBUI_SECRET_KEY=$(Rnd 24)", '-e', 'OFFLINE_MODE=true', '-e', 'HF_HUB_OFFLINE=1', '-e', 'ENABLE_OLLAMA_API=false',
    '-e', 'ENABLE_OPENAI_API=true', '-e', 'OPENAI_API_BASE_URL=http://stub-llm:8080/v1', '-e', 'OPENAI_API_KEY=lab',
    '-e', 'RAG_EMBEDDING_ENGINE=openai', '-e', 'RAG_OPENAI_API_BASE_URL=http://stub-llm:8080/v1', '-e', 'RAG_OPENAI_API_KEY=lab', '-e', 'ENABLE_WEB_SEARCH=false',
    '-e', "OAUTH_CLIENT_ID=$clientId", '-e', "OAUTH_CLIENT_SECRET=$clientSecret", '-e', 'OPENID_PROVIDER_URL=http://stub-oidc:8080/application/o/open-webui/.well-known/openid-configuration',
    '-e', 'OAUTH_PROVIDER_NAME=SSO', '-e', 'OAUTH_SCOPES=openid email profile', '-e', 'ENABLE_OAUTH_SIGNUP=true', '-e', 'ENABLE_LOGIN_FORM=false', '-e', 'ENABLE_PASSWORD_AUTH=false',
    '-e', 'DEFAULT_USER_ROLE=user', '-e', 'BYPASS_MODEL_ACCESS_CONTROL=true', '-e', 'AUTHLIB_INSECURE_TRANSPORT=1', '-e', 'WEBUI_URL=http://owui:8080',
    '-e', 'ENABLE_TITLE_GENERATION=false', '-e', 'ENABLE_FOLLOW_UP_GENERATION=false', '-e', 'ENABLE_TAGS_GENERATION=false', '-e', 'ENABLE_AUTOCOMPLETE_GENERATION=false',
    '-e', 'ENABLE_SEARCH_QUERY_GENERATION=false', '-e', 'ENABLE_RETRIEVAL_QUERY_GENERATION=false', '-e', "TOOL_SERVER_CONNECTIONS=$conns")
  if (-not (Run-Detached $owui (@('--network-alias', 'owui') + $owuiEnv + @($OwuiImage)))) { throw 'owui' }
  $hs = ''
  for ($i = 0; $i -lt 90; $i++) { $hs = Dk inspect -f '{{.State.Health.Status}}' $owui; if ($hs -eq 'healthy') { break }; Start-Sleep -Seconds 4 }
  Check ($hs -eq 'healthy') "Open WebUI is healthy ($hs)"

  Write-Host '[7] the driver: sign-in, then the cases'
  $cfg = [ordered]@{
    owui = 'http://owui:8080'; mcp = 'http://openbrain-mcp:8000/'; ext = 'http://openbrain-ext:8000/'; mcpo = 'http://openbrain-mcpo:8000'
    keys = @{ full = $K.full; personal = $K.personal; owui = $kMcp; mcpo = $K.mcpo }; markers = $markers; subs = $subs; default_user_id = $defaultUser
    iss = $iss; aud = $clientId; client_secret = $clientSecret; kid = $kid; oidc_base = 'http://stub-oidc:8080/application/o/open-webui'
    db_dsn = "postgresql://postgres:$pw@openbrain-db:5432/openbrain"; mode = $(if ($Red) { 'red' } else { 'green' }); cases = $Cases
  } | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText((Join-Path $state 'cfg.json'), $cfg, (New-Object System.Text.UTF8Encoding $false))
  $drv = @('run', '--rm', '--label', $label, '--network', $net, '-v', "${here}:/lab:ro", '-v', "${state}:/state", '--entrypoint', 'python', $OwuiImage, '/lab/driver.py')
  $o = Lab-Docker 600 ($drv + @('login'))
  Save 'driver-login.log' (Redact $o)
  Check ($script:rc -eq 0) 'A, B and C signed in through Open WebUI''s SSO (the stub provider)'
  $ids = $null; try { $ids = (($o -split "`n") | Where-Object { $_ -match '^\{' } | Select-Object -Last 1) | ConvertFrom-Json } catch { }
  if (-not $ids) { throw 'login' }
  # C keeps an Open WebUI session but no SSO session: Open WebUI then sends no token (the no-identity case)
  $o = Dk exec $owui python -c "import sqlite3; c = sqlite3.connect('/app/backend/data/webui.db'); n = c.execute('DELETE FROM oauth_session WHERE user_id = ?', ('$($ids.c)',)).rowcount; c.commit(); print('removed', n)"
  Check ($o -match 'removed [1-9]') "C's SSO session removed in Open WebUI ($o)"
  $o = Lab-Docker 1500 $drv
  Save 'driver.log' (Redact $o)
  Write-Host (Redact $o)
  $drvRc = $script:rc
  if ($Red) { Check ($drvRc -eq 0) 'RED: every bar check FAILED on the base' } else { Check ($drvRc -eq 0) 'GREEN: every driver check passed' }
  foreach ($c in @($mcp, $ext, $mcpo, $owui, $stub)) { Save "$c.log" (Redact (Dk logs $c)) }
}
catch { Fail "the run stopped: $($_.Exception.Message)" }
finally {
  if ($Keep) { Write-Host "== KEPT (net $net): remove everything labelled $label by hand"; Save 'cfg-kept.txt' $state; exit 3 }
  Write-Host '== teardown'
  foreach ($c in $script:made.containers) { $null = Dk rm -f -v $c }
  if ($script:made.net) { $null = Dk network rm $net }
  foreach ($img in $script:made.images) { $null = Dk image rm -f $img }
  $left = Dk ps -a --filter "label=$label" --format '{{.Names}}'
  $leftNet = Dk network ls --filter "label=$label" --format '{{.Name}}'
  $leftImg = Dk images --filter "label=$label" --format '{{.Repository}}:{{.Tag}}'
  Check ([string]::IsNullOrWhiteSpace("$left$leftNet$leftImg")) "nothing labelled $Id is left (containers '$left', networks '$leftNet', images '$leftImg')"
  $localAfter = (Dk images --filter 'reference=*:local' --format '{{.Repository}}:{{.Tag}} {{.ID}}' | Out-String).Trim()
  if ($localBefore -eq $localAfter) { Pass 'no :local image changed' } else { Write-Host '  WARN  a :local image listing differs from the start (this lab never builds one - the shim refuses it; another session rebuilt one: see local-images-*.txt)' }
  Save 'local-images-before.txt' $localBefore; Save 'local-images-after.txt' $localAfter
  foreach ($d in $script:made.dirs) { try { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } catch { } }
  Save 'summary.txt' "red=$([bool]$Red) base=$BaseSha tree=$sha fail=$($script:fail)"
  if ($script:fail) { Write-Host "== FAIL ($($script:fail))"; exit 1 } else { Write-Host '== OK'; exit 0 }
}
