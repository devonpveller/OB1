// deno test -A src/middleware/body_limit_test.ts - rw-body-size-stall: the request body cap (src/middleware/body_limit.ts).
// A write whose body is over the cap is answered 413 with a plain message before the owner scope (or any route) reads it;
// the largest body any current write route legitimately takes fits under the cap, shown here from the code's own limits.
// Hermetic: no database, no network, no workbench process.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import { bodyLimit, DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_UPLOAD_BYTES, INTAKE_MAX_FILE_BYTES, maxBodyBytes, maxUploadBytes, UPLOAD_ROUTES } from "./body_limit.ts";
import { ownerScope } from "./owner-scope.ts";
import type { Identity } from "./identity.ts";
import { DEFAULT_LIMITS } from "../export/markdown.ts";
import { MAX_DRAFT, MAX_SUMMARY } from "../ideas/repo.ts";
import { MAX_DOC_TEXT, MAX_PASSAGE, MAX_PASSAGES, MAX_QUESTION } from "../contracts/logic/research_start.ts";

const noRows = { query: () => Promise.resolve([]), tx: (f: (d: unknown) => unknown) => f(noRows) } as never;
const who: Identity = { sub: "bob", actor: "bob", name: "bob", key: "k-bob", kind: "user", admin: false, impersonating: null };
let reached = 0;
function app() {
  reached = 0;
  const a = new Hono();
  a.use("*", async (c, next) => { c.set("identity" as never, who as never); await next(); });
  a.use("/workbench/*", bodyLimit());
  a.use("/workbench/*", ownerScope(noRows));
  a.all("/workbench/*", async (c) => {
    reached++;
    return c.json({ reached: true, bytes: (await c.req.arrayBuffer()).byteLength });
  });
  return a;
}
const JSON_H = { "content-type": "application/json" };
const jsonOf = (bytes: number) => `{"label":"${"a".repeat(bytes - 12)}"}`; // exactly `bytes` bytes (ASCII)

async function withEnv(vars: Record<string, string>, f: () => Promise<void>) {
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  try { await f(); } finally { for (const k of Object.keys(vars)) Deno.env.delete(k); }
}

Deno.test("an oversized write is refused 413 with a plain message, fast, and no route runs - every write method", async () => {
  const cap = maxBodyBytes();
  assertEquals(cap, DEFAULT_MAX_BODY_BYTES);
  const body = jsonOf(cap + 1);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const t = performance.now();
    const r = await app().request("/workbench/documents/file?path=documents/k-bob/x.md", { method, headers: JSON_H, body });
    assert(performance.now() - t < 1000, `${method} took ${(performance.now() - t).toFixed(0)} ms`);
    assertEquals(r.status, 413, method);
    const j = await r.json();
    assertEquals(j.error, `the request is too large (at most ${cap} bytes)`);
    assertEquals(reached, 0, "no route ran");
  }
});

Deno.test("a body of exactly the cap is accepted, one byte more is not; any content type is capped", async () => {
  const cap = maxBodyBytes();
  const ok = await app().request("/workbench/notes/a.md", { method: "PUT", headers: JSON_H, body: jsonOf(cap) });
  assertEquals(ok.status, 200);
  assertEquals((await ok.json()).bytes, cap);
  for (const ct of ["application/json", "text/plain", "text/markdown", "application/x-www-form-urlencoded", "application/octet-stream"]) {
    const r = await app().request("/workbench/notes/a.md", { method: "PUT", headers: { "content-type": ct }, body: "x".repeat(cap + 1) });
    assertEquals(r.status, 413, ct);
  }
});

Deno.test("a DECLARED Content-Length of exactly cap+1 is refused 413, exactly cap is accepted (the declared-length branch, to the byte)", async () => {
  // the other cases here send no Content-Length, so they count the stream; this one carries the header the server frames by
  const cap = maxBodyBytes();
  assertEquals(cap, 4 * 1024 * 1024); // a raised default (e.g. 5 MiB) fails here and on the 413 below
  const send = (bytes: number, declared: number) => app().request("/workbench/notes/a.md", {
    method: "PUT", headers: { ...JSON_H, "content-length": String(declared) }, body: jsonOf(bytes),
  });
  const over = await send(cap + 1, cap + 1);
  assertEquals(over.status, 413, "declared cap+1");
  assertEquals((await over.json()).error, `the request is too large (at most ${cap} bytes)`);
  assertEquals(reached, 0);
  const at = await send(cap, cap);
  assertEquals(at.status, 200, "declared exactly cap");
  // a length over the cap is refused on the declaration alone, whatever the body that follows
  const lie = await app().request("/workbench/notes/a.md", { method: "PUT", headers: { ...JSON_H, "content-length": String(cap + 1) }, body: "x" });
  assertEquals(lie.status, 413, "declared cap+1, short body");
});

