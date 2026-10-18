/**
 * The pre-ingestion credibility stage, leads and found_via, the fold and the scoped pass, driven
 * through the REAL runResearch with every seam stubbed (research-workbench P3a, rw-p3a-entail).
 * The DB is a recording stub: every statement and its arguments are logged, so "never a sources
 * row" is checked against what the run actually asked the database to write.
 * Run: deno test --allow-read admission.test.ts
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type Deps, type FetchResult, type QueryClient, runResearch, type SearchHit } from "./harness.ts";
import { credibilityRows, seedSet } from "./fixtures/credibility-seeds.ts";
import { fixtureResolver } from "./fixtures/scholarly-network.ts";
import { CredibilityGateError } from "./credibility.ts";

const ENTITY = "vestibular motion sickness";
const QUERY = "Research on the mechanism of vestibular motion sickness: what do studies show?";
const PAPER = "https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2021.757735/full";
const NEWS = "https://www.reuters.com/health/vestibular-motion-sickness-2026";
const LEAD = "https://blog.example.com/vestibular-motion-sickness-explained";
const VIA = "https://www.nature.com/articles/s44172-025-00417-2";      // a paper the lead links
const JUNK = "https://shop.example.com/vestibular-motion-sickness-band"; // also linked; never credible

interface Logged { sql: string; args: unknown[] }

function recordingDb(o: {
  held?: Array<{ id: string; url: string | null; title: string; content: string; content_type?: string }>;
  context?: Array<{ id: string; url: string | null; title: string }>;
  tombstoned?: Set<string>;
  registry?: unknown[];
} = {}) {
  const log: Logged[] = [];
  const client: QueryClient = {
    queryObject<T>(sql: string, args: unknown[] = []): Promise<{ rows: T[] }> {
      log.push({ sql: sql.replace(/\s+/g, " ").trim(), args });
      const rows = (r: unknown[]) => Promise.resolve({ rows: r as T[] });
      if (o.registry && /FROM public\.contract_registry_entries/i.test(sql)) return rows(o.registry);
      const cred = credibilityRows(sql);
      if (cred) return rows(cred);
      if (/INSERT INTO public\.sessions/i.test(sql)) return rows([{ id: "00000000-0000-4000-8000-0000000000a1" }]);
      if (/find_or_create_source/i.test(sql)) return rows([{ id: `src:${args[0]}`, was_duplicate: false }]);
      if (/FROM public\.held_sources h/i.test(sql)) return rows((o.held ?? []).map((h) => ({ content_type: "manual", metadata: {}, ...h })));
      if (/FROM public\.refinery_user_sources u/i.test(sql)) return rows(o.context ?? []);
      if (/fold_held_source/i.test(sql)) {
        const id = String(args[0]);
        const h = (o.held ?? []).find((x) => x.id === id);
        if (h?.url && o.tombstoned?.has(h.url)) return Promise.reject(new Error(`tombstoned url refused: tombstone=t1 reason=debunked url=${h.url}`));
        return rows([{ id }]);
      }
      return rows([]);
    },
  };
  return { client, log };
}

const page = (url: string, content: string, links: string[] = []): FetchResult => ({
  page: { url, title: `${ENTITY} - ${new URL(url).hostname}`, content, domain: new URL(url).hostname, links }, outcome: "ok",
});

function deps(o: {
  hits?: SearchHit[];
  verdictFor?: (line: string) => string;
  synthesis?: (sourcesBlock: string) => string;
  admission?: Deps["admission"];
} = {}) {
  const seen = { fetched: [] as string[], curatorPkgs: [] as Record<string, unknown>[], admissionCalls: 0 };
  const d: Deps = {
    embed: () => Promise.resolve(new Array(1024).fill(0)),
    chat: (sys, user) => {
      if (sys.includes("ENTAILMENT JUDGE")) {
        const claim = (user.match(/^CLAIM \(tagged \[[A-Z]+\]\): (.*)$/m) ?? [])[1] ?? "";
        return Promise.resolve(JSON.stringify({ verdict: o.verdictFor ? o.verdictFor(claim) : "supports", rationale: "stub" }));
      }
      if (sys.includes("research planner")) return Promise.resolve(JSON.stringify({ needs: ["What mechanism causes vestibular motion sickness?"] }));
      if (sys.includes("web-search queries")) return Promise.resolve(JSON.stringify({ entity: ENTITY, queries: ["mechanism studies"] }));
      if (sys.includes("already covered by KNOWN CLAIMS")) return Promise.resolve(JSON.stringify({ gaps: [0] }));
      if (sys.includes("GATHERED SOURCES")) return Promise.resolve(JSON.stringify({ open: [] }));
      if (sys.includes("research strategist")) return Promise.resolve(JSON.stringify({ queries: [] }));
      if (sys.includes("You screen a fetched web page")) return Promise.resolve("RELEVANT");
      if (sys.includes("You screen fetched web content")) return Promise.resolve("CLEAN");
      if (sys.includes("grounded synthesizer")) {
        const block = user.slice(user.indexOf("SOURCES:"));
        return Promise.resolve(o.synthesis ? o.synthesis(block) : defaultSynthesis(block));
      }
      return Promise.resolve("{}");
    },
    searchWeb: () => Promise.resolve(o.hits ?? [
      { url: LEAD, title: `${ENTITY} explained simply`, snippet: `${ENTITY} blog` },
      { url: PAPER, title: `${ENTITY}: an EEG study`, snippet: `${ENTITY} EEG` },
      { url: NEWS, title: `${ENTITY} is common, say doctors`, snippet: `${ENTITY} news` },
    ]),
    fetchPage: (url) => {
      seen.fetched.push(url);
      if (url === LEAD) return Promise.resolve(page(LEAD, `By Some Blogger. ${ENTITY} is about the inner ear. `.repeat(20), [VIA, JUNK]));
      if (url === VIA) return Promise.resolve(page(VIA, `Galvanic vestibular stimulation changed ${ENTITY} by 26% in 10 participants. `.repeat(20)));
      if (url === PAPER) return Promise.resolve(page(PAPER, `Visually induced ${ENTITY} follows a visual-vestibular mismatch. `.repeat(20)));
      if (url === NEWS) return Promise.resolve(page(NEWS, `Doctors say ${ENTITY} is common among travellers. `.repeat(20)));
      return Promise.resolve(page(url, `${ENTITY} misc `.repeat(40)));
    },
    delegateToCurator: (pkg) => {
      seen.curatorPkgs.push(pkg);
      const sources = pkg.sources as Array<{ url: string }>;
      return Promise.resolve({ thread_id: null, persist: { source_ids: sources.map((s) => `src:${s.url}`) }, claims: {} });
    },
    scholarly: fixtureResolver(),
    admission: o.admission ?? null,
  };
  return { d, seen };
}

/** The synthesizer cites each pool page by the [Source N] the prompt gave it. */
function defaultSynthesis(block: string): string {
  const n = (host: string) => {
    const m = block.match(new RegExp(`\\[Source (\\d+)\\][^\\n]*\\(${host.replace(/\./g, "\\.")}\\)`));
    return m ? Number(m[1]) : 0;
  };
  const lines: string[] = [];
  if (n("www.frontiersin.org")) lines.push(`[SOURCED] Visually induced ${ENTITY} follows a visual-vestibular mismatch. [Source ${n("www.frontiersin.org")}]`);
  if (n("www.nature.com")) lines.push(`[SOURCED] Galvanic vestibular stimulation changed ${ENTITY} by 26% in 10 participants. [Source ${n("www.nature.com")}]`);
  if (n("www.reuters.com")) lines.push(`[SOURCED] Doctors say ${ENTITY} is common among travellers. [Source ${n("www.reuters.com")}]`);
  if (n("held.example.gov")) lines.push(`[SOURCED] The held report says ${ENTITY} is vestibular. [Source ${n("held.example.gov")}${n("www.frontiersin.org") ? `, ${n("www.frontiersin.org")}` : ""}]`);
  if (n("held-blog.example.com")) lines.push(`[SOURCED] A held blog says ${ENTITY} is vestibular. [Source ${n("held-blog.example.com")}]`);
  if (n("held-erased.example.edu")) lines.push(`[SOURCED] An erased page says ${ENTITY} is vestibular. [Source ${n("held-erased.example.edu")}]`);
  return lines.join("\n");
}

