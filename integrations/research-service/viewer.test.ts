// deno test viewer.test.ts - rw-identity round 2: whose jobs a read shows, and the prompt omission.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { callerFor, parseCallers } from "./origin.ts";
import { omitPrompts, readViewer, sharedEvents, sharedJobView, sharedTree } from "./viewer.ts";

const OWUI = "owui-key-0123456789abcdef";
const AO = "agent-org-key-0123456789ab";
const WS = "ws-key-0123456789abcdef";
const SHARED = "shared-mcp-key-0123456789";
const callers = parseCallers(`owui-tool=owui:${OWUI};agent-org=mattermost:${AO};workspace=workspace:${WS}`, SHARED, "manual");
const by = (k: string) => callerFor(k, callers)!;

Deno.test("readViewer: OWUI and the workspace may read for a user; every other key reads as its service; naming a user from one is 403", () => {
  assertEquals(readViewer(by(OWUI), "ak-alice"), { sub: "ak-alice" });
  assertEquals(readViewer(by(WS), " ak-bob "), { sub: "ak-bob" });
  assertEquals(readViewer(by(OWUI), null), { sub: "service:owui-tool" });
  assertEquals(readViewer(by(AO), ""), { sub: "service:agent-org" });
  assertEquals(readViewer(by(SHARED), null), { sub: "service:shared-key" });
  for (const k of [AO, SHARED]) assertEquals((readViewer(by(k), "ak-alice") as { status: number }).status, 403);
  assertEquals((readViewer(by(OWUI), "service:internal") as { status: number }).status, 400);
});

Deno.test("omitPrompts: every string carrying the prompt (or its 40-char head) is dropped at any depth; the rest is kept", () => {
  const p = "CrossUserPrompt0123 how do tidal locks form in binary systems";
  const job = {
    id: "j", status: "done", progress: { phase: "plan", message: `planning ${p}` },
    result: { query: p, synthesis: "Tidal locking happens when...", sources: [{ title: `about ${p}`, url: "https://x" }, { title: "other", url: "https://y" }] },
    error: `failed on ${p.slice(0, 40)}...`, tags: [p, "kept"],
  };
  assertEquals(omitPrompts(job as Record<string, unknown>, [p]), {
    id: "j", status: "done", progress: { phase: "plan" },
    result: { synthesis: "Tidal locking happens when...", sources: [{ url: "https://x" }, { title: "other", url: "https://y" }] },
    tags: ["kept"],
  });
  assertEquals(omitPrompts(job, []), job);
});

// round 4 (tester attempt 1, Case 7): ALLOW-LIST - a non-owner gets the shared research output only
Deno.test("sharedJobView: only status, the grounded report, its claims and sources - nothing else, at any depth", () => {
  const tok = "Zq0123456789";
  const job = {
    id: "j", status: "done", queue_position: null, queue_depth: 0, eta_seconds: null, error: `failed on ${tok}`,
    progress: { phase: "done", message: tok }, metrics: { note: tok },
    result: {
      outcome: "complete", report_type: "explainer", synthesis: "Offers can be countered [Source 1].",
      cited_sources: [{ title: "Settlement basics", url: "https://example.org/s", note: tok }],
      reuse_claims: [{ id: "c1", text: "Offers can be countered.", source: tok }],
      prose: `# No sources about My lawyer ${tok}`, rendered: tok, needs: [tok], followup_queries: [tok], gaps: [tok],
      search_record: { queries: [tok] }, report: tok, sources: [{ title: tok }], thread_id: tok, contract: { q: tok },
    },
  };
  const v = sharedJobView(job);
  assertEquals(v, {
    id: "j", status: "done", queue_position: null, queue_depth: 0, eta_seconds: null,
    result: {
      outcome: "complete", report_type: "explainer", synthesis: "Offers can be countered [Source 1].",
      cited_sources: [{ title: "Settlement basics", url: "https://example.org/s" }],
      reuse_claims: [{ id: "c1", text: "Offers can be countered." }],
    },
  });
  assert(!JSON.stringify(v).includes(tok));
  // a run that found nothing has no report to share (its notice is built from the question)
  const failed = sharedJobView({ ...job, result: { ...job.result, outcome: "no_relevant_sources", synthesis: `about ${tok}` } });
  assert(!JSON.stringify(failed).includes(tok));
  assertEquals(sharedJobView({ id: "q", status: "queued", result: null }).result, null);
});

Deno.test("sharedTree / sharedEvents: ids, kinds, status and time only", () => {
  const tok = "Zq9876543210";
  const t = sharedTree({ root_job_id: "r", topic_estimate: tok, origin: tok,
    branches: [{ id: "b", parent_job_id: "r", branch_kind: "steer", rooted_step_id: "s1", anchor: tok, query: tok, status: "done" }],
    steers: [{ text: tok }], report: tok, learning_records: [tok] });
  assertEquals(t, { root_job_id: "r", branches: [{ id: "b", parent_job_id: "r", branch_kind: "steer", rooted_step_id: "s1", status: "done" }] });
  const e = sharedEvents([{ id: "1", job_id: "j", root_job_id: "r", step_id: "s1", type: "stage", kind: "due_process", trail: { q: tok }, payload: { note: tok }, created_at: "t" }]);
  assertEquals(e, [{ id: "1", job_id: "j", root_job_id: "r", step_id: "s1", type: "stage", kind: "due_process", created_at: "t" }]);
});
