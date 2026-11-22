// rwr-research-start-api (workbench half): POST /workbench/research and /research/preview over fakes - a database
// that records every statement, and the research service's door that records every call. No network, no real DB.
//   deno test --allow-all src/contracts/research_start_test.ts
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import type { Context } from "hono";
import type { Db } from "./db.ts";
import { newApp } from "./routes/http.ts";
import { registerResearchStart } from "./routes/research_start.ts";
import { type DoorAnswer, type DoorClient } from "./repo/research_start.ts";
import type { Identity } from "../middleware/identity.ts";
import { buildItem, extractLinks, IDEA_REFUSED, parseStart } from "./logic/research_start.ts";
import { BadRequest } from "./logic/scope.ts";

const A = "sub-alice-0001", B = "sub-bob-0002";
const IDEA_A = "8b0c4f5e-1d2a-4b3c-9e8f-7a6b5c4d3e2f";
const IDEA_NONE = "9c1d5a6f-2e3b-4c4d-8f9a-8b7c6d5e4f3a";
const DOC_A = "documents/alice/notes.md";
const M = { Q: "zqQUESTm11aa22bb", DOC: "zqDOCTXTm33cc44dd", TIT: "zqIDEATITm55ee66ff", SUM: "zqIDEASUMm77aa88bb", PAS: "zqPASSm99cc00dd", PATH: "zqPATHm12ab34cd" };

function who(sub: string): Identity {
  return { sub, actor: sub, name: sub, key: sub, kind: "header" };
}

function rig(opts: { door?: DoorClient | null; previewBody?: Record<string, unknown>; startAnswer?: DoorAnswer } = {}) {
  const sql: string[] = [];
  const calls: Array<{ op: "preview" | "start"; body: Record<string, unknown> }> = [];
  const db: Db = {
    query: (text: string, args: unknown[] = []) => {
      sql.push(text);
      if (/FROM public\.ideas WHERE id/.test(text)) {
        return Promise.resolve(args[0] === IDEA_A && args[1] === A ? [{ id: IDEA_A, title: `${M.TIT} cabin`, summary: `${M.SUM} the plan`, current_revision: 3 }] : []) as never;
      }
      return Promise.resolve([]) as never;
    },
    tx: (fn) => fn(db),
  };
  const SHOWN = { ok: true, question: "What is known about heat pumps and winter bills?", topic: "heat pumps winter bills", links: ["https://news.example.org/hp"],
    depth: { name: "deep", budget: { rounds: 3, max_fetch: 80, wall_ms: 900000 } } };
  const door: DoorClient = {
    preview: (b) => { calls.push({ op: "preview", body: b }); return Promise.resolve({ status: 200, body: opts.previewBody ?? SHOWN }); },
    start: (b) => { calls.push({ op: "start", body: b }); return Promise.resolve(opts.startAnswer ?? { status: 202, body: { job_id: "d0d0d0d0-0000-4000-8000-0000000000aa", status: "queued", ...SHOWN } }); },
  };
  const app = newApp();
  registerResearchStart(app, { db } as never, {
    door: opts.door === undefined ? door : opts.door,
    readDoc: (path, id) => {
      if (id.sub === A && path === DOC_A) return Promise.resolve({ path: DOC_A, content: `# Cabin notes\n${M.DOC} heat pump ideas, see https://news.example.org/hp` });
      return Promise.resolve(null); // another user's or a missing one (the injected reader answers null)
    },
    identity: (c: Context) => Promise.resolve(who(c.req.header("x-test-sub") ?? A)),
    newId: () => "start-id-1",
  });
  const post = (path: string, body: unknown, sub = A) => app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-test-sub": sub }, body: JSON.stringify(body) });
  return { app, post, sql, calls };
}
const writes = (sql: string[]) => sql.filter((s) => /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)/i.test(s));

