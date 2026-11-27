// Stub workbench for the Appearance e2e lab (rwr-appearance): the shell's reads plus the user-settings routes, answered by
// appearance-fake.mjs (the same fake the vitest suite drives; it copies the real routes and the slot-700 validation), per "mode"
// (the person the next requests belong to: alice or bob).
//   POST /__mode/<alice|bob>   switch who the next requests belong to
//   GET  /__wire               every settings answer (who, method, url, status, body)
//   GET  /__store              the stored values ("<sub>|<key>" -> { value, version })
//   POST /__plant/<sub>/<key>  plant a raw stored value (JSON body) the routes would refuse
import http from "node:http";
import { createFake } from "./appearance-fake.mjs";

const fake = createFake();
const SUB = { alice: "u-alice", bob: "u-bob" };
const NAME = { alice: "Alice Lab", bob: "Bob Builder" };
let mode = "alice";

http.createServer((req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/__wire") return json(fake.wire);
  if (req.url === "/__store") return json(Object.fromEntries(fake.store));
  const m = req.url.match(/^\/__mode\/(\w+)$/);
  if (m && SUB[m[1]]) { mode = m[1]; return json({ mode }); }
  const pl = req.url.match(/^\/__plant\/([^/]+)\/([^/]+)$/);
  if (pl) { let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => { fake.plant(pl[1], pl[2], JSON.parse(raw)); json({ ok: true }); }); return; }
  const p = req.url.split("?")[0];
  if (p === "/workbench/workspace/whoami") return json({ subject_sub: SUB[mode], actor_sub: SUB[mode], name: NAME[mode] });
  if (p === "/workbench/auth/me") return json({ mode: "forward-auth", signed_in: true, kind: "user", subject_sub: SUB[mode], name: NAME[mode] });
  if (p === "/workbench/contract/sessions") return json({ sessions: [] });
  if (p === "/workbench/intake/jobs") return json({ jobs: [] });
  if (p === "/workbench/contract/cleanup/sources") return json({ sources: [], total: 0 });
  if (p === "/workbench/contract/cleanup/reopen-candidates") return json({ candidates: [] });
  if (p.startsWith("/workbench/settings")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const r = fake.handle({ method: req.method, url: req.url, sub: SUB[mode], body });
      if (r) return json(r.body, r.status);
      json({ error: "not found" }, 404);
    });
    return;
  }
  json({ error: "not found" }, 404);
}).listen(9000, () => console.log("stub up"));
