// deno test src/contracts/inlets_integration_test.ts - rwr-imports-server-api over a REAL workbench and database: the
// caller's own inlet connections (slot 600, GET /workbench/contract/inlets/connections) as THREE users and a service key,
// the catalog (who can run the function, who has any right on inlet_connections), and the retry cap on the intake route.
// SKIPPED unless INLETS_TEST_BASE and CONTRACT_TEST_DB_HOST are set; contract-test/run-inlets-tests.ps1 runs it in its
// disposable lab (the real initdb chain incl. 470, 480 and 600; the workbench logs in as ob_workbench, as compose does).
// Never point it at a live stack: it plants connection rows and import jobs.
// Environment: INLETS_TEST_BASE, INLETS_TEST_KEY (the door key), INLETS_TEST_SERVICE_KEY (a WORKSPACE_SERVICE_KEYS key),
// INLETS_TEST_SUB_HEADER (default X-Test-Sub), CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser: plants, catalog).
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("INLETS_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("INLETS_TEST_KEY") ?? "";
const SVC = Deno.env.get("INLETS_TEST_SERVICE_KEY") ?? "";
const SUB_HEADER = Deno.env.get("INLETS_TEST_SUB_HEADER") ?? "X-Test-Sub";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 3, true)
  : null;
// N1..N5 (inlets) and R1..R3 (the retry cap) name the acceptance statements (test-plans/rwr-imports-server-api.md)
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
const A = `inl-ann-${rnd()}`;
const B = `inl-bob-${rnd()}`;
const C = `inl-cy-${rnd()}`; // has no connection
const CONN_A = [`mbox-ann-${rnd()}`, `vault-ann-${rnd()}`];
const CONN_B = `mbox-bob-${rnd()}`;
const URL_PATH = "/workbench/contract/inlets/connections";

async function call(who: string | null, method: string, path: string, body?: unknown, key = KEY) {
  const headers: Record<string, string> = { "x-brain-key": key };
  if (who) headers[SUB_HEADER] = who;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  return { status: r.status, json, text };
}

async function plant() {
  await sql(`INSERT INTO public.inlet_connections (id, kind, owner_sub) VALUES ($1, 'gmail', $3), ($2, 'vault', $3), ($4, 'gmail', $5)
             ON CONFLICT (id) DO NOTHING`, [CONN_A[0], CONN_A[1], A, CONN_B, B]);
}

t("N1 two identities: each person gets only their own connections; none for a person with none", async () => {
  await plant();
  const a = await call(A, "GET", URL_PATH);
  assertEquals(a.status, 200, a.text);
  assertEquals(a.json.connections.map((x: any) => x.kind).sort(), ["gmail", "vault"]);
  const b = await call(B, "GET", URL_PATH);
  assertEquals(b.status, 200, b.text);
  assertEquals(b.json.connections.map((x: any) => x.kind), ["gmail"]);
  const c = await call(C, "GET", URL_PATH);
  assertEquals(c.status, 200, c.text);
  assertEquals(c.json, { connections: [] });
  // B's whole answer holds nothing of A's: not A's subject, not A's connection ids, not a count of A's rows
  for (const needle of [A, ...CONN_A]) assert(!b.text.includes(needle), `B's answer names ${needle}`);
  assert(!c.text.includes(A) && !c.text.includes(B), "C's answer names someone");
  assertEquals(Object.keys(b.json), ["connections"], "no total, no count, no other field");
  // a user cannot ask for someone else's: the query string and a header naming a person change nothing
  const spoof = await call(B, "GET", `${URL_PATH}?owner_sub=${encodeURIComponent(A)}&sub=${encodeURIComponent(A)}`);
  assertEquals(spoof.json.connections.length, 1);
  assert(!spoof.text.includes(A));
});

