// rwr-idea-capture-api: POST /workbench/ideas over a fake database (the real one is ideas_integration_test.ts [C*], in
// the P2b lab). What is pinned here: the capture is ONE call of idea_capture() - the owner-checked SQL function
// openbrain-mcp's capture_idea calls - with the identity seam's subject as owner and actor, never a user the request
// names (a body naming an owner is refused before anything runs); nothing writes ideas / idea_revisions / thoughts
// directly; the answer says whether research was queued now or waits for the owner's schedule, read for that owner only.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Db } from "../contracts/db.ts";
import { newApp } from "../contracts/routes/http.ts";
import { registerIdeaCapture } from "../contracts/routes/idea_capture.ts";
import { parseCapture, IdeaError } from "./repo.ts";

const ID = "a1000000-0000-4000-8000-0000000000a1";
const JOB = "d1000000-0000-4000-8000-0000000000d1";

interface Opts { deferred?: boolean; mode?: string | null; next?: string | null }
function fakeDb(o: Opts = {}) {
  const seen: { sql: string; args: unknown[] }[] = [];
  const db: Db = {
    query: (sql: string, args: unknown[] = []) => {
      seen.push({ sql, args });
      if (/public\.idea_capture\(/.test(sql)) return Promise.resolve([{ id: ID }] as never);
      if (/FROM public\.ideas i\s+JOIN public\.idea_revisions r/.test(sql)) {
        return Promise.resolve([{ title: "the title", status: "new", job_id: o.deferred ? null : JOB, deferred: !!o.deferred }] as never);
      }
      if (/FROM public\.idea_schedule/.test(sql)) {
        return Promise.resolve((o.mode ? [{ mode: o.mode, next_start: o.next ?? null }] : []) as never);
      }
      return Promise.resolve([] as never);
    },
    tx: (fn: (d: Db) => Promise<unknown>) => fn(db),
  } as never;
  return { db, seen };
}

function app(db: Db, embed: (t: string) => Promise<number[]> = () => Promise.resolve([0.1, 0.2])) {
  const a = newApp();
  registerIdeaCapture(a, { db, embed } as never);
  return a;
}
const post = (b: unknown) => ({
  method: "POST", body: typeof b === "string" ? b : JSON.stringify(b),
  headers: { "content-type": "application/json", "X-Test-Sub": "someone-else" },
});

Deno.test("rwr-idea-capture-api: the parser takes summary and an optional title, nothing else", () => {
  const bad = (b: unknown) => { try { parseCapture(b as never); return false; } catch (e) { return e instanceof IdeaError && e.status === 400; } };
  assert(bad({}));
  assert(bad({ summary: "   " }));
  assert(bad({ summary: "x".repeat(20001) }));
  assert(bad({ summary: "ok", title: 3 }));
  assertEquals(parseCapture({ summary: " the idea ", title: " T " }), { summary: "the idea", title: "T" });
  assertEquals(parseCapture({ summary: "x" }), { summary: "x", title: null });
});

Deno.test("rwr-idea-capture-api: a capture is ONE idea_capture() call with the seam's subject and actor; no direct write of ideas / idea_revisions / thoughts", async () => {
  const { db, seen } = fakeDb();
  const r = await app(db).request("/workbench/ideas", post({ summary: "my private idea", title: "Mine" }));
  assertEquals(r.status, 201, await r.clone().text());
  const calls = seen.filter((s) => /public\.idea_capture\(/.test(s.sql));
  assertEquals(calls.length, 1);
  // no identity seam mounted: the seam's default subject - never the X-Test-Sub the client sent, never a body field
  assertEquals(calls[0].args.slice(0, 4), ["operator", "operator", "Mine", "my private idea"]);
  assertEquals(calls[0].args[4], null, "no domain: the function's default");
  assertEquals(calls[0].args[5], "[0.1,0.2]", "the embedding of title + text (dedup / resurfacing)");
  assertEquals(seen.filter((s) => /thoughts/.test(s.sql)).length, 0, "nothing touches the thought corpus");
  assertEquals(seen.filter((s) => /(INSERT INTO|UPDATE|DELETE FROM) public\.(ideas|idea_revisions)\b/.test(s.sql)).length, 0);
  // every read after the capture is filtered by the same subject
  for (const s of seen.filter((s) => !/idea_capture\(/.test(s.sql))) {
    assert(/owner_sub = \$\d/.test(s.sql), `an owner-filtered read: ${s.sql.slice(0, 80)}`);
    assert(s.args.includes("operator"));
  }
});

Deno.test("rwr-idea-capture-api: a body naming an owner (or any other field) is refused before anything runs", async () => {
  for (const extra of [{ owner_sub: "b" }, { owner: "b" }, { sub: "b" }, { user: "b" }, { actor_sub: "b" }, { domain: "x" }]) {
    const { db, seen } = fakeDb();
    const r = await app(db).request("/workbench/ideas", post({ summary: "x", ...extra }));
    assertEquals(r.status, 400, JSON.stringify(extra));
    assertEquals(seen.length, 0, `no SQL ran for ${JSON.stringify(extra)}`);
  }
});

Deno.test("rwr-idea-capture-api: refusals - an empty, missing or non-JSON body is 400, nothing runs", async () => {
  for (const b of [{}, { summary: "" }, { summary: 4 }, "not json", "", "[]"]) {
    const { db, seen } = fakeDb();
    const r = await app(db).request("/workbench/ideas", post(b));
    assertEquals(r.status, 400, JSON.stringify(b));
    assertEquals(seen.length, 0);
  }
});

Deno.test("rwr-idea-capture-api: immediate (the default, no schedule row) answers research queued with its job", async () => {
  const { db } = fakeDb();
  const r = await app(db).request("/workbench/ideas", post({ summary: "x" }));
  const j = await r.json();
  assertEquals(r.status, 201);
  assertEquals(j, { idea_id: ID, title: "the title", status: "new", research: { mode: "immediate", queued: true, job_id: JOB, next_start: null } });
});

Deno.test("rwr-idea-capture-api: a scheduled owner's idea waits - not queued, the next scheduled start named", async () => {
  const { db } = fakeDb({ deferred: true, mode: "daily", next: "2026-11-22T06:00:00.000Z" });
  const j = await (await app(db).request("/workbench/ideas", post({ summary: "x" }))).json();
  assertEquals(j.research, { mode: "daily", queued: false, job_id: null, next_start: "2026-11-22T06:00:00.000Z" });
});

Deno.test("rwr-idea-capture-api: an embedder that is down still captures the idea (no embedding), never a 500", async () => {
  const { db, seen } = fakeDb();
  const r = await app(db, () => Promise.reject(new Error("down"))).request("/workbench/ideas", post({ summary: "x" }));
  assertEquals(r.status, 201);
  assertEquals(seen.find((s) => /idea_capture\(/.test(s.sql))!.args[5], null);
});

Deno.test("rwr-idea-capture-api: a database error is a bare 'internal' - no SQL text, no idea text in the answer", async () => {
  const db: Db = { query: () => Promise.reject(new Error("boom: secret idea text")), tx: (f: (d: Db) => Promise<unknown>) => f(db) } as never;
  const r = await app(db).request("/workbench/ideas", post({ summary: "secret idea text" }));
  assertEquals(r.status, 500);
  assert(!(await r.text()).includes("secret"));
});

Deno.test("rwr-idea-capture-api: mounted as app.ts mounts it (the ideas router at /workbench/ideas first, the contract last), POST /workbench/ideas reaches the capture and /:id/edit still reaches the edit", async () => {
  const { Hono } = await import("hono");
  const { ideasRouter } = await import("./routes.ts");
  const { db, seen } = fakeDb();
  const contract = newApp();
  registerIdeaCapture(contract, { db, embed: () => Promise.resolve([0.1]) } as never);
  const root = new Hono();
  root.route("/workbench/ideas", ideasRouter({ db, embed: () => Promise.resolve([0.1]) }));
  root.route("/", contract);
  root.notFound((c) => c.json({ error: "not found" }, 404));
  assertEquals((await root.request("/workbench/ideas", post({ summary: "x" }))).status, 201);
  assertEquals(seen.filter((s) => /idea_capture\(/.test(s.sql)).length, 1);
  await root.request(`/workbench/ideas/${ID}/edit`, post({ summary: "y" }));
  assert(seen.some((s) => /owner_sub = \$2/.test(s.sql) && s.args[0] === ID), "the edit route still answers its path");
});
