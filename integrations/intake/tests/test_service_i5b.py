"""intake-i5b: the intake service's pre-deploy list (DESIGN-intake section 12, items 7-13; the
intake-i5 round-2 tester R2-F1..F3 and the intake-int review R-1..R-6). Every class here failed on
OB1 27cdbce (journal/evidence/intake-i5b/red-*.txt).

  R2-F1  the three secrets are FILES (compose secrets at /run/secrets), never environment
         variables, so no `docker exec` process (the healthcheck, stack.py health,
         check-openbrain-health) carries them; a secret name in the environment refuses the start;
         after reading them the parent SEALS the directory (Landlock), so no worker can read the
         files either (the bind is world-readable on a Windows host: 0400 is not enforceable)
  R2-F2  net.ipv4.ip_forward=0 on both relays
  R2-F3 / R-5  the docs: no INTAKE_MODEL_DIR; the OB1 docker README lists pantry and intake
  R-2    the parent<->worker pipe carries size-capped JSON over send_bytes/recv_bytes, never pickle
  R-3    core.py's collapsed line continuation
  R-4    a worker that returns an invalid result is dropped and replaced, not re-pooled
  R-6    the relays pass a client's half-close on and close an idle connection

The Linux-only cases (the Landlock seal, a real worker's read of a sealed file) run in the image:
tests/e2e/run_service_e2e.py part J, and the in-container unit run in the test plan.
"""
import errno
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import tokenize
import unittest
from pathlib import Path
from unittest import mock

import _socket
import yaml

from tests import i5b_workers
from tests import service_support as ss

from intake_service import app, relay, settings, wire
from intake_service import pool as poolmod

HERE = Path(__file__).resolve().parent
INTAKE = HERE.parent
DOCKER = INTAKE.parents[1] / "docker"
COMPOSE = DOCKER / "docker-compose.yml"
SECRET_NAMES = ("INTAKE_CALLER_KEYS", "INTAKE_DB_PASSWORD", "INTAKE_SECOND_OPINION_KEY")


def _compose():
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))


