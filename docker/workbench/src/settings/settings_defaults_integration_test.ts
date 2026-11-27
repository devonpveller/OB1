// deno test src/settings/settings_defaults_integration_test.ts - rwr-settings-defaults (slot 730) over a REAL workbench and database:
// the eight new user keys, the ceiling a default may not pass, the admin research limits as presets inside fixed ranges (each
// preset's exact key values, the ranges enforced by the database whoever writes, the append-only log), and what a non-admin is
// ever sent. SKIPPED unless DOCS_TEST_BASE is set; contract-test/run-workspace-tests.ps1 [5j4] runs it on a DISPOSABLE internal
// network (the real initdb chain incl. slot 730). Users act through the lab's identity header (X-Test-Sub); a request with no
// header is the default subject, the admin with sign-in off.
// Environment: DOCS_TEST_BASE, DOCS_TEST_KEY, CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser).
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("DOCS_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("DOCS_TEST_KEY") ?? "";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 4, true)
  : null;
// each test starts from the shipped state (no stored admin limit) and leaves none behind
const t = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, ignore, sanitizeOps: false, sanitizeResources: false, fn: async () => { await wipe(); try { await fn(); } finally { await wipe(); } } });

const rnd = () => crypto.randomUUID().slice(0, 8);
const A = { "X-Test-Sub": `def-a-${rnd()}` };
const B = { "X-Test-Sub": `def-b-${rnd()}` };
const ADMIN = {};
const S = "/workbench/settings";

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}
async function code(text: string, args: unknown[] = []): Promise<string> {
  const c = await pool!.connect();
  try {
    await c.queryObject("BEGIN");
    await c.queryObject(text, args);
    return "";
  } catch (e) {
    return String((e as { fields?: { code?: string } }).fields?.code ?? (e as Error).message);
  } finally {
    try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
    c.release();
  }
}
async function call(method: string, path: string, body?: unknown, who: Record<string, string> = A) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "x-brain-key": KEY, "content-type": "application/json", ...who },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
// no stored admin limit, and the audit log's rows are kept (append-only): tests read the lines they made by id
const LIMIT_KEYS = `ARRAY['research.max_fetch','research.max_fetch_timeouts','research.max_rounds','research.relevant_target','research.max_wall_ms','research.search_k','research.confidence_floor','research.reuse_max_distance','research.kb_sources_k','curator.shortlist_k','curator.new_thread_min_confidence','curator.merge_floor_distance','curator.conflict_distance']`;
async function wipe() { await sql(`DELETE FROM public.contract_settings WHERE key = ANY(${LIMIT_KEYS})`); }
const lastId = async () => Number((await sql<{ m: string }>(`SELECT coalesce(max(id), 0)::text AS m FROM public.settings_admin_audit`))[0].m);
const stored = async () => Object.fromEntries((await sql<{ key: string; value: unknown }>(`SELECT key, value FROM public.contract_settings WHERE key = ANY(${LIMIT_KEYS}) ORDER BY key`)).map((r) => [r.key, r.value]));
const putUser = (who: Record<string, string>, key: string, value: unknown, version?: number) =>
  call("PUT", `${S}/${key}`, version === undefined ? { value } : { value, version }, who);
const find = (list: { key: string }[], key: string) => list.find((s) => s.key === key) as any;

