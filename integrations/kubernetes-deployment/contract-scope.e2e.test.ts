// contract-scope.e2e.test.ts - the cloud door's forced filter, end to end through the adapter
// (research-workbench P0 continuation rw-p0-contract2, after the reviewer reject of
// rw-p0-contract: dependence and tombstone carried no metadata_filter, so a cloud caller read
// them unscoped).
//
// SKIPPED unless CONTRACT_SCOPE_E2E_URL is set. OB1/docker/workbench/contract-test/
// run-contract-tests.ps1 runs it inside the :wt workbench image against a RUNNING :wt workbench
// on a DISPOSABLE database on its own internal network. Never point it at a live workbench:
// it seeds rows and erases sources.
//
// The tools are this directory's adapter (registerContractTools) - the code openbrain-mcp runs -
// called with the argument the cloud gateway forces ({"share":"cloud"}), and their requests go
// over HTTP to the real workbench routes. Every seeded row carries a run-unique marker; rows
// outside the cloud scope carry LOCAL_MARK, and no scoped answer may contain it.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { registerContractTools } from "./contract-tools.ts";

const BASE = Deno.env.get("CONTRACT_SCOPE_E2E_URL");
const ignore = !BASE;
const KEY = Deno.env.get("CONTRACT_SCOPE_E2E_KEY") ?? "";
const CLOUD = { share: "cloud" };

// One pool per test (each test ends its own in its finally).
let pool: Pool | null = null;
function db(): Pool {
  pool ??= new Pool({
    hostname: Deno.env.get("CONTRACT_SCOPE_E2E_DB_HOST"), port: 5432, database: "openbrain",
    user: "postgres", password: Deno.env.get("CONTRACT_SCOPE_E2E_DB_PASSWORD") ?? "",
  }, 2, true);
  return pool;
}
async function endPool() {
  if (pool) await pool.end();
  pool = null;
}
// deno-lint-ignore no-explicit-any
async function sql(text: string, args: unknown[] = []): Promise<Record<string, any>[]> {
  const c = await db().connect();
  try {
    return (await c.queryObject(text, args)).rows as Record<string, any>[];
  } finally {
    c.release();
  }
}

// The adapter's handlers, captured by name (the same registration openbrain-mcp's index.ts makes).
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const tools = new Map<string, Handler>();
if (BASE) {
  registerContractTools({ registerTool: ((n: string, _c: unknown, h: Handler) => tools.set(n, h)) as never }, {
    workbenchUrl: BASE, key: KEY,
  });
}
async function tool(name: string, args: Record<string, unknown>) {
  const r = await tools.get(name)!(args);
  const text = r.content[0].text;
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  return { isError: !!r.isError, text, json };
}

const run = crypto.randomUUID().slice(0, 8);
const LOCAL_MARK = `LOCAL-ONLY-${run}`;
const id = () => crypto.randomUUID();
const X = {
  srcCloud: id(), srcLocal: id(),
  claimCloud: id(), claimLocal: id(),
  leadCloud: id(), leadLocal: id(),
  synCloud: id(), synLocal: id(),
  eraseCloud: id(), eraseLocal: id(),
  page: `content/scope-e2e/${run}`, doc: id(), session: id(),
};
const tombstones: { cloud?: string; local?: string } = {};

