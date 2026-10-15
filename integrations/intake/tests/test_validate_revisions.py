"""Stage 1 (validate) and stage 2 (idempotency / revisions)."""
import base64
import dataclasses
import unittest

from tests import support
from tests.support import envelope

from intake import limits, pipeline, revisions
from intake.result import IdempotencyKey, IntakeResult


class Validate(unittest.TestCase):
    def rejected(self, env, needle=""):
        r = pipeline.screen(env)
        self.assertEqual(r.verdict, "rejected", r)
        self.assertEqual(r.reasons[0].rule, "validate")
        self.assertIn(needle, r.reasons[0].detail)
        self.assertIsNone(r.text)
        self.assertEqual(r.links, ())
        return r

    def test_allow_list(self):
        for ct in ("text/html", "application/xhtml+xml", "text/plain", "text/markdown",
                   "message/rfc822", "application/json", "TEXT/HTML; charset=utf-8"):
            with self.subTest(ct=ct):
                raw = '{"a": "b"}' if "json" in ct else "hello"
                self.assertNotEqual(pipeline.screen(envelope(raw, ct)).verdict, "rejected")
        for ct in ("application/pdf", "image/png", "text/javascript", "application/octet-stream",
                   "", "text/html2", "text"):
            with self.subTest(ct=ct):
                self.rejected(envelope("x", ct), "content type" if ct else "content_type")

    def test_schema(self):
        good = envelope("hello")
        for k in ("source", "connector", "external_id", "fetched_at", "content_type", "raw"):
            env = dict(good)
            del env[k]
            with self.subTest(missing=k):
                self.rejected(env, "missing")
        self.rejected({**good, "surprise": 1}, "unknown field")
        self.rejected({**good, "raw": 5}, "raw must be a string")
        self.rejected({**good, "source": "Web Source"}, "source must match")
        self.rejected({**good, "fetched_at": "yesterday"}, "ISO 8601")
        self.rejected({**good, "external_id": "a\nb"}, "control characters")
        self.rejected({**good, "metadata": []}, "metadata")
        self.rejected({**good, "metadata": {"x": float("nan")}}, "metadata")
        self.rejected({**good, "links": "https://a.example"}, "links")
        self.rejected({**good, "raw_encoding": "hex"}, "raw_encoding")
        self.rejected("not an object", "object")

    def test_size_cap(self):
        cap = limits.RAW_MAX_BYTES
        self.assertNotEqual(pipeline.screen(envelope("a" * cap)).verdict, "rejected")
        self.rejected(envelope("a" * (cap + 1)), "over")
        self.rejected(envelope("\u00e9" * (cap // 2 + 1)), "over")  # 2 bytes each in UTF-8
        b64 = base64.b64encode(b"a" * (cap + 1)).decode()
        self.rejected(envelope(b64, raw_encoding="base64"), "over")
        self.rejected(envelope("not base64 !!", raw_encoding="base64"), "base64")
        ok = base64.b64encode(b"<p>hi</p>").decode()
        r = pipeline.screen(envelope(ok, "text/html", raw_encoding="base64"))
        self.assertEqual(r.text, "hi")


class _History:
    """An in-memory History that records calls and refuses writes (it has none)."""

    def __init__(self, stored=(), latest=None):
        self.stored = {r.key: r for r in stored}
        self._latest = latest or {}
        self.calls = []

    def get(self, key):
        self.calls.append(("get", key))
        return self.stored.get(key)

    def latest(self, source, external_id):
        self.calls.append(("latest", source, external_id))
        return self._latest.get((source, external_id))


class Revisions(unittest.TestCase):
    def test_key_is_source_id_and_sha256_of_raw(self):
        r = pipeline.screen(envelope("hello"))
        self.assertEqual(r.key, IdempotencyKey(
            "web", "item-1", "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"))
        self.assertEqual((r.revision, r.supersedes, r.repeat), (1, None, False))

    def test_repeat_returns_the_stored_result_unchanged(self):
        first = pipeline.screen(envelope("hello"))
        hist = _History(stored=[first], latest={("web", "item-1"): (1, first.key.sha256)})
        again = pipeline.screen(envelope("hello"), hist)
        self.assertTrue(again.repeat)
        self.assertEqual(again.verdict, first.verdict)
        self.assertEqual(again.text, first.text)
        self.assertEqual(again.key, first.key)
        self.assertEqual(again.revision, 1)
        self.assertEqual([t.stage for t in again.trace], ["validate", "idempotency"])
        self.assertEqual(again.trace[-1].status, "stop")

    def test_new_hash_is_a_new_revision_not_a_rewrite(self):
        first = pipeline.screen(envelope("version one"))
        snapshot = first.to_dict()
        hist = _History(stored=[first], latest={("web", "item-1"): (1, first.key.sha256)})
        second = pipeline.screen(envelope("version two"), hist)
        self.assertFalse(second.repeat)
        self.assertEqual(second.revision, 2)
        self.assertEqual(second.supersedes, first.key.sha256)
        self.assertNotEqual(second.key, first.key)
        self.assertEqual(second.text, "version two")
        # the stored record is untouched (frozen, and nothing wrote to it)
        self.assertEqual(first.to_dict(), snapshot)
        with self.assertRaises(dataclasses.FrozenInstanceError):
            first.text = "rewritten"  # type: ignore[misc]
        self.assertTrue(all(c[0] in ("get", "latest") for c in hist.calls))

    def test_same_raw_under_another_id_is_another_item(self):
        first = pipeline.screen(envelope("hello"))
        hist = _History(stored=[first], latest={("web", "item-1"): (1, first.key.sha256)})
        other = pipeline.screen(envelope("hello", external_id="item-2"), hist)
        self.assertFalse(other.repeat)
        self.assertEqual(other.revision, 1)

    def test_impossible_history_fails_closed(self):
        first = pipeline.screen(envelope("hello"))
        bad = [
            _History(latest={("web", "item-1"): (1, first.key.sha256)}),   # latest == this hash, no record
            _History(latest={("web", "item-1"): (0, "ab")}),               # revision below 1
            _History(latest={("web", "item-1"): (True, "ab")}),            # not an int
        ]
        wrong_key = dataclasses.replace(first, key=IdempotencyKey("web", "other", first.key.sha256))
        bad.append(_History(stored=[]))
        bad[-1].stored[first.key] = wrong_key                              # record for another key
        for h in bad:
            with self.subTest(h=h.__dict__):
                r = pipeline.screen(envelope("hello"), h)
                self.assertEqual(r.verdict, "pending")
                self.assertIn("InconsistentHistory", r.error)

    def test_decide_is_pure(self):
        key = revisions.key_for("web", "x", b"raw")
        d1 = revisions.decide(key, revisions.NoHistory())
        d2 = revisions.decide(key, revisions.NoHistory())
        self.assertEqual(d1, d2)
        self.assertEqual((d1.kind, d1.revision), ("new-item", 1))
        stored = IntakeResult(verdict="clean", key=key, revision=3, text="t")
        h = _History(stored=[stored])
        self.assertEqual(revisions.decide(key, h).kind, "repeat")


if __name__ == "__main__":
    unittest.main()

assert support
