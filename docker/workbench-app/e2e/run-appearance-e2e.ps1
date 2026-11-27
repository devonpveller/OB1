# Headless-Chromium e2e for the workbench app Appearance section, in an isolated lab: an --internal docker network (no
# route out, no ai-stack_* network, no live container), a stub workbench, the app image under test, a
# headless Chrome and a node driver. It needs no plane lease (it mutates nothing outside its own lab).
#   .\e2e\run-e2e.ps1 -Image openbrain-workbench-app:wt-rwr-appearance -AxeJs <path to axe.min.js> [-Tag wt-rwr-appearance]
# axe-core is not part of the app: pass the file (npm pack axe-core, extract package/axe.min.js).
# Every container and the network are removed on the way out, pass or fail.
param(
  [Parameter(Mandatory = $true)][string]$Image,
  [Parameter(Mandatory = $true)][string]$AxeJs,
  [string]$Tag = "wt-rwr-appearance",
  [int]$TimeoutSec = 600
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
  docker network create --internal --subnet 10.250.96.0/24 $net | Out-Null
  docker run -d --name "$Tag-stub" --network $net --ip 10.250.96.20 --network-alias stub -e LAB_KEY=$labKey -v "${here}:/lab:ro" node:22-slim node /lab/appearance.stub.mjs | Out-Null
  docker run -d --name "$Tag-app" --network $net --ip 10.250.96.10 -e WORKBENCH_URL=http://stub:9000 -e WORKBENCH_KEY=$labKey -e WIKI_VIEWER_ALLOWED_HOSTS=10.250.96.10 $Image | Out-Null
  docker run -d --name "$Tag-chrome" --network $net --ip 10.250.96.30 chromedp/headless-shell:latest | Out-Null
  Start-Sleep -Seconds 6
  docker run --rm --name "$Tag-driver" --network "container:$Tag-chrome" -e APP_IP=10.250.96.10 -e CH=127.0.0.1 -e LAB_KEY=$labKey `
    -v "${here}:/lab:ro" -v "${axe}:/axe/axe.min.js:ro" node:22-slim timeout $TimeoutSec node /lab/appearance.e2e.mjs
  $code = $LASTEXITCODE
} finally {
  Clean
}
exit $code
