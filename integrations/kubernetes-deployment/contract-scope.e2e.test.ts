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

const pool = BASE
  ? new Pool({
    hostname: Deno.env.get("CONTRACT_SCOPE_E2E_DB_HOST"), port: 5432, database: "openbrain",
    user: "postgres", password: Deno.env.get("CONTRACT_SCOPE_E2E_DB_PASSWORD") ?? "",
  }, 2, true)
  : null;
async function sql(text: string, args: unknown[] = []) {
  const c = await pool!.connect();
  try {
    return (await c.queryObject(text, args)).rows as Record<string, unknown>[];
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
      await pool!.end();
    }
  },
});
