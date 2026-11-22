// deno test -A src/routes/documents_lifecycle_scope_test.ts - the JSON-only (415) rule of
// rwr-docs-lifecycle-api reaches this item's three routes and nothing else (round 2, review R1).
// The lifecycle router is mounted exactly as src/app.ts mounts it: first, at /workbench/documents, beside a
// second router at the same prefix. That second router stands in for documentsRouter with the same POST
// routes the review named; it answers 299 when its handler runs. Any 415 on those routes fails the test.
// The real handlers over HTTP are lifecycle_integration_test.ts L10.
import { assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import { documentsLifecycleRouter, jsonOnly } from "./documents_lifecycle.ts";

const reached: string[] = [];
const stand = new Hono();
for (const p of ["/", "/reconcile", "/folders", "/trash", "/restore", "/archive", "/move", "/references/:id/repin"]) {
  stand.post(p, (c) => {
    reached.push(p);
    return c.json({ reached: p }, 299 as never);
  });
}
const app = new Hono();
app.route("/workbench/documents", documentsLifecycleRouter({ db: { query: () => Promise.resolve([]) } as never, reg: {} as never } as never));
app.route("/workbench/documents", stand);

const D = "http://lab/workbench/documents";
const post = (path: string, init: { ct?: string; body?: string } = {}) =>
  app.request(D + path, {
    method: "POST",
    headers: init.ct ? { "content-type": init.ct } : {},
    body: init.body,
  });

Deno.test("R1: every other POST under /workbench/documents/* is untouched by the JSON-only rule (body-less and text/plain still reach the handler)", async () => {
  const cases: [string, { ct?: string; body?: string }, string][] = [
    ["/reconcile", {}, "/reconcile"], // body-less by design
    ["/references/ref-1/repin?path=documents%2Fx%2Fa.md", {}, "/references/:id/repin"], // its input is the query
    ["", { ct: "text/plain", body: JSON.stringify({ title: "t", body: "b" }) }, "/"], // create
    ["/trash", { ct: "text/plain", body: JSON.stringify({ path: "documents/x/a.md" }) }, "/trash"],
    ["/folders", { ct: "text/plain", body: JSON.stringify({ path: "f" }) }, "/folders"],
    ["/restore", { ct: "application/x-www-form-urlencoded", body: "path=x" }, "/restore"],
    ["/archive", {}, "/archive"],
    ["/move", { ct: "text/plain", body: "{}" }, "/move"],
  ];
  for (const [path, init, route] of cases) {
    reached.length = 0;
    const r = await post(path, init);
    const text = await r.text();
    if (r.status === 415) throw new Error(`POST ${path || "/"} got 415 (${text}): the JSON-only rule reached a route outside this item`);
    assertEquals(r.status, 299, `POST ${path || "/"}: ${text}`);
    assertEquals(reached, [route], `POST ${path || "/"} reached its own handler`);
  }
});

Deno.test("R1: the item's three routes still refuse a non-JSON or missing body with 415, before the handler", async () => {
  for (const p of ["/unarchive", "/delete-forever", "/empty-trash"]) {
    for (const init of [{}, { ct: "text/plain", body: JSON.stringify({ path: "documents/x/.trash/a.md", confirm: true }) }, { ct: "application/x-www-form-urlencoded", body: "confirm=true" }]) {
      reached.length = 0;
      const r = await post(p, init);
      assertEquals(r.status, 415, `${p} ${JSON.stringify(init)}`);
      assertEquals((await r.json()).error, "this route takes application/json");
      assertEquals(reached, [], "nothing else ran");
    }
  }
});

Deno.test("R1: jsonOnly lets a JSON (or +json) body through to the handler", async () => {
  const one = new Hono();
  one.post("/x", jsonOnly, (c) => c.json({ ok: true }));
  for (const ct of ["application/json", "application/json; charset=utf-8", "application/merge-patch+json", "APPLICATION/JSON"]) {
    const r = await one.request("http://lab/x", { method: "POST", headers: { "content-type": ct }, body: "{}" });
    assertEquals(r.status, 200, ct);
    await r.text();
  }
});
