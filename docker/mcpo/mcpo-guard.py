#!/usr/bin/env python
"""mcpo-guard: run mcpo, and EXIT (so compose restarts the container) if it serves no tools.

Why this exists (2026-10-19, mcpo-resilience). mcpo loads its MCP servers ONCE, at
start. Started before its upstream (openbrain-mcp / openbrain-ext) was answering, it
loaded an empty server list, served `/<name>/openapi.json` with "paths": {} and never
retried. Its healthcheck only fetched that file (200 either way), and Docker does NOT
restart a container for being unhealthy - `restart: unless-stopped` reacts to an EXIT.
So a proxy with zero tools sat "healthy" until a human restarted it, and Open WebUI
showed the servers connected while the models had no Open Brain tools.

This wrapper is the exit. It is mounted read-only into the stock image (no rebuild) and
set as the service `entrypoint`; the service `command` is unchanged and is passed to
mcpo verbatim.

  1. start `mcpo <args>` as a child (PID 1 here, so SIGTERM/SIGINT are forwarded);
  2. after MCPO_GUARD_GRACE seconds, every MCPO_GUARD_INTERVAL seconds fetch
     MCPO_GUARD_URL (the proxy's own openapi.json);
  3. MCPO_GUARD_MISSES consecutive reads that show 0 paths (or no answer) -> kill the
     child and exit 1; compose restarts the container, which loads the tools afresh;
  4. a read with paths resets the count; the child exiting for any reason ends the
     guard with the child's own code.

It never loads a tool or calls an upstream itself and holds no key: the openapi.json
read is the unauthenticated one the compose healthcheck already makes.

Env (all optional except the URL; defaults in parentheses):
  MCPO_GUARD_URL       the proxy's openapi.json, e.g. http://127.0.0.1:8000/open-brain/openapi.json
                       (unset: the guard only forwards signals and mirrors the child's exit)
  MCPO_GUARD_GRACE     seconds before the first read (90)
  MCPO_GUARD_INTERVAL  seconds between reads (15)
  MCPO_GUARD_MISSES    consecutive empty reads that end the process (3)
  MCPO_BIN             the command to run (mcpo); a test stand-in overrides it
"""
import json
import os
import shlex
import signal
import subprocess
import sys
import time
import urllib.request


def _int(name, default):
    try:
        v = int(os.environ.get(name, default))
        return v if v > 0 else default
    except (TypeError, ValueError):
        return default


def tool_count(url, timeout=5):
    """Number of paths in the openapi document at `url`, or -1 if it cannot be read."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            doc = json.load(r)
        paths = doc.get("paths") if isinstance(doc, dict) else None
        return len(paths) if isinstance(paths, dict) else 0
    except Exception:  # noqa: BLE001 - unreachable / malformed is "no tools" to the guard
        return -1


def main(argv):
    url = os.environ.get("MCPO_GUARD_URL", "")
    grace = _int("MCPO_GUARD_GRACE", 90)
    interval = _int("MCPO_GUARD_INTERVAL", 15)
    misses_max = _int("MCPO_GUARD_MISSES", 3)
    cmd = shlex.split(os.environ.get("MCPO_BIN", "mcpo")) + list(argv)

    child = subprocess.Popen(cmd)

    def forward(signum, _frame):
        try:
            child.send_signal(signum)
        except Exception:  # noqa: BLE001
            pass

    for s in (signal.SIGTERM, signal.SIGINT):
        signal.signal(s, forward)

    started = time.monotonic()
    next_read = started + grace
    misses = 0
    while True:
        code = child.poll()
        if code is not None:
            return code
        now = time.monotonic()
        if url and now >= next_read:
            n = tool_count(url)
            if n > 0:
                misses = 0
            else:
                misses += 1
                print("mcpo-guard: %s serves %s tools (%d/%d)"
                      % (url, "no" if n == 0 else "unreadable", misses, misses_max), flush=True)
                if misses >= misses_max:
                    print("mcpo-guard: exiting 1 so compose restarts the proxy and it reloads its tools",
                          flush=True)
                    child.terminate()
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                    return 1
            next_read = now + interval
        time.sleep(0.5)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
