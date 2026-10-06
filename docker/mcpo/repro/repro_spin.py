#!/usr/bin/env python3
"""Disposable rig: does an mcpo image busy-spin after an upstream fault?

Why: openbrain-mcpo / openbrain-mcpo-ext (mcpo v0.0.20, anyio 4.12.1) have
pinned a core at 100% after upstream trouble (open-webui/mcpo#302). The spin is
anyio's CancelScope._deliver_cancellation rescheduling itself for a task that
is already done (agronholm/anyio#1111, fixed in 4.14.x). ../Dockerfile
upgrades anyio over the pinned mcpo digest. This rig is the evidence, and the
check to rerun before dropping that layer when mcpo itself ships anyio>=4.14.

Everything runs in disposable containers named t-ef-mcpo-anyio-* on ONE
`--internal` network of the same name (no egress, never an ai-stack_* network),
labelled ai-stack.harness.owner=<owner>. Nothing live is touched. CPU is read
from the mcpo container's OWN cgroup counter (/sys/fs/cgroup/cpu.stat
usage_usec, cgroup v2) at the start and end of each interval, never from a
`docker stats` snapshot.

Verbs (python3 on the host, docker CLI on PATH):

  spin       --image REF --trigger {startup-closed,kill,502} [--window S]
             Build the rig, trip it, measure mcpo CPU over --window seconds in
             --interval steps, then bring the upstream back and check that
             mcpo serves a tool call again, and measure --post-window more
             seconds (does the spin outlive the recovery?). Prints a JSON verdict line:
             SPIN (mean >= 80% of one core), IDLE (mean < 5%) or BETWEEN.
  parity     --stock REF --derived REF
             Same stand-in upstream, same config: compare the openapi.json
             documents and the tool-call results of the two images.
  resolution --stock REF --derived REF
             Installed distributions of each image (offline), and the diff.
  cleanup    Remove every t-ef-mcpo-anyio-* container and the network.

Each verb cleans up after itself unless --keep is given. Exit code: 0 when the
verb ran (the verdict is in the output, not the exit code), 2 on a rig error,
except parity, which exits 1 when the two images differ.
"""

import argparse
import json
import os
import subprocess
import sys
import time

PREFIX = "t-ef-mcpo-anyio"
NET = PREFIX + "-net"
UP = PREFIX + "-up"
PROXY = PREFIX + "-proxy"
MCPO = PREFIX + "-mcpo"
KEY = "rig-not-a-secret"
HERE = os.path.dirname(os.path.abspath(__file__))
STOCK = "ghcr.io/open-webui/mcpo@sha256:1e82c9555c19e50b80745705f32b47a2647589f35279527b5118ecd3a71bd467"

# Git Bash on Windows rewrites /sys/... arguments into C:/Program Files/Git/...;
# this is a no-op elsewhere.
ENV = dict(os.environ, MSYS_NO_PATHCONV="1", MSYS2_ARG_CONV_EXCL="*")


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def docker(*args, check=True, timeout=120):
    r = subprocess.run(["docker", *args], capture_output=True, text=True, encoding="utf-8", errors="replace", env=ENV, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"docker {' '.join(args[:3])} ... failed ({r.returncode}): {r.stderr.strip()[:400]}")
    return r


def owner():
    return os.environ.get("RIG_OWNER", "wt-ef-mcpo-anyio")


def labels():
    return ["--label", f"ai-stack.harness.owner={owner()}", "--label", "ai-stack.rig=ef-mcpo-anyio"]


def cleanup(quiet=False):
    names = docker("ps", "-aq", "--filter", f"name=^{PREFIX}-", check=False).stdout.split()
    if names:
        docker("rm", "-f", *names, check=False)
    docker("network", "rm", NET, check=False)
    if not quiet:
        log(f"cleanup: removed {len(names)} container(s) and network {NET} (if present)")


def ensure_net():
    if docker("network", "inspect", NET, check=False).returncode != 0:
        docker("network", "create", "--internal", *labels(), NET)
    internal = docker("network", "inspect", NET, "--format", "{{.Internal}}").stdout.strip()
    if internal != "true":
        raise RuntimeError(f"{NET} is not --internal; refusing")


def create_py(name, image, script, alias, env=None):
    """Create (not start) a python container running one of the rig scripts."""
    args = ["create", "--name", name, "--network", NET, "--network-alias", alias, *labels(),
            "--memory", "256m", "--cpus", "1", "--entrypoint", "python"]
    for k, v in (env or {}).items():
        args += ["-e", f"{k}={v}"]
    args += [image, "-u", f"/tmp/{script}"]
    docker(*args)
    docker("cp", os.path.join(HERE, script), f"{name}:/tmp/{script}")