# -- R2-F1: secrets as files ------------------------------------------------------------------------
class R2F1SecretsAreFiles(unittest.TestCase):
    def assertRefused(self, env, needle):
        with self.assertRaises(settings.ConfigError) as cm:
            settings.load(env)
        self.assertIn(needle, str(cm.exception))
        for s in ss.SECRETS:
            self.assertNotIn(s, str(cm.exception), "a refusal must not print a secret")
        return str(cm.exception)

    def test_the_secrets_are_read_from_the_files(self):
        s = settings.load(ss.base_env())
        self.assertEqual(s.callers.match(ss.CALLER_KEYS["research"]), "research")
        self.assertEqual(s.db_password.reveal(), ss.DB_PASSWORD)
        self.assertEqual(s.second_opinion_key.reveal(), ss.SO_KEY)
        self.assertTrue(s.second_opinion_key_set)

    def test_a_secret_name_in_the_environment_refuses_the_start(self):
        for name in SECRET_NAMES:
            for value in ("x" * 40, ""):
                with self.subTest(name=name, empty=not value):
                    env = ss.base_env()
                    env[name] = value
                    msg = self.assertRefused(env, name)
                    self.assertIn("environment", msg)

    def test_one_trailing_line_break_is_dropped_and_nothing_else(self):
        for tail in ("\n", "\r\n"):
            with self.subTest(tail=repr(tail)):
                s = settings.load(ss.base_env(INTAKE_DB_PASSWORD=ss.DB_PASSWORD + tail))
                self.assertEqual(s.db_password.reveal(), ss.DB_PASSWORD)
        self.assertRefused(ss.base_env(INTAKE_DB_PASSWORD=ss.DB_PASSWORD + "\n\n"), "INTAKE_DB_PASSWORD")

    def test_a_missing_required_file_refuses_and_names_the_file(self):
        msg = self.assertRefused(ss.base_env(INTAKE_DB_PASSWORD=None), "INTAKE_DB_PASSWORD")
        self.assertIn("intake_db_password", msg)
        self.assertRefused(ss.base_env(INTAKE_CALLER_KEYS=None), "INTAKE_CALLER_KEYS")

    def test_an_unreadable_shape_refuses(self):
        env = ss.base_env()
        d = env["INTAKE_SECRETS_DIR"]
        os.remove(os.path.join(d, "intake_db_password"))
        os.mkdir(os.path.join(d, "intake_db_password"))  # what Docker makes for an absent bind source
        self.assertRefused(env, "INTAKE_DB_PASSWORD")
        self.assertRefused(ss.base_env(INTAKE_DB_PASSWORD="p" * 20000), "INTAKE_DB_PASSWORD")
        env = ss.base_env()
        with open(os.path.join(env["INTAKE_SECRETS_DIR"], "intake_db_password"), "wb") as fh:
            fh.write(b"\xff\xfe-not-utf8")
        self.assertRefused(env, "INTAKE_DB_PASSWORD")

    def test_a_relative_secrets_dir_is_refused(self):
        self.assertRefused(ss.base_env(INTAKE_SECRETS_DIR="run/secrets"), "INTAKE_SECRETS_DIR")

    def test_the_judge_key_file_absent_or_empty_is_reported_not_refused(self):
        self.assertFalse(settings.load(ss.base_env(INTAKE_SECOND_OPINION_KEY=None)).second_opinion_key_set)
        self.assertFalse(settings.load(ss.base_env(INTAKE_SECOND_OPINION_KEY="")).second_opinion_key_set)

    def test_the_default_dir_is_run_secrets(self):
        self.assertEqual(settings.DEFAULT_SECRETS_DIR, "/run/secrets")
        self.assertEqual(sorted(settings.SECRET_FILES.values()),
                         ["intake_caller_keys", "intake_db_password", "intake_second_opinion_key"])

    def test_no_secret_in_the_settings_repr(self):
        s = settings.load(ss.base_env())
        text = repr(s) + str(s) + repr(s.second_opinion_key)
        for secret in ss.SECRETS:
            self.assertNotIn(secret, text)

    def test_serve_hands_the_judge_the_file_key_then_seals_before_the_pool(self):
        order, seen = [], {}

        class FakeJudge:
            def __init__(self, transport, cfg, env):
                seen.update(env)

        def stop(*_a):
            order.append("pool")
            raise poolmod.PoolError("stop here")

        s = settings.load(ss.base_env())
        with mock.patch.object(app, "harden_process", side_effect=lambda: order.append("harden")), \
                mock.patch.object(app, "seal_secrets", side_effect=lambda d: order.append(("seal", d))), \
                mock.patch("intake.second_opinion.Judge", FakeJudge), \
                mock.patch("intake_service.pool.WorkerPool.start", side_effect=stop):
            code = app._serve(s, {})
        self.assertEqual(code, app.EXIT_WORKERS)
        self.assertEqual(order, ["harden", ("seal", s.secrets_dir), "pool"])
        self.assertEqual(seen.get("INTAKE_SECOND_OPINION_KEY"), ss.SO_KEY)

    def test_a_seal_failure_refuses_the_start(self):
        s = settings.load(ss.base_env())
        with mock.patch.object(app, "harden_process"), \
                mock.patch.object(app, "seal_secrets", side_effect=OSError(errno.ENOSYS, "no landlock")), \
                mock.patch("intake_service.pool.WorkerPool.start") as start:
            self.assertEqual(app._serve(s, {}), app.EXIT_HARDEN)
        start.assert_not_called()