Deno.test("a body stream that fails mid-read is a 400 with a plain message, never the app's 500, and no route runs", async () => {
  // the runtime can fail a streamed body part-way (deno 2.3.3: "error reading a body from connection" on a fast chunked body of
  // about 3 MiB or more); that is the client's transport, not a fault in the workbench, so it is not answered 500
  const failing = (after: number) => {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (sent >= after) return ctl.error(new Error("error reading a body from connection"));
        sent += 1024; ctl.enqueue(new Uint8Array(1024).fill(97));
      },
    });
  };
  for (const after of [0, 4096, maxBodyBytes() + 4096]) {
    const r = await app().request("/workbench/notes/a.md", { method: "PUT", headers: { "content-type": "text/plain" }, body: failing(after), duplex: "half" } as RequestInit);
    assertEquals(r.status, after > maxBodyBytes() ? 413 : 400, `fails after ${after} bytes`);
    if (r.status === 400) assertEquals((await r.json()).error, "the request body could not be read");
    assertEquals(reached, 0, "no route ran");
  }
});

Deno.test("reads carry no cap (the cap is on a write's body)", async () => {
  const r = await app().request(`/workbench/documents/file?path=${"a".repeat(8000)}`, { method: "GET" });
  assertEquals(r.status, 200);
});

Deno.test("a body with no length (chunked) is counted as it arrives: over the cap is 413, under it reaches the route whole", async () => {
  const chunked = (bytes: number) => new ReadableStream<Uint8Array>({
    start(ctl) {
      const piece = new TextEncoder().encode("a".repeat(64 * 1024));
      let left = bytes;
      while (left > 0) { const n = Math.min(left, piece.length); ctl.enqueue(piece.subarray(0, n)); left -= n; }
      ctl.close();
    },
  });
  await withEnv({ WORKBENCH_MAX_BODY_BYTES: "300000" }, async () => {
    const send = (bytes: number) => app().request("/workbench/notes/a.md", {
      method: "PUT", headers: { "content-type": "text/plain" }, body: chunked(bytes), duplex: "half",
    } as RequestInit);
    const over = await send(300_001);
    assertEquals(over.status, 413);
    assertEquals(reached, 0);
    const fine = await send(299_999);
    assertEquals(fine.status, 200);
    assertEquals((await fine.json()).bytes, 299_999);
  });
});

Deno.test("a chunked JSON body under the cap still goes through the owner scope: a foreign path in it is refused", async () => {
  const enc = new TextEncoder().encode(JSON.stringify({ label: "see documents/alice/x.md" }));
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc); c.close(); } });
  const r = await app().request("/workbench/settings/user/x", { method: "PUT", headers: JSON_H, body, duplex: "half" } as RequestInit);
  assertEquals(r.status, 404);
});

Deno.test("a file upload has its own, larger cap - on the three upload routes and for multipart only", async () => {
  await withEnv({ WORKBENCH_MAX_BODY_BYTES: "1000", WORKBENCH_MAX_UPLOAD_BYTES: "5000" }, async () => {
    const multipart = (bytes: number) => {
      const f = new FormData();
      f.append("file", new Blob(["x".repeat(bytes)]), "a.pdf");
      return f;
    };
    const uploads = ["/workbench/import", "/workbench/intake/add", "/workbench/sources/abc/replace-from-upload"];
    assertEquals(UPLOAD_ROUTES.length, uploads.length);
    for (const p of uploads) {
      assert(UPLOAD_ROUTES.some((r) => r.test(p)), p);
      assertEquals((await app().request(p, { method: "POST", body: multipart(3000) })).status, 200, `${p}: 3000 bytes of file`);
      assertEquals((await app().request(p, { method: "POST", body: multipart(6000) })).status, 413, `${p}: over the upload cap`);
      // not multipart: the general cap, even on an upload route
      assertEquals((await app().request(p, { method: "POST", headers: JSON_H, body: jsonOf(3000) })).status, 413, `${p}: JSON is not an upload`);
    }
    // multipart anywhere else: the general cap
    for (const p of ["/workbench/documents/file", "/workbench/notes/a.md", "/workbench/contract/cast/x", "/workbench/import/extra", "/workbench/settings/user/k"]) {
      assertEquals((await app().request(p, { method: "POST", body: multipart(3000) })).status, 413, `${p}: multipart is not an upload here`);
    }
  });
});

