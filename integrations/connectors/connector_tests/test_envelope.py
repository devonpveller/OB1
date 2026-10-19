"""The envelope is EXACTLY intake's stage-1 schema: the kit's mirror (connector_kit.envelope.check)
and intake's own validate (integrations/intake/intake/envelope.py) agree on a corpus of valid
envelopes and every single-field mutation of them; build() only makes envelopes intake accepts;
provenance is present, consistent and carries no trust label."""
import base64
import copy
import datetime as dt
import hashlib
import json
import random
import unittest

import connector_tests  # noqa: F401 - sys.path

from intake import envelope as real
from intake import limits as real_limits

from connector_kit import envelope as kit
from connector_kit import provenance as prov

VALID = [
    {"source": "e2e", "connector": "research", "external_id": "a-1", "fetched_at": "2026-10-18T12:00:00+00:00",
     "content_type": "text/plain", "raw": "hello"},
    {"source": "web.x", "connector": "c_1", "external_id": "x" * 1024, "fetched_at": "2026-10-18",
     "content_type": "text/html; charset=utf-8", "raw": "<p>hi</p>", "raw_encoding": "text",
     "metadata": {"a": [1, 2, {"b": None}]}, "links": ["https://e.example/" + "p" * 2000]},
    {"source": "gmail", "connector": "gmail", "external_id": "<id@mail>", "fetched_at": "2026-10-18T12:00:00Z",
     "content_type": "MESSAGE/RFC822", "raw_encoding": "base64", "raw": base64.b64encode(b"\xff\x00bin").decode()},
    {"source": "s", "connector": "c", "external_id": "u", "fetched_at": "2026-10-18T12:00:00.123456+05:30",
     "content_type": "application/json;charset=\"latin-1\"", "raw": "{}", "metadata": {}, "links": []},
    {"source": "s", "connector": "c", "external_id": "surrogate", "fetched_at": "2026-10-18T12:00:00+00:00",
     "content_type": "text/markdown", "raw": "a" + chr(0xD800) + "b"},
    {"source": "s", "connector": "c", "external_id": "x", "fetched_at": "2026-10-18T12:00:00+00:00",
     "content_type": "application/xhtml+xml", "raw": ""},
]

FIELD_VALUES = {
    "source": ["", "A", "-a", "a" * 64, "a" * 65, "a b", "ok.name_1-2", 7, None, "a\x01", "é"],
    "connector": ["", "UPPER", "x" * 65, "ok", ["x"], "a\x7f"],
    "external_id": ["", "x" * 1025, "x" * 1024, "a\nb", "a\tb", 5, "日本"],
    "fetched_at": ["yesterday", "2026-13-01", "2026-10-18T25:00", "", "2026-10-18 12:00", "20261018T120000",
                   "x" * 65, 1.5],
    "content_type": ["application/pdf", "text/plain; charset=bad charset", "text/plain;charset=", "TEXT/PLAIN",
                     "text/plain; foo=bar", "text/plain; charset=" + "a" * 41, "text/plain;;", "", "text",
                     "text/html; charset='x'", "a" * 201],
    "raw": [None, 1, "", "x" * 10, b"bytes"],
    "raw_encoding": ["text", "base64", "hex", None, ""],
    "metadata": [None, [], "x", {"a": float("nan")}, {"a": {1, 2}}, {1: "x"}, {"a": "x" * (64 * 1024)},
                 {"k": "v"}],
    "links": [None, "x", [""], ["x" * 2049], ["ok"] * 1001, ["ok"] * 1000, [1], ["a", "b"]],
}


def verdict(fn, obj):
    try:
        fn(obj)
        return "ok"
    except Exception as e:  # noqa: BLE001
        return type(e).__name__