class R2F1Compose(unittest.TestCase):
    def test_the_service_environment_names_no_secret(self):
        svc = _compose()["services"]["openbrain-intake"]
        env = svc.get("environment") or {}
        names = env if isinstance(env, dict) else [e.split("=", 1)[0] for e in env]
        for n in SECRET_NAMES:
            self.assertNotIn(n, names)

    def test_the_example_env_file_assigns_no_secret(self):
        ex = (DOCKER / "intake.env.example").read_text(encoding="utf-8")
        for n in SECRET_NAMES:
            self.assertIsNone(re.search(rf"^\s*#?\s*{n}\s*=", ex, re.M), n)

    def test_the_three_secrets_are_compose_secrets_from_the_gitignored_dir(self):
        d = _compose()
        svc = d["services"]["openbrain-intake"]
        got = {(x["source"], x.get("target")) for x in svc["secrets"]}
        self.assertEqual(got, {(v, v) for v in settings.SECRET_FILES.values()})
        top = d["secrets"]
        for v in settings.SECRET_FILES.values():
            self.assertTrue(top[v]["file"].startswith("./intake-secrets/"), top[v])
            self.assertNotIn(".", Path(top[v]["file"]).name, "no suffix: the backup derivation must not "
                             "call an absent one MISSING on a host without intake")
        for name, other in d["services"].items():
            if name != "openbrain-intake":
                self.assertFalse(other.get("secrets"), f"{name} must not get intake's secrets")

    @unittest.skipUnless(shutil.which("git"), "needs git (R2-F6: the image has none)")
    def test_the_secrets_dir_is_gitignored(self):
        r = subprocess.run(["git", "-C", str(DOCKER), "check-ignore", "-q", "intake-secrets/intake_db_password"])
        self.assertEqual(r.returncode, 0)


@unittest.skipUnless(sys.platform.startswith("linux"), "Landlock is Linux (runs in the image)")
class R2F1SealLinux(unittest.TestCase):
    """In a child process (a seal cannot be undone): a probe worker reads the secret file BEFORE
    the seal; after it the parent and a newly spawned worker get PermissionError, and the
    rest of the file system stays readable."""

    def test_after_the_seal_neither_the_parent_nor_a_worker_reads_a_secret(self):
        env = ss.base_env()
        d = env["INTAKE_SECRETS_DIR"]
        code = textwrap.dedent(f"""
            import json, os, sys
            sys.path.insert(0, {str(INTAKE)!r})
            from intake_service import app, pool
            d = {d!r}
            f = os.path.join(d, "intake_db_password")
            os.environ["INTAKE_TEST_PROBE_FILE"] = f
            def mk():
                p = pool.WorkerPool(1, factory="tests.i5b_workers:probe_factory", wall_stages_s=5,
                                    wall_transfer_s=5, wall_classifier_s=5, start_timeout_s=60, queue_wait_s=5)
                p.start(); v = p.version; p.close(); return v
            out = {{"worker_before": mk()}}
            app.seal_secrets(d)
            try:
                open(f, "rb").read(); out["parent_after"] = "READ"
            except Exception as e:
                out["parent_after"] = type(e).__name__
            out["worker_after"] = mk()
            out["app_readable"] = bool(open(app.__file__, "rb").read(10))
            out["etc_readable"] = bool(open("/etc/hostname", "rb").read(1) is not None)
            print(json.dumps(out))
        """)
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=300,
                           cwd=str(INTAKE))
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        out = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertEqual(out["worker_before"], "probe/READ", "the probe must be able to see a readable file")
        self.assertEqual(out["parent_after"], "PermissionError")
        self.assertEqual(out["worker_after"], "probe/PermissionError")
        self.assertTrue(out["app_readable"] and out["etc_readable"])

    def test_the_seal_refuses_with_a_second_thread(self):
        code = textwrap.dedent(f"""
            import sys, threading, time
            sys.path.insert(0, {str(INTAKE)!r})
            from intake_service import app
            threading.Thread(target=time.sleep, args=(30,), daemon=True).start()
            try:
                app.seal_secrets({tempfile.gettempdir()!r})
                print("SEALED")
            except OSError as e:
                print("REFUSED", e)
        """)
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
        self.assertIn("REFUSED", r.stdout, r.stderr[-500:])


# -- R2-F2: ip_forward on the relays ---------------------------------------------------------------
class R2F2RelaysDoNotForward(unittest.TestCase):
    def test_both_relays_set_ip_forward_0(self):
        d = _compose()
        # intake-gate-relay: the third relay (the search gate's way in) is held to the same line
        for name in ("openbrain-intake-dbrelay", "openbrain-intake-llmrelay", "openbrain-intake-callrelay"):
            with self.subTest(relay=name):
                sc = d["services"][name].get("sysctls") or {}
                self.assertEqual(str(sc.get("net.ipv4.ip_forward")), "0", sc)


