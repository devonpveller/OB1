// Stub workbench for the Cleanup e2e lab (rwr-cleanup): the shell's reads, the account's UI state keys, the documents back end
// (docs-fake.mjs), the flags back end (flags-fake.mjs) and the Cleanup back end (cleanup-fake.mjs) - the same three fakes the
// vitest suite (test/cleanup.test.tsx) drives, so the two cannot drift.
//   POST /__mode/<alice|bob>   who the next requests belong to
//   POST /__six                the flag_reasons registry gains Outdated and Broken link, and alice holds a flag of each
//   POST /__reset              the planted data again, empty log
//   GET  /__log                every request seen (method, url, mode, whether the door key was present, raw body)
//   GET  /__db                 flags (all owners), dismissals, sources and markers, for the driver's checks
import http from "node:http";
import { createFake, PEOPLE, uid } from "./docs-fake.mjs";
import { createFlagsFake, ITEMS, REASONS } from "./flags-fake.mjs";
import { createCleanupFake } from "./cleanup-fake.mjs";

const KEY = process.env.LAB_KEY || "";
const docs = createFake();
const CPU = "documents/k-a/Hardware/cpu.md";
const PUNCT = "documents/k-a/Notes+[v2];100%.md";
export const MARK = "PRIVATE-FLAG-NOTE-7788";
const flags = createFlagsFake({ ownsDocument: (w, p) => docs.db().docs.get(p)?.owner === w.sub });
const reasons = [...REASONS]; // the registry's list: /__six widens it in place
const cl = createCleanupFake({ flagReasons: reasons });
let mode = "alice";
let log = [];
let account = { alice: new Map(), bob: new Map() };
const UI_KEYS = ["ui.locked_document", "ui.last_document", "ui.start_screen", "library.recent"];
const SRC_A = ITEMS.source[0].id;
const seed = () => {
  docs.db().docs.set(PUNCT, { ...docs.db().docs.get(CPU), id: uid(PUNCT), title: "ALPHA punctuation notes", raw: undefined, body: "x" });
  const mk = (who, reason, note, from) => flags.handle(PEOPLE[who], "POST", "/workbench/contract/flags", { item_kind: "source", item_id: SRC_A, reason, note, from });
  mk("alice", "wrong_claim", MARK, { kind: "document", ref: CPU });
  mk("alice", "duplicate", "ALPHA second flag", { kind: "document", ref: PUNCT });
  mk("bob", "low_quality", "BRAVO-FLAG-NOTE", { kind: "source", ref: SRC_A });
};
seed();

http.createServer((req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    if (p === "/__log") return json(log);
    if (p === "/__db") return json({ flags: flags.rows(), dismissals: cl.dismissals(), sources: cl.sources(), tombs: cl.tombs() });
    if (p === "/__reset") { docs.reset(); flags.reset(); cl.reset(); reasons.length = 0; reasons.push(...REASONS); seed(); log = []; account = { alice: new Map(), bob: new Map() }; mode = "alice"; return json({ ok: true }); }
    if (p === "/__six") {
      for (const k of ["outdated", "broken_link"]) if (!reasons.includes(k)) reasons.push(k);
      for (const k of ["outdated", "broken_link"]) flags.rows().push({ id: `f1a90000-0000-4000-8000-${String(800 + flags.rows().length).padStart(12, "0")}`, owner_sub: PEOPLE.alice.sub, item_kind: "source", item_id: SRC_A, reason: k, note: "", from_kind: "source", from_ref: SRC_A, state: "open", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return json({ reasons });
    }
    const m0 = /^\/__mode\/(\w+)$/.exec(p);
    if (m0 && PEOPLE[m0[1]]) { mode = m0[1]; return json({ mode }); }
    log.push({ method: req.method, url: req.url, mode, keyOk: req.headers["x-brain-key"] === KEY, body: raw });
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return json({ error: "bad json" }, 400); }
    const me = PEOPLE[mode];
    if (p === "/workbench/workspace/whoami") return json({ subject_sub: me.sub, actor_sub: me.sub, name: me.name });
    if (p === "/workbench/auth/me") return json({ mode: "forward-auth", signed_in: true, kind: "user", subject_sub: me.sub, name: me.name });
    if (p === "/workbench/contract/sessions") return json({ sessions: [] });
    if (p === "/workbench/intake/jobs") return json({ jobs: [] });
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
    const c = cl.handle(me, req.method, req.url, body);
    if (c) return json(c.body, c.status);
    const fr = flags.handle(me, req.method, req.url, body);
    if (fr) return json(fr.body, fr.status);
    const r = docs.handle(mode, req.method, req.url, body);
    if (r) return json(r.body, r.status);
    json({ error: "not found" }, 404);
  });
}).listen(9000, () => console.log("stub up"));
