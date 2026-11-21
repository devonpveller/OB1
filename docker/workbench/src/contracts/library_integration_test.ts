// deno test src/contracts/library_integration_test.ts - the two shared-library reads behind Home's library cards
// (rwr-home round 4) over a REAL database: contract/library/waiting-claims and contract/library/recent.
//
// SKIPPED unless CONTRACT_TEST_DB_HOST is set. contract-test/run-contract-tests.ps1 runs it beside integration_test.ts
// in its disposable lab (the real initdb chain, fixtures.sql). Never point it at a live database: it plants and removes
// rows (every row it plants carries this run's marker and is deleted at the end).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";
import { Hono } from "hono";
import { poolDb } from "./db.ts";
import { RegistryReader } from "./registry.ts";
import { createContractApp } from "./app.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import { chunkText } from "../util/chunk.ts";
import { identitySeam, seamDeps } from "../middleware/identity.ts";
import { RecentSources, WaitingClaims } from "./schemas/library.ts";

const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !HOST;
const pool = HOST
  ? new Pool({
    hostname: HOST, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 4, true)
  : null;
const db = pool ? poolDb(pool) : null;
const app = db
  ? createContractApp({
    db, registry: new RegistryReader(db, 0), scorer: unavailableScorer, chunk: chunkText, mountsRoot: "/tmp/contract-mounts",
    embed: () => Promise.resolve(Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))), streamPollMs: 20, log: () => {},
  })
  : null;
const front = app ? new Hono() : null;
if (front) {
  const env = (k: string) => ({ WORKSPACE_IDENTITY_HEADER: "X-Test-Sub" } as Record<string, string>)[k];
  front.use("*", identitySeam(seamDeps(null, env)));
  front.route("/", app!);
}
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });
const sql = <T = Record<string, unknown>>(text: string, args: unknown[] = []) => db!.query<T>(text, args);
const MARK = `lib-${crypto.randomUUID().slice(0, 8)}`;
async function get(path: string, as = "user-a") {
  const r = await front!.request("/workbench/contract/library" + path, { headers: { "X-Test-Sub": as } });
  return { status: r.status, json: await r.json() as Record<string, any> };
}

