// The fake back end of the Cast and voices screen (rwr-voices): ONE module the vitest suite (test/voices.test.tsx) and the
// headless-Chromium lab (e2e/voices.stub.mjs) both use, so the two never disagree about the server. It copies the real
// server's behaviour, with the code it copies named (test/voices-drift.test.ts reads that code and fails on a difference):
//   lists    GET /workbench/contract/cast/{voices,presenters,teams,formats}   contracts/repo/cast.ts list*: only the caller's own rows
//            (owner_sub = the subject), with their totals; a shared row of someone else's is not in scope=mine
//   one row  anything that is not the caller's own (or not an id) is the one 404 "no such <thing>" (NO_SUCH); routes/cast.ts guard()
//   writes   POST / PATCH / DELETE on the four kinds: names are unique per owner (castError 23505 -> 409), a presenter in a team
//            and a team with formats cannot be deleted (409, naming them), a voice that voices a presenter cannot be deleted,
//            a team is at most 26 seats (25 presenters + the user's), the one default format per owner, registry values
//            (podcast_format_kinds / podcast_format_uses / podcast_prompt_modes) outside their keys are 422, an unknown body
//            field is 400 "invalid request" (strict schemas)
//   sample   POST .../voices/{id}/sample   routes/cast.ts: the caller's own voice link only (else the one 404), 503 while not set up,
//            429 for a second sample at once, 502 when the voice engine fails, else a WAV and never cached
// The shell's own reads (whoami, auth/me, the menu counts) answer here too, for the e2e lab. Test hooks (never on the real server): hook().

export const NO_SUCH = { voice: "no such voice", presenter: "no such presenter", team: "no such team", format: "no such format" };
export const MAX_SEATS = 26;
export const KINDS = ["conversation", "briefing", "debate", "interview"];
export const USES = ["daily", "research", "document", "discussion"];
export const MODES = ["built", "own"];
export const NAME_TAKEN = "that name is already taken by one of yours";
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const ROUTE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
export const VOICE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

const PRESENTER_TEXT = { personality: 4000, backstory: 8000, role: 500, focus: 1000, stance: 1000, tone: 500, speaking_style: 1000, system_prompt: 8000, notes: 4000 };
const PRESENTER_KEYS = ["name", "voice_id", "language", "system_prompt_mode", "grounded_in", ...Object.keys(PRESENTER_TEXT)];
const TEAM_KEYS = ["name", "description", "members", "user_seat"];
const FORMAT_KEYS = ["name", "team_id", "description", "briefing", "segments", "language", "script_route", "kind", "use_for", "is_default"];
const VOICE_KEYS = ["route", "voice", "speed"];
const quoted = (xs) => xs.map((x) => `"${x}"`).join(", ");

