"""Disposable stand-in MCP server for the mcpo spin rig (repro_spin.py).

Speaks the same transport as openbrain-mcp / openbrain-ext: MCP over
streamable-http at /mcp. It runs inside the mcpo base image, which already
ships mcp 1.26.0 + uvicorn, so the rig needs no network access to build it.

Two deterministic tools, so the parity test can compare mcpo's output
byte-for-byte between the stock and the derived image.
"""

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("stand-in", host="0.0.0.0", port=8000)


@mcp.tool()
def echo(text: str) -> str:
    """Return the text unchanged."""
    return text


@mcp.tool()
def add(a: int, b: int) -> dict:
    """Add two integers and return the sum with its inputs."""
    return {"a": a, "b": b, "sum": a + b}


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