Deno.test("preview creates no job, no row, and never calls the start door (asserted)", async () => {
  const r = rig();
  const res = await r.post("/workbench/research/preview", { attach: { kind: "document", path: DOC_A }, question: `${M.Q} should I?`, depth: "deep" });
  assertEquals(res.status, 200);
  const j = await res.json();
  assertEquals(j.ok, true);
  assertEquals(j.question, "What is known about heat pumps and winter bills?");
  assertEquals(j.links, ["https://news.example.org/hp"]);
  assertEquals(j.depth, { name: "deep", rounds: 3, max_fetch: 80, wall_ms: 900000 });
  assertEquals(r.calls.map((c) => c.op), ["preview"], "the start door was never called");
  assertEquals(writes(r.sql), [], "no INSERT / UPDATE / DELETE of any kind");
});

Deno.test("the preview and the start hand the boundary the SAME item, purpose and run", async () => {
  const r = rig();
  // round 2: was an idea attach - an idea is refused now (below); the same equality is asserted over a document
  const body = { attach: { kind: "document", path: DOC_A }, question: `${M.Q} cabin`, depth: "quick", passages: [`${M.PAS} line`] };
  await r.post("/workbench/research/preview", body);
  await r.post("/workbench/research", body);
  assertEquals(r.calls.map((c) => c.op), ["preview", "start"]);
  assertEquals(r.calls[0].body, r.calls[1].body, "one builder, byte-equal door bodies");
  assertEquals(r.calls[0].body.purpose, "user-start");
  assertEquals((r.calls[0].body.run as { depth: string }).depth, "quick");
});

Deno.test("a planted marker in the question, document, idea and passages never leaves the item's own fields", async () => {
  const r = rig();
  const answers: string[] = [];
  for (const body of [
    { attach: { kind: "document", path: DOC_A }, question: `${M.Q} q`, passages: [`${M.PAS} p`] },
    { attach: { kind: "idea", id: IDEA_A }, question: `${M.Q} q`, passages: [`${M.PAS} p`] },
    { attach: { kind: "none" }, question: `${M.Q} q` },
  ]) {
    for (const path of ["/workbench/research/preview", "/workbench/research"]) answers.push(await (await r.post(path, body)).text());
  }
  for (const m of Object.values(M)) for (const a of answers) assertFalse(a.includes(m), `a marker is in an answer: ${m}`);
  for (const c of r.calls) {
    const { item, ...rest } = c.body as { item: { fields: Record<string, string> } };
    for (const m of Object.values(M)) assertFalse(JSON.stringify(rest).includes(m), `a marker is outside the item: ${m}`);
    assert(item.fields.question.includes(M.Q), "the question is in the item's fields (the boundary's input)");
  }
  assertEquals(writes(r.sql), [], "this item writes nothing of its own");
});

Deno.test("attach to nothing: a chat item with no document or idea link", async () => {
  const r = rig();
  await r.post("/workbench/research", { question: "what about heat pumps?" });
  const item = r.calls[0].body.item as { kind: string; id: string; fields: Record<string, string> };
  assertEquals(item.kind, "chat");
  assertEquals(Object.keys(item.fields), ["question"]);
  assertFalse(/documents\/|idea/.test(JSON.stringify(item)), "no document or idea reference");
});

Deno.test("depth: standard by default, quick | standard | deep only, passed as a name (the service resolves the ceilings)", async () => {
  const r = rig();
  await r.post("/workbench/research", { question: "q" });
  assertEquals((r.calls[0].body.run as { depth: string }).depth, "standard");
  for (const bad of ["max", "DEEP", 3, { rounds: 99 }]) assertEquals((await r.post("/workbench/research", { question: "q", depth: bad })).status, 400, JSON.stringify(bad));
  assertEquals(r.calls.length, 1, "a refused depth reaches no door");
});

Deno.test("the identity is the seam's: an owner or user field in the body is refused, the item carries the seam's subject", async () => {
  const r = rig();
  for (const extra of [{ owner_sub: B }, { user: B }, { subject: B }, { deliver: {} }]) {
    assertEquals((await r.post("/workbench/research", { question: "q", ...extra })).status, 400);
  }
  await r.post("/workbench/research", { question: "q" }, B);
  assertEquals((r.calls[0].body.item as { owner_sub: string }).owner_sub, B);
});

