// rw-boundary-ideas (plan 09 PD0b, D7): the owner's review of an idea's research question, over a fake database and a
// fake research service (the real ones: OB1/integrations/research-service/boundary-ideas.e2e.test.ts, in its lab).
// What is pinned here: every read and decision is for the identity seam's subject only (a caller-supplied user is
// ignored; another owner's idea answers exactly like none: 404); the review (candidate, failing tokens) is shown only
// while the hand-back waits for its owner; "approve" goes to the research service under the workspace's key naming the
// seam's subject; "run privately" is ONE idea_handback_run_private() call; neither works on a review that no longer waits.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import type { Db } from "../contracts/db.ts";
import { ideasRouter } from "./routes.ts";
import { approveClient, type ApproveCall, parseQuestion } from "./review.ts";
import { IdeaError } from "./repo.ts";

const ID = "a1000000-0000-4000-8000-0000000000a1";
const HB = "b2000000-0000-4000-8000-0000000000b2";

function fakeDb(state: string | null, own = true) {
  const seen: { sql: string; args: unknown[] }[] = [];
  const db: Db = {
    query: (sql: string, args: unknown[] = []) => {
      seen.push({ sql, args });
      if (/FROM public\.ideas WHERE id = \$1::uuid AND owner_sub = \$2/.test(sql)) return Promise.resolve(own ? [{ id: ID }] : [] as never);
      if (/idea_handback_review\(/.test(sql)) {
        return Promise.resolve(state === null ? [] : [{
          handback_id: HB, revision: 2, state, refusal: "no_candidate_passed", candidate: state === "awaiting_owner" ? "What is zqTITm4be19c0a about?" : null,
          failing: state === "awaiting_owner" ? ["zqtitm4be19c0a"] : null, code: "token_not_allowed", job_id: null, created_at: "t", updated_at: "t",
        }] as never);
      }
      if (/idea_handback_run_private\(/.test(sql)) return Promise.resolve([{ j: "c3000000-0000-4000-8000-0000000000c3" }] as never);
      return Promise.resolve([] as never);
    },
    tx: (fn: (d: Db) => Promise<unknown>) => fn(db),
  } as never;
  return { db, seen };
}

function fakeApprove(status = 202, body: Record<string, unknown> = { job_id: "d4000000-0000-4000-8000-0000000000d4" }) {
  const calls: Array<{ hb: string; q: string; sub: string }> = [];
  const call: ApproveCall = (hb, q, who) => { calls.push({ hb, q, sub: who.sub }); return Promise.resolve({ status, body }); };
  return { call, calls };
}

const json = (b: unknown) => ({ method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json", "X-Who": "evil" } });
const app = (db: Db, approve: ApproveCall | null = null) => new Hono().route("/i", ideasRouter({ db, embed: () => Promise.resolve([0.1]), approve }));

Deno.test("rw-boundary-ideas: the research state - the review only while it waits for the owner; none; another owner's idea 404", async () => {
  const w = fakeDb("awaiting_owner");
  const r = await (await app(w.db).request(`/i/${ID}/research`)).json();
  assertEquals([r.state, r.review.candidate, r.review.failing], ["awaiting_owner", "What is zqTITm4be19c0a about?", ["zqtitm4be19c0a"]]);
  const call = w.seen.find((s) => /idea_handback_review\(/.test(s.sql))!;
  assertEquals(call.args[1], ID);
  assert(typeof call.args[0] === "string" && call.args[0] !== "evil", "the seam's subject, never a header's word");
  const q = await (await app(fakeDb("queued").db).request(`/i/${ID}/research`)).json();
  assertEquals([q.state, q.review], ["queued", null]);
  assertEquals((await (await app(fakeDb(null).db).request(`/i/${ID}/research`)).json()).state, "none");
  assertEquals((await app(fakeDb("awaiting_owner", false).db).request(`/i/${ID}/research`)).status, 404);
});

Deno.test("rw-boundary-ideas: approve sends the hand-back and the question to the research service for the seam's subject", async () => {
  const w = fakeDb("awaiting_owner");
  const a = fakeApprove();
  const r = await app(w.db, a.call).request(`/i/${ID}/research/approve`, json({ question: "  Which roof designs suit a cold cabin?  ", owner_sub: "someone-else" }));
  assertEquals(r.status, 202);
  assertEquals((await r.json()).run, "derived");
  assertEquals(a.calls.length, 1);
  assertEquals([a.calls[0].hb, a.calls[0].q], [HB, "Which roof designs suit a cold cabin?"]);
  assert(a.calls[0].sub !== "someone-else" && a.calls[0].sub !== "evil");
  // the research service refused the owner's question (identity / ids): 200 with the failing tokens, nothing queued
  const refused = await app(fakeDb("awaiting_owner").db, fakeApprove(200, { refused: "identity_token", failing: ["quillfeather"] }).call)
    .request(`/i/${ID}/research/approve`, json({ question: "Is Quillfeather a baker?" }));
  assertEquals([refused.status, (await refused.json()).failing], [200, ["quillfeather"]]);
});

Deno.test("rw-boundary-ideas: approve / run privately refuse a review that no longer waits (409), another owner's idea (404), no question (400)", async () => {
  const a = fakeApprove();
  assertEquals((await app(fakeDb("queued").db, a.call).request(`/i/${ID}/research/approve`, json({ question: "Which roofs?" }))).status, 409);
  assertEquals((await app(fakeDb("queued").db).request(`/i/${ID}/research/private`, json({ question: "Which roofs?" }))).status, 409);
  assertEquals((await app(fakeDb("awaiting_owner", false).db, a.call).request(`/i/${ID}/research/approve`, json({ question: "Which roofs?" }))).status, 404);
  assertEquals((await app(fakeDb("awaiting_owner").db, a.call).request(`/i/${ID}/research/approve`, json({}))).status, 400);
  assertEquals(a.calls.length, 0, "nothing reached the research service");
  // shipped inert: no research service configured -> a named refusal, nothing called
  assertEquals((await app(fakeDb("awaiting_owner").db, null).request(`/i/${ID}/research/approve`, json({ question: "Which roofs?" }))).status, 502);
});

Deno.test("rw-boundary-ideas: run privately is ONE idea_handback_run_private() call for the seam's subject", async () => {
  const w = fakeDb("awaiting_owner");
  const r = await app(w.db).request(`/i/${ID}/research/private`, json({ question: "my own words, run privately" }));
  assertEquals(r.status, 202);
  const b = await r.json();
  assertEquals([b.run, b.job_id], ["private", "c3000000-0000-4000-8000-0000000000c3"]);
  const calls = w.seen.filter((s) => /idea_handback_run_private\(/.test(s.sql));
  assertEquals(calls.length, 1);
  assertEquals([calls[0].args[2], calls[0].args[3]], [HB, "my own words, run privately"]);
  assert(!w.seen.some((s) => /research_handbacks|INSERT INTO public\.research_jobs/.test(s.sql)), "no direct read or write of the hand-back or the jobs");
});

Deno.test("rw-boundary-ideas: the approval client - inert without RESEARCH_URL / RESEARCH_WORKSPACE_KEY; the key and the subject ride; another service's error text is not handed on", async () => {
  assertEquals(approveClient(() => undefined), null);
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const f = ((url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    return Promise.resolve(new Response(JSON.stringify({ error: "a stack trace" }), { status: 500 }));
  }) as unknown as typeof fetch;
  const call = approveClient((k) => ({ RESEARCH_URL: "http://research:8000/", RESEARCH_WORKSPACE_KEY: "wk" } as Record<string, string>)[k], f)!;
  const o = await call(HB, "Which roofs?", { sub: "user-a", actor: "user-a", name: "A", key: "user-a" });
  assertEquals(seen[0].url, "http://research:8000/research/derived/approve");
  assertEquals([seen[0].headers["x-brain-key"], seen[0].headers["x-on-behalf-of"]], ["wk", "user-a"]);
  assertEquals(JSON.parse(seen[0].body), { handback_id: HB, question: "Which roofs?" });
  assertEquals([o.status, o.body.error], [502, "upstream_error"]);
  try { parseQuestion({ question: "x".repeat(2001) }); assert(false); } catch (e) { assertEquals((e as IdeaError).status, 400); }
});
