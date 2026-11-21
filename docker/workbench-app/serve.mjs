// The workbench app's server (rwr-app-scaffold). Four jobs, no dependencies:
//   /__health        200 {"status":"ok"} once the build is present (index.html readable)
//   /workbench/*     forwarded to the workbench with the door key injected SERVER-SIDE, by the viewer's own
//                    forwarder (workbench-proxy.mjs) - the SAME module file, not a fork (see the Dockerfile:
//                    the image copies it from the wiki viewer's lib/ through the build context `viewerlib`)
//   /assets/<hashed> the Vite build's hashed files: cache-control public, max-age=31536000, immutable
//                    (an unhashed file under /assets, the notices, is no-cache)
//   anything else    index.html, cache-control no-cache (the app's own routes are deep links: /documents/x)
// Every response carries the viewer's security headers (security-headers.mjs, same shared module).
// Env: PORT (8080), WORKBENCH_URL + WORKBENCH_KEY / WORKSPACE_DOOR_KEY (the forwarder is off, 404, unless
// both are set), WIKI_VIEWER_ALLOWED_HOSTS / WIKI_VIEWER_ALLOWED_ORIGINS (the forwarder's host + origin
// guard; the names are the viewer's: one module, one set of variables), WORKBENCH_APP_DIST (the build).
import http from "node:http";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// In the image the shared files sit in ./lib/shared; in the repo they are the wiki viewer's own lib/.
const HERE = fileURLToPath(new URL(".", import.meta.url));
async function loadShared(name) {
  for (const dir of [join(HERE, "lib", "shared"), join(HERE, "..", "wiki-viewer", "lib")]) {
    try { await stat(join(dir, name)); return await import(pathToFileURL(join(dir, name)).href); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  }
  throw new Error(`shared module ${name} not found (lib/shared in the image, ../wiki-viewer/lib in the repo)`);
}
const { isWorkbenchPath, proxyConfig, proxyWorkbench } = await loadShared("workbench-proxy.mjs");
const { withSecurityHeaders } = await loadShared("security-headers.mjs");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};

// Content-Security-Policy on the app's HTML (round 2): the app is same-origin only (scripts, styles, fonts,
// fetches), images may be data: URIs, nothing may frame it, <base> and cross-origin forms are out.
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join("; ");
// Vite content-hashes its build files (name-<hash>.ext); only those may be cached for good. Anything else
// under /assets (the notices file) is revalidated.
const HASHED = /-[A-Za-z0-9_-]{6,}\.(js|mjs|css|woff2?|svg|png|jpe?g|webp|gif|ico|map)$/;

export function createHandler({ dist, proxy }) {
  const root = normalize(dist);
  async function sendFile(req, res, file, cache) {
    const st = await stat(file);
    const type = MIME[extname(file)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "content-length": st.size, "cache-control": cache, ...(type.startsWith("text/html") ? { "content-security-policy": CSP } : {}) });
    if (req.method === "HEAD") { res.end(); return; }
    createReadStream(file).pipe(res);
  }
  async function handle(req, res) {
    const url = req.url || "/";
    const path = url.split("?")[0];
    if (path === "/__health") {
      let ok = false;
      try { ok = (await readFile(join(root, "index.html"))).length > 0; } catch { /* not built */ }
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ status: ok ? "ok" : "unavailable", service: "openbrain-workbench-app" }));
      return;
    }
    // any spelling that decodes to /workbench is the workbench's (it judges it), never the app's index
    if (isWorkbenchPath(path)) return proxyWorkbench(req, res, proxy);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain", allow: "GET, HEAD", "cache-control": "no-store" });
      res.end("method not allowed");
      return;
    }
    // hashed build files: names change with content, so they are cached for good
    if (path.startsWith("/assets/")) {
      const rel = path.slice("/assets/".length);
      if (/^[A-Za-z0-9._-]+$/.test(rel) && !rel.startsWith(".")) {
        try { return await sendFile(req, res, join(root, "assets", rel), HASHED.test(rel) ? "public, max-age=31536000, immutable" : "no-cache"); } catch { /* fall through */ }
      }
      res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("not found");
      return;
    }
    // a root file of the build (favicon ...): revalidated, not immutable
    if (/^\/[A-Za-z0-9._-]+\.[A-Za-z0-9]+$/.test(path) && path !== "/index.html") {
      try { return await sendFile(req, res, join(root, path.slice(1)), "no-cache"); } catch { /* an app route that looks like a file: the index */ }
    }
    try {
      return await sendFile(req, res, join(root, "index.html"), "no-cache");
    } catch {
      res.writeHead(503, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("the app build is not in this image");
    }
  }
  return withSecurityHeaders(handle);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PORT = Number(process.env.PORT || 8080);
  const DIST = process.env.WORKBENCH_APP_DIST || join(HERE, "dist");
  const proxy = proxyConfig(process.env);
  http.createServer(createHandler({ dist: DIST, proxy })).listen(PORT, () =>
    console.log(`[workbench-app] serving ${DIST} on :${PORT}; /workbench/* ${proxy ? "forwarded to " + proxy.url : "not routed (WORKBENCH_URL / key unset)"}`));
  // node is PID 1: exit on a stop signal
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
}
