// deno test -A src/middleware/body_limit_framing_test.ts - rw-body-size-stall, tester attempt 1 D1/D2/D3.
// D1: a Content-Length header that does not frame the body (Transfer-Encoding: chunked next to it) cannot get a body past the cap.
// D2: an upload is parsed once and only its small text fields are scanned; a big file does not hold the one thread for seconds.
// D3: a 4 MiB body of distinct legacy documents/N.md paths is checked in about a second of CPU, linear in size.
// Hermetic: a local Deno.serve (127.0.0.1, an ephemeral port) behind the real middleware; no database.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import { bodyLimit, FORM_TEXT_MAX_CHARS } from "./body_limit.ts";
import { ownerScope } from "./owner-scope.ts";
import type { Identity } from "./identity.ts";

const noRows = { query: () => Promise.resolve([]), tx: (f: (d: unknown) => unknown) => f(noRows) } as never;
const who: Identity = { sub: "bob", actor: "bob", name: "bob", key: "k-bob", kind: "user", admin: false, impersonating: null };
function app() {
  const a = new Hono();
  a.use("*", async (c, next) => { c.set("identity" as never, who as never); await next(); });
  a.use("/workbench/*", bodyLimit());
  a.use("/workbench/*", ownerScope(noRows));
  a.all("/workbench/*", async (c) => c.json({ reached: true, bytes: (await c.req.arrayBuffer()).byteLength }));
  return a;
}
async function withEnv(vars: Record<string, string>, f: () => Promise<void>) {
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  try { await f(); } finally { for (const k of Object.keys(vars)) Deno.env.delete(k); }
}

// a raw HTTP/1.1 request: the exact header pair a client library will not send
async function raw(port: number, head: string[], chunks: Uint8Array[]): Promise<{ status: number; text: string }> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let text = "";
  // read the answer from the start: a server that refuses early answers and closes while the body is still being sent
  const reading = (async () => {
    const buf = new Uint8Array(65536);
    for (;;) {
      let n: number | null = null;
      try { n = await conn.read(buf); } catch { return; }
      if (n === null) return;
      text += dec.decode(buf.subarray(0, n));
      if (/\r\n\r\n[\s\S]*\}/.test(text)) return;
    }
  })();
  try {
    await conn.write(enc.encode(head.join("\r\n") + "\r\n\r\n"));
    for (const ch of chunks) {
      await conn.write(enc.encode(ch.length.toString(16) + "\r\n"));
      await conn.write(ch);
      await conn.write(enc.encode("\r\n"));
    }
    await conn.write(enc.encode("0\r\n\r\n"));
  } catch { /* the server answered and closed early: fine */ }
  await Promise.race([reading, new Promise((r) => setTimeout(r, 5000))]);
  try { conn.close(); } catch { /* closed */ }
  return { status: Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0), text };
}

Deno.test("D1: Content-Length 10 plus Transfer-Encoding: chunked does not get a body past the cap", async () => {
  await withEnv({ WORKBENCH_MAX_BODY_BYTES: "100000" }, async () => {
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, app().fetch);
    try {
      const port = (server.addr as Deno.NetAddr).port;
      const piece = new Uint8Array(50_000).fill(97);
      const head = (path: string) => [`PUT ${path} HTTP/1.1`, "Host: x", "Content-Type: text/plain", "Content-Length: 10", "Transfer-Encoding: chunked", "Connection: close"];
      // 150 KB behind a false length of 10 (cap 100 KB; small enough to be on the wire before the refusal): refused
      const over = await raw(port, head("/workbench/notes/a.md"), Array.from({ length: 3 }, () => piece));
      assertEquals(over.status, 413, over.text.slice(0, 200));
      // 50 KB behind the same pair: reaches the route, the whole body (the length header is not what counts)
      const under = await raw(port, head("/workbench/notes/a.md"), Array.from({ length: 1 }, () => piece));
      assertEquals(under.status, 200, under.text.slice(0, 200));
      assert(under.text.includes(`"bytes":50000`), under.text.slice(-200));
    } finally {
      await server.shutdown();
    }
  });
});

