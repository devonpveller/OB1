// deno test src/settings/appearance_integration_test.ts - the Appearance keys (research-workbench-redesign rwr-appearance, slot 700)
// over a REAL workbench and database: the five keys and their tag, every offered choice stored and read back, the saved-themes cap
// of 10 (a 400, nothing stored), odd-typed values, versions that never go back, and two identities. SKIPPED unless DOCS_TEST_BASE is
// set; contract-test/run-workspace-tests.ps1 [5j4] runs it on a DISPOSABLE internal network (the real initdb chain incl. slots
// 400, 490, 550 and 700). Users act through the lab's identity header (X-Test-Sub).
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
const A = { "X-Test-Sub": `ap-a-${rnd()}` };
const B = { "X-Test-Sub": `ap-b-${rnd()}` };
const C = { "X-Test-Sub": `ap-c-${rnd()}` }; // never stores anything: the control for what B sees
const S = "/workbench/settings";
const KEYS = ["ui.theme", "ui.accent", "ui.density", "ui.text_size", "ui.saved_themes"];

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
const row = (list: { key: string }[], key: string) => list.find((s) => s.key === key) as any;
const theme = (name: string, o: Record<string, unknown> = {}) => ({ name, theme: "dark", accent: "indigo", density: "compact", text_size: "16", ...o });

