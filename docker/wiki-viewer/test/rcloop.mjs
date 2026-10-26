// rw-p1b-ready round 4 (tester attempt 3, F-T3-1): the reconcile run in a tight loop (<= 100 ms between passes) for
// --ms, against the vault at /wiki (ro) and the env's PostgREST; prints every pass that reported drift (after the
// round-3 missing re-check) and a summary line "RCLOOP passes=<n> driftPasses=<d> slugs=[...]". Used by run-p1b.sh B17.
import { reconcile } from "/ob1/recipes/_shared/reconcile-wiki-pages.mjs";
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const ms = Number(arg("--ms", "30000")), gap = Math.min(100, Number(arg("--gap", "50")));
const t0 = Date.now(); let passes = 0, driftPasses = 0; const slugs = new Set();
while (Date.now() - t0 < ms) {
  try {
    const r = await reconcile({ vault: "/wiki", log: () => {} });
    passes++;
    if (r.drift > 0) {
      driftPasses++;
      const s = [...r.missing.map((x) => `missing:${x}`), ...r.stale.map((x) => `stale:${x}`), ...r.orphan.map((x) => `orphan:${x}`), ...r.empty.map((x) => `empty:${x}`), ...r.failed.map((x) => `failed:${x}`)];
      s.forEach((x) => slugs.add(x));
      console.log(`+${Date.now() - t0} ms drift ${r.drift}: ${s.join(" ")}`);
    }
  } catch (e) { console.log(`+${Date.now() - t0} ms cannot check: ${e?.message || e}`); }
  await new Promise((r) => setTimeout(r, gap));
}
console.log(`RCLOOP passes=${passes} driftPasses=${driftPasses} slugs=${JSON.stringify([...slugs])}`);
