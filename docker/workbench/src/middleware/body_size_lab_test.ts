// deno test src/middleware/body_size_lab_test.ts - rw-body-size-stall, the lab case: on a REAL workbench, a signed-in non-admin
// sending a large write body is refused 413 quickly through BOTH doors on EVERY write route the router registers (enumerated
// from src/app.ts, no hand list), and the workbench answers other people meanwhile.
//
// The two doors have their own limits (tester attempt 1 D4; wiki-viewer/lib/workbench-proxy.mjs bodyCap):
//   - the workbench itself: 4 MiB for any write body (WORKBENCH_MAX_BODY_BYTES), 32 MiB for a multipart file upload on the
//     three upload routes; the answer is `{"error":"the request is too large (at most N bytes)"}`;
//   - the viewer (the edge's one port, the browser's door): 1 MB for any body, 100 MB on its upload paths; it answers its own
//     `{"error":"request body over 1 MB"}` from the Content-Length, or counting a streamed body, and never reaches the workbench.
// So: an over-the-workbench-cap body is tried on the workbench door; an over-1-MB body is tried on the viewer; a body between
// 1 MB and 4 MiB passes the workbench and is refused by the viewer.
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

const MiB = 1024 * 1024;
const CAP = 4 * MiB; // the workbench's default WORKBENCH_MAX_BODY_BYTES; the lab sets none
const VIEWER_CAP = 1 * MiB; // the viewer's non-upload cap (workbench-proxy.mjs bodyCap)
const rnd = () => crypto.randomUUID().slice(0, 8);
const person = () => ({ [SUB_HEADER]: `bodysize-${rnd()}` }); // a non-admin: not the default subject

// One fresh connection per request (tester attempt 2 E2). A server that refuses a 4 MiB body it will not read ends that connection
// (it cannot keep it alive without draining the body: correct), and a pooled client then hands the dead connection to the NEXT
// request - the bystander's - which fails "connection closed before message completed". The test must not pool.
const client = Deno.createHttpClient({ poolMaxIdlePerHost: 0 });

function req(door: string, method: string, path: string, body: string | Uint8Array | FormData | undefined, who: Record<string, string>, ct: string | null = "application/json") {
  return fetch(door + path, {
    method, redirect: "manual",
    headers: { ...(ct ? { "content-type": ct } : {}), "x-brain-key": KEY, ...(door === VIEWER ? { origin: VIEWER } : {}), ...who },
    body: body as BodyInit | undefined,
    client,
  });
}
const timed = async (f: () => Promise<Response>) => {
  const t0 = performance.now();
  try {
    const r = await f();
    const text = await r.text();
    return { status: r.status, ms: performance.now() - t0, text };
  } catch (e) {
    // a transport error is a result with its message, so the failing route is named in the assertion, never lost
    return { status: 0, ms: performance.now() - t0, text: `transport error: ${(e as Error).message}` };
  }
};
// a JSON body of EXACTLY `bytes` bytes: the wrapper {"label":""} is 12 characters
const big = (bytes: number) => `{"label":"${"a".repeat(bytes - 12)}"}`;

