#!/usr/bin/env node
/**
 * perf-nav - rw-p1b-ready acceptance 3: the explorer / nav floor, measured the
 * way PLAN-VIEWER-PERF measured its baseline, in a REAL browser.
 *
 * Baseline (PLAN-VIEWER-PERF section 0, 48,178 pages): explorer sort per
 * navigation 2,165 ms (the shipped comparator over the real index), nav TTFB
 * 3.4 s (a request after the nav cache expired), nav payload 16.3 MB raw
 * (/static/graphIndex.json). Floor (P1b): sort < 200 ms per navigation, nav
 * TTFB < 300 ms, nav payload < 2 MB. Target: sort < 100 ms, TTFB < 200 ms.
 *
 * What is measured, three parts:
 *  1. SERVER - nav TTFB from inside the network through the front door
 *     (fetch resolves at the response headers = time to first byte), N
 *     requests per folder for the root, the largest folder (first page and the
 *     page holding a deep entry), plus a burst while a refresh is running
 *     (a row written, the 15 s half-TTL passed: the request that finds the
 *     snapshot stale starts the refresh; every request here is timed).
 *  2. BROWSER - headless Chromium over CDP: open a page with ?wikiperf=1, then
 *     SPA-navigate through --pages. Per navigation: the explorer's own work
 *     (wikiperf "explorer" mark: the main-thread time of building the visible
 *     tree; the client sorts nothing), the setup's wall time ("explorer-wall"),
 *     every request's
 *     TTFB (receiveHeadersEnd - sendStart) and encoded bytes; the nav payload
 *     of a navigation = the bytes of its /workbench/nav and graphIndex.json
 *     responses. Any graphIndex.json / contentIndex.json request is reported.
 *  3. THROTTLED - the same browser run under Chrome DevTools' "Slow 4G"
 *     network profile (latency 562.5 ms, down 1.6 Mbps x 0.9, up 750 kbps x
 *     0.9) and Lighthouse's mobile CPU slowdown (4x); plus a mobile viewport
 *     where the explorer is built when the hamburger opens ("explorer-open").
 *     The client-observed TTFB through this profile includes the emulated
 *     562.5 ms request latency by construction; the server-attributable part
 *     (observed - 562.5 ms, and the response's server-timing app;dur) is what
 *     the floor is judged on there (findings: anchor fact F3).
 *
 *  4. LISTING PAGES (rw-p1b-ready fix round 1, tester attempt 1 defect 1):
 *     --pages may name folder pages ("content/tool/") and tag pages
 *     ("tags/<t>"); after each navigation the probe waits for the graph's
 *     /workbench/graph answer and 1.5 s more, so a whole-index fallback the
 *     graph would start is recorded (indexFetched) - the judge fails any.
 *     Listing pages are not explorer entries, so "active" is not asked there.
 *  5. --freeze: /static/graphIndex.json is read in full while a page and a
 *     nav are requested every 100 ms; the longest page/nav wait is reported
 *     (tester attempt 1: one cold request stalled pages 31,966 ms at 5x).
 *
 * Usage (inside the env network, the viewer image's node):
 *   node perf-nav.mjs --front http://<p>-front:8080 --chrome <p>-chrome --pages a,b,c [--label 1x] [--throttle] [--mobile] [--server-only]
 * Prints one JSON line "PERF-RESULT {...}" and a human summary; exit 0 always
 * (the runner judges the floor).
 */
import { lookup } from "node:dns/promises";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
const FRONT = arg("--front").replace(/\/+$/, "");
const CHROME = arg("--chrome", "");
const PAGES = (arg("--pages", "") || "").split(",").filter(Boolean);
const LABEL = arg("--label", "run");
const THROTTLE = has("--throttle");
const MOBILE = has("--mobile");
const N = Number(arg("--n", "30"));
const SLOW4G = { offline: false, latency: 562.5, downloadThroughput: (1.6 * 1024 * 1024 / 8) * 0.9, uploadThroughput: (750 * 1024 / 8) * 0.9 };
const CPU = 4;

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))].toFixed(1); };
const stats = (a) => ({ n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), max: a.length ? +Math.max(...a).toFixed(1) : null });

