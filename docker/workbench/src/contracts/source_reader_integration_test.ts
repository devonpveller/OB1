// deno test src/contracts/source_reader_integration_test.ts - rwr-source-reader-api over a REAL database.
//
// SKIPPED unless CONTRACT_TEST_DB_HOST (a DISPOSABLE database) is set; contract-test/run-contract-tests.ps1 [4a2]
// sets it, running the workbench side as ob_workbench (slot 480's role, the workbench's) and planting as a superuser
// (SR_ADMIN_USER / SR_ADMIN_PASSWORD) because the owner-private stores are readable by no app role. Never point it at
// a live database: it plants rows (and removes them again).
// Identity: the contract is served behind the identity seam with WORKSPACE_IDENTITY_HEADER = X-Test-Sub, so a request
// names its user; one service key stands for a service.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";
import { Hono } from "hono";
import { poolDb } from "./db.ts";
import { RegistryReader } from "./registry.ts";
import { createContractApp } from "./app.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import { chunkText } from "../util/chunk.ts";
import { identitySeam, seamDeps } from "../middleware/identity.ts";
import { SourceReader } from "./schemas/source_reader.ts";
import { FX } from "./schemas/fixtures.ts";

const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !HOST;
const mk = (user: string, password: string) =>
  new Pool({ hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain", user, password }, 3, true);
const appPool = HOST ? mk(Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "") : null;
const adminPool = HOST ? mk(Deno.env.get("SR_ADMIN_USER") ?? Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres",
  Deno.env.get("SR_ADMIN_PASSWORD") ?? Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "") : null;
const db = appPool ? poolDb(appPool) : null;
const admin = adminPool ? poolDb(adminPool) : null;
const logs: string[] = [];
const SERVICE_KEY = "source-reader-service-key-0123456789";
const front = db
  ? (() => {
    const app = createContractApp({
      db, registry: new RegistryReader(db, 0), scorer: unavailableScorer, chunk: chunkText, mountsRoot: "/tmp/contract-mounts",
      embed: () => Promise.resolve(Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))), streamPollMs: 20, log: (m) => logs.push(m),
      privateView: { signIn: true, defaultSub: "" }, // the private-view rule (identity/private_view.ts) in its signed-in mode
    });
    const h = new Hono();
    const env = (k: string) => ({ WORKSPACE_SERVICE_KEYS: `sr-test=${SERVICE_KEY}`, WORKSPACE_IDENTITY_HEADER: "X-Test-Sub" } as Record<string, string>)[k];
    h.use("*", identitySeam(seamDeps(null, env)));
    // lab identities: x-test-inject sets a full identity (an impersonating admin, an on-behalf caller); otherwise a named
    // X-Test-Sub subject is a signed-in user acting as themselves (the seam's header identity has kind "header")
    h.use("*", async (c, next) => {
      const inj = c.req.header("x-test-inject");
      const who = c.get("identity" as never) as { kind?: string; sub: string } | undefined;
      if (inj) c.set("identity" as never, JSON.parse(inj) as never);
      else if (who?.kind === "header") c.set("identity" as never, { ...who, kind: "user", actor: who.sub } as never);
      await next();
    });
    h.route("/", app);
    return h;
  })()
  : null;

