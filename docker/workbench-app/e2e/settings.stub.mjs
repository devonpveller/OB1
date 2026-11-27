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
  R({ key: "research.max_fetch", tier: "admin", type: "integer", section: "research", label: "ADMINONLY Pages retrieved per run", default: 80, editable: false }),
  R({ key: "curator.shortlist_k", tier: "admin", type: "integer", section: "research", position: 110, label: "ADMINONLY Curator: thread candidates", default: 5, editable: false }),
];
// rwr-settings-defaults: the new user keys, the ceiling (80, the deployed pages-per-run default) and the admin limits as presets
REGISTRY.push(
  R({ key: "research.default_depth", tier: "user", type: "enum", section: "research", label: "Default research depth", default: "standard", validation: { enum: ["quick", "standard", "deep"] } }),
  R({ key: "research.ask_over_fetch", tier: "user", type: "integer", section: "research", position: 20, label: "Ask me before a run reads more than this many pages", validation: { min: 1, max: 200 } }),
  R({ key: "library.how_far_out", tier: "user", read_by: "openbrain-workbench-app Library (kept now, applied when the Library opens)", type: "integer", section: "ui", position: 110, label: "How far out the Library looks", default: 2, validation: { min: 1, max: 3 } }),
  R({ key: "library.recent_size", tier: "user", read_by: "openbrain-workbench-app Library (kept now, applied when the Library opens)", type: "integer", section: "ui", position: 120, label: "Recently viewed: how many items to keep", default: 24, validation: { min: 1, max: 24 } }),
  R({ key: "library.clear_on_signout", tier: "user", read_by: "openbrain-workbench-app Library (kept now, applied when the Library opens)", type: "boolean", section: "ui", position: 130, label: "Clear Recently viewed when I sign out", default: false }),
  R({ key: "library.hidden_suggestions", tier: "user", read_by: "openbrain-workbench-app Library (kept now, applied when the Library opens)", type: "ref_list", section: "ui", position: 140, label: "Hidden suggestions", validation: { max_items: 100 } }),
  R({ key: "podcast.default_format", tier: "user", type: "string", section: "digest", position: 110, label: "Default podcast format", tag: "on_server", read_by: "openbrain-workbench-app (kept now, applied when the new-episode form opens)", validation: { max_len: 120, ref: "podcast_format" } }),
  R({ key: "podcast.episode_minutes", tier: "user", read_by: "openbrain-workbench-app (kept now, applied when the new-episode form opens)", type: "integer", section: "digest", position: 120, label: "Episode length (minutes)", default: 10, tag: "on_server", validation: { min: 3, max: 30 } }),
);
const CEIL = { "research.ask_over_fetch": { ceiling: 80, ceiling_phrase: "the most pages one research run may read, set by an admin" } };
const GROUPS = [
  { group: "run_size", label: "How big a research run is", help: "Pages read, rounds and time per run.", current: "standard",
    presets: ["small", "standard", "large"].map((p) => ({ preset: p, label: p[0].toUpperCase() + p.slice(1), help: "", values: [] })),
    values: [{ key: "research.max_fetch", label: "ADMINONLY Pages retrieved per run", value: 80, is_default: true, min: 6, max: 160 }] },
  { group: "judgement", label: "How strict research is about evidence", help: "", current: "standard",
    presets: ["strict", "standard", "open"].map((p) => ({ preset: p, label: p[0].toUpperCase() + p.slice(1), help: "", values: [] })), values: [] },
  { group: "curator", label: "How new claims are filed into threads", help: "", current: "standard",
    presets: ["careful", "standard", "broad"].map((p) => ({ preset: p, label: p[0].toUpperCase() + p.slice(1), help: "", values: [] })), values: [] },
];
const LOG = [];
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
  const out = (k, id) => { const s = STORE.get(id); return { ...k, ...(CEIL[k.key] ?? {}), value: s ? s.value : null, is_default: !s, version: ver(id), updated_at: s ? new Date().toISOString() : null }; };
  const isAdmin = mode === "admin";

  if (p === "/workbench/settings" && req.method === "GET") {
    return send({ admin: isAdmin, settings: REGISTRY.filter((k) => k.tier === "user").map((k) => out(k, SUB[mode] + "|" + k.key)) });
  }
  if (p === "/workbench/settings/admin" && req.method === "GET") {
    if (!isAdmin) return send({ error: "only an admin may read or change the shared settings" }, 403);
    return send({ settings: REGISTRY.filter((k) => k.tier === "admin").sort((a, b) => a.section.localeCompare(b.section) || a.position - b.position).map((k) => out(k, "*|" + k.key)) });
  }
  if (p === "/workbench/settings/admin/limits" && req.method === "GET") {
    if (!isAdmin) return send({ error: "only an admin may read or change the shared settings" }, 403);
    return send({ groups: GROUPS });
  }
  if (p === "/workbench/settings/admin/limits/log" && req.method === "GET") {
    if (!isAdmin) return send({ error: "only an admin may read or change the shared settings" }, 403);
    return send({ log: LOG });
  }
  const lm = p.match(/^\/workbench\/settings\/admin\/limits\/([a-z_]+)$/);
  if (lm && (req.method === "PUT" || req.method === "DELETE")) {
    if (!isAdmin) return send({ error: "only an admin may read or change the shared settings" }, 403);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const g = GROUPS.find((x) => x.group === lm[1]);
      if (!g) return send({ error: "no such group" }, 404);
      const b = raw ? JSON.parse(raw) : {};
      // the real route: the body is {preset} and nothing else
      if (req.method === "PUT" && (typeof b !== "object" || b === null || Array.isArray(b) || Object.keys(b).some((k) => k !== "preset") || typeof b.preset !== "string")) {
        return send({ error: "send {" + String.fromCharCode(34) + "preset" + String.fromCharCode(34) + ": the name of a preset}; the limits are chosen from presets, not typed" }, 400);
      }
      if (req.method === "PUT") {
        if (!g.presets.some((x) => x.preset === b.preset)) return send({ error: "there is no such preset" }, 404);
        const was = g.values[0]?.value;
        g.current = b.preset;
        g.values = g.values.map((v) => ({ ...v, value: b.preset === "small" ? 24 : b.preset === "large" ? 120 : 80, is_default: false }));
        CEIL["research.ask_over_fetch"].ceiling = g.group === "run_size" ? g.values[0].value : CEIL["research.ask_over_fetch"].ceiling;
        LOG.unshift({ id: LOG.length + 1, at: "2026-11-26T10:00:00Z", actor: SUB[mode], action: "set", key: "research.max_fetch", old_value: was ?? null, new_value: g.values[0]?.value ?? null, group: g.group, preset: b.preset });
      } else {
        g.current = "standard"; g.values = g.values.map((v) => ({ ...v, value: 80, is_default: true }));
        if (g.group === "run_size") CEIL["research.ask_over_fetch"].ceiling = 80;
      }
      send(g);
    });
    return;
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
        if (CEIL[key] && b.value > CEIL[key].ceiling) return send({ error: `${key}: must be at most ${CEIL[key].ceiling} (${CEIL[key].ceiling_phrase})` }, 400);
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
