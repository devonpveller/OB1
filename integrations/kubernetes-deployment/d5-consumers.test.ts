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

// The binding: registerSuggestionList runs SUGGESTION_LIST_SQL and no other query text, so the
// query tested below IS the query the tools run.
Deno.test("the triage listing runs SUGGESTION_LIST_SQL, and only it", async () => {
  const src = (await Deno.readTextFile(new URL("./index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const start = src.indexOf("function registerSuggestionList(");
  assert(start >= 0, "registerSuggestionList not found in index.ts");
  // the function ends at the first column-0 closing brace after its start
  const end = src.indexOf("\n}\n", start);
  assert(end > start, "the end of registerSuggestionList not found");
  const body = src.slice(start, end);
  assertEquals((body.match(/queryObject\b/g) ?? []).length, 1, "registerSuggestionList runs one query");
  assert(/queryObject<SuggestionView>\(SUGGESTION_LIST_SQL,/.test(body), "registerSuggestionList does not run SUGGESTION_LIST_SQL");
  assert(!/`[^`]*\bSELECT\b/i.test(body), "registerSuggestionList carries inline SQL besides SUGGESTION_LIST_SQL");
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
