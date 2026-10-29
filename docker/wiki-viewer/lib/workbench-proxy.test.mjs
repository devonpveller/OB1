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
  const cfg = proxyConfig({ WORKBENCH_URL: up.url, WORKBENCH_KEY: "server-side-key" });
  const front = await serve((req, res) => proxyWorkbench(req, res, cfg));
  return { seen, up, front, origin: front.url, close: () => { up.server.close(); front.server.close(); } };
}

test("forwards /workbench/* with the key injected and the client's key dropped", async () => {
  const l = await lab();
  try {
    const r = await fetch(`${l.front.url}/workbench/documents/file?path=x`, { method: "PUT", headers: { "x-brain-key": "forged", "remote-user": "alice", "content-type": "application/json", origin: l.origin }, body: "{}" });
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
    const r = await fetch(`${l.front.url}/workbench/notes/a.md`, { method: "PUT", body: big, headers: { origin: l.origin } });
    assert.equal(r.status, 413);
    const ok = await fetch(`${l.front.url}/workbench/import`, { method: "POST", body: big, headers: { origin: l.origin } });
    assert.equal(ok.status, 201);
  } finally {
    l.close();
  }
});

test("off unless both WORKBENCH_URL and WORKBENCH_KEY are set", () => {
  assert.equal(proxyConfig({}), null);
  assert.equal(proxyConfig({ WORKBENCH_URL: "http://wb:8000" }), null);
  const c = proxyConfig({ WORKBENCH_URL: "http://wb:8000/", WORKBENCH_KEY: "k", WIKI_VIEWER_ALLOWED_HOSTS: "Wiki.Edge.example, x.lan", WIKI_VIEWER_ALLOWED_ORIGINS: "https://wiki.edge.example/" });
  assert.equal(c.url, "http://wb:8000");
  assert.equal(c.key, "k");
  for (const h of ["localhost", "127.0.0.1", "[::1]", "openbrain-wiki-viewer", "wiki.edge.example", "x.lan"]) assert.ok(c.hosts.has(h), h);
  assert.deepEqual([...c.origins], ["https://wiki.edge.example"]);
});

test("an unreachable workbench is a 502, never a hang", async () => {
  const front = await serve((req, res) => proxyWorkbench(req, res, proxyConfig({ WORKBENCH_URL: "http://127.0.0.1:1", WORKBENCH_KEY: "k" })));
  try {
    const r = await fetch(`${front.url}/workbench/health`);
    assert.equal(r.status, 502);
  } finally {
    front.server.close();
  }
});

// r-p2b review finding (CSRF + DNS rebinding): the forwarder adds the key for whoever reaches the
// viewer, so a write must come from the viewer's own origin (or an allow-listed edge origin) and
// every forwarded request must name an allow-listed Host.
async function guarded() {
  const seen = [];
  const up = await serve(async (req, res) => {
    for await (const _ of req);
    seen.push(req.method + " " + req.url);
    res.writeHead(201, { "content-type": "application/json" });
    res.end("{}");
  });
  const cfg = proxyConfig({ WORKBENCH_URL: up.url, WORKBENCH_KEY: "k", WIKI_VIEWER_ALLOWED_ORIGINS: "https://wiki.edge.example", WIKI_VIEWER_ALLOWED_HOSTS: "wiki.edge.example" });
  const front = await serve((req, res) => proxyWorkbench(req, res, cfg));
  const port = front.server.address().port;
  // raw http.request so the Host header is exactly what a rebound name would send
  const send = (method, headers, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: "/workbench/documents", method, headers }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    r.on("error", reject); r.end(body);
  });
  return { seen, port, send, close: () => { up.server.close(); front.server.close(); } };
}

test("a cross-origin write is refused and never reaches the workbench", async () => {
  const g = await guarded();
  try {
    const s = await g.send("POST", { host: `127.0.0.1:${g.port}`, origin: "https://evil.example", "content-type": "text/plain" }, "x");
    assert.equal(s, 403);
    const s2 = await g.send("POST", { host: `127.0.0.1:${g.port}`, origin: "null", "content-type": "text/plain" }, "x");
    assert.equal(s2, 403);
    const s3 = await g.send("DELETE", { host: `127.0.0.1:${g.port}`, origin: `http://127.0.0.1:${g.port}`, referer: "https://evil.example/x" });
    assert.equal(s3, 403);
    assert.deepEqual(g.seen, []);
  } finally { g.close(); }
});

