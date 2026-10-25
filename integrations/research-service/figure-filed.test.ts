/**
 * rw-p3a-figure-filed - THE REPORT FIGURE STATES WHAT THE CURATOR FILED (offline; every seam stubbed).
 *
 * research_jobs.metrics.credibility and the stored footer were computed before the hand-off to the
 * curator, over the claim list of the package (rw-p3a-entail attempt 6). This suite plants each way the
 * filing can differ from that list and requires the published figure to follow the FILING RESULT:
 *   F2  the curator failed (error) or its claim write rolled back (claims_error): filed:false, value
 *       null, no claim counted, and the footer - in the job's prose AND the curator's stored prose -
 *       says "(not filed)"; a dry run says so too.
 *   R3  the curator's LLM meta judge dropped a claim after the shared list (claims.filed[k] null).
 *   R5  a cited source did not persist (persist.source_ids[k] null).
 *   F1  the database merged two claims of the run (claims.filed repeats one id): counted once.
 *   and a run whose filing succeeded keeps the pre-filing figure, filed:true, no "(not filed)".
 * Run: deno test --allow-env --allow-read --allow-net figure-filed.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type Deps, type FetchResult, type QueryClient, runResearch, type RunResult } from "./harness.ts";
import { claimList } from "./claim-list.ts";
import { credibilityRows } from "./fixtures/credibility-seeds.ts";
import { fixtureResolver } from "./fixtures/scholarly-network.ts";

const ENTITY = "vestibular motion sickness";
const QUERY = "Research on the mechanism of vestibular motion sickness: what do studies show?";
const PAPER = "https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2021.757735/full";
const NEWS = "https://www.reuters.com/health/vestibular-motion-sickness-2026";
const VIA = "https://www.nature.com/articles/s44172-025-00417-2";
const SYN_ID = "00000000-0000-4000-8000-00000000c0de";

interface Logged { sql: string; args: unknown[] }
function recordingDb() {
  const log: Logged[] = [];
  const client: QueryClient = {
    queryObject<T>(sql: string, args: unknown[] = []): Promise<{ rows: T[] }> {
      log.push({ sql: sql.replace(/\s+/g, " ").trim(), args });
      const rows = (r: unknown[]) => Promise.resolve({ rows: r as T[] });
      const cred = credibilityRows(sql);
      if (cred) return rows(cred);
      if (/INSERT INTO public\.sessions/i.test(sql)) return rows([{ id: "00000000-0000-4000-8000-0000000000a1" }]);
      if (/find_or_create_source/i.test(sql)) return rows([{ id: `src:${args[0]}`, was_duplicate: false }]);
      return rows([]);
    },
  };
  return { client, log };
}
const page = (url: string, content: string): FetchResult => ({
  page: { url, title: `${ENTITY} - ${new URL(url).hostname}`, content, domain: new URL(url).hostname, links: [] }, outcome: "ok",
});

type Curate = (pkg: Record<string, unknown>) => Record<string, unknown>;
type Lines = (n: (host: string) => number) => string[];
function deps(curate: Curate, lines?: Lines) {
  const seen = { pkgs: [] as Record<string, unknown>[] };
  const d: Deps = {
    embed: () => Promise.resolve(new Array(1024).fill(0)),
    chat: (sys, user) => {
      if (sys.includes("ENTAILMENT JUDGE")) return Promise.resolve(JSON.stringify({ verdict: "supports", rationale: "stub" }));
      if (sys.includes("research planner")) return Promise.resolve(JSON.stringify({ needs: ["What mechanism causes vestibular motion sickness?"] }));
      if (sys.includes("web-search queries")) return Promise.resolve(JSON.stringify({ entity: ENTITY, queries: ["mechanism studies"] }));
      if (sys.includes("already covered by KNOWN CLAIMS")) return Promise.resolve(JSON.stringify({ gaps: [0] }));
      if (sys.includes("GATHERED SOURCES")) return Promise.resolve(JSON.stringify({ open: [] }));
      if (sys.includes("research strategist")) return Promise.resolve(JSON.stringify({ queries: [] }));
      if (sys.includes("You screen a fetched web page")) return Promise.resolve("RELEVANT");
      if (sys.includes("You screen fetched web content")) return Promise.resolve("CLEAN");
      if (sys.includes("grounded synthesizer")) {
        const block = user.slice(user.indexOf("SOURCES:"));
        const n = (host: string) => {
          const m = block.match(new RegExp(`\\[Source (\\d+)\\][^\\n]*\\(${host.replace(/\./g, "\\.")}\\)`));
          return m ? Number(m[1]) : 0;
        };
        return Promise.resolve((lines ?? defaultLines)(n).join("\n"));
      }
      return Promise.resolve("{}");
    },
    searchWeb: () => Promise.resolve([
      { url: PAPER, title: `${ENTITY}: an EEG study`, snippet: `${ENTITY} EEG` },
      { url: NEWS, title: `${ENTITY} is common, say doctors`, snippet: `${ENTITY} news` },
      { url: VIA, title: `${ENTITY} stimulation`, snippet: `${ENTITY} galvanic` },
    ]),
    fetchPage: (url) => {
      if (url === VIA) return Promise.resolve(page(VIA, `Galvanic vestibular stimulation changed ${ENTITY} by 26% in 10 participants. `.repeat(20)));
      if (url === PAPER) return Promise.resolve(page(PAPER, `Visually induced ${ENTITY} follows a visual-vestibular mismatch. `.repeat(20)));
      if (url === NEWS) return Promise.resolve(page(NEWS, `Doctors say ${ENTITY} is common among travellers. `.repeat(20)));
      return Promise.resolve(page(url, `${ENTITY} misc `.repeat(40)));
    },
    delegateToCurator: (pkg) => { seen.pkgs.push(pkg); return Promise.resolve(curate(pkg)); },
    scholarly: fixtureResolver(),
    admission: null,
  };
  return { d, seen };
}
const defaultLines: Lines = (n) => [
  `[SOURCED] Visually induced ${ENTITY} follows a visual-vestibular mismatch. [Source ${n("www.frontiersin.org")}]`,
  `[SOURCED] Galvanic vestibular stimulation changed ${ENTITY} by 26% in 10 participants. [Source ${n("www.nature.com")}, ${n("www.frontiersin.org")}]`,
  `[SOURCED] Doctors say ${ENTITY} is common among travellers. [Source ${n("www.reuters.com")}]`,
];

/** What the REAL curator returns for a package it filed in full (claims.filed = one id per listed claim). */
const filedAll: Curate = (pkg) => {
  const sources = pkg.sources as Array<{ url: string }>;
  const list = claimList(String(pkg.synthesis ?? "").trim()).claims;
  return {
    thread_id: null, persist: { synthesis_id: SYN_ID, source_ids: sources.map((s) => `src:${s.url}`) },
    claims: { claimsWritten: list.length, claimsDeduped: 0, claimIds: list.map((_, k) => `claim-${k}`), filed: list.map((_, k) => `claim-${k}`) },
    claims_error: null,
  };
};
const footerOf = (r: RunResult) => (r.prose.match(/report credibility[^\n_]*/) ?? [""])[0];
// deno-lint-ignore no-explicit-any
const mc = (r: RunResult) => r.metrics.credibility as any;
const proseStamps = (log: Logged[]) =>
  log.filter((l) => /^UPDATE public\.sources SET metadata/i.test(l.sql) && String(l.args[1] ?? "").includes("prose_synthesis"));
