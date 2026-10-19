/**
 * rw-p3a-entail attempt 5 (the last extra round) over a REAL database - tester t-rw-p3a-4's finding A4-1
 * and near-misses N1 / N2. SKIPPED unless CRED_E2E_DB_HOST is set; run-credibility-e2e.ps1 runs it after
 * credibility-attempt4.e2e.test.ts on the same DISPOSABLE database (chain only). Every case runs in ONE
 * transaction per run that is rolled back.
 *
 * A4-1: harness.ts harden() runs numeric grounding AFTER the entailment verdicts, and attempt 4 scored a
 * line from its verdict-time tag; the curator filed the re-tagged line. Attempt 6 (the structural round)
 * restated every case here on THE INVARIANT (fixtures/credibility-invariant.ts compareInvariant): the
 * claims the run scores ARE the claims the curator files - count, order, text, tag, edges - each total
 * == claim_confidence_d15 == the view bit for bit, footer == research_jobs.metrics.credibility == the
 * filed claims (a judged line that yields no filed claim contributes nothing). Here:
 *   Case 41 drives the REAL runResearch (every model / network seam stubbed, the DATABASE real: staging,
 *           the registries, the stamps, the corroborations, the fold) -> the curator's own writeClaims on
 *           the package, with lines re-tagged by numeric grounding, by a verdict, partial, gap, omnibus.
 *   Case 42 is the twins sweep in harden()'s REAL order (the tester's "mode B"): it calls the functions
 *           runResearch calls (hardenJudged, curatorCopyLines, buildCitedAndRenumber, scoreCuratorPackage),
 *           never a model of them; attempt 6 adds every drop rule to its lines (the same text twice, a
 *           case-only duplicate, empty claim texts, meta-claims, two tags on one line, a citation on a
 *           continuation line).
 *   Case 43 is the refinery path (N2): lines grounded only in unfolded held sources, partly-stripped
 *           lines and a folded source, through the real fold.
 *   Case 44 is N1: the writer's edge statement (LINK_EDGE_SQL) and edgeWeightOk agree on every float32
 *           boundary, accepted/refused and stored.
 * Run (by the runner): deno test --allow-net --allow-env --allow-read credibility-attempt5.e2e.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Pool, type PoolClient } from "postgres";
import * as C from "./credibility.ts";
import { citedLines, type LineVerdict } from "./entailment.ts";
import { buildCitedAndRenumber } from "./lib.ts";
import { edgeWeightOk } from "./claim-edges.ts";
import * as H from "./harness.ts";
import type { FetchResult, SearchHit } from "./harness.ts";
import {
  compareInvariant, curator, ENTITY, host, type LineSpec, page, QUERY, realDeps,
} from "./fixtures/credibility-invariant.ts";

const HOST = Deno.env.get("CRED_E2E_DB_HOST");
const pool = HOST
  ? new Pool({ hostname: HOST, port: Number(Deno.env.get("CRED_E2E_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CRED_E2E_DB_USER") ?? "postgres", password: Deno.env.get("CRED_E2E_DB_PASSWORD") ?? "" }, 2, true)
  : null;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore: !HOST, fn, sanitizeOps: false, sanitizeResources: false });
const errOf = (e: unknown) => String((e as Error)?.message ?? e);
const id = () => crypto.randomUUID();
// deno-lint-ignore no-explicit-any
const HX = H as any;

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

// ── the real run: every model / network seam stubbed, the database REAL ─────────────────────────────
const PAPER = "https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2021.757735/full";
const VIA = "https://www.nature.com/articles/s44172-025-00417-2";
const NEWS = "https://www.reuters.com/health/vestibular-motion-sickness-2026";
const LEAD = "https://blog.example.com/vestibular-motion-sickness-explained";
const EXTRA = [
  "https://www.bbc.com/news/health-vestibular-motion-sickness",
  "https://apnews.com/article/vestibular-motion-sickness-travel",
  "https://www.theguardian.com/science/vestibular-motion-sickness",
];

/** The shapes a run's judged lines had (non-vacuity counts), from its verdicts. */
function shapes(r: H.RunResult) {
  return {
    partial: r.verdicts.filter((v) => v.verdict === "partial").length,
    gap: r.verdicts.filter((v) => v.verdict === "unsupported").length,
    omnibus: r.verdicts.filter((v) => v.cites.length > 4).length,
  };
}
const tok = () => `zq${id().replace(/[^a-f]/g, "").slice(0, 10)}`;
const footerOf = (r: H.RunResult) => (r.prose.match(/report credibility(?::)? [^ ]+/) ?? [""])[0];
// deno-lint-ignore no-explicit-any
const metricsOf = (r: H.RunResult) => { const m = r.metrics.credibility! as any; return { v: m.value, below: m.below_floor, claims: m.claims, judged: m.judged_lines, not_filed: m.judged_not_filed }; };

