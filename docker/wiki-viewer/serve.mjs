// Minimal static file server for the compiled Quartz site (Research Engine /
// wiki availability rework). Always serves the CURRENT good build via the
// /srv/current symlink — the entrypoint rebuilds into a new versioned dir and
// atomically re-points the symlink only when the viewer is idle, so a reader
// NEVER sees a "rebuilding" splash. Records each request's time to
// /tmp/last-access so the rebuild loop can tell when the viewer is in use.
import http from "node:http";
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
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

http.createServer((req, res) => {
  try { writeFileSync("/tmp/last-access", String(Math.floor(Date.now() / 1000))); } catch { /* */ }
  const file = resolve(req.url || "/");
  if (file) {
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
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
