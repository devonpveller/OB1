"""intake-i5 round 2 (tester attempt 1, `test-evidence/intake-i5.attempt1.md`): the FAIL on
acceptance line 3 (the service sat on ai-stack_llm-net with 30 peers) and findings F-T1, F-T2,
F-T3, F-T5, F-T6, F-T8 (watchdog, ai-stack side) and F-T10. Each class here failed on 40fee15.

The network fix itself (openbrain-intake-llmrelay; the service off llm-net) and the /proc
environ, drip and frozen-worker probes against the real image are in the e2e run
(tests/e2e/run_service_e2e.py, parts A, G2, I)."""
import io
import json
import os
import shutil
import signal
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import yaml

from tests import service_support as ss
from tests.service_memory import InlinePool, MemoryStore
from tests.test_service_core import WEAK, body, service

from intake import pipeline
from intake.second_opinion import HttpRequest, TransportError
from intake_service import app, core, settings
from intake_service import pool as poolmod
from intake_service import web
from intake_service.metrics import Metrics

COMPOSE = Path(__file__).resolve().parents[3] / "docker" / "docker-compose.yml"


def _compose():
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))


class LineThreeNetworks(unittest.TestCase):
    """The service reaches exactly the DB relay and the LiteLLM relay: it is on intake-net ONLY
    (internal), and each relay forwards one fixed target."""

    def test_the_service_is_on_intake_net_only(self):
        svc = _compose()["services"]["openbrain-intake"]
        self.assertEqual(list(svc["networks"]), ["intake-net"])

    def test_the_llm_relay_is_on_intake_net_and_llm_net_and_carries_the_alias_on_intake_net_only(self):
        r = _compose()["services"]["openbrain-intake-llmrelay"]
        self.assertEqual(set(r["networks"]), {"intake-net", "llm-net"})
        self.assertEqual(r["networks"]["intake-net"]["aliases"], ["llama-cpp"])
        self.assertFalse((r["networks"].get("llm-net") or {}).get("aliases"))
        env = r["environment"]
        self.assertEqual((env["INTAKE_RELAY_TARGET_HOST"], env["INTAKE_RELAY_TARGET_PORT"],
                          env["INTAKE_RELAY_LISTEN_PORT"]), ("llm-gateway", "8080", "8080"))
        self.assertEqual(r["profiles"], ["intake"])
        self.assertEqual(r["command"], ["relay"])

    def test_no_live_service_changes_its_networks(self):
        d = _compose()
        for name, svc in d["services"].items():
            if name.startswith("openbrain-intake"):
                continue
            nets = svc.get("networks") or []
            self.assertNotIn("intake-net", list(nets), name)

    def test_intake_net_is_internal_with_its_subnet(self):
        n = _compose()["networks"]["intake-net"]
        self.assertTrue(n["internal"])
        self.assertEqual(n["ipam"]["config"][0]["subnet"], "10.243.50.0/24")


class FT5OwnEnvFile(unittest.TestCase):
    """docker/intake.env is loaded by the intake service ONLY - not docker/.env, which open_notebook
    loads whole (`env_file: ./.env`). Since intake-i5b (R2-F1) it carries no secret at all: the
    secrets are compose secrets (tests/test_service_i5b.py)."""

    def test_only_the_intake_service_loads_intake_env(self):
        d = _compose()
        users = []
        for name, svc in d["services"].items():
            ef = svc.get("env_file")
            items = ef if isinstance(ef, list) else ([ef] if ef else [])
            for it in items:
                path = it["path"] if isinstance(it, dict) else it
                if "intake.env" in str(path):
                    users.append(name)
        self.assertEqual(users, ["openbrain-intake"])

    def test_no_intake_value_is_interpolated_from_dot_env(self):
        text = COMPOSE.read_text(encoding="utf-8")
        self.assertNotIn("${INTAKE_", text, "every ${INTAKE_*} is read from .env, which open_notebook loads")

    def test_neither_example_file_carries_a_secret_and_the_intake_one_names_the_secret_files(self):
        ex = (COMPOSE.parent / "intake.env.example").read_text(encoding="utf-8")
        dot = (COMPOSE.parent / ".env.example").read_text(encoding="utf-8")
        for k in ("INTAKE_CALLER_KEYS=", "INTAKE_DB_PASSWORD=", "INTAKE_SECOND_OPINION_KEY="):
            self.assertNotIn(k, ex)
            self.assertNotIn(k, dot)
        for fn in settings.SECRET_FILES.values():
            self.assertIn(fn, ex)

    @unittest.skipUnless(shutil.which("git"), "needs git (intake-i5 R2-F6: the image has none)")
    def test_intake_env_is_gitignored(self):
        import subprocess
        r = subprocess.run(["git", "-C", str(COMPOSE.parent), "check-ignore", "-q", "intake.env"])
        self.assertEqual(r.returncode, 0)

    def test_the_env_file_is_optional_so_a_host_without_it_still_renders(self):
        ef = _compose()["services"]["openbrain-intake"]["env_file"]
        self.assertEqual(ef, [{"path": "intake.env", "required": False}])


