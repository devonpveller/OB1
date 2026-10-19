/**
 * rw-p3a-entail attempt 4 (bounded round; tester t-rw-p3a-3 findings F1 / F2 and the near-misses tied
 * to bar (c)), offline. The DB halves are credibility-attempt4.e2e.test.ts.
 *   F1  THE REPRESENTABLE RANGE: an amount, a stamped score and an edge weight are 0 or in [1e-9, 1];
 *       a number the pipeline forms below 1e-9 is flushed to 0; storeConfidence (the stored twin's
 *       view) stores a total below the smallest normal float4 as 0.
 *   F2  ONE LINE FORMULA: a line is scored through the edges the curator files for it.
 *   near-misses: tag_effect shape, boolean-only `primary`.
 * Run: deno test --allow-read attempt4.test.ts
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  amountUnit, buildModel, corroborate, type CredibilityModel, CredibilityGateError, edgeTotal, filedClaimsCredibility, flushUnit,
  FLOAT4_MIN_NORMAL, foldReceived, lineCredibility, type RegistryRow, type SourceScore, storeConfidence, tagAfterEffect,
  weightedTotal,
} from "./credibility.ts";
import { applyVerdicts, citedLines } from "./entailment.ts";
import { recordCorroboration, stampSourceCredibility } from "./kb.ts";
import { seedSet } from "./fixtures/credibility-seeds.ts";

const seeds = seedSet();
const model = () => buildModel(seeds.rows, seeds.versions);
const withDef = (registry: string, key: string, patch: Record<string, unknown>): RegistryRow[] =>
  seeds.rows.map((r) => r.registry === registry && r.key === key ? { ...r, definition: { ...r.definition, ...patch } } : r);
// attempt 6: a line is scored as the claim the curator's claim list (claim-list.ts) files from it
const filedLine = (m: CredibilityModel, kind: string, tag: string, cites: number[], total: (n: number) => number) =>
  filedClaimsCredibility(m, kind, `[${tag}] The widget ships in size 3. [Source ${cites.join(", ")}]`, () => null, total)[0] ?? null;
const general = (score: number, primary: unknown = false): SourceScore => ({
  family: "general", score, reasons: [], model_version: "t",
  signals: { author_identity: null, domain_class: "general", primary: primary as boolean,
    link_structure: { inbound_corroborations: 0, found_via: 0 }, entailment_agreement: { supports: 0, partial: 0, unsupported: 0 } },
});

// ── F1 ─────────────────────────────────────────────────────────────────────────────────────────
Deno.test("attempt 4 F1: an amount is 0 or in [1e-9, 1] - 5e-324 / 1e-46 / 1e-45 / 1e-10 are refused (attempt 3 sent them)", () => {
  for (const a of [5e-324, 1e-46, 1e-45, 1e-10, 9.99e-10]) {
    assertThrows(() => amountUnit(a, "amount"), CredibilityGateError, "below 1e-9");
    assertThrows(() => foldReceived(0.3, [{ from: "g", claim: "l", amount: a }], new Set()), CredibilityGateError, "below 1e-9");
  }
  for (const a of [0, 1e-9, 0.5, 1]) assertEquals(amountUnit(a, "amount"), a);
});

Deno.test("attempt 4 F1: recordCorroboration refuses a sub-1e-9 amount and SENDS NOTHING (attempt 3: 'SENT the row')", async () => {
  const sent: string[] = [];
  const client = { queryObject<T>(sql: string) { sent.push(sql); return Promise.resolve({ rows: [] as T[] }); } };
  for (const amount of [5e-324, 1e-46, 1e-45]) {
    let err = "";
    try {
      await recordCorroboration(client, { from: "a", to: "b", strength: "weak", amount, claim: "l", kind: "practical", verdict: "supports", model: "m" }, null);
    } catch (e) { err = String((e as Error).message); }
    assert(/below 1e-9/.test(err), `${amount}: ${err}`);
  }
  assertEquals(sent, []);
});

Deno.test("attempt 4 F1: a number the pipeline FORMS below 1e-9 is flushed to 0 where it is formed (corroborate, scores)", () => {
  assertEquals([flushUnit(5e-324), flushUnit(9.9e-10), flushUnit(1e-9), flushUnit(0.3)], [0, 0, 1e-9, 0.3]);
  // an owner table where strong_factor x weight x score is 1e-12: the amount the run reasons with is 0
  const rows = withDef("credibility_terms", "corroboration", { strong_factor: 1e-3, weak_factor: 1e-3 });
  const m = buildModel(rows.map((r) => r.registry === "credibility_weights" && r.key === "practical.scholarly"
    ? { ...r, definition: { ...r.definition, weight: 1e-6 } } : r), seeds.versions);
  const paper: SourceScore = { family: "scholarly", score: 1e-3, reasons: [], model_version: "t", signals: { cited_by: null, author_works_count: null, age_years: null } };
  const edges = corroborate(m, "practical", "line", "supports",
    { url: "https://g.example/x", score: general(1e-3), links: ["https://p.example/w"] }, { url: "https://p.example/w", doi: null, score: paper });
  assertEquals(edges.map((e) => e.amount), [0, 1e-3 * (1 * 1e-3)].map((x) => x < 1e-9 ? 0 : x));
  for (const e of edges) assertEquals(amountUnit(e.amount, "amount"), e.amount);
});

Deno.test("attempt 4 F1: storeConfidence (the stored twin's view) - a total below the smallest normal float4 stores 0, on the floor's side; the rest as attempt 3", () => {
  assertEquals(FLOAT4_MIN_NORMAL, 1.1754943508222875e-38);
  for (const [t, f] of [[5e-324, 0.5], [1e-46, 0.5], [1e-45, 0.5], [1e-40, 0.5], [1e-40, 0], [FLOAT4_MIN_NORMAL / 2, 1e-9], [0, 0.5], [0, 0]] as Array<[number, number]>) {
    const v = storeConfidence(t, f);
    assertEquals(v, 0, `${t}`);
    assertEquals(v < f, t < f, `${t} floor ${f}: the stored 0 crossed the floor`);
  }
  assertEquals(storeConfidence(FLOAT4_MIN_NORMAL, 0.5), FLOAT4_MIN_NORMAL);
  assertEquals(storeConfidence(0.49999999, 0.5), Math.fround(0.5 - 0.5 * 2 ** -23));   // one step back (the e2e: = SQL, bit for bit)
  assertEquals(storeConfidence(0.402, 0.5), Math.fround(0.402));
  assertEquals(storeConfidence(0.6, null), Math.fround(0.6));
});

Deno.test("attempt 4 F1 / near-miss P4: an edge weight NaN / Infinity / 5 / -1 / 1e-45 is refused by the TS twin (attempt 3: scored 1.0)", () => {
  const m = model();
  for (const w of [NaN, Infinity, 5, -1, 1e-45]) assertThrows(() => edgeTotal(m, 0.6, "states", w), CredibilityGateError, "edge weight");
  assertEquals(edgeTotal(m, 0.6, "states", 0), 0);
  assertThrows(() => edgeTotal(m, 0.6, "contradicts", 1), CredibilityGateError, "no factor");
});

// ── F2 ─────────────────────────────────────────────────────────────────────────────────────────
Deno.test("attempt 4 F2 RED shapes: the line total is the stored claim total - INFERRED 0.402, UNCERTAIN 0.25125, 5-cite SOURCED 0.551 (attempt 3: 0.6 / 0.75 / 0.95)", () => {
  const m = model();
  const line = (tag: string, scores: number[]) =>
    filedLine(m, "practical", tag, scores.map((_, i) => i + 1), (n) => weightedTotal(m, "practical", general(scores[n - 1])).total)!;
  // the SQL twin's values on the same stamped rows, from the tester's record (adv-probes-p1-p6.out)
  assertEquals(line("SOURCED", [0.6]).total, 0.6);
  assertEquals(line("INFERRED", [0.6]).total, 0.402);
  assertEquals(line("INFERRED", [0.6]).below_floor, true);
  assertEquals(line("INFERRED", [0.75]).total, 0.5025000000000001);
  assertEquals(line("INFERRED", [0.9, 0.3]).total, 0.7035000000000001);
  assertEquals(line("UNCERTAIN", [0.75]).total, 0.25125000000000003);
  assertEquals(line("UNCERTAIN", [0.9, 0.3]).total, 0.35175000000000006);
  assertEquals(line("SOURCED", [0.6, 0.6, 0.6, 0.6, 0.6]).total, 0.5509999999999999);
  assertEquals(line("SOURCED", [0.6, 0.6, 0.6, 0.6, 0.6]).filed_tag, "uncertain");
  assertEquals(line("SOURCED", [0.9, 0.3]).total, 1);
});

Deno.test("attempt 4 F2: the factor is the registry's (edge_factors), not a literal - an owner change moves the TS twin", () => {
  const m = buildModel(withDef("credibility_terms", "edge_factors", { inferred_from: 0.5 }), seeds.versions);
  const l = filedLine(m, "practical", "INFERRED", [1], () => 0.6)!;
  assertEquals(l.total, 0.3);
  assertThrows(() => buildModel(withDef("credibility_terms", "edge_factors", { inferred_from: "0.67" }), seeds.versions), CredibilityGateError);
  assertThrows(() => buildModel(seeds.rows.filter((r) => r.key !== "edge_factors"), seeds.versions), CredibilityGateError, "edge_factors");
});

Deno.test("attempt 4 F2: a partial verdict lowers the tag to UNCERTAIN, which IS filed - the line carries that claim's total; unsupported (gap) carries 0", () => {
  const m = model();
  // the verdict's tag effect is written into the line (applyVerdicts / tagAfterEffect); the claim list files the result
  const at = (tag: string, verdict: string) =>
    filedLine(m, "practical", tagAfterEffect(tag, m.verdicts.get(verdict)!.tagEffect), [1], () => 0.8);
  assertEquals(at("SOURCED", "partial")!.filed_tag, "uncertain");
  assertEquals(at("SOURCED", "partial")!.total, 0.8 * 0.5 * 0.67);
  assertEquals(at("SOURCED", "unsupported"), null, "a [GAP] line is no claim: nothing is filed, nothing is scored");
  assertEquals(lineCredibility(m, "practical", 0, "unsupported", [{ total: 0.8 }]).total, 0);
});

Deno.test("attempt 4 F2: the tag the line is scored under is the tag applyVerdicts writes (one tagAfterEffect)", () => {
  const synth = ["[SOURCED] A is 1. [Source 1]", "[INFERRED] B is 2. [Source 1]", "[UNCERTAIN] C is 3. [Source 1]"].join("\n");
  const lines = citedLines(synth);
  const effects = [{ key: "supports", tagEffect: "keep" as const }, { key: "partial", tagEffect: "uncertain" as const }, { key: "unsupported", tagEffect: "gap" as const }];
  for (const verdict of ["supports", "partial", "unsupported"]) {
    const vs = lines.map((l) => ({ line: l.index, text: l.text, tag: l.tag, cites: l.cites, verdict, basis: "judge" as const, rationale: "", cited_text: [] }));
    const out = applyVerdicts(synth, vs, effects).synthesis.split("\n");
    lines.forEach((l, i) => {
      const effect = effects.find((e) => e.key === verdict)!.tagEffect;
      assertEquals(out[i].match(/^\[([A-Z]+)\]/)![1], tagAfterEffect(l.tag, effect), `${l.tag} ${verdict}`);
    });
  }
});

// ── near-misses tied to (c) ──────────────────────────────────────────────────────────────────────
Deno.test("attempt 4 near-miss: tag_effect must be a JSON string in the TS twin too - [\"keep\"] is refused (SQL refuses it)", () => {
  for (const bad of [["keep"], { v: "keep" }, 1, null]) {
    assertThrows(() => buildModel(withDef("entailment_verdicts", "supports", { tag_effect: bad }), seeds.versions), CredibilityGateError, "tag_effect");
  }
});

Deno.test("attempt 4 near-miss P3: `primary` counts only as the JSON value true - \"true\" / 1 / \"false\" are ignored (SQL: = 'true'::jsonb), and refused at write", async () => {
  const rows = withDef("credibility_weights", "practical.general", { primary_bonus: 0.02 });
  const m = buildModel(rows, seeds.versions);
  const base = weightedTotal(m, "practical", general(0.49, false)).total;
  assertEquals(weightedTotal(m, "practical", general(0.49, true)).total, 0.51);
  for (const p of ["true", 1, "false"]) assertEquals(weightedTotal(m, "practical", general(0.49, p)).total, base, String(p));
  const sent: string[] = [];
  const client = { queryObject<T>(sql: string) { sent.push(sql); return Promise.resolve({ rows: [] as T[] }); } };
  for (const p of ["true", 1]) {
    let err = "";
    try {
      await stampSourceCredibility(client, "s", { family: "general", claim_kind: "practical", signals: { primary: p }, score: 0.4, total: 0.4,
        reasons: [], model_version: "t", admission: { path: "x", floor: null, total: null, trail_id: null } }, null, null);
    } catch (e) { err = String((e as Error).message); }
    assert(/signals\.primary .* not a boolean/.test(err), err);
  }
  assertEquals(sent, []);
});
