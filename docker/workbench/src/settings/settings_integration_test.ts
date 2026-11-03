// deno test src/settings/settings_integration_test.ts - the settings store (research-workbench rw-settings-store,
// plan 08 PD3) over a REAL workbench and database: the routes, the read function services use
// (public.setting_get), the registry's validation, the tiers, and the database's own guard.
//
// SKIPPED unless DOCS_TEST_BASE is set. contract-test/run-workspace-tests.ps1 [5j] runs it on a DISPOSABLE internal
// network (the real initdb chain incl. slot 400, fixtures.sql). Two users act through the lab's identity header
// (WORKSPACE_IDENTITY_HEADER=X-Test-Sub); a request with no header is the default subject ("operator") with
// sign-in off - the single-user mode, where that subject is the admin. The app role's view of the database is
// taken with SET LOCAL ROLE on the superuser connection. Never point it at a live stack.
// Environment: DOCS_TEST_BASE, DOCS_TEST_KEY, CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("DOCS_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("DOCS_TEST_KEY") ?? "";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const APP_ROLE = Deno.env.get("IDEAS_TEST_APP_ROLE") ?? "ob_app_memory";
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 3, true)
  : null;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });

const rnd = () => crypto.randomUUID().slice(0, 8);
const A = { "X-Test-Sub": `settings-a-${rnd()}` };
const B = { "X-Test-Sub": `settings-b-${rnd()}` };
const ADMIN = {}; // no header: the default subject, the admin with sign-in off
const sub = (u: Record<string, string>) => u["X-Test-Sub"];
const S = "/workbench/settings";

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}
async function refusedAsApp(text: string, args: unknown[] = []): Promise<string> {
  const c = await pool!.connect();
  try {
    await c.queryObject("BEGIN");
    await c.queryObject(`SET LOCAL ROLE ${APP_ROLE}`);
    await c.queryObject(text, args);
    await c.queryObject("ROLLBACK");
    return "";
  } catch (e) {
    try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
    return String((e as { fields?: { code?: string } }).fields?.code ?? (e as Error).message);
  } finally {
    c.release();
  }
}
// as the superuser, in a transaction rolled back: "" = accepted, else the refusal code
async function refused(text: string, args: unknown[] = []): Promise<string> {
  const c = await pool!.connect();
  try {
    await c.queryObject("BEGIN");
    await c.queryObject(text, args);
    await c.queryObject("ROLLBACK");
    return "";
  } catch (e) {
    try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
    return String((e as { fields?: { code?: string } }).fields?.code ?? (e as Error).message);
  } finally {
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
const get = async (who: Record<string, string>, key: string) =>
  (await call("GET", S, undefined, who)).json.settings?.find((s: { key: string }) => s.key === key);
const readFn = async (owner: string | null, key: string) => (await sql<{ v: unknown }>(`SELECT public.setting_get($1, $2) AS v`, [owner, key]))[0].v;

t("I0: no stored values: every key reads NULL through setting_get (each service keeps its env value / default)", async () => {
  const keys = await sql<{ key: string; tier: string }>(`SELECT key, tier FROM public.settings_keys ORDER BY key`);
  assert(keys.length >= 10, `the registry holds the first tranche (${keys.length})`);
  for (const k of keys.filter((x) => x.tier === "user")) assertEquals(await readFn(sub(A), k.key), null, k.key);
  for (const k of keys.filter((x) => x.tier === "admin" && x.key !== "podcast.archive_destination")) assertEquals(await readFn(null, k.key), null, k.key);
  assertEquals(await readFn(null, "refinery.dormancy_days"), null, "a service without an owner reads nothing: its env value");
  const mine = await call("GET", S);
  assertEquals(mine.status, 200, mine.text);
  assert(mine.json.settings.every((s: { is_default: boolean; value: unknown }) => s.is_default && s.value === null), "everything at its default");
  assert(mine.json.settings.every((s: { tier: string }) => s.tier === "user"), "the user GET lists the user tier only");
});

t("I1: two users, different values for the same key: each reads only their own, through the routes and the read function", async () => {
  assertEquals((await call("PUT", `${S}/refinery.dormancy_days`, { value: 3 }, A)).status, 200);
  assertEquals((await call("PUT", `${S}/refinery.dormancy_days`, { value: 30 }, B)).status, 200);
  assertEquals((await get(A, "refinery.dormancy_days")).value, 3);
  assertEquals((await get(B, "refinery.dormancy_days")).value, 30);
  assertEquals(await readFn(sub(A), "refinery.dormancy_days"), 3);
  assertEquals(await readFn(sub(B), "refinery.dormancy_days"), 30);
  // no route takes an owner: a query or body naming B still reads / writes A's own
  const viaQuery = await call("GET", `${S}?owner_sub=${encodeURIComponent(sub(B))}&owner=${encodeURIComponent(sub(B))}`, undefined, A);
  assertEquals(viaQuery.json.settings.find((s: { key: string }) => s.key === "refinery.dormancy_days").value, 3);
  assert(!viaQuery.text.includes(sub(B)), "A's answer carries nothing of B's");
  assertEquals((await call("PUT", `${S}/refinery.dormancy_days`, { value: 5, owner_sub: sub(B) }, A)).status, 200);
  assertEquals(await readFn(sub(B), "refinery.dormancy_days"), 30, "A's write never reaches B's value");
  assertEquals(await readFn(sub(A), "refinery.dormancy_days"), 5);
  // A's DELETE is A's alone
  assertEquals((await call("DELETE", `${S}/refinery.dormancy_days`, undefined, A)).json.is_default, true);
  assertEquals(await readFn(sub(A), "refinery.dormancy_days"), null);
  assertEquals(await readFn(sub(B), "refinery.dormancy_days"), 30);
  const rows = await sql<{ owner_sub: string; updated_by: string }>(`SELECT owner_sub, updated_by FROM public.user_settings WHERE key = 'refinery.dormancy_days' AND owner_sub IN ($1, $2)`, [sub(A), sub(B)]);
  assertEquals(rows.map((r) => [r.owner_sub, r.updated_by]), [[sub(B), sub(B)]], "the row is B's, written by B");
  // a stale version is refused and changes nothing
  const stale = await call("PUT", `${S}/refinery.dormancy_days`, { value: 31, version: 0 }, B);
  assertEquals(stale.status, 409, stale.text);
  assertEquals(await readFn(sub(B), "refinery.dormancy_days"), 30);
});

t("I2: a non-admin's PUT of an admin key is refused (403) on every door and changes nothing", async () => {
  const before = await sql(`SELECT key, value, version FROM public.contract_settings ORDER BY key`);
  for (const [m, p, b] of [
    ["PUT", `${S}/admin/podcast.archive_destination`, { value: { mount: "podcast-archive" } }],
    ["PUT", `${S}/podcast.archive_destination`, { value: { mount: "podcast-archive" } }],
    ["DELETE", `${S}/admin/podcast.archive_destination`, undefined],
    ["PUT", `${S}/admin/research.max_fetch`, { value: 99 }],
    ["GET", `${S}/admin`, undefined],
    ["PUT", `/workbench/contract/settings/podcast.archive_destination`, { value: { mount: "podcast-archive" } }],
  ] as [string, string, unknown][]) {
    const r = await call(m, p, b, A);
    assertEquals(r.status, 403, `${m} ${p}: ${r.text}`);
  }
  assertEquals(await sql(`SELECT key, value, version FROM public.contract_settings ORDER BY key`), before, "the admin tier is unchanged");
  assertEquals((await call("GET", S, undefined, A)).json.admin, false, "the panel shows no Admin section");
});

t("I3: the admin (the default subject, sign-in off) reads the shared tier; research tuning is read-only; an editable shared key is written", async () => {
  const me = await call("GET", S, undefined, ADMIN);
  assertEquals(me.json.admin, true, me.text);
  const adm = await call("GET", `${S}/admin`, undefined, ADMIN);
  assertEquals(adm.status, 200, adm.text);
  const keys = adm.json.settings.map((s: { key: string }) => s.key);
  assert(keys.includes("podcast.archive_destination") && keys.includes("research.max_fetch") && keys.includes("curator.conflict_distance"), keys.join(","));
  assert(adm.json.settings.filter((s: { section: string }) => s.section === "research").every((s: { editable: boolean }) => !s.editable), "research tuning read-only");
  assertEquals((await call("PUT", `${S}/admin/research.max_fetch`, { value: 99 }, ADMIN)).status, 409);
  assertEquals(await readFn(null, "research.max_fetch"), null);
  // the archive destination goes through the slot-230 store's own validation
  assertEquals((await call("PUT", `${S}/admin/podcast.archive_destination`, { value: { path: "/etc" } }, ADMIN)).status, 400);
  const w = await call("PUT", `${S}/admin/podcast.archive_destination`, { value: { mount: "podcast-archive" } }, ADMIN);
  assertEquals(w.status, 200, w.text);
  assertEquals(await readFn(null, "podcast.archive_destination"), { mount: "podcast-archive" });
  assertEquals(await readFn(sub(A), "podcast.archive_destination"), { mount: "podcast-archive" }, "an admin key reads the same for every owner");
  const contract = await call("GET", `/workbench/contract/settings/podcast.archive_destination`, undefined, ADMIN);
  assertEquals(contract.json.is_default, false, "the contract store is the admin tier: it sees the write");
  assertEquals((await call("DELETE", `${S}/admin/podcast.archive_destination`, undefined, ADMIN)).json.is_default, true);
  // a user key is never written as a shared one
  assertEquals((await call("PUT", `${S}/admin/refinery.dormancy_days`, { value: 4 }, ADMIN)).status, 400);
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.contract_settings WHERE key = 'refinery.dormancy_days'`))[0].n, 0);
});

t("I4: a value failing the registry's validation is refused (400) and nothing is stored", async () => {
  const team = `settings-team-${rnd()}`;
  await sql(`INSERT INTO public.podcast_teams (id, owner_sub, name) VALUES ($1, $2, $3)`, [team, sub(B), `B's team ${team}`]);
  const cases: [string, unknown, string][] = [
    ["refinery.dormancy_days", 0, "at least 1"],
    ["refinery.dormancy_days", 400, "at most 365"],
    ["refinery.dormancy_days", 2.5, "whole number"],
    ["refinery.dormancy_days", "7", "a number"],
    ["refinery.resurface_max_dist", 2, "at most 1"],
    ["refinery.brainstorm", "yes", "true or false"],
    ["digest.window_hours", 169, "at most 168"],
    ["podcast.team", "no-such-team", "no podcast team of yours"],
    ["podcast.team", team, "no podcast team of yours"], // B's team is not A's
    ["podcast.team", "sk-0123456789abcdef0123456789", "credential"],
    // round 2 (review A3): not only at the start - a leading space, or a credential inside the text
    ["podcast.team", " sk-0123456789abcdef0123456789", "credential"],
    ["podcast.team", "my team ghp_0123456789abcdef0123456789abcd", "credential"],
    ["podcast.team", "Bearer abc.def.ghi", "credential"],
    // round 2 (review D1): a NUL is a 400 with a reason, never a 500
    ["podcast.team", `a${String.fromCharCode(0)}b`, "NUL"],
    ["podcast.team", "x".repeat(121), "at most 120"],
  ];
  for (const [k, v, why] of cases) {
    const r = await call("PUT", `${S}/${k}`, { value: v }, A);
    assertEquals(r.status, 400, `${k}=${JSON.stringify(v)}: ${r.text}`);
    assert(String(r.json.error).includes(why), `${k}: ${r.json.error}`);
  }
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.user_settings WHERE owner_sub = $1`, [sub(A)]))[0].n, 0, "nothing of A's stored");
  // B may name B's own team, which is then what the podcast reads for B
  assertEquals((await call("PUT", `${S}/podcast.team`, { value: team }, B)).status, 200);
  assertEquals(await readFn(sub(B), "podcast.team"), team);
  assertEquals((await call("PUT", `${S}/digest.send_time`, { value: "06:00" }, A)).status, 409, "the send time is read-only here");
  assertEquals((await call("PUT", `${S}/nope.nothing`, { value: 1 }, A)).status, 404);
});

t("I5: the database refuses what the routes refuse, whoever writes: an admin or read-only key in the user tier, a bad value, a secret key", async () => {
  const w = (k: string, v: unknown) => refusedAsApp(`INSERT INTO public.user_settings (owner_sub, key, value) VALUES ($1, $2, $3::jsonb)`, [sub(A), k, JSON.stringify(v)]);
  assertEquals(await w("research.max_fetch", 5), "42501", "an admin key is never a user row");
  assertEquals(await w("digest.send_time", "06:00"), "42501", "a read-only key");
  assertEquals(await w("refinery.dormancy_days", 0), "22023", "a value the registry refuses");
  assertEquals(await w("no.such_key", 1), "P0002", "an unregistered key");
  assertEquals(await refusedAsApp(`INSERT INTO public.settings_keys (key, tier, type, section, label, read_by) VALUES ('test.flag', 'user', 'boolean', 'refinery', 't', 't')`), "42501",
    "the app role cannot add keys (the registry is written by migrations)");
  // no secrets in the settings tables, even for the superuser: neither the type nor a credential-named key
  assertEquals(await refused(`INSERT INTO public.settings_keys (key, tier, type, section, label, read_by) VALUES ('cloud.provider', 'user', 'secret', 'refinery', 't', 't')`), "23514");
  assertEquals(await refused(`INSERT INTO public.settings_keys (key, tier, type, section, label, read_by) VALUES ('cloud.api_key', 'user', 'string', 'refinery', 't', 't')`), "23514");
  assertEquals(await refused(`INSERT INTO public.settings_keys (key, tier, type, section, label, read_by) VALUES ('google.oauth_token', 'user', 'string', 'refinery', 't', 't')`), "23514");
  // round 2 (review A2): any key / *_key segment, apikey, bearer, passphrase, access_key
  for (const k of ["cloud.ssh_key", "cloud.access_key", "cloud.key", "cloud.key.value", "cloud.apikey", "cloud.bearer", "cloud.passphrase", "aws.access_key_id"]) {
    assertEquals(await refused(`INSERT INTO public.settings_keys (key, tier, type, section, label, read_by) VALUES ($1, 'user', 'string', 'refinery', 't', 't')`, [k]), "23514", k);
  }
  // ... while ordinary names that merely contain the letters stay allowed
  assertEquals(await refused(`INSERT INTO public.settings_keys (key, tier, type, section, label, read_by) VALUES ('digest.keyword_limit', 'user', 'integer', 'digest', 't', 't')`), "");
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.settings_keys WHERE type = 'secret' OR key ~* '(secret|token|password|api_?key|credential)'`))[0].n, 0);
});

