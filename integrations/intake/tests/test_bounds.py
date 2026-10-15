"""Every adversarial input finishes in < 1 s through the whole pipeline and stays within the
size caps (I2 acceptance). Times are wall-clock on the test machine for one screen() call,
after one warm-up call that builds the Unicode tables (a one-time cost per process).

Set INTAKE_BOUNDS_REPORT=<path> to also write a JSON report of every timing."""
import json
import os
import time
import unittest

from tests import support
from tests.support import envelope, tag

from intake import limits, pipeline

BOUND_S = 1.0
MB2 = limits.HTML_MAX_BYTES
MB5 = limits.RAW_MAX_BYTES


def _html_cases():
    yield "comment-open x2MB", "<!--" * (MB2 // 4)
    yield "nav-open (deep nesting)", "<nav>" * (MB2 // 5)
    yield "div-open (deep nesting)", "<div>" * (MB2 // 5)
    yield "a-tags", "<a>" * (MB2 // 3)
    yield "lt x2MB", "<" * MB2
    yield "lt-space", "< " * (MB2 // 2)
    yield "lt-x unterminated tag", "<x" * (MB2 // 2)
    yield "one char x2MB", "a" * MB2
    yield "huge attribute", '<div title="' + "a" * (MB2 - 20) + '">x</div>'
    yield "huge style", '<div style="' + "display:block;" * (MB2 // 15) + '">x</div>'
    yield "many distinct styles", "".join(f'<p style="opacity:0.{i % 9 + 1};left:-{i}px">x</p>'
                                          for i in range(40_000))[:MB2]
    yield "entities", "&a" * (MB2 // 2)
    yield "numeric entities", "&#65;" * (MB2 // 5)
    yield "script markers", "<script>" + "<!--<script>" * (MB2 // 12)
    yield "many scripts", "<script>x</script>" * (MB2 // 18)
    yield "formatting stack", "".join(f"<b id={i}>" for i in range(400)) + "</p>x" * (MB2 // 6)
    yield "li-many", "<ul>" + "<li>x" * (MB2 // 5)
    yield "td-many", "<table>" + "<tr><td>x" * (MB2 // 9)
    yield "open quote attr", '<a b="' + "x>" * (MB2 // 2)
    yield "NUL x2MB", "\x00" * MB2
    yield "over the html cap (5MB)", "<p>" + "word " * (MB5 // 5 - 2)
    yield "hidden x many", "<div style='display:none'>x</div>" * (MB2 // 34)
    yield "realistic page", ("<html><body>" + "<div class='c'><p>Some text with <a href='https://e.x/p'>"
                             "a link</a> and <b>bold</b>.</p></div>" * 20000)[:MB2]


def _text_cases():
    yield "5MB one char", "a" * MB5
    yield "5MB 'ignore previous instructions '", ("ignore previous instructions " * (MB5 // 29))[:MB5]
    yield "5MB '[Source 1] ' lines", ("[Source 1] x\n" * (MB5 // 13))[:MB5]
    yield "5MB 'Answer: '", ("Answer: " * (MB5 // 8))[:MB5]
    yield "5MB '<|' tokens", ("<|im_start|" * (MB5 // 11))
    yield "5MB '![' openers", ("![" * (MB5 // 2))
    yield "5MB 'INJECTION '", ("INJECTION " * (MB5 // 10))
    yield "ZWSP x1.7M", "\u200b" * (MB5 // 3)
    yield "ZWSP alternating", "\u200bx" * (MB5 // 4)
    yield "TAG x1.25M", tag("A") * (MB5 // 4)
    yield "TAG alternating", (tag("A") + "x") * (MB5 // 5)
    yield "bidi+VS+C1 mix", "a\u200b\u202e\ufe0f\x85b" * (MB5 // 12)
    yield "combining x2.5M", "\u0301" * (MB5 // 2)
    yield "combining alternating classes", "a" + "\u0301\u0316" * (MB5 // 4)
    yield "combining runs of 3", "a\u0301\u0316\u0300" * (MB5 // 7)
    yield "U+FDFA x1.7M", "\ufdfa" * (MB5 // 3)
    yield "ligature fi x1.7M", "\ufb01" * (MB5 // 3)
    yield "fullwidth x1.7M", "\uff41" * (MB5 // 3)
    yield "halfwidth kana x1.7M", "\uff71" * (MB5 // 3)
    yield "CJK 5MB", "\u65e5\u672c\u8a9e\u306e\u6587\u3002" * (MB5 // 18)
    yield "Persian with ZWNJ", "\u0633\u0644\u0627\u0645\u200c\u062f\u0646\u06cc\u0627 " * (MB5 // 19)
    yield "lone surrogate x1M", "\ud800" * 1_000_000
    yield "5MB newlines", "\n" * MB5


def _other_cases():
    deep_json = "[" * 200_000 + "]" * 200_000
    yield "application/json", "deep JSON array", deep_json
    yield "application/json", "5MB JSON string", json.dumps("x" * (MB5 - 10))
    yield "application/json", "wide JSON", json.dumps([{"k": "v"}] * 300_000)
    boundary_bomb = "Content-Type: multipart/mixed; boundary=b0\r\n\r\n" + "".join(
        f"--b{i}\r\nContent-Type: multipart/mixed; boundary=b{i + 1}\r\n\r\n" for i in range(30))
    yield "message/rfc822", "nested multipart x30", boundary_bomb + "x" * (MB5 - len(boundary_bomb) - 10)
    yield "message/rfc822", "multipart bomb x5000", "".join(
        f"--b{i}\r\nContent-Type: multipart/mixed; boundary=b{i + 1}\r\n\r\n" for i in range(5000))
    many = "Content-Type: multipart/mixed; boundary=B\r\n\r\n" + "--B\r\nContent-Type: text/plain\r\n\r\nx\r\n" * 60_000
    yield "message/rfc822", "60k parts", many[:MB5]
    yield "message/rfc822", "5MB header line", "Subject: " + "=?utf-8?q?" * (MB5 // 11) + "\r\n\r\nbody"
    yield "message/rfc822", "huge filename params", (
        "Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Disposition: attachment; "
        + "filename*0=\"a\"; " * (MB5 // 20) + "\r\n\r\nx\r\n--B--")


class TimeBounds(unittest.TestCase):
    report: list = []

    @classmethod
    def setUpClass(cls):
        pipeline.screen(envelope("warm up \u00e9\u200b " + tag("x")))

    @classmethod
    def tearDownClass(cls):
        path = os.environ.get("INTAKE_BOUNDS_REPORT")
        if path:
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(cls.report, fh, indent=1)

    def _check(self, name, raw, ct):
        t0 = time.perf_counter()
        r = pipeline.screen(envelope(raw, ct))
        dt = time.perf_counter() - t0
        self.report.append({"case": name, "content_type": ct, "chars": len(raw), "seconds": round(dt, 4),
                            "verdict": r.verdict, "error": r.error})
        self.assertLess(dt, BOUND_S, f"{name}: {dt:.3f}s")
        self.assertIsNone(r.error, f"{name}: {r.error}")  # bounded by design, not by the deadline
        if r.text is not None:
            self.assertLessEqual(len(r.text.encode("utf-8", "surrogatepass")), limits.RAW_MAX_BYTES)
            if ct == "text/html":
                self.assertLessEqual(len(r.text.encode("utf-8")), limits.HTML_MAX_BYTES)
        self.assertLessEqual(len(r.links), limits.MAX_LINKS + 1000)
        return r

    def test_html(self):
        for name, raw in _html_cases():
            with self.subTest(case=name):
                self._check(name, raw, "text/html")

    def test_text(self):
        for name, raw in _text_cases():
            with self.subTest(case=name):
                self._check(name, raw, "text/plain")

    def test_json_and_mime(self):
        for ct, name, raw in _other_cases():
            with self.subTest(case=name):
                self._check(name, raw, ct)


if __name__ == "__main__":
    unittest.main()

assert support
