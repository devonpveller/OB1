/**
 * sessions-authority.test.ts - research-workbench P4b (rw-p4b-sessions), offline: who may steer or
 * cancel a job from the workspace, and what a steer records.
 *   - actorOf: only the workspace's own caller key may say who acted (x-actor-sub) and that the actor
 *     is an admin (x-actor-admin: 1), and only together with the user it acts for (x-on-behalf-of);
 *     every other key naming either is refused (403) - an admin flag cannot be forged by OWUI, agent-org
 *     or the shared key (operator 2026-10-30, option "Admins").
 *   - MAY_ACT_SQL: a service-owned job (owner service:<caller>) may be acted on by an admin; a USER's
 *     job stays owner-only, admin or not; an ownerless job stays the default subject's.
 *   - createSteer: every steer records actor_sub (a human steer without one is refused); a gap /
 *     inter-hub branch records the research service itself; add-source seeds land on the child only.
 * The SQL half (the real index.ts against a lab database) runs in the workbench's sessions lab
 * (OB1/docker/workbench/contract-test/run-sessions-tests.ps1).
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { actorOf, HIDDEN_STEER_TEXTS_SQL, MAY_ACT_SQL, nonActorView, TREE_STEP_IDS_SQL } from "./viewer.ts";
import { createSteer, GAP_ACTOR, openGapBranches, recordCancel, SteerError, type Q } from "./tree.ts";
import type { Caller } from "./origin.ts";

const ws: Caller = { name: "workspace", origin: "workspace", key: "k".repeat(32), shared: false };
const owui: Caller = { name: "owui-tool", origin: "owui", key: "o".repeat(32), shared: false };
const agent: Caller = { name: "agent-org", origin: "mattermost", key: "a".repeat(32), shared: false };
const shared: Caller = { name: "shared-key", origin: "workspace", key: "s".repeat(32), shared: true };
const h = (o: Record<string, string | undefined>) => (k: string) => o[k.toLowerCase()] ?? null;

Deno.test("P4b actorOf: the workspace key may name the actor and assert admin, with the user it acts for", () => {
  assertEquals(actorOf(ws, h({ "x-on-behalf-of": "alice", "x-actor-sub": "admin-1", "x-actor-admin": "1" }), "alice"),
    { actor: "admin-1", admin: true });
  assertEquals(actorOf(ws, h({ "x-on-behalf-of": "alice" }), "alice"), { actor: "alice", admin: false });
  // no header at all: the viewer acts, never an admin (every caller)
  for (const c of [ws, owui, agent, shared]) assertEquals(actorOf(c, h({}), `service:${c.name}`), { actor: `service:${c.name}`, admin: false });
});

Deno.test("P4b actorOf: any other key naming an actor or an admin is refused 403; a malformed value 400", () => {
  for (const c of [owui, agent, shared]) {
    for (const hdr of [{ "x-actor-admin": "1" }, { "x-actor-sub": "someone" }]) {
      const r = actorOf(c, h({ "x-on-behalf-of": "alice", ...hdr }), "alice");
      assert("error" in r && r.status === 403, `${c.name} ${JSON.stringify(hdr)}: ${JSON.stringify(r)}`);
    }
  }
  for (const bad of [{ "x-actor-admin": "true" }, { "x-actor-admin": "yes" }, { "x-actor-sub": "service:agent-org" },
    { "x-actor-sub": "system:x" }, { "x-actor-sub": "a\u0000b" }, { "x-actor-sub": "x".repeat(300) }]) {
    const r = actorOf(ws, h({ "x-on-behalf-of": "alice", ...bad }), "alice");
    assert("error" in r && r.status === 400, `${JSON.stringify(bad)}: ${JSON.stringify(r)}`);
  }
  // an admin flag without a user it acts for (the workspace's service identity) is refused
  const r = actorOf(ws, h({ "x-actor-admin": "1" }), "service:workspace");
  assert("error" in r && r.status === 400, JSON.stringify(r));
});

Deno.test("P4b MAY_ACT_SQL: an admin acts on a service's job only; a user's job stays owner-only", () => {
  assert(MAY_ACT_SQL.includes("$4"), "the admin flag is a bound parameter");
  // the admin clause is tied to a service owner, never to any owner
  assert(/\$4::boolean AND o\.owner_sub LIKE 'service:%'/.test(MAY_ACT_SQL), MAY_ACT_SQL);
  // the ownerless branch is unchanged: the default subject only
  assert(MAY_ACT_SQL.includes("ELSE ($3 <> '' AND $2 = $3)"), MAY_ACT_SQL);
});

// ── a fake client for createSteer: answers by statement, records what was written ────────────
function fakeQ(o: { status?: string; stepKind?: string } = {}) {
  const writes: { sql: string; args: unknown[] }[] = [];
  const q: Q = {
    queryObject<T>(sql: string, args: unknown[] = []) {
      const s = sql.replace(/\s+/g, " ");
      const rows = (r: unknown[]) => Promise.resolve({ rows: r as T[] });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s.trim())) return rows([]);
      if (s.includes("FOR UPDATE") || (s.includes("FROM public.research_jobs WHERE id = $1::uuid") && s.includes("branch_kind, anchor"))) {
        return rows([{ id: "p1", status: o.status ?? "running", query: "parent q", options: { seed_sources: [{ url: "u0", title: "t0", content: "c0" }] }, thread_id: null, origin: "mattermost", root_job_id: null, branch_kind: "root", anchor: null, topic_estimate: null }]);
      }
      if (s.includes("SELECT step_id FROM public.research_job_events")) return rows([{ step_id: args[1] }]);
      if (s.includes("SELECT query, topic_estimate")) return rows([{ query: "parent q", topic_estimate: "topic" }]);
      if (s.includes("count(*)::int AS n")) return rows([{ n: 0 }]);
      writes.push({ sql: s, args });
      if (s.startsWith("INSERT INTO public.research_jobs")) return rows([{ id: "child-1" }]);
      if (s.startsWith("INSERT INTO public.research_steers")) return rows([{ id: "steer-1" }]);
      if (s.startsWith("INSERT INTO public.research_job_events")) return rows([{ id: "1", step_id: null }]);
      return rows([]);
    },
  };
  return { q, writes };
}
const noContract = () => null;

Deno.test("P4b createSteer: a human steer records actor_sub; one without an actor is refused", async () => {
  const { q, writes } = fakeQ();
  await createSteer(q, { parentId: "p1", stepId: "s2", text: "narrow it", caller: "workspace", actorSub: "admin-1" }, noContract);
  const st = writes.find((w) => w.sql.startsWith("INSERT INTO public.research_steers"))!;
  assert(st.sql.includes("actor_sub"), st.sql);
  assert(st.args.includes("admin-1"), JSON.stringify(st.args));
  const e = await assertRejects(() => createSteer(fakeQ().q, { parentId: "p1", stepId: "s2", text: "x", caller: "workspace" }, noContract), SteerError);
  assertEquals((e as SteerError).status, 400);
});

Deno.test("P4b openGapBranches: a gap branch records the research service as its actor", async () => {
  const { q, writes } = fakeQ();
  await openGapBranches(q, "p1", "s2", [{ kind: "gap", text: "g", query: "g", ref: "claim:1", gap: { claim_id: "1" } }], 3, noContract);
  const st = writes.find((w) => w.sql.startsWith("INSERT INTO public.research_steers"))!;
  assert(st.args.includes(GAP_ACTOR), JSON.stringify(st.args));
  assert(GAP_ACTOR.startsWith("system:"), GAP_ACTOR);
});

Deno.test("P4b createSteer: add-source seeds land on the child; the parent is never written", async () => {
  const { q, writes } = fakeQ();
  await createSteer(q, {
    parentId: "p1", stepId: "s2", text: "use this source", caller: "workspace", actorSub: "alice",
    seedSources: [{ url: "https://example.org/a", title: "A", content: "the text" }],
  }, noContract);
  const job = writes.find((w) => w.sql.startsWith("INSERT INTO public.research_jobs"))!;
  const options = JSON.parse(String(job.args[3]));
  assertEquals(options.seed_sources, [{ url: "https://example.org/a", title: "A", content: "the text" }]);
  assert(!writes.some((w) => /^UPDATE public\.research_jobs/.test(w.sql)), "the parent row is never written");
  for (const bad of [[{ url: "u", title: "t", content: "" }], new Array(6).fill({ url: "u", title: "t", content: "c" })]) {
    const e = await assertRejects(() => createSteer(fakeQ().q, { parentId: "p1", stepId: "s2", text: "x", actorSub: "a", seedSources: bad }, noContract), SteerError);
    assertEquals((e as SteerError).status, 400);
  }
});

// ── round 2 (tester t-p4b-sessions F-cancel-actor-recorded): a cancel records who cancelled ─────
Deno.test("P4b round 2 recordCancel: every cancel is recorded with its actor (research_cancels); none without one", async () => {
  const { q, writes } = fakeQ();
  await recordCancel(q, { jobId: "p1", actorSub: "admin-1", caller: "workspace", reason: "no longer needed", outcome: "cancelled" });
  const w = writes.find((x) => x.sql.startsWith("INSERT INTO public.research_cancels"))!;
  assert(w, "a research_cancels row is written");
  assert(w.sql.includes("actor_sub"), w.sql);
  assertEquals(w.args.slice(0, 2), ["p1", "admin-1"]);
  assert(w.args.includes("cancelled"), JSON.stringify(w.args));
  for (const blank of ["", "  ", null]) {
    const e = await assertRejects(() => recordCancel(fakeQ().q, { jobId: "p1", actorSub: blank as string, caller: "x", reason: "r", outcome: "cancelled" }), SteerError);
    assertEquals((e as SteerError).status, 400);
  }
});

Deno.test("P4b round 2: the cancel route records the actor it computed (index.ts calls recordCancel with acting.actor)", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  const cancel = src.slice(src.indexOf("const cancelMatch"), src.indexOf("const steerMatch"));
  assert(/recordCancel\([^)]*acting\.actor/.test(cancel.replace(/\s+/g, " ")), "the cancel route stores acting.actor");
});

// ── round 3 (tester t-p4b-sessions2 defect 2): the service's own reads keep a steer's text and the
// step ids from a viewer who may not act (actor / may-act / admin see them; others do not) ──────────
Deno.test("P4b round 3 nonActorView: no step id anywhere, no steer text but the viewer's own", () => {
  const tree = {
    root_job_id: "r", topic_estimate: "t", origin: "service question",
    branches: [{ id: "r", branch_kind: "root", rooted_step_id: null, query: "service question" },
               { id: "c1", branch_kind: "steer", rooted_step_id: "s2", query: "AdminWords secret steer", anchor: "service question" }],
    steers: [{ id: "st1", step_id: "s2", text: "AdminWords secret steer", steer_kind: "human" }],
    report: { heading: "t", sections: [{ title: "AdminWords secret steer", summary: "found x" }] },
    learning_records: [{ steer: "AdminWords secret steer", red: "gap" }],
  };
  const v = nonActorView(tree, ["AdminWords secret steer"]);
  const s = JSON.stringify(v);
  assert(!s.includes("AdminWords") && !s.includes('"s2"') && !s.includes("step_id"), s);
  assert(s.includes("service question") && s.includes("found x"), "the shared research stays");
  const ev = nonActorView({ events: [{ id: "1", step_id: "s2", type: "human_steer", payload: { step_id: "s2", text: "AdminWords secret steer", steer_id: "st1" } },
    { id: "2", step_id: null, type: "source", trail: { url: "u", kind: "admitted" }, payload: { url: "u" } }] }, ["AdminWords secret steer"]);
  const se = JSON.stringify(ev);
  assert(!se.includes("AdminWords") && !se.includes('"s2"'), se);
  assert(se.includes('"admitted"'), "a source's trail stays");
});

Deno.test("P4b round 3: the hidden texts are the tree's human steers by anyone but the viewer", () => {
  const q = HIDDEN_STEER_TEXTS_SQL.replace(/\s+/g, " ");
  assert(q.includes("research_steers") && q.includes("steer_kind = 'human'") && q.includes("actor_sub NOT IN ($2, $3)"), q);
});

Deno.test("P4b round 3: the tree, events and job-detail routes apply the non-actor view", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  const tree = src.slice(src.indexOf("const treeMatch"), src.indexOf("const jobMatch"));
  const job = src.slice(src.indexOf("const jobMatch"), src.indexOf("return new Response(\"not found\""));
  for (const [name, part] of [["tree/events", tree], ["job detail/stream", job]] as const) {
    assert(part.includes("steerScopeOf(") && part.includes("nonActorView("), `${name} applies the non-actor view`);
  }
});

// ── round 4 (tester t-p4b-sessions3): a step id in PROSE (learning_records deviation / steer) ─────
Deno.test("P4b round 4 nonActorView: the tree's step ids are redacted from every string value, not only their keys", () => {
  const tree = {
    learning_records: [
      { deviation: "a human steer answered it at p2 (branch c1)", steer: "question: service question" },
      { deviation: "no steer answered it", steer: "gap gap steer at s7: claim 12 is weak" },
      { steer: "interhub gap steer at s7; also see p2." },
    ],
    report: { sections: [{ title: "s2x and ps2 and p22 stay; p2 goes", summary: "p2" }] },
    origin: "service question",
  };
  const v = nonActorView(tree, [], ["p2", "s7"]);
  const s = JSON.stringify(v);
  for (const step of ["p2", "s7"]) assert(!new RegExp(`(^|[^A-Za-z0-9_-])${step}([^A-Za-z0-9_-]|$)`).test(s), `${step} survives: ${s}`);
  assert(s.includes("s2x") && s.includes("ps2") && s.includes("p22"), `look-alike words stay: ${s}`);
  assert(s.includes("a human steer answered it at") && s.includes("claim 12 is weak"), `the rest of the sentence stays: ${s}`);
});

Deno.test("P4b round 4: the tree's step ids come from its stage events, its branches and its steers", () => {
  const q = TREE_STEP_IDS_SQL.replace(/\s+/g, " ");
  assert(q.includes("research_job_events") && q.includes("rooted_step_id") && q.includes("research_steers"), q);
});

Deno.test("P4b round 4: the reads pass the tree's step ids to nonActorView", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url)).replace(/\s+/g, " ");
  assert((src.match(/nonActorView\([^)]*steer\.steps\)/g) ?? []).length >= 2, "tree/events and job detail redact the step ids by value");
});