async function seed() {
  const src = (sid: string, title: string, meta: Record<string, unknown>, extra = "") =>
    sql(
      `INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata${extra ? ", retracted_at, retraction_committed_at, retracted_by, unlinked_at" : ""})
       VALUES ($1, $2, $3, $4, 'web_article', 'scope.example', $5::jsonb${extra})`,
      [sid, `https://scope.example/${run}/${sid}`, title, `${title} body`, JSON.stringify(meta)],
    );
  await src(X.srcCloud, `cloud source ${run}`, CLOUD);
  await src(X.srcLocal, `${LOCAL_MARK} local source`, {});
  for (const s of [X.srcCloud, X.srcLocal]) {
    await sql(`INSERT INTO public.source_chunks (source_id, idx, content) VALUES ($1, 0, 'chunk')`, [s]);
  }
  // claims: one inside the cloud scope, one outside; both grounded by both sources
  await sql(`INSERT INTO public.claims (id, text, metadata) VALUES ($1, $2, '{"share":"cloud"}'), ($3, $4, '{}')`,
    [X.claimCloud, `cloud claim ${run}`, X.claimLocal, `${LOCAL_MARK} local claim`]);
  for (const s of [X.srcCloud, X.srcLocal]) {
    await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $3, 'states'), ($2, $3, 'states')`,
      [X.claimCloud, X.claimLocal, s]);
  }
  // found_via leads and syntheses citing the cloud source, one of each in and out of scope
  await src(X.leadCloud, `cloud lead ${run}`, { ...CLOUD, found_via: X.srcCloud });
  await src(X.leadLocal, `${LOCAL_MARK} local lead`, { found_via: X.srcCloud });
  await sql(
    `INSERT INTO public.sources (id, title, content, content_type, metadata) VALUES
       ($1, $2, 's', 'research_synthesis', $3::jsonb), ($4, $5, 's', 'research_synthesis', $6::jsonb)`,
    [X.synCloud, `cloud synthesis ${run}`, JSON.stringify({ ...CLOUD, source_ids: [X.srcCloud] }),
      X.synLocal, `${LOCAL_MARK} local synthesis`, JSON.stringify({ source_ids: [X.srcCloud] })],
  );
  // record kinds that carry no metadata: a citing page, a user document, a research session
  await sql(`INSERT INTO public.wiki_pages (slug, page_class, title, body, links) VALUES ($1, 'entity', $2, 'b', $3::jsonb)`,
    [X.page, `${LOCAL_MARK} page`, JSON.stringify([`content/source/${X.srcCloud}`])]);
  await sql(`INSERT INTO public.user_document_listings (id, path, title, outbound_links) VALUES ($1, $2, $3, $4::jsonb)`,
    [X.doc, `documents/${LOCAL_MARK}.md`, `${LOCAL_MARK} document`, JSON.stringify([{ kind: "source", id: X.srcCloud, pin: null }])]);
  await sql(`INSERT INTO public.sessions (id, origin_tool, query_text) VALUES ($1, 'owui', $2)`, [X.session, `${LOCAL_MARK} q`]);
  await sql(`INSERT INTO public.session_sources (session_id, source_id) VALUES ($1, $2)`, [X.session, X.srcCloud]);
  // two unlinked sources with no dependence, erased through the workbench's own erase route
  await src(X.eraseCloud, `cloud erased ${run}`, CLOUD, ", now(), now(), 'scope-e2e', now()");
  await src(X.eraseLocal, `${LOCAL_MARK} local erased`, {}, ", now(), now(), 'scope-e2e', now()");
  for (const [k, sid] of [["cloud", X.eraseCloud], ["local", X.eraseLocal]] as const) {
    const r = await fetch(`${BASE}/workbench/contract/sources/${sid}/erase`, {
      method: "POST", headers: { "content-type": "application/json", "x-brain-key": KEY },
      body: JSON.stringify({ reason_type: "deliberate", note: `${LOCAL_MARK} note`, eraser: { kind: "user", user: `${LOCAL_MARK}-eraser` } }),
    });
    const body = await r.json();
    assertEquals(r.status, 200, `seed erase ${k}: ${JSON.stringify(body)}`);
    tombstones[k] = body.tombstone.id;
  }
}

async function cleanup() {
  const all = Object.values(X).filter((v) => !v.startsWith("content/"));
  await sql(`DELETE FROM public.session_sources WHERE session_id = $1`, [X.session]);
  await sql(`DELETE FROM public.sessions WHERE id = $1`, [X.session]);
  await sql(`DELETE FROM public.user_document_listings WHERE id = $1`, [X.doc]);
  await sql(`DELETE FROM public.wiki_pages WHERE slug = $1`, [X.page]);
  await sql(`DELETE FROM public.claim_sources WHERE claim_id = ANY($1::uuid[])`, [[X.claimCloud, X.claimLocal]]);
  await sql(`DELETE FROM public.claims WHERE id = ANY($1::uuid[])`, [[X.claimCloud, X.claimLocal]]);
  await sql(`DELETE FROM public.source_trail_events WHERE source_id = ANY($1::uuid[])`, [all]);
  await sql(`DELETE FROM public.source_tombstones WHERE source_id = ANY($1::uuid[])`, [all]);
  await sql(`DELETE FROM public.sources WHERE id = ANY($1::uuid[])`, [all]);
}

Deno.test({
  name: "contract_dependence and contract_tombstone, through the adapter with the forced cloud filter, " +
    "return nothing outside share=cloud and the scoped rows inside it",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    await seed();
    try {
      await t.step("dependence of a source outside share=cloud: nothing", async () => {
        const r = await tool("contract_dependence", { id: X.srcLocal, metadata_filter: CLOUD });
        assert(r.isError, `expected a not-found answer, got ${r.text}`);
        assertEquals(r.json.connections, undefined, r.text);
        assert(!r.text.includes(LOCAL_MARK), `scoped answer leaked out-of-scope text: ${r.text}`);
      });

      await t.step("dependence of a source inside share=cloud: only in-scope connections", async () => {
        const r = await tool("contract_dependence", { id: X.srcCloud, metadata_filter: CLOUD });
        assert(!r.isError, r.text);
        assert(!r.text.includes(LOCAL_MARK), `scoped answer leaked out-of-scope text: ${r.text}`);
        const refs = (k: string) => (r.json.connections as { kind: string; ref: string }[]).filter((c) => c.kind === k).map((c) => c.ref).sort();
        assertEquals(r.json.source_id, X.srcCloud);
        assertEquals(refs("chunk"), ["0"]);
        assertEquals(refs("report_citation"), [X.synCloud]);
        assertEquals(refs("found_via_lead"), [X.leadCloud]);
        const claims = (r.json.connections as { kind: string; detail: { claim_id: string } }[])
          .filter((c) => c.kind === "claim_edge").map((c) => c.detail.claim_id);
        assertEquals(claims, [X.claimCloud]);
        for (const k of ["citing_page", "document_link", "report_session", "entity_grounding"]) assertEquals(refs(k), [], k);
        assertEquals(r.json.erase_allowed, false, "a scoped view cannot prove zero dependence");
      });

      await t.step("the same dependence with no filter (the local door) still lists everything", async () => {
        const r = await tool("contract_dependence", { id: X.srcCloud });
        assert(!r.isError, r.text);
        const kinds = new Set((r.json.connections as { kind: string }[]).map((c) => c.kind));
        for (const k of ["claim_edge", "chunk", "citing_page", "report_session", "report_citation", "found_via_lead", "document_link"]) {
          assert(kinds.has(k), `unfiltered dependence lost ${k}`);
        }
        assert(r.text.includes(LOCAL_MARK), "the unfiltered answer should include the local rows");
      });

      await t.step("tombstone of a source erased outside share=cloud: nothing", async () => {
        const r = await tool("contract_tombstone", { id: tombstones.local!, metadata_filter: CLOUD });
        assert(r.isError, `expected a not-found answer, got ${r.text}`);
        assert(!r.text.includes(LOCAL_MARK) && !r.text.includes(X.eraseLocal), `leaked: ${r.text}`);
        assertEquals(r.json.url, undefined, r.text);
      });

      await t.step("tombstone of a source erased inside share=cloud: the tombstone", async () => {
        const r = await tool("contract_tombstone", { id: tombstones.cloud!, metadata_filter: CLOUD });
        assert(!r.isError, r.text);
        assertEquals(r.json.id, tombstones.cloud);
        assertEquals(r.json.source_id, X.eraseCloud);
        assertEquals(r.json.url, `https://scope.example/${run}/${X.eraseCloud}`);
        assertEquals(r.json.reason_type, "deliberate");
      });

      await t.step("the out-of-scope tombstone exists for the local door (no filter)", async () => {
        const r = await tool("contract_tombstone", { id: tombstones.local! });
        assert(!r.isError, r.text);
        assertEquals(r.json.source_id, X.eraseLocal);
      });
    } finally {
      await cleanup();
      await endPool();
    }
  },
});

