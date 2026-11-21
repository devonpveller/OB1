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

test("forwards /workbench/* with the key injected and the client's key and Remote-User dropped", async () => {
  const l = await lab();
  try {
    const r = await fetch(`${l.front.url}/workbench/documents/file?path=x`, { method: "PUT", headers: { "x-brain-key": "forged", "remote-user": "alice", "content-type": "application/json", origin: l.origin }, body: "{}" });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get("x-up"), "1");
    assert.deepEqual(l.seen[0], { method: "PUT", url: "/workbench/documents/file?path=x", key: "server-side-key", user: undefined, bytes: 2 }); // edge-b5: a client-sent Remote-User never passes
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


// edge-b5-portal-retire (tester t-edge-b5 D1): with the portal Caddy retired, the tailnet route reaches
// the viewer directly, and nothing in front of it strips what a client claims about who or where it is.
// The viewer does it: every unsigned identity or proxy-chain header a client sends is dropped from every
// forwarded request, whatever door it came through and whatever WORKSPACE_IDENTITY_HEADER says. Only the
// SIGNED Authentik token passes (the workbench verifies it); X-Forwarded-Proto is the viewer's own.
const FORGED = {
  "remote-user": "forged-author", "remote-groups": "admins", "remote-name": "Forged", "remote-email": "f@x.example",
  "x-remote-user": "forged-author", "x-forwarded-user": "forged-author", "x-forwarded-preferred-username": "forged-author",
  "x-forwarded-email": "f@x.example", "x-forwarded-groups": "admins", "x-forwarded-host": "evil.example",
  "x-forwarded-for": "203.0.113.9", "x-forwarded-port": "443", "x-forwarded-prefix": "/evil", "x-real-ip": "203.0.113.9",
  forwarded: "for=203.0.113.9;host=evil.example", "x-original-url": "/evil", "x-auth-request-user": "forged-author",
};

test("edge-b5: no client-sent identity or proxy-chain header reaches the workbench, on any Host the viewer answers", async () => {
  const seen = [];
  const up = await serve(async (req, res) => {
    for await (const _ of req);
    seen.push(Object.fromEntries(Object.entries(req.headers).filter(([k]) => k in FORGED || k === "x-forwarded-proto" || k === "x-authentik-jwt")));
    res.writeHead(201, { "content-type": "application/json" });
    res.end("{}");
  });
  const cfg = proxyConfig({ WORKBENCH_URL: up.url, WORKBENCH_KEY: "server-side-key", WIKI_VIEWER_ALLOWED_HOSTS: "lab-tailnet.example" });
  const front = await serve((req, res) => proxyWorkbench(req, res, cfg));
  const port = front.server.address().port;
  const send = (host, origin, extra = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method: "POST", path: "/workbench/notes",
      headers: { host, origin, "content-type": "application/json", "x-forwarded-proto": "http", ...FORGED, ...extra } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    r.on("error", reject); r.end("{}");
  });
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.AAAA-_bb";
  try {
    assert.equal(await send("lab-tailnet.example:8444", "https://lab-tailnet.example:8444"), 201); // the tailnet name
    assert.equal(await send("localhost", "http://localhost"), 201); // the always-allowed loopback name (tester's case)
    assert.equal(await send("lab-tailnet.example:8444", "https://lab-tailnet.example:8444", { "x-authentik-jwt": token }), 201); // the LAN door's token
    assert.deepEqual(seen, [
      { "x-forwarded-proto": "https" },
      { "x-forwarded-proto": "https" },
      { "x-forwarded-proto": "https", "x-authentik-jwt": token },
    ]);
  } finally {
    up.server.close(); front.server.close();
  }
});

// rw-identity: a client never names its own identity, and the door injects the door key.
test("rw-identity: the identity header is dropped from every client request; cookies pass; the door key is injected", async () => {
  const seen = [];
  const up = await serve(async (req, res) => {
    for await (const _ of req);
    seen.push({ sub: req.headers["x-auth-sub"], name: req.headers["x-auth-name"], cookie: req.headers.cookie, key: req.headers["x-brain-key"] });
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "upstream=t; Path=/; Secure; HttpOnly; SameSite=Strict" });
    res.end("{}");
  });
  const cfg = proxyConfig({ WORKBENCH_URL: up.url, WORKBENCH_KEY: "internal-service-key", WORKSPACE_DOOR_KEY: "the-door-key-0123456789",
    WORKSPACE_IDENTITY_HEADER: "X-Auth-Sub", WORKSPACE_IDENTITY_NAME_HEADER: "X-Auth-Name" });
  const front = await serve((req, res) => proxyWorkbench(req, res, cfg));
  try {
    const r = await fetch(`${front.url}/workbench/contract/documents`, { headers: { "x-auth-sub": "someone-else", "X-Auth-Name": "Mallory", cookie: "authentik_proxy_x=abc" } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("set-cookie") ?? "", /HttpOnly/);
    const w = await fetch(`${front.url}/workbench/auth/impersonate/end`, { method: "POST", headers: { origin: front.url, "x-auth-sub": "someone-else" } });
    assert.equal(w.status, 200);
    assert.deepEqual(seen, [
      { sub: undefined, name: undefined, cookie: "authentik_proxy_x=abc", key: "the-door-key-0123456789" },
      { sub: undefined, name: undefined, cookie: undefined, key: "the-door-key-0123456789" },
    ]);
  } finally {
    up.server.close(); front.server.close();
  }
});

