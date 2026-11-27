// A stand-in for openbrain-podcast, for the disposable contract-test network only (rwr-voices). It runs the REAL sample handler of
// recipes/daily-digest/src/podcast/sample.ts (the one openbrain-podcast serves at POST /sample) over a RECORDING speech function: there
// is no voice engine on the lab network, so a sample that tried to reach one directly (instead of asking this service) would fail.
//   POST /sample  the real handler, keyed with STUB_PODCAST_KEY (the workbench's WORKBENCH_KEY, as in the real stack)
//   POST /render  202 (the workbench hands a render request here when PODCAST_RENDER_URL is set; nothing is rendered)
//   GET  /__calls what the speech function was asked to voice, in order
// Env: STUB_PODCAST_KEY, STUB_RECIPES (the recipes mount, default /recipes).
const KEY = Deno.env.get("STUB_PODCAST_KEY") ?? "";
const RECIPES = (Deno.env.get("STUB_RECIPES") ?? "/recipes").replace(/\/+$/, "");
const { sampleHandler } = await import(`file://${RECIPES}/daily-digest/src/podcast/sample.ts`);
const calls: { route: string; voice: string; speed: number; text: string }[] = [];
const speech = (r: { route: string; voice: string; speed: number; text: string }) => {
  calls.push({ route: r.route, voice: r.voice, speed: r.speed, text: r.text });
  return Promise.resolve(new Uint8Array(2400 * 2).fill(1)); // 0.1 s of PCM
};
const sample = sampleHandler({ speech, key: KEY });
Deno.serve({ port: 8080 }, (req) => {
  const u = new URL(req.url);
  if (req.method === "GET" && u.pathname === "/__calls") return Response.json(calls);
  if (req.method === "POST" && u.pathname === "/sample") return sample(req);
  if (req.method === "POST" && u.pathname === "/render") return Response.json({ accepted: true }, { status: 202 });
  return new Response("not found", { status: 404 });
});