const sourceRowsFor = (log: Logged[]) => log.filter((l) => /find_or_create_source/i.test(l.sql)).map((l) => String(l.args[0]));
const stamps = (log: Logged[]) => log.filter((l) => /^UPDATE public\.sources SET metadata/i.test(l.sql))
  .map((l) => ({ id: String(l.args[0]), meta: JSON.parse(String(l.args[1])) }));
const trailRows = (log: Logged[]) => log.filter((l) => /INSERT INTO public\.research_admission_trail/i.test(l.sql))
  .map((l) => ({ id: String(l.args[0]), url: String(l.args[3]), kind: String(l.args[4]), found_via: l.args[13], path: JSON.parse(String(l.args[14])), source_id: l.args[15] }));

Deno.test("a below-floor hit is never written to sources; the credible source it links carries found_via; the trail shows the path", async () => {
  const db = recordingDb();
  const { d, seen } = deps();
  const r = await runResearch(d, db.client, QUERY, { origin: "owui", jobId: "00000000-0000-4000-8000-00000000j001" });
  assertEquals(r.metrics.admission?.claim_kind, "general_theory");
  // the lead was fetched only to read its links ...
  assert(seen.fetched.includes(LEAD), "the lead's links were never read");
  // ... and never became a sources row, a curator source, or a stamped source
  assert(!sourceRowsFor(db.log).includes(LEAD), "a below-floor page was staged into sources");
  for (const p of seen.curatorPkgs) assert(!(p.sources as Array<{ url: string }>).some((s) => s.url === LEAD), "a lead reached the curator");
  assert(!stamps(db.log).some((s) => s.id === `src:${LEAD}`), "a lead got a credibility stamp");
  assert(!sourceRowsFor(db.log).includes(JUNK), "a below-floor link was staged");
  // the credible paper it links was admitted on its own score, and carries found_via
  assert(sourceRowsFor(db.log).includes(VIA), "the credible linked source was not admitted");
  const leadTrail = r.admissionTrail.find((t) => t.url === LEAD)!;
  assertEquals(leadTrail.kind, "lead_path");
  assert(leadTrail.total! < leadTrail.floor!, "the lead was below its floor");
  const via = stamps(db.log).find((s) => s.id === `src:${VIA}`)!;
  assertEquals(via.meta.found_via, leadTrail.id);
  assertEquals(via.meta.credibility.admission.path, "found_via");
  // the trail persisted the path lead -> target -> credible source, and the lead has no source id
  const persisted = trailRows(db.log).find((t) => t.url === LEAD)!;
  assertEquals(persisted.kind, "lead_path");
  assertEquals(persisted.source_id, null);
  assert(persisted.path.some((p: { url: string; role: string }) => p.url === VIA && p.role === "credible source"), JSON.stringify(persisted.path));
  const viaTrail = trailRows(db.log).find((t) => t.url === VIA)!;
  assertEquals(viaTrail.found_via, leadTrail.id);
  assertEquals(viaTrail.source_id, `src:${VIA}`);
});