// rw-identity2: Authentik forward-auth. Traefik puts the outpost's signed token (X-authentik-jwt) on the
// request; the viewer passes it to the workbench UNCHANGED (the workbench verifies it) and never makes,
// alters or judges one itself - a request without one reaches the workbench without one.
test("rw-identity2: the Authentik token header is forwarded byte-for-byte; the viewer never mints or judges one", async () => {
  const seen = [];
  const up = await serve(async (req, res) => {
    for await (const _ of req);
    seen.push({ jwt: req.headers["x-authentik-jwt"], uid: req.headers["x-authentik-uid"], key: req.headers["x-brain-key"] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const cfg = proxyConfig({ WORKBENCH_URL: up.url, WORKBENCH_KEY: "internal-service-key", WORKSPACE_DOOR_KEY: "the-door-key-0123456789",
    WORKSPACE_IDENTITY_HEADER: "X-Auth-Sub" });
  const front = await serve((req, res) => proxyWorkbench(req, res, cfg));
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.AAAA-_bb";
  try {
    assert.equal((await fetch(`${front.url}/workbench/contract/documents`, { headers: { "x-authentik-jwt": token, "x-authentik-uid": "u1" } })).status, 200);
    assert.equal((await fetch(`${front.url}/workbench/contract/documents`, { headers: { "x-authentik-uid": "u1" } })).status, 200);
    assert.equal((await fetch(`${front.url}/workbench/auth/impersonate/end`, { method: "POST", headers: { origin: front.url, "x-authentik-jwt": "not even a jwt" } })).status, 200);
    assert.deepEqual(seen, [
      { jwt: token, uid: "u1", key: "the-door-key-0123456789" },
      { jwt: undefined, uid: "u1", key: "the-door-key-0123456789" },
      { jwt: "not even a jwt", uid: undefined, key: "the-door-key-0123456789" },
    ]);
    assert.equal(cfg.strip.has("x-authentik-jwt"), false);
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

test("rw-identity round 5: a non-canonical spelling of /workbench is still the workbench's", async () => {
  const { isWorkbenchPath } = await import("./workbench-proxy.mjs");
  for (const p of ["/workbench/documents", "/workbench\\documents\\folders", "/%77orkbench/documents", "/WORKBENCH/x", "//workbench/x", "/workbench%5cdocuments", "/workbench;x"]) {
    assert.equal(isWorkbenchPath(p), true, p);
  }
  for (const p of ["/workspace/", "/content/x", "/workbenchx", "/"]) assert.equal(isWorkbenchPath(p), false, p);
});

// rwr-app-scaffold round 2 (tester attempt 1, finding 2): the forwarder built new URL(cfg.url + req.url),
// which RESOLVES dot-segments, so /workbench/../admin reached the upstream as /admin WITH the door key.
// Every spelling below must be refused with 400 and never reach the upstream; and the ordinary calls pass.
async function pathLab(extra = {}) {
  const seen = [];
  const up = await serve((req, res) => {
    seen.push(req.url);
    if (req.url === "/workbench/redirect-abs") { res.writeHead(302, { location: `http://${req.headers.host}/workbench/next?x=1#h` }); return res.end(); }
    if (req.url === "/workbench/redirect-rel") { res.writeHead(302, { location: "/workbench/next" }); return res.end(); }
    if (req.url === "/workbench/redirect-foreign") { res.writeHead(302, { location: "https://elsewhere.example/x" }); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const cfg = proxyConfig({ WORKBENCH_URL: up.url, WORKBENCH_KEY: "k", ...extra });
  const front = await serve((req, res) => proxyWorkbench(req, res, cfg));
  const port = front.server.address().port;
  const send = (path) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method: "GET", setHost: true }, (res) => {
      res.resume(); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    r.on("error", reject); r.end();
  });
  return { seen, send, close: () => { up.server.close(); front.server.close(); } };
}

test("a path that resolves outside /workbench/ is refused 400 and never reaches the upstream", async () => {
  const l = await pathLab();
  try {
    const bad = ["/workbench/../admin", "/workbench/%2e%2e/admin", "/workbench/.%2e/admin", "/workbench/%2e./admin", "/workbench/%2E%2E/admin",
      "/workbench\\..\\admin", "/workbench/..\\admin", "/WORKBENCH/../admin", "/Workbench/x", "/%77orkbench/../admin", "/%77orkbench/x",
      "/workbench;/../admin", "//workbench/../admin", "//workbench/x", "/workbench/x/../../admin", "/workbench/./x", "/workbench/x%2f..%2f..%2fadmin",
      "/workbench/%252e%252e/admin", "/workbench/..%5cadmin", "/workbench/%5c", "/workbench/a%00b", "/workbench/a%0d%0ab",
      "/workbench/.%09./admin", "/workbench/..%0a/admin",
      // round 3: a literal % must not hide a traversal that a LATER decode pass would reveal
      "/workbench/50%25/%2e%2e/admin", "/workbench/a%25%5c..%5cadmin", "/workbench/%25/%252e%252e/admin", "/workbench/a%25b/%252e%252e/%252e%252e/admin",
      "/workbench/50%25.md/..%2fadmin", "/workbench/50%25%0d%0a", "/workbench/%252e%252e/admin",
      "/workbenchx", "/workbench%2fx", "/workbench;x"];
    for (const p of bad) {
      const r = await l.send(p);
      assert.equal(r.status, 400, p);
    }
    assert.deepEqual(l.seen, [], "nothing reached the upstream");
    for (const p of ["/workbench/documents?path=a/../b", "/workbench/a..b/x", "/workbench/x/..foo", "/workbench/a%20b", "/workbench/export/x.pdf", "/workbench/"]) {
      assert.equal((await l.send(p)).status, 200, p);
    }
    assert.deepEqual(l.seen, ["/workbench/documents?path=a/../b", "/workbench/a..b/x", "/workbench/x/..foo", "/workbench/a%20b", "/workbench/export/x.pdf", "/workbench/"]);
  } finally {
    l.close();
  }
});

test("an upstream absolute Location is rewritten to a relative path (or dropped when foreign); relative passes", async () => {
  const l = await pathLab();
  try {
    const a = await l.send("/workbench/redirect-abs");
    assert.equal(a.status, 302);
    assert.equal(a.headers.location, "/workbench/next?x=1#h");
    assert.equal((await l.send("/workbench/redirect-rel")).headers.location, "/workbench/next");
    const f = await l.send("/workbench/redirect-foreign");
    assert.equal(f.status, 302);
    assert.equal(f.headers.location, undefined, "a foreign absolute Location is dropped, never an address of the upstream");
  } finally {
    l.close();
  }
});

// rwr-app-scaffold round 3 (tester attempt 2, Case 13): the live viewer's real /workbench request shapes
// (NotesEditor builds "/workbench/notes/" + path.split("/").map(encodeURIComponent).join("/")). A note name
// holding a literal % encodes to %25; the guard's later decode pass threw on it and refused the request.
// Every shape the old (0545343) forwarder forwarded is forwarded again, EXCEPT two classes refused on purpose since
// round 2 (see the next test): a backslash and a control character in a decoded name (the vault is edited on
// Windows/Obsidian, which allow neither in a file name; and a backslash reads as a slash to some parsers, a
// control character is stripped by fetch() - both are how a dot-segment is hidden). "/workbench" and "/workbench?x=1" are forwarded too.
test("round 3: every real /workbench request shape of the live viewer is forwarded (literal %, spaces, bare /workbench)", async () => {
  const l = await pathLab();
  try {
    const enc = encodeURIComponent;
    const notePath = (p) => "/workbench/notes/" + p.split("/").map(enc).join("/");
    const shapes = [
      "/workbench", "/workbench?x=1", "/workbench/", "/workbench/health", "/workbench/nav?folder=" + enc("Research/My Notes"),
      "/workbench/search?q=" + enc("100% sure ../x") + "&limit=5", "/workbench/export?path=" + enc("a/../b.md") + "&format=pdf",
      notePath("Research/My Note.md"), notePath("Research/100% done.md"), notePath("50%.md"), notePath("a/100%41.md"),
      notePath("a/Q&A #1 (draft).md"), notePath("a/café ✓.md"), notePath("a/..hidden.md"), notePath("a/....md"),
      notePath("a/.obsidian/x.md"), notePath("a/b."), notePath("a/it's [x] {y}.md"), "/workbench/notes/a/" + enc("x/y"),
      "/workbench/sources/3f2c0a9e-1111-4222-8333-444455556666", "/workbench/sources/" + enc("src:abc 123"), "/workbench/notebooks/" + enc("thread 1/2"),
      "/workbench/grounding/" + enc("a b"), "/workbench/documents/file?path=" + enc("My Doc.md"), "/workbench/contract/documents/" + enc("doc:1"),
      "/workbench/jobs/123", "/workbench/sources/abc/replace-from-upload", "/workbench/idea-schedule/research-now/" + enc("id 1"),
      "/workbench/notes/a%20b", "/workbench/a..b/x", "/workbench/ping?q=1", "/workbench/notes/50%25.md", "/workbench/notes/Research/100%25%20done.md",
      "/workbench?x=/../admin",
    ];
    for (const s of shapes) assert.equal((await l.send(s)).status, 200, s);
    assert.deepEqual(l.seen, shapes, "each one reached the upstream exactly as sent");
  } finally {
    l.close();
  }
});

// rwr-app-scaffold round 4 (reviewer 1, 2): a backslash or control character in a note name is refused ON PURPOSE
// (the round-3 test wrote "back\slash" with a single backslash, which JavaScript reads as "backslash": no backslash was sent).
test("round 4: a backslash or control character in a note name is refused 400 (deliberate), never forwarded", async () => {
  const l = await pathLab();
  try {
    const enc = encodeURIComponent;
    const notePath = (p) => "/workbench/notes/" + p.split("/").map(enc).join("/");
    for (const p of [notePath("a/back\\slash.md"), "/workbench/notes/a/back%5Cslash.md", notePath("a/tab\tname.md"), "/workbench/notes/a/x%09.md",
      "/workbench/notes/a/" + enc("x%0a.md"), "/workbench/notes/a/x%250a.md"]) {
      assert.equal((await l.send(p)).status, 400, p);
    }
    assert.ok(notePath("a/back\\slash.md").includes("%5C"), "the case really carries a backslash");
    assert.deepEqual(l.seen, []);
  } finally {
    l.close();
  }
});

// rwr-app-scaffold round 4 (reviewer 1): a path still changing after the 6 decode passes is refused, not forwarded.
test("round 4: '..' encoded 6 and 7 times is refused 400 (too deeply encoded); depths 1-5 still 400", async () => {
  const l = await pathLab();
  try {
    const deep = (n) => { let s = "%2e%2e"; for (let i = 1; i < n; i++) s = s.replace(/%/g, "%25"); return s; };
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) assert.equal((await l.send("/workbench/" + deep(n) + "/admin")).status, 400, "depth " + n);
    assert.deepEqual(l.seen, [], "nothing reached the upstream");
  } finally {
    l.close();
  }
});

// rwr-app-scaffold round 4 (reviewer 4): a base path on WORKBENCH_URL is stripped from an absolute Location.
test("round 4: with a base path on WORKBENCH_URL an absolute Location is made relative to the workbench, base removed", async () => {
  const seen = [];
  const up = await serve((req, res) => {
    seen.push(req.url);
    res.writeHead(302, { location: `http://${req.headers.host}/base/workbench/next?x=1#h` });
    res.end();
  });
  const cfg = proxyConfig({ WORKBENCH_URL: up.url + "/base", WORKBENCH_KEY: "k" });
  const front = await serve((req, res) => proxyWorkbench(req, res, cfg));
  try {
    const r = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: front.server.address().port, path: "/workbench/go" }, (res) => { res.resume(); res.on("end", () => resolve(res)); }).on("error", reject);
    });
    assert.deepEqual(seen, ["/base/workbench/go"]);
    assert.equal(r.statusCode, 302);
    assert.equal(r.headers.location, "/workbench/next?x=1#h");
  } finally {
    up.server.close(); front.server.close();
  }
});
