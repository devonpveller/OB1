"""The second opinion's HTTP transport: the ONE intake module that opens a socket (I4).

    send(HttpRequest) -> HttpResponse      (intake.second_opinion.Transport)

It sends to exactly one place: POST http://llama-cpp:8080/v1/chat/completions, the LiteLLM
gateway alias (CLAUDE.md: never route inference around LiteLLM). Any other scheme, host, port,
path, query or userinfo is refused before a connection is made (TransportError "refused"). No
proxy is consulted (http.client, not urllib), redirects are not followed (a 3xx is just a
status), and the reply is read to at most MAX_REPLY_BYTES + 1 bytes. Standard library only.
It logs nothing; the caller (second_opinion.Judge) logs outcomes, never headers.

THE RESPONSE HAS ONE DEADLINE (attempt 1 T-F4): req.timeout seconds from the start, not per
socket operation. Once the socket is connected, a watchdog timer shuts it down at the deadline
(ending a stall while sending the request or reading the headers), and the body is read in
pieces with the socket timeout set to what is left. A gateway that drips bytes gets `timeout`
at the deadline. THE CONNECT IS NOT COVERED by the watchdog (attempt 2 T2-F1): until
create_connection returns there is no socket to shut down, so a slow name lookup or connect is
bounded only by the per-attempt socket timeout (req.timeout for EACH resolved address) and by
I5's killable worker, which remains the outer bound (operator D38). The outcome is still
`timeout`, never a verdict.
"""
from __future__ import annotations

import http.client
import socket
import threading
import time
from urllib.parse import urlsplit

from intake.second_opinion import (ENDPOINT, MAX_REPLY_BYTES, HttpRequest, HttpResponse,
                                   TransportError)

_TARGET = urlsplit(ENDPOINT)
HOST, PORT, PATH = _TARGET.hostname, _TARGET.port, _TARGET.path
assert (_TARGET.scheme, HOST, PORT, PATH) == ("http", "llama-cpp", 8080, "/v1/chat/completions")
_PIECE = 4096


def _check(url: str) -> None:
    u = urlsplit(url)
    if (u.scheme, u.hostname, u.port, u.path, u.query, u.fragment, u.username, u.password) != (
            "http", HOST, PORT, PATH, "", "", None, None) or url != ENDPOINT:
        raise TransportError("refused", "only the LiteLLM gateway alias is allowed")


class _Watchdog:
    """Shuts the connection's socket down at the deadline (from a timer thread)."""

    def __init__(self, conn, seconds: float):
        self.conn = conn
        self.sock = None
        self.fired = False
        self._lock = threading.Lock()
        self._timer = threading.Timer(max(seconds, 0.0), self._fire)
        self._timer.daemon = True

    def start(self):
        self._timer.start()

    def watch(self, sock):
        with self._lock:
            self.sock = sock
            if self.fired:
                self._shutdown()

    def _shutdown(self):
        for s in (self.sock, getattr(self.conn, "sock", None)):
            if s is not None:
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except Exception:  # noqa: BLE001 - already closed: nothing left to stop
                    pass

    def _fire(self):
        with self._lock:
            self.fired = True
            self._shutdown()

    def cancel(self):
        self._timer.cancel()


def _closed(resp) -> bool:
    """http.client's HTTPResponse.isclosed(); False for anything without one."""
    try:
        return bool(resp.isclosed())
    except Exception:  # noqa: BLE001
        return False


def send(req: HttpRequest) -> HttpResponse:
    _check(req.url)
    if req.method != "POST":
        raise TransportError("refused", "POST only")
    deadline = time.monotonic() + req.timeout
    conn = http.client.HTTPConnection(HOST, PORT, timeout=req.timeout)
    dog = _Watchdog(conn, req.timeout)
    dog.start()
    try:
        conn.request("POST", PATH, body=req.body, headers=dict(req.headers))
        sock = conn.sock  # kept: getresponse() may drop conn.sock on a closing reply
        dog.watch(sock)
        resp = conn.getresponse()
        body = bytearray()
        while True:
            left = deadline - time.monotonic()
            if left <= 0 or dog.fired:
                raise TransportError("timeout", "the request passed its deadline")
            # intake-i5 e2e T-1: http.client closes the response AND its socket once a body of
            # known length has been read whole (HTTP/1.0, `Connection: close`); the body is then
            # complete - stop here instead of calling settimeout() on the closed socket (EBADF,
            # which turned every such reply into `network`).
            if _closed(resp):
                break
            if sock is not None:
                try:
                    sock.settimeout(left)
                except OSError:
                    if _closed(resp):
                        break
                    raise
            piece = resp.read1(min(_PIECE, MAX_REPLY_BYTES + 1 - len(body)))
            if not piece:
                break
            body += piece
            if len(body) > MAX_REPLY_BYTES:
                raise TransportError("oversize", f"reply over {MAX_REPLY_BYTES} bytes")
        if dog.fired or time.monotonic() > deadline:
            raise TransportError("timeout", "the request passed its deadline")
        return HttpResponse(resp.status, bytes(body))
    except TransportError:
        raise
    except (socket.timeout, TimeoutError):
        raise TransportError("timeout", "no reply in time") from None
    except Exception as e:  # noqa: BLE001 - every other failure is a network outcome
        if dog.fired or time.monotonic() >= deadline:
            raise TransportError("timeout", "the request passed its deadline") from None
        raise TransportError("network", type(e).__name__) from None
    finally:
        dog.cancel()
        conn.close()
