// The wiki viewer's server (research-workbench P1a: the live renderer).
//
// EVERY PAGE URL IS PRESENTED FROM wiki_pages (D13: ingest -> compile ->
// present; the row is what is presented). lib/live-route.mjs resolves the URL
// through the page-class registry and renders it with the Quartz chrome
// (lib/chrome.mjs): x-wiki-render: db. A known page without a row is the
// typed pending-compile state (x-wiki-render: pending); a database that does
// not answer is ONE front-end screen for every URL (x-wiki-render:
// connecting|unreachable). Nothing is rendered from a vault file.
//
// READINESS (research-workbench P1b, P1c): the viewer serves the moment it
// listens. The client bundle and static assets (index.css, prescript.js,
// postscript.js, static/*) are the FROZEN bundle (/viewer/bundle: committed
// repo files, D7 - emitted once by Quartz v4.5.1 + quartz-overlay/, before the
// freeze tool was retired (rw-p1c-retire2); the image carries no Quartz).
// A file the bundle does not carry is a vault attachment,
// read from the vault itself (/wiki, read-only: a non-page file in a content
// directory that the vault .gitignore does not exclude). There is no builder, no snapshot
// volume (/srv), no swap loop and no nightly rebuild (P1c): nothing in this
// container rebuilds anything, so a redeploy serves pages at once. Health is
// /__health (the compose healthcheck): the site index warm (P1c: the cold
// build is paid at start, not by the first reader), database up,
// reconciliation at zero drift, no broken page class, no render error.
//
// The nav (P1b, E3): the explorer reads ONE folder at a time from /__nav,
// served by the NAV WORKER (lib/nav-worker.mjs: its own thread, heap and port
// WIKI_NAV_PORT=8082, so a GC pause of this thread's large site index never
// delays it); the browser reaches it as /workbench/nav through the workbench,
// and this server's own /__nav proxies to it (probes on the published port).
// /static/graphIndex.json is still answered LIVE from wiki_pages
// for its two remaining lazy readers (the graph's offline fallback, the notes
// editor's link autocomplete); no published file backs it any more.
//
// Kept from the 2026-08-23 perf rework: async I/O, ETag/Last-Modified
// validators with 304s on assets. P1b adds ETag/304 on pages. P1c removes the
// last-access bookkeeping (/__last-access): no background process waits for
// the viewer to be idle any more (operator 2026-09-25 20:27).
import http from "node:http";
import { createReadStream } from "node:fs";
import { stat, readdir } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { createHash } from "node:crypto";
import { getNavIndex, navIndexEnabled, indexChunks, navIndexWarm } from "./lib/nav-index.mjs";
import { isContentDir, slugifyFilePath } from "./lib/shared/quartz-slug.mjs";
import { isVaultIgnored } from "./lib/vault-ignore.mjs";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { renderLive, routeErrors, isKnownPageUrl } from "./lib/live-route.mjs";
import { loadPageClassDir, pageClasses, brokenPageClasses } from "./lib/page-classes.mjs";
import { dbState, onConnect, startProbe, probe } from "./lib/wiki-db.mjs";
import { reconcile, formatReport } from "./lib/shared/reconcile-wiki-pages.mjs";
import { isWorkbenchPath, proxyConfig, proxyWorkbench } from "./lib/workbench-proxy.mjs";

const BUNDLE = process.env.WIKI_BUNDLE_DIR || "/viewer/bundle"; // the frozen bundle (committed, D7)
const WORKSPACE = process.env.WIKI_WORKSPACE_DIR || "/viewer/workspace"; // the workspace app's build (Dockerfile stage `workspace`)
// /workbench/* forwarded with the key, server-side (rw-p2b-workspace: the edge targets the viewer alone)
const WB_PROXY = proxyConfig();
const PORT = parseInt(process.env.PORT || "8080", 10);
const VAULT = process.env.WIKI_VAULT_DIR || "/wiki";
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".avif": "image/avif", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".woff": "font/woff", ".ttf": "font/ttf", ".xml": "application/xml", ".txt": "text/plain",
  ".map": "application/json", ".webmanifest": "application/manifest+json",
};

