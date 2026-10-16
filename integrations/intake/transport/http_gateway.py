"""The second opinion's HTTP transport: the ONE intake module that opens a socket (I4).

    send(HttpRequest) -> HttpResponse      (intake.second_opinion.Transport)

It sends to exactly one place: POST http://llama-cpp:8080/v1/chat/completions, the LiteLLM
gateway alias (CLAUDE.md: never route inference around LiteLLM). Any other scheme, host, port,
path, query or userinfo is refused before a connection is made (TransportError "refused"). No
proxy is consulted (http.client, not urllib), redirects are not followed (a 3xx is just a
status), and the reply is read to at most MAX_REPLY_BYTES + 1 bytes. Standard library only.
It logs nothing; the caller (second_opinion.Judge) logs outcomes, never headers.
"""
from __future__ import annotations

import http.client
import socket
from urllib.parse import urlsplit

from intake.second_opinion import (ENDPOINT, MAX_REPLY_BYTES, HttpRequest, HttpResponse,
                                   TransportError)

_TARGET = urlsplit(ENDPOINT)
HOST, PORT, PATH = _TARGET.hostname, _TARGET.port, _TARGET.path
assert (_TARGET.scheme, HOST, PORT, PATH) == ("http", "llama-cpp", 8080, "/v1/chat/completions")


def _check(url: str) -> None:
    u = urlsplit(url)
    if (u.scheme, u.hostname, u.port, u.path, u.query, u.fragment, u.username, u.password) != (
            "http", HOST, PORT, PATH, "", "", None, None) or url != ENDPOINT:
        raise TransportError("refused", "only the LiteLLM gateway alias is allowed")


def send(req: HttpRequest) -> HttpResponse:
    _check(req.url)
    if req.method != "POST":
        raise TransportError("refused", "POST only")
    conn = http.client.HTTPConnection(HOST, PORT, timeout=req.timeout)
    try:
        conn.request("POST", PATH, body=req.body, headers=dict(req.headers))
        resp = conn.getresponse()
        body = resp.read(MAX_REPLY_BYTES + 1)
        if len(body) > MAX_REPLY_BYTES:
            raise TransportError("oversize", f"reply over {MAX_REPLY_BYTES} bytes")
        return HttpResponse(resp.status, body)
    except TransportError:
        raise
    except (socket.timeout, TimeoutError):
        raise TransportError("timeout", "no reply in time") from None
    except Exception as e:  # noqa: BLE001 - every other failure is a network outcome
        raise TransportError("network", type(e).__name__) from None
    finally:
        conn.close()
