/**
 * rw-p3a-entail attempt 5 (the last extra round) over a REAL database - tester t-rw-p3a-4's finding A4-1
 * and near-misses N1 / N2. SKIPPED unless CRED_E2E_DB_HOST is set; run-credibility-e2e.ps1 runs it after
 * credibility-attempt4.e2e.test.ts on the same DISPOSABLE database (chain only). Every case runs in ONE
 * transaction per run that is rolled back.
 *
 * A4-1: harness.ts harden() runs numeric grounding AFTER the entailment verdicts, and attempt 4 scored a
 * line from its verdict-time tag; the curator filed the re-tagged line. Attempt 4's tests modelled the
 * pipeline as applyVerdicts -> the curator, so they could not see it. Here:
 *   Case 41 drives the REAL runResearch (every model / network seam stubbed, the DATABASE real: staging,
 *           the registries, the stamps, the corroborations, the fold) -> the curator's own writeClaims on
 *           the package -> claim_confidence_d15 / the view / the stored REAL, and asserts per judged line
 *           run total == d15 == view (bit for bit), the floor verdict, storeConfidence(total) == stored
 *           REAL, and footer == research_jobs.metrics.credibility == the stored claims' roll-up.
 *   Case 42 is the twins sweep in harden()'s REAL order (the tester's "mode B"): it calls the functions
 *           harden() calls (hardenJudged, curatorCopyLines, finalLineCredibility), never a model of them.
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
import { fixtureResolver } from "./fixtures/scholarly-network.ts";
import * as H from "./harness.ts";
import type { Deps, FetchResult, SearchHit } from "./harness.ts";

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
// deno-lint-ignore no-explicit-any
const CX = C as any;

type Curator = {
  writeClaims: (c: unknown, s: string, o: Record<string, unknown>) => Promise<{ claimIds: string[]; metaSkipped: number }>;
  LINK_EDGE_SQL?: string;
};
async function curator(): Promise<Curator> {
  const dir = Deno.env.get("CURATOR_DIR");
  const url = dir ? `file://${dir.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}/claims.ts` : new URL("../research-curator/claims.ts", import.meta.url).href;
  return await import(url) as Curator;
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
const r3 = (x: number) => Math.round(x * 1000) / 1000;
async function ensureAppRole(): Promise<void> {
  const c = await pool!.connect();
  try {
    await c.queryArray(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_app_memory') THEN
                          CREATE ROLE ob_app_memory NOLOGIN NOSUPERUSER NOBYPASSRLS IN ROLE service_role; END IF; END $$`);
  } finally { c.release(); }
}

// ── the real run: every model / network seam stubbed, the database REAL ─────────────────────────────
const ENTITY = "vestibular motion sickness";
const QUERY = "Research on the mechanism of vestibular motion sickness: what do studies show?";
const PAPER = "https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2021.757735/full";
const VIA = "https://www.nature.com/articles/s44172-025-00417-2";
const NEWS = "https://www.reuters.com/health/vestibular-motion-sickness-2026";
const LEAD = "https://blog.example.com/vestibular-motion-sickness-explained";
const EXTRA = [
  "https://www.bbc.com/news/health-vestibular-motion-sickness",
  "https://apnews.com/article/vestibular-motion-sickness-travel",
  "https://www.theguardian.com/science/vestibular-motion-sickness",
];
const host = (u: string) => new URL(u).hostname;
const page = (url: string, content: string, links: string[] = []): FetchResult => ({
  page: { url, title: `${ENTITY} - ${host(url)}`, content, domain: host(url), links }, outcome: "ok",
});
interface LineSpec { tok: string; tag: string; text: string; cites: string[]; verdict: string; split?: boolean; dup?: boolean }

/** The synthesizer: each spec line cites the pool pages it names by the [Source N] the prompt gave them. */
function synthFrom(specs: LineSpec[]) {
  return (block: string): string => {
    const n = (url: string) => {
      for (const l of block.split("\n")) {
        const i = l.indexOf("[Source ");
        if (i >= 0 && l.includes(`(${host(url)})`)) return Number(l.slice(i + 8, l.indexOf("]", i)));
      }
      return 0;
    };
    return specs.map((s) => {
      if (s.tag === "GAP") return `[GAP] ${s.text} ${s.tok}.`;
      const nums = s.cites.map(n).filter((x) => x > 0);
      if (s.dup && nums.length) nums.push(nums[0]);
      const cite = s.split && nums.length > 1 ? `[Source ${nums[0]}][Source ${nums.slice(1).join(", ")}]` : `[Source ${nums.join(", ")}]`;
      return `[${s.tag}] ${s.text} ${s.tok}. ${cite}`;
    }).join("\n");
  };
}