test("a write with no Origin is refused", async () => {
  const g = await guarded();
  try {
    assert.equal(await g.send("PUT", { host: `127.0.0.1:${g.port}`, "content-type": "application/json" }, "{}"), 403);
    assert.deepEqual(g.seen, []);
  } finally { g.close(); }
});

test("a rebound Host (any name not on the allow-list) is refused, reads included", async () => {
  const g = await guarded();
  try {
    assert.equal(await g.send("GET", { host: `attacker.example:${g.port}` }), 421);
    assert.equal(await g.send("POST", { host: `attacker.example:${g.port}`, origin: `http://attacker.example:${g.port}` }, "x"), 421);
    assert.deepEqual(g.seen, []);
  } finally { g.close(); }
});

test("the viewer's own origin and an allow-listed edge origin may write; reads need no Origin", async () => {
  const g = await guarded();
  try {
    assert.equal(await g.send("POST", { host: `127.0.0.1:${g.port}`, origin: `http://127.0.0.1:${g.port}` }, "x"), 201);
    assert.equal(await g.send("POST", { host: `localhost:${g.port}`, origin: `http://localhost:${g.port}`, referer: `http://localhost:${g.port}/workspace` }, "x"), 201);
    assert.equal(await g.send("POST", { host: "wiki.edge.example", origin: "https://wiki.edge.example" }, "x"), 201);
    assert.equal(await g.send("GET", { host: `127.0.0.1:${g.port}` }), 201);
    assert.equal(g.seen.length, 4);
  } finally { g.close(); }
});

// rw-identity: a client never names its own identity, and the door injects the door key.
test("rw-identity: the identity header is dropped from every client request; cookies pass; the door key is injected", async () => {
  const seen = [];
  const up = await serve(async (req, res) => {
    for await (const _ of req);
    seen.push({ sub: req.headers["x-auth-sub"], name: req.headers["x-auth-name"], cookie: req.headers.cookie, key: req.headers["x-brain-key"] });
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "__Host-ob-ws-session=t; Path=/; Secure; HttpOnly; SameSite=Strict" });
    res.end("{}");
  });
  const cfg = proxyConfig({ WORKBENCH_URL: up.url, WORKBENCH_KEY: "internal-service-key", WORKSPACE_DOOR_KEY: "the-door-key-0123456789",
    WORKSPACE_IDENTITY_HEADER: "X-Auth-Sub", WORKSPACE_IDENTITY_NAME_HEADER: "X-Auth-Name" });
  const front = await serve((req, res) => proxyWorkbench(req, res, cfg));
  try {
    const r = await fetch(`${front.url}/workbench/contract/documents`, { headers: { "x-auth-sub": "someone-else", "X-Auth-Name": "Mallory", cookie: "__Host-ob-ws-session=abc" } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("set-cookie") ?? "", /HttpOnly/);
    const w = await fetch(`${front.url}/workbench/auth/logout`, { method: "POST", headers: { origin: front.url, "x-auth-sub": "someone-else" } });
    assert.equal(w.status, 200);
    assert.deepEqual(seen, [
      { sub: undefined, name: undefined, cookie: "__Host-ob-ws-session=abc", key: "the-door-key-0123456789" },
      { sub: undefined, name: undefined, cookie: undefined, key: "the-door-key-0123456789" },
    ]);
  } finally {
    up.server.close(); front.server.close();
  }
});

test("rw-identity: without WORKSPACE_DOOR_KEY the door injects WORKBENCH_KEY, and nothing is stripped unless named", () => {
  const c = proxyConfig({ WORKBENCH_URL: "http://wb:8000", WORKBENCH_KEY: "k" });
  assert.equal(c.key, "k");
  assert.equal(c.strip.size, 0);
  assert.equal(proxyConfig({ WORKBENCH_URL: "http://wb:8000", WORKBENCH_KEY: "k", WORKSPACE_DOOR_KEY: "  d  " }).key, "d");
});
