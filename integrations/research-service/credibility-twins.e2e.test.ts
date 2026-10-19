/**
 * Attempt 3 of rw-p3a-entail over a REAL database: the SQL twin and the TS model on the SAME rows
 * (tester t-rw-p3a-2's finding - the twins rounded differently and a claim's floor verdict flipped
 * - and the round's near-misses). SKIPPED unless CRED_E2E_DB_HOST is set; run-credibility-e2e.ps1
 * runs it after credibility.e2e.test.ts against the same DISPOSABLE database. Every case runs in
 * ONE transaction that is rolled back, so it leaves nothing behind and needs no particular order.
 *
 * THE RULE (test plan, Attempt 3): no number that feeds a total, an amount or a floor comparison is
 * rounded in either twin; both compute in IEEE double precision with the same operations in the
 * same order, and the floor is the highest claim_floor among the kind's family rows. So the claim
 * total (claim_confidence_d15) and the line total (credibility.ts lineCredibility) on the same
 * stamped rows agree to 1e-9 (in fact bit for bit) and give the same verdict.
 * Run (by the runner): deno test --allow-net --allow-env --allow-read credibility-twins.e2e.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Pool, type PoolClient } from "postgres";
import {
  type CredibilityModel, foldReceived, lineCredibility, loadCredibilityModel, type SourceScore, weightedTotal,
} from "./credibility.ts";

const HOST = Deno.env.get("CRED_E2E_DB_HOST");
const pool = HOST
  ? new Pool({ hostname: HOST, port: Number(Deno.env.get("CRED_E2E_DB_PORT") ?? 5432), database: "openbrain", user: Deno.env.get("CRED_E2E_DB_USER") ?? "postgres",
    password: Deno.env.get("CRED_E2E_DB_PASSWORD") ?? "" }, 2, true)
  : null;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore: !HOST, fn, sanitizeOps: false, sanitizeResources: false });
const errOf = (e: unknown) => String((e as Error)?.message ?? e);
const id = () => crypto.randomUUID();

/**
 * Run fn in one transaction and roll it back, whatever happens. The trigger starts each case on
 * the legacy model (credibility.e2e.test.ts flipped it; inserts here must not re-score under D15
 * while a case is shaping a table); a case that needs D15 flips it inside, as the owner.
 */
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
/** A statement that may fail, isolated by a savepoint so the transaction goes on. */
async function attempt<T>(c: PoolClient, fn: () => Promise<T>): Promise<{ ok: T | null; err: string }> {
  await c.queryArray("SAVEPOINT a");
  try {
    const ok = await fn();
    await c.queryArray("RELEASE SAVEPOINT a");
    return { ok, err: "" };
  } catch (e) {
    await c.queryArray("ROLLBACK TO SAVEPOINT a");
    return { ok: null, err: errOf(e) };
  }
}
const one = async <T>(c: PoolClient, sql: string, args: unknown[] = []) => (await c.queryObject<T>(sql, args)).rows[0];

const stamped = (m: CredibilityModel, family: string, score: number, primary = false): SourceScore => ({
  family, score, reasons: [], model_version: m.modelVersion,
  signals: family === "general"
    ? { author_identity: null, domain_class: "general", primary, link_structure: { inbound_corroborations: 0, found_via: 0 },
      entailment_agreement: { supports: 0, partial: 0, unsupported: 0 } }
    : { cited_by: null, author_works_count: null, age_years: null },
});
interface Cited { family: string; score: number; primary?: boolean; received?: number[] }
const tsLine = (m: CredibilityModel, kind: string, cited: Cited[]) =>
  lineCredibility(m, kind, 1, "supports", cited.map((x, i) => ({
    total: foldReceived(weightedTotal(m, kind, stamped(m, x.family, x.score, x.primary)).total,
      (x.received ?? []).map((amount, j) => ({ from: `g${i}.${j}`, claim: "line", amount })), new Set()),
  })));
const r3 = (x: number) => Math.round(x * 1000) / 1000;
/** attempt 2's TS rule, to find the inputs whose verdict it flipped */
function attempt2Below(m: CredibilityModel, kind: string, g: number, primary: boolean, p: number): boolean {
  const wg = m.weights.get(`${kind}.general`)!, ws = m.weights.get(`${kind}.scholarly`)!;
  const tg = r3(Math.min(1, wg.weight * Math.min(1, g + (primary ? wg.primaryBonus : 0))));
  const tp = r3(Math.min(1, ws.weight * Math.min(1, p)));
  const [lead, second] = tg >= tp ? [tg, tp] : [tp, tg];
  return r3(Math.min(1, lead + Math.min(m.corroboration.claimCap, m.corroboration.claimPer * second))) < 0.5;
}