// The bundle + styles have STABLE names whose CONTENT changes every rebuild:
// `no-cache` forces revalidation, the validators make it a cheap 304.
const REBUILDABLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".xml", ".map", ".webmanifest", ".txt"]);
const cacheControl = (ext) => (REBUILDABLE.has(ext) ? "no-cache, must-revalidate" : "public, max-age=86400");
const etagOf = (st) => `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;

// A static ASSET (never a page: pages are live): the frozen bundle FIRST (this
// image's client code), then a vault ATTACHMENT - what the retired builder's
// Assets emitter used to copy into its snapshot: a non-.md file in a directory
// Quartz builds (isContentDir: never private/, templates/, a dot-directory or
// the gitignored assets/ - Quartz honoured the vault .gitignore, so it never
// published assets/ either; never a dot-file) and NOT excluded by the vault's
// .gitignore (rw-p1c-retire2, review r-p1c: Quartz ran with gitignore: true,
// so it never published planned.json, the ledgers or *.lock; lib/vault-ignore.mjs,
// fail-closed on the wiki-service's REQUIRED_IGNORES), at the URL Quartz gave
// it (slugifyFilePath, the shared rule): the URL's own path, else the slug
// index of the vault's attachments (built on a miss, at most once a minute).
const statFile = async (p) => { try { const st = await stat(p); return st.isFile() ? { file: p, st } : null; } catch { return null; } };
const isAttachmentPath = (rel) => {
  const parts = rel.split("/");
  const name = parts.at(-1);
  return !!name && !name.startsWith(".") && !name.toLowerCase().endsWith(".md") && isContentDir(parts.slice(0, -1).join("/"));
};
const ASSET_INDEX_MS = Math.max(5_000, Number(process.env.WIKI_ASSET_INDEX_MS || "60000"));
let _assetIndex = { at: 0, map: new Map(), running: null };
async function assetSlugIndex() {
  if (Date.now() - _assetIndex.at < ASSET_INDEX_MS) return _assetIndex.map;
  _assetIndex.running ??= (async () => {
    const map = new Map();
    const walk = async (dir, rel) => {
      let ents;
      try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith(".")) continue;
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) { if (isContentDir(r) && !(await isVaultIgnored(VAULT, r, true))) await walk(join(dir, e.name), r); }
        else if (e.isFile() && isAttachmentPath(r) && !(await isVaultIgnored(VAULT, r))) map.set(slugifyFilePath(r), r);
      }
    };
    const top = async () => {
      let ents;
      try { ents = await readdir(VAULT, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith(".")) continue;
        if (e.isDirectory()) { if (isContentDir(e.name) && !(await isVaultIgnored(VAULT, e.name, true))) await walk(join(VAULT, e.name), e.name); }
        else if (e.isFile() && isAttachmentPath(e.name) && !(await isVaultIgnored(VAULT, e.name))) map.set(slugifyFilePath(e.name), e.name);
      }
    };
    await top();
    _assetIndex = { at: Date.now(), map, running: null };
    return map;
  })();
  return _assetIndex.running;
}
async function resolveAsset(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split("?")[0].split("#")[0]); } catch { return null; }
  const inBundle = normalize(join(BUNDLE, p));
  if (inBundle.startsWith(BUNDLE + "/")) {
    const hit = await statFile(inBundle);
    if (hit) return hit;
  }
  const rel = p.replace(/^\/+/, "");
  const inVault = normalize(join(VAULT, rel));
  if (!inVault.startsWith(VAULT + "/") || !isAttachmentPath(rel)) return null; // traversal + page-set guard
  const vrel = inVault.slice(VAULT.length + 1);
  if (!(await isVaultIgnored(VAULT, vrel))) {
    const exact = await statFile(inVault);
    if (exact) return exact;
  }
  const orig = (await assetSlugIndex()).get(rel); // the index holds no ignored path
  return orig && !(await isVaultIgnored(VAULT, orig)) ? statFile(join(VAULT, orig)) : null;
}

// A page URL for sure: no extension (Quartz pretty URLs), a folder URL, or a
// legacy .html form. A URL whose last segment has a dot ("/notes/pv.1": Quartz
// keeps the dots of a file name) is a published asset when that file exists,
// else a page - unless its extension is a known asset type, which is a page
// only when the site index knows one at that URL (rw-p1a-deploy-prep, NA4-1 /
// RV-4: every dotted URL used to be an asset, so "pv.1.md" was a 404).
function isPageUrl(urlPath) {
  const p = urlPath.split("?")[0].split("#")[0];
  const ext = extname(p);
  return !ext || ext === ".html" || p.endsWith("/");
}
const extOf = (urlPath) => extname(urlPath.split("?")[0].split("#")[0]).toLowerCase();

function notModified(req, st) {
  const inm = req.headers["if-none-match"];
  if (inm) return inm === etagOf(st);
  const ims = req.headers["if-modified-since"];
  if (ims) {
    const since = Date.parse(ims);
    return Number.isFinite(since) && Math.floor(st.mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}

const baseHeaders = (st, ext) => ({
  etag: etagOf(st),
  "last-modified": new Date(st.mtimeMs).toUTCString(),
  "cache-control": cacheControl(ext),
});

// ── reconciliation (D13 item 4): health probe + repair pass on (re)connect ──
const RECONCILE_MS = Math.max(5_000, Number(process.env.WIKI_RECONCILE_INTERVAL_MS || "300000"));
const REPAIR = process.env.WIKI_RECONCILE_REPAIR !== "0";
let _reconcile = { report: null, at: null, error: null, running: null };
function runReconcile(why, repair) {
  if (_reconcile.running) return _reconcile.running;
  _reconcile.running = (async () => {
    try {
      const r = await reconcile({ vault: VAULT, repair, log: (m) => console.log(`[wiki-viewer] ${m}`) });
      const final = r.after || r;
      _reconcile.report = final;
      _reconcile.error = null;
      _reconcile.at = new Date().toISOString();
      console.log(`[wiki-viewer] reconcile pass (${why}${repair ? ", repair" : ""}): ` +
        formatReport(r).split("\n").join(" | "));
      if (r.after) console.log(`[wiki-viewer] reconcile after repair: ${formatReport(r.after).split("\n")[0]}`);
    } catch (e) {
      _reconcile.error = String(e?.message || e);
      _reconcile.at = new Date().toISOString();
      console.error(`[wiki-viewer] reconcile pass (${why}) CANNOT CHECK: ${_reconcile.error}`);
    } finally {
      _reconcile.running = null;
    }
  })();
  return _reconcile.running;
}

function health() {
  const db = dbState();
  const rep = _reconcile.report;
  const reasons = [];
  // P1c (rw-p1b-ready review A): the first site-index snapshot is built at
  // start (warmNav below), so a redeploy reports healthy only once a reader's
  // first page no longer pays the cold build.
  if (navIndexEnabled() && !navIndexWarm()) reasons.push("site index warming");
  if (db.state !== "up") reasons.push(`database ${db.state}`);
  if (_reconcile.error) reasons.push(`reconciliation cannot check: ${_reconcile.error}`);
  else if (!rep) reasons.push("reconciliation not yet run");
  else if (rep.drift > 0) {
    reasons.push(`drift ${rep.drift} (${rep.missing.length} missing, ${rep.stale.length} stale, ${rep.empty.length} empty, ` +
      `${rep.orphan.length} orphan, ${rep.failed.length} failed)`);
  }
  // A page-class entry that threw, or the route itself: a renderer bug, named.
  const broken = brokenPageClasses();
  for (const b of broken) {
    reasons.push(`page class ${b.name}@${b.version} ${b.phase}() ${b.kind === "invalid" ? "returned an invalid result" : "threw"} ${b.count}x: ${b.error}`);
  }
  const re = routeErrors();
  if (re.count) reasons.push(`render errors ${re.count} (last ${re.last.key}: ${re.last.error})`);
  if (!_nav.up) reasons.push(`nav worker not serving${_nav.lastExit ? ` (exited ${_nav.lastExit.code} at ${_nav.lastExit.at}; restarts ${_nav.restarts})` : ""}`);
  return {
    status: reasons.length ? "degraded" : "ok",
    reasons,
    db: { state: db.state, since: new Date(db.since).toISOString(), lastOkAt: db.lastOkAt ? new Date(db.lastOkAt).toISOString() : null, lastError: db.lastError },
    reconcile: rep ? {
      checkedAt: _reconcile.at, drift: rep.drift, files: rep.files, rows: rep.rows,
      missing: rep.missing.slice(0, 50), stale: rep.stale.slice(0, 50), future: (rep.future || []).slice(0, 50),
      empty: rep.empty.slice(0, 50), orphan: rep.orphan.slice(0, 50), failed: rep.failed.slice(0, 50),
    } : { checkedAt: _reconcile.at, error: _reconcile.error },
    pageClasses: pageClasses().map((e) => `${e.name}@${e.version}`),
    brokenPageClasses: broken,
    renderErrors: re,
    navWorker: { up: _nav.up, port: NAV_PORT, restarts: _nav.restarts, lastExit: _nav.lastExit },
    siteIndex: { warm: navIndexWarm(), enabled: navIndexEnabled() },
  };
}

// Page validator (P1b, D4): over the bytes presented, so it changes iff the
// document does. Only for a page (x-wiki-render: db); the states that are
// not pages are no-store and carry none.
const pageEtag = (body) => `W/"p-${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
const serverTiming = (t0) => `app;dur=${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)}`;

