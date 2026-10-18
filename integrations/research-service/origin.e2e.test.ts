// origin.e2e.test.ts - D17 item 1 end to end: POST /research on a RUNNING research service, the
// row it writes, and the Idea Refinery's inlet reference (research-workbench P0).
//
// SKIPPED unless RESEARCH_E2E_URL is set. OB1/docker/workbench/contract-test/run-contract-tests.ps1
// runs it against the :wt research image and a DISPOSABLE database on its own internal network.
// Never point it at the live service: it submits jobs.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Pool } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

const URL_ = Deno.env.get("RESEARCH_E2E_URL");
const ignore = !URL_;
const K = {
  owui: Deno.env.get("RESEARCH_E2E_OWUI_KEY") ?? "",
  ao: Deno.env.get("RESEARCH_E2E_AO_KEY") ?? "",
  shared: Deno.env.get("RESEARCH_E2E_SHARED_KEY") ?? "",
};
const pool = URL_
  ? new Pool({
    hostname: Deno.env.get("RESEARCH_E2E_DB_HOST"), port: 5432, database: "openbrain",
    user: "postgres", password: Deno.env.get("RESEARCH_E2E_DB_PASSWORD") ?? "",
  }, 2, true)
  : null;
async function sql<T>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}
async function submit(key: string, body: Record<string, unknown>) {
  const r = await fetch(`${URL_}/research`, {
    method: "POST", headers: { "content-type": "application/json", "x-brain-key": key }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
type Row = { origin: string; caller: string; origin_claimed: string | null; inlet_ref: Record<string, string> | null;
  refinery_id: string | null; options: Record<string, unknown> };
const row = async (id: string) =>
  (await sql<Row>(`SELECT origin, caller, origin_claimed, inlet_ref, refinery_id, options FROM research_jobs WHERE id = $1`, [id]))[0];
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });

t("the existing OWUI tool's request (origin=owui, callback ids) is accepted and recorded owui with its chat id", async () => {
  const r = await submit(K.owui, {
    query: "e2e owui", origin: "owui", options: { confidence_floor: 0.5 },
    callback: { chat_id: "chat-e2e-1", message_id: "msg-1" },
  });
  assertEquals(r.status, 202);
  const j = await row(r.json.job_id);
  assertEquals([j.origin, j.caller, j.origin_claimed], ["owui", "owui-tool", null]);
  assertEquals(j.inlet_ref, { kind: "chat_id", id: "chat-e2e-1" });
});

t("agent-org's requests (origin=agent, agent-org) are accepted and recorded mattermost, the claim kept", async () => {
  for (const sent of ["agent", "agent-org", "agent"]) {
    const r = await submit(K.ao, { query: `e2e ao ${sent}`, origin: sent });
    assertEquals(r.status, 202);
    const j = await row(r.json.job_id);
    assertEquals([j.origin, j.caller, j.origin_claimed], ["mattermost", "agent-org", sent]);
  }
});

t("an Idea Refinery job rides the agent key: mattermost, with the idea id as its inlet reference", async () => {
  const r = await submit(K.ao, { query: "e2e idea research", origin: "agent" });
  assertEquals(r.status, 202);
  // what openbrain-idea-refinery does right after submitting: stamp the job on the revision
  const [{ id: thought }] = await sql<{ id: number }>(
    `INSERT INTO thoughts (content, exposure) VALUES ('e2e idea', 'ops') RETURNING id`);
  const [{ id: idea }] = await sql<{ id: string }>(`INSERT INTO ideas (title) VALUES ('e2e idea') RETURNING id`);
  await sql(`INSERT INTO idea_revisions (idea_id, revision, summary, thought_id) VALUES ($1, 1, 'e2e idea', $2)`, [idea, thought]);
  await sql(`UPDATE idea_revisions SET research_job_id = $2 WHERE idea_id = $1 AND revision = 1`, [idea, r.json.job_id]);
  const j = await row(r.json.job_id);
  assertEquals(j.origin, "mattermost");
  assertEquals(j.inlet_ref, { kind: "idea", id: idea });
  assertEquals(j.refinery_id, idea);
});

t("a self-declared origin never wins over the key", async () => {
  const a = await row((await submit(K.owui, { query: "e2e claim notebook", origin: "notebook" })).json.job_id);
  assertEquals([a.origin, a.origin_claimed], ["owui", "notebook"]);
  const b = await row((await submit(K.ao, { query: "e2e claim workspace", origin: "workspace" })).json.job_id);
  assertEquals(b.origin, "mattermost");
});

t("the shared key still authenticates; its jobs record the shared origin, the digest keeps its queue lane", async () => {
  const r = await submit(K.shared, { query: "e2e digest", origin: "notebook" });
  assertEquals(r.status, 202);
  const j = await row(r.json.job_id);
  assertEquals([j.origin, j.caller, j.origin_claimed], ["manual", "shared-key", "notebook"]);
  assertEquals(j.options.queue_origin, "notebook");
  const forged = await submit(K.shared, { query: "e2e forged lane", options: { queue_origin: "notebook" } });
  assertEquals((await row(forged.json.job_id)).options.queue_origin, "manual", "queue_origin is engine-owned");
});

t("an unknown key is refused; nothing is written", async () => {
  const before = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM research_jobs`))[0].n;
  const r = await submit("not-a-caller-key-0000000000", { query: "e2e nope" });
  assertEquals(r.status, 401);
  assertEquals((await sql<{ n: number }>(`SELECT count(*)::int AS n FROM research_jobs`))[0].n, before);
});

t("job status reads accept the per-caller keys too (the OWUI tool polls with its own key)", async () => {
  const r = await submit(K.owui, { query: "e2e poll" });
  const p = await fetch(`${URL_}/research/jobs/${r.json.job_id}`, { headers: { "x-brain-key": K.owui } });
  assertEquals(p.status, 200);
  await p.body?.cancel();
  assert(true);
});

Deno.test({ name: "close", ignore, fn: async () => await pool!.end(), sanitizeOps: false, sanitizeResources: false });
