/**
 * rw-boundary-core round 2 (tester TF2): every function slot 420 creates or replaces, and the hand-back table, called
 * through a REAL PostgREST configured as compose (anon role = service_role), with no token - the way any container on
 * obnet or the loopback rest port reaches it. Prints one line per call (status, rows, whether a private marker came
 * back - never content) and exits non-zero if any 420 object answered 2xx.
 *   deno run --allow-net --allow-env fixtures/boundary-pgrst-probe.ts   (PGRST_PROBE_URL, PGRST_PROBE_MARKER)
 */
const BASE = (Deno.env.get("PGRST_PROBE_URL") ?? "").replace(/\/+$/, "");
const MARK = (Deno.env.get("PGRST_PROBE_MARKER") ?? "zq").toLowerCase();
const calls: Array<[string, string, unknown, boolean]> = [
  // [method, path, body, is a 420 object (must be refused)]
  ["GET", "/research_handbacks?select=*", undefined, true],
  ["POST", "/rpc/handback_owned", { p_owner_sub: "f3b2c1d0-sub-dana" }, true],
  ["POST", "/rpc/handback_pending", { p_purpose: "idea-research" }, true],
  ["POST", "/rpc/handback_deliverables", { p_purpose: "digest-article" }, true],
  ["POST", "/rpc/handback_delivered", { p_id: "00000000-0000-4000-8000-000000000001" }, true],
  ["POST", "/rpc/handback_claim", { p_id: "00000000-0000-4000-8000-000000000001", p_job_id: null, p_state: "refused", p_verdict: null, p_owner_view: null }, true],
  ["POST", "/rpc/handback_open", { p_owner_sub: "x", p_inlet_kind: "idea", p_inlet_id: "x", p_inlet_revision: null, p_purpose: "idea-research", p_job_id: null, p_state: "refused", p_verdict: null, p_owner_view: null, p_deliver: null }, true],
  ["POST", "/rpc/request_boundary_options_ok", { p_options: {}, p_root: true }, true],
  ["POST", "/rpc/request_boundary_stamp_ok", { p_boundary: {} }, true],
  ["POST", "/rpc/trg_research_jobs_boundary", {}, true],
  ["POST", "/rpc/trg_research_prompts_boundary", {}, true],
  ["GET", "/research_request_boundary_saved?select=*", undefined, true],
  // replaced, not created, by 420 - reported, judged separately (slot 390 / 230 set their grants)
  ["POST", "/rpc/trg_idea_revisions_inlet", {}, true],
  ["POST", "/rpc/research_job_report_owner", { p_job: "00000000-0000-4000-8000-000000000001" }, false],
];
let bad = 0;
for (const [m, p, b, must] of calls) {
  const r = await fetch(BASE + p, { method: m, headers: { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
  const t = await r.text();
  const ok2xx = r.status >= 200 && r.status < 300;
  if (must && ok2xx) bad++;
  console.log(`PGRST ${m} ${p} -> ${r.status} ${ok2xx ? "ANSWERED" : "refused"}; private marker in the body: ${t.toLowerCase().includes(MARK)}${must ? "" : " (a slot-390 function: reported, not judged here)"}`);
}
console.log(`PGRST summary: ${bad} slot-420 object(s) answered`);
Deno.exit(bad ? 1 : 0);
