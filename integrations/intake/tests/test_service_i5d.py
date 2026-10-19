"""intake-i5d: the FINAL intake service-hardening item (operator D51(a); the intake-i5c tester's TC-1..TC-4
and the review's RV5-1). Every class here failed on OB1 a222ec72 (journal/evidence/intake-i5d/red-*.txt).

  TC-2   the parent parses the request and derives the announcement itself (connector binding, key =
         source/external_id/sha256(raw)) BEFORE it dispatches; a worker whose "started" is not exactly
         that is dropped and nothing is stored (before: a self-consistent planted envelope was stored)
  RV5-1  no parent->worker send is unguarded or unbounded, and run() drops the worker on ANY
         unexpected exception: a worker that exits right after "started" (or shuts its read side down)
         no longer leaves the pool wedged `busy`
  TC-1   a worker runs in its own session; the reap kills the whole process group, so a grandchild
         dies with its worker and the reap does not wait 5 s on a sentinel the grandchild holds
  TC-3   the reap closes the process object and stored exceptions carry no traceback, so a killed
         worker's fds are released without the cyclic GC
  TC-4   the parent's announcement check decodes the raw once (validate's), not twice

The Unix-only cases (a byte-stream pipe, fork, process groups, /proc) run in the image.
"""
import gc
import os
import shutil
import tempfile
import time
import unittest
from unittest import mock

from tests import i5d_workers
from tests import service_support as ss
from tests.test_service_i5c import HOLD, WALL, _Hostile, _pool, _wait_ready

from intake_service import wire
from intake_service import pool as poolmod

UNIX = os.name == "posix"


def _env(**kv):
    saved = {k: os.environ.get(k) for k in kv}
    os.environ.update(kv)
    return saved


def _restore(saved):
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _state(pid: int) -> str:
    """'gone', 'zombie' (dead, not reaped by its new parent) or 'alive'."""
    try:
        with open(f"/proc/{pid}/stat") as fh:
            st = fh.read().rsplit(")", 1)[1].split()[0]
    except OSError:
        return "gone"
    return "zombie" if st in ("Z", "X") else "alive"


# -- TC-2 ----------------------------------------------------------------------------------------------
class TC2TheParentDerivesTheIdentity(_Hostile, unittest.TestCase):
    def _service(self, main, how):
        from tests.test_service_core import service
        tmp = tempfile.mkdtemp(prefix="i5d-")
        saved = _env(INTAKE_TEST_ONCE=os.path.join(tmp, "once"), INTAKE_TEST_MISMATCH=how,
                     INTAKE_TEST_HOLD=str(HOLD))
        try:
            with mock.patch.object(poolmod, "_worker_main", main):
                p = _pool()
                try:
                    svc, store, _ = service(pool=p)
                    code, out = svc.handle("research", ss.envelope_bytes(connector="research"))
                    new = _wait_ready(p, -1)
                    return code, out, store, p.deaths, new
                finally:
                    p.close()
        finally:
            _restore(saved)
            shutil.rmtree(tmp, ignore_errors=True)

    def test_a_planted_announcement_is_dropped_and_nothing_is_stored(self):
        for how in ("raw", "external_id", "source"):
            with self.subTest(how):
                code, out, store, deaths, new = self._service(i5d_workers.mismatch_main, how)
                self.assertEqual(store.items, {}, "an item was stored under the worker's identity")
                self.assertEqual(store.raw, {}, "bronze was stored from the worker's announcement")
                self.assertEqual(deaths, 1, "the worker that lied about the request was not dropped")
                self.assertIsNotNone(new)
                self.assertNotEqual(code, 200)

    def test_the_parent_refuses_a_foreign_connector_and_a_bad_body_without_a_worker(self):
        p = _pool()
        try:
            busy_before = p.status()["busy"]
            out = p.run(ss.envelope_bytes(connector="mcp"), lambda i: "this key is not valid for connector 'mcp'")
            self.assertEqual(out.kind, "skipped")
            self.assertEqual(out.started["envelope"]["connector"], "mcp")
            self.assertEqual(p.run(b"[1, 2", lambda i: None).kind, "bad")
            self.assertEqual(p.run(b"[1, 2]", lambda i: None).kind, "bad")
            self.assertEqual((p.deaths, p.kills, p.status()["busy"]), (0, 0, busy_before))
            ok = p.run(ss.envelope_bytes(), lambda i: None)
            self.assertEqual(ok.kind, "result")
            self.assertEqual(ok.result.key.sha256, ok.started["key"]["sha256"])
        finally:
            p.close()


