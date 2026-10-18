"""The HTTP surface (I5), standard library only.

  POST /v1/intake   one envelope (JSON) in, the result out          key required
  GET  /v1/stats    stats.collect() (?since=<ISO 8601 with zone>)   key required
  GET  /metrics     Prometheus text (metrics.py)                    key required
  GET  /healthz     {ok, workers, db, ...}; 200 or 503              no key (compose healthcheck)

THE ORDER OF THE CHECKS, each before any work the next one needs:
  path and method  404 / 405
  key              `Authorization: Bearer <key>`: none or not a bearer token -> 401; a key that
                   is no caller's -> 403 (constant-time, against every key). The key names the
                   connector the envelope must carry (else 403, after stage 1, before screening).
  length           Transfer-Encoding (chunked) -> 411; no Content-Length -> 411; a malformed one
                   -> 400; over INTAKE_MAX_REQUEST_BYTES -> 413. The body is NOT read in any of
                   these cases, and the connection is closed.
  in flight        more than INTAKE_MAX_INFLIGHT requests at once -> 503
  body             read exactly Content-Length bytes under the socket timeout (30 s); short -> 400
Then core.Intake.handle: 200 (a result, including `pending` and content `rejected`), 400 (not a
JSON object), 403 (connector), 422 (an invalid envelope: stage 1 `rejected`), 503 (busy, no
worker, the store down, or no key announced). 500 only for a bug, with no detail.

The access log is one line per request: method, path, status, the CALLER'S CONNECTOR NAME and
the time. Never a header, a key, a body or a query value.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

from .store import StoreUnavailable

log = logging.getLogger("intake_service.web")
ROUTES = {"/v1/intake": ("POST",), "/v1/stats": ("GET",), "/metrics": ("GET",), "/healthz": ("GET",)}
_LEN = re.compile(r"[0-9]{1,9}")
_JSON = "application/json; charset=utf-8"


@dataclass
class Response:
    status: int
    body: bytes = b""
    headers: list = field(default_factory=list)


def _json(status: int, doc, *extra) -> Response:
    return Response(status, json.dumps(doc, ensure_ascii=False).encode("utf-8"),
                    [("Content-Type", _JSON), *extra])


def _header(headers, name: str) -> str | None:
    get = getattr(headers, "get", None)
    if get is not None:
        v = get(name)
        if v is not None:
            return v
    low = name.lower()
    for k, v in (headers.items() if hasattr(headers, "items") else ()):
        if str(k).lower() == low:
            return v
    return None


class Router:
    def __init__(self, svc, settings):
        self.svc = svc
        self.settings = settings
        self.inflight = threading.BoundedSemaphore(settings.max_inflight)

    def dispatch(self, method: str, path: str, headers, read) -> Response:
        t0 = time.monotonic()
        route, _, query = path.partition("?")
        caller = None
        try:
            resp, caller = self._route(method, route, query, headers, read)
        except Exception as e:  # noqa: BLE001 - a bug: no detail leaves the service
            log.error("unhandled %s on %s %s", type(e).__name__, method, route)
            resp = _json(500, {"error": "internal error"})
        resp.headers.append(("X-Content-Type-Options", "nosniff"))
        resp.headers.append(("Cache-Control", "no-store"))
        self.svc.metrics.inc("intake_requests_total", path=route if route in ROUTES else "other",
                             code=str(resp.status))
        log.info("%s %s -> %d caller=%s %.0fms", method, route if route in ROUTES else "<other>",
                 resp.status, caller or "-", (time.monotonic() - t0) * 1000)
        return resp

    def _auth(self, headers) -> tuple[str | None, Response | None]:
        value = _header(headers, "Authorization") or ""
        scheme, _, token = value.strip().partition(" ")
        if scheme.lower() != "bearer" or not token.strip():
            return None, _json(401, {"error": "a key is required (Authorization: Bearer <key>)"},
                               ("WWW-Authenticate", 'Bearer realm="intake"'))
        caller = self.settings.callers.match(token.strip())
        if caller is None:
            return None, _json(403, {"error": "this key is not valid"})
        return caller, None

    def _route(self, method, route, query, headers, read):
        if route not in ROUTES:
            return _json(404, {"error": "not found"}), None
        if method not in ROUTES[route]:
            return _json(405, {"error": "method not allowed"}, ("Allow", ", ".join(ROUTES[route]))), None
        if route == "/healthz":
            return self._health(), None
        caller, refused = self._auth(headers)
        if refused is not None:
            return refused, None
        if route == "/v1/stats":
            return self._stats(query), caller
        if route == "/metrics":
            text = self.svc.metrics.render(self.svc.gauges())
            return Response(200, text.encode("utf-8"), [("Content-Type", "text/plain; version=0.0.4")]), caller
        return self._intake(caller, headers, read), caller

    def _intake(self, caller, headers, read) -> Response:
        if _header(headers, "Transfer-Encoding") is not None:
            return _json(411, {"error": "send the body with a Content-Length (no chunked transfer)"})
        raw_len = _header(headers, "Content-Length")
        if raw_len is None:
            return _json(411, {"error": "Content-Length is required"})
        if not _LEN.fullmatch(raw_len):
            return _json(400, {"error": "Content-Length is not a whole number"})
        n = int(raw_len)
        if n > self.settings.max_request_bytes:
            return _json(413, {"error": f"the body is over {self.settings.max_request_bytes} bytes; "
                                        "send raw as base64 if it is near the 5 MB raw cap"})
        if not self.inflight.acquire(blocking=False):
            return _json(503, {"error": "too many requests in flight; retry later"}, ("Retry-After", "5"))
        try:
            data = read(n)
            if data is None or len(data) != n:
                return _json(400, {"error": "the body is shorter than its Content-Length"})
            status, doc = self.svc.handle(caller, data)
        finally:
            self.inflight.release()
        extra = (("Retry-After", "30"),) if status == 503 else ()
        return _json(status, doc, *extra)

    def _stats(self, query: str) -> Response:
        since = None
        q = parse_qs(query, keep_blank_values=True, max_num_fields=4)
        if "since" in q:
            try:
                since = dt.datetime.fromisoformat(q["since"][0])
            except ValueError:
                return _json(400, {"error": "since is not an ISO 8601 timestamp"})
            if since.tzinfo is None or since.utcoffset() is None:
                return _json(400, {"error": "since needs a time zone"})
        try:
            return _json(200, self.svc.stats(since))
        except StoreUnavailable:
            return _json(503, {"error": "store unavailable; retry later"}, ("Retry-After", "30"))

    def _health(self) -> Response:
        st = self.svc.pool.status()
        db = bool(self.svc.store.ping())
        ok = st.get("ready", 0) >= 1 and db
        return _json(200 if ok else 503, {
            "ok": ok, "workers": st, "db": db,
            "classifier": getattr(self.svc.pool, "version", None),
            "second_opinion_key": self.settings.second_opinion_key_set,
        })


class _Handler(BaseHTTPRequestHandler):
    server_version = "intake"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = 30

    def _do(self):
        resp = self.server.router.dispatch(self.command, self.path, self.headers, self.rfile.read)
        self.send_response(resp.status)
        for k, v in resp.headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(resp.body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(resp.body)
        self.close_connection = True

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _do

    def log_message(self, format, *args):  # noqa: A002 - the router logs; never headers
        return


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, router: Router, host: str, port: int):
        self.router = router
        super().__init__((host, port), _Handler)