/** Insert stamped sources in one statement; returns their ids in order. */
async function stampedSources(c: PoolClient, rows: Array<{ family: string; score: number; primary?: boolean; tag: string }>): Promise<string[]> {
  const xs = rows.map((r) => ({
    id: id(), url: `https://twin.attempt3.example/${r.tag}/${crypto.randomUUID().slice(0, 8)}`,
    meta: { credibility: { family: r.family, score: r.score, signals: r.family === "general" ? { primary: !!r.primary } : {}, model_version: "t3" } },
  }));
  await c.queryObject(
    `INSERT INTO public.sources (id, url, title, content, domain, metadata)
     SELECT x.id, x.url, x.url, 'c', 'twin.attempt3.example', x.meta FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, url text, meta jsonb)`,
    [JSON.stringify(xs)]);
  return xs.map((x) => x.id);
}
/** Claims of a kind, each grounded by its sources (first 'states', the rest 'corroborates'). */
async function claims(c: PoolClient, rows: Array<{ kind: string; sources: string[] }>): Promise<string[]> {
  const cs = rows.map((r, i) => ({ id: id(), text: `attempt 3 twin claim ${i} ${crypto.randomUUID().slice(0, 6)}`, kind: r.kind, sources: r.sources }));
  await c.queryObject(
    `INSERT INTO public.claims (id, text, metadata, volatility)
     SELECT x.id, x.text, jsonb_build_object('claim_kind', x.kind), 'slow' FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, text text, kind text)`,
    [JSON.stringify(cs.map(({ id, text, kind }) => ({ id, text, kind })))]);
  const edges = cs.flatMap((x) => x.sources.map((s, j) => ({ c: x.id, s, e: j === 0 ? "states" : "corroborates" })));
  await c.queryObject(
    `INSERT INTO public.claim_sources (claim_id, source_id, edge_type)
     SELECT x.c, x.s, x.e FROM jsonb_to_recordset($1::jsonb) AS x(c uuid, s uuid, e text)`, [JSON.stringify(edges)]);
  return cs.map((x) => x.id);
}
async function sqlTotals(c: PoolClient, ids: string[]) {
  const r = await c.queryObject<{ id: string; v: number; f: number }>(
    `SELECT x.id::text AS id, public.claim_confidence_d15(x.id) AS v, public.credibility_claim_floor(k.kind) AS f
       FROM unnest($1::uuid[]) AS x(id), LATERAL public.claim_kind_of(x.id) k`, [ids]);
  return new Map(r.rows.map((x) => [x.id, { v: Number(x.v), below: Number(x.v) < Number(x.f) }]));
}

