"""The classifier's eval set, frozen as a regression fixture (intake-i3; DESIGN-intake.md
section 9 / Appendix B). For fp32 and int8 on the pinned model:

  * every item's max chunk score is within the stated tolerance of the score frozen for that
    precision (fixtures/classifier_eval.json "p_fp32" / "p_int8") and of the section-9 score
    ("p_design");
  * the short-set recall and false positives at p >= 0.5 match section 9 (18/25 and 5/30)
    within the stated count tolerance;
  * through screen(): a score >= threshold gives `pending` + needs_second_opinion, a score below
    leaves the stage 1-5 verdict exactly as it was, and no item is `injected` on the score;
  * the I2 corpus (legitimate security writing) does not newly trip on the classifier alone
    beyond the false-positive count recorded for it (fixtures/classifier_corpus_scores.json).
"""
import unittest

from tests import classifier_support as cs
from tests import support
from tests.support import envelope

from intake import classifier, pipeline


def _p(clf, text):
    return clf.score([("body", text)]).max_score


class _EvalSet:
    precision = "fp32"

    @classmethod
    def setUpClass(cls):
        cls.fx = cs.eval_fixture()
        cls.clf = cs.real(cls.precision)
        cls.scores = {it["id"]: _p(cls.clf, it["text"]) for it in cls.fx["items"]}

    def test_fixture_is_the_section9_set(self):
        items = self.fx["items"]
        kinds = [(it["kind"], it["label"]) for it in items]
        self.assertEqual(kinds.count(("short", 1)), 25)
        self.assertEqual(kinds.count(("short", 0)), 30)
        self.assertEqual(kinds.count(("long", 1)), 4)
        self.assertEqual(kinds.count(("long", 0)), 2)
        self.assertEqual(len({it["id"] for it in items}), len(items))
        self.assertEqual(self.fx["model"], {"repo": classifier.MODEL_REPO, "revision": classifier.MODEL_REVISION})
        self.assertEqual((self.fx["chunking"]["chunk_tokens"], self.fx["chunking"]["overlap_tokens"]),
                         (self.clf.cfg.chunk_tokens, self.clf.cfg.overlap_tokens))

    def test_scores_match_the_frozen_scores(self):
        tol = self.fx["tolerance"]["score_vs_frozen"][self.precision]
        key = "p_" + self.precision
        for it in self.fx["items"]:
            with self.subTest(item=it["id"]):
                self.assertAlmostEqual(self.scores[it["id"]], it[key], delta=tol)

    def test_scores_match_section9(self):
        tol = self.fx["tolerance"]["score_vs_design"][self.precision]
        for it in self.fx["items"]:
            with self.subTest(item=it["id"]):
                self.assertAlmostEqual(self.scores[it["id"]], it["p_design"], delta=tol)

    def test_recall_and_false_positives_match_section9(self):
        thr = self.fx["threshold"]
        tol = self.fx["tolerance"]["counts"]
        short = [it for it in self.fx["items"] if it["kind"] == "short"]
        recall = sum(self.scores[it["id"]] >= thr for it in short if it["label"] == 1)
        fp = sum(self.scores[it["id"]] >= thr for it in short if it["label"] == 0)
        want_r, n_att = self.fx["design_section9"]["short_recall"]
        want_fp, n_ben = self.fx["design_section9"]["short_false_positives"]
        self.assertLessEqual(abs(recall - want_r), tol, f"recall {recall}/{n_att}, section 9 {want_r}/{n_att}")
        self.assertLessEqual(abs(fp - want_fp), tol, f"false positives {fp}/{n_ben}, section 9 {want_fp}/{n_ben}")

    def test_the_mid_page_ignore_payload_is_found(self):
        # section 9: at 256 tokens the mid-page "IGNORE ALL..." scores 0.98 (0.89 at 512)
        self.assertGreaterEqual(self.scores["L1_mid_ignore"], 0.5)


class EvalFp32(_EvalSet, unittest.TestCase):
    precision = "fp32"


class EvalInt8(_EvalSet, unittest.TestCase):
    precision = "int8"


class ThroughScreen(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = cs.eval_fixture()
        cls.clf = cs.real("fp32")

    def test_threshold_mapping_on_the_eval_set(self):
        thr = self.fx["threshold"]
        for it in self.fx["items"]:
            with self.subTest(item=it["id"]):
                env = envelope(it["text"])
                base = pipeline.screen(env, classifier=support.ZeroClassifier())  # stages 1-5 only
                r = pipeline.screen(env, classifier=self.clf)
                if base.verdict == "injected":
                    self.assertEqual(r.verdict, "injected")
                    self.assertIsNone(r.classifier)
                    continue
                self.assertIsNone(r.error, r.error)
                p = r.classifier["max_score"]
                if p >= thr:
                    self.assertEqual(r.verdict, "pending")
                    self.assertTrue(r.needs_second_opinion)
                    self.assertGreaterEqual(r.classifier["flagged_count"], 1)
                    self.assertEqual(r.text, base.text)
                else:
                    self.assertEqual((r.verdict, r.needs_second_opinion, r.text, r.reasons),
                                     (base.verdict, base.needs_second_opinion, base.text, base.reasons))
                self.assertEqual(r.reasons, base.reasons)  # the score adds no reason, never a STRONG one


class I2Corpus(unittest.TestCase):
    """Legitimate security writing (the I2 corpus): DESIGN section 8 expects its confident false
    positives here. The classifier alone may send it to the second opinion, never discard it,
    and no more of it than recorded."""

    @classmethod
    def setUpClass(cls):
        cls.fx = cs.corpus_fixture()
        cls.items = cs.corpus_items()

    def _run(self, precision):
        clf = cs.real(precision)
        rec = self.fx["precisions"][precision]
        tol = self.fx["tolerance"]["count"]
        newly = set()  # I2 said clean; the classifier alone now sends it to the second opinion
        for cid, text in self.items:
            env = envelope(text)
            base = pipeline.screen(env, classifier=support.ZeroClassifier(record=False))
            r = pipeline.screen(env, classifier=clf)
            self.assertIn(r.verdict, ("clean", "pending"), cid)
            self.assertIsNone(r.error, cid)
            if r.classifier["max_score"] >= self.fx["threshold"]:
                self.assertEqual(r.verdict, "pending", cid)
                self.assertTrue(r.needs_second_opinion, cid)
                if base.verdict == "clean":
                    newly.add(cid)
            else:
                self.assertEqual(r.verdict, base.verdict, cid)
        recorded = set(rec["newly_pending"])
        extra = newly - recorded
        self.assertLessEqual(len(extra), tol, sorted(extra))
        # never beyond the recorded false-positive rate: the corpus's own frozen count, and the
        # section-9 rate (5 of 30 benign texts) that DESIGN set the threshold on
        self.assertLessEqual(len(newly), len(recorded) + tol, sorted(newly))
        fp_n, fp_d = self.fx["design_section9_false_positive_rate"]
        self.assertLessEqual(len(newly) / len(self.items), fp_n / fp_d, sorted(newly))

    def test_corpus_size(self):
        self.assertEqual(len(self.items), self.fx["n"])

    def test_fp32(self):
        self._run("fp32")

    def test_int8(self):
        self._run("int8")


if __name__ == "__main__":
    unittest.main()
