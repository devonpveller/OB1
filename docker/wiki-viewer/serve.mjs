// Minimal static file server for the compiled Quartz site (Research Engine /
// wiki availability rework). Always serves the CURRENT good build via the
// /srv/current symlink — the entrypoint rebuilds into a new versioned dir and
// atomically re-points the symlink only when the viewer is idle, so a reader
// NEVER sees a "rebuilding" splash. Records request activity to
// /tmp/last-access so the rebuild loop can tell when the viewer is in use.
//
// 2026-08-23 perf rework: fully async I/O, ETag/Last-Modified validators with
// 304 handling (the site is served `no-cache` so browsers/CDNs always
// revalidate — before this there were NO validators, so every visit
// re-downloaded everything, including the multi-MB index), throttled
// last-access bookkeeping, and a cached readiness probe.
import http from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const ROOT = "/srv/current"; // a symlink → /srv/build-N (swapped atomically)
// The builder's LIVE output. Fallback for a just-created note/folder that the
// incremental watcher has already emitted but the idle-gated snapshot hasn't
// published yet — so user-created content appears in ~seconds instead of waiting
// out the idle gate (2026-06-17). Serving an individual fresh page from here is
// safe: render assets (css/js) still come from the complete snapshot.
const LIVE = "/quartz/public";
const PUBLISH_FLAG = "/tmp/ne-publish"; // serve.mjs sets it; the entrypoint loop
// honors it to publish promptly (bypassing the idle gate) so the nav/index catch up.
const PORT = parseInt(process.env.PORT || "8080", 10);
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".avif": "image/avif", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".woff": "font/woff", ".ttf": "font/ttf", ".xml": "application/xml", ".txt": "text/plain",
  ".map": "application/json", ".webmanifest": "application/manifest+json",
};

// Quartz emits the client bundle + styles under STABLE names (postscript.js,
// prescript.js, index.css) whose CONTENT changes every rebuild. `no-cache`
// forces revalidation on every use; the ETag/Last-Modified validators below
// turn that revalidation into a cheap 304 instead of a re-download. True
// static (fonts/images) may cache for a day.
const REBUILDABLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".xml", ".map", ".webmanifest", ".txt"]);
const cacheControl = (ext) =>
  REBUILDABLE.has(ext) ? "no-cache, must-revalidate" : "public, max-age=86400";

// Snapshot dirs are immutable once published, so size+mtime is a sound ETag.
const etagOf = (st) => `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;

async function resolveIn(root, p) {
  const base = normalize(join(root, p || "/"));
  if (!base.startsWith(root)) return null; // path traversal guard
  const candidates = p === "" || p === "/"
    ? [join(root, "index.html")]
    : [base, `${base}.html`, join(base, "index.html")];
  for (const c of candidates) {
    try {
      const st = await stat(c);
      if (st.isFile()) return { file: c, st };
    } catch { /* next */ }
  }
  return null;
}
async function resolve(urlPath) {
  // Quartz prettyURLs emit `foo/index.html`; also tolerate `foo.html`.
  let p = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  if (p.endsWith("/")) p = p.slice(0, -1);
  // Published snapshot first (stable, gated); fall back to the LIVE builder
  // output for a page that exists there but isn't snapshotted yet (a brand-new
  // note/folder), so it's reachable in ~seconds.
  return (await resolveIn(ROOT, p)) || (await resolveIn(LIVE, p));
}

// No good build yet (cold start / very first compile, before /srv/current is
// published)? Serve a self-refreshing splash so a reader who arrives mid-build
// sees "Building…" rather than a connection error. Once a snapshot exists this
// never shows again — nightly rebuilds keep serving the previous snapshot.
//
// COMPLETENESS gate (2026-06-15): a build is "ready" ONLY if it has index.html
// AND the core ComponentResources (styles + client JS). Requiring the full set
// means an incomplete /srv/current falls back to the splash instead of serving
// a broken, unstyled page. (Belt-and-suspenders with the entrypoint publish
// gate.) static/contentIndex.json = the search index; static/graphIndex.json =
// the lean graph/explorer index derived at publish time (2026-08-23) — a
// snapshot missing either falls back to the splash.
const REQUIRED = [
  "index.html", "index.css", "prescript.js", "postscript.js",
  "static/contentIndex.json", "static/graphIndex.json",
];
// Readiness only changes when the /srv/current symlink is re-pointed — cache
// the probe briefly instead of stat()ing 6 files on EVERY request.
let _ready = { at: 0, ok: false };
async function buildReady() {
  const now = Date.now();
  if (now - _ready.at < 2000) return _ready.ok;
  let ok = true;
  try {
    for (const f of REQUIRED) {
      if (!(await stat(join(ROOT, f))).isFile()) { ok = false; break; }
    }
  } catch { ok = false; }
  _ready = { at: now, ok };
  return ok;
}

// Throttled request-activity marker (was a SYNCHRONOUS write per request).
let _lastAccessWrote = 0;
function markAccess() {
  const now = Date.now();
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
<p>The site is compiling. This page refreshes automatically and will load as soon as a complete build is ready.</p>
</div></body></html>`;

// 304 when the client's validator still matches (site is no-cache → every use
// revalidates; this makes that revalidation ~free).
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

function baseHeaders(st, ext) {
  return {
    etag: etagOf(st),
    "last-modified": new Date(st.mtimeMs).toUTCString(),
    "cache-control": cacheControl(ext),
  };
}

async function handle(req, res) {
  markAccess();
  if (!(await buildReady())) {
    res.writeHead(503, { "content-type": "text/html; charset=utf-8", "retry-after": "6" });
    res.end(SPLASH);
    return;
  }
  const hit = await resolve(req.url || "/");
  if (hit) {
    const { file, st } = hit;
    // Served from the LIVE builder output ⇒ this page isn't in the published
    // snapshot yet (a just-created note/folder). Signal the snapshot loop to
    // publish promptly (bypassing the idle gate) so the nav/index catch up.
    if (file.startsWith(LIVE)) writeFile(PUBLISH_FLAG, "1").catch(() => {});
    const ext = extname(file);
    if (notModified(req, st)) {
      res.writeHead(304, baseHeaders(st, ext));
      res.end();
      return;
    }
    const head = { ...baseHeaders(st, ext), "content-type": MIME[ext] || "application/octet-stream" };
    if (req.method === "HEAD") {
      res.writeHead(200, { ...head, "content-length": st.size });
      res.end();
      return;
    }
    if (ext === ".html") {
      // Legacy dev-mode hot-reload strip. The builder no longer injects the
      // ws://localhost reload client (patched out in the Dockerfile), so this
      // only fires for pages built before that patch; the cheap substring
      // check keeps the streaming path for everything else.
      const html = await readFile(file, "utf8");
      const cleaned = html.includes("ws://localhost")
        ? html.replace(
            /<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?ws:\/\/localhost(?:(?!<\/script>)[\s\S])*?<\/script>/gi,
            "",
          )
        : html;
      res.writeHead(200, { ...head, "content-length": Buffer.byteLength(cleaned) });
      res.end(cleaned);
      return;
    }
    res.writeHead(200, { ...head, "content-length": st.size });
    createReadStream(file).pipe(res);
    return;
  }
  // Fall back to Quartz's generated 404 page if present.
  try {
    const nf = join(ROOT, "404.html");
    const st = await stat(nf);
    res.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    createReadStream(nf).pipe(res);
    void st;
    return;
  } catch { /* no 404 page */ }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("[wiki-viewer] request failed:", e?.message || e);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    });
  })
  .listen(PORT, () => console.log(`[wiki-viewer] static idle-swap server on :${PORT}`));