// THE DOCUMENTED PRESETS (rwr-settings-defaults): the exact key values each preset writes. The test owns this table; the database's
// settings_limit_preset_values must equal it, and applying a preset must store exactly these values and no other key.
const PRESETS: Record<string, Record<string, Record<string, number>>> = {
  run_size: {
    small: { "research.max_fetch": 24, "research.max_fetch_timeouts": 20, "research.max_rounds": 2, "research.relevant_target": 5, "research.max_wall_ms": 300000, "research.search_k": 6, "research.kb_sources_k": 4 },
    standard: { "research.max_fetch": 80, "research.max_fetch_timeouts": 40, "research.max_rounds": 3, "research.relevant_target": 8, "research.max_wall_ms": 900000, "research.search_k": 8, "research.kb_sources_k": 6 },
    large: { "research.max_fetch": 120, "research.max_fetch_timeouts": 60, "research.max_rounds": 4, "research.relevant_target": 12, "research.max_wall_ms": 1500000, "research.search_k": 12, "research.kb_sources_k": 10 },
  },
  judgement: {
    strict: { "research.confidence_floor": 0.65, "research.reuse_max_distance": 0.45 },
    standard: { "research.confidence_floor": 0.5, "research.reuse_max_distance": 0.55 },
    open: { "research.confidence_floor": 0.4, "research.reuse_max_distance": 0.62 },
  },
  curator: {
    careful: { "curator.shortlist_k": 4, "curator.new_thread_min_confidence": 0.7, "curator.merge_floor_distance": 0.35, "curator.conflict_distance": 0.2 },
    standard: { "curator.shortlist_k": 5, "curator.new_thread_min_confidence": 0.6, "curator.merge_floor_distance": 0.45, "curator.conflict_distance": 0.25 },
    broad: { "curator.shortlist_k": 8, "curator.new_thread_min_confidence": 0.5, "curator.merge_floor_distance": 0.55, "curator.conflict_distance": 0.32 },
  },
};
const RANGES: Record<string, [number, number]> = {
  "research.max_fetch": [6, 160], "research.max_fetch_timeouts": [0, 80], "research.max_rounds": [1, 5], "research.relevant_target": [3, 16],
  "research.max_wall_ms": [60000, 1800000], "research.search_k": [3, 16], "research.confidence_floor": [0.3, 0.8], "research.reuse_max_distance": [0.3, 0.7],
  "research.kb_sources_k": [0, 12], "curator.shortlist_k": [2, 10], "curator.new_thread_min_confidence": [0.4, 0.8],
  "curator.merge_floor_distance": [0.25, 0.6], "curator.conflict_distance": [0.1, 0.4],
};

t("D1: each preset writes exactly the documented key values - table-driven, over the route and the database", async () => {
  // the database's table IS the documented table
  const db = await sql<{ grp: string; preset: string; key: string; value: number }>(`SELECT grp, preset, key, value FROM public.settings_limit_preset_values`);
  const flat = db.map((r) => `${r.grp}/${r.preset}/${r.key}=${Number(r.value)}`).sort();
  const doc = Object.entries(PRESETS).flatMap(([g, ps]) => Object.entries(ps).flatMap(([p, kv]) => Object.entries(kv).map(([k, v]) => `${g}/${p}/${k}=${v}`))).sort();
  assertEquals(flat, doc);
  for (const [grp, ps] of Object.entries(PRESETS)) {
    for (const [preset, want] of Object.entries(ps)) {
      await wipe();
      const before = await lastId();
      const r = await call("PUT", `${S}/admin/limits/${grp}`, { preset }, ADMIN);
      assertEquals(r.status, 200, `${grp}/${preset}: ${r.text}`);
      assertEquals(r.json.group, grp);
      assertEquals(r.json.current, preset);
      // exactly this preset's keys are stored, with exactly its values, and no other key is touched
      assertEquals(Object.fromEntries(Object.entries(await stored()).map(([k, v]) => [k, Number(v)])), want, `${grp}/${preset}`);
      // one log line per key, who did it, old (nothing) and new, and the preset
      const lines = await sql<any>(`SELECT * FROM public.settings_admin_audit WHERE id > $1 ORDER BY key`, [before]);
      assertEquals(lines.map((l: any) => l.key), Object.keys(want).sort(), `${grp}/${preset}: one line per key`);
      for (const l of lines) {
        assertEquals(l.action, "set");
        assertEquals(l.old_value, null);
        assertEquals(Number(l.new_value), want[l.key]);
        assertEquals([l.grp, l.preset], [grp, preset]);
        assert(l.actor && !/^db role /.test(l.actor), `actor ${l.actor}`);
      }
      // the same preset again: nothing changes, so nothing is logged
      const again = await lastId();
      assertEquals((await call("PUT", `${S}/admin/limits/${grp}`, { preset }, ADMIN)).status, 200);
      assertEquals(await lastId(), again, "an unchanged apply writes no log line");
    }
  }
});

