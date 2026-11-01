// Security response headers on EVERY viewer response - pages, assets, health, errors and whatever the
// /workbench/* forwarder answers (edge-b5-portal-retire, tester t-edge-b5 D1). The retired portal Caddy
// set these on every site (its `security_headers` snippet); the tailnet route now reaches the viewer
// with no proxy in front, so the viewer sets them itself.
//
// They WIN (round 3, tester t-edge-b5b): a value an upstream (the workbench behind the forwarder) or a
// handler writes for one of these names is replaced by the viewer's, at writeHead time - as Caddy's
// `header` directive replaced an upstream's. The one deliberate relaxation is allowSameOriginFraming(res):
// X-Frame-Options SAMEORIGIN for that response only (the PDF attachments the wiki embeds in its own
// <iframe>, lib/render-page.mjs); every other header stays.
//
// HSTS: sent without includeSubDomains (the edge owns any domain-wide policy). It is only meaningful
// when the browser reached the viewer over TLS - the tailnet `tailscale serve` route and the Traefik
// door both are - and a browser ignores it on a plain-http answer (RFC 6797 8.1), so on the loopback
// debug port it is inert.
// CORP same-site (round 3, D3; Caddyfile:46): everything the viewer serves is loaded same-origin - its
// pages, the workspace's assets, the PDFs it frames itself - so it blocks nothing the viewer uses; it
// stops another site embedding the viewer's resources. No route is exempt.
export const SECURITY_HEADERS = Object.freeze({
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "geolocation=(), microphone=(), camera=(), usb=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-site",
});

const FRAMING = Symbol("viewer.allowSameOriginFraming");

// This response may be framed by the viewer's own pages (X-Frame-Options SAMEORIGIN) - nothing else changes.
export function allowSameOriginFraming(res) {
  res[FRAMING] = true;
}

function wanted(res) {
  return res[FRAMING] ? { ...SECURITY_HEADERS, "x-frame-options": "SAMEORIGIN" } : SECURITY_HEADERS;
}

// The headers argument of writeHead without any security header name (any case): an object, or a raw
// [name, value, name, value, ...] array.
function withoutSecurityNames(headers) {
  if (Array.isArray(headers)) {
    const out = [];
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (!(String(headers[i]).toLowerCase() in SECURITY_HEADERS)) out.push(headers[i], headers[i + 1]);
    }
    return out;
  }
  if (headers && typeof headers === "object") {
    const out = {};
    for (const [k, v] of Object.entries(headers)) if (!(k.toLowerCase() in SECURITY_HEADERS)) out[k] = v;
    return out;
  }
  return headers;
}

export function setSecurityHeaders(res) {
  for (const [k, v] of Object.entries(wanted(res))) res.setHeader(k, v);
}

// Make the viewer's values final on this response: whatever writeHead is given (or setHeader set before
// it), the security names carry the viewer's values. node calls writeHead for an implicit head too.
function enforce(res) {
  const writeHead = res.writeHead;
  res.writeHead = function (status, ...rest) {
    const i = rest.findIndex((a) => a && typeof a === "object");
    if (i >= 0) rest[i] = withoutSecurityNames(rest[i]);
    setSecurityHeaders(res);
    return writeHead.call(this, status, ...rest);
  };
}

// Wrap a request handler: the headers are set before it runs and made final at writeHead, and a handler
// that throws still answers 500 with them.
export function withSecurityHeaders(handler) {
  return (req, res) => {
    enforce(res);
    setSecurityHeaders(res);
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((e) => {
        console.error("[wiki-viewer] request failed:", e?.stack || e?.message || e);
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error");
      });
  };
}
