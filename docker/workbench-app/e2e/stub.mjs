// Stub workbench for the shell e2e lab: answers the six reads the shell makes from a fixed fixture, per
// "mode" (the person the stub pretends the request belongs to), and records every request it gets.
//   POST /__mode/<alice|bob|default>   switch who the next requests belong to
//   GET  /__log                        every request seen (method, url, whether the door key was present)
import http from "node:http";

const KEY = process.env.LAB_KEY || "";
const FX = {
  alice: {
    whoami: { subject_sub: "u-alice", actor_sub: "u-alice", name: "Alice Lab" },
    me: { mode: "forward-auth", signed_in: true, kind: "user", subject_sub: "u-alice", name: "Alice Lab" },
    sessions: 2, jobs: [["retry"], ["cancel"], ["cancel"], []], total: 3, candidates: [true, false],
  },
  bob: {
    whoami: { subject_sub: "u-bob", actor_sub: "u-bob", name: "Bob Builder" },
    me: { mode: "forward-auth", signed_in: true, kind: "user", subject_sub: "u-bob", name: "Bob Builder" },
    sessions: 0, jobs: [["retry"], ["retry"]], total: 7, candidates: [],
  },
  default: {
    whoami: { subject_sub: "operator", actor_sub: "operator", name: "operator" },
    me: { mode: "default", signed_in: true, kind: "default", subject_sub: "operator", name: "operator" },
    sessions: 1, jobs: [], total: 0, candidates: [],
  },
};
let mode = "alice";
const log = [];
http.createServer((req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/__log") return json(log);
  const m = req.url.match(/^\/__mode\/(\w+)$/);
  if (m && FX[m[1]]) { mode = m[1]; return json({ mode }); }
  log.push({ method: req.method, url: req.url, mode, keyOk: req.headers["x-brain-key"] === KEY });
  const f = FX[mode];
  const p = req.url.split("?")[0];
  if (p === "/workbench/workspace/whoami") return json(f.whoami);
  if (p === "/workbench/auth/me") return json(f.me);
  if (p === "/workbench/contract/sessions") return json({ sessions: Array.from({ length: f.sessions }, (_, i) => ({ id: "s" + i })) });
  if (p === "/workbench/intake/jobs") return json({ jobs: f.jobs.map((a, i) => ({ id: "j" + i, detail: { actions: a } })) });
  if (p === "/workbench/contract/cleanup/sources") return json({ sources: [], total: f.total });
  if (p === "/workbench/contract/cleanup/reopen-candidates") return json({ candidates: f.candidates.map((e) => ({ evidence: e ? [{}] : [] })) });
  json({ error: "not found" }, 404);
}).listen(9000, () => console.log("stub up"));