// ── Case 41: the REAL harden() order, end to end ─────────────────────────────────────────────────────
t("attempt 5 A4-1 (Case 41): through the REAL runResearch -> the curator's writeClaims, the scored claims ARE the filed claims and each total == claim_confidence_d15 == the view, the floor verdict and the stored REAL agree, and footer == metrics == the filed claims - with lines re-tagged by numeric grounding, by a verdict, partial, gap and omnibus lines", async () => {
  const cur = await curator();
  const specs: LineSpec[] = [
    { tok: tok(), tag: "SOURCED", text: `Visually induced ${ENTITY} follows a visual-vestibular mismatch`, cites: [PAPER], verdict: "supports" },
    // the figure is not in its cited text: numeric grounding re-tags it [UNCERTAIN] AFTER the verdict (A4-1)
    { tok: tok(), tag: "SOURCED", text: `Visually induced ${ENTITY} follows a visual-vestibular mismatch in 12 of 20 subjects`, cites: [PAPER], verdict: "supports" },
    { tok: tok(), tag: "INFERRED", text: `Doctors say ${ENTITY} affects 40% of travellers`, cites: [NEWS], verdict: "supports" },
    { tok: tok(), tag: "SOURCED", text: `Doctors say ${ENTITY} is common among travellers`, cites: [NEWS], verdict: "partial" },
    { tok: tok(), tag: "SOURCED", text: `Doctors say ${ENTITY} is rare among sailors`, cites: [NEWS], verdict: "unsupported" },
    // a figure that IS in its text, split brackets and a duplicate citation
    { tok: tok(), tag: "SOURCED", text: `Galvanic vestibular stimulation changed ${ENTITY} by 26% in 10 participants`, cites: [VIA, PAPER], verdict: "supports", split: true, dup: true },
    // two sources, the figure absent: [SOURCED] states + corroborates becomes [UNCERTAIN] inferred_from x2
    { tok: tok(), tag: "SOURCED", text: `${ENTITY} was measured in 3 trials`, cites: [PAPER, NEWS], verdict: "supports" },
    // omnibus (> 4 citations), one with an absent figure, one partial
    { tok: tok(), tag: "SOURCED", text: `${ENTITY} is widely reported`, cites: [PAPER, NEWS, VIA, ...EXTRA], verdict: "supports" },
    { tok: tok(), tag: "INFERRED", text: `${ENTITY} is reported by 77% of outlets`, cites: [PAPER, NEWS, VIA, ...EXTRA], verdict: "supports" },
    { tok: tok(), tag: "INFERRED", text: `${ENTITY} is reported in the press`, cites: [NEWS, ...EXTRA], verdict: "partial" },
    { tok: tok(), tag: "GAP", text: `Nothing on the long-term course of ${ENTITY}`, cites: [], verdict: "supports" },
  ];
  const pages: Record<string, FetchResult> = {
    [LEAD]: page(LEAD, `By Some Blogger. ${ENTITY} is about the inner ear. `.repeat(20), [VIA]),
    [VIA]: page(VIA, `Galvanic vestibular stimulation changed ${ENTITY} by 26% in 10 participants. `.repeat(20)),
    [PAPER]: page(PAPER, `Visually induced ${ENTITY} follows a visual-vestibular mismatch. `.repeat(20)),
    [NEWS]: page(NEWS, `Doctors say ${ENTITY} is common among travellers. `.repeat(20)),
    // distinct texts: find_or_create_source dedups by md5(content), so three identical pages would be ONE stored
    // source (three citations, one edge) - the named residual "sources merged on persistence", not this case
    ...Object.fromEntries(EXTRA.map((u) => [u, page(u, `Reporters at ${host(u)} say ${ENTITY} is widely discussed in the press. `.repeat(20))])),
  };
  const hits: SearchHit[] = [LEAD, PAPER, NEWS, ...EXTRA].map((u) => ({ url: u, title: `${ENTITY} ${host(u)}`, snippet: `${ENTITY} ${host(u)}` }));
  await inTx(async (c) => {
    const { d, seen } = realDeps(c, cur, specs, pages, hits);
    const r = await H.runResearch(d, c, QUERY, { origin: "owui" });
    assertEquals(seen.filed.length, 1, "the curator was handed one package");
    const inv = await compareInvariant(c, r, seen.filed[0]);
    const sh = shapes(r);
    console.log(`CASE 41: kind ${r.metrics.credibility!.kind}; ungrounded figures ${JSON.stringify(r.ungroundedNumbers)}; ` +
      `judged ${inv.judged}, scored ${inv.scored}, filed ${inv.filed}, bit-identical ${inv.bit}/${inv.filed}, judged-not-filed ${inv.notFiled}, re-tagged after the verdict ${inv.retagged}, ` +
      `partial ${sh.partial}, gap ${sh.gap}, omnibus ${sh.omnibus}; metrics ${JSON.stringify(metricsOf(r))}; footer '${footerOf(r)}'`);
    console.log("CASE 41 filed synthesis:\n" + seen.filed[0].synthesis);
    for (const b of inv.bad) console.log(`  DISAGREE ${b}`);
    // the case is not vacuous: every shape the finding named is in it
    assert(inv.retagged >= 2, `re-tagged by numeric grounding after a supports verdict: ${inv.retagged}`);
    assert(sh.partial >= 2 && sh.gap >= 1 && sh.omnibus >= 2 && inv.filed >= 7, JSON.stringify({ ...sh, filed: inv.filed }));
    assert((r.ungroundedNumbers ?? []).length >= 3, `numeric grounding re-tagged ${JSON.stringify(r.ungroundedNumbers)}`);
    assertEquals(inv.bad, [], "scored vs filed disagreements");
    assertEquals(inv.bit, inv.filed);
  });
});

