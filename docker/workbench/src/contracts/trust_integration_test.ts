// deno test src/contracts/trust_integration_test.ts - the trust panels' reads (research-workbench P3b,
// rw-p3b-trustpanels) over a REAL workbench and database:
//   T1 claims(): verdict, corroborations and contradicted_by_newer on every claim (the ledger's columns)
//   T2 coverage(session): needs by status (no percent), topic estimate + anchor, hubs, roll-up
//   T3 coverage(document): the document's hubs and ONLY its owner's sessions
//   T4 reportCredibility: the roll-up with the claim-kind weights it used; never a bare number
//   T5 the export of a research report carries the roll-up section at its head
//   T6 two users: shared knowledge reads the same; per-user coverage is 404 to anyone else
//
// SKIPPED unless TRUST_TEST_BASE is set. contract-test/run-trust-tests.ps1 sets it to the :wt workbench
// on a DISPOSABLE internal network (the real initdb chain, contract-test/fixtures.sql, a temp vault).
// Never point it at a live stack: it writes rows and vault files.
// Environment: TRUST_TEST_BASE, DOCS_TEST_KEY, DOCS_TEST_VAULT, DOCS_TEST_SUB_HEADER (default X-Test-Sub),
// CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser: it plants rows with fixed created_at).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("TRUST_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("DOCS_TEST_KEY") ?? "";
const VAULT = Deno.env.get("DOCS_TEST_VAULT") ?? "/vault";
const SUB_HEADER = Deno.env.get("DOCS_TEST_SUB_HEADER") ?? "X-Test-Sub";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 2, true)
  : null;

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}

const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const A = { [SUB_HEADER]: `trust-ay-${rnd()}` };
const B = { [SUB_HEADER]: `trust-bee-${rnd()}` };
const M = { promptA: `PromptA${rnd()}X`, promptB: `PromptB${rnd()}X`, needB: `NeedB${rnd()}X`, anchorB: `AnchorB${rnd()}X` };

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const r = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json", "x-brain-key": KEY, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

// ids of this run (fixed shapes, fresh per run)
const u = () => crypto.randomUUID();
const ID = {
  paper: u(), general: u(), newer: u(), report: u(), reportB: u(), reportNoJob: u(),
  c1: u(), c2: u(), c3: u(), c4: u(), c5: u(), c0: u(),
  jobA: u(), jobB: u(), jobDocA: u(), jobDocB: u(),
};
const TXT = { c1: `Trust claim one ${rnd()}`, c2: `Trust claim two ${rnd()}`, c3: `Trust claim three ${rnd()}`, c4: `Trust claim four ${rnd()}`, c5: `Trust claim five ${rnd()}` };
const HUB = `content/concept/trust-hub-${rnd()}`;
const WEIGHTS = { scholarly: 1, general: 0.4 };
const ROLLUP = {
  value: 0.62, claims: 2, below_floor: 1, judged_lines: 3, judged_not_filed: 1, kind: "general_theory",
  model_version: "d15 weights v1 paper p1", weights: WEIGHTS, filed: true, basis: "filing",
};
let docPath = "";
let planted = false;