// ── 1. THE FINDING: one rule, both twins, the same rows ─────────────────────────────────────────
t("attempt 3: the SQL claim total == the TS line total on the same stamped rows - every attempt-2 flip and a grid over every kind, to 1e-9 with the same floor verdict (and the view, and the stored confidence)", async () => {
  const report = await inTx(async (c) => {
    const m = await loadCredibilityModel(c);
    // the tester's sweep (general 0.05-0.62 +/- primary, paper 0.600-1.000) over EVERY kind: all the
    // inputs attempt 2 flipped, plus every 97th point of the grid, plus the two the tester named
    const picks: Array<{ kind: string; g: number; primary: boolean; p: number; flip: boolean }> = [];
    let k = 0;
    for (const kind of m.kinds.map((x) => x.key)) {
      for (let gi = 5; gi <= 62; gi++) for (const primary of [false, true]) for (let pi = 600; pi <= 1000; pi++) {
        const g = gi / 100, p = pi / 1000;
        const ts = tsLine(m, kind, [{ family: "scholarly", score: p }, { family: "general", score: g, primary }]);
        const flip = attempt2Below(m, kind, g, primary, p) !== ts.below_floor;
        const named = kind === "release" && !primary && ((g === 0.1 && p === 0.999) || (g === 0.11 && p === 0.988));
        if (flip || named || k++ % 97 === 0) picks.push({ kind, g, primary, p, flip });
      }
    }
    const gens = new Map<string, number>(), papers = new Map<number, number>();
    const genRows: Array<{ family: string; score: number; primary: boolean; tag: string }> = [];
    const paperRows: Array<{ family: string; score: number; tag: string }> = [];
    for (const x of picks) {
      const gk = `${x.g}/${x.primary}`;
      if (!gens.has(gk)) { gens.set(gk, genRows.length); genRows.push({ family: "general", score: x.g, primary: x.primary, tag: "g" }); }
      if (!papers.has(x.p)) { papers.set(x.p, paperRows.length); paperRows.push({ family: "scholarly", score: x.p, tag: "p" }); }
    }
    const gIds = await stampedSources(c, genRows), pIds = await stampedSources(c, paperRows);
    const cIds = await claims(c, picks.map((x) => ({ kind: x.kind, sources: [pIds[papers.get(x.p)!], gIds[gens.get(`${x.g}/${x.primary}`)!]] })));
    const sql = await sqlTotals(c, cIds);
    const view = new Map((await c.queryObject<{ id: string; v: number; b: boolean }>(
      `SELECT claim_id::text AS id, after_confidence AS v, below_floor_after AS b FROM public.credibility_before_after WHERE claim_id = ANY($1::uuid[])`,
      [cIds])).rows.map((x) => [x.id, x]));
    // the stored twin after the flip (as the owner, inside this rolled-back transaction)
    await c.queryArray(`UPDATE public.credibility_trigger_state SET model = 'd15'`);
    await c.queryObject(`SELECT count(public.recompute_claim_confidence(x)) FROM unnest($1::uuid[]) x`, [cIds]);
    const stored = new Map((await c.queryObject<{ id: string; v: number; f: number }>(
      `SELECT cl.id::text AS id, cl.confidence::float8 AS v, public.credibility_claim_floor(cl.metadata ->> 'claim_kind') AS f
         FROM public.claims cl WHERE cl.id = ANY($1::uuid[])`, [cIds])).rows.map((x) => [x.id, x]));
    const bad: string[] = [];
    let maxDiff = 0, bitEqual = 0;
    picks.forEach((x, i) => {
      const ts = tsLine(m, x.kind, [{ family: "scholarly", score: x.p }, { family: "general", score: x.g, primary: x.primary }]);
      const s = sql.get(cIds[i])!, v = view.get(cIds[i])!, st = stored.get(cIds[i])!;
      const d = Math.abs(s.v - ts.total);
      maxDiff = Math.max(maxDiff, d);
      if (s.v === ts.total) bitEqual++;
      const label = `${x.kind} general ${x.g}${x.primary ? " primary" : ""} paper ${x.p}`;
      if (d > 1e-9) bad.push(`${label}: SQL ${s.v} TS ${ts.total}`);
      if (s.below !== ts.below_floor) bad.push(`${label}: SQL below=${s.below} TS below=${ts.below_floor}`);
      if (Number(v.v) !== s.v || v.b !== ts.below_floor) bad.push(`${label}: view ${v.v}/${v.b} TS ${ts.total}/${ts.below_floor}`);
      if ((Number(st.v) < Number(st.f)) !== ts.below_floor) bad.push(`${label}: stored ${st.v} on the other side of ${st.f} (TS ${ts.total})`);
    });
    const named = picks.findIndex((x) => x.kind === "release" && x.g === 0.1 && x.p === 0.999 && !x.primary);
    return { n: picks.length, flips: picks.filter((x) => x.flip).length, bad, maxDiff, bitEqual,
      named: { sql: sql.get(cIds[named])!, ts: tsLine(m, "release", [{ family: "scholarly", score: 0.999 }, { family: "general", score: 0.1 }]) } };
  });
  console.log(`compared ${report.n} claims (${report.flips} of them flipped under attempt 2); max |SQL - TS| = ${report.maxDiff}; bit-identical ${report.bitEqual}/${report.n}`);
  console.log(`release general 0.1 paper 0.999: SQL ${report.named.sql.v} below=${report.named.sql.below} | TS ${report.named.ts.total} below=${report.named.ts.below_floor}`);
  assertEquals(report.bad.slice(0, 8), [], `${report.bad.length} disagreements`);
  assert(report.flips >= 216, `the sweep covers the attempt-2 flips (${report.flips})`);
  assertEquals(report.named.sql.below, true);
  assertEquals(report.named.ts.below_floor, true);
});