// ── Case 42: the twins sweep in harden()'s REAL order ("mode B") ─────────────────────────────────────
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
t("attempt 5 A4-1 (Case 42, attempt 6: with every drop rule): the twins sweep in harden()'s REAL order - hardenJudged (verdicts, then numeric grounding), curatorCopyLines, buildCitedAndRenumber, scoreCuratorPackage - through the curator's writeClaims: the scored claims ARE the filed claims, every one bit-identical, every floor verdict, footer and metrics agree, under owner edge-factor changes", async () => {
  assert(typeof HX.hardenJudged === "function" && typeof HX.scoreCuratorPackage === "function",
    "harness.ts exports hardenJudged and scoreCuratorPackage (the functions runResearch calls)");
  const { writeClaims, claimList } = await curator();
  const r = rng(Number(Deno.env.get("SWEEP5_SEED") ?? 20261018));
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const letters = (k: number) => Array.from({ length: k }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(r() * 26)]).join("");
  const runsPerKind = Number(Deno.env.get("SWEEP5_RUNS") ?? 6);
  const FACTORS = [
    { states: 1, corroborates: 1, inferred_from: 0.67 }, { states: 1, corroborates: 1, inferred_from: 0.5 },
    { states: 0.8, corroborates: 1, inferred_from: 1e-9 }, { states: 1, corroborates: 0.3, inferred_from: 0 },
    { states: 1, corroborates: 1, inferred_from: 1 }, { states: 0.999999999, corroborates: 2e-9, inferred_from: 0.333 },
  ];
  const general = (primary: boolean) => ({ author_identity: null, domain_class: "general", primary,
    link_structure: { inbound_corroborations: 0, found_via: 0 }, entailment_agreement: { supports: 0, partial: 0, unsupported: 0 } });
  const s = { runs: 0, lines: 0, judged: 0, scored: 0, filed: 0, bit: 0, retagged: 0, notFiled: 0, unjudged: 0, bad: [] as string[], footers: 0,
    dropped: {} as Record<string, number> };
  await inTx(async (c) => {
    const kinds = (await c.queryObject<{ key: string }>(`SELECT key FROM public.contract_registry_entries WHERE registry = 'claim_kinds' AND retired_at IS NULL ORDER BY key`)).rows.map((x) => x.key);
    for (const kind of kinds) {
      for (let run = 0; run < runsPerKind; run++) {
        s.runs++;
        const ef = pick(FACTORS);
        await c.queryObject(`UPDATE public.contract_registry_entries SET definition = $1::jsonb WHERE registry = 'credibility_terms' AND key = 'edge_factors'`,
          [JSON.stringify({ term_version: 1, ...ef })]);
        const m = await C.loadCredibilityModel(c);
        const n = 4 + Math.floor(r() * 5);
        const tagW = letters(8);
        const rows = Array.from({ length: n }, () => {
          const family = r() < 0.4 ? "scholarly" : "general";
          return { id: id(), family, content: "", primary: family === "general" && r() < 0.3,
            score: pick([0, 1e-9, 2e-9, 0.1, 0.3, 0.5, 0.5 - 2 ** -40, 0.6, 0.75, 0.9, 1, r(), r(), r()]) };
        });
        const figures = Array.from({ length: 12 }, () => 10 + Math.floor(r() * 80));
        for (const p of rows) p.content = `widget notes ${tagW} ` + figures.filter(() => r() < 0.5).map((f) => `size ${f} cm`).join("; ");
        await c.queryObject(`INSERT INTO public.sources (id, url, title, content, domain, metadata)
          SELECT x.id, 'https://sweep5.example/' || x.id, 'sweep5', x.content, 'sweep5.example', x.meta
            FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, content text, meta jsonb)`,
          [JSON.stringify(rows.map((p) => ({ id: p.id, content: p.content, meta: { credibility: { family: p.family, score: p.score,
            signals: p.family === "general" ? { primary: p.primary } : {}, model_version: "sweep5" } } })))]);
        const received = new Map<string, Array<{ from: string; claim: string; amount: number }>>();
        for (const p of rows) {
          for (const from of rows.map((q) => q.id).filter((q) => q !== p.id).filter(() => r() < 0.25)) {
            const amount = pick([0, 1e-9, 2e-9, 0.05, 0.1, r() * 0.3]);
            const claim = `corr ${letters(10)}`;
            await c.queryObject(`INSERT INTO public.source_corroborations (from_source_id, to_source_id, strength, amount, claim_text, claim_kind, verdict, model_version)
              VALUES ($1, $2, 'weak', $3, $4, 'practical', 'supports', 'sweep5')`, [from, p.id, amount, claim]);
            (received.get(p.id) ?? received.set(p.id, []).get(p.id)!).push({ from, claim, amount });
          }
        }
        const synthLines: string[] = [];
        const bodies: string[] = [];
        const cite = (k: number) => {
          const cites = Array.from({ length: k }, () => 1 + Math.floor(r() * n));
          if (r() < 0.1) cites.push(n + 1 + Math.floor(r() * 3));
          if (r() < 0.1) cites.push(cites[0]);
          return r() < 0.2 && cites.length > 1 ? `[Source ${cites[0]}][Source ${cites.slice(1).join(", ")}]` : `[Source ${cites.join(", ")}]`;
        };
        for (let li = 0; li < 12; li++) {
          const tk = `zq${letters(10)}`;
          const tag = pick(["SOURCED", "SOURCED", "INFERRED", "UNCERTAIN", "Sourced", "inferred"]);
          const k = pick([1, 1, 2, 3, 4, 5, 6, 7]);
          const shape = r();
          // attempt 6: every drop rule, mixed in
          if (shape < 0.06) { synthLines.push(`[GAP] Nothing on ${tk}.`); continue; }
          if (shape < 0.13 && bodies.length) { const b = pick(bodies); synthLines.push(`[${tag}] ${r() < 0.5 ? b : b.toUpperCase()} ${cite(k)}`); continue; }
          if (shape < 0.18) { synthLines.push(`[${tag}] ${pick(["", "--", "* "])} ${cite(k)}`); continue; }
          if (shape < 0.23) { synthLines.push(`[${tag}] The provided sources contain no information about the widget ${tk}. ${cite(k)}`); continue; }
          if (shape < 0.28) { synthLines.push(`[${tag}] The widget ${tk} ships in size ${figures[li]} cm. ${cite(k)} [INFERRED] The widget ${tk}b is boxed. ${cite(1)}`); continue; }
          if (shape < 0.32) { synthLines.push(`[${tag}] The widget ${tk} ships in size ${figures[li]} cm.`); synthLines.push(`as noted ${cite(k)}`); continue; }
          const body = `The widget ${tk} ships in size ${figures[li]} cm.`;
          bodies.push(body);
          synthLines.push(`[${tag}] ${body} ${cite(k)}`);
        }
        const synthesis = synthLines.join("\n");
        s.lines += synthLines.length;
        const verdicts: LineVerdict[] = citedLines(synthesis).map((l) => ({ line: l.index, text: l.text, tag: l.tag, cites: l.cites,
          verdict: pick(["supports", "supports", "partial", "unsupported"]), basis: "judge", rationale: "", cited_text: [] } as LineVerdict));
        const effects = [...m.verdicts.values()].map((v) => ({ key: v.key, tagEffect: v.tagEffect }));
        // runResearch's order, through the functions it calls
        const hardened = HX.hardenJudged(synthesis, verdicts, effects, rows.map((p) => p.content)).synthesis as string;
        const lines = HX.curatorCopyLines(hardened, new Set<number>()) as Array<string | null>;
        const { synthesis: curatorSyn, cited } = buildCitedAndRenumber(lines.filter((l) => l !== null).join("\n"), rows);
        const scoredPkg = HX.scoreCuratorPackage(m, kind, curatorSyn, cited, lines, verdicts, (p: typeof rows[number], grounders: typeof rows) => {
          const coCited = new Set(grounders.map((g) => g.id));
          const score = { family: p.family, score: p.score, reasons: [], model_version: "s",
            signals: p.family === "general" ? general(p.primary) : { cited_by: null, author_works_count: null, age_years: null } } as unknown as C.SourceScore;
          return C.foldReceived(C.weightedTotal(m, kind, score).total, received.get(p.id) ?? [], coCited);
        }) as { claims: C.ScoredClaim[]; report: C.ReportCredibility };
        const res = await writeClaims(c, curatorSyn.trim(), { threadId: null, synthesisId: null, sourceIds: cited.map((p) => p.id), volatility: "slow", claimMetadata: { claim_kind: kind } });
        for (const x of claimList ? claimList(curatorSyn).dropped : []) s.dropped[x.reason] = (s.dropped[x.reason] ?? 0) + 1;
        const pseudo = { metrics: { credibility: scoredPkg.report }, lineCredibility: scoredPkg.claims, verdicts, prose: "" } as unknown as H.RunResult;
        const inv = await compareInvariant(c, pseudo, { pkg: {}, synthesis: curatorSyn, sourceIds: cited.map((p) => p.id), claimIds: res.claimIds },
          `${kind} run ${run} ef ${JSON.stringify(ef)}`);
        s.footers++;
        s.judged += inv.judged; s.scored += inv.scored; s.filed += inv.filed; s.bit += inv.bit; s.retagged += inv.retagged;
        s.notFiled += inv.notFiled; s.unjudged += inv.unjudgedFiled;
        s.bad.push(...inv.bad);
        await c.queryArray(`DELETE FROM public.claim_sources WHERE claim_id IN (SELECT id FROM public.claims WHERE text ILIKE '%zq%')`);
        await c.queryArray(`DELETE FROM public.claims WHERE text ILIKE '%zq%'`);
      }
    }
  });
  console.log(`CASE 42 (mode B, runResearch's order, with the drop rules): runs ${s.runs}, synthesis lines ${s.lines}, judged ${s.judged}, scored ${s.scored}, filed ${s.filed}, ` +
    `re-tagged by numeric grounding after a supports verdict ${s.retagged}, judged-not-filed ${s.notFiled}, filed-off-a-judged-line ${s.unjudged}, ` +
    `dropped ${JSON.stringify(s.dropped)}, bit-identical ${s.bit}/${s.filed}, footers/metrics compared ${s.footers}, disagreements ${s.bad.length}`);
  for (const b of s.bad.slice(0, 8)) console.log(`  ${b}`);
  assert(s.retagged >= 10, `the sweep re-tags lines after the verdict (${s.retagged})`);
  for (const k of ["duplicate_text", "empty_text", "meta_pattern"]) assert((s.dropped[k] ?? 0) >= 5, `${k}: ${s.dropped[k] ?? 0}`);
  assertEquals(s.bad, []);
  assertEquals(s.scored, s.filed);
  assertEquals(s.bit, s.filed);
});

