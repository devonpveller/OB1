/**
 * tree.test.ts - research-workbench P4a (rw-p4a-trees), offline: the pure half of the job tree,
 * the harness's event hooks (per-source trail, D15 gap events) on mocked seams, the dispatcher's
 * derived cap and the lane read-back. The SQL half runs in trees.e2e.test.ts against a lab DB.
 */
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { credibilityRows } from "./fixtures/credibility-seeds.ts";
import { runResearch, type Deps, type QueryClient } from "./harness.ts";
import { loadCredibilityModel, claimFloor, classifyClaimKind } from "./credibility.ts";
import { ContractError, resolveContract } from "./contract.ts";
import { Dispatcher, CLAIM_SQL } from "./jobs.ts";
import { ModelHealth } from "./llm.ts";
import {
  branchRank, buildTreeReport, entryWithin, interHubGaps, learningRecords, narrowContract, readLaneConcurrency,
  splitAtThreshold, STAGE_KINDS, stageEvent, type Tree, type TreeEvent, type TreeNode,
} from "./tree.ts";

const here = (p: string) => new URL(p, import.meta.url);
const readOr = (p: URL) => { try { return Deno.readTextFileSync(p); } catch { return null; } };

// ── Case 5: every stage carries the marker ──────────────────────────────────────────────────
Deno.test("P4a events: every phase the harness and the service report is named steering|due_process", () => {
  const src = Deno.readTextFileSync(here("./harness.ts")) + Deno.readTextFileSync(here("./index.ts"));
  const phases = new Set([...src.matchAll(/progress\("([a-z_]+)"/g)].map((m) => m[1]));
  assert(phases.size >= 10, `found ${phases.size} phases`);
  for (const p of phases) assert(p in STAGE_KINDS, `phase ${p} has no steering|due_process marker`);
  for (const [p, k] of Object.entries(STAGE_KINDS)) assert(k === "steering" || k === "due_process", p);
  const ev = stageEvent("plan", "planning");
  assertEquals([ev.type, ev.kind], ["stage", "steering"]);
  assertEquals(stageEvent("gather", "x").kind, "due_process");
});

Deno.test("P4a events: the migration refuses an unmarked event and a source event without a trail", () => {
  const sql = readOr(here("../../docker/init-research-trees.sql"));
  if (sql === null) return; // image build context: the docker/ dir is not there
  assert(/kind\s+TEXT NOT NULL CHECK \(kind IN \('steering', 'due_process'\)\)/.test(sql), "kind NOT NULL + CHECK");
  assert(/type <> 'source' OR \(trail IS NOT NULL AND jsonb_typeof\(trail\) = 'object'\)/.test(sql), "source events need a trail (NULL included)");
  assert(/type <> 'human_steer'[\s\S]*payload \? 'topic_estimate' AND payload \? 'anchor'/.test(sql), "human steer carries estimate + anchor");
});

// ── Case 2: the child's contract is at or below the parent's ────────────────────────────────
Deno.test("P4a contract: a child's contract is built new, clamped against the parent's, never widened", () => {
  const parent = resolveContract({ contract: { sources: { allow: ["*.edu", "nist.gov"], deny: ["bad.example"] }, budget: { max_fetch: 20, rounds: 2 } } });
  const child = narrowContract(parent, { sources: { allow: ["mit.edu"] }, budget: { max_fetch: 50, wall_ms: 1000 } })!;
  assertEquals(child.sources?.allow, ["mit.edu"]);
  assertEquals(child.sources?.deny, ["bad.example"], "deny is inherited");
  assertEquals(child.budget, { max_fetch: 20, wall_ms: 1000, rounds: 2 }, "a request can only lower a ceiling");
  const rc = resolveContract({ contract: child })!;
  assertEquals(rc.budget.maxFetch, 20);
  // inherit as-is
  const same = narrowContract(parent, undefined)!;
  assertEquals(same.sources?.allow, ["*.edu", "nist.gov"]);
  // widening refused
  assertThrows(() => narrowContract(parent, { sources: { allow: ["example.com"] } }), ContractError, "widens");
  assertThrows(() => narrowContract(resolveContract({ contract: { sources: { allow: ["mit.edu"] } } }), { sources: { allow: ["*.edu"] } }), ContractError);
  // an unconstrained parent: the child may narrow, and stays unconstrained otherwise
  assertEquals(narrowContract(null, undefined), null);
  assertEquals(narrowContract(null, { budget: { rounds: 1 } }), { budget: { rounds: 1 } });
  // entry containment
  assert(entryWithin("a.b.edu", "*.edu") && entryWithin("nist.gov/x/y", "nist.gov") && !entryWithin("nist.gov", "nist.gov/x"));
});

// ── Case 6: gap work at the kind's threshold (D15), through the real harness ────────────────
function credClient(claims: Array<{ id: string; text: string; confidence: number }>): QueryClient {
  return {
    queryObject<T>(sql: string): Promise<{ rows: T[] }> {
      const cred = credibilityRows(sql);
      if (cred) return Promise.resolve({ rows: cred as T[] });
      if (/INSERT INTO public\.sessions/i.test(sql)) return Promise.resolve({ rows: [{ id: "00000000-0000-0000-0000-000000000001" }] as unknown as T[] });
      if (/FROM public\.claims c/i.test(sql)) {
        return Promise.resolve({ rows: claims.map((c) => ({
          id: c.id, text: c.text, confidence: c.confidence, contradicted: false, grounded: true, has_strong: true,
          researched_on: new Date().toISOString(), volatility: "slow", revalidate_days: null, distance: "0.1",
        })) as unknown as T[] });
      }
      return Promise.resolve({ rows: [] as T[] });
    },
  };
}
function mockDeps(): Deps {
  return {
    embed: () => Promise.resolve(new Array(1024).fill(0)),
    chat: (sys) => {
      if (sys.includes("ENTAILMENT JUDGE")) return Promise.resolve(JSON.stringify({ verdict: "supports" }));
      if (sys.includes("research planner")) return Promise.resolve(JSON.stringify({ needs: ["What is soil pH?"] }));
      if (sys.includes("web-search queries")) return Promise.resolve(JSON.stringify({ entity: "soil", queries: ["soil ph garden"] }));
      if (sys.includes("already covered by KNOWN CLAIMS")) return Promise.resolve(JSON.stringify({ covered: [], gaps: [0] }));
      if (sys.includes("GATHERED SOURCES")) return Promise.resolve(JSON.stringify({ covered: [0], open: [] }));
      if (sys.includes("research strategist")) return Promise.resolve(JSON.stringify({ queries: [] }));
      if (sys.includes("You screen a fetched web page")) return Promise.resolve("RELEVANT");
      if (sys.includes("grounded synthesizer")) return Promise.resolve("[SOURCED] Garden soil pH is best near 6.5. [Source 1]");
      if (sys.includes("You choose the best REPORT TEMPLATE")) return Promise.resolve(JSON.stringify({ template: "general-report" }));
      if (sys.includes("research writer")) return Promise.resolve("# Soil\nBody.");
      if (sys.includes("You screen fetched web content")) return Promise.resolve("CLEAN");
      return Promise.resolve("{}");
    },
    searchWeb: () => Promise.resolve([{ url: "https://soil.example.org/ph", title: "Soil pH for gardens", snippet: "soil pH garden" }]),
    fetchPage: (url) => Promise.resolve({ page: { url, title: "Soil pH for gardens", content: "Garden soil pH is best near 6.5 for most vegetables. ".repeat(30), domain: "soil.example.org" }, outcome: "ok" }),
    delegateToCurator: (pkg) => Promise.resolve({ thread_id: pkg.thread_id, persist: {}, claims: {} }),
  };
}

Deno.test("P4a gap work: a claim below its kind's threshold is a gap event naming it and its score; above it, none", async () => {
  const model = await loadCredibilityModel(credClient([]) as never);
  const lowText = "Garden soil pH should be measured before planting", highText = "Compost improves garden soil structure";
  const lowT = claimFloor(model, classifyClaimKind(model, lowText).kind), highT = claimFloor(model, classifyClaimKind(model, highText).kind);
  const claims = [
    { id: "11111111-1111-1111-1111-111111111111", text: lowText, confidence: Math.max(0, lowT - 0.2) },
    { id: "22222222-2222-2222-2222-222222222222", text: highText, confidence: Math.min(1, highT + 0.2) },
  ];
  const split = splitAtThreshold(model, claims);
  assertEquals(split.below.map((g) => g.claim_id), [claims[0].id]);
  assertEquals(split.above, [claims[1].id]);
  const events: TreeEvent[] = [];
  const r = await runResearch(mockDeps(), credClient(claims), "How should I prepare garden soil?",
    { origin: "owui", dryRun: true, onEvent: (e) => { events.push(e); return Promise.resolve(); } });
  const gaps = events.filter((e) => e.type === "gap");
  assertEquals(gaps.length, 1, `one gap event (got ${gaps.length})`);
  assertEquals(gaps[0].payload?.claim_id, claims[0].id);
  assertEquals(gaps[0].payload?.score, claims[0].confidence);
  assertEquals(gaps[0].payload?.threshold, lowT);
  assertEquals(gaps[0].kind, "steering");
  assertEquals(r.gapWork?.map((g) => g.claim_id), [claims[0].id], "the below-threshold claim is the run's gap work");
  assert(!r.gapWork?.some((g) => g.claim_id === claims[1].id), "an above-threshold claim is not gap work");
  assert(!r.reuseClaims.some((c) => c.id === claims[0].id), "a below-threshold claim is never reused as-is");
  assert(r.reuseClaims.some((c) => c.id === claims[1].id), "the above-threshold claim is reused, not researched again");
  // Case 5: every per-source event carries its trail
  const src = events.filter((e) => e.type === "source");
  assert(src.length >= 1, "the admitted hit produced a per-source event");
  for (const e of src) {
    assert(e.trail && typeof e.trail === "object" && typeof (e.trail as Record<string, unknown>).url === "string", "trail present");
    assertEquals(e.kind, "due_process");
  }
});

// ── Cases 9-10: inter-hub gaps from link density, no topic table ────────────────────────────
const tri = (p: string) => [`${p}1`, `${p}2`, `${p}3`];
const clique = (ids: string[]) => ids.flatMap((a, i) => ids.slice(i + 1).map((b) => ({ a, b, w: 2 })));
Deno.test("P4a inter-hub: a thin bridge between two dense neighbourhoods is an inter-hub gap; a dense join is none", () => {
  const nodes = [...tri("a"), ...tri("b")].map((id) => ({ id, text: `claim ${id}` }));
  const thin = interHubGaps(nodes, [...clique(tri("a")), ...clique(tri("b")), { a: "a3", b: "b1", w: 1 }]);
  assertEquals(thin.length, 1, JSON.stringify(thin));
  assertEquals([thin[0].a.members, thin[0].b.members], [tri("a"), tri("b")]);
  assert(thin[0].density > 0 && thin[0].density < 0.2, `density ${thin[0].density}`);
  const none = interHubGaps(nodes, [...clique([...tri("a"), ...tri("b")])]);
  assertEquals(none.length, 0, "one dense neighbourhood has no inter-hub gap");
  const apart = interHubGaps(nodes, [...clique(tri("a")), ...clique(tri("b"))]);
  assertEquals(apart.length, 1, "two neighbourhoods with no link at all: the connection is unclear");
  assertEquals(apart[0].density, 0);
});

Deno.test("P4a inter-hub: no topic or hub table is created or read", () => {
  const sql = readOr(here("../../docker/init-research-trees.sql"));
  const code = Deno.readTextFileSync(here("./tree.ts"));
  for (const t of [sql ?? "", code]) {
    assert(!/CREATE TABLE[^(]*\b\w*(topic|hub)\w*\s*\(/i.test(t), "no topic/hub table");
    assert(!/(FROM|JOIN|INTO|UPDATE)\s+public\.\w*(topics?|hubs?)\b/i.test(t), "no topic/hub table read or written");
  }
});

// ── Cases 4 and 12: the tree report and the learning records ────────────────────────────────
function fixtureTree(): Tree {
  const n = (o: Partial<TreeNode>): TreeNode => ({
    id: "", parent_job_id: null, branch_kind: "root", query: "", anchor: null, rooted_step_id: null, status: "done",
    result: null, metrics: null, created_at: "2026-10-25T10:00:00Z", finished_at: "2026-10-25T10:05:00Z", ...o,
  });
  const root = n({ id: "r", query: "How do I prepare garden soil?", result: {
    synthesis: "Loosen the soil and add compost. [Source 1]", gaps: ["what pH suits tomatoes"],
    needs_status: [{ need: "a", status: "answered" }, { need: "b", status: "open" }] },
    metrics: { credibility: { value: 0.71, claims: 3 } } });
  const steer = n({ id: "s", parent_job_id: "r", branch_kind: "steer", query: "focus on soil pH for tomatoes", anchor: root.query,
    rooted_step_id: "s2", result: { synthesis: "Tomatoes prefer pH 6.2-6.8. [Source 1]", gaps: [], needs_status: [{ need: "a", status: "answered" }] },
    metrics: { credibility: { value: 0.8, claims: 1 } } });
  const gap = n({ id: "g", parent_job_id: "r", branch_kind: "gap", query: "Verify: compost raises pH", anchor: root.query, rooted_step_id: "s1",
    result: { synthesis: "", gaps: ["no source on compost and pH"] } });
  const open = n({ id: "o", parent_job_id: "r", branch_kind: "steer", query: "still running", anchor: root.query, rooted_step_id: "s3", status: "running", finished_at: null });
  const steers = [
    { id: "st1", parent_job_id: "r", child_job_id: "s", steer_kind: "human" as const, step_id: "s2", text: "focus on soil pH for tomatoes", topic_estimate: root.query, anchor: root.query, gap: null, created_at: "2026-10-25T10:01:00Z" },
    { id: "st2", parent_job_id: "r", child_job_id: "g", steer_kind: "gap" as const, step_id: "s1", text: "compost raises pH", topic_estimate: root.query, anchor: root.query, gap: { claim_id: "c1", score: 0.2, threshold: 0.5 }, created_at: "2026-10-25T10:00:30Z" },
    { id: "st3", parent_job_id: "r", child_job_id: "o", steer_kind: "human" as const, step_id: "s3", text: "still running", topic_estimate: root.query, anchor: root.query, gap: null, created_at: "2026-10-25T10:02:00Z" },
  ];
  return { root, nodes: [root, steer, gap, open], steers, estimate: "Soil pH management for tomato beds" };
}

Deno.test("P4a tree report: cumulative over the parent and every closed child, headed by the topic estimate, origin shown", () => {
  const r = buildTreeReport(fixtureTree());
  assertEquals(r.heading, "Soil pH management for tomato beds");
  assert(r.markdown.startsWith("# Soil pH management for tomato beds\n"), "headed by the estimate, not the prompt");
  assert(!r.markdown.startsWith("# How do I prepare garden soil?"));
  assert(r.markdown.includes("_Origin: How do I prepare garden soil?_"), "the prompt is the origin");
  assertEquals(r.branches.map((b) => b.job_id), ["r", "s", "g"], "parent + every CLOSED child, not the running one");
  assert(r.markdown.includes("Tomatoes prefer pH 6.2-6.8"));
});

// learning-record.schema.json v1 (06-EXPANSION §3.3), the exploratory fidelity's rules
const REQUIRED = ["schema_version", "fidelity", "producer", "source_ref", "domains", "steer", "red", "outcome", "created_at"];
const ALLOWED = new Set([...REQUIRED, "iterations", "hypotheses_refuted", "deviation", "mental_model", "skill_candidate", "reviewer_check"]);
Deno.test("P4a learning records: every branch reads back as an exploratory record derived from the tree", () => {
  const t = fixtureTree();
  const recs = learningRecords(t);
  assertEquals(recs.length, t.nodes.length, "one per branch");
  for (const r of recs) {
    for (const k of REQUIRED) assert(k in r, `missing ${k}`);
    for (const k of Object.keys(r)) assert(ALLOWED.has(k), `field ${k} is not in the schema`);
    assertEquals([r.schema_version, r.fidelity, r.producer], [1, "exploratory", "job-tree"]);
    assert(["found", "gap-remains"].includes(r.outcome.kind));
    assert(r.domains.length >= 1);
    assert(!("mental_model" in r), "nothing authored");
  }
  const by = Object.fromEntries(recs.map((r) => [r.source_ref.branch_id, r]));
  assert(by.s.steer.includes("human steer at s2: focus on soil pH for tomatoes"), by.s.steer);
  assertEquals(by.s.outcome.kind, "found");
  assert(by.s.outcome.evidence.some((e) => e.includes("credibility 0.8")) && by.s.outcome.evidence.some((e) => e.includes("coverage 1/1")));
  assert(by.g.steer.includes("gap gap steer at s1"), by.g.steer);
  assertEquals(by.g.red, "no source on compost and pH");
  assert(by.r.deviation.includes("a human steer answered it at s2") && by.r.deviation.includes("a gap gap steer answered it at s1"), by.r.deviation);
  assertEquals(by.s.deviation, "no steer answered it");
  // derived, not authored: change the tree, the record follows
  const t2 = fixtureTree(); (t2.nodes[1].result as Record<string, unknown>).gaps = ["new gap"];
  assertEquals(learningRecords(t2).find((r) => r.source_ref.branch_id === "s")!.red, "new gap");
});

// ── Cases 1 / 7 / 8: scheduling and the lane ────────────────────────────────────────────────
Deno.test("P4a scheduling: a human steer outranks main lines, which outrank gap work; the claim orders by it", () => {
  assert(branchRank("steer") < branchRank("root") && branchRank("root") < branchRank("gap") && branchRank("gap") === branchRank("interhub"));
  assert(/ORDER BY CASE branch_kind WHEN 'steer' THEN 0[^,]*, created_at/.test(CLAIM_SQL), CLAIM_SQL);
});

Deno.test("P4a lane: the dispatcher's cap is re-read every tick (a reloaded queue moves it)", async () => {
  let cap = 2;
  const started: string[] = [];
  let queue = ["a", "b", "c", "d", "e"];
  const d = new Dispatcher({
    connect: () => Promise.resolve({
      queryObject: <T>(sql: string) => {
        if (/SET status='running'/.test(sql)) {
          const id = queue.shift();
          return Promise.resolve({ rows: (id ? [{ id, query: "q", thread_id: null, origin: "manual", options: {} }] : []) as T[] });
        }
        return Promise.resolve({ rows: [] as T[] });
      },
      release: () => {},
    }),
    execute: (job) => { started.push(job.jobId); return new Promise(() => {}); },
    health: new ModelHealth(), probe: () => Promise.resolve(true),
    maxConcurrency: () => cap, probeIntervalMs: 0, log: () => {},
  });
  await d.tick();
  assertEquals(started.length, 2);
  cap = 4;
  await d.tick();
  assertEquals(started.length, 4, "raising the lane lets two more run");
  queue = [];
});

Deno.test("P4a lane: the research service reads the derived concurrency back; unreadable = 2 with a warning", async () => {
  const logs: string[] = [];
  const fx = (status: number, body: unknown) => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;
  assertEquals(await readLaneConcurrency("http://q/observe/queue/estimate", "k", (l) => logs.push(l), fx(200, { max_concurrency: 5, capacity_declared: true })), 5);
  assertEquals(logs.length, 0);
  assertEquals(await readLaneConcurrency("http://q/observe/queue/estimate", "k", (l) => logs.push(l), fx(503, {})), 2);
  assertEquals(await readLaneConcurrency("http://q/observe/queue/estimate", "k", (l) => logs.push(l), fx(200, { max_concurrency: 1 })), 2, "never 1");
  assertEquals(await readLaneConcurrency("http://q/observe/queue/estimate", "k", (l) => logs.push(l), (() => Promise.reject(new Error("refused"))) as unknown as typeof fetch), 2);
  assertEquals(logs.filter((l) => /WARNING/.test(l)).length, 3);
  // the request names the lane
  let asked = "";
  await readLaneConcurrency("http://q/observe/queue/estimate", "k", () => {}, ((u: URL) => { asked = String(u); return Promise.resolve(new Response('{"max_concurrency":3}')); }) as unknown as typeof fetch);
  assert(asked.includes("key=research-branch"), asked);
});

Deno.test("P4a lane: RESEARCH_MAX_CONCURRENCY is no longer a hand-set cap", () => {
  const idx = Deno.readTextFileSync(here("./index.ts"));
  assert(!/parseInt\(env\("RESEARCH_MAX_CONCURRENCY"/.test(idx), "index.ts still parses RESEARCH_MAX_CONCURRENCY into a cap");
  const compose = readOr(here("../../docker/docker-compose.yml"));
  if (compose !== null) assert(!/^\s*RESEARCH_MAX_CONCURRENCY:/m.test(compose), "compose still sets RESEARCH_MAX_CONCURRENCY");
});

// ── Case 11: no nightly drain (checkout-only: the image build context has neither file) ────
Deno.test("P4a ideas: no nightly drain - the refinery no longer researches owed ideas and cron no longer fires it", () => {
  const cron = readOr(here("../../docker/cron/crontab"));
  const ref = readOr(here("../openbrain-idea-refinery/index.ts"));
  if (cron === null || ref === null) return;
  const live = cron.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  assert(!live.some((l) => /openbrain-idea-refinery/.test(l)), "crontab still fires the refinery");
  assert(!/selectOwed|submitWithBackpressure\(await ideaQuery/.test(ref), "the refinery still drains owed ideas");
  assert(/research_idea_queue\(/.test(ref), "`research now` goes through the database's coalescing path");
  const sql = readOr(here("../../docker/init-research-trees.sql"));
  if (sql !== null) assert(/BEFORE INSERT ON public\.idea_revisions/.test(sql), "a captured/changed idea engages at once (trigger)");
});
