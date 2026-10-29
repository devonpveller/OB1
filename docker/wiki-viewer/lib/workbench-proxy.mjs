// /workbench/* through the viewer (rw-p2b-workspace, operator 2026-10-28: the edge - Traefik with
// Authentik in front - targets the viewer alone, the ob1 plane's one front-end port). The viewer
// forwards the request to the workbench with the shared key injected SERVER-SIDE; a key the client
// sent is dropped, so the browser can never hold or forge one. Request bodies are capped as the
// portal's (wiki_app) Caddy snippet capped them: 100 MB on the upload paths, 1 MB elsewhere.
// Off (404) unless WORKBENCH_URL and WORKBENCH_KEY are both set. While Caddy still fronts the plane
// it routes /workbench/* to the workbench itself, and none of it reaches the viewer.
//
// CSRF + DNS-rebinding guard (review r-p2b finding 4): because the key is added for whoever reaches
// the viewer, every forwarded request must name an allow-listed Host (421 otherwise: a rebound name
// pointing at 127.0.0.1 never gets the key), and every request other than GET/HEAD/OPTIONS must
// carry an Origin that is the viewer's own (the request's Host) or an allow-listed edge origin
// (403 otherwise; a missing or "null" Origin is refused; a Referer, when sent, must agree).
// WIKI_VIEWER_ALLOWED_HOSTS: extra host names (no port) beyond loopback and the container's names;
// WIKI_VIEWER_ALLOWED_ORIGINS: extra origins (scheme://host[:port]) - the edge's public origin.
import http from "node:http";
import https from "node:https";
import { hostname as osHostname } from "node:os";

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "x-brain-key", "content-length"]);
const UPLOAD = /^\/workbench\/(import(\/|$|\?)|sources\/[^/]+\/replace-from-upload)/;
const MB = 1024 * 1024;

const list = (v) => String(v || "").split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

export function proxyConfig(env = process.env) {
  const url = String(env.WORKBENCH_URL || "").replace(/\/+$/, "");
  const key = String(env.WORKBENCH_KEY || "");
  if (!(url && key)) return null;
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]", "openbrain-wiki-viewer", osHostname().toLowerCase(),
    ...list(env.WIKI_VIEWER_ALLOWED_HOSTS)]);
  const origins = new Set(list(env.WIKI_VIEWER_ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, "")));
  return { url, key, hosts, origins };
}

// the host name of a Host header value ("name:port", "[v6]:port"), lower-cased; "" if unusable
export function hostName(h) {
  const v = String(h || "").trim().toLowerCase();
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/.exec(v);
  return m ? m[1] : "";
}

function originOf(u) {
  try { const x = new URL(u); return x.origin === "null" ? "" : x.origin.toLowerCase(); } catch { return ""; }
}

// null when the request may be forwarded, else [status, reason]
export function refuse(req, cfg) {
  const host = String(req.headers.host || "").trim().toLowerCase();
  const name = hostName(host);
  if (!name || !cfg.hosts?.has(name)) return [421, "this host name is not one the viewer answers for"];
  const m = String(req.method || "GET").toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return null;
  const ok = (o) => !!o && (o.replace(/^[a-z]+:\/\//, "") === host || (cfg.origins?.has(o) ?? false));
  const origin = originOf(req.headers.origin);
  if (!ok(origin)) return [403, "a write is accepted only from the viewer's own origin or the edge's"];
  if (req.headers["sec-fetch-site"] === "cross-site") return [403, "cross-site write refused"];
  if (req.headers.referer !== undefined && !ok(originOf(req.headers.referer))) return [403, "the referer is not the viewer's origin"];
  return null;
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
  const no = refuse(req, cfg);
  if (no) {
    req.resume();
    res.writeHead(no[0], { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: no[1] }));
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
