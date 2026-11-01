// deno test src/contracts/trust_probe_integration_test.ts - rw-p3b-trustpanels round 2: the tester's adversarial
// probes (t-p3b-trust, attempt 1; journal/evidence/rw-p3b-trustpanels/tester/probes/tester_probe_test.ts.txt), kept
// in the suite as regressions: V1-V5 the verdict's id join on the curator's fold / refile paths (D2), N1-N4
// contradicted-by-newer (D3: N1 now asserted), K1 the corroboration count, C1-C3 / R1 / S1 two-user isolation.
// SKIPPED unless TRUST_TEST_BASE and CONTRACT_TEST_DB_HOST are set (run-trust-tests.ps1, the disposable lab only).
// tester t-p3b-trust (rw-p3b-trustpanels): adversarial probes over a REAL lab workbench + database.
// Mounted read-only into the :wt-t-p3b-trust test image at src/contracts/zz_tester_probe_test.ts and run
// against the disposable lab only (TRUST_TEST_BASE / CONTRACT_TEST_DB_HOST). Every probe prints a
// "PROBE <id> ..." line with what it saw; assertions encode the bar the anchor sets.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("TRUST_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("DOCS_TEST_KEY") ?? "";
const VAULT = Deno.env.get("DOCS_TEST_VAULT") ?? "/vault";
const SUB_HEADER = "X-Test-Sub";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({ hostname: HOST!, port: 5432, database: "openbrain", user: "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "" }, 2, true)
  : null;
async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try { return (await c.queryObject<T>(text, args)).rows; } finally { c.release(); }
}
const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const u = () => crypto.randomUUID();
const A = { [SUB_HEADER]: `tprobe-a-${rnd()}` };
const B = { [SUB_HEADER]: `tprobe-b-${rnd()}` };
async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const t = performance.now();
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", "x-brain-key": KEY, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const ms = performance.now() - t;
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, text, ms };
}
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, sanitizeOps: false, sanitizeResources: false, fn });
const claimsOf = async (syn: string, who = A) => {
  const r = await call("GET", `/workbench/contract/claims?synthesis_id=${syn}&limit=50`, who);
  assertEquals(r.status, 200, r.text);
  return new Map((r.json.claims as any[]).map((c) => [c.id, c]));
};
const META = JSON.stringify({ claim_kind: "general_theory", source: "deep-research-claim" });

async function source(content_type: string, at = "2026-01-01T00:00:00Z", title = "probe source") {
  const id = u();
  await sql(`INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata, created_at) VALUES ($1, $2, $3, 'x', $4, 'example.org', '{}', $5::timestamptz)`,
    [id, content_type === "research_synthesis" ? null : `https://example.org/p-${rnd()}`, title, content_type, at]);
  return id;
}
async function job(o: { id?: string; syn: string; lines: { text: string; verdict: string }[]; filed?: (string | null)[]; finished: string; query?: string; owner?: string }) {
  const id = o.id ?? u();
  const result = { curator: { persist: { synthesis_id: o.syn, source_ids: [] }, claims: { filed: o.filed ?? [] } }, line_credibility: o.lines.map((l, i) => ({ claim: i, ...l })) };
  await sql(`INSERT INTO public.research_jobs (id, status, origin, query, result, caller, started_at, finished_at, created_at) VALUES ($1, 'done', 'workspace', $2, $3::jsonb, 'workspace', $4::timestamptz, $4::timestamptz, $4::timestamptz)`,
    [id, o.query ?? `probe job ${rnd()}`, JSON.stringify(result), o.finished]);
  if (o.owner) await sql(`INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, $2, $2, $3)`, [id, o.owner, o.query ?? "p"]);
  return id;
}
const foc = async (text: string, syn: string, thread: string | null = null) =>
  (await sql<{ id: string; was_duplicate: boolean }>(`SELECT * FROM public.find_or_create_claim($1, $2::uuid, $3::uuid, 'sourced', NULL, NULL, NULL, $4::jsonb)`, [text, thread, syn, META]))[0];

