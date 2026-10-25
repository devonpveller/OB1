/**
 * rw-p3a-figure-filed - THE REPORT FIGURE IS RE-STATED FROM WHAT THE CURATOR FILED, over a REAL database
 * (the runner's disposable database A, the full initdb chain) and the curator's REAL writeClaims.
 *
 *   Case F2a  a planted claim-write ROLLBACK (writeClaims runs inside a savepoint, then the planted error
 *             rolls it back, as index.ts writeGroundedClaims does): claims_error -> filed:false, value null,
 *             0 claims, '(not filed)' in the footer, and no claim row of the run in the store.
 *   Case F2b  a planted curator failure (delegateToCurator throws): error -> the same.
 *   Case R3   a planted LLM meta judge that refuses one claim after the shared list: the figure is the
 *             mean of claim_confidence_d15 over the claims the curator wrote, bit for bit.
 *   Case R5   a cited source that does not persist (its source id null): the same.
 *   Case F1   a within-run pair differing only by a case fold JavaScript and Postgres lower() treat
 *             differently (U+0130): claimList keeps both, the database merges them; the figure counts
 *             the merged claim ONCE and equals the store's mean bit for bit.
 *   Case F8   the comparator's R1 carve-out, narrowed: a syndicated duplicate merged TWICE (three pool
 *             pages with identical text -> one stored source) - the invariant passes; and a planted wrong
 *             total on a claim whose stored source received corroboration from the merged source but NOT
 *             through the merge is caught (the old carve-out skipped its total check).
 * Run (by the runner): deno test --allow-net --allow-env --allow-read credibility-figure-filed.e2e.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Pool, type PoolClient } from "postgres";
import * as H from "./harness.ts";
import type { FetchResult, SearchHit } from "./harness.ts";
import {
  compareInvariant, curator, ENTITY, type Filed, host, type LineSpec, page, QUERY, r3, realDeps,
} from "./fixtures/credibility-invariant.ts";

const HOST = Deno.env.get("CRED_E2E_DB_HOST");
const pool = HOST
  ? new Pool({ hostname: HOST, port: Number(Deno.env.get("CRED_E2E_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CRED_E2E_DB_USER") ?? "postgres", password: Deno.env.get("CRED_E2E_DB_PASSWORD") ?? "" }, 2, true)
  : null;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore: !HOST, fn, sanitizeOps: false, sanitizeResources: false });
const id = () => crypto.randomUUID();
const tok = () => `zq${id().replace(/[^a-f]/g, "").slice(0, 10)}`;
async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool!.connect();
  try {
    await c.queryArray("BEGIN");
    await c.queryArray(`UPDATE public.credibility_trigger_state SET model = 'legacy'`);
    return await fn(c);
  } finally {
    await c.queryArray("ROLLBACK").catch(() => {});
    c.release();
  }
}

const PAPER = "https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2021.757735/full";
const VIA = "https://www.nature.com/articles/s44172-025-00417-2";
const NEWS = "https://www.reuters.com/health/vestibular-motion-sickness-2026";
const NEWS2 = "https://www.npr.org/health/vestibular-motion-sickness";
const DUPA = "https://www.bbc.com/news/health-vestibular-motion-sickness";
const DUPB = "https://apnews.com/article/vestibular-motion-sickness-travel";
const DUPC = "https://www.theguardian.com/science/vestibular-motion-sickness";
const pages = (): Record<string, FetchResult> => ({
  [PAPER]: page(PAPER, `Visually induced ${ENTITY} follows a visual-vestibular mismatch. `.repeat(20)),
  [VIA]: page(VIA, `Galvanic vestibular stimulation changed ${ENTITY} by 26% in 10 participants. `.repeat(20)),
  [NEWS]: page(NEWS, `Doctors say ${ENTITY} is common among travellers. `.repeat(20)),
  [NEWS2]: page(NEWS2, `Clinicians report ${ENTITY} in commuters and sailors. `.repeat(20)),
  // three pool pages with identical fetched text: find_or_create_source stores ONE source (two merges).
  // Corroboration is a general page that LINKS a paper on a line citing both (credibility.ts corroborate):
  // DUPA and DUPB link the frontiers paper, DUPC links the nature paper.
  ...Object.fromEntries([DUPA, DUPB, DUPC].map((u) => [u, page(u, `Syndicated wire copy: ${ENTITY} is widely discussed in the press. `.repeat(20),
    u === DUPC ? [VIA] : [PAPER])])),
});
const hitsOf = (urls: string[]): SearchHit[] => urls.map((u) => ({ url: u, title: `${ENTITY} ${host(u)}`, snippet: `${ENTITY} ${host(u)}` }));
const one = async <T>(c: PoolClient, sql: string, args: unknown[] = []) => (await c.queryObject<T>(sql, args)).rows[0];

interface Plant { metaRefuse?: string; unpersisted?: string; rollback?: boolean; fail?: boolean }
/** realDeps, with the curator's filing planted to fail in the named way (index.ts's shapes). */
async function run(c: PoolClient, specs: LineSpec[], urls: string[], plant: Plant = {}) {
  const cur = await curator();
  const { d, seen } = realDeps(c, cur, specs, pages(), hitsOf(urls));
  d.delegateToCurator = async (pkg) => {
    if (plant.fail) throw new Error("planted: the curator is unreachable");
    const ids: Array<string | null> = [];
    for (const s of pkg.sources as Array<{ url: string; title: string; content: string; domain: string }>) {
      if (s.url === plant.unpersisted) { ids.push(null); continue; }
      const r = await one<{ id: string }>(c, `SELECT id::text AS id FROM public.find_or_create_source($1, $2, NULL, $3, 'web_article', NULL, $4, NULL::vector, '{}'::jsonb)`,
        [s.url, s.content, s.title, s.domain]);
      ids.push(r.id);
    }
    const synthesis = String(pkg.synthesis ?? "").trim();
    const opts = { threadId: null, synthesisId: null, sourceIds: ids, volatility: "slow", claimMetadata: { claim_kind: pkg.claim_kind },
      ...(plant.metaRefuse ? { metaJudge: (text: string) => Promise.resolve(text.includes(plant.metaRefuse!) ? "META" : "WORLD") } : {}) };
    if (plant.rollback) {
      await c.queryArray("SAVEPOINT planted_filing");
      try {
        await cur.writeClaims(c, synthesis, opts);
        throw new Error("planted: the claim write failed after its edges");
      } catch (e) {
        await c.queryArray("ROLLBACK TO SAVEPOINT planted_filing");
        seen.filed.push({ pkg, synthesis, sourceIds: ids as string[], claimIds: [] });
        return { thread_id: null, persist: { source_ids: ids }, claims: null, claims_error: (e as Error).message };
      }
    }
    const res = await cur.writeClaims(c, synthesis, opts);
    seen.filed.push({ pkg, synthesis, sourceIds: ids as string[], claimIds: res.claimIds });
    return { thread_id: null, persist: { source_ids: ids }, claims: res };
  };
  const r = await H.runResearch(d, c, QUERY, { origin: "owui" });
  return { r, filed: (seen.filed[0] ?? null) as Filed | null };
}
// deno-lint-ignore no-explicit-any
const mc = (r: H.RunResult) => r.metrics.credibility as any;
const footer = (r: H.RunResult) => (r.prose.match(/report credibility[^\n_]*/) ?? [""])[0];
/** The store's figure: the mean of claim_confidence_d15 over the DISTINCT claim rows the curator wrote. */
async function storeFigure(c: PoolClient, ids: string[]) {
  const distinct = [...new Set(ids)];
  const v: number[] = [];
  for (const x of distinct) v.push(Number((await one<{ v: number }>(c, `SELECT public.claim_confidence_d15($1) AS v`, [x])).v));
  return { claims: distinct.length, value: v.length ? r3(v.reduce((a, b) => a + b, 0) / v.length) : null };
}
const basic = (): LineSpec[] => [
  { tok: tok(), tag: "SOURCED", text: `Visually induced ${ENTITY} follows a visual-vestibular mismatch`, cites: [PAPER], verdict: "supports" },
  { tok: tok(), tag: "SOURCED", text: `Galvanic stimulation changed ${ENTITY} by 26% in 10 participants`, cites: [VIA, PAPER], verdict: "supports" },
  { tok: tok(), tag: "SOURCED", text: `Doctors say ${ENTITY} is common among travellers`, cites: [NEWS], verdict: "supports" },
  { tok: tok(), tag: "INFERRED", text: `Clinicians report ${ENTITY} in commuters`, cites: [NEWS2, NEWS], verdict: "supports" },
];