Deno.test("two identities: B attaching A's document gets the same 404 as a missing one; any idea attach is the same 400; nothing reaches the door", async () => {
  const r = rig();
  const missingDoc = await r.post("/workbench/research/preview", { attach: { kind: "document", path: "documents/alice/none.md" }, question: "q" }, B);
  const foreignDoc = await r.post("/workbench/research/preview", { attach: { kind: "document", path: DOC_A }, question: "q" }, B);
  assertEquals([missingDoc.status, foreignDoc.status], [404, 404]);
  assertEquals(await foreignDoc.text(), await missingDoc.text(), "a foreign document answers exactly as a missing one");
  const missingIdea = await r.post("/workbench/research", { attach: { kind: "idea", id: IDEA_NONE }, question: "q" }, B);
  const foreignIdea = await r.post("/workbench/research", { attach: { kind: "idea", id: IDEA_A }, question: "q" }, B);
  const junkIdea = await r.post("/workbench/research", { attach: { kind: "idea", id: "not-a-uuid" }, question: "q" }, B);
  // round 2: an idea attach is refused before anything is read (was 404 for B; it is 400 for everyone now)
  assertEquals([missingIdea.status, foreignIdea.status, junkIdea.status], [400, 400, 400]);
  const t = await foreignIdea.text();
  assertEquals(t, await missingIdea.text());
  assertEquals(t, await junkIdea.text());
  assertFalse(t.includes(IDEA_A) || t.includes(M.TIT), "the refusal names nothing of A's");
  assertEquals(r.calls, [], "nothing of A's was read into a door call");
  assertFalse(r.sql.some((q) => /ideas/i.test(q)), "no idea was read at all");
  // and A, the owner, can attach their document; their own idea is the same 400 as B's (preview and start alike)
  assertEquals((await r.post("/workbench/research/preview", { attach: { kind: "document", path: DOC_A }, question: "q" }, A)).status, 200);
  const own = await r.post("/workbench/research/preview", { attach: { kind: "idea", id: IDEA_A }, question: "q" }, A);
  assertEquals(own.status, 400);
  assertEquals(await own.text(), t, "the owner's own idea answers exactly as another user's");
});

Deno.test("a service identity has no user front end: no owner, nothing started", async () => {
  const app = newApp();
  const door: DoorClient = { preview: () => Promise.reject(new Error("no")), start: () => Promise.reject(new Error("no")) };
  registerResearchStart(app, { db: {} as never } as never, { door, identity: () => Promise.resolve({ ...who("service:agent"), kind: "service" }), readDoc: () => Promise.reject(new Error("no")) });
  const res = await app.request("/workbench/research", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "q" }) });
  assertEquals(res.status, 404);
});

Deno.test("a refusal starts nothing and carries the code only; a changed question is a 409 that starts nothing", async () => {
  const refused = rig({ startAnswer: { status: 200, body: { refused: "no_candidate_passed", handback_id: "11111111-1111-4111-8111-111111111111" } } });
  const res = await refused.post("/workbench/research", { question: `${M.Q} q` });
  assertEquals(res.status, 200);
  const j = await res.json();
  assertEquals([j.started, j.job_id, j.question, j.refusal], [false, null, null, "no_candidate_passed"]);
  assertFalse(JSON.stringify(j).includes("1111-4111"), "the hand-back id is not relayed");
  const changed = rig({ startAnswer: { status: 409, body: { changed: true, ok: true, question: "A different question about heat pumps?", topic: "t", links: [] } } });
  const c = await changed.post("/workbench/research", { question: "q", approved_question: "What is known about heat pumps and winter bills?" });
  assertEquals(c.status, 409);
  assertEquals(changed.calls[0].body.approved_question, "What is known about heat pumps and winter bills?");
  assertFalse("job_id" in await c.json());
});

Deno.test("inert without RESEARCH_URL / RESEARCH_WORKSPACE_KEY: the stated 503, nothing read", async () => {
  const r = rig({ door: null });
  for (const path of ["/workbench/research/preview", "/workbench/research"]) {
    // round 2: was an idea attach (refused now, 400, below); the inert 503 is asserted over a document
    assertEquals((await r.post(path, { question: "q", attach: { kind: "document", path: DOC_A } })).status, 503);
    assertEquals((await r.post(path, { question: "q", attach: { kind: "idea", id: IDEA_A } })).status, 400);
  }
  assertEquals(r.sql, []);
});