t("D2: the ranges are the database's, whoever writes - a direct write outside a range is refused, at the edges and past them", async () => {
  for (const [key, [lo, hi]] of Object.entries(RANGES)) {
    const int = !/confidence|distance/.test(key);
    const step = int ? 1 : 0.01;
    for (const v of [lo - step, hi + step]) {
      assertEquals(await code(`INSERT INTO public.contract_settings (key, value, updated_by) VALUES ($1, $2::jsonb, 'x')`, [key, JSON.stringify(v)]), "22023", `${key}=${v} is outside ${lo}..${hi}`);
    }
    for (const v of [lo, hi]) {
      assertEquals(await code(`INSERT INTO public.contract_settings (key, value, updated_by) VALUES ($1, $2::jsonb, 'x')`, [key, JSON.stringify(v)]), "", `${key}=${v} is inside ${lo}..${hi}`);
    }
    for (const bad of ['"24"', "null", "true", "[24]", "{}"]) {
      assertEquals(await code(`INSERT INTO public.contract_settings (key, value, updated_by) VALUES ($1, $2::jsonb, 'x')`, [key, bad]), "22023", `${key}=${bad}`);
    }
  }
  assertEquals(await code(`INSERT INTO public.contract_settings (key, value, updated_by) VALUES ('research.max_fetch', '24.5'::jsonb, 'x')`), "22023", "a whole-number limit refuses a fraction");
  // an UPDATE of a stored limit is judged too
  await sql(`INSERT INTO public.contract_settings (key, value, updated_by) VALUES ('research.max_fetch', '24', 'x')`);
  assertEquals(await code(`UPDATE public.contract_settings SET value = '161' WHERE key = 'research.max_fetch'`), "22023");
  assertEquals((await stored())["research.max_fetch"], 24);
});

t("D3: no raw number reaches a limit over HTTP - the per-key admin door is closed, a body of values is refused, nothing is stored", async () => {
  const before = await lastId();
  assertEquals((await call("PUT", `${S}/admin/research.max_fetch`, { value: 30 }, ADMIN)).status, 409);
  assertEquals((await call("DELETE", `${S}/admin/research.max_fetch`, undefined, ADMIN)).status, 409);
  for (const body of [{ values: { "research.max_fetch": 999 } }, { preset: "small", values: { "research.max_fetch": 999 } }, { "research.max_fetch": 30 }, { preset: 30 }, { preset: "nope" }, {},
    { key: "research.max_fetch", value: 30 }, { preset: "small", key: "research.max_fetch", value: 30 }, { preset: "small", value: 30 }, { preset: "small", extra: 1 }]) {
    const r = await call("PUT", `${S}/admin/limits/run_size`, body, ADMIN);
    assert(r.status === 400 || r.status === 404, `${JSON.stringify(body)} -> ${r.status}`);
    assertEquals(await stored(), {}, `${JSON.stringify(body)} stored something`);
  }
  assertEquals((await call("PUT", `${S}/admin/limits/no_such_group`, { preset: "small" }, ADMIN)).status, 404);
  assertEquals((await call("PUT", `${S}/admin/limits/run_size`, { preset: "strict" }, ADMIN)).status, 404, "another group's preset is not this group's");
  assertEquals(await stored(), {});
  assertEquals(await lastId(), before);
  // and the admin keys are listed read-only (no editable limit)
  const adm = await call("GET", `${S}/admin`, undefined, ADMIN);
  for (const s of adm.json.settings.filter((x: any) => x.key in RANGES)) assertEquals(s.editable, false, s.key);
});