function realDeps(c: PoolClient, cur: Curator, specs: LineSpec[], pages: Record<string, FetchResult>, hits: SearchHit[]) {
  const seen = { pkgs: [] as Record<string, unknown>[], filed: [] as string[] };
  const d: Deps = {
    embed: () => Promise.resolve(new Array(1024).fill(0)),
    chat: (sys, user) => {
      if (sys.includes("ENTAILMENT JUDGE")) {
        const claim = (user.match(/^CLAIM \(tagged \[[A-Z]+\]\): (.*)$/m) ?? [])[1] ?? "";
        const s = specs.find((x) => claim.includes(x.tok));
        return Promise.resolve(JSON.stringify({ verdict: s?.verdict ?? "supports", rationale: "stub" }));
      }
      if (sys.includes("research planner")) return Promise.resolve(JSON.stringify({ needs: ["What mechanism causes vestibular motion sickness?"] }));
      if (sys.includes("web-search queries")) return Promise.resolve(JSON.stringify({ entity: ENTITY, queries: ["mechanism studies"] }));
      if (sys.includes("already covered by KNOWN CLAIMS")) return Promise.resolve(JSON.stringify({ gaps: [0] }));
      if (sys.includes("GATHERED SOURCES")) return Promise.resolve(JSON.stringify({ open: [] }));
      if (sys.includes("research strategist")) return Promise.resolve(JSON.stringify({ queries: [] }));
      if (sys.includes("You screen a fetched web page")) return Promise.resolve("RELEVANT");
      if (sys.includes("You screen fetched web content")) return Promise.resolve("CLEAN");
      if (sys.includes("grounded synthesizer")) return Promise.resolve(synthFrom(specs)(user.slice(user.indexOf("SOURCES:"))));
      return Promise.resolve("{}");
    },
    searchWeb: () => Promise.resolve(hits),
    fetchPage: (url) => Promise.resolve(pages[url] ?? page(url, `${ENTITY} misc `.repeat(40))),
    // the curator, for real: the package's sources are deduped into OB as the curator does
    // (find_or_create_source) and ITS writeClaims files the package's synthesis
    delegateToCurator: async (pkg) => {
      seen.pkgs.push(pkg);
      const ids: string[] = [];
      for (const s of pkg.sources as Array<{ url: string; title: string; content: string; domain: string }>) {
        const r = await one<{ id: string }>(c, `SELECT id::text AS id FROM public.find_or_create_source($1, $2, NULL, $3, 'web_article', NULL, $4, NULL::vector, '{}'::jsonb)`,
          [s.url, s.content, s.title, s.domain]);
        ids.push(r.id);
      }
      await cur.writeClaims(c, String(pkg.synthesis), { threadId: null, synthesisId: null, sourceIds: ids, volatility: "slow",
        claimMetadata: { claim_kind: pkg.claim_kind } });
      seen.filed.push(String(pkg.synthesis));
      return { thread_id: null, persist: { source_ids: ids }, claims: {} };
    },
    scholarly: fixtureResolver(),
    admission: null,
  };
  return { d, seen };
}

interface Compared { lines: number; filed: number; bit: number; bad: string[]; retagged: number; partial: number; gap: number; omnibus: number; unfiled: number }