// ── every cloud tool, every argument shape the real gateway forwards (rw-p0-contract2 attempt 2) ──
//
// Tester t-rw-p0 (attempt 1, Case 23) found contract_claims returning an OUT-OF-SCOPE source's id,
// title and URL inside an in-scope claim's sources[], and source_id=<out-of-scope id> selecting the
// in-scope claims it grounds: the top-level rows were filtered, a nested array was not. This test
// is that probe made permanent. contract-scope-calls.py runs the REAL gateway policy
// (openbrain-gateway/app.py _apply_policy) over every cloud tool x its argument sets x eight
// metadata_filter shapes and writes what the gateway forwards (CONTRACT_SCOPE_E2E_CALLS); each
// forwarded call runs here through the adapter against the workbench, and NO answer may contain a
// forbidden string: every out-of-scope source / claim / held source / tombstone / attempt /
// session / job / idea / document / page / thread id, title, URL, path, slug, note or query in the
// database (fixtures included), minus the strings the call itself passed. The same calls with no
// filter are the control: the detector must see the rows there, tool by tool.
const CALLS_PATH = Deno.env.get("CONTRACT_SCOPE_E2E_CALLS") ?? "";
const FX_IDEA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const FX_JOB = "99999999-9999-4999-8999-999999999999";
const FX_SOURCE = "11111111-1111-4111-8111-111111111111";
// database error text must never reach a caller (N3)
const DB_TEXT = /invalid input syntax|syntax error at|violates|SQLSTATE|relation "|column "|operator does not exist/i;

