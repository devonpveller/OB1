// deno test -A src/documents/refinery_reopen_trail_test.ts - rw-idea-reopen-trail: the refinery open (reopenRefinery) writes ONE
// 'reopened' trail line, for the owner and by the caller, with the idea id as its subject and no text - only when it really
// reopened an archived refinery. Over a fake database that records writes (the real one is ideas_integration_test.ts [RT*]).
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Db } from "../contracts/db.ts";
import type { Identity } from "../middleware/identity.ts";

const vault = await Deno.makeTempDir({ prefix: "refinery-trail-vault-" });
Deno.env.set("WIKI_GIT_DIR", vault);
const { reopenRefinery } = await import("./refinery.ts");

const IDEA = "a1000000-0000-4000-8000-0000000000a1";
const who = { sub: "operator", actor: "operator", name: "Op", key: "operator" } as Identity;
const PATH = "documents/operator/ideas/x.md";

function fake(archivedAt: string | null, owner = "operator", stamp = "dirty") {
  const seen: { sql: string; args: unknown[] }[] = [];
  const db: Db = {
    query: (sql: string, args: unknown[] = []) => {
      seen.push({ sql, args });
      if (/FROM public\.user_document_listings WHERE path/.test(sql)) {
        return Promise.resolve([{ id: "d1", path: PATH, title: "T", updated_at: new Date(), refinery_id: IDEA, owner_sub: owner }] as never);
      }
      if (/FROM public\.ideas i LEFT JOIN public\.refinery_state/.test(sql)) {
        return Promise.resolve([{ id: IDEA, status: archivedAt ? "archived" : "engaged", archived_at: archivedAt, archived_from: archivedAt ? stamp : null }] as never);
      }
      if (/SELECT archived_from FROM public\.refinery_state/.test(sql)) return Promise.resolve([{ archived_from: archivedAt ? stamp : null }] as never);
      if (/UPDATE public\.refinery_state SET archived_at = NULL.*archived_at IS NOT NULL.*RETURNING/s.test(sql)) {
        // RETURNING gives the row AFTER the update: archived_from is already NULL there (PostgreSQL semantics)
        const col = /RETURNING (\w+)/.exec(sql)![1];
        return Promise.resolve((archivedAt ? [{ [col]: col === "archived_from" ? null : IDEA }] : []) as never);
      }
      return Promise.resolve([] as never);
    },
    tx: (fn: (d: Db) => Promise<unknown>) => fn(db),
  } as never;
  return { db, seen };
}
const deps = (db: Db) => ({ db, reg: {} as never, embed: () => Promise.resolve([]), chunk: (t: string) => [t], refetch: null, research: null });
const trail = (seen: { sql: string; args: unknown[] }[]) => seen.filter((s) => /INSERT INTO public\.user_document_trail/.test(s.sql));

Deno.test("rw-idea-reopen-trail: opening an archived refinery writes one reopened line (owner, actor, idea id)", async () => {
  const { db, seen } = fake("2026-11-01T00:00:00Z");
  const out = await reopenRefinery(deps(db), PATH, who);
  assertEquals(out.reopened, true);
  const w = trail(seen);
  assertEquals(w.length, 1);
  assertEquals(w[0].args, ["operator", "operator", IDEA]);
  assert(/'reopened'/.test(w[0].sql));
  assert(seen.indexOf(w[0]) > seen.findIndex((s) => /UPDATE public\.ideas SET status/.test(s.sql)));
});

Deno.test("rw-idea-reopen-trail: opening a refinery that was not archived writes no line (nothing reopened)", async () => {
  const { db, seen } = fake(null);
  assertEquals((await reopenRefinery(deps(db), PATH, who)).reopened, false);
  assertEquals(trail(seen).length, 0);
});

Deno.test("rw-idea-reopen-trail: another user's document is refused (404) and writes no line", async () => {
  const { db, seen } = fake("2026-11-01T00:00:00Z", "someone-else");
  let status = 0;
  try { await reopenRefinery(deps(db), PATH, who); } catch (e) { status = (e as { status?: number }).status ?? -1; }
  assertEquals(status, 404);
  assertEquals(trail(seen).length, 0);
});

