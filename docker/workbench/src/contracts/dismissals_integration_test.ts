// deno test src/contracts/dismissals_integration_test.ts - Cleanup "Not again for this" (rwr-cleanup) over a REAL workbench and
// database, as TWO users. SKIPPED unless DISMISS_TEST_BASE and CONTRACT_TEST_DB_HOST are set;
// contract-test/run-dismissals-tests.ps1 runs it in its disposable lab (the real initdb chain incl. 700-init-cleanup-dismissals.sql,
// fixtures.sql, the :wt workbench with WORKSPACE_IDENTITY_HEADER=X-Test-Sub). Never point it at a live stack.
// STATUS: written with the unit tests; NOT RUN yet (the lab needs a plane lease).
// Environment: DISMISS_TEST_BASE, DISMISS_TEST_KEY, DISMISS_TEST_SUB_HEADER (default X-Test-Sub),
// CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser: plants and snapshots).
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("DISMISS_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("DISMISS_TEST_KEY") ?? "";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const SUB_HEADER = Deno.env.get("DISMISS_TEST_SUB_HEADER") ?? "X-Test-Sub";
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 3, true)
  : null;
// D1..D8 name the acceptance statements (test-plans/rwr-cleanup.md)
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
const A = `dis-a-${rnd()}`;
const B = `dis-b-${rnd()}`;
const MARKER = `DISMISS-MARKER-${rnd()}`;
const DS = "/workbench/contract/cleanup/dismissals";

async function call(who: string, method: string, path: string, body?: unknown, raw?: string) {
  const headers: Record<string, string> = { "x-brain-key": KEY, [SUB_HEADER]: who };
  if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(BASE + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  return { status: r.status, json, text };
}
const mk = (who: string, over: Record<string, unknown> = {}) => call(who, "POST", DS, { kind: "reopen_candidate", ref: MARKER, ...over });

// the shared knowledge a dismissal must not touch: every row of these tables, hashed
const SHARED = ["sources", "source_chunks", "claims", "claim_sources", "reference_records", "source_trail_events", "source_tombstones", "wiki_pages", "user_flags"];
async function snapshot() {
  const out: Record<string, string> = {};
  for (const tb of SHARED) {
    const ex = await sql<{ r: string | null }>(`SELECT to_regclass('public.${tb}')::text AS r`);
    if (!ex[0].r) continue;
    const r = await sql<{ n: number; h: string }>(`SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '' ORDER BY x::text)), '') AS h FROM public.${tb} x`);
    out[tb] = `${r[0].n}:${r[0].h}`;
  }
  return out;
}

t("D1: a person dismisses; it is theirs - their list has it, another person's list does not, and no total moves for them", async () => {
  const a = await mk(A);
  assertEquals(a.status, 201, a.text);
  assertEquals(Object.keys(a.json).sort(), ["created_at", "id", "kind", "ref"]);
  assertEquals((await call(A, "GET", DS)).json.total, 1);
  const b = await call(B, "GET", DS);
  assertEquals(b.status, 200);
  assertEquals(b.json, { dismissals: [], total: 0 });
  assert(!b.text.includes(MARKER), "another person's list never carries the ref");
});

t("D2: the same dismissal twice is one row, and one id", async () => {
  const one = await mk(A), two = await mk(A);
  assertEquals(one.json.id, two.json.id);
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.cleanup_dismissals WHERE ref = $1`, [MARKER]))[0].n, 1);
});

t("D3: it is still there for them and still absent for another person after B dismisses the same thing (rows are per person)", async () => {
  assertEquals((await mk(B)).status, 201);
  const ids = (await sql<{ owner_sub: string }>(`SELECT owner_sub FROM public.cleanup_dismissals WHERE ref = $1 ORDER BY owner_sub`, [MARKER])).map((r) => r.owner_sub).sort();
  assertEquals(ids, [A, B].sort());
  assertEquals((await call(A, "GET", DS)).json.total, 1);
  assertEquals((await call(B, "GET", DS)).json.total, 1);
});

t("D4: another person's dismissal by id is NOT FOUND, the same answer as a missing one; the row stays", async () => {
  const mine = (await call(A, "GET", DS)).json.dismissals[0].id as string;
  const other = await call(B, "DELETE", `${DS}/${mine}`);
  const missing = await call(B, "DELETE", `${DS}/00000000-0000-4000-8000-00000000dead`);
  assertEquals(other.status, 404);
  assertEquals([other.status, other.json], [missing.status, missing.json]);
  const junk = await call(B, "DELETE", `${DS}/not-an-id`);
  assertEquals([junk.status, junk.json], [missing.status, missing.json]);
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.cleanup_dismissals WHERE id = $1`, [mine]))[0].n, 1);
  assertEquals((await call(A, "DELETE", `${DS}/${mine}`)).status, 200);
  assertEquals((await call(A, "GET", DS)).json.total, 0);
});

t("D5: a kind the registry does not know is 422, an unknown or user-shaped field is 400, a NUL or a long ref is 400; none writes a row", async () => {
  const before = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.cleanup_dismissals`))[0].n;
  assertEquals((await mk(A, { kind: "nope" })).status, 422);
  assertEquals((await mk(A, { owner_sub: B })).status, 400);
  assertEquals((await mk(A, { user: B })).status, 400);
  assertEquals((await mk(A, { ref: "a\u0000b" })).status, 400);
  assertEquals((await mk(A, { ref: "x".repeat(201) })).status, 400);
  assertEquals((await mk(A, { ref: "" })).status, 400);
  assertEquals((await call(A, "POST", DS, undefined, "{not json")).status, 400);
  assertEquals((await call(A, "GET", `${DS}?kind=nope`)).status, 422);
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.cleanup_dismissals`))[0].n, before);
});

t("D6: the planted ref reaches cleanup_dismissals and no other table (shared search, shared rows, trails, wiki)", async () => {
  await mk(A);
  const tables = await sql<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
  const hits: string[] = [];
  for (const { t: tb } of tables) {
    const r = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public."${tb}" x WHERE x::text LIKE $1`, [`%${MARKER}%`]);
    if (r[0].n > 0) hits.push(tb);
  }
  assertEquals(hits, ["cleanup_dismissals"]);
});

t("D7: dismissing changes nothing about any shared table (sources, tombstones, claims, trails, flags)", async () => {
  const before = await snapshot();
  await mk(A, { ref: `${MARKER}-two` });
  const after = await snapshot();
  assertEquals(after, before);
  assertNotEquals(Object.keys(after).length, 0);
});

t("D8: the table holds exactly the grants the app needs: service_role selects, inserts and deletes; nothing updates a dismissal", async () => {
  const g = await sql<{ p: string }>(`SELECT privilege_type AS p FROM information_schema.role_table_grants WHERE table_name = 'cleanup_dismissals' AND grantee = 'service_role' ORDER BY 1`);
  assertEquals(g.map((r) => r.p), ["DELETE", "INSERT", "SELECT"]);
});
