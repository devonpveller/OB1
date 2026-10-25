/**
 * rw-p3a-entail attempt 6 (the structural round) - THE INVARIANT, as a reusable comparison over a REAL
 * database: for a run, the claims the pipeline scores (RunResult.lineCredibility, the footer and
 * research_jobs.metrics.credibility) EQUAL the claims the curator's own writeClaims files from that
 * run's package - same count, same order, same texts, same tags, same edges (source, type, stored REAL
 * weight) - and every scored total equals the filed claim's claim_confidence_d15 and the view's
 * after_confidence bit for bit, with the same floor verdict, and storeConfidence(total) equals the
 * stored REAL after the operator's flip. The report figure is the filed claims' mean and below-floor
 * count (a judged line that yields no filed claim contributes nothing), and judged_not_filed is the
 * number of judged lines that yield no filed claim.
 *
 * The one place the totals may differ is the named residual R1 (two package sources with identical
 * fetched text become ONE stored source, find_or_create_source's md5(content) dedup): the claim is
 * still the same claim (text, tag, order) but it is filed with fewer distinct sources than it cites.
 * Such a claim is counted as `r1`, never as agreement, and only when one of its cited package sources
 * really persisted to the same id as another package source, or (rw-p3a-figure-filed, F8: narrowed)
 * when a stored source it cites received corroboration THROUGH the merge - one scored claim co-cites
 * that source with two or more package copies of the merged source and the store holds the collapsed
 * row (the run gave one amount per package copy; source_corroborations keeps one per (from, to, claim
 * text)), and the merged source is not one of this claim's own grounders (p_exclude would drop it).
 * A claim whose source got corroboration from a merged source by ONE copy is not exempt. An exempt
 * claim's total is still checked: claim_confidence_d15 must equal the expected total computed with the
 * merged amount - the D15 claim math (credibility.ts edgeTotal, claimTotal) over its stored edges, each
 * source's rolling total read from the store (source_rolling_total_core, which holds the one merged row).
 *
 * Used by credibility-attempt5.e2e.test.ts (Cases 41-43) and credibility-attempt6.e2e.test.ts (Cases
 * 47-48). Test-only: the runtime image ships no fixtures.
 */
import type { PoolClient } from "postgres";
import * as C from "../credibility.ts";
import type { Deps, FetchResult, RunResult, SearchHit } from "../harness.ts";
import { fixtureResolver } from "./scholarly-network.ts";

export const ENTITY = "vestibular motion sickness";
export const QUERY = "Research on the mechanism of vestibular motion sickness: what do studies show?";
export const host = (u: string) => new URL(u).hostname;
export const page = (url: string, content: string, links: string[] = []): FetchResult => ({
  page: { url, title: `${ENTITY} - ${host(url)}`, content, domain: host(url), links }, outcome: "ok",
});
export const r3 = (x: number) => Math.round(x * 1000) / 1000;
export const one = async <T>(c: PoolClient, sql: string, args: unknown[] = []) => (await c.queryObject<T>(sql, args)).rows[0];

/** One synthesis line. `line` (when set) is emitted verbatim, each {url} replaced by that page's [Source N]. */
export interface LineSpec {
  tok: string; tag: string; text: string; cites: string[]; verdict: string;
  split?: boolean; dup?: boolean; raw?: string; line?: string;
}

/** The synthesizer stub: each spec line cites the pool pages it names by the [Source N] the prompt gave them. */
export function synthFrom(specs: LineSpec[]) {
  return (block: string): string => {
    const n = (url: string) => {
      for (const l of block.split("\n")) {
        const i = l.indexOf("[Source ");
        if (i >= 0 && l.includes(`(${host(url)})`)) return Number(l.slice(i + 8, l.indexOf("]", i)));
      }
      return 0;
    };
    return specs.map((s) => {
      if (s.line !== undefined) return s.line.replace(/\{(https?:[^}]*)\}/g, (_m, u) => String(n(u)));
      if (s.tag === "GAP") return `[GAP] ${s.text} ${s.tok}.`;
      const nums = s.cites.map(n).filter((x) => x > 0);
      if (s.dup && nums.length) nums.push(nums[0]);
      const cite = s.raw ?? (s.split && nums.length > 1 ? `[Source ${nums[0]}][Source ${nums.slice(1).join(", ")}]` : `[Source ${nums.join(", ")}]`);
      return `[${s.tag}] ${s.text}${s.tok ? " " + s.tok : ""}. ${cite}`;
    }).join("\n");
  };
}

