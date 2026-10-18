/** D5 stage 1 in openbrain-mcp's SQL consumers (rw-p0-contract attempt 2, tester finding F3; made
 * behavioural by rw-p0b-purge-door, tester finding T2-3): the suggestion / hidden triage listing
 * must filter suppressed sources like every other consumer (the workbench's own triage list,
 * notebooks.ts listSuggestions, already does).
 *
 * The listing's query is SUGGESTION_LIST_SQL (suggestion-list.ts). This test RUNS that text against
 * a DISPOSABLE database holding one active and one suppressed source suggested into one thread,
 * so a filter commented out inside the SQL (or deleted) fails here; a static regex could not tell
 * a live filter from a commented one.
 *
 * Run (the database tests are SKIPPED unless D5_TEST_DB_HOST is set; never a live database - the
 * test inserts and deletes rows):
 *   deno test --allow-read --allow-env --allow-net d5-consumers.test.ts
 * contract-test/run-contract-tests.ps1 step [4] runs it against its disposable database A.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { SUGGESTION_LIST_SQL } from "./suggestion-list.ts";

const HOST = Deno.env.get("D5_TEST_DB_HOST");
const ignore = !HOST;

// THE BINDING, by execution (rw-p0b-purge-door attempt 2, tester finding N3: attempt 1 counted
// `queryObject` in index.ts's text, so a second query through queryArray, a template literal or a
// double-quoted string, or a module-level shadow `const SUGGESTION_LIST_SQL = SLS.replace(...)`,
// passed). Now index.ts itself is EXECUTED, its external imports swapped for recording stand-ins
// (the MCP server records each registered tool; the pg Pool hands out a client that records EVERY
// method call, whatever its name or argument shape), and the two triage tools are invoked. Each call
// must make exactly the pool's own liveness probe (ResilientPool.connect: queryArray "SELECT 1")
// and ONE statement: queryObject(SUGGESTION_LIST_SQL - the very constant the database test below
// runs - , [status, thread]). Anything else - another statement, another method, a different text -
// FAILS. Only the module's import lines and its final Deno.serve call are rewritten (counted below);
// the code that registers and runs the tools is index.ts as it is.
const STUB_MCP = `
export const registered = (globalThis.__d5Registered ??= []);
const chain = new Proxy(function () {}, {
  get(_t, p) { if (p === "then") return undefined; if (p === Symbol.toPrimitive) return () => ""; if (p === Symbol.iterator) return function* () {}; return chain; },
  apply() { return chain; }, construct() { return chain; },
});
export class McpServer {
  constructor() {
    return new Proxy(this, { get(t, p, r) { if (p in t) return Reflect.get(t, p, r); if (p === "then") return undefined; return chain; } });
  }
  registerTool(name, config, handler) { registered.push({ server: this, name, handler }); return chain; }
}`;
const STUB_HONO_MCP = `export class StreamableHTTPTransport { handleRequest() { return new Response(null); } }`;
const STUB_PG = `
export const calls = (globalThis.__d5Calls ??= []);
function client() {
  return new Proxy({}, {
    get(_t, p) {
      if (p === "then") return undefined;
      if (p === "release") return () => {};
      return (...args) => { calls.push({ method: String(p), args }); return Promise.resolve({ rows: [], rowCount: 0, command: "SELECT" }); };
    },
  });
}
export class Pool { constructor() {} async connect() { return client(); } async end() {} }`;
const dataUrl = (mime: string, text: string) =>
  `data:${mime};base64,${btoa(String.fromCharCode(...new TextEncoder().encode(text)))}`;

Deno.test({
  name: "the triage tools, executed: each call runs SUGGESTION_LIST_SQL and no other statement",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const here = new URL("./", import.meta.url);
    let src = (await Deno.readTextFile(new URL("./index.ts", import.meta.url))).replace(/\r\n/g, "\n");
    const swaps: Array<[RegExp, string]> = [
      [/from "@modelcontextprotocol\/sdk\/server\/mcp\.js";/g, `from "${dataUrl("application/javascript", STUB_MCP)}";`],
      [/from "@hono\/mcp";/g, `from "${dataUrl("application/javascript", STUB_HONO_MCP)}";`],
      [/from "postgres";/g, `from "${dataUrl("application/javascript", STUB_PG)}";`],
      [/^Deno\.serve\(/gm, "(globalThis as any).__d5Serve("],
    ];
    for (const [rx, to] of swaps) {
      const n = (src.match(rx) ?? []).length;
      assertEquals(n, 1, `index.ts: expected one ${rx} to swap, found ${n}`);
      src = src.replace(rx, to);
    }
    // every relative import, to the real module beside index.ts (the same URL this test imports)
    src = src.replace(/from "\.\/([^"]+)"/g, (_m, rel) => `from "${new URL(rel, here).href}"`);
    (globalThis as any).__d5Serve = () => ({ finished: Promise.resolve(), shutdown: async () => {}, ref() {}, unref() {} });
    const env: Record<string, string> = { DB_HOST: "d5-binding.invalid", DB_PASSWORD: "x", MCP_ACCESS_KEY: "d5-binding-test-key-0123456789", PORT: "0" };
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
    for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
    try {
      await import(dataUrl("application/typescript", src));
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    }
    const registered = (globalThis as any).__d5Registered as Array<{ name: string; handler: (a: unknown) => Promise<any> }>;
    const calls = (globalThis as any).__d5Calls as Array<{ method: string; args: unknown[] }>;
    const thread = crypto.randomUUID();
    for (const [tool, status] of [["get_suggestions", "pending"], ["get_hidden_suggestions", "hidden"]]) {
      const regs = registered.filter((r) => r.name === tool);
      assert(regs.length >= 1, `${tool} is not registered by index.ts`);
      for (const r of regs) {
        for (const input of [{ thread_id: thread }, {}]) {
          calls.length = 0;
          const res = await r.handler(input);
          assert(!res?.isError, `${tool}(${JSON.stringify(input)}) answered an error: ${JSON.stringify(res)}`);
          const seen = calls.map((c) => ({ method: c.method, text: typeof c.args[0] === "string" ? c.args[0] : JSON.stringify(c.args[0]), params: c.args[1] }));
          assertEquals(seen.length, 2, `${tool}: exactly the pool's probe and ONE statement, saw ${JSON.stringify(seen)}`);
          assertEquals([seen[0].method, seen[0].text], ["queryArray", "SELECT 1"], `${tool}: the first call is ResilientPool's probe`);
          assertEquals(seen[1].method, "queryObject", `${tool}: the statement goes through queryObject`);
          assert(seen[1].text === SUGGESTION_LIST_SQL, `${tool}: the statement is not SUGGESTION_LIST_SQL: ${seen[1].text}`);
          assertEquals(seen[1].params, [status, (input as { thread_id?: string }).thread_id ?? null], `${tool}: the parameters`);
        }
      }
    }
  },
});

Deno.test({
  name: "the suggestion / hidden triage listing omits suppressed sources (D5 stage 1), run against a disposable database",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const pool = new Pool({
      hostname: HOST, port: Number(Deno.env.get("D5_TEST_DB_PORT") ?? 5432), database: "openbrain",
      user: Deno.env.get("D5_TEST_DB_USER") ?? "postgres", password: Deno.env.get("D5_TEST_DB_PASSWORD") ?? "",
    }, 1, true);
    const c = await pool.connect();
    const thread = crypto.randomUUID();
    const active = crypto.randomUUID();
    const suppressed = crypto.randomUUID();
    const run = thread.slice(0, 8);
    try {
      await c.queryObject(`INSERT INTO public.threads (id, name, slug) VALUES ($1, $2, $3)`,
        [thread, `d5 consumers test ${run}`, `d5-consumers-test-${run}`]);
      await c.queryObject(
        `INSERT INTO public.sources (id, url, title, content, retraction_committed_at, retracted_at) VALUES
           ($1, $3, 'd5 test active source', 'active', NULL, NULL),
           ($2, $4, 'd5 test suppressed source', 'suppressed', now(), now())`,
        [active, suppressed, `https://example.org/d5/${active}`, `https://example.org/d5/${suppressed}`],
      );
      for (const status of ["pending", "hidden"]) {
        await c.queryObject(`DELETE FROM public.thread_sources WHERE thread_id = $1`, [thread]);
        await c.queryObject(
          `INSERT INTO public.thread_sources (thread_id, source_id, link_type, status, suggestion_reason) VALUES
             ($1, $2, 'suggested', $4, 'd5 test'), ($1, $3, 'suggested', $4, 'd5 test')`,
          [thread, active, suppressed, status],
        );
        // the fixture: both rows exist with this status, so only the listing's filter can drop one
        const both = await c.queryObject<{ n: number }>(
          `SELECT count(*)::int AS n FROM public.thread_sources WHERE thread_id = $1 AND status = $2`, [thread, status]);
        assertEquals(both.rows[0].n, 2);
        const scoped = (await c.queryObject<{ source_id: string }>(SUGGESTION_LIST_SQL, [status, thread])).rows.map((r) => r.source_id);
        assertEquals(scoped, [active], `${status}, scoped to the thread: the listing returned ${JSON.stringify(scoped)}`);
        const global = (await c.queryObject<{ source_id: string }>(SUGGESTION_LIST_SQL, [status, null])).rows.map((r) => r.source_id);
        assert(global.includes(active), `${status}, global: the active source is listed`);
        assert(!global.includes(suppressed), `${status}, global: the listing returned the SUPPRESSED source ${suppressed}`);
      }
    } finally {
      await c.queryObject(`DELETE FROM public.thread_sources WHERE thread_id = $1`, [thread]);
      await c.queryObject(`DELETE FROM public.threads WHERE id = $1`, [thread]);
      await c.queryObject(`DELETE FROM public.sources WHERE id = ANY($1::uuid[])`, [[active, suppressed]]);
      c.release();
      await pool.end();
    }
  },
});
