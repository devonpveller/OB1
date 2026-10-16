"""Every input inside the caps finishes screen() in < 2 s on the reference host, per stage
including inside RE2 (operator D34; I2 acceptance line 2, round 2).

* Times are wall-clock for one screen() call, after a warm-up call that builds the Unicode
  tables (a one-time cost per process).
* The deadline (limits.DEADLINE_SECONDS, enforced inside the stages) is what makes the bound
  hold on a loaded host: an adversarial input that would run longer ends `pending` at the
  deadline. Inputs that a legitimate page or text looks like (LEGIT below) must finish WITHOUT
  reaching it.
* RE2's own log is captured for every case: no rule may print "DFA out of memory" (the
  attempt-1 failure: RE2 left its DFA for the NFA, ~8 s per MB).
* Cases: the developer's adversarial set, the attempt-1 tester's probe set (probe_bounds.py),
  every rule's fragments at random spacing (tests/adversarial.py) as text, HTML and markdown,
  and one huge tag per tag-tokenizer alternative.

Set INTAKE_BOUNDS_REPORT=<path> to also write a JSON report of every timing."""
import contextlib
import json
import os
import random
import sys
import tempfile
import time
import unittest

from tests import adversarial as adv
from tests import adversarial_r3
from tests import support
from tests.support import envelope, tag

from intake import limits, pipeline, rules

BOUND_S = 2.0
MB = 1024 * 1024
MB2 = limits.HTML_MAX_BYTES
MB5 = limits.RAW_MAX_BYTES
fit = adv.fit


def _real_like_page(size: int = MB2) -> str:
    """Markup at ~24 bytes per tag: the densest of the real pages of 1.8 MB or more among 2,620
    measured on the reference host (Python/CMake/Git docs, 2026-10-15: genindex-all.html 1.8 MB,
    24.7 bytes per tag; changelog.html 32.7; CMake genindex.html 29.6). Small pages reach 16
    bytes per tag, but 2 MB of such markup is 131,000 tags, under the 150,000 cap."""
    row = ("<tr><td><a href='#l{0}'>item {0:06d} in the index</a></td><td>value and more text "
           "here, then a little more for the reader</td></tr>\n<p class='n'>Some <b>bold</b> words "
           "in a sentence of ordinary size, as an index or a reference table would print it.</p>\n")
    out, n, i = ["<!doctype html><html><head><title>Index</title></head><body><table>"], 0, 0
    while n < size - 64:
        s = row.format(i)
        out.append(s)
        n += len(s)
        i += 1
    return fit("".join(out), size - 32) + "</table></body></html>"


LEGIT = {"real-like 2MB page", "one char x2MB", "5MB one char", "CJK 5MB", "Persian with ZWNJ"}


