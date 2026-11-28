// rwr-research-sources (workbench half): the Start research door carries `sources` (credible | community), preset from
// the person's own research.sources_default, and refuses `community` with 403 and a plain reason when the admin
// switch research.community_allowed is off. GET /workbench/research/options tells the dialog both. Over fakes.
//   deno test --allow-all src/contracts/research_sources_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Context } from "hono";
import type { Db } from "./db.ts";
import { newApp } from "./routes/http.ts";
import { registerResearchStart } from "./routes/research_start.ts";
import type { DoorClient } from "./repo/research_start.ts";
import type { Identity } from "../middleware/identity.ts";
import { COMMUNITY_OFF_REASON, parseStart } from "./logic/research_start.ts";
import { BadRequest } from "./logic/scope.ts";

const A = "sub-alice-0001", B = "sub-bob-0002";

function rig(o: { defaults?: Record<string, unknown>; allowed?: unknown; adminReadFails?: boolean } = {}) {
  const calls: Array<{ op: string; body: Record<string, unknown> }> = [];
  const db: Db = {
    query: (text: string, args: unknown[] = []) => {
      if (/setting_get/.test(text) && args[1] === "research.community_allowed") {
        if (o.adminReadFails) return Promise.reject(new Error("db down")) as never;
        return Promise.resolve(o.allowed === undefined ? [{ v: null }] : [{ v: o.allowed }]) as never;
      }
      if (/setting_get/.test(text) && args[1] === "research.sources_default") {
        const v = o.defaults?.[String(args[0])];
        return Promise.resolve([{ v: v === undefined ? null : v }]) as never;
      }
      return Promise.resolve([]) as never;
    },
    tx: (fn) => fn(db),
  };
  const SHOWN = { ok: true, question: "What helps heat pump noise?", topic: "heat pump noise", links: [], depth: null };
  const door: DoorClient = {
    preview: (b) => { calls.push({ op: "preview", body: b }); return Promise.resolve({ status: 200, body: { ...SHOWN, sources: (b.run as Record<string, unknown>).sources } }); },
    start: (b) => { calls.push({ op: "start", body: b }); return Promise.resolve({ status: 202, body: { job_id: "d0d0d0d0-0000-4000-8000-0000000000aa", ...SHOWN, sources: (b.run as Record<string, unknown>).sources } }); },
  };
  const app = newApp();
  registerResearchStart(app, { db } as never, {
    door, readDoc: () => Promise.resolve(null),
    identity: (c: Context) => Promise.resolve({ sub: c.req.header("x-test-sub") ?? A, actor: A, name: A, key: A, kind: "header" } as Identity),
    newId: () => "start-id-1",
  });
  const post = (path: string, body: unknown, sub = A) => app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-test-sub": sub }, body: JSON.stringify(body) });
  const get = (path: string, sub = A) => app.request(path, { headers: { "x-test-sub": sub } });
  const sent = () => calls.map((c) => (c.body.run as Record<string, unknown>).sources);
  return { post, get, calls, sent };
}

Deno.test("parseStart: sources is credible or community, optional; anything else is a 400", () => {
  assertEquals(parseStart({ question: "q", sources: "community" }).sources, "community");
  assertEquals(parseStart({ question: "q" }).sources, undefined);
  for (const bad of ["all", "Community", 1, null]) {
    let threw = false;
    try { parseStart({ question: "q", sources: bad }); } catch (e) { threw = e instanceof BadRequest; }
    assert(threw, `refused ${JSON.stringify(bad)}`);
  }
});

Deno.test("no choice and no saved default: the run is credible only, and the answer says so", async () => {
  const r = rig();
  const res = await r.post("/workbench/research", { question: "heat pump noise?" });
  assertEquals(res.status, 202);
  assertEquals((await res.json()).sources, "credible");
  assertEquals(r.sent(), ["credible"]);
});

Deno.test("the person's own default presets the run; another person's never does", async () => {
  const r = rig({ defaults: { [A]: "community" } });
  await r.post("/workbench/research", { question: "q" }, A);
  await r.post("/workbench/research", { question: "q" }, B);
  assertEquals(r.sent(), ["community", "credible"]);
});

Deno.test("an explicit choice wins over the default", async () => {
  const r = rig({ defaults: { [A]: "community" } });
  await r.post("/workbench/research/preview", { question: "q", sources: "credible" });
  assertEquals(r.sent(), ["credible"]);
});

Deno.test("admin switch off: community is refused with 403 and a plain reason, through preview and start; nothing reaches the door", async () => {
  const r = rig({ allowed: false });
  for (const path of ["/workbench/research/preview", "/workbench/research"]) {
    const res = await r.post(path, { question: "q", sources: "community" });
    assertEquals(res.status, 403);
    const j = await res.json();
    assertEquals(j.error, COMMUNITY_OFF_REASON);
    assertEquals(j.code, "community_off");
  }
  assertEquals(r.calls.length, 0);
  // credible still starts
  assertEquals((await r.post("/workbench/research", { question: "q", sources: "credible" })).status, 202);
});

Deno.test("admin switch off and a saved community default: the run falls back to credible (the choice is disabled)", async () => {
  const r = rig({ allowed: false, defaults: { [A]: "community" } });
  assertEquals((await r.post("/workbench/research", { question: "q" })).status, 202);
  assertEquals(r.sent(), ["credible"]);
});

Deno.test("the admin switch cannot be read: community is refused (fail closed)", async () => {
  const r = rig({ adminReadFails: true });
  assertEquals((await r.post("/workbench/research", { question: "q", sources: "community" })).status, 403);
});

Deno.test("GET /workbench/research/options: the person's default and whether community is allowed, with the reason", async () => {
  const on = await (await rig({ defaults: { [A]: "community" } }).get("/workbench/research/options")).json();
  assertEquals(on, { sources_default: "community", community_allowed: true, reason: null });
  const off = await (await rig({ allowed: false, defaults: { [A]: "community" } }).get("/workbench/research/options")).json();
  assertEquals(off, { sources_default: "credible", community_allowed: false, reason: COMMUNITY_OFF_REASON });
});