t("D4: every admin change is a log line - who, what, old value, new value; a direct psql write too; and the log cannot be edited", async () => {
  const before = await lastId();
  assertEquals((await call("PUT", `${S}/admin/limits/run_size`, { preset: "small" }, ADMIN)).status, 200);
  assertEquals((await call("PUT", `${S}/admin/limits/run_size`, { preset: "large" }, ADMIN)).status, 200);
  const l = await sql<any>(`SELECT * FROM public.settings_admin_audit WHERE id > $1 AND key = 'research.max_fetch' ORDER BY id`, [before]);
  assertEquals(l.map((x: any) => [x.action, x.old_value === null ? null : Number(x.old_value), Number(x.new_value), x.preset]), [["set", null, 24, "small"], ["set", 24, 120, "large"]]);
  // reset: the stored values go, one 'clear' line per key, the old value kept
  assertEquals((await call("DELETE", `${S}/admin/limits/run_size`, undefined, ADMIN)).status, 200);
  const c = await sql<any>(`SELECT * FROM public.settings_admin_audit WHERE id > $1 AND action = 'clear' AND key = 'research.max_fetch'`, [before]);
  assertEquals(c.length, 1);
  assertEquals([Number(c[0].old_value), c[0].new_value, c[0].preset], [120, null, "env"]);
  assertEquals(await stored(), {});
  // a write that names nobody still leaves a line that says so
  const b2 = await lastId();
  await sql(`INSERT INTO public.contract_settings (key, value) VALUES ('research.search_k', '9')`);
  await sql(`UPDATE public.contract_settings SET value = '10' WHERE key = 'research.search_k'`);
  await sql(`DELETE FROM public.contract_settings WHERE key = 'research.search_k'`);
  const d = await sql<any>(`SELECT * FROM public.settings_admin_audit WHERE id > $1 ORDER BY id`, [b2]);
  // a write that does not come through the logging writers is logged as the database role that made it, never as a name it supplies
  assert(d.length === 3 && d.every((x: any) => /^db role \S+ \(a direct write\)$/.test(x.actor) && x.preset === null && x.grp === null), JSON.stringify(d.map((x: any) => x.actor)));
  assertEquals(d.map((x: any) => x.action), ["set", "set", "clear"]);
  // a no-op UPDATE writes nothing
  await sql(`INSERT INTO public.contract_settings (key, value, updated_by) VALUES ('research.search_k', '9', 'x')`);
  const b3 = await lastId();
  await sql(`UPDATE public.contract_settings SET value = '9' WHERE key = 'research.search_k'`);
  assertEquals(await lastId(), b3);
  // append-only, for every role including the superuser
  assertEquals(await code(`UPDATE public.settings_admin_audit SET actor = 'x'`), "42501");
  assertEquals(await code(`DELETE FROM public.settings_admin_audit`), "42501");
  assertEquals(await code(`TRUNCATE public.settings_admin_audit`), "42501");
  // and the app roles hold no write on it, nor the right to run the limit writers
  for (const role of ["service_role", "ob_workbench"]) {
    for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      assertEquals((await sql<{ h: boolean }>(`SELECT has_table_privilege($1, 'public.settings_admin_audit', $2) AS h`, [role, p]))[0].h, false, `${role} ${p}`);
    }
  }
  for (const f of ["settings_limits_apply(text,text,text)", "settings_limits_reset(text,text)", "admin_setting_clear(text,text)"]) {
    assertEquals((await sql<{ h: boolean }>(`SELECT has_function_privilege('service_role', 'public.${f}', 'EXECUTE') AS h`))[0].h, false, `service_role must not run ${f}`);
    assertEquals((await sql<{ h: boolean }>(`SELECT has_function_privilege('ob_workbench', 'public.${f}', 'EXECUTE') AS h`))[0].h, true);
  }
});

t("D5: the admin reads the log over HTTP; a non-admin cannot read or write the limits or the log on any route", async () => {
  await call("PUT", `${S}/admin/limits/judgement`, { preset: "strict" }, ADMIN);
  const log = await call("GET", `${S}/admin/limits/log?limit=5`, undefined, ADMIN);
  assertEquals(log.status, 200, log.text);
  assert(log.json.log.length >= 2 && log.json.log.length <= 5);
  assert(log.json.log[0].id > log.json.log[1].id, "newest first");
  assertEquals(log.json.log.find((x: any) => x.key === "research.confidence_floor").new_value, 0.65);
  const groups = await call("GET", `${S}/admin/limits`, undefined, ADMIN);
  assertEquals(groups.json.groups.map((g: any) => g.group), ["run_size", "judgement", "curator"]);
  assertEquals(groups.json.groups.find((g: any) => g.group === "judgement").current, "strict");
  assertEquals(groups.json.groups.find((g: any) => g.group === "run_size").current, "standard", "no stored value = the deployed defaults = standard");
  // nothing stored for run size: the values shown are the deployed (compose) defaults, flagged as defaults
  const rv = Object.fromEntries(groups.json.groups.find((g: any) => g.group === "run_size").values.map((v: any) => [v.key, [v.value, v.is_default]]));
  assertEquals([rv["research.max_fetch"], rv["research.max_fetch_timeouts"], rv["research.max_wall_ms"]], [[80, true], [40, true], [900000, true]]);
  // a non-admin, every route and spelling: the same refusal as any admin door, nothing read, nothing written
  const refusal = (await call("DELETE", `${S}/admin/whatever.x`, undefined, A)).text;
  const before = await lastId();
  const stBefore = await stored();
  for (const [m, p, b] of [
    ["GET", `${S}/admin/limits`], ["GET", `${S}/admin/limits/log`], ["GET", `${S}/admin/limits/log?limit=1`],
    ["PUT", `${S}/admin/limits/run_size`, { preset: "large" }], ["DELETE", `${S}/admin/limits/run_size`], ["PUT", `${S}/admin/limits/judgement`, { preset: "open" }],
    ["PUT", `${S}/admin/limits/%72un_size`, { preset: "large" }], ["PUT", `${S}/admin/limits/run_size/`, { preset: "large" }], ["GET", `${S}/admin/limits/`],
    ["PUT", `${S}/admin/research.max_fetch`, { value: 30 }], ["GET", `${S}/admin`],
  ] as [string, string, unknown?][]) {
    for (const who of [A, B, { "X-Test-Sub": "svc-like" }]) {
      const r = await call(m, p, b, who);
      assert([403, 404].includes(r.status), `${m} ${p}: ${r.status} ${r.text}`);
      assert(!/max_fetch|confidence_floor|"groups"|"log"/.test(r.text), `${m} ${p} leaks: ${r.text}`);
      if (r.status === 403) assertEquals(r.text, refusal, `${m} ${p}`);
    }
  }
  assertEquals(await lastId(), before);
  assertEquals(await stored(), stBefore);
});