Deno.test("a lead whose links reach nothing credible leaves only a trail entry", async () => {
  const db = recordingDb();
  const { d } = deps({
    hits: [{ url: LEAD, title: `${ENTITY} explained simply`, snippet: ENTITY },
      { url: NEWS, title: `${ENTITY} is common, say doctors`, snippet: ENTITY }],
  });
  const fetchPage = d.fetchPage;
  d.fetchPage = (url) => url === LEAD
    ? Promise.resolve(page(LEAD, `${ENTITY} blog text `.repeat(40), [JUNK]))
    : fetchPage(url);
  const r = await runResearch(d, db.client, QUERY, { origin: "owui" });
  const lead = r.admissionTrail.find((t) => t.url === LEAD)!;
  assertEquals(lead.kind, "lead_dropped");
  assert(!sourceRowsFor(db.log).includes(LEAD) && !sourceRowsFor(db.log).includes(JUNK));
  assert(stamps(db.log).every((s) => !s.meta.found_via), "found_via set with no credible path");
  assertEquals(trailRows(db.log).find((t) => t.url === LEAD)?.kind, "lead_dropped");
});

Deno.test("a credible source reached through a lead gets NO found_via when its line is only partial", async () => {
  const db = recordingDb();
  const { d } = deps({ verdictFor: (l) => (l.includes("26%") ? "partial" : "supports") });
  const r = await runResearch(d, db.client, QUERY, { origin: "owui" });
  const via = stamps(db.log).find((s) => s.id === `src:${VIA}`);
  assert(via, "the credible source is still a source (it cleared its own floor)");
  assertEquals(via.meta.found_via, undefined);
  assertEquals(r.admissionTrail.find((t) => t.url === LEAD)!.kind, "lead_dropped");
});