// ── Case 43: the refinery path (N2) through the REAL fold ────────────────────────────────────────────
t("attempt 5 N2 (Case 43): the refinery path - a line grounded only in an unfolded held source is not filed and not scored, a partly-stripped line is scored with its remaining citations, a folded source's corroboration is in the total; the scored claims ARE the filed claims, footer == metrics == the filed claims", async () => {
  const cur = await curator();
  const HELD_OK = "https://held.example.gov/report";
  const HELD_LOW = "https://held-blog.example.com/post";
  const specs: LineSpec[] = [
    { tok: tok(), tag: "SOURCED", text: `Visually induced ${ENTITY} follows a visual-vestibular mismatch`, cites: [PAPER], verdict: "supports" },
    { tok: tok(), tag: "SOURCED", text: `The held report says ${ENTITY} is vestibular`, cites: [HELD_OK, PAPER], verdict: "supports" },
    { tok: tok(), tag: "SOURCED", text: `A held blog says ${ENTITY} is vestibular`, cites: [HELD_LOW], verdict: "supports" },
    { tok: tok(), tag: "SOURCED", text: `A held blog and the press say ${ENTITY} is common`, cites: [HELD_LOW, NEWS], verdict: "supports" },
    { tok: tok(), tag: "INFERRED", text: `Doctors say ${ENTITY} affects 40% of travellers`, cites: [NEWS, HELD_LOW], verdict: "supports" },
    { tok: tok(), tag: "SOURCED", text: `Doctors say ${ENTITY} is common among travellers`, cites: [NEWS], verdict: "partial" },
  ];
  const pages: Record<string, FetchResult> = {
    [PAPER]: page(PAPER, `Visually induced ${ENTITY} follows a visual-vestibular mismatch. `.repeat(20)),
    [NEWS]: page(NEWS, `Doctors say ${ENTITY} is common among travellers. `.repeat(20)),
  };
  const hits: SearchHit[] = [PAPER, NEWS].map((u) => ({ url: u, title: `${ENTITY} ${host(u)}`, snippet: `${ENTITY} ${host(u)}` }));
  await inTx(async (c) => {
    const refinery = id();
    await c.queryObject(`INSERT INTO public.ideas (id, title) VALUES ($1, 'p3a attempt 5 refinery')`, [refinery]);
    for (const [url, body] of [[HELD_OK, `${ENTITY} report `], [HELD_LOW, `${ENTITY} blog `]]) {
      const h = id();
      await c.queryObject(`INSERT INTO public.held_sources (id, refinery_id, url, title, content) VALUES ($1, $2, $3, $4, $5)`,
        [h, refinery, url, `held ${host(url)}`, body.repeat(40)]);
      await c.queryObject(`INSERT INTO public.refinery_user_sources (refinery_id, source_id, status) VALUES ($1, $2, 'held')`, [refinery, h]);
    }
    const { d, seen } = realDeps(c, cur, specs, pages, hits);
    const r = await H.runResearch(d, c, QUERY, { origin: "owui", refineryId: refinery });
    const fold = (r.fold?.held ?? []).map((h) => `${host(h.url ?? "x")}:${h.outcome}`);
    const inv = await compareInvariant(c, r, seen.filed[0] ?? null);
    console.log(`CASE 43: fold ${JSON.stringify(fold)}; judged ${inv.judged}, scored ${inv.scored}, filed ${inv.filed}, judged-not-filed ${inv.notFiled}, bit-identical ${inv.bit}/${inv.filed}; ` +
      `metrics ${JSON.stringify(metricsOf(r))}; footer '${footerOf(r)}'`);
    console.log("CASE 43 filed synthesis:\n" + (seen.filed[0]?.synthesis ?? "(none)"));
    for (const b of inv.bad) console.log(`  DISAGREE ${b}`);
    assert(fold.includes("held.example.gov:held_folded") && fold.includes("held-blog.example.com:held_kept"), JSON.stringify(fold));
    assert(inv.notFiled >= 1, "a line grounded only in the unfolded held source is not filed");
    assert(!String(seen.filed[0]?.synthesis).includes(specs[2].tok), "the held-only line never reaches the curator");
    assertEquals(inv.bad, [], "scored vs filed disagreements");
    assertEquals(inv.bit, inv.filed);
  });
});

