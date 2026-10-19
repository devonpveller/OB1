/**
 * nav-worker - the explorer's nav, served from its OWN thread and heap
 * (research-workbench P1b).
 *
 * WHY A WORKER: the floor (nav TTFB < 300 ms at five times today's 76,542
 * pages) cannot hold in the page renderer's thread. That thread keeps the
 * whole site index (backlinks, tags, aliases, link resolution - ~0.5 GB at
 * 383k rows), and a mark-compact of a heap that size paused it 0.45-0.96 s
 * (measured, --trace-gc, rw-p1b-ready findings). A request arriving then waits
 * the pause out. This thread holds only what the explorer needs (titles,
 * folders, folder names: lib/nav-tree.mjs over a nav-only site index read with
 * the narrow projection), so its collections are small, and it listens on its
 * own port (WIKI_NAV_PORT, 8082), so a pause in the page thread never delays
 * a nav answer. The workbench's /workbench/nav forwards here.
 *
 *   GET /__nav?folder=<path>&offset=<n>&limit=<n>&focus=<slug>   one folder, sorted, ETag/304
 *   GET /__nav-health                                            200 {ok,...} | 503 (the last refresh failed / none yet)
 *
 * The page thread (serve.mjs) starts this worker, restarts it if it exits,
 * proxies its own /__nav here (for probes on the published port) and reports
 * it in /__health.
 */
import http from "node:http";
import { workerData, parentPort } from "node:worker_threads";
import { configureNavIndex, getNavIndex, navIndexStatus } from "./nav-index.mjs";
import { navPage, normalizeFolder } from "./nav-tree.mjs";

configureNavIndex({ navOnly: true });
const PORT = Number(workerData?.port || process.env.WIKI_NAV_PORT || 8082);
const serverTiming = (t0) => `app;dur=${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)}`;

async function handle(req, res) {
  const t0 = process.hrtime.bigint();
  const u = new URL(req.url || "/", "http://nav");
  const json = (status, obj) => {
    const b = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "server-timing": serverTiming(t0), "content-length": Buffer.byteLength(b) });
    res.end(req.method === "HEAD" ? undefined : b);
  };
  if (u.pathname === "/__nav-health") {
    const st = navIndexStatus();
    return json(st.ok ? 200 : 503, st);
  }
  if (u.pathname !== "/__nav") return json(404, { error: "not found" });
  const folder = normalizeFolder(u.searchParams.get("folder") ?? "");
  if (folder == null) return json(400, { error: "bad folder" });
  const nav = await getNavIndex();
  const st = navIndexStatus();
  // the database not answering is the front end's ONE screen (D13 item 3): the
  // explorer gets a 503, never a nav from a snapshot the database may have moved past
  if (!st.ok) return json(503, { error: `nav unavailable: ${st.error}` });
  if (!nav?.site) return json(503, { error: "nav index unavailable" });
  const p = navPage(nav.site, folder, { offset: u.searchParams.get("offset"), limit: u.searchParams.get("limit"), focus: u.searchParams.get("focus") });
  if (!p) return json(404, { error: "no such folder", folder });
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache, must-revalidate",
    etag: p.etag,
    "x-wiki-nav": "db",
    "server-timing": serverTiming(t0),
  };
  if (req.headers["if-none-match"] === p.etag) { res.writeHead(304, headers); res.end(); return; }
  res.writeHead(200, { ...headers, "content-length": Buffer.byteLength(p.json) });
  res.end(req.method === "HEAD" ? undefined : p.json);
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error("[wiki-viewer] nav worker request failed:", e?.stack || e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("internal error");
  });
}).listen(PORT, () => {
  console.log(`[wiki-viewer] nav worker on :${PORT}`);
  parentPort?.postMessage({ listening: PORT });
  void getNavIndex(); // warm: the first explorer request should not wait for the walk
});
