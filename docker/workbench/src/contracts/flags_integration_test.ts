// deno test src/contracts/flags_integration_test.ts - flag for cleanup (rwr-flags-api) over a REAL workbench and
// database, as TWO users and an admin. SKIPPED unless FLAGS_TEST_BASE and CONTRACT_TEST_DB_HOST are set;
// contract-test/run-flags-tests.ps1 runs it in its disposable lab (the real initdb chain incl. 500-init-flags.sql,
// fixtures.sql, the :wt workbench with WORKSPACE_IDENTITY_HEADER=X-Test-Sub). Never point it at a live stack.
//
// Callers: a user is a request with X-Test-Sub; "admin" is the lab's default identity (no header, no sign-in:
// the single-user admin, settingsAdmin).
// Environment: FLAGS_TEST_BASE, FLAGS_TEST_KEY, FLAGS_TEST_SUB_HEADER (default X-Test-Sub),
// CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser: plants and snapshots).
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("FLAGS_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("FLAGS_TEST_KEY") ?? "";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const SUB_HEADER = Deno.env.get("FLAGS_TEST_SUB_HEADER") ?? "X-Test-Sub";
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 3, true)
  : null;
// F1..F8 name the acceptance statements (test-plans/rwr-flags-api.md)
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}
const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const A = `flag-a-${rnd()}`;
const B = `flag-b-${rnd()}`;
const SRC = "11111111-1111-4111-8111-111111111111";
const CLAIM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const REF = "f2000000-0000-4000-8000-000000000001";
const FL = "/workbench/contract/flags";