// the longest the one thread stays busy while f runs: a ticker that should fire every 10 ms
async function longestStall(f: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let worst = 0;
  const tick = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; }, 10);
  try { await f(); } finally { clearInterval(tick); }
  worst = Math.max(worst, performance.now() - last);
  return worst;
}
const upload = (file: Uint8Array, fields: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  f.append("file", new Blob([file as BlobPart]), "a.pdf");
  return f;
};

Deno.test("D2: an upload is parsed once and its file is never scanned: 30 MiB of file adds no hold on the thread", async () => {
  // bytes that would be slow and would name a foreign path if they were scanned as text
  const file = new Uint8Array(30 * 1024 * 1024);
  const seed = new TextEncoder().encode("a..b documents/someone-else/x.md ../../ ");
  for (let i = 0; i + seed.length < file.length; i += seed.length) file.set(seed, i);
  let status = 0;
  // the client's own encoding of the form is done before the clock starts: only the server's work is timed
  const pre = new Request("http://x/", { method: "POST", body: upload(file, { target_notebook: "n" }) });
  const ct = pre.headers.get("content-type")!;
  const bytes = new Uint8Array(await pre.arrayBuffer());
  const stall = await longestStall(async () => {
    const r = await app().request("/workbench/import", { method: "POST", headers: { "content-type": ct }, body: bytes });
    status = r.status;
    await r.arrayBuffer();
  });
  assertEquals(status, 200);
  assert(stall < 300, `the thread was busy ${stall.toFixed(0)} ms at a stretch`);
});

Deno.test("D2: the text fields of an upload are still scanned (a foreign path is 404) and capped (over FORM_TEXT_MAX_CHARS is 413)", async () => {
  const tiny = new Uint8Array(10);
  const a = (fields: Record<string, string>) => app().request("/workbench/intake/add", { method: "POST", body: upload(tiny, fields) });
  assertEquals((await a({ path: "documents/k-bob/x.md" })).status, 200);
  assertEquals((await a({ path: "documents/alice/x.md" })).status, 404);
  assertEquals((await a({ path: "x ../documents/alice/x.md" })).status, 404);
  const near = await a({ url: "u".repeat(FORM_TEXT_MAX_CHARS - 50) });
  assertEquals(near.status, 200);
  const over = await a({ url: "a".repeat(FORM_TEXT_MAX_CHARS + 1) });
  assertEquals(over.status, 413);
  assert((await over.json()).error.includes("too large"));
  // a urlencoded form is the same
  const enc = (v: string) => app().request("/workbench/documents/trash", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `path=${v}` });
  assertEquals((await enc("documents/alice/x.md")).status, 404);
  assertEquals((await enc("a".repeat(FORM_TEXT_MAX_CHARS + 1))).status, 413);
  // a big upload on an upload route is not parsed here (the route parses it once and checks what it names itself); a
  // small one, and a big one elsewhere, are scanned (the 4 MiB general cap bounds a form on any other route)
  const big = new Uint8Array(2 * 1024 * 1024);
  assertEquals((await app().request("/workbench/intake/add", { method: "POST", body: upload(big, { path: "documents/alice/x.md" }) })).status, 200);
  assertEquals((await app().request("/workbench/documents/trash", { method: "POST", body: upload(big, { path: "documents/alice/x.md" }) })).status, 404);
  // a form with no body at all is no body (as before)
  assertEquals((await app().request("/workbench/import", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" } })).status, 200);
});

Deno.test("D3: a 4 MiB body of distinct legacy documents/N.md paths is checked in under 1.5 s of one thread, in step with size", async () => {
  const body = (bytes: number) => {
    let s = "";
    for (let i = 0; s.length < bytes; i++) s += `documents/${i}.md `;
    return JSON.stringify({ label: s });
  };
  const once = async (n: number) => {
    const b = body(n);
    const t = performance.now();
    const r = await app().request("/workbench/settings/user/x", { method: "PUT", headers: { "content-type": "application/json" }, body: b });
    assertEquals(r.status, 404);
    return performance.now() - t;
  };
  const t1 = await once(1024 * 1024);
  const t4 = await once(4 * 1024 * 1024 - 64);
  assert(t4 < 1500, `4 MiB took ${t4.toFixed(0)} ms`);
  assert(t4 < Math.max(t1, 20) * 8, `1 MiB ${t1.toFixed(0)} ms, 4 MiB ${t4.toFixed(0)} ms: not in step`);
});
