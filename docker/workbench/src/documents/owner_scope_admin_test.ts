// deno test -A src/documents/owner_scope_admin_test.ts - the one exception the owner scope makes
// (rwr-docs-lifecycle-api): an admin's real sign-in may NAME another user's document on
// POST /workbench/documents/delete-forever (the route itself then requires it to be trashed). Nobody else,
// no other route, no other method, and not an impersonating admin.
import { assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import { ownerScope } from "../middleware/owner-scope.ts";
import type { Identity } from "../middleware/identity.ts";

const noRows = { query: () => Promise.resolve([]), tx: (f: (d: unknown) => unknown) => f(noRows) } as never;
const id = (sub: string, over: Partial<Identity> = {}): Identity => ({
  sub, actor: sub, name: sub, key: `k-${sub}`, kind: "user", admin: false, impersonating: null, ...over,
});
function appFor(who: Identity) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("identity" as never, who as never);
    await next();
  });
  app.use("/workbench/*", ownerScope(noRows));
  app.all("/workbench/documents/*", (c) => c.json({ reached: true }));
  return app;
}
const foreign = "documents/k-alice/.trash/notes/x.md";
const post = (app: Hono, path: string, method = "POST") =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify({ path: foreign, confirm: true }) });

Deno.test("a user naming another user's document is refused before any route (404)", async () => {
  const r = await post(appFor(id("bob")), "/workbench/documents/delete-forever");
  assertEquals(r.status, 404);
  assertEquals((await r.json()).error, "no such document");
});

Deno.test("an admin's real sign-in reaches delete-forever with another user's path", async () => {
  const r = await post(appFor(id("root", { admin: true })), "/workbench/documents/delete-forever");
  assertEquals(r.status, 200);
});

Deno.test("the exception is that route only: an admin is refused on every other documents route", async () => {
  for (const p of ["trash", "restore", "archive", "unarchive", "empty-trash", "move"]) {
    const r = await post(appFor(id("root", { admin: true })), `/workbench/documents/${p}`);
    assertEquals(r.status, 404, p);
  }
  // and a GET naming the path is not a delete-forever
  const g = await appFor(id("root", { admin: true })).request(`/workbench/documents/delete-forever?path=${foreign}`);
  assertEquals(g.status, 404);
});

Deno.test("an impersonating admin acts as the user: no exception", async () => {
  const imp = id("bob", { admin: true, actor: "root", impersonating: { reason: "r", since: "t" } });
  assertEquals((await post(appFor(imp), "/workbench/documents/delete-forever")).status, 404);
});