# -- R2-F3 / R-5: docs ------------------------------------------------------------------------------
class R2F3Docs(unittest.TestCase):
    def test_no_stale_intake_model_dir(self):
        for p in (COMPOSE, INTAKE / "README.md", DOCKER / "intake.env.example"):
            with self.subTest(path=p.name):
                self.assertNotIn("INTAKE_MODEL_DIR", p.read_text(encoding="utf-8"))

    def test_the_docker_readme_profile_table_lists_pantry_and_intake(self):
        text = (DOCKER / "README.md").read_text(encoding="utf-8")
        section = text[text.index("## Compose profiles"):text.index("### The invariant")]
        for svc, prof in (("openbrain-pantry", "pantry"), ("openbrain-intake", "intake"),
                          ("openbrain-intake-dbrelay", "intake"), ("openbrain-intake-llmrelay", "intake"),
                          ("openbrain-intake-callrelay", "intake")):
            with self.subTest(svc=svc):
                self.assertRegex(section, rf"\| `{re.escape(svc)}` \| `{prof}` \|")


# -- R-2 / R-4: the pipe ---------------------------------------------------------------------------
def _pool(**kw):
    p = poolmod.WorkerPool(1, factory="tests.service_support:zero", wall_stages_s=5.0, wall_transfer_s=5.0,
                           wall_classifier_s=10.0, start_timeout_s=60.0, queue_wait_s=10.0,
                           respawn_backoff_s=1.0, **kw)
    p.start()
    return p


def _wait_ready(p, old_pid, seconds=90):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        pids = p.status_pids()
        if pids and pids[0] != old_pid and p.status()["replacing"] == 0:
            return pids[0]
        time.sleep(0.2)
    return None


