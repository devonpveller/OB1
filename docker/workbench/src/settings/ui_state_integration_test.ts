// deno test src/settings/ui_state_integration_test.ts - the per-user front-end state keys (research-workbench-redesign
// rwr-ui-state-keys, slot 490) over a REAL workbench and database: ui.locked_document, ui.last_document,
// ui.start_screen and library.recent in the settings store, through /workbench/settings/:key, for two identities.
//
// SKIPPED unless DOCS_TEST_BASE is set. contract-test/run-workspace-tests.ps1 [5j2] runs it on a DISPOSABLE internal
// network (the real initdb chain incl. slots 400 and 490). Two users act through the lab's identity header
// (WORKSPACE_IDENTITY_HEADER=X-Test-Sub). Never point it at a live stack.
// Environment: DOCS_TEST_BASE, DOCS_TEST_KEY, CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser).
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
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
const A = { "X-Test-Sub": `ui-a-${rnd()}` };
const B = { "X-Test-Sub": `ui-b-${rnd()}` };
const C = { "X-Test-Sub": `ui-c-${rnd()}` }; // a user who never stores anything: the control for "what B sees"
const sub = (u: Record<string, string>) => u["X-Test-Sub"];
const S = "/workbench/settings";
const K = { lock: "ui.locked_document", last: "ui.last_document", start: "ui.start_screen", recent: "library.recent" };
const ALL = Object.values(K);

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}
async function codeAsApp(text: string, args: unknown[] = []): Promise<string> {
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
const mine = async (who: Record<string, string>) => {
  const r = await call("GET", S, undefined, who);
  assertEquals(r.status, 200, r.text);
  return Object.fromEntries(r.json.settings.filter((s: { key: string }) => ALL.includes(s.key)).map((s: { key: string }) => [s.key, s]));
};
const put = (who: Record<string, string>, key: string, value: unknown, version?: number) =>
  call("PUT", `${S}/${key}`, version === undefined ? { value } : { value, version }, who);

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "source", id: `item-${i}` }));

t("U0: the four keys are registered: user tier, editable, in the ui section, and a fresh user reads them all at the default", async () => {
  const keys = await sql<{ key: string; tier: string; editable: boolean; section: string; type: string }>(
    `SELECT key, tier, editable, section, type FROM public.settings_keys WHERE key = ANY($1) ORDER BY key`, [ALL]);
  assertEquals(keys.map((k) => [k.key, k.tier, k.editable, k.section]).sort(), ALL.map((k) => [k, "user", true, "ui"]).sort());
  const m = await mine(C);
  for (const k of ALL) assertEquals([m[k].value, m[k].version, m[k].is_default], [null, 0, true], k);
  assert((await mine(C))[K.recent].validation.max_items === 24, "the cap is in the registry");
});

t("U1: lock a document, then read it from another browser (no cookie, same subject): still locked, version 1", async () => {
  const doc = `documents/${sub(A)}/plan.md`;
  assertEquals((await put(A, K.lock, doc)).json.version, 1);
  // "another browser profile": a fresh request carrying only the signed-in subject
  const other = await mine(A);
  assertEquals([other[K.lock].value, other[K.lock].version], [doc, 1]);
  // the database read function services use sees the same, for the owner only
  assertEquals((await sql<{ v: string }>(`SELECT public.setting_get($1, $2) AS v`, [sub(A), K.lock]))[0].v, doc);
});