// ── the nav worker (lib/nav-worker.mjs) ─────────────────────────────────────
const NAV_PORT = Number(process.env.WIKI_NAV_PORT || 8082);
let _nav = { worker: null, up: false, restarts: 0, lastExit: null };
function startNavWorker() {
  const w = new Worker(new URL("./lib/nav-worker.mjs", import.meta.url), {
    workerData: { port: NAV_PORT },
    // a roomy young generation: the walk's short-lived objects die young
    // instead of being promoted into a mark-compact (rw-p1b-ready findings)
    resourceLimits: { maxYoungGenerationSizeMb: 64 },
  });
  _nav = { ..._nav, worker: w, up: false };
  w.on("message", (m) => { if (m?.listening) _nav.up = true; });
  w.on("error", (e) => console.error(`[wiki-viewer] nav worker error: ${e?.stack || e}`));
  w.on("exit", (code) => {
    _nav = { ..._nav, worker: null, up: false, restarts: _nav.restarts + 1, lastExit: { code, at: new Date().toISOString() } };
    console.error(`[wiki-viewer] nav worker exited (code ${code}); restarting in 2 s`);
    setTimeout(startNavWorker, 2000).unref();
  });
}

// This server's /__nav: a proxy to the worker (the explorer goes through the
// workbench straight to the worker's port; this is for probes).
async function proxyNav(req, res) {
  const headers = {};
  if (req.headers["if-none-match"]) headers["if-none-match"] = req.headers["if-none-match"];
  try {
    const r = await fetch(`http://127.0.0.1:${NAV_PORT}${req.url}`, { headers, signal: AbortSignal.timeout(10_000) });
    const out = {};
    for (const h of ["content-type", "cache-control", "etag", "x-wiki-nav", "server-timing"]) if (r.headers.get(h)) out[h] = r.headers.get(h);
    const body = r.status === 304 ? null : Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, body ? { ...out, "content-length": body.length } : out);
    res.end(req.method === "HEAD" || !body ? undefined : body);
  } catch (e) {
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: `nav worker unreachable: ${e?.message || e}` }));
  }
}