t("attempt 3: received amounts sum in one order (descending) in both twins - three insertion orders, one total", async () => {
  const r = await inTx(async (c) => {
    const m = await loadCredibilityModel(c);
    // attempt 4: 2e-9, not 1e-12 - an amount is 0 or in [1e-9, 1] (the representable range)
    const amounts = [0.1, 0.2, 0.3, 0.07, 0.013, 2e-9];
    const orders = [amounts, [...amounts].reverse(), [0.2, 2e-9, 0.013, 0.3, 0.1, 0.07]];
    const out: Array<{ sql: number; ts: number }> = [];
    for (const order of orders) {
      const [recv] = await stampedSources(c, [{ family: "general", score: 0.05, tag: "recv" }]);
      const givers = await stampedSources(c, order.map(() => ({ family: "general", score: 0.3, tag: "giver" })));
      for (const [j, amount] of order.entries()) {
        await c.queryObject(`INSERT INTO public.source_corroborations (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version)
                             VALUES ($1, $2, 'weak', $3, 'another line', 'practical', 'supports', 't3')`, [givers[j], recv, amount]);
      }
      const [cl] = await claims(c, [{ kind: "practical", sources: [recv] }]);
      out.push({ sql: (await sqlTotals(c, [cl])).get(cl)!.v, ts: tsLine(m, "practical", [{ family: "general", score: 0.05, received: order }]).total });
    }
    return out;
  });
  for (const x of r) assertEquals(x.sql, x.ts, JSON.stringify(r));
  assertEquals(new Set(r.map((x) => x.sql)).size, 1, `the insertion order changed the total: ${JSON.stringify(r)}`);
});

t("attempt 3: an owner-tuned weight of 0.4996 (and 0.49999999) is the same number below the floor in the view, the stored confidence and the TS twin", async () => {
  const rows = await inTx(async (c) => {
    const out: Array<Record<string, unknown>> = [];
    for (const w of [0.4996, 0.49999999]) {
      await c.queryArray("SAVEPOINT w");
      await c.queryObject(`UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{weight}', $1::jsonb)
                            WHERE registry = 'credibility_weights' AND key = 'release.general'`, [JSON.stringify(w)]);
      const m = await loadCredibilityModel(c);
      const [s] = await stampedSources(c, [{ family: "general", score: 1, tag: "tuned" }]);
      const [cl] = await claims(c, [{ kind: "release", sources: [s] }]);
      const v = await one<{ after: number; b: boolean }>(c, `SELECT after_confidence AS after, below_floor_after AS b FROM public.credibility_before_after WHERE claim_id = $1`, [cl]);
      await c.queryArray(`UPDATE public.credibility_trigger_state SET model = 'd15'`);
      const st = await one<{ v: number }>(c, `SELECT public.recompute_claim_confidence($1)::float8 AS v`, [cl]);
      const ts = tsLine(m, "release", [{ family: "general", score: 1 }]);
      out.push({ w, view: Number(v.after), view_below: v.b, stored: Number(st.v), stored_below: Number(st.v) < 0.5, ts: ts.total, ts_below: ts.below_floor });
      await c.queryArray("ROLLBACK TO SAVEPOINT w");
    }
    return out;
  });
  console.log(JSON.stringify(rows));
  for (const r of rows) {
    assertEquals([r.view, r.ts], [r.w, r.w], JSON.stringify(r));
    assertEquals([r.view_below, r.stored_below, r.ts_below], [true, true, true], JSON.stringify(r));
  }
});

// ── 2. numbers at the edge: refused by both, or accepted by both with one value ─────────────────
async function probe(c: PoolClient, mutate: string[], opts: { dropChecks?: boolean } = {}) {
  await c.queryArray("SAVEPOINT p");
  try {
    if (opts.dropChecks) {
      await c.queryArray(`ALTER TABLE public.contract_registry_entries DROP CONSTRAINT IF EXISTS contract_registry_entries_credibility_weight_ok`);
      await c.queryArray(`DROP INDEX IF EXISTS public.uq_credibility_weights_kind_family`);
      await c.queryArray(`DROP INDEX IF EXISTS public.uq_paper_score_versions_one_active`);
    }
    for (const sql of mutate) await c.queryArray(sql);
    const [s] = await stampedSources(c, [{ family: "general", score: 1, tag: "probe" }]);
    const [cl] = await claims(c, [{ kind: "practical", sources: [s] }]);
    const sqlRoll = await attempt(c, () => one<{ v: number }>(c, `SELECT public.source_rolling_total($1::uuid, 'practical') AS v`, [s]));
    const sqlClaim = await attempt(c, () => one<{ v: number }>(c, `SELECT public.claim_confidence_d15($1::uuid) AS v`, [cl]));
    let tsOut: { total: number | null; err: string };
    try {
      const m = await loadCredibilityModel(c);
      tsOut = { total: weightedTotal(m, "practical", stamped(m, "general", 1)).total, err: "" };
    } catch (e) { tsOut = { total: null, err: errOf(e) }; }
    return {
      sql: sqlRoll.err || sqlClaim.err ? `REFUSED ${sqlRoll.err || sqlClaim.err}` : `${Number(sqlRoll.ok!.v)}`,
      ts: tsOut.err ? `REFUSED ${tsOut.err}` : `${tsOut.total}`,
    };
  } finally { await c.queryArray("ROLLBACK TO SAVEPOINT p"); }
}
const setWeight = (raw: string) => `UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{weight}', '${raw}'::jsonb)
                                     WHERE registry = 'credibility_weights' AND key = 'practical.general'`;

