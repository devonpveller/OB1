// Stub workbench for the Notifications e2e lab (rwr-notify-prefs): the shell's reads plus the settings routes, per "mode" (the
// person the stub pretends the request belongs to: alice or bob). The registry is slot 720's (three boolean class keys, the
// sign-in key an enum of "on" only), with the real server's refusals: setting_problem's words (400), a stale version (409),
// versions that never go back, an unknown key a 404. And the bell's read (GET /workbench/contract/notifications) with the real
// filter: an event of a class whose boolean key the person stored false is left out of THAT person's answer only.
//   POST /__mode/<alice|bob>   switch who the next requests belong to
//   GET  /__log                every request seen (method, url, mode)
//   GET  /__wire               every response body the settings routes sent, with the mode it was sent to
//   GET  /__store              the stored values
import http from "node:http";

const KEY = process.env.LAB_KEY || "";
const N = (key, type, position, label, help, def, validation = {}) =>
  ({ key, tier: "user", type, section: "ui", position, label, help, default: def, env: null, validation, editable: true, tag: "only_you" });
const REGISTRY = [
  { ...N("ui.start_screen", "enum", 10, "Start screen", "The screen the app opens on.", null, { enum: ["home", "research", "library"] }) },
  N("notify.informational", "boolean", 100, "Events about your work", "A new idea of yours, a dossier delivered. Off: these no longer show in your bell. Other people's bells are not changed.", true),
  N("notify.structural", "boolean", 110, "Problems that need a fix", "Something failed that is not the model (for example a document that could not be updated). Off: these no longer show in your bell.", true),
  N("notify.transient", "boolean", 120, "The model did not perform", "A model call that kept failing. Off: these no longer show in your bell.", true),
  N("notify.sign_in_new_device", "enum", 130, "Sign-in from a new device", "Not detected yet: this server does not track sign-in devices, so no alert is sent today. The row is reserved and always on, and cannot be switched off.", "on", { enum: ["on"] }),
];
const EVENTS = [
  { id: "e1", class: "informational", subject: "dossier delivered" },
  { id: "e2", class: "structural", subject: "a listing could not be updated" },
  { id: "e3", class: "transient", subject: "LLM call failing for this task" },
  // GUARD for a future producer, not proof the row works: no producer can post this class today (post_research_notification refuses
  // an unregistered class and nothing detects a new device). It checks that IF such an event ever exists the filter cannot hide it.
  { id: "e4", class: "sign_in_new_device", subject: "a sign-in from a new device (future producer)" },
];
const SUB = { alice: "u-alice", bob: "u-bob" };
const NAME = { alice: "Alice Lab", bob: "Bob Builder" };
const STORE = new Map();
const ver = (id) => STORE.get(id)?.version ?? 0;
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

  if (p === "/workbench/settings" && req.method === "GET") return send({ admin: false, settings: REGISTRY.map((k) => out(k, SUB[mode] + "|" + k.key)) });
  if (p === "/workbench/settings/admin" && req.method === "GET") return send({ error: "only an admin may read or change the shared settings" }, 403);
  const sm = p.match(/^\/workbench\/settings\/(.+)$/);
  if (sm) {
    const key = decodeURIComponent(sm[1]);
    const k = REGISTRY.find((r) => r.key === key);
    if (!k) return send({ error: `${key} is not a setting` }, 404);
    const id = SUB[mode] + "|" + key;
    if (req.method === "DELETE") { STORE.delete(id); return send(out(k, id)); }
    if (req.method === "PUT") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const b = raw ? JSON.parse(raw) : {};
        if (b.version !== undefined && b.version !== ver(id)) return send({ error: `the setting changed since it was read (version ${ver(id)}, not ${b.version})` }, 409);
        if (k.type === "boolean" && typeof b.value !== "boolean") return send({ error: `${key}: must be true or false` }, 400);
        if (k.type === "enum" && !(typeof b.value === "string" && k.validation.enum.includes(b.value))) return send({ error: `${key}: must be one of ${JSON.stringify(k.validation.enum)}` }, 400);
        STORE.set(id, { value: b.value, version: ver(id) + 1 });
        send(out(k, id));
      });
      return;
    }
  }
  // the bell: an event of a class the person switched off (a boolean key stored false) is left out for THAT person
  if (p === "/workbench/contract/notifications" && req.method === "GET") {
    const hidden = (c) => { const k = REGISTRY.find((r) => r.key === "notify." + c); return !!k && k.type === "boolean" && STORE.get(SUB[mode] + "|" + k.key)?.value === false; };
    return json({ notifications: EVENTS.filter((e) => !hidden(e.class)) });
  }
  if (p === "/workbench/workspace/whoami") return json({ subject_sub: SUB[mode], actor_sub: SUB[mode], name: NAME[mode] });
  if (p === "/workbench/auth/me") return json({ mode: "forward-auth", signed_in: true, kind: "user", subject_sub: SUB[mode], name: NAME[mode] });
  if (p === "/workbench/contract/sessions") return json({ sessions: [] });
  if (p === "/workbench/intake/jobs") return json({ jobs: [] });
  if (p === "/workbench/contract/cleanup/sources") return json({ sources: [], total: 0 });
  if (p === "/workbench/contract/cleanup/reopen-candidates") return json({ candidates: [] });
  json({ error: "not found" }, 404);
}).listen(9000, () => console.log("stub up"));