# -- RV5-1 ---------------------------------------------------------------------------------------------
class RV51NoWorkerFailureWedgesThePool(_Hostile, unittest.TestCase):
    def _assert_not_wedged(self, r):
        self.assertIn(r["out"].kind, ("died", "killed"), r["out"].detail)
        self.assertEqual(r["deaths"] + r["kills"], 1)
        self.assertIsNotNone(r["new"], "the worker was never replaced: the pool is wedged")
        self.assertEqual(r["again"].kind, "result", "the next request is not served")

    def _run(self, main, **kw):
        try:
            return self.hostile(main, **kw)
        except Exception as e:  # noqa: BLE001 - the pre-i5d pool raises BrokenPipeError out of run()
            self.fail(f"run() raised {type(e).__name__}: {e} (the worker is left busy forever)")

    def test_a_worker_that_exits_after_started_is_replaced(self):
        self._assert_not_wedged(self._run(i5d_workers.exit_after_started_main, gate=lambda i: time.sleep(0.3)))

    @unittest.skipUnless(UNIX, "SHUT_RD on a socket pair (Linux)")
    def test_a_worker_that_shuts_its_read_side_is_replaced(self):
        self._assert_not_wedged(self._run(i5d_workers.shutrd_main))

    def test_any_unexpected_exception_in_run_drops_the_worker(self):
        p = _pool()
        try:
            pid = p.status_pids()[0]
            with mock.patch.object(wire, "done_from_wire", side_effect=RuntimeError("boom")):
                try:
                    out = p.run(ss.envelope_bytes(), lambda i: None)
                except RuntimeError:
                    self.fail("run() raised: the worker is left busy forever")
            self.assertEqual(out.kind, "died")
            self.assertEqual(p.status()["busy"], 0)
            self.assertIsNotNone(_wait_ready(p, pid), "the worker was not replaced")
            self.assertEqual(p.run(ss.envelope_bytes(), lambda i: None).kind, "result")
        finally:
            p.close()


# -- TC-1 / F-3 ---------------------------------------------------------------------------------------
@unittest.skipUnless(UNIX, "fork and process groups")
class TC1TheReapKillsTheProcessGroup(_Hostile, unittest.TestCase):
    def test_a_grandchild_dies_with_its_worker_and_the_reap_does_not_wait(self):
        tmp = tempfile.mkdtemp(prefix="i5d-gc-")
        gcfile = os.path.join(tmp, "gc.pid")
        try:
            r = self.hostile(i5d_workers.grandchild_main, {"INTAKE_TEST_GC_FILE": gcfile})
            self.assertEqual(r["out"].kind, "killed")
            self.assertLess(r["took"], WALL + 2.0, f"the reap waited: {r['took']:.2f}s with a {WALL}s clock")
            with open(gcfile) as fh:
                gpid = int(fh.read())
            self.assertIn(_state(gpid), ("gone", "zombie"), "the grandchild outlived its worker's reap")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# -- TC-3 ----------------------------------------------------------------------------------------------
@unittest.skipUnless(UNIX and os.path.isdir("/proc/self/fd"), "/proc fd count")
class TC3FdsReleasedWithoutTheCyclicGC(unittest.TestCase):
    def test_the_fd_count_returns_to_baseline_after_kills_without_gc(self):
        kills = 6
        saved = _env(INTAKE_TEST_HOLD=str(HOLD))
        gc.collect()
        gc.disable()
        try:
            with mock.patch.object(poolmod, "_worker_main", i5d_workers.always_partial_main):
                p = _pool()
                try:
                    base = len(os.listdir("/proc/self/fd"))
                    for _ in range(kills):
                        pid = p.status_pids()[0]
                        self.assertEqual(p.run(ss.envelope_bytes(), lambda i: None).kind, "killed")
                        self.assertIsNotNone(_wait_ready(p, pid))
                    time.sleep(0.5)
                    after = len(os.listdir("/proc/self/fd"))
                finally:
                    p.close()
        finally:
            gc.enable()
            _restore(saved)
        self.assertLessEqual(after - base, 1, f"fds {base} -> {after} after {kills} kills without gc.collect()")


# -- TC-4 ----------------------------------------------------------------------------------------------
class TC4TheRawIsDecodedOnce(unittest.TestCase):
    def test_started_from_wire_decodes_the_raw_once(self):
        import base64
        from intake import revisions
        raw = b"A plain paragraph about gardening." * 100
        info = {"key": revisions.key_for("web", "item-1", raw).to_dict(),
                "envelope": {"source": "web", "connector": "research", "external_id": "item-1",
                             "fetched_at": "2026-10-15T10:00:00+00:00", "content_type": "text/plain",
                             "raw": raw, "metadata": {}, "links": []}}
        payload = wire.started_to_wire(info)
        real = base64.b64decode
        calls = []
        with mock.patch("base64.b64decode", side_effect=lambda *a, **k: calls.append(1) or real(*a, **k)):
            back = wire.started_from_wire(payload)
        self.assertEqual(back, info)
        self.assertEqual(len(calls), 1, "the raw is base64-decoded twice in the parent")


if __name__ == "__main__":
    unittest.main()