const storedProse = (l: Logged) => String(JSON.parse(String(l.args[1])).prose_synthesis);
const mean = (xs: number[]) => Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 1000) / 1000;

Deno.test("F2: a curator outcome of error publishes filed:false, a null value, no claim counted, and '(not filed)' in the footer", async () => {
  const db = recordingDb();
  const { d } = deps(() => ({ error: "ingest_failed: planted (resolve stage)" }));
  const r = await runResearch(d, db.client, QUERY, { origin: "owui" });
  assert(r.lineCredibility.length >= 2, "the package held scored claims (else the case is vacuous)");
  assertEquals(mc(r).filed, false, JSON.stringify(mc(r)));
  assertEquals(mc(r).value, null);
  assertEquals(mc(r).claims, 0);
  assertEquals(mc(r).below_floor, 0);
  assertEquals(mc(r).not_filed, "curator_error");
  assert(footerOf(r).includes("(not filed)"), footerOf(r));
  assert(!/report credibility \d/.test(r.prose), "no numeric figure is left in the prose");
});

Deno.test("F2: a claims_error (the claim write rolled back) publishes filed:false and re-stamps the curator's stored prose with '(not filed)'", async () => {
  const db = recordingDb();
  const { d } = deps((pkg) => ({ ...filedAll(pkg), claims: null, claims_error: "Error: planted rollback after the edges" }));
  const r = await runResearch(d, db.client, QUERY, { origin: "owui" });
  assertEquals(mc(r).filed, false, JSON.stringify(mc(r)));
  assertEquals(mc(r).value, null);
  assertEquals(mc(r).claims, 0);
  assertEquals(mc(r).not_filed, "claims_error");
  assert(footerOf(r).includes("(not filed)"), footerOf(r));
  const st = proseStamps(db.log);
  assertEquals(st.length, 1, "the stored report prose (sources.metadata.prose_synthesis) is re-stamped once");
  assertEquals(st[0].args[0], SYN_ID);
  assert(storedProse(st[0]).includes("(not filed)"), storedProse(st[0]).slice(-300));
  assertEquals(storedProse(st[0]), r.prose, "the stored footer is the job's footer");
});

