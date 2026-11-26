// A fake of the workbench's user-settings back end for the Appearance section (rwr-appearance): the vitest suite
// (test/appearance.test.tsx) and the e2e stub (e2e/appearance.stub.mjs) both drive THIS one, so the two cannot drift.
// It copies the real code as the app sees it:
//   - routes: OB1/docker/workbench/src/settings/routes.ts (GET / = { admin, settings }, PUT /:key { value, version },
//     DELETE /:key?version=, 404 `<key> is not a setting`, 400 for a missing value, 409 for a stale version) and
//     settings/store.ts (a refusal reads `<key>: <why>` with status 400; versions never go back: a delete is a version);
//   - validation: OB1/docker/init-appearance.sql (slot 700) setting_problem(): the enum branch (490/400 text) and the
//     theme_list branch (at most max_items, only name/theme/accent/density/text_size, every choice one of the offered lists,
//     a name of 1..max_name characters with no control or invisible character and no credential shape, no repeated name);
//     init-ui-state.sql for ui.start_screen. A value longer than 4096 characters of jsonb text is refused.
//   - the identity: a person is whoever `sub` says (the lab's identity header); every row belongs to its owner.
// The fake is not the server: the server's own rules are tested by the database lab ([5j4], run-workspace-tests.ps1).
export const OFFERED = {
  themes: ["light", "dark", "system"],
  accents: ["teal", "indigo", "amber", "rose", "slate"],
  densities: ["comfortable", "compact"],
  text_sizes: ["13", "14", "15", "16", "18"],
};
const R = (o) => ({ position: 10, help: "", default: null, env: null, read_by: "test", validation: {}, editable: true, tag: "only_you", ...o });
export const REGISTRY = [
  R({ key: "ui.theme", tier: "user", type: "enum", section: "ui", position: 5, label: "Theme", help: "Light, dark, or follow your device (light by day, dark if your device is dark).", default: "system", validation: { enum: OFFERED.themes } }),
  R({ key: "ui.accent", tier: "user", type: "enum", section: "ui", position: 6, label: "Accent colour", help: "Buttons, links and highlights. One of the colours offered.", default: "teal", validation: { enum: OFFERED.accents } }),
  R({ key: "ui.density", tier: "user", type: "enum", section: "ui", position: 7, label: "Density", help: "Comfortable: roomier rows. Compact: tighter rows in Documents, Research and the Library.", default: "comfortable", validation: { enum: OFFERED.densities } }),
  R({ key: "ui.text_size", tier: "user", type: "enum", section: "ui", position: 8, label: "Text size", help: "The size of body text, in pixels.", default: "14", validation: { enum: OFFERED.text_sizes } }),
  R({ key: "ui.start_screen", tier: "user", type: "enum", section: "ui", position: 30, label: "Start screen", help: "The screen the app opens on. Unset: the app's own default (Home).", validation: { enum: ["home", "research", "chat", "documents", "ideas", "podcasts", "library"] } }),
  R({ key: "ui.locked_document", tier: "user", type: "string", section: "ui", position: 10, label: "Locked document", validation: { max_len: 400, ref: "doc_path" } }),
  R({ key: "library.recent", tier: "user", type: "ref_list", section: "ui", position: 40, label: "Recently viewed", validation: { max_items: 24, max_len: 120 } }),
  R({ key: "ui.saved_themes", tier: "user", type: "theme_list", section: "ui", position: 50, label: "Saved themes", help: "Your own looks, kept with your account: a name and the theme, accent, density and text size it sets. At most 10.",
    validation: { max_items: 10, max_name: 40, themes: OFFERED.themes, accents: OFFERED.accents, densities: OFFERED.densities, text_sizes: OFFERED.text_sizes } }),
  R({ key: "refinery.brainstorm", tier: "user", type: "boolean", section: "refinery", position: 10, label: "Brainstorm on my ideas", default: true, tag: "on_server" }),
];

const BAD_CHAR = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
// slot 700's rules: prefixes case-SENSITIVE (`~`), `bearer` case-insensitive (`~*`); btrim strips only the ASCII space; length() is code points
const CRED_PREFIX = /(^|[^A-Za-z0-9])(sk-|sk_|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|AIza|ya29\.|eyJ)/;
const CRED_BEARER = /(^|[^a-z0-9])bearer\s/i;
const btrim = (x) => x.replace(/^ +| +$/g, "");
// jsonb's text for a value, only its length matters (the 4096 cap): close enough for the sizes the tests use
const jlen = (v) => JSON.stringify(v).length;

