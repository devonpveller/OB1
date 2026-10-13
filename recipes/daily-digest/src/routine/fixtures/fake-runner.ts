// Test fixture: stands in for link-enrich.ts in the VIRTUAL-CLOCK routine
// scenarios only (routine.e2e.test.ts), where the real runner cannot follow a
// virtual clock. The real link-enrich.ts is driven end-to-end in real time by
// link-enrich.e2e.test.ts. Spawned by the REAL PodcastService exactly as
// link-enrich is (same args shape, same ROUTINE_* env).
//
//   --mode=produce     write today's brief + result "produced", exit 0
//   --mode=fail        write result "error", exit 1, no brief
//   --mode=hang-once   first invocation (counter file) sleeps 20 s and writes
//                      nothing (the run that gets interrupted); later ones produce
//   --reports=<dir>    where the brief goes (REPORTS_DIR)

const arg = (n: string) => Deno.args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? "";
const mode = arg("mode") || "produce";
const reports = arg("reports");
const date = Deno.env.get("ROUTINE_DATE") ?? "";
const stateDir = Deno.env.get("ROUTINE_STATE_DIR") ?? "";

// "now" for the brief = the run's startedAt, which the PodcastService wrote with
// the (virtual) routine clock.
const rec = JSON.parse(await Deno.readTextFile(`${stateDir}/${date}.podcast.json`));
const startedAt: string = rec.runs.at(-1).startedAt;

async function writeResult(outcome: string) {
  await Deno.writeTextFile(`${stateDir}/${date}.podcast-result.json`, JSON.stringify({ date, at: startedAt, outcome }));
}

if (mode === "hang-once") {
  const counter = `${reports}/runner-count`;
  let n = 0;
  try {
    n = Number(await Deno.readTextFile(counter)) || 0;
  } catch { /* first */ }
  await Deno.writeTextFile(counter, String(n + 1));
  if (n === 0) {
    await new Promise((r) => setTimeout(r, 20_000));
    Deno.exit(0); // an orphan of a killed server: writes nothing
  }
}

if (mode === "fail") {
  await writeResult("error");
  Deno.exit(1);
}

await Deno.mkdir(reports, { recursive: true });
await Deno.writeTextFile(
  `${reports}/podcast-brief-latest.json`,
  JSON.stringify({
    generatedAt: startedAt,
    date: startedAt.slice(0, 10),
    routineDate: date,
    episode: { name: "001-daily-routing", title: "Daily #001 — routing", viewUrl: null, downloadUrl: null },
    segments: [{
      label: "brain/test",
      items: [{ title: "Routing notes", url: "https://example.test/a", keyPoints: ["Key point A from research"], preliminary: [], gaps: [], emailOnly: false }],
    }],
    followUps: [],
  }),
);
await writeResult("produced");