t("A1: the catalog - five keys, user tier, section ui, tag only_you, the registry's own offered lists; the cap is 10", async () => {
  const rows = await sql<{ key: string; tier: string; type: string; section: string; tag: string; editable: boolean; validation: any; default_value: unknown }>(
    `SELECT key, tier, type, section, tag, editable, validation, default_value FROM public.settings_keys WHERE key = ANY($1) ORDER BY key`, [KEYS]);
  assertEquals(rows.map((r) => r.key), [...KEYS].sort());
  for (const r of rows) {
    assertEquals([r.tier, r.section, r.tag, r.editable], ["user", "ui", "only_you", true], r.key);
    assertEquals(r.type, r.key === "ui.saved_themes" ? "theme_list" : "enum", r.key);
  }
  const by = (k: string) => rows.find((r) => r.key === k)!;
  assertEquals(by("ui.theme").validation.enum, ["light", "dark", "system"]);
  assertEquals(by("ui.accent").validation.enum, ["teal", "indigo", "amber", "rose", "slate"]);
  assertEquals(by("ui.density").validation.enum, ["comfortable", "compact"]);
  assertEquals(by("ui.text_size").validation.enum, ["13", "14", "15", "16", "18"]);
  assertEquals(by("ui.saved_themes").validation.max_items, 10);
  assertEquals([by("ui.theme").default_value, by("ui.accent").default_value, by("ui.density").default_value, by("ui.text_size").default_value], ["system", "teal", "comfortable", "14"]);
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.settings_keys WHERE tag IS NULL`))[0].n, 0, "slot 550's rule: no key without a tag");
});

t("A2: every offered choice is stored and read back; every other value is refused (400) and nothing is stored", async () => {
  const offered: Record<string, unknown[]> = {
    "ui.theme": ["light", "dark", "system"], "ui.accent": ["teal", "indigo", "amber", "rose", "slate"],
    "ui.density": ["comfortable", "compact"], "ui.text_size": ["13", "14", "15", "16", "18"],
  };
  for (const [key, list] of Object.entries(offered)) {
    for (const v of list) {
      const w = await put(A, key, v);
      assertEquals(w.status, 200, `${key}=${v}: ${w.text}`);
      assertEquals(w.json.tag, "only_you");
      assertEquals(row((await call("GET", S, undefined, A)).json.settings, key).value, v);
    }
    const before = row((await call("GET", S, undefined, A)).json.settings, key);
    // odd-typed and unknown values: a number, a boolean, a list, an object, a mixed-case or padded spelling, an unknown choice
    for (const bad of [0, 14, true, ["dark"], {}, { theme: "dark" }, "", " dark", "DARK", "sepia", "magenta", "17", 16, "constructor"]) {
      const r = await put(A, key, bad);
      assertEquals(r.status, 400, `${key}=${JSON.stringify(bad)}: ${r.text}`);
      assert(r.json.error.startsWith(`${key}: must be one of`), r.text);
    }
    const nul = await call("PUT", `${S}/${key}`, { value: null }, A);
    assertEquals(nul.status, 400);
    assertEquals(row((await call("GET", S, undefined, A)).json.settings, key).version, before.version, "a refused write moves no version");
  }
});

t("A3: saved themes - ten are kept; an eleventh is a 400 and nothing changes; a delete makes room", async () => {
  const list = Array.from({ length: 10 }, (_, i) => theme("Theme " + (i + 1)));
  const ok10 = await put(A, "ui.saved_themes", list);
  assertEquals(ok10.status, 200, ok10.text);
  const v = ok10.json.version;
  const over = await put(A, "ui.saved_themes", [...list, theme("One too many")], v);
  assertEquals(over.status, 400, over.text);
  assertEquals(over.json.error, "ui.saved_themes: you can keep at most 10 saved themes");
  const got = row((await call("GET", S, undefined, A)).json.settings, "ui.saved_themes");
  assertEquals(got.value.length, 10);
  assertEquals(got.version, v, "the refusal stored nothing and moved no version");
  const fewer = await put(A, "ui.saved_themes", list.slice(1), v);
  assertEquals(fewer.status, 200);
  assertEquals((await put(A, "ui.saved_themes", [])).status, 200, "an empty list is allowed");
});

t("A4: saved themes - every malformed list or item is a 400: not a list, an item that is not an object, an unknown choice, a wrong type, an extra field, a missing field, a bad name, a repeated name", async () => {
  const good = theme("Good");
  const bad: [string, unknown][] = [
    ["a string", "dark"], ["an object", { name: "x" }], ["a number", 5], ["a list of strings", ["a"]], ["a list of lists", [[]]], ["a null item", [null]],
    ["unknown theme", [{ ...good, theme: "sepia" }]], ["unknown accent", [{ ...good, accent: "magenta" }]], ["unknown density", [{ ...good, density: "huge" }]],
    ["unknown text size", [{ ...good, text_size: "17" }]], ["text size as a number", [{ ...good, text_size: 16 }]], ["theme as a list", [{ ...good, theme: ["dark"] }]],
    ["an extra field", [{ ...good, note: "hello" }]], ["a nested extra field", [{ ...good, accent: { id: "teal" } }]],
    ["a missing field", [{ name: "x", theme: "dark", accent: "teal", density: "compact" }]], ["a missing name", [{ theme: "dark", accent: "teal", density: "compact", text_size: "14" }]],
    ["an empty name", [{ ...good, name: "" }]], ["a blank name", [{ ...good, name: "   " }]], ["a 41 character name", [{ ...good, name: "x".repeat(41) }]],
    ["a numeric name", [{ ...good, name: 7 }]], ["a control character", [{ ...good, name: "bell\u0007" }]], ["a zero-width space", [{ ...good, name: "zero​width" }]],
    ["a bidi override", [{ ...good, name: "‮evil" }]], ["a credential shape", [{ ...good, name: "sk-live-abc123" }]], ["a bearer token", [{ ...good, name: "Bearer abc" }]],
    ["a repeated name", [good, { ...good, name: "good" }]],
  ];
  const before = row((await call("GET", S, undefined, A)).json.settings, "ui.saved_themes");
  for (const [what, v] of bad) {
    const r = await put(A, "ui.saved_themes", v);
    assertEquals(r.status, 400, `${what}: ${r.text}`);
    assert(r.json.error.startsWith("ui.saved_themes: "), `${what}: ${r.text}`);
  }
  assertEquals(row((await call("GET", S, undefined, A)).json.settings, "ui.saved_themes").version, before.version, "nothing was stored by any refusal");
  // a 40 character name is fine, and a name with a normal space and punctuation
  assertEquals((await put(A, "ui.saved_themes", [theme("x".repeat(40)), theme("Night reading, v2")])).status, 200);
});

t("A5: the database refuses the same whoever writes: a bad value inserted directly (the guard trigger), and a stored value that falls outside a later list is still read back (never a 500)", async () => {
  const owner = `ap-db-${rnd()}`;
  const direct = async (key: string, value: unknown) => {
    const c = await pool!.connect();
    try {
      await c.queryObject("BEGIN");
      await c.queryObject(`INSERT INTO public.user_settings (owner_sub, key, value, version, updated_by) VALUES ($1, $2, $3::jsonb, 1, 'test')`, [owner, key, JSON.stringify(value)]);
      return "";
    } catch (e) {
      return String((e as { fields?: { code?: string } }).fields?.code ?? (e as Error).message);
    } finally {
      try { await c.queryObject("ROLLBACK"); } catch { /* broken */ }
      c.release();
    }
  };
  assert((await direct("ui.theme", "sepia")) !== "", "a direct insert of an unknown theme is refused by the database");
  assert((await direct("ui.saved_themes", Array.from({ length: 11 }, (_, i) => theme("n" + i)))) !== "", "a direct insert of eleven themes is refused");
  // plant (as the superuser, outside the guard) a value no list offers any more: the routes still answer 200 with it
  const planted = `ap-old-${rnd()}`;
  await sql(`ALTER TABLE public.user_settings DISABLE TRIGGER trg_user_settings_guard`);
  try {
    await sql(`INSERT INTO public.user_settings (owner_sub, key, value, version, updated_by) VALUES ($1, 'ui.theme', '"sepia"'::jsonb, 1, 'test'), ($1, 'ui.accent', '12'::jsonb, 1, 'test'), ($1, 'ui.saved_themes', '[{"name":"Old","theme":"dark","accent":"magenta","density":"compact","text_size":"18"}, "junk"]'::jsonb, 1, 'test')`, [planted]);
    const r = await call("GET", S, undefined, { "X-Test-Sub": planted });
    assertEquals(r.status, 200, r.text);
    assertEquals(row(r.json.settings, "ui.theme").value, "sepia");
  } finally {
    await sql(`DELETE FROM public.user_settings WHERE owner_sub = $1`, [planted]);
    await sql(`ALTER TABLE public.user_settings ENABLE TRIGGER trg_user_settings_guard`);
  }
});

t("A6: versions never go back and a stale write is a 409: back to default is a versioned delete", async () => {
  const w1 = await put(A, "ui.density", "compact");
  const v1 = w1.json.version;
  assertEquals((await put(A, "ui.density", "comfortable", v1 + 5)).status, 409);
  const del = await call("DELETE", `${S}/ui.density?version=${v1}`, undefined, A);
  assertEquals(del.status, 200, del.text);
  assertEquals(del.json.is_default, true);
  assertEquals(del.json.version, v1 + 1, "a delete is itself a version");
  assertEquals((await put(A, "ui.density", "compact", v1)).status, 409, "the old version can never match again");
  assertEquals((await put(A, "ui.density", "compact", v1 + 1)).status, 200);
});

t("A7: two identities - B never sees A's appearance: values, versions, counts, totals, error messages", async () => {
  assertEquals((await put(A, "ui.theme", "dark")).status, 200);
  assertEquals((await put(A, "ui.accent", "rose")).status, 200);
  assertEquals((await put(A, "ui.saved_themes", [theme("ALPHA-PRIVATE-NAME", { accent: "rose" })])).status, 200);
  const a = await call("GET", S, undefined, A);
  const b = await call("GET", S, undefined, B);
  const c = await call("GET", S, undefined, C);
  assertEquals(b.json.settings, c.json.settings, "B's list equals the never-stored user's list");
  assertEquals(b.json.settings.length, a.json.settings.length, "the same total");
  for (const k of KEYS) {
    const s = row(b.json.settings, k);
    assert(s.is_default && s.value === null && s.updated_at === null && s.version === 0, `${k} shows A's data to B`);
  }
  assert(!b.text.includes("ALPHA-PRIVATE") && !b.text.includes("ap-a-"), "nothing of A is in B's read");
  // B's refusals do not name A's version or value, and read the same as C's
  const stale = await put(B, "ui.theme", "light", row(a.json.settings, "ui.theme").version);
  assertEquals(stale.status, 409);
  assert(/version 0, not /.test(stale.json.error) && !/dark/.test(stale.text), stale.text);
  const badB = await put(B, "ui.accent", "magenta");
  const badC = await put(C, "ui.accent", "magenta");
  assertEquals(badB.text, badC.text);
  const overB = await put(B, "ui.saved_themes", Array.from({ length: 11 }, (_, i) => theme("n" + i)));
  const overC = await put(C, "ui.saved_themes", Array.from({ length: 11 }, (_, i) => theme("n" + i)));
  assertEquals(overB.text, overC.text);
  // B's write and delete leave A's rows alone
  assertEquals((await put(B, "ui.theme", "light")).status, 200);
  await call("DELETE", `${S}/ui.accent`, undefined, B);
  const a2 = await call("GET", S, undefined, A);
  assertEquals(row(a2.json.settings, "ui.theme").value, "dark");
  assertEquals(row(a2.json.settings, "ui.accent").value, "rose");
  assertEquals(row(a2.json.settings, "ui.saved_themes").value[0].name, "ALPHA-PRIVATE-NAME");
});
