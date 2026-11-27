# runner-param-shadow.test.ps1 - a hermetic AST check over the lab runners (rw-lab-throughput attempt 6b).
# PowerShell variable names are case-insensitive, so a script-scope local that reuses a declared parameter's name IS
# that parameter, with the parameter's type constraint: test attempt 5 found run-workspace-tests.ps1 assigning a path
# string to $mutant while the script declares [switch]$Mutant - every green and landing run died at [5p] with
# "Cannot convert value System.String to type SwitchParameter".
# The rule checked here, for every run-*.ps1 under contract-test/ and workbench-app/e2e/:
#   R1 no assignment (or foreach variable) outside a function may spell a declared parameter's name in another letter
#      case - that is never a deliberate re-assignment, always an accidental reuse;
#   R2 a same-spelling re-assignment of a [switch] parameter must not assign a string (a path, a literal, Join-Path).
# Deliberate same-spelling re-assignments of the right type ($NoSweep = -not $run.sweep, $Evidence = Join-Path ...) pass.
#   powershell -NoProfile -File runner-param-shadow.test.ps1                 # every runner of this tree
#   powershell -NoProfile -File runner-param-shadow.test.ps1 -Files <a>,<b>  # given copies (for example an older one: red)
param([string[]]$Files = @())
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Files.Count) {
  $Files = @(Get-ChildItem -Path $here -Filter 'run-*.ps1' | ForEach-Object { $_.FullName })
  $e2e = Join-Path (Split-Path -Parent (Split-Path -Parent $here)) 'workbench-app\e2e'
  if (Test-Path $e2e) { $Files += @(Get-ChildItem -Path $e2e -Filter 'run-*.ps1' | ForEach-Object { $_.FullName }) }
}
$bad = 0; $n = 0
foreach ($f in $Files) {
  $n++
  $tokens = $null; $errs = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$errs)
  if ($errs -and $errs.Count) { Write-Host "  FAIL  $(Split-Path -Leaf $f): does not parse"; $bad++; continue }
  $params = @{}
  if ($ast.ParamBlock) {
    foreach ($p in $ast.ParamBlock.Parameters) { $params[$p.Name.VariablePath.UserPath.ToLowerInvariant()] = @{ name = $p.Name.VariablePath.UserPath; type = "$($p.StaticType)" } }
  }
  $hits = @()
  $inFunction = { param($node) $x = $node.Parent; while ($x) { if ($x -is [System.Management.Automation.Language.FunctionDefinitionAst]) { return $true }; $x = $x.Parent }; return $false }
  $targets = @()
  foreach ($a in $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)) {
    $l = $a.Left
    if ($l -is [System.Management.Automation.Language.ConvertExpressionAst]) { $l = $l.Child }
    if ($l -is [System.Management.Automation.Language.VariableExpressionAst]) { $targets += , @($l, $a.Right, $a) }
  }
  foreach ($fe in $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.ForEachStatementAst] }, $true)) { $targets += , @($fe.Variable, $null, $fe) }
  foreach ($t in $targets) {
    $v = $t[0]
    if (& $inFunction $t[2]) { continue }
    $vp = $v.VariablePath
    if ($vp.DriveName -or -not $vp.IsUnqualified) { continue }   # $script:x, $env:x, $global:x
    $name = $vp.UserPath
    $key = $name.ToLowerInvariant()
    if (-not $params.ContainsKey($key)) { continue }
    $decl = $params[$key]
    if ($name -cne $decl.name) {
      $hits += "line $($v.Extent.StartLineNumber): `$$name reuses the parameter `$$($decl.name) [$($decl.type)] in another letter case (R1)"
    } elseif ($decl.type -match 'SwitchParameter' -and $t[1]) {
      $rhs = $t[1].Extent.Text
      if ($rhs -match '^\s*["'']' -or $rhs -match '(?i)\bJoin-Path\b') { $hits += "line $($v.Extent.StartLineNumber): the [switch] parameter `$$name is assigned a string ($rhs) (R2)" }
    }
  }
  if ($hits.Count) { $bad++; Write-Host "  FAIL  $(Split-Path -Leaf $f):"; foreach ($h in $hits) { Write-Host "          $h" } }
  else { Write-Host "  PASS  $(Split-Path -Leaf $f) ($($params.Count) parameters)" }
}
if ($bad) { Write-Host "$bad of $n runner(s) FAILED"; exit 1 }
Write-Host "all $n runner(s) passed: no local reuses a parameter name"
exit 0