t("attempt 3: a credibility number is 0 or in [1e-9, 1] in BOTH twins - 1e-50 / 1e-400 / 1e-10 refused by both (and the CHECK), 1e-9 and 1.0000000000000000001 accepted by both with one value", async () => {
  const problems: string[] = [];
  await inTx(async (c) => {
    for (const raw of ["1e-50", "1e-400", "-1e-400", "1e-10", "5e-324"]) {
      const r = await probe(c, [setWeight(raw)], { dropChecks: true });
      if (!/^REFUSED .*(not a number in \[0, 1\]|malformed)/.test(r.sql)) problems.push(`${raw}: SQL ${r.sql}`);
      if (!/^REFUSED .*below 1e-9/.test(r.ts)) problems.push(`${raw}: TS ${r.ts}`);
      const w = await attempt(c, () => c.queryArray(setWeight(raw)));
      if (!/contract_registry_entries_credibility_weight_ok/.test(w.err)) problems.push(`${raw}: the CHECK let it in (${w.err || "ACCEPTED"})`);
    }
    for (const raw of ["1e-9", "0.99999999999999999999", "1.0000000000000000001", "0", "0.4996"]) {
      const r = await probe(c, [setWeight(raw)]);
      if (r.sql.startsWith("REFUSED") || r.ts.startsWith("REFUSED") || Number(r.sql) !== Number(r.ts)) problems.push(`${raw}: SQL ${r.sql} TS ${r.ts}`);
    }
    // an AMOUNT is a DOUBLE in the representable range (attempt 4: 0 or [1e-9, 1] - attempt 3 stored
    // 1e-50, which the stored twin's REAL could not hold): 1e-50 is refused, 1.0000000001e-9 is stored as it is
    const [recv] = await stampedSources(c, [{ family: "general", score: 0.05, tag: "amt" }]);
    const [giver] = await stampedSources(c, [{ family: "general", score: 0.3, tag: "amtg" }]);
    const tiny = await attempt(c, () => c.queryObject(`INSERT INTO public.source_corroborations (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version)
                         VALUES ($1, $2, 'weak', $3, 'l0', 'practical', 'supports', 't3')`, [giver, recv, 1e-50]));
    if (!/source_corroborations_amount_unit/.test(tiny.err)) problems.push(`amount 1e-50: ${tiny.err || "STORED"}`);
    await c.queryObject(`INSERT INTO public.source_corroborations (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version)
                         VALUES ($1, $2, 'weak', $3, 'l', 'practical', 'supports', 't3')`, [giver, recv, 1.0000000001e-9]);
    const back = await one<{ a: number }>(c, `SELECT amount AS a FROM public.source_corroborations WHERE to_source_id = $1`, [recv]);
    if (Number(back.a) !== 1.0000000001e-9) problems.push(`amount 1.0000000001e-9 read back as ${back.a}`);
    const over = await attempt(c, () => c.queryObject(`INSERT INTO public.source_corroborations (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version)
                         VALUES ($1, $2, 'weak', 1.00000001, 'l2', 'practical', 'supports', 't3')`, [giver, recv]));
    if (!/source_corroborations_amount_unit/.test(over.err)) problems.push(`amount 1.00000001: ${over.err || "STORED"}`);
  });
  assertEquals(problems, [], problems.join("\n"));
});

