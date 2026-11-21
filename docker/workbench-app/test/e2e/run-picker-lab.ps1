# rwr-picker e2e lab (PowerShell 5.1). Headless Chromium + two identities, all on ONE --internal docker network.
#   .\run-picker-lab.ps1 [-Image openbrain-workbench-app:wt-rwr-picker]
# The image must be built with --build-arg PICKER_HARNESS=1 (the harness page is not in the production build).
# Containers: stuba / stubb (stub.mjs, identity A / B), appa / appb (the image, each in front of its own stub),
# chrome (chromedp/headless-shell), the driver (node:22-slim, driver.mjs + axe-core). No ai-stack_* network, no
# :local image, no published ports, no live container touched; everything is removed in `finally`.
# axe-core is fetched on the HOST into a temp dir (not a dependency of the app) and mounted into the driver.
param([string]$Image = "openbrain-workbench-app:wt-rwr-picker", [int]$TimeoutSec = 240)
$ErrorActionPreference = "Continue" # native stderr is not a failure in PS 5.1; exit codes are checked
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tag = "wt-rwr-picker-lab"
$net = $tag
$names = @("stuba", "stubb", "appa", "appb", "chrome", "driver") | ForEach-Object { "$tag-$_" }
$key = -join ((1..48) | ForEach-Object { "{0:x}" -f (Get-Random -Maximum 16) })
$tmp = Join-Path ([IO.Path]::GetTempPath()) "$tag-axe"
function Cleanup {
  $ErrorActionPreference = "SilentlyContinue"
  foreach ($n in $names) { docker rm -f $n 2>&1 | Out-Null }
  docker network rm $net 2>&1 | Out-Null
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
}
try {
  Cleanup
  New-Item -ItemType Directory -Force $tmp | Out-Null
  Push-Location $tmp
  npm pack axe-core@4.10.2 --silent | Out-Null
  tar -xzf (Get-ChildItem *.tgz | Select-Object -First 1).Name package/axe.min.js
  Copy-Item package/axe.min.js (Join-Path $tmp "axe.min.js")
  Pop-Location
  docker network create --internal $net | Out-Null
  foreach ($id in @("a", "b")) {
    docker run -d --name "$tag-stub$id" --network $net --network-alias "stub$id" -e "ID=$($id.ToUpper())" -e "LAB_KEY=$key" `
      -v "${here}:/lab:ro" node:22-slim node /lab/stub.mjs | Out-Null
    docker run -d --name "$tag-app$id" --network $net --network-alias "app$id.lab" -e "WORKBENCH_URL=http://stub${id}:9000" -e "WORKBENCH_KEY=$key" `
      -e "WIKI_VIEWER_ALLOWED_HOSTS=app$id.lab" $Image | Out-Null
  }
  docker run -d --name "$tag-chrome" --network $net chromedp/headless-shell:latest | Out-Null
  Start-Sleep -Seconds 6
  $chromeIp = (docker inspect "$tag-chrome" | ConvertFrom-Json)[0].NetworkSettings.Networks.$net.IPAddress
  if (-not $chromeIp) { docker logs "$tag-chrome" 2>&1 | Select-Object -Last 20; throw "chrome has no address" }
  docker run --rm --name "$tag-driver" --network $net -v "${here}:/lab:ro" -v "${tmp}:/axe:ro" `
    -e "CHROME_IP=$chromeIp" -e "APP_A=http://appa.lab:8080" -e "APP_B=http://appb.lab:8080" -e "STUB_A=http://stuba:9000" -e "STUB_B=http://stubb:9000" -e "LAB_KEY=$key" `
    node:22-slim node /lab/driver.mjs
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "driver exit $code" }
} finally {
  Cleanup
}
