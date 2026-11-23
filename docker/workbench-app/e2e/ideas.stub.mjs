// Stub workbench for the Ideas e2e lab (rwr-ideas): the fake of ideas-fake.mjs (the SAME module the vitest suite uses) behind
// an HTTP door that, like the real one, answers only a request carrying the lab's door key.
//   POST /__mode/<alice|bob|nobody>     who the next requests belong to
//   POST /__hook/<name>   {json}        a test hook of the fake (form-run, await-owner, fail-list)
//   GET  /__state/<idea id>             the fake's own record of an idea (revisions with their run ids, status)
//   GET  /__log                         every request seen (method, url, who, whether the door key was present)
import http from "node:http";
import { createFake } from "./ideas-fake.mjs";

const KEY = process.env.LAB_KEY || "";
const fake = createFake();
const A = fake.people.alice.sub, B = fake.people.bob.sub;
const LONG = "Unbroken" + "x".repeat(220);
const ids = {};
ids.wiki = fake.addIdea(A, { title: "ALPHA Move the wiki to the cluster", summary: "ALPHA run the wiki on the cluster instead of the workstation", status: "new", created: fake.iso(5 * fake.D), thread_root: "mm-1" });
ids.cpu = fake.addIdea(A, {
  title: "ALPHA Plan the CPU upgrade", status: "researched", created: fake.iso(14 * fake.D), updated: fake.iso(2 * fake.H),
  revisions: ["ALPHA move to a top part", "ALPHA narrowed to boards with strong power stages"], jobs: ["job-old", null],
  sessionQueries: { "job-old": "Which LGA2066 CPUs fit a 7820X board?" }, podcasts: ["p1"], room: { entries: 5 }, user_sources: [{ id: "s1", title: "Your own: pantry export" }],
  revAt: [fake.iso(14 * fake.D), fake.iso(fake.D)],
});
ids.long = fake.addIdea(A, { title: "ALPHA " + LONG, summary: "ALPHA " + LONG + " https://example.org/" + "a".repeat(200), status: "engaged", created: fake.iso(3 * fake.D), updated: fake.iso(30 * fake.H) });
ids.old = fake.addIdea(A, { title: "ALPHA A weekly podcast of what changed", summary: "ALPHA one episode a week", status: "archived", created: fake.iso(60 * fake.D) });
ids.bob = fake.addIdea(B, { title: "BRAVO Bob's idea", summary: "BRAVO something of bob's", status: "engaged", created: fake.iso(3 * fake.D) });

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
    m = req.url.match(/^\/__state\/(.+)$/);
    if (m) { const i = fake.ideas.get(m[1]); return json(i ? { status: i.status, summary: i.summary, revisions: i.revisions } : { error: "none" }, i ? 200 : 404); }
    if (req.url === "/__ids") return json(ids);
    const keyOk = req.headers["x-brain-key"] === KEY;
    log.push({ method: req.method, url: req.url, who: fake.state.mode, keyOk });
    if (!keyOk) return json({ error: "unauthorized" }, 401);
    let body; try { body = raw ? JSON.parse(raw) : undefined; } catch { return json({ error: "bad json" }, 400); }
    const a = fake.handle(req.method, req.url, body, fake.state.mode);
    json(a.body, a.status);
  });
}).listen(9000, () => console.log("stub up"));
