// Stub workbench for the Home e2e lab: answers every read the shell and the Home screen make, per "mode" (the
// person the stub pretends the request belongs to), with planted data: ALPHA items belong to alice, BRAVO to bob.
// The sessions read returns every user's sessions, as the real one does (another user's card: empty question,
// can_act false), so the test sees whether Home leaks it.
//   POST /__mode/<alice|bob|nobody|broken>   switch who the next requests belong to ("broken": podcasts 500)
//   GET  /__log                              every request seen (method, url, mode, whether the door key was present)
import http from "node:http";

const KEY = process.env.LAB_KEY || "";
const H = 3600 * 1000, D = 24 * H;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const card = (id, status, query, can, tree, waiting, fin, mine = can) => ({
  id, status, query, can_act: can, mine, waiting_on: waiting, tree: Array.from({ length: tree }, () => ({})),
  created_at: ago(H), started_at: ago(H), finished_at: fin ? ago(5 * H) : null,
});
const FOREIGN = card("s1", "running", "", false, 3, { kind: "branches", detail: "2 open branches" });
const PEOPLE = {
  alice: {
    documents: [
      { id: "a0000000-0000-4000-8000-0000000000a1", title: "ALPHA older note", path: "documents/alpha-old.md", updated: ago(3 * D), outbound_links: [] },
      { id: "a0000000-0000-4000-8000-0000000000a2", title: "ALPHA newest draft", path: "documents/alpha-new.md", updated: ago(2 * H), outbound_links: [{}, {}] },
      { id: "a0000000-0000-4000-8000-0000000000a3", title: "ALPHA middle", path: "documents/alpha-mid.md", updated: ago(D), outbound_links: [{}] },
    ],
    ideas: [{ id: "i1", title: "ALPHA pantry idea", status: "researched", updated_at: ago(D) }],
    episodes: [{ id: "e1", title: "ALPHA digest episode", seconds: 840, shared: false, mine: true, created_at: ago(H) }],
    requests: [
      { id: "r1", title: "ALPHA rendering now", state: "rendering", episode_id: null, created_at: ago(H) },
      { id: "r2", title: "ALPHA digest episode", state: "done", episode_id: "e1", created_at: ago(H) },
    ],
    sessions: [
      card("s1", "running", "ALPHA which CPUs fit", true, 3, { kind: "branches", detail: "2 open branches" }),
      card("s2", "done", "ALPHA finished question", true, 1, { kind: "nothing", detail: "done" }, true),
    ],
  },
  bob: {
    documents: [{ id: "b0000000-0000-4000-8000-0000000000b1", title: "BRAVO plan", path: "documents/bravo.md", updated: ago(H), outbound_links: [] }],
    ideas: [], episodes: [], requests: [],
    sessions: [card("s9", "running", "BRAVO own question", true, 1, { kind: "stage", detail: "plan" }), FOREIGN],
  },
  nobody: { documents: [], ideas: [], episodes: [], requests: [], sessions: [FOREIGN] },
};
PEOPLE.admin = { documents: [], ideas: [], episodes: [], requests: [], sessions: [card("s1", "running", "ALPHA admin can read this", true, 3, { kind: "branches", detail: "2 open branches" }, false, false), card("s7", "running", "SERVICE job text", true, 1, { kind: "stage", detail: "plan" }, false, false)] };
PEOPLE.broken = PEOPLE.alice;
const NAME = { admin: "Ada Admin", alice: "Alice Lab", bob: "Bob Builder", nobody: "Nina Nobody", broken: "Alice Lab" };
const SUB = { admin: "u-admin", alice: "u-alice", bob: "u-bob", nobody: "u-nobody", broken: "u-alice" };
// the server's own library reads: exact totals over the whole library, a page of five (live-like volume)
const LONG = "Claim with a long unbroken address https://example.org/" + "a".repeat(300);
const LIB = {
  recent: { days: 7, sources_total: 2, claims_total: 682, sources: [
    { id: "a", title: "Shared source first", url: "https://example.org/a", content_type: "web_article", created_at: ago(H) },
    { id: "b", title: "Shared source second", url: null, content_type: "pdf", created_at: ago(D) } ] },
  waiting: { total: 14292, claims: [LONG, "Shared claim two", "Shared claim three", "four", "five"].map((text, i) => ({ id: "k" + i, text, created_at: ago(i * H) })) },
};
// The account (rwr-ui-state-keys): the shell reads /workbench/settings on every page. The four per-person UI state keys,
// per mode, versioned (a delete is a version), answered as the shell's own stub (stub.mjs) answers them; nobody here has
// anything stored, so the shell reads no document for a lock.
const UI_KEYS = ["ui.locked_document", "ui.last_document", "ui.start_screen", "library.recent"];
const ACCOUNT = {}, TOMBS = {};
const acct = (m) => (ACCOUNT[m] ??= new Map());
const tombs = (m) => (TOMBS[m] ??= new Map());
const ver = (m, k) => acct(m).get(k)?.version ?? tombs(m).get(k) ?? 0;
let mode = "alice";
let emptyLibrary = false;
const log = [];
http.createServer((req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/__log") return json(log);
  const m = req.url.match(/^\/__mode\/(\w+)$/);
  if (m && PEOPLE[m[1]]) { mode = m[1]; return json({ mode }); }
  if (req.url === "/__library/empty") { emptyLibrary = true; return json({ emptyLibrary }); }
  if (req.url === "/__library/full") { emptyLibrary = false; return json({ emptyLibrary }); }
  log.push({ method: req.method, url: req.url, mode, keyOk: req.headers["x-brain-key"] === KEY });
  const f = PEOPLE[mode];
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  if (p === "/workbench/settings" && req.method === "GET") {
    return json({ admin: false, settings: UI_KEYS.map((k) => ({ key: k, value: acct(mode).get(k)?.value ?? null, version: ver(mode, k) })) });
  }
  const sm = p.match(/^\/workbench\/settings\/(.+)$/);
  if (sm) {
    const k = decodeURIComponent(sm[1]);
    if (!UI_KEYS.includes(k)) return json({ error: "not a setting" }, 404);
    const q = u.searchParams.get("version");
    if (req.method === "DELETE") {
      if (q !== null && Number(q) !== ver(mode, k)) return json({ error: `the setting changed since it was read (version ${ver(mode, k)}, not ${q})` }, 409);
      if (acct(mode).has(k)) { const n = ver(mode, k) + 1; acct(mode).delete(k); tombs(mode).set(k, n); }
      return json({ key: k, value: null, version: ver(mode, k) });
    }
    if (req.method === "PUT") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const b = raw ? JSON.parse(raw) : {};
        if (b.version !== undefined && b.version !== ver(mode, k)) return json({ error: `the setting changed since it was read (version ${ver(mode, k)}, not ${b.version})` }, 409);
        const n = ver(mode, k) + 1; acct(mode).set(k, { value: b.value, version: n }); tombs(mode).delete(k);
        json({ key: k, value: b.value, version: n });
      });
      return;
    }
  }
  if (p === "/workbench/workspace/whoami") return json({ subject_sub: SUB[mode], actor_sub: SUB[mode], name: NAME[mode] });
  if (p === "/workbench/auth/me") return json({ mode: "forward-auth", signed_in: true, kind: "user", subject_sub: SUB[mode], name: NAME[mode] });
  if (p === "/workbench/intake/jobs") return json({ jobs: [] });
  if (p === "/workbench/contract/cleanup/sources") return json({ sources: [], total: 0 });
  if (p === "/workbench/contract/cleanup/reopen-candidates") return json({ candidates: [] });
  if (p === "/workbench/contract/documents") return json({ documents: f.documents });
  if (p === "/workbench/documents/folders") return json({ root: "documents", folders: [""] }); // the Documents screen (rwr-docs-list)
  if (p === "/workbench/contract/ideas") return json({ ideas: f.ideas });
  if (p === "/workbench/contract/podcasts") return mode === "broken" ? json({ error: "boom" }, 500) : json({ podcasts: f.episodes });
  if (p === "/workbench/contract/podcasts/requests") return json({ requests: f.requests });
  if (p === "/workbench/contract/sessions") return json({ sessions: f.sessions });
  if (p === "/workbench/contract/research/runs") return json({ runs: [], counts: { running: 0, queued: 0, done: 0, stopped: 0, archived: 0, total: 0 } }); // the Research screen (a card title opens it)
  if (p === "/workbench/contract/library/recent") return json(emptyLibrary ? { days: 7, sources_total: 0, claims_total: 0, sources: [] } : LIB.recent);
  if (p === "/workbench/contract/library/waiting-claims") return json(emptyLibrary ? { total: 0, claims: [] } : LIB.waiting);
  if (p === "/workbench/contract/search") {
    const q = u.searchParams.get("q");
    if (q === "zzzz") return json({ results: [] });
    return json({ results: [
      { kind: "source", id: "a", title: "Shared source about " + q, snippet: "text with <<HL>>" + q + "<</HL>> in it" },
      { kind: "claim", id: "k1", title: "Shared claim about " + q, snippet: "a claim" },
    ] });
  }
  json({ error: "not found" }, 404);
}).listen(9000, () => console.log("stub up"));
