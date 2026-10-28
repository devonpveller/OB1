// /workbench/* through the viewer (rw-p2b-workspace, operator 2026-10-28: the edge - Traefik with
// Authentik in front - targets the viewer alone, the ob1 plane's one front-end port). The viewer
// forwards the request to the workbench with the shared key injected SERVER-SIDE; a key the client
// sent is dropped, so the browser can never hold or forge one. Request bodies are capped as the
// portal's (wiki_app) Caddy snippet capped them: 100 MB on the upload paths, 1 MB elsewhere.
// Off (404) unless WORKBENCH_URL and WORKBENCH_KEY are both set. While Caddy still fronts the plane
// it routes /workbench/* to the workbench itself, and none of it reaches the viewer.
import http from "node:http";
import https from "node:https";

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "x-brain-key", "content-length"]);
const UPLOAD = /^\/workbench\/(import(\/|$|\?)|sources\/[^/]+\/replace-from-upload)/;
const MB = 1024 * 1024;

export function proxyConfig(env = process.env) {
  const url = String(env.WORKBENCH_URL || "").replace(/\/+$/, "");
  const key = String(env.WORKBENCH_KEY || "");
  return url && key ? { url, key } : null;
}

export function bodyCap(path) {
  return UPLOAD.test(path) ? 100 * MB : 1 * MB;
}

export function proxyWorkbench(req, res, cfg) {
  if (!cfg) {
    res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "not routed: the viewer forwards /workbench/* only with WORKBENCH_URL and WORKBENCH_KEY set" }));
    return;
  }
  const cap = bodyCap(req.url || "");
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > cap) {
    req.resume();
    res.writeHead(413, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `request body over ${cap / MB} MB` }));
    return;
  }
  const target = new URL(cfg.url + req.url);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  headers["x-brain-key"] = cfg.key;
  headers["x-forwarded-proto"] = headers["x-forwarded-proto"] || "https";
  const lib = target.protocol === "https:" ? https : http;
  const up = lib.request(target, { method: req.method, headers, timeout: 600_000 }, (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k) || k === "content-length") out[k] = v;
    res.writeHead(r.statusCode || 502, out);
    r.pipe(res);
  });
  const failed = (msg) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: `the workbench is not answering (${msg})` }));
    } else res.destroy();
  };
  up.on("error", (e) => failed(e.code || e.message));
  up.on("timeout", () => up.destroy(new Error("timeout")));
  let seen = 0;
  req.on("data", (c) => {
    seen += c.length;
    if (seen > cap) {
      up.destroy();
      if (!res.headersSent) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `request body over ${cap / MB} MB` }));
      }
      req.destroy();
      return;
    }
    up.write(c);
  });
  req.on("end", () => up.end());
  req.on("aborted", () => up.destroy());
}