Deno.test("F2: a successful filing keeps the pre-filing figure, filed:true, and no '(not filed)'; no re-stamp", async () => {
  const before = await runResearch(deps(() => ({ thread_id: null, persist: {}, claims: {} })).d, recordingDb().client, QUERY, { origin: "owui" });
  const db = recordingDb();
  const r = await runResearch(deps(filedAll).d, db.client, QUERY, { origin: "owui" });
  assertEquals(mc(r).filed, true, JSON.stringify(mc(r)));
  assertEquals(mc(r).value, mc(before).value, "the figure of a run that behaved as before is unchanged");
  assertEquals(mc(r).value, mean(r.lineCredibility.map((c) => c.total)));
  assertEquals(mc(r).claims, r.lineCredibility.length);
  assert(!footerOf(r).includes("not filed"), footerOf(r));
  assertEquals(footerOf(r), footerOf(before));
  assertEquals(proseStamps(db.log).length, 0, "nothing to re-stamp");
});

Deno.test("F2: a dry run states in the footer and the metrics that nothing was filed", async () => {
  const { d, seen } = deps(filedAll);
  const r = await runResearch(d, recordingDb().client, QUERY, { origin: "owui", dryRun: true });
  assertEquals(seen.pkgs.length, 0, "a dry run hands nothing to the curator");
  assertEquals(mc(r).filed, false, JSON.stringify(mc(r)));
  assertEquals(mc(r).value, null);
  assertEquals(mc(r).not_filed, "dry_run");
  assert(footerOf(r).includes("(not filed)") && footerOf(r).includes("dry run"), footerOf(r));
});

