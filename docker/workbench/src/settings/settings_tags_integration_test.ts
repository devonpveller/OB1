// deno test src/settings/settings_tags_integration_test.ts - the Settings frame's server side (research-workbench-redesign
// rwr-settings-shell, slot 550) over a REAL workbench and database: the tag on every registry row, what a non-admin is
// ever sent, and two identities. SKIPPED unless DOCS_TEST_BASE is set; contract-test/run-workspace-tests.ps1 [5j3] runs it
// on a DISPOSABLE internal network (the real initdb chain incl. slots 400, 490 and 550). Two users act through the lab's
// identity header (X-Test-Sub); a request with no header is the default subject, the admin with sign-in off.
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
  }, 3, true)
  : null;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });

const rnd = () => crypto.randomUUID().slice(0, 8);
const A = { "X-Test-Sub": `tags-a-${rnd()}` };
const B = { "X-Test-Sub": `tags-b-${rnd()}` };
const C = { "X-Test-Sub": `tags-c-${rnd()}` }; // never stores anything: the control for what B sees
const ADMIN = {};
const S = "/workbench/settings";
const TAGS = ["only_you", "on_server", "admin_all"];

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}
// run statements in one transaction that is always rolled back; returns "" or the first refusal's code
async function inRolledBack(stmts: [string, unknown[]?][]): Promise<{ code: string; counts: unknown[] }> {
  const c = await pool!.connect();
  const counts: unknown[] = [];
  try {
    await c.queryObject("BEGIN");
    for (const [q, a] of stmts) counts.push((await c.queryObject(q, a ?? [])).rows);
    return { code: "", counts };
  } catch (e) {
    return { code: String((e as { fields?: { code?: string } }).fields?.code ?? (e as Error).message), counts };
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
const put = (who: Record<string, string>, key: string, value: unknown, version?: number) =>
  call("PUT", `${S}/${key}`, version === undefined ? { value } : { value, version }, who);
const untagged = async () => (await sql<{ key: string }>(`SELECT key FROM public.settings_keys WHERE tag IS NULL ORDER BY key`)).map((r) => r.key);
const find = (list: { key: string }[], key: string) => list.find((s) => s.key === key) as any;

t("T1: the catalog - every key has a tag from its registry row, from the allowed set, and none is a cloud tag", async () => {
  const rows = await sql<{ key: string; tier: string; tag: string | null }>(`SELECT key, tier, tag FROM public.settings_keys ORDER BY key`);
  assert(rows.length >= 22, `the registry holds ${rows.length} keys`);
  assertEquals(await untagged(), [], "a key without a tag fails this test");
  for (const r of rows) {
    assert(TAGS.includes(r.tag!), `${r.key}: tag ${r.tag}`);
    assertNotEquals(r.tag, "cloud", `${r.key}: no key may carry the cloud tag before phase 9`);
    // an admin key says an admin changes it; a user key never does
    assertEquals(r.tag === "admin_all", r.tier === "admin", `${r.key}: tier ${r.tier} / tag ${r.tag}`);
  }
});

t("T2: the table refuses the cloud tag (and any tag outside the set) on every key; a key inserted without a tag is what the catalog query finds", async () => {
  for (const bad of ["cloud", "everyone", ""]) {
    const r = await inRolledBack([[`UPDATE public.settings_keys SET tag = $1 WHERE key = 'ui.start_screen'`, [bad]]]);
    assertEquals(r.code, "23514", `tag '${bad}' is refused by the CHECK`);
  }
  const mutant = await inRolledBack([
    [`INSERT INTO public.settings_keys (key, tier, type, section, label, read_by) VALUES ('test.no_tag', 'user', 'boolean', 'ui', 'x', 'test')`],
    [`SELECT key FROM public.settings_keys WHERE tag IS NULL`],
  ]);
  assertEquals(mutant.code, "");
  assertEquals((mutant.counts[1] as { key: string }[]).map((r) => r.key), ["test.no_tag"], "the catalog query names the untagged key");
  assertEquals(await untagged(), [], "and the rollback left nothing behind");
});

t("T3: every setting the routes send carries its registry row's tag; the user door sends user keys only, the admin door admin_all only", async () => {
  const reg = new Map((await sql<{ key: string; tag: string }>(`SELECT key, tag FROM public.settings_keys`)).map((r) => [r.key, r.tag]));
  const mine = await call("GET", S, undefined, A);
  assertEquals(mine.status, 200, mine.text);
  assert(mine.json.settings.length >= 10, "the user tier is listed (10 keys today)");
  for (const s of mine.json.settings) {
    assertEquals(s.tier, "user", `${s.key} is not a user key`);
    assertEquals(s.tag, reg.get(s.key), s.key);
    assert(["only_you", "on_server"].includes(s.tag), `${s.key}: ${s.tag}`);
  }
  const adm = await call("GET", `${S}/admin`, undefined, ADMIN);
  assertEquals(adm.status, 200, adm.text);
  assert(adm.json.settings.length >= 8);
  for (const s of adm.json.settings) assertEquals(s.tag, "admin_all", s.key);
});

t("T4: a non-admin is never sent an admin key - checked on the wire, on every route a screen could call", async () => {
  const adminKeys = await sql<{ key: string; label: string }>(`SELECT key, label FROM public.settings_keys WHERE tier = 'admin'`);
  assert(adminKeys.length >= 8);
  const bodies: string[] = [];
  const seen = (r: { status: number; text: string }, expect: number, what: string) => {
    assertEquals(r.status, expect, `${what}: ${r.text}`);
    bodies.push(r.text);
  };
  seen(await call("GET", S, undefined, A), 200, "GET /");
  seen(await call("GET", `${S}/admin`, undefined, A), 403, "GET /admin");
  for (const k of adminKeys) {
    seen(await call("PUT", `${S}/admin/${k.key}`, { value: 1 }, A), 403, `PUT admin ${k.key}`);
    seen(await call("DELETE", `${S}/admin/${k.key}`, undefined, A), 403, `DELETE admin ${k.key}`);
    seen(await call("PUT", `${S}/${k.key}`, { value: 1 }, A), 404, `PUT ${k.key}`);
    seen(await call("DELETE", `${S}/${k.key}`, undefined, A), 404, `DELETE ${k.key}`);
  }
  const all = bodies.join("\n");
  // the only place a key's name may appear is the caller's own request echoed back ("<key> is not a setting")
  const echoless = all.replace(/[a-z][a-z0-9_.]* is not a setting/g, "");
  const list = (await call("GET", S, undefined, A)).json;
  assertEquals(list.admin, false);
  assert(list.settings.every((s: { tier: string }) => s.tier === "user"));
  for (const k of adminKeys) {
    // the only place a key's name may appear is the caller's own request echoed back ("<key> is not a setting")
    assert(!echoless.includes(k.key), `${k.key} appears in a response to a non-admin`);
    assert(!all.includes(k.label), `the label of ${k.key} appears in a response to a non-admin`);
  }
  // the admin does get them
  assertEquals((await call("GET", S, undefined, ADMIN)).json.admin, true);
});

t("T5: a value saved on one browser shows on another (the account holds it), and 'Back to default' clears it everywhere", async () => {
  const w = await put(A, "ui.start_screen", "library");
  assertEquals(w.status, 200, w.text);
  assertEquals(w.json.tag, "only_you");
  const other = await call("GET", S, undefined, A); // a second client: nothing but the same account
  const row = find(other.json.settings, "ui.start_screen");
  assertEquals(row.value, "library");
  const back = await call("DELETE", `${S}/ui.start_screen?version=${row.version}`, undefined, A);
  assertEquals(back.json.is_default, true, back.text);
  assertEquals(find((await call("GET", S, undefined, A)).json.settings, "ui.start_screen").value, null);
});

t("T6: two identities - B never sees A's per-user data from this item: values, versions, counts, totals, error messages", async () => {
  // A writes three versions of two keys
  for (const v of [3, 4, 5]) assertEquals((await put(A, "refinery.dormancy_days", 100 + v)).status, 200);
  for (const s of ["library", "chat", "ideas"]) assertEquals((await put(A, "ui.start_screen", s)).status, 200);
  const a = await call("GET", S, undefined, A);
  assertEquals(find(a.json.settings, "refinery.dormancy_days").version, 3);

  const b = await call("GET", S, undefined, B);
  const c = await call("GET", S, undefined, C);
  // B sees exactly what a user who never stored anything sees: same keys, same totals, defaults, versions that start over
  assertEquals(b.json.settings, c.json.settings, "B's list equals the never-stored user's list");
  assertEquals(b.json.settings.length, a.json.settings.length, "the same total");
  for (const s of b.json.settings) assert(s.is_default && s.value === null && s.updated_at === null, `${s.key} shows A's data to B`);
  assert(!/10[345]|"chat"|"ideas"|"library"/.test(JSON.stringify(b.json.settings.map((s: { value: unknown }) => s.value))), "A's values are not in B's reads");
  assert(!b.text.includes("tags-a-"), "A's subject is not in B's read");

  // B's refusals do not name A's version or value: a stale write reports B's OWN version
  const stale = await put(B, "refinery.dormancy_days", 9, 3); // A's version is 3, B's is 0
  assertEquals(stale.status, 409, stale.text);
  assert(/version 0, not 3/.test(stale.json.error), stale.text);
  assert(!/10[345]/.test(stale.text), stale.text);
  const stale2 = await call("DELETE", `${S}/ui.start_screen?version=3`, undefined, B);
  assertEquals(stale2.status, 409, stale2.text);
  assert(!/ideas|chat/.test(stale2.text), stale2.text);
  // a refusal for a value B may not set looks the same whatever A holds
  const badB = await put(B, "refinery.dormancy_days", 9999);
  const badC = await put(C, "refinery.dormancy_days", 9999);
  assertEquals(badB.text, badC.text);

  // B's write does not move A's, and B's delete changes nothing of A's
  assertEquals((await put(B, "refinery.dormancy_days", 20)).status, 200);
  await call("DELETE", `${S}/ui.start_screen`, undefined, B);
  const a2 = await call("GET", S, undefined, A);
  assertEquals(find(a2.json.settings, "refinery.dormancy_days").value, 105);
  assertEquals(find(a2.json.settings, "ui.start_screen").value, "ideas");
});

// rw-settings-registry-tier (settings-shell review N1): the settings registry route, and so the contract_registry MCP tool that
// calls it, is filtered by tier for a person who is not an admin. A marker is PLANTED in every field of an admin-tier registry
// entry (key, label, nested definition fields) and a user-tier entry is planted beside it; every string and every object key in
// what a person receives is walked for the marker. The admin and a service (the workbench key with no identity header, the
// podcast writer's kind of caller) still see both. The registry reader caches 30 s, so the admin view is polled until it shows
// the plant.
const walk = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => walk(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); walk(x, out); }
  return out;
};
t("T7: two identities - the settings registry a person reads holds no admin-tier key, label, default mount or nested field; an admin and a service see all", async () => {
  const mark = `plantedadmin${rnd()}`;
  const akey = `zz.${mark}`;
  const ukey = `zz.planteduser${rnd()}`;
  const def = (m: string) => JSON.stringify({ type: "string", default: { mount: m }, nested: { a: [{ b: `${m}-deep` }] }, read_by: `${m} reader` });
  try {
    await sql(`INSERT INTO public.settings_keys (key, tier, type, section, label, read_by, store) VALUES ($1,'admin','string','research',$2,'x','contract'), ($3,'user','string','refinery','a user label','x','settings')`, [akey, `${mark} label`, ukey]);
    await sql(`INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES ('settings',$1,$2,$3::jsonb), ('settings',$4,'a user label',$5::jsonb)`, [akey, `${mark} label`, def(mark), ukey, def("usermount")]);
    let admin = await call("GET", "/workbench/contract/registries/settings", undefined, ADMIN);
    for (let i = 0; i < 45 && !admin.text.includes(mark); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      admin = await call("GET", "/workbench/contract/registries/settings", undefined, ADMIN);
    }
    assertEquals(admin.status, 200, admin.text);
    assert(admin.text.includes(mark) && admin.text.includes(ukey), "the admin sees both planted entries (the plant is live)");
    assert(admin.json.entries.some((e: { key: string }) => e.key === "podcast.archive_destination"), "and the real admin key");
    // a service: the workbench key with no identity header and ... the lab's default-subject is the admin; a service is the same key
    // through a header-less door, so what the lab can show for a service is the admin's view (the unit door test covers the service keys)
    for (const who of [A, B]) {
      const r = await call("GET", "/workbench/contract/registries/settings", undefined, who);
      assertEquals(r.status, 200, r.text);
      const strings = walk(r.json);
      assert(!r.text.includes(mark), `the marker reaches a person: ${r.text}`);
      assert(strings.every((s) => !s.includes(mark) && !s.includes("podcast.archive_destination") && !s.includes("podcast-archive")), "no admin string in any field");
      assertEquals(r.json.entries.map((e: { key: string }) => e.key), [ukey], "exactly the user-tier entry");
      assert(r.text.includes("usermount-deep"), "the user-tier entry arrives whole, nested fields included");
      const sum = (await call("GET", "/workbench/contract/registries", undefined, who)).json.registries.find((x: { name: string }) => x.name === "settings");
      assertEquals(sum.entries, 1, "the registry summary counts only what this person may see");
    }
    const sumAdmin = (await call("GET", "/workbench/contract/registries", undefined, ADMIN)).json.registries.find((x: { name: string }) => x.name === "settings");
    assertEquals(sumAdmin.entries, admin.json.entries.length);
  } finally {
    await sql(`DELETE FROM public.contract_registry_entries WHERE registry = 'settings' AND key IN ($1,$2)`, [akey, ukey]);
    await sql(`DELETE FROM public.settings_keys WHERE key IN ($1,$2)`, [akey, ukey]);
  }
});
