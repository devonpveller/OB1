// deno test src/settings/notify_prefs_integration_test.ts - the notification preferences (research-workbench-redesign
// rwr-notify-prefs, slot 720) over a REAL workbench and database: the four keys, a class switched off leaves THAT person's bell
// only, the sign-in key cannot be switched off (the server refuses, and a stored value can never hide it), no email key, two
// identities. SKIPPED unless DOCS_TEST_BASE is set; contract-test/run-notify-prefs-tests.ps1 [5a] runs it on a DISPOSABLE
// internal network (the real initdb chain incl. slots 400, 550 and 720). Users act through the lab's identity header (X-Test-Sub).
// Environment: DOCS_TEST_BASE, DOCS_TEST_KEY, CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser).
import { assert, assertEquals } from "jsr:@std/assert@1";
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
const RUN = rnd();
const A = { "X-Test-Sub": `np-a-${RUN}` };
const B = { "X-Test-Sub": `np-b-${RUN}` };
const C = { "X-Test-Sub": `np-c-${RUN}` }; // never stores anything: the control for what B sees
const S = "/workbench/settings";
const N = "/workbench/contract/notifications";
const KEYS = ["notify.informational", "notify.structural", "notify.transient", "notify.sign_in_new_device"];

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
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
const put = (who: Record<string, string>, key: string, value: unknown, version?: number) =>
  call("PUT", `${S}/${key}`, version === undefined ? { value } : { value, version }, who);
const stored = async (sub: string, key: string) =>
  await sql<{ value: unknown; version: number }>(`SELECT value, version FROM public.user_settings WHERE owner_sub = $1 AND key = $2`, [sub, key]);
const row = (list: { key: string }[], key: string) => list.find((s) => s.key === key) as any;

// events of this run, by class: one subject each, so a bell read can be filtered to them
const SUBJ = (cls: string) => `np-${RUN}-${cls}`;
async function seed(cls: string, ageSeconds = 0) {
  await sql(
    `INSERT INTO public.research_notifications (class, subject, dedup_key, first_seen, last_seen)
     VALUES ($1, $2, md5($2), now() - make_interval(secs => $3), now() - make_interval(secs => $3))`,
    [cls, SUBJ(cls), ageSeconds],
  );
}
async function bell(who: Record<string, string>, query = "") {
  const r = await call("GET", `${N}?limit=500${query}`, undefined, who);
  assertEquals(r.status, 200, r.text);
  return { ...r, mine: (r.json.notifications as any[]).filter((n) => String(n.subject).startsWith(`np-${RUN}-`)) };
}
const classes = (l: any[]) => l.map((n) => n.class).sort();
async function cleanup() {
  await sql(`DELETE FROM public.research_notifications WHERE subject LIKE $1`, [`np-${RUN}-%`]);
  await sql(`DELETE FROM public.user_settings WHERE owner_sub LIKE $1`, [`np-%-${RUN}`]);
  await sql(`DELETE FROM public.user_setting_tombstones WHERE owner_sub LIKE $1`, [`np-%-${RUN}`]);
}

t("N1: the catalog - four keys, user tier, section ui, tag only_you; three boolean defaults true, the sign-in key an enum of on only; no email key", async () => {
  const rows = await sql<{ key: string; tier: string; type: string; section: string; tag: string; editable: boolean; validation: any; default_value: unknown }>(
    `SELECT key, tier, type, section, tag, editable, validation, default_value FROM public.settings_keys WHERE key LIKE 'notify.%' ORDER BY key`);
  assertEquals(rows.map((r) => r.key), [...KEYS].sort(), "exactly these keys, and no email key");
  for (const r of rows) assertEquals([r.tier, r.section, r.tag, r.editable], ["user", "ui", "only_you", true], r.key);
  for (const k of KEYS.slice(0, 3)) {
    const r = rows.find((x) => x.key === k)!;
    assertEquals([r.type, r.default_value], ["boolean", true], k);
  }
  const s = rows.find((x) => x.key === "notify.sign_in_new_device")!;
  assertEquals([s.type, s.default_value, s.validation], ["enum", "on", { enum: ["on"] }]);
  const cls = await sql<{ key: string }>(`SELECT key FROM public.contract_registry_entries WHERE registry = 'notification_classes' ORDER BY key`);
  assertEquals(cls.map((c) => c.key), ["informational", "structural", "transient"], "no new notification class was created");
});