Deno.test("R3: a claim the curator's meta judge dropped after the shared list is not in the figure", async () => {
  const db = recordingDb();
  const r = await runResearch(deps((pkg) => {
    const x = filedAll(pkg) as { claims: { filed: Array<string | null> } };
    x.claims.filed[0] = null; // planted: the LLM meta judge refused claim 0 (it fails open otherwise)
    return x as unknown as Record<string, unknown>;
  }).d, db.client, QUERY, { origin: "owui" });
  assertEquals(r.lineCredibility.length, 3, "the scored list stays the list the curator files FROM (the invariant)");
  const kept = r.lineCredibility.slice(1);
  assertEquals(mc(r).filed, true);
  assertEquals(mc(r).claims, kept.length, JSON.stringify(mc(r)));
  assertEquals(mc(r).value, mean(kept.map((c) => c.total)));
  assertEquals(mc(r).below_floor, kept.filter((c) => c.below_floor).length);
  assert(footerOf(r).includes(`report credibility ${mean(kept.map((c) => c.total)).toFixed(2)}`), footerOf(r));
  const st = proseStamps(db.log);
  if (mean(kept.map((c) => c.total)).toFixed(2) !== mean(r.lineCredibility.map((c) => c.total)).toFixed(2)) {
    assertEquals(st.length, 1, "a changed footer is re-stamped onto the stored prose");
    assertEquals(storedProse(st[0]), r.prose);
  }
});

Deno.test("R5: a cited source that did not persist counts out the claim it alone grounds, and its edge off a co-cited claim", async () => {
  let pkgSeen: Record<string, unknown> = {};
  const r = await runResearch(deps((pkg) => {
    pkgSeen = pkg;
    const x = filedAll(pkg) as { persist: { source_ids: Array<string | null> }; claims: { filed: Array<string | null> } };
    const sources = pkg.sources as Array<{ url: string }>;
    x.persist.source_ids[sources.findIndex((s) => s.url === PAPER)] = null; // planted: the paper did not persist
    x.claims.filed[0] = null; // so the curator files no claim grounded only in it (ungroundedSkipped)
    return x as unknown as Record<string, unknown>;
  }).d, recordingDb().client, QUERY, { origin: "owui" });
  const list = claimList(String(pkgSeen.synthesis ?? "").trim()).claims;
  assert(list.length === 3 && list[1].edges.length === 2, "claim 1 cites the paper and one more source");
  assertEquals(mc(r).claims, 2, JSON.stringify(mc(r)));
  // claim 1 is re-scored over its persisted edge only: it loses the paper's corroboration
  assert(mc(r).value < mean(r.lineCredibility.slice(1).map((c) => c.total)), `${mc(r).value} vs the pre-filing claims 1-2`);
});

Deno.test("F1/R4: two claims the database merged (one id twice in claims.filed) are counted once", async () => {
  // The Unicode case: JS toLowerCase('İ') is 'i̇' (two code points), Postgres lower() gives 'i'
  // in en_US.utf8 - claimList keeps both, find_or_create_claim's md5(lower(btrim())) merges them.
  const lines: Lines = (n) => [
    `[SOURCED] İstanbul clinics report ${ENTITY} in ferry passengers. [Source ${n("www.reuters.com")}]`,
    `[SOURCED] istanbul clinics report ${ENTITY} in ferry passengers. [Source ${n("www.frontiersin.org")}]`,
    `[SOURCED] Galvanic vestibular stimulation changed ${ENTITY} by 26% in 10 participants. [Source ${n("www.nature.com")}]`,
  ];
  const r = await runResearch(deps((pkg) => {
    const x = filedAll(pkg) as { claims: { filed: Array<string | null>; claimIds: string[]; claimsDeduped: number } };
    x.claims.filed[1] = x.claims.filed[0]; // the database's dedup returned claim 0's row for claim 1
    x.claims.claimIds[1] = x.claims.claimIds[0];
    x.claims.claimsDeduped = 1;
    return x as unknown as Record<string, unknown>;
  }, lines).d, recordingDb().client, QUERY, { origin: "owui" });
  assertEquals(r.lineCredibility.length, 3, "claimList keeps both case forms (the seam is not moved)");
  assertEquals(mc(r).claims, 2, JSON.stringify(mc(r)));
  assertEquals(mc(r).filed, true);
});
