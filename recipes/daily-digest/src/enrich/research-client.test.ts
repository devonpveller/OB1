// research-client tests (mr-research-failfast, 2026-10-13).
//
// WHY: on 2026-10-13 link-enrich gave up on research jobs after its deadline but
// never told the engine, so every abandoned job kept its FIFO place and ran
// ~77 minutes for nobody. waitForDone now CANCELS its job at its own deadline,
// submitDerived() (rw-boundary-digest; was submit()) carries the caller's deadline to the engine, and a deadline error says
// whether the model was down - the signal mr-routine-outage acts on.
//
// The real ResearchClient against a real stub research-service over HTTP. The
// end-to-end version against the real engine is
// OB1/integrations/research-service/failfast.e2e.test.ts (E3).
//
// Run: deno test --allow-net src/enrich/research-client.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { isModelDown, type JobRecord, ResearchClient, ResearchDeadlineError, waitForAll } from "./research-client.ts";

const ID = "11111111-2222-3333-4444-555555555555";

function stubEngine(job: (n: number, cancelSeen: boolean) => Partial<JobRecord>, cancelAnswer = "cancelled") {
  const seen: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  let polls = 0;
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, async (req) => {
    const path = new URL(req.url).pathname;
    const body = req.method === "POST" ? await req.json().catch(() => null) : null;
    seen.push({ method: req.method, path, body });
    if (req.method === "POST" && path === "/research/derived") {
      // rw-boundary-digest: the door answers a job or a refusal
      if ((body as { item?: { id?: string } } | null)?.item?.id === "refuse-me") return Response.json({ refused: "no_candidate_passed", handback_id: "h1" });
      return Response.json({ job_id: ID, status: "queued" }, { status: 202 });
    }
    if (req.method === "POST" && path === "/research/derived/delivered") {
      return Response.json({ delivered: ((body as { deliveries?: unknown[] } | null)?.deliveries ?? []).length });
    }
    if (req.method === "POST" && path.endsWith("/cancel")) {
      if (cancelAnswer === "filing") return Response.json({ job_id: ID, status: "running", filing: true }, { status: 409 });
      return Response.json({ job_id: ID, status: cancelAnswer });
    }
    const cancelSeen = seen.some((s) => s.path.endsWith("/cancel"));
    return Response.json({ id: ID, status: "queued", ...job(++polls, cancelSeen) });
  });
  return {
    client: new ResearchClient({ baseUrl: `http://127.0.0.1:${server.addr.port}`, brainKey: "k" }),
    seen,
    cancels: () => seen.filter((s) => s.path.endsWith("/cancel")),
    async close() { ac.abort(); await server.finished; },
  };
}

Deno.test("waitForDone CANCELS its job when its own deadline passes, and says so", async () => {
  const e = stubEngine(() => ({ status: "queued" }));
  try {
    const err = await assertRejects(() => e.client.waitForDone(ID, { timeoutMs: 300, intervalMs: 50 }), ResearchDeadlineError);
    assertEquals(e.cancels().length, 1, "exactly one cancel");
    assertEquals(e.cancels()[0].path, `/research/jobs/${ID}/cancel`);
    assert(err.cancelled && !err.modelDown);
    assert(/did not complete within deadline/.test(err.message), "message keeps the old prefix for log readers");
  } finally { await e.close(); }
});

Deno.test("cancelOnTimeout:false (gap dives carry their job over) never cancels", async () => {
  const e = stubEngine(() => ({ status: "running" }));
  try {
    const err = await assertRejects(() => e.client.waitForDone(ID, { timeoutMs: 200, intervalMs: 50, cancelOnTimeout: false }), ResearchDeadlineError);
    assertEquals(e.cancels().length, 0);
    assertEquals(err.cancelled, false);
    const out = await waitForAll(e.client, [ID], { timeoutMs: 150, intervalMs: 50, cancelOnTimeout: false });
    assertEquals(out.get(ID)?.ok, false);
    assertEquals(e.cancels().length, 0);
  } finally { await e.close(); }
});

Deno.test("a job paused for model_down: the deadline error carries modelDown", async () => {
  const e = stubEngine(() => ({
    status: "queued",
    progress: { phase: "model_down", code: "model_down", message: "paused" },
    model: { state: "down", since: "2026-10-13T05:03:00.000Z", reason: "chat 502: name resolution" },
  }));
  try {
    const err = await assertRejects(() => e.client.waitForDone(ID, { timeoutMs: 200, intervalMs: 50 }), ResearchDeadlineError);
    assert(err.modelDown, err.message);
    assert(/model_down/.test(err.message));
  } finally { await e.close(); }
});

Deno.test("the job finished between the last poll and the cancel: its result is returned, not thrown away", async () => {
  // Running on every poll until the cancel arrives; the engine answers the cancel
  // with "done" (it finished in the gap), so only the post-cancel poll sees done.
  const e = stubEngine((_n, cancelSeen) => (cancelSeen ? { status: "done", result: { synthesis: "[SOURCED] x [Source 1]" } } : { status: "running" }), "done");
  try {
    const job = await e.client.waitForDone(ID, { timeoutMs: 120, intervalMs: 50 });
    assertEquals(job.status, "done");
    assertEquals(e.cancels().length, 1, "reached through the cancel path");
  } finally { await e.close(); }
});