// as `role`, in a transaction rolled back: "" = accepted, else the refusal code
async function refusedAs(role: string, text: string, args: unknown[] = []): Promise<string> {
  const c = await pool!.connect();
  try {
    await c.queryObject("BEGIN");
    await c.queryObject(`SET LOCAL ROLE ${role}`);
    await c.queryObject(text, args);
    await c.queryObject("ROLLBACK");
    return "";
  } catch (e) {
    try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
    return String((e as { fields?: { code?: string } }).fields?.code ?? (e as Error).message);
  } finally {
    c.release();
  }
}

t("I7: no login outside the app role may run the settings functions (round 2, review G1): ob_pantry, anon and authenticated get 42501", async () => {
  const roles = (await sql<{ r: string }>(`SELECT rolname AS r FROM pg_roles WHERE rolname IN ('ob_pantry', 'anon', 'authenticated') ORDER BY 1`)).map((x) => x.r);
  assertEquals(roles, ["anon", "authenticated", "ob_pantry"], "the three roles exist in the chain");
  await sql(`INSERT INTO public.user_settings (owner_sub, key, value) VALUES ($1, 'refinery.dormancy_days', '11') ON CONFLICT (owner_sub, key) DO UPDATE SET value = '11'`, [sub(B)]);
  const calls: [string, unknown[]][] = [
    [`SELECT public.setting_get($1, 'refinery.dormancy_days')`, [sub(B)]],
    [`SELECT public.setting_problem($1, 'refinery.dormancy_days', '5'::jsonb)`, [sub(B)]],
    [`SELECT public.user_setting_set($1, 'refinery.dormancy_days', '1'::jsonb, 'intruder', NULL)`, [sub(B)]],
  ];
  for (const role of roles) {
    for (const [q, a] of calls) assertEquals(await refusedAs(role, q, a), "42501", `${role}: ${q}`);
  }
  assertEquals(await readFn(sub(B), "refinery.dormancy_days"), 11, "B's value was neither read nor changed by them");
  // the app role (what the workbench and the refinery run as) still reads and writes through them
  assertEquals(await refusedAs(APP_ROLE, calls[0][0], calls[0][1]), "");
  assertEquals(await refusedAs(APP_ROLE, calls[1][0], calls[1][1]), "");
  const member = (await sql<{ m: boolean }>(`SELECT pg_has_role($1, 'service_role', 'MEMBER') AS m`, [APP_ROLE]))[0].m;
  assertEquals(member, true, `${APP_ROLE} reaches the functions as a member of service_role`);
  await sql(`DELETE FROM public.user_settings WHERE owner_sub = $1 AND key = 'refinery.dormancy_days'`, [sub(B)]);
});

t("I6: the idea schedule answers exactly as before, and is not in the settings tables", async () => {
  const sched = await call("GET", "/workbench/idea-schedule", undefined, A);
  assertEquals(sched.status, 200, sched.text);
  assertEquals(sched.json.mode, "immediate");
  const put = await call("PUT", "/workbench/idea-schedule", { mode: "daily", at_time: "09:00", tz: "UTC" }, A);
  assertEquals([put.status, put.json.mode, put.json.at_time], [200, "daily", "09:00"]);
  assertEquals((await call("PUT", "/workbench/idea-schedule", { mode: "immediate" }, A)).json.mode, "immediate");
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.user_settings WHERE owner_sub = $1`, [sub(A)]))[0].n, 0, "the schedule is its own table");
});