t("N2 the answer carries kind and the two stamps and nothing else (not the connection id, not the owner)", async () => {
  await plant();
  const a = await call(A, "GET", URL_PATH);
  for (const row of a.json.connections) assertEquals(Object.keys(row).sort(), ["created_at", "kind", "updated_at"]);
  for (const needle of [...CONN_A, A]) assert(!a.text.includes(needle), `A's own answer names ${needle}`);
  assert(!Number.isNaN(Date.parse(a.json.connections[0].created_at)));
});

t("N3 a service key has no inlets (403), as for the other per-user routes", async () => {
  if (!SVC) throw new Error("INLETS_TEST_SERVICE_KEY is not set");
  const r = await call(null, "GET", URL_PATH, undefined, SVC);
  assertEquals(r.status, 403, r.text);
  assert(!r.text.includes(A));
});

t("N4 the function, as ob_workbench: an unusable subject, another person's, or none gets nothing of A's", async () => {
  await plant();
  const c = await pool!.connect();
  const asWb = async (sub: string | null): Promise<number> => {
    await c.queryObject(`BEGIN`);
    try {
      await c.queryObject(`SET LOCAL ROLE ob_workbench`);
      return (await c.queryObject<{ n: number }>(`SELECT count(*)::int AS n FROM public.inlet_connections_of($1)`, [sub])).rows[0].n;
    } finally {
      await c.queryObject(`ROLLBACK`);
    }
  };
  try {
    for (const s of ["", "   ", "service:mcp", "system:x", "anonymous:y", "operator", "OPERATOR", C, `${A} `, `${A}' OR '1'='1`, null]) {
      assertEquals(await asWb(s), 0, `subject ${JSON.stringify(s)} got rows`);
    }
    assertEquals(await asWb(B), 1, "B gets B's own one");
    assertEquals(await asWb(A), 2, "A gets A's two");
  } finally {
    c.release();
  }
});

t("N5 the catalog: ob_workbench alone may run the function, and no role gains any right on inlet_connections", async () => {
  const roles = await sql<{ rolname: string; fn: boolean; sel: boolean; wr: boolean }>(
    `SELECT r.rolname,
            has_function_privilege(r.oid, 'public.inlet_connections_of(text)'::regprocedure, 'EXECUTE') AS fn,
            has_table_privilege(r.oid, 'public.inlet_connections', 'SELECT') AS sel,
            (has_table_privilege(r.oid, 'public.inlet_connections', 'INSERT') OR has_table_privilege(r.oid, 'public.inlet_connections', 'UPDATE')
             OR has_table_privilege(r.oid, 'public.inlet_connections', 'DELETE') OR has_table_privilege(r.oid, 'public.inlet_connections', 'TRUNCATE')
             OR has_table_privilege(r.oid, 'public.inlet_connections', 'REFERENCES') OR has_table_privilege(r.oid, 'public.inlet_connections', 'TRIGGER')) AS wr
       FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' ORDER BY 1`);
  assertEquals(roles.filter((r) => r.fn).map((r) => r.rolname), ["ob_workbench"], "who may run inlet_connections_of");
  // 470's own view role reads the record (its prune); nobody else has any right, ob_workbench included (it reads through the function)
  assertEquals(roles.filter((r) => r.sel).map((r) => r.rolname), ["ob_inlet_stamp_view"], "who may SELECT the table");
  assertEquals(roles.filter((r) => r.wr).map((r) => r.rolname), [], "who may write or reference the table");
  const anon = await sql<{ pub: boolean }>(`SELECT has_function_privilege('public', 'public.inlet_connections_of(text)'::regprocedure, 'EXECUTE') AS pub`);
  assertEquals(anon[0].pub, false, "PUBLIC");
  const rls = await sql<{ rls: boolean; frc: boolean }>(`SELECT relrowsecurity AS rls, relforcerowsecurity AS frc FROM pg_class WHERE oid = 'public.inlet_connections'::regclass`);
  assertEquals([rls[0].rls, rls[0].frc], [true, true], "row-level security stays on and forced");
  const def = await sql<{ prosecdef: boolean; cols: string }>(
    `SELECT prosecdef, pg_get_function_result(oid) AS cols FROM pg_proc WHERE oid = 'public.inlet_connections_of(text)'::regprocedure`);
  assertEquals(def[0].prosecdef, true);
  assertEquals(def[0].cols, "TABLE(kind text, created_at timestamp with time zone, updated_at timestamp with time zone)", "the function exposes kind and stamps only");
});