t("N2: a class switched off no longer shows in that person's bell, and still shows for others who left it on", async () => {
  try {
    for (const c of ["informational", "structural", "transient"]) await seed(c);
    assertEquals(classes((await bell(A)).mine), ["informational", "structural", "transient"], "all three before any preference");
    const w = await put(A, "notify.informational", false);
    assertEquals(w.status, 200, w.text);
    assertEquals([w.json.value, w.json.is_default, w.json.tag], [false, false, "only_you"]);
    assertEquals(classes((await bell(A)).mine), ["structural", "transient"], "A no longer sees informational");
    assertEquals(classes((await bell(B)).mine), ["informational", "structural", "transient"], "B (never stored anything) still sees all");
    assertEquals(classes((await bell(C)).mine), ["informational", "structural", "transient"], "C too");
    // the class filter of the read follows the same rule
    assertEquals((await bell(A, "&class=informational")).mine, [], "?class=informational is empty for A");
    assertEquals(classes((await bell(B, "&class=informational")).mine), ["informational"]);
    // two classes off, then one back on
    assertEquals((await put(A, "notify.transient", false)).status, 200);
    assertEquals(classes((await bell(A)).mine), ["structural"]);
    const on = await put(A, "notify.informational", true, w.json.version);
    assertEquals(on.status, 200, on.text);
    assertEquals(classes((await bell(A)).mine), ["informational", "structural"]);
    // back to the default (a DELETE): the class shows again
    const del = await call("DELETE", `${S}/notify.transient?version=${(await call("GET", `${S}/notify.transient`, undefined, A)).json.version}`, undefined, A);
    assertEquals(del.status, 200, del.text);
    assertEquals(classes((await bell(A)).mine), ["informational", "structural", "transient"]);
  } finally {
    await cleanup();
  }
});

t("N3: the limit counts what the person can see - a hidden newest event does not use up the page", async () => {
  try {
    await seed("informational", 0); // newest
    await seed("transient", 30); // older
    assertEquals((await put(A, "notify.informational", false)).status, 200);
    const since = new Date(Date.now() - 120_000).toISOString();
    const r = await call("GET", `${N}?limit=1&since=${encodeURIComponent(since)}`, undefined, A);
    assertEquals(r.status, 200, r.text);
    const mine = (r.json.notifications as any[]).filter((n) => String(n.subject).startsWith(`np-${RUN}-`));
    assertEquals(classes(mine), ["transient"], "limit 1 gives A the newest event A can see, not an empty page");
    const rb = await call("GET", `${N}?limit=1&since=${encodeURIComponent(since)}`, undefined, B);
    assertEquals(rb.json.notifications.length, 1);
    assertEquals(rb.json.notifications[0].class, "informational", "B's newest is the informational one");
  } finally {
    await cleanup();
  }
});

t("N4: 'Sign-in from a new device' cannot be switched off - the server refuses every way of saying off, and nothing is stored", async () => {
  try {
    const k = "notify.sign_in_new_device";
    for (const bad of ["off", "OFF", "On", false, true, 0, 1, null, "", "false", ["on"], { enum: "on" }, "on "]) {
      const w = await put(A, k, bad);
      assertEquals(w.status, 400, `${JSON.stringify(bad)}: ${w.text}`);
    }
    assertEquals((await stored(`np-a-${RUN}`, k)).length, 0, "nothing was stored by a refused write");
    const ok = await put(A, k, "on");
    assertEquals(ok.status, 200, ok.text);
    assertEquals(ok.json.value, "on");
    // still refused after a stored "on", with a version
    assertEquals((await put(A, k, "off", ok.json.version)).status, 400);
    assertEquals((await stored(`np-a-${RUN}`, k))[0].value, "on");
    // the database refuses it too, whoever writes (the trigger on user_settings)
    for (const v of ['"off"', "false", "null"]) {
      let code = "";
      try {
        await sql(`INSERT INTO public.user_settings (owner_sub, key, value) VALUES ($1, $2, $3::jsonb)`, [`np-z-${RUN}`, k, v]);
      } catch (e) {
        code = String((e as { fields?: { code?: string } }).fields?.code ?? e);
      }
      assert(code === "22023", `a direct write of ${v} is refused by the database (${code})`);
    }
    assertEquals((await stored(`np-z-${RUN}`, k)).length, 0);
  } finally {
    await cleanup();
  }
});

t("N5: a sign-in notification always shows, even if a forged stored value says off (the read hides boolean keys only)", async () => {
  const k = "notify.sign_in_new_device";
  try {
    await seed("sign_in_new_device");
    await seed("informational");
    assertEquals(classes((await bell(A)).mine), ["informational", "sign_in_new_device"]);
    // forge what the trigger forbids (a superuser with the trigger off), then read
    await sql(`ALTER TABLE public.user_settings DISABLE TRIGGER trg_user_settings_guard`);
    try {
      await sql(`INSERT INTO public.user_settings (owner_sub, key, value) VALUES ($1, $2, 'false'::jsonb)`, [`np-a-${RUN}`, k]);
      await sql(`INSERT INTO public.user_settings (owner_sub, key, value) VALUES ($1, 'notify.informational', 'false'::jsonb)`, [`np-a-${RUN}`]);
    } finally {
      await sql(`ALTER TABLE public.user_settings ENABLE TRIGGER trg_user_settings_guard`);
    }
    assertEquals(classes((await bell(A)).mine), ["sign_in_new_device"], "the forged off hides nothing of the sign-in key; the real class key still hides");
  } finally {
    await sql(`ALTER TABLE public.user_settings ENABLE TRIGGER trg_user_settings_guard`);
    await cleanup();
  }
});

