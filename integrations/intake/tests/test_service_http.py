"""I5 HTTP surface: POST /v1/intake, GET /v1/stats, GET /metrics, GET /healthz.
Auth by a per-caller key from the environment: no key -> 401, a wrong key -> 403; a body over
the limit -> 413 before it is read; no secret in any log line. The router is driven directly
(the test process has sockets disabled); the real socket path is the e2e run."""
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

from tests import service_support as ss
from tests.service_memory import InlinePool, MemoryStore
from tests.test_service_core import body

from intake import second_opinion
from intake_service import app, core, settings
from intake_service import web as svchttp
from intake_service.metrics import Metrics
from intake_service.weights import WeightsRefused, verify_model_dir


def router(env=None):
    s = settings.load(ss.base_env(**(env or {})))
    store = MemoryStore()
    judge = second_opinion.Judge(lambda r: None, cfg=s.second_opinion, env={})
    svc = core.Intake(s, InlinePool(ss.zero()), store, Metrics(), judge=judge)
    return svchttp.Router(svc, s), store


def call(r, method, path, headers=None, data=b"", declare=None):
    headers = dict(headers or {})
    if method == "POST" and "Content-Length" not in headers and declare is None:
        headers["Content-Length"] = str(len(data))
    if declare is not None:
        headers["Content-Length"] = declare
    reads = []

    def read(n):
        reads.append(n)
        return data[:n]

    resp = r.dispatch(method, path, headers, read)
    return resp, reads


def auth(connector="research"):
    return {"Authorization": "Bearer " + ss.CALLER_KEYS[connector]}


class Auth(unittest.TestCase):
    def test_no_key_is_401_and_the_body_is_never_read(self):
        r, store = router()
        for h in ({}, {"Authorization": ""}, {"Authorization": "Basic abc"}, {"Authorization": "Bearer"}):
            with self.subTest(h=h):
                resp, reads = call(r, "POST", "/v1/intake", h, body())
                self.assertEqual(resp.status, 401)
                self.assertEqual(reads, [])
                self.assertIn(("WWW-Authenticate", 'Bearer realm="intake"'), resp.headers)
        self.assertEqual(store.items, {})

    def test_a_wrong_key_is_403(self):
        r, store = router()
        for k in ("wrong" * 8, ss.CALLER_KEYS["research"][:-1], ss.DB_PASSWORD, ss.SO_KEY):
            resp, reads = call(r, "POST", "/v1/intake", {"Authorization": "Bearer " + k}, body())
            self.assertEqual(resp.status, 403)
            self.assertEqual(reads, [])
        self.assertEqual(store.items, {})

    def test_the_right_key_is_200(self):
        r, store = router()
        resp, _ = call(r, "POST", "/v1/intake", auth(), body())
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(resp.body)["verdict"], "clean")

    def test_stats_and_metrics_need_a_key_healthz_does_not(self):
        r, _ = router()
        self.assertEqual(call(r, "GET", "/v1/stats")[0].status, 401)
        self.assertEqual(call(r, "GET", "/metrics")[0].status, 401)
        self.assertEqual(call(r, "GET", "/v1/stats", auth())[0].status, 200)
        self.assertEqual(call(r, "GET", "/metrics", auth())[0].status, 200)
        resp, _ = call(r, "GET", "/healthz")
        self.assertEqual(resp.status, 200)
        self.assertTrue(json.loads(resp.body)["ok"])