// ── verdict matched by TEXT ─────────────────────────────────────────────────────────────────────
t("V1 a claim re-filed by a second synthesis in a case variant (find_or_create_claim folds it): its verdict", async () => {
  const paper = await source("paper");
  const s1 = await source("research_synthesis"), s2 = await source("research_synthesis");
  const base = `Fold probe claim ${rnd()} holds`;
  const c1 = await foc(base, s1);
  await sql(`SELECT public.link_claim_to_source($1::uuid, $2::uuid, 'states', 1.0)`, [c1.id, paper]);
  await job({ syn: s1, lines: [{ text: base, verdict: "supports" }], filed: [c1.id], finished: "2026-01-02T00:00:00Z" });
  const c2 = await foc(base.toLowerCase(), s2); // the curator's dedupe: same row, synthesis_id moves to s2, text kept
  await job({ syn: s2, lines: [{ text: base.toLowerCase(), verdict: "unsupported" }], filed: [c2.id], finished: "2026-01-03T00:00:00Z" });
  const row = (await sql(`SELECT synthesis_id::text AS s, text FROM public.claims WHERE id = $1`, [c1.id]))[0];
  const got = (await claimsOf(s2)).get(c1.id);
  console.log(`PROBE V1 fold: same row=${c1.id === c2.id} was_duplicate=${c2.was_duplicate} row.synthesis=${row.s === s2 ? "s2" : row.s} row.text="${row.text}" -> ledger verdict=${JSON.stringify(got?.verdict)} (the latest run judged it 'unsupported'; its filed[] names this claim id)`);
  assertEquals(got?.verdict, "unsupported", "the latest judgement of THIS claim (job 2 filed it, filed[0] = its id)");
});

t("V2 the same exact text re-filed by a later synthesis: the latest verdict wins", async () => {
  const paper = await source("paper");
  const s1 = await source("research_synthesis"), s2 = await source("research_synthesis");
  const text = `Exact refile probe ${rnd()}`;
  const c = await foc(text, s1);
  await sql(`SELECT public.link_claim_to_source($1::uuid, $2::uuid, 'states', 1.0)`, [c.id, paper]);
  await job({ syn: s1, lines: [{ text, verdict: "supports" }], filed: [c.id], finished: "2026-01-02T00:00:00Z" });
  await foc(text, s2);
  await job({ syn: s2, lines: [{ text, verdict: "partial" }], filed: [c.id], finished: "2026-01-03T00:00:00Z" });
  const got = (await claimsOf(s2)).get(c.id);
  console.log(`PROBE V2 exact refile -> verdict=${JSON.stringify(got?.verdict)} (expected partial)`);
  assertEquals(got?.verdict, "partial");
});

t("V3 identical claim text in two threads, two syntheses, two jobs with different verdicts: each claim its own", async () => {
  const paper = await source("paper");
  const s1 = await source("research_synthesis"), s2 = await source("research_synthesis");
  const th1 = u(), th2 = u();
  await sql(`INSERT INTO public.threads (id, name) VALUES ($1, 'probe t1'), ($2, 'probe t2')`, [th1, th2]).catch(async (e) => {
    console.log(`PROBE V3 threads insert: ${(e as Error).message}`);
    throw e;
  });
  const text = `Twin text probe ${rnd()}`;
  const a = await foc(text, s1, th1), b = await foc(text, s2, th2);
  for (const id of [a.id, b.id]) await sql(`SELECT public.link_claim_to_source($1::uuid, $2::uuid, 'states', 1.0)`, [id, paper]);
  await job({ syn: s1, lines: [{ text, verdict: "supports" }], filed: [a.id], finished: "2026-01-02T00:00:00Z" });
  await job({ syn: s2, lines: [{ text, verdict: "unsupported" }], filed: [b.id], finished: "2026-01-03T00:00:00Z" });
  const va = (await claimsOf(s1)).get(a.id)?.verdict, vb = (await claimsOf(s2)).get(b.id)?.verdict;
  console.log(`PROBE V3 twins: distinct rows=${a.id !== b.id} verdicts=${JSON.stringify([va, vb])} (expected ["supports","unsupported"])`);
  assertEquals([va, vb], ["supports", "unsupported"]);
});

