// edge-b5-portal-retire (tester t-edge-b5 D1): the retired portal Caddy set the security response headers
// on every site; the tailnet route now reaches the viewer directly, so the viewer sets them itself, on
// every response - pages, the /workbench forwarder's answers (passed through or refused) and errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { SECURITY_HEADERS, withSecurityHeaders } from "./security-headers.mjs";
import { proxyConfig, proxyWorkbench } from "./workbench-proxy.mjs";

async function serve(handler) {
  const s = http.createServer(handler).listen(0, "127.0.0.1");
  await once(s, "listening");
  return { server: s, url: `http://127.0.0.1:${s.address().port}` };
}

const WANT = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=31536000",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin",
};

function check(r, label) {
  for (const [k, v] of Object.entries(WANT)) assert.equal(r.headers.get(k), v, `${label}: ${k}`);
}

test("the shipped set is the one the retired Caddy (security_headers) sent, HSTS without includeSubDomains", () => {
  for (const [k, v] of Object.entries(WANT)) assert.equal(SECURITY_HEADERS[k], v, k);
});

test("every response carries the security headers: a page, a 404, a thrown error, a proxied and a refused /workbench call", async () => {
  const up = await serve((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  const cfg = proxyConfig({ WORKBENCH_URL: up.url, WORKBENCH_KEY: "k" });
  const front = await serve(withSecurityHeaders(async (req, res) => {
    if (req.url.startsWith("/workbench/")) return proxyWorkbench(req, res, cfg);
    if (req.url === "/boom") throw new Error("boom");
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end("<p>page</p>"); return; }
    res.writeHead(404, { "content-type": "text/plain" }); res.end("nope");
  }));
  try {
    check(await fetch(`${front.url}/`), "page");
    check(await fetch(`${front.url}/missing`), "404");
    const boom = await fetch(`${front.url}/boom`);
    assert.equal(boom.status, 500);
    check(boom, "500");
    check(await fetch(`${front.url}/workbench/health`), "proxied");
    // fetch cannot set Host: a raw request names a rebound one
    const refused = await new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port: front.server.address().port, path: "/workbench/health", headers: { host: "rebound.example" } },
        (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode, headers: new Headers(Object.entries(res.headers).map(([k, v]) => [k, String(v)])) })); });
      r.on("error", reject); r.end();
    });
    assert.equal(refused.status, 421);
    check(refused, "421");
  } finally {
    up.server.close(); front.server.close();
  }
});
