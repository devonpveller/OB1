// serve.mjs, end to end over real sockets: the index and assets (acceptance 1, 2) and the /workbench/*
// forwarder it shares with the wiki viewer (acceptance 4). The upstream is a stub that records what
// it was sent.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../serve.mjs";
import { existsSync } from "node:fs";

// the shared module: lib/shared in the image build, the wiki viewer's lib/ in the repo
const shared = existsSync(new URL("../lib/shared/workbench-proxy.mjs", import.meta.url))
  ? "../lib/shared/workbench-proxy.mjs" : "../../wiki-viewer/lib/workbench-proxy.mjs";
const { proxyConfig } = await import(new URL(shared, import.meta.url).href);

const KEY = "door-key-not-for-browsers";
let dist, up, app, base, seen;

async function listen(handler) {
  const s = http.createServer(handler).listen(0, "127.0.0.1");
  await once(s, "listening");
  return { server: s, url: `http://127.0.0.1:${s.address().port}` };
}
function get(path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const r = http.request({ host: u.hostname, port: u.port, path, method, headers, setHost: !("host" in headers) }, (res) => {
      const b = []; res.on("data", (c) => b.push(c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString() }));
    });
    r.on("error", reject); r.end();
  });
}

before(async () => {
  dist = await mkdtemp(join(tmpdir(), "wbapp-"));
  await mkdir(join(dist, "assets"));
  await writeFile(join(dist, "index.html"), '<!doctype html><meta name="csp-nonce" content="__CSP_NONCE__"><title>INDEX</title>');
  await writeFile(join(dist, "assets", "index-abc123.js"), "console.log(1)");
  await writeFile(join(dist, "assets", "index-abc123.css"), "a{}");
  await writeFile(join(dist, "assets", "THIRD-PARTY-NOTICES.txt"), "notices");
  await writeFile(join(dist, "favicon.svg"), "<svg/>");
  seen = [];
  up = await listen((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json", "x-frame-options": "ALLOWALL" });
    res.end(JSON.stringify({ ok: true }));
  });
  const proxy = proxyConfig({ WORKBENCH_URL: up.url, WORKBENCH_KEY: KEY, WORKSPACE_IDENTITY_HEADER: "X-Workspace-User" });
  app = await listen(createHandler({ dist, proxy }));
  base = app.url;
});
after(async () => { app.server.close(); up.server.close(); await rm(dist, { recursive: true, force: true }); });

test("GET / returns the index with cache-control: no-cache", async () => {
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.match(r.body, /INDEX/);
  assert.equal(r.headers["cache-control"], "no-cache");
  assert.match(r.headers["content-type"], /text\/html/);
});