t("D6: an admin limit is invisible to a non-admin on the user door in every spelling - the same answer as a key that does not exist", async () => {
  const adminKeys = (await sql<{ key: string }>(`SELECT key FROM public.settings_keys WHERE tier = 'admin'`)).map((r) => r.key);
  assert(adminKeys.length >= 14);
  // a refusal is compared with the one for a twin that does not exist, the key's echo aside
  const shape = (s: string) => s.replace(/"error":"[^"]* is not a setting"/, '"error":"NOT_A_SETTING"');
  const spell = (k: string) => [k, k.toUpperCase(), k + "%20", "%20" + k, k.replace(".", "%2E"), k.replace(/^./, (c) => "%" + c.charCodeAt(0).toString(16)), k + "/", k + ".", k.replace(".", "..")];
  for (const k of adminKeys) {
    const spelled = spell(k), twins = spell("nosuch." + k.split(".").slice(1).join("."));
    for (let i = 0; i < spelled.length; i++) {
      for (const [m, b] of [["PUT", { value: 5 }], ["DELETE", undefined]] as [string, unknown][]) {
        const real = await call(m, `${S}/${spelled[i]}`, b, A);
        const fake = await call(m, `${S}/${twins[i]}`, b, A);
        assertEquals(real.status, fake.status, `${m} ${spelled[i]} vs ${twins[i]}`);
        assertEquals(shape(real.text), shape(fake.text), `${m} ${spelled[i]}`);
        assert([400, 404, 405].includes(real.status), `${m} ${spelled[i]}: ${real.status}`);
      }
    }
  }
  // never in the list, with the ceiling the one thing a limit lends a user
  const mine = await call("GET", S, undefined, A);
  assertEquals(mine.json.settings.filter((s: any) => s.tier !== "user").length, 0);
  for (const k of adminKeys) assert(!mine.text.includes(k), `${k} in a non-admin's list`);
});

t("D7: a default above the ceiling is refused with the ceiling named; a default at it is saved; the ceiling follows the admin's limit", async () => {
  const ASK = "research.ask_over_fetch";
  // nothing stored: the ceiling is what the service really runs on (the compose default, 80 pages)
  assertEquals(find((await call("GET", S, undefined, A)).json.settings, ASK).ceiling, 80);
  const over = await putUser(A, ASK, 81);
  assertEquals(over.status, 400, over.text);
  assert(over.json.error.includes("at most 80"), over.json.error);
  assert(!over.json.error.includes("max_fetch"), "the refusal does not name the admin key");
  assertEquals((await putUser(A, ASK, 80)).status, 200);
  assertEquals((await putUser(A, ASK, 40, 1)).status, 200, "40 is allowed: runs read up to 80");
  // the admin picks Small (24 pages): the ceiling is 24; a stored 40 is NOT altered on read, but a new value above 24 is refused
  assertEquals((await call("PUT", `${S}/admin/limits/run_size`, { preset: "small" }, ADMIN)).status, 200);
  const row = find((await call("GET", S, undefined, A)).json.settings, ASK);
  assertEquals([row.value, row.ceiling], [40, 24], "a stored value is returned as stored, with the ceiling beside it");
  const o2 = await putUser(A, ASK, 25, row.version);
  assertEquals(o2.status, 400);
  assert(o2.json.error.includes("at most 24"), o2.json.error);
  assertEquals((await putUser(A, ASK, 24, row.version)).status, 200);
  // large: ceiling 120
  await call("PUT", `${S}/admin/limits/run_size`, { preset: "large" }, ADMIN);
  assertEquals(find((await call("GET", S, undefined, A)).json.settings, ASK).ceiling, 120);
  assertEquals((await putUser(B, ASK, 120)).status, 200);
  assertEquals((await putUser(B, ASK, 121, 1)).status, 400);
  // the database refuses it whoever writes (the trigger), here as the superuser
  assertEquals(await code(`INSERT INTO public.user_settings (owner_sub, key, value) VALUES ('def-direct', $1, '121')`, [ASK]), "22023");
  assertEquals(await code(`INSERT INTO public.user_settings (owner_sub, key, value) VALUES ('def-direct', $1, '120')`, [ASK]), "");
  // nothing stored again: the deployed default
  await call("DELETE", `${S}/admin/limits/run_size`, undefined, ADMIN);
  assertEquals(find((await call("GET", S, undefined, A)).json.settings, ASK).ceiling, 80);
  await sql(`DELETE FROM public.user_settings WHERE owner_sub = ANY($1)`, [[A["X-Test-Sub"], B["X-Test-Sub"]]]);
});