def _html_cases():
    yield "real-like 2MB page", _real_like_page()
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
    yield "control charrefs", "<p>" + "&#x1f;" * (MB2 // 7) + "</p>"
    yield "script markers", "<script>" + "<!--<script>" * (MB2 // 12)
    yield "many scripts", "<script>x</script>" * (MB2 // 18)
    yield "formatting stack", "".join(f"<b id={i}>" for i in range(400)) + "</p>x" * (MB2 // 6)
    yield "li-many", "<ul>" + "<li>x" * (MB2 // 5)
    yield "td-many", "<table>" + "<tr><td>x" * (MB2 // 9)
    yield "open quote attr", '<a b="' + "x>" * (MB2 // 2)
    yield "quoted values flood", "<a" + ' b="x>"' * (MB2 // 7) + ">t"
    yield "NUL x2MB", "\x00" * MB2
    yield "over the html cap (5MB)", "<p>" + "word " * (MB5 // 5 - 2)
    yield "hidden x many", "<div style='display:none'>x</div>" * (MB2 // 34)
    yield "closed details x many", "<details><summary>s</summary>x</details>" * (MB2 // 41)
    yield "misnested formatting", "<b><p>x</b>y</p>" * (MB2 // 16)


def _text_cases():
    rnd = random.Random(424242)
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
    yield "fake flags x 5MB", ("\U0001F3F4" + tag("ignore") + "\U000E007F") * (MB5 // 32)
    yield "bidi+VS+C1 mix", "a\u200b\u202e\ufe0f\x85b" * (MB5 // 12)
    yield "CGJ / Hangul fillers", "a\u034f\u3164" * (MB5 // 7)
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
    yield "random multi-script chars 5MB", fit("".join(chr(rnd.choice([
        rnd.randint(0x20, 0x7e), rnd.randint(0x400, 0x4ff), rnd.randint(0x4e00, 0x9fff),
        rnd.randint(0x600, 0x6ff), rnd.randint(0x1f300, 0x1f5ff)])) for _ in range(1_600_000)), MB5 - 16)


def _tester_cases():
    """The attempt-1 tester's probe_bounds.py set (journal/evidence/intake-i2/tester-attempt1)."""
    rnd = random.Random(424242)

    def rand_bang(n):
        out, size = [], 0
        while size < n:
            piece = "![" + "".join(rnd.choice("abcdefghij ") for _ in range(rnd.randint(1, 20)))
            out.append(piece)
            size += len(piece)
        return "".join(out)

    def rand_words(words, n):
        out, size = [], 0
        while size < n:
            w = rnd.choice(words)
            out.append(w)
            size += len(w) + 1
        return " ".join(out)

    T = "text/plain"
    yield T, "t1 random '![' 5MB", fit(rand_bang(5 * MB), 5 * MB - 16)
    yield "text/html", "t1 random '![' 2MB html", "<p>" + fit(rand_bang(2 * MB), 2 * MB - 16)
    yield "message/rfc822", "t1 random '![' email 3MB", "Content-Type: text/plain\r\n\r\n" + fit(rand_bang(3 * MB), 3 * MB)
    yield "text/markdown", "t1 random '![' markdown 1MB", fit(rand_bang(MB), MB)
    yield "application/json", "t1 random '![' json 1MB", json.dumps([fit(rand_bang(MB), MB)])
    yield T, "t1 ignore soup", fit(rand_words(["ignore", "disregard", "your", "all", "previous", "prior",
                                               "the", "a", "system"], 5 * MB), 5 * MB - 16)
    yield T, "t1 answer soup", fit(rand_words(["answer", "label", "this", "as", "classify", "mark", "it",
                                               "with", "only", ":", "the"], 5 * MB), 5 * MB - 16)
    yield T, "t1 reveal soup", fit(rand_words(["reveal", "print", "show", "your", "the", "system",
                                               "initial", "hidden", "x"], 5 * MB), 5 * MB - 16)
    yield T, "t1 INJECTION/CLEAN soup", fit(rand_words(["INJECTION", "CLEAN", "x", "y"], 5 * MB), 5 * MB - 16)
    yield T, "t1 '[Source' + digits", fit("[Source " + "1" * (5 * MB), 5 * MB - 16)
    yield T, "t1 '[ Source 1' unterminated", fit("[ \t Source \t 12 \t " * 300000, 5 * MB - 16)
    yield T, "t1 9,999 forged lines", "\n".join(f"[Source {i}] x" for i in range(9999))
    yield T, "t1 10,001 forged lines", "\n".join(f"[Source {i}] x" for i in range(10001))
    yield T, "t1 U+2474 x1.75M", fit("\u2474" * 1_750_000, 5 * MB - 16)
    yield T, "t1 jamo LVT", fit("\uac01" * 600_000, 5 * MB - 16)
    yield T, "t1 19,999 U+FDFA + filler", "\ufdfa" * 19_999 + fit("\u00e9" * 1_600_000, 4 * MB)
    yield T, "t1 1,999 runs of 30 marks", ("a" + "\u0316\u0301" * 15) * 1999 + fit("b c " * 1_000_000, 4 * MB)
    yield T, "t1 TAG/Cf/bidi/VS rotating", fit("".join(["a\U000E0041", "b\u200b", "c\u202e", "d\ufe0f", "e\x01"][i % 5]
                                                       for i in range(1_300_000)), 5 * MB - 16)
    yield "application/json", "t1 lone surrogates via JSON", '["' + "\\ud800x" * 600000 + '"]'
    yield "text/html", "t1 32 x 64KB CSS escapes", "".join(f'<p style="x{i}:' + "\\61 " * 16000 + '">t</p>' for i in range(32))
    yield "text/html", "t1 32 tags x 30k bare attrs", "".join("<p hidden" + " a" * 30000 + ">x</p>" for _ in range(32))
    yield "text/html", "t1 rawtext '</stylex'", "<style>" + "</stylex" * 260000 + "</style>ok"
    yield "text/html", "t1 511 nested + </p> flood", "<div>" * 511 + "</p>" * 59000
    yield "text/html", "t1 300 tables + td flood", "<table>" * 300 + "<td>x" * 50000
    yield "message/rfc822", "t1 5MB QP soft breaks", ("Content-Type: text/plain\r\nContent-Transfer-Encoding: "
                                                      "quoted-printable\r\n\r\n" + "=\r\n" * 1_700_000)
    yield "message/rfc822", "t1 5MB base64 body", ("Content-Type: text/plain\r\nContent-Transfer-Encoding: base64"
                                                   "\r\n\r\n" + "QUFB" * 1_300_000)
    yield "message/rfc822", "t1 5MB folded subject", "Subject: " + "a\r\n " * 1_700_000 + "\r\n\r\nbody"
    yield "application/json", "t1 5MB small ints", "[" + "1," * 2_600_000 + "1]"
    yield "application/json", "t1 depth 199 then wide", "[" * 199 + ",".join(['"x"'] * 100000) + "]" * 199


def _other_cases():
    yield "application/json", "deep JSON array", "[" * 200_000 + "]" * 200_000
    yield "application/json", "5MB JSON string", json.dumps("x" * (MB5 - 10))
    yield "application/json", "wide JSON", json.dumps([{"k": "v"}] * 300_000)
    yield "application/json", "escaped JSON strings", json.dumps(["\u00e9\u200b\"" * 20] * 40_000)
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


@contextlib.contextmanager
def re2_log():
    """Capture what C code writes to stderr (RE2 logs there) into a list of lines."""
    lines: list[str] = []
    sys.stderr.flush()
    fd = sys.stderr.fileno()
    saved = os.dup(fd)
    with tempfile.TemporaryFile() as tmp:
        os.dup2(tmp.fileno(), fd)
        try:
            yield lines
        finally:
            sys.stderr.flush()
            os.dup2(saved, fd)
            os.close(saved)
            tmp.seek(0)
            lines.extend(tmp.read().decode("utf-8", "replace").splitlines())


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
        with re2_log() as log:
            t0 = time.perf_counter()
            r = pipeline.screen(envelope(raw, ct))
            dt = time.perf_counter() - t0
        self.report.append({"case": name, "content_type": ct, "chars": len(raw), "seconds": round(dt, 4),
                            "verdict": r.verdict, "error": r.error,
                            "stages_ms": {t.stage: round(t.ms) for t in r.trace}})
        self.assertLess(dt, BOUND_S, f"{name}: {dt:.3f}s")
        self.assertFalse([ln for ln in log if "DFA out of memory" in ln], f"{name}: RE2 left its DFA")
        if r.error is not None:
            self.assertIn("deadline", r.error, f"{name}: {r.error}")
            self.assertNotIn(name, LEGIT, f"{name}: a legitimate-looking input reached the deadline")
            self.assertEqual(r.verdict, "pending")
        if r.text is not None:
            self.assertLessEqual(len(r.text.encode("utf-8")), limits.RAW_MAX_BYTES)
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

    def test_attempt1_tester_inputs(self):
        for ct, name, raw in _tester_cases():
            with self.subTest(case=name):
                self._check(name, raw, ct)

    def test_every_rule_at_random_spacing(self):
        for rule in rules.rules():
            if rule.kind != "regex":
                continue
            for ct, size in (("text/plain", MB5), ("text/html", MB2), ("text/markdown", MB)):
                with self.subTest(rule=rule.id, content_type=ct):
                    raw = adv.spaced(rule, size - 16, seed=sum(map(ord, rule.id)))
                    if ct == "text/html":
                        raw = "<p>" + raw
                    self._check(f"spaced {rule.id} {ct}", raw, ct)

    def test_every_rule_alone_on_its_worst_input(self):
        # the rules stage on its own: every regex on every rule's spaced input, 5 MB
        texts = {r.id: adv.spaced(r, MB5).encode("utf-8") for r in rules.rules() if r.kind == "regex"}
        with re2_log() as log:
            for rid, b in texts.items():
                for rule in rules.rules():
                    if rule.kind != "regex":
                        continue
                    t0 = time.perf_counter()
                    rule.regex.search(b)
                    dt = time.perf_counter() - t0
                    self.assertLess(dt, 0.25, f"{rule.id} on {rid}'s input: {dt:.3f}s")
        self.assertFalse([ln for ln in log if "DFA out of memory" in ln])

    def test_round3_json_escape_floods(self):
        # attempt 2 FAIL-A (1): every JSON escape kind as a 5 MB flood, alone and in keys/values
        for name, raw in adversarial_r3.json_escape_floods():
            with self.subTest(case=name):
                self._check(name, raw, "application/json")

    def test_round3_email_line_endings(self):
        # attempt 2 FAIL-A (2): CR-only, LF-only, CRLF and mixed line endings, at the line cap
        # and as 5 MB floods
        for name, raw in adversarial_r3.email_line_shapes():
            with self.subTest(case=name):
                self._check(name, raw, "message/rfc822")

    def test_round3_json_and_email_sweep(self):
        # round 3 (3): every other single JSON / email step the sweep looked at
        for name, raw in adversarial_r3.json_other():
            with self.subTest(case=name):
                self._check(name, raw, "application/json")
        for name, raw in adversarial_r3.email_other():
            with self.subTest(case=name):
                self._check(name, raw, "message/rfc822")

    def test_huge_single_tags(self):
        for name, raw in adv.huge_tags().items():
            with self.subTest(case=name):
                self._check("huge tag " + name, raw, "text/html")


class DeadlineInsideStages(unittest.TestCase):
    def test_the_deadline_stops_a_long_stage(self):
        page = _real_like_page()
        t0 = time.perf_counter()
        r = pipeline.screen(envelope(page, "text/html"), deadline_s=0.05)
        dt = time.perf_counter() - t0
        self.assertEqual(r.verdict, "pending")
        self.assertIn("DeadlineExceeded", r.error)
        self.assertEqual(r.trace[-1].stage, "cdr")  # stopped INSIDE the HTML scanner
        self.assertLess(dt, 0.05 + 0.3)

    def test_a_stage_that_overruns_by_itself_is_stopped_after(self):
        ticks = iter(range(0, 10_000, 7))
        r = pipeline.screen(envelope("plain text"), deadline_s=10, clock=lambda: next(ticks))
        self.assertEqual(r.verdict, "pending")
        self.assertIn("deadline", r.error)


if __name__ == "__main__":
    unittest.main()

assert support
