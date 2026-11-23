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
    sessions: 2, foreign: 1, jobs: [["retry"], ["cancel"], ["cancel"], []], total: 3, candidates: [true, false],
  },
  bob: {
    whoami: { subject_sub: "u-bob", actor_sub: "u-bob", name: "Bob Builder" },
    me: { mode: "forward-auth", signed_in: true, kind: "user", subject_sub: "u-bob", name: "Bob Builder" },
    sessions: 0, foreign: 3, jobs: [["retry"], ["retry"]], total: 7, candidates: [],
  },
  default: {
    whoami: { subject_sub: "operator", actor_sub: "operator", name: "operator" },
    me: { mode: "default", signed_in: true, kind: "default", subject_sub: "operator", name: "operator" },
    sessions: 1, foreign: 0, jobs: [], total: 0, candidates: [],
  },
  // header mode, no identity header on the request: the default subject, kind "default", mode "header"
  header: {
    whoami: { subject_sub: "operator", actor_sub: "operator", name: "operator", kind: "default" },
    me: { mode: "header", signed_in: true, kind: "default", subject_sub: "operator", name: "operator" },
    sessions: 0, foreign: 2, jobs: [], total: 0, candidates: [],
  },
};
// The account (rwr-ui-state-keys): the four per-person UI state keys, per mode, versioned (a delete is a version).
const ACCOUNT = {
  alice: new Map([["ui.locked_document", { value: "documents/k-7f3a/plan.md", version: 1 }]]),
  bob: new Map(), default: new Map(), header: new Map(),
};
const TOMBS = { alice: new Map(), bob: new Map(), default: new Map(), header: new Map() };
const UI_KEYS = ["ui.locked_document", "ui.last_document", "ui.start_screen", "library.recent"];
const ver = (m, k) => ACCOUNT[m].get(k)?.version ?? TOMBS[m].get(k) ?? 0;
const DOCS = { "documents/k-7f3a/plan.md": "Alice plan" };
let mode = "alice";
const log = [];
http.createServer((req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/__log") return json(log);
  const am = req.url.match(/^\/__account\/(\w+)$/);
  if (am && ACCOUNT[am[1]]) return json(Object.fromEntries([...ACCOUNT[am[1]]].map(([k, v]) => [k, v])));
  const m = req.url.match(/^\/__mode\/(\w+)$/);
  if (m && FX[m[1]]) { mode = m[1]; return json({ mode }); }
  log.push({ method: req.method, url: req.url, mode, keyOk: req.headers["x-brain-key"] === KEY });
  const f = FX[mode];
  const p = req.url.split("?")[0];
  const body = () => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b ? JSON.parse(b) : {})); });
  if (p === "/workbench/settings" && req.method === "GET") {
    return json({ admin: false, settings: UI_KEYS.map((k) => ({ key: k, value: ACCOUNT[mode].get(k)?.value ?? null, version: ver(mode, k) })) });
  }
  const sm = p.match(/^\/workbench\/settings\/(.+)$/);
  if (sm) {
    const k = decodeURIComponent(sm[1]);
    if (!UI_KEYS.includes(k)) return json({ error: "not a setting" }, 404);
    const q = new URL(req.url, "http://x").searchParams.get("version");
    if (req.method === "DELETE") {
      if (q !== null && Number(q) !== ver(mode, k)) return json({ error: `the setting changed since it was read (version ${ver(mode, k)}, not ${q})` }, 409);
      if (ACCOUNT[mode].has(k)) { const n = ver(mode, k) + 1; ACCOUNT[mode].delete(k); TOMBS[mode].set(k, n); }
      return json({ key: k, value: null, version: ver(mode, k) });
    }
    if (req.method === "PUT") return body().then((b) => {
      if (b.version !== undefined && b.version !== ver(mode, k)) return json({ error: `the setting changed since it was read (version ${ver(mode, k)}, not ${b.version})` }, 409);
      const n = ver(mode, k) + 1; ACCOUNT[mode].set(k, { value: b.value, version: n }); TOMBS[mode].delete(k);
      return json({ key: k, value: b.value, version: n });
    });
  }
  // the Documents screen's two reads (rwr-docs-list; its own e2e is docs.e2e.mjs): nothing listed in this lab
  if (p === "/workbench/contract/documents") return json({ documents: [] });
  if (p === "/workbench/documents/folders") return json({ root: "documents/k-7f3a", folders: [""] });
  if (p === "/workbench/documents/state") {
    const path = new URL(req.url, "http://x").searchParams.get("path");
    return DOCS[path] && mode === "alice" ? json({ path, listed: true, trashed: false }) : json({ error: "no such document" }, 404);
  }
  if (p === "/workbench/documents/file") {
    const path = new URL(req.url, "http://x").searchParams.get("path");
    return DOCS[path] && mode === "alice" ? json({ path, content: `---
title: ${JSON.stringify(DOCS[path])}
---

private body` }) : json({ error: "no such document" }, 404);
  }
  if (p === "/workbench/workspace/whoami") return json(f.whoami);
  if (p === "/workbench/auth/me") return json(f.me);
  if (p === "/workbench/contract/sessions") return json({ sessions: [...Array.from({ length: f.sessions }, (_, i) => ({ id: "s" + i, mine: true, can_act: true })), ...Array.from({ length: f.foreign }, (_, i) => ({ id: "f" + i, mine: false, can_act: false }))] });
  if (p === "/workbench/contract/ideas") return json({ ideas: [] }); // the Ideas screen (rwr-ideas): this lab has no ideas
  if (p === "/workbench/intake/jobs") return json({ jobs: f.jobs.map((a, i) => ({ id: "j" + i, detail: { actions: a } })) });
  if (p === "/workbench/contract/cleanup/sources") return json({ sources: [], total: f.total });
  if (p === "/workbench/contract/cleanup/reopen-candidates") return json({ candidates: f.candidates.map((e) => ({ evidence: e ? [{}] : [] })) });
  json({ error: "not found" }, 404);
}).listen(9000, () => console.log("stub up"));
