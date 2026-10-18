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
// What still comes from the published Quartz snapshot (/srv/current, written
// by entrypoint.sh's builder while WIKI_BUILDER=1): the client bundle and
// static assets (index.css, prescript.js, postscript.js, static/*). P1c
// freezes that bundle and removes the builder.
//
// Kept from the 2026-08-23 perf rework: async I/O, ETag/Last-Modified
// validators with 304s on assets, throttled last-access bookkeeping (the
// compiler's drain gate reads /__last-access), the cached readiness probe.
import http from "node:http";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { getNavIndex, navIndexEnabled } from "./lib/nav-index.mjs";
import { renderLive } from "./lib/live-route.mjs";
import { loadPageClassDir, pageClasses } from "./lib/page-classes.mjs";
import { dbState, onConnect, startProbe } from "./lib/wiki-db.mjs";
import { reconcile, formatReport } from "./lib/shared/reconcile-wiki-pages.mjs";

const ROOT = "/srv/current"; // a symlink -> /srv/build-N (swapped atomically)
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

// A static ASSET from the published snapshot (never a page: pages are live).
async function resolveAsset(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split("?")[0].split("#")[0]); } catch { return null; }
  const base = normalize(join(ROOT, p));
  if (!base.startsWith(ROOT)) return null; // path traversal guard
  try {
    const st = await stat(base);
    if (st.isFile()) return { file: base, st };
  } catch { /* none */ }
  return null;
}

// A page URL: no extension (Quartz pretty URLs), a folder URL, or a legacy
// .html form. Everything else is an asset.
function isPageUrl(urlPath) {
  const p = urlPath.split("?")[0].split("#")[0];
  const ext = extname(p);
  return !ext || ext === ".html" || p.endsWith("/");
}

// No published bundle yet (cold start, first build): the page chrome needs the
// bundle, so a self-refreshing splash. P1b replaces this readiness contract.
const REQUIRED = ["index.css", "prescript.js", "postscript.js", "static/graphIndex.json"];
let _ready = { at: 0, ok: false };
async function bundleReady() {
  const now = Date.now();
  if (now - _ready.at < 2000) return _ready.ok;
  let ok = true;
  try {
    for (const f of REQUIRED) if (!(await stat(join(ROOT, f))).isFile()) { ok = false; break; }
  } catch { ok = false; }
  _ready = { at: now, ok };
  return ok;
}

let lastAccessMs = 0;
let _lastAccessWrote = 0;
function markAccess() {
  const now = Date.now();
  lastAccessMs = now;
  if (now - _lastAccessWrote < 5000) return;
  _lastAccessWrote = now;
  writeFile("/tmp/last-access", String(Math.floor(now / 1000))).catch(() => {});
}

const SPLASH = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="6"><title>Building the wiki…</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;
font-family:system-ui,-apple-system,sans-serif;background:#1e1e24;color:#d4d4dc}
.box{text-align:center;max-width:30rem;padding:2rem}
.spin{width:2.4rem;height:2.4rem;border:3px solid #44454f;border-top-color:#84a9ff;border-radius:50%;
margin:0 auto 1.2rem;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}
h1{font-size:1.1rem;font-weight:600;margin:0 0 .4rem}p{font-size:.85rem;color:#9a9ba6;margin:.2rem 0;line-height:1.5}</style>
</head><body><div class="box"><div class="spin"></div><h1>Building the wiki…</h1>
<p>The site bundle is compiling. This page refreshes automatically.</p>
</div></body></html>`;

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
  if (db.state !== "up") reasons.push(`database ${db.state}`);
  if (_reconcile.error) reasons.push(`reconciliation cannot check: ${_reconcile.error}`);
  else if (!rep) reasons.push("reconciliation not yet run");
  else if (rep.drift > 0) reasons.push(`drift ${rep.drift} (${rep.missing.length} missing, ${rep.stale.length} stale, ${rep.orphan.length} orphan)`);
  return {
    status: reasons.length ? "degraded" : "ok",
    reasons,
    db: { state: db.state, since: new Date(db.since).toISOString(), lastOkAt: db.lastOkAt ? new Date(db.lastOkAt).toISOString() : null, lastError: db.lastError },
    reconcile: rep ? {
      checkedAt: _reconcile.at, drift: rep.drift, files: rep.files, rows: rep.rows,
      missing: rep.missing.slice(0, 50), stale: rep.stale.slice(0, 50), orphan: rep.orphan.slice(0, 50),
    } : { checkedAt: _reconcile.at, error: _reconcile.error },
    pageClasses: pageClasses().map((e) => `${e.name}@${e.version}`),
    builder: process.env.WIKI_BUILDER !== "0",
  };
}

async function handle(req, res) {
  const url = req.url || "/";
  // Machine probes - must NOT count as user interaction.
  if (url === "/__last-access") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ts: lastAccessMs }));
    return;
  }
  if (url.split("?")[0] === "/__health") {
    const hb = health();
    res.writeHead(hb.status === "ok" ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(hb));
    return;
  }
  markAccess();
  if (!(await bundleReady())) {
    res.writeHead(503, { "content-type": "text/html; charset=utf-8", "retry-after": "6" });
    res.end(SPLASH);
    return;
  }
  // The nav/graph index, LIVE from wiki_pages (Phase C); the published file
  // is the fallback while the database is unreachable.
  if (navIndexEnabled() && url.split("?")[0].endsWith("/static/graphIndex.json")) {
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
      res.writeHead(200, { ...headers, "content-length": Buffer.byteLength(nav.json) });
      res.end(req.method === "HEAD" ? undefined : nav.json);
      return;
    }
  }
  // Alias for clients cached from before the index change.
  if (url.split("?")[0].endsWith("/static/contentIndex.json")) {
    const lean = join(ROOT, "static", "graphIndex.json");
    try {
      const st = await stat(lean);
      res.writeHead(200, { ...baseHeaders(st, ".json"), "content-type": "application/json; charset=utf-8", "content-length": st.size });
      createReadStream(lean).pipe(res);
      return;
    } catch { /* fall through */ }
  }
  if (isPageUrl(url)) {
    const out = await renderLive(url.replace(/\.html(?=$|[?#])/, ""));
    const body = req.method === "HEAD" ? undefined : out.body;
    res.writeHead(out.status, { ...out.headers, "content-length": Buffer.byteLength(out.body || "") });
    res.end(body);
    return;
  }
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
  res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-cache" });
  res.end("not found");
}

await loadPageClassDir();
console.log(`[wiki-viewer] page classes: ${pageClasses().map((e) => `${e.name}@${e.version}/p${e.priority}`).join(", ")}`);
// Repair pass on every (re)connect; periodic check as the health probe.
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
  .listen(PORT, () => console.log(`[wiki-viewer] live renderer on :${PORT} (WIKI_BUILDER=${process.env.WIKI_BUILDER ?? "1"})`));

