// deno test src/middleware/body_size_lab_test.ts - rw-body-size-stall, the lab case: on a REAL workbench, a signed-in non-admin
// sending a large write body is refused 413 within a second through BOTH doors (the workbench itself, and the viewer's
// /workbench forwarder, the edge's one port) on EVERY write route the router registers (enumerated from src/app.ts, no hand
// list), and the workbench answers other people meanwhile; a body under the cap is checked in under a second at 40 KB,
// 160 KB, 1 MB and the cap itself; the refusals that worked before still work on a big body; a settings version over the
// database's INT is a 400 (not a 500).
//
// SKIPPED unless BODY_BASE and BODY_VIEWER are set. contract-test/run-workspace-tests.ps1 [5d0] runs it in its DISPOSABLE lab
// (before the isolation sweep). Never point it at a live stack.
// Environment: BODY_BASE (the workbench), BODY_VIEWER (the viewer), DOCS_TEST_KEY, plus the workbench's own DB_* /
// WIKI_GIT_DIR / OPEN_BRAIN_* so src/app.ts can be imported to read its route table (it is never served here).
import { assert, assertEquals } from "jsr:@std/assert@1";

const BASE = (Deno.env.get("BODY_BASE") ?? "").replace(/\/+$/, "");
const VIEWER = (Deno.env.get("BODY_VIEWER") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("DOCS_TEST_KEY") ?? "";
const SUB_HEADER = Deno.env.get("DOCS_TEST_SUB_HEADER") ?? "X-Test-Sub";
const ignore = !BASE || !VIEWER;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });

const CAP = 4 * 1024 * 1024; // the default WORKBENCH_MAX_BODY_BYTES; the lab sets none
const doors: [string, string][] = [["workbench", BASE], ["viewer", VIEWER]];
const rnd = () => crypto.randomUUID().slice(0, 8);
const person = () => ({ [SUB_HEADER]: `bodysize-${rnd()}` }); // a non-admin: not the default subject

function req(door: string, method: string, path: string, body: string | undefined, who: Record<string, string>, ct = "application/json") {
  return fetch(door + path, {
    method, redirect: "manual",
    headers: { "content-type": ct, "x-brain-key": KEY, ...(door === VIEWER ? { origin: VIEWER } : {}), ...who },
    body,
  });
}
const timed = async (f: () => Promise<Response>) => {
  const t0 = performance.now();
  const r = await f();
  await r.arrayBuffer();
  return { status: r.status, ms: performance.now() - t0 };
};
const big = (bytes: number) => JSON.stringify({ label: "a".repeat(bytes - 14) });

t("every write route refuses an over-the-cap body with 413 within 1 s, through both doors, and the workbench answers meanwhile", async () => {
  const { app } = await import(new URL("../app.ts", import.meta.url).href);
  const seen = new Set<string>();
  const routes = (app.routes as { method: string; path: string }[])
    .filter((r) => ["POST", "PUT", "PATCH", "DELETE"].includes(r.method) && !r.path.endsWith("*"))
    .filter((r) => { const k = `${r.method} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
  assert(routes.length > 40, `the router lists ${routes.length} write routes`);
  const fill = (p: string) => p.replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, (_m, _n, re) => (re && re.includes(".")) ? "x/y.md" : "x");
  const body = big(CAP + 1);
  const bad: string[] = [];
  let calls = 0;
  for (const [name, door] of doors) {
    const who = person();
    for (const r of routes) {
      calls++;
      // a bystander reads while the big one is in flight: it must not wait on it
      const [big1, other] = await Promise.all([
        timed(() => req(door, r.method, fill(r.path), body, who)),
        timed(() => req(door, "GET", "/workbench/workspace/whoami", undefined, person())),
      ]);
      if (big1.status !== 413 || big1.ms > 1000) bad.push(`${name} ${r.method} ${r.path} -> ${big1.status} in ${big1.ms.toFixed(0)} ms`);
      if (other.status !== 200 || other.ms > 1000) bad.push(`${name} bystander during ${r.method} ${r.path} -> ${other.status} in ${other.ms.toFixed(0)} ms`);
    }
  }
  console.log(`body-size: ${routes.length} write routes x 2 doors = ${calls} oversized calls, ${bad.length} failures`);
  assertEquals(bad, [], bad.slice(0, 20).join("\n"));
});

t("the 413 answer is the plain message, as JSON", async () => {
  for (const [, door] of doors) {
    const r = await req(door, "PUT", "/workbench/settings/ui.x", big(CAP + 1), person());
    assertEquals(r.status, 413);
    assertEquals((await r.json()).error, `the request is too large (at most ${CAP} bytes)`);
  }
});

t("a body under the cap is checked in under 1 s at 40 KB, 160 KB, 1 MB and the cap itself, through both doors", async () => {
  const rows: string[] = [];
  for (const [name, door] of doors) {
    for (const n of [40_000, 160_000, 1_000_000, CAP]) {
      const r = await timed(() => req(door, "POST", "/workbench/documents/trash", big(n), person()));
      rows.push(`${name} ${n} bytes -> ${r.status} in ${r.ms.toFixed(0)} ms`);
      assert(r.status !== 413 && r.status < 500, rows.at(-1)!);
      assert(r.ms < 1000, rows.at(-1)!);
    }
  }
  console.log("body-size timing:\n  " + rows.join("\n  "));
});

t("a long string of ../ units and a hidden foreign path in a big body: still refused, and fast", async () => {
  for (const [, door] of doors) {
    for (const hidden of ["documents/someone-else/x.md", "../".repeat(40_000) + "documents/someone-else/x.md"]) {
      const r = await timed(() => req(door, "POST", "/workbench/documents/trash", JSON.stringify({ path: hidden, label: "a".repeat(150_000) }), person()));
      assertEquals(r.status, 404);
      assert(r.ms < 1000, `${r.ms} ms`);
    }
  }
});

t("a settings version over the database's INT is a 400, not a 500", async () => {
  for (const [, door] of doors) {
    for (const v of [2147483648, 9007199254740991]) {
      const r = await req(door, "PUT", "/workbench/settings/refinery.dormancy_days", JSON.stringify({ value: 9, version: v }), person());
      assertEquals(r.status, 400, `version ${v}`);
      await r.arrayBuffer();
    }
  }
});
