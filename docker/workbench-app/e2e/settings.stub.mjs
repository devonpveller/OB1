// Stub workbench for the Settings e2e lab (rwr-settings-shell): the shell's reads plus the settings routes, per "mode" (the
// person the stub pretends the request belongs to: alice, bob, or admin). A registry of user keys and admin keys, a stored
// value per (person, key) with versions that never go back, one shared admin tier, and the real server's refusals: the shared
// tier is answered to the admin mode only (403 to everyone else), a stale version is a 409, an out-of-range value a 400.
//   POST /__mode/<alice|bob|admin>   switch who the next requests belong to
//   GET  /__log                      every request seen (method, url, mode, whether the door key was present)
//   GET  /__wire                     every response body the settings routes sent, with the mode it was sent to
//   GET  /__store                    the stored values
import http from "node:http";

const KEY = process.env.LAB_KEY || "";
const R = (o) => ({ position: 10, help: "", default: null, env: null, validation: {}, editable: true, tag: o.tier === "admin" ? "admin_all" : "only_you", ...o });
const REGISTRY = [
  R({ key: "ui.start_screen", tier: "user", type: "enum", section: "ui", label: "Start screen", help: "The screen the app opens on.", validation: { enum: ["home", "research", "chat", "documents", "ideas", "podcasts", "library"] } }),
  R({ key: "ui.locked_document", tier: "user", type: "string", section: "ui", position: 20, label: "Locked document", validation: { ref: "doc_path" } }),
  R({ key: "library.recent", tier: "user", type: "ref_list", section: "ui", position: 40, label: "Recently viewed" }),
  R({ key: "refinery.brainstorm", tier: "user", type: "boolean", section: "refinery", label: "Brainstorm on my ideas", default: true, tag: "on_server" }),
  R({ key: "refinery.dormancy_days", tier: "user", type: "integer", section: "refinery", position: 20, label: "Days before a quiet idea goes dormant", help: "A researched idea with no engagement for this many days goes dormant.", default: 14, tag: "on_server", validation: { min: 1, max: 365 } }),
  R({ key: "digest.send_time", tier: "user", type: "time", section: "digest", label: "Send time", default: "05:00", editable: false, tag: "on_server" }),
  R({ key: "podcast.team", tier: "user", type: "string", section: "digest", position: 30, label: "The team that voices my daily episode", tag: "on_server" }),
  R({ key: "podcast.archive_destination", tier: "admin", type: "destination", section: "digest", position: 40, label: "ADMINONLY Podcast archive destination", default: { mount: "podcast-archive" } }),
  R({ key: "research.max_fetch", tier: "admin", type: "integer", section: "research", label: "ADMINONLY Pages retrieved per run", default: 24, editable: false }),
  R({ key: "curator.shortlist_k", tier: "admin", type: "integer", section: "research", position: 110, label: "ADMINONLY Curator: thread candidates", default: 5, editable: false }),
];
const SUB = { alice: "u-alice", bob: "u-bob", admin: "u-admin" };
const NAME = { alice: "Alice Lab", bob: "Bob Builder", admin: "Ada Admin" };
const STORE = new Map(); // "<sub>|<key>" -> { value, version }
const TOMB = new Map();
const ver = (id) => STORE.get(id)?.version ?? TOMB.get(id) ?? 0;
let mode = "alice";
const log = [];
const wire = [];

http.createServer((req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/__log") return json(log);
  if (req.url === "/__wire") return json(wire);
  if (req.url === "/__store") return json(Object.fromEntries(STORE));
  const m = req.url.match(/^\/__mode\/(\w+)$/);
  if (m && SUB[m[1]]) { mode = m[1]; return json({ mode }); }
  log.push({ method: req.method, url: req.url, mode, keyOk: req.headers["x-brain-key"] === KEY });
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  const send = (o, s = 200) => { if (p.startsWith("/workbench/settings")) wire.push({ mode, method: req.method, url: req.url, status: s, body: JSON.stringify(o) }); return json(o, s); };
  const out = (k, id) => { const s = STORE.get(id); return { ...k, value: s ? s.value : null, is_default: !s, version: ver(id), updated_at: s ? new Date().toISOString() : null }; };
  const isAdmin = mode === "admin";

  if (p === "/workbench/settings" && req.method === "GET") {
    return send({ admin: isAdmin, settings: REGISTRY.filter((k) => k.tier === "user").map((k) => out(k, SUB[mode] + "|" + k.key)) });
  }
  if (p === "/workbench/settings/admin" && req.method === "GET") {
    if (!isAdmin) return send({ error: "only an admin may read or change the shared settings" }, 403);
    return send({ settings: REGISTRY.filter((k) => k.tier === "admin").sort((a, b) => a.section.localeCompare(b.section) || a.position - b.position).map((k) => out(k, "*|" + k.key)) });
  }
  const sm = p.match(/^\/workbench\/settings\/(.+)$/);
  if (sm) {
    const key = decodeURIComponent(sm[1]);
    const k = REGISTRY.find((r) => r.key === key && r.tier === "user");
    if (!k) return send({ error: `${key} is not a setting` }, 404);
    const id = SUB[mode] + "|" + key;
    if (req.method === "DELETE") {
      const q = u.searchParams.get("version");
      if (q !== null && Number(q) !== ver(id)) return send({ error: `the setting changed since it was read (version ${ver(id)}, not ${q})` }, 409);
      if (STORE.has(id)) { TOMB.set(id, ver(id) + 1); STORE.delete(id); }
      return send(out(k, id));
    }
    if (req.method === "PUT") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const b = raw ? JSON.parse(raw) : {};
        if (b.version !== undefined && b.version !== ver(id)) return send({ error: `the setting changed since it was read (version ${ver(id)}, not ${b.version})` }, 409);
        if (k.type === "integer" && (!Number.isInteger(b.value) || b.value > Number(k.validation.max ?? 1e9) || b.value < Number(k.validation.min ?? -1e9))) {
          return send({ error: `${key}: must be at most ${k.validation.max}` }, 400);
        }
        STORE.set(id, { value: b.value, version: ver(id) + 1 });
        TOMB.delete(id);
        send(out(k, id));
      });
      return;
    }
  }
  if (p === "/workbench/workspace/whoami") return json({ subject_sub: SUB[mode], actor_sub: SUB[mode], name: NAME[mode] });
  if (p === "/workbench/auth/me") return json({ mode: "forward-auth", signed_in: true, kind: "user", subject_sub: SUB[mode], name: NAME[mode] });
  if (p === "/workbench/contract/sessions") return json({ sessions: [] });
  if (p === "/workbench/intake/jobs") return json({ jobs: [] });
  if (p === "/workbench/contract/cleanup/sources") return json({ sources: [], total: 0 });
  if (p === "/workbench/contract/cleanup/reopen-candidates") return json({ candidates: [] });
  json({ error: "not found" }, 404);
}).listen(9000, () => console.log("stub up"));