/** Run total vs the stored claim, per judged line; the roll-ups; the stored REAL after the flip. */
async function compareRun(c: PoolClient, r: H.RunResult, specs: LineSpec[]): Promise<Compared> {
  // deno-lint-ignore no-explicit-any
  const rr = r as any;
  const kind = r.metrics.credibility!.kind;
  const floor = Number((await one<{ f: number }>(c, `SELECT public.credibility_claim_floor($1) AS f`, [kind])).f);
  const out: Compared = { lines: 0, filed: 0, bit: 0, bad: [], retagged: 0, partial: 0, gap: 0, omnibus: 0, unfiled: 0 };
  const stored: number[] = [];
  let storedBelow = 0;
  const ids: Array<{ id: string; total: number; label: string }> = [];
  for (const [i, lc] of (rr.lineCredibility as C.FiledLine[]).entries()) {
    out.lines++;
    const v = rr.verdicts[i] as LineVerdict;
    const spec = specs.find((s) => v.text.includes(s.tok));
    const label = `line ${lc.line} [${v.tag}] ${v.verdict} ${spec?.tok ?? "?"}`;
    if (v.verdict === "partial") out.partial++;
    if (v.verdict === "unsupported") out.gap++;
    if (v.cites.length > 4) out.omnibus++;
    const row = spec ? await one<{ id: string; tag: string }>(c,
      `SELECT id::text AS id, epistemic_tag AS tag FROM public.claims WHERE status = 'active' AND text LIKE '%' || $1 || '%'`, [spec.tok]) : undefined;
    if (lc.filed_tag && lc.filed_tag.toUpperCase() !== v.tag && v.verdict === "supports" && v.cites.length <= 4) out.retagged++;
    if (!row) {
      out.unfiled++;
      if (lc.total !== 0 || !lc.below_floor) out.bad.push(`${label}: not filed, run total ${lc.total} below ${lc.below_floor}`);
      stored.push(0); storedBelow++;
      continue;
    }
    out.filed++;
    const d15 = Number((await one<{ v: number }>(c, `SELECT public.claim_confidence_d15($1) AS v`, [row.id])).v);
    const view = await one<{ v: number; b: boolean }>(c,
      `SELECT after_confidence AS v, below_floor_after AS b FROM public.credibility_before_after WHERE claim_id = $1`, [row.id]);
    if (lc.total === d15 && Number(view.v) === d15 && lc.filed_tag === row.tag) out.bit++;
    else out.bad.push(`${label}: filed ${row.tag} d15 ${d15} view ${view.v} | run ${lc.total} (run tag ${lc.filed_tag})`);
    if ((d15 < floor) !== lc.below_floor || view.b !== (d15 < floor)) out.bad.push(`${label}: FLOOR d15 ${d15 < floor} view ${view.b} run ${lc.below_floor}`);
    stored.push(d15);
    if (d15 < floor) storedBelow++;
    ids.push({ id: row.id, total: lc.total, label });
  }
  const mc = r.metrics.credibility!;
  const storedMean = stored.length ? r3(stored.reduce((a, x) => a + x, 0) / stored.length) : null;
  if (mc.value !== storedMean) out.bad.push(`METRICS value ${mc.value} stored ${storedMean}`);
  if (mc.below_floor !== storedBelow) out.bad.push(`METRICS below_floor ${mc.below_floor} stored ${storedBelow}`);
  if (mc.lines !== out.lines) out.bad.push(`METRICS lines ${mc.lines} judged ${out.lines}`);
  const footer = (r.prose.match(/report credibility [^ ]+/) ?? [""])[0];
  if (storedMean !== null && footer !== `report credibility ${storedMean.toFixed(2)}`) out.bad.push(`FOOTER '${footer}' stored ${storedMean}`);
  // the stored REAL, after the operator's flip: storeConfidence(run total) bit for bit
  await c.queryArray(`UPDATE public.credibility_trigger_state SET model = 'd15'`);
  for (const x of ids) {
    const v = Number((await one<{ v: number }>(c, `SELECT public.recompute_claim_confidence($1::uuid)::float8 AS v`, [x.id])).v);
    if (v !== C.storeConfidence(x.total, floor)) out.bad.push(`${x.label}: STORED ${v} storeConfidence(run) ${C.storeConfidence(x.total, floor)}`);
  }
  await c.queryArray(`UPDATE public.credibility_trigger_state SET model = 'legacy'`);
  return out;
}

const tok = () => `zq${id().replace(/[^a-f]/g, "").slice(0, 10)}`;