t("V4 one job judging the same text twice with different verdicts (two listed lines folded into one row)", async () => {
  const paper = await source("paper");
  const s = await source("research_synthesis");
  const text = `Doubled line probe ${rnd()}`;
  const c = await foc(text, s);
  await sql(`SELECT public.link_claim_to_source($1::uuid, $2::uuid, 'states', 1.0)`, [c.id, paper]);
  await job({ syn: s, lines: [{ text, verdict: "supports" }, { text: `  ${text} `, verdict: "unsupported" }], filed: [c.id, c.id], finished: "2026-01-02T00:00:00Z" });
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push((await claimsOf(s)).get(c.id)?.verdict);
  console.log(`PROBE V4 doubled line, 5 reads: ${JSON.stringify(runs)} (stable? one verdict silently chosen)`);
  assert(new Set(runs).size === 1, "the verdict is stable across reads");
});

t("V5 an edited claim text (text changed after filing): verdict", async () => {
  const paper = await source("paper");
  const s = await source("research_synthesis");
  const text = `Edited probe ${rnd()}`;
  const c = await foc(text, s);
  await sql(`SELECT public.link_claim_to_source($1::uuid, $2::uuid, 'states', 1.0)`, [c.id, paper]);
  await job({ syn: s, lines: [{ text, verdict: "supports" }], filed: [c.id], finished: "2026-01-02T00:00:00Z" });
  await sql(`UPDATE public.claims SET text = text || ' (edited)' WHERE id = $1`, [c.id]);
  const got = (await claimsOf(s)).get(c.id);
  console.log(`PROBE V5 edited -> verdict=${JSON.stringify(got?.verdict)} (null = 'not judged': the old verdict is NOT carried to edited text)`);
});

// ── contradicted by newer ────────────────────────────────────────────────────────────────────────
t("N1-N4 contradicted-by-newer ordering edges", async () => {
  const paper = await source("paper");
  const s = await source("research_synthesis");
  const mk = async (text: string, at: string, status = "active") => {
    const id = u();
    await sql(`INSERT INTO public.claims (id, text, synthesis_id, epistemic_tag, status, created_at, metadata) VALUES ($1, $2, $3, 'sourced', $5, $4::timestamptz, $6::jsonb)`, [id, text, s, at, status, META]);
    await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $2, 'states')`, [id, paper]);
    return id;
  };
  const old1 = await mk(`old1 ${rnd()}`, "2026-01-01T00:00:00Z"), newRetracted = await mk(`newR ${rnd()}`, "2026-03-01T00:00:00Z", "retracted");
  const old2 = await mk(`old2 ${rnd()}`, "2026-01-01T00:00:00Z"), same = await mk(`same ${rnd()}`, "2026-01-01T00:00:00Z");
  const old3 = await mk(`old3 ${rnd()}`, "2026-01-01T00:00:00Z");
  const newSup = await source("web_article", "2026-04-01T00:00:00Z");
  await sql(`UPDATE public.sources SET retraction_committed_at = now(), unlinked_at = now() WHERE id = $1`, [newSup]);
  const old4 = await mk(`old4 ${rnd()}`, "2026-01-01T00:00:00Z"), older = await mk(`older ${rnd()}`, "2025-06-01T00:00:00Z");
  await sql(`INSERT INTO public.claim_sources (claim_id, parent_claim_id, edge_type) VALUES ($1, $2, 'contradicts'), ($3, $4, 'contradicts'), ($5, $6, 'contradicts')`,
    [old1, newRetracted, old2, same, old4, older]);
  await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1, $2, 'contradicts')`, [old3, newSup]);
  const m = await claimsOf(s);
  const f = (id: string) => m.get(id)?.contradicted_by_newer;
  console.log(`PROBE N1 contradicted by a NEWER but RETRACTED claim -> ${f(old1)}`);
  console.log(`PROBE N2 contradicted by a claim with the SAME created_at -> ${f(old2)} (expected false)`);
  console.log(`PROBE N3 contradicted by a newer source that is unlinked/suppressed -> ${f(old3)} (expected false)`);
  console.log(`PROBE N4 contradicted only by an OLDER claim (edge written now) -> ${f(old4)} (expected false)`);
  assertEquals([f(old1), f(old2), f(old3), f(old4)], [false, false, false, false], "D3: a retracted newer claim counts no more than a suppressed source");
});

