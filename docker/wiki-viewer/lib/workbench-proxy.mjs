// /workbench/* through the viewer (rw-p2b-workspace, operator 2026-10-28: the edge - Traefik with
// Authentik in front - targets the viewer alone, the ob1 plane's one front-end port). The viewer
// forwards the request to the workbench with the shared key injected SERVER-SIDE; a key the client
// sent is dropped, so the browser can never hold or forge one. Request bodies are capped as the
// portal's (wiki_app) Caddy snippet capped them: 100 MB on the upload paths, 1 MB elsewhere.
// Off (404) unless WORKBENCH_URL and WORKBENCH_KEY are both set. This is the only browser door to
// /workbench: the portal Caddy's own route is gone (rw-identity-harden; the portal is retired).
//
// CSRF + DNS-rebinding guard (review r-p2b finding 4): because the key is added for whoever reaches
// the viewer, every forwarded request must name an allow-listed Host (421 otherwise: a rebound name
// pointing at 127.0.0.1 never gets the key), and every request other than GET/HEAD/OPTIONS must
// carry an Origin that is the viewer's own (the request's Host) or an allow-listed edge origin
// (403 otherwise; a missing or "null" Origin is refused; a Referer, when sent, must agree).
// WIKI_VIEWER_ALLOWED_HOSTS: extra host names (no port) beyond loopback and the container's names;
// WIKI_VIEWER_ALLOWED_ORIGINS: extra origins (scheme://host[:port]) - the edge's public origin.
//
// rw-identity: the key injected is WORKSPACE_DOOR_KEY when set (the browser door's own key - required
// once the workbench signs users in, so that WORKBENCH_KEY marks an internal service, never a browser),
// else WORKBENCH_KEY as before. And no client may name its own identity: the identity header the
// workbench may be configured to trust (WORKSPACE_IDENTITY_HEADER, WORKSPACE_IDENTITY_NAME_HEADER) is
// DROPPED from every forwarded request, whatever its value; the workbench ignores it anyway while
// sign-in is configured. rw-identity2 (Authentik forward-auth): the outpost's signed token that Traefik
// puts on the request (X-authentik-jwt) passes to the workbench UNCHANGED - the workbench verifies it on
// every request; the viewer never makes, alters or judges one (the unsigned X-authentik-* headers pass
// too and count for nothing). Cookies pass, as before.
import http from "node:http";
import https from "node:https";
import { hostname as osHostname } from "node:os";

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "x-brain-key", "content-length"]);
// edge-b5-portal-retire (tester t-edge-b5 D1): what a CLIENT claims about who or where it is never
// reaches the workbench. The retired portal Caddy stripped Remote-* and X-Forwarded-Host / X-Real-IP
// before anything else; the tailnet route now reaches the viewer directly, so the viewer drops, from
// EVERY forwarded request and whatever door it came through, every unsigned identity header (Remote-*,
// X-Remote-*, X-Forwarded-User / -Email / -Groups / -Preferred-Username, X-Auth-Request-*) and every
// proxy-chain header (X-Forwarded-*, X-Real-IP, Forwarded, X-Original-*); X-Forwarded-Proto is the
// viewer's own ("https": both doors in front of it are TLS). The doors cannot be told apart from here
// (Docker publishes the LAN and loopback ports from the same gateway address), and they need not be:
// the only identity the trusted LAN door (Traefik + Authentik) brings is the outpost's SIGNED token,
// X-authentik-jwt, which the workbench verifies on every request - so it passes from any door, and an
// unsigned header from any door counts for nothing. WORKSPACE_IDENTITY_HEADER (and its name header)
// stays dropped as before (cfg.strip).
const FORGEABLE = /^(remote-|x-remote-|x-forwarded-|x-real-ip$|forwarded$|x-original-|x-auth-request-)/;
const UPLOAD = /^\/workbench\/(import(\/|$|\?)|sources\/[^/]+\/replace-from-upload)/;
const MB = 1024 * 1024;

const list = (v) => String(v || "").split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

export function proxyConfig(env = process.env) {
  const url = String(env.WORKBENCH_URL || "").replace(/\/+$/, "");
  const key = String(env.WORKSPACE_DOOR_KEY || "").trim() || String(env.WORKBENCH_KEY || "");
  if (!(url && key)) return null;
  // never forwarded from a client: the identity header(s) the workbench may trust
  const strip = new Set([env.WORKSPACE_IDENTITY_HEADER, env.WORKSPACE_IDENTITY_NAME_HEADER]
    .map((h) => String(h || "").trim().toLowerCase()).filter(Boolean));
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]", "openbrain-wiki-viewer", osHostname().toLowerCase(),
    ...list(env.WIKI_VIEWER_ALLOWED_HOSTS)]);
  const origins = new Set(list(env.WIKI_VIEWER_ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, "")));
  return { url, key, hosts, origins, strip };
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

