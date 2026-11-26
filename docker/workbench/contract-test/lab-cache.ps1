# lab-cache.ps1 - list or prune what the contract-test runners keep between runs on purpose (rw-lab-throughput):
#   images tagged :wt-tree-<tree>-<args> (labelled ai-stack.lab.tree) - reused by the next run on the same OB1 tree
#   volumes ob1-dbtpl-<pin>-<digest>      (labelled ai-stack.lab.dbtpl=1) - the DB template of one pin and chain
# Nothing else is listed or removed: the selection is by those labels only, never by name.
#
#   powershell -NoProfile -File lab-cache.ps1                        # list, with sizes and ages
#   powershell -NoProfile -File lab-cache.ps1 -Prune -OlderThanHours 48
#   powershell -NoProfile -File lab-cache.ps1 -Prune -All            # everything the runners cached
# A pruned entry is rebuilt by the next run that needs it. Never touches :local images or any running container's image.
param([switch]$Prune, [switch]$All, [int]$OlderThanHours = 72)
$ErrorActionPreference = 'Continue'
$cut = (Get-Date).ToUniversalTime().AddHours(-$OlderThanHours)
$imgs = @(& docker images --filter 'label=ai-stack.lab.tree' --format '{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Size}}|{{.CreatedAt}}' 2>$null | Where-Object { $_ -match ':wt-tree-' })
$vols = @(& docker volume ls --filter 'label=ai-stack.lab.dbtpl=1' --format '{{.Name}}' 2>$null | Where-Object { $_ -match '^ob1-dbtpl-' })
$inUse = @(& docker ps -a --format '{{.Image}}' 2>$null)
Write-Host "== lab cache: $($imgs.Count) reuse image tag(s), $($vols.Count) DB template volume(s)$(if ($Prune) { " - pruning $(if ($All) { 'all' } else { "older than $OlderThanHours h" })" })"
foreach ($row in $imgs) {
  $f = $row -split '\|'; $tag = $f[0]
  $created = [DateTime]::MinValue
  try { $created = [DateTime]::Parse(($f[3] -replace ' [A-Z]{3,4}$', '')).ToUniversalTime() } catch { }
  $old = $All -or ($created -lt $cut)
  $busy = $inUse -contains $tag
  Write-Host ("  image  {0}  {1}  created {2:u}{3}" -f $tag, $f[2], $created, $(if ($busy) { '  (in use by a container: kept)' } elseif ($Prune -and $old) { '  -> removed' } else { '' }))
  if ($Prune -and $old -and -not $busy -and $tag -notmatch ':local$') { $null = & docker rmi $tag 2>&1 }
}
foreach ($v in $vols) {
  $c = "$(& docker volume inspect --format '{{.CreatedAt}}' $v 2>$null)".Trim()
  $created = [DateTime]::MinValue
  try { $created = [DateTime]::Parse(($c -replace ' [A-Z]{3,4}$', '')).ToUniversalTime() } catch { }
  $old = $All -or ($created -lt $cut)
  Write-Host ("  volume {0}  created {1:u}{2}" -f $v, $created, $(if ($Prune -and $old) { '  -> removed' } else { '' }))
  if ($Prune -and $old) { $null = & docker volume rm $v 2>&1 }
}
exit 0
