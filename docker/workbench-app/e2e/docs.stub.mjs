// Stub workbench for the Documents screen's e2e lab (rwr-docs-list): the shell's reads, the account's UI state keys,
// and the documents back end from docs-fake.mjs (the same fake the vitest suite drives). Records every request.
//   POST /__mode/<alice|bob>   who the next requests belong to
//   POST /__reset              the planted data again, empty accounts and log
//   GET  /__log                every request seen (method, url, mode, whether the door key was present)
//   GET  /__db                 the fake's documents (path, owner, history) and trail, for the driver's checks
import http from "node:http";
import { createFake, PEOPLE } from "./docs-fake.mjs";

const KEY = process.env.LAB_KEY || "";
const fake = createFake();
let mode = "alice";
let log = [];
let account = { alice: new Map(), bob: new Map() };
const UI_KEYS = ["ui.locked_document", "ui.last_document", "ui.start_screen", "library.recent"];

http.createServer((req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    if (p === "/__log") return json(log);
    if (p === "/__db") {
      const db = fake.db();
      return json({ docs: [...db.docs].map(([path, d]) => ({ path, owner: d.owner, title: d.title, history: d.history })), trail: db.trail });
    }
    if (p === "/__reset") { fake.reset(); log = []; account = { alice: new Map(), bob: new Map() }; mode = "alice"; return json({ ok: true }); }
    const m = /^\/__mode\/(\w+)$/.exec(p);
    if (m && PEOPLE[m[1]]) { mode = m[1]; return json({ mode }); }
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
    // the lifecycle routes take JSON only (documents_lifecycle.ts jsonOnly)
    if (["/workbench/documents/unarchive", "/workbench/documents/delete-forever", "/workbench/documents/empty-trash"].includes(p)
      && !/^application\/json/.test(req.headers["content-type"] || "")) return json({ error: "this route takes application/json" }, 415);
    const r = fake.handle(mode, req.method, req.url, body);
    if (r) return json(r.body, r.status);
    json({ error: "not found" }, 404);
  });
}).listen(9000, () => console.log("stub up"));
