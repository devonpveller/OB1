// Stub workbench for the Research runs e2e lab (rwr-research-runs): the shell's reads, and the runs routes served by the SAME fake
// back end the vitest suite uses (runs-fake.mjs - the rules of the real research_runs.ts / sessions routes), plus a real
// server-sent stream for a running run. ALPHA is alice's, BRAVO is bob's.
//   POST /__mode/<alice|bob>             who the next requests belong to
//   GET  /__log                          every request seen: method, url, mode, door key present, parsed body
//   GET  /__ids                          the seeded runs' ids by name
//   POST /__grow/<run id>   {kind,query,status}   add a node to a run (it "grows"): the open streams tell the screen
//   POST /__finish/<run id>              finish a run
//   GET  /__state                        archive marks and the documents made
import http from "node:http";
import { createRunsFake } from "./runs-fake.mjs";

const KEY = process.env.LAB_KEY || "";
const NAME = { alice: "Alice Lab", bob: "Bob Builder" };
const SUB = { alice: "u-alice", bob: "u-bob" };
const fake = createRunsFake();
const ago = (ms) => Date.now() - ms;
fake.state.sharedClaims.set("k1", "A shared claim about sensors.");
fake.state.sharedClaims.set("k2", "ALPHA a second shared claim, with a very long unbroken token " + "x".repeat(200));
const ids = {};
ids.done = fake.addRun({
  owner: SUB.alice, question: "ALPHA how do the two sensors compare in noise, drift and price?", topic: "sensors", document: "documents/u-alice/alpha-sensors-note.md", status: "done",
  report: "ALPHA-REPORT-TEXT", sources: [{ url: "https://example.org/a-very-long-address/" + "p".repeat(200), title: "Page A", stages: ["fetched", "admitted"] }],
  claims: [{ id: "k1" }, { id: "k2" }, { id: "k-private" }], // k-private: a claim drawn from a private report - no row in the shared table
  nodes: [
    { id: "b1000000-0000-4000-8000-000000000001", kind: "steer", status: "done", query: "ALPHA focus on noise", sources: [{ url: "https://example.org/b" }] },
    { id: "b1000000-0000-4000-8000-000000000002", kind: "gap", status: "done", query: "ALPHA gap: calibration" },
  ],
}).id;
ids.live = fake.addRun({ owner: SUB.alice, question: "ALPHA live question about power draw", topic: "power", status: "running", created: ago(600_000), step: "step-7" }).id;
ids.queued = fake.addRun({ owner: SUB.alice, question: "ALPHA waits in the queue", status: "queued", created: ago(300_000) }).id;
ids.failed = fake.addRun({ owner: SUB.alice, question: "ALPHA failed one", status: "error", created: ago(9 * 24 * 3600_000) }).id;
ids.bob = fake.addRun({ owner: SUB.bob, question: "BRAVO their question", topic: "bravo-topic", status: "done", report: "BRAVO-REPORT" }).id;

let mode = "alice";
const log = [];
http.createServer((req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/__log") return json(log);
  if (req.url === "/__ids") return json(ids);
  if (req.url === "/__state") return json({ docs: fake.state.docs, archived: fake.state.runs.map((r) => ({ id: r.id, by: [...r.archivedBy] })) });
  let m = req.url.match(/^\/__mode\/(\w+)$/);
  if (m && SUB[m[1]]) { mode = m[1]; return json({ mode }); }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    m = req.url.match(/^\/__grow\/([\w-]+)$/);
    if (m) { fake.grow(m[1], body ?? {}); return json({ ok: true }); }
    m = req.url.match(/^\/__finish\/([\w-]+)$/);
    if (m) { fake.finish(m[1]); return json({ ok: true }); }
    log.push({ method: req.method, url: req.url, mode, keyOk: req.headers["x-brain-key"] === KEY, body });
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    const sub = SUB[mode];
    if (p === "/workbench/settings" && req.method === "GET") {
      return json({ admin: false, settings: ["ui.locked_document", "ui.last_document", "ui.start_screen", "library.recent"].map((k) => ({ key: k, value: null, version: 0 })) });
    }
    if (p.startsWith("/workbench/settings/")) return json({ key: p, value: null, version: 1 });
    if (p === "/workbench/workspace/whoami") return json({ subject_sub: sub, actor_sub: sub, name: NAME[mode] });
    if (p === "/workbench/auth/me") return json({ mode: "forward-auth", signed_in: true, kind: "user", subject_sub: sub, name: NAME[mode] });
    if (p === "/workbench/intake/jobs") return json({ jobs: [] });
    if (p === "/workbench/contract/cleanup/sources") return json({ sources: [], total: 0 });
    if (p === "/workbench/contract/cleanup/reopen-candidates") return json({ candidates: [] });
    if (p === "/workbench/contract/sessions") return json({ sessions: [] });
    if (p === "/workbench/documents/resolve") {
      const d = fake.state.docs.find((x) => x.owner === sub && x.id === u.searchParams.get("id"));
      return d ? json({ id: d.id, path: d.path, listed: true, trashed: false, archived: false }) : json({ error: "no such document" }, 404);
    }
    const a = fake.handle(req.method, req.url, body, sub);
    if (a && a.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const run = a.run;
      const write = () => {
        const running = run.status === "queued" || run.status === "running" || run.nodes.some((n) => n.id !== run.id && (n.status === "queued" || n.status === "running"));
        res.write(fake.sse(run, a.mine));
        if (!running) { res.write(fake.sse(run, a.mine, "end")); res.end(); un(); }
      };
      const un = fake.listen(run.id, write);
      res.on("close", () => un()); // the RESPONSE closes with the connection (a request's close fires once its body is read)
      return write();
    }
    if (a) return json(a.body, a.status);
    json({ error: "not found" }, 404);
  });
}).listen(9000, () => console.log("stub up"));
