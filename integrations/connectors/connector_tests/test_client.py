"""The intake client: what it refuses before sending, its bounded deadline (intake's own pattern),
and what it does with every intake answer (outcomes.py's table)."""
import io
import json
import logging
import os
import socket
import threading
import time
import unittest

import connector_tests  # noqa: F401 - sys.path

from connector_kit import envelope as kit
from connector_kit.client import (ClientConfigError, IntakeClient, RequestTooLarge, RetryPolicy, check_url)
from connector_kit.secret import KeyFileError, Secret, load_key_file
from connector_kit.testkit.fake_intake import FakeIntake

KEY = "ck-" + "5e" * 20
CID = "reference-file"
FAST = RetryPolicy(max_attempts=4, base_s=0.01, cap_s=0.02, retry_after_cap_s=0.02, budget_s=10)


def env(ext="file/a.txt", raw="hello", connector=CID, **kw):
    return kit.build(connector=connector, connector_version="1", source="local-file", external_id=ext,
                     content_type="text/plain", raw=raw, fetched_at="2026-10-19T10:00:00+00:00", **kw)


def client(url, **kw):
    kw.setdefault("retry", FAST)
    kw.setdefault("timeout_s", 5.0)
    return IntakeClient(url, Secret(KEY), connector=CID, **kw)


class _Evil:
    """A raw TCP server that misbehaves on purpose: answers with `script(conn)`."""

    def __init__(self, script):
        self.script = script
        self.s = socket.socket()
        self.s.bind(("127.0.0.1", 0))
        self.s.listen(8)
        self.port = self.s.getsockname()[1]
        self.conns = []
        self.t = threading.Thread(target=self._loop, daemon=True)
        self.t.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}/v1/intake"

    def _loop(self):
        while True:
            try:
                c, _ = self.s.accept()
            except OSError:
                return
            self.conns.append(c)
            threading.Thread(target=self._one, args=(c,), daemon=True).start()

    def _one(self, c):
        try:
            self.script(c)
        except OSError:
            pass

    def close(self):
        self.s.close()
        for c in self.conns:
            try:
                c.close()
            except OSError:
                pass


def _read_request(c):
    data = b""
    c.settimeout(5)
    while b"\r\n\r\n" not in data:
        data += c.recv(65536)
    head, _, rest = data.partition(b"\r\n\r\n")
    n = 0
    for line in head.split(b"\r\n"):
        if line.lower().startswith(b"content-length:"):
            n = int(line.split(b":")[1])
    while len(rest) < n:
        rest += c.recv(65536)
    return head, rest


class Refusals(unittest.TestCase):
    def test_the_url_is_intakes_only(self):
        for bad in ("https://intake:8000/v1/intake", "http://intake:8000/v1/intake?x=1", "http://u:p@intake/v1/intake",
                    "http://intake:8000/v1/other", "http:///v1/intake", "ftp://intake/v1/intake",
                    "http://intake:8000/v1/intake#f", "http://intake:99999/v1/intake"):
            with self.subTest(url=bad):
                with self.assertRaises(ClientConfigError):
                    check_url(bad)
        self.assertEqual(check_url("http://openbrain-intake:8000/v1/intake"), ("openbrain-intake", 8000))

    def test_the_key_is_a_secret_from_a_file(self):
        with self.assertRaises(ClientConfigError):
            IntakeClient("http://i:8000/v1/intake", KEY, connector=CID)
        for bad in ("short", "x" * 257, "has blank" + "x" * 30, "comma," + "x" * 30, "é" * 40):
            with self.assertRaises(KeyFileError):
                Secret(bad)
        s = Secret(KEY)
        self.assertNotIn(KEY, repr(s) + str(s) + repr(client("http://i:8000/v1/intake")))
        with self.assertRaises(KeyFileError) as cm:
            load_key_file(os.path.join(os.path.dirname(__file__), "no-such-key-file"))
        self.assertNotIn(KEY, str(cm.exception))

    def test_only_checked_envelopes_of_this_connector_are_sent(self):
        with FakeIntake({CID: KEY}) as fake:
            c = client(fake.url)
            with self.assertRaises(kit.InvalidEnvelope):
                c.send({"source": "x"})                              # not an Envelope
            good = env()
            forged = kit.Envelope(body={**good.body, "content_type": "application/pdf"}, key=good.key)
            with self.assertRaises(kit.InvalidEnvelope):
                c.send(forged)                                       # a hand-made Envelope is re-checked
            wrong_key = kit.Envelope(body=good.body, key=kit.Key("x", "y", "0" * 64))
            with self.assertRaises(kit.InvalidEnvelope):
                c.send(wrong_key)
            with self.assertRaises(kit.InvalidEnvelope):
                c.send(env(connector="other-connector"))             # another connector's envelope
            self.assertEqual(fake.received, [], "nothing reached intake")

    def test_a_body_over_the_request_cap_is_not_sent(self):
        with FakeIntake({CID: KEY}) as fake:
            c = client(fake.url, max_request_bytes=4096)
            with self.assertRaises(RequestTooLarge):
                c.send(env(raw="x" * 5000))
            self.assertEqual(fake.received, [])


