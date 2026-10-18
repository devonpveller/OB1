/**
 * rw-p3a-entail attempt 6 (the structural round) over a REAL database - THE INVARIANT: for every run, the
 * claims the pipeline scores for the footer and research_jobs.metrics.credibility EQUAL the claims the
 * curator files from that run's package (same texts, tags, edges and citations, in the same order), and
 * every scored total equals the filed claim's claim_confidence_d15 bit for bit (fixtures/
 * credibility-invariant.ts compareInvariant). The report figure is over the filed claims only; a judged
 * line the curator does not file contributes nothing and is counted in judged_not_filed.
 *
 *   Case 47  one refinery run through the REAL runResearch (every model / network seam stubbed, the
 *            database real, the fold real) -> the curator's own writeClaims, its package holding every
 *            drop rule: the same text twice in one synthesis, a case-only duplicate, empty claim texts,
 *            meta-claims, held-only lines, omnibus, partial, unsupported (GAP), a [GAP] line, lines
 *            re-tagged by numeric grounding, two tags on one line, a citation on a continuation line,
 *            no citation, an out-of-pool citation, and two pool sources with identical text (R1).
 *   Case 47b the tester's A5-1 / A5-2 shapes verbatim (adv5-paths.test.ts P2 and P5).
 *   Case 48  the randomised property test: seeded, >= 2000 synthesis lines over many runs (six claim
 *            kinds, web and refinery runs), every drop rule mixed at random, every run through
 *            runResearch -> writeClaims, the invariant asserted per run.
 * SKIPPED unless CRED_E2E_DB_HOST is set; run-credibility-e2e.ps1 runs it on its disposable database.
 * One transaction per run, rolled back.
 * Run (by the runner): deno test --allow-net --allow-env --allow-read credibility-attempt6.e2e.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Pool, type PoolClient } from "postgres";
import * as H from "./harness.ts";
import type { FetchResult, SearchHit } from "./harness.ts";
import {
  compareInvariant, curator, ENTITY, type Filed, host, type Invariant, type LineSpec, page, QUERY, realDeps,
} from "./fixtures/credibility-invariant.ts";

const HOST = Deno.env.get("CRED_E2E_DB_HOST");
const pool = HOST
  ? new Pool({ hostname: HOST, port: Number(Deno.env.get("CRED_E2E_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CRED_E2E_DB_USER") ?? "postgres", password: Deno.env.get("CRED_E2E_DB_PASSWORD") ?? "" }, 2, true)
  : null;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore: !HOST, fn, sanitizeOps: false, sanitizeResources: false });
const id = () => crypto.randomUUID();
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

const PAPER = "https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2021.757735/full";
const VIA = "https://www.nature.com/articles/s44172-025-00417-2";
const NEWS = "https://www.reuters.com/health/vestibular-motion-sickness-2026";
const NEWS2 = "https://www.npr.org/health/vestibular-motion-sickness";
const DUPA = "https://www.bbc.com/news/health-vestibular-motion-sickness";
const DUPB = "https://apnews.com/article/vestibular-motion-sickness-travel";
const EXTRA = ["https://www.theguardian.com/science/vestibular-motion-sickness", "https://www.cnn.com/health/vestibular",
  "https://www.washingtonpost.com/health/vestibular"];
const HELD_OK = "https://held.example.gov/report";
const HELD_LOW = "https://held-blog.example.com/post";
const basePages = (): Record<string, FetchResult> => ({
  [PAPER]: page(PAPER, `Visually induced ${ENTITY} follows a visual-vestibular mismatch. `.repeat(20)),
  [VIA]: page(VIA, `Galvanic vestibular stimulation changed ${ENTITY} by 26% in 10 participants. `.repeat(20)),
  [NEWS]: page(NEWS, `Doctors say ${ENTITY} is common among travellers. `.repeat(20)),
  [NEWS2]: page(NEWS2, `Clinicians report ${ENTITY} in commuters and sailors. `.repeat(20)),
  // identical fetched text: find_or_create_source stores ONE source for the two (the named residual R1)
  [DUPA]: page(DUPA, `Syndicated wire copy: ${ENTITY} is widely discussed in the press. `.repeat(20)),
  [DUPB]: page(DUPB, `Syndicated wire copy: ${ENTITY} is widely discussed in the press. `.repeat(20)),
  ...Object.fromEntries(EXTRA.map((u) => [u, page(u, `Reporters at ${host(u)} say ${ENTITY} is in the news. `.repeat(20))])),
});
const hitsOf = (urls: string[]): SearchHit[] => urls.map((u) => ({ url: u, title: `${ENTITY} ${host(u)}`, snippet: `${ENTITY} ${host(u)}` }));
const tok = () => `zq${id().replace(/[^a-f]/g, "").slice(0, 10)}`;

async function heldRefinery(c: PoolClient): Promise<string> {
  const refinery = id();
  await c.queryObject(`INSERT INTO public.ideas (id, title) VALUES ($1, 'p3a attempt 6 refinery')`, [refinery]);
  for (const [url, body] of [[HELD_OK, `${ENTITY} report `], [HELD_LOW, `${ENTITY} blog `]]) {
    const h = id();
    await c.queryObject(`INSERT INTO public.held_sources (id, refinery_id, url, title, content) VALUES ($1, $2, $3, $4, $5)`,
      [h, refinery, url, `held ${host(url)}`, body.repeat(40)]);
    await c.queryObject(`INSERT INTO public.refinery_user_sources (refinery_id, source_id, status) VALUES ($1, $2, 'held')`, [refinery, h]);
  }
  return refinery;
}

interface RunOut { inv: Invariant; filed: Filed | null; r: H.RunResult; dropped: Record<string, number> }
async function runOnce(c: PoolClient, specs: LineSpec[], urls: string[], o: { query?: string; refinery?: boolean } = {}): Promise<RunOut> {
  const cur = await curator();
  const refineryId = o.refinery ? await heldRefinery(c) : undefined;
  const { d, seen } = realDeps(c, cur, specs, basePages(), hitsOf(urls));
  const r = await H.runResearch(d, c, o.query ?? QUERY, { origin: "owui", ...(refineryId ? { refineryId } : {}) });
  const filed = seen.filed[0] ?? null;
  const inv = await compareInvariant(c, r, filed);
  const dropped: Record<string, number> = {};
  for (const x of (filed && cur.claimList ? cur.claimList(filed.synthesis).dropped : [])) dropped[x.reason] = (dropped[x.reason] ?? 0) + 1;
  return { inv, filed, r, dropped };
}
const summary = (x: RunOut) => {
  const mc = x.r.metrics.credibility! as unknown as Record<string, unknown>;
  return `kind ${mc.kind}; judged ${x.inv.judged}, scored ${x.inv.scored}, filed ${x.inv.filed}, bit-identical ${x.inv.bit}, R1 ${x.inv.r1}, ` +
    `judged-not-filed ${x.inv.notFiled}, filed-off-a-judged-line ${x.inv.unjudgedFiled}, re-tagged ${x.inv.retagged}; dropped ${JSON.stringify(x.dropped)}; ` +
    `metrics ${JSON.stringify({ v: mc.value, below: mc.below_floor, claims: mc.claims ?? mc.lines, judged: mc.judged_lines, not_filed: mc.judged_not_filed })}; ` +
    `stored mean ${x.inv.storedMean} below ${x.inv.storedBelow}; footer '${(x.r.prose.match(/report credibility(?::)? [^ ]+/) ?? [""])[0]}'`;
};

// ── Case 47: every drop rule in one package ──────────────────────────────────────────────────────────
t("attempt 6 (Case 47): THE INVARIANT through the REAL runResearch -> the curator's writeClaims, one refinery run holding every drop rule - scored claims == filed claims (count, order, text, tag, edges), every total == claim_confidence_d15 == the view, footer == metrics == the filed claims", async () => {
  const dupA = tok(), dupB = tok(), two1 = tok(), two2 = tok(), cont = tok();
  const specs: LineSpec[] = [
    { tok: tok(), tag: "SOURCED", text: `Visually induced ${ENTITY} follows a visual-vestibular mismatch`, cites: [PAPER], verdict: "supports" },
    // A5-1: the same claim text twice in one synthesis, then a case-only duplicate
    { tok: dupA, tag: "SOURCED", text: `Doctors say ${ENTITY} is common among travellers`, cites: [NEWS], verdict: "supports" },
    { tok: dupA, tag: "SOURCED", text: `Doctors say ${ENTITY} is common among travellers`, cites: [PAPER, VIA], verdict: "supports" },
    { tok: dupB, tag: "INFERRED", text: `Clinicians report ${ENTITY} in commuters`, cites: [NEWS2], verdict: "supports" },
    { tok: dupB.toUpperCase(), tag: "SOURCED", text: `CLINICIANS REPORT ${ENTITY.toUpperCase()} IN COMMUTERS`, cites: [PAPER], verdict: "supports" },
    // A5-2: empty claim texts
    { tok: "", tag: "SOURCED", text: "", cites: [], verdict: "supports", line: `[SOURCED] [Source {${NEWS}}]` },
    { tok: "", tag: "SOURCED", text: "", cites: [], verdict: "supports", line: `[SOURCED] -- [Source {${PAPER}}]` },
    // meta-claims (the pattern layer)
    { tok: tok(), tag: "SOURCED", text: `The provided sources contain no information about ${ENTITY} in children`, cites: [PAPER], verdict: "supports" },
    { tok: tok(), tag: "INFERRED", text: `No study has tested ${ENTITY} in astronauts`, cites: [NEWS], verdict: "supports" },
    // held-only (dropped from the curator's copy), held + pool (stripped), the folded held source
    { tok: tok(), tag: "SOURCED", text: `A held blog says ${ENTITY} is vestibular`, cites: [HELD_LOW], verdict: "supports" },
    { tok: tok(), tag: "SOURCED", text: `A held blog and the press say ${ENTITY} is frequent`, cites: [HELD_LOW, NEWS], verdict: "supports" },
    { tok: tok(), tag: "SOURCED", text: `The held report says ${ENTITY} is vestibular`, cites: [HELD_OK, PAPER], verdict: "supports" },
    // numeric re-tag after a supports verdict; partial; unsupported -> GAP; omnibus (one partial)
    { tok: tok(), tag: "SOURCED", text: `Visually induced ${ENTITY} follows a mismatch in 12 of 20 subjects`, cites: [PAPER], verdict: "supports" },
    { tok: tok(), tag: "INFERRED", text: `Doctors say ${ENTITY} affects 40% of travellers`, cites: [NEWS], verdict: "supports" },
    { tok: tok(), tag: "SOURCED", text: `Doctors say ${ENTITY} is frequent on ferries`, cites: [NEWS], verdict: "partial" },
    { tok: tok(), tag: "INFERRED", text: `Doctors say ${ENTITY} is rare among sailors`, cites: [NEWS, NEWS2], verdict: "unsupported" },
    { tok: tok(), tag: "SOURCED", text: `${ENTITY} is in the news`, cites: [PAPER, NEWS, VIA, ...EXTRA], verdict: "supports" },
    { tok: tok(), tag: "SOURCED", text: `${ENTITY} is in 9 news outlets`, cites: [PAPER, NEWS, VIA, ...EXTRA], verdict: "partial", dup: true },
    { tok: tok(), tag: "GAP", text: `Nothing on the long-term course of ${ENTITY}`, cites: [], verdict: "supports" },
    // split + duplicate citations; no citation; an out-of-pool citation
    { tok: tok(), tag: "SOURCED", text: `Galvanic stimulation changed ${ENTITY} by 26% in 10 participants`, cites: [VIA, PAPER, VIA], verdict: "supports", split: true, dup: true },
    { tok: tok(), tag: "SOURCED", text: `Doctors say ${ENTITY} has no citation here`, cites: [], verdict: "supports", raw: "" },
    { tok: tok(), tag: "SOURCED", text: `Doctors say ${ENTITY} cites past the pool`, cites: [], verdict: "supports", raw: "[Source 99]" },
    // two tags on one line (the second is filed off a judged line); a citation on the continuation line
    { tok: two1, tag: "SOURCED", text: "", cites: [], verdict: "supports",
      line: `[SOURCED] Doctors say ${ENTITY} worsens at sea ${two1}. [Source {${NEWS}}] [INFERRED] Clinicians say ${ENTITY} eases on land ${two2}. [Source {${NEWS2}}]` },
    { tok: cont, tag: "SOURCED", text: "", cites: [], verdict: "supports",
      line: `[SOURCED] Visually induced ${ENTITY} also follows screen motion ${cont}.\nas the study shows [Source {${PAPER}}]` },
    // R1: two pool sources with identical text, co-cited
    { tok: tok(), tag: "SOURCED", text: `Wire copy says ${ENTITY} is widely discussed in the press`, cites: [DUPA, DUPB], verdict: "supports" },
  ];
  await inTx(async (c) => {
    const x = await runOnce(c, specs, [PAPER, VIA, NEWS, NEWS2, DUPA, DUPB, ...EXTRA], { refinery: true });
    const fold = (x.r.fold?.held ?? []).map((h) => `${host(h.url ?? "x")}:${h.outcome}`);
    console.log(`CASE 47: fold ${JSON.stringify(fold)}; ${summary(x)}`);
    console.log("CASE 47 filed synthesis:\n" + (x.filed?.synthesis ?? "(none)"));
    for (const b of x.inv.bad) console.log(`  DISAGREE ${b}`);
    assertEquals(x.inv.bad, [], "scored vs filed disagreements");
    // not vacuous: every drop rule fired, and the residual is pinned to its claim
    assert(fold.includes("held.example.gov:held_folded") && fold.includes("held-blog.example.com:held_kept"), JSON.stringify(fold));
    assert((x.dropped.duplicate_text ?? 0) >= 2 && (x.dropped.empty_text ?? 0) >= 2 && (x.dropped.meta_pattern ?? 0) >= 2, JSON.stringify(x.dropped));
    assert(!x.filed!.synthesis.includes(specs[9].tok), "the held-only line never reaches the curator");
    assert(x.inv.filed >= 10 && x.inv.notFiled >= 6 && x.inv.unjudgedFiled >= 1 && x.inv.retagged >= 1 && x.inv.r1 === 1, summary(x));
    // two tags on one judged line: two filed claims, both scored on that line
    const lines = (x.r.lineCredibility as unknown as Array<{ line: number | null }>).map((s) => s.line).filter((l) => l !== null);
    assert(lines.some((l, i) => lines.indexOf(l) !== i), "a judged line carries two filed claims");
    assertEquals(x.inv.bit + x.inv.r1, x.inv.filed);
  });
});

// ── Case 47b: the tester's A5-1 / A5-2 shapes, verbatim ──────────────────────────────────────────────
t("attempt 6 (Case 47b): the tester's A5-1 (adv5-paths P2: same-run identical text and a case-only duplicate) and A5-2 (P5: empty claim texts) - scored == filed, footer == metrics == the filed claims", async () => {
  const a = tok(), b = tok();
  const p2: LineSpec[] = [
    { tok: a, tag: "SOURCED", text: `Doctors say ${ENTITY} is common among travellers`, cites: [NEWS], verdict: "supports" },
    { tok: a, tag: "SOURCED", text: `Doctors say ${ENTITY} is common among travellers`, cites: [PAPER, VIA], verdict: "supports" },
    { tok: b, tag: "INFERRED", text: `Clinicians report ${ENTITY} in commuters`, cites: [NEWS2], verdict: "supports" },
    { tok: b, tag: "SOURCED", text: `CLINICIANS REPORT ${ENTITY.toUpperCase()} IN COMMUTERS`, cites: [PAPER], verdict: "supports" },
    { tok: tok(), tag: "SOURCED", text: `Visually induced ${ENTITY} follows a visual-vestibular mismatch`, cites: [PAPER], verdict: "supports" },
  ];
  const p5: LineSpec[] = [
    { tok: tok(), tag: "SOURCED", text: `Visually induced ${ENTITY} follows a visual-vestibular mismatch`, cites: [PAPER], verdict: "supports" },
    { tok: tok(), tag: "SOURCED", text: `Doctors say ${ENTITY} has no citation here`, cites: [], verdict: "supports", raw: "" },
    { tok: tok(), tag: "SOURCED", text: `Doctors say ${ENTITY} cites past the pool`, cites: [], verdict: "supports", raw: "[Source 99]" },
    { tok: tok(), tag: "SOURCED", text: `Doctors say ${ENTITY} cites source zero`, cites: [], verdict: "supports", raw: "[Source 0]" },
    { tok: "", tag: "SOURCED", text: "", cites: [], verdict: "supports", line: `[SOURCED] [Source {${NEWS}}]` },
    { tok: "", tag: "SOURCED", text: "", cites: [], verdict: "supports", line: `[SOURCED] -- [Source {${PAPER}}]` },
  ];
  const bad: string[] = [];
  for (const [name, specs, urls] of [["A5-1 (P2)", p2, [PAPER, VIA, NEWS, NEWS2]], ["A5-2 (P5)", p5, [PAPER, NEWS]]] as Array<[string, LineSpec[], string[]]>) {
    await inTx(async (c) => {
      const x = await runOnce(c, specs, urls);
      console.log(`CASE 47b ${name}: ${summary(x)}`);
      for (const z of x.inv.bad) console.log(`  DISAGREE ${z}`);
      bad.push(...x.inv.bad.map((z) => `${name} ${z}`));
    });
  }
  assertEquals(bad, []);
});

// ── Case 48: the randomised property test ────────────────────────────────────────────────────────────
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
const QUERIES = [
  QUERY,
  "What changed in the latest vestibular motion sickness app release?",
  "How much does vestibular motion sickness treatment cost?",
  "Was there an outage of the vestibular motion sickness tracker status page?",
  "Which vestibular motion sickness drug was discontinued?",
  "How to avoid vestibular motion sickness on a ferry?",
];
t("attempt 6 (Case 48): the property test - seeded, >= 2000 synthesis lines, every drop rule mixed at random over six claim kinds and web + refinery runs, each run through runResearch -> writeClaims: scored == filed and bit-identical in every run", async () => {
  const seed = Number(Deno.env.get("PROP6_SEED") ?? 20261018);
  const runs = Number(Deno.env.get("PROP6_RUNS") ?? 190);
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const POOL = [PAPER, VIA, NEWS, NEWS2, DUPA, ...EXTRA];
  // DUPB (DUPA's identical text: the named residual R1) is cited rarely, so most claims are bit-comparable
  const poolPick = () => (r() < 0.03 ? DUPB : pick(POOL));
  const s = { runs: 0, lines: 0, judged: 0, scored: 0, filed: 0, bit: 0, r1: 0, notFiled: 0, unjudged: 0, retagged: 0, bad: [] as string[],
    dropped: {} as Record<string, number>, kinds: {} as Record<string, number> };
  for (let run = 0; run < runs; run++) {
    const refinery = r() < 0.3;
    const cites = (k: number) => Array.from({ length: k }, () => (refinery && r() < 0.25 ? pick([HELD_OK, HELD_LOW]) : poolPick()));
    const specs: LineSpec[] = [];
    const texts: string[] = [];
    const n = 8 + Math.floor(r() * 7);
    for (let li = 0; li < n; li++) {
      const tk = tok();
      const tag = pick(["SOURCED", "SOURCED", "INFERRED", "UNCERTAIN", "Sourced", "inferred"]);
      const verdict = pick(["supports", "supports", "supports", "partial", "unsupported"]);
      const k = pick([1, 1, 1, 2, 2, 3, 4, 5, 6]);
      const shape = r();
      if (shape < 0.08 && texts.length) {
        // the same text again (identical, or a case-only variant), other citations
        const prev = pick(texts);
        specs.push({ tok: "", tag, text: "", cites: [], verdict, line: `[${tag}] ${r() < 0.5 ? prev : prev.toUpperCase()} [Source ${cites(k).map((u) => `{${u}}`).join(", ")}]` });
      } else if (shape < 0.13) {
        specs.push({ tok: "", tag, text: "", cites: [], verdict, line: pick([`[${tag}] [Source {${poolPick()}}]`, `[${tag}] -- [Source {${poolPick()}}]`, `[${tag}] *  [Sources {${poolPick()}}, {${poolPick()}}]`]) });
      } else if (shape < 0.19) {
        specs.push({ tok: tk, tag, text: pick([`The provided sources contain no information about ${ENTITY} in group`, `No study has tested ${ENTITY} in cohort`,
          `These findings pertain to the DGX Spark, not the subject of`, `The retrieved pages do not describe ${ENTITY} for`]), cites: cites(k), verdict });
      } else if (shape < 0.25) {
        specs.push({ tok: tk, tag: "GAP", text: `Nothing on ${ENTITY} in`, cites: [], verdict });
      } else if (shape < 0.30) {
        const t2 = tok();
        specs.push({ tok: tk, tag, text: "", cites: [], verdict,
          line: `[${tag}] Doctors say ${ENTITY} varies ${tk}. [Source {${poolPick()}}] [${pick(["INFERRED", "UNCERTAIN"])}] Clinicians say ${ENTITY} differs ${t2}. [Source {${poolPick()}}]` });
      } else if (shape < 0.34) {
        specs.push({ tok: tk, tag, text: "", cites: [], verdict, line: `[${tag}] Visually induced ${ENTITY} follows a cue ${tk}.\nas reported [Source {${poolPick()}}]` });
      } else if (shape < 0.37) {
        specs.push({ tok: tk, tag, text: `Doctors say ${ENTITY} is uncited`, cites: [], verdict, raw: pick(["", "[Source 99]", "[Source 0]"]) });
      } else {
        // an ordinary claim: a figure the cited text may not hold (numeric re-tag), split / duplicate citations
        const fig = pick(["", "", ` in ${10 + Math.floor(r() * 80)} of 100 subjects`, " by 26% in 10 participants", ` in ${Math.floor(r() * 9)} trials`]);
        const text = `${pick(["Visually induced", "Galvanic", "Doctors say", "Reporters say"])} ${ENTITY} ${pick(["follows a mismatch", "is common", "is in the news", "changed"])}${fig} ${tk}.`;
        texts.push(text);
        specs.push({ tok: tk, tag, text: text.slice(0, -(tk.length + 2)), cites: cites(k), verdict, split: r() < 0.2, dup: r() < 0.1 });
      }
    }
    s.lines += specs.reduce((a, x) => a + (x.line ?? "x").split("\n").length, 0);
    const query = pick(QUERIES);
    await inTx(async (c) => {
      let x: RunOut;
      try {
        x = await runOnce(c, specs, [...POOL, DUPB], { query, refinery });
      } catch (e) {
        s.bad.push(`run ${run}: ERROR ${String((e as Error).message ?? e).slice(0, 200)}`);
        return;
      }
      s.runs++;
      const kind = x.r.metrics.credibility!.kind;
      s.kinds[kind] = (s.kinds[kind] ?? 0) + 1;
      s.judged += x.inv.judged; s.scored += x.inv.scored; s.filed += x.inv.filed; s.bit += x.inv.bit; s.r1 += x.inv.r1;
      s.notFiled += x.inv.notFiled; s.unjudged += x.inv.unjudgedFiled; s.retagged += x.inv.retagged;
      for (const [k, v] of Object.entries(x.dropped)) s.dropped[k] = (s.dropped[k] ?? 0) + v;
      s.bad.push(...x.inv.bad.map((b) => `run ${run} (${kind}${refinery ? ", refinery" : ""}): ${b}`));
    });
  }
  console.log(`CASE 48 (property, seed ${seed}): runs ${s.runs}, synthesis lines ${s.lines}, judged ${s.judged}, scored ${s.scored}, filed ${s.filed}, ` +
    `bit-identical ${s.bit}, R1 ${s.r1}, judged-not-filed ${s.notFiled}, filed-off-a-judged-line ${s.unjudged}, re-tagged ${s.retagged}, ` +
    `dropped ${JSON.stringify(s.dropped)}, kinds ${JSON.stringify(s.kinds)}, disagreements ${s.bad.length}`);
  for (const b of s.bad.slice(0, 12)) console.log(`  ${b}`);
  assertEquals(s.bad.slice(0, 12), [], `${s.bad.length} disagreements`);
  assertEquals(s.scored, s.filed);
  assertEquals(s.bit + s.r1, s.filed);
  assert(s.lines >= 2000, `synthesis lines ${s.lines}`);
  for (const k of ["duplicate_text", "empty_text", "meta_pattern"]) assert((s.dropped[k] ?? 0) >= 20, `${k}: ${s.dropped[k] ?? 0}`);
  assert(Object.keys(s.kinds).length === 6 && s.unjudged >= 20 && s.retagged >= 20 && s.notFiled >= 200, JSON.stringify(s.kinds));
});

Deno.test({ name: "attempt 6: close the pool", ignore: !HOST, fn: async () => { await pool!.end(); }, sanitizeOps: false, sanitizeResources: false });