// ── Case 41: the REAL harden() order, end to end ─────────────────────────────────────────────────────
t("attempt 5 A4-1 (Case 41): through the REAL runResearch -> the curator's writeClaims, every judged line's run total == claim_confidence_d15 == the view, the floor verdict and the stored REAL agree, and footer == metrics == the stored roll-up - with lines re-tagged by numeric grounding, by a verdict, partial, gap and omnibus lines", async () => {
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
    assertEquals(seen.pkgs.length, 1, "the curator was handed one package");
    const cmp = await compareRun(c, r, specs);
    console.log(`CASE 41: kind ${r.metrics.credibility!.kind}; ungrounded figures ${JSON.stringify(r.ungroundedNumbers)}; ` +
      `lines ${cmp.lines}, filed ${cmp.filed}, bit-identical ${cmp.bit}/${cmp.filed}, unfiled ${cmp.unfiled}, re-tagged after the verdict ${cmp.retagged}, ` +
      `partial ${cmp.partial}, gap ${cmp.gap}, omnibus ${cmp.omnibus}; metrics ${JSON.stringify({ v: r.metrics.credibility!.value, below: r.metrics.credibility!.below_floor, lines: r.metrics.credibility!.lines })}; ` +
      `footer '${(r.prose.match(/report credibility [^ ]+/) ?? [""])[0]}'`);
    console.log("CASE 41 filed synthesis:\n" + seen.filed[0]);
    for (const b of cmp.bad) console.log(`  DISAGREE ${b}`);
    // the case is not vacuous: every shape the finding named is in it
    assert(cmp.retagged >= 2, `re-tagged by numeric grounding after a supports verdict: ${cmp.retagged}`);
    assert(cmp.partial >= 2 && cmp.gap >= 1 && cmp.omnibus >= 2 && cmp.filed >= 7, JSON.stringify(cmp));
    assert((r.ungroundedNumbers ?? []).length >= 3, `numeric grounding re-tagged ${JSON.stringify(r.ungroundedNumbers)}`);
    assertEquals(cmp.bad, [], "run vs stored disagreements");
    assertEquals(cmp.bit, cmp.filed);
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
t("attempt 5 A4-1 (Case 42): the twins sweep in harden()'s REAL order - hardenJudged (verdicts, then numeric grounding), curatorCopyLines, finalLineCredibility - through the curator's writeClaims: every filed claim bit-identical, every floor verdict, footer and metrics agree, under owner edge-factor changes", async () => {
  assert(typeof HX.hardenJudged === "function" && typeof CX.finalLineCredibility === "function",
    "harness.ts exports hardenJudged and credibility.ts exports finalLineCredibility (the functions harden() and the scoring call)");
  const { writeClaims } = await curator();
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
  const s = { runs: 0, lines: 0, filed: 0, bit: 0, retagged: 0, bad: [] as string[], footers: 0 };
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
        for (let li = 0; li < 12; li++) {
          const tk = `zq${letters(10)}`;
          if (r() < 0.06) { synthLines.push(`[GAP] Nothing on ${tk}.`); continue; }
          const tag = pick(["SOURCED", "SOURCED", "INFERRED", "UNCERTAIN", "Sourced", "inferred"]);
          const k = pick([1, 1, 2, 3, 4, 5, 6, 7]);
          const cites = Array.from({ length: k }, () => 1 + Math.floor(r() * n));
          if (r() < 0.1) cites.push(n + 1 + Math.floor(r() * 3));
          if (r() < 0.1) cites.push(cites[0]);
          const body = `The widget ${tk} ships in size ${figures[li]} cm.`;
          const cite = r() < 0.2 && cites.length > 1 ? `[Source ${cites[0]}][Source ${cites.slice(1).join(", ")}]` : `[Source ${cites.join(", ")}]`;
          synthLines.push(`[${tag}] ${body} ${cite}`);
        }
        const synthesis = synthLines.join("\n");
        const verdicts: LineVerdict[] = citedLines(synthesis).map((l) => ({ line: l.index, text: l.text, tag: l.tag, cites: l.cites,
          verdict: pick(["supports", "supports", "partial", "unsupported"]), basis: "judge", rationale: "", cited_text: [] } as LineVerdict));
        const effects = [...m.verdicts.values()].map((v) => ({ key: v.key, tagEffect: v.tagEffect }));
        // harden()'s order, through the functions harden() calls
        const hardened = HX.hardenJudged(synthesis, verdicts, effects, rows.map((p) => p.content)).synthesis as string;
        const lines = HX.curatorCopyLines(hardened, new Set<number>()) as Array<string | null>;
        const { synthesis: curatorSyn, cited } = buildCitedAndRenumber(lines.filter((l) => l !== null).join("\n"), rows);
        const tsLines = CX.finalLineCredibility(m, kind, verdicts, lines, (x: number, grounders: number[]) => {
          const p = rows[x - 1];
          if (!p) return null;
          const coCited = new Set(grounders.filter((g) => rows[g - 1]).map((g) => rows[g - 1].id));
          const score = { family: p.family, score: p.score, reasons: [], model_version: "s",
            signals: p.family === "general" ? general(p.primary) : { cited_by: null, author_works_count: null, age_years: null } } as unknown as C.SourceScore;
          return C.foldReceived(C.weightedTotal(m, kind, score).total, received.get(p.id) ?? [], coCited);
        }) as C.FiledLine[];
        await writeClaims(c, curatorSyn, { threadId: null, synthesisId: null, sourceIds: cited.map((p) => p.id), volatility: "slow", claimMetadata: { claim_kind: kind } });
        const floor = Number((await one<{ f: number }>(c, `SELECT public.credibility_claim_floor($1) AS f`, [kind])).f);
        let storedBelow = 0;
        const storedTotals: number[] = [];
        for (const [i, v] of verdicts.entries()) {
          s.lines++;
          const ts = tsLines[i];
          const tk = (v.text.match(/zq[a-z]{10}/) ?? [""])[0];
          const row = await one<{ id: string; tag: string }>(c, `SELECT id::text AS id, epistemic_tag AS tag FROM public.claims WHERE status = 'active' AND text LIKE '%' || $1 || '%'`, [tk]);
          const label = `${kind} run ${run} line ${v.line} [${v.tag}] ${v.verdict} cites ${JSON.stringify(v.cites)} ef ${JSON.stringify(ef)}`;
          if (!row) {
            if (ts.total !== 0) s.bad.push(`${label}: not filed, TS line total ${ts.total}`);
            storedTotals.push(0); storedBelow++;
            continue;
          }
          s.filed++;
          if (row.tag !== String(v.tag).toLowerCase() && v.verdict === "supports" && v.cites.length <= 4) s.retagged++;
          const sql = Number((await one<{ v: number }>(c, `SELECT public.claim_confidence_d15($1) AS v`, [row.id])).v);
          const view = await one<{ v: number; b: boolean }>(c, `SELECT after_confidence AS v, below_floor_after AS b FROM public.credibility_before_after WHERE claim_id = $1`, [row.id]);
          if (sql === ts.total && Number(view.v) === sql && ts.filed_tag === row.tag) s.bit++;
          else s.bad.push(`${label}: filed ${row.tag} SQL ${sql} view ${view.v} | TS ${ts.total} (TS tag ${ts.filed_tag})`);
          if ((sql < floor) !== ts.below_floor || view.b !== (sql < floor)) s.bad.push(`${label}: FLOOR SQL ${sql < floor} view ${view.b} TS ${ts.below_floor}`);
          storedTotals.push(sql);
          if (sql < floor) storedBelow++;
        }
        const rep = C.reportCredibility(m, kind, tsLines);
        const storedMean = storedTotals.length ? r3(storedTotals.reduce((a, x) => a + x, 0) / storedTotals.length) : null;
        s.footers++;
        if (rep.below_floor !== storedBelow) s.bad.push(`${kind} run ${run}: METRICS below_floor ${rep.below_floor} stored ${storedBelow}`);
        if (rep.value !== storedMean) s.bad.push(`${kind} run ${run}: FOOTER ${rep.value} stored ${storedMean}`);
        await c.queryArray(`DELETE FROM public.claim_sources WHERE claim_id IN (SELECT id FROM public.claims WHERE text LIKE '%zq%')`);
        await c.queryArray(`DELETE FROM public.claims WHERE text LIKE '%zq%'`);
      }
    }
  });
  console.log(`CASE 42 (mode B, harden()'s order): runs ${s.runs}, lines ${s.lines}, filed ${s.filed}, re-tagged by numeric grounding after a supports verdict ${s.retagged}, ` +
    `bit-identical ${s.bit}/${s.filed}, footers/metrics compared ${s.footers}, disagreements ${s.bad.length}`);
  for (const b of s.bad.slice(0, 8)) console.log(`  ${b}`);
  assert(s.retagged >= 10, `the sweep re-tags lines after the verdict (${s.retagged})`);
  assertEquals(s.bad, []);
  assertEquals(s.bit, s.filed);
});