async function plant() {
  if (planted) return;
  planted = true;
  const t0 = "2026-01-01T00:00:00Z", t1 = "2026-02-01T00:00:00Z", t2 = "2026-03-01T00:00:00Z";
  await sql(`INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata, created_at) VALUES
    ($1, 'https://example.org/trust-paper', 'Trust paper', 'paper text', 'paper', 'example.org', '{}', $8),
    ($2, 'https://example.org/trust-general', 'Trust general page', 'general text', 'web_article', 'example.org', '{}', $8),
    ($3, 'https://example.org/trust-newer', 'Trust newer source', 'newer text', 'web_article', 'example.org', '{}', $10),
    ($4, NULL, 'Trust report', 'Synthesis [Source 1] [Source 2].', 'research_synthesis', NULL, '{}', $9),
    ($5, NULL, 'Trust report of B', 'Synthesis.', 'research_synthesis', NULL, '{}', $9),
    ($6, NULL, 'Trust report filed by no job', 'Synthesis.', 'research_synthesis', NULL, '{}', $9),
    ($7, 'https://example.org/trust-unused', 'unused', 'x', 'web_article', 'example.org', '{}', $8)`,
    [ID.paper, ID.general, ID.newer, ID.report, ID.reportB, ID.reportNoJob, u(), t0, t1, t2]);
  // claims of the report: c1 two states sources (1 corroboration), c2 contradicted by a NEWER claim c3,
  // c4 contradicted by a NEWER source, c5 contradicted only by an OLDER claim c0
  await sql(`INSERT INTO public.claims (id, text, synthesis_id, epistemic_tag, created_at, metadata)
    SELECT v.id::uuid, v.text, $13::uuid, v.tag, v.at::timestamptz, '{"claim_kind": "general_theory"}'::jsonb
      FROM (VALUES ($1, $7, 'sourced', $14), ($2, $8, 'sourced', $14), ($3, $9, 'sourced', $16),
                   ($4, $10, 'uncertain', $14), ($5, $11, 'sourced', $15), ($6, $12, 'sourced', $14)) v(id, text, tag, at)`,
    [ID.c1, ID.c2, ID.c3, ID.c4, ID.c5, ID.c0, TXT.c1, TXT.c2, TXT.c3, TXT.c4, TXT.c5, `Trust claim zero ${rnd()}`, ID.report, t0, t1, t2]);
  await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES
    ($1, $5, 'states'), ($1, $6, 'states'), ($2, $5, 'states'), ($3, $6, 'states'), ($4, $6, 'states'),
    ($4, $7, 'contradicts'), ($8, $5, 'states'), ($9, $6, 'inferred_from')`,
    [ID.c1, ID.c2, ID.c3, ID.c4, ID.paper, ID.general, ID.newer, ID.c5, ID.c0]);
  await sql(`INSERT INTO public.claim_sources (claim_id, parent_claim_id, edge_type) VALUES
    ($1, $2, 'contradicts'), ($2, $1, 'contradicts'), ($3, $4, 'contradicts'), ($4, $3, 'contradicts')`,
    [ID.c2, ID.c3, ID.c5, ID.c0]);
  // the hub: a concept page linking both sources' leaves (the P2b hub computation reads wiki_pages)
  await sql(`INSERT INTO public.wiki_pages (slug, page_class, entity_type, title, body, links) VALUES
    ($1, 'entity', 'concept', 'Trust hub', 'hub', jsonb_build_array('content/source/' || $2, 'content/source/' || $3)),
    ('content/source/' || $2, 'source', NULL, 'Trust paper', 'Leaf.', '[]'),
    ('content/source/' || $3, 'source', NULL, 'Trust general page', 'Leaf.', '[]')
    ON CONFLICT (slug) DO NOTHING`, [HUB, ID.paper, ID.general]);
  const result = (report: string, needs: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({
    needs_status: needs, gaps: needs.filter((n: any) => n.status !== "answered").map((n: any) => n.need),
    curator: { persist: { synthesis_id: report, source_ids: [ID.paper, ID.general, null] } },
    line_credibility: [{ claim: 0, text: TXT.c1, verdict: "supports" }, { claim: 1, text: TXT.c2, verdict: "partial" }, { claim: 2, text: TXT.c4, verdict: "Not A Key!" }],
    ...extra,
  });
  const needsA = [
    { need: "what is trust", status: "answered" }, { need: "how much trust", status: "partial" }, { need: "who trusts", status: "open" },
    { need: "when trust", status: "search_failed" }, { need: "why trust", status: "answered" },
  ];
  await sql(`INSERT INTO public.research_jobs (id, status, origin, query, result, metrics, topic_estimate, caller, started_at, finished_at, created_at)
             VALUES ($1, 'done', 'workspace', $2, $3::jsonb, $4::jsonb, 'trust and how it is earned', 'workspace', now(), now(), now())`,
    [ID.jobA, M.promptA, result(ID.report, needsA), JSON.stringify({ credibility: ROLLUP })]);
  await sql(`INSERT INTO public.research_jobs (id, status, origin, query, result, metrics, topic_estimate, anchor, caller, started_at, finished_at, created_at)
             VALUES ($1, 'done', 'workspace', $2, $3::jsonb, $4::jsonb, 'B estimate', $5, 'workspace', now(), now(), now())`,
    [ID.jobB, M.promptB, result(ID.reportB, [{ need: M.needB, status: "open" }]), JSON.stringify({ credibility: ROLLUP }), M.anchorB]);
  await sql(`INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, $2, $2, $3), ($4, $5, $5, $6)`,
    [ID.jobA, A[SUB_HEADER], M.promptA, ID.jobB, B[SUB_HEADER], M.promptB]);
  // A's document, and a session of A's and one of B's that both name it as their inlet
  const made = await call("POST", "/workbench/documents", A, { title: `Trust doc ${rnd()}`, body: `Cites [[source:${ID.paper}|the paper]].` });
  assertEquals(made.status, 201, made.text);
  docPath = made.json.path;
  await sql(`INSERT INTO public.research_jobs (id, status, origin, query, result, caller, inlet_ref, created_at)
             VALUES ($1, 'done', 'workspace', 'doc session of A', $3::jsonb, 'workspace', jsonb_build_object('kind', 'document', 'id', $5::text), now()),
                    ($2, 'done', 'workspace', $6, $4::jsonb, 'workspace', jsonb_build_object('kind', 'document', 'id', $5::text), now())`,
    [ID.jobDocA, ID.jobDocB, result(ID.report, needsA), result(ID.reportB, [{ need: M.needB, status: "open" }]), docPath, M.promptB]);
  await sql(`INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, $2, $2, 'doc session of A'), ($3, $4, $4, $5)`,
    [ID.jobDocA, A[SUB_HEADER], ID.jobDocB, B[SUB_HEADER], M.promptB]);
  // the report's page in the vault (what the export reads)
  await Deno.mkdir(`${VAULT}/content/source`, { recursive: true });
  await Deno.writeTextFile(`${VAULT}/content/source/${ID.report}.md`,
    `---\ntitle: Trust report\ncontent_type: research_synthesis\n---\n\n# Trust report\n\nTrustBodyMarker the report body.\n`);
  await Deno.writeTextFile(`${VAULT}/content/source/${ID.general}.md`, `---\ntitle: Trust general page\n---\n\nGeneralBodyMarker.\n`);
}

