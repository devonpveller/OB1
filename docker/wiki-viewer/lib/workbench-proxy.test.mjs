// rw-p2b-workspace: the viewer forwards /workbench/* to the workbench with the key, server-side
// (the edge targets the viewer alone; the browser never holds the key).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { proxyWorkbench, proxyConfig } from "./workbench-proxy.mjs";

async function serve(handler) {
  const s = http.createServer(handler).listen(0, "127.0.0.1");
  await once(s, "listening");
  return { server: s, url: `http://127.0.0.1:${s.address().port}` };
}

async function lab() {
  const seen = [];
  const up = await serve(async (req, res) => {
    let n = 0;
    for await (const c of req) n += c.length;
    seen.push({ method: req.method, url: req.url, key: req.headers["x-brain-key"], user: req.headers["remote-user"], bytes: n });
    if (req.url.startsWith("/workbench/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 50);
      return;
    }
    res.writeHead(201, { "content-type": "application/json", "x-up": "1" });
    res.end(JSON.stringify({ ok: true }));
  });
  const cfg = { url: up.url, key: "server-side-key" };
  const front = await serve((req, res) => proxyWorkbench(req, res, cfg));
  return { seen, up, front, close: () => { up.server.close(); front.server.close(); } };
}

test("forwards /workbench/* with the key injected and the client's key dropped", async () => {
  const l = await lab();
  try {
    const r = await fetch(`${l.front.url}/workbench/documents/file?path=x`, { method: "PUT", headers: { "x-brain-key": "forged", "remote-user": "alice", "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get("x-up"), "1");
    assert.deepEqual(l.seen[0], { method: "PUT", url: "/workbench/documents/file?path=x", key: "server-side-key", user: "alice", bytes: 2 });
  } finally {
    l.close();
  }
});

test("streams a server-sent event response through", async () => {
  const l = await lab();
  try {
    const r = await fetch(`${l.front.url}/workbench/stream`);
    assert.equal(r.headers.get("content-type"), "text/event-stream");
    assert.equal(await r.text(), "data: one\n\ndata: two\n\n");
  } finally {
    l.close();
  }
});

test("caps a request body like the front door did: 1 MB, 100 MB on the upload paths", async () => {
  const l = await lab();
  try {
    const big = "x".repeat(1024 * 1024 + 10);
    const r = await fetch(`${l.front.url}/workbench/notes/a.md`, { method: "PUT", body: big });
    assert.equal(r.status, 413);
    const ok = await fetch(`${l.front.url}/workbench/import`, { method: "POST", body: big });
    assert.equal(ok.status, 201);
  } finally {
    l.close();
  }
});

test("off unless both WORKBENCH_URL and WORKBENCH_KEY are set", () => {
  assert.equal(proxyConfig({}), null);
  assert.equal(proxyConfig({ WORKBENCH_URL: "http://wb:8000" }), null);
  assert.deepEqual(proxyConfig({ WORKBENCH_URL: "http://wb:8000/", WORKBENCH_KEY: "k" }), { url: "http://wb:8000", key: "k" });
});

test("an unreachable workbench is a 502, never a hang", async () => {
  const front = await serve((req, res) => proxyWorkbench(req, res, { url: "http://127.0.0.1:1", key: "k" }));
  try {
    const r = await fetch(`${front.url}/workbench/health`);
    assert.equal(r.status, 502);
  } finally {
    front.server.close();
  }
});
