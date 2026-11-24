// rwr-idea-archive-api: POST /workbench/ideas/{id}/archive and /reopen over a fake database (the real one is
// ideas_integration_test.ts [AR*], in the P2b lab). Pinned here: both act for the seam's subject only (every statement is
// owner-filtered and carries the subject, never a header or a body field); another user's idea is 404 with the body of an idea
// that does not exist; archive of an archived idea and reopen of an open one are 409; the archive stamps archived_from and
// reopen restores exactly that; the write is inside one transaction on a locked row.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Db } from "../contracts/db.ts";
import { newApp } from "../contracts/routes/http.ts";
import { registerIdeaArchive } from "../contracts/routes/idea_archive.ts";

const ID = "a1000000-0000-4000-8000-0000000000a1";

interface Row { status: string; archived_from: string | null; owner: string }
function fakeDb(row: Row | null, guardRefuses = false) {
  const seen: { sql: string; args: unknown[] }[] = [];
  let txs = 0;
  const db: Db = {
    query: (sql: string, args: unknown[] = []) => {
      seen.push({ sql, args });
      if (/^\s*SELECT archived_from/i.test(sql)) return Promise.resolve((row && args[0] === ID ? [{ archived_from: row.archived_from }] : []) as never);
      if (/^\s*SELECT/i.test(sql)) {
        const mine = row && args.includes(row.owner) && args[0] === ID;
        return Promise.resolve((mine ? [{ status: row!.status, archived_from: row!.archived_from }] : []) as never);
      }
      if (guardRefuses && /UPDATE public\.ideas SET status = \$2/.test(sql)) {
        return Promise.reject(Object.assign(new Error("ideas: an idea is promoted only through idea_promote()"), { fields: { code: "42501", message: "ideas: an idea is promoted only through idea_promote()" } }));
      }
      return Promise.resolve([] as never);
    },
    tx: (fn: (d: Db) => Promise<unknown>) => { txs++; return fn(db); },
  } as never;
  return { db, seen, txs: () => txs };
}
function app(db: Db) {
  const a = newApp();
  registerIdeaArchive(a, { db, embed: () => Promise.resolve([]) } as never);
  return a;
}
const post = (path: string) => ({ method: "POST", body: "{}", headers: { "content-type": "application/json", "X-Test-Sub": "someone-else" } , path });
const go = (a: ReturnType<typeof app>, id: string, verb: string) =>
  a.request(`/workbench/ideas/${id}/${verb}`, { method: "POST", headers: { "X-Test-Sub": "someone-else", "content-type": "application/json" }, body: "{\"owner_sub\":\"x\"}" });

Deno.test("rwr-idea-archive-api: archive stamps archived_from and the status, in one transaction, for the seam's subject only", async () => {
  const { db, seen, txs } = fakeDb({ status: "researched", archived_from: null, owner: "operator" });
  const r = await go(app(db), ID, "archive");
  assertEquals(r.status, 200, await r.clone().text());
  assertEquals(await r.json(), { idea_id: ID, status: "archived", archived: true });
  assertEquals(txs(), 1);
  const stamp = seen.find((s) => /INSERT INTO public\.refinery_state/.test(s.sql))!;
  assertEquals(stamp.args, [ID, "researched"]);
  assert(seen.some((s) => /UPDATE public\.ideas SET status = 'archived'/.test(s.sql)));
  assert(/FOR UPDATE/.test(seen[0].sql) && /owner_sub = \$2/.test(seen[0].sql));
  assertEquals(seen[0].args, [ID, "operator"], "the seam's subject, not the X-Test-Sub header or the body");
});

Deno.test("rwr-idea-archive-api: reopen restores the state it was archived from and clears the stamp", async () => {
  const { db, seen } = fakeDb({ status: "archived", archived_from: "dirty", owner: "operator" });
  const r = await go(app(db), ID, "reopen");
  assertEquals(r.status, 200, await r.clone().text());
  assertEquals(await r.json(), { idea_id: ID, status: "dirty", archived: false });
  assertEquals(seen.find((s) => /UPDATE public\.ideas SET status = \$2/.test(s.sql))!.args, [ID, "dirty"]);
  assert(seen.some((s) => /SET archived_at = NULL, archived_from = NULL/.test(s.sql)));
});

