// Stub workbench for the Flag for cleanup e2e lab (rwr-flag-buttons): the shell's reads, the account's UI state keys, the
// documents back end from docs-fake.mjs and the flags back end from flags-fake.mjs - the same two fakes the vitest suite
// (test/flag-buttons.test.tsx) drives, so the two cannot drift. Alice's CPU document carries citations to two references.
//   POST /__mode/<alice|bob>      who the next requests belong to
//   POST /__admin/<alice|bob|none>  who the flags back end treats as an admin (scope=all)
//   POST /__behave/<ok|fail|slow>   how a flag POST answers (fail = 500 once with database text; slow = a held answer)
//   POST /__reset                 the planted data again, empty accounts, no flags, empty log
//   GET  /__log                   every request seen (method, url, mode, whether the door key was present, raw body)
//   GET  /__db                    the flags (all owners), the flagged items as planted and the documents' file text, for the driver's checks
import http from "node:http";
import { createFake, PEOPLE, REF_A, REF_B } from "./docs-fake.mjs";
import { createFlagsFake, ITEMS } from "./flags-fake.mjs";

const KEY = process.env.LAB_KEY || "";
const docs = createFake();
const CPU = "documents/k-a/Hardware/cpu.md";
const BRAVO = "documents/k-b/bravo.md";
const plant = () => {
  docs.db().docs.get(CPU).raw = `---\ntitle: "ALPHA Upgrading the CPU"\n---\nThe board supports it [@ref:${REF_A}] as stated, and also [@ref:${REF_B}].`;
  docs.db().docs.get(BRAVO).raw = `---\ntitle: "BRAVO plan"\n---\nBravo cites the same shared reference [@ref:${REF_A}].`;
};
plant();
const flags = createFlagsFake({ ownsDocument: (w, p) => docs.db().docs.get(p)?.owner === w.sub });
let mode = "alice";
let behave = "ok";
let log = [];
let account = { alice: new Map(), bob: new Map() };
const UI_KEYS = ["ui.locked_document", "ui.last_document", "ui.start_screen", "library.recent"];

http.createServer((req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    if (p === "/__log") return json(log);
    if (p === "/__db") {
      return json({ flags: flags.rows(), items: ITEMS, docs: [...docs.db().docs].map(([path, d]) => ({ path, owner: d.owner, raw: d.raw ?? null, history: d.history })), refs: [...docs.db().refs] });
    }
    if (p === "/__reset") { docs.reset(); plant(); flags.reset(); flags.setAdmins([]); log = []; account = { alice: new Map(), bob: new Map() }; mode = "alice"; behave = "ok"; return json({ ok: true }); }
    let m = /^\/__mode\/(\w+)$/.exec(p);
    if (m && PEOPLE[m[1]]) { mode = m[1]; return json({ mode }); }
    m = /^\/__admin\/(\w+)$/.exec(p);
    if (m) { flags.setAdmins(PEOPLE[m[1]] ? [PEOPLE[m[1]].sub] : []); return json({ admin: m[1] }); }
    m = /^\/__behave\/(\w+)$/.exec(p);
    if (m) { behave = m[1]; return json({ behave }); }
    log.push({ method: req.method, url: req.url, mode, keyOk: req.headers["x-brain-key"] === KEY, body: raw });
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return json({ error: "bad json" }, 400); }
    const me = PEOPLE[mode];
    if (p === "/workbench/workspace/whoami") return json({ subject_sub: me.sub, actor_sub: me.sub, name: me.name });
    if (p === "/workbench/auth/me") return json({ mode: "forward-auth", signed_in: true, kind: "user", subject_sub: me.sub, name: me.name });
    if (p === "/workbench/contract/sessions") return json({ sessions: [] });
    if (p === "/workbench/intake/jobs") return json({ jobs: [] });
    if (p === "/workbench/contract/cleanup/sources") return json({ sources: [], total: 0 });
    if (p === "/workbench/contract/cleanup/reopen-candidates") return json({ candidates: [] });
    const acct = account[mode];
    if (p === "/workbench/settings" && req.method === "GET") {
      return json({ admin: false, settings: UI_KEYS.map((k) => ({ key: k, value: acct.get(k)?.value ?? null, version: acct.get(k)?.version ?? 0 })) });
    }
    const sm = /^\/workbench\/settings\/(.+)$/.exec(p);
    if (sm) {
      const k = decodeURIComponent(sm[1]);
      if (!UI_KEYS.includes(k)) return json({ error: "not a setting" }, 404);
      const n = (acct.get(k)?.version ?? 0) + 1;
      if (req.method === "DELETE") { acct.set(k, { value: null, version: n }); return json({ key: k, value: null, version: n }); }
      if (req.method === "PUT") { acct.set(k, { value: body.value, version: n }); return json({ key: k, value: body.value, version: n }); }
    }
    // the flags routes take JSON only when they carry a body (routes/flags.ts jsonBody)
    if (p === "/workbench/contract/flags" && req.method === "POST") {
      if (!/^application\/json/.test(req.headers["content-type"] || "")) return json({ error: "invalid request: the body must be a JSON object" }, 400);
      if (behave === "fail") { behave = "ok"; return json({ error: "internal" }, 500); }
      if (behave === "slow") { behave = "ok"; const r = flags.handle(me, req.method, req.url, body); await new Promise((x) => setTimeout(x, 3000)); return json(r.body, r.status); }
    }
    const fr = flags.handle(me, req.method, req.url, body);
    if (fr) return json(fr.body, fr.status);
    const r = docs.handle(mode, req.method, req.url, body);
    if (r) return json(r.body, r.status);
    json({ error: "not found" }, 404);
  });
}).listen(9000, () => console.log("stub up"));
