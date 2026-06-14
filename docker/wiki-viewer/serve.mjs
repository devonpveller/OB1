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

function resolve(urlPath) {
  // Quartz prettyURLs emit `foo/index.html`; also tolerate `foo.html`.
  let p = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  if (p.endsWith("/")) p = p.slice(0, -1);
  const base = normalize(join(ROOT, p || "/"));
  if (!base.startsWith(ROOT)) return null; // path traversal guard
  const candidates = p === "" || p === "/"
    ? [join(ROOT, "index.html")]
    : [base, `${base}.html`, join(base, "index.html")];
  for (const c of candidates) {
    try { const st = statSync(c); if (st.isFile()) return c; } catch { /* next */ }
  }
  return null;
}

// No good build yet (cold start / very first compile, before /srv/current is
// published)? Serve a self-refreshing splash so a reader who arrives mid-build
// sees "Building…" rather than a connection error. Once a snapshot exists this
// never shows again — nightly rebuilds keep serving the previous snapshot.
function buildReady() {
  try { return statSync(join(ROOT, "index.html")).isFile(); } catch { return false; }
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