// setting_problem(owner, key, value): null = fine, else the reason (the fake adds "<key>: " like store.ts)
export function problem(k, value) {
  const t = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (value === null || value === undefined) return "a value is required (delete the setting to go back to the default)";
  if (jlen(value) > 4096) return "the value is too large";
  const v = k.validation;
  switch (k.type) {
    case "boolean": return t === "boolean" ? null : "must be true or false";
    case "enum": return t === "string" && (v.enum ?? []).includes(value) ? null : `must be one of ${JSON.stringify(v.enum ?? [])}`;
    case "string": return t === "string" ? null : "must be text";
    case "ref_list": return t === "array" ? null : "must be a list";
    case "theme_list": {
      if (t !== "array") return "must be a list";
      if (value.length > (v.max_items ?? 10)) return `you can keep at most ${v.max_items ?? 10} saved themes`;
      const bad = value.some((e) => {
        if (!e || typeof e !== "object" || Array.isArray(e)) return true;
        if (Object.keys(e).some((x) => !["name", "theme", "accent", "density", "text_size"].includes(x))) return true;
        if (typeof e.name !== "string" || btrim(e.name) === "" || Array.from(e.name).length > (v.max_name ?? 40)) return true;
        if (BAD_CHAR.test(e.name) || CRED_PREFIX.test(e.name) || CRED_BEARER.test(e.name)) return true;
        return !(typeof e.theme === "string" && v.themes.includes(e.theme) && typeof e.accent === "string" && v.accents.includes(e.accent)
          && typeof e.density === "string" && v.densities.includes(e.density) && typeof e.text_size === "string" && v.text_sizes.includes(e.text_size));
      });
      if (bad) return 'every saved theme is {"name": short text, "theme", "accent", "density", "text_size"} using the offered choices';
      if (new Set(value.map((e) => btrim(e.name).toLowerCase())).size !== value.length) return "two saved themes cannot have the same name";
      return null;
    }
    default: return `${k.key} has a type this store cannot hold`;
  }
}

// One fake server. `handle({ method, url, sub, body })` -> { status, body }. `store` holds "<sub>|<key>" -> { value, version }.
export function createFake() {
  const registry = structuredClone(REGISTRY); // each fake has its own registry (a test may change one)
  const store = new Map();
  const tomb = new Map();
  const wire = []; // every settings answer, as sent, with who it went to
  const verOf = (id) => store.get(id)?.version ?? tomb.get(id) ?? 0;
  const out = (k, id) => {
    const s = store.get(id);
    return { ...k, value: s ? s.value : null, is_default: !s, version: verOf(id), updated_at: s ? "2026-11-25T00:00:00Z" : null };
  };
  const fake = {
    store, tomb, wire, registry,
    // plant a stored value directly (an odd, old or hostile value the routes would refuse: the app must still cope)
    plant(sub, key, value) { const id = sub + "|" + key; store.set(id, { value, version: verOf(id) + 1 }); },
    handle({ method, url, sub, body }) {
      const [path, qs] = url.split("?");
      const send = (status, b) => { wire.push({ sub, method, url, status, body: JSON.stringify(b) }); return { status, body: b }; };
      if (path === "/workbench/settings" && method === "GET") {
        return send(200, { admin: false, settings: registry.map((k) => out(k, sub + "|" + k.key)) });
      }
      const m = path.match(/^\/workbench\/settings\/([^/]+)$/);
      if (!m) return null;
      const key = decodeURIComponent(m[1]);
      const k = registry.find((r) => r.key === key);
      if (!k) return send(404, { error: `${key} is not a setting` });
      const id = sub + "|" + key;
      const cur = verOf(id);
      if (method === "PUT") {
        if (!body || typeof body !== "object" || Array.isArray(body) || !("value" in body) || body.value === null || body.value === undefined) {
          return send(400, { error: 'send {"value": ...} (DELETE the setting to go back to the default)' });
        }
        const why = problem(k, body.value);
        if (why) return send(400, { error: `${key}: ${why}` });
        if (body.version !== undefined && body.version !== null && body.version !== cur) {
          return send(409, { error: `the setting changed since it was read (version ${cur}, not ${body.version})` });
        }
        store.set(id, { value: body.value, version: cur + 1 });
        tomb.delete(id);
        return send(200, out(k, id));
      }
      if (method === "DELETE") {
        const q = new URLSearchParams(qs ?? "");
        if (q.has("version") && Number(q.get("version")) !== cur) return send(409, { error: `the setting changed since it was read (version ${cur}, not ${q.get("version")})` });
        if (store.has(id)) { tomb.set(id, cur + 1); store.delete(id); }
        return send(200, out(k, id));
      }
      return send(405, { error: "method not allowed" });
    },
  };
  return fake;
}
