/**
 * The D15 model's integrity, TS side (research-workbench P3a attempt 2, rw-p3a-entail; tester
 * t-rw-p3a finding 2 and the near-misses). Offline. The SQL twin's half of every case is in
 * credibility.e2e.test.ts (same malformed rows, same refusals), so the two cannot drift by
 * convention.
 * Run: deno test --allow-read integrity.test.ts
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildModel, CredibilityGateError, foldReceived, lineCredibility, type RegistryRow, unit,
} from "./credibility.ts";
import { recordCorroboration, stampSourceCredibility } from "./kb.ts";
import { seedSet } from "./fixtures/credibility-seeds.ts";

const seeds = () => structuredClone(seedSet());
const withDef = (registry: string, key: string, patch: (d: Record<string, unknown>) => Record<string, unknown>): RegistryRow[] =>
  seeds().rows.map((r) => r.registry === registry && r.key === key ? { ...r, definition: patch({ ...r.definition }) } : r);
const build = (rows: RegistryRow[]) => buildModel(rows, seeds().versions);

// The tester's adv2 table, plus the rest of what "a credibility number" excludes.
const BAD: Array<[string, unknown]> = [
  ["missing", undefined], ['"NaN"', "NaN"], ['"abc"', "abc"], ["null", null], ["NaN", Number.NaN],
  ["-0.5", -0.5], ["1.7", 1.7], ['"-Infinity"', "-Infinity"], ["-Infinity", -Infinity], ["Infinity", Infinity], ['"0.5"', "0.5"],
];

Deno.test("a malformed weight is REFUSED (never 1.0, never a total outside [0, 1]) - every adv2 shape", () => {
  for (const [label, v] of BAD) {
    const rows = withDef("credibility_weights", "practical.general", (d) => {
      if (v === undefined) delete d.weight; else d.weight = v;
      return d;
    });
    assertThrows(() => build(rows), CredibilityGateError, "practical.general.weight", `weight ${label} was accepted`);
  }
  // 0 and 1 are credibility numbers
  for (const v of [0, 1]) build(withDef("credibility_weights", "practical.general", (d) => ({ ...d, weight: v })));
});

Deno.test("every number of a weight row is a credibility number: floors and the primary bonus too", () => {
  for (const field of ["admission_floor", "claim_floor", "primary_bonus"]) {
    for (const v of [-0.1, 1.5, "0.2", null]) {
      assertThrows(() => build(withDef("credibility_weights", "release.general", (d) => ({ ...d, [field]: v }))),
        CredibilityGateError, `release.general.${field}`, `${field} = ${JSON.stringify(v)} was accepted`);
    }
  }
  // primary_bonus is the one optional field (absent = 0, the SQL twin's rule)
  const m = build(withDef("credibility_weights", "release.general", (d) => { delete d.primary_bonus; return d; }));
  assertEquals(m.weights.get("release.general")!.primaryBonus, 0);
});

Deno.test("two active rows for one kind x family are refused (attempt 1: the last one silently won)", () => {
  const rows = seeds().rows;
  rows.push({ registry: "credibility_weights", key: "practical.general.dup", version: 1,
    definition: { kind: "practical", family: "general", weight: 0.01, admission_floor: 0.2, claim_floor: 0.5, primary_bonus: 0 }, retired_at: null });
  assertThrows(() => build(rows), CredibilityGateError, "two active rows for claim kind 'practical' and family 'general'");
  // a RETIRED second row is history, not a second weight
  rows[rows.length - 1].retired_at = "2026-10-18T00:00:00Z";
  build(rows);
});

Deno.test("the other model numbers are validated too: domain scores, paper terms, general and corroboration terms (no `?? 0`)", () => {
  assertThrows(() => build(withDef("domain_classes", "news", (d) => ({ ...d, score: 1.2 }))), CredibilityGateError, "domain_classes.news.score");
  assertThrows(() => build(withDef("paper_score_versions", "p1", (d) => ({ ...d, base: "0.6" }))), CredibilityGateError, "paper.base");
  assertThrows(() => build(withDef("paper_score_versions", "p1", (d) => ({ ...d, cite_rate_half: 0 }))), CredibilityGateError, "paper.cite_rate_half");
  assertThrows(() => build(withDef("credibility_terms", "corroboration", (d) => { delete d.claim_cap; return d; })),
    CredibilityGateError, "corroboration.claim_cap");
  assertThrows(() => build(withDef("source_families", "general", (d) => ({ ...d, terms: { ...(d.terms as object), link_cap: -1 } }))),
    CredibilityGateError, "general.terms.link_cap");
  assertEquals(unit(0.5, "x"), 0.5);
  assertThrows(() => unit("0.5", "x"), CredibilityGateError, "x is not a number");
});

Deno.test("THE FOLD RULE: on a line, corroboration between two cited sources is not added - each counts once (tester adv3)", () => {
  const m = build(seeds().rows);
  const a = 0.42, b = 0.42;
  const line = "both sources say so";
  // one way (B -> A) and both ways (A <-> B): A's line total leaves B's corroboration out
  const coCited = new Set(["A", "B"]);
  const aOneWay = foldReceived(a, [{ from: "B", claim: line, amount: 0.2 }], coCited);
  const aBoth = foldReceived(a, [{ from: "B", claim: line, amount: 0.2 }], coCited);
  const bBoth = foldReceived(b, [{ from: "A", claim: line, amount: 0.2 }], coCited);
  const none = lineCredibility(m, "practical", 0, "supports", [{ total: a }, { total: b }]).total;
  assertEquals(lineCredibility(m, "practical", 0, "supports", [{ total: aOneWay }, { total: b }]).total, none);
  assertEquals(lineCredibility(m, "practical", 0, "supports", [{ total: aBoth }, { total: bBoth }]).total, none);
  // the attempt 1 arithmetic, for the record: adding it counted B twice
  const doubled = lineCredibility(m, "practical", 0, "supports", [{ total: a + 0.2 }, { total: b + 0.2 }]).total;
  assert(doubled > none, `${doubled} vs ${none}`);
  // a giver NOT cited on the line counts in full; the source's own rolling total keeps everything
  assertEquals(foldReceived(a, [{ from: "D", claim: "another line", amount: 0.1 }], coCited), 0.52);
  assertEquals(foldReceived(a, [{ from: "B", claim: line, amount: 0.2 }], new Set()), 0.62);
});

Deno.test("the same giver -> receiver pair on the same line counts once (whatever the model version)", () => {
  const e = { from: "P", claim: "the line", amount: 0.3 };
  assertEquals(foldReceived(0.2, [e, { ...e }], new Set()), 0.5);
  assertEquals(foldReceived(0.2, [e, { ...e, claim: "a second line" }], new Set()), 0.8);
  assertEquals(foldReceived(0.9, [e, { ...e, claim: "a second line" }], new Set()), 1, "capped at 1");
  for (const bad of [-5, Number.NaN, 1.5, Infinity]) {
    assertThrows(() => foldReceived(0.2, [{ ...e, amount: bad }], new Set()), CredibilityGateError, "amount");
  }
});

// a recording stub client: what the writers would send to the database
function recorder() {
  const sent: Array<{ sql: string; args: unknown[] }> = [];
  return { sent, client: { queryObject: <T>(sql: string, args: unknown[] = []) => { sent.push({ sql, args }); return Promise.resolve({ rows: [] as T[] }); } } };
}

Deno.test("recordCorroboration refuses a bad amount or a self-corroboration BEFORE the database, and upserts one row per pair and line", async () => {
  const base = { from: "a", to: "b", strength: "strong" as const, amount: 0.2, claim: "l", kind: "practical", verdict: "supports", model: "m" };
  for (const bad of [{ amount: -5 }, { amount: Number.NaN }, { amount: 1.5 }, { amount: Infinity }, { to: "a" }]) {
    const r = recorder();
    let err: unknown = null;
    try { await recordCorroboration(r.client, { ...base, ...bad }, null); } catch (e) { err = e; }
    assert(err instanceof CredibilityGateError, `${JSON.stringify(bad)} reached the database`);
    assertEquals(r.sent.length, 0);
  }
  const r = recorder();
  await recordCorroboration(r.client, base, null);
  assertEquals(r.sent.length, 1);
  assert(/ON CONFLICT \(from_source_id, to_source_id, claim_text\) DO UPDATE/.test(r.sent[0].sql), r.sent[0].sql);
  assert(!/model_version\) DO NOTHING/.test(r.sent[0].sql), "the key must not include model_version");
});

Deno.test("stampSourceCredibility refuses a score the SQL twin would refuse, and stores no credential-shaped text", async () => {
  const stamp = { family: "general", claim_kind: "practical", signals: {}, score: 0.3, total: 0.3, reasons: ["domain class general: 0.22"],
    model_version: "d15 weights v1 paper p1", admission: { path: "search", floor: 0.2, total: 0.3, trail_id: null } };
  for (const bad of [{ score: -3 }, { score: Number.NaN }, { total: 5 }, { score: "0.5" as unknown as number }, { family: "" }]) {
    const r = recorder();
    let err: unknown = null;
    try { await stampSourceCredibility(r.client, "s", { ...stamp, ...bad }, null, null); } catch (e) { err = e; }
    assert(err instanceof CredibilityGateError, `${JSON.stringify(bad)} was stored`);
    assertEquals(r.sent.length, 0);
  }
  const key = "SECRETKEY-integrity";
  const r = recorder();
  await stampSourceCredibility(r.client, "s", { ...stamp, reasons: [`doi 10.1/x UNRESOLVED (https://api.openalex.org/works/x?api_key=${key}): scored as general`] },
    { state: "unresolved", reason: `OpenAlex error: https://api.openalex.org/works/x?api_key=${key}&mailto=a@b` }, null);
  const all = JSON.stringify(r.sent.map((x) => x.args));
  assert(!all.includes(key) && !all.includes("api_key") && !all.includes("mailto"), all);
});
