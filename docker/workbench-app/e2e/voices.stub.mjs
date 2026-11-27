// Stub workbench for the Cast and voices e2e lab (rwr-voices): the fake of voices-fake.mjs (the SAME module the vitest suite uses) behind an
// HTTP door that, like the real one, answers only a request carrying the lab's door key. The sample route answers a real (silent) WAV so
// the browser can play it.
//   POST /__mode/<alice|bob|nobody>     who the next requests belong to
//   POST /__hook/<name>   {json}        a test hook of the fake (sample, fail-list, busy)
//   GET  /__state                       the fake's own record: rows by kind, and every sample asked for
//   GET  /__ids                         the seeded ids
//   GET  /__log                         every request seen (method, url, who, whether the door key was present)
import http from "node:http";
import { createFake } from "./voices-fake.mjs";

const KEY = process.env.LAB_KEY || "";
const fake = createFake();
const A = fake.people.alice.sub, B = fake.people.bob.sub;
const LONG = "Unbroken" + "x".repeat(200);
const ids = {};
ids.vMorgan = fake.seed.voice(A, { voice: "bm_george", speed: 1 });
ids.vShared = fake.seed.voice(A, { voice: "af_bella", speed: 1.1 });
ids.vBob = fake.seed.voice(B, { voice: "am_adam", speed: 1 });
ids.morgan = fake.seed.presenter(A, {
  name: "ALPHA Morgan", role: "host", personality: "Calm and precise", backstory: "ALPHA a researcher", voice_id: ids.vMorgan, notes: "ALPHA note: too formal last time",
  grounded_in: [{ kind: "topic", ref: "retrieval", label: "retrieval" }, { kind: "source", ref: "s-1", label: "ALPHA private source", private: true }],
});
ids.sam = fake.seed.presenter(A, { name: "ALPHA Sam", role: "co-host", voice_id: ids.vShared });
ids.alex = fake.seed.presenter(A, { name: "ALPHA Alex", role: "guest", voice_id: ids.vShared });
ids.long = fake.seed.presenter(A, { name: "ALPHA " + LONG, role: LONG, backstory: LONG + " https://example.org/" + "a".repeat(200), voice_id: ids.vShared });
ids.bobP = fake.seed.presenter(B, { name: "BRAVO Bobbie", backstory: "BRAVO bob's", voice_id: ids.vBob, notes: "BRAVO notes" });
ids.team = fake.seed.team(A, { name: "ALPHA Morning team", members: [ids.morgan, ids.sam], user_seat: 1, description: "The daily two" });
ids.longTeam = fake.seed.team(A, { name: "ALPHA " + LONG, members: [ids.alex], user_seat: 0 });
ids.bobTeam = fake.seed.team(B, { name: "BRAVO Bob's team", members: [ids.bobP], user_seat: 0 });
ids.fmt = fake.seed.format(A, { name: "ALPHA Daily brief", team_id: ids.team, kind: "briefing", use_for: ["daily"], is_default: true, briefing: "Run through the points." });
ids.bobFmt = fake.seed.format(B, { name: "BRAVO Bob's format", team_id: ids.bobTeam });

// 0.2 s of silence: 24 kHz, mono, 16-bit
function wav() {
  const n = 4800 * 2, b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  return b;
}

const log = [];
http.createServer((req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.url === "/__log") return json(log);
    let m = req.url.match(/^\/__mode\/(\w+)$/);
    if (m && fake.people[m[1]]) { fake.state.mode = m[1]; return json({ mode: m[1] }); }
    m = req.url.match(/^\/__hook\/([\w-]+)$/);
    if (m) return json(fake.hook(m[1], raw ? JSON.parse(raw) : {}));
    if (req.url === "/__state") {
      const rows = (map) => [...map.values()].map((r) => ({ ...r }));
      return json({ voices: rows(fake.t.voices), presenters: rows(fake.t.presenters), teams: rows(fake.t.teams), formats: rows(fake.t.formats), samples: fake.state.samples });
    }
    if (req.url === "/__ids") return json(ids);
    const keyOk = req.headers["x-brain-key"] === KEY;
    log.push({ method: req.method, url: req.url, who: fake.state.mode, keyOk });
    if (!keyOk) return json({ error: "unauthorized" }, 401);
    let body; try { body = raw ? JSON.parse(raw) : undefined; } catch { return json({ error: "bad json" }, 400); }
    const a = fake.handle(req.method, req.url, body, fake.state.mode);
    if (a.wav) { const w = wav(); res.writeHead(200, { "content-type": "audio/wav", "cache-control": "no-store", "content-length": w.length }); return res.end(w); }
    json(a.body, a.status);
  });
}).listen(9000, () => console.log("stub up"));