t("U2: two identities: B never reads, lists, counts or infers A's four values", async () => {
  const doc = `documents/${sub(A)}/private-plan-${rnd()}.md`;
  const marker = `marker-${rnd()}`;
  assertEquals((await put(A, K.lock, doc)).status, 200);
  assertEquals((await put(A, K.last, `documents/${sub(A)}/${marker}-last.md`)).status, 200);
  assertEquals((await put(A, K.start, "podcasts")).status, 200);
  assertEquals((await put(A, K.recent, [{ kind: "source", id: `${marker}-src`, locked: true }, ...items(3)])).status, 200);

  // B's whole answer is the answer of a user who has nothing (no count, no version, no timestamp, no value differs)
  const rb = await call("GET", S, undefined, B);
  const rc = await call("GET", S, undefined, C);
  assertEquals(rb.status, 200);
  const strip = (r: { json: any }) => JSON.stringify(r.json.settings.filter((s: { key: string }) => ALL.includes(s.key)));
  assertEquals(strip(rb), strip(rc), "B's view of the four keys equals a pristine user's");
  for (const frag of [doc, marker, sub(A)]) assert(!rb.text.includes(frag), `B's answer carries nothing of A's: ${frag}`);
  // B cannot lock A's document either: A's path in B's write is refused and nothing is stored for B
  const steal = await put(B, K.lock, doc);
  assert(steal.status >= 400 && steal.status < 500, `B's lock of A's document is refused (${steal.status}): ${steal.text}`);
  assertEquals((await mine(B))[K.lock].value, null);
  // naming A in the query or the body does not change whose it is
  const viaQuery = await call("GET", `${S}?owner_sub=${encodeURIComponent(sub(A))}&sub=${encodeURIComponent(sub(A))}`, undefined, B);
  assertEquals(strip(viaQuery), strip(rc));
  const viaBody = await call("PUT", `${S}/${K.start}`, { value: "chat", owner_sub: sub(A), owner: sub(A) }, B);
  assertEquals(viaBody.status, 200);
  assertEquals((await mine(A))[K.start].value, "podcasts", "B's write never reaches A");
  assertEquals((await mine(B))[K.start].value, "chat");

  // errors do not leak: B's stale write (a version only A has reached) is refused talking about B's own row alone
  const stale = await put(B, K.lock, `documents/${sub(B)}/b.md`, 1);
  assertEquals(stale.status, 409, stale.text);
  assert(stale.text.includes("version 0, not 1"), stale.text);
  const pristine = await put(C, K.lock, `documents/${sub(C)}/c.md`, 1);
  assertEquals([pristine.status, pristine.json.error], [409, stale.json.error], "the refusal is the same for B as for a user with nothing");
  for (const frag of [doc, marker, sub(A)]) assert(!stale.text.includes(frag), `the refusal carries nothing of A's: ${frag}`);
  assertEquals((await mine(B))[K.lock].version, 0, "the refused write changed nothing");

  // B's DELETE is B's alone; A's values stand
  assertEquals((await call("DELETE", `${S}/${K.lock}`, undefined, B)).json.is_default, true);
  const a = await mine(A);
  assertEquals([a[K.lock].value, a[K.start].value, a[K.recent].value.length], [doc, "podcasts", 4]);

  // the database: B's read function and rows hold only B's
  assertEquals((await sql<{ v: unknown }>(`SELECT public.setting_get($1, $2) AS v`, [sub(B), K.lock]))[0].v, null);
  const rows = await sql<{ owner_sub: string }>(`SELECT DISTINCT owner_sub FROM public.user_settings WHERE key = ANY($1) AND owner_sub IN ($2, $3, $4)`, [ALL, sub(A), sub(B), sub(C)]);
  assertEquals(rows.map((r) => r.owner_sub).sort(), [sub(A), sub(B)].sort(), "C stored nothing; no row is shared");
  // no route takes an owner: there is no way to ask for another subject's keys
  const attempts = [`${S}/${K.lock}?owner_sub=${encodeURIComponent(sub(A))}`, `${S}/admin`];
  for (const u of attempts) {
    const r = await call("GET", u, undefined, B);
    assert(!r.text.includes(doc) && !r.text.includes(marker), `B read nothing of A's at ${u}`);
  }
});

t("U3: a write carrying a stale version is refused and changes nothing; the right version goes through", async () => {
  const who = { "X-Test-Sub": `ui-v-${rnd()}` };
  assertEquals((await put(who, K.start, "library", 0)).json.version, 1); // 0 = nothing stored yet
  assertEquals((await put(who, K.start, "home", 0)).status, 409, "0 is stale once a row exists");
  assertEquals((await mine(who))[K.start].value, "library");
  const ok = await put(who, K.start, "home", 1);
  assertEquals([ok.status, ok.json.version], [200, 2]);
  const stale = await put(who, K.start, "chat", 1);
  assertEquals(stale.status, 409, stale.text);
  assertEquals((await mine(who))[K.start].value, "home", "the stale write changed nothing");
  assertEquals((await mine(who))[K.start].version, 2);
});