const t = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, ignore, sanitizeOps: false, sanitizeResources: false, fn: async () => { await plant(); await fn(); } });

t("T1 claims(): every claim carries verdict, corroborations and contradicted_by_newer", async () => {
  const r = await call("GET", `/workbench/contract/claims?synthesis_id=${ID.report}&limit=50`, A);
  assertEquals(r.status, 200, r.text);
  const by = new Map((r.json.claims as any[]).map((c) => [c.id, c]));
  assertEquals(by.size, 6, r.text);
  for (const c of by.values()) {
    for (const k of ["epistemic_tag", "verdict", "edges_by_type", "corroborations", "contradicted_by_newer", "confidence"]) {
      assert(k in c, `claim ${c.id} misses the ledger column ${k}`);
    }
  }
  assertEquals([by.get(ID.c1).verdict, by.get(ID.c1).corroborations, by.get(ID.c1).contradicted_by_newer], ["supports", 1, false]);
  assertEquals([by.get(ID.c2).verdict, by.get(ID.c2).corroborations, by.get(ID.c2).contradicted_by_newer], ["partial", 0, true], "c2: contradicted by the newer claim c3");
  assertEquals(by.get(ID.c3).contradicted_by_newer, false, "c3 is the newer one: contradicted by an OLDER claim");
  assertEquals([by.get(ID.c4).verdict, by.get(ID.c4).contradicted_by_newer], [null, true], "c4: a verdict that is not a key is never served; contradicted by a newer source");
  assertEquals(by.get(ID.c5).contradicted_by_newer, false, "c5: contradicted only by an older claim");
  assertEquals(by.get(ID.c1).edges_by_type, { states: 2 });
  assertEquals(by.get(ID.c4).edges_by_type, { states: 1, contradicts: 1 });
});