// ── Case 44: N1 - the writer's edge statement and edgeWeightOk on float32 boundaries ─────────────────
t("attempt 5 N1 (Case 44): an edge weight sent through the writer's statement (LINK_EDGE_SQL: $4::float8::real) is accepted / refused and stored exactly as edgeWeightOk / Math.fround say - 1 + 2^-24, 5e-324, 0.30000002682209015, the 1e-9 midpoints - for the owner and ob_app_memory", async () => {
  await ensureAppRole();
  const cur = await curator();
  const sqlText = cur.LINK_EDGE_SQL;
  assert(sqlText, "the curator's claims.ts exports LINK_EDGE_SQL");
  const mid = 1.0000000272292198e-9;
  const ws = [1 + 2 ** -24, 5e-324, 0.30000002682209015, 1e-9, mid, mid + 2 ** -82, mid - 2 ** -82, 2e-9, 0, -0, 1, 1 - 2 ** -53, 1 + 2 ** -23,
    2 ** -150, 2 ** -149, 1e-46, 0.5, 0.1, 1 / 3, NaN, Infinity, -1, -(2 ** -150)];
  const problems: string[] = [];
  const shown: unknown[] = [];
  for (const role of ["postgres", "ob_app_memory"]) {
    await inTx(async (c) => {
      const s = id();
      await c.queryObject(`INSERT INTO public.sources (id, url, title, content, domain, metadata) VALUES ($1, $2, 'n1', 'n1', 'n1.example', $3::jsonb)`,
        [s, `https://n1.example/${s}`, JSON.stringify({ credibility: { family: "general", score: 0.5, signals: { primary: false } } })]);
      const claimIds = ws.map(() => id());
      for (const cl of claimIds) {
        await c.queryObject(`INSERT INTO public.claims (id, text, metadata, volatility) VALUES ($1, $2, '{"claim_kind":"practical"}', 'slow')`, [cl, `n1 ${cl}`]);
      }
      if (role !== "postgres") await c.queryArray(`SET LOCAL ROLE ${role}`);
      const m = await C.loadCredibilityModel(c);
      const base = Number((await one<{ v: number }>(c, `SELECT public.source_rolling_total($1, 'practical', NULL::jsonb) AS v`, [s])).v);
      for (const [k, w] of ws.entries()) {
        const cl = claimIds[k];
        const ts = edgeWeightOk(w);
        const r = await attempt(c, () => c.queryObject(sqlText!, [cl, s, "states", w]));
        const stored = r.err ? null : Number((await one<{ w: number }>(c, `SELECT weight::float8 AS w FROM public.claim_sources WHERE claim_id = $1`, [cl])).w);
        const d15 = r.err ? null : Number((await one<{ v: number }>(c, `SELECT public.claim_confidence_d15($1) AS v`, [cl])).v);
        const tsTotal = ts ? Math.min(1, C.edgeTotal(m, base, "states", w)) : null;
        if (role === "postgres") shown.push({ w, ts, sql: r.err ? `refused (${r.err.slice(0, 50)})` : stored, fround: Math.fround(w), d15, tsTotal });
        if (ts !== !r.err) problems.push(`${role} w ${w}: TS ${ts ? "accepts" : "refuses"}, SQL ${r.err ? `refuses (${r.err.slice(0, 80)})` : "stores"}`);
        else if (ts && (stored !== Math.fround(w) || d15 !== tsTotal)) problems.push(`${role} w ${w}: stored ${stored} fround ${Math.fround(w)} d15 ${d15} TS ${tsTotal}`);
      }
    });
  }
  console.log(`CASE 44 ${JSON.stringify(shown)}`);
  assertEquals(problems, []);
});

Deno.test({ name: "attempt 5: close the pool", ignore: !HOST, fn: async () => { await pool!.end(); }, sanitizeOps: false, sanitizeResources: false });
