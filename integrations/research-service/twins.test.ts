/**
 * ONE scoring rule in both twins (research-workbench P3a attempt 3, rw-p3a-entail; tester
 * t-rw-p3a-2 finding: the TS model rounded each source total and the line total to 3 decimals
 * while the SQL twin did not, so a `release` claim grounded by a paper stamped 0.999 and a general
 * source stamped 0.1 was 0.49955 (below the 0.50 floor) in SQL and 0.5 (not below) in TS).
 *
 * THE RULE (the test plan states it): no number that feeds a total, an amount or a floor
 * comparison is rounded, in either twin. Both compute in IEEE-754 double precision (the SQL twin
 * in DOUBLE PRECISION, never REAL), with the same operations in the same order:
 *   source total  t = min(1, weight x min(1, score + bonus) + S), S = the received amounts summed
 *                 in DESCENDING order from 0 (SQL: sum(amount ORDER BY amount DESC));
 *   claim total   lead + min(cap, 0 + per x t2 + per x t3 ...), totals in descending order, then min(1);
 *   floor         below iff total < max over families of the kind's claim_floor (unrounded).
 * Rounding is display only: reason strings, the report footer, the workbench contract's 4 decimals.
 * The SQL half of every case is credibility-twins.e2e.test.ts (same rows, same numbers, 1e-9 and the
 * same verdict); this file proves the TS half offline.
 * Run: deno test --allow-read twins.test.ts
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildModel, CredibilityGateError, type CredibilityModel, foldReceived, lineCredibility, parseRegistryJson,
  type RegistryRow, type SourceScore, unit, weightedTotal,
} from "./credibility.ts";
import { seedSet } from "./fixtures/credibility-seeds.ts";

const seeds = () => structuredClone(seedSet());
const model = (rows = seeds().rows) => buildModel(rows, seeds().versions);
const withDef = (registry: string, key: string, patch: (d: Record<string, unknown>) => Record<string, unknown>): RegistryRow[] =>
  seeds().rows.map((r) => r.registry === registry && r.key === key ? { ...r, definition: patch({ ...r.definition }) } : r);

const stamped = (m: CredibilityModel, family: string, score: number, primary = false): SourceScore => ({
  family, score, reasons: [], model_version: m.modelVersion,
  signals: family === "general"
    ? { author_identity: null, domain_class: "general", primary, link_structure: { inbound_corroborations: 0, found_via: 0 },
      entailment_agreement: { supports: 0, partial: 0, unsupported: 0 } }
    : { cited_by: null, author_works_count: null, age_years: null },
});

/** The SQL twin's arithmetic (source_rolling_total + claim_confidence_d15), op for op, depth 0. */
function sqlFormula(m: CredibilityModel, kind: string, cited: Array<{ family: string; score: number; primary?: boolean; received?: number[] }>) {
  const totals = cited.map((c) => {
    const w = m.weights.get(`${kind}.${c.family}`)!;
    const bonus = c.family === "general" && c.primary ? w.primaryBonus : 0;
    const base = w.weight * Math.min(1, c.score + bonus);
    const s = [...(c.received ?? [])].sort((a, b) => b - a).reduce((a, x) => a + x, 0);
    return Math.min(1, base + s);
  }).sort((a, b) => b - a);
  let extra = 0;
  for (const t of totals.slice(1)) extra = extra + m.corroboration.claimPer * t;
  const total = Math.max(Math.min((totals[0] + Math.min(extra, m.corroboration.claimCap)) * 1, 1), 0);
  const floor = Math.max(...m.scoredFamilies.map((f) => m.weights.get(`${kind}.${f}`)!.claimFloor));
  return { total, below: total < floor };
}
function tsLine(m: CredibilityModel, kind: string, cited: Array<{ family: string; score: number; primary?: boolean; received?: number[] }>) {
  return lineCredibility(m, kind, 1, "supports", cited.map((c, i) => ({
    total: foldReceived(weightedTotal(m, kind, stamped(m, c.family, c.score, c.primary)).total,
      (c.received ?? []).map((amount, j) => ({ from: `giver-${i}-${j}`, claim: "the line", amount })), new Set()),
  })));
}
/** attempt 2's rule (r3 on each source total and on the line), to find the inputs it flipped. */
const r3 = (x: number) => Math.round(x * 1000) / 1000;
function attempt2Verdict(m: CredibilityModel, kind: string, g: number, primary: boolean, p: number): boolean {
  const wg = m.weights.get(`${kind}.general`)!, ws = m.weights.get(`${kind}.scholarly`)!;
  const tg = r3(Math.min(1, wg.weight * Math.min(1, g + (primary ? wg.primaryBonus : 0))));
  const tp = r3(Math.min(1, ws.weight * Math.min(1, p)));
  const [lead, second] = tg >= tp ? [tg, tp] : [tp, tg];
  return r3(Math.min(1, lead + Math.min(m.corroboration.claimCap, m.corroboration.claimPer * second))) < 0.5;
}

