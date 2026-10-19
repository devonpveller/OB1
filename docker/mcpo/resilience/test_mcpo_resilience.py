"""mcpo-resilience: pins every rule of the fix (compose render, guard, healthcheck, ordering).

Run from anywhere:   python OB1/docker/mcpo/resilience/test_mcpo_resilience.py
Base for RED / byte-identity (a git ref in OB1, usually the pin the branch was cut from):
                     OB1_BASE_REF=daa9094 python .../test_mcpo_resilience.py
                     (unset: the RED and byte-identity tests SKIP, the rest run)
Docker-backed tests need a Docker daemon and the local images python:3.12-slim and
denoland/deno:2.3.3; without a daemon they SKIP. Set MCPO_RESILIENCE_NO_DOCKER=1 to force it.

What touches Docker, and how it is fenced:
  * `docker compose config` only RENDERS (no container);
  * the healthcheck RED/GREEN runs two python:3.12-slim containers with --network none;
  * the throwaway compose uses ONE internal network on 10.231.77.0/24 (outside
    192.168.0.0/16, and not an ai-stack_* network), project `wt-mcpo-resilience-t`, no
    container_name (so nothing can collide with a live container), and stand-in
    images/stubs only. Every object carries ai-stack.harness.owner=wt-mcpo-resilience.
  * nothing here names, restarts or inspects a live container.

The throwaway compose is GENERATED FROM THE REAL RENDER: the entrypoint, command,
environment, depends_on, healthcheck command and restart policy of the three services
are copied from `docker compose config`, so the test breaks if the real file regresses.
Only the images, volumes, networks and timings (shortened) are the test's own.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
GUARD = HERE.parent / "mcpo-guard.py"
DOCKER_DIR = HERE.parent.parent  # OB1/docker
OB1_DIR = DOCKER_DIR.parent
OWNER = "wt-mcpo-resilience"
PROJECT = "wt-mcpo-resilience-t"
SUBNET = "10.231.77.0/24"
PROFILES = ["idea-refinery", "research", "wiki", "notebook", "pantry", "intake"]
PROXIES = {"openbrain-mcpo": "open-brain", "openbrain-mcpo-ext": "open-brain-extensions"}
BASE_REF = os.environ.get("OB1_BASE_REF", "")


def run(args, cwd=None, timeout=120, check=False, env=None):
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env)
    if check and p.returncode != 0:
        raise RuntimeError("%s -> %d\n%s\n%s" % (args[:4], p.returncode, p.stdout[-500:], p.stderr[-800:]))
    return p


def docker_ok():
    if os.environ.get("MCPO_RESILIENCE_NO_DOCKER"):
        return False
    try:
        return run(["docker", "version", "--format", "{{.Server.Version}}"], timeout=20).returncode == 0
    except Exception:  # noqa: BLE001
        return False


def have_images():
    for img in ("python:3.12-slim", "denoland/deno:2.3.3"):
        if run(["docker", "image", "inspect", img], timeout=20).returncode != 0:
            return False
    return True


def render(compose_file):
    """`docker compose config` of a compose file in OB1/docker, all profiles, dummy env."""
    with tempfile.TemporaryDirectory() as t:
        envf = Path(t) / ".env"
        envf.write_text("OPS_GATEWAY_KEY=x\nMCPO_API_KEY=testkey\nMCP_ACCESS_KEY=testkey\n")
        cmd = ["docker", "compose", "-f", str(compose_file), "--env-file", str(envf)]
        for p in PROFILES:
            cmd += ["--profile", p]
        cmd += ["config", "--format", "json"]
        p = run(cmd, cwd=str(DOCKER_DIR), timeout=120)
        if p.returncode != 0:
            raise RuntimeError("render failed: " + p.stderr[-600:])
        return json.loads(p.stdout)


def base_render():
    """Render the compose file at OB1_BASE_REF (written next to the real one so its include resolves)."""
    src = run(["git", "-C", str(OB1_DIR), "show", "%s:docker/docker-compose.yml" % BASE_REF], check=True).stdout
    tmp = DOCKER_DIR / "docker-compose.base-render.tmp.yml"
    try:
        tmp.write_text(src, encoding="utf-8", newline="\n")
        return render(tmp)
    finally:
        tmp.unlink(missing_ok=True)


_HEAD = None


def head():
    global _HEAD
    if _HEAD is None:
        _HEAD = render(DOCKER_DIR / "docker-compose.yml")
    return _HEAD


def dur_s(v):
    """Seconds in a compose duration: 90s, 1m30s, 500ms, or a bare number."""
    import re
    total = 0.0
    for num, unit in re.findall(r"([0-9.]+)(ms|s|m|h)?", str(v)):
        total += float(num) * {"ms": 0.001, "s": 1, "m": 60, "h": 3600, "": 1}[unit]
    return total


# ----------------------------------------------------------------------------------------------
class RenderRules(unittest.TestCase):
    """Rule (1), (2), (5): what the compose file says. Needs only `docker compose config`."""

    @classmethod
    def setUpClass(cls):
        if not docker_ok():
            raise unittest.SkipTest("no docker CLI/daemon for `compose config`")
        cls.r = head()["services"]

    def test_both_proxies_wait_for_openbrain_mcp_healthy(self):
        for name in PROXIES:
            dep = self.r[name]["depends_on"]
            self.assertIn("openbrain-mcp", dep, name)
            self.assertEqual(dep["openbrain-mcp"]["condition"], "service_healthy", name)
            self.assertTrue(dep["openbrain-mcp"].get("required", True), name)

    def test_openbrain_mcp_has_a_healthcheck_that_proves_it_answers(self):
        hc = self.r["openbrain-mcp"]["healthcheck"]
        text = " ".join(hc["test"])
        self.assertEqual(hc["test"][:3], ["CMD", "deno", "eval"])
        # an MCP initialize carrying the container's own key: not a bare GET, no key in the file
        self.assertIn("initialize", text)
        self.assertIn("x-brain-key", text)
        self.assertIn("Deno.env.get('MCP_ACCESS_KEY')", text)
        self.assertIn("r.ok", text)
        self.assertNotIn("testkey", text)

    def test_each_proxy_healthcheck_fails_on_zero_paths(self):
        for name, srv in PROXIES.items():
            hc = self.r[name]["healthcheck"]
            self.assertEqual(hc["test"][:3], ["CMD", "python", "-c"], name)
            code = hc["test"][3]
            self.assertIn("/%s/openapi.json" % srv, code, name)
            self.assertIn("json.load", code, name)
            self.assertIn("paths", code, name)
            self.assertIn("sys.exit(0 if d.get('paths') else 1)", code, name)
            self.assertGreaterEqual(dur_s(hc["start_period"]), 60, name + ": start_period must cover a real tool load")

    def test_restart_policy_and_the_guard_that_makes_it_fire(self):
        for name, srv in PROXIES.items():
            s = self.r[name]
            self.assertEqual(s["restart"], "unless-stopped", name)
            self.assertEqual(s["entrypoint"], ["python", "/guard/mcpo-guard.py"], name)
            self.assertEqual(s["environment"]["MCPO_GUARD_URL"], "http://127.0.0.1:8000/%s/openapi.json" % srv, name)
            vols = [v for v in s["volumes"] if v.get("target") == "/guard/mcpo-guard.py"]
            self.assertEqual(len(vols), 1, name)
            self.assertTrue(vols[0].get("read_only"), name)
            # mcpo's own arguments are the unchanged command (the guard passes them through)
            self.assertEqual(s["command"][:2], ["--config", "/config/%s" % ("mcpo.config.json" if name == "openbrain-mcpo" else "mcpo-ext.config.json")])
        self.assertTrue(GUARD.is_file())


class OtherServicesUnchanged(unittest.TestCase):
    """Acceptance: renders of every other OB1 service are byte-identical to the base."""

    @classmethod
    def setUpClass(cls):
        if not BASE_REF:
            raise unittest.SkipTest("OB1_BASE_REF unset")
        if not docker_ok():
            raise unittest.SkipTest("no docker CLI")

    def test_every_other_service_render_is_identical(self):
        b, h = base_render()["services"], head()["services"]
        touched = {"openbrain-mcp", "openbrain-mcpo", "openbrain-mcpo-ext"}
        self.assertEqual(sorted(b), sorted(h), "the service set must not change")
        diffs = [n for n in b if n not in touched and json.dumps(b[n], sort_keys=True) != json.dumps(h[n], sort_keys=True)]
        self.assertEqual(diffs, [])
        self.assertEqual(json.dumps(base_render()["networks"], sort_keys=True), json.dumps(h_nets(), sort_keys=True))

    def test_openbrain_mcp_changes_only_by_its_healthcheck(self):
        b, h = base_render()["services"]["openbrain-mcp"], head()["services"]["openbrain-mcp"]
        h = dict(h)
        self.assertIn("healthcheck", h)
        h.pop("healthcheck")
        self.assertEqual(json.dumps(b, sort_keys=True), json.dumps(h, sort_keys=True))


def h_nets():
    return head()["networks"]


# ----------------------------------------------------------------------------------------------
class _Stub(BaseHTTPRequestHandler):
    paths = 0

    def do_GET(self):
        body = json.dumps({"paths": {"/t%d" % i: {} for i in range(type(self).paths)}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class GuardUnit(unittest.TestCase):
    """mcpo-guard.py with a local stub server and a sleeping child (no Docker)."""

    def serve(self, paths):
        h = type("H", (_Stub,), {"paths": paths})
        srv = ThreadingHTTPServer(("127.0.0.1", 0), h)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        return "http://127.0.0.1:%d/x/openapi.json" % srv.server_address[1]

    def guard(self, url, child, **env):
        e = dict(os.environ, MCPO_GUARD_URL=url, MCPO_GUARD_GRACE="1", MCPO_GUARD_INTERVAL="1",
                 MCPO_GUARD_MISSES="2", MCPO_BIN=child, **env)
        return subprocess.Popen([sys.executable, str(GUARD)], env=e, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    SLEEP = '%s -c "import time; time.sleep(60)"' % ('"%s"' % sys.executable)

    def test_empty_openapi_makes_the_guard_exit_1_and_stop_the_child(self):
        p = self.guard(self.serve(0), self.SLEEP)
        out, _ = p.communicate(timeout=30)
        self.assertEqual(p.returncode, 1, out)
        self.assertIn("serves no tools (2/2)", out)

    def test_unreachable_counts_as_empty(self):
        p = self.guard("http://127.0.0.1:1/x/openapi.json", self.SLEEP)
        out, _ = p.communicate(timeout=30)
        self.assertEqual(p.returncode, 1, out)
        self.assertIn("unreadable", out)

    def test_paths_keep_it_running_and_the_child_exit_code_is_mirrored(self):
        url = self.serve(3)
        p = self.guard(url, '"%s" -c "import time,sys; time.sleep(5); sys.exit(7)"' % sys.executable)
        out, _ = p.communicate(timeout=30)
        self.assertEqual(p.returncode, 7, out)
        self.assertNotIn("serves no tools", out)

    def test_no_url_means_no_guard_only_passthrough(self):
        p = self.guard("", '"%s" -c "import sys; sys.exit(3)"' % sys.executable)
        out, _ = p.communicate(timeout=30)
        self.assertEqual(p.returncode, 3, out)

    def test_arguments_are_passed_to_the_child_verbatim(self):
        e = dict(os.environ, MCPO_GUARD_URL="", MCPO_BIN='"%s" -c "import sys; print(sys.argv[1:]); sys.exit(0)"' % sys.executable)
        p = subprocess.run([sys.executable, str(GUARD), "--config", "/c.json", "--port", "8000"], env=e, capture_output=True, text=True, timeout=30)
        self.assertIn("['--config', '/c.json', '--port', '8000']", p.stdout)


# ----------------------------------------------------------------------------------------------
def _lbl():
    return {"ai-stack.harness.owner": OWNER}


class HealthcheckRedGreen(unittest.TestCase):
    """RED: the BASE healthcheck passes a proxy serving 0 paths. GREEN: the new one fails it and
    passes one with paths. Real healthcheck argv, run inside a python container (no network)."""

    @classmethod
    def setUpClass(cls):
        if not (docker_ok() and have_images()):
            raise unittest.SkipTest("needs docker + python:3.12-slim")
        cls.cids = []
        for n in (0, 3):
            p = run(["docker", "run", "-d", "--rm", "--network", "none", "--label", "ai-stack.harness.owner=" + OWNER,
                     "-e", "PATHS=%d" % n, "-v", "%s:/stub:ro" % HERE, "python:3.12-slim", "python", "/stub/stub_openapi.py"],
                    check=True)
            cls.cids.append(p.stdout.strip())
        deadline = time.time() + 30
        for cid in cls.cids:
            while time.time() < deadline:
                if run(["docker", "exec", cid, "python", "-c", "import socket; socket.create_connection(('127.0.0.1', 8000), 2)"]).returncode == 0:
                    break
                time.sleep(0.5)

    @classmethod
    def tearDownClass(cls):
        for cid in getattr(cls, "cids", []):
            run(["docker", "rm", "-f", cid])

    def probe(self, cid, compose_render, name):
        argv = compose_render["services"][name]["healthcheck"]["test"][1:]
        return run(["docker", "exec", cid] + argv, timeout=60).returncode

    def test_base_is_red_empty_openapi_reads_healthy(self):
        if not BASE_REF:
            self.skipTest("OB1_BASE_REF unset")
        b = base_render()
        for name in PROXIES:
            self.assertEqual(self.probe(self.cids[0], b, name), 0, name + ": the base probe should (wrongly) PASS on 0 paths")
            self.assertEqual(self.probe(self.cids[1], b, name), 0, name)

    def test_new_fails_zero_paths_and_passes_with_paths(self):
        for name in PROXIES:
            self.assertNotEqual(self.probe(self.cids[0], head(), name), 0, name + ": 0 paths must FAIL")
            self.assertEqual(self.probe(self.cids[1], head(), name), 0, name + ": paths must PASS")


class RealServerImage(unittest.TestCase):
    """The openbrain-mcp healthcheck against the REAL server image (run only, never rebuilt),
    --network none, dummy DB: it must pass with the container's key and fail with a wrong one."""

    IMAGE = os.environ.get("OB1_MCP_IMAGE", "openbrain-mcp-server:local")

    @classmethod
    def setUpClass(cls):
        if not docker_ok() or run(["docker", "image", "inspect", cls.IMAGE]).returncode != 0:
            raise unittest.SkipTest("no docker or no %s image" % cls.IMAGE)
        p = run(["docker", "run", "-d", "--rm", "--network", "none", "--label", "ai-stack.harness.owner=" + OWNER,
                 "-e", "MCP_ACCESS_KEY=testkey", "-e", "DB_HOST=nowhere", "-e", "DB_PASSWORD=x", "-e", "PORT=8000", cls.IMAGE],
                check=True)
        cls.cid = p.stdout.strip()
        end = time.time() + 40
        argv = head()["services"]["openbrain-mcp"]["healthcheck"]["test"][1:]
        cls.argv = argv
        while time.time() < end:
            if run(["docker", "exec", cls.cid] + argv).returncode == 0:
                return
            time.sleep(1)

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "cid"):
            run(["docker", "rm", "-f", cls.cid])

    def test_passes_with_the_key_fails_with_a_wrong_one(self):
        self.assertEqual(run(["docker", "exec", self.cid] + self.argv).returncode, 0)
        self.assertNotEqual(run(["docker", "exec", "-e", "MCP_ACCESS_KEY=wrong", self.cid] + self.argv).returncode, 0)