t("K1 corroboration count: two states sources, one suppressed; a third corroborates; an inferred_from", async () => {
  const s = await source("research_synthesis");
  const p1 = await source("paper"), p2 = await source("paper"), p3 = await source("web_article"), p4 = await source("web_article"), p5 = await source("web_article");
  await sql(`UPDATE public.sources SET retraction_committed_at = now() WHERE id = $1`, [p2]);
  const id = u();
  await sql(`INSERT INTO public.claims (id, text, synthesis_id, epistemic_tag, created_at, metadata) VALUES ($1, $2, $3, 'sourced', now(), $4::jsonb)`, [id, `corro ${rnd()}`, s, META]);
  await sql(`INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES ($1,$2,'states'),($1,$3,'states'),($1,$4,'corroborates'),($1,$5,'inferred_from'),($1,$6,'contradicts')`, [id, p1, p2, p3, p4, p5]);
  const c = (await claimsOf(s)).get(id);
  console.log(`PROBE K1 corroborations=${c?.corroborations} edges_by_type=${JSON.stringify(c?.edges_by_type)} (states p1 + corroborates p3 active = 1; suppressed p2 lends none)`);
  assertEquals(c?.corroborations, 1);
});

// ── coverage: another user's session / document ────────────────────────────────────────────────
const MB = { prompt: `PRIVPROMPT${rnd()}`, need: `PRIVNEED${rnd()}`, anchor: `PRIVANCHOR${rnd()}`, gap: `PRIVGAP${rnd()}`, title: `PRIVDOC${rnd()}`, idea: `PRIVIDEA${rnd()}`, est: `PRIVEST${rnd()}` };
let planted: null | { bJob: string; bChild: string; bReport: string; bDoc: string; aDoc: string; ownerless: string; service: string } = null;
async function plantB() {
  if (planted) return planted;
  const bReport = await source("research_synthesis", "2026-02-01T00:00:00Z", "B's report");
  const bd = await call("POST", "/workbench/documents", B, { title: MB.title, body: `B private body ${MB.prompt} [[source:${bReport}|r]]` });
  assertEquals(bd.status, 201, bd.text);
  const ad = await call("POST", "/workbench/documents", A, { title: `A doc ${rnd()}`, body: `A body [[source:${bReport}|r]]` });
  assertEquals(ad.status, 201, ad.text);
  const bJob = u(), bChild = u(), ownerless = u(), service = u();
  const res = JSON.stringify({ needs_status: [{ need: MB.need, status: "open" }], gaps: [MB.gap], curator: { persist: { synthesis_id: bReport, source_ids: [] } } });
  const metrics = JSON.stringify({ credibility: { value: 0.5, claims: 1, below_floor: 0, judged_lines: 1, judged_not_filed: 0, kind: "general_theory", model_version: "m", weights: { scholarly: 1, general: 0.4 }, filed: true, basis: "filing" } });
  await sql(`INSERT INTO public.research_jobs (id, status, origin, query, result, metrics, topic_estimate, anchor, caller, inlet_ref, started_at, finished_at, created_at)
     VALUES ($1, 'done', 'workspace', $2, $3::jsonb, $4::jsonb, $5, $6, 'workspace', jsonb_build_object('kind','document','id',$7::text), now(), now(), now())`,
    [bJob, MB.prompt, res, metrics, MB.est, MB.anchor, bd.json.path]);
  await sql(`INSERT INTO public.research_jobs (id, status, origin, query, result, caller, root_job_id, parent_job_id, anchor, branch_kind, rooted_step_id, inlet_ref, created_at)
     VALUES ($1, 'done', 'workspace', $2, $3::jsonb, 'workspace', $4, $4, $5, 'steer', 'step-probe', jsonb_build_object('kind','document','id',$6::text), now())`,
    [bChild, `${MB.prompt} child`, res, bJob, MB.prompt, ad.json.path]).catch(async (e) => {
      console.log(`PROBE plant child (branch_kind fallback): ${(e as Error).message}`);
      await sql(`INSERT INTO public.research_jobs (id, status, origin, query, result, caller, root_job_id, parent_job_id, anchor, inlet_ref, created_at)
         VALUES ($1, 'done', 'workspace', $2, $3::jsonb, 'workspace', $4, $4, $5, jsonb_build_object('kind','document','id',$6::text), now())`,
        [bChild, `${MB.prompt} child`, res, bJob, MB.prompt, ad.json.path]);
    });
  await sql(`INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, $2, $2, $3)`, [bJob, B[SUB_HEADER], MB.prompt]);
  // a job with NO recorded owner, and one a service started
  await sql(`INSERT INTO public.research_jobs (id, status, origin, query, result, caller, created_at) VALUES ($1, 'done', 'workspace', $2, $3::jsonb, 'workspace', now()), ($4, 'done', 'agent', 'service probe question', $3::jsonb, 'agent', now())`,
    [ownerless, `OWNERLESS${MB.prompt}`, res, service]);
  await sql(`INSERT INTO public.research_prompts (job_id, owner_sub, actor_sub, prompt) VALUES ($1, 'service:probe', 'service:probe', 'service probe question')`, [service]);
  await Deno.mkdir(`${VAULT}/content/source`, { recursive: true });
  await Deno.writeTextFile(`${VAULT}/content/source/${bReport}.md`, `---\ntitle: B report\n---\n\n# B report\n\nBReportBody.\n`);
  planted = { bJob, bChild, bReport, bDoc: bd.json.path, aDoc: ad.json.path, ownerless, service };
  console.log(`PROBE plant: bDoc=${bd.json.path} aDoc=${ad.json.path}`);
  return planted;
}
const markers = Object.values(MB);
const leaks = (text: string) => markers.filter((m) => text.includes(m));