def create_mcpo(image, target_url):
    cfg = {"mcpServers": {"stand-in": {"type": "streamable-http", "url": target_url}}}
    path = os.path.join(HERE, ".rig-mcpo.config.json")
    with open(path, "w") as f:
        json.dump(cfg, f)
    # --cpus 1: a spin pins exactly one core (asyncio is single-threaded), and
    # the cap keeps the rig from ever loading the host more than that.
    docker("create", "--name", MCPO, "--network", NET, *labels(), "--memory", "512m", "--cpus", "1",
           image, "--config", "/tmp/mcpo.config.json", "--host", "0.0.0.0", "--port", "8000",
           "--api-key", KEY)
    docker("cp", path, f"{MCPO}:/tmp/mcpo.config.json")
    os.remove(path)


def mcpo_http(method, path, body=None, timeout=15):
    """HTTP call to mcpo from inside its own (disposable) container."""
    code = (
        "import json,sys,urllib.request,urllib.error\n"
        f"req=urllib.request.Request('http://127.0.0.1:8000{path}',method='{method}',"
        f"headers={{'Authorization':'Bearer {KEY}','Content-Type':'application/json'}},"
        f"data={json.dumps(json.dumps(body)) if body is not None else None}"
        f"{'.encode()' if body is not None else ''})\n"
        "try:\n"
        f"  r=urllib.request.urlopen(req,timeout={timeout}); print(r.status); sys.stdout.write(r.read().decode())\n"
        "except urllib.error.HTTPError as e:\n"
        "  print(e.code); sys.stdout.write(e.read().decode()[:2000])\n"
        "except Exception as e:\n"
        "  print(0); sys.stdout.write(type(e).__name__+': '+str(e))\n"
    )
    r = docker("exec", MCPO, "python", "-c", code, check=False, timeout=timeout + 20)
    out = r.stdout
    first, _, rest = out.partition("\n")
    try:
        return int(first.strip()), rest
    except ValueError:
        return 0, (out + r.stderr)[:500]


def proxy_ctl(path, method="POST"):
    code = (
        "import urllib.request,sys\n"
        f"r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8000{path}',method='{method}'),timeout=5)\n"
        "sys.stdout.write(r.read().decode())\n"
    )
    return docker("exec", PROXY, "python", "-c", code).stdout