t("U4: values the registry refuses are 400, a documents/ path that is not the caller's is 404 (the owner-scope gate), and nothing is stored", async () => {
  const who = { "X-Test-Sub": `ui-x-${rnd()}` };
  const me = sub(who); // a safe subject: its documents directory key is the subject itself (middleware/identity.ts ownerKey)
  // Layer 1, the request gate (middleware/owner-scope.ts) runs before any route: a body naming a documents/ path that is
  // not the caller's - another user's directory, or a path whose `..` resolves outside the caller's own - answers 404
  // "no such document", exactly as a missing document does (no existence leak). The registry never sees these.
  const foreign: [string, unknown][] = [
    [K.recent, [{ kind: "document", id: "documents/a/../b.md" }]], [K.recent, [{ kind: "document", id: "documents/a/x.md" }]],
    [K.lock, "documents/a/../b.md"], [K.lock, "documents/a/sk-0123456789abcdef0123456789.md"], [K.lock, `documents/${me}/../b.md`],
    [K.last, "documents/a/‮.md"],
  ];
  for (const [k, v] of foreign) {
    const r = await put(who, k, v);
    assertEquals([r.status, r.json.error], [404, "no such document"], `${k}=${JSON.stringify(v).slice(0, 60)}: ${r.text}`);
  }
  // Layer 2, the registry (setting_problem, via the settings route): every malformed value that reaches it is 400 -
  // including the caller's OWN documents/ paths with dot segments, credential shapes or direction characters
  const bad: [string, unknown][] = [
    [K.start, "nowhere"], [K.start, 3], [K.start, ""],
    [K.lock, ""], [K.lock, "   "], [K.lock, 7], [K.lock, "a\nb"], [K.lock, "x".repeat(401)], [K.last, ["a-list"]],
    [K.recent, "a-string"], [K.recent, { kind: "document", id: "a" }],
    [K.recent, items(25)],
    [K.recent, ["a-string"]], [K.recent, [1]], [K.recent, [null]],
    [K.recent, [{ kind: "document" }]], [K.recent, [{ id: "a" }]],
    [K.recent, [{ kind: "Document", id: "a" }]], [K.recent, [{ kind: "doc ument", id: "a" }]], [K.recent, [{ kind: 5, id: "a" }]],
    [K.recent, [{ kind: "document", id: "" }]], [K.recent, [{ kind: "document", id: "  " }]], [K.recent, [{ kind: "document", id: "a\u0007b" }]],
    [K.recent, [{ kind: "document", id: "x".repeat(121) }]], [K.recent, [{ kind: "document", id: 5 }]],
    [K.recent, [{ kind: "document", id: "a", locked: "yes" }]],
    // text does not ride in the list, whatever it is called
    [K.recent, [{ kind: "source", id: "a", title: "private words" }]], [K.recent, [{ kind: "source", id: "a", text: "x" }]],
    // round 2 (F4, F6): credential-shaped ids, kinds outside the set, prose ids, dot segments, invisible and direction characters
    [K.recent, [{ kind: "source", id: "sk-0123456789abcdef0123456789" }]], [K.recent, [{ kind: "source", id: "a:ghp_0123456789abcdef01234567" }]],
    [K.recent, [{ kind: "source", id: "eyJhbGciOiJIUzI1NiJ9" }]], [K.recent, [{ kind: "secret_diagnosis", id: "a" }]],
    [K.recent, [{ kind: "source", id: "my doctor said the biopsy" }]], [K.recent, [{ kind: "source", id: "a..b" }]],
    [K.recent, [{ kind: "source", id: "a‮b" }]], [K.recent, [{ kind: "source", id: "a​b" }]], [K.recent, [{ kind: "source", id: "a\u0085b" }]],
    [K.recent, [{ kind: "document", id: "notes/x.md" }]], [K.recent, [{ kind: "document", id: `documents/${me}/a/../b.md` }]],
    [K.recent, [{ kind: "document", id: `documents/${me}/sk-0123456789abcdef0123456789.md` }]],
    [K.lock, "The meeting notes: we will lay off"], [K.lock, `documents/${me}/a/../b.md`], [K.lock, `documents/${me}/./b.md`],
    [K.lock, `documents/${me}/sk-0123456789abcdef0123456789.md`],
    [K.last, `documents/${me}/‮.md`], [K.last, `documents/${me}/a​b.md`],
  ];
  for (const [k, v] of bad) {
    const r = await put(who, k, v);
    assertEquals(r.status, 400, `${k}=${JSON.stringify(v).slice(0, 60)}: ${r.text}`);
  }
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.user_settings WHERE owner_sub = $1`, [sub(who)]))[0].n, 0, "nothing stored");
  // the cap exactly, an empty list, locked flags: accepted
  assertEquals((await put(who, K.recent, items(24))).status, 200);
  assertEquals((await put(who, K.recent, [])).status, 200);
  assertEquals((await put(who, K.recent, [{ kind: "claim", id: "c1", locked: false }, { kind: "source", id: "s-1" }])).status, 200);
  for (const s of ["home", "research", "chat", "documents", "ideas", "podcasts", "library"]) assertEquals((await put(who, K.start, s)).status, 200, s);
  // DELETE is back to the default
  const d = await call("DELETE", `${S}/${K.recent}`, undefined, who);
  assertEquals([d.json.value, d.json.is_default], [null, true]);
});

t("U5: the database refuses the same whoever writes: the app role inserting a bad ref_list or screen directly", async () => {
  const fresh = `ui-d-${rnd()}`; // a subject with no rows: only the guard can refuse (not the primary key)
  const w = (k: string, v: unknown) => codeAsApp(`INSERT INTO public.user_settings (owner_sub, key, value) VALUES ($1, $2, $3::jsonb)`, [fresh, k, JSON.stringify(v)]);
  assertEquals(await w(K.recent, [{ kind: "document", id: "a", title: "text" }]), "22023");
  assertEquals(await w(K.recent, items(25)), "22023");
  assertEquals(await w(K.start, "nowhere"), "22023");
  assertEquals(await w(K.recent, [{ kind: "source", id: "a" }]), "");
  assertEquals(await codeAsApp(`INSERT INTO public.settings_keys (key, tier, type, section, label, read_by) VALUES ('ui.x', 'user', 'ref_list', 'ui', 't', 't')`), "42501", "the app role cannot add keys");
});

t("U6: no credential-shaped or secret-named key sits in the four; none stores document text (types are string, enum, ref_list of identifiers)", async () => {
  const r = await sql<{ key: string; type: string; validation: any }>(`SELECT key, type, validation FROM public.settings_keys WHERE key = ANY($1) ORDER BY key`, [ALL]);
  assertEquals(r.map((x) => [x.key, x.type]), [["library.recent", "ref_list"], ["ui.last_document", "string"], ["ui.locked_document", "string"], ["ui.start_screen", "enum"]]);
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.settings_keys WHERE key = ANY($1) AND key ~* '(secret|token|passw|bearer|credential|apikey|(^|[._])key($|[._])|_key($|[._]))'`, [ALL]))[0].n, 0);
});