Deno.test("rwr-idea-archive-api: an archive with no stamp reopens as engaged (as the document-path reopen)", async () => {
  const { db } = fakeDb({ status: "archived", archived_from: null, owner: "operator" });
  assertEquals((await (await go(app(db), ID, "reopen")).json()).status, "engaged");
});

Deno.test("rwr-idea-archive-api: another user's idea answers exactly like a missing or malformed id, and nothing is written", async () => {
  const missing = fakeDb(null);
  const foreign = fakeDb({ status: "researched", archived_from: null, owner: "someone-else" }); // the seam is 'operator'
  for (const verb of ["archive", "reopen"]) {
    const a = await go(app(missing.db), ID, verb);
    const b = await go(app(foreign.db), ID, verb);
    const c = await go(app(missing.db), "not-an-id", verb);
    assertEquals([b.status, await b.clone().text()], [a.status, await a.clone().text()], verb);
    assertEquals([c.status, await c.clone().text()], [a.status, await a.clone().text()], verb);
    assertEquals(a.status, 404);
  }
  for (const f of [foreign, missing]) assertEquals(f.seen.filter((s) => !/^\s*SELECT/i.test(s.sql)).length, 0);
});

Deno.test("rwr-idea-archive-api: archive of an archived idea and reopen of an open one are 409 and write nothing", async () => {
  const arch = fakeDb({ status: "archived", archived_from: "new", owner: "operator" });
  const r1 = await go(app(arch.db), ID, "archive");
  assertEquals([r1.status, (await r1.json()).code], [409, "already-archived"]);
  const open = fakeDb({ status: "new", archived_from: null, owner: "operator" });
  const r2 = await go(app(open.db), ID, "reopen");
  assertEquals([r2.status, (await r2.json()).code], [409, "not-archived"]);
  for (const f of [arch, open]) assertEquals(f.seen.filter((s) => !/^\s*SELECT/i.test(s.sql)).length, 0);
});

Deno.test("rwr-idea-archive-api: a promoted idea whose document is no longer its own is 409 on reopen, not a 500", async () => {
  const { db } = fakeDb({ status: "archived", archived_from: "promoted", owner: "operator" }, true);
  const r = await go(app(db), ID, "reopen");
  assertEquals([r.status, (await r.json()).code], [409, "cannot-reopen"]);
});

Deno.test("rwr-idea-archive-api: both routes are user-only paths (a service key is 403 before the route runs)", async () => {
  const { USER_ONLY } = await import("../middleware/identity.ts");
  for (const verb of ["archive", "reopen"]) assert(USER_ONLY.test(`/workbench/ideas/${ID}/${verb}`), verb);
});

Deno.test("rwr-idea-archive-api: reopen locks the idea row alone and reads archived_from in a LATER statement (a join keeps the pre-wait snapshot)", async () => {
  const { db, seen } = fakeDb({ status: "archived", archived_from: "dirty", owner: "operator" });
  await go(app(db), ID, "reopen");
  const lock = seen.findIndex((s) => /FOR UPDATE/.test(s.sql));
  assert(lock === 0 && !/refinery_state/.test(seen[lock].sql), "the locking statement names no other table");
  const read = seen.findIndex((s) => /SELECT archived_from FROM public\.refinery_state/.test(s.sql));
  assert(read > lock, "the stamp is read after the lock");
});

Deno.test("rwr-idea-archive-api: only the write guard's own refusal becomes cannot-reopen; any other 42501 is not mislabelled", async () => {
  const seen: string[] = [];
  const db = {
    query: (sql: string, args: unknown[] = []) => {
      if (/^\s*SELECT status/i.test(sql)) return Promise.resolve([{ status: "archived" }] as never);
      if (/^\s*SELECT archived_from/i.test(sql)) return Promise.resolve([{ archived_from: "dirty" }] as never);
      if (/UPDATE public\.ideas SET status = \$2/.test(sql)) return Promise.reject(Object.assign(new Error("permission denied for table ideas"), { fields: { code: "42501", message: "permission denied for table ideas" } }));
      seen.push(sql); void args;
      return Promise.resolve([] as never);
    },
    tx: (fn: (d: Db) => Promise<unknown>) => fn(db as never),
  } as never as Db;
  const r = await go(app(db), ID, "reopen");
  assertEquals(r.status, 500, "an unrelated permission error stays an internal error, not a 409 about promotion");
});