const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });
const sql = <T = Record<string, unknown>>(text: string, args: unknown[] = []) => admin!.query<T>(text, args);
const uuid = () => crypto.randomUUID();
const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
async function read(id: string, as: string | null, query = "", opts: { service?: boolean; inject?: Record<string, unknown> } = {}) {
  const r = await front!.request(`/workbench/contract/sources/${id}/reader${query}`, {
    headers: {
      ...(as ? { "X-Test-Sub": as } : {}), ...(opts.service ? { "x-brain-key": SERVICE_KEY } : {}),
      ...(opts.inject ? { "x-test-inject": JSON.stringify(opts.inject) } : {}),
    },
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  return { status: r.status, text, json, headers: r.headers };
}
async function get(path: string, as: string | null) {
  const r = await front!.request(`/workbench/contract${path}`, { headers: as ? { "X-Test-Sub": as } : {} });
  return { status: r.status, text: await r.text() };
}

const R = rnd();
const W = {
  subA: `lab-sr-a-${R}`, subB: `lab-sr-b-${R}`, subAdmin: `lab-sr-admin-${R}`,
  shared: uuid(), priv: uuid(), noChunks: uuid(), missing: uuid(),
  cVerbatim: uuid(), cOverlap: uuid(), cLoose: uuid(), cPriv: uuid(), cLinked: uuid(), cSharedOnly: uuid(),
  MARK: `PRIVMARK${R}`, batch: uuid(),
};
const SHARED_CHUNKS = [
  "# Overview\n\nThe study looked at tidal energy plants along three coasts.",
  "## Method\n\nSensors recorded turbine output every ten minutes for two years.",
  "## Findings\n\nAverage availability across the sites reached ninety four percent.",
  "Maintenance windows were shortest at the northern coast site.",
];
const SHARED_CONTENT = SHARED_CHUNKS.join("\n\n");
const colsOf = async (table: string) =>
  (await sql<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table])).map((r) => r.column_name);

