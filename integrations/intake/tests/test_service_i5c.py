"""intake-i5c: the last intake pre-deploy items (DESIGN-intake section 12 item 14; the intake-i5b
tester's TF-1/2/3/5/7 and the review's RV-3/RV-4). Every class here failed on OB1 46a4431
(journal/evidence/intake-i5c/red-*.txt).

  TF-1  every parent-side read of a worker frame is bounded by the phase wall clock - the length
        header AND the body: a partial frame then a stall is cut at the clock, the worker killed
        and replaced (before: the parent waited until the worker exited, i.e. forever)
  TF-2  non-finite numbers are refused on decode: NaN, Infinity, -Infinity and an overflowing
        literal such as 1e99999 (which json decodes to inf)
  TF-3  the message order is enforced (no `done` before "started", no `done` but a result, one
        "started") and the result's key must be the announced one
  TF-5  the e2e G[K] check no longer races a fast-rejected shape against the 1 ms stages clock
  TF-7  the announced envelope is re-checked in the parent by stage 1 itself (envelope.validate):
        the allowed fields, the sizes (metadata 64 KiB, 1000 links of 1..2048 characters, raw
        5 MiB), the slugs, the timestamp, the content type; and the key's sha256 is the raw's
  RV-3  the worker's body cap is the configured request cap (INTAKE_MAX_REQUEST_BYTES)
  RV-4  PgStore._get closes a closed/broken pooled connection it skips

The Unix-only cases (a partial frame needs a byte-stream pipe; Windows pipes are message-mode)
run in the image: the test plan's in-container unit run.
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from tests import i5c_workers
from tests import service_support as ss

from intake_service import app, settings, wire
from intake_service import pool as poolmod

HERE = Path(__file__).resolve().parent
UNIX_PIPE = os.name == "posix"
WALL = 2.0     # every phase clock in these tests
HOLD = 30.0    # how long a stalling stand-in holds before it exits on its own


def _pool(**kw):
    args = dict(factory="tests.service_support:zero", wall_stages_s=WALL, wall_transfer_s=WALL,
                wall_classifier_s=WALL, start_timeout_s=60.0, queue_wait_s=10.0, respawn_backoff_s=1.0)
    args.update(kw)
    p = poolmod.WorkerPool(1, **args)
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


class _Hostile:
    """Run one job against a pool whose worker is `main`; the first job meets the hostile move."""

    def hostile(self, main, env=None, gate=None, body=None, **kw):
        tmp = tempfile.mkdtemp(prefix="i5c-")
        extra = {"INTAKE_TEST_ONCE": os.path.join(tmp, "once"), "INTAKE_TEST_HOLD": str(HOLD), **(env or {})}
        saved = {k: os.environ.get(k) for k in extra}
        os.environ.update(extra)
        try:
            with mock.patch.object(poolmod, "_worker_main", main):
                p = _pool(**kw)
                try:
                    pid = p.status_pids()[0]
                    t0 = time.monotonic()
                    out = p.run(body or ss.envelope_bytes(), gate or (lambda i: None))
                    took = time.monotonic() - t0
                    new = _wait_ready(p, pid) if p.deaths + p.kills else None
                    again = p.run(ss.envelope_bytes(), lambda i: None) if new else None
                    return {"out": out, "took": took, "deaths": p.deaths, "kills": p.kills, "pid": pid,
                            "new": new, "again": again}
                finally:
                    p.close()
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            shutil.rmtree(tmp, ignore_errors=True)

    def assert_dropped(self, r, kind="died"):
        self.assertEqual(r["out"].kind, kind, r["out"].detail)
        self.assertIsNone(r["out"].result)
        self.assertEqual(r["deaths"] + r["kills"], 1)
        self.assertIsNotNone(r["new"], "the worker was not replaced")
        self.assertNotEqual(r["new"], r["pid"])
        self.assertEqual(r["again"].kind, "result", "the replacement does not serve")


# -- TF-1 ------------------------------------------------------------------------------------------------
@unittest.skipUnless(UNIX_PIPE, "a partial frame needs a byte-stream pipe (Windows pipes are message-mode)")
class TF1PartialFrameIsCutAtTheClock(_Hostile, unittest.TestCase):
    def _assert_cut(self, r, phase):
        self.assertLess(r["took"], WALL + 3.0, f"the parent waited {r['took']:.1f}s, past the {WALL}s clock")
        self.assert_dropped(r, "killed")
        self.assertEqual(r["out"].phase, phase)
        self.assertEqual(r["kills"], 1)

    def test_a_partial_frame_then_a_stall_in_transfer_is_killed_at_the_clock(self):
        self._assert_cut(self.hostile(i5c_workers.partial_transfer_main), "transfer")

    def test_a_partial_frame_then_a_stall_in_stages_is_killed_at_the_clock(self):
        r = self.hostile(i5c_workers.partial_stages_main)
        self._assert_cut(r, "stages")
        self.assertIsNotNone(r["out"].started, "the announced key is kept for the pending row")

    def test_a_partial_length_header_then_a_stall_is_killed_at_the_clock(self):
        self._assert_cut(self.hostile(i5c_workers.partial_header_main), "transfer")

    def test_a_partial_ready_frame_at_start_is_cut_at_the_start_clock(self):
        with mock.patch.object(poolmod, "_worker_main", i5c_workers.partial_ready_main):
            os.environ["INTAKE_TEST_HOLD"] = str(HOLD)
            try:
                p = poolmod.WorkerPool(1, factory="tests.service_support:zero", wall_stages_s=WALL,
                                       wall_transfer_s=WALL, wall_classifier_s=WALL, start_timeout_s=3.0,
                                       queue_wait_s=1.0, respawn_backoff_s=1.0)
                t0 = time.monotonic()
                with self.assertRaises(poolmod.PoolError):
                    p.start()
                took = time.monotonic() - t0
            finally:
                os.environ.pop("INTAKE_TEST_HOLD", None)
        self.assertLess(took, 3.0 + 6.0, f"the start waited {took:.1f}s past its 3 s clock")


# -- TF-2 ------------------------------------------------------------------------------------------------
class TF2NonFiniteNumbersRefused(_Hostile, unittest.TestCase):
    def test_wire_refuses_every_non_finite_number(self):
        a, b = poolmod._CTX.Pipe(duplex=True)
        try:
            for text in ("1e99999", "-1e99999", "NaN", "Infinity", "-Infinity", "1.5e400"):
                a.send_bytes(('["x",' + text + "]").encode())
                with self.assertRaises(wire.WireError, msg=text):
                    wire.recv_msg(b, 1 << 16)
            a.send_bytes(b'["x",1e300,-2.5,0.0,12]')
            self.assertEqual(wire.recv_msg(b, 1 << 16), ["x", 1e300, -2.5, 0.0, 12])
        finally:
            a.close()
            b.close()

    def test_an_overflowing_float_in_a_result_drops_the_worker(self):
        for text in ("1e99999", "-1e99999"):
            with self.subTest(text):
                r = self.hostile(i5c_workers.frame_main, {"INTAKE_TEST_FRAME": i5c_workers.done_frame(text)})
                self.assert_dropped(r)

    def test_a_nan_literal_in_a_result_drops_the_worker(self):
        r = self.hostile(i5c_workers.frame_main, {"INTAKE_TEST_FRAME": i5c_workers.done_frame("NaN")})
        self.assert_dropped(r)


# -- TF-3 ------------------------------------------------------------------------------------------------
class TF3MessageOrderAndKey(_Hostile, unittest.TestCase):
    def _order(self, how, **kw):
        return self.hostile(i5c_workers.order_main, {"INTAKE_TEST_ORDER": how}, **kw)

    def test_done_before_started_is_refused_and_the_worker_replaced(self):
        r = self._order("done_result_first")
        self.assert_dropped(r)
        self.assertLess(r["took"], WALL, "a protocol violation is not waited out to the clock")

    def test_a_skipped_done_before_started_is_refused(self):
        self.assert_dropped(self._order("done_skipped_first"))

    def test_a_skipped_done_from_a_worker_is_refused(self):
        # intake-i5d: was "a result after the parent said skip"; the parent now refuses a foreign
        # connector before it dispatches (tests/test_service_i5d.py), so no worker can answer it
        self.assert_dropped(self._order("skipped_after_started"))

    def test_a_second_started_is_refused(self):
        self.assert_dropped(self._order("second_started"))

    def test_a_result_for_another_key_is_refused(self):
        r = self._order("key_mismatch")
        self.assert_dropped(r)
        self.assertIn("key", r["out"].detail)

    def test_a_keyed_result_without_an_announced_key_is_refused(self):
        self.assert_dropped(self._order("key_without_started"))

    def test_the_legitimate_orders_still_pass(self):
        p = _pool()
        try:
            ok = p.run(ss.envelope_bytes(), lambda i: None)
            self.assertEqual(ok.kind, "result")
            self.assertEqual(ok.result.key.sha256, ok.started["key"]["sha256"])
            skip = p.run(ss.envelope_bytes(), lambda i: "this key is not valid")
            self.assertEqual(skip.kind, "skipped")
            bad = p.run(b"not json", lambda i: None)
            self.assertEqual(bad.kind, "bad")
            rej = p.run(json.dumps({"source": "web"}).encode(), lambda i: None)
            self.assertEqual((rej.kind, rej.result.verdict, rej.result.key), ("result", "rejected", None))
            self.assertEqual(p.deaths + p.kills, 0)
        finally:
            p.close()


# -- TF-7 ------------------------------------------------------------------------------------------------
class TF7AnnouncedEnvelopeChecked(_Hostile, unittest.TestCase):
    CASES = {
        "metadata over 64 KiB": {"envelope": {"metadata": {"x": "y" * 70000}}},
        "1001 links": {"envelope": {"links": ["https://a.example/"] * 1001}},
        "a link over 2048 characters": {"envelope": {"links": ["https://a.example/" + "a" * 2100]}},
        "an empty link": {"envelope": {"links": [""]}},
        "a link that is not a string": {"envelope": {"links": [{"href": "x"}]}},
        "an unknown envelope field": {"extra": {"labels": {"verdict": "clean"}}},
        "a missing envelope field": {"drop": ["fetched_at"]},
        "a source that is not a slug": {"envelope": {"source": "Web Site"}, "key": {"source": "Web Site"}},
        "a connector that is not a slug": {"envelope": {"connector": "../x"}},
        "an external id with a control character": {"envelope": {"external_id": "a\nb"}, "key": {"external_id": "a\nb"}},
        "fetched_at not a timestamp": {"envelope": {"fetched_at": "yesterday"}},
        "a content type outside the allow-list": {"envelope": {"content_type": "application/x-sh"}},
        "raw over 5 MiB": {"envelope": {"raw": "QUFB" * (5 * 1024 * 1024 // 3 + 4)}},
        "a key sha256 that is not the raw's": {"key": {"sha256": "e" * 64}},
    }

    def test_each_invalid_announcement_drops_the_worker(self):
        for name, spec in self.CASES.items():
            with self.subTest(name), tempfile.TemporaryDirectory(prefix="i5c-spec-") as d:
                path = os.path.join(d, "spec.json")
                Path(path).write_text(json.dumps(spec), encoding="utf-8")
                r = self.hostile(i5c_workers.started_main, {"INTAKE_TEST_STARTED_FILE": path})
                self.assert_dropped(r)
                self.assertIn("started", r["out"].detail)

    def test_wire_rebuilds_a_valid_announcement_unchanged(self):
        from intake import revisions
        raw = "Plain text éè about tomatoes.".encode()
        info = {"key": revisions.key_for("web", "item-1", raw).to_dict(),
                "envelope": {"source": "web", "connector": "research", "external_id": "item-1",
                             "fetched_at": "2026-10-15T10:00:00+00:00", "content_type": "text/plain; charset=utf-8",
                             "raw": raw, "metadata": {"a": [1, {"b": None}]}, "links": ["https://a.example/x", "mailto:x"]}}
        back = wire.started_from_wire(json.loads(json.dumps(wire.started_to_wire(info))))
        self.assertEqual(back, info)


# -- TF-5 ------------------------------------------------------------------------------------------------
class TF5KillCheckHasNoRace(unittest.TestCase):
    """The e2e's part K verdict, fed the intake-i5b tester's run-1 answers (semicolon-flood-2 beat the
    1 ms clock with its production answer, `rejected`) and run-2 answers (every shape killed)."""

    def _verdict(self):
        from tests.e2e import run_service_e2e as e2e
        return e2e.k_verdict

    def _fixture(self):
        return json.loads((HERE / "fixtures" / "i5c_gk_runs.json").read_text(encoding="utf-8"))

    def test_a_fast_rejected_shape_with_its_production_answer_passes(self):
        k_verdict = self._verdict()
        fx = self._fixture()
        for run in ("run1", "run2"):
            with self.subTest(run):
                v = k_verdict(fx[run]["k"], fx[run]["a"])
                self.assertTrue(all(ok for ok, _ in v["per_shape"].values()), v)

    def test_a_shape_that_dodges_the_kill_with_another_answer_still_fails(self):
        k_verdict = self._verdict()
        fx = self._fixture()["run1"]
        k = json.loads(json.dumps(fx["k"]))
        k["calc-page-31x64k"] = {"http": 200, "label": "clean", "error": "", "text": None}
        self.assertFalse(k_verdict(k, fx["a"])["per_shape"]["calc-page-31x64k"][0])
        k = json.loads(json.dumps(fx["k"]))
        k["semicolon-flood-2"] = {"http": 200, "label": "clean", "error": "", "text": None}
        self.assertFalse(k_verdict(k, fx["a"])["per_shape"]["semicolon-flood-2"][0])
        k = json.loads(json.dumps(fx["k"]))
        k["semicolon-flood-2"] = {"http": 200, "label": "rejected", "error": "", "text": "leaked"}
        self.assertFalse(k_verdict(k, fx["a"])["per_shape"]["semicolon-flood-2"][0])


# -- RV-3 ------------------------------------------------------------------------------------------------
class RV3WorkerBodyCapIsTheRequestCap(unittest.TestCase):
    def test_serve_builds_the_pool_with_the_configured_request_cap(self):
        seen = {}

        def spy(*a, **k):
            seen.update(k)
            raise poolmod.PoolError("stop here")

        s = settings.load(ss.base_env(INTAKE_MAX_REQUEST_BYTES="2000000"))
        with mock.patch.object(app, "harden_process"), mock.patch.object(app, "seal_secrets"), \
                mock.patch("intake.second_opinion.Judge"), mock.patch("intake_service.pool.WorkerPool", spy):
            with self.assertRaises(poolmod.PoolError):
                app._serve(s, {})
        self.assertEqual(seen.get("max_body_bytes"), 2000000)


# -- RV-4 ------------------------------------------------------------------------------------------------
class RV4BrokenConnectionClosed(unittest.TestCase):
    def test_a_closed_or_broken_pooled_connection_is_closed_when_skipped(self):
        made = []

        class Conn:
            def __init__(self):
                self.closed = False
                self.broken = False
                self.close_calls = 0

            def close(self):
                self.close_calls += 1
                self.closed = True

        fake = mock.MagicMock()
        fake.connect.side_effect = lambda **k: made.append(Conn()) or made[-1]
        fake_types = mock.MagicMock()
        with mock.patch.dict(sys.modules, {"psycopg": fake, "psycopg.types": fake_types,
                                           "psycopg.types.json": fake_types.json}):
            from intake_service import store
            st = store.PgStore(host="h", port=5432, dbname="d", user="u", password=settings.Secret("p"),
                               max_idle_s=60.0)
            c1 = st._get()
            st._put(c1)
            c1.broken = True
            c2 = st._get()
        self.assertIsNot(c2, c1)
        self.assertEqual(c1.close_calls, 1, "the broken connection was skipped without close()")


if __name__ == "__main__":
    unittest.main()