t("D8: the user keys - types, ranges and refusals; a default format must be one of the person's own; nothing is dropped on read", async () => {
  const bad: [string, unknown][] = [
    ["research.default_depth", "shallow"], ["research.default_depth", 3], ["research.ask_over_fetch", 0], ["research.ask_over_fetch", 201], ["research.ask_over_fetch", 2.5],
    ["library.how_far_out", 0], ["library.how_far_out", 4], ["library.recent_size", 0], ["library.recent_size", 25], ["library.clear_on_signout", "yes"],
    ["library.hidden_suggestions", [{ kind: "run", id: "r-1" }]], ["library.hidden_suggestions", [{ kind: "topic", id: "has space" }]], ["library.hidden_suggestions", [{ kind: "topic" }]], ["library.hidden_suggestions", "a"],
    ["podcast.episode_minutes", 2], ["podcast.episode_minutes", 31], ["podcast.default_format", "no-such-format"],
  ];
  for (const [k, v] of bad) {
    const r = await putUser(A, k, v);
    assert(r.status === 400, `${k}=${JSON.stringify(v)} must be refused (400), got ${r.status} ${r.text.slice(0, 200)}`);
  }
  const good: [string, unknown][] = [
    ["research.default_depth", "deep"], ["research.ask_over_fetch", 10], ["library.how_far_out", 3], ["library.recent_size", 5], ["library.clear_on_signout", true],
    ["library.hidden_suggestions", [{ kind: "topic", id: "t-1" }, { kind: "gap", id: "g_2" }]], ["podcast.episode_minutes", 15],
  ];
  for (const [k, v] of good) assertEquals((await putUser(A, k, v)).status, 200, k);
  const list = (await call("GET", S, undefined, A)).json.settings;
  for (const [k, v] of good) assertEquals(find(list, k).value, v, `${k} is returned exactly as stored`);
  // a podcast format: the person's own is accepted (by id or by name), another person's is a refusal like a missing one
  const team = `def-team-${rnd()}`, fmt = `def-fmt-${rnd()}`;
  await sql(`INSERT INTO public.podcast_teams (id, owner_sub, name) VALUES ($1, $2, 'My team')`, [team, A["X-Test-Sub"]]);
  await sql(`INSERT INTO public.podcast_formats (id, owner_sub, name, team_id) VALUES ($1, $2, 'My format', $3)`, [fmt, A["X-Test-Sub"], team]);
  try {
    assertEquals((await putUser(A, "podcast.default_format", fmt)).status, 200);
    assertEquals((await putUser(A, "podcast.default_format", "My format")).status, 200);
    const mine = await putUser(B, "podcast.default_format", fmt);
    const none = await putUser(B, "podcast.default_format", "def-fmt-missing");
    assertEquals(mine.status, 400);
    assertEquals(mine.text.replace(fmt, "X"), none.text.replace("def-fmt-missing", "X"), "another person's format answers as a missing one");
  } finally {
    await sql(`DELETE FROM public.user_settings WHERE key = 'podcast.default_format'`);
    await sql(`DELETE FROM public.podcast_formats WHERE id = $1`, [fmt]);
    await sql(`DELETE FROM public.podcast_teams WHERE id = $1`, [team]);
  }
  await sql(`DELETE FROM public.user_settings WHERE owner_sub = ANY($1)`, [[A["X-Test-Sub"], B["X-Test-Sub"]]]);
});