async function source(title: string, opts: { suppressed?: boolean; ageDays?: number } = {}) {
  const id = crypto.randomUUID();
  await sql(
    `INSERT INTO public.sources (id, url, title, content, created_at, retraction_committed_at)
     VALUES ($1, $2, $3, 'body', now() - make_interval(days => $4::int), CASE WHEN $5::boolean THEN now() ELSE NULL END)`,
    [id, `https://example.org/${MARK}/${id}`, `${MARK} ${title}`, opts.ageDays ?? 0, !!opts.suppressed],
  );
  return id;
}
async function claim(text: string, edges: [string, string][]) {
  const id = crypto.randomUUID();
  await sql(`INSERT INTO public.claims (id, text) VALUES ($1, $2)`, [id, `${MARK} ${text}`]);
  for (const [src, kind] of edges) await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $2, $3)`, [id, src, kind]);
  return id;
}
async function baseline() {
  const w = await get("/waiting-claims?limit=50");
  return w.json.total as number;
}
async function cleanup() {
  await sql(`DELETE FROM public.claims WHERE text LIKE $1`, [`${MARK}%`]);
  await sql(`DELETE FROM public.sources WHERE title LIKE $1`, [`${MARK}%`]);
}

t("waiting-claims: exactly the active, uncontradicted claims with one active source; the same for every user", async () => {
  try {
    const before = await baseline();
    const a = await source("A");
    const b = await source("B");
    const gone = await source("gone", { suppressed: true });
    const one = await claim("one source", [[a, "states"]]);
    await claim("two sources", [[a, "states"], [b, "corroborates"]]);
    await claim("one active plus one suppressed", [[a, "states"], [gone, "states"]]); // still one ACTIVE source: waits
    await claim("only a suppressed source", [[gone, "states"]]); // no active source: not "waiting"
    await claim("contradicted", [[a, "states"], [b, "contradicts"]]);
    const retracted = await claim("retracted", [[a, "states"]]);
    await sql(`UPDATE public.claims SET status = 'retracted' WHERE id = $1`, [retracted]);
    const r = await get("/waiting-claims?limit=50");
    assertEquals(r.status, 200);
    assert(WaitingClaims.safeParse(r.json).success);
    // one source (new), one active plus one suppressed (new): two new waiting claims; the others do not count
    assertEquals(r.json.total, before + 2);
    const mine = (r.json.claims as { id: string; text: string }[]).filter((c) => c.text.startsWith(MARK));
    assertEquals(mine.map((c) => c.text.slice(MARK.length + 1)).sort(), ["one active plus one suppressed", "one source"]);
    assert(mine.some((c) => c.id === one));
    // another user reads the same rows
    const o = await get("/waiting-claims?limit=50", "user-b");
    assertEquals(o.json, r.json);
  } finally {
    await cleanup();
  }
});

t("waiting-claims: a live-like volume - the total is exact past the page, the page is the limit, newest first", async () => {
  try {
    const before = await baseline();
    const s = await source("volume");
    await sql(
      `INSERT INTO public.claims (id, text, created_at)
       SELECT gen_random_uuid(), $1 || ' v' || g, now() - make_interval(secs => g) FROM generate_series(1, 3000) g`,
      [MARK],
    );
    await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) SELECT id, $1, 'states' FROM public.claims WHERE text LIKE $2`, [s, `${MARK} v%`]);
    const r = await get("/waiting-claims?limit=5");
    assertEquals(r.json.claims.length, 5);
    assertEquals(r.json.total, before + 3000);
    const times = (r.json.claims as { created_at: string }[]).map((c) => Date.parse(c.created_at));
    assertEquals([...times].sort((x, y) => y - x), times);
    const big = await get("/waiting-claims?limit=500"); // the cap is 50
    assertEquals(big.json.claims.length, 50);
    assertEquals(big.json.total, before + 3000);
  } finally {
    await cleanup();
  }
});

t("recent: the active sources first added in the window with their titles, the exact totals, never a suppressed or old one", async () => {
  try {
    const base = await get("/recent?days=7&limit=50");
    const base60 = await get("/recent?days=60&limit=1");
    assert(RecentSources.safeParse(base.json).success);
    const s1 = await source("new one");
    await source("new two");
    await source("suppressed", { suppressed: true });
    await source("old", { ageDays: 30 });
    await claim("fresh claim", [[s1, "states"]]);
    const r = await get("/recent?days=7&limit=50");
    assertEquals(r.status, 200);
    assertEquals(r.json.days, 7);
    assertEquals(r.json.sources_total, base.json.sources_total + 2);
    assertEquals(r.json.claims_total, base.json.claims_total + 1);
    const titles = (r.json.sources as { title: string }[]).map((x) => x.title).filter((x) => x.startsWith(MARK)).sort();
    assertEquals(titles, [`${MARK} new one`, `${MARK} new two`]);
    // a wider window includes the old one; the page is capped but the total is not
    const w = await get("/recent?days=60&limit=1");
    assertEquals(w.json.sources.length, 1);
    assertEquals(w.json.sources_total, base60.json.sources_total + 3);
    // the same for another user
    const o = await get("/recent?days=7&limit=50", "user-b");
    assertEquals(o.json, r.json);
  } finally {
    await cleanup();
  }
});

t("recent: no user's private material is in the answer (a held source and a private report are not rows of sources)", async () => {
  try {
    const r = await get("/recent?days=90&limit=50");
    const claimsText = JSON.stringify(r.json);
    assert(!/held_sources|research_private/.test(claimsText));
    const rows = await sql<{ n: number | bigint }>(
      `SELECT count(*) AS n FROM public.sources s WHERE EXISTS (SELECT 1 FROM public.research_private_reports p WHERE p.id = s.id)`,
    );
    assertEquals(Number(rows[0].n), 0); // a private report never lives in sources, so this read cannot show one
  } finally {
    await cleanup();
  }
});
