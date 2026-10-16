"""The I2 carry-ins (intake-i3; operator D38/D39; I2 review R-1; attempt-3 FAIL-B and F3-2).
Each test fails on e04ff3a (RED) and passes after the fix."""
import time
import unittest

from tests import support
from tests.adversarial_i3 import calc_chain_page, header_semicolon_floods
from tests.support import envelope

from intake import cdr, htmlscan, limits, pipeline
from intake.deadline import Deadline


class CountingDeadline:
    """A deadline that never expires and counts its checks."""

    limit = float("inf")

    def __init__(self):
        self.checks = 0

    def check(self):
        self.checks += 1

    def remaining(self):
        return float("inf")


class CalcChains(unittest.TestCase):
    """D39 / review R-1: calc() chains in inline styles were walked quadratically, and the
    deadline was not checked while styles were evaluated."""

    @classmethod
    def setUpClass(cls):
        pipeline.screen(envelope("warm up"))

    def test_review_r1_page_finishes_well_inside_the_bound(self):
        page = calc_chain_page()
        self.assertLessEqual(len(page.encode("utf-8")), limits.HTML_MAX_BYTES)
        t0 = time.perf_counter()
        r = pipeline.screen(envelope(page, "text/html"))
        dt = time.perf_counter() - t0
        self.assertIsNone(r.error, r.error)
        self.assertLess(dt, 2.0, f"{dt:.3f}s")
        # thousands of calc() in one value is not presentation: every paragraph counts as hidden
        self.assertEqual(r.counts["hidden_elements"], 31)
        self.assertNotIn("para", r.text)

    def test_up_to_the_calc_cap_is_evaluated(self):
        cap = limits.CSS_MAX_CALC_PER_VALUE
        self.assertEqual(htmlscan._lengths_px("calc(1px)" * cap), [1.0] * cap)
        self.assertEqual(htmlscan._lengths_px("calc(1px)" * (cap + 1))[-1], float("-inf"))
        self.assertFalse(htmlscan.css_hides("left:" + "calc(1px)" * cap))
        self.assertTrue(htmlscan.css_hides("left:" + "calc(1px)" * (cap + 1)))

    def test_calc_evaluation_is_unchanged(self):
        self.assertEqual(htmlscan._lengths_px("calc(-1 * 9999px)"), [-9999.0])
        self.assertEqual(htmlscan._lengths_px("calc(1px) 3px calc(2px + 1px)"), [1.0, 3.0, 3.0])
        self.assertEqual(htmlscan._lengths_px("4px calc(1px"), [1.0, 4.0])  # unterminated
        self.assertTrue(htmlscan.css_hides("left:calc(-1 * 9999px)"))
        self.assertFalse(htmlscan.css_hides("left:calc(10px + 2px)"))

    def test_the_deadline_is_checked_for_every_evaluated_style(self):
        n = 50
        page = "".join(f'<p style="left:{i}px">x</p>' for i in range(n)).encode()
        dl = CountingDeadline()
        htmlscan.extract_html(page, dl)
        self.assertGreaterEqual(dl.checks, n)

    def test_an_expired_deadline_stops_inside_style_evaluation(self):
        # 31 tags: run()'s own check (every 1024 tags) never fires; only the per-style one can
        page = calc_chain_page().encode()
        ticks = iter(range(10**9))
        dl = Deadline(5, clock=lambda: next(ticks))  # each check advances the clock by 1
        with self.assertRaises(Exception) as cm:
            htmlscan.extract_html(page, dl)
        self.assertEqual(type(cm.exception).__name__, "DeadlineExceeded")