class R2WireNeverPickle(unittest.TestCase):
    def test_the_pool_never_calls_send_or_recv_on_a_connection(self):
        src = (INTAKE / "intake_service" / "pool.py").read_text(encoding="utf-8")
        code = "".join(t.string for t in tokenize.generate_tokens(io.StringIO(src).readline)
                       if t.type not in (tokenize.COMMENT, tokenize.STRING))
        self.assertIsNone(re.search(r"\.(send|recv)\(", code), "pickle: Connection.send/recv")

    def test_frames_are_json_and_capped(self):
        a, b = poolmod._CTX.Pipe(duplex=True)

        def send(data):  # from a thread: a pipe write can wait for its reader (Windows)
            th = threading.Thread(target=lambda: a.send_bytes(data), daemon=True)
            th.start()
            return th

        try:
            wire.send_msg(a, ["started", 1, {"k": "v", "n": [1, 2]}])
            self.assertEqual(wire.recv_msg(b, 1024), ["started", 1, {"k": "v", "n": [1, 2]}])
            import pickle
            send(pickle.dumps(("done", 1, {}))).join(5)
            with self.assertRaises(wire.WireError):
                wire.recv_msg(b, 1024)
            for bad in (b'{"op": 1}', b"[]", b"[1]", b'["x", NaN]', b"[" * 20000):
                th = send(bad)
                with self.assertRaises(wire.WireError):
                    wire.recv_msg(b, 1 << 20)
                th.join(5)
            with self.assertRaises(ValueError):
                wire.send_msg(a, ["x", float("nan")])
            send(b"[" + b'"x",' * 400 + b'"y"]')
            with self.assertRaises(OSError):
                wire.recv_msg(b, 256)  # over the cap: refused from its length
        finally:
            a.close()
            b.close()

    def test_the_started_envelope_raw_comes_back_as_the_same_bytes(self):
        p = _pool()
        try:
            out = p.run(ss.envelope_bytes("Plain text éè about tomatoes."), lambda i: None)
            self.assertEqual(out.kind, "result")
            self.assertEqual(out.started["envelope"]["raw"], "Plain text éè about tomatoes.".encode())
        finally:
            p.close()

    def test_a_large_legitimate_body_still_passes(self):
        p = _pool()
        try:
            raw = ('A "quoted" \\ line about tomatoes.\n' * 150000)[:5 * 1024 * 1024 - 64]
            out = p.run(ss.envelope_bytes(raw), lambda i: None)
            self.assertEqual(out.kind, "result", out.detail)
            self.assertEqual(out.result.verdict, "clean")
        finally:
            p.close()

    def _hostile(self, main, **kw):
        marker = os.path.join(tempfile.mkdtemp(prefix="i5b-marker-"), "PWNED")
        os.environ["INTAKE_TEST_MARKER"] = marker
        try:
            with mock.patch.object(poolmod, "_worker_main", main):
                p = _pool(**kw)
                try:
                    pid = p.status_pids()[0]
                    t0 = time.monotonic()
                    try:
                        out = p.run(ss.envelope_bytes(), lambda i: None)
                    except Exception as e:  # noqa: BLE001 - recorded: the pwned check comes first
                        out = poolmod.Outcome("raised " + type(e).__name__, None, None)
                    took = time.monotonic() - t0
                    new = _wait_ready(p, pid)
                    return out, took, os.path.exists(marker), p.deaths, pid, new
                finally:
                    p.close()
        finally:
            os.environ.pop("INTAKE_TEST_MARKER", None)
            shutil.rmtree(os.path.dirname(marker), ignore_errors=True)

    def test_a_pickle_from_a_worker_is_refused_and_the_worker_replaced(self):
        out, took, pwned, deaths, pid, new = self._hostile(i5b_workers.pickle_main)
        self.assertFalse(pwned, "the parent unpickled a worker message: code ran in the parent")
        self.assertEqual(out.kind, "died")
        self.assertIsNone(out.result)
        self.assertEqual(deaths, 1)
        self.assertIsNotNone(new, "the worker was not replaced")

    def test_an_oversize_message_is_refused_and_the_worker_replaced(self):
        out, took, _, deaths, pid, new = self._hostile(i5b_workers.oversize_main)
        self.assertEqual(out.kind, "died")
        self.assertIn("oversize", out.detail)
        self.assertEqual(deaths, 1)
        self.assertIsNotNone(new)

    def test_a_message_for_another_job_or_an_unknown_op_drops_the_worker_at_once(self):
        out, took, _, deaths, pid, new = self._hostile(i5b_workers.wrong_id_main)
        self.assertEqual(out.kind, "died")
        self.assertLess(took, 3.0, "a protocol violation is not waited out to the wall clock")
        self.assertEqual(deaths, 1)
        self.assertIsNotNone(new)


class R4InvalidResultDropsTheWorker(unittest.TestCase):
    def test_an_invalid_result_is_refused_and_the_worker_replaced_not_repooled(self):
        with mock.patch.object(poolmod, "_worker_main", i5b_workers.invalid_result_main):
            p = _pool()
            try:
                pid = p.status_pids()[0]
                out = p.run(ss.envelope_bytes(), lambda i: None)
                self.assertEqual(out.kind, "died")
                self.assertIn("invalid result", out.detail)
                self.assertIsNone(out.result)
                self.assertEqual(p.deaths, 1)
                new = _wait_ready(p, pid)
                self.assertIsNotNone(new, "the worker that sent an invalid result was re-pooled")
                self.assertNotEqual(new, pid)
            finally:
                p.close()


# -- R-3 --------------------------------------------------------------------------------------------
class R3Readability(unittest.TestCase):
    def test_no_collapsed_line_continuation_in_the_service_code(self):
        bad = []
        for path in sorted((INTAKE / "intake_service").glob("*.py")):
            toks = list(tokenize.generate_tokens(io.StringIO(path.read_text(encoding="utf-8")).readline))
            for prev, tok in zip(toks, toks[1:]):
                if (tok.start[0] == prev.end[0] and tok.start[1] - prev.end[1] >= 8
                        and tok.type not in (tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE)
                        and prev.type not in (tokenize.INDENT, tokenize.DEDENT, tokenize.NL, tokenize.NEWLINE)):
                    bad.append(f"{path.name}:{tok.start[0]}")
        self.assertEqual(bad, [])