t("T2 coverage(session): needs by status (never a percent), topic estimate beside the anchor, hubs, the roll-up", async () => {
  const r = await call("GET", `/workbench/contract/sessions/${ID.jobA}/coverage`, A);
  assertEquals(r.status, 200, r.text);
  assertEquals(r.json.by_status, { answered: 2, partial: 1, open: 1, search_failed: 1 });
  assertEquals(r.json.needs.map((n: any) => n.status), ["answered", "partial", "open", "search_failed", "answered"]);
  assert(!/%|percent/i.test(r.text), "the coverage carries no percent");
  assertEquals(r.json.topic_estimate, "trust and how it is earned");
  assertEquals(r.json.anchor, M.promptA, "a root's anchor is its own question - shown to its owner");
  assertEquals(r.json.report_id, ID.report);
  const hub = (r.json.hubs as any[]).find((h) => h.centre.slug === HUB);
  assert(hub, `the session's sources fall into the planted hub: ${JSON.stringify(r.json.hubs)}`);
  assertEquals(typeof hub.thin, "boolean");
  assertEquals(typeof hub.contested, "boolean");
  assertStringIncludes(r.json.credibility.statement, "weights scholarly 1.00, general 0.40");
  assertStringIncludes(r.json.credibility.statement, "claim kind general_theory");
});

t("T3 coverage(document): the document's hubs and only its owner's sessions", async () => {
  const r = await call("GET", `/workbench/contract/documents/coverage?path=${encodeURIComponent(docPath)}`, A);
  assertEquals(r.status, 200, r.text);
  const ids = (r.json.sessions as any[]).map((s) => s.id);
  assert(ids.includes(ID.jobDocA), `A's session started from the document is listed: ${r.text}`);
  assert(!ids.includes(ID.jobDocB), "B's session naming A's document is NOT listed to A");
  assert(!r.text.includes(M.promptB) && !r.text.includes(M.needB), "nothing of B's in A's document coverage");
  assert((r.json.hubs as any[]).length >= 1, `the document's hub context: ${r.text}`);
  const s = (r.json.sessions as any[]).find((x) => x.id === ID.jobDocA);
  assertEquals(s.by_status, { answered: 2, partial: 1, open: 1, search_failed: 1 });
  assertStringIncludes(s.credibility, "Report credibility");
});

t("T4 reportCredibility: the roll-up with the claim-kind weights; a report with none says so; a non-report is 404", async () => {
  const r = await call("GET", `/workbench/contract/reports/${ID.report}/credibility`, A);
  assertEquals(r.status, 200, r.text);
  assertEquals(r.json.recorded, true);
  assertEquals(r.json.value, 0.62);
  assertEquals(r.json.weights, [{ family: "scholarly", weight: 1 }, { family: "general", weight: 0.4 }]);
  assertEquals(r.json.claim_kind, "general_theory");
  assertStringIncludes(r.json.statement, "Report credibility 0.62");
  assertStringIncludes(r.json.statement, "weights scholarly 1.00, general 0.40");
  const none = await call("GET", `/workbench/contract/reports/${ID.reportNoJob}/credibility`, A);
  assertEquals(none.status, 200, none.text);
  assertEquals([none.json.recorded, none.json.value], [false, null]);
  assertStringIncludes(none.json.statement, "not recorded");
  assertEquals((await call("GET", `/workbench/contract/reports/${ID.general}/credibility`, A)).status, 404, "a source that is not a report");
  assertEquals((await call("GET", `/workbench/contract/reports/${ID.report}/credibility?metadata_filter=${encodeURIComponent('{"share":"cloud"}')}`, A)).status, 404, "fail closed under a filter");
});