async function plant() {
  // a shared source with headings, chunks stored in order, and four claims: verbatim, overlap-only, loose, and a
  // claim whose only edge is to ANOTHER source (it must not appear here)
  await sql(`INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata) VALUES ($1, $2, 'Tidal energy study', $3, 'web_article', 'example.org', '{}')`,
    [W.shared, `https://example.org/sr/${R}`, SHARED_CONTENT]);
  for (let i = 0; i < SHARED_CHUNKS.length; i++) {
    await sql(`INSERT INTO public.source_chunks (source_id, idx, content) VALUES ($1, $2, $3)`, [W.shared, i, SHARED_CHUNKS[i]]);
  }
  await sql(`INSERT INTO public.claims (id, text, epistemic_tag) VALUES
      ($1, 'Sensors recorded turbine output every ten minutes for two years', 'sourced'),
      ($2, 'Availability averaged ninety four percent across all of the sites studied', 'sourced'),
      ($3, 'Wind farms are noisy', 'inferred'),
      ($4, 'A claim about some other source entirely', 'sourced')`, [W.cVerbatim, W.cOverlap, W.cLoose, W.cSharedOnly]);
  await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $4, 'states'), ($2, $4, 'corroborates'), ($3, $4, 'inferred_from'), ($5, $6, 'states')`,
    [W.cVerbatim, W.cOverlap, W.cLoose, W.shared, W.cSharedOnly, FX.sourceActive]);
  await sql(`INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata) VALUES ($1, NULL, 'No chunks yet', 'Text not chunked.', 'manual', NULL, '{}')`, [W.noChunks]);

  // a private (inlet) source of subA, planted the way slot 440 leaves one: moved out of the shared tables
  await sql(`INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata) VALUES ($1, NULL, $2, $3, 'web_article', NULL, '{}')`,
    [W.priv, `Private ${W.MARK} transcript`, `# Episode\n\nHost says ${W.MARK} opening line about budgets.\n\n## Guest\n\nThe guest answers about ${W.MARK} spending plans.`]);
  await sql(`INSERT INTO public.source_chunks (source_id, idx, content) VALUES ($1, 0, $2), ($1, 1, $3)`,
    [W.priv, `# Episode Host says ${W.MARK} opening line about budgets.`, `## Guest The guest answers about ${W.MARK} spending plans.`]);
  await sql(`INSERT INTO public.claims (id, text, epistemic_tag) VALUES ($1, $2, 'sourced'), ($3, $4, 'sourced')`,
    [W.cPriv, `The guest answers about ${W.MARK} spending plans`, W.cLinked, `Budgets were discussed on the programme`]);
  await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $3, 'states'), ($2, $3, 'corroborates')`, [W.cPriv, W.cLinked, W.priv]);
  const copy = async (table: string, priv: string, where: string, arg: string) => {
    const cols = (await colsOf(table)).join(", ");
    await sql(`INSERT INTO public.${priv} (${cols}, inlet_owner_sub, inlet_batch) SELECT ${cols}, $1, $2 FROM public.${table} WHERE ${where} = $3`, [W.subA, W.batch, arg]);
  };
  await copy("sources", "inlet_private_sources", "id", W.priv);
  await copy("source_chunks", "inlet_private_source_chunks", "source_id", W.priv);
  await copy("claims", "inlet_private_claims", "id", W.cPriv);
  // the private claim's own edge; the shared claim's private link
  await sql(`INSERT INTO public.inlet_private_claim_sources (claim_id, edge_ref, owner_sub, batch, source_id, row_data)
             VALUES ($1, md5($5), $2, $3, $4, jsonb_build_object('edge_type', 'states'))`, [W.cPriv, W.subA, W.batch, W.priv, W.cPriv]);
  await sql(`INSERT INTO public.inlet_private_claim_links (claim_id, source_id, owner_sub, batch, row_data)
             VALUES ($1, $2, $3, $4, jsonb_build_object('edge_type', 'corroborates'))`, [W.cLinked, W.priv, W.subA, W.batch]);
  // (planted as a web article: slot 470's guard refuses a shared podcast transcript, which is the point of 440's move)
  await sql(`UPDATE public.inlet_private_sources SET content_type = 'podcast_transcript' WHERE id = $1`, [W.priv]);
  // out of the shared tables, as 440 leaves it (cascade removes the shared chunks and the private claim's edge)
  await sql(`DELETE FROM public.sources WHERE id = $1`, [W.priv]);
  await sql(`DELETE FROM public.claims WHERE id = $1`, [W.cPriv]);
  // the linked claim keeps no shared edge to the private source: that edge went with the cascade above
}
async function unplant() {
  await sql(`DELETE FROM public.inlet_private_claim_links WHERE batch = $1`, [W.batch]);
  await sql(`DELETE FROM public.inlet_private_claim_sources WHERE batch = $1`, [W.batch]);
  await sql(`DELETE FROM public.inlet_private_claims WHERE inlet_batch = $1`, [W.batch]);
  await sql(`DELETE FROM public.inlet_private_source_chunks WHERE inlet_batch = $1`, [W.batch]);
  await sql(`DELETE FROM public.inlet_private_sources WHERE inlet_batch = $1`, [W.batch]);
  await sql(`DELETE FROM public.claims WHERE id = ANY($1::uuid[])`, [[W.cVerbatim, W.cOverlap, W.cLoose, W.cSharedOnly, W.cLinked, W.cPriv]]);
  await sql(`DELETE FROM public.sources WHERE id = ANY($1::uuid[])`, [[W.shared, W.noChunks, W.priv]]);
}

let planted = false;
async function world() {
  if (!planted) {
    try {
      await plant();
    } catch (e) {
      await unplant().catch(() => {});
      throw e;
    }
    planted = true;
  }
}

t("acceptance 1+3: a shared source comes back with its chunks in source order and their section names, matching the contract's schema", async () => {
  await world();
  const r = await read(W.shared, W.subB);
  assertEquals(r.status, 200, r.text);
  assertEquals(r.headers.get("cache-control"), "no-store");
  const p = SourceReader.safeParse(r.json);
  assert(p.success, JSON.stringify(p.error?.issues));
  assertEquals(r.json.private, false);
  assertEquals(r.json.source_id, W.shared);
  assertEquals(r.json.revision, 1);
  assertEquals(r.json.chunks.map((c: any) => c.idx), [0, 1, 2, 3]);
  assertEquals(r.json.chunks.map((c: any) => c.content), SHARED_CHUNKS);
  assertEquals(r.json.chunks.map((c: any) => c.section), ["Overview", "Method", "Findings", "Findings"]);
  assertEquals(r.json.sections.map((s: any) => [s.name, s.level, s.first_chunk_idx]), [["Overview", 1, 0], ["Method", 2, 1], ["Findings", 2, 2]]);
});

t("acceptance 4: every claim that carries a span has a span that lies inside its chunk's text, over a fixture", async () => {
  await world();
  const r = await read(W.shared, W.subB);
  let spans = 0;
  for (const c of r.json.chunks) {
    for (const cl of c.claims) {
      if (cl.span === null) continue;
      spans++;
      assert(Number.isInteger(cl.span.start) && Number.isInteger(cl.span.end), "integer offsets");
      assert(cl.span.start >= 0 && cl.span.end > cl.span.start && cl.span.end <= c.content.length, `span ${JSON.stringify(cl.span)} outside chunk ${c.idx} (${c.content.length})`);
      assertEquals(c.content.slice(cl.span.start, cl.span.end).toLowerCase(), cl.text.toLowerCase());
    }
  }
  assert(spans >= 1, "the fixture must carry at least one span, or this proves nothing");
  const verbatim = r.json.chunks[1].claims.find((c: any) => c.claim_id === W.cVerbatim);
  assert(verbatim && verbatim.span && verbatim.overlap === 1 && verbatim.edge_type === "states");
});

t("acceptance 5: where no span can be given, the claim is returned against its chunk with no span - or listed unplaced - and no error", async () => {
  await world();
  const r = await read(W.shared, W.subB);
  assertEquals(r.status, 200);
  const overlap = r.json.chunks[2].claims.find((c: any) => c.claim_id === W.cOverlap);
  assert(overlap, "the overlap-only claim sits in chunk 2");
  assertEquals(overlap.span, null);
  assert(overlap.overlap >= 0.6 && overlap.overlap < 1);
  assertEquals(overlap.edge_type, "corroborates");
  assertEquals(r.json.unplaced_claims.map((c: any) => c.claim_id), [W.cLoose]);
  assertEquals(r.json.unplaced_claims[0].span, null);
  assertEquals(r.json.unplaced_claims[0].overlap, null);
  // a claim whose only edge is to another source is not here at all
  assert(!r.text.includes(W.cSharedOnly));
  // and a source with no chunks yet is a source with no chunks, not an error
  const e = await read(W.noChunks, W.subB);
  assertEquals(e.status, 200);
  assertEquals(e.json.chunks, []);
  assertEquals(e.json.unplaced_claims, []);
});

t("a suppressed source shows its state and reason; evidence-only omits it; a missing source and a bad id answer as they should", async () => {
  await world();
  const s = await read(FX.sourceSuppressed, W.subB);
  assertEquals(s.status, 200, s.text);
  assertEquals(s.json.state, "suppressed");
  assert(typeof s.json.state_detail.reason === "string" && s.json.state_detail.reason.length > 0);
  const o = await read(FX.sourceSuppressed, W.subB, "?evidence_only=true");
  assertEquals(o.status, 200);
  assertEquals(o.json.state, "omitted");
  assertEquals(o.json.chunks, []);
  assertEquals(o.json.unplaced_claims, []);
  assertEquals((await read(W.missing, W.subB)).status, 404);
  assertEquals((await read("not-a-uuid", W.subB)).status, 400);
});

t("acceptance 2+6: a private source is its owner's; anyone else - user B, a non-owner admin, a service, the default user, a filtered caller - gets the 404 a missing source gets, byte for byte", async () => {
  await world();
  const mine = await read(W.priv, W.subA);
  assertEquals(mine.status, 200, mine.text);
  assertEquals(mine.json.private, true);
  assert(SourceReader.safeParse(mine.json).success);
  assertEquals(mine.json.revision, null);
  assertEquals(mine.json.chunks.map((c: any) => c.idx), [0, 1]);
  assertEquals(mine.json.chunks.map((c: any) => c.section), ["Episode", "Guest"]);
  assert(mine.text.includes(W.MARK));
  // the owner's claims: the private claim (placed, with a span) and the shared claim's private link (placed by overlap or unplaced)
  const priv = mine.json.chunks[1].claims.find((c: any) => c.claim_id === W.cPriv);
  assert(priv && priv.span && priv.edge_type === "states", JSON.stringify(mine.json.chunks[1].claims));
  const everyClaim = [...mine.json.chunks.flatMap((c: any) => c.claims), ...mine.json.unplaced_claims].map((c: any) => c.claim_id).sort();
  assertEquals(everyClaim, [W.cLinked, W.cPriv].sort());

  const missing = await read(W.missing, W.subA);
  assertEquals(missing.status, 404);
  const refusals = [
    ["user B", await read(W.priv, W.subB)],
    ["a non-owner admin", await read(W.priv, W.subAdmin)],
    ["the default user", await read(W.priv, null)],
    ["a service", await read(W.priv, null, "", { service: true })],
    // attempt-1 Case 2 (T2b, T2c): the owner's subject, but not the owner acting as themselves (identity/private_view.ts D2)
    ["an admin impersonating the owner (T2b)", await read(W.priv, null, "", { inject: { sub: W.subA, actor: W.subAdmin, name: W.subA, key: W.subA, kind: "user", admin: true, impersonating: { reason: "lab", since: new Date().toISOString() } } })],
    ["openbrain-mcp on behalf of the owner (T2c)", await read(W.priv, null, "", { inject: { sub: W.subA, actor: "service:mcp", name: W.subA, key: W.subA, kind: "on-behalf", admin: false, impersonating: null } })],
    ["Open WebUI on behalf of the owner", await read(W.priv, null, "", { inject: { sub: W.subA, actor: "service:owui", name: W.subA, key: W.subA, kind: "on-behalf", admin: false, impersonating: null } })],
    ["the owner under a cloud-door filter", await read(W.priv, W.subA, `?metadata_filter=${encodeURIComponent('{"share":"cloud"}')}`)],
  ] as const;
  for (const [who, r] of refusals) {
    assertEquals(r.status, 404, who);
    assertEquals(r.text, missing.text, `${who}: the refusal must be byte-identical to a missing source's`);
    assert(!r.text.includes(W.MARK) && !r.text.includes(W.priv), who);
  }
  // the same through a different path to the same data: a service key may not read it either, and the owner's own request for a
  // shared source id that is not hers still works (the route is not per-user for shared sources)
  assertEquals((await read(W.shared, W.subA)).status, 200);
});

