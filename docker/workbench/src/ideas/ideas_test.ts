// rw-p8a4-ideas: the ideas writes, over a fake database (the real one is ideas_integration_test.ts, in the P2b lab).
// What is pinned here: every write is ONE call of the owner-checked SQL function (the same the MCP idea tools call),
// with the identity seam's subject as the owner - never a caller-supplied user - and nothing writes `ideas` or
// `idea_revisions` directly; another owner's idea answers exactly like none (404); an archived refinery is 409.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import type { Db } from "../contracts/db.ts";
import { ideasRouter } from "./routes.ts";
import { ideaId, IdeaError, parseDraft, parseEdit, refuse } from "./repo.ts";

const ID = "a1000000-0000-4000-8000-0000000000a1";

function fakeDb(outcome: Record<string, unknown>, own = true) {
  const seen: { sql: string; args: unknown[] }[] = [];
  const db: Db = {
    query: (sql: string, args: unknown[] = []) => {
      seen.push({ sql, args });
      if (/FROM public\.ideas WHERE id = \$1::uuid AND owner_sub = \$2/.test(sql)) return Promise.resolve(own ? [{ title: "t", status: "new" }] : [] as never);
      if (/INSERT INTO public\.thoughts/.test(sql)) return Promise.resolve([{ id: "42" }] as never);
      if (/public\.idea_room\(/.test(sql)) return Promise.resolve([{ r: "c1000000-0000-4000-8000-0000000000c1" }] as never);
      if (/UPDATE public\.workspace_rooms SET draft/.test(sql)) return Promise.resolve([{ id: "c1000000-0000-4000-8000-0000000000c1", draft_updated_at: "now" }] as never);
      return Promise.resolve([{ o: outcome }] as never);
    },
    tx: (fn: (d: Db) => Promise<unknown>) => fn(db),
  } as never;
  return { db, seen };
}

const json = (b: unknown) => ({ method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json", "X-Who": "evil" } });
const app = (db: Db) => new Hono().route("/i", ideasRouter({ db, embed: () => Promise.resolve([0.1, 0.2]) }));

Deno.test("rw-p8a4-ideas: the parsers refuse what is not an idea edit or a draft", () => {
  const bad = (f: () => unknown) => {
    try { f(); return false; } catch (e) { return e instanceof IdeaError && e.status === 400; }
  };
  assert(bad(() => parseEdit({})));
  assert(bad(() => parseEdit({ summary: "   " })));
  assert(bad(() => parseEdit({ summary: "x".repeat(20001) })));
  assert(bad(() => parseEdit({ summary: "ok", title: 3 })));
  assertEquals(parseEdit({ summary: " new text ", title: " T " }), { summary: "new text", title: "T" });
  assertEquals(parseEdit({ summary: "x" }), { summary: "x", title: null });
  assert(bad(() => parseDraft({ text: 1 })));
  assertEquals(parseDraft({ text: "" }), "");
  // an id that cannot exist reads exactly like one that does not
  try { ideaId("../etc"); assert(false); } catch (e) { assertEquals((e as IdeaError).status, 404); }
  assertEquals(ideaId(ID.toUpperCase()), ID);
});

Deno.test("rw-p8a4-ideas: refuse() maps the function's outcomes - another owner's idea 404, an archived refinery 409", () => {
  const st = (o: string) => { try { refuse({ outcome: o as never }); return 200; } catch (e) { return (e as IdeaError).status; } };
  assertEquals([st("not_found"), st("archived"), st("changed"), st("unchanged"), st("queued")], [404, 409, 200, 200, 200]);
});

Deno.test("rw-p8a4-ideas: edit is ONE idea_edit() call with the seam's subject and its corpus thought in the same transaction; no direct write of ideas / idea_revisions", async () => {
  const { db, seen } = fakeDb({ outcome: "changed", revision: 2, title: "t" });
  const r = await app(db).request(`/i/${ID}/edit`, json({ summary: "the new text", owner_sub: "someone-else", sub: "x" }));
  assertEquals(r.status, 200);
  assertEquals((await r.json()).outcome, "changed");
  const calls = seen.filter((s) => /idea_edit\(/.test(s.sql));
  assertEquals(calls.length, 1);
  assertEquals(calls[0].args.slice(0, 4), [ID, "operator", "operator", "the new text"]); // the seam's default subject + actor
  // the revision's corpus thought is this door's, written first in the same transaction (the memory plane reads it)
  assertEquals(calls[0].args[6], "42");
  const th = seen.find((s) => /INSERT INTO public\.thoughts/.test(s.sql))!;
  assertEquals([th.args[0], th.args[3]], ["the new text", "ops"]);
  assert(seen.indexOf(th) < seen.indexOf(calls[0]));
  assertEquals(seen.filter((s) => /(INSERT INTO|UPDATE) public\.(ideas|idea_revisions)\b/.test(s.sql)).length, 0);
});

Deno.test("rw-p8a4-ideas: an unchanged edit keeps no thought (the transaction is rolled back)", async () => {
  const seen: string[] = [];
  let rolled = false;
  const inner: Db = {
    query: (sql: string) => {
      seen.push(sql);
      if (/INSERT INTO public\.thoughts/.test(sql)) return Promise.resolve([{ id: "42" }] as never);
      if (/idea_edit\(/.test(sql)) return Promise.resolve([{ o: { outcome: "unchanged", revision: 1 } }] as never);
      return Promise.resolve([{ title: "t" }] as never);
    },
    tx: async (fn: (d: Db) => Promise<unknown>) => {
      try { return await fn(inner); } catch (e) { rolled = true; throw e; }
    },
  } as never;
  const r = await app(inner).request(`/i/${ID}/edit`, json({ summary: "same" }));
  assertEquals([r.status, (await r.json()).outcome, rolled], [200, "unchanged", true]);
});

Deno.test("rw-p8a4-ideas: another owner's idea is 404 on every write, before any function runs", async () => {
  for (const [path, init] of [[`/i/${ID}/edit`, json({ summary: "x" })], [`/i/${ID}/draft`, { ...json({ text: "d" }), method: "PUT" }]] as const) {
    const { db, seen } = fakeDb({ outcome: "changed" }, false);
    const r = await app(db).request(path, init);
    assertEquals(r.status, 404, path);
    assertEquals(seen.filter((s) => /idea_edit\(|UPDATE public\.workspace_rooms/.test(s.sql)).length, 0, path);
  }
  // research now: the function itself is the check (not_found)
  const { db } = fakeDb({ outcome: "not_found" });
  assertEquals((await app(db).request(`/i/${ID}/research-now`, json({}))).status, 404);
});

Deno.test("rw-p8a4-ideas: research now is ONE idea_research() call; an archived refinery is 409", async () => {
  const q = fakeDb({ outcome: "queued", job_id: "j" });
  const r = await app(q.db).request(`/i/${ID}/research-now`, json({ owner: "x" }));
  assertEquals(r.status, 202);
  const calls = q.seen.filter((s) => /idea_research\(/.test(s.sql));
  assertEquals(calls.length, 1);
  assertEquals(calls[0].args, [ID, "operator", "operator"]);
  const a = fakeDb({ outcome: "archived" });
  const ra = await app(a.db).request(`/i/${ID}/research-now`, json({}));
  assertEquals(ra.status, 409);
  assertEquals((await ra.json()).code, "refinery-archived");
});

Deno.test("rw-p8a4-ideas: the draft is a field on the idea's room (idea_room), written for the caller only", async () => {
  const { db, seen } = fakeDb({});
  const r = await app(db).request(`/i/${ID}/draft`, { ...json({ text: "accreting" }), method: "PUT" });
  assertEquals(r.status, 200);
  const up = seen.find((s) => /UPDATE public\.workspace_rooms SET draft/.test(s.sql))!;
  assert(/owner_sub = \$2/.test(up.sql));
  assertEquals(up.args.slice(1, 3), ["operator", "accreting"]);
});

Deno.test("rw-p8a4-ideas round 2: the draft of an archived refinery is refused (409), nothing written", async () => {
  const seen: string[] = [];
  const db: Db = {
    query: (sql: string) => {
      seen.push(sql);
      if (/SELECT status FROM public\.ideas/.test(sql)) return Promise.resolve([{ status: "archived" }] as never);
      return Promise.resolve([] as never);
    },
    tx: (fn: (d: Db) => Promise<unknown>) => fn(db),
  } as never;
  const r = await app(db).request(`/i/${ID}/draft`, { ...json({ text: "while resting" }), method: "PUT" });
  assertEquals([r.status, (await r.json()).code], [409, "refinery-archived"]);
  assertEquals(seen.filter((s) => /UPDATE public\.workspace_rooms|idea_room\(/.test(s)).length, 0);
});