def wait_for(fn, what, timeout=60, step=1.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    raise RuntimeError(f"timed out after {timeout}s waiting for {what}")


def cpu_usec(name):
    r = docker("exec", name, "cat", "/sys/fs/cgroup/cpu.stat", check=False, timeout=30)
    for line in r.stdout.splitlines():
        if line.startswith("usage_usec"):
            return int(line.split()[1])
    r = docker("exec", name, "cat", "/sys/fs/cgroup/cpuacct/cpuacct.usage", check=False, timeout=30)
    if r.returncode == 0 and r.stdout.strip().isdigit():
        return int(r.stdout.strip()) // 1000
    raise RuntimeError(f"no cgroup cpu counter readable in {name}")


def measure(window, interval, names):
    """Per-interval and mean CPU (% of one core) for each container, from its cgroup counter."""
    t0 = time.time()
    base = {n: cpu_usec(n) for n in names}
    first = dict(base)
    t_prev = t0
    series = {n: [] for n in names}
    while time.time() - t0 < window:
        time.sleep(min(interval, max(0.0, window - (time.time() - t0))))
        now = time.time()
        cur = {n: cpu_usec(n) for n in names}
        for n in names:
            series[n].append(round(100.0 * (cur[n] - base[n]) / ((now - t_prev) * 1e6), 1))
        log("cpu %: " + "  ".join(f"{n.replace(PREFIX + '-', '')}={series[n][-1]}" for n in names))
        base, t_prev = cur, now
    wall = time.time() - t0
    mean = {n: round(100.0 * (base[n] - first[n]) / (wall * 1e6), 2) for n in names}
    return {"wall_s": round(wall, 1), "interval_s": interval, "mean_pct": mean, "series_pct": series}


def tool_ok():
    code, body = mcpo_http("POST", "/stand-in/echo", {"text": "ping"})
    return code == 200 and "ping" in body, code, body[:300]


def image_facts(image):
    r = docker("run", "--rm", "--network", "none", *labels(), "--entrypoint", "python", image, "-c",
               "import anyio,importlib.metadata as m;print(m.version('anyio'),m.version('mcpo'),m.version('mcp'))")
    anyio_v, mcpo_v, mcp_v = r.stdout.split()
    return {"image": image, "anyio": anyio_v, "mcpo": mcpo_v, "mcp": mcp_v}


def verb_spin(a):
    facts = image_facts(a.image)
    log(f"image {a.image}: anyio {facts['anyio']}, mcpo {facts['mcpo']}, mcp {facts['mcp']}")
    cleanup(quiet=True)
    ensure_net()
    # The stand-in and the proxy always run on the STOCK base, so both runs
    # of the rig share the same upstream and only mcpo differs.
    create_py(UP, a.upstream_image, "stand_in_mcp.py", "upstream")
    via_proxy = a.trigger == "502"
    if via_proxy:
        create_py(PROXY, a.upstream_image, "flaky_proxy.py", "proxy", env={"UPSTREAM": "http://upstream:8000"})
    target = "http://proxy:8000/mcp" if via_proxy else "http://upstream:8000/mcp"
    create_mcpo(a.image, target)
    result = {"verb": "spin", "trigger": a.trigger, **facts}
    try:
        if a.trigger == "startup-closed":
            # mcpo#302 comment (2026-09-11): the backend's port is closed when
            # mcpo starts. The upstream container exists but is not started.
            docker("start", MCPO)
            wait_for(lambda: mcpo_http("GET", "/openapi.json")[0] == 200, "mcpo /openapi.json", 60)
            log("mcpo up with its upstream down; settling 20 s")
            time.sleep(20)
        else:
            docker("start", UP)
            if via_proxy:
                docker("start", PROXY)
            docker("start", MCPO)
            wait_for(lambda: tool_ok()[0], "a first tool call through mcpo", 90, 2)
            log("baseline: tool call OK through mcpo; measuring a 30 s pre-trigger baseline")
            result["baseline"] = measure(30, 30, [MCPO])
            if a.trigger == "kill":
                # Ungraceful upstream death, then traffic that hits the dead session.
                docker("kill", "-s", "KILL", UP)
                log("upstream SIGKILLed; sending 3 tool calls into the dead session")
            else:
                log("proxy armed: next 3 requests answer 502, open streams cut")
                proxy_ctl("/__ctl/fail?n=3")
            for _ in range(3):
                ok, code, body = tool_ok()
                log(f"  tool call -> {code} {body[:120]!r}")
                time.sleep(2)
            time.sleep(10)
        log(f"measuring mcpo CPU for {a.window} s")
        result["after_trigger"] = measure(a.window, a.interval, [MCPO])
        mean = result["after_trigger"]["mean_pct"][MCPO]
        result["verdict"] = "SPIN" if mean >= 80 else ("IDLE" if mean < 5 else "BETWEEN")
        log(f"verdict: {result['verdict']} (mean {mean}% of one core over {result['after_trigger']['wall_s']} s)")

        # Recovery: bring the upstream back and see if mcpo serves tools again.
        if a.trigger == "502":
            proxy_ctl("/__ctl/ok")
        else:
            docker("start", UP)
        time.sleep(5)
        tries = []
        recovered = False
        for _ in range(a.recover_tries):
            ok, code, body = tool_ok()
            tries.append({"code": code, "body": body[:160]})
            if ok:
                recovered = True
                break
            time.sleep(3)
        result["recovery"] = {"recovered": recovered, "attempts": tries}
        log(f"recovery after upstream returned: {'OK' if recovered else 'NO'} after {len(tries)} attempt(s)")
        if a.post_window > 0:
            # Does the spin outlive the recovery? (stock: yes - mcpo serves
            # again while the orphaned cancel-delivery loop keeps burning.)
            log(f"measuring mcpo CPU for {a.post_window} s after the upstream returned")
            result["after_recovery"] = measure(a.post_window, a.interval, [MCPO])
        logs = docker("logs", "--tail", "400", MCPO, check=False)
        text = logs.stdout + logs.stderr
        result["log_markers"] = {
            "cancel_scope_runtimeerror": text.count("Attempted to exit cancel scope in a different task"),
            "lines": len(text.splitlines()),
        }
        if a.save_logs:
            try:
                with open(a.save_logs, "w", encoding="utf-8") as f:
                    f.write(text)
            except OSError as e:
                log(f"could not save mcpo logs to {a.save_logs}: {e}")
    finally:
        if not a.keep:
            cleanup(quiet=True)
            log("rig removed")
    print("RESULT " + json.dumps(result))
    return 0


def run_parity_once(image):
    cleanup(quiet=True)
    ensure_net()
    create_py(UP, STOCK, "stand_in_mcp.py", "upstream")
    create_mcpo(image, "http://upstream:8000/mcp")
    docker("start", UP)
    docker("start", MCPO)
    wait_for(lambda: tool_ok()[0], "a first tool call", 90, 2)
    out = {}
    for name, (method, path, body) in {
        "openapi_root": ("GET", "/openapi.json", None),
        "openapi_stand_in": ("GET", "/stand-in/openapi.json", None),
        "echo": ("POST", "/stand-in/echo", {"text": "parity \u00e9 \U0001f600"}),
        "add": ("POST", "/stand-in/add", {"a": 40, "b": 2}),
        "add_bad_type": ("POST", "/stand-in/add", {"a": "x", "b": 2}),
        "unknown_tool": ("POST", "/stand-in/nope", {}),
        "no_auth_docs": ("GET", "/stand-in/docs", None),
    }.items():
        code, text = mcpo_http(method, path, body)
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = text
        out[name] = {"status": code, "body": parsed}
    cleanup(quiet=True)
    return out


def verb_parity(a):
    s = run_parity_once(a.stock)
    d = run_parity_once(a.derived)
    diffs = [k for k in s if json.dumps(s[k], sort_keys=True) != json.dumps(d[k], sort_keys=True)]
    for k in s:
        log(f"{k:18} stock={s[k]['status']} derived={d[k]['status']} {'SAME' if k not in diffs else 'DIFFERENT'}")
    print("RESULT " + json.dumps({"verb": "parity", "identical": not diffs, "differing": diffs,
                                  "stock": s if diffs else None, "derived": d if diffs else None,
                                  "sample": {"echo": s["echo"], "add": s["add"]}}))
    return 0 if not diffs else 1


def dists(image):
    r = docker("run", "--rm", "--network", "none", *labels(), "--entrypoint", "python", image, "-c",
               "import importlib.metadata as m,json;"
               "print(json.dumps(sorted([d.metadata['Name'].lower(),d.version] for d in m.distributions())))")
    return dict(json.loads(r.stdout))


def verb_resolution(a):
    s, d = dists(a.stock), dists(a.derived)
    changed = {k: [s.get(k), d.get(k)] for k in sorted(set(s) | set(d)) if s.get(k) != d.get(k)}
    for k, (old, new) in changed.items():
        log(f"{k}: {old} -> {new}")
    check = docker("run", "--rm", "--network", "none", *labels(), "--entrypoint", "uv", a.derived,
                   "pip", "check", "--python", "/app/.venv/bin/python", check=False)
    print("RESULT " + json.dumps({"verb": "resolution", "stock_count": len(s), "derived_count": len(d),
                                  "changed": changed, "uv_pip_check_rc": check.returncode,
                                  "uv_pip_check": (check.stdout + check.stderr).strip()[-300:]}))
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="verb", required=True)
    sp = sub.add_parser("spin")
    sp.add_argument("--image", required=True)
    sp.add_argument("--trigger", choices=["startup-closed", "kill", "502"], required=True)
    sp.add_argument("--window", type=int, default=180)
    sp.add_argument("--interval", type=int, default=30)
    sp.add_argument("--recover-tries", type=int, default=10)
    sp.add_argument("--post-window", type=int, default=60)
    sp.add_argument("--upstream-image", default=STOCK)
    sp.add_argument("--save-logs")
    sp.add_argument("--keep", action="store_true")
    pp = sub.add_parser("parity")
    pp.add_argument("--stock", default=STOCK)
    pp.add_argument("--derived", required=True)
    rp = sub.add_parser("resolution")
    rp.add_argument("--stock", default=STOCK)
    rp.add_argument("--derived", required=True)
    sub.add_parser("cleanup")
    a = p.parse_args()
    try:
        if a.verb == "spin":
            return verb_spin(a)
        if a.verb == "parity":
            return verb_parity(a)
        if a.verb == "resolution":
            return verb_resolution(a)
        cleanup()
        return 0
    except (RuntimeError, subprocess.TimeoutExpired) as e:
        log(f"RIG ERROR: {e}")
        cleanup(quiet=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