# -- R-6: the relays --------------------------------------------------------------------------------
_REAL_CONNECT = _socket.socket.connect
_REAL_CONNECT_EX = _socket.socket.connect_ex
_REAL_GAI = _socket.getaddrinfo


def _loopback_only(addr):
    host = addr[0] if isinstance(addr, tuple) else addr
    if host not in ("127.0.0.1", "localhost"):
        raise OSError(errno.ENETUNREACH, f"the relay tests reach loopback only, not {host!r}")


def _connect(self, addr):
    _loopback_only(addr)
    return _REAL_CONNECT(self, addr)


def _connect_ex(self, addr):
    _loopback_only(addr)
    return _REAL_CONNECT_EX(self, addr)


def _gai(host, *a, **k):
    _loopback_only((host,))
    return _REAL_GAI(host, *a, **k)


def _free_port():
    s = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _Target:
    """A loopback target: `reply` mode reads until EOF, then answers REPLY:<data> and closes
    (a client that half-closes after its request); `echo` mode echoes."""

    def __init__(self, mode):
        self.mode = mode
        self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)  # bind/listen/accept: no connect
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(8)
        self.port = self.srv.getsockname()[1]
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while True:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            threading.Thread(target=self._one, args=(c,), daemon=True).start()

    def _one(self, c):
        try:
            if self.mode == "reply":
                data = b""
                while True:
                    b = c.recv(65536)
                    if not b:
                        break
                    data += b
                time.sleep(0.2)
                c.sendall(b"REPLY:" + data)
            else:
                while True:
                    b = c.recv(65536)
                    if not b:
                        break
                    c.sendall(b)
        except OSError:
            pass
        finally:
            c.close()

    def close(self):
        self.srv.close()