class Outcomes(unittest.TestCase):
    def run_one(self, outcomes, default="clean", **kw):
        with FakeIntake({CID: KEY}, default=default) as fake:
            fake.script("file/a.txt", *outcomes)
            sub = client(fake.url, **kw).submit(env())
            return sub, fake

    def test_each_result_label_is_recorded_once(self):
        for label in ("clean", "suspicious", "pending", "injected", "rejected"):
            with self.subTest(label=label):
                sub, fake = self.run_one([label])
                self.assertEqual((sub.final, sub.outcome.label, sub.attempts, len(fake.received)),
                                 ("record", label, 1, 1))
                self.assertIsNotNone(sub.outcome.intake_id)

    def test_clean_text_is_dropped_unless_the_client_asks(self):
        """The default keeps no text (a connector is a producer); return_clean_text=True (the
        search gate) gets intake's text, title and labels for clean ONLY."""
        sub, _ = self.run_one(["clean"])
        self.assertEqual(dict(sub.outcome.extra), {})
        sub, _ = self.run_one(["clean"], return_clean_text=True)
        self.assertEqual(sub.outcome.extra["text"], "hello")
        self.assertEqual(sub.outcome.extra["labels"]["connector"], CID)
        self.assertIn("title", sub.outcome.extra)
        for label in ("suspicious", "pending", "injected", "rejected"):
            with self.subTest(label=label):
                sub, _ = self.run_one([label], return_clean_text=True)
                self.assertEqual((sub.outcome.label, dict(sub.outcome.extra)), (label, {}))

    def test_503_and_408_are_retried_then_recorded(self):
        for code in (503, "503:busy", "503:not-ready", "503:inflight", "503:no-key", 408):
            with self.subTest(code=code):
                sub, fake = self.run_one([code, code, "pending"])
                self.assertEqual((sub.final, sub.outcome.label, sub.attempts), ("record", "pending", 3))
                self.assertEqual([o.action for o in sub.history], ["retry", "retry", "record"])

    def test_retries_end_deferred_at_the_attempt_budget(self):
        sub, fake = self.run_one([], default=503)
        self.assertEqual((sub.final, sub.attempts, len(fake.received)), ("deferred", 4, 4))

    def test_401_403_413_422_400_500_stop_without_a_retry(self):
        for code in (401, 403, 413, 422, 400, 500):
            with self.subTest(code=code):
                sub, fake = self.run_one([code])
                self.assertEqual((sub.final, sub.outcome.http, sub.attempts, len(fake.received)),
                                 ("stop", code, 1, 1))

    def test_the_real_auth_answers(self):
        with FakeIntake({CID: KEY, "other": "ok-" + "7" * 40}) as fake:
            bad = IntakeClient(fake.url, Secret("zz-" + "9" * 40), connector=CID, retry=FAST)
            self.assertEqual((bad.submit(env()).final, bad.send(env()).http), ("stop", 403))
            other = IntakeClient(fake.url, Secret("ok-" + "7" * 40), connector=CID, retry=FAST)
            o = other.send(env())          # a valid key, but for another connector: 403 after stage 1
            self.assertEqual((o.action, o.http), ("stop", 403))
            self.assertIn("not valid for connector", o.reason)

    def test_a_repeat_and_a_revision(self):
        with FakeIntake({CID: KEY}) as fake:
            c = client(fake.url)
            a = c.submit(env()).outcome
            b = c.submit(env()).outcome
            d = c.submit(env(raw="changed")).outcome
        self.assertEqual((a.repeat, b.repeat, b.intake_id), (False, True, a.intake_id))
        self.assertEqual((d.repeat, d.revision), (False, 2))

    def test_retry_after_is_honoured_and_capped(self):
        p = RetryPolicy(base_s=1, cap_s=30, retry_after_cap_s=60)
        self.assertEqual(p.delay(1, None), 1)
        self.assertEqual(p.delay(3, None), 4)
        self.assertEqual(p.delay(10, None), 30)
        self.assertEqual(p.delay(1, 30), 30)
        self.assertEqual(p.delay(1, 3600), 60)
        waits = []
        with FakeIntake({CID: KEY}) as fake:
            fake.script("file/a.txt", 503, "clean")
            c = IntakeClient(fake.url, Secret(KEY), connector=CID, sleep=waits.append,
                             retry=RetryPolicy(base_s=0.5, retry_after_cap_s=45))
            self.assertEqual(c.submit(env()).final, "record")
        self.assertEqual(waits, [30.0], "the 503's Retry-After: 30 was used")


