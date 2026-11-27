// Stub workbench for the Library shell e2e lab (rwr-lib-shell): the shell's reads and the two shared fakes the vitest suite
// (test/library.test.tsx) drives - the documents back end (docs-fake.mjs) and the Library's own routes (library-fake.mjs:
// the account's UI keys, source-states, search, the to-place queue) - so the two cannot drift.
//   POST /__mode/<alice|bob>              who the next requests belong to
//   POST /__reset                         the planted data again, empty accounts, empty log
//   POST /__lifecycle/<source id>/<state> change a shared source's state (active, suppressed, unlinked) or erase it ("erased")
//   POST /__rename/<source id>            body {title}: the shared source's title (a long one, to try the layout)
//   POST /__plant/<person>/<key>          body {value}: set one of that person's account keys, as another browser would
//   GET  /__log                           every request seen (method, url, mode, whether the door key was present)
//   GET  /__db                            the to-place rows (all owners), both accounts, and the planted ids
import http from "node:http";
import { createFake, PEOPLE } from "./docs-fake.mjs";
import { createLibraryFake, SRC, SRC_HIDDEN, SRC_CUT, SRC_GONE, SRC_HELD_A, CLAIM_SHARED, CLAIM_PRIVATE_A, PRIVATE_MARKER } from "./library-fake.mjs";

const KEY = process.env.LAB_KEY || "";
const docs = createFake();
const lib = createLibraryFake({ docs });
let mode = "alice";
let log = [];

http.createServer((req, res) => {
  const json = (o, s = 200, h = {}) => { res.writeHead(s, { "content-type": "application/json", "cache-control": "no-store", ...h }); res.end(JSON.stringify(o)); };
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return json({ error: "bad json" }, 400); }
    if (p === "/__log") return json(log);
    if (p === "/__db") {
      return json({ pending: lib.pendingRows(), accounts: { alice: lib.account("alice"), bob: lib.account("bob") },
        ids: { SRC: Array.from({ length: 12 }, (_, i) => SRC(i + 1)), SRC_HIDDEN, SRC_CUT, SRC_GONE, SRC_HELD_A, CLAIM_SHARED, CLAIM_PRIVATE_A, PRIVATE_MARKER } });
    }
    if (p === "/__reset") { docs.reset(); lib.reset(); log = []; mode = "alice"; return json({ ok: true }); }
    let m = /^\/__mode\/(\w+)$/.exec(p);
    if (m && PEOPLE[m[1]]) { mode = m[1]; return json({ mode }); }
    m = /^\/__lifecycle\/([^/]+)\/(\w+)$/.exec(p);
    if (m) { if (m[2] === "erased") lib.erase(m[1]); else lib.setLifecycle(m[1], m[2]); return json({ ok: true }); }
    m = /^\/__rename\/([^/]+)$/.exec(p);
    if (m) { lib.rename(m[1], String(body.title ?? "")); return json({ ok: true }); }
    m = /^\/__plant\/(\w+)\/(.+)$/.exec(p);
    if (m && PEOPLE[m[1]]) { lib.plantAccount(m[1], decodeURIComponent(m[2]), body.value); return json({ ok: true }); }
    log.push({ method: req.method, url: req.url, mode, keyOk: req.headers["x-brain-key"] === KEY });
    const me = PEOPLE[mode];
    if (p === "/workbench/workspace/whoami") return json({ subject_sub: me.sub, actor_sub: me.sub, name: me.name });
    if (p === "/workbench/auth/me") return json({ mode: "forward-auth", signed_in: true, kind: "user", subject_sub: me.sub, name: me.name });
    if (p === "/workbench/contract/sessions") return json({ sessions: [] });
    if (p === "/workbench/intake/jobs") return json({ jobs: [] });
    if (p === "/workbench/contract/cleanup/sources") return json({ sources: [], total: 0 });
    if (p === "/workbench/contract/cleanup/reopen-candidates") return json({ candidates: [] });
    if (p === "/workbench/contract/library/recent") return json({ sources: [], total: 0 });
    if (p === "/workbench/contract/library/waiting-claims") return json({ claims: [], total: 0 });
    const r = lib.handle(mode, req.method, req.url, body) ?? docs.handle(mode, req.method, req.url, body);
    if (r) return json(r.body, r.status, r.headers);
    json({ error: "not found" }, 404);
  });
}).listen(9000, () => console.log("stub up"));
