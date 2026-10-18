/**
 * The disposable runners' hygiene (research-workbench P3a attempt 2, tester t-rw-p3a near-misses):
 * attempt 1's run-credibility-e2e.ps1 removed its Postgres containers with `docker rm -f` (no -v),
 * so both anonymous data volumes were left behind, and checked containers and networks but not
 * volumes; neither runner pinned a --subnet, so the daemon's default pool (which runs into
 * 192.168.0.0/20 - the home LAN's range) chose it. Static half: the scripts as written. The live
 * half is each runner's own teardown lines (`no volume of ours is left`, the pinned-subnet check).
 * The runners are not in the research-service image, so this runs from a checkout (ignored there).
 * Run: deno test --allow-read runner-hygiene.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const RUNNERS = [
  new URL("./run-credibility-e2e.ps1", import.meta.url),
  new URL("../../docker/workbench/contract-test/run-contract-tests.ps1", import.meta.url),
];
const present = RUNNERS.every((u) => { try { Deno.statSync(u); return true; } catch { return false; } });

for (const u of RUNNERS) {
  const name = u.pathname.split("/").pop()!;
  Deno.test({ name: `${name}: every container removal takes its volumes; the teardown proves none of ours is left`, ignore: !present, fn() {
    const text = Deno.readTextFileSync(u);
    const removals = [...text.matchAll(/^.*\bDk rm\b.*$/gm)].map((m) => m[0].trim());
    assert(removals.length > 0, "no container removal found");
    for (const r of removals) assert(/\bDk rm -f -v\b/.test(r), `a removal without -v: ${r}`);
    assert(!/docker volume prune/.test(text), "never prune volumes the run did not create");
    assert(/no volume of ours is left/.test(text), "the teardown checks the run's own volumes");
    assert(/\{\{range \.Mounts\}\}\{\{\.Type\}\}=\{\{\.Name\}\}/.test(text), "each container's volumes are recorded before it is removed");
  } });
  Deno.test({ name: `${name}: the network's subnet is pinned and never inside 192.168.0.0/16`, ignore: !present, fn() {
    const text = Deno.readTextFileSync(u);
    const creates = [...text.matchAll(/^.*\bnetwork create\b.*$/gm)].map((m) => m[0].trim());
    assertEquals(creates.length, 1, `network creations: ${creates.join(" | ")}`);
    assert(/--internal --subnet \$s /.test(creates[0]), `not pinned: ${creates[0]}`);
    assert(/\[string\]\$Subnet = ''/.test(text) && /\[string\]\$SubnetBase = '10\.24[0-9]'/.test(text), "-Subnet / -SubnetBase parameters");
    assert(/\$o\[0\] -eq 192 -and \$o\[1\] -eq 168\) \{ return \$false \}/.test(text), "the 192.168.0.0/16 refusal");
    assert(/\$SubnetBase -match '\^192\\\.168\$'/.test(text), "a -SubnetBase of 192.168 is refused");
    assert(/the network's subnet is the pinned one, outside 192\.168\.0\.0\/16/.test(text), "the run checks the subnet docker gave it");
  } });
}

Deno.test({ name: "the two runners pin DIFFERENT default ranges (a concurrent pair cannot collide on the default)", ignore: !present, fn() {
  const bases = RUNNERS.map((u) => Deno.readTextFileSync(u).match(/\[string\]\$SubnetBase = '([0-9.]+)'/)?.[1]);
  assert(bases[0] && bases[1] && bases[0] !== bases[1], JSON.stringify(bases));
} });
