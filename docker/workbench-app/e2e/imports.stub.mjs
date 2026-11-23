// Stub workbench for the Imports e2e lab: the shell's reads plus the intake routes, answered by the SAME fake the vitest
// suite uses (imports-fake.mjs, which copies the real server's answers). Planted data: ALPHA / alpha.example are alice's,
// BRAVO / bravo.example are bob's. Control (test only):
//   POST /__mode/<alice|bob|nobody>             who the next requests belong to
//   POST /__set/<alice|bob>/<url part>/<status>?error=...   the pipeline's own move of one job (the real one runs in the server)
//   GET  /__log                                 every request seen (method, url, mode, door key present, body keys)
import http from "node:http";
import { createFake } from "./imports-fake.mjs";

const KEY = process.env.LAB_KEY || "";
const H = 3600 * 1000, D = 24 * H;
const fake = createFake();
const SUB = { alice: "u-alice", bob: "u-bob", nobody: "u-nobody" };
const NAME = { alice: "Alice Lab", bob: "Bob Builder", nobody: "Nina Nobody" };
const IDEA_A = "11111111-1111-4111-8111-111111111111";
const LONG = "https://alpha.example/" + "a".repeat(180) + "/unbroken-address-that-must-not-widen-the-screen";
fake.docs.push({ owner: "u-alice", path: "documents/k-a/alpha-plan.md", title: "ALPHA plan", refinery: true }, { owner: "u-alice", path: "documents/k-a/alpha-bare.md", title: "ALPHA bare", refinery: false },
  { owner: "u-bob", path: "documents/k-b/bravo.md", title: "BRAVO doc", refinery: true });
fake.ideas.push({ owner: "u-alice", id: IDEA_A, title: "ALPHA pantry idea", status: "researched" }, { owner: "u-bob", id: "33333333-3333-4333-8333-333333333333", title: "BRAVO idea", status: "open" });
const ago = (ms) => Date.now() - ms;
fake.seed("u-alice", { url: "https://alpha.example/held-article", status: "held", doc_path: "documents/k-a/alpha-plan.md", held_source_id: "aaaaaaaa-0000-4000-8000-000000000001", created: ago(3 * H) });
fake.seed("u-alice", { url: "https://alpha.example/refused", status: "failed", error: "the page answered with an error", doc_path: "documents/k-a/alpha-plan.md", created: ago(2 * H) });
fake.seed("u-alice", { url: "https://alpha.example/chat-link", status: "fetching", origin: "owui", refinery_id: IDEA_A, created: ago(H) });
fake.seed("u-alice", { filename: "ALPHA-notes.pdf", status: "failed", error: "the file could not be read", attempts: 2, doc_path: "documents/k-a/alpha-plan.md", created: ago(5 * H) });
fake.seed("u-alice", { mode: "import", url: LONG, status: "done", source_id: "aaaaaaaa-0000-4000-8000-000000000002", created: ago(9 * D) });
fake.seed("u-bob", { url: "https://bravo.example/own", status: "held", doc_path: "documents/k-b/bravo.md", created: ago(H) });

fake.inlets.push({ owner: "u-alice", kind: "gmail", created: Date.now() - 5 * D }, { owner: "u-alice", kind: "vault", created: Date.now() - 4 * D }, { owner: "u-bob", kind: "gmail", created: Date.now() - D });
const UI_KEYS = ["ui.locked_document", "ui.last_document", "ui.start_screen", "library.recent"];
let mode = "alice";
const log = [];
const body = (req) => new Promise((res) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => res(Buffer.concat(c))); });

http.createServer(async (req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  if (p === "/__log") return json(log);
  let m = p.match(/^\/__mode\/(\w+)$/);
  if (m && SUB[m[1]]) { mode = m[1]; return json({ mode }); }
  if ((m = p.match(/^\/__set\/(\w+)\/([^/]+)\/(\w+)$/))) {
    const j = [...fake.jobs.values()].find((x) => x.owner === SUB[m[1]] && String(x.url ?? x.filename).includes(decodeURIComponent(m[2])));
    if (!j) return json({ error: "no such job" }, 404);
    fake.set(j.id, m[3], u.searchParams.get("error"));
    return json({ ok: true });
  }
  const raw = req.method === "POST" ? await body(req) : Buffer.alloc(0);
  let j = {}, form = null;
  const ct = req.headers["content-type"] || "";
  if (raw.length && ct.startsWith("multipart/form-data")) {
    form = {};
    const fd = await new Request("http://x", { method: "POST", headers: { "content-type": ct }, body: raw }).formData();
    for (const [k, v] of fd.entries()) form[k] = typeof v === "string" ? v : { name: v.name, head: (await v.text()).slice(0, 512) };
  } else if (raw.length) j = JSON.parse(raw.toString("utf8"));
  log.push({ method: req.method, url: req.url, mode, keyOk: req.headers["x-brain-key"] === KEY, keys: Object.keys(form ?? j) });
  if (p === "/workbench/settings" && req.method === "GET") return json({ admin: false, settings: UI_KEYS.map((k) => ({ key: k, value: null, version: 0 })) });
  if (p === "/workbench/workspace/whoami") return json({ subject_sub: SUB[mode], actor_sub: SUB[mode], name: NAME[mode] });
  if (p === "/workbench/auth/me") return json({ mode: "forward-auth", signed_in: true, kind: "user", subject_sub: SUB[mode], name: NAME[mode] });
  const r = fake.handle({ who: SUB[mode], method: req.method, path: p, query: Object.fromEntries(u.searchParams), json: j, form });
  if (r) return json(r.body, r.status);
  if (p === "/workbench/contract/sessions") return json({ sessions: [] });
  if (p === "/workbench/contract/cleanup/sources") return json({ sources: [], total: 0 });
  if (p === "/workbench/contract/cleanup/reopen-candidates") return json({ candidates: [] });
  json({ error: "not found" }, 404);
}).listen(9000, () => console.log("stub up"));
