// edge-b5-portal-retire (tester t-edge-b5 D1): the retired portal Caddy set the security response headers
// on every site; the tailnet route now reaches the viewer directly, so the viewer sets them itself, on
// every response - pages, the /workbench forwarder's answers (passed through or refused) and errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import * as sec from "./security-headers.mjs";
const { SECURITY_HEADERS, withSecurityHeaders } = sec;
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
  // round 3 (tester t-edge-b5b D3): the retired Caddy's CORP, same-site (Caddyfile:46). Every resource
  // the viewer serves is loaded same-origin - its pages, the workspace's assets, the PDF it embeds in
  // its own <iframe> - so same-site blocks nothing it uses; no route is exempt.
  "cross-origin-resource-policy": "same-site",
};

function check(r, label) {
  for (const [k, v] of Object.entries(WANT)) assert.equal(r.headers.get(k), v, `${label}: ${k}`);
}

test("the shipped set is the one the retired Caddy (security_headers) sent, HSTS without includeSubDomains, CORP included", () => {
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

// round 3 (tester t-edge-b5b, latent): the viewer's security headers WIN - an upstream's (the workbench
// behind the forwarder) or a handler's own value never replaces one with a weaker one. The one
// deliberate relaxation is allowSameOriginFraming(res) (the PDF attachments the wiki embeds itself):
// X-Frame-Options SAMEORIGIN for that response only, everything else unchanged.
test("an upstream's or a handler's weaker value never replaces a viewer security header", async () => {
  const weak = { "x-frame-options": "SAMEORIGIN", "cross-origin-resource-policy": "cross-origin",
    "strict-transport-security": "max-age=0", "x-content-type-options": "sniff", "referrer-policy": "unsafe-url",
    "cross-origin-opener-policy": "unsafe-none" };
  const up = await serve((req, res) => { res.writeHead(200, { "content-type": "application/json", ...weak }); res.end("{}"); });
  const cfg = proxyConfig({ WORKBENCH_URL: up.url, WORKBENCH_KEY: "k" });
  const front = await serve(withSecurityHeaders(async (req, res) => {
    if (req.url.startsWith("/workbench/")) return proxyWorkbench(req, res, cfg);
    if (req.url === "/set") { for (const [k, v] of Object.entries(weak)) res.setHeader(k, v); res.end("x"); return; }
    if (req.url === "/raw") { res.writeHead(200, Object.entries(weak).flat()); res.end("x"); return; }
    res.writeHead(200, { "content-type": "text/plain", "X-Frame-Options": "ALLOWALL" }); res.end("x");
  }));
  try {
    check(await fetch(`${front.url}/workbench/weak`), "upstream (the forwarder)");
    check(await fetch(`${front.url}/set`), "setHeader then implicit writeHead");
    check(await fetch(`${front.url}/raw`), "writeHead with a raw header array");
    check(await fetch(`${front.url}/case`), "writeHead object, other case");
  } finally {
    up.server.close(); front.server.close();
  }
});

test("allowSameOriginFraming relaxes X-Frame-Options to SAMEORIGIN for that response only; CORP and the rest stay", async () => {
  assert.equal(typeof sec.allowSameOriginFraming, "function");
  const front = await serve(withSecurityHeaders(async (req, res) => {
    if (req.url === "/a.pdf") { sec.allowSameOriginFraming(res); res.setHeader("x-frame-options", "ALLOWALL"); }
    res.writeHead(200, { "content-type": req.url === "/a.pdf" ? "application/pdf" : "text/html" }); res.end("x");
  }));
  try {
    const pdf = await fetch(`${front.url}/a.pdf`);
    assert.equal(pdf.headers.get("x-frame-options"), "SAMEORIGIN");
    for (const [k, v] of Object.entries(WANT)) if (k !== "x-frame-options") assert.equal(pdf.headers.get(k), v, `pdf: ${k}`);
    check(await fetch(`${front.url}/page`), "a page next to it");
  } finally {
    front.server.close();
  }
});