t("D9: two identities - B never sees A's defaults: not the values, the versions, the count, nor a refusal that says a row exists", async () => {
  await putUser(A, "research.default_depth", "deep");
  await putUser(A, "library.hidden_suggestions", [{ kind: "topic", id: "secret-topic-1" }]);
  await putUser(A, "research.ask_over_fetch", 17);
  const a = (await call("GET", S, undefined, A)).json.settings.filter((s: any) => !s.is_default);
  const b = await call("GET", S, undefined, B);
  assertEquals(b.json.settings.filter((s: any) => !s.is_default).length, 0, "B has stored nothing: no values, no count");
  for (const s of b.json.settings) assertEquals([s.value, s.updated_at], [null, null], s.key);
  assert(!b.text.includes("secret-topic-1"), "A's values are nowhere in B's list");
  assertEquals(a.length, 3);
  // B's stale-version write of A's key: a refusal that does not reveal A's version
  const stale = await putUser(B, "research.default_depth", "quick", 1);
  assertEquals(stale.status, 409);
  assert(stale.json.error.includes("version 0"), stale.json.error);
  // B deleting a key B never stored: nothing of A's is touched
  await call("DELETE", `${S}/research.default_depth`, undefined, B);
  assertEquals(find((await call("GET", S, undefined, A)).json.settings, "research.default_depth").value, "deep");
  await sql(`DELETE FROM public.user_settings WHERE owner_sub = ANY($1)`, [[A["X-Test-Sub"], B["X-Test-Sub"]]]);
});

t("D10: the services read an admin limit through the one function: NULL until an admin picks a preset (env stays the fallback), then the preset's value", async () => {
  assertEquals((await sql<{ v: unknown }>(`SELECT public.setting_get(NULL, 'research.max_fetch') AS v`))[0].v, null);
  await call("PUT", `${S}/admin/limits/run_size`, { preset: "small" }, ADMIN);
  assertEquals((await sql<{ v: unknown }>(`SELECT public.setting_get(NULL, 'research.max_fetch') AS v`))[0].v, 24);
  assertEquals((await sql<{ v: unknown }>(`SELECT public.setting_get(NULL, 'research.max_wall_ms') AS v`))[0].v, 300000);
  assertEquals((await sql<{ v: unknown }>(`SELECT public.setting_get(NULL, 'curator.shortlist_k') AS v`))[0].v, null, "another group is untouched");
  await call("DELETE", `${S}/admin/limits/run_size`, undefined, ADMIN);
  assertEquals((await sql<{ v: unknown }>(`SELECT public.setting_get(NULL, 'research.max_fetch') AS v`))[0].v, null);
});

t("D11: a value no preset names reads as 'custom' and is never rewritten; two admins applying different presets at once leave exactly one preset", async () => {
  await sql(`INSERT INTO public.contract_settings (key, value, updated_by) VALUES ('research.max_fetch', '31', 'psql')`);
  const g = (await call("GET", `${S}/admin/limits`, undefined, ADMIN)).json.groups.find((x: any) => x.group === "run_size");
  assertEquals(g.current, "custom");
  assertEquals(g.values.find((v: any) => v.key === "research.max_fetch").value, 31, "the stored value is shown as stored");
  assertEquals((await stored())["research.max_fetch"], 31);
  await wipe();
  const rs = await Promise.all(["small", "large", "standard", "small", "large"].map((p) => call("PUT", `${S}/admin/limits/run_size`, { preset: p }, ADMIN)));
  for (const r of rs) assertEquals(r.status, 200, r.text);
  const cur = (await call("GET", `${S}/admin/limits`, undefined, ADMIN)).json.groups.find((x: any) => x.group === "run_size").current;
  assertNotEquals(cur, "custom", "the values are one preset's, never a mix");
  assertEquals(Object.fromEntries(Object.entries(await stored()).map(([k, v]) => [k, Number(v)])), PRESETS.run_size[cur]);
});

// run statements in ONE transaction that is always rolled back (so nothing, not even a log line, is left behind); returns the first
// refusal's SQLSTATE ("" when none) and the rows of the last statement
async function inTx(stmts: [string, unknown[]?][]): Promise<{ code: string; rows: any[] }> {
  const c = await pool!.connect();
  let rows: any[] = [];
  try {
    await c.queryObject("BEGIN");
    for (const [q, a] of stmts) rows = (await c.queryObject(q, a ?? [])).rows;
    return { code: "", rows };
  } catch (e) {
    return { code: String((e as { fields?: { code?: string } }).fields?.code ?? (e as Error).message), rows: [] };
  } finally {
    try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
    c.release();
  }
}
const LAST_LINE: [string] = [`SELECT actor, grp, preset, action, new_value FROM public.settings_admin_audit ORDER BY id DESC LIMIT 1`];