t("U7: a locked document that is trashed is 'not live' to the documents state route the app asks (and the lock itself is just an identifier); restore makes it live again; B cannot ask about A's", async () => {
  const D = "/workbench/documents";
  const created = await call("POST", D, { title: `ui lock ${rnd()}`, body: "private body text" }, A);
  assertEquals(created.status, 201, created.text);
  const path = created.json.path as string;
  const st = (p: string, who = A) => call("GET", `${D}/state?path=${encodeURIComponent(p)}`, undefined, who);
  assertEquals(await put(A, K.lock, path).then((r) => r.status), 200);
  const live = await st(path);
  assertEquals([live.status, live.json.listed, live.json.trashed], [200, true, false], live.text);
  // the lock holds the path and nothing of the text
  const stored = JSON.stringify((await mine(A))[K.lock]);
  assert(!stored.includes("private body text"));
  // another subject asking about A's path gets a plain refusal, never A's state
  const other = await st(path, B);
  assertEquals(other.status, 404, other.text);
  assert(!other.text.includes(path) || other.json.error === "no such document", other.text);
  // trash it: the live path no longer answers as a live document (404 or listed:false / trashed:true)
  const tr = await call("POST", `${D}/trash`, { path }, A);
  assertEquals(tr.status, 200, tr.text);
  const gone = await st(path);
  assert(gone.status >= 400 || gone.json.listed === false || gone.json.trashed === true, `trashed is not live: ${gone.status} ${gone.text}`);
  assertNotEquals(gone.status >= 500, true, "never a server error");
  // the stored lock is untouched (unlocking is the user's act); restoring brings the document back
  assertEquals((await mine(A))[K.lock].value, path);
  const rs = await call("POST", `${D}/restore`, { path: tr.json.trashed }, A);
  assertEquals(rs.status, 200, rs.text);
  const back = await st(path);
  assertEquals([back.status, back.json.listed, back.json.trashed], [200, true, false], back.text);
});