// ── the race (fix round 1): a stateful fake with a row lock on the idea, so two callers really interleave ──────────────
const { reopenIdea } = await import("../ideas/repo.ts");
const tick = () => new Promise((r) => setTimeout(r, 0));
function stateful() {
  const st = { archived_at: "2026-11-01T00:00:00Z" as string | null, archived_from: "dirty" as string | null, status: "archived", lines: 0 };
  let holder: object | null = null;
  const waiters: (() => void)[] = [];
  const lock = async (me: object) => {
    while (holder && holder !== me) await new Promise<void>((r) => waiters.push(r));
    holder = me;
  };
  const unlock = (me: object) => { if (holder === me) { holder = null; waiters.splice(0).forEach((w) => w()); } };
  const mk = (me: object | null): Db => ({
    query: async (sql: string, args: unknown[] = []) => {
      await tick();
      if (/FROM public\.user_document_listings WHERE path/.test(sql)) {
        return [{ id: "d1", path: PATH, title: "T", updated_at: new Date(), refinery_id: IDEA, owner_sub: "operator" }] as never;
      }
      if (/FROM public\.ideas i LEFT JOIN public\.refinery_state/.test(sql)) {
        return [{ id: IDEA, status: st.status, archived_at: st.archived_at, archived_from: st.archived_from }] as never;
      }
      if (/FROM public\.ideas WHERE id = .*FOR UPDATE/.test(sql)) {
        if (me) await lock(me);
        return [{ status: st.status }] as never;
      }
      if (/SELECT archived_from FROM public\.refinery_state/.test(sql)) return [{ archived_from: st.archived_from }] as never;
      if (/UPDATE public\.refinery_state SET archived_at = NULL/.test(sql)) {
        const was = st.archived_at;
        const from = st.archived_from;
        if (/archived_at IS NOT NULL/.test(sql) && !was) return [] as never;
        st.archived_at = null; st.archived_from = null;
        void from; // RETURNING is the row AFTER the update: archived_from is NULL there
        return (/RETURNING archived_from/.test(sql) ? [{ archived_from: null }] : /RETURNING/.test(sql) ? [{ refinery_id: IDEA }] : []) as never;
      }
      if (/UPDATE public\.ideas SET status/.test(sql)) { st.status = String(args[1]); return [] as never; }
      if (/INSERT INTO public\.user_document_trail/.test(sql)) { st.lines++; return [] as never; }
      return [] as never;
    },
    tx: async (fn: (d: Db) => Promise<unknown>) => {
      const me = {};
      try { return await fn(mk(me)); } finally { unlock(me); }
    },
  }) as never;
  return { st, db: mk(null) };
}

Deno.test("rw-idea-reopen-trail: two concurrent refinery opens of an archived refinery write ONE line; one answers reopened:true", async () => {
  for (let i = 0; i < 5; i++) {
    const { st, db } = stateful();
    const rs = await Promise.all([reopenRefinery(deps(db), PATH, who), reopenRefinery(deps(db), PATH, who)]);
    assertEquals(st.lines, 1, `round ${i}`);
    assertEquals(rs.map((r) => r.reopened).sort(), [false, true], `round ${i}`);
    assertEquals(st.status, "dirty", `round ${i}: the state it was archived from comes back`);
  }
});

Deno.test("rw-idea-reopen-trail: a refinery open racing POST /ideas/{id}/reopen writes ONE line", async () => {
  for (let i = 0; i < 8; i++) { // i = how many ticks the by-id route starts after the refinery open
    const { st, db } = stateful();
    const delayed = async () => { for (let k = 0; k < i; k++) await tick(); return await reopenIdea(db, IDEA, who); };
    const rs = await Promise.allSettled([delayed(), reopenRefinery(deps(db), PATH, who)]);
    assertEquals(st.lines, 1, `round ${i}`);
    const open = rs[1];
    const byId = rs[0];
    // exactly one of the two reopened: the by-id route 409s when it lost, the refinery open answers reopened:false
    const byIdWon = byId.status === "fulfilled";
    const openWon = open.status === "fulfilled" && open.value.reopened === true;
    assert(byIdWon !== openWon, `round ${i}: byIdWon=${byIdWon} openWon=${openWon}`);
  }
});

Deno.test("rw-idea-reopen-trail (fix round 2): reopening a PROMOTED, archived refinery restores 'promoted', not 'engaged'", async () => {
  const { db, seen } = fake("2026-11-01T00:00:00Z", "operator", "promoted");
  const out = await reopenRefinery(deps(db), PATH, who);
  assertEquals(out.reopened, true);
  const set = seen.find((s) => /UPDATE public\.ideas SET status/.test(s.sql))!;
  assertEquals(set.args[1], "promoted");
  // an archive that left no stamp still comes back engaged
  const none = fake("2026-11-01T00:00:00Z", "operator", null as never);
  await reopenRefinery(deps(none.db), PATH, who);
  assertEquals(none.seen.find((s) => /UPDATE public\.ideas SET status/.test(s.sql))!.args[1], "engaged");
});