t("D12: no change of the admin tier is unlogged or forged - TRUNCATE is refused for every role; a write that names itself as an admin is logged as the database role", async () => {
  // TRUNCATE (statement privilege the app roles hold through service_role): refused, the stored limits stay
  await call("PUT", `${S}/admin/limits/run_size`, { preset: "small" }, ADMIN);
  const before = await lastId();
  for (const role of ["ob_workbench", "ob_app_memory", "service_role", null]) {
    const set: [string, unknown[]?][] = role ? [[`SET LOCAL ROLE ${role}`]] : [];
    const r = await inTx([...set, [`TRUNCATE public.contract_settings`]]);
    assertEquals(r.code, "42501", `TRUNCATE as ${role ?? "the superuser"} must be refused`);
    assertEquals(await inTx([...set, [`TRUNCATE public.contract_settings CASCADE`]]).then((x) => x.code), "42501", `TRUNCATE CASCADE as ${role ?? "the superuser"}`);
  }
  assertEquals((await stored())["research.max_fetch"], 24, "the stored limits are still there");
  assertEquals(await lastId(), before);
  // forgery: an app role sets every value the old trigger trusted, then writes a limit
  for (const role of ["ob_app_memory", "ob_workbench"]) {
    const r = await inTx([
      [`SET LOCAL ROLE ${role}`],
      [`SELECT set_config('workbench.settings_actor', 'u-admin', true) AS a, set_config('workbench.settings_group', 'run_size', true) AS g, set_config('workbench.settings_preset', 'large', true) AS p`],
      [`INSERT INTO public.contract_settings (key, value, updated_by) VALUES ('research.max_fetch', '60', 'u-admin') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = 'u-admin'`],
      [`RESET ROLE`],
      LAST_LINE,
    ]);
    assertEquals(r.code, "", role);
    const l = r.rows[0];
    assert(/^db role \S+ \(a direct write\)$/.test(l.actor), `${role}: the log says ${l.actor}`);
    assertEquals([l.grp, l.preset, l.action, Number(l.new_value)], [null, null, "set", 60], role);
    // and a delete naming an admin
    const d = await inTx([[`SET LOCAL ROLE ${role}`], [`SELECT set_config('workbench.settings_actor', 'u-admin', true)`], [`DELETE FROM public.contract_settings WHERE key = 'research.max_fetch'`], [`RESET ROLE`], LAST_LINE]);
    assert(/^db role /.test(d.rows[0].actor) && d.rows[0].action === "clear" && d.rows[0].preset === null, `${role} delete: ${d.rows[0]?.actor}`);
  }
  // the context the real writers use cannot be read or written by an app role
  for (const role of ["ob_app_memory", "ob_workbench", "service_role"]) {
    assertEquals((await inTx([[`SET LOCAL ROLE ${role}`], [`INSERT INTO public.settings_audit_context (txid, actor) VALUES (txid_current(), 'u-admin')`]])).code, "42501", `${role} insert`);
    assertEquals((await inTx([[`SET LOCAL ROLE ${role}`], [`SELECT * FROM public.settings_audit_context`]])).code, "42501", `${role} select`);
  }
  // the contract door's PUT: a body naming someone else in `by` is ignored, the log names the real admin
  const forged = await call("PUT", `/workbench/contract/settings/podcast.archive_destination`, { value: { mount: "podcast-archive" }, by: "u-someone-else" }, ADMIN);
  assertEquals(forged.status, 200, forged.text);
  const fl = (await sql<any>(`SELECT actor FROM public.settings_admin_audit WHERE key = 'podcast.archive_destination' ORDER BY id DESC LIMIT 1`))[0];
  assert(fl && fl.actor !== "u-someone-else" && !/^db role /.test(fl.actor), `the log says ${fl?.actor}`);
  await sql(`DELETE FROM public.contract_settings WHERE key = 'podcast.archive_destination'`);
  // the real writer still names the admin and the preset (through the route), and leaves no context row behind
  await call("PUT", `${S}/admin/limits/run_size`, { preset: "large" }, ADMIN);
  const last = (await sql<any>(`SELECT actor, preset FROM public.settings_admin_audit WHERE key = 'research.max_fetch' ORDER BY id DESC LIMIT 1`))[0];
  assertEquals(last.preset, "large");
  assert(!/^db role /.test(last.actor), last.actor);
  assertEquals((await sql<any>(`SELECT count(*)::int AS n FROM public.settings_audit_context`))[0].n, 0);
});
