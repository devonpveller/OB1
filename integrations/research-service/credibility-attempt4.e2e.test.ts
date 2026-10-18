/**
 * rw-p3a-entail attempt 4 (bounded round) over a REAL database - tester t-rw-p3a-3's findings F1 and
 * F2 and the near-misses tied to bar (c). SKIPPED unless CRED_E2E_DB_HOST is set; run-credibility-e2e.ps1
 * runs it after credibility-twins.e2e.test.ts on the same DISPOSABLE database. Every case runs in ONE
 * transaction that is rolled back.
 *
 * THE REPRESENTABLE RANGE (F1): every credibility number either twin reads as an input - registry
 * numbers, stamped scores, corroboration amounts, edge weights - is 0 or in [1e-9, 1], refused at
 * write by a CHECK and the TS writers, refused at read by both; the stored twin stores a total below
 * the smallest normal float4 as 0 (never 22003), and credibility.ts storeConfidence is its view.
 * ONE LINE FORMULA (F2): the pipeline scores a line through the edges the curator files for it, so
 * per filed claim: line total == claim_confidence_d15 == the view; storeConfidence(line total) == the
 * stored REAL, bit for bit; and the report footer / research_jobs.metrics.credibility (reportCredibility)
 * equal what the stored claims say.
 *
 * The case 24 extension FILES the claims through the curator's own writeClaims (research-curator/claims.ts,
 * imported from CURATOR_DIR - the runner mounts it read-only - or ../research-curator beside the checkout).
 * Written to also run against attempt 3's code (fallbacks below), which is how its RED was recorded.
 * Run (by the runner): deno test --allow-net --allow-env --allow-read credibility-attempt4.e2e.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Pool, type PoolClient } from "postgres";
import * as C from "./credibility.ts";
import { applyVerdicts, citedLines, type LineVerdict } from "./entailment.ts";

const HOST = Deno.env.get("CRED_E2E_DB_HOST");
const pool = HOST
  ? new Pool({ hostname: HOST, port: Number(Deno.env.get("CRED_E2E_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CRED_E2E_DB_USER") ?? "postgres", password: Deno.env.get("CRED_E2E_DB_PASSWORD") ?? "" }, 2, true)
  : null;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore: !HOST, fn, sanitizeOps: false, sanitizeResources: false });
const errOf = (e: unknown) => String((e as Error)?.message ?? e);
const id = () => crypto.randomUUID();
type M = C.CredibilityModel;
// deno-lint-ignore no-explicit-any
const X = C as any;

// ── attempt 3 fallbacks (RED runs only): what the pipeline did there ────────────────────────────────
const filedLine: (m: M, kind: string, v: { line: number; tag: string; cites: number[]; verdict: string }, st: (n: number) => number | null) => C.LineCredibility =
  X.filedLineCredibility ??
  ((m: M, kind: string, v: { line: number; cites: number[]; verdict: string }, st: (n: number) => number | null) =>
    C.lineCredibility(m, kind, v.line, v.verdict, v.cites.filter((n) => st(n) !== null).map((n) => ({ total: st(n)! }))));
const storeView: (total: number, floor: number | null) => number = X.storeConfidence ?? ((x: number) => Math.fround(x));

async function curator() {
  const dir = Deno.env.get("CURATOR_DIR");
  const url = dir ? `file://${dir.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}/claims.ts` : new URL("../research-curator/claims.ts", import.meta.url).href;
  return await import(url) as { writeClaims: (c: unknown, s: string, o: Record<string, unknown>) => Promise<{ claimIds: string[]; metaSkipped: number }> };
}

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
async function ensureAppRole(): Promise<void> {
  const c = await pool!.connect();
  try {
    await c.queryArray(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
                          CREATE ROLE ob_app_memory NOLOGIN NOSUPERUSER NOBYPASSRLS IN ROLE service_role; END IF; END $$`);
  } finally { c.release(); }
}

interface Src { id: string; family: string; score: number; primary: boolean }
async function insertSources(c: PoolClient, rows: Array<{ family: string; score: number; primary?: unknown; tag: string }>): Promise<string[]> {
  const xs = rows.map((r) => ({
    id: id(), url: `https://twin.attempt4.example/${r.tag}/${crypto.randomUUID().slice(0, 8)}`,
    meta: { credibility: { family: r.family, score: r.score, signals: r.family === "general" ? { primary: r.primary ?? false } : {}, model_version: "t4" } },
  }));
  await c.queryObject(
    `INSERT INTO public.sources (id, url, title, content, domain, metadata)
     SELECT x.id, x.url, x.url, 'c', 'twin.attempt4.example', x.meta FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, url text, meta jsonb)`,
    [JSON.stringify(xs)]);
  return xs.map((x) => x.id);
}
const stamped = (family: string, score: number, primary: unknown = false): C.SourceScore => ({
  family, score, reasons: [], model_version: "t4",
  signals: family === "general"
    ? { author_identity: null, domain_class: "general", primary: primary as boolean, link_structure: { inbound_corroborations: 0, found_via: 0 },
      entailment_agreement: { supports: 0, partial: 0, unsupported: 0 } }
    : { cited_by: null, author_works_count: null, age_years: null },
});
const corrInsert = `INSERT INTO public.source_corroborations (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version)
                    VALUES ($1, $2, 'weak', $3, $4, 'practical', 'supports', 't4')`;

// ── F1: the representable range ────────────────────────────────────────────────────────────────────
t("attempt 4 F1: amounts, edge weights and stamps outside 0 / [1e-9, 1] are refused AT WRITE for the owner and both app roles (attempt 3 stored 5e-324 and 1e-45)", async () => {
  await ensureAppRole();
  const problems: string[] = [];
  for (const role of ["postgres", "service_role", "ob_app_memory"]) {
    await inTx(async (c) => {
      const [recv, giver, s] = await insertSources(c, [{ family: "general", score: 0, tag: "recv" }, { family: "general", score: 0.3, tag: "giver" },
        { family: "general", score: 0.4, tag: "edge" }]);
      const cl = id();
      await c.queryObject(`INSERT INTO public.claims (id, text, metadata, volatility) VALUES ($1, $2, '{"claim_kind":"practical"}', 'slow')`, [cl, `a4 ${cl}`]);
      if (role !== "postgres") await c.queryArray(`SET LOCAL ROLE ${role}`);
      for (const a of [5e-324, 1e-46, 1e-45, 1e-10, 9.99e-10, 1.0000001]) {
        const r = await attempt(c, () => c.queryObject(corrInsert, [giver, recv, a, `line ${a}`]));
        if (!/source_corroborations_amount_unit/.test(r.err)) problems.push(`${role} amount ${a}: ${r.err || "STORED"}`);
      }
      for (const a of [0, 1e-9, 0.5, 1]) {
        const r = await attempt(c, () => c.queryObject(corrInsert, [giver, recv, a, `ok line ${a}`]));
        if (r.err) problems.push(`${role} amount ${a} refused: ${r.err}`);
      }
      for (const w of ["1e-45", "NaN", "Infinity", "5", "-1", "1e-9"]) {   // 1e-9 as REAL is 9.99999971718e-10
        const r = await attempt(c, () => c.queryObject(`SELECT public.link_claim_to_source($1, $2, 'states', $3::real)`, [cl, s, w]));
        if (!/claim_sources_weight_credibility/.test(r.err)) problems.push(`${role} edge weight ${w}: ${r.err || "STORED"}`);
      }
      for (const w of ["0", "0.5", "1", "2e-9"]) {
        const r = await attempt(c, () => c.queryObject(`SELECT public.link_claim_to_source($1, $2, 'states', $3::real)`, [cl, s, w]));
        if (r.err) problems.push(`${role} edge weight ${w} refused: ${r.err}`);
      }
      for (const [label, meta] of [["score 5e-324", { credibility: { family: "general", score: 5e-324 } }], ["score 1e-10", { credibility: { family: "general", score: 1e-10 } }],
        ["primary \"true\"", { credibility: { family: "general", score: 0.4, signals: { primary: "true" } } }],
        ["primary 1", { credibility: { family: "general", score: 0.4, signals: { primary: 1 } } }]] as Array<[string, unknown]>) {
        const r = await attempt(c, () => c.queryObject(`UPDATE public.sources SET metadata = $2::jsonb WHERE id = $1`, [s, JSON.stringify(meta)]));
        if (!/sources_credibility_stamp_ok/.test(r.err)) problems.push(`${role} stamp ${label}: ${r.err || "STORED"}`);
      }
    });
  }
  assertEquals(problems, [], problems.join("\n"));
});

t("attempt 4 F1: the stored twin never raises 22003 - credibility_store_confidence == credibility.ts storeConfidence bit for bit, a sub-normal total stores 0 on the floor's side", async () => {
  const cases: Array<[number, number | null]> = [[5e-324, 0.5], [1e-46, 0.5], [1e-45, 0.5], [1e-40, 0.5], [1e-40, 0], [2 ** -127, 1e-9], [2 ** -126, 0.5],
    [1e-37, 0.5], [0, 0.5], [0, 0], [0.49999999, 0.5], [0.5, 0.5], [0.402, 0.5], [0.4995500147342682, 0.5], [0.6, null], [1, 0.5], [1e-9, 1e-9]];
  const rows = await inTx((c) => Promise.all(cases.map(async ([total, floor]) => {
    const r = await attempt(c, () => one<{ v: number }>(c, `SELECT public.credibility_store_confidence($1::float8, $2::float8)::float8 AS v`, [total, floor]));
    return { total, floor, sql: r.err ? `ERR ${r.err}` : Number(r.ok!.v), ts: storeView(total, floor) };
  })));
  console.log(JSON.stringify(rows));
  for (const r of rows) {
    assertEquals(r.sql, r.ts, JSON.stringify(r));
    if (r.floor !== null) assertEquals((r.ts as number) < r.floor, r.total < r.floor, `${JSON.stringify(r)}: the stored value crossed the floor`);
  }
});

t("attempt 4 F1: the tester's flow - a claim at the bottom of the range re-scores through the gate and is filed after the flip (attempt 3: 22003 aborted both)", async () => {
  const out = await inTx(async (c) => {
    // the smallest admissible numbers everywhere: weight 1e-9, a stamped 1e-9 score, an edge weight just
    // above 1e-9 as a REAL, an inferred_from factor of 1e-9 - the claim total is ~1e-36, as small as the
    // representable range allows
    await c.queryArray(`UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{weight}', '1e-9') WHERE registry = 'credibility_weights' AND key = 'practical.general'`);
    await c.queryArray(`UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{inferred_from}', '1e-9') WHERE registry = 'credibility_terms' AND key = 'edge_factors'`);
    const m = await C.loadCredibilityModel(c);
    const [s] = await insertSources(c, [{ family: "general", score: 1e-9, tag: "tiny" }]);
    const cl = id();
    await c.queryObject(`INSERT INTO public.claims (id, text, metadata, volatility) VALUES ($1, $2, '{"claim_kind":"practical"}', 'slow')`, [cl, `a4 tiny ${cl}`]);
    await c.queryObject(`SELECT public.link_claim_to_source($1, $2, 'inferred_from', 2e-9::real)`, [cl, s]);
    const sql = Number((await one<{ v: number }>(c, `SELECT public.claim_confidence_d15($1) AS v`, [cl])).v);
    // the stored edge weight here is 2e-9 (not a curator weight), so the per-edge term is computed directly
    const tsEdge = X.edgeTotal ? X.edgeTotal(m, C.weightedTotal(m, "practical", stamped("general", 1e-9)).total, "inferred_from", 2e-9) : null;
    const d = await one<{ d: string; m: string }>(c, `SELECT public.credibility_before_after_digest() AS d, public.credibility_model_version() AS m`);
    await c.queryObject(`SELECT public.credibility_record_confirmation($1, 'operator', 'findings', 'line')`, [d.d]);
    const applied = await attempt(c, () => one<{ n: number }>(c, `SELECT public.credibility_apply_d15_trigger($1) AS n`, [d.d]));
    const stored = await one<{ v: number }>(c, `SELECT confidence::float8 AS v FROM public.claims WHERE id = $1`, [cl]);
    const cl2 = id();
    await c.queryObject(`INSERT INTO public.claims (id, text, metadata, volatility) VALUES ($1, $2, '{"claim_kind":"practical"}', 'slow')`, [cl2, `a4 tiny2 ${cl2}`]);
    await c.queryArray(`SET LOCAL ROLE ob_app_memory`);
    const filed = await attempt(c, () => c.queryObject(`SELECT public.link_claim_to_source($1, $2, 'inferred_from', 2e-9::real)`, [cl2, s]));
    await c.queryArray(`RESET ROLE`);
    return { sql, tsEdge, applied: applied.err || Number(applied.ok!.n), stored: Number(stored.v), filed: filed.err || "ok" };
  });
  console.log(JSON.stringify(out));
  assert(typeof out.applied === "number" && out.applied > 0, `the gated re-score: ${out.applied}`);
  assertEquals(out.filed, "ok");
  assertEquals(out.tsEdge, out.sql, "the TS twin of the per-edge term");
  assertEquals(out.stored, storeView(out.sql, 0.5));
});

t("attempt 4 F1: a row outside the range that got in anyway (the owner dropped a CHECK) is refused by BOTH twins at read - never computed by one", async () => {
  const problems: string[] = [];
  await inTx(async (c) => {
    const m = await C.loadCredibilityModel(c);
    await c.queryArray(`ALTER TABLE public.source_corroborations DROP CONSTRAINT source_corroborations_amount_unit`);
    await c.queryArray(`ALTER TABLE public.claim_sources DROP CONSTRAINT claim_sources_weight_credibility`);
    const [recv, giver, s] = await insertSources(c, [{ family: "general", score: 0, tag: "recv" }, { family: "general", score: 0.3, tag: "g" }, { family: "general", score: 0.4, tag: "w" }]);
    await c.queryObject(corrInsert, [giver, recv, 5e-324, "denormal line"]);
    const sqlA = await attempt(c, () => one(c, `SELECT public.source_rolling_total($1, 'practical') AS v`, [recv]));
    let tsA = "";
    try { C.foldReceived(0, [{ from: giver, claim: "denormal line", amount: 5e-324 }], new Set()); } catch (e) { tsA = errOf(e); }
    if (!/not 0 or in \[1e-9, 1\]/.test(sqlA.err) || !/below 1e-9/.test(tsA)) problems.push(`amount 5e-324: SQL ${sqlA.err || "computed"} | TS ${tsA || "computed"}`);
    for (const w of ["NaN", "Infinity", "5", "1e-45"]) {
      const cl = id();
      await c.queryObject(`INSERT INTO public.claims (id, text, metadata, volatility) VALUES ($1, $2, '{"claim_kind":"practical"}', 'slow')`, [cl, `a4 w ${cl}`]);
      await c.queryObject(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type, weight) VALUES ($1, $2, 'states', $3::real)`, [cl, s, w]);
      const sql = await attempt(c, () => one(c, `SELECT public.claim_confidence_d15($1) AS v`, [cl]));
      let ts = "";
      try { X.edgeTotal ? X.edgeTotal(m, 0.4, "states", Number(w)) : (ts = "computed (no edge input)"); } catch (e) { ts = errOf(e); }
      if (!/edge weight that is not 0 or in/.test(sql.err) || !/edge weight/.test(ts)) problems.push(`weight ${w}: SQL ${sql.err || "computed"} | TS ${ts || "computed"}`);
    }
  });
  assertEquals(problems, [], problems.join("\n"));
});

// ── F2: one line formula - the Case 24 sweep extended to every edge the curator files ─────────────
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

t("attempt 4 F2 (case 24 extended): every line the curator files - SOURCED / INFERRED / UNCERTAIN, omnibus, supports / partial / unsupported - line total == claim_confidence_d15 == the view, storeConfidence == the stored REAL, and the footer / metrics == the stored claims", async () => {
  const { writeClaims } = await curator();
  const report = await inTx(async (c) => {
    const m = await C.loadCredibilityModel(c);
    const r = rng(20261018);
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const scoreOf = () => pick([0, 1e-9, 0.1, 0.3, 0.5, 0.6, 0.75, 0.9, 1, r(), r(), r()]);
    const bad: string[] = [];
    let lines = 0, filedN = 0, bitEq = 0, maxDiff = 0;
    const byTag: Record<string, number> = {};
    const reports: Array<{ kind: string; ts: C.ReportCredibility; storedBelow: number; storedMean: number | null }> = [];
    for (const kind of m.kinds.map((k) => k.key)) {
      for (let run = 0; run < 25; run++) {
        // a pool of sources, both families, stamped scores; corroboration received from outside givers
        // and from pool members (the fold rule then excludes co-cited givers in BOTH twins)
        const n = 4 + Math.floor(r() * 5);
        const srcRows = Array.from({ length: n }, (_, i) => ({ family: r() < 0.4 ? "scholarly" : "general", score: scoreOf(), primary: r() < 0.3, tag: `p${i}` }));
        const ids = await insertSources(c, srcRows);
        const outside = await insertSources(c, [{ family: "general", score: 0.3, tag: "out" }, { family: "scholarly", score: 0.8, tag: "out2" }]);
        const received = new Map<string, Array<{ from: string; claim: string; amount: number }>>();
        for (const [j, to] of ids.entries()) {
          const givers = [...outside, ...ids.filter((x) => x !== to)].filter(() => r() < 0.25);
          for (const from of givers) {
            const amount = pick([0, 1e-9, 0.05, 0.1, 0.2, r() * 0.3]);
            const claim = `corr ${j} ${from.slice(0, 8)}`;
            await c.queryObject(corrInsert, [from, to, amount, claim]);
            (received.get(to) ?? received.set(to, []).get(to)!).push({ from, claim, amount });
          }
        }
        // the synthesis: lines of every tag, 1..7 citations (5+ is omnibus), unique world-claim texts
        const synthLines: string[] = [];
        for (let li = 0; li < 10; li++) {
          const tag = pick(["SOURCED", "SOURCED", "INFERRED", "UNCERTAIN"]);
          const k = pick([1, 1, 2, 3, 4, 5, 6, 7].filter((x) => x <= n));
          const cites = [...ids.keys()].map((i) => i + 1).sort(() => r() - 0.5).slice(0, k);
          synthLines.push(`[${tag}] The widget W${run}x${li}x${crypto.randomUUID().slice(0, 6)} ships in size ${li + 3}. [Source ${cites.join(", ")}]`);
        }
        const synthesis = synthLines.join("\n");
        const verdicts: LineVerdict[] = citedLines(synthesis).map((l) => ({
          line: l.index, text: l.text, tag: l.tag, cites: l.cites, verdict: pick(["supports", "supports", "partial", "unsupported"]),
          basis: "judge", rationale: "", cited_text: [],
        }));
        const effects = [...m.verdicts.values()].map((v) => ({ key: v.key, tagEffect: v.tagEffect }));
        const filedSynthesis = applyVerdicts(synthesis, verdicts, effects).synthesis;
        // the pipeline's line totals (harness.ts: foldReceived over the line's co-cited sources, then
        // the filed-line formula)
        const tsLines = verdicts.map((v) => {
          const coCited = new Set(v.cites.map((x) => ids[x - 1]));
          return filedLine(m, kind, v, (x) => {
            const sid = ids[x - 1];
            if (!sid) return null;
            const s = srcRows[x - 1];
            return C.foldReceived(C.weightedTotal(m, kind, stamped(s.family, s.score, s.primary)).total, received.get(sid) ?? [], coCited);
          });
        });
        // the curator files the claims from the filed synthesis, as in production
        await writeClaims(c, filedSynthesis, { threadId: null, synthesisId: null, sourceIds: ids, volatility: "slow", claimMetadata: { claim_kind: kind } });
        const floor = Number((await one<{ f: number }>(c, `SELECT public.credibility_claim_floor($1) AS f`, [kind])).f);
        const storedTotals: number[] = [];
        let storedBelow = 0;
        for (const [i, v] of verdicts.entries()) {
          lines++;
          const ts = tsLines[i];
          const row = await one<{ id: string; tag: string }>(c, `SELECT id::text AS id, epistemic_tag AS tag FROM public.claims WHERE text = $1`, [v.text]);
          const label = `${kind} run ${run} line ${i} ${v.tag}/${v.verdict} cites ${v.cites.length}`;
          if (!row) {
            if (ts.total !== 0) bad.push(`${label}: no claim was filed, TS line total ${ts.total}`);
            storedTotals.push(0); storedBelow++;
            continue;
          }
          filedN++;
          byTag[`${row.tag}/${v.verdict}${v.cites.length > 4 ? "/omnibus" : ""}`] = (byTag[`${row.tag}/${v.verdict}${v.cites.length > 4 ? "/omnibus" : ""}`] ?? 0) + 1;
          const sql = Number((await one<{ v: number }>(c, `SELECT public.claim_confidence_d15($1) AS v`, [row.id])).v);
          const view = await one<{ v: number; b: boolean }>(c, `SELECT after_confidence AS v, below_floor_after AS b FROM public.credibility_before_after WHERE claim_id = $1`, [row.id]);
          maxDiff = Math.max(maxDiff, Math.abs(sql - ts.total));
          if (sql === ts.total) bitEq++;
          else bad.push(`${label} (filed ${row.tag}): SQL ${sql} TS ${ts.total}`);
          if ((sql < floor) !== ts.below_floor || view.b !== ts.below_floor || Number(view.v) !== sql) bad.push(`${label}: verdicts SQL ${sql < floor} view ${view.b} TS ${ts.below_floor}`);
          storedTotals.push(sql);
          if (sql < floor) storedBelow++;
        }
        const tsReport = C.reportCredibility(m, kind, tsLines);
        const storedMean = storedTotals.length ? Math.round(storedTotals.reduce((a, x) => a + x, 0) / storedTotals.length * 1000) / 1000 : null;
        reports.push({ kind, ts: tsReport, storedBelow, storedMean });
        if (tsReport.below_floor !== storedBelow) bad.push(`${kind} run ${run}: metrics.credibility.below_floor ${tsReport.below_floor}, stored ${storedBelow}`);
        if (tsReport.value !== storedMean) bad.push(`${kind} run ${run}: footer ${tsReport.value}, stored ${storedMean}`);
      }
    }
    // the stored twin after the flip: storeConfidence(TS line total) == the stored REAL, bit for bit
    await c.queryArray(`UPDATE public.credibility_trigger_state SET model = 'd15'`);
    const stored = (await c.queryObject<{ id: string; v: number; d15: number; f: number }>(
      `SELECT x.id::text AS id, public.recompute_claim_confidence(x.id)::float8 AS v, public.claim_confidence_d15(x.id) AS d15,
              public.credibility_claim_floor(x.metadata ->> 'claim_kind') AS f
         FROM public.claims x WHERE x.text LIKE 'The widget W%'`)).rows;
    let storedBad = 0;
    for (const s of stored) {
      if (Number(s.v) !== storeView(Number(s.d15), Number(s.f))) { storedBad++; if (storedBad < 5) bad.push(`stored ${s.v} != storeConfidence(${s.d15}) ${storeView(Number(s.d15), Number(s.f))}`); }
      if ((Number(s.v) < Number(s.f)) !== (Number(s.d15) < Number(s.f))) bad.push(`stored ${s.v} crossed the floor (${s.d15})`);
    }
    return { lines, filedN, bitEq, maxDiff, bad, byTag, stored: stored.length, reports: reports.length };
  });
  console.log(`attempt 4 sweep: ${report.lines} lines, ${report.filedN} filed claims, bit-identical ${report.bitEq}/${report.filedN}, max |SQL - TS| = ${report.maxDiff}; ${report.stored} stored after the flip; ${report.reports} footers/metrics compared`);
  console.log(`filed by tag/verdict: ${JSON.stringify(report.byTag)}`);
  assertEquals(report.bad.slice(0, 12), [], `${report.bad.length} disagreements`);
  for (const k of ["sourced/supports", "inferred/supports", "uncertain/supports", "uncertain/partial", "uncertain/supports/omnibus"]) {
    assert((report.byTag[k] ?? 0) > 0, `the sweep files no ${k} claim: ${JSON.stringify(report.byTag)}`);
  }
});

t("attempt 4 F2: the tester's P1 shapes through the curator's own filing - INFERRED 0.402, UNCERTAIN 0.25125, 5-cite SOURCED 0.551 in the line, the claim and the view", async () => {
  const { writeClaims } = await curator();
  const rows = await inTx(async (c) => {
    const m = await C.loadCredibilityModel(c);
    const out: Array<Record<string, unknown>> = [];
    for (const [tag, scores] of [["SOURCED", [0.6]], ["INFERRED", [0.6]], ["UNCERTAIN", [0.75]], ["SOURCED", [0.6, 0.6, 0.6, 0.6, 0.6]]] as Array<[string, number[]]>) {
      const ids = await insertSources(c, scores.map((score, i) => ({ family: "general", score, tag: `p1-${i}` })));
      const text = `The shelf S${crypto.randomUUID().slice(0, 6)} holds ${scores.length} boxes.`;
      const synthesis = `[${tag}] ${text} [Source ${scores.map((_, i) => i + 1).join(", ")}]`;
      const [l] = citedLines(synthesis);
      const ts = filedLine(m, "practical", { line: l.index, tag: l.tag, cites: l.cites, verdict: "supports" },
        (n) => ids[n - 1] ? C.weightedTotal(m, "practical", stamped("general", scores[n - 1])).total : null);
      await writeClaims(c, synthesis, { threadId: null, synthesisId: null, sourceIds: ids, volatility: "slow", claimMetadata: { claim_kind: "practical" } });
      const cl = await one<{ id: string }>(c, `SELECT id::text AS id FROM public.claims WHERE text = $1`, [text]);
      const sql = await one<{ v: number; b: boolean }>(c, `SELECT after_confidence AS v, below_floor_after AS b FROM public.credibility_before_after WHERE claim_id = $1`, [cl.id]);
      out.push({ tag, scores: scores.length, sql: Number(sql.v), sql_below: sql.b, ts: ts.total, ts_below: ts.below_floor });
    }
    return out;
  });
  console.log(rows.map((x) => JSON.stringify(x)).join("\n"));
  for (const x of rows) assertEquals([x.ts, x.ts_below], [x.sql, x.sql_below], JSON.stringify(x));
});

// ── near-misses tied to (c) ──────────────────────────────────────────────────────────────────────────
t("attempt 4 near-miss: the gate digest binds the exact view - a 0.50003 -> 0.49997 stamp flip (and a 0.50003 -> 0.50004 move) changes it", async () => {
  const r = await inTx(async (c) => {
    const [s] = await insertSources(c, [{ family: "general", score: 0.50003, tag: "dg" }]);
    const cl = id();
    await c.queryObject(`INSERT INTO public.claims (id, text, metadata, volatility) VALUES ($1, $2, '{"claim_kind":"practical"}', 'slow')`, [cl, `a4 digest ${cl}`]);
    await c.queryObject(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $2, 'states')`, [cl, s]);
    const d = async () => (await one<{ d: string; b: boolean }>(c,
      `SELECT public.credibility_before_after_digest() AS d, (SELECT below_floor_after FROM public.credibility_before_after WHERE claim_id = $1) AS b`, [cl]));
    const set = (x: number) => c.queryObject(`UPDATE public.sources SET metadata = jsonb_set(metadata, '{credibility,score}', $2::jsonb) WHERE id = $1`, [s, JSON.stringify(x)]);
    const a = await d();
    await c.queryArray(`SET LOCAL ROLE service_role`);
    await set(0.49997);
    await c.queryArray(`RESET ROLE`);
    const b = await d();
    await set(0.50003);
    const a2 = await d();
    await set(0.50004);
    const e = await d();
    return { a, b, a2, e };
  });
  console.log(JSON.stringify(r));
  assertEquals([r.a.b, r.b.b], [false, true], "the stamp change flips the verdict");
  assert(r.a.d !== r.b.d, "a floor-crossing stamp change left the digest unchanged");
  assertEquals(r.a2.d, r.a.d, "the same view gives the same digest");
  assert(r.e.d !== r.a.d, "a sub-4-decimal move left the digest unchanged");
});

t("attempt 4 near-miss P3: a non-boolean `primary` (\"true\" / 1 / \"false\") is refused at write and, past a dropped CHECK, ignored IDENTICALLY by both twins", async () => {
  const rows = await inTx(async (c) => {
    await c.queryArray(`UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{primary_bonus}', '0.02') WHERE registry = 'credibility_weights' AND key = 'practical.general'`);
    const m = await C.loadCredibilityModel(c);
    await c.queryArray(`ALTER TABLE public.sources DROP CONSTRAINT sources_credibility_stamp_ok`);
    const out: Array<Record<string, unknown>> = [];
    for (const p of ["true", 1, "false", true, false]) {
      const [s] = await insertSources(c, [{ family: "general", score: 0.49, primary: p, tag: "prim" }]);
      const sql = Number((await one<{ v: number }>(c, `SELECT public.source_rolling_total($1, 'practical') AS v`, [s])).v);
      out.push({ primary: p, sql, ts: C.weightedTotal(m, "practical", stamped("general", 0.49, p)).total });
    }
    return out;
  });
  console.log(JSON.stringify(rows));
  for (const x of rows) assertEquals(x.sql, x.ts, JSON.stringify(x));
});

t("attempt 4 near-miss: tag_effect [\"keep\"] (an array) is refused by BOTH twins (attempt 3: SQL refused, TS built 0.9)", async () => {
  const r = await inTx(async (c) => {
    await c.queryArray(`UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{tag_effect}', '["keep"]') WHERE registry = 'entailment_verdicts' AND key = 'supports'`);
    const [s] = await insertSources(c, [{ family: "general", score: 0.9, tag: "te" }]);
    const sql = await attempt(c, () => one(c, `SELECT public.source_rolling_total($1, 'practical') AS v`, [s]));
    let ts = "";
    try { await C.loadCredibilityModel(c); } catch (e) { ts = errOf(e); }
    return { sql: sql.err, ts };
  });
  assert(/tag_effect/.test(r.sql) && /tag_effect/.test(r.ts), JSON.stringify(r));
});

Deno.test({ name: "close the pool (attempt 4 file)", ignore: !HOST, fn: async () => { await pool!.end(); }, sanitizeOps: false, sanitizeResources: false });
