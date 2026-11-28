// deno test src/util/multipart_test.ts - a form body is read once and parsed in a worker (rw-upload-store-offthread, fix round 2).
// Hermetic: no database, no network.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { closeMultipart, formOf, multipartSizeOf, parseStats } from "./multipart.ts";
import { work } from "./multipart_worker.ts";

const MiB = 1024 * 1024;
const opts = { sanitizeOps: false, sanitizeResources: false };
function pattern(n: number, seed = 7): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; b[i] = x >>> 24; }
  return b;
}
const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
async function post(parts: [string, string | { name: string; type?: string; bytes: Uint8Array }][]): Promise<Request> {
  const f = new FormData();
  for (const [k, v] of parts) {
    if (typeof v === "string") f.append(k, v);
    else f.append(k, new Blob([v.bytes as BlobPart], { type: v.type ?? "application/octet-stream" }), v.name);
  }
  const probe = new Request("http://x/", { method: "POST", body: f });
  return new Request("http://x/", { method: "POST", headers: { "content-type": probe.headers.get("content-type")! }, body: new Uint8Array(await probe.arrayBuffer()) });
}
async function worstStall<T>(job: () => T | Promise<T>): Promise<{ out: Awaited<T>; worst: number }> {
  let worst = 0, stop = false;
  const tick = (async () => { while (!stop) { const t = performance.now(); await new Promise((r) => setTimeout(r, 10)); worst = Math.max(worst, performance.now() - t - 10); } })();
  await new Promise((r) => setTimeout(r, 40));
  worst = 0;
  const out = await job();
  await new Promise((r) => setTimeout(r, 30)); // the tick that ends a stall fires after it
  stop = true;
  await tick;
  return { out, worst };
}

Deno.test({ name: "formOf: text fields in order (a repeated name kept), the file's name, type and bytes, parsed in a worker", ...opts, async fn() {
  const bytes = pattern(70000, 3);
  const before = parseStats.workerParses;
  const req = await post([["url", "a"], ["refinery_id", "r1"], ["url", "b"], ["file", { name: "n\u00e4me.pdf", type: "application/pdf", bytes }], ["other", { name: "x.bin", bytes: pattern(10) }]]);
  const form = await formOf(req);
  assertEquals(form.entries, [["url", "a"], ["refinery_id", "r1"], ["url", "b"]]);
  assertEquals(form.fields["url"], "b", "the last value of a repeated name, as parseBody gave it");
  assertEquals(form.file?.name, "n\u00e4me.pdf");
  assertEquals(form.file?.type, "application/pdf");
  assertEquals(form.file?.size, 70000);
  assertEquals(await sha(form.file!.bytes), await sha(bytes));
  assertEquals(form.empty, false);
  assertEquals(parseStats.workerParses, before + 1, "one parse, in the worker");
  assert(parseStats.lastInWorker, "the parse ran inside a Worker, not on the request thread");
  assertEquals(await formOf(req), form, "the seam and the route share one parse");
  closeMultipart();
}});

Deno.test({ name: "formOf: every byte value survives (all 256, NUL and CR LF inside the file)", ...opts, async fn() {
  const all = Uint8Array.from({ length: 1024 }, (_, i) => i % 256);
  const form = await formOf(await post([["file", { name: "a.bin", bytes: all }]]));
  assertEquals([...form.file!.bytes], [...all]);
  closeMultipart();
}});

