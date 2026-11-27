# Headless-Chromium e2e for the workbench app Cleanup (rwr-cleanup), in an isolated lab: an --internal docker network (no
# route out, no ai-stack_* network, no live container), a stub workbench, the app image under test, a
# headless Chrome and a node driver. It needs no plane lease (it mutates nothing outside its own lab).
#   .\e2e\run-cleanup-e2e.ps1 -Image openbrain-workbench-app:wt-rwr-cleanup -AxeJs <path to axe.min.js> [-Tag wt-rwr-cleanup]
# axe-core is not part of the app: pass the file (npm pack axe-core, extract package/axe.min.js).
# Every container and the network are removed on the way out, pass or fail.
param(
  [Parameter(Mandatory = $true)][string]$Image,
  [Parameter(Mandatory = $true)][string]$AxeJs,
  [string]$Tag = "wt-rwr-cleanup",
  [string]$Owner = $Tag,  # the harness owner label on everything the lab creates (a tester passes their own id)
  [int]$TimeoutSec = 600,
  [ValidateRange(1,254)][int]$Octet = 131   # the lab is 10.250.<Octet>.0/24: pick a free one (docker network ls first)
)
$ErrorActionPreference = "Stop"
if ($Image -notmatch ':wt-') { throw "refusing: the image must be a :wt-<id> test tag, got $Image" }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$axe = (Resolve-Path $AxeJs).Path
$net = "$Tag-lab"
$names = @("$Tag-stub", "$Tag-app", "$Tag-chrome", "$Tag-driver")
$labKey = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
function Clean { $e = $ErrorActionPreference; $ErrorActionPreference = "Continue"; foreach ($n in $names) { docker rm -f $n 2>$null | Out-Null }; docker network rm $net 2>$null | Out-Null; $ErrorActionPreference = $e }
Clean
$code = 1
try {
  docker network create --label "ai-stack.harness.owner=$Owner" --internal --subnet "10.250.${Octet}.0/24" $net | Out-Null
  docker run -d --label "ai-stack.harness.owner=$Owner" --name "$Tag-stub" --network $net --ip 10.250.${Octet}.20 --network-alias stub -e LAB_KEY=$labKey -v "${here}:/lab:ro" node:22-slim node /lab/cleanup.stub.mjs | Out-Null
  docker run -d --label "ai-stack.harness.owner=$Owner" --name "$Tag-app" --network $net --ip 10.250.${Octet}.10 -e WORKBENCH_URL=http://stub:9000 -e WORKBENCH_KEY=$labKey -e WIKI_VIEWER_ALLOWED_HOSTS=10.250.${Octet}.10 $Image | Out-Null
  docker run -d --label "ai-stack.harness.owner=$Owner" --name "$Tag-chrome" --network $net --ip 10.250.${Octet}.30 chromedp/headless-shell:latest | Out-Null
  Start-Sleep -Seconds 6
  docker run --rm --label "ai-stack.harness.owner=$Owner" --name "$Tag-driver" --network "container:$Tag-chrome" -e APP_IP=10.250.${Octet}.10 -e CH=127.0.0.1 -e LAB_KEY=$labKey `
    -v "${here}:/lab:ro" -v "${axe}:/axe/axe.min.js:ro" node:22-slim timeout $TimeoutSec node /lab/cleanup.e2e.mjs
  $code = $LASTEXITCODE
} finally {
  Clean
}
exit $code