t("acceptance 7: nothing private from this item is on a shared surface - the planted marker is in no shared table, no shared read, no log", async () => {
  await world();
  await read(W.priv, W.subA);
  await read(W.priv, W.subB);
  const like = `%${W.MARK}%`;
  for (const [table, col] of [["sources", "content"], ["sources", "title"], ["source_chunks", "content"], ["claims", "text"]] as const) {
    const n = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table} WHERE ${col} ILIKE $1`, [like]))[0].n;
    assertEquals(n, 0, `${table}.${col} holds the private marker`);
  }
  for (const who of [W.subA, W.subB, null]) {
    for (const path of [`/search?q=${W.MARK}&kinds=page,claim,source`, `/claims?q=${W.MARK}`, `/claims?source_id=${W.priv}`, `/chunks/${W.priv}:0/context?window=2`,
      `/references/${W.priv}`, `/sources/${W.priv}/quality`, `/sources/${W.priv}/dependence`, `/trail?source_id=${W.priv}`, `/timeline?source_id=${W.priv}`]) {
      const r = await get(path, who);
      // a search echoes its own query text; what it must not carry is a RESULT, so the echo is taken out first
      const body = r.text.split(W.MARK).length > 1 && path.includes("?q=") ? r.text.split(`"${W.MARK}"`).join('""') : r.text;
      assert(!body.includes(W.MARK), `${path} as ${who ?? "default"} carries the private marker (status ${r.status})`);
    }
  }
  assert(!logs.some((l) => l.includes(W.MARK)), "the contract's log carries the private marker");
  // the app role cannot read the private stores directly - the route reaches them only through the owner functions
  let denied = 0;
  for (const table of ["inlet_private_sources", "inlet_private_source_chunks", "inlet_private_claims", "inlet_private_claim_sources", "inlet_private_claim_links"]) {
    try {
      await db!.query(`SELECT count(*) FROM public.${table}`);
    } catch (e) {
      if ((e as { fields?: { code?: string } }).fields?.code === "42501") denied++;
    }
  }
  const role = (await db!.query<{ u: string; s: boolean }>(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s`))[0];
  if (!role.s) assertEquals(denied, 5, "the app role must be refused every private table");
  // the functions answer an owner and nobody else, at the SQL level too
  assertEquals((await db!.query(`SELECT * FROM public.inlet_private_reader_chunks($1::uuid, $2)`, [W.priv, W.subB])).length, 0);
  assertEquals((await db!.query(`SELECT * FROM public.inlet_private_reader_claims($1::uuid, $2)`, [W.priv, W.subB])).length, 0);
  assertEquals((await db!.query(`SELECT * FROM public.inlet_private_reader_chunks($1::uuid, $2)`, [W.priv, "service:sr-test"])).length, 0);
  assertEquals((await db!.query(`SELECT * FROM public.inlet_private_reader_chunks($1::uuid, $2)`, [W.priv, ""])).length, 0);
  assertEquals((await db!.query(`SELECT * FROM public.inlet_private_reader_chunks($1::uuid, $2)`, [W.priv, W.subA])).length, 2);
  assertEquals((await db!.query(`SELECT * FROM public.inlet_private_reader_claims($1::uuid, $2)`, [W.priv, W.subA])).length, 2);
});

