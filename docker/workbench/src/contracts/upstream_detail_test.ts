// deno test --allow-all src/contracts/upstream_detail_test.ts - rw-identity-harden2 (review r-id-harden B1):
// an upstream service's own `detail` on a 5xx is an exception message; it never reaches a response body or a
// stored reason. Stub upstreams (Deno.serve on a loopback port) answer 500 with a marker that names a path.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { decideReopen, httpScorer } from "./logic/reopen.ts";
import { researchActions } from "../sessions/client.ts";

// the route's answer for a steer the research service did not accept. On a tree without steerFailure (the RED run
// on baa64f6) this is the route's own pre-fix expression, copied from routes/sessions.ts:132-133.
const spec = "./routes/sessions.ts"; // a variable: the RED run on a tree without it still type-checks
const mod = await import(spec) as Record<string, unknown>;
const steerFailure = (typeof mod.steerFailure === "function" ? mod.steerFailure : (r: { status: number; body: Record<string, unknown> }) => ({
  status: [400, 409].includes(r.status) ? r.status : 502,
  error: String(r.body.detail ?? r.body.error ?? `the research service answered ${r.status}`),
})) as (r: { status: number; body: Record<string, unknown> }) => { status: number; error: string };

const MARK = "MARKER-upstream-secret /var/lib/research/x.sql password=hunter2";
const stub = (status: number, body: unknown) => {
  const srv = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, () => Response.json(body, { status }));
  return { url: `http://127.0.0.1:${(srv.addr as Deno.NetAddr).port}`, close: () => srv.shutdown() };
};
const quiet = async (f: () => Promise<void>) => {
  const w = console.warn, e = console.error;
  console.warn = () => {};
  console.error = () => {};
  try { await f(); } finally { console.warn = w; console.error = e; }
};

Deno.test("B1 steer: a research-service 5xx is answered 502 with a fixed text, never its detail", async () => {
  await quiet(async () => {
    for (const status of [500, 502, 503]) {
      const up = stub(status, { error: "steer_failed", detail: MARK });
      try {
        const acts = researchActions((k) => ({ RESEARCH_URL: up.url, RESEARCH_WORKSPACE_KEY: "k" } as Record<string, string>)[k])!;
        const r = await acts.steer("00000000-0000-4000-8000-000000000001", { step_id: "s", text: "t" }, { sub: "a", actor: "a", admin: false });
        assertEquals(r.status, status);
        const f = steerFailure(r);
        assertEquals(f.status, 502);
        assert(!JSON.stringify(f).includes("MARKER") && !f.error.includes("/var/lib"), `the 502 body carries the upstream detail: ${f.error}`);
      } finally {
        await up.close();
      }
    }
    // a typed refusal (SteerError 409) keeps its own text: the user can act on it
    assertEquals(steerFailure({ status: 409, body: { error: "x", detail: "that step is already steered" } }), { status: 409, error: "that step is already steered" });
  });
});

Deno.test("B1 reopen: the D15 scorer's 5xx detail is neither in the score's reason nor in the stored decision reason", async () => {
  await quiet(async () => {
    const up = stub(500, { error: "score_failed", detail: MARK });
    try {
      const score = await httpScorer(up.url, "k").score({ url: "https://e.org/a", title: "t", content: "c", content_type: "web" });
      assertEquals(score.available, false);
      assert(!score.reason.includes("MARKER") && !score.reason.includes("/var/lib"), `score reason: ${score.reason}`);
      const d = decideReopen({ path: "rescore_contest", gate: "auto", tombstone: { confidence: null, score_version: null, fingerprint: null }, score, candidateFingerprint: null });
      assertEquals(d.outcome, "refused");
      assert(!JSON.stringify(d).includes("MARKER") && !d.reason.includes("password"), `the stored reason: ${d.reason}`);
    } finally {
      await up.close();
    }
    // the typed 422 gate refusal names the claim kind and is kept
    const gate = stub(422, { error: "credibility_gate", detail: "no weight row for claim kind 'x'" });
    try {
      const score = await httpScorer(gate.url, "k").score({ url: "https://e.org/a", title: "t", content: "c", content_type: "web" });
      assert(score.reason.includes("claim kind 'x'"), score.reason);
    } finally {
      await gate.close();
    }
  });
});