Deno.test("attempt 3 RED shape: release, paper stamped 0.999 + general 0.1 -> 0.49955, BELOW the 0.50 floor (attempt 2: 0.5, not below)", () => {
  const m = model();
  const line = tsLine(m, "release", [{ family: "scholarly", score: 0.999 }, { family: "general", score: 0.1 }]);
  const sql = sqlFormula(m, "release", [{ family: "scholarly", score: 0.999 }, { family: "general", score: 0.1 }]);
  assertEquals(line.total, sql.total);
  assert(Math.abs(line.total - 0.49955) < 1e-12, `line total ${line.total}`);
  assertEquals(line.below_floor, true, `the TS twin says ${line.total} is not below the floor`);
  // the tester's second named input
  assertEquals(tsLine(m, "release", [{ family: "scholarly", score: 0.988 }, { family: "general", score: 0.11 }]).below_floor, true);
});

Deno.test("attempt 3: the TS line total IS the SQL twin's arithmetic, bit for bit, over the tester's whole sweep (and every attempt-2 flip)", () => {
  const m = model();
  let n = 0, flips = 0;
  const bad: string[] = [];
  for (const kind of m.kinds.map((k) => k.key)) {
    for (let gi = 5; gi <= 62; gi++) {
      for (const primary of [false, true]) {
        for (let pi = 600; pi <= 1000; pi++) {
          const g = gi / 100, p = pi / 1000;
          const cited = [{ family: "scholarly", score: p }, { family: "general", score: g, primary }];
          const ts = tsLine(m, kind, cited), sql = sqlFormula(m, kind, cited);
          n++;
          if (attempt2Verdict(m, kind, g, primary, p) !== sql.below) flips++;
          if (ts.total !== sql.total || ts.below_floor !== sql.below) bad.push(`${kind} g=${g} primary=${primary} p=${p}: TS ${ts.total}/${ts.below_floor} SQL ${sql.total}/${sql.below}`);
        }
      }
    }
  }
  assertEquals(bad.slice(0, 5), [], `${bad.length} of ${n} inputs disagree`);
  assert(flips >= 216, `the sweep covers the attempt-2 flips (${flips})`);
  console.log(`swept ${n} inputs; ${flips} of them had flipped under attempt 2's rounding; 0 disagree now`);
});

Deno.test("attempt 3: an owner-tuned weight of 0.4996 is 0.4996 in the TS twin (attempt 2: 0.5), below the floor", () => {
  const m = model(withDef("credibility_weights", "release.general", (d) => ({ ...d, weight: 0.4996 })));
  const line = tsLine(m, "release", [{ family: "general", score: 1 }]);
  assertEquals(line.total, 0.4996);
  assertEquals(line.below_floor, true);
});

Deno.test("attempt 3: the received amounts sum in ONE order (descending), so the floor verdict never depends on insertion order", () => {
  const m = model();
  const amounts = [0.1, 0.2, 0.3, 0.07, 0.013];
  const want = sqlFormula(m, "practical", [{ family: "general", score: 0.05, received: amounts }]).total;
  for (const order of [amounts, [...amounts].reverse(), [0.2, 0.013, 0.3, 0.1, 0.07]]) {
    const got = foldReceived(0.05, order.map((amount, j) => ({ from: `g${j}`, claim: "l", amount })), new Set());
    assertEquals(got, Math.min(1, 0.05 + [...amounts].sort((a, b) => b - a).reduce((a, x) => a + x, 0)));
    assertEquals(tsLine(m, "practical", [{ family: "general", score: 0.05, received: order }]).total, want);
  }
});

Deno.test("attempt 3: a credibility number is 0 or in [1e-9, 1] - a non-zero number below 1e-9 is refused (SQL: the same CHECK and OBC04)", () => {
  for (const v of [1e-50, 1e-40, 1e-10, 5e-324]) {
    assertThrows(() => unit(v, "w"), CredibilityGateError, "below 1e-9", `${v} was accepted`);
    assertThrows(() => model(withDef("credibility_weights", "release.general", (d) => ({ ...d, weight: v }))), CredibilityGateError, "release.general.weight");
  }
  for (const v of [0, -0, 1e-9, 0.5, 1]) assertEquals(unit(v, "w"), v);
});

Deno.test("attempt 3: registry JSON is parsed so a number that UNDERFLOWS (1e-400 -> 0 in JSON.parse) is refused, not read as 0", () => {
  const d = parseRegistryJson('{"weight":1e-400,"neg":-1e-400,"zero":0.0,"z2":-0,"half":0.5,"one":1.0000000000000000001}');
  assertThrows(() => unit(d.weight, "w"), CredibilityGateError, "below 1e-9");
  assertThrows(() => unit(d.neg, "n"), CredibilityGateError, "below 1e-9");
  assertEquals([unit(d.zero, "z"), unit(d.z2, "z2"), unit(d.half, "h"), unit(d.one, "o")], [0, -0, 0.5, 1]);
});