const ITEM = { kind: "gmail" as const, id: "g1:abc", owner_sub: "operator", fields: { subject: "s" }, links: ["https://example.org/a"] };

Deno.test("submitDerived carries the caller deadline as ISO run.deadline_at; omitted when not given", async () => {
  const e = stubEngine(() => ({ status: "done" }));
  try {
    const at = Date.UTC(2026, 9, 13, 12);
    await e.client.submitDerived({ item: ITEM, purpose: "digest-article", deliver: {}, mode: "article", gapResearch: "preliminary", deadlineAt: at });
    await e.client.submitDerived({ item: ITEM, purpose: "digest-gap", deliver: {} });
    const posts = e.seen.filter((s) => s.path === "/research/derived");
    assertEquals(posts[0].body?.run, { mode: "article", gap_research: "preliminary", deadline_at: "2026-10-13T12:00:00.000Z" });
    assertEquals(posts[1].body?.run, {});
  } finally { await e.close(); }
});

Deno.test("rw-boundary-digest: submitDerived sends no query, seed content or thread id - and a refusal is an answer, not an error", async () => {
  const e = stubEngine(() => ({ status: "done" }));
  try {
    assertEquals(await e.client.submitDerived({ item: ITEM, purpose: "digest-article", deliver: { gmail_id: "g1" }, dryRun: true }), { jobId: ID });
    const body = e.seen.find((s) => s.path === "/research/derived")!.body!;
    assertEquals(Object.keys(body).sort(), ["deliver", "item", "purpose", "run"]);
    assertEquals(body.run, { dry_run: true });
    assertEquals(await e.client.submitDerived({ item: { ...ITEM, id: "refuse-me" }, purpose: "digest-gap", deliver: {} }), { refused: "no_candidate_passed", handbackId: "h1" });
    assertEquals(await e.client.delivered([{ jobId: ID, ok: true, episodeId: ID, threadId: null }, { jobId: ID, ok: false }]), 2);
    const d = e.seen.find((s) => s.path === "/research/derived/delivered")!.body!;
    assertEquals(d.deliveries, [{ job_id: ID, ok: true, episode_id: ID }, { job_id: ID, ok: false }]);
    assertEquals(e.seen.filter((s) => s.path === "/research").length, 0, "never the old door");
  } finally { await e.close(); }
});

Deno.test("isModelDown: the one predicate over every shape of the signal", () => {
  assertEquals(isModelDown(null), false);
  assertEquals(isModelDown({ progress: { phase: "synthesize" }, model: { state: "up" } }), false);
  assertEquals(isModelDown({ progress: { code: "model_down" } }), true); // paused
  assertEquals(isModelDown({ model: { state: "down" } }), true); // engine latch
  assertEquals(isModelDown({ error: "model_down: chat 502: ..." }), true); // gave up
  assertEquals(isModelDown({ progress: { code: "deadline", model_down: true } }), true); // cancelled while paused
  assertEquals(isModelDown({ progress: { code: "deadline", model_down: false } }), false);
});

Deno.test("a RUNNING job: 'cancelling' is confirmed by polling - cancelled only when the engine says cancelled", async () => {
  const e = stubEngine((_n, cancelSeen) => (cancelSeen ? { status: "cancelled", error: "cancelled: caller deadline passed" } : { status: "running" }), "cancelling");
  try {
    const err = await assertRejects(() => e.client.waitForDone(ID, { timeoutMs: 150, intervalMs: 50 }), ResearchDeadlineError);
    assert(err.cancelled, "confirmed cancelled");
  } finally { await e.close(); }
});

Deno.test("'cancelling' that is never confirmed is NOT reported as cancelled", async () => {
  const e = stubEngine(() => ({ status: "running" }), "cancelling");
  try {
    const err = await assertRejects(() => e.client.waitForDone(ID, { timeoutMs: 100, intervalMs: 40, cancelSettleMs: 200 }), ResearchDeadlineError);
    assertEquals(err.cancelled, false);
    assert(/NOT cancelled/.test(err.message));
  } finally { await e.close(); }
});

Deno.test("a job already FILING (engine answers 409) is awaited and its real 'done' record returned, not thrown away", async () => {
  let polls = 0;
  const e = stubEngine((_n, cancelSeen) => {
    if (!cancelSeen) return { status: "running" };
    return ++polls < 3 ? { status: "running" } : { status: "done", result: { synthesis: "[SOURCED] x [Source 1]" } };
  }, "filing");
  try {
    const job = await e.client.waitForDone(ID, { timeoutMs: 120, intervalMs: 40 });
    assertEquals(job.status, "done");
    assertEquals(e.cancels().length, 1);
  } finally { await e.close(); }
});

Deno.test("deadlineAt that looks like epoch SECONDS is refused before anything is sent", async () => {
  const e = stubEngine(() => ({ status: "done" }));
  try {
    await assertRejects(() => e.client.submitDerived({ item: ITEM, purpose: "digest-article", deliver: {}, deadlineAt: Math.floor(Date.now() / 1000) + 3600 }), Error, "SECONDS");
    assertEquals(e.seen.filter((s) => s.path.startsWith("/research")).length, 0);
  } finally { await e.close(); }
});