class HeaderSemicolonFloods(unittest.TestCase):
    """D38 / attempt-3 FAIL-B: a per-header ';' cap rejects the stdlib parameter parser's
    quadratic shapes before the parser runs."""

    @classmethod
    def setUpClass(cls):
        pipeline.screen(envelope("warm up"))

    def test_floods_are_rejected_early(self):
        for name, raw in header_semicolon_floods():
            with self.subTest(case=name):
                t0 = time.perf_counter()
                r = pipeline.screen(envelope(raw, "message/rfc822"))
                dt = time.perf_counter() - t0
                self.assertEqual(r.verdict, "rejected", (name, r.error))
                self.assertIn("';'", r.reasons[-1].detail)
                self.assertLess(dt, 0.5, f"{name}: {dt:.3f}s")

    def test_ordinary_parameter_lists_still_parse(self):
        dkim = "DKIM-Signature: " + "; ".join(f"k{i}=v{i}" for i in range(40)) + "\r\n"
        raw = (dkim + "Content-Type: multipart/mixed; boundary=B; charset=utf-8; x=1\r\n\r\n"
               "--B\r\nContent-Type: text/plain; charset=utf-8; format=flowed; delsp=yes\r\n\r\n"
               "body text\r\n--B\r\nContent-Disposition: attachment; filename=\"ab.txt\"; size=3\r\n"
               "Content-Type: application/octet-stream\r\n\r\nabc\r\n--B--\r\n")
        r = pipeline.screen(envelope(raw, "message/rfc822"))
        self.assertEqual(r.verdict, "clean", r.error)
        self.assertEqual(r.text.strip(), "body text")
        self.assertEqual(r.attachments[0]["filename"], "ab.txt")

    def test_semicolons_in_a_body_are_not_counted(self):
        css = "<style>" + "a{b:c;}" * 5000 + "</style><p>visible</p>"
        raw = ("Content-Type: multipart/alternative; boundary=B\r\n\r\n--B\r\nContent-Type: text/html\r\n\r\n"
               + css + "\r\n--B--\r\n")
        r = pipeline.screen(envelope(raw, "message/rfc822"))
        self.assertEqual(r.verdict, "clean", r.error)
        self.assertIn("visible", r.text)
        plain = "Content-Type: text/plain\r\n\r\n" + "x;" * 20000 + "\r\n"
        self.assertEqual(pipeline.screen(envelope(plain, "message/rfc822")).verdict, "clean")

    def test_the_cap_is_per_header(self):
        cap = limits.MIME_MAX_HEADER_SEMICOLONS
        at = "Content-Type: text/plain; a=1" + ";" * (cap - 1) + "\r\n\r\nbody\r\n"
        over = "Content-Type: text/plain; a=1" + ";" * cap + "\r\n\r\nbody\r\n"
        self.assertEqual(pipeline.screen(envelope(at, "message/rfc822")).verdict, "clean")
        self.assertEqual(pipeline.screen(envelope(over, "message/rfc822")).verdict, "rejected")
        # many headers each under the cap are fine
        many = "".join(f"X-H{i}: " + ";" * (cap - 1) + "\r\n" for i in range(50)) + "\r\nbody\r\n"
        self.assertEqual(pipeline.screen(envelope(many, "message/rfc822")).verdict, "clean")

    def test_cdr_raises_parser_bomb(self):
        with self.assertRaises(htmlscan.ParserBomb):
            cdr.extract("rfc822", header_semicolon_floods()[1][1].encode(), None)


class NumericReferences(unittest.TestCase):
    """F3-2: the control-reference regex cut astral and other references after 1-3 digits."""

    def test_references_decode_to_their_characters(self):
        cases = {
            "&#x1F600;": "\U0001F600", "&#127881;": "\U0001F389", "&#x1680;": " ",
            "&#x13441;": "\U00013441", "&#x10D3;": "დ", "&#x1D400;": "\U0001D400",
            "&#x7F00;": "缀", "&#65;": "A", "&#x41;": "A", "&#0065;": "A",
        }
        for ref, ch in cases.items():
            with self.subTest(ref=ref):
                h = htmlscan.extract_html(f"<p>[{ref}]</p>".encode())
                self.assertEqual(h.text, f"[{ch}]")

    def test_control_references_are_still_kept_and_counted(self):
        h = htmlscan.extract_html(b"<p>a&#x1f;b&#1;c&#x7F;d&#127;e</p>")
        self.assertEqual(h.text, "a\x1fb\x01c\x7fd\x7fe")
        self.assertEqual(h.counts["controls_refs"], 4)
        # a control reference with no ';' still ends at the first non-digit
        h = htmlscan.extract_html(b"<p>a&#x1fz</p>")
        self.assertEqual(h.text, "a\x1fz")


class DeadCodeRemoved(unittest.TestCase):
    def test_dead_names_are_gone(self):
        for mod, name in ((htmlscan, "_SCRIPT_SCAN"), (htmlscan, "_Plain"), (htmlscan, "_PLAIN"),
                          (htmlscan, "attrs_hide"), (cdr, "_raw_header"), (pipeline, "escape_title")):
            with self.subTest(name=name):
                self.assertFalse(hasattr(mod, name))


if __name__ == "__main__":
    unittest.main()

assert support