t("attempt 3: registry shapes are refused by BOTH twins - kind 'practical ' / 'Practical', family 'General', two active paper versions, string flags, a non-integer order, a kind without rows, a broken papers_outrank", async () => {
  const problems: string[] = [];
  const weightRow = (key: string, kind: string, family: string) =>
    `INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES ('credibility_weights', '${key}', 'probe',
       '${JSON.stringify({ kind, family, weight: 0.3, admission_floor: 0.2, claim_floor: 0.5 })}')`;
  const shapes: Array<[string, string[], RegExp | null]> = [
    ["kind 'practical '", [weightRow("practical-space.general", "practical ", "general")], /contract_registry_entries_credibility_weight_ok/],
    ["kind 'Practical'", [weightRow("practical-case.general", "Practical", "general")], /contract_registry_entries_credibility_weight_ok/],
    ["family 'General'", [weightRow("practical.general-case", "practical", "General")], /contract_registry_entries_credibility_weight_ok/],
    ["two active paper versions", [`INSERT INTO public.contract_registry_entries (registry, key, label, definition)
       SELECT registry, 'p2', 'p2', definition FROM public.contract_registry_entries WHERE registry = 'paper_score_versions' AND key = 'p1'`],
      /uq_paper_score_versions_one_active/],
    ["active \"true\" (a string)", [`UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{active}', '"true"')
       WHERE registry = 'paper_score_versions' AND key = 'p1'`], null],
    ["fallback \"true\" (a string)", [`UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{fallback}', '"true"')
       WHERE registry = 'claim_kinds' AND key = 'practical'`], null],
    ["domain class order 1.5", [`UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{order}', '1.5')
       WHERE registry = 'domain_classes' AND key = 'news'`], null],
    ["two domain classes on one order", [`UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{order}', '2')
       WHERE registry = 'domain_classes' AND key = 'news'`], null],
    ["a claim kind with no weight rows", [`INSERT INTO public.contract_registry_entries (registry, key, label, definition)
       VALUES ('claim_kinds', 'zz-probe-kind', 'probe', '{"order":50,"cues":[]}')`], null],
    ["papers_outrank broken", [`UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{weight}', '1.0')
       WHERE registry = 'credibility_weights' AND key = 'general_theory.general'`], null],
    ["a family with a weight row for ONE kind only", [`INSERT INTO public.contract_registry_entries (registry, key, label) VALUES ('source_families', 'zz-partial', 'probe')`,
      weightRow("release.zz-partial", "release", "zz-partial")], null],
    ["paper half-point 1e-400", [`UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{author_half}', '1e-400')
       WHERE registry = 'paper_score_versions' AND key = 'p1'`], null],
  ];
  await inTx(async (c) => {
    for (const [label, mutate, writeRefusal] of shapes) {
      const r = await probe(c, mutate, { dropChecks: true });
      if (!r.sql.startsWith("REFUSED")) problems.push(`${label}: SQL computed ${r.sql}`);
      if (!r.ts.startsWith("REFUSED")) problems.push(`${label}: TS built ${r.ts}`);
      if (writeRefusal) {
        const w = await attempt(c, async () => { for (const sql of mutate) await c.queryArray(sql); });
        if (!writeRefusal.test(w.err)) problems.push(`${label}: the write was not refused by ${writeRefusal} (${w.err || "ACCEPTED"})`);
      }
    }
    // the seeded table builds in both (control); so does it with a family REGISTERED without any
    // weight row (P0's expansion by registration: not scored yet, it stops nothing - attempt 2's
    // near-miss "an app-role family INSERT stops every recompute after the flip")
    for (const [label, mutate] of [["control", []], ["a registered family with no weight rows", [
      `INSERT INTO public.contract_registry_entries (registry, key, label) VALUES ('source_families', 'zz-unscored', 'probe')`]]] as Array<[string, string[]]>) {
      const ok = await probe(c, mutate);
      if (ok.sql.startsWith("REFUSED") || ok.ts.startsWith("REFUSED") || Number(ok.sql) !== Number(ok.ts)) problems.push(`${label}: SQL ${ok.sql} TS ${ok.ts}`);
    }
  });
  assertEquals(problems, [], problems.join("\n"));
});