# ----------------------------------------------------------------------------------------------
class ThrowawayCompose(unittest.TestCase):
    """Real ordering + self-heal on stand-in images. See the module docstring for the fence."""

    @classmethod
    def setUpClass(cls):
        if not (docker_ok() and have_images()):
            raise unittest.SkipTest("needs docker + python:3.12-slim + denoland/deno:2.3.3")
        cls.tmp = Path(tempfile.mkdtemp(prefix="mcpo-res-"))
        cls.cfg = cls.tmp / "cfg"
        cls.cfg.mkdir()
        for fn, srv, url in (("mcpo.config.json", "open-brain", "http://openbrain-mcp:8000/"),
                             ("mcpo-ext.config.json", "open-brain-extensions", "http://openbrain-ext:8000/")):
            (cls.cfg / fn).write_text(json.dumps({"mcpServers": {srv: {"type": "streamable-http", "url": url,
                                                                        "headers": {"x-brain-key": "testkey"}}}}))

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "tmp"):
            cls.compose("down", "-v", "--remove-orphans", "-t", "2", timeout=120)
            shutil.rmtree(cls.tmp, ignore_errors=True)

    # -- the generated compose --
    @classmethod
    def build_compose(cls, mcp_delay_ms):
        r = head()["services"]
        fast = {"interval": "2s", "timeout": "5s", "retries": 3, "start_period": "3s"}
        lab = _lbl()

        def stub_upstream(delay):
            return {"image": "denoland/deno:2.3.3", "labels": lab, "networks": ["t"], "restart": "unless-stopped",
                    "command": ["deno", "run", "--allow-net", "--allow-env", "/stub/mcp_stub.ts"],
                    "environment": {"MCP_ACCESS_KEY": "testkey", "START_DELAY_MS": str(delay)},
                    "volumes": ["%s:/stub:ro" % HERE]}

        mcp = stub_upstream(mcp_delay_ms)
        # the REAL probe command; start_period stays long so the delayed listener is "starting", not unhealthy
        mcp["healthcheck"] = dict(r["openbrain-mcp"]["healthcheck"], **dict(fast, start_period="30s"))
        ext = stub_upstream(0)
        out = {"name": PROJECT, "services": {"openbrain-mcp": mcp, "openbrain-ext": ext},
               "networks": {"t": {"internal": True, "labels": lab, "ipam": {"config": [{"subnet": SUBNET}]}}}}
        for name, cfgname in (("openbrain-mcpo", "mcpo.config.json"), ("openbrain-mcpo-ext", "mcpo-ext.config.json")):
            s = r[name]
            env = dict(s["environment"], MCPO_GUARD_GRACE="4", MCPO_GUARD_INTERVAL="2", MCPO_GUARD_MISSES="2",
                       MCPO_BIN="python /stub/stub_mcpo.py")
            out["services"][name] = {
                "image": "python:3.12-slim", "labels": lab, "networks": ["t"],
                "entrypoint": s["entrypoint"], "command": s["command"], "environment": env,
                "depends_on": {k: {"condition": v["condition"]} for k, v in s["depends_on"].items()},
                "healthcheck": dict(s["healthcheck"], **fast), "restart": s["restart"],
                "volumes": ["%s:/guard/mcpo-guard.py:ro" % GUARD, "%s:/stub:ro" % HERE,
                            "%s:/config/%s:ro" % (cls.cfg / cfgname, cfgname)],
            }
        (cls.tmp / "compose.json").write_text(json.dumps(out))

    @classmethod
    def compose(cls, *args, timeout=180):
        return run(["docker", "compose", "-p", PROJECT, "-f", str(cls.tmp / "compose.json")] + list(args), timeout=timeout)

    @classmethod
    def cid(cls, svc):
        return cls.compose("ps", "-aq", svc).stdout.strip().splitlines()[:1] or [""]

    @classmethod
    def inspect(cls, svc):
        c = cls.cid(svc)[0]
        if not c:
            return None
        p = run(["docker", "inspect", c, "--format",
                 "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.RestartCount}}"])
        if p.returncode != 0:
            return None
        st, hl, rc = p.stdout.strip().split("|")
        return {"state": st, "health": hl, "restarts": int(rc)}

    @classmethod
    def tools(cls, svc, srv):
        c = cls.cid(svc)[0]
        if not c:
            return -1
        p = run(["docker", "exec", c, "python", "-c",
                 "import json,urllib.request; print(len(json.load(urllib.request.urlopen('http://localhost:8000/%s/openapi.json'))['paths']))" % srv])
        return int(p.stdout.strip()) if p.returncode == 0 and p.stdout.strip().isdigit() else -1

    @classmethod
    def wait(cls, pred, seconds, every=0.5):
        end = time.time() + seconds
        while time.time() < end:
            if pred():
                return True
            time.sleep(every)
        return False

    def setUp(self):
        self.compose("down", "-v", "--remove-orphans", "-t", "2", timeout=120)

    # -- scenarios --
    def test_1_mcpo_waits_for_openbrain_mcp_to_be_healthy(self):
        self.build_compose(mcp_delay_ms=12000)
        up = subprocess.Popen(["docker", "compose", "-p", PROJECT, "-f", str(self.tmp / "compose.json"), "up", "-d"],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.addCleanup(lambda: up.poll() is None and up.kill())
        violations, mcp_was_unhealthy_while_proxy_absent = [], False
        end = time.time() + 120
        done = False
        while time.time() < end and not done:
            m = self.inspect("openbrain-mcp")
            for svc in PROXIES:
                s = self.inspect(svc)
                if m and s and s["state"] == "running" and m["health"] != "healthy":
                    violations.append((svc, m, s))
                if m and m["health"] != "healthy" and (s is None or s["state"] == "created"):
                    mcp_was_unhealthy_while_proxy_absent = True
            both = [self.inspect(x) for x in PROXIES]
            done = all(b and b["state"] == "running" and b["health"] == "healthy" for b in both)
            time.sleep(0.5)
        self.assertEqual(violations, [], "a proxy ran while openbrain-mcp was not healthy")
        self.assertTrue(mcp_was_unhealthy_while_proxy_absent, "never observed the not-yet-healthy window the test relies on")
        self.assertTrue(done, "proxies never became healthy")
        self.assertEqual(self.tools("openbrain-mcpo", "open-brain"), 3)
        self.assertEqual(self.tools("openbrain-mcpo-ext", "open-brain-extensions"), 3)
        for svc in PROXIES:
            self.assertEqual(self.inspect(svc)["restarts"], 0, svc + " should not have needed a restart")

    def test_2_a_proxy_that_loaded_zero_tools_is_restarted_and_ends_healthy(self):
        self.build_compose(mcp_delay_ms=0)
        # Reproduce 2026-10-19: the proxy starts BEFORE its upstream (--no-deps skips the ordering
        # that rule 1 adds, so this isolates rule 2).
        self.assertEqual(self.compose("up", "-d", "--no-deps", "openbrain-mcpo").returncode, 0)
        seen_healthy_while_empty = []
        self.assertTrue(self.wait(lambda: (self.inspect("openbrain-mcpo") or {}).get("restarts", 0) >= 1, 90),
                        "compose never restarted the empty proxy")
        for _ in range(6):
            i = self.inspect("openbrain-mcpo")
            if i and i["health"] == "healthy" and self.tools("openbrain-mcpo", "open-brain") == 0:
                seen_healthy_while_empty.append(i)
            time.sleep(0.5)
        self.assertEqual(seen_healthy_while_empty, [], "an empty proxy was reported healthy")
        # the upstream comes up: the next load finds the tools, no human step
        self.assertEqual(self.compose("up", "-d", "--no-deps", "openbrain-mcp").returncode, 0)
        self.assertTrue(self.wait(lambda: (self.inspect("openbrain-mcpo") or {}).get("health") == "healthy", 120),
                        "proxy never ended healthy: %r" % self.inspect("openbrain-mcpo"))
        self.assertEqual(self.tools("openbrain-mcpo", "open-brain"), 3)

    def test_3_without_the_guard_docker_leaves_an_unhealthy_empty_proxy_alone(self):
        """Why the guard exists: `restart: unless-stopped` fires on EXIT, never on unhealthy. The
        same service minus the guard entrypoint stays up, unhealthy, restarts == 0."""
        self.build_compose(mcp_delay_ms=0)
        cf = json.loads((self.tmp / "compose.json").read_text())
        s = cf["services"]["openbrain-mcpo"]
        s["entrypoint"] = ["python", "/stub/stub_mcpo.py"]  # mcpo itself, no guard
        (self.tmp / "compose.json").write_text(json.dumps(cf))
        self.assertEqual(self.compose("up", "-d", "--no-deps", "openbrain-mcpo").returncode, 0)
        self.assertTrue(self.wait(lambda: (self.inspect("openbrain-mcpo") or {}).get("health") == "unhealthy", 60),
                        "the empty proxy should read unhealthy: %r" % self.inspect("openbrain-mcpo"))
        time.sleep(20)
        i = self.inspect("openbrain-mcpo")
        self.assertEqual((i["state"], i["health"], i["restarts"]), ("running", "unhealthy", 0), i)


if __name__ == "__main__":
    unittest.main(verbosity=2)
