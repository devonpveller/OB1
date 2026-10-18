# harness-subnet.ps1 - the -Subnet rule of the disposable contract test runs (run-contract-tests.ps1,
# run-references-tests.ps1; rw-p0b-purge-door attempt 3). Dot-sourced; defines two functions.
#
# -Subnet is REQUIRED, EXACTLY /24, a network address, and outside Docker's default address pools
# (172.17-172.31: refused as 172.16.0.0/12), 192.168.0.0/16 (the LAN, and Docker's 192.168 /20
# pools - a pool handed out 192.168.0.0/20 and cut the host off its LAN), 0/8, 127/8, 169.254/16
# and 224/3. Attempt 2 refused only 192.168/16 and anything wider than /16, so 172.17.0.0/16 ran.
#
# The /24 is split in two: the run's network gets the lower /25, and the eleven-router smoke's own
# fetch network (scripts/checks/smoke-workbench-routers.ps1 -Subnet) the upper /25 - docker refuses
# two networks whose subnets overlap, and the smoke script creates and removes one per capture.
function Test-HarnessSubnet([string]$s) {
  if ($s -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/(\d{1,2})$') { return "-Subnet <a.b.c.0/24> is required (got '$s')" }
  $o = @([int64]$Matches[1], [int64]$Matches[2], [int64]$Matches[3], [int64]$Matches[4]); $p = [int]$Matches[5]
  if (@($o | Where-Object { $_ -gt 255 }).Count) { return "-Subnet '$s' is not an IPv4 network" }
  if ($p -ne 24) { return "-Subnet '$s' is /${p}: exactly /24 (never wider)" }
  if ($o[3] -ne 0) { return "-Subnet '$s' is not a network address (host bits set)" }
  $v = $o[0] * 16777216 + $o[1] * 65536 + $o[2] * 256
  foreach ($r in @(@(2886729728, 12, "Docker's default address pools (172.17-172.31; 172.16.0.0/12)"), @(3232235520, 16, '192.168.0.0/16 (the LAN; Docker''s 192.168 /20 pools)'),
      @(0, 8, '0.0.0.0/8'), @(2130706432, 8, 'loopback 127.0.0.0/8'), @(2851995648, 16, 'link-local 169.254.0.0/16'), @(3758096384, 3, 'multicast / reserved 224.0.0.0/3'))) {
    $size = [int64][Math]::Pow(2, 32 - $r[1])
    if ($v -ge [int64]$r[0] -and $v -lt ([int64]$r[0] + $size)) { return "-Subnet '$s' is inside $($r[2])" }
  }
  return ''
}
# @{ run = '<a.b.c>.0/25'; smoke = '<a.b.c>.128/25' } for a /24 Test-HarnessSubnet accepted.
function Split-HarnessSubnet([string]$s) {
  $p = ($s -split '/')[0] -replace '\.0$', ''
  return @{ run = "$p.0/25"; smoke = "$p.128/25" }
}