// ── 3. the app roles: the version counter and TRUNCATE ───────────────────────────────────────────
t("attempt 3: an app role cannot relabel the model (contract_registries.version) or TRUNCATE a registry or a credibility table - refused by privilege, not by foreign keys", async () => {
  await (async () => {
    const c = await pool!.connect();
    try {
      await c.queryArray(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
                            CREATE ROLE ob_app_memory NOLOGIN NOSUPERUSER NOBYPASSRLS IN ROLE service_role; END IF; END $$`);
    } finally { c.release(); }
  })();
  const tables = ["contract_registries", "contract_registry_entries", "research_admission_trail", "source_credibility_history",
    "source_corroborations", "credibility_rescore_confirmations", "credibility_trigger_state"];
  const problems: string[] = [];
  for (const role of ["service_role", "ob_app_memory"]) {
    await inTx(async (c) => {
      const before = await one<{ v: string }>(c, `SELECT public.credibility_model_version() AS v`);
      for (const tb of tables) {
        const p = await one<{ t: boolean }>(c, `SELECT has_table_privilege($1, $2, 'TRUNCATE') AS t`, [role, `public.${tb}`]);
        if (p.t) problems.push(`${role} holds TRUNCATE on ${tb}`);
      }
      await c.queryArray(`SET LOCAL ROLE ${role}`);
      const writes: Array<[string, string]> = [
        ["relabel the weights version", `UPDATE public.contract_registries SET version = 77 WHERE name = 'credibility_weights'`],
        ["move the paper registry's version", `UPDATE public.contract_registries SET version = version + 1 WHERE name = 'paper_score_versions'`],
        ["upsert the weights registry", `INSERT INTO public.contract_registries (name, version, owner) VALUES ('credibility_weights', 88, 'x')
                                          ON CONFLICT (name) DO UPDATE SET version = 88`],
        ["delete the weights registry", `DELETE FROM public.contract_registries WHERE name = 'credibility_weights'`],
        ...tables.map((tb) => [`TRUNCATE ${tb}`, `TRUNCATE public.${tb}`] as [string, string]),
      ];
      for (const [label, sql] of writes) {
        const r = await attempt(c, () => c.queryArray(sql));
        if (!/permission denied/.test(r.err)) problems.push(`${role} ${label}: ${r.err || "ALLOWED"}`);
        if (/foreign key/.test(r.err)) problems.push(`${role} ${label}: stopped by a foreign key, not a privilege (${r.err})`);
      }
      // P0's expansion by registration still works (the family insert bumps source_families' version as the caller)
      const fam = await attempt(c, () => c.queryArray(`INSERT INTO public.contract_registry_entries (registry, key, label) VALUES ('source_families', 'probe-family-3', 'p')`));
      if (fam.err) problems.push(`${role} could not register a family: ${fam.err}`);
      await c.queryArray(`RESET ROLE`);
      const after = await one<{ v: string }>(c, `SELECT public.credibility_model_version() AS v`);
      if (after.v !== before.v) problems.push(`${role}: the model label moved ${before.v} -> ${after.v}`);
    });
  }
  assertEquals(problems, [], problems.join("\n"));
});

// ── 4. the cutover: filed_at, server-set ─────────────────────────────────────────────────────────
t("attempt 3: a kindless claim backdated by its writer (created_at / filed_at 2020) is still 'filed after the cutover' (OBC01); only the owner can mark a claim as pre-P3a", async () => {
  const problems: string[] = [];
  await inTx(async (c) => {
    const [s] = await stampedSources(c, [{ family: "general", score: 0.3, tag: "cut" }]);
    const [appClaim, ownerClaim] = [id(), id()];
    await c.queryArray(`SET LOCAL ROLE service_role`);
    await c.queryObject(`INSERT INTO public.claims (id, text, volatility, created_at, filed_at) VALUES ($1, 'kindless backdated by an app', 'slow', '2020-01-01', '2020-01-01')`, [appClaim]);
    const upd = await attempt(c, () => c.queryObject(`UPDATE public.claims SET filed_at = NULL WHERE id = $1`, [appClaim]));
    if (!/permission denied: claims\.filed_at/.test(upd.err)) problems.push(`an app role changed filed_at: ${upd.err || "ALLOWED"}`);
    await c.queryArray(`RESET ROLE`);
    await c.queryObject(`INSERT INTO public.claims (id, text, volatility, created_at, filed_at) VALUES ($1, 'kindless backdated by the owner', 'slow', '2020-01-01', '2020-01-01')`, [ownerClaim]);
    await c.queryObject(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $3, 'states'), ($2, $3, 'states')`, [appClaim, ownerClaim, s]);
    for (const cl of [appClaim, ownerClaim]) {
      const k = await one<{ kind: string | null; basis: string; filed: string }>(c,
        `SELECT k.kind, k.basis, c.filed_at::text AS filed FROM public.claims c, LATERAL public.claim_kind_of(c.id) k WHERE c.id = $1`, [cl]);
      if (k.kind !== null || !/MISSING: filed after the P3a cutover/.test(k.basis)) problems.push(`${cl}: took ${k.kind} (${k.basis}) filed_at ${k.filed}`);
      const r = await attempt(c, () => one(c, `SELECT public.claim_confidence_d15($1::uuid)`, [cl]));
      if (!/has no claim kind \(MISSING/.test(r.err)) problems.push(`${cl}: no loud failure (${r.err || "a score"})`);
    }
    // the owner's explicit marking (the deploy remedy / a pre-P3a claim) is the one way back
    await c.queryObject(`UPDATE public.claims SET filed_at = NULL WHERE id = $1`, [ownerClaim]);
    const k = await one<{ kind: string | null; basis: string }>(c, `SELECT k.kind, k.basis FROM public.claim_kind_of($1) k`, [ownerClaim]);
    if (k.kind !== "practical" || !/filed before P3a/.test(k.basis)) problems.push(`owner marking: ${k.kind} (${k.basis})`);
  });
  assertEquals(problems, [], problems.join("\n"));
});

// ── 5. the re-score gate: one confirmation per view, applied once ───────────────────────────────
t("attempt 3: rescore-gate.ts --apply twice records ONE confirmation and re-scores once; the database half is idempotent too", async () => {
  const { runGate } = await import("./rescore-gate.ts");
  const out = await inTx(async (c) => {
    // a view no confirmation exists for yet: one more claim
    const [s] = await stampedSources(c, [{ family: "general", score: 0.3, tag: "gate" }]);
    await claims(c, [{ kind: "practical", sources: [s] }]);
    const cur = await one<{ d: string; m: string }>(c, `SELECT public.credibility_before_after_digest() AS d, public.credibility_model_version() AS m`);
    const findings = `# findings\n\nD15-RESCORE-CONFIRMED digest=${cur.d} model="${cur.m}" by=operator date=2026-10-18\n`;
    const first = await runGate(c, findings, "findings/rw-p3a-entail.md", true);
    const rows1 = await one<{ n: number; applied: number | null }>(c,
      `SELECT count(*)::int AS n, max(applied_claims) AS applied FROM public.credibility_rescore_confirmations WHERE view_digest = $1`, [cur.d]);
    const second = await runGate(c, findings, "findings/rw-p3a-entail.md", true);
    const rows2 = await one<{ n: number; applied: number | null }>(c,
      `SELECT count(*)::int AS n, max(applied_claims) AS applied FROM public.credibility_rescore_confirmations WHERE view_digest = $1`, [cur.d]);
    const again = await one<{ id1: string; id2: string; n: number }>(c,
      `SELECT public.credibility_record_confirmation($1, 'operator', 'f', 'line')::text AS id1,
              public.credibility_record_confirmation($1, 'operator2', 'f', 'another line')::text AS id2,
              public.credibility_apply_d15_trigger($1) AS n`, [cur.d]);
    const rows3 = await one<{ n: number }>(c, `SELECT count(*)::int AS n FROM public.credibility_rescore_confirmations WHERE view_digest = $1`, [cur.d]);
    return { first, second, rows1, rows2, again, rows3 };
  });
  console.log(JSON.stringify({ first: out.first.out, second: out.second.out, rows: [out.rows1, out.rows2, out.rows3] }));
  assertEquals([out.first.code, out.second.code], [0, 0]);
  assert(out.first.out.some((l) => /applied: the trigger now uses/.test(l)), out.first.out.join("\n"));
  assert(out.second.out.some((l) => /already applied: .*nothing recorded, nothing re-scored/.test(l)), out.second.out.join("\n"));
  assertEquals(out.rows1.n, 1);
  assertEquals(out.rows2, out.rows1, "the second --apply changed the confirmations");
  assertEquals(out.again.id1, out.again.id2, "a second confirmation of the same view minted a row");
  assertEquals(Number(out.again.n), 0, "an already-applied view was re-scored again");
  assertEquals(out.rows3.n, 1);
});

// ── 6. the fold path scrubs what it stores ─────────────────────────────────────────────────────
t("attempt 3: fold_held_source, called through foldHeld, stores no credential-shaped reason (metadata and the trail event)", async () => {
  const { foldHeld } = await import("./kb.ts");
  const key = `SECRETKEY-${crypto.randomUUID().slice(0, 8)}`;
  const stored = await inTx(async (c) => {
    const refinery = id(), held = id();
    await c.queryObject(`INSERT INTO public.ideas (id, title) VALUES ($1, 'p3a attempt 3 fold')`, [refinery]);
    await c.queryObject(`INSERT INTO public.held_sources (id, refinery_id, url, title, content) VALUES ($1, $2, 'https://held3.example.edu/r', 'h', 'b')`, [held, refinery]);
    await foldHeld(c, held, { family: "general", score: 0.4, reasons: [`OpenAlex 401 bare ${key} rejected`, `see https%3A%2F%2Fapi.openalex.org%2Fw%3Fapi_key%3D${key}`] }, null);
    const m = await one<{ m: string; t: string }>(c,
      `SELECT s.metadata::text AS m, (SELECT string_agg(detail::text, ' ') FROM public.source_trail_events WHERE source_id = s.id) AS t
         FROM public.sources s WHERE s.id = $1`, [held]);
    return `${m.m} ${m.t}`;
  });
  assert(!stored.includes(key), `the fold stored the key: ${stored}`);
  assert(/reason redacted/.test(stored), stored);
});

Deno.test({ name: "close the pool (attempt 3 file)", ignore: !HOST, fn: async () => { await pool!.end(); }, sanitizeOps: false, sanitizeResources: false });