t("U8 (F2): two first writes that both send version 0 - exactly one wins, the other is refused as stale", async () => {
  for (const key of [K.lock, K.start]) {
    const who = { "X-Test-Sub": `ui-r-${rnd()}` };
    const v = key === K.lock ? [`documents/${sub(who)}/one.md`, `documents/${sub(who)}/two.md`] : ["home", "chat"];
    const rs = await Promise.all([put(who, key, v[0], 0), put(who, key, v[1], 0)]);
    assertEquals(rs.map((r) => r.status).sort(), [200, 409], `${key}: ${rs.map((r) => r.text).join(" | ")}`);
    const winner = rs.find((r) => r.status === 200)!;
    assertEquals(winner.json.version, 1);
    assertEquals((await mine(who))[key].value, winner.json.value);
    assertEquals((await mine(who))[key].version, 1);
  }
  // many at once: still exactly one
  const who = { "X-Test-Sub": `ui-r-${rnd()}` };
  const many = await Promise.all(Array.from({ length: 8 }, (_, i) => put(who, K.recent, [{ kind: "source", id: `w${i}` }], 0)));
  assertEquals(many.filter((r) => r.status === 200).length, 1, many.map((r) => r.status).join());
  assertEquals(many.filter((r) => r.status === 409).length, 7);
});

t("U9 (F3): DELETE takes the version; a stale Unlock is refused; versions never go back after a delete (no ABA)", async () => {
  const who = { "X-Test-Sub": `ui-u-${rnd()}` };
  const P = (n: string) => `documents/${sub(who)}/${n}.md`;
  assertEquals((await put(who, K.lock, P("one"), 0)).json.version, 1);
  assertEquals((await put(who, K.lock, P("two"), 1)).json.version, 2); // another browser locks "two"
  // this tab still holds version 1: its Unlock is refused and the newer lock stays
  const stale = await call("DELETE", `${S}/${K.lock}?version=1`, undefined, who);
  assertEquals(stale.status, 409, stale.text);
  assertEquals((await mine(who))[K.lock].value, P("two"));
  // the right version deletes, and the delete is itself a version
  const del = await call("DELETE", `${S}/${K.lock}?version=2`, undefined, who);
  assertEquals([del.status, del.json.is_default, del.json.version], [200, true, 3], del.text);
  assertEquals((await mine(who))[K.lock].version, 3, "a key with no row reports the version the delete left, not 0");
  // lock again: the number continues
  assertEquals((await put(who, K.lock, P("three"), 3)).json.version, 4);
  // ABA: a tab still holding an old version can no longer overwrite what it never saw
  for (const old of [0, 1, 2, 3]) {
    const r = await put(who, K.lock, P("four"), old);
    assertEquals(r.status, 409, `version ${old}: ${r.text}`);
  }
  assertEquals((await mine(who))[K.lock].value, P("three"));
  // a stale Unlock of the deleted key is refused too; an unversioned DELETE still works (the Settings panel's reset)
  await call("DELETE", `${S}/${K.lock}?version=4`, undefined, who); // -> 5
  assertEquals((await call("DELETE", `${S}/${K.lock}?version=4`, undefined, who)).status, 409);
  assertEquals((await call("DELETE", `${S}/${K.lock}?version=x`, undefined, who)).status, 400);
  assertEquals((await call("DELETE", `${S}/${K.lock}`, undefined, who)).status, 200);
  assertEquals((await mine(who))[K.lock].version, 5);
  // another subject's versions are its own
  assertEquals((await mine(B))[K.lock].version, 0);
});

async function codeAs(role: string, text: string, args: unknown[] = []): Promise<string> {
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

t("U10: slot 400's other keys count monotonically too; no other login reaches the tombstones or the clear function", async () => {
  const who = { "X-Test-Sub": `ui-t-${rnd()}` };
  await call("PUT", `${S}/refinery.dormancy_days`, { value: 5 }, who);
  const d = await call("DELETE", `${S}/refinery.dormancy_days`, undefined, who);
  assertEquals(d.json.version, 2);
  assertEquals((await call("PUT", `${S}/refinery.dormancy_days`, { value: 6, version: 2 }, who)).json.version, 3);
  for (const role of ["ob_pantry", "anon", "authenticated"]) {
    assertEquals(await codeAs(role, `SELECT count(*) FROM public.user_setting_tombstones`), "42501", role);
    assertEquals(await codeAs(role, `SELECT public.user_setting_clear($1, 'ui.start_screen', NULL)`, [sub(B)]), "42501", role);
  }
});
