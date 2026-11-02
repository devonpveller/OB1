// deliver.test.ts - the refinery's dossier delivery (rw-p8a4-ideas), over fakes of the database and Mattermost.
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

function deps(opts: { room?: string; mm?: boolean; mmFails?: boolean } = {}) {
  const log: { sql: string; args: unknown[] }[] = [];
  const order: string[] = [];
  const posts: { message: string; root: string | null }[] = [];
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
    mm: opts.mm === false ? null : {
      channel: () => Promise.resolve("chan"),
      post: (_c: string, message: string, root: string | null) => {
        order.push("mattermost");
        if (opts.mmFails) return Promise.reject(new Error("mm post 503"));
        posts.push({ message, root });
        return Promise.resolve({ id: "post-1" });
      },
      permalink: () => null,
    },
    resurfaceMaxDist: 0.4,
    log: () => {},
  };
  return { d, log, order, posts };
}

const IDEA: DeliverIdea = { id: "a1000000-0000-4000-8000-0000000000a1", title: "An idea", summary: "what it is", thread_root: null, last_job_id: "job-1" };
const RESULT = { synthesis: "what research found", cited_sources: [{ title: "S", url: "https://example.org/s" }] };

Deno.test("a dossier lands in the idea's room FIRST and is still posted to Mattermost; then the idea is delivered", async () => {
  const { d, log, order, posts } = deps();
  eq(await deliverForIdea(d, IDEA, RESULT), "delivered");
  eq(order, ["room", "mattermost", "mark"]);
  const room = log.find((l) => /idea_deliver_dossier\(/.test(l.sql))!;
  eq(room.args[0], IDEA.id);
  eq(room.args[1], "job-1", "one entry per research job (idempotent on retry)");
  assert(String(room.args[2]).includes("what research found") && String(room.args[2]).includes("in the room"), "the room carries the dossier");
  eq(posts.length, 1);
  assert(posts[0].message.includes("what research found") && posts[0].root === null, "the thread root on the first dossier");
  const mark = log.find((l) => /^\s*UPDATE ideas/.test(l.sql))!;
  eq(mark.args, [IDEA.id, "post-1"]);
});

Deno.test("an update posts under the existing thread, without a resurface cross-link", async () => {
  const { d, log, posts } = deps();
  await deliverForIdea(d, { ...IDEA, thread_root: "root-9" }, RESULT);
  eq(posts[0].root, "root-9");
  assert(!log.some((l) => /idea_resurface/.test(l.sql)), "resurface only on a new idea's first dossier");
});

Deno.test("the resurface cross-link names only the same owner's parked ideas (idea_resurface), never a raw query over every idea", async () => {
  const { d, log } = deps();
  await deliverForIdea(d, IDEA, RESULT);
  assert(log.some((l) => /public\.idea_resurface\(\$1::uuid, \$2, 2\)/.test(l.sql)));
  assert(!log.some((l) => /status\s*=\s*'dormant'/.test(l.sql)), "no unscoped dormant-idea query");
});

Deno.test("an archived refinery: no room entry is made, nothing is posted to Mattermost, the idea is not marked", async () => {
  const { d, order, posts } = deps({ room: "archived" });
  eq(await deliverForIdea(d, IDEA, RESULT), "skipped");
  eq(order, ["room"]);
  eq(posts.length, 0);
});

Deno.test("Mattermost off: the room alone, the idea delivered with its thread_root kept", async () => {
  const { d, log, order } = deps({ mm: false });
  eq(await deliverForIdea(d, IDEA, RESULT), "delivered");
  eq(order, ["room", "mark"]);
  eq(log.find((l) => /^\s*UPDATE ideas/.test(l.sql))!.args, [IDEA.id, null]);
});

Deno.test("a failed Mattermost post leaves the idea undelivered for the next pass (the room entry is idempotent per job)", async () => {
  const { d, order } = deps({ mmFails: true });
  let err = "";
  try { await deliverForIdea(d, IDEA, RESULT); } catch (e) { err = (e as Error).message; }
  eq(err, "mm post 503");
  eq(order, ["room", "mattermost"]);
});

Deno.test("the refinery never promotes on its own: no statement it runs names `promoted` (source check of the service)", async () => {
  const { d, log } = deps();
  await deliverForIdea(d, IDEA, RESULT);
  assert(!log.some((l) => /promoted/.test(l.sql)));
  const here = new URL(".", import.meta.url);
  for (const f of ["index.ts", "deliver.ts"]) {
    const src = (await Deno.readTextFile(new URL(f, here))).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert(!/status\s*=\s*'promoted'/.test(src), `${f} sets status promoted`);
  }
  // index.ts delivers through this module, and its resurface is the owner-scoped function
  const idx = await Deno.readTextFile(new URL("index.ts", here));
  assert(/deliverForIdea\(/.test(idx) && /from "\.\/deliver\.ts"/.test(idx), "index.ts delivers through deliver.ts");
  assert(!/WHERE status='dormant' AND id <> \$1/.test(idx), "the old unscoped nearDormant query is gone");
});
