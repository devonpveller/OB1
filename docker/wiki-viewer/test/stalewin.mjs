// rw-p1b-ready round 2 (tester attempt 2, the 24 h soak: an entity page STALE in 2 of 2668 samples) - measure the
// window in which a page's FILE is newer than its ROW (the reconcile's "stale": row.updated_at + 2 s < file mtime).
// Polls every 25 ms for --ms. Run in the env network with the vault at /wiki (ro); used by run-p1b.sh B16 and B6.
import { stat } from "node:fs/promises";
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const slug = arg("--slug", "content/person/person-ada-fixture");
const ms = Number(arg("--ms", "60000"));
const rest = arg("--rest", "http://openbrain-rest");
const t0 = Date.now(); let inWin = null; const wins = []; let polls = 0, staleSeen = 0;
while (Date.now() - t0 < ms) {
  polls++;
  let m = null, u = null;
  try { m = (await stat(`/wiki/${slug}.md`)).mtimeMs; } catch {}
  try { const r = await fetch(`${rest}/rest/v1/wiki_pages?select=updated_at&slug=eq.${encodeURIComponent(slug)}`, { headers: { apikey: "local-trust" } }); const j = await r.json(); u = j[0] ? Date.parse(j[0].updated_at) : null; } catch {}
  const stale = m != null && u != null && u + 2000 < m;
  if (stale) { staleSeen++; if (!inWin) inWin = { from: Date.now(), fileMs: m, rowMs: u }; }
  else if (inWin) { wins.push({ ...inWin, to: Date.now(), dur: Date.now() - inWin.from }); inWin = null; }
  await new Promise((r) => setTimeout(r, 25));
}
if (inWin) wins.push({ ...inWin, to: Date.now(), dur: Date.now() - inWin.from, open: true });
console.log(`STALEWIN ${slug}: polls=${polls} staleSamples=${staleSeen} windows=${wins.length} maxMs=${wins.length ? Math.max(...wins.map((w) => w.dur)) : 0} ` + JSON.stringify(wins.map((w) => w.dur)));