async function call(who: string, method: string, path: string, body?: unknown, raw?: string) {
  const headers: Record<string, string> = { "x-brain-key": KEY };
  if (who !== "admin") headers[SUB_HEADER] = who;
  if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(BASE + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  return { status: r.status, json, text };
}
const mk = (who: string, over: Record<string, unknown> = {}) =>
  call(who, "POST", FL, { item_kind: "source", item_id: SRC, reason: "low_quality", note: "n", from: { kind: "source", ref: SRC }, ...over });

// the shared knowledge a flag must not touch: every row of these tables, hashed
const SHARED = ["sources", "source_chunks", "claims", "claim_sources", "reference_records", "reference_holders", "source_trail_events",
  "source_tombstones", "wiki_pages", "page_compile_marks", "source_revisions"];
async function snapshot() {
  const out: Record<string, string> = {};
  for (const tb of SHARED) {
    const ex = await sql<{ r: string | null }>(`SELECT to_regclass('public.${tb}')::text AS r`);
    if (!ex[0].r) continue;
    const r = await sql<{ n: number; h: string }>(
      `SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '' ORDER BY x::text)), '') AS h FROM public.${tb} x`);
    out[tb] = `${r[0].n}:${r[0].h}`;
  }
  return out;
}

t("F1: flagging changes nothing about the flagged item (same state and rows, before and after)", async () => {
  const before = await snapshot();
  assert(Object.keys(before).length >= 5, `the snapshot covers the shared tables (${Object.keys(before)})`);
  for (const [kind, id] of [["source", SRC], ["claim", CLAIM], ["reference", REF]] as const) {
    const r = await mk(A, { item_kind: kind, item_id: id, reason: "wrong_claim", note: `f1 ${kind}` });
    assertEquals(r.status, 201, r.text);
  }
  const f = (await call(A, "GET", `${FL}?limit=500`)).json.flags as any[];
  const id = f[0].id;
  assertEquals((await call(A, "PATCH", `${FL}/${id}`, { state: "withdrawn" })).status, 200);
  assertEquals(await snapshot(), before, "no row of the shared knowledge changed (counts and content hashes)");
  const s = (await call(A, "GET", `/workbench/contract/sources/${SRC}`)).json;
  assertNotEquals(s.state, "withdrawn");
  assertEquals((await sql(`SELECT retraction_committed_at, unlinked_at FROM public.sources WHERE id = $1`, [SRC]))[0].retraction_committed_at, null);
});

t("F2: user B does not see user A's flags, notes or count; an admin sees all", async () => {
  const mark = `F2NOTE-${rnd()}`;
  const a = await mk(A, { note: mark, reason: "duplicate" });
  assertEquals(a.status, 201, a.text);
  const aid = a.json.id;
  const b0 = await call(B, "GET", FL);
  assertEquals(b0.status, 200);
  assertEquals(b0.json.flags, []);
  assertEquals(b0.json.total, 0, "B's count is B's own");
  assert(!b0.text.includes(mark) && !b0.text.includes(aid));
  const aList = await call(A, "GET", FL);
  assert(aList.json.flags.some((f: any) => f.id === aid && f.note === mark), "A sees A's own flag and note");
  assertEquals(aList.json.flags.every((f: any) => f.flagged_by === null), true, "a user's own list never names a flagger");
  // by id: B gets the same answer as for a flag that does not exist
  const bGet = await call(B, "GET", `${FL}/${aid}`);
  const none = await call(B, "GET", `${FL}/${crypto.randomUUID()}`);
  assertEquals([bGet.status, bGet.text], [none.status, none.text]);
  assertEquals(bGet.status, 404);
  const bPatch = await call(B, "PATCH", `${FL}/${aid}`, { note: "hijack" });
  const nonePatch = await call(B, "PATCH", `${FL}/${crypto.randomUUID()}`, { note: "hijack" });
  assertEquals([bPatch.status, bPatch.text], [nonePatch.status, nonePatch.text]);
  assertEquals((await sql(`SELECT note FROM public.user_flags WHERE id = $1`, [aid]))[0].note, mark, "B changed nothing");
  // B asking for everyone's is refused (a non-admin)
  assertEquals((await call(B, "GET", `${FL}?scope=all`)).status, 403);
  // the admin sees A's flag (and who made it) and every other flag
  const adm = await call("admin", "GET", `${FL}?scope=all&limit=500`);
  assertEquals(adm.status, 200, adm.text);
  const mine = adm.json.flags.find((f: any) => f.id === aid);
  assert(mine && mine.note === mark && mine.flagged_by === A, "the admin sees A's flag, note and flagger");
  const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.user_flags`);
  assertEquals(adm.json.total, n, "the admin's total is every flag");
  assertEquals((await call("admin", "GET", `${FL}/${aid}`)).status, 200);
});

t("F3: each flag stores where it was made from and is listed with that link back", async () => {
  const doc = `documents/${A}/from-doc.md`;
  const fromDoc = await mk(A, { from: { kind: "document", ref: doc } });
  assertEquals(fromDoc.status, 201, fromDoc.text);
  assertEquals(fromDoc.json.from, { kind: "document", ref: doc });
  const fromSrc = await mk(A, { item_kind: "claim", item_id: CLAIM, from: { kind: "source", ref: SRC } });
  assertEquals(fromSrc.json.from, { kind: "source", ref: SRC });
  const listed = (await call(A, "GET", `${FL}?limit=500`)).json.flags as any[];
  assertEquals(listed.find((f) => f.id === fromDoc.json.id).from, { kind: "document", ref: doc });
  assertEquals(listed.find((f) => f.id === fromSrc.json.id).from, { kind: "source", ref: SRC });
  const row = (await sql(`SELECT from_kind, from_ref FROM public.user_flags WHERE id = $1`, [fromDoc.json.id]))[0];
  assertEquals([row.from_kind, row.from_ref], ["document", doc]);
  // no `from` is refused; another user's document as the origin is not found, exactly as a missing one
  assertEquals((await call(A, "POST", FL, { item_kind: "source", item_id: SRC, reason: "other" })).status, 400);
  const foreign = await mk(B, { from: { kind: "document", ref: doc } });
  const missing = await mk(B, { from: { kind: "document", ref: `documents/${A}-nobody/x.md` } });
  assertEquals(foreign.status, 404);
  assertEquals([foreign.status, foreign.text], [missing.status, missing.text]);
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.user_flags WHERE owner_sub = $1`, [B]))[0].n, 0);
});