for (const [name, plant] of [["F2a (planted rollback -> claims_error)", { rollback: true }], ["F2b (planted curator failure -> error)", { fail: true }]] as const) {
  t(`rw-p3a-figure-filed Case ${name}: the figure says not filed, the footer says '(not filed)', no claim row is left`, async () => {
    await inTx(async (c) => {
      const specs = basic();
      const { r } = await run(c, specs, [PAPER, VIA, NEWS, NEWS2], plant);
      console.log(`CASE ${name}: metrics ${JSON.stringify({ filed: mc(r).filed, v: mc(r).value, claims: mc(r).claims, nf: mc(r).not_filed })}; footer '${footer(r)}'`);
      assert(r.lineCredibility.length >= 3, "the package held scored claims");
      assertEquals(mc(r).filed, false);
      assertEquals(mc(r).value, null);
      assertEquals(mc(r).claims, 0);
      assert(footer(r).includes("(not filed)"), footer(r));
      const left = Number((await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM public.claims WHERE ${specs.map((_, i) => `text LIKE $${i + 1}`).join(" OR ")}`,
        specs.map((s) => `%${s.tok}%`))).n);
      assertEquals(left, 0, "the rolled-back filing left no claim row");
    });
  });
}

t("rw-p3a-figure-filed Case F2c: a filing that succeeds keeps the figure equal to the store's, filed:true, no '(not filed)'", async () => {
  await inTx(async (c) => {
    const { r, filed } = await run(c, basic(), [PAPER, VIA, NEWS, NEWS2]);
    const st = await storeFigure(c, filed!.claimIds);
    console.log(`CASE F2c: metrics ${JSON.stringify({ filed: mc(r).filed, v: mc(r).value, claims: mc(r).claims })}; store ${JSON.stringify(st)}; footer '${footer(r)}'`);
    assertEquals(mc(r).filed, true);
    assertEquals(mc(r).value, st.value);
    assertEquals(mc(r).claims, st.claims);
    assert(!footer(r).includes("not filed"), footer(r));
    const inv = await compareInvariant(c, r, filed, "F2c");
    assertEquals(inv.bad, []);
  });
});

t("rw-p3a-figure-filed Case R3: a claim the planted meta judge refuses after the shared list is not in the figure (== the store, bit for bit)", async () => {
  await inTx(async (c) => {
    const specs = basic();
    const { r, filed } = await run(c, specs, [PAPER, VIA, NEWS, NEWS2], { metaRefuse: specs[2].tok });
    const st = await storeFigure(c, filed!.claimIds);
    console.log(`CASE R3: scored ${r.lineCredibility.length}, written ${filed!.claimIds.length}; metrics ${JSON.stringify({ v: mc(r).value, claims: mc(r).claims })}; store ${JSON.stringify(st)}`);
    assertEquals(filed!.claimIds.length, r.lineCredibility.length - 1, "the judge refused exactly one listed claim");
    assertEquals(mc(r).claims, st.claims);
    assertEquals(mc(r).value, st.value);
    assert(footer(r).includes(`report credibility ${Number(st.value).toFixed(2)}`), footer(r));
  });
});

t("rw-p3a-figure-filed Case R5: a cited source that does not persist - the figure counts only what the curator wrote (== the store, bit for bit)", async () => {
  await inTx(async (c) => {
    const { r, filed } = await run(c, basic(), [PAPER, VIA, NEWS, NEWS2], { unpersisted: PAPER });
    const st = await storeFigure(c, filed!.claimIds);
    console.log(`CASE R5: scored ${r.lineCredibility.length}, written ${filed!.claimIds.length}; metrics ${JSON.stringify({ v: mc(r).value, claims: mc(r).claims })}; store ${JSON.stringify(st)}`);
    assertEquals(filed!.claimIds.length, r.lineCredibility.length - 1, "the claim grounded only in the paper was not filed");
    assertEquals(mc(r).claims, st.claims);
    assertEquals(mc(r).value, st.value);
  });
});

t("rw-p3a-figure-filed Case F1: a U+0130 case pair - claimList keeps both, the database merges them, the figure counts it once (== the store)", async () => {
  await inTx(async (c) => {
    const k = tok();
    const specs: LineSpec[] = [
      { tok: k, tag: "SOURCED", text: `İstanbul clinics report ${ENTITY} in ferry passengers`, cites: [NEWS], verdict: "supports" },
      { tok: k, tag: "SOURCED", text: `istanbul clinics report ${ENTITY} in ferry passengers`, cites: [NEWS2], verdict: "supports" },
      { tok: tok(), tag: "SOURCED", text: `Visually induced ${ENTITY} follows a visual-vestibular mismatch`, cites: [PAPER], verdict: "supports" },
    ];
    const lowered = await one<{ same: boolean }>(c, `SELECT lower($1) = lower($2) AS same`, [specs[0].text, specs[1].text]);
    assert(lowered.same, "this database's lower() folds U+0130 to i (else the case is vacuous here)");
    assert(specs[0].text.toLowerCase() !== specs[1].text.toLowerCase(), "JavaScript's fold keeps them apart");
    const { r, filed } = await run(c, specs, [PAPER, NEWS, NEWS2]);
    const st = await storeFigure(c, filed!.claimIds);
    console.log(`CASE F1: scored ${r.lineCredibility.length}, claim ids ${filed!.claimIds.length} (${new Set(filed!.claimIds).size} distinct); metrics ${JSON.stringify({ v: mc(r).value, claims: mc(r).claims })}; store ${JSON.stringify(st)}`);
    assertEquals(r.lineCredibility.length, 3, "claimList is NOT made to match lower(btrim()) - the seam is not moved");
    assertEquals(new Set(filed!.claimIds).size, 2, "the database merged the pair");
    assertEquals(mc(r).claims, 2);
    assertEquals(mc(r).value, st.value);
  });
});

t("rw-p3a-figure-filed Case F8: a syndicated duplicate merged twice passes the narrowed comparator, and a planted wrong total one hop out (not through the merge) is caught", async () => {
  await inTx(async (c) => {
    const specs: LineSpec[] = [
      { tok: tok(), tag: "SOURCED", text: `Wire copy says ${ENTITY} is widely discussed in the press`, cites: [DUPA, DUPB, DUPC], verdict: "supports" },
      // the frontiers paper receives corroboration from TWO copies of the merged source on one claim text
      // (the run counts two amounts, the store one row: through the merge)
      { tok: tok(), tag: "SOURCED", text: `The paper and the wire say ${ENTITY} follows a mismatch`, cites: [PAPER, DUPA, DUPB], verdict: "supports" },
      { tok: tok(), tag: "SOURCED", text: `Visually induced ${ENTITY} follows a visual-vestibular mismatch`, cites: [PAPER], verdict: "supports" },
      // the nature paper receives corroboration from ONE copy (from a merged source, NOT through the merge)
      { tok: tok(), tag: "SOURCED", text: `The stimulation paper and the wire say ${ENTITY} changes`, cites: [VIA, DUPC], verdict: "supports" },
      { tok: tok(), tag: "SOURCED", text: `Galvanic stimulation changed ${ENTITY} by 26% in 10 participants`, cites: [VIA], verdict: "supports" },
      { tok: tok(), tag: "SOURCED", text: `Doctors say ${ENTITY} is common among travellers`, cites: [NEWS], verdict: "supports" },
    ];
    const { r, filed } = await run(c, specs, [PAPER, VIA, NEWS, DUPA, DUPB, DUPC]);
    const corr = (await c.queryObject<{ f: string; t: string; n: number }>(
      `SELECT from_source_id::text AS f, to_source_id::text AS t, count(*)::int AS n FROM public.source_corroborations
        WHERE from_source_id = ANY($1::uuid[]) OR to_source_id = ANY($1::uuid[]) GROUP BY 1, 2`, [filed!.sourceIds])).rows;
    console.log(`CASE F8: package ${JSON.stringify((filed!.pkg.sources as Array<{ url: string }>).map((x) => host(x.url)))}; corroboration rows ${corr.length}`);
    const merges = filed!.sourceIds.length - new Set(filed!.sourceIds).size;
    const inv = await compareInvariant(c, r, filed, "F8");
    console.log(`CASE F8: merges ${merges}; scored ${inv.scored}, filed ${inv.filed}, bit ${inv.bit}, R1 ${inv.r1}; bad ${JSON.stringify(inv.bad)}`);
    assert(merges >= 2, `the syndicated duplicate merged more than once (${merges})`);
    assertEquals(inv.bad, [], "the narrowed comparator passes the multi-merge run");
    assertEquals(inv.r1, 4, "R1 = the three claims citing the merged source directly + the one through the merge, not the one-copy hop");
    const k = r.lineCredibility.findIndex((s) => s.text.includes(specs[4].tok));
    assert(k >= 0, "the one-hop claim was scored");
    // planted: a wrong total on the claim whose source's corroboration from the merged source did not come through the merge
    const planted = structuredClone(r);
    planted.lineCredibility[k] = { ...planted.lineCredibility[k], total: planted.lineCredibility[k].total + 0.001 };
    const bad = (await compareInvariant(c, planted, filed, "F8-planted")).bad;
    console.log(`CASE F8 planted: ${JSON.stringify(bad)}`);
    assert(bad.some((b) => b.startsWith(`F8-planted claim ${k}: TOTAL`)), `the planted total is caught: ${JSON.stringify(bad)}`);
  });
});