Deno.test("a missing or non-JSON body is the caller's 400", async () => {
  const r = rig();
  const bad = await r.app.request("/workbench/research", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
  assertEquals(bad.status, 400);
  assertEquals((await r.post("/workbench/research", { question: "" })).status, 400);
  assertEquals((await r.post("/workbench/research", { question: "q", attach: { kind: "folder" } })).status, 400);
  assertEquals((await r.post("/workbench/research", { question: "q", passages: ["x"] })).status, 400, "passages need a document or an idea");
});

Deno.test("parseStart / buildItem / extractLinks (pure)", () => {
  assertEquals(extractLinks("see https://a.example.org/x, and (https://b.example.org/y).", "https://a.example.org/x"), ["https://a.example.org/x", "https://b.example.org/y"]);
  const req = parseStart({ attach: { kind: "document", path: DOC_A }, question: " why? ", passages: ["p"] });
  assertEquals(req.question, "why?");
  const it = buildItem(A, req, { ref: DOC_A, title: "T", text: "https://n.example.org/z body" }, "s1");
  assertEquals([it.kind, it.id, it.owner_sub], ["document", `${DOC_A}#s1`, A]);
  assertEquals(it.links, ["https://n.example.org/z"]);
  assertEquals(Object.keys(it.fields).sort(), ["document", "document_title", "passage_1", "question"]);
  try { parseStart(null); assert(false); } catch (e) { assert(e instanceof BadRequest); }
});

// ── round 2 (the coordinator's decision, operator rule PD0b / slot 580): an idea is researched only through its owner's
// request path (the idea's research-now -> idea_research -> the drain), never through the shared derived door. That
// path cannot serve this start as its preview shows it (it takes neither the question nor the passages, answers a
// request id, not a job, and runs privately only after the owner's review) - so idea attach is removed, alike for
// preview and start.
Deno.test("idea attach is refused alike by the preview and the start, for the owner and for anyone: 400, one answer, nothing read, no door call", async () => {
  const r = rig();
  const answers: Array<{ status: number; text: string }> = [];
  for (const path of ["/workbench/research/preview", "/workbench/research"]) {
    for (const [id, sub] of [[IDEA_A, A], [IDEA_A, B], [IDEA_NONE, A], ["not-a-uuid", B]] as const) {
      for (const extra of [{}, { passages: [`${M.PAS} p`] }, { approved_question: "What is known about heat pumps and winter bills?" }]) {
        const res = await r.post(path, { attach: { kind: "idea", id }, question: `${M.Q} q`, ...extra }, sub);
        answers.push({ status: res.status, text: await res.text() });
      }
    }
  }
  assertEquals(new Set(answers.map((a) => a.status)), new Set([400]));
  assertEquals(new Set(answers.map((a) => a.text)).size, 1, "the owner's idea, another user's, a missing one and junk: one answer");
  assertEquals(JSON.parse(answers[0].text), { error: IDEA_REFUSED }, "a clear message: research an idea from the idea itself");
  for (const m of [...Object.values(M), IDEA_A]) assertFalse(answers[0].text.includes(m), `the refusal names ${m}`);
  assertEquals(r.calls, [], "no preview door and no start door call: the derived door is never asked to take an idea");
  assertEquals(r.sql, [], "nothing read: not the idea, not anything");
});

Deno.test("parseStart: an idea attach is a BadRequest with the one message; a document and nothing still parse", () => {
  for (const a of [{ kind: "idea", id: IDEA_A }, { kind: "idea" }, { kind: "idea", id: "" }]) {
    try { parseStart({ attach: a, question: "q" }); assert(false, JSON.stringify(a)); } catch (e) {
      assert(e instanceof BadRequest);
      assertEquals((e as Error).message, IDEA_REFUSED);
    }
  }
  assertEquals(parseStart({ attach: { kind: "document", path: DOC_A }, question: "q" }).attach, { kind: "document", path: DOC_A });
  assertEquals(parseStart({ question: "q" }).attach, { kind: "none" });
  const it = buildItem(A, parseStart({ question: "q" }), null, "s2");
  assertEquals(it.kind, "chat");
  assertFalse("revision" in it, "no idea revision on any item");
});