t("F4: the reason is limited to the six values; anything else is refused", async () => {
  for (const reason of ["wrong_claim", "low_quality", "duplicate", "outdated", "broken_link", "other"]) {
    const r = await mk(A, { reason });
    assertEquals(r.status, 201, reason);
    const back = await sql<{ reason: string }>(`SELECT reason FROM public.user_flags WHERE id = $1`, [r.json.id]);
    assertEquals(back[0].reason, reason, "reads back with that reason");
  }
  for (const bad of ["spam", "Duplicate", "wrong claim", "", "low_quality ", "OTHER", "null"]) {
    const r = await mk(A, { reason: bad });
    assert([400, 422].includes(r.status), `reason '${bad}' -> ${r.status}`);
  }
  const noReason = await call(A, "POST", FL, { item_kind: "source", item_id: SRC, from: { kind: "source", ref: SRC } });
  assertEquals(noReason.status, 400);
  const num = await mk(A, { reason: 7 });
  assertEquals(num.status, 400);
  const mid = (await mk(A, { reason: "other" })).json.id;
  assertEquals((await call(A, "PATCH", `${FL}/${mid}`, { reason: "spam" })).status, 422);
  assertEquals((await call(A, "PATCH", `${FL}/${mid}`, { reason: "duplicate" })).json.reason, "duplicate");
  assertEquals((await call(A, "PATCH", `${FL}/${mid}`, { state: "deleted" })).status, 422);
  assertEquals((await mk(A, { item_kind: "page" })).status, 422);
  assertEquals((await mk(A, { item_id: crypto.randomUUID() })).status, 404, "an item that does not exist");
  assertEquals((await call(A, "POST", FL, undefined, "{nope")).status, 400);
  const own = await mk(A, { owner_sub: B });
  assertEquals(own.status, 400, "no user field is accepted");
  const stored = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.user_flags WHERE reason NOT IN ('wrong_claim','low_quality','duplicate','outdated','broken_link','other')`);
  assertEquals(stored[0].n, 0, "no row holds another reason");
});

t("F5: the note text never appears on a shared surface (planted marker)", async () => {
  const mark = `F5NOTE-${rnd()}`;
  const r = await mk(A, { note: mark });
  assertEquals(r.status, 201, r.text);
  // the database: no table but user_flags holds the marker
  const tables = await sql<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
  const holders: string[] = [];
  for (const { t: tb } of tables) {
    const n = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public."${tb}" x WHERE x::text LIKE $1`, [`%${mark}%`]);
    if (n[0].n > 0) holders.push(tb);
  }
  assertEquals(holders, ["user_flags"], "the marker is in user_flags only");
  // every shared read as another user, and as a service-less default: none carries it
  const surfaces = [
    `/workbench/contract/search?q=${mark}&kinds=page,claim,source`, `/workbench/contract/sources/${SRC}`,
    `/workbench/contract/sources/${SRC}/dependence`, `/workbench/contract/sources/${SRC}/quality`,
    `/workbench/contract/cleanup/sources?limit=500`, `/workbench/contract/cleanup/actions`, `/workbench/contract/timeline`,
    `/workbench/contract/notifications`, `/workbench/contract/trail`, `/workbench/openapi.json`,
  ];
  for (const who of [B, "admin"]) {
    for (const p of surfaces) {
      const x = await call(who, "GET", p);
      // the search route echoes the query it was given, so for it the answer is the hits: none
      if (p.includes("/search?")) assertEquals((x.json.results ?? []).length, 0, `${p} as ${who} finds the note`);
      else assert(!x.text.includes(mark), `${p} as ${who} carries the note`);
    }
  }
  // B's own list and B's by-id answer do not carry it either (the surface for a second user)
  assert(!(await call(B, "GET", FL)).text.includes(mark));
  assert(!(await call(B, "GET", `${FL}/${r.json.id}`)).text.includes(mark));
});