test("hashed assets are immutable", async () => {
  for (const f of ["index-abc123.js", "index-abc123.css"]) {
    const r = await get(`/assets/${f}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers["cache-control"], "public, max-age=31536000, immutable");
  }
  assert.equal((await get("/assets/missing-1.js")).status, 404);
  assert.equal((await get("/assets/..%2findex.html")).status, 404);
  assert.equal((await get("/assets/.hidden")).status, 404);
});

test("deep links return the index (not immutable)", async () => {
  for (const p of ["/documents/x", "/research", "/a/b/c?x=1", "/documents/x.pdf"]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.body, /INDEX/, p);
    assert.equal(r.headers["cache-control"], "no-cache", p);
  }
  const f = await get("/favicon.svg");
  assert.equal(f.headers["cache-control"], "no-cache");
});

test("/__health answers 200 when the build is present; security headers ride on every response", async () => {
  const h = await get("/__health");
  assert.equal(h.status, 200);
  assert.equal(JSON.parse(h.body).status, "ok");
  for (const p of ["/", "/assets/index-abc123.js", "/__health", "/nope/x"]) {
    const r = await get(p);
    assert.equal(r.headers["x-content-type-options"], "nosniff", p);
    assert.equal(r.headers["x-frame-options"], "DENY", p);
    assert.ok(r.headers["strict-transport-security"], p);
  }
});

test("writes to app routes are refused (405)", async () => {
  const r = await get("/documents/x", { method: "POST" });
  assert.equal(r.status, 405);
});

test("the forwarder injects the door key server-side; the browser never sees it", async () => {
  seen.length = 0;
  const r = await get("/workbench/ping?q=1", { headers: { "x-brain-key": "client-forged" } });
  assert.equal(r.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/workbench/ping?q=1");
  assert.equal(seen[0].headers["x-brain-key"], KEY, "the upstream got the server's key, not the client's");
  assert.ok(!JSON.stringify(r.headers).includes(KEY) && !r.body.includes(KEY), "the key is in nothing the browser receives");
  // and none of the app's own responses carries it either
  for (const p of ["/", "/__health", "/assets/index-abc123.js"]) {
    const x = await get(p);
    assert.ok(!JSON.stringify(x.headers).includes(KEY) && !x.body.includes(KEY), p);
  }
});

test("client-sent identity headers are stripped; X-authentik-jwt passes unchanged", async () => {
  seen.length = 0;
  const jwt = "eyJhbGciOiJSUzI1NiJ9.signed.by-outpost";
  await get("/workbench/whoami", { headers: {
    "remote-user": "mallory", "x-remote-user": "mallory", "x-forwarded-user": "mallory", "x-forwarded-email": "m@x",
    "x-auth-request-user": "mallory", "x-real-ip": "6.6.6.6", "x-workspace-user": "mallory", "x-authentik-jwt": jwt,
  } });
  const h = seen[0].headers;
  for (const n of ["remote-user", "x-remote-user", "x-forwarded-user", "x-forwarded-email", "x-auth-request-user", "x-real-ip", "x-workspace-user"]) {
    assert.equal(h[n], undefined, `${n} must not reach the workbench`);
  }
  assert.equal(h["x-authentik-jwt"], jwt);
  assert.equal(h["x-forwarded-proto"], "https");
});

test("an upstream's own security-header values lose to the server's", async () => {
  const r = await get("/workbench/ping");
  assert.equal(r.headers["x-frame-options"], "DENY");
});

test("a write needs the app's own origin; a wrong Host is refused (421)", async () => {
  seen.length = 0;
  const host = new URL(base).host;
  const noOrigin = await get("/workbench/x", { method: "POST" });
  assert.equal(noOrigin.status, 403);
  const evil = await get("/workbench/x", { method: "POST", headers: { origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  const rebound = await get("/workbench/x", { headers: { host: "rebound.example" } });
  assert.equal(rebound.status, 421);
  assert.equal(seen.length, 0, "refused requests never reached the workbench");
  const ok = await get("/workbench/x", { method: "POST", headers: { origin: `http://${host}` } });
  assert.equal(ok.status, 200);
});

// since round 2 these spellings are routed to the forwarder and refused there with 400: they never reach the workbench
test("odd spellings of /workbench are refused 400 by the forwarder, never the index, and never reach the upstream", async () => {
  seen.length = 0;
  for (const p of ["/Workbench/x", "//workbench/x", "/%57orkbench/x"]) {
    const r = await get(p);
    assert.equal(r.status, 400, p);
    assert.ok(!/INDEX/.test(r.body), p);
  }
  assert.equal(seen.length, 0, "the stub upstream received nothing");
});

test("with no key configured /workbench/* is not routed (404), never the index", async () => {
  const off = await listen(createHandler({ dist, proxy: proxyConfig({ WORKBENCH_URL: up.url }) }));
  const r = await new Promise((res) => http.get(off.url + "/workbench/x", (m) => { let b = ""; m.on("data", (c) => (b += c)); m.on("end", () => res({ s: m.statusCode, b })); }));
  assert.equal(r.s, 404);
  assert.ok(!/INDEX/.test(r.b));
  off.server.close();
});

test("an empty build answers /__health 503 and the index 503", async () => {
  const empty = await mkdtemp(join(tmpdir(), "wbapp-empty-"));
  const s = await listen(createHandler({ dist: empty, proxy: null }));
  const st = (p) => new Promise((res) => http.get(s.url + p, (m) => { m.resume(); res(m.statusCode); }));
  assert.equal(await st("/__health"), 503);
  assert.equal(await st("/"), 503);
  s.server.close(); await rm(empty, { recursive: true, force: true });
});

// round 2 (tester attempt 1, finding 4): only a file whose NAME carries a content hash is immutable
test("an unhashed asset (the notices file) is revalidated, never immutable", async () => {
  const r = await get("/assets/THIRD-PARTY-NOTICES.txt");
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "no-cache");
  assert.equal(r.body, "notices");
});

// round 2 (tester attempt 1, finding 6): a Content-Security-Policy on the app's HTML
test("the HTML carries a Content-Security-Policy: same-origin only, no framing", async () => {
  const csp = (await get("/")).headers["content-security-policy"];
  assert.ok(csp, "the index has a CSP");
  const d = Object.fromEntries(csp.split(";").map((x) => x.trim()).filter(Boolean).map((x) => { const [k, ...v] = x.split(/\s+/); return [k, v.join(" ")]; }));
  assert.equal(d["default-src"], "'self'");
  assert.equal(d["script-src"], "'self'");
  // rwr-doc-editor: the editor's own <style> element runs by a per-response nonce (below), never by 'unsafe-inline'
  assert.match(d["style-src"], /^'self' 'nonce-[A-Za-z0-9+/]{22}=='$/);
  assert.equal(d["img-src"], "'self' data:");
  assert.equal(d["font-src"], "'self'");
  // rwr-voices: a voice sample is fetched through the door and played from a blob: URL; media is the app's own or a blob: of its own making
  assert.equal(d["media-src"], "'self' blob:");
  assert.equal(d["connect-src"], "'self'");
  assert.equal(d["frame-ancestors"], "'none'");
  assert.equal(d["base-uri"], "'none'");
  assert.equal(d["form-action"], "'self'");
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp.replace(/'self'/g, "")), "no wildcard, no unsafe-*");
  const strip = (c) => c.replace(/'nonce-[^']+'/, "'nonce-X'");
  for (const p of ["/documents/x", "/research/abc?y=1"]) assert.equal(strip((await get(p)).headers["content-security-policy"]), strip(csp), p);
});

// rwr-doc-editor: the nonce is fresh per response, the same one in the policy and in the page's meta tag, and no
// placeholder is left in what the browser gets
test("the style nonce is fresh for every response and matches the page's meta tag", async () => {
  const nonceOf = (r) => /'nonce-([^']+)'/.exec(r.headers["content-security-policy"])[1];
  const a = await get("/"), b = await get("/documents/x");
  assert.notEqual(nonceOf(a), nonceOf(b));
  for (const r of [a, b]) {
    assert.ok(r.body.includes(`<meta name="csp-nonce" content="${nonceOf(r)}">`), "the meta tag carries this response's nonce");
    assert.ok(!r.body.includes("__CSP_NONCE__"), "no placeholder reaches the browser");
    assert.equal(Number(r.headers["content-length"]), Buffer.byteLength(r.body), "content-length is the rewritten page's");
  }
  assert.equal((await get("/", { method: "HEAD" })).body, "");
  assert.ok(!/nonce/.test((await get("/assets/index-abc123.css")).headers["content-security-policy"] ?? ""), "only the page carries the policy");
});