export function createFake({ now = () => Date.now() } = {}) {
  const iso = () => new Date(now()).toISOString();
  const people = {
    alice: { sub: "u-alice", name: "Alice Lab" },
    bob: { sub: "u-bob", name: "Bob Builder" },
    nobody: { sub: "u-nobody", name: "Nina Nobody" },
  };
  let seq = 0;
  const nid = (p) => `${p}-00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const t = { voices: new Map(), presenters: new Map(), teams: new Map(), formats: new Map() };
  const log = [];
  // sample: ok | unset (503) | down (502); busy = a sample is in flight for that subject (429)
  const state = { mode: "alice", sample: "ok", failList: false, hang: false, samples: [] };
  const mine = (m, sub) => [...m.values()].filter((r) => r.owner_sub === sub);

  // ---- seeding (the screen's own data; every row has its owner)
  const seed = {
    voice: (sub, v) => { const r = { id: nid("voice"), owner_sub: sub, route: "local-tts", voice: "bm_george", speed: 1, created_at: iso(), updated_at: iso(), ...v }; t.voices.set(r.id, r); return r.id; },
    presenter: (sub, p) => {
      const r = {
        id: nid("presenter"), owner_sub: sub, name: "Presenter", personality: "", backstory: "", language: "en-US", role: "", focus: "", stance: "", tone: "",
        speaking_style: "", system_prompt: "", system_prompt_mode: "built", notes: "", grounded_in: [], voice_id: null, shared: false, copied_from: null,
        origin: "operator", created_at: iso(), updated_at: iso(), ...p,
      };
      t.presenters.set(r.id, r); return r.id;
    },
    team: (sub, x) => { const r = { id: nid("team"), owner_sub: sub, name: "Team", description: "", members: [], user_seat: 0, shared: false, copied_from: null, origin: "operator", created_at: iso(), updated_at: iso(), ...x }; t.teams.set(r.id, r); return r.id; },
    format: (sub, x) => {
      const r = {
        id: nid("format"), owner_sub: sub, name: "Format", description: "", team_id: null, briefing: "", segments: 3, language: "en-US", script_route: "local-large:nothink",
        kind: "conversation", use_for: [], is_default: false, shared: false, copied_from: null, origin: "operator", created_at: iso(), updated_at: iso(), ...x,
      };
      t.formats.set(r.id, r); return r.id;
    },
  };

  // ---- views (the wire shapes of schemas/cast.ts)
  const voiceView = (r) => ({
    id: r.id, route: r.route, voice: r.voice, speed: r.speed,
    used_by: mine(t.presenters, r.owner_sub).filter((p) => p.voice_id === r.id).sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, name: p.name })),
    created_at: r.created_at, updated_at: r.updated_at,
  });
  const teamsOf = (p) => mine(t.teams, p.owner_sub).filter((x) => x.members.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name)).map((x) => ({ id: x.id, name: x.name }));
  const presenterView = (r) => {
    const v = t.voices.get(r.voice_id);
    return {
      id: r.id, name: r.name, personality: r.personality, backstory: r.backstory, language: r.language, role: r.role, focus: r.focus, stance: r.stance, tone: r.tone,
      speaking_style: r.speaking_style, system_prompt: r.system_prompt, system_prompt_mode: r.system_prompt_mode, notes: r.notes,
      voice: { id: v.id, route: v.route, voice: v.voice, speed: v.speed },
      grounded_in: r.grounded_in.map((g) => ({ kind: g.kind, ref: g.ref, label: g.label ?? g.ref, private: !!g.private })),
      teams: teamsOf(r), shared: r.shared, mine: true, copied_from: r.copied_from, origin: r.origin, created_at: r.created_at, updated_at: r.updated_at,
    };
  };
  const teamView = (r) => ({
    id: r.id, name: r.name, description: r.description,
    members: r.members.map((pid, position) => ({ position, presenter_id: pid, name: t.presenters.get(pid)?.name ?? "" })),
    user_seat: r.user_seat, seats: r.members.length + 1,
    formats: mine(t.formats, r.owner_sub).filter((f) => f.team_id === r.id).sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({ id: f.id, name: f.name })),
    shared: r.shared, mine: true, copied_from: r.copied_from, origin: r.origin, created_at: r.created_at, updated_at: r.updated_at,
  });
  const formatView = (r) => ({
    id: r.id, name: r.name, description: r.description, team_id: r.team_id, team_name: t.teams.get(r.team_id)?.name ?? "", briefing: r.briefing, segments: r.segments,
    language: r.language, script_route: r.script_route, kind: r.kind, use_for: r.use_for, is_default: r.is_default, shared: r.shared, mine: true,
    copied_from: r.copied_from, origin: r.origin, created_at: r.created_at, updated_at: r.updated_at,
  });

  const err = (status, error) => ({ status, body: { error } });
  const invalid = () => err(400, "invalid request");
  const clean = (s) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s);
  const text = (v, max) => typeof v === "string" && v.length <= max && clean(v);
  const name = (v) => typeof v === "string" && v.length >= 1 && v.length <= 120 && clean(v) && v.trim() !== "";
  const nameTaken = (m, sub, n, exceptId) => mine(m, sub).some((r) => r.name === n && r.id !== exceptId);
  const speedOk = (v) => typeof v === "number" && v > 0.25 && v <= 4;
  const strictKeys = (b, keys) => b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).every((k) => keys.includes(k));

  // the voice link, presenter, team, format writes: returns {status, body}
  function writePresenter(sub, b, id) {
    if (!strictKeys(b, id ? [...PRESENTER_KEYS, "shared", "share_digest"] : PRESENTER_KEYS)) return invalid();
    if (b.shared !== undefined || b.share_digest !== undefined) return err(400, "sharing is not part of this screen");
    if (b.name !== undefined && !name(b.name)) return invalid();
    if (!id && b.name === undefined) return invalid();
    for (const [k, max] of Object.entries(PRESENTER_TEXT)) if (b[k] !== undefined && !text(b[k], max)) return invalid();
    if (b.language !== undefined && !LANG_RE.test(b.language)) return invalid();
    if (b.system_prompt_mode !== undefined && !MODES.includes(b.system_prompt_mode)) return err(422, `"${b.system_prompt_mode}" is not a key of the registry podcast_prompt_modes`);
    if (b.grounded_in !== undefined && !Array.isArray(b.grounded_in)) return invalid();
    if (!id && typeof b.voice_id !== "string") return invalid();
    if (b.voice_id !== undefined) {
      if (!ID_RE.test(b.voice_id)) return err(404, NO_SUCH.voice);
      const v = t.voices.get(b.voice_id);
      if (!v || v.owner_sub !== sub) return err(404, NO_SUCH.voice);
    }
    const cur = id ? t.presenters.get(id) : null;
    const n = b.name ?? cur?.name;
    if (nameTaken(t.presenters, sub, n, id)) return err(409, NAME_TAKEN);
    if (id) {
      for (const k of Object.keys(b)) if (k !== "grounded_in") cur[k] = b[k];
      if (b.grounded_in) cur.grounded_in = b.grounded_in.map((g) => ({ kind: g.kind, ref: g.ref, label: g.ref, private: false }));
      cur.updated_at = iso();
      return { status: 200, body: presenterView(cur) };
    }
    const nidv = seed.presenter(sub, { ...b, grounded_in: (b.grounded_in ?? []).map((g) => ({ kind: g.kind, ref: g.ref, label: g.ref, private: false })), origin: "operator" });
    return { status: 201, body: presenterView(t.presenters.get(nidv)) };
  }

  function writeTeam(sub, b, id) {
    if (!strictKeys(b, id ? [...TEAM_KEYS, "shared", "share_digest"] : TEAM_KEYS)) return invalid();
    if (b.shared !== undefined || b.share_digest !== undefined) return err(400, "sharing is not part of this screen");
    if (b.name !== undefined && !name(b.name)) return invalid();
    if (!id && (b.name === undefined || !Array.isArray(b.members))) return invalid();
    if (b.description !== undefined && !text(b.description, 2000)) return invalid();
    if (b.members !== undefined) {
      if (!Array.isArray(b.members) || b.members.length < 1 || b.members.length > MAX_SEATS - 1 || b.members.some((m) => typeof m !== "string" || m.length > 200)) return invalid();
      if (new Set(b.members).size !== b.members.length) return err(400, "a presenter sits in a team once");
    }
    const cur = id ? t.teams.get(id) : null;
    const members = b.members ?? cur.members;
    if (b.user_seat !== undefined && (!Number.isInteger(b.user_seat) || b.user_seat < 0 || b.user_seat > MAX_SEATS - 1)) return invalid();
    if (members.length + 1 > MAX_SEATS) return err(400, `a team has at most ${MAX_SEATS} seats: ${MAX_SEATS - 1} presenters and yours`);
    const seat = b.user_seat;
    if (seat !== undefined && (seat < 0 || seat > members.length)) return err(400, `user_seat is 0 .. ${members.length} (the number of presenters)`);
    if (b.members !== undefined) {
      const own = b.members.filter((m) => ID_RE.test(m) && t.presenters.get(m)?.owner_sub === sub);
      if (own.length !== b.members.length) return err(404, NO_SUCH.presenter);
    }
    const n = b.name ?? cur?.name;
    if (nameTaken(t.teams, sub, n, id)) return err(409, NAME_TAKEN);
    if (id) {
      if (b.name !== undefined) cur.name = b.name;
      if (b.description !== undefined) cur.description = b.description;
      if (b.members !== undefined) { cur.members = b.members; if (seat === undefined) cur.user_seat = Math.min(cur.user_seat, b.members.length); }
      if (seat !== undefined) cur.user_seat = seat;
      cur.updated_at = iso();
      return { status: 200, body: teamView(cur) };
    }
    const tid = seed.team(sub, { name: b.name, description: b.description ?? "", members: b.members, user_seat: seat ?? b.members.length, origin: "operator" });
    return { status: 201, body: teamView(t.teams.get(tid)) };
  }

  function writeFormat(sub, b, id) {
    if (!strictKeys(b, id ? [...FORMAT_KEYS, "shared", "share_digest"] : FORMAT_KEYS)) return invalid();
    if (b.shared !== undefined || b.share_digest !== undefined) return err(400, "sharing is not part of this screen");
    if (b.name !== undefined && !name(b.name)) return invalid();
    if (!id && (b.name === undefined || typeof b.team_id !== "string")) return invalid();
    for (const [k, max] of [["description", 2000], ["briefing", 8000]]) if (b[k] !== undefined && !text(b[k], max)) return invalid();
    if (b.segments !== undefined && (!Number.isInteger(b.segments) || b.segments < 1 || b.segments > 50)) return invalid();
    if (b.language !== undefined && !LANG_RE.test(b.language)) return invalid();
    if (b.script_route !== undefined && !ROUTE_RE.test(b.script_route)) return invalid();
    if (b.is_default !== undefined && typeof b.is_default !== "boolean") return invalid();
    if (b.use_for !== undefined && (!Array.isArray(b.use_for) || b.use_for.length > 10)) return invalid();
    if (b.kind !== undefined && !KINDS.includes(b.kind)) return err(422, `"${b.kind}" is not a key of the registry podcast_format_kinds`);
    for (const u of b.use_for ?? []) if (!USES.includes(u)) return err(422, `"${u}" is not a key of the registry podcast_format_uses`);
    if (b.use_for && new Set(b.use_for).size !== b.use_for.length) return err(400, "a use is listed twice");
    if (b.team_id !== undefined) {
      const tm = ID_RE.test(b.team_id) ? t.teams.get(b.team_id) : null;
      if (!tm || tm.owner_sub !== sub) return err(404, NO_SUCH.team);
    }
    const cur = id ? t.formats.get(id) : null;
    const n = b.name ?? cur?.name;
    if (nameTaken(t.formats, sub, n, id)) return err(409, NAME_TAKEN);
    if (b.is_default === true) for (const f of mine(t.formats, sub)) if (f.id !== id) f.is_default = false;
    if (id) {
      Object.assign(cur, b);
      cur.updated_at = iso();
      return { status: 200, body: formatView(cur) };
    }
    const fid = seed.format(sub, { ...b, origin: "operator" });
    return { status: 201, body: formatView(t.formats.get(fid)) };
  }

  function writeVoice(sub, b, id) {
    if (!strictKeys(b, VOICE_KEYS)) return invalid();
    if (b.route !== undefined && !ROUTE_RE.test(b.route)) return invalid();
    if (b.voice !== undefined && !VOICE_RE.test(b.voice)) return invalid();
    if (b.speed !== undefined && !speedOk(b.speed)) return invalid();
    if (id) {
      const cur = t.voices.get(id);
      Object.assign(cur, b);
      cur.updated_at = iso();
      return { status: 200, body: voiceView(cur) };
    }
    if (typeof b.route !== "string" || typeof b.voice !== "string") return invalid();
    const vid = seed.voice(sub, { route: b.route, voice: b.voice, speed: b.speed ?? 1 });
    return { status: 201, body: voiceView(t.voices.get(vid)) };
  }

  const busy = new Set();
  const KIND = {
    voices: { map: t.voices, what: "voice", view: voiceView, write: writeVoice },
    presenters: { map: t.presenters, what: "presenter", view: presenterView, write: writePresenter },
    teams: { map: t.teams, what: "team", view: teamView, write: writeTeam },
    formats: { map: t.formats, what: "format", view: formatView, write: writeFormat },
  };

  function remove(kind, sub, id) {
    const k = KIND[kind];
    const r = k.map.get(id);
    if (kind === "voices") {
      const users = mine(t.presenters, sub).filter((p) => p.voice_id === id).sort((a, b) => a.name.localeCompare(b.name));
      if (users.length) return { status: 409, body: { error: `this voice voices ${quoted(users.map((u) => u.name))}: give them another voice first`, detail: { presenters: users.map((u) => ({ id: u.id, name: u.name })) } } };
    }
    if (kind === "presenters") {
      const teams = teamsOf(r);
      if (teams.length) return { status: 409, body: { error: `this presenter is in ${quoted(teams.map((x) => x.name))}: take it out of ${teams.length > 1 ? "those teams" : "the team"} first`, detail: { teams } } };
    }
    if (kind === "teams") {
      const formats = mine(t.formats, sub).filter((f) => f.team_id === id).sort((a, b) => a.name.localeCompare(b.name));
      if (formats.length) return { status: 409, body: { error: `this team has the format${formats.length > 1 ? "s" : ""} ${quoted(formats.map((f) => f.name))}: delete or move ${formats.length > 1 ? "them" : "it"} first`, detail: { formats: formats.map((f) => ({ id: f.id, name: f.name })) } } };
    }
    k.map.delete(id);
    return { status: 200, body: { id, deleted: true } };
  }

  // handle(method, url, body, mode) -> {status, body, wav?}. `mode` is who the request belongs to.
  function handle(method, url, body, mode) {
    const who = people[mode];
    const [path, qs = ""] = url.split("?");
    const q = new URLSearchParams(qs);
    log.push({ method, url, who: mode });
    if (path === "/workbench/workspace/whoami") return { status: 200, body: { subject_sub: who.sub, name: who.name, kind: "user" } };
    if (path === "/workbench/auth/me") return { status: 200, body: { kind: "user", name: who.name } };
    if (path === "/workbench/contract/sessions") return { status: 200, body: { sessions: [] } };
    if (path === "/workbench/intake/jobs") return { status: 200, body: { jobs: [] } };
    if (path === "/workbench/contract/cleanup/sources") return { status: 200, body: { total: 0, sources: [] } };
    if (path === "/workbench/contract/cleanup/reopen-candidates") return { status: 200, body: { candidates: [] } };
    if (path === "/workbench/settings") return { status: 200, body: { settings: [], admin: false } };
    const m = path.match(/^\/workbench\/contract\/cast\/(voices|presenters|teams|formats)(?:\/([^/]+))?(\/sample)?$/);
    if (!m) return err(404, "no such route in the fake: " + method + " " + path);
    const [, kind, rawId, sample] = m;
    const k = KIND[kind];
    const sub = who.sub;
    const id = rawId === undefined ? undefined : decodeURIComponent(rawId);
    if (id === undefined) {
      if (method === "GET") {
        if (state.failList) return err(500, "internal");
        const scope = q.get("scope");
        if (scope !== null && scope !== "mine" && scope !== "shared") return err(400, "scope is mine or shared");
        if (scope === "shared") return { status: 200, body: { [kind]: [], total: 0 } }; // the shared pool is rwr-cast-share's: nothing is shared here
        const limit = Math.min(Math.max(parseInt(q.get("limit") ?? "100", 10) || 100, 1), 500);
        const rows = mine(k.map, sub).sort((a, b) => (kind === "voices" ? a.voice.localeCompare(b.voice) : a.name.localeCompare(b.name)) || a.id.localeCompare(b.id));
        return { status: 200, body: { [kind]: rows.slice(0, limit).map(k.view), total: rows.length } };
      }
      if (method === "POST") return k.write(sub, body, undefined);
      return err(404, "no such route in the fake");
    }
    if (!ID_RE.test(id)) return err(404, NO_SUCH[k.what]);
    const r = k.map.get(id);
    const own = r && r.owner_sub === sub;
    if (sample) {
      if (kind !== "voices" || method !== "POST") return err(404, "no such route in the fake");
      if (!own) return err(404, NO_SUCH.voice);
      if (state.sample === "unset") return err(503, "voice samples are not available on this server");
      if (busy.has(sub)) return err(429, "one sample at a time, and not too many: wait a moment");
      if (state.sample === "down") return err(502, "the voice engine did not answer: try again in a moment");
      state.samples.push({ sub, id, route: r.route, voice: r.voice, speed: r.speed });
      return { status: 200, body: {}, wav: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]) };
    }
    if (!own) return err(404, NO_SUCH[k.what]);
    if (method === "GET") return { status: 200, body: k.view(r) };
    if (method === "PATCH") return k.write(sub, body, id);
    if (method === "DELETE") return remove(kind, sub, id);
    return err(404, "no such route in the fake");
  }

  function hook(name, arg = {}) {
    if (name === "sample") { state.sample = arg.mode; return { sample: state.sample }; }
    if (name === "fail-list") { state.failList = !!arg.on; return { failList: state.failList }; }
    if (name === "busy") { if (arg.on) busy.add(arg.sub); else busy.delete(arg.sub); return { busy: [...busy] }; }
    throw new Error("no such hook " + name);
  }

  return { people, state, log, seed, handle, hook, iso, t, voiceView, presenterView, teamView, formatView };
}