t("F6: two identities - B never sees A's per-user data: nested fields, counts, list totals, error messages", async () => {
  const mark = `F6NOTE-${rnd()}`;
  const docA = `documents/${A}/six.md`;
  const a = await mk(A, { note: mark, from: { kind: "document", ref: docA } });
  const aid = a.json.id;
  const b = await mk(B, { note: `b-${rnd()}`, reason: "duplicate" });
  assertEquals(b.status, 201);
  const bList = await call(B, "GET", `${FL}?limit=500`);
  assertEquals(bList.json.total, bList.json.flags.length, "B's total counts B's flags only");
  assert(bList.json.flags.every((f: any) => f.id === b.json.id || !bList.text.includes(f.id)));
  assert(!bList.text.includes(mark) && !bList.text.includes(aid) && !bList.text.includes(docA) && !bList.text.includes(A));
  for (const q of ["?state=open", "?item_kind=source", "?limit=1", "?scope=mine"]) {
    const x = await call(B, "GET", FL + q);
    assert(!x.text.includes(mark) && !x.text.includes(aid) && !x.text.includes(A), `B${q}`);
    assert(x.json.flags.every((f: any) => f.id === b.json.id));
  }
  assertEquals((await call(B, "GET", `${FL}?scope=all`)).text.includes(mark), false);
  assertEquals(JSON.parse((await call(B, "GET", `${FL}?scope=all`)).text).error, "scope=all is for admins");
  // error texts: a refusal about A's row is byte-identical to one about a missing row
  for (const m of ["GET", "PATCH"]) {
    const body = m === "PATCH" ? { note: "x" } : undefined;
    const x = await call(B, m, `${FL}/${aid}`, body);
    const y = await call(B, m, `${FL}/${crypto.randomUUID()}`, body);
    assertEquals([x.status, x.text], [y.status, y.text], m);
    assert(!x.text.includes(aid) && !x.text.includes(A));
  }
  // B naming A's document as its own origin: same as a missing document, and no text of A's
  const x = await mk(B, { from: { kind: "document", ref: docA } });
  assert(!x.text.includes(mark) && !x.text.includes(A), x.text);
  assertEquals(x.status, 404);
  // A's rows are unchanged after all of B's attempts, and B's flags are not in A's list
  assertEquals((await sql(`SELECT note, reason FROM public.user_flags WHERE id = $1`, [aid]))[0].note, mark);
  const aList = await call(A, "GET", `${FL}?limit=500`);
  assert(!aList.text.includes(b.json.id));
});

t("F7: the flag routes are in the served contract, and are not tools on the shared surface", async () => {
  const doc = (await call(A, "GET", "/workbench/openapi.json")).json;
  const base = doc.paths?.["/workbench/contract/flags"];
  assert(base?.post && base?.get, "create and list are documented");
  assert(doc.paths["/workbench/contract/flags/{id}"]?.patch, "update is documented");
  for (const op of [base.post, base.get, doc.paths["/workbench/contract/flags/{id}"].get, doc.paths["/workbench/contract/flags/{id}"].patch]) {
    assertEquals(op["x-mcp-tool"], undefined);
  }
});

t("F8: the registry behind the reasons is exactly six active keys (slots 500 + 680)", async () => {
  const r = await sql<{ key: string }>(`SELECT key FROM public.contract_registry_entries WHERE registry = 'flag_reasons' AND retired_at IS NULL ORDER BY key`);
  assertEquals(r.map((x) => x.key), ["broken_link", "duplicate", "low_quality", "other", "outdated", "wrong_claim"]);
});

t("R2: a NUL in a note is 400; an admin keeps from.ref of another user's document; a from source must exist", async () => {
  const nul = await mk(A, { note: "a\u0000b" });
  assertEquals(nul.status, 400, nul.text);
  assertEquals((await call(A, "POST", FL, undefined, '{"item_kind":"source","item_id":"' + SRC + '","reason":"other","note":"x\\u0000y","from":{"kind":"source","ref":"' + SRC + '"}}')).status, 400);
  const doc = `documents/${A}/r2-${rnd()}.md`;
  const made = await mk(A, { from: { kind: "document", ref: doc } });
  assertEquals(made.status, 201, made.text);
  const list = await call("admin", "GET", `${FL}?scope=all&limit=500`);
  assertEquals(list.json.flags.find((f: any) => f.id === made.json.id).from.ref, doc, "the admin list keeps the origin");
  assertEquals((await call("admin", "GET", `${FL}/${made.json.id}`)).json.from.ref, doc, "and so does the admin's by-id read");
  const gone = await mk(A, { from: { kind: "source", ref: crypto.randomUUID() } });
  assertEquals(gone.status, 404, gone.text);
});

Deno.test({ name: "close the pool", ignore, sanitizeOps: false, sanitizeResources: false, fn: async () => { await pool?.end(); } });
