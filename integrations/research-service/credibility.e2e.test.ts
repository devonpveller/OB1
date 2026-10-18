/**
 * The D15 model's SQL twin and the re-score GATE over a REAL database (research-workbench P3a,
 * rw-p3a-entail). SKIPPED unless CRED_E2E_DB_HOST is set; run-credibility-e2e.ps1 sets it to a
 * DISPOSABLE Postgres it creates on its own internal network with the real initdb chain. Never
 * point it at a live database: it re-scores every claim it can see.
 * Run (by the runner): deno test --allow-net --allow-env --allow-read credibility.e2e.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Pool } from "postgres";
import { buildModel, loadCredibilityModel } from "./credibility.ts";
import { seedSet } from "./fixtures/credibility-seeds.ts";
import { foldHeld, TombstonedError } from "./kb.ts";

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
async function claim(text: string, sources: string[], kind?: string) {
  const c = id();
  await q(`INSERT INTO public.claims (id, text, metadata, volatility) VALUES ($1, $2, $3::jsonb, 'slow')`,
    [c, text, JSON.stringify(kind ? { claim_kind: kind } : {})]);
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
    try { await c2.queryArray(`UPDATE public.credibility_trigger_state SET model = 'd15'`); } catch (e) { m = String((e as Error).message); }
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