class Limits(unittest.TestCase):
    def test_oversize_is_413_before_the_body_is_read(self):
        r, store = router({"INTAKE_MAX_REQUEST_BYTES": "4096"})
        resp, reads = call(r, "POST", "/v1/intake", auth(), b"x" * 10, declare="4097")
        self.assertEqual(resp.status, 413)
        self.assertEqual(reads, [])
        resp, reads = call(r, "POST", "/v1/intake", auth(), body(), declare=str(len(body())))
        self.assertEqual(resp.status, 200)

    def test_a_missing_or_bad_length_or_chunked_body_is_refused(self):
        r, _ = router()
        self.assertEqual(r.dispatch("POST", "/v1/intake", auth(), lambda n: b"").status, 411)
        for bad in ("-1", "abc", "1e3", "", " 12"):
            self.assertEqual(call(r, "POST", "/v1/intake", auth(), b"", declare=bad)[0].status, 400)
        h = {**auth(), "Transfer-Encoding": "chunked", "Content-Length": "5"}
        self.assertEqual(r.dispatch("POST", "/v1/intake", h, lambda n: b"").status, 411)

    def test_a_short_body_is_400(self):
        r, _ = router()
        resp, _ = call(r, "POST", "/v1/intake", auth(), b'{"a":', declare="500")
        self.assertEqual(resp.status, 400)

    def test_unknown_paths_and_methods(self):
        r, _ = router()
        self.assertEqual(call(r, "GET", "/v1/intake", auth())[0].status, 405)
        self.assertEqual(call(r, "GET", "/nope", auth())[0].status, 404)
        self.assertEqual(call(r, "DELETE", "/v1/intake", auth())[0].status, 405)

    def test_inflight_cap_is_503(self):
        r, _ = router({"INTAKE_MAX_INFLIGHT": "1"})
        r.inflight.acquire()
        try:
            self.assertEqual(call(r, "POST", "/v1/intake", auth(), body())[0].status, 503)
        finally:
            r.inflight.release()


class NoSecretInLogs(unittest.TestCase):
    def test_requests_log_no_secret(self):
        with ss.LogCapture() as cap:
            r, _ = router()
            call(r, "POST", "/v1/intake", auth(), body())
            call(r, "POST", "/v1/intake", {"Authorization": "Bearer " + ss.DB_PASSWORD}, body())
            call(r, "POST", "/v1/intake", auth("mcp"), body())
            call(r, "GET", "/v1/stats", auth())
        self.assertIn("/v1/intake", cap.text)
        for s in ss.SECRETS:
            self.assertNotIn(s, cap.text)


class Startup(unittest.TestCase):
    def test_invalid_d40_config_refuses_to_start(self):
        with ss.LogCapture() as cap:
            code = app.main(["serve"], env=ss.base_env(INTAKE_D2_WEAK_RULE_JUDGE_CLEAN="maybe"),
                            start=False)
        self.assertEqual(code, app.EXIT_CONFIG)
        self.assertIn("INTAKE_D2_WEAK_RULE_JUDGE_CLEAN", cap.text)

    def test_missing_weights_refuse_to_start(self):
        with tempfile.TemporaryDirectory() as d:
            code = app.main(["serve"], env=ss.base_env(INTAKE_CLASSIFIER_DIR=d), start=False)
        self.assertEqual(code, app.EXIT_WEIGHTS)

    def test_tampered_weights_refuse_to_start(self):
        with tempfile.TemporaryDirectory() as d:
            pins = {}
            for name in ("config.json", "tokenizer.json", "model.safetensors"):
                data = os.urandom(1000)
                Path(d, name).write_bytes(data)
                pins[name] = (len(data), hashlib.sha256(data).hexdigest())
            verify_model_dir(d, pins)
            p = Path(d, "model.safetensors")
            b = bytearray(p.read_bytes())
            b[500] ^= 1
            p.write_bytes(bytes(b))
            with self.assertRaises(WeightsRefused) as cm:
                verify_model_dir(d, pins)
            self.assertIn("model.safetensors", str(cm.exception))
            code = app.main(["serve"], env=ss.base_env(INTAKE_CLASSIFIER_DIR=d), start=False, files=pins)
            self.assertEqual(code, app.EXIT_WEIGHTS)
            Path(d, "model.safetensors").write_bytes(b"x" * 1000)
            self.assertEqual(app.main(["serve"], env=ss.base_env(INTAKE_CLASSIFIER_DIR=d), start=False,
                                      files=pins), app.EXIT_WEIGHTS)


if __name__ == "__main__":
    unittest.main()
