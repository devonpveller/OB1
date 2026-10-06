"""Disposable pass-through proxy that can answer 502 on demand (repro_spin.py).

mcpo -> this proxy -> stand-in MCP server. It streams requests and responses
through unchanged, so mcpo's streamable-http session (POSTs plus the long-lived
GET event stream) works as if it were direct. The trigger of
open-webui/mcpo#302 is "the upstream answers a transient 502 on an established
connection"; the rig arms it with:

    POST /__ctl/fail?n=<k>   the next k forwarded requests get 502 Bad Gateway
                             AND every open event stream is cut
    POST /__ctl/ok           back to pass-through
    GET  /__ctl/state        {"fail_left": k, "forwarded": n, "failed": m}

Runs inside the mcpo base image (starlette, httpx and uvicorn are already
there). UPSTREAM is the base URL of the stand-in, e.g. http://upstream:8000.
"""

import os

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

UPSTREAM = os.environ.get("UPSTREAM", "http://upstream:8000").rstrip("/")
HOP = {"host", "content-length", "connection", "keep-alive", "transfer-encoding", "te", "upgrade"}

state = {"fail_left": 0, "forwarded": 0, "failed": 0, "generation": 0}
client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=5.0))


async def ctl_fail(request: Request) -> Response:
    state["fail_left"] = int(request.query_params.get("n", "1"))
    state["generation"] += 1  # cuts every stream opened before this
    return JSONResponse(state)


async def ctl_ok(request: Request) -> Response:
    state["fail_left"] = 0
    return JSONResponse(state)


async def ctl_state(request: Request) -> Response:
    return JSONResponse(state)


async def forward(request: Request) -> Response:
    if state["fail_left"] > 0:
        state["fail_left"] -= 1
        state["failed"] += 1
        return Response("Bad Gateway (rig)", status_code=502)
    state["forwarded"] += 1
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
    body = await request.body()
    upstream_req = client.build_request(
        request.method, UPSTREAM + request.url.path, params=request.query_params, headers=headers, content=body
    )
    try:
        resp = await client.send(upstream_req, stream=True)
    except httpx.HTTPError as exc:
        state["failed"] += 1
        return Response(f"Bad Gateway (rig): {type(exc).__name__}", status_code=502)

    born = state["generation"]

    async def body_iter():
        try:
            async for chunk in resp.aiter_raw():
                if state["generation"] != born:
                    # Armed: drop open streams mid-flight, like a gateway that
                    # lost its backend.
                    break
                yield chunk
        finally:
            await resp.aclose()

    out_headers = {k: v for k, v in resp.headers.items() if k.lower() not in HOP}
    return StreamingResponse(body_iter(), status_code=resp.status_code, headers=out_headers)


app = Starlette(
    routes=[
        Route("/__ctl/fail", ctl_fail, methods=["POST"]),
        Route("/__ctl/ok", ctl_ok, methods=["POST"]),
        Route("/__ctl/state", ctl_state, methods=["GET"]),
        Route("/{path:path}", forward, methods=["GET", "POST", "DELETE", "PUT", "PATCH", "OPTIONS"]),
    ]
)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="warning")