// ── Case 43: the refinery path (N2) through the REAL fold ────────────────────────────────────────────
t("attempt 5 N2 (Case 43): the refinery path - a line grounded only in an unfolded held source is not filed and totals 0 (below the floor), a partly-stripped line is scored with its remaining citations, a folded source's corroboration is in the total; footer == metrics == the stored roll-up", async () => {
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
    const cmp = await compareRun(c, r, specs);
    console.log(`CASE 43: fold ${JSON.stringify(fold)}; lines ${cmp.lines}, filed ${cmp.filed}, unfiled ${cmp.unfiled}, bit-identical ${cmp.bit}/${cmp.filed}; ` +
      `metrics ${JSON.stringify({ v: r.metrics.credibility!.value, below: r.metrics.credibility!.below_floor, lines: r.metrics.credibility!.lines })}; footer '${(r.prose.match(/report credibility [^ ]+/) ?? [""])[0]}'`);
    console.log("CASE 43 filed synthesis:\n" + (seen.filed[0] ?? "(none)"));
    for (const b of cmp.bad) console.log(`  DISAGREE ${b}`);
    assert(fold.includes("held.example.gov:held_folded") && fold.includes("held-blog.example.com:held_kept"), JSON.stringify(fold));
    assert(cmp.unfiled >= 1, "a line grounded only in the unfolded held source is not filed");
    assert(!String(seen.filed[0]).includes(specs[2].tok), "the held-only line never reaches the curator");
    assertEquals(cmp.bad, [], "run vs stored disagreements");
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