Deno.test("every admitted source records its family and the signals of THAT family", async () => {
  const db = recordingDb();
  const { d } = deps();
  await runResearch(d, db.client, QUERY, { origin: "owui" });
  const byId = new Map(stamps(db.log).map((s) => [s.id, s.meta]));
  const paper = byId.get(`src:${PAPER}`)!;
  assertEquals(paper.credibility.family, "scholarly");
  assertEquals(Object.keys(paper.credibility.signals).sort(), ["age_years", "author_works_count", "cited_by"]);
  assertEquals(paper.scholarly.state, "resolved");
  assertEquals(paper.scholarly.cited_by, 21);
  const news = byId.get(`src:${NEWS}`)!;
  assertEquals(news.credibility.family, "general");
  assertEquals(Object.keys(news.credibility.signals).sort(),
    ["author_identity", "domain_class", "entailment_agreement", "link_structure", "primary"]);
  assertEquals(news.credibility.signals.domain_class, "news");
  assertEquals(news.credibility.signals.entailment_agreement.supports, 1);
  assert(news.credibility.model_version.startsWith("d15 weights v1 paper p1"));
});

Deno.test("research_jobs.metrics carries the entailment counts and the report credibility roll-up", async () => {
  const db = recordingDb();
  const { d } = deps({ verdictFor: (l) => (l.includes("travellers") ? "unsupported" : "supports") });
  const r = await runResearch(d, db.client, QUERY, { origin: "owui" });
  assertEquals(r.metrics.entailment?.lines, 3);
  assertEquals(r.metrics.entailment?.demoted, 1);
  assertEquals(r.metrics.credibility?.model_version, "d15 weights v1 paper p1");
  assert(typeof r.metrics.credibility?.value === "number");
  assert(r.prose.includes("entailment: 1 of 3 cited line(s) demoted"), r.prose.slice(-400));
  assertEquals(r.verdicts.length, 3);
});

Deno.test("a claim kind with no weight row stops the run before anything is fetched, naming the kind", async () => {
  const rows = [...seedSet().rows,
    { registry: "claim_kinds", key: "folklore", version: 1, definition: { order: 0, cues: ["\\bmechanism\\b"] } }];
  const db = recordingDb({ registry: rows });
  const { d, seen } = deps();
  const e = await assertRejects(() => runResearch(d, db.client, QUERY, { origin: "owui" }), CredibilityGateError);
  assert(e.message.includes("'folklore'"), e.message);
  assertEquals(seen.fetched.length, 0);
});

// ── the fold (ingestion model, agreed 2026-09-25 19:59) ─────────────────────
const HELD_OK = { id: "11111111-1111-4111-8111-111111111111", url: "https://held.example.gov/report", title: "held report", content: `${ENTITY} report `.repeat(40) };
const HELD_LOW = { id: "22222222-2222-4222-8222-222222222222", url: "https://held-blog.example.com/post", title: "held blog", content: `${ENTITY} blog `.repeat(40) };
const HELD_ERASED = { id: "33333333-3333-4333-8333-333333333333", url: "https://held-erased.example.edu/page", title: "erased", content: `${ENTITY} erased `.repeat(40) };
const CONTEXT = { id: "44444444-4444-4444-8444-444444444444", url: PAPER, title: "the refinery's curated paper" };