class Protocol(unittest.TestCase):
    def evil(self, script):
        e = _Evil(script)
        self.addCleanup(e.close)
        return e

    def test_an_answer_for_another_key_or_connector_stops(self):
        def wrong(c):
            _read_request(c)
            doc = FakeIntake.result_doc("clean", "id-1", CID, {"source": "local-file", "external_id": "other",
                                                               "sha256": "0" * 64}, 1, None)
            body = json.dumps(doc).encode()
            c.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s" % (len(body), body))
            c.close()
        o = client(self.evil(wrong).url).send(env())
        self.assertEqual((o.action, o.http), ("stop", 200))
        self.assertIn("another key", o.reason)

    def test_text_for_an_injected_item_is_a_protocol_error(self):
        e = env()

        def leaky(c):
            _read_request(c)
            doc = FakeIntake.result_doc("injected", "id-1", CID, e.key.to_dict(), 1, None)
            doc["text"] = "payload"
            body = json.dumps(doc).encode()
            c.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s" % (len(body), body))
            c.close()
        o = client(self.evil(leaky).url).send(e)
        self.assertEqual(o.action, "stop")

    def test_a_3xx_is_not_followed(self):
        def redirect(c):
            _read_request(c)
            c.sendall(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://example.com/v1/intake\r\n"
                      b"Content-Length: 0\r\nConnection: close\r\n\r\n")
            c.close()
        o = client(self.evil(redirect).url).send(env())
        self.assertEqual((o.action, o.http), ("stop", 307))

    def test_a_stall_after_the_headers_ends_at_the_one_deadline(self):
        def drip(c):
            _read_request(c)
            c.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n")
            for _ in range(100):
                c.sendall(b"x")
                time.sleep(0.2)
        t0 = time.monotonic()
        o = client(self.evil(drip).url, timeout_s=1.0).send(env())
        took = time.monotonic() - t0
        self.assertEqual((o.action, o.http), ("retry", None))
        self.assertIn("timeout", o.reason)
        self.assertLess(took, 2.5, "a dripping reply is cut at the deadline, not per byte")

    def test_dripping_headers_end_at_the_one_deadline(self):
        # each recv() alone would wait up to the socket timeout; only the watchdog bounds the sum
        def drip_head(c):
            _read_request(c)
            for b in b"HTTP/1.1 200 OK\r\nX-Slow: " + b"y" * 200:
                c.sendall(bytes([b]))
                time.sleep(0.3)
        t0 = time.monotonic()
        o = client(self.evil(drip_head).url, timeout_s=1.0).send(env())
        self.assertEqual((o.action, o.http), ("retry", None))
        self.assertLess(time.monotonic() - t0, 2.5, "a header drip is cut at the deadline")

    def test_no_headers_at_all_ends_at_the_deadline(self):
        def silent(c):
            _read_request(c)
            time.sleep(10)
        t0 = time.monotonic()
        o = client(self.evil(silent).url, timeout_s=1.0).send(env())
        self.assertEqual(o.action, "retry")
        self.assertLess(time.monotonic() - t0, 2.5)

    def test_a_reply_over_the_cap_or_cut_short(self):
        def big(c):
            _read_request(c)
            c.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 300000\r\nConnection: close\r\n\r\n" + b"x" * 300000)
            c.close()

        def short(c):
            _read_request(c)
            c.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 500\r\nConnection: close\r\n\r\n{}")
            c.close()
        o = client(self.evil(big).url, max_reply_bytes=100000).send(env())
        self.assertEqual((o.action, o.http), ("retry", None))
        self.assertIn("oversize", o.reason)
        o = client(self.evil(short).url).send(env())
        self.assertEqual((o.action, o.http), ("retry", None))

    def test_connection_refused_is_a_retry(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        sub = client(f"http://127.0.0.1:{port}/v1/intake").submit(env())
        self.assertEqual((sub.final, sub.attempts), ("deferred", 4))

    def test_no_proxy_is_used(self):
        old = {k: os.environ.get(k) for k in ("HTTP_PROXY", "http_proxy", "ALL_PROXY")}
        try:
            for k in old:
                os.environ[k] = "http://127.0.0.1:9"
            with FakeIntake({CID: KEY}) as fake:
                self.assertEqual(client(fake.url).submit(env()).final, "record")
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_the_request_on_the_wire(self):
        seen = {}

        def capture(c):
            head, body = _read_request(c)
            seen["head"], seen["body"] = head.decode(), body
            c.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
            c.close()
        e = env()
        client(self.evil(capture).url).send(e)
        lines = seen["head"].split("\r\n")
        self.assertEqual(lines[0], "POST /v1/intake HTTP/1.1")
        hdrs = {ln.split(":", 1)[0].lower(): ln.split(":", 1)[1].strip() for ln in lines[1:]}
        self.assertEqual(hdrs["authorization"], "Bearer " + KEY)
        self.assertEqual(hdrs["content-type"], "application/json")
        self.assertEqual(int(hdrs["content-length"]), len(seen["body"]))
        self.assertNotIn("transfer-encoding", hdrs)
        self.assertEqual(json.loads(seen["body"]), dict(e.body))

    def test_the_key_is_never_logged(self):
        buf = io.StringIO()
        h = logging.StreamHandler(buf)
        root = logging.getLogger()
        root.addHandler(h)
        old = root.level
        root.setLevel(logging.DEBUG)
        try:
            with FakeIntake({CID: KEY}) as fake:
                fake.script("file/a.txt", 503, 403)
                client(fake.url).submit(env())
            client("http://127.0.0.1:1/v1/intake", retry=RetryPolicy(max_attempts=1)).submit(env())
        finally:
            root.removeHandler(h)
            root.setLevel(old)
        text = buf.getvalue()
        self.assertIn("http 503", text)
        self.assertNotIn(KEY, text)
        self.assertNotIn("Bearer", text)


if __name__ == "__main__":
    unittest.main()
