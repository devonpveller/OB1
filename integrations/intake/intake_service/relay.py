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
  INTAKE_RELAY_IDLE_SECONDS     900: a connection with no byte in either direction for this long
                                is closed, so stale connections cannot hold every slot until a
                                restart (intake-int review R-6). Compose sets the DB relay to 900
                                (the store drops a pooled connection idle 300 s) and the LLM relay
                                to 600 (over the judge's 120 s request timeout)
Invalid values refuse the start (exit 2), like the service's.

HALF-CLOSE (R-6): when one side finishes sending (EOF), the relay passes that on (write_eof) and
keeps carrying the other direction until it ends too, so a client that shuts down its sending
half after its request still gets the reply. A reset or error on either side closes both.
NO FORWARDING: compose sets net.ipv4.ip_forward=0 in each relay's namespace (R2-F2), so a peer
with NET_ADMIN on llm-net or obnet cannot route through a relay into intake-net.
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


def _num(env, name, default, lo, hi) -> float:
    raw = env.get(name, str(default))
    if not re.fullmatch(r"[0-9]{1,6}(\.[0-9]{1,3})?", raw) or not lo <= float(raw) <= hi:
        raise RelayConfigError(f"{name}={raw!r} is not a number in [{lo}, {hi}]")
    return float(raw)


def config(env) -> dict:
    host = env.get("INTAKE_RELAY_TARGET_HOST", "openbrain-db")
    if not _HOST.fullmatch(host):
        raise RelayConfigError(f"INTAKE_RELAY_TARGET_HOST={host!r} is not a host name")
    return {"listen_port": _int(env, "INTAKE_RELAY_LISTEN_PORT", 5432, 1, 65535),
            "host": host,
            "port": _int(env, "INTAKE_RELAY_TARGET_PORT", 5432, 1, 65535),
            "max": _int(env, "INTAKE_RELAY_MAX_CONNECTIONS", 32, 1, 1024),
            "idle_s": _num(env, "INTAKE_RELAY_IDLE_SECONDS", 900, 0.1, 86400)}


async def _pump(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, touch) -> bool:
    """One direction. True: the sender finished (EOF), passed on as a half-close. False: an error
    (the caller closes both sides)."""
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            touch()
            writer.write(data)
            await writer.drain()
        if writer.can_write_eof():
            writer.write_eof()
        return True
    except (ConnectionError, OSError, asyncio.IncompleteReadError):
        return False


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
            loop = asyncio.get_running_loop()
            last = [loop.time()]

            def touch():
                last[0] = loop.time()

            pending = {asyncio.create_task(_pump(r1, w2, touch)), asyncio.create_task(_pump(r2, w1, touch))}
            try:
                while pending:
                    left = cfg["idle_s"] - (loop.time() - last[0])
                    if left <= 0:
                        log.info("relay: closing a connection idle for %.0fs", cfg["idle_s"])
                        break
                    done, pending = await asyncio.wait(pending, timeout=left,
                                                       return_when=asyncio.FIRST_COMPLETED)
                    if any(not t.result() for t in done):
                        break  # a reset or error on one side: close both
            finally:
                for t in pending:
                    t.cancel()
        finally:
            active -= 1
            for w in (w1, w2):
                if w is not None:
                    with contextlib.suppress(Exception):
                        w.close()

    server = await asyncio.start_server(handle, cfg.get("listen_host", "0.0.0.0"), cfg["listen_port"])
    log.info("relay listening on :%d -> %s:%d (max %d connections, idle %.0fs)", cfg["listen_port"], cfg["host"],
             cfg["port"], cfg["max"], cfg["idle_s"])
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