Deno.test("attempt 3: registry keys are normalised - a weight row for kind 'practical ' / 'Practical' or family 'General' is refused (the CHECK's pattern)", () => {
  for (const [field, v] of [["kind", "practical "], ["kind", "Practical"], ["family", "General"], ["family", " general"], ["kind", ""]]) {
    const rows = seeds().rows;
    rows.push({ registry: "credibility_weights", key: "shape.probe", version: 1, retired_at: null,
      definition: { kind: "practical", family: "general", weight: 0.5, admission_floor: 0.2, claim_floor: 0.5, [field]: v } });
    assertThrows(() => model(rows), CredibilityGateError, "credibility_weights.shape.probe", `${field} ${JSON.stringify(v)} was accepted`);
  }
});

Deno.test("attempt 3: flags are JSON true only, orders are JSON integers (the SQL twin reads them the same way)", () => {
  assertThrows(() => model(withDef("paper_score_versions", "p1", (d) => ({ ...d, active: "true" }))), CredibilityGateError, "0 active versions");
  assertThrows(() => model(withDef("claim_kinds", "practical", (d) => ({ ...d, fallback: "true" }))), CredibilityGateError, "exactly one entry must be declared fallback");
  for (const o of [1.5, "2", null]) {
    assertThrows(() => model(withDef("domain_classes", "news", (d) => ({ ...d, order: o }))), CredibilityGateError, "domain_classes.news.order", `order ${JSON.stringify(o)} accepted`);
  }
  assertThrows(() => model(withDef("domain_classes", "news", (d) => ({ ...d, order: 2 }))), CredibilityGateError, "share order 2");
  const rows = seeds().rows;
  rows.push({ registry: "paper_score_versions", key: "p2", version: 1, retired_at: null, definition: { ...rows.find((r) => r.key === "p1")!.definition } });
  assertThrows(() => model(rows), CredibilityGateError, "2 active versions");
});

Deno.test("attempt 3: no rounding is left in the scoring path (credibility.ts) and no REAL in the SQL twin's D15 functions", async () => {
  const ts = await Deno.readTextFile(new URL("./credibility.ts", import.meta.url));
  for (const fn of ["weightedTotal", "foldReceived", "lineCredibility", "corroborate", "paperScore", "generalScore"]) {
    const body = ts.slice(ts.indexOf(`export function ${fn}(`)).split(/\nexport /)[0];
    const code = body.split("\n").filter((l) => !/reasons?\.push|reason:|reasons: \[/.test(l)).join("\n");
    assert(!/\br3\(|Math\.round|toFixed/.test(code), `${fn} rounds a number that feeds a total or a floor:\n${code}`);
  }
  let sql = "";
  try { sql = await Deno.readTextFile(new URL("../../docker/init-research-credibility.sql", import.meta.url)); }
  catch { return; }   // the image build has no ../../docker in its context; the checkout runs it
  for (const fn of ["credibility_unit", "source_credibility", "source_rolling_total_core", "claim_confidence_d15", "credibility_claim_floor"]) {
    const at = sql.indexOf(`FUNCTION public.${fn}(`);
    assert(at >= 0, `${fn} is defined`);
    const body = sql.slice(at, sql.indexOf("$$;", sql.indexOf("$$", at) + 2));
    assert(!/\bREAL\b|::real/i.test(body), `${fn} computes in REAL (float4):\n${body.slice(0, 400)}`);
  }
  assert(/amount\s+DOUBLE PRECISION/.test(sql), "source_corroborations.amount is DOUBLE PRECISION");
  assert(/sum\(sc\.amount ORDER BY sc\.amount DESC\)/.test(sql), "the SQL twin sums received amounts in descending order");
});

Deno.test("attempt 3: a family REGISTERED without weight rows (P0's expansion) is not scored and stops nothing; a family with SOME rows needs one per kind", () => {
  const rows = seeds().rows;
  rows.push({ registry: "source_families", key: "test-family", version: 1, retired_at: null, definition: {} });
  const m = model(rows);
  assertEquals(m.scoredFamilies.sort(), ["general", "scholarly"]);
  assertEquals(tsLine(m, "release", [{ family: "scholarly", score: 0.999 }, { family: "general", score: 0.1 }]).total,
    tsLine(model(), "release", [{ family: "scholarly", score: 0.999 }, { family: "general", score: 0.1 }]).total);
  assertThrows(() => weightedTotal(m, "release", stamped(m, "test-family", 0.5)), CredibilityGateError, "no row for claim kind 'release' and family 'test-family'");
  rows.push({ registry: "credibility_weights", key: "release.test-family", version: 1, retired_at: null,
    definition: { kind: "release", family: "test-family", weight: 0.5, admission_floor: 0.2, claim_floor: 0.5 } });
  assertThrows(() => model(rows), CredibilityGateError, "and family 'test-family'");
});