t("the migration's functions are executable by ob_workbench alone (480's pattern): not PUBLIC, not ob_app_memory (a role ten services log in as), not service_role or anon", async () => {
  const sigs = ["public.inlet_private_reader_chunks(uuid,text)", "public.inlet_private_reader_claims(uuid,text)"];
  for (const sig of sigs) {
    const r = (await sql<{ wb: boolean; app: boolean; svc: boolean; anon: boolean; pub: boolean; def: boolean; cfg: string }>(
      `SELECT has_function_privilege('ob_workbench', p.oid, 'EXECUTE') AS wb,
              has_function_privilege('ob_app_memory', p.oid, 'EXECUTE') AS app,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
              coalesce((SELECT has_function_privilege('anon', p.oid, 'EXECUTE') FROM pg_roles WHERE rolname = 'anon'), false) AS anon,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE') AS pub,
              p.prosecdef AS def, array_to_string(p.proconfig, ',') AS cfg
         FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [sig]))[0];
    assert(r, `${sig} exists`);
    assertEquals([r.wb, r.app, r.svc, r.anon, r.pub], [true, false, false, false, false], `${sig}: who may execute`);
    assertEquals(r.def, true);
    assertEquals(r.cfg, "search_path=public, pg_temp");
  }
  // the app role of this run is ob_workbench itself (or a superuser in a plain lab): it runs them; ob_app_memory is refused at the SQL level
  const who = (await db!.query<{ u: string }>(`SELECT current_user AS u`))[0].u;
  assert(["ob_workbench", "postgres"].includes(who), `the test must run as ob_workbench (the workbench's role), not ${who}`);
});

Deno.test({
  name: "cleanup: the planted rows are removed",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await unplant();
    assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.sources WHERE id = ANY($1::uuid[])`, [[W.shared, W.priv, W.noChunks]]))[0].n, 0);
    await appPool?.end();
    await adminPool?.end();
  },
});
