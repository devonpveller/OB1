// The door's host / origin guard as the COMPOSE service passes it (rwr-app-container): the env below is
// the shape docker-compose.yml gives openbrain-workbench-app - WIKI_VIEWER_ALLOWED_HOSTS lists the
// service's own name plus the operator's door host, WIKI_VIEWER_ALLOWED_ORIGINS the door's origin.
// Proves over real sockets: a disallowed Host is refused (421) and never reaches the workbench; a
// cross-origin / origin-less / "null"-origin write is refused (403); the service name, the loopback
// and the configured edge host/origin are accepted; the key is injected only on accepted requests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createHandler } from "../serve.mjs";

const shared = existsSync(new URL("../lib/shared/workbench-proxy.mjs", import.meta.url))
  ? "../lib/shared/workbench-proxy.mjs" : "../../wiki-viewer/lib/workbench-proxy.mjs";
const { proxyConfig } = await import(new URL(shared, import.meta.url).href);

const EDGE_HOST = "research.example.internal";
const EDGE_ORIGIN = "https://research.example.internal";
let dist, up, app, seen;

async function listen(handler) {
  const s = http.createServer(handler).listen(0, "127.0.0.1");
  await once(s, "listening");
  return { server: s, port: s.address().port };
}
function call(method, path, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: app.port, path, method, headers, setHost: false }, (res) => {
      const b = []; res.on("data", (c) => b.push(c)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(b).toString() }));
    });
    r.on("error", reject); r.end(method === "POST" ? "{}" : undefined);
  });
}

before(async () => {
  dist = await mkdtemp(join(tmpdir(), "wbapp-guard-"));
  await writeFile(join(dist, "index.html"), "<!doctype html>");
  seen = [];
  up = await listen((req, res) => { seen.push(req); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  const proxy = proxyConfig({
    WORKBENCH_URL: `http://127.0.0.1:${up.port}`, WORKBENCH_KEY: "k", WORKSPACE_DOOR_KEY: "door-key",
    WIKI_VIEWER_ALLOWED_HOSTS: `openbrain-workbench-app,${EDGE_HOST}`, WIKI_VIEWER_ALLOWED_ORIGINS: EDGE_ORIGIN,
  });
  app = await listen(createHandler({ dist, proxy }));
});
after(async () => { app.server.close(); up.server.close(); await rm(dist, { recursive: true, force: true }); });

test("a disallowed Host is refused (421) and never reaches the workbench", async () => {
  const n = seen.length;
  for (const host of ["evil.example", "rebind.example:8820", "openbrain-workbench:8000", "127.0.0.1.evil.example", "[::2]"]) {
    const r = await call("GET", "/workbench/workspace/whoami", { host });
    assert.equal(r.status, 421, `host "${host}"`);
  }
  assert.equal(seen.length, n);
});

test("the service name, loopback and the configured door host are answered, with the door key injected", async () => {
  for (const host of ["openbrain-workbench-app:8080", "127.0.0.1:8820", "localhost", EDGE_HOST]) {
    const r = await call("GET", "/workbench/workspace/whoami", { host });
    assert.equal(r.status, 200, host);
    assert.equal(seen.at(-1).headers["x-brain-key"], "door-key");
  }
});

test("a cross-origin, origin-less or null-origin write is refused (403) and never reaches the workbench", async () => {
  const n = seen.length;
  const base = { host: EDGE_HOST };
  for (const h of [{ origin: "https://evil.example" }, {}, { origin: "null" }, { origin: EDGE_ORIGIN, "sec-fetch-site": "cross-site" },
    { origin: EDGE_ORIGIN, referer: "https://evil.example/x" }]) {
    const r = await call("POST", "/workbench/documents", { ...base, ...h });
    assert.equal(r.status, 403, JSON.stringify(h));
  }
  assert.equal(seen.length, n);
});

test("a write from the door's own origin or its configured edge origin is forwarded", async () => {
  assert.equal((await call("POST", "/workbench/documents", { host: EDGE_HOST, origin: EDGE_ORIGIN })).status, 200);
  assert.equal((await call("POST", "/workbench/documents", { host: "127.0.0.1:8820", origin: "http://127.0.0.1:8820" })).status, 200);
});