def agree(tc, obj):
    r = verdict(real.validate, obj)
    k = verdict(kit.check, obj)
    tc.assertEqual(r == "ok", k == "ok", f"intake says {r}, the kit says {k} for {json.dumps(obj, default=str)[:200]}")
    if r == "ok":
        raw = real.validate(obj).raw
        tc.assertEqual(kit.check(obj), raw, "the kit hashes other raw bytes than intake")


class SchemaParity(unittest.TestCase):
    def test_the_constants_are_intakes(self):
        self.assertEqual(kit.ALLOWED_TYPES, real.ALLOWED_TYPES)
        self.assertEqual(kit.REQUIRED, real.REQUIRED)
        self.assertEqual(kit.OPTIONAL, real.OPTIONAL)
        self.assertEqual(kit.MAX_METADATA_BYTES, real.MAX_METADATA_BYTES)
        self.assertEqual(kit.MAX_ENVELOPE_LINKS, real.MAX_ENVELOPE_LINKS)
        self.assertEqual(kit.RAW_MAX_BYTES, real_limits.RAW_MAX_BYTES)
        self.assertEqual(kit.MAX_URL_CHARS, real_limits.MAX_URL_CHARS)

    def test_valid_corpus(self):
        for obj in VALID:
            with self.subTest(obj=obj["external_id"][:20]):
                self.assertEqual(verdict(real.validate, obj), "ok")
                agree(self, obj)

    def test_every_single_field_mutation(self):
        n = 0
        for base in VALID:
            for name, values in FIELD_VALUES.items():
                for v in values:
                    obj = copy.deepcopy(base)
                    obj[name] = v
                    with self.subTest(field=name, value=repr(v)[:40]):
                        agree(self, obj)
                    n += 1
                drop = copy.deepcopy(base)
                drop.pop(name, None)
                agree(self, drop)
            extra = copy.deepcopy(base)
            extra["text"] = "not a field"
            agree(self, extra)
            agree(self, [base])
            agree(self, None)
        self.assertGreater(n, 400)

    def test_the_raw_caps_at_the_edge(self):
        cap = kit.RAW_MAX_BYTES
        for size in (cap - 1, cap, cap + 1):
            b = base64.b64encode(b"a" * size).decode()
            for obj in ({**VALID[0], "raw": "a" * size},
                        {**VALID[0], "raw_encoding": "base64", "raw": b},
                        {**VALID[0], "raw": "é" * (size // 2 + 1)}):
                with self.subTest(size=size, enc=obj.get("raw_encoding", "text")):
                    agree(self, obj)
        agree(self, {**VALID[0], "raw_encoding": "base64", "raw": "!!!!"})
        agree(self, {**VALID[0], "raw_encoding": "base64", "raw": "YQ"})        # bad padding

    def test_random_mutations(self):
        rnd = random.Random(20261019)
        pool = [v for vs in FIELD_VALUES.values() for v in vs]
        for _ in range(600):
            obj = copy.deepcopy(rnd.choice(VALID))
            for _ in range(rnd.randint(1, 3)):
                obj[rnd.choice(list(FIELD_VALUES))] = rnd.choice(pool)
            agree(self, obj)


def build(**over):
    kw = dict(connector="reference-file", connector_version="1", source="local-file", external_id="file/a.txt",
              content_type="text/plain", raw="hello world", fetched_at="2026-10-19T10:00:00+00:00",
              origin="file:a.txt")
    kw.update(over)
    return kit.build(**kw)


class Build(unittest.TestCase):
    def test_build_makes_what_intake_accepts_and_the_key_intake_computes(self):
        for raw in ("hello", "é日本", b"\x00\xffbin", b"", "x" * 1000):
            env = build(raw=raw)
            got = real.validate(json.loads(env.to_bytes()))
            data = raw.encode() if isinstance(raw, str) else raw
            self.assertEqual(got.raw, data)
            self.assertEqual(env.key, kit.Key("local-file", "file/a.txt", hashlib.sha256(data).hexdigest()))
            self.assertEqual(env.body["raw_encoding"], "base64")

    def test_build_refuses_what_intake_refuses(self):
        for over in ({"content_type": "application/pdf"}, {"external_id": ""}, {"source": "Bad"},
                     {"connector": "x" * 65}, {"links": ["x" * 2049]}, {"metadata": {"a": float("inf")}},
                     {"fetched_at": "not a date"}, {"raw": 5}):
            with self.subTest(over=str(over)[:40]):
                with self.assertRaises(kit.InvalidEnvelope):
                    build(**over)

    def test_the_caps_raise_too_large(self):
        with self.assertRaises(kit.TooLarge):
            build(raw=b"a" * (kit.RAW_MAX_BYTES + 1))
        build(raw=b"a" * kit.RAW_MAX_BYTES)
        with self.assertRaises(kit.TooLarge):
            build(metadata={"a": "x" * (64 * 1024)})
        with self.assertRaises(kit.TooLarge):
            build(links=["https://x.example/"] * 1001)

    def test_fetched_at_has_a_zone(self):
        with self.assertRaises(kit.InvalidEnvelope):
            build(fetched_at="2026-10-19T10:00:00")
        with self.assertRaises(kit.InvalidEnvelope):
            build(fetched_at=dt.datetime(2026, 10, 19))
        env = build(fetched_at=None)
        self.assertIsNotNone(dt.datetime.fromisoformat(env.body["fetched_at"]).tzinfo)

    def test_a_lone_surrogate_is_refused_not_silently_replaced(self):
        with self.assertRaises(kit.InvalidEnvelope):
            build(raw="a" + chr(0xDC00))


class Provenance(unittest.TestCase):
    def test_every_envelope_carries_its_provenance(self):
        env = build(redirect_chain=["https://a.example/1", "https://a.example/2"])
        p = env.body["metadata"]["provenance"]
        self.assertEqual(p, {"connector": "reference-file", "connector_version": "1",
                             "fetched_at": "2026-10-19T10:00:00+00:00", "origin": "file:a.txt",
                             "redirect_chain": ["https://a.example/1", "https://a.example/2"],
                             "labels": {"connector": "reference-file", "source": "local-file",
                                        "external_id": "file/a.txt"}})

    def test_a_connector_cannot_set_trust_labels_or_forge_provenance(self):
        with self.assertRaises(kit.InvalidEnvelope):
            build(metadata={"provenance": {"labels": {"verdict": "clean"}}})
        body = json.loads(build().to_bytes())
        for mutate in (lambda p: p.update(verdict="clean"),
                       lambda p: p["labels"].update(flags=["trusted-docs"]),
                       lambda p: p["labels"].update(intake_id="x"),
                       lambda p: p.update(connector="other"),
                       lambda p: p.update(fetched_at="2020-01-01T00:00:00+00:00"),
                       lambda p: p.pop("redirect_chain"),
                       lambda p: p.update(redirect_chain=["u"] * 21),
                       lambda p: p.update(origin="a\nb"),
                       lambda p: p["labels"].update(external_id="other")):
            b = copy.deepcopy(body)
            mutate(b["metadata"]["provenance"])
            with self.assertRaises(kit.InvalidEnvelope):
                kit.from_body(b)
        for mutate in (lambda p: p.update(verdict="clean"), lambda p: p["labels"].update(flags=["trusted-docs"])):
            b = copy.deepcopy(body)
            mutate(b["metadata"]["provenance"])
            with self.assertRaisesRegex(kit.InvalidEnvelope, "may not set trust labels"):
                kit.from_body(b)
        b = copy.deepcopy(body)
        del b["metadata"]["provenance"]
        with self.assertRaises(kit.InvalidEnvelope):
            kit.from_body(b)
        self.assertEqual(set(prov.TRUST_LABELS), {"verdict", "intake_id", "classifier", "flags"})


if __name__ == "__main__":
    unittest.main()