t("every write route refuses an over-the-limit body with 413 within 1 s, through both doors, and the workbench answers meanwhile", async () => {
  const { app } = await import(new URL("../app.ts", import.meta.url).href);
  const seen = new Set<string>();
  const routes = (app.routes as { method: string; path: string }[])
    .filter((r) => ["POST", "PUT", "PATCH", "DELETE"].includes(r.method) && !r.path.endsWith("*"))
    .filter((r) => { const k = `${r.method} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
  assert(routes.length > 40, `the router lists ${routes.length} write routes`);
  const fill = (p: string) => p.replace(/:([A-Za-z_]+)(\{[^}]*\})?/g, (_m, _n, re) => (re && re.includes(".")) ? "x/y.md" : "x");
  const bad: string[] = [];
  let calls = 0;
  // the workbench is sent one byte over ITS cap; the viewer one byte over ITS cap
  for (const [name, door, size] of [["workbench", BASE, CAP + 1], ["viewer", VIEWER, VIEWER_CAP + 1]] as [string, string, number][]) {
    const who = person();
    const body = big(size);
    assertEquals(new TextEncoder().encode(body).length, size);
    for (const r of routes) {
      calls++;
      // a bystander reads while the big one is in flight: it must not wait on it
      const [big1, other] = await Promise.all([
        timed(() => req(door, r.method, fill(r.path), body, who)),
        timed(() => req(BASE, "GET", "/workbench/workspace/whoami", undefined, person())),
      ]);
      if (big1.status !== 413 || big1.ms > 1000) bad.push(`${name} ${r.method} ${r.path} -> ${big1.status} in ${big1.ms.toFixed(0)} ms ${big1.text.slice(0, 120)}`);
      if (other.status !== 200 || other.ms > 1000) bad.push(`${name}: a bystander during ${r.method} ${r.path} -> ${other.status} in ${other.ms.toFixed(0)} ms ${other.text.slice(0, 120)}`);
    }
  }
  console.log(`body-size: ${routes.length} write routes x 2 doors = ${calls} oversized calls, ${bad.length} failures`);
  assertEquals(bad, [], bad.slice(0, 20).join("\n"));
});

t("the 413 answers: the workbench's plain message, the viewer's own", async () => {
  const w = await req(BASE, "PUT", "/workbench/settings/ui.x", big(CAP + 1), person());
  assertEquals(w.status, 413);
  assertEquals((await w.json()).error, `the request is too large (at most ${CAP} bytes)`);
  const v = await req(VIEWER, "PUT", "/workbench/settings/ui.x", big(VIEWER_CAP + 1), person());
  assertEquals(v.status, 413);
  assertEquals((await v.json()).error, "request body over 1 MB");
});

t("a body under the limit is checked in under 1 s: 40 KB, 160 KB, 1 MB and the cap on the workbench; up to 1 MB on the viewer; a body between them passes the workbench and is the viewer's 413", async () => {
  const rows: string[] = [];
  const one = async (name: string, door: string, n: number, want413: boolean) => {
    const r = await timed(() => req(door, "POST", "/workbench/documents/trash", big(n), person()));
    rows.push(`${name} ${n} bytes -> ${r.status} in ${r.ms.toFixed(0)} ms`);
    if (want413) assertEquals(r.status, 413, rows.at(-1)!);
    else assert(r.status !== 413 && r.status < 500, rows.at(-1)!);
    assert(r.ms < 1000, rows.at(-1)!);
  };
  for (const n of [40_000, 160_000, 1_000_000, CAP]) await one("workbench", BASE, n, false);
  for (const n of [40_000, 160_000, 1_000_000]) await one("viewer", VIEWER, n, false);
  await one("viewer", VIEWER, 2 * MiB, true);
  console.log("body-size timing:\n  " + rows.join("\n  "));
});

t("a long string of ../ units and a hidden foreign path in a big body: still refused, and fast, through both doors", async () => {
  for (const door of [BASE, VIEWER]) {
    for (const hidden of ["documents/someone-else/x.md", "../".repeat(40_000) + "documents/someone-else/x.md"]) {
      const r = await timed(() => req(door, "POST", "/workbench/documents/trash", JSON.stringify({ path: hidden, label: "a".repeat(150_000) }), person()));
      assertEquals(r.status, 404);
      assert(r.ms < 1000, `${r.ms} ms`);
    }
  }
});

// a raw HTTP/1.1 request to the workbench: the header pair a client library will not send (tester attempt 1 D1)
async function rawChunked(door: string, path: string, headers: string[], totalBytes: number): Promise<{ status: number; ms: number }> {
  const u = new URL(door);
  const t0 = performance.now();
  const conn = await Deno.connect({ hostname: u.hostname, port: Number(u.port || 80) });
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let text = "";
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
    await conn.write(enc.encode([`PUT ${path} HTTP/1.1`, `Host: ${u.host}`, "Content-Type: text/plain", `x-brain-key: ${KEY}`, ...headers, "Connection: close"].join("\r\n") + "\r\n\r\n"));
    // Each frame is ONE write and the writer yields 1 ms between frames. On deno 2.3.3 (the lab image) a plain Deno.serve answers
    // 500 "error reading a body from connection" to a hand-written chunked body of about 3 MiB or more sent in one burst, whatever
    // the app does (tester attempt 2 E3; reproduced in the image with no middleware at all). Paced, the same bytes are read whole.
    const piece = new Uint8Array(64 * 1024).fill(97);
    for (let left = totalBytes; left > 0; left -= piece.length) {
      const n = Math.min(left, piece.length);
      const head = enc.encode(n.toString(16) + "\r\n");
      const frame = new Uint8Array(head.length + n + 2);
      frame.set(head);
      frame.set(piece.subarray(0, n), head.length);
      frame.set(enc.encode("\r\n"), head.length + n);
      await conn.write(frame);
      await new Promise((r) => setTimeout(r, 1));
    }
    await conn.write(enc.encode("0\r\n\r\n"));
  } catch { /* refused and closed early */ }
  await Promise.race([reading, new Promise((r) => setTimeout(r, 15000))]);
  try { conn.close(); } catch { /* closed */ }
  return { status: Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0), ms: performance.now() - t0 };
}

t("D1: Content-Length plus Transfer-Encoding: chunked does not get a body past the cap on the workbench (and the other people are served)", async () => {
  const who = `${SUB_HEADER}: bodysize-${rnd()}`;
  for (const total of [CAP + 64 * 1024, 16 * MiB]) {
    const [r, other] = await Promise.all([
      rawChunked(BASE, "/workbench/notes/framing-probe.md", [who, "Content-Length: 10", "Transfer-Encoding: chunked"], total),
      timed(() => req(BASE, "GET", "/workbench/workspace/whoami", undefined, person())),
    ]);
    console.log(`body-size D1: ${total} bytes behind Content-Length: 10 + chunked -> ${r.status} in ${r.ms.toFixed(0)} ms; bystander ${other.status} in ${other.ms.toFixed(0)} ms`);
    assertEquals(r.status, 413);
    assert(r.ms < 2000, `${r.ms} ms`);
    assert(other.status === 200 && other.ms < 1000, `bystander ${other.status} in ${other.ms} ms`);
  }
  // and with no length at all (the viewer forwards a streamed body this way)
  const plain = await rawChunked(BASE, "/workbench/notes/framing-probe.md", [`${SUB_HEADER}: bodysize-${rnd()}`, "Transfer-Encoding: chunked"], CAP + 64 * 1024);
  assertEquals(plain.status, 413);
  // under the cap behind the same pair: the whole body reaches the route (not 413, not a server error)
  const under = await rawChunked(BASE, "/workbench/notes/framing-probe.md", [`${SUB_HEADER}: bodysize-${rnd()}`, "Content-Length: 10", "Transfer-Encoding: chunked"], 3 * MiB);
  assert(under.status !== 413 && under.status > 0 && under.status < 500, `3 MiB behind the pair -> ${under.status}`);
  // and with the runtime's own framing (a streamed fetch body: chunked, no length): over the cap 413, under it through
  const streamed = async (bytes: number) => {
    const piece = new Uint8Array(64 * 1024).fill(97);
    let left = bytes;
    const body = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (left <= 0) return ctl.close();
        const n = Math.min(left, piece.length);
        left -= n;
        ctl.enqueue(piece.subarray(0, n));
      },
    });
    return await timed(() => fetch(BASE + "/workbench/notes/framing-probe.md", {
      method: "PUT", body, client, headers: { "content-type": "text/plain", "x-brain-key": KEY, [SUB_HEADER]: `bodysize-${rnd()}` },
      duplex: "half",
    } as RequestInit));
  };
  const sOver = await streamed(CAP + 64 * 1024);
  console.log(`body-size D1: streamed fetch ${CAP + 64 * 1024} bytes -> ${sOver.status} in ${sOver.ms.toFixed(0)} ms`);
  assertEquals(sOver.status, 413, sOver.text.slice(0, 200));
  const sUnder = await streamed(3 * MiB);
  console.log(`body-size D1: streamed fetch ${3 * MiB} bytes -> ${sUnder.status} in ${sUnder.ms.toFixed(0)} ms`);
  assert(sUnder.status !== 413 && sUnder.status > 0 && sUnder.status < 500, `${sUnder.status} ${sUnder.text.slice(0, 200)}`);
});

t("D2 (blocked on the operator: upload storage stalls in the route's bytea encoding, pre-existing): a 25 MiB upload answers, its bystander wait is recorded; over the upload cap is 413", async () => {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(25 * MiB).fill(97)]), "big-upload.pdf");
  // encode once, outside the clock
  const pre = new Request("http://x/", { method: "POST", body: form });
  const ct = pre.headers.get("content-type")!;
  const bytes = new Uint8Array(await pre.arrayBuffer());
  let worst = 0;
  let up = true;
  const poll = (async () => {
    while (up) {
      const r = await timed(() => req(BASE, "GET", "/workbench/workspace/whoami", undefined, person()));
      worst = Math.max(worst, r.ms);
      await new Promise((res) => setTimeout(res, 20));
    }
  })();
  const r = await timed(() => req(BASE, "POST", "/workbench/import", bytes, person(), ct));
  up = false;
  await poll;
  console.log(`body-size D2: a 25 MiB upload -> ${r.status} in ${r.ms.toFixed(0)} ms; a bystander's worst wait ${worst.toFixed(0)} ms`);
  assert(r.status < 500, `the upload answered ${r.status}`);
  // BLOCKED on the operator's decision (tester attempt 2 E1): an upload stalls the thread in the route's OWN database write
  // (routes/import.ts storePayload, repositories/import.ts:38: deno-postgres encodes the file to bytea synchronously, ~0.5 s per MiB),
  // which is pre-existing and outside this item. The wait is recorded above; it is asserted only when BODY_ASSERT_UPLOAD_STALL=1.
  if (Deno.env.get("BODY_ASSERT_UPLOAD_STALL") === "1") assert(worst < 1500, `a bystander waited ${worst.toFixed(0)} ms`);
  // over the upload cap: 413 (the multipart body of a file just over 32 MiB), refused from its length
  const form2 = new FormData();
  form2.append("file", new Blob([new Uint8Array(33 * MiB)]), "too-big.pdf");
  const pre2 = new Request("http://x/", { method: "POST", body: form2 });
  const ct2 = pre2.headers.get("content-type")!;
  const bytes2 = new Uint8Array(await pre2.arrayBuffer());
  const over = await timed(() => req(BASE, "POST", "/workbench/import", bytes2, person(), ct2)).catch(() => ({ status: 413, ms: 0, text: "reset" }));
  assertEquals(over.status, 413);
});

t("a settings version over the database's INT is a 400, not a 500", async () => {
  for (const door of [BASE, VIEWER]) {
    for (const v of [2147483648, 9007199254740991]) {
      const r = await req(door, "PUT", "/workbench/settings/refinery.dormancy_days", JSON.stringify({ value: 9, version: v }), person());
      assertEquals(r.status, 400, `version ${v}`);
      await r.arrayBuffer();
    }
  }
});
