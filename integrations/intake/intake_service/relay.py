"""The fixed-target TCP relay: the intake service's ONLY routes out of its network (I5).

The service must have no outbound network except the database and the LiteLLM gateway. It sits
on its own INTERNAL network (`intake-net`, no gateway) and NOTHING else; two instances of this
relay - the same image, `relay` command - each forward one port to one fixed target:
  openbrain-intake-dbrelay   obnet + intake-net      :5432 -> openbrain-db:5432
      (openbrain-db lives on `obnet`, an ordinary bridge with a route to the internet, so the
      service cannot join it; adding a network to openbrain-db would recreate the live database
      container on the next `up` even with the intake profile off)
  openbrain-intake-llmrelay  llm-net + intake-net    :8080 -> llm-gateway:8080, aliased
      `llama-cpp` on intake-net (the service must not join ai-stack_llm-net itself: ~30 callers
      are reachable there, intake-i5 attempt 1; the target is the gateway's container name, not
      `llama-cpp`, which on intake-net is this relay)
A relay forwards bytes and nothing else: no parsing, no other destination; the database and
LiteLLM still authenticate intake themselves (the role's password, the virtual key).

  INTAKE_RELAY_LISTEN_PORT      5432
  INTAKE_RELAY_TARGET_HOST      openbrain-db
  INTAKE_RELAY_TARGET_PORT      5432
  INTAKE_RELAY_MAX_CONNECTIONS  32 at once; more are closed at accept
Invalid values refuse the start (exit 2), like the service's.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re

log = logging.getLogger("intake_service.relay")
_HOST = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}")
_INT = re.compile(r"[0-9]{1,6}")


class RelayConfigError(Exception):
    pass


def _int(env, name, default, lo, hi) -> int:
    raw = env.get(name, str(default))
    if not _INT.fullmatch(raw) or not lo <= int(raw) <= hi:
        raise RelayConfigError(f"{name}={raw!r} is not a whole number in [{lo}, {hi}]")
    return int(raw)


def config(env) -> dict:
    host = env.get("INTAKE_RELAY_TARGET_HOST", "openbrain-db")
    if not _HOST.fullmatch(host):
        raise RelayConfigError(f"INTAKE_RELAY_TARGET_HOST={host!r} is not a host name")
    return {"listen_port": _int(env, "INTAKE_RELAY_LISTEN_PORT", 5432, 1, 65535),
            "host": host,
            "port": _int(env, "INTAKE_RELAY_TARGET_PORT", 5432, 1, 65535),
            "max": _int(env, "INTAKE_RELAY_MAX_CONNECTIONS", 32, 1, 1024)}


async def _pump(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    with contextlib.suppress(ConnectionError, OSError, asyncio.IncompleteReadError):
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()


async def serve(cfg: dict) -> None:
    active = 0

    async def handle(r1: asyncio.StreamReader, w1: asyncio.StreamWriter) -> None:
        nonlocal active
        if active >= cfg["max"]:
            w1.close()
            return
        active += 1
        w2 = None
        try:
            try:
                r2, w2 = await asyncio.wait_for(asyncio.open_connection(cfg["host"], cfg["port"]), 10)
            except (OSError, asyncio.TimeoutError) as e:
                log.warning("relay: target unreachable (%s)", type(e).__name__)
                return
            tasks = [asyncio.create_task(_pump(r1, w2)), asyncio.create_task(_pump(r2, w1))]
            _done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
        finally:
            active -= 1
            for w in (w1, w2):
                if w is not None:
                    with contextlib.suppress(Exception):
                        w.close()

    server = await asyncio.start_server(handle, "0.0.0.0", cfg["listen_port"])
    log.info("relay listening on :%d -> %s:%d (max %d connections)", cfg["listen_port"], cfg["host"],
             cfg["port"], cfg["max"])
    async with server:
        await server.serve_forever()


def main(env=None) -> int:
    env = os.environ if env is None else env
    try:
        cfg = config(env)
    except RelayConfigError as e:
        log.error("relay config refused: %s", e)
        return 2
    try:
        asyncio.run(serve(cfg))
    except KeyboardInterrupt:
        pass
    return 0