Deno.test("the fold: active only when the floor is cleared AND entailment supports; tombstones take the D5 path; the scoped pass writes nothing", async () => {
  const db = recordingDb({ held: [HELD_OK, HELD_LOW, HELD_ERASED], context: [CONTEXT], tombstoned: new Set([HELD_ERASED.url]) });
  const reopen: unknown[] = [];
  const { d, seen } = deps({
    admission: (req) => { reopen.push(req); return Promise.resolve({ outcome: "candidate", admits: false, reason: "user-erased: awaits the operator", source_id: null }); },
  });
  const r = await runResearch(d, db.client, QUERY, { origin: "owui", refineryId: "55555555-5555-4555-8555-555555555555", jobId: "00000000-0000-4000-8000-00000000j002" });
  const row = (id: string) => r.fold!.held.find((h) => h.id === id)!;
  // cleared its floor (.gov) and a line citing it is supported -> folded, with its uuid
  assertEquals(row(HELD_OK.id).outcome, "held_folded");
  assertEquals(row(HELD_OK.id).source_id, HELD_OK.id);
  assert(db.log.some((l) => /fold_held_source/.test(l.sql) && l.args[0] === HELD_OK.id));
  // supported, but below the general-theory floor -> stays held, never folded
  assertEquals(row(HELD_LOW.id).outcome, "held_kept");
  assert(row(HELD_LOW.id).supports > 0 && row(HELD_LOW.id).total < row(HELD_LOW.id).floor);
  assert(!db.log.some((l) => /fold_held_source/.test(l.sql) && l.args[0] === HELD_LOW.id), "a below-floor held source was folded");
  // tombstoned -> the reopening path was asked, said candidate, so it stays held
  assertEquals(reopen.length, 1);
  assertEquals((reopen[0] as { path: string }).path, "intake");
  assertEquals(row(HELD_ERASED.id).outcome, "held_kept");
  assert(row(HELD_ERASED.id).reason.includes("reopening path"), row(HELD_ERASED.id).reason);
  // held sources are never staged; the unfolded ones never reach the curator
  for (const h of [HELD_OK, HELD_LOW, HELD_ERASED]) assert(!sourceRowsFor(db.log).includes(h.url!), `held ${h.url} staged`);
  const pkgUrls = (seen.curatorPkgs[0].sources as Array<{ url: string }>).map((s) => s.url);
  assert(pkgUrls.includes(HELD_OK.url!), "the folded source is filed like any source");
  assert(!pkgUrls.includes(HELD_LOW.url!) && !pkgUrls.includes(HELD_ERASED.url!), "an unfolded held source reached the curator");
  // corroboration at fold time, both directions, between the folded source and its co-cited paper
  const corr = db.log.filter((l) => /INSERT INTO public\.source_corroborations/.test(l.sql)).map((l) => [l.args[0], l.args[1], l.args[2]]);
  assert(corr.some(([f, t]) => f === `src:${PAPER}` && t === HELD_OK.id), JSON.stringify(corr));
  assert(corr.some(([f, t]) => f === HELD_OK.id && t === `src:${PAPER}`), JSON.stringify(corr));
  // the scoped pass reports refinery-only relations and moves no score
  const scoped = r.fold!.scoped.find((s) => s.held_id === HELD_OK.id && s.context_id === CONTEXT.id)!;
  assertEquals(scoped.relation, "support each other");
  assert(r.fold!.scoped.some((s) => s.held_id === HELD_LOW.id), "the scoped pass covers held sources that did not fold");
  assert(!corr.some(([f, t]) => [f, t].includes(HELD_LOW.id) || [f, t].includes(HELD_ERASED.id)), "the scoped pass wrote a corroboration");
  assert(!db.log.some((l) => /UPDATE public\.claims|recompute_claim_confidence|claim_confidence/i.test(l.sql)), "a claim score was written");
  assert(!stamps(db.log).some((s) => s.id === HELD_LOW.id || s.id === HELD_ERASED.id), "an unfolded held source got a database score");
  assertEquals(r.metrics.admission?.held_folded, 1);
  assertEquals(r.metrics.admission?.held_kept, 2);
});

Deno.test("the fold refuses a tombstoned held source when the reopening path is unreachable - it never bypasses it", async () => {
  const db = recordingDb({ held: [HELD_ERASED], tombstoned: new Set([HELD_ERASED.url]) });
  const { d } = deps({ hits: [] });
  d.searchWeb = () => Promise.resolve([{ url: NEWS, title: `${ENTITY} is common`, snippet: ENTITY }]);
  // the erased page (.edu, academic) clears the general-theory floor on its own and is supported
  const r = await runResearch(d, db.client, QUERY, {
    origin: "owui", refineryId: "55555555-5555-4555-8555-555555555555",
  });
  const row = r.fold!.held[0];
  assertEquals(row.outcome, "held_kept");
  assert(row.supports > 0 && row.total >= row.floor, "precondition: it would fold but for the tombstone");
  assert(/reopening path is not reachable/.test(row.reason), row.reason);
});
