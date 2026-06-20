// Minimal static file server for the compiled Quartz site (Research Engine /
// wiki availability rework). Always serves the CURRENT good build via the
// /srv/current symlink — the entrypoint rebuilds into a new versioned dir and
// atomically re-points the symlink only when the viewer is idle, so a reader
// NEVER sees a "rebuilding" splash. Records each request's time to
// /tmp/last-access so the rebuild loop can tell when the viewer is in use.
import http from "node:http";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
// prescript.js, index.css) whose CONTENT changes every rebuild. With no cache
// headers, browsers/CDNs cache them by URL and keep serving the OLD bundle after
// a fix ships (the cause of "I cleared cache but the page still misbehaves").
// Force always-revalidate on rebuildable assets; let true static (fonts/images)
// cache for a day.
const REBUILDABLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".xml", ".map", ".webmanifest", ".txt"]);
const cacheControl = (ext) =>
  REBUILDABLE.has(ext) ? "no-cache, must-revalidate" : "public, max-age=86400";

function resolveIn(root, p) {
  const base = normalize(join(root, p || "/"));
  if (!base.startsWith(root)) return null; // path traversal guard
  const candidates = p === "" || p === "/"
    ? [join(root, "index.html")]
    : [base, `${base}.html`, join(base, "index.html")];
  for (const c of candidates) {
    try { const st = statSync(c); if (st.isFile()) return c; } catch { /* next */ }
  }
  return null;
}
function resolve(urlPath) {
  // Quartz prettyURLs emit `foo/index.html`; also tolerate `foo.html`.
  let p = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  if (p.endsWith("/")) p = p.slice(0, -1);
  // Published snapshot first (stable, gated); fall back to the LIVE builder
  // output for a page that exists there but isn't snapshotted yet (a brand-new
  // note/folder), so it's reachable in ~seconds.
  return resolveIn(ROOT, p) || resolveIn(LIVE, p);
}

// No good build yet (cold start / very first compile, before /srv/current is
// published)? Serve a self-refreshing splash so a reader who arrives mid-build
// sees "Building…" rather than a connection error. Once a snapshot exists this
// never shows again — nightly rebuilds keep serving the previous snapshot.
//
// COMPLETENESS gate (2026-06-15): a build is "ready" ONLY if it has index.html
// AND the core ComponentResources (styles + client JS). A build that crashed
// after emitting page HTML but before these would otherwise be served with every
// asset 404'd as text/plain (the wiki-render incident). Requiring the full set
// means an incomplete /srv/current falls back to the splash instead of serving a
// broken, unstyled page. (Belt-and-suspenders with the entrypoint publish gate.)
// static/contentIndex.json = the search/graph index. The entrypoint's publish
// gate guarantees it's present AND a terminated JSON before a snapshot goes live
// (a torn one truncates → client "Unterminated string in JSON"); requiring its
// presence here too means a snapshot somehow missing it falls back to the splash.
const REQUIRED = ["index.html", "index.css", "prescript.js", "postscript.js", "static/contentIndex.json"];
function buildReady() {
  try {
    for (const f of REQUIRED) if (!statSync(join(ROOT, f)).isFile()) return false;
    return true;
  } catch { return false; }
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

http.createServer((req, res) => {
  try { writeFileSync("/tmp/last-access", String(Math.floor(Date.now() / 1000))); } catch { /* */ }
  if (!buildReady()) {
    res.writeHead(503, { "content-type": "text/html; charset=utf-8", "retry-after": "6" });
    res.end(SPLASH);
    return;
  }
  const file = resolve(req.url || "/");
  if (file) {
    // Served from the LIVE builder output ⇒ this page isn't in the published
    // snapshot yet (a just-created note/folder). Signal the snapshot loop to
    // publish promptly (bypassing the idle gate) so the nav/index catch up.
    if (file.startsWith(LIVE)) { try { writeFileSync(PUBLISH_FLAG, "1"); } catch { /* */ } }
    const ext = extname(file);
    if (ext === ".html") {
      // Strip the Quartz dev-mode (`build --serve`) hot-reload client: it opens
      // ws://localhost:3001 and reload()s resources via blob:http://localhost,
      // both of which fail noisily in every remote viewer's console. We serve
      // static snapshots, so live-reload is irrelevant — drop the script block.
      const html = readFileSync(file, "utf8").replace(
        /<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?ws:\/\/localhost(?:(?!<\/script>)[\s\S])*?<\/script>/gi,
        "",
      );
      res.writeHead(200, { "content-type": MIME[ext], "cache-control": "no-cache, must-revalidate" });
      res.end(html);
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": cacheControl(ext),
    });
    createReadStream(file).pipe(res);
    return;
  }
  // Fall back to Quartz's generated 404 page if present.
  const nf = join(ROOT, "404.html");
  if (existsSync(nf)) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    createReadStream(nf).pipe(res);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}).listen(PORT, () => console.log(`[wiki-viewer] static idle-swap server on :${PORT}`));