t("T5 the export of a research report carries the roll-up section at its head; another page does not", async () => {
  const r = await fetch(`${BASE}/workbench/export?path=${encodeURIComponent(`content/source/${ID.report}.md`)}&format=md&style=ieee`,
    { headers: { "x-brain-key": KEY, ...A } });
  const md = await r.text();
  assertEquals(r.status, 200, md.slice(0, 400));
  const at = md.indexOf("Report credibility");
  assert(at >= 0, `the exported report has the roll-up section: ${md.slice(0, 600)}`);
  assert(at < md.indexOf("TrustBodyMarker"), "the roll-up is at the head of the report, before its body");
  assertStringIncludes(md.replace(/\s+/g, " "), "weights scholarly 1.00, general 0.40"); // pandoc re-wraps the line
  // the weights table, as pandoc's markdown writer renders it (a pipe or a simple table: one row per family)
  assert(/^\s*\|?\s*scholarly\s*\|?\s+1\.00\s*\|?\s*$/m.test(md) && /^\s*\|?\s*general\s*\|?\s+0\.40\s*\|?\s*$/m.test(md), `the weights table: ${md.slice(0, 800)}`);
  assert(/^#{1,6} Report credibility\s*$/m.test(md), "the section heading P6b keys on");
  const other = await fetch(`${BASE}/workbench/export?path=${encodeURIComponent(`content/source/${ID.general}.md`)}&format=md&style=ieee`,
    { headers: { "x-brain-key": KEY, ...A } });
  const otherMd = await other.text();
  assertEquals(other.status, 200, otherMd.slice(0, 400));
  assert(!otherMd.includes("Report credibility"), "a page that is not a research report gets no roll-up section");
});

t("T6 two users: shared knowledge reads the same; per-user coverage of another user is 404 and leaks nothing", async () => {
  for (const p of [`/workbench/contract/claims?synthesis_id=${ID.report}&limit=50`, `/workbench/contract/reports/${ID.report}/credibility`,
    `/workbench/contract/sources/${ID.paper}/quality`]) {
    const a = await call("GET", p, A);
    const b = await call("GET", p, B);
    assertEquals([a.status, b.status], [200, 200], `${p}: ${a.text} / ${b.text}`);
    assertEquals(a.text, b.text, `${p}: shared knowledge reads the same for both users`);
  }
  const foreign = await call("GET", `/workbench/contract/sessions/${ID.jobB}/coverage`, A);
  assertEquals(foreign.status, 404, foreign.text);
  for (const m of [M.promptB, M.needB, M.anchorB]) assert(!foreign.text.includes(m), `B's ${m} reached A`);
  const own = await call("GET", `/workbench/contract/sessions/${ID.jobB}/coverage`, B);
  assertEquals(own.status, 200, own.text);
  assertEquals(own.json.anchor, M.anchorB, "B reads B's own anchor");
  const doc = await call("GET", `/workbench/contract/documents/coverage?path=${encodeURIComponent(docPath)}`, B);
  assertEquals(doc.status, 404, `B reading A's document coverage: ${doc.text}`);
  // a caller-supplied user is never read: a query naming B changes nothing for A
  const spoof = await call("GET", `/workbench/contract/sessions/${ID.jobB}/coverage?sub=${encodeURIComponent(B[SUB_HEADER])}&owner_sub=${encodeURIComponent(B[SUB_HEADER])}`, A);
  assert(spoof.status === 404 || spoof.status === 400, `a user named in the query is ignored: ${spoof.status} ${spoof.text}`);
  assert(!spoof.text.includes(M.promptB));
});
