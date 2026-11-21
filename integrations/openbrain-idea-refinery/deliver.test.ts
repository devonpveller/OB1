// deliver.test.ts - the refinery's dossier delivery (rw-p8a4-ideas, rw-idea-privacy), over a fake of the database.
//   deno test --allow-read deliver.test.ts      (no network, no database; idea_deliver_dossier() itself is proven in the
//                                                 workbench's P2b lab: src/ideas/ideas_integration_test.ts I2 / I9)
import { deliverForIdea, type DeliverDeps, type DeliverIdea } from "./deliver.ts";

function assert(c: unknown, m = "assertion failed"): asserts c {
  if (!c) throw new Error(m);
}
function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m} expected ${y}, got ${x}`);
}

function deps(opts: { room?: string } = {}) {
  const log: { sql: string; args: unknown[] }[] = [];
  const order: string[] = [];
  const d: DeliverDeps = {
    sql: <T>(text: string, args: unknown[] = []) => {
      log.push({ sql: text, args });
      if (/idea_resurface\(/.test(text)) return Promise.resolve([{ title: "a parked idea" }] as unknown as T[]);
      if (/idea_deliver_dossier\(/.test(text)) {
        order.push("room");
        return Promise.resolve([{ o: { outcome: opts.room ?? "delivered", room_id: "room-1" } }] as unknown as T[]);
      }
      if (/^\s*UPDATE ideas/.test(text)) order.push("mark");
      return Promise.resolve([] as T[]);
    },
    resurfaceMaxDist: 0.4,
    log: () => {},
  };
  return { d, log, order };
}

const IDEA: DeliverIdea = { id: "a1000000-0000-4000-8000-0000000000a1", title: "An idea", summary: "what it is", thread_root: null, last_job_id: "job-1" };
const RESULT = { synthesis: "what research found", cited_sources: [{ title: "S", url: "https://example.org/s" }] };

// the service's source without comments (index.ts starts a server on import, so it is read, not imported)
async function source(f: string): Promise<string> {
  return (await Deno.readTextFile(new URL(f, new URL(".", import.meta.url)))).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

Deno.test("a dossier lands in the idea's room, once per research job; then the idea is delivered", async () => {
  const { d, log, order } = deps();
  eq(await deliverForIdea(d, IDEA, RESULT), "delivered");
  eq(order, ["room", "mark"]);
  const room = log.find((l) => /idea_deliver_dossier\(/.test(l.sql))!;
  eq(room.args[0], IDEA.id);
  eq(room.args[1], "job-1", "one entry per research job (idempotent on retry)");
  assert(String(room.args[2]).includes("what research found") && String(room.args[2]).includes("in the room"), "the room carries the dossier");
  eq(log.filter((l) => /idea_deliver_dossier\(/.test(l.sql)).length, 1, "the room once");
  const mark = log.find((l) => /^\s*UPDATE ideas/.test(l.sql))!;
  eq(mark.args, [IDEA.id]);
  assert(!/thread_root/.test(mark.sql), "no Mattermost thread is recorded");
});

Deno.test("rw-idea-privacy: the dossier goes to NO Mattermost channel - the delivery has no Mattermost dependency at all", async () => {
  // DR4: #ideas was a PUBLIC channel every member of the bot's team could read. No owner -> Mattermost mapping exists,
  // so the dossier's only delivery is the owner's room: deliver.ts takes no Mattermost client and calls no post
  let posted = 0;
  const { d } = deps();
  const withMm = { ...d, mm: { channel: () => Promise.resolve("ideas"), post: () => { posted++; return Promise.resolve({ id: "p" }); }, permalink: () => null } };
  eq(await deliverForIdea(withMm as unknown as DeliverDeps, IDEA, RESULT), "delivered");
  eq(posted, 0, "a Mattermost client handed in is never used");
  const del = await source("deliver.ts");
  assert(!/\bmm\b|mattermost|posts\b|channel/i.test(del), "deliver.ts names no Mattermost post or channel");
  const idx = await source("index.ts");
  const call = idx.slice(idx.indexOf("await deliverDossier("), idx.indexOf("}, idea, result)"));
  assert(call.length > 0 && !/\bmm\s*:/.test(call), "index.ts delivers with no Mattermost client");
  assert(!/method:\s*"POST"[\s\S]{0,200}\/api\/v4\/channels`/.test(idx) && !/\/api\/v4\/channels`,\s*\{\s*method:\s*"POST"/.test(idx), "the refinery never creates a channel");
  assert(!/type:\s*"O"/.test(idx), "no public channel type anywhere in the service");
});

Deno.test("an update (an idea delivered before) gets no resurface cross-link", async () => {
  const { d, log } = deps();
  await deliverForIdea(d, { ...IDEA, thread_root: "root-9" }, RESULT);
  assert(!log.some((l) => /idea_resurface/.test(l.sql)), "resurface only on a new idea's first dossier");
  assert(String(log.find((l) => /idea_deliver_dossier\(/.test(l.sql))!.args[2]).includes("Updated: An idea"));
});

Deno.test("the resurface cross-link names only the same owner's parked ideas (idea_resurface), never a raw query over every idea", async () => {
  const { d, log } = deps();
  await deliverForIdea(d, IDEA, RESULT);
  assert(log.some((l) => /public\.idea_resurface\(\$1::uuid, \$2, 2\)/.test(l.sql)));
  assert(!log.some((l) => /status\s*=\s*'dormant'/.test(l.sql)), "no unscoped dormant-idea query");
});

Deno.test("an archived refinery: no room entry is made and the idea is not marked", async () => {
  const { d, order } = deps({ room: "archived" });
  eq(await deliverForIdea(d, IDEA, RESULT), "skipped");
  eq(order, ["room"]);
});

Deno.test("the refinery never promotes on its own: no statement it runs names `promoted` (source check of the service)", async () => {
  const { d, log } = deps();
  await deliverForIdea(d, IDEA, RESULT);
  assert(!log.some((l) => /promoted/.test(l.sql)));
  for (const f of ["index.ts", "deliver.ts"]) assert(!/status\s*=\s*'promoted'/.test(await source(f)), `${f} sets status promoted`);
  // index.ts delivers through this module, and its resurface is the owner-scoped function
  const here = new URL(".", import.meta.url);
  const idx = await Deno.readTextFile(new URL("index.ts", here));
  assert(/deliverForIdea\(/.test(idx) && /from "\.\/deliver\.ts"/.test(idx), "index.ts delivers through deliver.ts");
  assert(!/WHERE status='dormant' AND id <> \$1/.test(idx), "the old unscoped nearDormant query is gone");
});

// ── rw-boundary-ideas (slot 580): the delivery through the hand-back ──────────────────────────────────────────────
import { deliverHandbacks, type HandbackDeps } from "./deliver.ts";

function hbDeps(rows: unknown[], idea: DeliverIdea | null = IDEA) {
  const base = deps();
  const closed: Array<[string, boolean]> = [];
  const failed: string[] = [];
  const d: HandbackDeps = {
    ...base.d,
    sql: <T>(text: string, args: unknown[] = []) => {
      if (/idea_handback_deliverables\(/.test(text)) return Promise.resolve(rows as T[]);
      if (/handback_delivered\(/.test(text)) { closed.push([String(args[0]), args[1] === true || /true\)/.test(text)]); return Promise.resolve([] as T[]); }
      return base.d.sql<T>(text, args);
    },
    idea: () => Promise.resolve(idea),
    markFailed: (i) => { failed.push(i.id); return Promise.resolve(); },
  };
  return { d, closed, failed, log: base.log };
}

Deno.test("rw-boundary-ideas: a finished hand-back job is delivered into the room under ITS job id, then the hand-back is closed", async () => {
  const h = hbDeps([{ id: "hb-1", idea_id: IDEA.id, job_id: "job-derived", job_status: "done", result: RESULT, error: null }]);
  const o = await deliverHandbacks(h.d, 10);
  eq([o.delivered, o.failed, o.missing], [1, 0, false]);
  const room = h.log.find((c) => /idea_deliver_dossier\(/.test(c.sql))!;
  eq(room.args[1], "job-derived", "the dossier names the hand-back's job");
  eq(h.closed, [["hb-1", true]]);
});

Deno.test("rw-boundary-ideas: a failed / cancelled job closes its hand-back as failed; the idea is marked only for its CURRENT job", async () => {
  const cur = hbDeps([{ id: "hb-2", idea_id: IDEA.id, job_id: "job-1", job_status: "error", result: null, error: "x" }]);
  eq((await deliverHandbacks(cur.d, 10)).failed, 1);
  eq([cur.closed, cur.failed], [[["hb-2", false]], [IDEA.id]]);
  const old = hbDeps([{ id: "hb-3", idea_id: IDEA.id, job_id: "job-older", job_status: "cancelled", result: null, error: null }]);
  await deliverHandbacks(old.d, 10);
  eq([old.closed, old.failed], [[["hb-3", false]], []]);
});

Deno.test("rw-boundary-ideas: a database without slot 580 is reported (missing), not an error; a deleted idea's hand-back is closed", async () => {
  const none: HandbackDeps = { ...hbDeps([]).d, sql: () => Promise.reject(Object.assign(new Error("no function"), { fields: { code: "42883" } })) };
  eq((await deliverHandbacks(none, 10)).missing, true);
  const gone = hbDeps([{ id: "hb-4", idea_id: IDEA.id, job_id: "j", job_status: "done", result: RESULT, error: null }], null);
  await deliverHandbacks(gone.d, 10);
  eq(gone.closed, [["hb-4", false]]);
});

Deno.test("rw-boundary-ideas: the legacy pass skips a job queued through a hand-back (no double delivery) - source check", async () => {
  const src = await source("index.ts");
  assert(/request_kind NOT IN \('derived', 'personal'\)/.test(src), "selectPending excludes the hand-back kinds");
  assert(/deliverThroughHandbacks\(\)/.test(src), "the pass delivers through the hand-back first");
});