class R6Relay(unittest.TestCase):
    def setUp(self):
        self.patches = [mock.patch.object(socket.socket, "connect", _connect),
                        mock.patch.object(socket.socket, "connect_ex", _connect_ex),
                        mock.patch.object(socket, "getaddrinfo", _gai),
                        mock.patch.object(socket, "create_connection", self._create_connection)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()

    @staticmethod
    def _create_connection(addr, timeout=None, *a, **k):
        _loopback_only(addr)
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        _REAL_CONNECT(s, addr)
        return s

    def _relay(self, target_port, **extra):
        import asyncio
        port = _free_port()
        env = {"INTAKE_RELAY_TARGET_HOST": "127.0.0.1", "INTAKE_RELAY_TARGET_PORT": str(target_port),
               "INTAKE_RELAY_LISTEN_PORT": str(port), **extra}
        cfg = relay.config(env)
        cfg["listen_host"] = "127.0.0.1"
        loop = asyncio.new_event_loop()
        task = {}

        def run():
            asyncio.set_event_loop(loop)
            task["t"] = loop.create_task(relay.serve(cfg))
            try:
                loop.run_until_complete(task["t"])
            except BaseException:  # noqa: BLE001 - cancelled at teardown
                pass

        th = threading.Thread(target=run, daemon=True)
        th.start()
        end = time.monotonic() + 10
        while time.monotonic() < end:
            try:
                self._create_connection(("127.0.0.1", port), 1).close()
                break
            except OSError:
                time.sleep(0.05)

        def stop():
            loop.call_soon_threadsafe(task["t"].cancel)
            th.join(5)
        self.addCleanup(stop)
        return port

    def test_the_idle_timeout_is_configured_and_validated(self):
        self.assertEqual(relay.config({})["idle_s"], 900.0)
        self.assertEqual(relay.config({"INTAKE_RELAY_IDLE_SECONDS": "30"})["idle_s"], 30.0)
        for bad in ("0", "-1", "abc", "100000"):
            with self.subTest(bad=bad), self.assertRaises(relay.RelayConfigError):
                relay.config({"INTAKE_RELAY_IDLE_SECONDS": bad})

    def test_a_client_half_close_still_gets_the_reply(self):
        t = _Target("reply")
        self.addCleanup(t.close)
        port = self._relay(t.port)
        c = self._create_connection(("127.0.0.1", port), 10)
        try:
            c.sendall(b"hello")
            c.shutdown(socket.SHUT_WR)
            data = b""
            while True:
                b = c.recv(65536)
                if not b:
                    break
                data += b
        finally:
            c.close()
        self.assertEqual(data, b"REPLY:hello")

    def test_an_idle_connection_is_closed_and_its_slot_freed(self):
        t = _Target("echo")
        self.addCleanup(t.close)
        port = self._relay(t.port, INTAKE_RELAY_IDLE_SECONDS="1", INTAKE_RELAY_MAX_CONNECTIONS="1")
        time.sleep(0.5)  # the readiness probe's slot is released first (max 1 connection)
        c = self._create_connection(("127.0.0.1", port), 6)
        t0 = time.monotonic()
        try:
            got = c.recv(10)
        except socket.timeout:
            got = "still open"
        finally:
            c.close()
        took = time.monotonic() - t0
        self.assertEqual(got, b"", "the idle connection was not closed")
        self.assertGreaterEqual(took, 0.8, "closed at once (refused at accept), not by the idle timeout")
        self.assertLess(took, 4.0)
        time.sleep(0.3)
        c2 = self._create_connection(("127.0.0.1", port), 5)
        try:
            c2.sendall(b"ping")
            self.assertEqual(c2.recv(10), b"ping", "the slot of the idle connection was not freed")
        finally:
            c2.close()

    def test_traffic_keeps_a_connection_open_past_the_idle_time(self):
        t = _Target("echo")
        self.addCleanup(t.close)
        port = self._relay(t.port, INTAKE_RELAY_IDLE_SECONDS="1")
        c = self._create_connection(("127.0.0.1", port), 5)
        try:
            for i in range(6):
                c.sendall(b"x%d" % i)
                self.assertEqual(c.recv(10), b"x%d" % i)
                time.sleep(0.5)
        finally:
            c.close()


# -- R-6 consequence: the store never hands out a connection the DB relay may have cut ------------
class R6StoreIdle(unittest.TestCase):
    def test_a_pooled_connection_idle_past_max_idle_is_replaced(self):
        made = []

        class Conn:
            closed = False
            broken = False

            def close(self):
                self.closed = True

        fake = mock.MagicMock()
        fake.connect.side_effect = lambda **k: made.append(Conn()) or made[-1]
        fake_types = mock.MagicMock()
        with mock.patch.dict(sys.modules, {"psycopg": fake, "psycopg.types": fake_types,
                                           "psycopg.types.json": fake_types.json}):
            from intake_service import store
            st = store.PgStore(host="h", port=5432, dbname="d", user="u", password=settings.Secret("p"),
                               max_idle_s=60.0)
            now = [1000.0]
            with mock.patch.object(store.time, "monotonic", lambda: now[0]):
                c1 = st._get()
                st._put(c1)
                now[0] += 30
                self.assertIs(st._get(), c1, "a connection idle under max_idle is reused")
                st._put(c1)
                now[0] += 61
                c2 = st._get()
        self.assertIsNot(c2, c1)
        self.assertTrue(c1.closed, "the stale connection is closed, not leaked")

    def test_the_store_max_idle_is_below_the_db_relay_idle_timeout(self):
        d = _compose()
        relay_idle = float(d["services"]["openbrain-intake-dbrelay"]["environment"]["INTAKE_RELAY_IDLE_SECONDS"])
        from intake_service import store
        self.assertLess(store.MAX_IDLE_SECONDS, relay_idle)
        llm_idle = float(d["services"]["openbrain-intake-llmrelay"]["environment"]["INTAKE_RELAY_IDLE_SECONDS"])
        from intake import config as libconfig
        self.assertGreater(llm_idle, libconfig.SECOND_OPINION_TIMEOUT_SECONDS,
                           "the LLM relay must not cut a judge ask that is still inside its timeout")


if __name__ == "__main__":
    unittest.main()