Deno.test("the largest legitimate body of every write route fits under the cap", async () => {
  const cap = maxBodyBytes();
  const sendJson = async (path: string, method: string, v: unknown) => {
    const body = JSON.stringify(v);
    assert(new TextEncoder().encode(body).length <= cap, `${method} ${path}: ${body.length} bytes`);
    assertEquals((await app().request(path, { method, headers: JSON_H, body })).status, 200, `${method} ${path}`);
  };
  // 1. a document or note save: its text has no ceiling of its own, but a note over the export's size ceiling cannot be
  //    exported, so that is the largest real one. Its JSON form, even with EVERY character an escape (a quote or a newline: 2 bytes each)
  const note = DEFAULT_LIMITS.maxBytes;
  assertEquals(note, 1_000_000);
  const prose = ("word ".repeat(15) + "\n").repeat(Math.ceil(note / 76)).slice(0, note);
  const allEscapes = '"\n'.repeat(note / 2);
  for (const content of [prose, allEscapes]) {
    await sendJson("/workbench/documents/file?path=documents/k-bob/x.md&commit=1", "PUT", { content, if_match: "0".repeat(64) });
    await sendJson("/workbench/documents", "POST", { title: "t", folder: "f", body: content });
    await sendJson("/workbench/notes/a.md", "PUT", { content, if_match: "0".repeat(64) });
    await sendJson("/workbench/documents/user-sources", "POST", { title: "t", content, path: "documents/k-bob/x.md", url: "https://example.org/" });
    await sendJson("/workbench/documents/user-sources/1/replace", "POST", { path: "documents/k-bob/x.md", title: "t", content });
  }
  // raw markdown note body (a PUT of text/markdown): the note itself
  assertEquals((await app().request("/workbench/notes/a.md", { method: "PUT", headers: { "content-type": "text/markdown" }, body: prose })).status, 200);
  // 2. an idea: a draft (MAX_DRAFT) and a summary (MAX_SUMMARY), in three-byte characters (the widest a JS string unit encodes to)
  await sendJson("/workbench/ideas/x/draft", "POST", { text: "中".repeat(MAX_DRAFT) });
  await sendJson("/workbench/ideas", "POST", { title: "t", summary: "中".repeat(MAX_SUMMARY) });
  // 3. the research start: a question, up to MAX_PASSAGES passages of MAX_PASSAGE, a document of MAX_DOC_TEXT
  await sendJson("/workbench/contract/research/start", "POST", {
    question: "q".repeat(MAX_QUESTION), passages: Array.from({ length: MAX_PASSAGES }, () => "p".repeat(MAX_PASSAGE)), attach: [{ path: "documents/k-bob/x.md", text: "d".repeat(MAX_DOC_TEXT) }],
  });
  // 4. an upload: the intake add's largest file, a real multipart body (file + its text fields), through the upload cap
  const f = new FormData();
  f.append("file", new Blob([new Uint8Array(INTAKE_MAX_FILE_BYTES)]), "a-much-longer-file-name-than-most.pdf");
  f.append("refinery_id", crypto.randomUUID());
  f.append("path", "documents/k-bob/" + "d".repeat(400) + ".md");
  f.append("content_type", "pdf");
  const r = await app().request("/workbench/intake/add", { method: "POST", body: f });
  assertEquals(r.status, 200, "the intake add's largest file is under the upload cap");
  assert((await r.json()).bytes > INTAKE_MAX_FILE_BYTES);
  assertEquals(maxUploadBytes(), DEFAULT_MAX_UPLOAD_BYTES);
  // the import and replace-from-upload have no limit of their own; the upload cap is 32 MiB (the thread's hold: ~20 ms per MiB of
  // form parse, tester attempt 1 D2), above the intake's 25 MiB file and below the edge's 100 MB, which is lowered here on purpose
  assertEquals(DEFAULT_MAX_UPLOAD_BYTES, 32 * 1024 * 1024);
  assert(DEFAULT_MAX_UPLOAD_BYTES >= INTAKE_MAX_FILE_BYTES + 1024 * 1024);
});

Deno.test("no write route reads a multipart or form body that is not on the upload list (a new upload route must be added to the cap)", async () => {
  const root = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
  const hits: string[] = [];
  async function walk(dir: string) {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (e.name.endsWith(".ts") && !/_test\.ts$|_fixtures\.ts$/.test(e.name) && /\.parseBody\(|\.formData\(\)/.test(await Deno.readTextFile(p))) {
        hits.push(p.slice(root.length).replace(/^\/+/, ""));
      }
    }
  }
  await walk(root.replace(/\/$/, ""));
  assertEquals(hits.sort(), ["intake/routes.ts", "middleware/owner-scope.ts", "routes/import.ts", "routes/sources.ts"]);
});

Deno.test("the cap is mounted on /workbench/* after the two doors and before the owner scope", async () => {
  const src = await Deno.readTextFile(new URL("../app.ts", import.meta.url));
  const at = (s: string) => src.indexOf(s);
  assert(at('app.use("/workbench/*", requireKey(') > 0);
  assert(at('app.use("/workbench/*", requireKey(') < at('app.use("/workbench/*", identitySeam('));
  assert(at('app.use("/workbench/*", identitySeam(') < at('app.use("/workbench/*", bodyLimit())'));
  assert(at('app.use("/workbench/*", bodyLimit())') < at('app.use("/workbench/*", ownerScope('));
  assert(at('app.use("/workbench/*", ownerScope(') < at('app.route("/workbench/notebooks"'));
});

Deno.test("an env override is honoured, a bad one keeps the default", async () => {
  await withEnv({ WORKBENCH_MAX_BODY_BYTES: "2048" }, () => { assertEquals(maxBodyBytes(), 2048); return Promise.resolve(); });
  for (const bad of ["", "0", "-5", "abc", "1.5", "1e3x"]) {
    await withEnv({ WORKBENCH_MAX_BODY_BYTES: bad }, () => { assertEquals(maxBodyBytes(), DEFAULT_MAX_BODY_BYTES, bad); return Promise.resolve(); });
  }
});