t("C1 another user's session coverage: 404, same shape and timing as a session that does not exist", async () => {
  const p = await plantB();
  const ids = { foreign: p.bJob, foreignChild: p.bChild, missing: u(), ownerless: p.ownerless, upper: p.bJob.toUpperCase() };
  const out: Record<string, { status: number; body: string; med: number }> = {};
  for (const [k, id] of Object.entries(ids)) {
    const ms: number[] = [];
    let last = { status: 0, text: "" };
    for (let i = 0; i < 25; i++) { const r = await call("GET", `/workbench/contract/sessions/${id}/coverage`, A); ms.push(r.ms); last = r; assertEquals(leaks(r.text), [], `${k}: ${r.text}`); }
    ms.sort((a, b) => a - b);
    out[k] = { status: last.status, body: last.text, med: Math.round(ms[12] * 10) / 10 };
  }
  for (const [k, v] of Object.entries(out)) console.log(`PROBE C1 ${k}: ${v.status} ${v.body} median ${v.med} ms`);
  const own = await call("GET", `/workbench/contract/sessions/${p.bJob}/coverage`, B);
  console.log(`PROBE C1 B reads own: ${own.status}; anchor=${own.json.anchor === MB.anchor}`);
  const svc = await call("GET", `/workbench/contract/sessions/${p.service}/coverage`, A);
  console.log(`PROBE C1 service-started session as A: ${svc.status} anchor=${JSON.stringify(svc.json.anchor)}`);
  for (const k of ["foreign", "foreignChild", "ownerless", "upper"]) {
    assertEquals(out[k].status, 404, k);
    assertEquals(out[k].body, out.missing.body, `${k}: same error body as a missing session`);
  }
});

