/**
 * The D15 model's SQL twin and the re-score GATE over a REAL database (research-workbench P3a,
 * rw-p3a-entail). SKIPPED unless CRED_E2E_DB_HOST is set; run-credibility-e2e.ps1 sets it to a
 * DISPOSABLE Postgres it creates on its own internal network with the real initdb chain. Never
 * point it at a live database: it re-scores every claim it can see.
 * Run (by the runner): deno test --allow-net --allow-env --allow-read credibility.e2e.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Pool } from "postgres";
import { buildModel, CredibilityGateError, loadCredibilityModel } from "./credibility.ts";
import { seedSet } from "./fixtures/credibility-seeds.ts";
import { foldHeld, recordCorroboration, TombstonedError } from "./kb.ts";

const HOST = Deno.env.get("CRED_E2E_DB_HOST");
const pool = HOST
  ? new Pool({ hostname: HOST, port: 5432, database: "openbrain", user: Deno.env.get("CRED_E2E_DB_USER") ?? "postgres",
    password: Deno.env.get("CRED_E2E_DB_PASSWORD") ?? "" }, 2, true)
  : null;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore: !HOST, fn, sanitizeOps: false, sanitizeResources: false });
async function q<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try { return (await c.queryObject<T>(sql, args)).rows; } finally { c.release(); }
}
async function raises(sql: string, args: unknown[] = []): Promise<string> {
  try { await q(sql, args); return ""; } catch (e) { return String((e as Error).message); }
}
const id = () => crypto.randomUUID();
async function source(url: string, meta: Record<string, unknown> = {}) {
  const s = id();
  await q(`INSERT INTO public.sources (id, url, title, content, domain, metadata) VALUES ($1, $2, $3, 'c', $4, $5::jsonb)`,
    [s, url, url, new URL(url).hostname, JSON.stringify(meta)]);
  return s;
}
// A claim without a kind is a PRE-P3a claim (attempt 2): it is created before the cutover marker,
// as every kindless claim in the live store was; a kindless claim filed after it stops the gate.
async function claim(text: string, sources: string[], kind?: string) {
  const c = id();
  await q(`INSERT INTO public.claims (id, text, metadata, volatility, created_at) VALUES ($1, $2, $3::jsonb, 'slow', $4::timestamptz)`,
    [c, text, JSON.stringify(kind ? { claim_kind: kind } : {}), kind ? new Date().toISOString() : "2020-01-01T00:00:00Z"]);
  for (const [i, s] of sources.entries()) {
    await q(`SELECT public.link_claim_to_source($1, $2, $3, 1.0)`, [c, s, i === 0 ? "states" : "corroborates"]);
  }
  return c;
}
const after = async (c: string) => Number((await q<{ v: number }>(`SELECT public.claim_confidence_d15($1) AS v`, [c]))[0].v);
const confidence = async (c: string) => Number((await q<{ v: number }>(`SELECT confidence AS v FROM public.claims WHERE id = $1`, [c]))[0].v);

t("the registries the database seeds ARE the offline fixture (the migration ran as the tests assume)", async () => {
  const c = await pool!.connect();
  try {
    const live = await loadCredibilityModel(c);
    const offline = buildModel(seedSet().rows, seedSet().versions);
    assertEquals(live.modelVersion, "d15 weights v1 paper p1");
    assertEquals([...live.weights.entries()], [...offline.weights.entries()]);
    assertEquals(live.kinds.map((k) => k.key), offline.kinds.map((k) => k.key));
    assertEquals(live.domainClasses.map((d) => [d.key, d.score]), offline.domainClasses.map((d) => [d.key, d.score]));
    assertEquals(live.paper, offline.paper);
    assertEquals(live.general, offline.general);
    assertEquals(live.corroboration, offline.corroboration);
  } finally { c.release(); }
  assertEquals((await q<{ v: string }>(`SELECT public.credibility_model_version() AS v`))[0].v, "d15 weights v1 paper p1");
});

t("a claim kind with no weight row stops the SQL gate with the kind named (OBC01), no default", async () => {
  const m = await raises(`SELECT public.credibility_weight('horoscope', 'general')`);
  assert(/no row for claim kind 'horoscope'/.test(m), m);
  const c = await claim("kindless", [await source("https://example.com/kindless")], "horoscope");
  const m2 = await raises(`SELECT public.claim_confidence_d15($1)`, [c]);
  assert(/'horoscope'/.test(m2), m2);
  await q(`UPDATE public.claims SET status = 'retracted' WHERE id = $1`, [c]);   // out of the view below
});

t("corroboration transfers only on a verdict the registry says transfers (OBC02 otherwise)", async () => {
  const a = await source("https://blog.example.com/x");
  const b = await source("https://journal.example.org/y");
  const m = await raises(
    `INSERT INTO public.source_corroborations (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version)
     VALUES ($1, $2, 'strong', 0.4, 'c', 'practical', 'partial', 'm')`, [b, a]);
  assert(/does not transfer/.test(m), m);
  const before = Number((await q<{ v: number }>(`SELECT public.source_rolling_total($1, 'practical') AS v`, [a]))[0].v);
  await q(`INSERT INTO public.source_corroborations (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version)
           VALUES ($1, $2, 'strong', 0.4, 'c', 'practical', 'supports', 'm')`, [b, a]);
  const later = Number((await q<{ v: number }>(`SELECT public.source_rolling_total($1, 'practical') AS v`, [a]))[0].v);
  assert(Math.abs(later - before - 0.4) < 1e-6, `${before} -> ${later}`);
});

// ── attempt 2: the SQL twin refuses what the TS model refuses (tester t-rw-p3a finding 2) ─────────
// Every malformed weight the tester's adv2 tried, applied as the OWNER in a rolled-back
// transaction. READ TIME first (the CHECK dropped inside the transaction, so a row the CHECK
// would stop can be read at all): the SQL twin must RAISE, never return a total (attempt 1:
// missing / "NaN" -> 1.0, -0.5 -> -0.11, "-Infinity" -> -Infinity), and the TS model must refuse
// the same row. WRITE TIME second: the CHECK refuses the row outright.
const BAD_WEIGHTS: Array<[string, string]> = [
  ["missing", `definition - 'weight'`],
  ['"NaN"', `definition || '{"weight":"NaN"}'`],
  ['"abc"', `definition || '{"weight":"abc"}'`],
  ["null", `definition || '{"weight":null}'`],
  ["-0.5", `definition || '{"weight":-0.5}'`],
  ["1.7", `definition || '{"weight":1.7}'`],
  ['"-Infinity"', `definition || '{"weight":"-Infinity"}'`],
  ['"0.5" (a string)', `definition || '{"weight":"0.5"}'`],
  ["claim_floor 2", `definition || '{"claim_floor":2}'`],
  ["primary_bonus -1", `definition || '{"primary_bonus":-1}'`],
];
const errOf = (e: unknown) => String((e as Error)?.message ?? e);

t("attempt 2: a malformed weight row is refused by BOTH twins at read time and by the table's CHECK at write time", async () => {
  const s = await source("https://blog.integrity.example/w");
  const c = await pool!.connect();
  const problems: string[] = [];
  try {
    for (const [label, expr] of BAD_WEIGHTS) {
      await c.queryArray("BEGIN");
      try {
        await c.queryArray(`ALTER TABLE public.contract_registry_entries DROP CONSTRAINT IF EXISTS contract_registry_entries_credibility_weight_ok`);
        await c.queryArray(`UPDATE public.contract_registry_entries SET definition = ${expr}
                             WHERE registry = 'credibility_weights' AND key = 'practical.general'`);
        await c.queryArray("SAVEPOINT r");
        let sqlOut = "";
        try {
          const r = await c.queryObject<{ v: number }>(`SELECT public.source_rolling_total($1::uuid, 'practical') AS v`, [s]);
          sqlOut = `RETURNED ${r.rows[0].v}`;
        } catch (e) { sqlOut = errOf(e); }
        await c.queryArray("ROLLBACK TO SAVEPOINT r");
        let tsOut = "";
        try { await loadCredibilityModel(c); tsOut = "BUILT"; } catch (e) {
          tsOut = e instanceof CredibilityGateError ? `REFUSED ${errOf(e)}` : `ERROR ${errOf(e)}`;
        }
        if (!/malformed/.test(sqlOut)) problems.push(`${label}: SQL ${sqlOut}`);
        if (!/^REFUSED .*practical\.general\./.test(tsOut)) problems.push(`${label}: TS ${tsOut}`);
      } finally { await c.queryArray("ROLLBACK"); }
      await c.queryArray("BEGIN");
      let w = "";
      try {
        await c.queryArray(`UPDATE public.contract_registry_entries SET definition = ${expr}
                             WHERE registry = 'credibility_weights' AND key = 'practical.general'`);
        w = "ACCEPTED";
      } catch (e) { w = errOf(e); } finally { await c.queryArray("ROLLBACK"); }
      if (!/contract_registry_entries_credibility_weight_ok/.test(w)) problems.push(`${label}: write ${w}`);
    }
    // a second ACTIVE row for one kind x family: the unique index at write time; both twins at read time
    const dup = `INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES ('credibility_weights',
      'practical.general.dup', 'dup', '{"kind":"practical","family":"general","weight":0.01,"admission_floor":0.2,"claim_floor":0.5,"primary_bonus":0}')`;
    await c.queryArray("BEGIN");
    try {
      await c.queryArray(`DROP INDEX IF EXISTS public.uq_credibility_weights_kind_family`);
      await c.queryArray(dup);
      await c.queryArray("SAVEPOINT r");
      let sqlOut = "";
      try { sqlOut = `RETURNED ${(await c.queryObject<{ v: number }>(`SELECT public.source_rolling_total($1::uuid, 'practical') AS v`, [s])).rows[0].v}`; }
      catch (e) { sqlOut = errOf(e); }
      await c.queryArray("ROLLBACK TO SAVEPOINT r");
      let tsOut = "";
      try { await loadCredibilityModel(c); tsOut = "BUILT"; } catch (e) { tsOut = `REFUSED ${errOf(e)}`; }
      if (!/2 active rows/.test(sqlOut)) problems.push(`duplicate row: SQL ${sqlOut}`);
      if (!/two active rows/.test(tsOut)) problems.push(`duplicate row: TS ${tsOut}`);
    } finally { await c.queryArray("ROLLBACK"); }
    await c.queryArray("BEGIN");
    let w = "";
    try { await c.queryArray(dup); w = "ACCEPTED"; } catch (e) { w = errOf(e); } finally { await c.queryArray("ROLLBACK"); }
    if (!/uq_credibility_weights_kind_family/.test(w)) problems.push(`duplicate row: write ${w}`);
  } finally { c.release(); }
  assertEquals(problems, [], problems.join("\n"));
  // nothing above survived: the table is the seeded one
  assertEquals((await q<{ v: string }>(`SELECT public.credibility_model_version() AS v`))[0].v, "d15 weights v1 paper p1");
});

// An app role READS the credibility registries and cannot change them (tester (4) / (4f): attempt 1's
// ob_app_memory could UPDATE a weight and, after the flip, store 1.0 under a version nobody
// confirmed). Run as service_role and as its member ob_app_memory, each write in a savepoint.
async function appRoleWrites(role: string): Promise<{ read: number; refused: string[]; allowed: string[] }> {
  await q(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
             CREATE ROLE ob_app_memory NOLOGIN NOSUPERUSER NOBYPASSRLS IN ROLE service_role; END IF; END $$`);
  const writes: Array<[string, string]> = [
    ["UPDATE a weight", `UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{weight}', '0.3') WHERE registry = 'credibility_weights' AND key = 'practical.general'`],
    ["drop a weight field (4f)", `UPDATE public.contract_registry_entries SET definition = definition - 'weight' WHERE registry = 'credibility_weights' AND key = 'practical.general'`],
    ["INSERT a weight row", `INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES ('credibility_weights', 'practical.probe', 'p', '{"kind":"practical","family":"probe","weight":1,"admission_floor":0,"claim_floor":0}')`],
    ["DELETE a weight row", `DELETE FROM public.contract_registry_entries WHERE registry = 'credibility_weights' AND key = 'practical.general'`],
    ["UPDATE a domain class", `UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{score}', '0.9') WHERE registry = 'domain_classes' AND key = 'general'`],
    ["UPDATE the paper score", `UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{base}', '0.9') WHERE registry = 'paper_score_versions' AND key = 'p1'`],
    ["UPDATE the corroboration terms", `UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{claim_cap}', '1') WHERE registry = 'credibility_terms' AND key = 'corroboration'`],
    ["UPDATE a verdict", `UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{transfers}', 'true') WHERE registry = 'entailment_verdicts' AND key = 'partial'`],
    ["UPDATE a claim kind", `UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{fallback}', 'false') WHERE registry = 'claim_kinds' AND key = 'practical'`],
    ["UPDATE a family's terms", `UPDATE public.contract_registry_entries SET definition = definition - 'terms' WHERE registry = 'source_families' AND key = 'general'`],
  ];
  const c = await pool!.connect();
  const refused: string[] = [];
  const allowed: string[] = [];
  let read = 0;
  try {
    await c.queryArray("BEGIN");
    await c.queryArray(`SET LOCAL ROLE ${role}`);
    read = Number((await c.queryObject<{ n: number }>(`SELECT count(*)::int AS n FROM public.contract_registry_entries WHERE registry = 'credibility_weights'`)).rows[0].n);
    for (const [label, sql] of writes) {
      await c.queryArray("SAVEPOINT w");
      try { await c.queryArray(sql); allowed.push(label); } catch (e) { if (/permission denied/.test(errOf(e))) refused.push(label); else allowed.push(`${label} (${errOf(e)})`); }
      await c.queryArray("ROLLBACK TO SAVEPOINT w");
    }
    // P0's expansion by registration stays open: a new family can only stop the gate (no weight rows)
    await c.queryArray("SAVEPOINT w");
    try { await c.queryArray(`INSERT INTO public.contract_registry_entries (registry, key, label) VALUES ('source_families', 'probe-family', 'probe')`); allowed.push("INSERT a new family"); }
    catch (e) { refused.push(`INSERT a new family (${errOf(e)})`); }
    await c.queryArray("ROLLBACK TO SAVEPOINT w");
  } finally { await c.queryArray("ROLLBACK").catch(() => {}); c.release(); }
  return { read, refused, allowed };
}

t("attempt 2: the app roles READ the credibility registries and cannot write them (before the trigger flip)", async () => {
  assertEquals((await q<{ v: string }>(`SELECT public.credibility_trigger_model() AS v`))[0].v, "legacy");
  for (const role of ["service_role", "ob_app_memory"]) {
    const r = await appRoleWrites(role);
    assertEquals(r.read, 12, `${role} reads the weight table`);
    assertEquals(r.allowed, ["INSERT a new family"], `${role} changed the model: ${JSON.stringify(r)}`);
    assertEquals(r.refused.length, 10, JSON.stringify(r));
  }
});

// A stamped score is a credibility number naming its family (tester adv2 2g: a -3 stamp read -3,
// a "NaN" stamp read 1.0 and the claim stored 1.0).
t("attempt 2: a stamped score outside [0, 1], not a number, or without a family stops the SQL twin (OBC04)", async () => {
  const s = await source("https://blog.integrity.example/stamp");
  const cl = await claim("a claim on a stamped source", [s], "practical");
  const c = await pool!.connect();
  const problems: string[] = [];
  try {
    for (const stamp of [{ family: "general", score: -3 }, { family: "general", score: 5 }, { family: "general", score: "NaN" },
      { family: "general", score: "0.5" }, { family: "general", score: null }, { score: 0.3 }]) {
      await c.queryArray("BEGIN");
      try {
        await c.queryArray(`UPDATE public.sources SET metadata = $2::jsonb WHERE id = $1::uuid`, [s, JSON.stringify({ credibility: stamp })]);
        for (const sql of [`SELECT public.source_rolling_total($1::uuid, 'practical') AS v`, `SELECT public.claim_confidence_d15($1::uuid) AS v`]) {
          await c.queryArray("SAVEPOINT r");
          const arg = sql.includes("claim_confidence") ? cl : s;
          try { problems.push(`${JSON.stringify(stamp)}: ${sql.split("(")[0]} RETURNED ${(await c.queryObject<{ v: number }>(sql, [arg])).rows[0].v}`); }
          catch (e) { if (!/stamped credibility score is not a number in \[0, 1\]|stamped score without a family/.test(errOf(e))) problems.push(`${JSON.stringify(stamp)}: ${errOf(e)}`); }
          await c.queryArray("ROLLBACK TO SAVEPOINT r");
        }
      } finally { await c.queryArray("ROLLBACK"); }
    }
  } finally { c.release(); }
  assertEquals(problems, [], problems.join("\n"));
  await q(`UPDATE public.claims SET status = 'retracted' WHERE id = $1`, [cl]);
});

// A corroboration is a credibility number, never from a source to itself, and one row per pair and
// line whatever the model version (tester adv2 2h, adv3: -5 -> total -4.78, "NaN" -> 1, A->A
// counted, the same pair on the same line twice after a weight change).
t("attempt 2: corroboration amounts in [0, 1], no self-corroboration, one row per giver -> receiver -> line", async () => {
  const a = await source("https://blog.integrity.example/a");
  const b = await source("https://journal.integrity.example/b");
  const ins = (from: string, to: string, amount: string, line = "a line", model = "d15 weights v1 paper p1") =>
    raises(`INSERT INTO public.source_corroborations (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version)
            VALUES ($1, $2, 'strong', ${amount}, $3, 'practical', 'supports', $4)`, [from, to, line, model]);
  for (const amt of ["-5", "'NaN'", "1.5", "'Infinity'", "'-Infinity'"]) {
    assert(/source_corroborations_amount_unit/.test(await ins(b, a, amt, `amount ${amt}`)), `amount ${amt} was stored`);
  }
  assert(/source_corroborations_not_self/.test(await ins(a, a, "0.3", "self")), "a self-corroboration was stored");
  const before = Number((await q<{ v: number }>(`SELECT public.source_rolling_total($1, 'practical') AS v`, [a]))[0].v);
  assertEquals(await ins(b, a, "0.2", "the same line", "d15 weights v1 paper p1"), "");
  assert(/source_corroborations_one_per_line/.test(await ins(b, a, "0.2", "the same line", "d15 weights v2 paper p1")),
    "a weight change let the same pair on the same line in twice");
  // the writer UPSERTS: a re-run after tuning replaces the pair's row, it never adds one
  const c = await pool!.connect();
  try {
    await recordCorroboration(c, { from: b, to: a, strength: "strong", amount: 0.25, claim: "the same line", kind: "practical", verdict: "supports", model: "d15 weights v2 paper p1" }, null);
  } finally { c.release(); }
  const rows = await q<{ amount: number; model_version: string }>(`SELECT amount::float AS amount, model_version FROM public.source_corroborations WHERE from_source_id = $1 AND to_source_id = $2`, [b, a]);
  assertEquals(rows.map((r) => [Math.round(r.amount * 100) / 100, r.model_version]), [[0.25, "d15 weights v2 paper p1"]]);
  const later = Number((await q<{ v: number }>(`SELECT public.source_rolling_total($1, 'practical') AS v`, [a]))[0].v);
  assert(Math.abs(later - before - 0.25) < 1e-6, `the pair counts once: ${before} -> ${later}`);
});

// THE FOLD RULE (tester adv3: A<->B on a claim both state read 0.83 against 0.63 one way - B counted
// in A's received amount AND as claim_per x B). A co-grounding source counts once in a claim.
t("attempt 2: within one claim total a co-grounding source counts once (corroboration between co-grounders is not added)", async () => {
  const a = await source("https://blog-a.integrity.example/m");
  const b = await source("https://blog-b.integrity.example/m");
  const d = await source("https://blog-d.integrity.example/m");
  const cl = await claim("both blogs say so", [a, b], "practical");
  const corr = (from: string, to: string, amount: number, line: string) =>
    q(`INSERT INTO public.source_corroborations (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version)
       VALUES ($1, $2, 'weak', $3, $4, 'practical', 'supports', 'd15 weights v1 paper p1')`, [from, to, amount, line]);
  const none = await after(cl);
  await corr(b, a, 0.2, "both blogs say so");
  const oneWay = await after(cl);
  await corr(a, b, 0.2, "both blogs say so");
  const bothWays = await after(cl);
  assert(Math.abs(oneWay - none) < 1e-6, `one way: B counted twice (${none} -> ${oneWay})`);
  assert(Math.abs(bothWays - none) < 1e-6, `both ways: B counted twice (${none} -> ${bothWays})`);
  // the source's own rolling total (quality(id)) still carries what it received
  const ownA = Number((await q<{ v: number }>(`SELECT public.source_rolling_total($1, 'practical') AS v`, [a]))[0].v);
  const baseA = Number((await q<{ v: number }>(`SELECT public.source_rolling_total($1, 'practical', NULL::jsonb, $2::uuid[]) AS v`, [a, [b]]))[0].v);
  assert(Math.abs(ownA - baseA - 0.2) < 1e-6, `A's own total keeps B's corroboration (${baseA} -> ${ownA})`);
  // a giver that does NOT ground the claim still counts in full
  await corr(d, a, 0.1, "a third blog agrees");
  const withOutsider = await after(cl);
  assert(withOutsider > none + 0.05, `an outside giver counts (${none} -> ${withOutsider})`);
  await q(`UPDATE public.claims SET status = 'retracted' WHERE id = $1`, [cl]);
});

// The P3a cutover (tester near-miss: a claim filed after P3a without a kind took the basis "filed
// before P3a"). A kindless claim created after the marker stops the gate naming it; one created
// before it takes the declared fallback and says so.
t("attempt 2: a kindless claim filed after the P3a cutover stops the gate (OBC01); one filed before takes the fallback", async () => {
  const s = await source("https://blog.integrity.example/cut");
  const c = await pool!.connect();
  try {
    await c.queryArray("BEGIN");
    const [late, early] = [id(), id()];
    await c.queryArray(`INSERT INTO public.claims (id, text, volatility) VALUES ($1, 'kindless, filed now', 'slow')`, [late]);
    await c.queryArray(`INSERT INTO public.claims (id, text, volatility, created_at) VALUES ($1, 'kindless, filed long ago', 'slow', '2020-01-01')`, [early]);
    await c.queryArray(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $3, 'states'), ($2, $3, 'states')`, [late, early, s]);
    const k = (await c.queryObject<{ id: string; kind: string | null; basis: string }>(
      `SELECT x.id, k.kind, k.basis FROM unnest($1::uuid[]) AS x(id), LATERAL public.claim_kind_of(x.id) k`, [[late, early]])).rows;
    const kl = k.find((r) => r.id === late)!, ke = k.find((r) => r.id === early)!;
    assertEquals(kl.kind, null, `a kindless claim filed after the cutover took ${kl.kind} (${kl.basis})`);
    assert(/MISSING: filed after the P3a cutover/.test(kl.basis), kl.basis);
    assertEquals(ke.kind, "practical");
    assert(/filed before P3a/.test(ke.basis), ke.basis);
    await c.queryArray("SAVEPOINT r");
    let m = "";
    try { await c.queryObject(`SELECT public.claim_confidence_d15($1::uuid)`, [late]); } catch (e) { m = errOf(e); }
    await c.queryArray("ROLLBACK TO SAVEPOINT r");
    assert(/has no claim kind \(MISSING: filed after the P3a cutover/.test(m), `no loud failure: ${m}`);
    const v = (await c.queryObject<{ v: number }>(`SELECT public.claim_confidence_d15($1::uuid) AS v`, [early])).rows[0].v;
    assert(Number(v) > 0, "the pre-cutover claim scores under the fallback");
  } finally { await c.queryArray("ROLLBACK").catch(() => {}); c.release(); }
  const marker = await q<{ at: string }>(`SELECT kind_required_from::text AS at FROM public.credibility_trigger_state`);
  assertEquals(marker.length, 1, "the cutover marker exists");
});

// ── the before/after view and the gate (D15 item 6) ──────────────────────────────────────────
const ids: Record<string, string> = {};
t("before/after: single-source non-paper claims fall below the 0.50 floor; papers and corroborated claims stay above", async () => {
  ids.single = await claim("one blog says so", [await source("https://www.someblog.com/a")]);
  ids.singleGov = await claim("one agency page says so", [await source("https://www.agency.gov/a")]);
  ids.paper = await claim("a paper says so", [await source("https://journal.example.org/p",
    { credibility: { family: "scholarly", score: 0.82, claim_kind: "general_theory", model_version: "d15 weights v1 paper p1" } })], "general_theory");
  ids.corroborated = await claim("three outlets say so", [
    await source("https://www.reuters.com/a"), await source("https://apnews.com/b"), await source("https://www.bbc.co.uk/c")]);
  const rows = await q<{ claim_id: string; before_confidence: number; after_confidence: number; single_source_non_paper: boolean;
    below_floor_before: boolean; below_floor_after: boolean; model_version: string; kind: string; kind_basis: string }>(
    `SELECT * FROM public.credibility_before_after WHERE claim_id = ANY($1::uuid[])`, [Object.values(ids)]);
  const r = (k: string) => rows.find((x) => x.claim_id === ids[k])!;
  for (const k of ["single", "singleGov"]) {
    assert(r(k).single_source_non_paper, k);
    assert(!r(k).below_floor_before && r(k).before_confidence >= 0.5, `${k} before ${r(k).before_confidence}`);
    assert(r(k).below_floor_after && r(k).after_confidence < 0.5, `${k} after ${r(k).after_confidence}`);
    assert(/fallback/.test(r(k).kind_basis), "a pre-P3a claim names that it took the fallback kind");
  }
  assert(!r("paper").below_floor_after && r("paper").after_confidence >= 0.5, `paper ${r("paper").after_confidence}`);
  assert(!r("corroborated").below_floor_after, `corroborated ${r("corroborated").after_confidence}`);
  assert(rows.every((x) => x.model_version === "d15 weights v1 paper p1"), "the view names the versions");
  // the view re-scored NOTHING: the stored confidence is still the old model's
  assertEquals(await confidence(ids.single), Number(r("single").before_confidence));
});

t("the GATE's tables are read-only to the app roles: no confirmation or trigger change around the findings sink", async () => {
  const c = await pool!.connect();
  try {
    await c.queryArray("BEGIN");
    await c.queryArray("SET LOCAL ROLE service_role");
    let m = "";
    try {
      await c.queryArray(`INSERT INTO public.credibility_rescore_confirmations (view_digest, model_version, confirmed_by, findings_ref, confirmation_line)
                          VALUES ('x', 'x', 'app', 'x', 'x')`);
    } catch (e) { m = String((e as Error).message); }
    assert(/permission denied/.test(m), `an app role wrote a confirmation: ${m}`);
  } finally { await c.queryArray("ROLLBACK").catch(() => {}); c.release(); }
  const c2 = await pool!.connect();
  try {
    await c2.queryArray("BEGIN");
    await c2.queryArray("SET LOCAL ROLE service_role");
    let m = "";
    await c2.queryArray("SAVEPOINT before_write");   // the refused write aborts the transaction otherwise
    try { await c2.queryArray(`UPDATE public.credibility_trigger_state SET model = 'd15'`); } catch (e) { m = String((e as Error).message); }
    await c2.queryArray("ROLLBACK TO SAVEPOINT before_write");
    assert(/permission denied/.test(m), `an app role flipped the trigger: ${m}`);
    const r = await c2.queryObject<{ v: string }>(`SELECT public.credibility_trigger_model() AS v`);
    assertEquals(r.rows[0].v, "legacy", "the app role can still READ the model");
  } finally { await c2.queryArray("ROLLBACK").catch(() => {}); c2.release(); }
});

t("the GATE: no re-score without a recorded confirmation of exactly the current view", async () => {
  const digest = (await q<{ d: string }>(`SELECT public.credibility_before_after_digest() AS d`))[0].d;
  let m = await raises(`SELECT public.credibility_apply_d15_trigger($1)`, [digest]);
  assert(/no operator confirmation is recorded/.test(m), m);
  assertEquals((await q<{ v: string }>(`SELECT public.credibility_trigger_model() AS v`))[0].v, "legacy");
  m = await raises(`SELECT public.credibility_record_confirmation($1, 'operator', 'findings/rw-p3a-entail.md', 'line')`, ["0".repeat(32)]);
  assert(/is not the current before\/after view/.test(m), m);
  await q(`SELECT public.credibility_record_confirmation($1, 'operator', 'findings/rw-p3a-entail.md', 'D15-RESCORE-CONFIRMED ...')`, [digest]);
  // the view changes after the confirmation (a weight is tuned) -> the old digest no longer applies
  await q(`UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{weight}', '0.9')
            WHERE registry = 'credibility_weights' AND key = 'practical.general'`);
  m = await raises(`SELECT public.credibility_apply_d15_trigger($1)`, [digest]);
  assert(/is not the current before\/after view/.test(m), m);
  assertEquals((await q<{ v: string }>(`SELECT public.credibility_model_version() AS v`))[0].v, "d15 weights v2 paper p1",
    "a weight change is a new table version");
  await q(`UPDATE public.contract_registry_entries SET definition = jsonb_set(definition, '{weight}', '1.0')
            WHERE registry = 'credibility_weights' AND key = 'practical.general'`);
  // confirmed against the CURRENT view, it applies and the trigger re-scores to the view's numbers
  const now = (await q<{ d: string }>(`SELECT public.credibility_before_after_digest() AS d`))[0].d;
  await q(`SELECT public.credibility_record_confirmation($1, 'operator', 'findings/rw-p3a-entail.md', 'D15-RESCORE-CONFIRMED ...')`, [now]);
  const want = await after(ids.single);
  const n = Number((await q<{ n: number }>(`SELECT public.credibility_apply_d15_trigger($1) AS n`, [now]))[0].n);
  assert(n >= 4, `re-scored ${n}`);
  assertEquals((await q<{ v: string }>(`SELECT public.credibility_trigger_model() AS v`))[0].v, "d15");
  assert(Math.abs(await confidence(ids.single) - want) < 1e-6, "the trigger now writes the D15 total");
  const applied = await q<{ applied_at: string | null; applied_claims: number | null }>(
    `SELECT applied_at, applied_claims FROM public.credibility_rescore_confirmations WHERE view_digest = $1`, [now]);
  assert(applied[0].applied_at && applied[0].applied_claims === n, "the confirmation records what it applied");
});

t("attempt 2: AFTER the flip the app roles still cannot change the model (tester 4f); the version and stored confidence stay the confirmed ones", async () => {
  assertEquals((await q<{ v: string }>(`SELECT public.credibility_trigger_model() AS v`))[0].v, "d15", "precondition: the GATE test flipped the trigger");
  const version = (await q<{ v: string }>(`SELECT public.credibility_model_version() AS v`))[0].v;
  const stored = await confidence(ids.single);
  for (const role of ["service_role", "ob_app_memory"]) {
    const r = await appRoleWrites(role);
    assertEquals(r.allowed, ["INSERT a new family"], `${role} changed the model after the flip: ${JSON.stringify(r)}`);
    assertEquals(r.refused.length, 10, JSON.stringify(r));
  }
  assertEquals((await q<{ v: string }>(`SELECT public.credibility_model_version() AS v`))[0].v, version, "no unconfirmed weights version");
  assertEquals((await q<{ v: number }>(`SELECT public.recompute_claim_confidence($1) AS v`, [ids.single]))[0].v, stored,
    "a recompute stores the confirmed model's number");
  assertEquals(await confidence(ids.single), stored);
});

// ── the fold's move (ingestion model item 2) ─────────────────────────────────────────────────
t("fold_held_source keeps the uuid, moves the chunks, marks the user source active; a tombstoned URL raises OBT01", async () => {
  const refinery = id();
  await q(`INSERT INTO public.ideas (id, title) VALUES ($1, 'p3a fold refinery')`, [refinery]);
  const held = id();
  await q(`INSERT INTO public.held_sources (id, refinery_id, url, title, content) VALUES ($1, $2, 'https://held.example.edu/r', 'h', 'held body')`, [held, refinery]);
  await q(`INSERT INTO public.held_source_chunks (held_source_id, idx, content) VALUES ($1, 0, 'chunk zero')`, [held]);
  await q(`INSERT INTO public.refinery_user_sources (refinery_id, source_id, status) VALUES ($1, $2, 'held')`, [refinery, held]);
  const c = await pool!.connect();
  try {
    assertEquals(await foldHeld(c, held, { family: "general", score: 0.4 }, null), held);
  } finally { c.release(); }
  assertEquals((await q(`SELECT 1 FROM public.held_sources WHERE id = $1`, [held])).length, 0);
  const s = await q<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM public.sources WHERE id = $1`, [held]);
  assertEquals(s.length, 1);
  assertEquals((s[0].metadata.credibility as Record<string, unknown>).family, "general");
  assertEquals((await q(`SELECT 1 FROM public.source_chunks WHERE source_id = $1`, [held])).length, 1);
  assertEquals((await q<{ status: string }>(`SELECT status FROM public.refinery_user_sources WHERE source_id = $1`, [held]))[0].status, "active");
  assertEquals((await q(`SELECT 1 FROM public.source_trail_events WHERE source_id = $1 AND kind = 'folded'`, [held])).length, 1);
  // a held source whose URL is tombstoned never walks in through the fold
  const h2 = id();
  await q(`INSERT INTO public.held_sources (id, refinery_id, url, title, content) VALUES ($1, $2, 'https://erased.example.org/t', 'h2', 'b')`, [h2, refinery]);
  await q(`INSERT INTO public.source_tombstones (source_id, url, url_key, reason_type, eraser_kind)
           VALUES ($1, 'https://erased.example.org/t', public.contract_url_key('https://erased.example.org/t'), 'debunked', 'user')`, [id()]);
  const c2 = await pool!.connect();
  let err: unknown = null;
  try { await foldHeld(c2, h2, {}, null); } catch (e) { err = e; } finally { c2.release(); }
  assert(err instanceof TombstonedError, String(err));
  assertEquals((await q(`SELECT 1 FROM public.held_sources WHERE id = $1`, [h2])).length, 1, "it stays held");
});