// rwr-app-scaffold round 2: the path the forwarder may send on. The request target is judged BEFORE it is
// joined to the upstream and again AFTER the URL parser resolved it: it must start with exactly
// "/workbench/" (case-sensitive; no "//", no ";" tricks), hold no backslash and no control character
// (raw or percent-encoded, checked through up to 6 decode passes), and no dot-segment in any of those decodings.
// A path that is STILL changing after the 6 passes (more layers of encoding than any real caller builds) is refused
// ("too deeply encoded") rather than forwarded unjudged. A backslash or control character in a decoded name is
// refused on purpose. null = fine, else a reason.
function pathRefusal(rawUrl, cfg) {
  const url = String(rawUrl || "");
  if (!(url.startsWith("/workbench/") || url === "/workbench" || url.startsWith("/workbench?"))) return "only /workbench/... is forwarded";
  const pathPart = url.split(/[?#]/)[0];
  let p = pathPart;
  let settled = false;
  // round 3: only a FIRST decode that fails is refused. A later pass that throws (a literal "%" the first
  // pass produced: "50%25.md" -> "50%.md") is not refused: it falls back to a lenient per-escape decode and
  // stops when the string stops changing. A dot-segment / backslash / control character in any pass that did decode still refuses.
  for (let i = 0; i < 6; i++) {
    if (/[\u0000-\u001f\u007f\\]/.test(p)) return "a backslash or control character in the path";
    if (p.split("/").some((s) => s === ".." || s === ".")) return "a dot-segment in the path";
    let d;
    try { d = decodeURIComponent(p); } catch {
      if (i === 0) return "a path that does not decode";
      // a later pass hit a bare "%": decode the well-formed %XX escapes one by one (never throws), so a
      // traversal hidden behind a literal "%" is still seen; stop once that changes nothing
      d = p.replace(/%[0-9a-f]{2}/gi, (m) => String.fromCharCode(parseInt(m.slice(1), 16)));
    }
    if (d === p) { settled = true; break; }
    p = d;
  }
  if (!settled) return "a path that is too deeply encoded";
  if (/[\u0000-\u001f\u007f\\]/.test(url.slice(pathPart.length))) return "a control character in the query";
  let target;
  try { target = new URL(cfg.url + url); } catch { return "a path that does not resolve"; }
  const base = new URL(cfg.url).pathname.replace(/\/+$/, "");
  if (target.pathname !== base + "/workbench" && !target.pathname.startsWith(base + "/workbench/")) return "the path resolves outside /workbench/";
  return null;
}

// an absolute Location / Content-Location of the upstream becomes a relative one (the browser never sees
// the internal address; a base path of WORKBENCH_URL is stripped, as pathRefusal allows for it); one that
// names any other host is dropped
function relocate(value, cfg) {
  const v = String(Array.isArray(value) ? value[0] : value);
  if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(v)) return v;
  try {
    const u = new URL(v, cfg.url);
    const b = new URL(cfg.url);
    if (u.origin === b.origin) {
      const base = b.pathname.replace(/\/+$/, "");
      const path = base && (u.pathname === base || u.pathname.startsWith(base + "/")) ? u.pathname.slice(base.length) || "/" : u.pathname;
      return path + u.search + u.hash;
    }
  } catch { /* unparsable absolute: dropped */ }
  return null;
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
  const bad = pathRefusal(req.url, cfg);
  if (bad) {
    req.resume();
    res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: `refused: ${bad}` }));
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
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !cfg.strip?.has(k) && !FORGEABLE.test(k)) headers[k] = v;
  headers["x-brain-key"] = cfg.key;
  headers["x-forwarded-proto"] = "https";
  const lib = target.protocol === "https:" ? https : http;
  const up = lib.request(target, { method: req.method, headers, timeout: 600_000 }, (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k) || k === "content-length") out[k] = v;
    for (const h of ["location", "content-location"]) {
      if (out[h] === undefined) continue;
      const rel = relocate(out[h], cfg);
      if (rel === null) delete out[h]; else out[h] = rel;
    }
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

// round 5 (tester attempt 2, P11): a path that only BECOMES /workbench/... once it is decoded, its
// backslashes read as slashes, its case folded or its doubled slashes collapsed is still the
// workbench's - it is ROUTED to the forwarder, never answered by the wiki renderer as a page. (Since round 2
// the forwarder refuses the non-canonical ones - case, "//", backslash, encoded "workbench" - with 400
// locally; they never reach the workbench. This function only decides who answers.)
export function isWorkbenchPath(path) {
  let p = String(path || "");
  for (let i = 0; i < 4; i++) {
    let d;
    try { d = decodeURIComponent(p); } catch { break; }
    if (d === p) break;
    p = d;
  }
  p = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
  return p === "/workbench" || p.startsWith("/workbench/") || p.startsWith("/workbench;");
}
