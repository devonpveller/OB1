// Security response headers on EVERY viewer response - pages, assets, health, errors and whatever the
// /workbench/* forwarder answers (edge-b5-portal-retire, tester t-edge-b5 D1). The retired portal Caddy
// set these on every site (its `security_headers` snippet); the tailnet route now reaches the viewer
// with no proxy in front, so the viewer sets them itself. An edge in front (the Proxmox Traefik) may
// add its own; a header the response already names is left as it is.
//
// HSTS: sent without includeSubDomains (the edge owns any domain-wide policy). It is only meaningful
// when the browser reached the viewer over TLS - the tailnet `tailscale serve` route and the Traefik
// door both are - and a browser ignores it on a plain-http answer (RFC 6797 8.1), so on the loopback
// debug port it is inert.
export const SECURITY_HEADERS = Object.freeze({
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "geolocation=(), microphone=(), camera=(), usb=()",
  "cross-origin-opener-policy": "same-origin",
});

export function setSecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!res.hasHeader(k)) res.setHeader(k, v);
}

// Wrap a request handler: the headers are set before it runs (writeHead merges them into whatever it
// writes), and a handler that throws still answers 500 with them.
export function withSecurityHeaders(handler) {
  return (req, res) => {
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