Deno.test({
  name: "every cloud-door contract tool, with every filter shape the real gateway forwards, " +
    "returns no out-of-scope row in any field, nested array or aggregate",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    assert(CALLS_PATH, "CONTRACT_SCOPE_E2E_CALLS is not set: the gateway-policed calls are this test's input");
    const calls = JSON.parse(await Deno.readTextFile(CALLS_PATH)) as
      { tool: string; variant: string; forwarded: Record<string, unknown> }[];
    const manifest = JSON.parse(await Deno.readTextFile(new URL("./contract-tools.json", import.meta.url))) as
      { tool: string; input: { properties: Record<string, unknown> } }[];
    const cloudTools = manifest.filter((m) => "metadata_filter" in m.input.properties).map((m) => m.tool).sort();
    assertEquals(cloudTools.length, 15, `cloud tools: ${cloudTools}`);
    assertEquals([...new Set(calls.map((c) => c.tool))].sort(), cloudTools, "the calls must cover every cloud tool");
    for (const v of ["absent", "empty", "override_local", "override_null", "extra_key", "string_empty", "string_override"]) {
      assert(calls.some((c) => c.variant === v), `no forwarded call with filter shape ${v}`);
    }
    for (const c of calls) {
      assertEquals((c.forwarded.metadata_filter as Record<string, unknown>)?.share, "cloud", JSON.stringify(c));
    }

    const r8 = crypto.randomUUID().slice(0, 8);
    const LOCAL = `LOCAL-ONLY-${r8}`;
    const X: Record<string, string> = {
      srcCloud: id(), srcLocal: id(), srcSupCloud: id(), claimCloud: id(), claimCloud2: id(), claimLocal: id(),
      leadCloud: id(), leadLocal: id(), synCloud: id(), synLocal: id(), eraseCloud: id(), eraseLocal: id(),
      heldCloud: id(), doc: id(), session: id(), thread: id(), page: `content/scope-all/${r8}`,
      fxIdea: FX_IDEA, fxJob: FX_JOB, fx1: FX_SOURCE, LOCAL, run: r8,
    };
    const CLOUD_SOURCES = new Set([X.srcCloud, X.srcSupCloud, X.leadCloud, X.synCloud]);
    const src = (sid: string, title: string, meta: Record<string, unknown>, extra = "") =>
      sql(
        `INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata${extra ? ", retracted_at, retraction_committed_at, retracted_by, unlinked_at" : ""})
         VALUES ($1, $2, $3, $4, 'web_article', 'scope.example', $5::jsonb${extra})`,
        [sid, `https://scope.example/${title.startsWith(LOCAL) ? LOCAL + "/" : ""}${sid}`, title, `${title} body`, JSON.stringify(meta)],
      );
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${BASE}/workbench/contract${path}`, {
        method: "POST", headers: { "content-type": "application/json", "x-brain-key": KEY }, body: JSON.stringify(body),
      });
      const j = await r.json();
      assertEquals(r.status, 200, `seed POST ${path}: ${JSON.stringify(j)}`);
      return j;
    };
    const tomb: Record<string, string> = {};

    async function seed() {
      await src(X.srcCloud, `cloud source ${r8}`, CLOUD);
      await src(X.srcLocal, `${LOCAL} local source`, {});
      await src(X.srcSupCloud, `cloud suppressed ${r8}`, CLOUD);
      for (const s of [X.srcCloud, X.srcLocal]) {
        await sql(`INSERT INTO public.source_chunks (source_id, idx, content) VALUES ($1, 0, $2)`,
          [s, s === X.srcLocal ? `${LOCAL} chunk` : "cloud chunk"]);
      }
      await sql(`INSERT INTO public.threads (id, name) VALUES ($1, $2)`, [X.thread, `${LOCAL} thread`]);
      await src(X.leadCloud, `cloud lead ${r8}`, { ...CLOUD, found_via: X.srcCloud });
      await src(X.leadLocal, `${LOCAL} local lead`, { found_via: X.srcCloud });
      await sql(
        `INSERT INTO public.sources (id, title, content, content_type, metadata) VALUES
           ($1, $2, 's', 'research_synthesis', $3::jsonb), ($4, $5, 's', 'research_synthesis', $6::jsonb)`,
        [X.synCloud, `cloud synthesis ${r8}`, JSON.stringify({ ...CLOUD, source_ids: [X.srcCloud, X.srcLocal] }),
          X.synLocal, `${LOCAL} local synthesis`, JSON.stringify({ source_ids: [X.srcCloud] })],
      );
      // claims: claimCloud is grounded by BOTH sources (the shape that leaked), sits in a thread and
      // belongs to the in-scope synthesis; claimCloud2 is grounded ONLY out of scope and belongs to
      // the out-of-scope synthesis; claimLocal is out of scope and grounded by both.
      await sql(
        `INSERT INTO public.claims (id, text, metadata, thread_id, synthesis_id) VALUES
           ($1, $2, '{"share":"cloud"}', $3, $4), ($5, $6, '{"share":"cloud"}', NULL, $7), ($8, $9, '{}', NULL, NULL)`,
        [X.claimCloud, `cloud claim ${r8}`, X.thread, X.synCloud, X.claimCloud2, `cloud claim two ${r8}`, X.synLocal,
          X.claimLocal, `${LOCAL} local claim`],
      );
      await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES
                   ($1, $3, 'states'), ($1, $4, 'states'), ($2, $4, 'states'), ($5, $3, 'states'), ($5, $4, 'states')`,
        [X.claimCloud, X.claimCloud2, X.srcCloud, X.srcLocal, X.claimLocal]);
      // fixed confidences AFTER the edges (the claim_sources trigger re-scores on insert), so the
      // quality means are known: in scope 0.9, unscoped (0.9 + 0.1) / 2
      await sql(`UPDATE public.claims SET confidence = CASE id WHEN $1 THEN 0.9 WHEN $2 THEN 0.5 ELSE 0.1 END
                  WHERE id = ANY($3::uuid[])`, [X.claimCloud, X.claimCloud2, [X.claimCloud, X.claimCloud2, X.claimLocal]]);
      // record kinds that carry no metadata
      await sql(`INSERT INTO public.wiki_pages (slug, page_class, title, body, links) VALUES ($1, 'entity', $2, $3, $4::jsonb)`,
        [X.page, `${LOCAL} page`, `${LOCAL} page body contract retrieval`,
          JSON.stringify([`content/source/${X.srcCloud}`, `content/source/${X.srcSupCloud}`])]);
      await sql(`INSERT INTO public.user_document_listings (id, path, title, outbound_links) VALUES ($1, $2, $3, $4::jsonb)`,
        [X.doc, `documents/${LOCAL}.md`, `${LOCAL} document`, JSON.stringify([{ kind: "source", id: X.srcCloud, pin: null }])]);
      await sql(`INSERT INTO public.sessions (id, origin_tool, query_text) VALUES ($1, 'owui', $2)`, [X.session, `${LOCAL} q`]);
      await sql(`INSERT INTO public.session_sources (session_id, source_id) VALUES ($1, $2)`, [X.session, X.srcCloud]);
      await sql(`INSERT INTO public.thread_sources (thread_id, source_id, status) VALUES ($1, $2, 'confirmed')`, [X.thread, X.srcSupCloud]);
      // a held source whose metadata even claims share=cloud: it belongs to a refinery (no metadata),
      // so under a filter it is out of scope
      await sql(`INSERT INTO public.held_sources (id, refinery_id, url, title, content, content_type, metadata)
                 VALUES ($1, $2, $3, $4, $5, 'manual', '{"share":"cloud","user_provided":true}')`,
        [X.heldCloud, FX_IDEA, `https://scope.example/${LOCAL}/held`, `${LOCAL} held`, `${LOCAL} held text`]);
      await sql(`INSERT INTO public.held_source_chunks (held_source_id, idx, content) VALUES ($1, 0, $2)`, [X.heldCloud, `${LOCAL} held chunk`]);
      await sql(`INSERT INTO public.refinery_user_sources (refinery_id, source_id, status) VALUES ($1, $2, 'held')`, [FX_IDEA, X.heldCloud]);
      // an in-scope source suppressed through the route: its suppression_context counts a citing page
      // and a notebook (both metadata-less)
      await post(`/sources/${X.srcSupCloud}/suppress`, { reason: `cloud reason ${r8}`, by: `cloud-op-${r8}` });
      // two erased sources; the in-scope one names a batch run (a job id), carries a reopen attempt from
      // a session and was readmitted as a source outside the scope
      await src(X.eraseCloud, `cloud erased ${r8}`, CLOUD, ", now(), now(), 'scope-all', now()");
      await src(X.eraseLocal, `${LOCAL} local erased`, {}, ", now(), now(), 'scope-all', now()");
      tomb.cloud = (await post(`/sources/${X.eraseCloud}/erase`, {
        reason_type: "deliberate", note: `cloud note ${r8}`, batch_run_id: FX_JOB, eraser: { kind: "user", user: `cloud-user-${r8}` },
      })).tombstone.id;
      tomb.local = (await post(`/sources/${X.eraseLocal}/erase`, {
        reason_type: "deliberate", note: `${LOCAL} note`, eraser: { kind: "user", user: `${LOCAL}-eraser` },
      })).tombstone.id;
      X.tombCloud = tomb.cloud;
      X.tombLocal = tomb.local;
      for (const tb of [tomb.cloud, tomb.local]) {
        await sql(`INSERT INTO public.source_tombstone_attempts (tombstone_id, path, outcome, session_id, note)
                   VALUES ($1, 'intake', 'refused', $2, $3)`, [tb, X.session, `${LOCAL} attempt ${tb}`]);
      }
      // its removal score (normally the suppression snapshot's mean over every claim it grounded)
      await sql(`UPDATE public.source_tombstones SET readmitted_source_id = $2, confidence = 0.42 WHERE id = $1`, [tomb.cloud, X.srcLocal]);
    }

    async function cleanup() {
      const ids = [X.srcCloud, X.srcLocal, X.srcSupCloud, X.leadCloud, X.leadLocal, X.synCloud, X.synLocal, X.eraseCloud, X.eraseLocal];
      await sql(`DELETE FROM public.refinery_user_sources WHERE source_id = $1`, [X.heldCloud]);
      await sql(`DELETE FROM public.held_source_chunks WHERE held_source_id = $1`, [X.heldCloud]);
      await sql(`DELETE FROM public.held_sources WHERE id = $1`, [X.heldCloud]);
      await sql(`DELETE FROM public.session_sources WHERE session_id = $1`, [X.session]);
      await sql(`DELETE FROM public.sessions WHERE id = $1`, [X.session]);
      await sql(`DELETE FROM public.user_document_listings WHERE id = $1`, [X.doc]);
      await sql(`DELETE FROM public.wiki_pages WHERE slug = $1`, [X.page]);
      await sql(`DELETE FROM public.claim_sources WHERE claim_id = ANY($1::uuid[])`, [[X.claimCloud, X.claimCloud2, X.claimLocal]]);
      await sql(`DELETE FROM public.claims WHERE id = ANY($1::uuid[])`, [[X.claimCloud, X.claimCloud2, X.claimLocal]]);
      await sql(`DELETE FROM public.source_trail_events WHERE source_id = ANY($1::uuid[])`, [ids]);
      await sql(`DELETE FROM public.source_tombstones WHERE source_id = ANY($1::uuid[])`, [ids]);
      await sql(`DELETE FROM public.sources WHERE id = ANY($1::uuid[])`, [ids]);
      await sql(`DELETE FROM public.threads WHERE id = $1`, [X.thread]);
    }

    await seed();
    try {
      // What a scoped answer may never contain.
      const forb = new Map<string, string>();
      const addF = (v: unknown, why: string) => {
        if (typeof v === "string" && v.length >= 8) forb.set(v, why);
      };
      addF(LOCAL, "marker");
      const NOTC = `NOT metadata @> '{"share":"cloud"}'::jsonb`;
      for (const r of await sql(`SELECT id::text, title, url FROM public.sources WHERE ${NOTC}`)) {
        addF(r.id, "source id"); addF(r.title, "source title"); addF(r.url, "source url");
      }
      for (const r of await sql(`SELECT id::text, text FROM public.claims WHERE ${NOTC}`)) {
        addF(r.id, "claim id"); addF((r.text as string)?.slice(0, 40), "claim text");
      }
      for (const r of await sql(`SELECT id::text, title, url FROM public.held_sources`)) {
        addF(r.id, "held id"); addF(r.title, "held title"); addF(r.url, "held url");
      }
      for (const r of await sql(`SELECT id::text, url, title, note, source_id::text AS sid FROM public.source_tombstones WHERE ${NOTC}`)) {
        addF(r.id, "tombstone id"); addF(r.url, "tombstone url"); addF(r.title, "tombstone title"); addF(r.note, "tombstone note");
        addF(r.sid, "erased source id");
      }
      for (const r of await sql(`SELECT session_id, note FROM public.source_tombstone_attempts`)) {
        addF(r.session_id, "attempt session"); addF(r.note, "attempt note");
      }
      for (const r of await sql(`SELECT id::text, query_text FROM public.sessions`)) { addF(r.id, "session id"); addF(r.query_text, "session query"); }
      for (const r of await sql(`SELECT id::text, name FROM public.threads`)) { addF(r.id, "thread id"); addF(r.name, "thread name"); }
      for (const r of await sql(`SELECT id::text, query FROM public.research_jobs`)) { addF(r.id, "job id"); addF(r.query, "job query"); }
      for (const r of await sql(`SELECT id::text, title FROM public.ideas`)) { addF(r.id, "idea id"); addF(r.title, "idea title"); }
      for (const r of await sql(`SELECT id::text, path, title FROM public.user_document_listings`)) {
        addF(r.id, "document id"); addF(r.path, "document path"); addF(r.title, "document title");
      }
      for (const r of await sql(`SELECT slug, title FROM public.wiki_pages`)) { addF(r.slug, "page slug"); addF(r.title, "page title"); }
      for (const k of ["srcCloud", "srcSupCloud", "claimCloud", "claimCloud2", "leadCloud", "synCloud", "eraseCloud", "tombCloud"]) {
        assert(!forb.has(X[k]), `${k} is in scope but in the forbidden set`);
      }
      console.log(`forbidden strings: ${forb.size}`);

      const resolve = (v: unknown): unknown =>
        typeof v === "string" ? v.replace(/\$([A-Za-z0-9]+)/g, (_m, k) => X[k] ?? `$${k}`) : v;
      const answers = new Map<string, { json: Record<string, any>; text: string }>();
      const leaks: string[] = [];
      const controlByTool = new Map<string, number>();
      for (const c of calls) {
        const args = Object.fromEntries(Object.entries(c.forwarded).map(([k, v]) => [k, resolve(v)]));
        const own = new Set(Object.values(args).filter((v) => typeof v === "string")
          .flatMap((v) => (v as string).split(/[:,]/).concat([v as string])));
        const r = await tool(c.tool, args);
        const hits = [...forb.entries()].filter(([s]) => !own.has(s) && r.text.includes(s)).map(([s, why]) => `${why}=${s}`);
        if (DB_TEXT.test(r.text)) hits.push(`database text: ${r.text.slice(0, 200)}`);
        if (hits.length) {
          leaks.push(`LEAK ${c.tool} variant=${c.variant} args=${JSON.stringify(c.forwarded)} -> ${[...new Set(hits)].slice(0, 4).join(" | ")}` +
            `\n     response: ${r.text.slice(0, 600)}`);
        }
        const key = `${c.tool} ${JSON.stringify(Object.fromEntries(Object.entries(c.forwarded).filter(([k]) => k !== "metadata_filter")))}`;
        if (c.variant === "absent") {
          answers.set(key, r);
          const u = { ...args };
          delete u.metadata_filter;
          const ctl = await tool(c.tool, u);
          answers.set(`${key} UNFILTERED`, ctl);
          const n = [...forb.keys()].filter((s) => !own.has(s) && ctl.text.includes(s)).length;
          controlByTool.set(c.tool, (controlByTool.get(c.tool) ?? 0) + (n > 0 ? 1 : 0));
        }
      }
      const get = (toolName: string, a: Record<string, string>, unfiltered = false) => {
        const k = `${toolName} ${JSON.stringify(a)}${unfiltered ? " UNFILTERED" : ""}`;
        const v = answers.get(k);
        assert(v, `no recorded answer for ${k}`);
        return v!;
      };
      const leakingTools = [...new Set(leaks.map((l) => l.split(" ")[1]))].sort();
      console.log(`SUMMARY calls=${calls.length} leaking_calls=${leaks.length} leaking_tools=${JSON.stringify(leakingTools)} ` +
        `forbidden=${forb.size} control_hits_by_tool=${JSON.stringify(Object.fromEntries(controlByTool))}`);

      await t.step("no forwarded call answers an out-of-scope string or database text", () => {
        assertEquals(leaks.length, 0, `leaking tools ${JSON.stringify(leakingTools)}\n${leaks.slice(0, 12).join("\n")}\n(${leaks.length} leaking calls)`);
      });

      await t.step("the control: unfiltered, the detector sees out-of-scope rows through every tool but quality", () => {
        for (const tn of cloudTools.filter((x) => x !== "contract_quality")) {
          assert((controlByTool.get(tn) ?? 0) > 0, `${tn}: no unfiltered call hit a forbidden string, so the detector proves nothing`);
        }
      });

      await t.step("claims: nested sources, synthesis and thread ids are scoped; an out-of-scope id selects nothing", () => {
        const all = get("contract_claims", {}).json;
        const ids = (all.claims as { id: string }[]).map((c) => c.id).sort();
        assertEquals(ids, [X.claimCloud, X.claimCloud2].sort());
        for (const c of all.claims as any[]) {
          for (const s of c.sources) assert(CLOUD_SOURCES.has(s.source_id), `claim ${c.id} lists ${s.source_id}`);
          assert(c.synthesis_id === null || c.synthesis_id === X.synCloud, `synthesis_id ${c.synthesis_id}`);
          assertEquals(c.thread_id, null);
        }
        const one = (all.claims as any[]).find((c) => c.id === X.claimCloud);
        assertEquals(one.sources.map((s: any) => s.source_id), [X.srcCloud]);
        assertEquals(one.edges_by_type, { states: 1 });
        const two = (all.claims as any[]).find((c) => c.id === X.claimCloud2);
        assertEquals(two.sources, []);
        assertEquals(two.grounded, false, "grounded is computed from in-scope edges only");
        assertEquals(get("contract_claims", { source_id: "$srcLocal" }).json.count, 0, "out-of-scope source_id is an oracle");
        assertEquals(get("contract_claims", { source_id: "$eraseLocal" }).json.count, 0);
        assertEquals(get("contract_claims", { synthesis_id: "$synLocal" }).json.count, 0, "out-of-scope synthesis_id is an oracle");
        assertEquals(get("contract_claims", { thread_id: "$thread" }).json.count, 0, "a thread carries no metadata");
        assertEquals((get("contract_claims", { source_id: "$srcCloud" }).json.claims as any[]).map((c) => c.id), [X.claimCloud]);
        assertEquals((get("contract_claims", { evidence_only: "true" }).json.claims as any[]).map((c) => c.id), [X.claimCloud]);
        // the control sees the out-of-scope grounding
        const u = get("contract_claims", {}, true).json;
        const uOne = (u.claims as any[]).find((c) => c.id === X.claimCloud);
        assertEquals(uOne.sources.map((s: any) => s.source_id).sort(), [X.srcCloud, X.srcLocal].sort());
        assertEquals(uOne.thread_id, X.thread);
      });

      await t.step("quality aggregates only in-scope claims (N2)", () => {
        const f = get("contract_quality", { id: "$srcCloud" }).json;
        const u = get("contract_quality", { id: "$srcCloud" }, true).json;
        const factor = (q: any, n: string) => q.factors.find((x: any) => x.name === n).value;
        assertEquals(factor(f, "grounded_claims"), 1, JSON.stringify(f));
        assertEquals(factor(u, "grounded_claims"), 2, JSON.stringify(u));
        assert(Math.abs(f.score.value - 0.9) < 1e-6, `scoped mean ${f.score.value}`);
        assert(Math.abs(u.score.value - 0.5) < 1e-6, `unscoped mean ${u.score.value}`);
      });

      await t.step("reference of an in-scope suppressed source carries no metadata-less counts (N4)", () => {
        const f = get("contract_reference", { id: "$srcSupCloud" }).json;
        assertEquals(f.state, "suppressed", JSON.stringify(f));
        const ctx = f.state_detail.context as Record<string, unknown>;
        for (const k of ["notebooks", "citing_pages", "score_at_removal"]) assertEquals(ctx[k], undefined, `context.${k}`);
        assertEquals(ctx.title, `cloud suppressed ${r8}`);
        const u = get("contract_reference", { id: "$srcSupCloud" }, true).json;
        assertEquals(u.state_detail.context.notebooks, 1, JSON.stringify(u.state_detail));
        assertEquals(u.state_detail.context.citing_pages, 1);
      });

      await t.step("tombstone of an in-scope erased source: attempts, run ids, readmission and removal score redacted (N4)", () => {
        const f = get("contract_tombstone", { id: "$tombCloud" }).json;
        assertEquals(f.id, tomb.cloud, JSON.stringify(f));
        assertEquals(f.attempts.length, 1);
        assertEquals(f.attempts[0].session_id, null);
        assertEquals(f.attempts[0].note, null);
        assertEquals(f.attempts[0].path, "intake");
        assertEquals(f.batch_run_id, null);
        assertEquals(f.readmitted_source_id, null);
        assertEquals(f.confidence, null);
        const u = get("contract_tombstone", { id: "$tombCloud" }, true).json;
        assert(Math.abs(u.confidence - 0.42) < 1e-6, `unscoped confidence ${u.confidence}`);
        assertEquals(u.attempts[0].session_id, X.session);
        assertEquals(u.batch_run_id, FX_JOB);
        assertEquals(u.readmitted_source_id, X.srcLocal);
      });

      await t.step("held sources and metadata-less kinds are out of scope; in-scope rows still answer", () => {
        for (const [tn, a] of [["contract_reference", { id: "$heldCloud" }], ["contract_quality", { id: "$heldCloud" }],
          ["contract_dependence", { id: "$heldCloud" }], ["contract_chunk_context", { chunkId: "$heldCloud:0" }]] as const) {
          assert(get(tn, a).json.error, `${tn} ${JSON.stringify(a)}: ${get(tn, a).text.slice(0, 200)}`);
        }
        assertEquals(get("contract_reference", { id: "$srcCloud" }).json.state, "active");
        assertEquals(get("contract_chunk_context", { chunkId: "$srcCloud:0", window: "5" }).json.chunks.length, 1);
        assertEquals(get("contract_documents", {}).json.documents.length, 0);
        assertEquals(get("contract_ideas", {}).json.ideas.length, 0);
        assertEquals(get("contract_jobs", {}).json.jobs.length, 0);
        assertEquals(get("contract_timeline", {}).json.events.length, 0);
        assertEquals(get("contract_trail", {}).json.entries.length, 0);
        assertEquals(get("contract_neighbours", { id: "$page" }).json.nodes.length, 0);
        const hits = get("contract_search", { q: "$run" }).json.results as { id: string }[];
        assert(hits.length > 0 && hits.every((h) => CLOUD_SOURCES.has(h.id) || [X.claimCloud, X.claimCloud2].includes(h.id)),
          JSON.stringify(hits));
      });

      await t.step("a malformed path id is a 400 with no database text (N3)", async () => {
        for (const tn of ["contract_reference", "contract_dependence", "contract_quality", "contract_tombstone"]) {
          for (const bad of ["../registries", "not-a-uuid"]) {
            for (const f of [CLOUD, undefined]) {
              const r = await tool(tn, f ? { id: bad, metadata_filter: f } : { id: bad });
              assert(r.isError, `${tn} ${bad}: ${r.text}`);
              assert(!DB_TEXT.test(r.text) && r.json.error !== "internal", `${tn} ${bad} ${f ? "filtered" : "unfiltered"}: ${r.text}`);
            }
          }
        }
        const res = await fetch(`${BASE}/workbench/contract/sources/not-a-uuid/dependence`, { headers: { "x-brain-key": KEY } });
        const body = await res.text();
        assertEquals(res.status, 400, body);
        assert(!DB_TEXT.test(body), body);
      });
    } finally {
      await cleanup();
      await endPool();
    }
  },
});