// /workspace: the app's index.html for the app's own URLs, its hashed assets from the build. The
// build carries no page and reads no vault file; the app talks to /workbench/* like every panel.
async function serveWorkspace(req, res, path) {
  const rel = path.replace(/^\/workspace\/?/, "");
  const isAsset = /^assets\/[A-Za-z0-9._-]+$/.test(rel);
  const file = normalize(join(WORKSPACE, isAsset ? rel : "index.html"));
  if (!file.startsWith(WORKSPACE + "/")) { res.writeHead(400); res.end(); return; }
  let st;
  try { st = await stat(file); } catch { st = null; }
  if (!st?.isFile()) {
    res.writeHead(isAsset ? 404 : 503, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end(isAsset ? "not found" : "the workspace is not in this image");
    return;
  }
  const ext = extname(file);
  // hashed asset names never change content: cache them; index.html revalidates
  const headers = { ...baseHeaders(st, ext), "content-type": MIME[ext] || "application/octet-stream", "content-length": st.size,
    "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache, must-revalidate", "x-wiki-render": "workspace" };
  if (notModified(req, st)) { res.writeHead(304, headers); res.end(); return; }
  res.writeHead(200, headers);
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(file).pipe(res);
}

async function handle(req, res) {
  const t0 = process.hrtime.bigint();
  const url = req.url || "/";
  if (url.split("?")[0] === "/__health") {
    const hb = health();
    res.writeHead(hb.status === "ok" ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(hb));
    return;
  }
  const path = url.split("?")[0];
  if (path === "/__nav") return proxyNav(req, res);
  // The workspace (research-workbench P2b): the Vite + React app at /workspace. Its notifications
  // bell replaced the P1b strip and its /__notifications routes (D13, moved to the title bar 2026-09-25).
  if (path === "/workspace" || path.startsWith("/workspace/")) return serveWorkspace(req, res, path);
  // rw-identity round 5: any spelling that decodes to /workbench is forwarded (the workbench judges it)
  if (isWorkbenchPath(path)) return proxyWorkbench(req, res, WB_PROXY);
  // The full index, LIVE from wiki_pages, for its one remaining lazy reader
  // (the notes editor's link autocomplete, when the editor opens; the graph no
  // longer falls back to it - fix round 1). No file fallback (E3): the
  // database being down is the database screen, not a stale index. STREAMED
  // in slices with a yield between them (fix round 1, tester attempt 1 defect
  // 1: building it as one string on this thread - JSON.stringify of 383k rows,
  // 128 MB - stalled every page for 32 s).
  if (navIndexEnabled() && path.endsWith("/static/graphIndex.json")) {
    const nav = await getNavIndex();
    if (nav) {
      const headers = {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-cache, must-revalidate",
        etag: nav.etag,
        "x-wiki-nav": "db",
      };
      if (req.headers["if-none-match"] === nav.etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, headers); // chunked: no whole-payload length is ever computed
      if (req.method === "HEAD") { res.end(); return; }
      let closed = false;
      res.on("close", () => { closed = true; });
      for (const chunk of indexChunks(nav)) {
        if (closed) return;
        if (!res.write(chunk)) await Promise.race([once(res, "drain"), once(res, "close")]).catch(() => {});
        await new Promise((r) => setImmediate(r)); // a page request waiting meanwhile is served between slices
      }
      res.end();
      return;
    }
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "nav index unavailable (database)" }));
    return;
  }
  const page = async (u) => {
    const out = await renderLive(u);
    const headers = { ...out.headers, "server-timing": serverTiming(t0) };
    if (out.status === 200 && out.headers["x-wiki-render"] === "db" && out.body) {
      headers.etag = pageEtag(out.body);
      if (req.headers["if-none-match"] === headers.etag) { res.writeHead(304, headers); res.end(); return; }
    }
    const body = req.method === "HEAD" ? undefined : out.body;
    res.writeHead(out.status, { ...headers, "content-length": Buffer.byteLength(out.body || "") });
    res.end(body);
  };
  if (isPageUrl(url)) return page(url.replace(/\.html(?=$|[?#])/, ""));
  const hit = await resolveAsset(url);
  if (hit) {
    const { file, st } = hit;
    const ext = extname(file);
    if (notModified(req, st)) {
      res.writeHead(304, baseHeaders(st, ext));
      res.end();
      return;
    }
    res.writeHead(200, { ...baseHeaders(st, ext), "content-type": MIME[ext] || "application/octet-stream", "content-length": st.size });
    if (req.method === "HEAD") { res.end(); return; }
    createReadStream(file).pipe(res);
    return;
  }
  // No published file: a dotted page name, unless the extension is an asset's.
  if (!MIME[extOf(url)] || (await isKnownPageUrl(url))) return page(url);
  res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-cache" });
  res.end("not found");
}

await loadPageClassDir();
console.log(`[wiki-viewer] page classes: ${pageClasses().map((e) => `${e.name}@${e.version}/p${e.priority}`).join(", ")}`);
// Repair pass on every (re)connect; periodic check as the health probe.
startNavWorker();
// Warm THIS thread's site index now (rw-p1b-ready review A, P1c): the cold
// build (keyset walk + site index) used to wait for the first reader after a
// start - 26-29 s at 401k rows. Started here it overlaps the healthcheck's
// start period; /__health says "site index warming" until it lands. Retried
// while the database is not up yet (getNavIndex returns null then).
(function warmNav(attempt = 0) {
  if (!navIndexEnabled()) return;
  const retry = () => setTimeout(() => warmNav(attempt + 1), Math.min(10_000, 1_000 * (attempt + 1))).unref();
  getNavIndex().then((n) => {
    if (n) console.log(`[wiki-viewer] site index warm after start (attempt ${attempt + 1})`);
    else retry();
  }).catch(retry);
})();
onConnect((why) => runReconcile(why, REPAIR));
startProbe();
setInterval(() => { if (dbState().state === "up") runReconcile("periodic", false); }, RECONCILE_MS).unref();

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("[wiki-viewer] request failed:", e?.stack || e?.message || e);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    });
  })
  .listen(PORT, () => console.log(`[wiki-viewer] live renderer on :${PORT} (frozen bundle ${BUNDLE}; no builder)`));

// node is PID 1 (no shell entrypoint since P1c): exit on a stop signal
// instead of ignoring it until Docker's kill timeout.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));