t("N6: odd values for a class key are refused (400) and nothing is stored; the stored value is read back exactly", async () => {
  try {
    const k = "notify.structural";
    for (const bad of ["false", "true", "off", 0, 1, null, [], {}, "", { value: false }]) {
      const w = await put(A, k, bad);
      assertEquals(w.status, 400, `${JSON.stringify(bad)}: ${w.text}`);
    }
    assertEquals((await stored(`np-a-${RUN}`, k)).length, 0);
    const w = await put(A, k, false);
    assertEquals(w.status, 200, w.text);
    const list = await call("GET", S, undefined, A);
    const r = row(list.json.settings, k);
    assertEquals([r.value, r.is_default, r.version, r.default], [false, false, w.json.version, true], "the list says exactly what is stored");
    assertEquals((await stored(`np-a-${RUN}`, k))[0].value, false);
  } finally {
    await cleanup();
  }
});

t("N7: there is no email key and no way to make one - 404, nothing stored; no route sends mail", async () => {
  for (const k of ["notify.email", "notify.informational.email", "notify.email_informational", "email.informational", "notify.mail"]) {
    const w = await put(A, k, true);
    assertEquals(w.status, 404, `${k}: ${w.text}`);
    assert(w.text.includes("is not a setting"), w.text);
  }
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.settings_keys WHERE key ~* '(mail|smtp)'`))[0].n, 0);
  const list = await call("GET", S, undefined, A);
  assert(!/mail/i.test(JSON.stringify(list.json.settings.filter((s: any) => s.key.startsWith("notify.")).map((s: any) => [s.key, s.type, s.validation]))), "no key of this item mentions mail");
});

t("N8: preferences are per person and unreadable by others - B never sees A's value, version or error, in the list, by key, in the bell or in a refusal", async () => {
  try {
    const wa = await put(A, "notify.transient", false);
    assertEquals(wa.status, 200, wa.text);
    const ver = wa.json.version;
    // B's views
    const list = await call("GET", S, undefined, B);
    const rb = row(list.json.settings, "notify.transient");
    assertEquals([rb.value, rb.is_default, rb.version], [null, true, 0], "B's list shows B's own (nothing stored)");
    const one = await call("GET", `${S}/notify.transient`, undefined, B);
    assertEquals([one.json.value, one.json.is_default, one.json.version], [null, true, 0]);
    // B writes his own: A's version is not B's, A's value is not touched
    const wb = await put(B, "notify.transient", true, 0);
    assertEquals(wb.status, 200, wb.text);
    assertEquals((await stored(`np-a-${RUN}`, "notify.transient"))[0].value, false, "B's write left A's value alone");
    // a stale version from A's world is just stale for B: the refusal names B's own version, not A's
    const stale = await put(B, "notify.transient", false, ver + 5);
    assertEquals(stale.status, 409, stale.text);
    assert(!stale.text.includes(`np-a-${RUN}`), "the refusal does not name A");
    // the bell carries no preference data at all
    await seed("transient");
    const bb = await bell(B);
    assert(!bb.text.includes(`np-a-${RUN}`) && !/owner_sub|notify\./.test(bb.text), "B's bell has no per-user field of A's");
    // the same answer for a key nobody stored and a key somebody else stored: a refusal for another's row looks the same as a missing row
    const missing = await call("PUT", `${S}/notify.nope`, { value: true }, B);
    const alien = await call("PUT", `${S}/notify.sign_in_new_device`, { value: "off" }, B);
    assertEquals([missing.status], [404]);
    assertEquals(alien.status, 400);
    // C (nothing stored) sees all defaults
    const lc = row((await call("GET", S, undefined, C)).json.settings, "notify.transient");
    assertEquals([lc.value, lc.is_default], [null, true]);
    // another person's DELETE by version cannot clear A's row
    const delB = await call("DELETE", `${S}/notify.transient?version=${ver}`, undefined, C);
    assert(delB.status === 409 || delB.status === 200, `C's delete: ${delB.status}`);
    assertEquals((await stored(`np-a-${RUN}`, "notify.transient"))[0].value, false, "C's delete did not touch A's row");
  } finally {
    await cleanup();
  }
});