async function timedGet(path) {
  const t0 = performance.now();
  const r = await fetch(FRONT + path, { headers: { "cache-control": "no-cache" } });
  const ttfb = performance.now() - t0;
  const body = Buffer.from(await r.arrayBuffer());
  return { status: r.status, ttfb, bytes: body.length, st: r.headers.get("server-timing"), body };
}

// The nav answers (a cold viewer builds its site index first): bounded wait.
async function navReady(ms = 600000) {
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(FRONT + "/workbench/nav?folder=").catch(() => null);
    if (r && r.status === 200) return Date.now() - t0;
    if (Date.now() - t0 > ms) throw new Error("the nav never answered 200");
    await new Promise((res) => setTimeout(res, 1000));
  }
}

// ── 1. server ───────────────────────────────────────────────────────────────
async function serverPart() {
  const out = {};
  const root = JSON.parse((await timedGet("/workbench/nav?folder=")).body);
  let largest = { name: "", count: -1, slug: "" };
  const content = JSON.parse((await timedGet("/workbench/nav?folder=content")).body);
  for (const e of [...root.entries, ...content.entries]) if (e.folder && e.count > largest.count) largest = e;
  const lf = largest.slug.replace(/\/index$/, "");
  const lastPage = JSON.parse((await timedGet(`/workbench/nav?folder=${encodeURIComponent(lf)}&limit=1&offset=${Math.max(0, largest.count - 1)}`)).body);
  const deep = lastPage.entries[0]?.slug || "";
  const probes = {
    root: "/workbench/nav?folder=",
    content: "/workbench/nav?folder=content",
    largest: `/workbench/nav?folder=${encodeURIComponent(lf)}`,
    largestFocusDeep: `/workbench/nav?folder=${encodeURIComponent(lf)}&focus=${encodeURIComponent(deep)}`,
  };
  for (const [k, p] of Object.entries(probes)) {
    const t = [], bytes = [], st = [];
    for (let i = 0; i < N; i++) {
      const r = await timedGet(p);
      if (r.status !== 200) throw new Error(`${p} -> ${r.status}`);
      t.push(r.ttfb); bytes.push(r.bytes);
      const m = /dur=([\d.]+)/.exec(r.st || ""); if (m) st.push(Number(m[1]));
    }
    out[k] = { path: p, ttfb: stats(t), serverTiming: stats(st), bytesMax: Math.max(...bytes) };
  }
  out.largestFolder = { slug: lf, children: largest.count };
  return out;
}

// A burst of nav requests spanning a refresh (the runner writes a row and
// waits past the half-TTL before calling this with --refresh-burst).
async function refreshBurst() {
  const t = [];
  const until = Date.now() + Number(arg("--burst-ms", "20000"));
  while (Date.now() < until) {
    const r = await timedGet("/workbench/nav?folder=content");
    t.push(r.ttfb);
    await new Promise((res) => setTimeout(res, 50));
  }
  return stats(t);
}

// ── 2/3. browser ────────────────────────────────────────────────────────────
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.wait = new Map(); this.handlers = []; }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.wait.has(msg.id)) { const { res, rej } = c.wait.get(msg.id); c.wait.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
      else for (const h of c.handlers) h(msg);
    };
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => this.wait.set(id, { res, rej }));
  }
  on(fn) { this.handlers.push(fn); }
}