Deno.test({ name: "formOf: no body, a non-form type and a form that is not a form", ...opts, async fn() {
  const none = await formOf(new Request("http://x/", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=zz" } }));
  assertEquals([none.empty, none.entries, none.file], [true, [], null]);
  const json = await formOf(new Request("http://x/", { method: "POST", headers: { "content-type": "application/json" }, body: '{"file":"x"}' }));
  assertEquals([json.empty, json.entries, json.file], [true, [], null]);
  const url = await formOf(new Request("http://x/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1&b=2&a=3" }));
  assertEquals([url.entries, url.fields["a"]], [[["a", "1"], ["b", "2"], ["a", "3"]], "3"]);
  const bad = new Request("http://x/", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=zz" }, body: "this is not multipart" });
  assertEquals(await multipartSizeOf(bad), 21);
  // a runtime may refuse it (a rejection) or read it as no fields; either way no file and no crash
  const got = await formOf(bad).catch(() => null);
  assert(got === null || (got.file === null && got.entries.length === 0));
  // and the worker still works after a refusal
  assertEquals((await formOf(await post([["a", "1"]]))).fields["a"], "1");
  closeMultipart();
}});

Deno.test({ name: "formOf: a 32 MiB upload does not hold the event loop (parsed in a worker, the file comes back whole)", ...opts, async fn() {
  const bytes = pattern(32 * MiB, 11);
  const want = await sha(bytes);
  const req = await post([["refinery_id", "r1"], ["file", { name: "big.pdf", type: "application/pdf", bytes }]]);
  const before = parseStats.workerParses;
  const mainParses = work.parseMultipart;
  const r = await worstStall(async () => { await multipartSizeOf(req); return await formOf(req); });
  console.log(`multipart 32 MiB: worst event-loop stall ${r.worst.toFixed(0)} ms`);
  // unfakeable: the parse function counts itself, per thread. The worker has its own copy of the module, so the request
  // thread's count did not move because the parse really ran elsewhere (a flag set by a caller cannot do that)
  assertEquals(work.parseMultipart, mainParses, "parseMultipart ran on the request thread");
  // the marker proves the worker; the bound is the user-visible bar (a bystander within 1 s) with the worker path's own margin
  assertEquals(parseStats.workerParses, before + 1);
  assert(parseStats.lastInWorker, "the 32 MiB parse ran inside a Worker");
  assert(r.worst < 500, `the event loop was held ${r.worst.toFixed(0)} ms`);
  assertEquals(r.out.file!.size, 32 * MiB);
  assertEquals(await sha(r.out.file!.bytes), want);
  closeMultipart();
}});

// ── through the real seam: owner-scope reads the body once, the route reuses that parse ──────────────────────────
import { Hono } from "hono";
import { ownerScope } from "../middleware/owner-scope.ts";

function seamApp() {
  const hits: string[] = [];
  const db = { query: (_sql: string, _args?: unknown[]) => { hits.push("db"); return Promise.resolve([] as unknown[]); } } as never;
  const app = new Hono();
  app.use("/workbench/*", ownerScope(db));
  // a route that reads the RAW body itself (a note save): a multipart type must not break it (the seam leaves its body whole)
  app.put("/workbench/notes/x.md", async (c) => c.json({ text: await c.req.text() }));
  app.post("/workbench/import", async (c) => {
    const f = await formOf(c.req.raw);
    return c.json({ size: f.file?.size ?? null, fields: f.fields });
  });
  return { app, hits };
}

Deno.test({ name: "owner-scope + route: one parse in a worker; a document path in a text field is refused before the route; a 32 MiB upload holds no loop", ...opts, async fn() {
  const { app } = seamApp();
  // the request thread must never parse or decode an upload body itself: count formData() / text() calls made on THIS thread
  // (the worker has its own realm, so its parse is not counted); a seam that clones and parses again would show here
  const rq = Request.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const rs = Response.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const called = { reqFormData: 0, reqText: 0, resFormData: 0 };
  const orig = { rf: rq.formData, rt: rq.text, sf: rs.formData };
  rq.formData = function (this: Request, ...a) { called.reqFormData++; return orig.rf.apply(this, a); };
  rq.text = function (this: Request, ...a) { called.reqText++; return orig.rt.apply(this, a); };
  rs.formData = function (this: Response, ...a) { called.resFormData++; return orig.sf.apply(this, a); };
  const mainParses = work.parseMultipart;
  try { await seamBody(app); } finally { rq.formData = orig.rf; rq.text = orig.rt; rs.formData = orig.sf; }
  assertEquals(called, { reqFormData: 0, reqText: 0, resFormData: 0 }, "no formData()/text() on the request thread for a multipart upload");
  assertEquals(work.parseMultipart, mainParses, "parseMultipart ran on the request thread");
  // (outside the spy: the note route legitimately reads text())
  // a multipart PUT to a non-upload route keeps its body: the route reads it, as before (it did 500 once the seam consumed it)
  const put = await post([["a", "1"]]);
  const putRes = await app.fetch(new Request("http://x/workbench/notes/x.md", { method: "PUT", headers: put.headers, body: new Uint8Array(await put.arrayBuffer()) }));
  assertEquals(putRes.status, 200);
  assert((await putRes.json()).text.includes('name="a"'));
}});
async function seamBody(app: Hono) {
  const refused = await app.fetch(await postTo("/workbench/import", [["path", "documents/someone-else/x.md"], ["file", { name: "a.pdf", bytes: pattern(1000) }]]));
  assertEquals(refused.status, 404);
  const before = parseStats.workerParses;
  const ok = await app.fetch(await postTo("/workbench/import", [["refinery_id", "r1"], ["file", { name: "a.pdf", bytes: pattern(5000) }]]));
  assertEquals(ok.status, 200);
  assertEquals(await ok.json(), { size: 5000, fields: { refinery_id: "r1" } });
  assertEquals(parseStats.workerParses, before + 1, "the seam and the route parsed the body ONCE between them");
  assert(parseStats.lastInWorker);

  const bytes = pattern(32 * MiB, 21);
  const req = await postTo("/workbench/import", [["refinery_id", "r1"], ["file", { name: "big.pdf", bytes }]]);
  const r = await worstStall(() => app.fetch(req));
  console.log(`seam + route, 32 MiB upload: worst event-loop stall ${r.worst.toFixed(0)} ms`);
  assertEquals((await r.out.json()).size, 32 * MiB);
  assert(r.worst < 500, `the event loop was held ${r.worst.toFixed(0)} ms`);
  closeMultipart();
}
async function postTo(path: string, parts: Parameters<typeof post>[0]): Promise<Request> {
  const r = await post(parts);
  return new Request("http://x" + path, { method: "POST", headers: r.headers, body: new Uint8Array(await r.arrayBuffer()) });
}
