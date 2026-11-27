// Stub workbench for the Coverage tab's e2e lab (rwr-doc-coverage): the shell's reads, the account's UI state keys, the documents
// back end from docs-fake.mjs and the gaps / research-needs back end from gaps-fake.mjs (the same two fakes the vitest suite,
// test/coverage.test.tsx, drives). Records every request.
//   POST /__finish/<n>?cover=1   the n-th research run (1 = the first started) ended; cover=1 means it covered the gaps it carried
//   POST /__queue/<ok|off>       whether the research service answers (off = 503)
//   POST /__mode/<alice|bob>   who the next requests belong to
//   POST /__reset              the planted data again, empty accounts and log
//   GET  /__log                every request seen (method, url, mode, whether the door key was present)
//   GET  /__db                 the fake's documents (path, owner, history, raw file once saved), trail and queued research, for the driver's checks
import http from "node:http";
import { createFake, PEOPLE } from "./docs-fake.mjs";
import { createGapsFake } from "./gaps-fake.mjs";

const KEY = process.env.LAB_KEY || "";
const fake = createFake();
const gaps = createGapsFake({ ownsDocument: (w, p) => fake.db().docs.get(p)?.owner === w.sub });
const CPU = "documents/k-a/Hardware/cpu.md";
const BRAVO = "documents/k-b/bravo.md";
const A = PEOPLE.alice, B = PEOPLE.bob;
const S1 = "5e550000-0000-4000-8000-000000000001", S2 = "5e550000-0000-4000-8000-000000000002", SB = "5e550000-0000-4000-8000-0000000000b1";
const MARK = "PRIVATE-GAP-MARKER-7731";
const plant = () => {
  gaps.reset();
  gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S1, created_at: "2026-11-20T10:00:00.000Z", needs: [{ need: "ALPHA price of the 7950X", status: "open" }, { need: "ALPHA socket wattage", status: "answered" }, { need: "ALPHA BIOS support", status: "partial" }], gaps: ["ALPHA thermal paste choice"] });
  gaps.plantSession({ owner_sub: A.sub, path: CPU, id: S2, created_at: "2026-11-22T10:00:00.000Z", needs: [{ need: `ALPHA ${MARK} RAM kits with a very long unbroken word ${"x".repeat(70)}`, status: "open" }] });
  gaps.plantGap(A, { path: CPU, text: `ALPHA ${MARK} does the socket take 165 W?` });
  gaps.plantGap(A, { path: CPU, text: "ALPHA which cooler fits?" });
  gaps.plantGap(B, { path: BRAVO, text: "BRAVO own gap" });
  gaps.plantSession({ owner_sub: B.sub, path: BRAVO, id: SB, needs: [{ need: "BRAVO own need", status: "open" }] });
};
plant();
let runs = [];
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
      return json({ docs: [...db.docs].map(([path, d]) => ({ path, owner: d.owner, title: d.title, history: d.history, raw: d.raw ?? null })), trail: db.trail, research: db.research, gaps: gaps.rows(), runs });
    }
    if (p === "/__reset") { fake.reset(); plant(); runs = []; log = []; account = { alice: new Map(), bob: new Map() }; mode = "alice"; return json({ ok: true }); }
    let fm = /^\/__finish\/(\d+)$/.exec(p);
    if (fm) { const job = runs[Number(fm[1]) - 1]; const covers = u.searchParams.get("cover") === "1" ? gaps.rows().filter((g) => g.job_id === job).map((g) => g.id) : []; gaps.finishRun(job, { covers }); return json({ job, covers }); }
    fm = /^\/__queue\/(\w+)$/.exec(p);
    if (fm) { gaps.setQueue(fm[1]); return json({ queue: fm[1] }); }
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
    // the gaps routes take JSON only when they carry a body (routes/gaps.ts jsonBody)
    if (p.startsWith("/workbench/contract/gaps") && ["POST", "PATCH"].includes(req.method) && !/^application\/json/.test(req.headers["content-type"] || "")) return json({ error: "invalid request: the body must be a JSON object" }, 400);
    const gr = gaps.handle(me, req.method, req.url, body);
    if (gr) {
      if (req.method === "POST" && p === "/workbench/contract/gaps/research" && gr.status === 202) runs.push(gr.body.job_id);
      return json(gr.body, gr.status);
    }
    const r = fake.handle(mode, req.method, req.url, body);
    if (r) return json(r.body, r.status);
    json({ error: "not found" }, 404);
  });
}).listen(9000, () => console.log("stub up"));