async function browserPart() {
  const { address } = await lookup(CHROME);
  const ver = await (await fetch(`http://${address}:9222/json/version`)).json();
  const cdp = await CDP.open(ver.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://${address}:9222`));
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const reqs = new Map(); // requestId -> record
  let loaded = 0;
  cdp.on((m) => {
    if (m.sessionId !== s) return;
    if (m.method === "Network.requestWillBeSent") reqs.set(m.params.requestId, { url: m.params.request.url, t: Date.now(), bytes: 0, done: false });
    else if (m.method === "Network.responseReceived") {
      const r = reqs.get(m.params.requestId); if (!r) return;
      const tm = m.params.response.timing;
      r.status = m.params.response.status;
      r.ttfb = tm ? tm.receiveHeadersEnd - tm.sendStart : null;
      r.st = m.params.response.headers["server-timing"] || m.params.response.headers["Server-Timing"] || null;
    } else if (m.method === "Network.loadingFinished") {
      const r = reqs.get(m.params.requestId); if (r) { r.bytes = m.params.encodedDataLength; r.done = true; }
    } else if (m.method === "Page.loadEventFired") loaded++;
  });
  await cdp.send("Page.enable", {}, s);
  await cdp.send("Network.enable", {}, s);
  await cdp.send("Runtime.enable", {}, s);
  if (MOBILE) await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, s);
  else await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, s);
  if (THROTTLE) {
    await cdp.send("Network.emulateNetworkConditions", SLOW4G, s);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU }, s);
  }
  const ev = async (expr) => (await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (expr, ms = 120000) => { const t0 = Date.now(); for (;;) { if (typeof expr === "function" ? expr() : await ev(expr)) return true; if (Date.now() - t0 > ms) return false; await sleep(100); } };

  const navs = [];
  const first = PAGES[0];
  const mark0 = Date.now();
  await cdp.send("Page.navigate", { url: `${FRONT}/${first}?wikiperf=1` }, s);
  await waitFor(`document.readyState === "complete"`);
  const builtFirst = await waitFor(`(window.__wikiperfLog || []).some((e) => e.name === ${JSON.stringify(MOBILE ? "explorer" : "explorer")})`);
  await sleep(300);
  const collect = (since) => [...reqs.values()].filter((r) => r.t >= since);
  const summarize = (label, since, log) => {
    const rs = collect(since);
    const nav = rs.filter((r) => /\/workbench\/nav\?|graphIndex\.json|contentIndex\.json/.test(r.url));
    return {
      to: label,
      explorerMs: log?.explorer ?? null, fetchMs: log?.fetch ?? null, li: log?.li ?? null,
      navRequests: nav.length,
      navBytes: nav.reduce((a, r) => a + (r.bytes || 0), 0),
      navTtfb: nav.map((r) => r.ttfb != null ? +r.ttfb.toFixed(1) : null),
      navServerTiming: nav.map((r) => r.st),
      indexFetched: rs.filter((r) => /graphIndex\.json|contentIndex\.json/.test(r.url)).map((r) => r.url),
      allBytes: rs.reduce((a, r) => a + (r.bytes || 0), 0),
      statuses: [...new Set(rs.map((r) => r.status))],
    };
  };
  const lastLog = async () => ev(`(() => { const L = window.__wikiperfLog || []; const e = [...L].reverse().find((x) => x.name === "explorer"); const f = [...L].reverse().find((x) => x.name === "explorer-wall"); return { n: L.length, explorer: e ? e.ms : null, fetch: f ? f.ms : null, li: e ? e.li : null, built: e ? e.built : null }; })()`);
  navs.push({ ...summarize(first + " (full load)", mark0, await lastLog()), built: builtFirst });
  for (const p of PAGES.slice(1)) {
    const before = (await lastLog()).n;
    const since = Date.now();
    await ev(`window.spaNavigate(new URL("/" + ${JSON.stringify(p)}, location.href))`);
    const ok = await waitFor(`(window.__wikiperfLog || []).length >= ${before + (MOBILE ? 1 : 2)}`, 120000);
    await sleep(200);
    const log = await lastLog();
    const listing = p.endsWith("/") || p.startsWith("tags/");
    // the page's own entry is in the explorer, marked active (its ancestors were opened and loaded)
    const active = MOBILE || listing ? null : await waitFor(`!!document.querySelector('.explorer-ul a.active[data-for="${p}"]')`, 30000);
    // the graph answered (or failed) for this page, then 1.5 s for a fallback it would start
    const graphSettled = await waitFor(() => [...reqs.values()].some((r) => r.t >= since && /\/workbench\/graph\?/.test(r.url) && (r.done || r.status >= 400)), 30000);
    await sleep(1500);
    navs.push({ ...summarize(p, since, log), ok, active, listing, graphSettled, slug: await ev("document.body.dataset.slug") });
  }
  // The explorer still WORKS (not only fast): a collapsed folder opens on its
  // icon and loads its children; a second click closes it (delegated handler).
  let toggle = null;
  if (!MOBILE) {
    const before = await ev(`(() => { const c = [...document.querySelectorAll(".explorer-ul .folder-container")].find((x) => !x.nextElementSibling.classList.contains("open")); if (!c) return null; c.setAttribute("data-perf-pick", "1"); c.querySelector(".folder-icon").dispatchEvent(new MouseEvent("click", { bubbles: true })); return { path: c.dataset.folderpath, li: document.querySelectorAll(".explorer-ul li").length }; })()`);
    if (before) {
      await waitFor(`(() => { const c = document.querySelector("[data-perf-pick]"); return c && c.nextElementSibling.querySelectorAll("li").length > 0; })()`, 30000);
      const opened = await ev(`(() => { const c = document.querySelector("[data-perf-pick]"); return { open: c.nextElementSibling.classList.contains("open"), children: c.nextElementSibling.querySelectorAll(":scope > ul > li").length }; })()`);
      await ev(`document.querySelector("[data-perf-pick] .folder-icon").dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
      const closed = await ev(`!document.querySelector("[data-perf-pick]").nextElementSibling.classList.contains("open")`);
      toggle = { folder: before.path, opened: opened.open, children: opened.children, closedAgain: closed, ok: opened.open && opened.children > 0 && closed };
    }
  }
  let mobileOpen = null;
  if (MOBILE) {
    const before = (await ev("(window.__wikiperfLog || []).length"));
    const since = Date.now();
    await ev(`document.querySelector(".explorer .mobile-explorer").click()`);
    await waitFor(`(window.__wikiperfLog || []).slice(${before}).some((e) => e.name === "explorer-open")`, 120000);
    const o = await ev(`(() => { const L = window.__wikiperfLog || []; const e = [...L].reverse().find((x) => x.name === "explorer-open"); const f = [...L].reverse().find((x) => x.name === "explorer-open-wall"); return { explorerOpenMs: e ? e.ms : null, fetchMs: f ? f.ms : null, li: e ? e.li : null }; })()`);
    mobileOpen = { ...o, ...summarize("hamburger open", since, null) };
  }
  await cdp.send("Target.closeTarget", { targetId });
  cdp.ws.close();
  return { navs, mobileOpen, toggle, loaded };
}

const result = { label: LABEL, throttle: THROTTLE ? { network: "Chrome DevTools Slow 4G", ...SLOW4G, cpuSlowdown: CPU } : null, mobile: MOBILE };
if (has("--freeze")) {
  result.freeze = await freezeProbe();
} else if (has("--refresh-burst")) {
  result.refreshBurst = await refreshBurst();
} else {
  result.navReadyAfterMs = await navReady();
  if (!has("--browser-only")) result.server = await serverPart();
  if (CHROME && !has("--server-only")) result.browser = await browserPart();
}

// --freeze: the whole index read in full while pages and the nav are asked
// every 100 ms; what a reader of a page waited meanwhile.
async function freezeProbe() {
  const page = arg("--freeze-page", "content/person/person-syn-500");
  const pages = [], navs = [];
  let stop = false;
  const loop = async (path, out) => { while (!stop) { const t0 = performance.now(); try { const r = await fetch(FRONT + path); await r.arrayBuffer(); out.push({ ms: performance.now() - t0, status: r.status }); } catch (e) { out.push({ ms: performance.now() - t0, status: String(e) }); } await new Promise((r) => setTimeout(r, 100)); } };
  const l1 = loop("/" + page, pages), l2 = loop("/workbench/nav?folder=content", navs);
  await new Promise((r) => setTimeout(r, 3000));
  const g0 = performance.now();
  const r = await fetch(FRONT + "/static/graphIndex.json", { headers: { "cache-control": "no-cache" } });
  const ttfb = performance.now() - g0;
  const bytes = (await r.arrayBuffer()).byteLength;
  const total = performance.now() - g0;
  await new Promise((res) => setTimeout(res, 2000));
  stop = true; await Promise.all([l1, l2]);
  const s = (a) => ({ n: a.length, max: a.length ? +Math.max(...a.map((x) => x.ms)).toFixed(1) : null, over300: a.filter((x) => x.ms > 300).length, over1000: a.filter((x) => x.ms > 1000).length, non200: a.filter((x) => x.status !== 200).length });
  return { graphIndex: { status: r.status, bytes, ttfb: +ttfb.toFixed(1), ms: +total.toFixed(1), xWikiNav: r.headers.get("x-wiki-nav") }, pages: s(pages), nav: s(navs) };
}

// ── judge + summary ─────────────────────────────────────────────────────────
const lat = THROTTLE ? SLOW4G.latency : 0;
const lines = [];
if (result.server) {
  for (const [k, v] of Object.entries(result.server)) if (v.ttfb) lines.push(`server ${k.padEnd(18)} ttfb p50=${v.ttfb.p50} p95=${v.ttfb.p95} max=${v.ttfb.max} ms  app=${v.serverTiming.p95}ms  bytes<=${v.bytesMax}`);
  lines.push(`largest folder: ${result.server.largestFolder.slug} (${result.server.largestFolder.children} children)`);
}
if (result.freeze) { const f = result.freeze; lines.push(`freeze: graphIndex.json ${f.graphIndex.status} ${f.graphIndex.bytes}B ttfb ${f.graphIndex.ttfb}ms total ${f.graphIndex.ms}ms | pages n=${f.pages.n} max=${f.pages.max}ms >300:${f.pages.over300} >1000:${f.pages.over1000} non200:${f.pages.non200} | nav n=${f.nav.n} max=${f.nav.max}ms >300:${f.nav.over300}`); }
if (result.refreshBurst) lines.push(`refresh burst ttfb p50=${result.refreshBurst.p50} p95=${result.refreshBurst.p95} max=${result.refreshBurst.max} ms (n=${result.refreshBurst.n})`);
if (result.browser) {
  for (const n of result.browser.navs) {
    const ttfb = n.navTtfb.filter((x) => x != null);
    lines.push(`nav -> ${String(n.to).slice(0, 48).padEnd(48)} explorer=${n.explorerMs}ms fetch=${n.fetchMs}ms li=${n.li} navReq=${n.navRequests} navBytes=${n.navBytes} ` +
      `navTTFB(max)=${ttfb.length ? Math.max(...ttfb).toFixed(1) : "-"}ms${lat ? ` (-latency ${ttfb.length ? (Math.max(...ttfb) - lat).toFixed(1) : "-"}ms)` : ""} index=${n.indexFetched.length}${n.listing ? " (listing page)" : ""}${n.graphSettled === false ? " graph-not-settled" : ""}`);
  }
  if (result.browser.toggle) lines.push(`folder toggle ${result.browser.toggle.folder}: opened=${result.browser.toggle.opened} children=${result.browser.toggle.children} closedAgain=${result.browser.toggle.closedAgain}`);
  if (result.browser.mobileOpen) lines.push(`mobile hamburger open: explorer-open=${result.browser.mobileOpen.explorerOpenMs}ms fetch=${result.browser.mobileOpen.fetchMs}ms navBytes=${result.browser.mobileOpen.navBytes}`);
}
console.log(lines.join("\n"));
console.log("PERF-RESULT " + JSON.stringify(result));