export type Curator = {
  writeClaims: (c: unknown, s: string, o: Record<string, unknown>) => Promise<{ claimIds: string[]; metaSkipped: number; claimsWritten: number; claimsDeduped: number }>;
  claimList?: (s: string) => { claims: Array<{ text: string; tag: string; edges: Array<{ sourceIndex: number; edgeType: string; weight: number }> }>; dropped: Array<{ reason: string }> };
  LINK_EDGE_SQL?: string;
};
export async function curator(): Promise<Curator> {
  const dir = Deno.env.get("CURATOR_DIR");
  const url = dir ? `file://${dir.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}/claims.ts` : new URL("../../research-curator/claims.ts", import.meta.url).href;
  return await import(url) as Curator;
}

export interface Filed { pkg: Record<string, unknown>; synthesis: string; sourceIds: string[]; claimIds: string[] }

/** Every model / network seam stubbed; the curator REAL: the package's sources are persisted as the
 *  curator does (find_or_create_source) and ITS writeClaims files the package's synthesis (trimmed, as
 *  index.ts writeGroundedClaims hands it). */
export function realDeps(c: PoolClient, cur: Curator, specs: LineSpec[], pages: Record<string, FetchResult>, hits: SearchHit[]) {
  const seen = { filed: [] as Filed[] };
  const d: Deps = {
    embed: () => Promise.resolve(new Array(1024).fill(0)),
    chat: (sys, user) => {
      if (sys.includes("ENTAILMENT JUDGE")) {
        const claim = (user.match(/^CLAIM \(tagged \[[A-Z]+\]\): (.*)$/m) ?? [])[1] ?? "";
        const s = specs.find((x) => x.tok && claim.includes(x.tok));
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
    delegateToCurator: async (pkg) => {
      const ids: string[] = [];
      for (const s of pkg.sources as Array<{ url: string; title: string; content: string; domain: string }>) {
        const r = await one<{ id: string }>(c, `SELECT id::text AS id FROM public.find_or_create_source($1, $2, NULL, $3, 'web_article', NULL, $4, NULL::vector, '{}'::jsonb)`,
          [s.url, s.content, s.title, s.domain]);
        ids.push(r.id);
      }
      const synthesis = String(pkg.synthesis ?? "").trim();
      const res = await cur.writeClaims(c, synthesis, { threadId: null, synthesisId: null, sourceIds: ids, volatility: "slow",
        claimMetadata: { claim_kind: pkg.claim_kind } });
      seen.filed.push({ pkg, synthesis, sourceIds: ids, claimIds: res.claimIds });
      return { thread_id: null, persist: { source_ids: ids }, claims: res };
    },
    scholarly: fixtureResolver(),
    admission: null,
  };
  return { d, seen };
}

export interface Invariant {
  judged: number; scored: number; filed: number; bit: number; r1: number; bad: string[];
  storedMean: number | null; storedBelow: number; notFiled: number; retagged: number; unjudgedFiled: number;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

// deno-lint-ignore no-explicit-any
type AnyScored = any;

/**
 * THE INVARIANT for one run (see the header). `filed` is what the curator was handed and filed (null =
 * no package was sent: then nothing may be scored). Returns every disagreement in `bad`.
 */
export async function compareInvariant(c: PoolClient, r: RunResult, filed: Filed | null, label = "run"): Promise<Invariant> {
  const kind = r.metrics.credibility!.kind;
  const floor = Number((await one<{ f: number }>(c, `SELECT public.credibility_claim_floor($1) AS f`, [kind])).f);
  const scored = (r.lineCredibility ?? []) as AnyScored[];
  const ids = filed?.claimIds ?? [];
  const out: Invariant = { judged: r.verdicts.length, scored: scored.length, filed: ids.length, bit: 0, r1: 0, bad: [],
    storedMean: null, storedBelow: 0, notFiled: 0, retagged: 0, unjudgedFiled: 0 };
  if (scored.length !== ids.length) out.bad.push(`${label}: COUNT scored ${scored.length} filed ${ids.length}`);
  if (new Set(ids).size !== ids.length) out.bad.push(`${label}: the curator filed ${ids.length} claims into ${new Set(ids).size} rows (a same-run merge)`);
  const stored: number[] = [];
  const r1Totals: number[] = [];
  // R1's reach: a stored source that two package sources persisted to, and every stored source that
  // received corroboration from one (the run gave it one amount per package source, the store one)
  const mergedIds = [...new Set((filed?.sourceIds ?? []).filter((x, k, a) => a.indexOf(x) !== k))];
  // F8 (narrowed): T -> the merged sources whose corroboration of T collapsed in the store - a scored
  // claim co-cites T with >= 2 package copies of S, and the store holds a corroboration row S -> T
  const rows = mergedIds.length
    ? (await c.queryObject<{ f: string; t: string }>(`SELECT DISTINCT from_source_id::text AS f, to_source_id::text AS t FROM public.source_corroborations WHERE from_source_id = ANY($1::uuid[])`, [mergedIds])).rows
    : [];
  const viaMerge = new Map<string, Set<string>>();
  for (const s of scored) {
    const cites = [...new Set((s.edges ?? []).map((e: { cite: number }) => e.cite))] as number[];
    const stored = cites.map((k) => filed!.sourceIds[k - 1]);
    for (const S of mergedIds) {
      if (stored.filter((x) => x === S).length < 2) continue;
      for (const T of new Set(stored)) {
        if (!T || T === S || !rows.some((r) => r.f === S && r.t === T)) continue;
        if (!viaMerge.has(T)) viaMerge.set(T, new Set());
        viaMerge.get(T)!.add(S);
      }
    }
  }
  let model: C.CredibilityModel | null = null;
  /** The expected total of an R1 claim, with the merged amount: the D15 claim math over its STORED edges. */
  const expectedFromStore = async (claimId: string) => {
    model ??= await C.loadCredibilityModel(c);
    const es = (await c.queryObject<{ sid: string; t: string; w: number }>(
      `SELECT source_id::text AS sid, edge_type AS t, weight::float8 AS w FROM public.claim_sources
        WHERE claim_id = $1 AND source_id IS NOT NULL AND edge_type <> 'contradicts'`, [claimId])).rows;
    const grounders = [...new Set(es.map((e) => e.sid))];
    const best = new Map<string, number>();
    for (const e of es) {
      const srt = Number((await one<{ v: number }>(c, `SELECT public.source_rolling_total_core($1::uuid, $2, NULL::jsonb, $3::uuid[]) AS v`,
        [e.sid, kind, grounders])).v);
      const t = C.edgeTotal(model, srt, e.t, Number(e.w));
      best.set(e.sid, Math.max(best.get(e.sid) ?? 0, t));
    }
    return best.size ? C.claimTotal(model, floor, [...best.values()]).total : 0;
  };
  const toFlip: Array<{ id: string; total: number; at: string }> = [];
  for (let i = 0; i < Math.max(scored.length, ids.length); i++) {
    const s = scored[i];
    const id = ids[i];
    const at = `${label} claim ${i}`;
    if (!s || !id) continue;
    const row = await one<{ text: string; tag: string }>(c, `SELECT text, epistemic_tag AS tag FROM public.claims WHERE id = $1`, [id]);
    const edges = (await c.queryObject<{ sid: string; t: string; w: number }>(
      `SELECT source_id::text AS sid, edge_type AS t, weight::float8 AS w FROM public.claim_sources WHERE claim_id = $1`, [id])).rows;
    const d15 = Number((await one<{ v: number }>(c, `SELECT public.claim_confidence_d15($1) AS v`, [id])).v);
    const view = await one<{ v: number; b: boolean }>(c,
      `SELECT after_confidence AS v, below_floor_after AS b FROM public.credibility_before_after WHERE claim_id = $1`, [id]);
    if (s.text !== row.text) out.bad.push(`${at}: TEXT scored ${JSON.stringify(s.text)} filed ${JSON.stringify(row.text)}`);
    if (s.filed_tag !== row.tag) out.bad.push(`${at}: TAG scored ${s.filed_tag} filed ${row.tag}`);
    const want = (s.edges ?? []).map((e: { cite: number; edge_type: string; weight: number }) =>
      `${filed!.sourceIds[e.cite - 1]}|${e.edge_type}|${Math.fround(e.weight)}`);
    const got = edges.map((e) => `${e.sid}|${e.t}|${Number(e.w)}`);
    const sids = (s.edges ?? []).map((e: { cite: number }) => filed!.sourceIds[e.cite - 1]);
    // R1 scope (F8, narrowed): the claim cites a package source that persisted to the same stored
    // source as another package source (its edges collapse), or a stored source whose corroboration
    // from a merged source came THROUGH the merge and is not excluded on this claim (not a grounder)
    const direct = sids.some((sid: string) => mergedIds.includes(sid));
    const hop = !direct && sids.some((sid: string) => [...(viaMerge.get(sid) ?? [])].some((S) => !sids.includes(S)));
    if (direct || hop) {
      out.r1++;
      r1Totals.push(s.total);
      if (direct && (!got.length || !got.every((g) => want.includes(g)))) {
        out.bad.push(`${at}: EDGES (R1) scored ${want.join(" ")} filed ${got.join(" ")}`);
      }
      if (hop && [...want].sort().join() !== [...got].sort().join()) out.bad.push(`${at}: EDGES (R1 hop) scored ${want.join(" ")} filed ${got.join(" ")}`);
      // the total is checked, with the merged amount (never skipped)
      const expected = await expectedFromStore(id);
      if (d15 !== expected || Number(view.v) !== d15) out.bad.push(`${at}: TOTAL (R1) d15 ${d15} view ${view.v} expected with the merged amount ${expected}`);
      continue;
    }
    if ([...want].sort().join() !== [...got].sort().join()) out.bad.push(`${at}: EDGES scored ${want.join(" ")} filed ${got.join(" ")}`);
    if (s.total === d15 && Number(view.v) === d15) out.bit++;
    else out.bad.push(`${at}: TOTAL scored ${s.total} d15 ${d15} view ${view.v}`);
    if (s.below_floor !== (d15 < floor) || view.b !== (d15 < floor)) out.bad.push(`${at}: FLOOR scored ${s.below_floor} d15 ${d15 < floor} view ${view.b}`);
    stored.push(d15);
    if (d15 < floor) out.storedBelow++;
    toFlip.push({ id, total: s.total, at });
    if (s.line === null || s.line === undefined) out.unjudgedFiled++;
    else {
      const v = r.verdicts.find((x) => x.line === s.line);
      if (!v) out.bad.push(`${at}: on judged line ${s.line}, which has no verdict`);
      else {
        // numeric grounding appends its note to the filed text; the judged text is the line before it
        const asserted = row.text.replace(/\s*\(unverified figures?:[^)]*\)\s*$/i, "");
        if (!squash(v.text).includes(squash(asserted))) out.bad.push(`${at}: mapped to judged line ${s.line} '${v.text.slice(0, 60)}', which does not hold '${row.text.slice(0, 60)}'`);
        if (v.verdict === "supports" && s.filed_tag !== String(v.tag).toLowerCase() && (v.cites ?? []).length <= 4) out.retagged++;
      }
    }
  }
  const mc = r.metrics.credibility! as AnyScored;
  // the report figure: the filed claims (R1 claims included at their scored total - the residual - and
  // compared separately below)
  const all = [...stored, ...r1Totals];
  out.storedMean = all.length ? r3(all.reduce((a, x) => a + x, 0) / all.length) : null;
  const scoredMean = scored.length ? r3(scored.reduce((a: number, x: AnyScored) => a + x.total, 0) / scored.length) : null;
  if (mc.value !== scoredMean) out.bad.push(`${label}: METRICS value ${mc.value}, the scored claims' mean ${scoredMean}`);
  if (!out.r1 && mc.value !== out.storedMean) out.bad.push(`${label}: METRICS value ${mc.value} stored ${out.storedMean}`);
  if (!out.r1 && mc.below_floor !== out.storedBelow) out.bad.push(`${label}: METRICS below_floor ${mc.below_floor} stored ${out.storedBelow}`);
  if ((mc.claims ?? mc.lines) !== ids.length) out.bad.push(`${label}: METRICS claims ${mc.claims ?? mc.lines} filed ${ids.length}`);
  const judgedLines = [...new Set(r.verdicts.map((v) => v.line))];
  out.notFiled = judgedLines.filter((l) => !scored.some((s: AnyScored) => s.line === l)).length;
  if (mc.judged_lines !== judgedLines.length) out.bad.push(`${label}: METRICS judged_lines ${mc.judged_lines} verdicts ${judgedLines.length}`);
  if (mc.judged_not_filed !== out.notFiled) out.bad.push(`${label}: METRICS judged_not_filed ${mc.judged_not_filed} counted ${out.notFiled}`);
  if (r.prose) {
    const footer = (r.prose.match(/report credibility(?::)? [^ ]+/) ?? [""])[0];
    const want = mc.value === null ? "report credibility: n/a" : `report credibility ${Number(mc.value).toFixed(2)}`;
    if (footer !== want) out.bad.push(`${label}: FOOTER '${footer}' metrics ${mc.value}`);
    if (!out.r1 && out.storedMean !== null && footer !== `report credibility ${out.storedMean.toFixed(2)}`) out.bad.push(`${label}: FOOTER '${footer}' stored ${out.storedMean}`);
  }
  // the stored REAL after the operator's flip: storeConfidence(scored total) bit for bit
  await c.queryArray(`UPDATE public.credibility_trigger_state SET model = 'd15'`);
  for (const x of toFlip) {
    const v = Number((await one<{ v: number }>(c, `SELECT public.recompute_claim_confidence($1::uuid)::float8 AS v`, [x.id])).v);
    if (v !== C.storeConfidence(x.total, floor)) out.bad.push(`${x.at}: STORED ${v} storeConfidence(scored) ${C.storeConfidence(x.total, floor)}`);
  }
  await c.queryArray(`UPDATE public.credibility_trigger_state SET model = 'legacy'`);
  return out;
}