// ── the retry cap ────────────────────────────────────────────────────────────────────────────────────────────────
async function failedJob(owner: string, attempts = 1, status = "failed"): Promise<string> {
  const r = await sql<{ id: string }>(
    `INSERT INTO public.import_jobs (status, mode, origin, owner_sub, actor_sub, actor_name, url, error, attempts)
     VALUES ($1, 'add', 'workspace', $2, $2, 'lab', $3, 'the page answered with an error', $4) RETURNING id::text AS id`,
    [status, owner, `https://alpha.example/${rnd()}`, attempts]);
  return r[0].id;
}
const state = async (id: string) => (await sql<{ status: string; attempts: number; error: string | null }>(`SELECT status, attempts, error FROM public.import_jobs WHERE id = $1::uuid`, [id]))[0];
async function settle(id: string) {
  for (let i = 0; i < 40; i++) {
    const s = await state(id);
    if (["failed", "held", "cancelled", "done"].includes(s.status)) return s;
    await new Promise((r) => setTimeout(r, 250));
  }
  return await state(id);
}
const RETRY = (id: string) => `/workbench/intake/jobs/add/${id}/retry`;
const REASON = "this job was already retried once, so it cannot be retried again: add the link or file again as a new item";

t("R1 a failed job is retried once; the second retry answers 409 with a reason and changes nothing", async () => {
  const id = await failedJob(A);
  const first = await call(A, "POST", RETRY(id));
  assertEquals(first.status, 202, first.text);
  assertEquals(first.json.job.detail.attempts, 2);
  const settled = await settle(id); // the pipeline ends it (the lab has no research service: it fails again)
  assertEquals(settled.status, "failed");
  const before = await state(id);
  const second = await call(A, "POST", RETRY(id));
  assertEquals(second.status, 409, second.text);
  assertEquals(second.json.error, REASON);
  assertEquals(await state(id), before, "the row is exactly as it was");
  // a cancelled job at its second attempt is refused the same way
  const cid = await failedJob(A, 2, "cancelled");
  assertEquals((await call(A, "POST", RETRY(cid))).status, 409);
  assertEquals((await state(cid)).attempts, 2);
});

t("R2 the cap holds for every caller: another person's job id answers like a missing one; the same refusal for a service-acting user", async () => {
  const id = await failedJob(A, 2);
  const foreign = await call(B, "POST", RETRY(id));
  const missing = await call(B, "POST", RETRY("99999999-9999-4999-8999-999999999999"));
  assertEquals([foreign.status, foreign.json], [missing.status, missing.json]);
  assertEquals(foreign.status, 404);
  assert(!foreign.text.includes("retried"), "B is not told the job exists, nor that it was retried");
  assertEquals((await state(id)).attempts, 2);
  // the door's own default identity (the lab's single-user admin) is held to the cap too
  const admin = await call(null, "POST", RETRY(await failedJob("operator", 2)));
  assert(admin.status === 409 || admin.status === 404, `the default identity: ${admin.status} ${admin.text}`);
  assertNotEquals(admin.status, 202);
});

t("R3 two retries sent together: one runs, the other is refused, attempts is 2", async () => {
  const id = await failedJob(A);
  const [x, y] = await Promise.all([call(A, "POST", RETRY(id)), call(A, "POST", RETRY(id))]);
  assertEquals([x.status, y.status].sort(), [202, 409], `${x.text} | ${y.text}`);
  assertEquals((await state(id)).attempts, 2);
});

Deno.test({ name: "pool close", ignore, fn: async () => { await pool!.end(); }, sanitizeOps: false, sanitizeResources: false });
