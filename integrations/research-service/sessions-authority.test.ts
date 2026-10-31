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
import { actorOf, MAY_ACT_SQL } from "./viewer.ts";
import { createSteer, GAP_ACTOR, openGapBranches, SteerError, type Q } from "./tree.ts";
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