t("C2 document coverage: B's document and path/encoding tricks, as A", async () => {
  const p = await plantB();
  const bKey = p.bDoc.split("/")[1], aKey = p.aDoc.split("/")[1], file = p.bDoc.split("/").slice(2).join("/");
  const variants = [
    p.bDoc, `/${p.bDoc}`, `./${p.bDoc}`, p.bDoc.replace(/\//g, "\\"), `documents//${bKey}/${file}`,
    `documents/${aKey}/../${bKey}/${file}`, `documents/${aKey}/%2e%2e/${bKey}/${file}`, `documents/${aKey}/%252e%252e/${bKey}/${file}`,
    `${aKey}/../../documents/${bKey}/${file}`, `../${bKey}/${file}`, `documents/${bKey.toUpperCase()}/${file}`, `DOCUMENTS/${bKey}/${file}`,
    `documents/${bKey}/${file}%00.md`, `documents/${bKey}/${file.replace(/\.md$/, ".MD")}`, `documents/${bKey}/./${file}`,
    `documents/.trash/${bKey}/${file}`, `documents/${bKey}/${file} `, `documents/${bKey}/nonexistent-${rnd()}.md`,
  ];
  const rows: string[] = [];
  for (const v of variants) {
    for (const enc of [encodeURIComponent(v), v.replace(/ /g, "%20")]) {
      const r = await call("GET", `/workbench/contract/documents/coverage?path=${enc}`, A);
      rows.push(`${r.status} ${JSON.stringify(v)} [${enc === v ? "raw" : "enc"}] -> ${r.text.slice(0, 140)}`);
      // 200 is acceptable only as A's OWN (nonexistent) path under A's root, with nothing in it
      assert(r.status === 404 || r.status === 400 || (r.status === 200 && String(r.json.path).startsWith(`documents/${aKey}/`) && !r.json.hubs?.length && !r.json.sessions?.length), `${v}: ${r.status} ${r.text}`);
      assertEquals(leaks(r.text), [], `${v}: ${r.text}`);
    }
  }
  // the same path given twice, the second B's
  const dbl = await call("GET", `/workbench/contract/documents/coverage?path=${encodeURIComponent(p.aDoc)}&path=${encodeURIComponent(p.bDoc)}`, A);
  rows.push(`${dbl.status} path twice (A's then B's) -> ${dbl.text.slice(0, 200)}`);
  const dbl2 = await call("GET", `/workbench/contract/documents/coverage?path=${encodeURIComponent(p.bDoc)}&path=${encodeURIComponent(p.aDoc)}`, A);
  rows.push(`${dbl2.status} path twice (B's then A's) -> ${dbl2.text.slice(0, 200)}`);
  assert(dbl2.status === 404 || dbl2.status === 400 || !dbl2.text.includes(MB.title), dbl2.text);
  for (const r of rows) console.log(`PROBE C2 ${r}`);
  // A's own document coverage: B's child job names A's document as its inlet - not listed, nothing of B's
  const own = await call("GET", `/workbench/contract/documents/coverage?path=${encodeURIComponent(p.aDoc)}`, A);
  console.log(`PROBE C2 A's own doc: ${own.status} sessions=${JSON.stringify((own.json.sessions ?? []).map((s: any) => s.id))} hubs=${(own.json.hubs ?? []).length} leaks=${JSON.stringify(leaks(own.text))}`);
  assertEquals(own.status, 200);
  assert(!(own.json.sessions as any[]).some((s) => s.id === p.bChild), "B's branch naming A's document is not listed to A");
  assertEquals(leaks(own.text), []);
  // the identity seam: X-authentik-* while forward-auth is off; the query naming B
  const ak = await call("GET", `/workbench/contract/documents/coverage?path=${encodeURIComponent(p.bDoc)}`, { ...A, "X-authentik-uid": B[SUB_HEADER], "X-authentik-username": B[SUB_HEADER] });
  console.log(`PROBE C2 X-authentik-* with forward-auth off: ${ak.status} ${ak.text.slice(0, 120)}`);
  assertEquals(leaks(ak.text), []);
  const q = await call("GET", `/workbench/contract/documents/coverage?path=${encodeURIComponent(p.bDoc)}&sub=${B[SUB_HEADER]}&owner_sub=${B[SUB_HEADER]}&user=${B[SUB_HEADER]}`, A);
  console.log(`PROBE C2 query naming B: ${q.status}`);
  assertEquals(q.status, 404);
});

t("C3 the identity seam: raw-target tricks against B's session coverage, as A", async () => {
  const p = await plantB();
  const paths = [
    `/workbench/contract/sessions/${p.bJob}/coverage/`, `/workbench/contract/sessions/${p.bJob}//coverage`, `/workbench/contract//sessions/${p.bJob}/coverage`,
    `/workbench/contract/sessions/${p.bJob}%2Fcoverage`, `/workbench/contract/sessions/${p.bJob}/coverage;x=1`, `/workbench/contract/sessions/${p.bJob};/coverage`,
    `/workbench/contract/sessions/./${p.bJob}/coverage`, `/workbench/contract/sessions/x/../${p.bJob}/coverage`, `/workbench/contract/sessions/x/%2e%2e/${p.bJob}/coverage`,
    `/workbench/contract/sessions/${p.bJob}/coverage?metadata_filter=`, `/workbench/contract/sessions/${p.bJob}/coverage#x`, `/workbench/contract/SESSIONS/${p.bJob}/coverage`,
    `/workbench/contract/sessions/${p.bJob}/Coverage`, `/workbench/contract/reports/${p.bReport}/credibility/`, `/workbench/contract/reports/${p.bReport}%2Fcredibility`,
  ];
  for (const path of paths) {
    const r = await call("GET", path, A);
    console.log(`PROBE C3 ${r.status} ${path.replace(p.bJob, "<bJob>").replace(p.bReport, "<bReport>")} -> ${r.text.slice(0, 100)}`);
    assertEquals(leaks(r.text), [], path);
    if (path.includes("/coverage") || path.includes("/Coverage")) assert(r.status >= 400, `${path}: ${r.status}`);
  }
});

t("R1 the roll-up of B's report: shared, byte-identical for A and B, no private text of B's", async () => {
  const p = await plantB();
  const ra = await call("GET", `/workbench/contract/reports/${p.bReport}/credibility`, A);
  const rb = await call("GET", `/workbench/contract/reports/${p.bReport}/credibility`, B);
  console.log(`PROBE R1 A ${ra.status} / B ${rb.status}; identical=${ra.text === rb.text}; leaks=${JSON.stringify(leaks(ra.text))}; job_id named=${ra.json.job_id === p.bJob}: ${ra.text.slice(0, 300)}`);
  assertEquals(ra.text, rb.text);
  assertEquals(leaks(ra.text), []);
  const ea = await fetch(`${BASE}/workbench/export?path=${encodeURIComponent(`content/source/${p.bReport}.md`)}&format=md&style=ieee`, { headers: { "x-brain-key": KEY, ...A } });
  const eat = await ea.text();
  const eb = await fetch(`${BASE}/workbench/export?path=${encodeURIComponent(`content/source/${p.bReport}.md`)}&format=md&style=ieee`, { headers: { "x-brain-key": KEY, ...B } });
  const ebt = await eb.text();
  console.log(`PROBE R1 export of B's report as A: ${ea.status} section=${eat.includes("Report credibility")} identical-to-B=${eat === ebt} leaks=${JSON.stringify(leaks(eat))}`);
  assertEquals(leaks(eat), []);
  const up = await fetch(`${BASE}/workbench/export?path=${encodeURIComponent(`content/source/${p.bReport.toUpperCase()}.md`)}&format=md&style=ieee`, { headers: { "x-brain-key": KEY, ...A } });
  const upt = await up.text();
  console.log(`PROBE R1 export with the report id upper-cased: ${up.status} section=${upt.includes("Report credibility")} head=${JSON.stringify(upt.slice(0, 120))}`);
});

t("S1 my sweep: every trust read as A over B's planted ids returns none of B's private markers", async () => {
  const p = await plantB();
  const reads = [
    `/workbench/contract/sessions/${p.bJob}/coverage`, `/workbench/contract/sessions/${p.bChild}/coverage`, `/workbench/contract/reports/${p.bReport}/credibility`,
    `/workbench/contract/claims?synthesis_id=${p.bReport}&limit=200`, `/workbench/contract/claims?source_id=${p.bReport}&limit=200`,
    `/workbench/contract/sources/${p.bReport}/quality`, `/workbench/contract/documents/coverage?path=${encodeURIComponent(p.bDoc)}`,
    `/workbench/contract/documents/coverage?path=${encodeURIComponent(p.aDoc)}`,
  ];
  let hits = 0;
  for (const r of reads) {
    const x = await call("GET", r, A);
    const l = leaks(x.text);
    hits += l.length;
    console.log(`PROBE S1 ${x.status} ${r.replace(p.bJob, "<bJob>").replace(p.bChild, "<bChild>").replace(p.bReport, "<bReport>")} hits=${JSON.stringify(l)}`);
  }
  console.log(`PROBE S1 total hits ${hits}`);
  assertEquals(hits, 0);
});