class FT1NonDumpableParent(unittest.TestCase):
    """The parent makes itself non-dumpable before any worker exists, so a worker (same uid,
    no capability) cannot read /proc/<parent>/environ or /proc/<parent>/mem. The real read is
    proved in the e2e (part A); here: the call is made, in the right order, and a failure to
    make it refuses the start."""

    def test_harden_runs_before_the_pool_and_a_failure_refuses_the_start(self):
        order = []
        # intake-i5b: the seal (a Landlock domain, irreversible) is patched out here: run for real
        # it would confine this test process; it runs for real in tests.test_service_i5b.R2F1SealLinux
        with mock.patch.object(app, "harden_process", side_effect=lambda: order.append("harden")), \
                mock.patch.object(app, "seal_secrets", side_effect=lambda d: order.append("seal")), \
                mock.patch("intake_service.pool.WorkerPool.start", side_effect=lambda *a: order.append("pool")
                           or (_ for _ in ()).throw(poolmod.PoolError("stop here"))):
            code = app._serve(settings.load(ss.base_env()), ss.base_env())
        self.assertEqual(order[:3], ["harden", "seal", "pool"])
        self.assertEqual(code, app.EXIT_WORKERS)
        with mock.patch.object(app, "harden_process", side_effect=OSError("prctl refused")), \
                mock.patch.object(app, "seal_secrets") as seal:
            self.assertEqual(app._serve(settings.load(ss.base_env()), ss.base_env()), app.EXIT_HARDEN)
        seal.assert_not_called()

    @unittest.skipUnless(sys.platform.startswith("linux"), "prctl is Linux")
    def test_harden_process_makes_this_process_non_dumpable(self):
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        before = libc.prctl(3, 0, 0, 0, 0)  # PR_GET_DUMPABLE
        try:
            app.harden_process()
            self.assertEqual(libc.prctl(3, 0, 0, 0, 0), 0)
        finally:
            libc.prctl(4, before, 0, 0, 0)


def _make(factory, **kw):
    p = poolmod.WorkerPool(1, factory=factory, wall_stages_s=5.0, wall_transfer_s=kw.pop("transfer", 2.0),
                           wall_classifier_s=10.0, start_timeout_s=60.0, queue_wait_s=kw.pop("queue_wait_s", 5.0))
    p.start()
    return p


class FT2TransferClockCoversTheSend(unittest.TestCase):
    """A body bigger than the pipe buffer, handed to a FROZEN worker, is cut at the transfer
    wall clock (the send itself is bounded), and a pool whose every worker is stuck is not
    reported ready."""

    @unittest.skipUnless(hasattr(signal, "SIGSTOP"), "SIGSTOP is POSIX")
    def test_a_large_body_to_a_frozen_worker_is_cut_at_the_transfer_clock(self):
        p = _make("tests.service_support:zero", transfer=2.0)
        try:
            pid = p.status_pids()[0]
            os.kill(pid, signal.SIGSTOP)
            t0 = time.monotonic()
            out = p.run(ss.envelope_bytes("x" * 3_000_000), lambda i: None)
            took = time.monotonic() - t0
            self.assertEqual((out.kind, out.phase), ("killed", "transfer"))
            self.assertLess(took, 2.0 + 3.0)
        finally:
            p.close()

    def test_the_send_is_bounded_even_when_it_blocks(self):
        p = _make("tests.service_support:zero", transfer=1.0)
        try:
            w = p._idle[0]
            release = threading.Event()
            real_send = w.conn.send_bytes

            def blocking_send(data):
                if data.startswith(b'["job"'):
                    release.wait(30)  # a worker that never reads: the send never returns
                return real_send(data)

            w.conn.send_bytes = blocking_send
            t0 = time.monotonic()
            out = p.run(ss.envelope_bytes("x"), lambda i: None)
            self.assertEqual((out.kind, out.phase), ("killed", "transfer"))
            self.assertLess(time.monotonic() - t0, 4.0)
            release.set()
        finally:
            p.close()

    def test_a_busy_worker_past_every_wall_clock_is_stuck_not_ready(self):
        p = _make("tests.service_support:zero")
        try:
            w = p._idle.pop()
            p._busy.add(w)
            p._job_started[w] = time.monotonic() - (p.max_job_seconds + 60)
            st = p.status()
            self.assertEqual(st["stuck"], 1)
            self.assertEqual(st["serving"], 0)
        finally:
            p._busy.discard(w)
            p._idle.append(w)
            p.close()

    def test_healthz_is_503_when_no_worker_is_serving(self):
        s = settings.load(ss.base_env())

        class Stuck(InlinePool):
            def status(self):
                return {"ready": 1, "total": 1, "busy": 1, "stuck": 1, "serving": 0}

        svc = core.Intake(s, Stuck(ss.zero()), MemoryStore(), Metrics(), judge=None)
        resp = web.Router(svc, s).dispatch("GET", "/healthz", {}, lambda n: b"")
        self.assertEqual(resp.status, 503)
        self.assertFalse(json.loads(resp.body)["ok"])


class _DripFile:
    """A request body that arrives one byte per `gap` seconds."""

    def __init__(self, data, gap):
        self.data, self.gap = data, gap

    def read1(self, n):
        time.sleep(self.gap)
        b, self.data = self.data[:1], self.data[1:]
        return b

    read = read1


class FT3BodyReadDeadline(unittest.TestCase):
    def test_a_drip_is_cut_at_the_total_deadline(self):
        r = web.BodyReader(_DripFile(b"x" * 1000, 0.05), None, total_s=0.5)
        t0 = time.monotonic()
        with self.assertRaises(web.BodyTimeout):
            r.read(1000)
        self.assertLess(time.monotonic() - t0, 1.0)

    def test_a_prompt_body_is_read_whole(self):
        data = b"y" * 70_000
        self.assertEqual(web.BodyReader(io.BytesIO(data), None, total_s=5).read(len(data)), data)

    def test_the_router_answers_408_on_a_body_timeout(self):
        s = settings.load(ss.base_env())
        svc = core.Intake(s, InlinePool(ss.zero()), MemoryStore(), Metrics(), judge=None)

        def read(n):
            raise web.BodyTimeout("the body did not arrive in time")

        h = {"Authorization": "Bearer " + ss.CALLER_KEYS["research"], "Content-Length": "100"}
        resp = web.Router(svc, s).dispatch("POST", "/v1/intake", h, read)
        self.assertEqual(resp.status, 408)

    def test_connections_are_capped(self):
        s = settings.load(ss.base_env(INTAKE_MAX_CONNECTIONS="2"))
        self.assertEqual(s.max_connections, 2)
        gate = web.ConnectionGate(2)
        self.assertTrue(gate.enter())
        self.assertTrue(gate.enter())
        self.assertFalse(gate.enter())
        gate.leave()
        self.assertTrue(gate.enter())

    def test_body_deadline_is_config(self):
        self.assertEqual(settings.load(ss.base_env()).body_read_s, 30.0)
        with self.assertRaises(settings.ConfigError):
            settings.load(ss.base_env(INTAKE_BODY_READ_SECONDS="0"))


class FT6ShortReply(unittest.TestCase):
    def test_a_reply_shorter_than_its_content_length_is_refused(self):
        from tests.test_service_transport import _ClosingResp, _conn
        from transport import http_gateway
        full = json.dumps({"choices": [{"message": {"content": '{"verdict": "clean"}'}}]}).encode()

        class Short(_ClosingResp):
            def getheader(self, name, default=None):
                return str(len(full) + 10) if name.lower() == "content-length" else default

        class Conn(_conn(full)):
            def getresponse(self):
                return Short(self.sock, full, 1)

        req = HttpRequest(url="http://llama-cpp:8080/v1/chat/completions", headers=(), body=b"{}", timeout=5.0)
        with mock.patch.object(http_gateway.http.client, "HTTPConnection", Conn):
            with self.assertRaises(TransportError) as cm:
                http_gateway.send(req)
        self.assertEqual(cm.exception.kind, "network")


class FT10RepeatText(unittest.TestCase):
    """A repeat serves the stored decision; the fresh screen's text is returned only when that
    screen produced the SAME evidence the stored decision was made on. Otherwise no text, and
    rescreen=true (the stored label stands until a re-screen, I9)."""

    def test_same_evidence_serves_the_text(self):
        svc, store, _ = service()
        svc.handle("research", body(WEAK))
        svc.sweep_second_opinion()  # judge clean -> clean (D40)
        _, again = svc.handle("research", body(WEAK))
        self.assertEqual((again["repeat"], again["label"]), (True, "clean"))
        self.assertTrue(again["text"])
        self.assertFalse(again["rescreen"])

    def test_different_evidence_withholds_the_text(self):
        svc, store, _ = service()
        svc.handle("research", body(WEAK))
        svc.sweep_second_opinion()
        # the rules changed since (simulated: the fresh screen now has no rule hit and the
        # classifier over the threshold) - same bytes, different evidence
        svc.pool = InlinePool(ss.high())
        with mock.patch.object(pipeline.rules, "evaluate", return_value=[]):
            _, again = svc.handle("research", body(WEAK))
        self.assertTrue(again["repeat"])
        self.assertEqual(again["label"], "clean")
        self.assertIsNone(again["text"])
        self.assertTrue(again["rescreen"])
        self.assertIn("evidence", again["text_withheld"])


if __name__ == "__main__":
    unittest.main()
